from __future__ import annotations

import secrets
from pathlib import Path

from backend.config import sanitize_user_id
from backend.repositories.app_db import AppDatabase, now_ms


class UserRepository:
    def __init__(self, db_path: Path) -> None:
        self.db = AppDatabase(db_path)

    @staticmethod
    def _row_to_user(row) -> dict | None:  # noqa: ANN001
        if row is None:
            return None
        return {
            "userId": str(row["user_id"]),
            "accountToken": str(row["account_token"] or ""),
            "displayName": str(row["display_name"] or ""),
            "isRegistered": bool(row["is_registered"]),
            "createdAt": int(row["created_at"] or 0),
            "updatedAt": int(row["updated_at"] or 0),
            "mergedAnonymousId": str(row["merged_anonymous_id"] or ""),
            "deletedAt": int(row["deleted_at"] or 0),
        }

    def get_user(self, user_id: str) -> dict | None:
        user_key = sanitize_user_id(user_id)
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT
                  user_id,
                  account_token,
                  display_name,
                  is_registered,
                  created_at,
                  updated_at,
                  merged_anonymous_id,
                  deleted_at
                FROM users
                WHERE user_id = ?
                LIMIT 1
                """,
                (user_key,),
            ).fetchone()
        finally:
            conn.close()
        user = self._row_to_user(row)
        if user and user["deletedAt"] > 0:
            return None
        return user

    def find_by_token(self, account_token: str) -> dict | None:
        token = str(account_token or "").strip()
        if not token:
            return None
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT
                  user_id,
                  account_token,
                  display_name,
                  is_registered,
                  created_at,
                  updated_at,
                  merged_anonymous_id,
                  deleted_at
                FROM users
                WHERE account_token = ?
                LIMIT 1
                """,
                (token,),
            ).fetchone()
        finally:
            conn.close()
        user = self._row_to_user(row)
        if user and user["deletedAt"] > 0:
            return None
        return user

    def is_registered(self, user_id: str) -> bool:
        user = self.get_user(user_id)
        return bool(user and user["isRegistered"])

    def verify_token(self, user_id: str, account_token: str) -> bool:
        user = self.get_user(user_id)
        token = str(account_token or "").strip()
        return bool(user and token and user["accountToken"] == token)

    def register(
        self,
        user_id: str,
        *,
        display_name: str = "",
        merged_anonymous_id: str = "",
    ) -> tuple[dict | None, bool]:
        user_key = sanitize_user_id(user_id)
        existing = self.get_user(user_key)
        if existing and existing["isRegistered"]:
            return None, False
        now = now_ms()
        account_token = secrets.token_urlsafe(24)
        created_at = int(existing["createdAt"]) if existing else now
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                INSERT INTO users (
                  user_id,
                  account_token,
                  display_name,
                  is_registered,
                  created_at,
                  updated_at,
                  merged_anonymous_id,
                  deleted_at
                ) VALUES (?, ?, ?, 1, ?, ?, ?, 0)
                ON CONFLICT(user_id) DO UPDATE SET
                  account_token = excluded.account_token,
                  display_name = excluded.display_name,
                  is_registered = 1,
                  updated_at = excluded.updated_at,
                  merged_anonymous_id = excluded.merged_anonymous_id,
                  deleted_at = 0
                """,
                (
                    user_key,
                    account_token,
                    str(display_name or "").strip(),
                    created_at,
                    now,
                    str(merged_anonymous_id or "").strip(),
                ),
            )
        return self.get_user(user_key), True

    def delete_user(self, user_id: str) -> None:
        user_key = sanitize_user_id(user_id)
        with self.db.transaction(immediate=True) as conn:
            conn.execute("DELETE FROM users WHERE user_id = ?", (user_key,))
