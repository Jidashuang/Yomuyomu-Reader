from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs, urlparse

import backend.config as settings


def dispatch_get(handler: Any, path: str, query: dict[str, list[str]]) -> bool:
    if path == "/api/admin/ops/daily":
        handle_admin_ops_daily(handler, query)
        return True
    if path == "/api/admin/users":
        handle_admin_users(handler)
        return True
    if path == "/api/admin/ai-usage":
        handle_admin_ai_usage(handler, query)
        return True
    if path == "/api/export/vocab":
        handle_export_vocab(handler, query)
        return True
    if path == "/api/export/progress":
        handle_export_progress(handler, query)
        return True
    return False


def dispatch_post(handler: Any, path: str) -> bool:
    if path == "/api/auth/register":
        handle_auth_register(handler)
        return True
    if path == "/api/auth/login":
        handle_auth_login(handler)
        return True
    if path == "/api/cloud/delete":
        handle_cloud_delete(handler)
        return True
    if path == "/api/account/delete":
        handle_account_delete(handler)
        return True
    return False


def handle_auth_register(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    username = handler.user_repository.normalize_username(str(payload.get("username", "") or ""))
    password = str(payload.get("password", "") or "")
    if username or password:
        if not handler.user_repository.valid_username(username):
            handler.json_response(
                400,
                {
                    "ok": False,
                    "code": "INVALID_USERNAME",
                    "error": "用户名仅支持 3-32 位小写字母、数字、下划线和连字符。",
                },
            )
            return
        if username in {"default"} or username.startswith("guest_") or username.startswith("guest-"):
            handler.json_response(
                400,
                {
                    "ok": False,
                    "code": "INVALID_USERNAME",
                    "error": "用户名不可使用 guest/default 保留前缀。",
                },
            )
            return
        if len(password) < 8:
            handler.json_response(
                400,
                {
                    "ok": False,
                    "code": "WEAK_PASSWORD",
                    "error": "密码至少需要 8 位。",
                },
            )
            return
        if handler.user_repository.find_by_username(username):
            handler.json_response(
                409,
                {
                    "ok": False,
                    "code": "USERNAME_EXISTS",
                    "error": "该用户名已存在，请换一个。",
                },
            )
            return
        user_id = handler.sanitize_user_id(username)
        result, error = handler.account_service.register_account(
            user_id=user_id,
            local_snapshot=payload.get("snapshot") if isinstance(payload.get("snapshot"), dict) else {},
            anonymous_id=str(payload.get("anonymousId", "") or "").strip(),
            display_name=username,
        )
        if result is None:
            handler.json_response(
                409,
                {
                    "ok": False,
                    "code": "ACCOUNT_EXISTS",
                    "error": error or "该用户名已存在。",
                },
            )
            return
        if not handler.user_repository.set_credentials(
            user_id=user_id,
            username=username,
            password_hash=handler.user_repository.hash_password(password),
        ):
            handler.json_response(
                409,
                {
                    "ok": False,
                    "code": "USERNAME_EXISTS",
                    "error": "该用户名已存在，请换一个。",
                },
            )
            return
        refreshed_user = handler.user_repository.get_user(user_id)
        if refreshed_user is not None:
            result["account"] = refreshed_user
        result["userId"] = user_id
        handler.json_response(200, {"ok": True, **result})
        return
    user_id = handler.sanitize_user_id(str(payload.get("userId", "") or ""))
    if not user_id or user_id == "default" or user_id.startswith("guest_") or user_id.startswith("guest-"):
        handler.json_response(
            400,
            {
                "ok": False,
                "code": "INVALID_ACCOUNT_ID",
                "error": "请使用一个稳定的账号 ID，不能使用 guest/default。",
            },
        )
        return
    result, error = handler.account_service.register_account(
        user_id=user_id,
        local_snapshot=payload.get("snapshot") if isinstance(payload.get("snapshot"), dict) else {},
        anonymous_id=str(payload.get("anonymousId", "") or "").strip(),
        display_name=str(payload.get("displayName", "") or "").strip(),
    )
    if result is None:
        handler.json_response(
            409,
            {
                "ok": False,
                "code": "ACCOUNT_EXISTS",
                "error": error or "该账号已存在。",
            },
        )
        return
    handler.json_response(200, {"ok": True, **result})


def handle_auth_login(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    username = handler.user_repository.normalize_username(str(payload.get("username", "") or ""))
    password = str(payload.get("password", "") or "")
    account = handler.user_repository.authenticate(username=username, password=password)
    if account is None:
        handler.json_response(
            401,
            {
                "ok": False,
                "code": "INVALID_CREDENTIALS",
                "error": "用户名或密码错误。",
            },
        )
        return
    handler.json_response(
        200,
        {
            "ok": True,
            "account": {
                "userId": account["userId"],
                "username": account["username"] or username,
                "accountToken": account["accountToken"],
            },
        },
    )


def handle_cloud_delete(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    user_id = handler.sanitize_user_id(str(payload.get("userId", "default") or "default"))
    billing = handler.require_registered_account(user_id=user_id, payload=payload)
    if billing is None:
        return
    result = handler.account_service.delete_cloud_data(user_id)
    handler.json_response(200, {"ok": True, "billing": handler.billing_payload(user_id), **result})


def handle_account_delete(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    user_id = handler.sanitize_user_id(str(payload.get("userId", "default") or "default"))
    billing = handler.require_registered_account(user_id=user_id, payload=payload)
    if billing is None:
        return
    result = handler.account_service.delete_account(user_id)
    handler.json_response(200, {"ok": True, **result})


def handle_export_vocab(handler: Any, query: dict[str, list[str]] | None = None) -> None:
    query = query if isinstance(query, dict) else parse_qs(urlparse(handler.path).query)
    user_id = handler.sanitize_user_id(query.get("userId", ["default"])[0])
    billing = handler.require_registered_account(user_id=user_id)
    if billing is None:
        return
    handler.json_response(200, {"ok": True, **handler.account_service.export_vocabulary(user_id)})


def handle_export_progress(handler: Any, query: dict[str, list[str]] | None = None) -> None:
    query = query if isinstance(query, dict) else parse_qs(urlparse(handler.path).query)
    user_id = handler.sanitize_user_id(query.get("userId", ["default"])[0])
    billing = handler.require_registered_account(user_id=user_id)
    if billing is None:
        return
    handler.json_response(200, {"ok": True, **handler.account_service.export_progress(user_id)})


def handle_admin_ops_daily(handler: Any, query: dict[str, list[str]] | None = None) -> None:
    if not settings.BILLING_ADMIN_TOKEN:
        handler.json_response(
            404,
            {"ok": False, "code": "OPS_DISABLED", "error": "Admin ops 未启用。"},
        )
        return
    provided = str(handler.headers.get("X-Admin-Token", "") or "").strip()
    if provided != settings.BILLING_ADMIN_TOKEN:
        handler.json_response(
            403,
            {"ok": False, "code": "INVALID_ADMIN_TOKEN", "error": "管理员令牌无效。"},
        )
        return
    query = query if isinstance(query, dict) else parse_qs(urlparse(handler.path).query)
    try:
        days = int(query.get("days", ["14"])[0] or 14)
    except ValueError:
        days = 14
    handler.json_response(200, {"ok": True, "rows": handler.ops_service.daily_metrics(days=days)})


def handle_admin_users(handler: Any) -> None:
    if not handler._require_admin_token():
        return
    users = []
    for row in handler.user_repository.list_admin_users():
        user_id = str(row.get("userId", "") or "")
        billing = handler.billing_store.get_billing(user_id)
        created_at = int(row.get("createdAt", 0) or 0)
        users.append(
            {
                "userId": user_id,
                "username": str(row.get("username", "") or ""),
                "createdAt": (
                    datetime.fromtimestamp(created_at / 1000, tz=timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z")
                    if created_at > 0
                    else ""
                ),
                "planName": str(billing.get("planName", "") or "free"),
                "planStatus": str(billing.get("planStatus", "") or "inactive"),
                "updatedAt": int(billing.get("updatedAt", 0) or 0),
            }
        )
    handler.json_response(200, {"ok": True, "users": users})


def handle_admin_ai_usage(handler: Any, query: dict[str, list[str]] | None = None) -> None:
    if not handler._require_admin_token():
        return
    query = query if isinstance(query, dict) else parse_qs(urlparse(handler.path).query)
    try:
        limit = max(1, min(1000, int(query.get("limit", ["200"])[0] or 200)))
    except ValueError:
        limit = 200
    rows = handler.ai_repository.list_recent_daily_usage(limit=limit)
    events = handler.ai_repository.list_recent_usage_events(limit=limit)
    for row in rows:
        row["lastUsedAtIso"] = handler.utc_iso8601(int(row.get("lastUsedAt", 0) or 0))
    for row in events:
        row["createdAtIso"] = handler.utc_iso8601(int(row.get("createdAt", 0) or 0))
    handler.json_response(
        200,
        {
            "ok": True,
            "rows": rows,
            "events": events,
        },
    )
