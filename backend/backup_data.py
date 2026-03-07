#!/usr/bin/env python3
from __future__ import annotations

import json

from backend.config import APP_DB_PATH, BACKUP_DIR, BACKUP_RETENTION_DAYS, IMPORT_JOBS_DIR, ensure_dirs
from backend.services.backup_service import create_backup


def main() -> None:
    ensure_dirs()
    result = create_backup(
        db_path=APP_DB_PATH,
        uploads_dir=IMPORT_JOBS_DIR,
        backup_dir=BACKUP_DIR,
        retention_days=BACKUP_RETENTION_DAYS,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
