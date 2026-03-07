from __future__ import annotations

import json
from pathlib import Path

from backend.config import sanitize_user_id
from backend.repositories.app_db import AppDatabase, json_dumps, json_loads, now_ms


class SyncSnapshotRepository:
    def __init__(self, db_path: Path, legacy_cloud_dir: Path | None = None) -> None:
        self.db = AppDatabase(db_path)
        self.legacy_cloud_dir = legacy_cloud_dir

    def _legacy_path_for(self, user_id: str) -> Path | None:
        if not self.legacy_cloud_dir:
            return None
        return self.legacy_cloud_dir / f"{sanitize_user_id(user_id)}.json"

    def _migrate_legacy_if_needed(self, user_id: str) -> None:
        legacy_path = self._legacy_path_for(user_id)
        if legacy_path is None or not legacy_path.exists():
            return
        existing = self.pull(user_id, migrate_legacy=False)
        if existing:
            return
        try:
            payload = json.loads(legacy_path.read_text(encoding="utf-8"))
        except Exception:
            return
        if not isinstance(payload, dict):
            return
        self.push(user_id, payload)

    def pull(self, user_id: str, *, migrate_legacy: bool = True) -> dict:
        if migrate_legacy:
            self._migrate_legacy_if_needed(user_id)
        user_key = sanitize_user_id(user_id)
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT snapshot_json, updated_at
                FROM sync_snapshots
                WHERE user_id = ?
                LIMIT 1
                """,
                (user_key,),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return {}
        snapshot = json_loads(row["snapshot_json"], {})
        if not isinstance(snapshot, dict):
            snapshot = {}
        return {
            "updatedAt": int(row["updated_at"] or 0),
            "snapshot": snapshot.get("snapshot") if "snapshot" in snapshot else snapshot,
        }

    def push(self, user_id: str, snapshot: dict) -> dict:
        user_key = sanitize_user_id(user_id)
        payload = snapshot if isinstance(snapshot, dict) else {}
        data = {
            "updatedAt": int(payload.get("updatedAt", now_ms()) or now_ms()),
            "snapshot": payload.get("snapshot") if "snapshot" in payload else payload,
        }
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                INSERT INTO sync_snapshots (user_id, snapshot_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                  snapshot_json = excluded.snapshot_json,
                  updated_at = excluded.updated_at
                """,
                (user_key, json_dumps(data), int(data["updatedAt"] or now_ms())),
            )
        return data

    def delete(self, user_id: str) -> None:
        user_key = sanitize_user_id(user_id)
        with self.db.transaction(immediate=True) as conn:
            conn.execute("DELETE FROM sync_snapshots WHERE user_id = ?", (user_key,))
