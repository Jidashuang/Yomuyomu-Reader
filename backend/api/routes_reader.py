from __future__ import annotations

import re
from typing import Any


def dispatch_post(handler: Any, path: str) -> bool:
    progress_match = re.fullmatch(r"/api/books/([^/]+)/progress", path)
    if progress_match:
        handle_save_progress(handler, progress_match.group(1))
        return True
    if path == "/api/events":
        handle_event_ingest(handler)
        return True
    if path == "/api/feedback":
        handle_feedback(handler)
        return True
    return False


def handle_save_progress(handler: Any, book_id: str) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    user_id = handler.sanitize_user_id(str(payload.get("userId", "default") or "default"))
    saved = handler.progress_repository.save_progress(
        user_id=user_id,
        book_id=book_id,
        chapter_id=str(payload.get("chapterId", "") or "").strip(),
        chapter_index=int(payload.get("chapterIndex", 0) or 0),
        paragraph_index=int(payload.get("paragraphIndex", 0) or 0),
        char_index=int(payload.get("charIndex", 0) or 0),
    )
    handler.json_response(200, {"ok": True, "progress": saved})


def handle_event_ingest(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    event_name = str(payload.get("name", "") or payload.get("event", "")).strip()
    if not event_name:
        handler.json_response(400, {"ok": False, "error": "Missing event name"})
        return
    handler.event_repository.track(
        event_name,
        user_id=handler.sanitize_user_id(str(payload.get("userId", "default") or "default")),
        book_id=str(payload.get("bookId", "") or "").strip(),
        chapter_id=str(payload.get("chapterId", "") or "").strip(),
        payload=payload.get("payload") if isinstance(payload.get("payload"), dict) else {},
    )
    handler.json_response(200, {"ok": True})


def handle_feedback(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    message = str(payload.get("message", "") or "").strip()
    kind = str(payload.get("kind", "feedback") or "feedback").strip().lower()
    user_id = handler.sanitize_user_id(str(payload.get("userId", "default") or "default"))
    if not message:
        handler.json_response(400, {"ok": False, "error": "反馈内容不能为空。"})
        return
    handler.event_repository.track(
        "feedback_submitted",
        user_id=user_id,
        book_id=str(payload.get("bookId", "") or "").strip(),
        chapter_id=str(payload.get("chapterId", "") or "").strip(),
        payload={
            "kind": kind,
            "message": message[:500],
        },
    )
    handler.json_response(200, {"ok": True})
