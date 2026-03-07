from __future__ import annotations

from dataclasses import dataclass

from backend.config import sanitize_user_id
from backend.repositories.ai import AIExplainRepository
from backend.repositories.billing import BillingStore
from backend.repositories.books import BookRepository
from backend.repositories.events import EventRepository
from backend.repositories.progress import ReadingProgressRepository
from backend.repositories.sync import SyncSnapshotRepository
from backend.repositories.users import UserRepository


def _merge_vocab(local_items: list[dict], remote_items: list[dict]) -> list[dict]:
    merged: dict[str, dict] = {}
    for item in [*remote_items, *local_items]:
        if not isinstance(item, dict):
            continue
        word = str(item.get("word", "") or "").strip()
        lemma = str(item.get("lemma", "") or "").strip()
        key = f"{lemma or word}|{word or lemma}"
        if not key.strip("|"):
            continue
        existing = merged.get(key)
        if existing is None:
            merged[key] = dict(item)
            continue
        merged[key] = {
            **existing,
            **item,
            "lookupCount": int(existing.get("lookupCount", 0) or 0)
            + int(item.get("lookupCount", 0) or 0),
            "createdAt": min(
                int(existing.get("createdAt", 0) or 0) or int(item.get("createdAt", 0) or 0),
                int(item.get("createdAt", 0) or 0) or int(existing.get("createdAt", 0) or 0),
            ),
            "nextReview": min(
                int(existing.get("nextReview", 0) or 0) or int(item.get("nextReview", 0) or 0),
                int(item.get("nextReview", 0) or 0) or int(existing.get("nextReview", 0) or 0),
            ),
        }
    return sorted(
        merged.values(),
        key=lambda item: int(item.get("createdAt", 0) or 0),
    )


def _merge_bookmarks(local_items: list[dict], remote_items: list[dict]) -> list[dict]:
    merged: dict[str, dict] = {}
    for item in [*remote_items, *local_items]:
        if not isinstance(item, dict):
            continue
        key = "|".join(
            [
                str(item.get("chapterId", "") or ""),
                str(item.get("paraIndex", "") or ""),
                str(item.get("charIndex", "") or ""),
                str(item.get("excerpt", "") or ""),
            ]
        )
        if not key.strip("|"):
            continue
        existing = merged.get(key)
        if existing is None or int(item.get("createdAt", 0) or 0) > int(existing.get("createdAt", 0) or 0):
            merged[key] = dict(item)
    return sorted(
        merged.values(),
        key=lambda item: int(item.get("createdAt", 0) or 0),
        reverse=True,
    )


def _merge_notes(local_items: list[dict], remote_items: list[dict]) -> list[dict]:
    merged: dict[str, dict] = {}
    for item in [*remote_items, *local_items]:
        if not isinstance(item, dict):
            continue
        key = str(item.get("id", "") or "").strip()
        if not key:
            key = "|".join(
                [
                    str(item.get("chapterId", "") or ""),
                    str(item.get("paraIndex", "") or ""),
                    str(item.get("start", "") or ""),
                    str(item.get("end", "") or ""),
                    str(item.get("word", "") or ""),
                ]
            )
        if not key.strip("|"):
            continue
        existing = merged.get(key)
        if existing is None or int(item.get("createdAt", 0) or 0) > int(existing.get("createdAt", 0) or 0):
            merged[key] = dict(item)
    return sorted(
        merged.values(),
        key=lambda item: int(item.get("createdAt", 0) or 0),
        reverse=True,
    )


def _pick_book_state(local_snapshot: dict, remote_snapshot: dict) -> tuple[dict | None, int]:
    local_saved_at = int(local_snapshot.get("savedAt", 0) or 0)
    remote_saved_at = int(remote_snapshot.get("savedAt", 0) or 0)
    if local_snapshot.get("book") and local_saved_at >= remote_saved_at:
        return local_snapshot.get("book"), int(local_snapshot.get("currentChapter", 0) or 0)
    if remote_snapshot.get("book"):
        return remote_snapshot.get("book"), int(remote_snapshot.get("currentChapter", 0) or 0)
    return None, 0


