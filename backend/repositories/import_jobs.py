from __future__ import annotations

import secrets
from pathlib import Path

from backend.config import sanitize_user_id
from backend.repositories.app_db import AppDatabase, now_ms


JOB_STATUSES = {"queued", "processing", "completed", "failed"}


class ImportJobRepository:
    def __init__(self, db_path: Path) -> None:
        self.db = AppDatabase(db_path)

    @staticmethod
    def _normalize_status(status: str) -> str:
        normalized = str(status or "").strip().lower()
        return normalized if normalized in JOB_STATUSES else "queued"

    @staticmethod
    def _row_to_job(row) -> dict | None:  # noqa: ANN001
        if row is None:
            return None
        return {
            "jobId": str(row["job_id"]),
            "userId": str(row["user_id"]),
            "fileName": str(row["file_name"]),
            "fileType": str(row["file_type"]),
            "status": str(row["status"]),
            "bookId": str(row["book_id"] or ""),
            "error": str(row["last_error"] or row["error_message"] or ""),
            "createdAt": int(row["created_at"] or 0),
            "updatedAt": int(row["updated_at"] or 0),
            "completedAt": int(row["completed_at"] or 0),
            "attemptCount": int(row["attempt_count"] or 0),
            "heartbeatAt": int(row["heartbeat_at"] or 0),
            "leaseExpiresAt": int(row["lease_expires_at"] or 0),
            "lastError": str(row["last_error"] or ""),
            "idempotencyKey": str(row["idempotency_key"] or ""),
            "bookSha256": str(row["book_sha256"] or ""),
            "payloadPath": str(row["payload_path"] or ""),
        }

    def create_job(
        self,
        *,
        user_id: str,
        file_name: str,
        file_type: str,
        book_sha256: str,
        idempotency_key: str,
        payload_path: str = "",
        status: str = "queued",
        book_id: str = "",
        last_error: str = "",
    ) -> dict:
        job_id = f"job_{now_ms()}_{secrets.token_hex(4)}"
        now = now_ms()
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                INSERT INTO import_jobs (
                  job_id,
                  user_id,
                  file_name,
                  file_type,
                  status,
                  book_id,
                  error_message,
                  created_at,
                  updated_at,
                  completed_at,
                  attempt_count,
                  heartbeat_at,
                  lease_expires_at,
                  last_error,
                  idempotency_key,
                  book_sha256,
                  payload_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    sanitize_user_id(user_id),
                    str(file_name or "").strip() or "book.txt",
                    str(file_type or "").strip().lower(),
                    self._normalize_status(status),
                    str(book_id or "").strip(),
                    str(last_error or "").strip(),
                    now,
                    now,
                    now if status in {"completed", "failed"} else 0,
                    str(last_error or "").strip(),
                    str(idempotency_key or "").strip(),
                    str(book_sha256 or "").strip(),
                    str(payload_path or "").strip(),
                ),
            )
        return self.get_job(job_id)

    def get_job(self, job_id: str) -> dict | None:
        conn = self.db.connect()
        try:
            row = conn.execute(
                "SELECT * FROM import_jobs WHERE job_id = ? LIMIT 1",
                (str(job_id or "").strip(),),
            ).fetchone()
        finally:
            conn.close()
        return self._row_to_job(row)

    def find_latest_by_idempotency_key(self, *, user_id: str, idempotency_key: str) -> dict | None:
        key = str(idempotency_key or "").strip()
        if not key:
            return None
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT *
                FROM import_jobs
                WHERE user_id = ? AND idempotency_key = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (sanitize_user_id(user_id), key),
            ).fetchone()
        finally:
            conn.close()
        return self._row_to_job(row)

    def claim_next_job(self, *, lease_ms: int) -> dict | None:
        now = now_ms()
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                """
                SELECT job_id
                FROM import_jobs
                WHERE status = 'queued'
                ORDER BY created_at ASC
                LIMIT 1
                """
            ).fetchone()
            if not row:
                return None
            job_id = str(row["job_id"])
            conn.execute(
                """
                UPDATE import_jobs
                SET status = 'processing',
                    attempt_count = attempt_count + 1,
                    heartbeat_at = ?,
                    lease_expires_at = ?,
                    updated_at = ?,
                    last_error = ''
                WHERE job_id = ?
                """,
                (now, now + lease_ms, now, job_id),
            )
        return self.get_job(job_id)

    def heartbeat(self, job_id: str, *, lease_ms: int) -> dict | None:
        now = now_ms()
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                UPDATE import_jobs
                SET heartbeat_at = ?,
                    lease_expires_at = ?,
                    updated_at = ?
                WHERE job_id = ? AND status = 'processing'
                """,
                (now, now + lease_ms, now, str(job_id or "").strip()),
            )
        return self.get_job(job_id)

    def mark_completed(self, job_id: str, *, book_id: str) -> dict | None:
        now = now_ms()
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                UPDATE import_jobs
                SET status = 'completed',
                    book_id = ?,
                    updated_at = ?,
                    completed_at = ?,
                    heartbeat_at = ?,
                    lease_expires_at = ?,
                    error_message = '',
                    last_error = ''
                WHERE job_id = ?
                """,
                (
                    str(book_id or "").strip(),
                    now,
                    now,
                    now,
                    now,
                    str(job_id or "").strip(),
                ),
            )
        return self.get_job(job_id)

    def mark_failed(self, job_id: str, *, error_message: str) -> dict | None:
        now = now_ms()
        message = str(error_message or "").strip()
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                UPDATE import_jobs
                SET status = 'failed',
                    updated_at = ?,
                    completed_at = ?,
                    heartbeat_at = ?,
                    lease_expires_at = ?,
                    error_message = ?,
                    last_error = ?
                WHERE job_id = ?
                """,
                (now, now, now, now, message, message, str(job_id or "").strip()),
            )
        return self.get_job(job_id)

    def requeue_stale_jobs(self, *, max_attempts: int) -> list[dict]:
        now = now_ms()
        reclaimed: list[str] = []
        failed: list[str] = []
        with self.db.transaction(immediate=True) as conn:
            rows = conn.execute(
                """
                SELECT job_id, attempt_count
                FROM import_jobs
                WHERE status = 'processing' AND lease_expires_at > 0 AND lease_expires_at < ?
                """,
                (now,),
            ).fetchall()
            for row in rows:
                job_id = str(row["job_id"])
                attempt_count = int(row["attempt_count"] or 0)
                if attempt_count >= max_attempts:
                    conn.execute(
                        """
                        UPDATE import_jobs
                        SET status = 'failed',
                            updated_at = ?,
                            completed_at = ?,
                            error_message = 'Import job exceeded max retries.',
                            last_error = 'Import job exceeded max retries.'
                        WHERE job_id = ?
                        """,
                        (now, now, job_id),
                    )
                    failed.append(job_id)
                    continue
                conn.execute(
                    """
                    UPDATE import_jobs
                    SET status = 'queued',
                        updated_at = ?,
                        heartbeat_at = 0,
                        lease_expires_at = 0,
                        last_error = 'Worker lease expired; job requeued.'
                    WHERE job_id = ?
                    """,
                    (now, job_id),
                )
                reclaimed.append(job_id)
        return [self.get_job(job_id) for job_id in [*reclaimed, *failed] if self.get_job(job_id)]
