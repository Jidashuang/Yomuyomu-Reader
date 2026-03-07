from __future__ import annotations

from pathlib import Path

from backend.repositories.app_db import AppDatabase, json_dumps, now_ms


class EventRepository:
    def __init__(self, db_path: Path) -> None:
        self.db = AppDatabase(db_path)

    def track(
        self,
        event_name: str,
        *,
        user_id: str = "",
        book_id: str = "",
        chapter_id: str = "",
        payload: dict | None = None,
    ) -> None:
        conn = self.db.connect()
        try:
            conn.execute(
                """
                INSERT INTO events (
                  event_name,
                  user_id,
                  book_id,
                  chapter_id,
                  payload_json,
                  created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    str(event_name or "").strip(),
                    str(user_id or "").strip(),
                    str(book_id or "").strip(),
                    str(chapter_id or "").strip(),
                    json_dumps(payload or {}),
                    now_ms(),
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def daily_counts(
        self,
        *,
        since_ms: int,
        until_ms: int,
        event_names: list[str] | None = None,
    ) -> list[dict]:
        clauses = ["created_at >= ?", "created_at < ?"]
        params: list[object] = [int(since_ms or 0), int(until_ms or 0)]
        if event_names:
            placeholders = ",".join("?" for _ in event_names)
            clauses.append(f"event_name IN ({placeholders})")
            params.extend([str(name or "").strip() for name in event_names])
        conn = self.db.connect()
        try:
            rows = conn.execute(
                f"""
                SELECT
                  strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
                  event_name,
                  COUNT(*) AS count
                FROM events
                WHERE {' AND '.join(clauses)}
                GROUP BY day, event_name
                ORDER BY day ASC, event_name ASC
                """,
                tuple(params),
            ).fetchall()
        finally:
            conn.close()
        return [
            {
                "day": str(row["day"] or ""),
                "eventName": str(row["event_name"] or ""),
                "count": int(row["count"] or 0),
            }
            for row in rows
        ]

    def delete_events_for_user(self, user_id: str) -> None:
        conn = self.db.connect()
        try:
            conn.execute("DELETE FROM events WHERE user_id = ?", (str(user_id or "").strip(),))
            conn.commit()
        finally:
            conn.close()
