from __future__ import annotations

import secrets
from datetime import datetime, timezone
from pathlib import Path

from backend.config import sanitize_user_id
from backend.repositories.app_db import AppDatabase, json_dumps, json_loads, now_ms


ALLOWED_DAILY_SUBJECT_TYPES = {"guest", "user", "guest_ip"}


class AIExplainRepository:
    def __init__(self, db_path: Path) -> None:
        self.db = AppDatabase(db_path)

    @staticmethod
    def today_utc_date() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    @staticmethod
    def normalize_daily_subject(subject_type: str, subject_id: str) -> tuple[str, str]:
        normalized_type = str(subject_type or "").strip().lower()
        if normalized_type not in ALLOWED_DAILY_SUBJECT_TYPES:
            normalized_type = "guest"
        raw_id = str(subject_id or "").strip()
        if normalized_type == "guest_ip":
            normalized_id = raw_id.lower()[:120] or "127.0.0.1"
        else:
            normalized_id = sanitize_user_id(raw_id)
        return normalized_type, normalized_id

    @classmethod
    def usage_actor_key(cls, *, subject_type: str, subject_id: str) -> str:
        normalized_type, normalized_id = cls.normalize_daily_subject(subject_type, subject_id)
        return f"{normalized_type}:{normalized_id}"

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

    def daily_usage_count(self, *, subject_type: str, subject_id: str, usage_date: str = "") -> int:
        normalized_type, normalized_id = self.normalize_daily_subject(subject_type, subject_id)
        day = str(usage_date or "").strip() or self.today_utc_date()
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT explain_count
                FROM ai_explain_daily_usage
                WHERE subject_type = ? AND subject_id = ? AND usage_date = ?
                LIMIT 1
                """,
                (normalized_type, normalized_id, day),
            ).fetchone()
        finally:
            conn.close()
        return int(row["explain_count"] or 0) if row else 0

    def reserve_daily_usage(
        self,
        *,
        subject_type: str,
        subject_id: str,
        daily_limit: int,
        usage_date: str = "",
    ) -> bool:
        normalized_type, normalized_id = self.normalize_daily_subject(subject_type, subject_id)
        legacy_subject_key = self.usage_actor_key(
            subject_type=normalized_type,
            subject_id=normalized_id,
        )
        limit = max(0, int(daily_limit or 0))
        if limit <= 0:
            return False
        day = str(usage_date or "").strip() or self.today_utc_date()
        now = now_ms()
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                """
                SELECT explain_count
                FROM ai_explain_daily_usage
                WHERE subject_type = ? AND subject_id = ? AND usage_date = ?
                LIMIT 1
                """,
                (normalized_type, normalized_id, day),
            ).fetchone()
            used = int(row["explain_count"] or 0) if row else 0
            if used >= limit:
                return False
            if row:
                conn.execute(
                    """
                    UPDATE ai_explain_daily_usage
                    SET explain_count = explain_count + 1,
                        last_used_at = ?
                    WHERE subject_type = ? AND subject_id = ? AND usage_date = ?
                    """,
                    (now, normalized_type, normalized_id, day),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO ai_explain_daily_usage (
                      user_id,
                      date,
                      subject_type,
                      subject_id,
                      usage_date,
                      explain_count,
                      last_used_at
                    ) VALUES (?, ?, ?, ?, ?, 1, ?)
                    """,
                    (
                        legacy_subject_key,
                        day,
                        normalized_type,
                        normalized_id,
                        day,
                        now,
                    ),
                )
        return True

    def release_daily_usage(self, *, subject_type: str, subject_id: str, usage_date: str = "") -> None:
        normalized_type, normalized_id = self.normalize_daily_subject(subject_type, subject_id)
        day = str(usage_date or "").strip() or self.today_utc_date()
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                """
                SELECT explain_count
                FROM ai_explain_daily_usage
                WHERE subject_type = ? AND subject_id = ? AND usage_date = ?
                LIMIT 1
                """,
                (normalized_type, normalized_id, day),
            ).fetchone()
            if not row:
                return
            used = int(row["explain_count"] or 0)
            if used <= 0:
                return
            conn.execute(
                """
                UPDATE ai_explain_daily_usage
                SET explain_count = CASE
                    WHEN explain_count > 0 THEN explain_count - 1
                    ELSE 0
                  END,
                  last_used_at = ?
                WHERE subject_type = ? AND subject_id = ? AND usage_date = ?
                """,
                (now_ms(), normalized_type, normalized_id, day),
            )

    def list_recent_daily_usage(self, *, limit: int = 200) -> list[dict]:
        take = max(1, min(1000, int(limit or 200)))
        conn = self.db.connect()
        try:
            rows = conn.execute(
                """
                SELECT
                  user_id,
                  date,
                  subject_type,
                  subject_id,
                  usage_date,
                  explain_count,
                  last_used_at
                FROM ai_explain_daily_usage
                WHERE explain_count > 0
                ORDER BY last_used_at DESC
                LIMIT ?
                """,
                (take,),
            ).fetchall()
        finally:
            conn.close()
        return [
            {
                "subjectType": str(row["subject_type"] or "").strip() or "user",
                "subjectId": str(row["subject_id"] or "").strip() or str(row["user_id"] or ""),
                "usageDate": str(row["usage_date"] or "").strip() or str(row["date"] or ""),
                "userId": str(row["user_id"] or ""),
                "date": str(row["date"] or ""),
                "explainCount": int(row["explain_count"] or 0),
                "lastUsedAt": int(row["last_used_at"] or 0),
            }
            for row in rows
        ]

    def list_recent_usage_events(self, *, limit: int = 200) -> list[dict]:
        take = max(1, min(1000, int(limit or 200)))
        conn = self.db.connect()
        try:
            rows = conn.execute(
                """
                SELECT
                  user_id,
                  mode,
                  model,
                  cached,
                  status,
                  provider,
                  error_message,
                  created_at
                FROM ai_usage
                ORDER BY id DESC
                LIMIT ?
                """,
                (take,),
            ).fetchall()
        finally:
            conn.close()
        return [
            {
                "userId": str(row["user_id"] or ""),
                "mode": str(row["mode"] or ""),
                "model": str(row["model"] or ""),
                "cached": bool(row["cached"]),
                "status": str(row["status"] or ""),
                "provider": str(row["provider"] or ""),
                "errorMessage": str(row["error_message"] or ""),
                "createdAt": int(row["created_at"] or 0),
            }
            for row in rows
        ]

    def delete_user_data(self, user_id: str) -> None:
        target = sanitize_user_id(user_id)
        prefixed_target = self.usage_actor_key(subject_type="user", subject_id=target)
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                "DELETE FROM ai_usage WHERE user_id IN (?, ?)",
                (target, prefixed_target),
            )
            conn.execute(
                """
                DELETE FROM ai_explain_daily_usage
                WHERE (subject_type = 'user' AND subject_id = ?)
                  OR user_id IN (?, ?)
                """,
                (target, target, prefixed_target),
            )
