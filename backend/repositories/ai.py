from __future__ import annotations

import secrets
from pathlib import Path

from backend.repositories.app_db import AppDatabase, json_dumps, json_loads, now_ms


class AIExplainRepository:
    def __init__(self, db_path: Path) -> None:
        self.db = AppDatabase(db_path)

    def get_cached(self, cache_key: str, ttl_seconds: int) -> dict | None:
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT
                  cache_key,
                  sentence_hash,
                  context_hash,
                  mode,
                  model,
                  prompt_version,
                  provider,
                  response_json,
                  created_at
                FROM ai_explain_cache
                WHERE cache_key = ?
                LIMIT 1
                """,
                (str(cache_key or "").strip(),),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        created_at = int(row["created_at"] or 0)
        if ttl_seconds > 0 and now_ms() - created_at > ttl_seconds * 1000:
            return None
        response = json_loads(row["response_json"], {})
        if not isinstance(response, dict):
            return None
        return {
            "cacheKey": str(row["cache_key"]),
            "sentenceHash": str(row["sentence_hash"]),
            "contextHash": str(row["context_hash"]),
            "mode": str(row["mode"]),
            "model": str(row["model"]),
            "promptVersion": str(row["prompt_version"]),
            "provider": str(row["provider"]),
            "response": response,
            "createdAt": created_at,
        }

    def set_cached(
        self,
        *,
        cache_key: str,
        sentence_hash: str,
        context_hash: str,
        mode: str,
        model: str,
        prompt_version: str,
        provider: str,
        response: dict,
    ) -> dict:
        created_at = now_ms()
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                INSERT INTO ai_explain_cache (
                  cache_key,
                  sentence_hash,
                  context_hash,
                  mode,
                  model,
                  prompt_version,
                  provider,
                  response_json,
                  created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                  sentence_hash = excluded.sentence_hash,
                  context_hash = excluded.context_hash,
                  mode = excluded.mode,
                  model = excluded.model,
                  prompt_version = excluded.prompt_version,
                  provider = excluded.provider,
                  response_json = excluded.response_json,
                  created_at = excluded.created_at
                """,
                (
                    str(cache_key or "").strip(),
                    str(sentence_hash or "").strip(),
                    str(context_hash or "").strip(),
                    str(mode or "").strip(),
                    str(model or "").strip(),
                    str(prompt_version or "").strip(),
                    str(provider or "").strip(),
                    json_dumps(response or {}),
                    created_at,
                ),
            )
        return {
            "cacheKey": str(cache_key or "").strip(),
            "provider": str(provider or "").strip(),
            "model": str(model or "").strip(),
            "promptVersion": str(prompt_version or "").strip(),
            "createdAt": created_at,
            "response": response or {},
        }

    def reserve_uncached_usage(
        self,
        *,
        user_id: str,
        daily_limit: int,
        since_ms: int,
        cache_key: str,
        sentence_hash: str,
        context_hash: str,
        mode: str,
        model: str,
        prompt_version: str,
    ) -> str:
        if daily_limit <= 0:
            return ""
        reservation_token = f"res_{now_ms()}_{secrets.token_hex(4)}"
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM ai_usage
                WHERE user_id = ?
                  AND cached = 0
                  AND status IN ('reserved', 'ok')
                  AND created_at >= ?
                """,
                (str(user_id or "").strip(), int(since_ms or 0)),
            ).fetchone()
            used = int(row["count"] or 0) if row else 0
            if used >= daily_limit:
                return ""
            conn.execute(
                """
                INSERT INTO ai_usage (
                  user_id,
                  cache_key,
                  sentence_hash,
                  context_hash,
                  mode,
                  model,
                  prompt_version,
                  cached,
                  status,
                  provider,
                  error_message,
                  created_at,
                  reservation_token
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'reserved', '', '', ?, ?)
                """,
                (
                    str(user_id or "").strip(),
                    str(cache_key or "").strip(),
                    str(sentence_hash or "").strip(),
                    str(context_hash or "").strip(),
                    str(mode or "").strip(),
                    str(model or "").strip(),
                    str(prompt_version or "").strip(),
                    now_ms(),
                    reservation_token,
                ),
            )
        return reservation_token

    def finalize_reservation(
        self,
        *,
        reservation_token: str,
        provider: str,
        status: str,
        error_message: str = "",
    ) -> None:
        if not reservation_token:
            return
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                UPDATE ai_usage
                SET status = ?,
                    provider = ?,
                    error_message = ?
                WHERE reservation_token = ?
                """,
                (
                    str(status or "").strip(),
                    str(provider or "").strip(),
                    str(error_message or "").strip(),
                    str(reservation_token or "").strip(),
                ),
            )

    def record_usage(
        self,
        *,
        user_id: str,
        cache_key: str,
        sentence_hash: str,
        context_hash: str,
        mode: str,
        model: str,
        prompt_version: str,
        cached: bool,
        status: str,
        provider: str = "",
        error_message: str = "",
    ) -> None:
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                INSERT INTO ai_usage (
                  user_id,
                  cache_key,
                  sentence_hash,
                  context_hash,
                  mode,
                  model,
                  prompt_version,
                  cached,
                  status,
                  provider,
                  error_message,
                  created_at,
                  reservation_token
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
                """,
                (
                    str(user_id or "").strip(),
                    str(cache_key or "").strip(),
                    str(sentence_hash or "").strip(),
                    str(context_hash or "").strip(),
                    str(mode or "").strip(),
                    str(model or "").strip(),
                    str(prompt_version or "").strip(),
                    1 if cached else 0,
                    str(status or "").strip(),
                    str(provider or "").strip(),
                    str(error_message or "").strip(),
                    now_ms(),
                ),
            )

    def count_uncached_usage_since(self, *, user_id: str, since_ms: int) -> int:
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM ai_usage
                WHERE user_id = ?
                  AND cached = 0
                  AND status = 'ok'
                  AND created_at >= ?
                """,
                (str(user_id or "").strip(), int(since_ms or 0)),
            ).fetchone()
        finally:
            conn.close()
        return int(row["count"] or 0) if row else 0

    def count_usage_since(self, *, user_id: str, since_ms: int) -> dict:
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT
                  COUNT(*) AS total,
                  SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cached_total,
                  SUM(CASE WHEN cached = 0 AND status = 'ok' THEN 1 ELSE 0 END) AS uncached_ok,
                  SUM(CASE WHEN status = 'limited' THEN 1 ELSE 0 END) AS limited_total
                FROM ai_usage
                WHERE user_id = ?
                  AND created_at >= ?
                """,
                (str(user_id or "").strip(), int(since_ms or 0)),
            ).fetchone()
        finally:
            conn.close()
        return {
            "total": int(row["total"] or 0) if row else 0,
            "cachedTotal": int(row["cached_total"] or 0) if row else 0,
            "uncachedOk": int(row["uncached_ok"] or 0) if row else 0,
            "limitedTotal": int(row["limited_total"] or 0) if row else 0,
        }

    def delete_user_data(self, user_id: str) -> None:
        target = str(user_id or "").strip()
        with self.db.transaction(immediate=True) as conn:
            conn.execute("DELETE FROM ai_usage WHERE user_id = ?", (target,))
