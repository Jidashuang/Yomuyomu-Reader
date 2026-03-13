from __future__ import annotations

import time
from typing import Any
from urllib.parse import parse_qs, urlparse


def dispatch_get(handler: Any, path: str, query: dict[str, list[str]]) -> bool:
    if path == "/api/sync/pull":
        handle_sync_pull(handler, query)
        return True
    return False


def dispatch_post(handler: Any, path: str) -> bool:
    if path == "/api/sync/push":
        handle_sync_push(handler)
        return True
    return False


def handle_sync_pull(handler: Any, query: dict[str, list[str]] | None = None) -> None:
    query = query if isinstance(query, dict) else parse_qs(urlparse(handler.path).query)
    user_id = handler.sanitize_user_id(query.get("userId", ["default"])[0])
    billing = handler.gate_plan_access(user_id=user_id, feature="sync_pull")
    if billing is None:
        handler.track_sync_event(user_id=user_id, direction="pull", success=False, error="entitlement")
        return
    payload = handler.sync_repository.pull(user_id) or {"updatedAt": 0, "snapshot": {}}
    handler.track_sync_event(user_id=user_id, direction="pull", success=True)
    handler.json_response(200, {"ok": True, "data": payload})


def handle_sync_push(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    user_id = handler.sanitize_user_id(str(payload.get("userId", "default")))
    billing = handler.gate_plan_access(user_id=user_id, feature="sync_push", payload=payload)
    if billing is None:
        handler.track_sync_event(user_id=user_id, direction="push", success=False, error="entitlement")
        return
    snapshot = payload.get("snapshot", {})
    if not isinstance(snapshot, dict):
        handler.track_sync_event(user_id=user_id, direction="push", success=False, error="invalid_snapshot")
        handler.json_response(400, {"ok": False, "error": "Invalid snapshot payload"})
        return
    data = {"updatedAt": int(time.time() * 1000), "snapshot": snapshot}
    handler.sync_repository.push(user_id, data)
    handler.track_sync_event(user_id=user_id, direction="push", success=True)
    handler.json_response(200, {"ok": True, "data": data})
