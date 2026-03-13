from __future__ import annotations

from typing import Any

import backend.config as settings
from backend.services.ai_service import (
    AIExplainLimitError,
    AIExplainNotConfiguredError,
    AIExplainProviderError,
)


def dispatch_post(handler: Any, path: str) -> bool:
    if path == "/api/nlp/tokenize":
        handle_tokenize(handler)
        return True
    if path == "/api/dict/lookup":
        handle_lookup(handler)
        return True
    if path == "/api/ai/explain":
        handle_ai_explain(handler)
        return True
    return False


def handle_tokenize(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    text = str(payload.get("text", ""))
    if not text.strip():
        handler.json_response(200, {"ok": True, "tokens": []})
        return
    tokens = handler.tokenizer.tokenize(text)
    handler.json_response(200, {"ok": True, "backend": handler.tokenizer.backend, "tokens": tokens})


def handle_lookup(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    surface = str(payload.get("surface", "")).strip()
    lemma = str(payload.get("lemma", "")).strip()
    entries = handler.dict_store.lookup(surface, lemma)
    handler.json_response(200, {"ok": True, "entries": entries})


def handle_ai_explain(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    sentence = str(payload.get("sentence", "") or "")
    subject = handler.resolve_explain_subject(payload)
    subject_type = str(subject.get("subjectType", "guest") or "guest").strip().lower()
    subject_id = str(subject.get("subjectId", "") or "").strip()
    billing_user_id = handler.sanitize_user_id(str(subject.get("billingUserId", "default") or "default"))
    if not subject_id:
        subject_id = billing_user_id

    billing = handler.gate_plan_access(user_id=billing_user_id, feature="ai_explain", payload=payload)
    if billing is None:
        return

    allow_subject, retry_after_subject = handler.ai_rate_limiter.check(
        key=f"explain:{subject_type}:{subject_id}",
        limit=settings.AI_EXPLAIN_RATE_LIMIT_MAX_PER_USER,
        window_seconds=settings.AI_EXPLAIN_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allow_subject:
        handler.respond_entitlement_error(
            status=429,
            code="AI_EXPLAIN_RATE_LIMITED",
            error=f"解释请求过于频繁，请 {retry_after_subject} 秒后再试。",
            billing=billing,
            extra={"retryAfterSeconds": retry_after_subject},
        )
        return
    request_ip = handler.client_ip()
    allow_ip, retry_after_ip = handler.ai_rate_limiter.check(
        key=f"explain:ip:{request_ip}",
        limit=settings.AI_EXPLAIN_RATE_LIMIT_MAX_PER_IP,
        window_seconds=settings.AI_EXPLAIN_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allow_ip:
        handler.respond_entitlement_error(
            status=429,
            code="AI_EXPLAIN_RATE_LIMITED",
            error=f"该网络请求过于频繁，请 {retry_after_ip} 秒后再试。",
            billing=billing,
            extra={"retryAfterSeconds": retry_after_ip},
        )
        return
    guest_ip_quota_reserved = False
    if subject_type == "guest" and settings.AI_EXPLAIN_GUEST_IP_DAILY_LIMIT > 0:
        guest_ip_quota_reserved = handler.ai_repository.reserve_daily_usage(
            subject_type="guest_ip",
            subject_id=request_ip,
            daily_limit=settings.AI_EXPLAIN_GUEST_IP_DAILY_LIMIT,
        )
        if not guest_ip_quota_reserved:
            billing = handler.billing_payload(
                billing_user_id,
                usage_subject_type=subject_type,
                usage_subject_id=subject_id,
            )
            handler.json_response(
                429,
                {
                    "ok": False,
                    "code": "EXPLAIN_LIMIT_REACHED",
                    "error": "You have reached today's AI explanation limit.",
                    "billing": billing,
                },
            )
            return
    try:
        result = handler.ai_explain_service.explain(
            subject_type=subject_type,
            subject_id=subject_id,
            plan=billing["plan"],
            sentence=sentence,
            context=payload.get("context"),
            mode=str(payload.get("mode", "reader") or "reader"),
            model=str(payload.get("model", "") or ""),
            prompt_version=str(payload.get("promptVersion", "") or ""),
        )
    except ValueError as exc:
        if guest_ip_quota_reserved:
            handler.ai_repository.release_daily_usage(
                subject_type="guest_ip",
                subject_id=request_ip,
            )
        handler.json_response(
            400,
            {"ok": False, "code": "INVALID_SENTENCE", "error": str(exc)},
        )
        return
    except AIExplainLimitError as exc:
        if guest_ip_quota_reserved:
            handler.ai_repository.release_daily_usage(
                subject_type="guest_ip",
                subject_id=request_ip,
            )
        billing = handler.billing_payload(
            billing_user_id,
            usage_subject_type=subject_type,
            usage_subject_id=subject_id,
        )
        handler.json_response(
            429,
            {
                "ok": False,
                "code": "EXPLAIN_LIMIT_REACHED",
                "error": str(exc),
                "billing": billing,
            },
        )
        return
    except AIExplainNotConfiguredError as exc:
        if guest_ip_quota_reserved:
            handler.ai_repository.release_daily_usage(
                subject_type="guest_ip",
                subject_id=request_ip,
            )
        handler.json_response(
            503,
            {
                "ok": False,
                "code": "AI_NOT_CONFIGURED",
                "error": str(exc),
                "billing": billing,
            },
        )
        return
    except AIExplainProviderError as exc:
        if guest_ip_quota_reserved:
            handler.ai_repository.release_daily_usage(
                subject_type="guest_ip",
                subject_id=request_ip,
            )
        handler.json_response(
            503,
            {
                "ok": False,
                "code": "AI_PROVIDER_ERROR",
                "error": str(exc),
                "billing": billing,
            },
        )
        return
    except RuntimeError as exc:
        if guest_ip_quota_reserved:
            handler.ai_repository.release_daily_usage(
                subject_type="guest_ip",
                subject_id=request_ip,
            )
        handler.json_response(
            503,
            {
                "ok": False,
                "code": "AI_PROVIDER_ERROR",
                "error": str(exc),
                "billing": billing,
            },
        )
        return
    billing = handler.billing_payload(
        billing_user_id,
        usage_subject_type=subject_type,
        usage_subject_id=subject_id,
    )
    handler.event_repository.track(
        "ai_explain_requested",
        user_id=billing_user_id,
        book_id=str(payload.get("bookId", "") or "").strip(),
        chapter_id=str(payload.get("chapterId", "") or "").strip(),
        payload={
            "cached": bool(result.get("cached")),
            "mode": str(payload.get("mode", "reader") or "reader"),
            "model": result.get("model", ""),
            "subjectType": subject_type,
        },
    )
    if result.get("cached"):
        handler.event_repository.track(
            "ai_explain_cache_hit",
            user_id=billing_user_id,
            book_id=str(payload.get("bookId", "") or "").strip(),
            chapter_id=str(payload.get("chapterId", "") or "").strip(),
        )
    handler.json_response(200, {"ok": True, "billing": billing, **result})
