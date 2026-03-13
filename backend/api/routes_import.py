from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import backend.config as settings


def dispatch_get(handler: Any, path: str) -> bool:
    job_match = re.fullmatch(r"/api/import-jobs/([^/]+)", path)
    if job_match:
        handle_import_job_status(handler, job_match.group(1))
        return True
    return False


def dispatch_post(handler: Any, path: str) -> bool:
    if path == "/api/import":
        handle_import(handler)
        return True
    if path == "/api/books/import":
        handle_async_import(handler)
        return True
    return False


def handle_import(handler: Any) -> None:
    content_type = handler.headers.get("Content-Type", "")
    if "multipart/form-data" not in content_type:
        handler.json_response(400, {"ok": False, "error": "Use multipart/form-data with file"})
        return
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length <= 0:
        handler.json_response(400, {"ok": False, "error": "Empty body"})
        return
    if length > settings.IMPORT_MAX_FILE_BYTES + 64 * 1024:
        handler.json_response(413, {"ok": False, "error": "上传文件过大。"})
        return
    raw_body = handler.rfile.read(length)
    fields, files = handler.parse_multipart_form(raw_body, content_type)
    if not files or "file" not in files:
        handler.json_response(400, {"ok": False, "error": "Missing `file` field"})
        return
    user_id = handler.sanitize_user_id((fields or {}).get("userId", "default"))
    filename, raw = files["file"]
    filename = filename or "book.txt"
    ext = Path(filename).suffix.lower().lstrip(".")
    if len(raw) > settings.IMPORT_MAX_FILE_BYTES:
        handler.json_response(413, {"ok": False, "error": "上传文件过大。"})
        return
    billing = handler.gate_plan_access(
        user_id=user_id,
        feature="import",
        payload=fields or {},
        file_ext=ext or "txt",
    )
    if billing is None:
        return
    try:
        result = handler.parse_book_content(raw, filename, ext)
        handler.json_response(200, {"ok": True, "book": result})
    except Exception as exc:
        handler.json_response(500, {"ok": False, "error": str(exc)})


def handle_async_import(handler: Any) -> None:
    content_type = handler.headers.get("Content-Type", "")
    if "multipart/form-data" not in content_type:
        handler.json_response(400, {"ok": False, "error": "Use multipart/form-data with file"})
        return
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length <= 0:
        handler.json_response(400, {"ok": False, "error": "Empty body"})
        return
    if length > settings.IMPORT_MAX_FILE_BYTES + 64 * 1024:
        handler.json_response(413, {"ok": False, "error": "上传文件过大。"})
        return
    raw_body = handler.rfile.read(length)
    fields, files = handler.parse_multipart_form(raw_body, content_type)
    if not files or "file" not in files:
        handler.json_response(400, {"ok": False, "error": "Missing `file` field"})
        return

    user_id = handler.sanitize_user_id((fields or {}).get("userId", "default"))
    filename, raw = files["file"]
    filename = filename or "book.txt"
    ext = Path(filename).suffix.lower().lstrip(".")
    if len(raw) > settings.IMPORT_MAX_FILE_BYTES:
        handler.json_response(413, {"ok": False, "error": "上传文件过大。"})
        return
    billing = handler.gate_plan_access(
        user_id=user_id,
        feature="import",
        payload=fields or {},
        file_ext=ext or "txt",
    )
    if billing is None:
        return
    allow_user, retry_after_user = handler.import_rate_limiter.check(
        key=f"import:user:{user_id}",
        limit=settings.IMPORT_RATE_LIMIT_MAX_PER_USER,
        window_seconds=settings.IMPORT_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allow_user:
        handler.respond_entitlement_error(
            status=429,
            code="IMPORT_RATE_LIMITED",
            error=f"导入过于频繁，请 {retry_after_user} 秒后再试。",
            billing=billing,
            extra={"retryAfterSeconds": retry_after_user},
        )
        return
    allow_ip, retry_after_ip = handler.import_rate_limiter.check(
        key=f"import:ip:{handler.client_ip()}",
        limit=settings.IMPORT_RATE_LIMIT_MAX_PER_IP,
        window_seconds=settings.IMPORT_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allow_ip:
        handler.respond_entitlement_error(
            status=429,
            code="IMPORT_RATE_LIMITED",
            error=f"该网络请求过于频繁，请 {retry_after_ip} 秒后再试。",
            billing=billing,
            extra={"retryAfterSeconds": retry_after_ip},
        )
        return

    handler.event_repository.track(
        "book_import_requested",
        user_id=user_id,
        payload={"fileName": filename, "fileType": ext or "txt"},
    )
    job = handler.library_import_service.enqueue_import(
        user_id=user_id,
        file_name=filename,
        file_type=ext or "txt",
        raw=raw,
    )
    handler.json_response(
        202,
        {
            "ok": True,
            "jobId": job["jobId"],
            "job": job,
        },
    )


def handle_import_job_status(handler: Any, job_id: str) -> None:
    job = handler.import_job_repository.get_job(job_id)
    if not job:
        handler.json_response(404, {"ok": False, "error": "Import job not found"})
        return
    handler.json_response(200, {"ok": True, "job": job})
