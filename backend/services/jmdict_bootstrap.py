from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from backend.build_jmdict_db import build_db
from backend.config import DATA_DIR, DB_PATH
from backend.download_jmdict import DEFAULT_URL, download, extract_gzip

JMDICT_XML_PATH = DATA_DIR / "JMdict_e"
REQUIRED_ENTRY_COLUMNS = {"surface", "lemma", "reading", "gloss"}


def _candidate_urls() -> list[str]:
    configured = str(os.getenv("JMDICT_DOWNLOAD_URL", "") or "").strip()
    candidates = [configured, DEFAULT_URL]
    return [url for url in candidates if url]


def is_jmdict_db_ready(db_path: Path = DB_PATH) -> bool:
    if not db_path.exists() or db_path.stat().st_size <= 0:
        return False
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        columns = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(entries)").fetchall()
        }
        return REQUIRED_ENTRY_COLUMNS.issubset(columns)
    except sqlite3.Error:
        return False
    finally:
        if conn is not None:
            conn.close()


def _ensure_jmdict_xml(xml_path: Path) -> Path:
    if xml_path.exists() and xml_path.stat().st_size > 0:
        return xml_path

    xml_path.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    for url in _candidate_urls():
        gz_path = xml_path.with_suffix(".gz")
        try:
            print(f"[jmdict] downloading {url}")
            download(url, gz_path)
            print(f"[jmdict] extracting -> {xml_path}")
            extract_gzip(gz_path, xml_path)
            gz_path.unlink(missing_ok=True)
            return xml_path
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            gz_path.unlink(missing_ok=True)
    raise RuntimeError(f"Unable to download JMdict XML: {last_error}") from last_error


def ensure_jmdict_db(db_path: Path = DB_PATH, xml_path: Path = JMDICT_XML_PATH) -> bool:
    if is_jmdict_db_ready(db_path):
        return True

    xml_path = _ensure_jmdict_xml(xml_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()

    print(f"[jmdict] building SQLite DB at {db_path}")
    build_db(xml_path, db_path)
    return is_jmdict_db_ready(db_path)
