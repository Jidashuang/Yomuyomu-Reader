from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, urlparse

import backend.config as settings


def dispatch_get(handler: Any, path: str, query: dict[str, list[str]]) -> bool:
    if path == "/api/billing/plan":
        user_id = handler.sanitize_user_id(query.get("userId", ["default"])[0])
        handler.json_response(200, {"ok": True, "billing": handler.billing_payload(user_id)})
        return True
    if path == "/api/payment/options":
        _handle_payment_options(handler)
        return True
    if path == "/api/billing/order-status":
        handle_billing_order_status(handler, query)
        return True
    return False


def dispatch_post(handler: Any, path: str) -> bool:
    admin_plan_match = re.fullmatch(r"/api/admin/users/([^/]+)/plan", path)
    if admin_plan_match:
        handle_admin_user_plan_update(handler, admin_plan_match.group(1))
        return True

    if path == "/api/billing/create-order":
        handle_billing_create_order(handler)
        return True
    if path == "/api/billing/create-checkout-session":
        handle_billing_create_checkout_session(handler)
        return True
    if path == "/api/billing/checkout-complete":
        handle_billing_checkout_complete(handler)
        return True
    if path == "/api/billing/create-portal-session":
        handle_billing_create_portal_session(handler)
        return True
    if path == "/api/billing/confirm-paid":
        handle_billing_confirm_paid(handler, source="manual-confirm")
        return True
    if path == "/api/billing/stripe/webhook":
        handle_billing_stripe_webhook(handler)
        return True
    if path == "/api/billing/wechat/notify":
        handle_billing_notify(handler, settings.PAY_CHANNEL_WECHAT)
        return True
    if path == "/api/billing/alipay/notify":
        handle_billing_notify(handler, settings.PAY_CHANNEL_ALIPAY)
        return True
    if path == "/api/billing/set-plan":
        handle_set_billing_plan(handler)
        return True
    return False


def _handle_payment_options(handler: Any) -> None:
    if not settings.payment_enabled():
        handler.json_response(
            200,
            {
                "enabled": False,
                "appBaseUrl": handler.resolve_app_base_url(),
                "stripe": {
                    "publishableKey": str(settings.STRIPE_PUBLISHABLE_KEY or "").strip(),
                },
            },
        )
        return
    handler.json_response(
        200,
        {
            "enabled": True,
            "appBaseUrl": handler.resolve_app_base_url(),
            "channels": settings.payment_channels(),
            "stripe": {
                "paymentLinkReady": handler._stripe_payment_link_ready(),
                "paymentLink": handler.stripe_payment_link_url(),
                "checkoutReady": handler._stripe_checkout_ready(),
                "publishableKey": str(settings.STRIPE_PUBLISHABLE_KEY or "").strip(),
            },
        },
    )


def handle_admin_user_plan_update(handler: Any, raw_user_id: str) -> None:
    if not handler._require_admin_token():
        return
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    user_id = handler.sanitize_user_id(raw_user_id)
    if not handler.user_repository.get_user(user_id):
        handler.json_response(
            404,
            {"ok": False, "code": "USER_NOT_FOUND", "error": "用户不存在。"},
        )
        return
    plan = settings.normalize_plan(str(payload.get("plan", settings.FREE_PLAN)))
    status = settings.normalize_plan_status(
        str(payload.get("status", "active" if plan == settings.PRO_PLAN else "inactive"))
    )
    handler.billing_store.set_plan(
        user_id,
        plan,
        source="admin-manual",
        plan_status=status,
        subscription_status="manual",
        billing_state="active" if status == "active" else "inactive",
    )
    handler.json_response(200, {"ok": True, "billing": handler.billing_payload(user_id)})


