#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path


CURRENT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = CURRENT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.handler import ApiHandler
from backend.config import (
    DB_PATH,
    APP_DB_PATH,
    BACKUP_DIR,
    BACKUP_RETENTION_DAYS,
    IMPORT_JOBS_DIR,
    PAY_CHANNEL_ALIPAY,
    PAY_CHANNEL_STRIPE,
    PAY_CHANNEL_WECHAT,
    PROJECT_ROOT as CONFIG_PROJECT_ROOT,
    ensure_dirs,
    payment_channels,
)
from backend.services.backup_service import ensure_backup_runtime


def run_server(host: str, port: int) -> None:
    ensure_dirs()
    backup_status = ensure_backup_runtime(
        db_path=APP_DB_PATH,
        uploads_dir=IMPORT_JOBS_DIR,
        backup_dir=BACKUP_DIR,
    )
    handler_cls = lambda *args, **kwargs: ApiHandler(  # noqa: E731
        *args,
        directory=str(CONFIG_PROJECT_ROOT),
        **kwargs,
    )
    with ThreadingHTTPServer((host, port), handler_cls) as server:
        print(f"YomuYomu server running at http://{host}:{port}")
        print(f"Tokenizer backend: {ApiHandler.tokenizer.backend}")
        print(f"JMDict DB: {DB_PATH} ({'found' if DB_PATH.exists() else 'not found'})")
        print(
            "Backup runtime: "
            f"dir={BACKUP_DIR} "
            f"restore={'ok' if backup_status.get('restoreOk') else 'failed'} "
            f"retention={BACKUP_RETENTION_DAYS}d"
        )
        channels = payment_channels()
        print(
            "Payment channels: "
            f"wechat={'on' if channels[PAY_CHANNEL_WECHAT] else 'off'}, "
            f"alipay={'on' if channels[PAY_CHANNEL_ALIPAY] else 'off'}, "
            f"stripe={'on' if channels[PAY_CHANNEL_STRIPE] else 'off'}"
        )
        print(
            "Official gateway: "
            f"wechat(order={'on' if ApiHandler._wechat_official_order_ready() else 'off'},"
            f"notify={'on' if ApiHandler._wechat_official_notify_ready() else 'off'}), "
            f"alipay(order={'on' if ApiHandler._alipay_official_order_ready() else 'off'},"
            f"notify={'on' if ApiHandler._alipay_official_notify_ready() else 'off'}), "
            f"stripe(order={'on' if ApiHandler._stripe_checkout_ready() else 'off'},"
            f"notify={'on' if bool(channels[PAY_CHANNEL_STRIPE]) else 'off'})"
        )
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


def main() -> None:
    parser = argparse.ArgumentParser(description="YomuYomu backend server")
    default_host = os.getenv("HOST", "0.0.0.0").strip() or "0.0.0.0"
    try:
        default_port = int(os.getenv("PORT", "8000") or 8000)
    except ValueError:
        default_port = 8000
    parser.add_argument("--host", default=default_host, help="Bind host")
    parser.add_argument("--port", type=int, default=default_port, help="Bind port")
    args = parser.parse_args()
    run_server(args.host, args.port)


if __name__ == "__main__":
    main()
