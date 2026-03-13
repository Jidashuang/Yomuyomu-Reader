from __future__ import annotations

import re
import time
from typing import Any
from urllib.parse import parse_qs


def dispatch_get(handler: Any, path: str, query: dict[str, list[str]]) -> bool:
    chapter_match = re.fullmatch(r"/api/books/([^/]+)/chapters/([^/]+)", path)
    if chapter_match:
        user_id = handler.sanitize_user_id(query.get("userId", ["default"])[0])
        handle_book_chapter(
            handler,
            book_id=chapter_match.group(1),
            chapter_id=chapter_match.group(2),
            user_id=user_id,
        )
        return True

    book_match = re.fullmatch(r"/api/books/([^/]+)", path)
    if book_match:
        user_id = handler.sanitize_user_id(query.get("userId", ["default"])[0])
        handle_book_metadata(handler, book_match.group(1), user_id=user_id)
        return True

    if path == "/api/sample-book":
        user_id = handler.sanitize_user_id(query.get("userId", ["default"])[0])
        handle_sample_book(handler, user_id=user_id)
        return True
    return False


def dispatch_post(handler: Any, path: str) -> bool:
    delete_book_match = re.fullmatch(r"/api/books/([^/]+)/delete", path)
    if delete_book_match:
        handle_delete_book(handler, delete_book_match.group(1))
        return True
    return False


def handle_sample_book(handler: Any, *, user_id: str) -> None:
    book = handler.library_import_service.sample_book_metadata()
    if not book:
        handler.json_response(503, {"ok": False, "error": "Sample book unavailable"})
        return
    metadata = handler._book_metadata_payload(book_id=str(book.get("id", "") or ""), user_id=user_id)
    if not metadata:
        handler.json_response(503, {"ok": False, "error": "Sample book unavailable"})
        return
    handler.event_repository.track("sample_opened", user_id=user_id)
    handler.json_response(200, {"ok": True, "book": metadata})


def handle_book_metadata(handler: Any, book_id: str, *, user_id: str) -> None:
    book = handler._book_metadata_payload(book_id=book_id, user_id=user_id)
    if not book:
        handler.json_response(404, {"ok": False, "error": "Book not found"})
        return
    handler.json_response(200, {"ok": True, "book": book})


def handle_book_chapter(handler: Any, *, book_id: str, chapter_id: str, user_id: str) -> None:
    chapter = handler._current_chapter_payload(book_id=book_id, chapter_id=chapter_id)
    if not chapter:
        handler.json_response(404, {"ok": False, "error": "Chapter not found"})
        return
    progress = handler.progress_repository.get_progress(user_id, book_id)
    handler.json_response(
        200,
        {
            "ok": True,
            "chapter": chapter,
            "progress": progress,
        },
    )


def handle_delete_book(handler: Any, book_id: str) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    user_id = handler.sanitize_user_id(str(payload.get("userId", "default") or "default"))
    billing = handler.require_registered_account(user_id=user_id, payload=payload)
    if billing is None:
        return
    if not handler.account_service.delete_book(user_id=user_id, book_id=book_id):
        handler.json_response(404, {"ok": False, "error": "Book not found"})
        return
    remote = handler.sync_repository.pull(user_id) or {}
    snapshot = remote.get("snapshot") if isinstance(remote, dict) else {}
    if isinstance(snapshot, dict):
        current_book = snapshot.get("book") if isinstance(snapshot.get("book"), dict) else {}
        if str(current_book.get("id", "") or "").strip() == str(book_id or "").strip():
            snapshot["book"] = None
            snapshot["currentChapter"] = 0
            snapshot["savedAt"] = int(time.time() * 1000)
            handler.sync_repository.push(user_id, snapshot)
    handler.event_repository.track("book_deleted", user_id=user_id, book_id=book_id)
    handler.json_response(200, {"ok": True, "billing": billing})
