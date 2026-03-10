from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
from pathlib import Path

from backend.config import sanitize_user_id
from backend.repositories.app_db import AppDatabase, now_ms


USERNAME_RE = re.compile(r"^[a-z0-9_-]{3,32}$")


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
            "username": str(row["username"] or ""),
            "isRegistered": bool(row["is_registered"]),
            "createdAt": int(row["created_at"] or 0),
            "updatedAt": int(row["updated_at"] or 0),
            "mergedAnonymousId": str(row["merged_anonymous_id"] or ""),
            "deletedAt": int(row["deleted_at"] or 0),
        }

    @staticmethod
    def normalize_username(username: str) -> str:
        return str(username or "").strip().lower()

    @staticmethod
    def valid_username(username: str) -> bool:
        return bool(USERNAME_RE.fullmatch(UserRepository.normalize_username(username)))

    @staticmethod
    def hash_password(password: str) -> str:
        salt = os.urandom(16)
        derived = hashlib.pbkdf2_hmac(
            "sha256",
            str(password or "").encode("utf-8"),
            salt,
            260000,
        )
        salt_b64 = base64.urlsafe_b64encode(salt).decode("ascii").rstrip("=")
        hash_b64 = base64.urlsafe_b64encode(derived).decode("ascii").rstrip("=")
        return f"pbkdf2_sha256$260000${salt_b64}${hash_b64}"

    @staticmethod
    def verify_password(password: str, password_hash: str) -> bool:
        encoded = str(password_hash or "").strip()
        try:
            algorithm, rounds_text, salt_b64, hash_b64 = encoded.split("$", 3)
            if algorithm != "pbkdf2_sha256":
                return False
            rounds = int(rounds_text)
            salt = base64.urlsafe_b64decode(salt_b64 + "=" * (-len(salt_b64) % 4))
            expected = base64.urlsafe_b64decode(hash_b64 + "=" * (-len(hash_b64) % 4))
        except Exception:
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            str(password or "").encode("utf-8"),
            salt,
            rounds,
        )
        return hmac.compare_digest(actual, expected)

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
                  username,
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
                  username,
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

    def find_by_username(self, username: str) -> dict | None:
        username_key = self.normalize_username(username)
        if not username_key:
            return None
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT
                  user_id,
                  account_token,
                  display_name,
                  username,
                  is_registered,
                  created_at,
                  updated_at,
                  merged_anonymous_id,
                  deleted_at
                FROM users
                WHERE username = ?
                LIMIT 1
                """,
                (username_key,),
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

    def set_credentials(self, *, user_id: str, username: str, password_hash: str) -> bool:
        user_key = sanitize_user_id(user_id)
        username_key = self.normalize_username(username)
        with self.db.transaction(immediate=True) as conn:
            try:
                conn.execute(
                    """
                    UPDATE users
                    SET username = ?,
                        password_hash = ?,
                        updated_at = ?
                    WHERE user_id = ?
                    """,
                    (
                        username_key,
                        str(password_hash or "").strip(),
                        now_ms(),
                        user_key,
                    ),
                )
            except sqlite3.IntegrityError:
                return False
        return True

    def refresh_account_token(self, user_id: str) -> dict | None:
        user_key = sanitize_user_id(user_id)
        account_token = secrets.token_urlsafe(24)
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                UPDATE users
                SET account_token = ?,
                    updated_at = ?
                WHERE user_id = ?
                  AND deleted_at = 0
                """,
                (
                    account_token,
                    now_ms(),
                    user_key,
                ),
            )
        return self.get_user(user_key)

    def authenticate(self, username: str, password: str) -> dict | None:
        username_key = self.normalize_username(username)
        if not username_key:
            return None
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT
                  user_id,
                  account_token,
                  display_name,
                  username,
                  password_hash,
                  is_registered,
                  created_at,
                  updated_at,
                  merged_anonymous_id,
                  deleted_at
                FROM users
                WHERE username = ?
                LIMIT 1
                """,
                (username_key,),
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            return None
        user = self._row_to_user(row)
        if not user or user["deletedAt"] > 0 or not user["isRegistered"]:
            return None
        if not self.verify_password(password, str(row["password_hash"] or "")):
            return None
        refreshed = self.refresh_account_token(user["userId"])
        return refreshed or user

    def list_admin_users(self) -> list[dict]:
        conn = self.db.connect()
        try:
            rows = conn.execute(
                """
                SELECT user_id, username, created_at
                FROM users
                WHERE deleted_at = 0
                ORDER BY created_at DESC
                """
            ).fetchall()
        finally:
            conn.close()
        return [
            {
                "userId": str(row["user_id"] or ""),
                "username": str(row["username"] or ""),
                "createdAt": int(row["created_at"] or 0),
            }
            for row in rows
        ]

    def delete_user(self, user_id: str) -> None:
        user_key = sanitize_user_id(user_id)
        with self.db.transaction(immediate=True) as conn:
            conn.execute("DELETE FROM users WHERE user_id = ?", (user_key,))