def handle_billing_create_order(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    user_id = handler.sanitize_user_id(str(payload.get("userId", "default")))
    handler.json_response(
        410,
        {
            "ok": False,
            "code": "LEGACY_PAYMENT_DISABLED",
            "error": "旧版支付流程已停用，请使用 Stripe Checkout。",
            "billing": handler.billing_payload(user_id),
        },
    )


def handle_billing_create_checkout_session(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    user_id = handler.sanitize_user_id(str(payload.get("userId", "default")))
    interval = settings.normalize_stripe_interval(
        payload.get("interval")
        or payload.get("billing_cycle")
        or payload.get("billingCycle")
        or "monthly"
    )
    if interval == "yearly" and not settings.stripe_price_id("yearly"):
        handler.json_response(
            400,
            {
                "ok": False,
                "code": "YEARLY_NOT_CONFIGURED",
                "error": "Stripe 年付套餐尚未配置。",
            },
        )
        return
    if interval == "monthly" and not settings.stripe_price_id("monthly"):
        handler.json_response(
            400,
            {
                "ok": False,
                "code": "MONTHLY_NOT_CONFIGURED",
                "error": "Stripe 月付套餐尚未配置。",
            },
        )
        return
    billing = handler.require_registered_account(user_id=user_id, payload=payload)
    if billing is None:
        return
    channels = billing["paymentChannels"]
    if not channels.get(settings.PAY_CHANNEL_STRIPE):
        handler.json_response(
            400,
            {
                "ok": False,
                "code": "STRIPE_NOT_ENABLED",
                "error": "Stripe 支付未启用或配置不完整。",
                "billing": billing,
            },
        )
        return
    if not handler._stripe_checkout_ready():
        handler.json_response(
            503,
            {
                "ok": False,
                "code": "STRIPE_NOT_READY",
                "error": "Stripe Checkout 未就绪，请检查秘钥和 Price 配置。",
                "billing": billing,
            },
        )
        return
    order = handler.order_store.create_order(
        user_id=user_id,
        channel=settings.PAY_CHANNEL_STRIPE,
        amount_fen=settings.PRO_PRICE_FEN,
        plan=settings.PRO_PLAN,
    )
    session, error = handler._create_stripe_checkout_session(
        user_id=user_id,
        interval=interval,
        order_id=order["orderId"],
    )
    if session is None:
        handler.json_response(
            502,
            {
                "ok": False,
                "code": "STRIPE_SESSION_FAILED",
                "error": error or "Stripe Checkout Session 创建失败。",
                "billing": billing,
            },
        )
        return
    checkout_url = str(session.get("url", "") or "").strip()
    if checkout_url:
        order = handler.order_store.set_pay_url(order["orderId"], checkout_url) or order
    order_response = handler._sanitize_order_for_response(order)
    handler.json_response(
        200,
        {
            "ok": True,
            "url": checkout_url,
            "checkoutUrl": checkout_url,
            "sessionId": str(session.get("id", "") or "").strip(),
            "interval": interval,
            "order": order_response,
            "billing": handler.billing_payload(user_id),
        },
    )


def handle_billing_checkout_complete(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    session_id = str(payload.get("sessionId", "") or "").strip()
    user_id_hint = handler.sanitize_user_id(str(payload.get("userId", "default")))
    if not session_id:
        handler.json_response(400, {"ok": False, "error": "Missing sessionId"})
        return
    session, error = handler._stripe_retrieve_checkout_session(session_id)
    if session is None:
        handler.json_response(
            502,
            {
                "ok": False,
                "code": "STRIPE_SESSION_FETCH_FAILED",
                "error": error or "无法查询 Stripe Checkout Session。",
            },
        )
        return
    billing, order, sync_error = handler._sync_billing_from_checkout_session(
        session,
        source="stripe-checkout-complete",
        user_id_hint=user_id_hint,
    )
    if billing is None:
        handler.json_response(
            400,
            {
                "ok": False,
                "code": "CHECKOUT_NOT_COMPLETED",
                "error": sync_error or "Checkout 尚未完成。",
            },
        )
        return
    handler.json_response(
        200,
        {
            "ok": True,
            "billing": handler.billing_payload(billing["userId"]),
            "billingCycle": handler.stripe_normalize_billing_cycle(billing.get("billingCycle")),
            "order": order or {},
            "session": {
                "id": str(session.get("id", "") or "").strip(),
                "status": str(session.get("status", "") or "").strip(),
                "paymentStatus": str(session.get("payment_status", "") or "").strip(),
            },
        },
    )


def handle_billing_create_portal_session(handler: Any) -> None:
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    user_id = handler.sanitize_user_id(str(payload.get("userId", "default")))
    billing = handler.require_registered_account(user_id=user_id, payload=payload)
    if billing is None:
        return
    if not billing["paymentChannels"].get(settings.PAY_CHANNEL_STRIPE):
        handler.json_response(
            400,
            {
                "ok": False,
                "code": "STRIPE_NOT_ENABLED",
                "error": "Stripe 支付未启用或配置不完整。",
                "billing": billing,
            },
        )
        return
    if not handler._stripe_portal_ready():
        handler.json_response(
            503,
            {
                "ok": False,
                "code": "STRIPE_PORTAL_NOT_READY",
                "error": "Stripe Billing Portal 未就绪。",
                "billing": billing,
            },
        )
        return
    customer_id = str(billing.get("stripeCustomerId", "") or "").strip()
    if not customer_id:
        handler.json_response(
            400,
            {
                "ok": False,
                "code": "NO_STRIPE_CUSTOMER",
                "error": "当前账号还没有 Stripe 客户记录，请先完成一次订阅支付。",
                "billing": billing,
            },
        )
        return
    session, error = handler._create_stripe_portal_session(customer_id=customer_id)
    if session is None:
        handler.json_response(
            502,
            {
                "ok": False,
                "code": "STRIPE_PORTAL_SESSION_FAILED",
                "error": error or "无法创建 Stripe Portal 会话。",
                "billing": billing,
            },
        )
        return
    handler.json_response(
        200,
        {
            "ok": True,
            "portalUrl": str(session.get("url", "") or "").strip(),
            "billing": billing,
        },
    )


def handle_billing_stripe_webhook(handler: Any) -> None:
    raw = handler.read_raw_body()
    if not handler._stripe_sdk_ready():
        handler.json_response(
            503,
            {
                "ok": False,
                "code": "STRIPE_NOT_READY",
                "error": "Stripe SDK 未就绪，请检查 STRIPE_SECRET_KEY 与依赖安装。",
            },
        )
        return
    payload: dict | None = None
    stripe_module = handler.stripe_module()
    if settings.STRIPE_WEBHOOK_SECRET:
        signature = str(handler.headers.get("Stripe-Signature", "") or "").strip()
        try:
            event_obj = stripe_module.Webhook.construct_event(
                payload=raw,
                sig_header=signature,
                secret=settings.STRIPE_WEBHOOK_SECRET,
                tolerance=settings.STRIPE_WEBHOOK_TOLERANCE_SECONDS
                if settings.STRIPE_WEBHOOK_TOLERANCE_SECONDS > 0
                else None,
            )
            payload = handler._stripe_object_to_dict(event_obj)
        except Exception as exc:
            handler.json_response(
                400,
                {
                    "ok": False,
                    "code": "INVALID_STRIPE_SIGNATURE",
                    "error": handler._stripe_error_message(exc, "Stripe Webhook 签名校验失败。"),
                },
            )
            return
    else:
        payload = handler._parse_json_or_form_raw(raw, handler.headers.get("Content-Type", ""))
        if payload is None or not isinstance(payload, dict):
            handler.json_response(400, {"ok": False, "error": "Invalid webhook payload"})
            return
    event_type = str(payload.get("type", "") or "").strip()
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    event_obj = data.get("object") if isinstance(data.get("object"), dict) else {}
    if event_type == "checkout.session.completed":
        handler._sync_billing_from_checkout_session(
            event_obj,
            source="stripe-webhook-checkout",
        )
    elif event_type in {"customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"}:
        handler._sync_billing_from_stripe_subscription(
            subscription=event_obj,
            source=f"stripe-webhook:{event_type}",
        )
    elif event_type in {"invoice.paid", "invoice.payment_failed"}:
        customer = event_obj.get("customer")
        customer_id = (
            str(customer.get("id", "") or "").strip()
            if isinstance(customer, dict)
            else str(customer or "").strip()
        )
        subscription = event_obj.get("subscription")
        subscription_id = (
            str(subscription.get("id", "") or "").strip()
            if isinstance(subscription, dict)
            else str(subscription or "").strip()
        )
        metadata = event_obj.get("metadata") if isinstance(event_obj.get("metadata"), dict) else {}
        handler._sync_billing_from_stripe_subscription(
            subscription_id=subscription_id,
            customer_id=customer_id,
            metadata=metadata,
            source=f"stripe-webhook:{event_type}",
            last_order_id=str(event_obj.get("id", "") or "").strip(),
        )
    handler.json_response(200, {"ok": True, "received": True})


def handle_billing_order_status(handler: Any, query: dict[str, list[str]] | None = None) -> None:
    query = query if isinstance(query, dict) else parse_qs(urlparse(handler.path).query)
    order_id = str(query.get("orderId", [""])[0] or "").strip()
    if not order_id:
        handler.json_response(400, {"ok": False, "error": "Missing orderId"})
        return
    order = handler.order_store.get_order(order_id)
    if not order:
        handler.json_response(404, {"ok": False, "error": "Order not found"})
        return
    query_user = handler.sanitize_user_id(query.get("userId", [""])[0])
    if query_user and query_user != "default" and query_user != order["userId"]:
        handler.json_response(
            403,
            {
                "ok": False,
                "error": "Order does not belong to current user",
            },
        )
        return
    if order["status"] == "paid":
        handler._sync_plan_from_paid_order(order)
    order = handler._sanitize_order_for_response(order)
    handler.json_response(
        200,
        {
            "ok": True,
            "order": order,
            "billing": handler.billing_payload(order["userId"]),
        },
    )


def handle_billing_confirm_paid(handler: Any, source: str = "manual-confirm") -> None:
    payload = handler.read_json_or_form_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid payment payload"})
        return
    order_id = handler._extract_order_id(payload)
    user_id = "default"
    if order_id:
        existing_order = handler.order_store.get_order(order_id)
        if existing_order:
            user_id = handler.sanitize_user_id(str(existing_order.get("userId", "default")))
    handler.json_response(
        410,
        {
            "ok": False,
            "code": "LEGACY_PAYMENT_DISABLED",
            "error": "手动确认支付流程已停用，请使用 Stripe Checkout 验单。",
            "billing": handler.billing_payload(user_id),
        },
    )


def handle_billing_notify(handler: Any, channel: str) -> None:
    normalized_channel = settings.normalize_pay_channel(channel)
    raw = handler.read_raw_body()
    payload: dict | None
    official_used = False
    official_error = ""
    if normalized_channel == settings.PAY_CHANNEL_WECHAT:
        payload, official_used, official_error = handler._parse_wechat_official_notify(raw)
    else:
        payload = handler._parse_json_or_form_raw(raw, handler.headers.get("Content-Type", ""))
        if payload is None:
            handler.json_response(400, {"ok": False, "error": "Invalid notify payload"})
            return
        if normalized_channel == settings.PAY_CHANNEL_ALIPAY:
            payload, official_used, official_error = handler._parse_alipay_official_notify(payload)
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid notify payload"})
        return
    if official_used and official_error:
        if normalized_channel == settings.PAY_CHANNEL_ALIPAY:
            handler.text_response(400, "failure")
        elif normalized_channel == settings.PAY_CHANNEL_WECHAT:
            handler.json_response(400, {"code": "FAIL", "message": official_error})
        else:
            handler.json_response(400, {"ok": False, "error": official_error})
        return
    official_verified = official_used and not official_error
    if not official_verified and settings.BILLING_NOTIFY_TOKEN and not handler._payment_token_valid():
        handler.json_response(
            403,
            {
                "ok": False,
                "code": "INVALID_PAYMENT_TOKEN",
                "error": "支付通知令牌无效。",
            },
        )
        return
    if not handler._notify_success(normalized_channel, payload):
        if official_verified and normalized_channel == settings.PAY_CHANNEL_ALIPAY:
            handler.text_response(200, "success")
            return
        if official_verified and normalized_channel == settings.PAY_CHANNEL_WECHAT:
            handler.json_response(200, {"code": "SUCCESS", "message": "成功", "ignored": True})
            return
        handler.json_response(200, {"ok": True, "ignored": True})
        return
    order_id = handler._extract_order_id(payload)
    if not order_id:
        handler.json_response(400, {"ok": False, "error": "Missing orderId in notify payload"})
        return
    external_trade_no = handler._extract_external_trade_no(payload)
    order = handler.order_store.mark_paid(
        order_id,
        paid_source=f"{normalized_channel}-notify",
        external_trade_no=external_trade_no,
    )
    if not order:
        handler.json_response(404, {"ok": False, "error": "Order not found"})
        return
    handler._track_payment_success(order)
    handler._sync_plan_from_paid_order(order)
    if official_verified and normalized_channel == settings.PAY_CHANNEL_ALIPAY:
        handler.text_response(200, "success")
        return
    if official_verified and normalized_channel == settings.PAY_CHANNEL_WECHAT:
        handler.json_response(200, {"code": "SUCCESS", "message": "成功", "order": order})
        return
    handler.json_response(200, {"ok": True, "order": order})


def handle_set_billing_plan(handler: Any) -> None:
    if not settings.BILLING_ALLOW_MANUAL_PLAN_CHANGE:
        handler.json_response(
            403,
            {
                "ok": False,
                "code": "MANUAL_PLAN_CHANGE_DISABLED",
                "error": "手动套餐切换已禁用。",
            },
        )
        return
    if not settings.BILLING_ADMIN_TOKEN:
        handler.json_response(
            403,
            {
                "ok": False,
                "code": "ADMIN_TOKEN_REQUIRED",
                "error": "请先配置 BILLING_ADMIN_TOKEN。",
            },
        )
        return
    provided = str(handler.headers.get("X-Admin-Token", "") or "").strip()
    if provided != settings.BILLING_ADMIN_TOKEN:
        handler.json_response(
            403,
            {
                "ok": False,
                "code": "INVALID_ADMIN_TOKEN",
                "error": "管理员令牌无效。",
            },
        )
        return
    payload = handler.read_json_body()
    if payload is None:
        handler.json_response(400, {"ok": False, "error": "Invalid JSON body"})
        return
    user_id = handler.sanitize_user_id(str(payload.get("userId", "default")))
    plan = settings.normalize_plan(str(payload.get("plan", settings.FREE_PLAN)))
    status = settings.normalize_plan_status(
        str(payload.get("status", "active" if plan == settings.PRO_PLAN else "inactive"))
    )
    handler.billing_store.set_plan(
        user_id,
        plan,
        source="manual",
        plan_status=status,
        billing_state="active" if status == "active" else "inactive",
    )
    handler.json_response(200, {"ok": True, "billing": handler.billing_payload(user_id)})
