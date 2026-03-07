from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path


BUSY_TIMEOUT_MS = 5000


def now_ms() -> int:
    return int(time.time() * 1000)


def json_dumps(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False)


def json_loads(raw: str | bytes | None, fallback):  # noqa: ANN001
    try:
        parsed = json.loads(raw or "")
    except Exception:
        return fallback
    return parsed


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {str(row[1]) for row in rows}


class AppDatabase:
    _schema_lock = threading.Lock()

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.ensure_schema()

    def _configure_connection(self, conn: sqlite3.Connection) -> None:
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        conn.execute("PRAGMA foreign_keys=ON")

    def ensure_schema(self) -> None:
        with self._schema_lock:
            conn = sqlite3.connect(self.path, check_same_thread=False)
            try:
                self._configure_connection(conn)
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
                conn.execute("PRAGMA foreign_keys=ON")
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                      name TEXT PRIMARY KEY,
                      applied_at INTEGER NOT NULL
                    )
                    """
                )
                self._apply_migrations(conn)
                conn.commit()
            finally:
                conn.close()

    def _mark_migration(self, conn: sqlite3.Connection, name: str) -> None:
        conn.execute(
            "INSERT OR REPLACE INTO schema_migrations (name, applied_at) VALUES (?, ?)",
            (name, now_ms()),
        )

    def _ensure_column(
        self,
        conn: sqlite3.Connection,
        table_name: str,
        column_name: str,
        ddl_suffix: str,
    ) -> None:
        if column_name in _table_columns(conn, table_name):
            return
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {ddl_suffix}")

    def _apply_migrations(self, conn: sqlite3.Connection) -> None:
        applied = {
            str(row["name"])
            for row in conn.execute("SELECT name FROM schema_migrations").fetchall()
        }

        if "001_core_schema" not in applied:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS plans (
                  user_id TEXT PRIMARY KEY,
                  plan TEXT NOT NULL DEFAULT 'free',
                  updated_at INTEGER NOT NULL DEFAULT 0,
                  source TEXT NOT NULL DEFAULT 'manual',
                  last_paid_channel TEXT NOT NULL DEFAULT '',
                  last_order_id TEXT NOT NULL DEFAULT '',
                  plan_expire_at INTEGER NOT NULL DEFAULT 0,
                  subscription_status TEXT NOT NULL DEFAULT '',
                  stripe_customer_id TEXT NOT NULL DEFAULT '',
                  stripe_subscription_id TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS books (
                  id TEXT PRIMARY KEY,
                  user_id TEXT NOT NULL,
                  title TEXT NOT NULL,
                  format TEXT NOT NULL,
                  chapter_count INTEGER NOT NULL DEFAULT 0,
                  normalized_version INTEGER NOT NULL DEFAULT 1,
                  imported_at INTEGER NOT NULL DEFAULT 0,
                  source_file_name TEXT NOT NULL DEFAULT '',
                  created_at INTEGER NOT NULL DEFAULT 0,
                  content_sha256 TEXT NOT NULL DEFAULT '',
                  stats_json TEXT NOT NULL DEFAULT '{}',
                  sample_slug TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS chapters (
                  book_id TEXT NOT NULL,
                  chapter_id TEXT NOT NULL,
                  chapter_index INTEGER NOT NULL,
                  title TEXT NOT NULL,
                  text TEXT NOT NULL,
                  paragraphs_json TEXT NOT NULL,
                  source_type TEXT NOT NULL DEFAULT '',
                  source_ref TEXT NOT NULL DEFAULT '',
                  PRIMARY KEY (book_id, chapter_id),
                  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS chapter_analysis (
                  book_id TEXT NOT NULL,
                  chapter_id TEXT NOT NULL,
                  chapter_index INTEGER NOT NULL,
                  analysis_json TEXT NOT NULL,
                  updated_at INTEGER NOT NULL DEFAULT 0,
                  PRIMARY KEY (book_id, chapter_id),
                  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS import_jobs (
                  job_id TEXT PRIMARY KEY,
                  user_id TEXT NOT NULL,
                  file_name TEXT NOT NULL,
                  file_type TEXT NOT NULL DEFAULT '',
                  status TEXT NOT NULL,
                  book_id TEXT NOT NULL DEFAULT '',
                  error_message TEXT NOT NULL DEFAULT '',
                  created_at INTEGER NOT NULL DEFAULT 0,
                  updated_at INTEGER NOT NULL DEFAULT 0,
                  completed_at INTEGER NOT NULL DEFAULT 0,
                  attempt_count INTEGER NOT NULL DEFAULT 0,
                  heartbeat_at INTEGER NOT NULL DEFAULT 0,
                  lease_expires_at INTEGER NOT NULL DEFAULT 0,
                  last_error TEXT NOT NULL DEFAULT '',
                  idempotency_key TEXT NOT NULL DEFAULT '',
                  book_sha256 TEXT NOT NULL DEFAULT '',
                  payload_path TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS ai_explain_cache (
                  cache_key TEXT PRIMARY KEY,
                  sentence_hash TEXT NOT NULL,
                  context_hash TEXT NOT NULL,
                  mode TEXT NOT NULL,
                  model TEXT NOT NULL,
                  prompt_version TEXT NOT NULL,
                  provider TEXT NOT NULL DEFAULT '',
                  response_json TEXT NOT NULL,
                  created_at INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS ai_usage (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id TEXT NOT NULL,
                  cache_key TEXT NOT NULL,
                  sentence_hash TEXT NOT NULL,
                  context_hash TEXT NOT NULL,
                  mode TEXT NOT NULL,
                  model TEXT NOT NULL,
                  prompt_version TEXT NOT NULL,
                  cached INTEGER NOT NULL DEFAULT 0,
                  status TEXT NOT NULL,
                  provider TEXT NOT NULL DEFAULT '',
                  error_message TEXT NOT NULL DEFAULT '',
                  created_at INTEGER NOT NULL DEFAULT 0,
                  reservation_token TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  event_name TEXT NOT NULL,
                  user_id TEXT NOT NULL DEFAULT '',
                  book_id TEXT NOT NULL DEFAULT '',
                  chapter_id TEXT NOT NULL DEFAULT '',
                  payload_json TEXT NOT NULL DEFAULT '{}',
                  created_at INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS reading_progress (
                  user_id TEXT NOT NULL,
                  book_id TEXT NOT NULL,
                  chapter_id TEXT NOT NULL DEFAULT '',
                  chapter_index INTEGER NOT NULL DEFAULT 0,
                  paragraph_index INTEGER NOT NULL DEFAULT 0,
                  char_index INTEGER NOT NULL DEFAULT 0,
                  updated_at INTEGER NOT NULL DEFAULT 0,
                  PRIMARY KEY (user_id, book_id)
                );

                CREATE TABLE IF NOT EXISTS sync_snapshots (
                  user_id TEXT PRIMARY KEY,
                  snapshot_json TEXT NOT NULL,
                  updated_at INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS users (
                  user_id TEXT PRIMARY KEY,
                  account_token TEXT NOT NULL DEFAULT '',
                  display_name TEXT NOT NULL DEFAULT '',
                  is_registered INTEGER NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL DEFAULT 0,
                  updated_at INTEGER NOT NULL DEFAULT 0,
                  merged_anonymous_id TEXT NOT NULL DEFAULT '',
                  deleted_at INTEGER NOT NULL DEFAULT 0
                );
                """
            )
            self._mark_migration(conn, "001_core_schema")

        if "003_backfill_columns" not in applied:
            self._ensure_column(conn, "books", "content_sha256", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "books", "stats_json", "TEXT NOT NULL DEFAULT '{}'")
            self._ensure_column(conn, "books", "sample_slug", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "plans", "grace_until_at", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "plans", "payment_failed_at", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "plans", "billing_state", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "import_jobs", "attempt_count", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "import_jobs", "heartbeat_at", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "import_jobs", "lease_expires_at", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "import_jobs", "last_error", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "import_jobs", "idempotency_key", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "import_jobs", "book_sha256", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "import_jobs", "payload_path", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "ai_usage", "reservation_token", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "account_token", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "display_name", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "is_registered", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "users", "created_at", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "users", "updated_at", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "users", "merged_anonymous_id", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "deleted_at", "INTEGER NOT NULL DEFAULT 0")
            self._mark_migration(conn, "003_backfill_columns")

        if "002_indexes" not in applied:
            conn.executescript(
                """
                CREATE INDEX IF NOT EXISTS idx_books_user_created
                  ON books(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_books_user_sha
                  ON books(user_id, content_sha256);
                CREATE INDEX IF NOT EXISTS idx_chapters_book_index
                  ON chapters(book_id, chapter_index);
                CREATE INDEX IF NOT EXISTS idx_chapter_analysis_book_index
                  ON chapter_analysis(book_id, chapter_index);
                CREATE INDEX IF NOT EXISTS idx_import_jobs_user_created
                  ON import_jobs(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_import_jobs_status_lease
                  ON import_jobs(status, lease_expires_at);
                CREATE INDEX IF NOT EXISTS idx_import_jobs_user_hash
                  ON import_jobs(user_id, book_sha256);
                CREATE INDEX IF NOT EXISTS idx_ai_explain_cache_created
                  ON ai_explain_cache(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created
                  ON ai_usage(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_usage_reservation
                  ON ai_usage(user_id, reservation_token);
                CREATE INDEX IF NOT EXISTS idx_events_name_created
                  ON events(event_name, created_at DESC);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account_token
                  ON users(account_token);
                """
            )
            self._mark_migration(conn, "002_indexes")

        if "004_accounts_and_billing_state" not in applied:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                  user_id TEXT PRIMARY KEY,
                  account_token TEXT NOT NULL DEFAULT '',
                  display_name TEXT NOT NULL DEFAULT '',
                  is_registered INTEGER NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL DEFAULT 0,
                  updated_at INTEGER NOT NULL DEFAULT 0,
                  merged_anonymous_id TEXT NOT NULL DEFAULT '',
                  deleted_at INTEGER NOT NULL DEFAULT 0
                );
                """
            )
            self._ensure_column(conn, "plans", "grace_until_at", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "plans", "payment_failed_at", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "plans", "billing_state", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "account_token", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "display_name", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "is_registered", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "users", "created_at", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "users", "updated_at", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "users", "merged_anonymous_id", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "deleted_at", "INTEGER NOT NULL DEFAULT 0")
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account_token ON users(account_token)"
            )
            self._mark_migration(conn, "004_accounts_and_billing_state")

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, check_same_thread=False)
        self._configure_connection(conn)
        return conn

    @contextmanager
    def transaction(self, *, immediate: bool = False):
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