@dataclass(slots=True)
class AccountService:
    users: UserRepository
    sync_repository: SyncSnapshotRepository
    progress_repository: ReadingProgressRepository
    book_repository: BookRepository
    billing_store: BillingStore
    event_repository: EventRepository
    ai_repository: AIExplainRepository

    def register_account(
        self,
        *,
        user_id: str,
        local_snapshot: dict | None,
        anonymous_id: str = "",
        display_name: str = "",
    ) -> tuple[dict | None, str]:
        user_key = sanitize_user_id(user_id)
        user, created = self.users.register(
            user_key,
            display_name=display_name,
            merged_anonymous_id=anonymous_id,
        )
        if not created or user is None:
            return None, "该账号 ID 已存在，请换一个。"
        remote_state = self.sync_repository.pull(user_key) or {}
        remote_snapshot = remote_state.get("snapshot") if isinstance(remote_state, dict) else {}
        if not isinstance(remote_snapshot, dict):
            remote_snapshot = {}
        local = local_snapshot if isinstance(local_snapshot, dict) else {}
        merged_snapshot = self.merge_snapshot(
            user_id=user_key,
            local_snapshot=local,
            remote_snapshot=remote_snapshot,
        )
        self.sync_repository.push(user_key, {"updatedAt": merged_snapshot["savedAt"], "snapshot": merged_snapshot})
        self._persist_progress_from_snapshot(user_key, merged_snapshot)
        self.event_repository.track(
            "account_registered",
            user_id=user_key,
            payload={"anonymousId": str(anonymous_id or "").strip()},
        )
        return {
            "account": user,
            "snapshot": merged_snapshot,
            "billing": self.billing_store.get_billing(user_key),
        }, ""

    def merge_snapshot(
        self,
        *,
        user_id: str,
        local_snapshot: dict,
        remote_snapshot: dict,
    ) -> dict:
        local = local_snapshot if isinstance(local_snapshot, dict) else {}
        remote = remote_snapshot if isinstance(remote_snapshot, dict) else {}
        merged_book, merged_current_chapter = _pick_book_state(local, remote)
        merged = {
            "book": merged_book,
            "currentChapter": merged_current_chapter,
            "vocab": _merge_vocab(
                list(local.get("vocab") or []),
                list(remote.get("vocab") or []),
            ),
            "notes": _merge_notes(
                list(local.get("notes") or []),
                list(remote.get("notes") or []),
            ),
            "bookmarks": _merge_bookmarks(
                list(local.get("bookmarks") or []),
                list(remote.get("bookmarks") or []),
            ),
            "settings": {
                **(remote.get("settings") if isinstance(remote.get("settings"), dict) else {}),
                **(local.get("settings") if isinstance(local.get("settings"), dict) else {}),
            },
            "stats": {
                **(remote.get("stats") if isinstance(remote.get("stats"), dict) else {}),
                **(local.get("stats") if isinstance(local.get("stats"), dict) else {}),
            },
            "sync": {
                "userId": user_id,
                "accountMode": "registered",
            },
            "savedAt": max(
                int(local.get("savedAt", 0) or 0),
                int(remote.get("savedAt", 0) or 0),
            ),
        }
        if merged["savedAt"] <= 0:
            from backend.repositories.app_db import now_ms

            merged["savedAt"] = now_ms()
        return merged

    def _persist_progress_from_snapshot(self, user_id: str, snapshot: dict) -> None:
        book = snapshot.get("book") if isinstance(snapshot.get("book"), dict) else {}
        chapters = book.get("chapters") if isinstance(book.get("chapters"), list) else []
        if not book or not chapters:
            return
        chapter_index = max(0, int(snapshot.get("currentChapter", 0) or 0))
        chapter_index = min(chapter_index, max(0, len(chapters) - 1))
        chapter = chapters[chapter_index] if chapters else {}
        self.progress_repository.save_progress(
            user_id=user_id,
            book_id=str(book.get("id", "") or "").strip(),
            chapter_id=str(chapter.get("id", "") or "").strip(),
            chapter_index=chapter_index,
            paragraph_index=0,
            char_index=0,
        )

    def delete_book(self, *, user_id: str, book_id: str) -> bool:
        deleted = self.book_repository.delete_book(user_id=user_id, book_id=book_id)
        if deleted:
            self.progress_repository.delete_progress(user_id, book_id=book_id)
        return deleted

    def delete_cloud_data(self, user_id: str) -> dict:
        user_key = sanitize_user_id(user_id)
        self.sync_repository.delete(user_key)
        deleted_books = self.book_repository.delete_books_for_user(user_key)
        self.progress_repository.delete_progress(user_key)
        self.event_repository.track("cloud_data_deleted", user_id=user_key)
        return {"deletedBooks": deleted_books}

    def delete_account(self, user_id: str) -> dict:
        user_key = sanitize_user_id(user_id)
        deletion = self.delete_cloud_data(user_key)
        self.billing_store.delete_billing(user_key)
        self.ai_repository.delete_user_data(user_key)
        self.event_repository.delete_events_for_user(user_key)
        self.users.delete_user(user_key)
        return deletion

    def export_vocabulary(self, user_id: str) -> dict:
        user_key = sanitize_user_id(user_id)
        remote = self.sync_repository.pull(user_key) or {}
        snapshot = remote.get("snapshot") if isinstance(remote, dict) else {}
        if not isinstance(snapshot, dict):
            snapshot = {}
        return {
            "userId": user_key,
            "exportedAt": int(remote.get("updatedAt", 0) or 0),
            "vocab": list(snapshot.get("vocab") or []),
        }

    def export_progress(self, user_id: str) -> dict:
        user_key = sanitize_user_id(user_id)
        return {
            "userId": user_key,
            "exportedAt": max(
                [int(item.get("updatedAt", 0) or 0) for item in self.progress_repository.list_progress(user_key)]
                or [0]
            ),
            "progress": self.progress_repository.list_progress(user_key),
        }
