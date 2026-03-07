from __future__ import annotations

from pathlib import Path

from backend.config import sanitize_user_id
from backend.repositories.app_db import AppDatabase, now_ms


class ReadingProgressRepository:
    def __init__(self, db_path: Path) -> None:
        self.db = AppDatabase(db_path)

    def get_progress(self, user_id: str, book_id: str) -> dict:
        user_key = sanitize_user_id(user_id)
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT
                  user_id,
                  book_id,
                  chapter_id,
                  chapter_index,
                  paragraph_index,
                  char_index,
                  updated_at
                FROM reading_progress
                WHERE user_id = ? AND book_id = ?
                LIMIT 1
                """,
                (user_key, str(book_id or "").strip()),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return {
                "userId": user_key,
                "bookId": str(book_id or "").strip(),
                "chapterId": "",
                "chapterIndex": 0,
                "paragraphIndex": 0,
                "charIndex": 0,
                "updatedAt": 0,
            }
        return {
            "userId": str(row["user_id"]),
            "bookId": str(row["book_id"]),
            "chapterId": str(row["chapter_id"] or ""),
            "chapterIndex": int(row["chapter_index"] or 0),
            "paragraphIndex": int(row["paragraph_index"] or 0),
            "charIndex": int(row["char_index"] or 0),
            "updatedAt": int(row["updated_at"] or 0),
        }

    def save_progress(
        self,
        *,
        user_id: str,
        book_id: str,
        chapter_id: str,
        chapter_index: int,
        paragraph_index: int = 0,
        char_index: int = 0,
    ) -> dict:
        user_key = sanitize_user_id(user_id)
        payload = {
            "userId": user_key,
            "bookId": str(book_id or "").strip(),
            "chapterId": str(chapter_id or "").strip(),
            "chapterIndex": max(0, int(chapter_index or 0)),
            "paragraphIndex": max(0, int(paragraph_index or 0)),
            "charIndex": max(0, int(char_index or 0)),
            "updatedAt": now_ms(),
        }
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                INSERT INTO reading_progress (
                  user_id,
                  book_id,
                  chapter_id,
                  chapter_index,
                  paragraph_index,
                  char_index,
                  updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, book_id) DO UPDATE SET
                  chapter_id = excluded.chapter_id,
                  chapter_index = excluded.chapter_index,
                  paragraph_index = excluded.paragraph_index,
                  char_index = excluded.char_index,
                  updated_at = excluded.updated_at
                """,
                (
                    payload["userId"],
                    payload["bookId"],
                    payload["chapterId"],
                    payload["chapterIndex"],
                    payload["paragraphIndex"],
                    payload["charIndex"],
                    payload["updatedAt"],
                ),
            )
        return payload

    def list_progress(self, user_id: str) -> list[dict]:
        user_key = sanitize_user_id(user_id)
        conn = self.db.connect()
        try:
            rows = conn.execute(
                """
                SELECT
                  user_id,
                  book_id,
                  chapter_id,
                  chapter_index,
                  paragraph_index,
                  char_index,
                  updated_at
                FROM reading_progress
                WHERE user_id = ?
                ORDER BY updated_at DESC, book_id ASC
                """,
                (user_key,),
            ).fetchall()
        finally:
            conn.close()
        return [
            {
                "userId": str(row["user_id"]),
                "bookId": str(row["book_id"]),
                "chapterId": str(row["chapter_id"] or ""),
                "chapterIndex": int(row["chapter_index"] or 0),
                "paragraphIndex": int(row["paragraph_index"] or 0),
                "charIndex": int(row["char_index"] or 0),
                "updatedAt": int(row["updated_at"] or 0),
            }
            for row in rows
        ]

    def delete_progress(self, user_id: str, *, book_id: str = "") -> None:
        user_key = sanitize_user_id(user_id)
        with self.db.transaction(immediate=True) as conn:
            if str(book_id or "").strip():
                conn.execute(
                    "DELETE FROM reading_progress WHERE user_id = ? AND book_id = ?",
                    (user_key, str(book_id or "").strip()),
                )
            else:
                conn.execute("DELETE FROM reading_progress WHERE user_id = ?", (user_key,))
