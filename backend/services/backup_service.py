from __future__ import annotations

import shutil
import sqlite3
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from backend.repositories.app_db import now_ms


def _timestamp_slug(timestamp_ms: int) -> str:
    return datetime.utcfromtimestamp(timestamp_ms / 1000).strftime("%Y%m%d-%H%M%S")


def _sqlite_backup(src: Path, dest: Path) -> None:
    src.parent.mkdir(parents=True, exist_ok=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not src.exists():
        dest.touch()
        return
    source = sqlite3.connect(src)
    target = sqlite3.connect(dest)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()


def _zip_directory(src_dir: Path, dest_zip: Path) -> None:
    dest_zip.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(dest_zip, "w", compression=ZIP_DEFLATED) as archive:
        if not src_dir.exists():
            return
        for path in sorted(src_dir.rglob("*")):
            if path.is_dir():
                continue
            archive.write(path, arcname=path.relative_to(src_dir))


def create_backup(*, db_path: Path, uploads_dir: Path, backup_dir: Path, retention_days: int) -> dict:
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp_ms = now_ms()
    slug = _timestamp_slug(timestamp_ms)
    db_backup_path = backup_dir / f"app-{slug}.sqlite3"
    uploads_backup_path = backup_dir / f"uploads-{slug}.zip"
    _sqlite_backup(db_path, db_backup_path)
    _zip_directory(uploads_dir, uploads_backup_path)
    prune_backups(backup_dir=backup_dir, retention_days=retention_days)
    return {
        "createdAt": timestamp_ms,
        "dbBackupPath": str(db_backup_path),
        "uploadsBackupPath": str(uploads_backup_path),
    }


def prune_backups(*, backup_dir: Path, retention_days: int) -> None:
    if retention_days <= 0 or not backup_dir.exists():
        return
    cutoff = datetime.utcnow() - timedelta(days=retention_days)
    for path in backup_dir.iterdir():
        try:
            modified_at = datetime.utcfromtimestamp(path.stat().st_mtime)
        except FileNotFoundError:
            continue
        if modified_at < cutoff:
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)


def verify_restore(*, db_backup_path: Path) -> tuple[bool, str]:
    if not db_backup_path.exists():
        return False, f"backup missing: {db_backup_path}"
    with tempfile.TemporaryDirectory(prefix="yomuyomu-restore-check-") as tempdir:
        probe_path = Path(tempdir) / "restore.sqlite3"
        shutil.copy2(db_backup_path, probe_path)
        conn = sqlite3.connect(probe_path)
        try:
            row = conn.execute("PRAGMA integrity_check").fetchone()
        finally:
            conn.close()
    status = str(row[0]) if row else ""
    return status == "ok", status or "integrity_check failed"


def ensure_backup_runtime(*, db_path: Path, uploads_dir: Path, backup_dir: Path) -> dict:
    backup_dir.mkdir(parents=True, exist_ok=True)
    uploads_dir.mkdir(parents=True, exist_ok=True)
    latest_db_backup = max(backup_dir.glob("app-*.sqlite3"), default=None, key=lambda item: item.stat().st_mtime)
    if latest_db_backup is None:
        with tempfile.TemporaryDirectory(prefix="yomuyomu-backup-probe-") as tempdir:
            probe_path = Path(tempdir) / "probe.sqlite3"
            _sqlite_backup(db_path, probe_path)
            restore_ok, restore_message = verify_restore(db_backup_path=probe_path)
        return {
            "backupDir": str(backup_dir),
            "latestDbBackup": "",
            "restoreOk": restore_ok,
            "restoreMessage": restore_message,
        }
    restore_ok, restore_message = verify_restore(db_backup_path=latest_db_backup)
    return {
        "backupDir": str(backup_dir),
        "latestDbBackup": str(latest_db_backup),
        "restoreOk": restore_ok,
        "restoreMessage": restore_message,
    }
