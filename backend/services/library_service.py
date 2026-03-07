from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path

import backend.config as settings
from backend.config import DEFAULT_SAMPLE_BOOK_SLUG, sanitize_user_id
from backend.repositories.books import BookRepository
from backend.repositories.events import EventRepository
from backend.repositories.import_jobs import ImportJobRepository
from backend.services.analysis_service import ChapterAnalysisService
from backend.services.import_service import parse_book_with_timeout
from backend.services.sample_book_service import build_sample_book


class LibraryImportService:
    def __init__(
        self,
        *,
        jobs: ImportJobRepository,
        books: BookRepository,
        events: EventRepository,
        analyzer: ChapterAnalysisService,
        import_jobs_dir: Path,
        max_attempts: int = 3,
        lease_ms: int = 20_000,
        max_workers: int = 2,
        start_background_threads: bool = True,
    ) -> None:
        self.jobs = jobs
        self.books = books
        self.events = events
        self.analyzer = analyzer
        self.import_jobs_dir = Path(import_jobs_dir)
        self.import_jobs_dir.mkdir(parents=True, exist_ok=True)
        self.max_attempts = max_attempts
        self.lease_ms = lease_ms
        self.max_workers = max_workers
        self._stop_event = threading.Event()
        self._active_jobs: set[str] = set()
        self._active_lock = threading.Lock()
        self._ensure_sample_book()
        if start_background_threads:
            self._start_background_threads()

    def _start_background_threads(self) -> None:
        threading.Thread(
            target=self._dispatch_loop,
            daemon=True,
            name="import-job-dispatcher",
        ).start()
        threading.Thread(
            target=self._reaper_loop,
            daemon=True,
            name="import-job-reaper",
        ).start()

    def _dispatch_loop(self) -> None:
        while not self._stop_event.is_set():
            with self._active_lock:
                can_spawn = len(self._active_jobs) < self.max_workers
            if not can_spawn:
                time.sleep(0.25)
                continue
            job = self.jobs.claim_next_job(lease_ms=self.lease_ms)
            if not job:
                time.sleep(0.25)
                continue
            with self._active_lock:
                self._active_jobs.add(job["jobId"])
            threading.Thread(
                target=self._process_claimed_job,
                args=(job,),
                daemon=True,
                name=f"import-worker-{job['jobId']}",
            ).start()

    def _reaper_loop(self) -> None:
        while not self._stop_event.is_set():
            reclaimed = self.jobs.requeue_stale_jobs(max_attempts=self.max_attempts)
            for job in reclaimed:
                if not job:
                    continue
                if job.get("status") == "queued":
                    self.events.track(
                        "import_job_requeued",
                        user_id=job.get("userId", ""),
                        payload={"jobId": job.get("jobId", "")},
                    )
            time.sleep(2.0)

    @staticmethod
    def _book_sha256(raw: bytes) -> str:
        return hashlib.sha256(raw).hexdigest()

    def _payload_path(self, book_sha256: str, file_type: str) -> Path:
        suffix = f".{str(file_type or '').strip().lower()}" if file_type else ".bin"
        return self.import_jobs_dir / f"{book_sha256}{suffix}"

    def enqueue_import(
        self,
        *,
        user_id: str,
        file_name: str,
        file_type: str,
        raw: bytes,
    ) -> dict:
        user_key = sanitize_user_id(user_id)
        book_sha256 = self._book_sha256(raw)
        idempotency_key = f"{user_key}:{book_sha256}"
        existing = self.books.find_existing_book(user_id=user_key, content_sha256=book_sha256)
        if existing:
            return self.jobs.create_job(
                user_id=user_key,
                file_name=file_name,
                file_type=file_type,
                book_sha256=book_sha256,
                idempotency_key=idempotency_key,
                status="completed",
                book_id=existing["id"],
                last_error="",
            )

        existing_job = self.jobs.find_latest_by_idempotency_key(
            user_id=user_key,
            idempotency_key=idempotency_key,
        )
        if existing_job and existing_job.get("status") in {"queued", "processing", "completed"}:
            return existing_job

        payload_path = self._payload_path(book_sha256, file_type)
        if not payload_path.exists():
            payload_path.write_bytes(raw)
        return self.jobs.create_job(
            user_id=user_key,
            file_name=file_name,
            file_type=file_type,
            book_sha256=book_sha256,
            idempotency_key=idempotency_key,
            payload_path=str(payload_path),
        )

    def _heartbeat_loop(self, job_id: str, stop_event: threading.Event) -> None:
        while not stop_event.wait(self.lease_ms / 4000):
            self.jobs.heartbeat(job_id, lease_ms=self.lease_ms)

    def _process_claimed_job(self, job: dict) -> None:
        stop_event = threading.Event()
        heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            args=(job["jobId"], stop_event),
            daemon=True,
            name=f"import-heartbeat-{job['jobId']}",
        )
        heartbeat_thread.start()
        try:
            payload_path = Path(job["payloadPath"])
            if not payload_path.exists():
                raise FileNotFoundError("Import payload is missing.")
            raw = payload_path.read_bytes()
            book = parse_book_with_timeout(
                raw,
                job["fileName"],
                job["fileType"],
                timeout_seconds=settings.IMPORT_PARSE_TIMEOUT_SECONDS,
            )
            analyses = self.analyzer.analyze_book(
                book,
                on_chapter_done=lambda *_: self.jobs.heartbeat(job["jobId"], lease_ms=self.lease_ms),
            )
            book_id = self.books.save_book_with_analysis(
                user_id=job["userId"],
                book=book,
                chapter_analyses=analyses,
                content_sha256=job["bookSha256"],
            )
            self.jobs.mark_completed(job["jobId"], book_id=book_id)
            self.events.track(
                "book_imported",
                user_id=job["userId"],
                book_id=book_id,
                payload={
                    "title": str(book.get("title", "") or ""),
                    "format": str(book.get("format", "") or ""),
                    "chapterCount": int(book.get("chapterCount", 0) or 0),
                    "sourceFileName": str(book.get("sourceFileName", "") or job["fileName"]),
                    "bookSha256": job["bookSha256"],
                },
            )
        except Exception as exc:
            self.jobs.mark_failed(job["jobId"], error_message=str(exc))
            self.events.track(
                "book_import_failed",
                user_id=job.get("userId", ""),
                payload={
                    "jobId": job.get("jobId", ""),
                    "fileName": job.get("fileName", ""),
                    "error": str(exc),
                },
            )
        finally:
            stop_event.set()
            self._cleanup_payload_file(job.get("payloadPath", ""))
            with self._active_lock:
                self._active_jobs.discard(job["jobId"])

    def _ensure_sample_book(self) -> None:
        existing = self.books.find_sample_book(DEFAULT_SAMPLE_BOOK_SLUG)
        if existing:
            first_chapter = existing["chapters"][0] if existing.get("chapters") else None
            if first_chapter:
                chapter_payload = self.books.get_chapter_payload(existing["id"], first_chapter["id"])
                if chapter_payload and self.analyzer.analysis_is_current(chapter_payload.get("analysis")):
                    return
        sample_book = build_sample_book()
        sample_sha = hashlib.sha256(json_repr(sample_book).encode("utf-8")).hexdigest()
        analyses = self.analyzer.analyze_book(sample_book)
        self.books.save_book_with_analysis(
            user_id="sample-user",
            book=sample_book,
            chapter_analyses=analyses,
            content_sha256=sample_sha,
            sample_slug=DEFAULT_SAMPLE_BOOK_SLUG,
        )

    def sample_book_metadata(self) -> dict | None:
        return self.books.find_sample_book(DEFAULT_SAMPLE_BOOK_SLUG)

    def _cleanup_payload_file(self, payload_path: str) -> None:
        target = Path(str(payload_path or "").strip())
        if not str(payload_path or "").strip():
            return
        try:
            target.unlink(missing_ok=True)
        except Exception:
            return


def json_repr(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
