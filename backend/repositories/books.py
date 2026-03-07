from __future__ import annotations

import hashlib
import secrets
from pathlib import Path

from backend.config import sanitize_user_id
from backend.repositories.app_db import AppDatabase, json_dumps, json_loads, now_ms


def _book_stats(chapter_analyses: list[dict]) -> dict:
    total_tokens = 0
    unique_words: set[str] = set()
    level_buckets = {"N1": 0, "N2": 0, "N3": 0, "N4": 0, "N5": 0, "other": 0}
    for analysis in chapter_analyses:
        if not isinstance(analysis, dict):
            continue
        tokens = list(analysis.get("tokens") or [])
        jlpt_stats = analysis.get("jlptStats") or {}
        total_tokens += len(tokens)
        for level in ("N1", "N2", "N3", "N4", "N5"):
            level_buckets[level] += int(jlpt_stats.get(level, 0) or 0)
        level_buckets["other"] += int(jlpt_stats.get("other", 0) or 0)
        for token in tokens:
            lemma = str(token.get("lemma") or token.get("surface") or "").strip()
            if lemma:
                unique_words.add(lemma)
    return {
        "totalTokens": total_tokens,
        "uniqueWords": len(unique_words),
        "levelBuckets": level_buckets,
    }


class BookRepository:
    def __init__(self, db_path: Path) -> None:
        self.db = AppDatabase(db_path)

    @staticmethod
    def hash_content(raw: bytes) -> str:
        return hashlib.sha256(raw).hexdigest()

    def find_existing_book(self, *, user_id: str, content_sha256: str) -> dict | None:
        user_key = sanitize_user_id(user_id)
        sha = str(content_sha256 or "").strip()
        if not sha:
            return None
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT id, title, format, chapter_count, normalized_version, imported_at, source_file_name
                FROM books
                WHERE user_id = ? AND content_sha256 = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (user_key, sha),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        return {
            "id": str(row["id"]),
            "title": str(row["title"] or ""),
            "format": str(row["format"] or ""),
            "chapterCount": int(row["chapter_count"] or 0),
            "normalizedVersion": int(row["normalized_version"] or 1),
            "importedAt": int(row["imported_at"] or 0),
            "sourceFileName": str(row["source_file_name"] or ""),
        }

    def list_books_for_user(self, user_id: str) -> list[dict]:
        user_key = sanitize_user_id(user_id)
        conn = self.db.connect()
        try:
            rows = conn.execute(
                """
                SELECT id
                FROM books
                WHERE user_id = ?
                ORDER BY created_at DESC
                """,
                (user_key,),
            ).fetchall()
        finally:
            conn.close()
        return [
            item
            for item in (self.get_book_metadata(str(row["id"])) for row in rows)
            if item is not None
        ]

    def find_sample_book(self, sample_slug: str) -> dict | None:
        slug = str(sample_slug or "").strip()
        if not slug:
            return None
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT id
                FROM books
                WHERE sample_slug = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (slug,),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        return self.get_book_metadata(str(row["id"]))

    def save_book_with_analysis(
        self,
        *,
        user_id: str,
        book: dict,
        chapter_analyses: list[dict],
        content_sha256: str = "",
        sample_slug: str = "",
    ) -> str:
        existing = None
        if content_sha256:
            existing = self.find_existing_book(user_id=user_id, content_sha256=content_sha256)
        if existing:
            return str(existing["id"])

        book_id = f"book_{now_ms()}_{secrets.token_hex(4)}"
        chapters = list(book.get("chapters") or [])
        now = now_ms()
        analysis_by_chapter = {
            str(item.get("chapterId") or ""): item for item in chapter_analyses if isinstance(item, dict)
        }
        stats = _book_stats(chapter_analyses)
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                INSERT INTO books (
                  id,
                  user_id,
                  title,
                  format,
                  chapter_count,
                  normalized_version,
                  imported_at,
                  source_file_name,
                  created_at,
                  content_sha256,
                  stats_json,
                  sample_slug
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    book_id,
                    sanitize_user_id(user_id),
                    str(book.get("title", "") or "Untitled"),
                    str(book.get("format", "") or "txt"),
                    int(book.get("chapterCount", len(chapters)) or len(chapters)),
                    int(book.get("normalizedVersion", 1) or 1),
                    int(book.get("importedAt", now) or now),
                    str(book.get("sourceFileName", "") or ""),
                    now,
                    str(content_sha256 or "").strip(),
                    json_dumps(stats),
                    str(sample_slug or "").strip(),
                ),
            )
            for index, chapter in enumerate(chapters):
                chapter_id = str(chapter.get("id") or f"ch-{index + 1}")
                conn.execute(
                    """
                    INSERT INTO chapters (
                      book_id,
                      chapter_id,
                      chapter_index,
                      title,
                      text,
                      paragraphs_json,
                      source_type,
                      source_ref
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        book_id,
                        chapter_id,
                        int(chapter.get("index", index) or index),
                        str(chapter.get("title", "") or f"Chapter {index + 1}"),
                        str(chapter.get("text", "") or ""),
                        json_dumps(chapter.get("paragraphs") or []),
                        str(chapter.get("sourceType", "") or ""),
                        str(chapter.get("sourceRef", "") or ""),
                    ),
                )
                analysis = analysis_by_chapter.get(chapter_id, {})
                conn.execute(
                    """
                    INSERT INTO chapter_analysis (
                      book_id,
                      chapter_id,
                      chapter_index,
                      analysis_json,
                      updated_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        book_id,
                        chapter_id,
                        int(chapter.get("index", index) or index),
                        json_dumps(analysis),
                        now,
                    ),
                )
        return book_id

    def update_chapter_analysis(self, *, book_id: str, chapter_id: str, analysis: dict) -> None:
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                UPDATE chapter_analysis
                SET analysis_json = ?, updated_at = ?
                WHERE book_id = ? AND chapter_id = ?
                """,
                (json_dumps(analysis or {}), now_ms(), str(book_id or "").strip(), str(chapter_id or "").strip()),
            )
            rows = conn.execute(
                """
                SELECT analysis_json
                FROM chapter_analysis
                WHERE book_id = ?
                ORDER BY chapter_index ASC
                """,
                (str(book_id or "").strip(),),
            ).fetchall()
            analyses = [json_loads(row["analysis_json"], {}) for row in rows]
            conn.execute(
                "UPDATE books SET stats_json = ? WHERE id = ?",
                (json_dumps(_book_stats(analyses)), str(book_id or "").strip()),
            )

    def get_book_metadata(self, book_id: str) -> dict | None:
        conn = self.db.connect()
        try:
            book_row = conn.execute(
                """
                SELECT
                  id,
                  user_id,
                  title,
                  format,
                  chapter_count,
                  normalized_version,
                  imported_at,
                  source_file_name,
                  stats_json,
                  sample_slug
                FROM books
                WHERE id = ?
                LIMIT 1
                """,
                (str(book_id or "").strip(),),
            ).fetchone()
            if not book_row:
                return None
            chapter_rows = conn.execute(
                """
                SELECT chapter_id, chapter_index, title
                FROM chapters
                WHERE book_id = ?
                ORDER BY chapter_index ASC
                """,
                (str(book_id or "").strip(),),
            ).fetchall()
            analysis_rows = conn.execute(
                """
                SELECT analysis_json
                FROM chapter_analysis
                WHERE book_id = ?
                ORDER BY chapter_index ASC
                """,
                (str(book_id or "").strip(),),
            ).fetchall()
        finally:
            conn.close()
        stats = _book_stats([json_loads(row["analysis_json"], {}) for row in analysis_rows])
        return {
            "id": str(book_row["id"]),
            "userId": str(book_row["user_id"]),
            "title": str(book_row["title"] or ""),
            "format": str(book_row["format"] or ""),
            "chapterCount": int(book_row["chapter_count"] or len(chapter_rows)),
            "normalizedVersion": int(book_row["normalized_version"] or 1),
            "importedAt": int(book_row["imported_at"] or 0),
            "sourceFileName": str(book_row["source_file_name"] or ""),
            "sampleSlug": str(book_row["sample_slug"] or ""),
            "stats": stats,
            "chapters": [
                {
                    "id": str(row["chapter_id"]),
                    "index": int(row["chapter_index"] or 0),
                    "title": str(row["title"] or ""),
                }
                for row in chapter_rows
            ],
        }

    def get_chapter_payload(self, book_id: str, chapter_id: str) -> dict | None:
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT
                  c.book_id,
                  c.chapter_id,
                  c.chapter_index,
                  c.title,
                  c.text,
                  c.paragraphs_json,
                  c.source_type,
                  c.source_ref,
                  a.analysis_json
                FROM chapters c
                LEFT JOIN chapter_analysis a
                  ON a.book_id = c.book_id
                 AND a.chapter_id = c.chapter_id
                WHERE c.book_id = ? AND c.chapter_id = ?
                LIMIT 1
                """,
                (str(book_id or "").strip(), str(chapter_id or "").strip()),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        analysis = json_loads(row["analysis_json"], {})
        if not isinstance(analysis, dict):
            analysis = {}
        if not analysis.get("chapterId"):
            analysis["chapterId"] = str(row["chapter_id"])
        return {
            "id": str(row["chapter_id"]),
            "index": int(row["chapter_index"] or 0),
            "title": str(row["title"] or ""),
            "text": str(row["text"] or ""),
            "paragraphs": json_loads(row["paragraphs_json"], []),
            "sourceType": str(row["source_type"] or ""),
            "sourceRef": str(row["source_ref"] or ""),
            "analysis": analysis,
        }

    def delete_book(self, *, user_id: str, book_id: str) -> bool:
        user_key = sanitize_user_id(user_id)
        target_book_id = str(book_id or "").strip()
        if not target_book_id:
            return False
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                "SELECT id FROM books WHERE id = ? AND user_id = ? LIMIT 1",
                (target_book_id, user_key),
            ).fetchone()
            if not row:
                return False
            conn.execute("DELETE FROM books WHERE id = ?", (target_book_id,))
        return True

    def delete_books_for_user(self, user_id: str) -> int:
        user_key = sanitize_user_id(user_id)
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS count FROM books WHERE user_id = ?",
                (user_key,),
            ).fetchone()
            deleted = int(row["count"] or 0) if row else 0
            conn.execute("DELETE FROM books WHERE user_id = ?", (user_key,))
        return deleted
