from __future__ import annotations

import sqlite3
from pathlib import Path

from backend.config import WORD_NOISE_RE
from backend.services.jmdict_bootstrap import is_jmdict_db_ready


class JMDictStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    def available(self) -> bool:
        return is_jmdict_db_ready(self.db_path)

    @staticmethod
    def _entry_columns(conn: sqlite3.Connection) -> set[str]:
        rows = conn.execute("PRAGMA table_info(entries)").fetchall()
        return {row[1] for row in rows}

    @staticmethod
    def _katakana_to_hiragana(text: str) -> str:
        out = []
        for ch in str(text or ""):
            code = ord(ch)
            if 0x30A1 <= code <= 0x30F6:
                out.append(chr(code - 0x60))
            else:
                out.append(ch)
        return "".join(out)

    @staticmethod
    def _hiragana_to_katakana(text: str) -> str:
        out = []
        for ch in str(text or ""):
            code = ord(ch)
            if 0x3041 <= code <= 0x3096:
                out.append(chr(code + 0x60))
            else:
                out.append(ch)
        return "".join(out)

    @staticmethod
    def _strip_word_noise(text: str) -> str:
        return WORD_NOISE_RE.sub("", str(text or "").strip()).strip()

    def _build_lookup_candidates(self, surface: str, lemma: str) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for raw in (surface, lemma):
            base = str(raw or "").strip()
            if not base:
                continue
            values = (
                base,
                self._strip_word_noise(base),
                self._katakana_to_hiragana(base),
                self._hiragana_to_katakana(base),
            )
            for value in values:
                val = self._strip_word_noise(value)
                if not val or val in seen:
                    continue
                seen.add(val)
                out.append(val)
        return out

    def lookup(self, surface: str, lemma: str, limit: int = 8) -> list[dict]:
        if not self.available():
            return []
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            columns = self._entry_columns(conn)
            candidates = self._build_lookup_candidates(surface, lemma)
            if not candidates:
                return []
            select_fields = [
                "surface",
                "lemma",
                "reading",
                "gloss",
                "pos",
                "gloss_zh" if "gloss_zh" in columns else "'' AS gloss_zh",
                "gloss_en" if "gloss_en" in columns else "'' AS gloss_en",
            ]
            select_sql = ", ".join(select_fields)
            placeholders = ", ".join("?" for _ in candidates)
            rows = conn.execute(
                f"""
                SELECT {select_sql}
                FROM entries
                WHERE surface IN ({placeholders}) OR lemma IN ({placeholders})
                LIMIT ?
                """,
                (*candidates, *candidates, limit),
            ).fetchall()
            if not rows:
                like_clauses = " OR ".join(["surface LIKE ? OR lemma LIKE ?"] * len(candidates))
                like_params: list[str | int] = []
                for cand in candidates:
                    like_params.extend([f"{cand}%", f"{cand}%"])
                like_params.append(limit)
                rows = conn.execute(
                    f"""
                    SELECT {select_sql}
                    FROM entries
                    WHERE {like_clauses}
                    LIMIT ?
                    """,
                    tuple(like_params),
                ).fetchall()
            return [dict(row) for row in rows]
        finally:
            conn.close()
