#!/usr/bin/env python3
"""
YomuYomu backend service.

Provides:
- /api/import (TXT/EPUB/PDF/MOBI)
- /api/nlp/tokenize (Sudachi or MeCab/fugashi with heuristic fallback)
- /api/dict/lookup (JMDict SQLite lookup)
- /api/sync/push and /api/sync/pull (simple cloud snapshot sync)
- /api/billing/plan / create-order / order-status / confirm-paid
- /api/billing/create-checkout-session / checkout-complete / create-portal-session
- /api/billing/stripe/webhook
- /api/billing/wechat/notify and /api/billing/alipay/notify
- /api/billing/set-plan (optional admin-only override)
- Static file hosting for the frontend
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import posixpath
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timezone
from functools import lru_cache
from html.parser import HTMLParser
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, quote_plus, urlencode, urlparse
from xml.etree import ElementTree as ET

try:
    import requests
except Exception:  # pragma: no cover - optional dependency
    requests = None

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:  # pragma: no cover - optional dependency
    hashes = None
    serialization = None
    padding = None
    AESGCM = None

import backend.config as settings
from backend.repositories.ai import AIExplainRepository
from backend.repositories.billing import BillingStore as RepositoryBillingStore
from backend.repositories.books import BookRepository
from backend.repositories.dictionary import JMDictStore as RepositoryJMDictStore
from backend.repositories.events import EventRepository
from backend.repositories.import_jobs import ImportJobRepository
from backend.repositories.orders import PaymentOrderStore as RepositoryPaymentOrderStore
from backend.repositories.progress import ReadingProgressRepository
from backend.repositories.sync import SyncSnapshotRepository
from backend.repositories.users import UserRepository
from backend.services.account_service import AccountService
from backend.services.ai_service import (
    AIExplainLimitError,
    AIExplainNotConfiguredError,
    AIExplainProviderError,
    AIExplainService,
)
from backend.services.analysis_service import ChapterAnalysisService
from backend.services.ops_service import OpsService
from backend.services.import_service import parse_book as service_parse_book
from backend.services.library_service import LibraryImportService
from backend.services.rate_limit_service import RateLimitService
from backend.services.tokenizer_service import JapaneseTokenizer as ServiceJapaneseTokenizer

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


load_env_file(PROJECT_ROOT / ".env")

DATA_DIR = PROJECT_ROOT / "backend" / "data"
CLOUD_DIR = DATA_DIR / "cloud"
DB_PATH = DATA_DIR / "jmdict.db"
BILLING_PATH = DATA_DIR / "billing.json"
ORDER_PATH = DATA_DIR / "billing_orders.json"
FREE_PLAN = "free"
PRO_PLAN = "pro"
PAY_CHANNEL_WECHAT = "wechat"
PAY_CHANNEL_ALIPAY = "alipay"
PAY_CHANNEL_STRIPE = "stripe"
PAY_CHANNELS = {PAY_CHANNEL_WECHAT, PAY_CHANNEL_ALIPAY, PAY_CHANNEL_STRIPE}
PLAN_FEATURES = {
    FREE_PLAN: {
        "advancedImport": False,
        "cloudSync": False,
        "csvExportMaxRows": 60,
    },
    PRO_PLAN: {
        "advancedImport": True,
        "cloudSync": True,
        "csvExportMaxRows": 100000,
    },
}
APP_BASE_URL = os.getenv("APP_BASE_URL", "").strip()
BILLING_ALLOW_MANUAL_PLAN_CHANGE = os.getenv("BILLING_ALLOW_MANUAL_PLAN_CHANGE", "0").strip() == "1"
BILLING_ADMIN_TOKEN = os.getenv("BILLING_ADMIN_TOKEN", "").strip()
WECHAT_PAY_ENABLED = os.getenv("WECHAT_PAY_ENABLED", "1").strip() != "0"
ALIPAY_PAY_ENABLED = os.getenv("ALIPAY_PAY_ENABLED", "1").strip() != "0"
STRIPE_PAY_ENABLED = os.getenv("STRIPE_PAY_ENABLED", "0").strip() == "1"
WECHAT_PAY_ENTRY_URL = os.getenv("WECHAT_PAY_ENTRY_URL", "").strip()
ALIPAY_PAY_ENTRY_URL = os.getenv("ALIPAY_PAY_ENTRY_URL", "").strip()
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "").strip()
STRIPE_PRICE_ID_MONTHLY = os.getenv("STRIPE_PRICE_ID_MONTHLY", "").strip()
STRIPE_PRICE_ID_YEARLY = os.getenv("STRIPE_PRICE_ID_YEARLY", "").strip()
STRIPE_PAYMENT_LINK_MONTHLY = os.getenv("STRIPE_PAYMENT_LINK_MONTHLY", "").strip()
STRIPE_SUCCESS_URL = os.getenv("STRIPE_SUCCESS_URL", "").strip()
STRIPE_CANCEL_URL = os.getenv("STRIPE_CANCEL_URL", "").strip()
STRIPE_PORTAL_RETURN_URL = os.getenv("STRIPE_PORTAL_RETURN_URL", "").strip()
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "").strip()
STRIPE_WEBHOOK_TOLERANCE_SECONDS = max(
    0, int(os.getenv("STRIPE_WEBHOOK_TOLERANCE_SECONDS", "300") or 300)
)
STRIPE_API_BASE = os.getenv("STRIPE_API_BASE", "https://api.stripe.com").strip()
WECHAT_APP_ID = os.getenv("WECHAT_APP_ID", "").strip()
WECHAT_MCH_ID = os.getenv("WECHAT_MCH_ID", "").strip()
WECHAT_MCH_SERIAL = os.getenv("WECHAT_MCH_SERIAL", "").strip()
WECHAT_MCH_PRIVATE_KEY = os.getenv("WECHAT_MCH_PRIVATE_KEY", "").strip()
WECHAT_MCH_PRIVATE_KEY_PATH = os.getenv("WECHAT_MCH_PRIVATE_KEY_PATH", "").strip()
WECHAT_PLATFORM_PUBLIC_KEY = os.getenv("WECHAT_PLATFORM_PUBLIC_KEY", "").strip()
WECHAT_PLATFORM_PUBLIC_KEY_PATH = os.getenv("WECHAT_PLATFORM_PUBLIC_KEY_PATH", "").strip()
WECHAT_API_V3_KEY = os.getenv("WECHAT_API_V3_KEY", "").strip()
WECHAT_NOTIFY_URL = os.getenv("WECHAT_NOTIFY_URL", "").strip()
WECHAT_PAY_API_BASE = os.getenv("WECHAT_PAY_API_BASE", "https://api.mch.weixin.qq.com").strip()
ALIPAY_APP_ID = os.getenv("ALIPAY_APP_ID", "").strip()
ALIPAY_PRIVATE_KEY = os.getenv("ALIPAY_PRIVATE_KEY", "").strip()
ALIPAY_PRIVATE_KEY_PATH = os.getenv("ALIPAY_PRIVATE_KEY_PATH", "").strip()
ALIPAY_PUBLIC_KEY = os.getenv("ALIPAY_PUBLIC_KEY", "").strip()
ALIPAY_PUBLIC_KEY_PATH = os.getenv("ALIPAY_PUBLIC_KEY_PATH", "").strip()
ALIPAY_NOTIFY_URL = os.getenv("ALIPAY_NOTIFY_URL", "").strip()
ALIPAY_RETURN_URL = os.getenv("ALIPAY_RETURN_URL", "").strip()
ALIPAY_GATEWAY = os.getenv("ALIPAY_GATEWAY", "https://openapi.alipay.com/gateway.do").strip()
BILLING_NOTIFY_TOKEN = os.getenv("BILLING_NOTIFY_TOKEN", "").strip()
BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM = (
    os.getenv("BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM", "1").strip() == "1"
)
PRO_PRICE_FEN = int(float(os.getenv("PRO_PRICE_CNY", "39")) * 100)
PRO_PLAN_DAYS = max(1, int(os.getenv("PRO_PLAN_DAYS", "31")))
ORDER_EXPIRE_MINUTES = max(5, int(os.getenv("PAY_ORDER_EXPIRE_MINUTES", "30")))
WORD_NOISE_RE = re.compile(
    r"""^[\s「」『』【】［］（）()〈〉《》〔〕｛｝{}'"“”‘’、。・，．！？!?：:；;]+|"""
    r"""[\s「」『』【】［］（）()〈〉《》〔〕｛｝{}'"“”‘’、。・，．！？!?：:；;]+$"""
)

PROJECT_ROOT = settings.PROJECT_ROOT
DATA_DIR = settings.DATA_DIR
CLOUD_DIR = settings.CLOUD_DIR
DB_PATH = settings.DB_PATH
BILLING_PATH = settings.BILLING_PATH
ORDER_PATH = settings.ORDER_PATH
FREE_PLAN = settings.FREE_PLAN
PRO_PLAN = settings.PRO_PLAN
PAY_CHANNEL_WECHAT = settings.PAY_CHANNEL_WECHAT
PAY_CHANNEL_ALIPAY = settings.PAY_CHANNEL_ALIPAY
PAY_CHANNEL_STRIPE = settings.PAY_CHANNEL_STRIPE
PAY_CHANNELS = settings.PAY_CHANNELS
PLAN_FEATURES = settings.PLAN_FEATURES
APP_BASE_URL = settings.APP_BASE_URL
BILLING_ALLOW_MANUAL_PLAN_CHANGE = settings.BILLING_ALLOW_MANUAL_PLAN_CHANGE
BILLING_ADMIN_TOKEN = settings.BILLING_ADMIN_TOKEN
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "").strip() or BILLING_ADMIN_TOKEN
WECHAT_PAY_ENABLED = settings.WECHAT_PAY_ENABLED
ALIPAY_PAY_ENABLED = settings.ALIPAY_PAY_ENABLED
STRIPE_PAY_ENABLED = settings.STRIPE_PAY_ENABLED
WECHAT_PAY_ENTRY_URL = settings.WECHAT_PAY_ENTRY_URL
ALIPAY_PAY_ENTRY_URL = settings.ALIPAY_PAY_ENTRY_URL
STRIPE_SECRET_KEY = settings.STRIPE_SECRET_KEY
STRIPE_PRICE_ID_MONTHLY = settings.STRIPE_PRICE_ID_MONTHLY
STRIPE_PRICE_ID_YEARLY = settings.STRIPE_PRICE_ID_YEARLY
STRIPE_PAYMENT_LINK_MONTHLY = settings.STRIPE_PAYMENT_LINK_MONTHLY
STRIPE_SUCCESS_URL = settings.STRIPE_SUCCESS_URL
STRIPE_CANCEL_URL = settings.STRIPE_CANCEL_URL
STRIPE_PORTAL_RETURN_URL = settings.STRIPE_PORTAL_RETURN_URL
STRIPE_WEBHOOK_SECRET = settings.STRIPE_WEBHOOK_SECRET
STRIPE_WEBHOOK_TOLERANCE_SECONDS = settings.STRIPE_WEBHOOK_TOLERANCE_SECONDS
STRIPE_API_BASE = settings.STRIPE_API_BASE
WECHAT_APP_ID = settings.WECHAT_APP_ID
WECHAT_MCH_ID = settings.WECHAT_MCH_ID
WECHAT_MCH_SERIAL = settings.WECHAT_MCH_SERIAL
WECHAT_MCH_PRIVATE_KEY = settings.WECHAT_MCH_PRIVATE_KEY
WECHAT_MCH_PRIVATE_KEY_PATH = settings.WECHAT_MCH_PRIVATE_KEY_PATH
WECHAT_PLATFORM_PUBLIC_KEY = settings.WECHAT_PLATFORM_PUBLIC_KEY
WECHAT_PLATFORM_PUBLIC_KEY_PATH = settings.WECHAT_PLATFORM_PUBLIC_KEY_PATH
WECHAT_API_V3_KEY = settings.WECHAT_API_V3_KEY
WECHAT_NOTIFY_URL = settings.WECHAT_NOTIFY_URL
WECHAT_PAY_API_BASE = settings.WECHAT_PAY_API_BASE
ALIPAY_APP_ID = settings.ALIPAY_APP_ID
ALIPAY_PRIVATE_KEY = settings.ALIPAY_PRIVATE_KEY
ALIPAY_PRIVATE_KEY_PATH = settings.ALIPAY_PRIVATE_KEY_PATH
ALIPAY_PUBLIC_KEY = settings.ALIPAY_PUBLIC_KEY
ALIPAY_PUBLIC_KEY_PATH = settings.ALIPAY_PUBLIC_KEY_PATH
ALIPAY_NOTIFY_URL = settings.ALIPAY_NOTIFY_URL
ALIPAY_RETURN_URL = settings.ALIPAY_RETURN_URL
ALIPAY_GATEWAY = settings.ALIPAY_GATEWAY
BILLING_NOTIFY_TOKEN = settings.BILLING_NOTIFY_TOKEN
BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM = settings.BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM
PRO_PRICE_FEN = settings.PRO_PRICE_FEN
PRO_PLAN_DAYS = settings.PRO_PLAN_DAYS
ORDER_EXPIRE_MINUTES = settings.ORDER_EXPIRE_MINUTES


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CLOUD_DIR.mkdir(parents=True, exist_ok=True)


def json_response(handler: SimpleHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header(
        "Access-Control-Allow-Headers",
        "Content-Type,X-Admin-Token,X-Payment-Token,X-Account-Token",
    )
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.end_headers()
    handler.wfile.write(body)


def text_response(handler: SimpleHTTPRequestHandler, status: int, text: str) -> None:
    body = str(text or "").encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "text/plain; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header(
        "Access-Control-Allow-Headers",
        "Content-Type,X-Admin-Token,X-Payment-Token,X-Account-Token",
    )
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.end_headers()
    handler.wfile.write(body)


def safe_decode(raw: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "shift_jis", "cp932", "euc_jp"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def normalize_plan(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    return raw if raw in PLAN_FEATURES else FREE_PLAN


def normalize_plan_status(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    return "active" if raw == "active" else "inactive"


def normalize_pay_channel(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    return raw if raw in PAY_CHANNELS else PAY_CHANNEL_WECHAT


def normalize_optional_pay_channel(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    return normalize_pay_channel(raw)


def normalize_subscription_status(value: str | None) -> str:
    return str(value or "").strip().lower()


def payment_channels() -> dict[str, bool]:
    return settings.payment_channels()


def any_payment_channel_enabled() -> bool:
    return any(payment_channels().values())


def pay_entry_url(channel: str) -> str:
    normalized = normalize_pay_channel(channel)
    if normalized == PAY_CHANNEL_WECHAT:
        return WECHAT_PAY_ENTRY_URL
    if normalized == PAY_CHANNEL_ALIPAY:
        return ALIPAY_PAY_ENTRY_URL
    return ""


def normalize_stripe_interval(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    return "yearly" if raw in {"yearly", "annual", "year"} else "monthly"


def stripe_price_id(interval: str) -> str:
    normalized = normalize_stripe_interval(interval)
    if normalized == "yearly":
        return STRIPE_PRICE_ID_YEARLY or STRIPE_PRICE_ID_MONTHLY
    return STRIPE_PRICE_ID_MONTHLY or STRIPE_PRICE_ID_YEARLY


def stripe_checkout_enabled() -> bool:
    return bool(stripe_runtime_enabled() and (STRIPE_PRICE_ID_MONTHLY or STRIPE_PRICE_ID_YEARLY))


def stripe_payment_link_url() -> str:
    raw = str(STRIPE_PAYMENT_LINK_MONTHLY or "").strip()
    return raw if is_abs_http_url(raw) else ""


def stripe_payment_link_enabled() -> bool:
    return bool(STRIPE_PAY_ENABLED and stripe_payment_link_url())


def stripe_runtime_enabled() -> bool:
    return bool(
        STRIPE_PAY_ENABLED
        and requests is not None
        and STRIPE_SECRET_KEY
    )


def is_abs_http_url(value: str | None) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    parsed = urlparse(raw)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def build_pay_url(template: str, *, order_id: str, user_id: str, channel: str) -> str:
    raw = str(template or "").strip()
    if not raw:
        return ""
    mapped = (
        raw.replace("{orderId}", order_id)
        .replace("{userId}", user_id)
        .replace("{channel}", channel)
    )
    if "{orderId}" in raw or "{userId}" in raw or "{channel}" in raw:
        return mapped
    sep = "&" if "?" in mapped else "?"
    return f"{mapped}{sep}orderId={order_id}&userId={user_id}&channel={channel}"


def stripe_api_request(
    method: str,
    path: str,
    *,
    data: dict[str, str | list[str]] | None = None,
    timeout: int = 12,
) -> tuple[dict | None, str]:
    if requests is None:
        return None, "requests 未安装，无法调用 Stripe API。"
    if not STRIPE_SECRET_KEY:
        return None, "缺少 STRIPE_SECRET_KEY。"
    target = f"{STRIPE_API_BASE.rstrip('/')}/{path.lstrip('/')}"
    headers = {
        "Authorization": f"Bearer {STRIPE_SECRET_KEY}",
    }
    if method.upper() != "GET":
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    try:
        req_method = method.upper()
        request_kwargs: dict = {
            "headers": headers,
            "timeout": timeout,
        }
        if req_method == "GET":
            request_kwargs["params"] = data or None
        else:
            request_kwargs["data"] = data or None
        resp = requests.request(
            req_method,
            target,
            **request_kwargs,
        )
    except Exception as exc:
        return None, f"Stripe API 请求失败: {exc}"
    payload: dict | None = None
    if resp.text:
        try:
            parsed = resp.json()
            payload = parsed if isinstance(parsed, dict) else {}
        except Exception:
            payload = {}
    else:
        payload = {}
    if resp.status_code >= 400:
        err = ""
        if isinstance(payload, dict):
            err_obj = payload.get("error")
            if isinstance(err_obj, dict):
                err = str(err_obj.get("message", "") or "").strip()
        return payload, err or f"Stripe API 返回 HTTP {resp.status_code}"
    return payload or {}, ""


def parse_stripe_signature_header(header_value: str) -> tuple[int, list[str]]:
    timestamp = 0
    signatures: list[str] = []
    for part in str(header_value or "").split(","):
        key, _, value = part.strip().partition("=")
        if not key or not value:
            continue
        if key == "t":
            try:
                timestamp = int(value)
            except Exception:
                timestamp = 0
        elif key == "v1":
            signatures.append(value)
    return timestamp, signatures


def verify_stripe_signature(raw: bytes, header_value: str) -> bool:
    if not STRIPE_WEBHOOK_SECRET:
        return True
    timestamp, signatures = parse_stripe_signature_header(header_value)
    if timestamp <= 0 or not signatures:
        return False
    now = int(time.time())
    if STRIPE_WEBHOOK_TOLERANCE_SECONDS > 0 and abs(now - timestamp) > STRIPE_WEBHOOK_TOLERANCE_SECONDS:
        return False
    signed_payload = f"{timestamp}.".encode("utf-8") + raw
    expected = hmac.new(
        STRIPE_WEBHOOK_SECRET.encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()
    return any(hmac.compare_digest(expected, item) for item in signatures)


def stripe_period_end_ms(value: int | str | None) -> int:
    try:
        sec = int(value or 0)
    except Exception:
        sec = 0
    if sec <= 0:
        return 0
    return sec * 1000


def normalize_pem_value(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    return raw.replace("\\n", "\n").strip()


def load_secret_from_env_or_path(value: str | None, path: str | None) -> str:
    direct = normalize_pem_value(value)
    if direct:
        return direct
    file_path = str(path or "").strip()
    if not file_path:
        return ""
    try:
        return normalize_pem_value(Path(file_path).expanduser().read_text(encoding="utf-8"))
    except Exception:
        return ""


@lru_cache(maxsize=1)
def wechat_private_key_pem() -> str:
    return load_secret_from_env_or_path(WECHAT_MCH_PRIVATE_KEY, WECHAT_MCH_PRIVATE_KEY_PATH)


@lru_cache(maxsize=1)
def wechat_platform_public_key_pem() -> str:
    return load_secret_from_env_or_path(WECHAT_PLATFORM_PUBLIC_KEY, WECHAT_PLATFORM_PUBLIC_KEY_PATH)


@lru_cache(maxsize=1)
def alipay_private_key_pem() -> str:
    return load_secret_from_env_or_path(ALIPAY_PRIVATE_KEY, ALIPAY_PRIVATE_KEY_PATH)


@lru_cache(maxsize=1)
def alipay_public_key_pem() -> str:
    return load_secret_from_env_or_path(ALIPAY_PUBLIC_KEY, ALIPAY_PUBLIC_KEY_PATH)


@lru_cache(maxsize=1)
def wechat_private_key_obj():
    return load_private_key_from_pem(wechat_private_key_pem())


@lru_cache(maxsize=1)
def wechat_platform_public_key_obj():
    return load_public_key_from_pem(wechat_platform_public_key_pem())


@lru_cache(maxsize=1)
def alipay_private_key_obj():
    return load_private_key_from_pem(alipay_private_key_pem())


@lru_cache(maxsize=1)
def alipay_public_key_obj():
    return load_public_key_from_pem(alipay_public_key_pem())


def crypto_runtime_ready() -> bool:
    return bool(hashes and serialization and padding)


def load_private_key_from_pem(pem_text: str):
    if not crypto_runtime_ready():
        return None
    try:
        return serialization.load_pem_private_key(pem_text.encode("utf-8"), password=None)
    except Exception:
        return None


def load_public_key_from_pem(pem_text: str):
    if not crypto_runtime_ready():
        return None
    try:
        return serialization.load_pem_public_key(pem_text.encode("utf-8"))
    except Exception:
        return None


def rsa_sign_sha256_base64(private_key, message: bytes) -> str:
    if not private_key or not crypto_runtime_ready():
        return ""
    try:
        signature = private_key.sign(
            message,
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
        return base64.b64encode(signature).decode("utf-8")
    except Exception:
        return ""


def rsa_verify_sha256_base64(public_key, message: bytes, signature_b64: str) -> bool:
    if not public_key or not crypto_runtime_ready():
        return False
    try:
        signature = base64.b64decode(signature_b64)
        public_key.verify(signature, message, padding.PKCS1v15(), hashes.SHA256())
        return True
    except Exception:
        return False


def utc_iso8601(ms: int) -> str:
    if int(ms or 0) <= 0:
        return ""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


class BillingStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    @staticmethod
    def _empty() -> dict:
        return {"updatedAt": 0, "users": {}}

    @staticmethod
    def _now_ms() -> int:
        return int(time.time() * 1000)

    def _read(self) -> dict:
        if not self.path.exists():
            return self._empty()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            users = payload.get("users")
            if not isinstance(users, dict):
                users = {}
            return {
                "updatedAt": int(payload.get("updatedAt", 0) or 0),
                "users": users,
            }
        except Exception:
            return self._empty()

    def _write(self, payload: dict) -> None:
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.path)

    @staticmethod
    def _normalize_record(user_key: str, raw: dict | None) -> dict:
        source = raw if isinstance(raw, dict) else {}
        return {
            "userId": user_key,
            "plan": normalize_plan(source.get("plan")),
            "updatedAt": int(source.get("updatedAt", 0) or 0),
            "source": str(source.get("source", "manual") or "manual"),
            "lastPaidChannel": normalize_optional_pay_channel(source.get("lastPaidChannel")),
            "lastOrderId": str(source.get("lastOrderId", "") or "").strip(),
            "planExpireAt": int(source.get("planExpireAt", 0) or 0),
            "subscriptionStatus": normalize_subscription_status(source.get("subscriptionStatus")),
            "stripeCustomerId": str(source.get("stripeCustomerId", "") or "").strip(),
            "stripeSubscriptionId": str(source.get("stripeSubscriptionId", "") or "").strip(),
        }

    @staticmethod
    def _record_for_write(record: dict) -> dict:
        return {
            "plan": normalize_plan(record.get("plan")),
            "updatedAt": int(record.get("updatedAt", 0) or 0),
            "source": str(record.get("source", "manual") or "manual"),
            "lastPaidChannel": normalize_optional_pay_channel(record.get("lastPaidChannel")),
            "lastOrderId": str(record.get("lastOrderId", "") or "").strip(),
            "planExpireAt": int(record.get("planExpireAt", 0) or 0),
            "subscriptionStatus": normalize_subscription_status(record.get("subscriptionStatus")),
            "stripeCustomerId": str(record.get("stripeCustomerId", "") or "").strip(),
            "stripeSubscriptionId": str(record.get("stripeSubscriptionId", "") or "").strip(),
        }

    def _set_record_locked(self, users: dict, user_key: str, record: dict) -> None:
        users[user_key] = self._record_for_write(record)

    def get_billing(self, user_id: str) -> dict:
        user_key = sanitize_user_id(user_id)
        with self._lock:
            payload = self._read()
            user = payload.get("users", {}).get(user_key, {})
        record = self._normalize_record(user_key, user)
        plan = record["plan"]
        return {
            "userId": user_key,
            "plan": plan,
            "features": PLAN_FEATURES[plan],
            "updatedAt": record["updatedAt"],
            "source": record["source"],
            "lastPaidChannel": record["lastPaidChannel"],
            "lastOrderId": record["lastOrderId"],
            "planExpireAt": record["planExpireAt"],
            "subscriptionStatus": record["subscriptionStatus"],
            "stripeCustomerId": record["stripeCustomerId"],
            "stripeSubscriptionId": record["stripeSubscriptionId"],
        }

    def set_plan(
        self,
        user_id: str,
        plan: str,
        source: str = "manual",
        *,
        last_paid_channel: str = "",
        last_order_id: str = "",
        subscription_status: str | None = None,
        plan_expire_at: int | None = None,
        stripe_customer_id: str = "",
        stripe_subscription_id: str = "",
    ) -> dict:
        user_key = sanitize_user_id(user_id)
        normalized_plan = normalize_plan(plan)
        now_ms = self._now_ms()
        with self._lock:
            payload = self._read()
            users = payload.setdefault("users", {})
            record = self._normalize_record(user_key, users.get(user_key, {}))
            record["plan"] = normalized_plan
            record["source"] = str(source or "manual")
            if last_paid_channel:
                record["lastPaidChannel"] = normalize_pay_channel(last_paid_channel)
            if last_order_id:
                record["lastOrderId"] = str(last_order_id).strip()
            if subscription_status is not None:
                record["subscriptionStatus"] = normalize_subscription_status(subscription_status)
            if plan_expire_at is not None:
                record["planExpireAt"] = max(0, int(plan_expire_at or 0))
            if stripe_customer_id:
                record["stripeCustomerId"] = str(stripe_customer_id).strip()
            if stripe_subscription_id:
                record["stripeSubscriptionId"] = str(stripe_subscription_id).strip()
            record["updatedAt"] = now_ms
            self._set_record_locked(users, user_key, record)
            payload["updatedAt"] = now_ms
            self._write(payload)
        return self.get_billing(user_key)

    def find_user_by_stripe_customer_id(self, customer_id: str) -> str:
        target = str(customer_id or "").strip()
        if not target:
            return ""
        with self._lock:
            payload = self._read()
            users = payload.get("users", {})
            if not isinstance(users, dict):
                return ""
            for raw_user_id, raw_record in users.items():
                user_key = sanitize_user_id(str(raw_user_id or ""))
                record = self._normalize_record(user_key, raw_record if isinstance(raw_record, dict) else {})
                if record.get("stripeCustomerId") == target:
                    return user_key
        return ""


class PaymentOrderStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    @staticmethod
    def _empty() -> dict:
        return {"updatedAt": 0, "orders": {}}

    @staticmethod
    def _now_ms() -> int:
        return int(time.time() * 1000)

    def _read(self) -> dict:
        if not self.path.exists():
            return self._empty()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            orders = payload.get("orders")
            if not isinstance(orders, dict):
                orders = {}
            return {"updatedAt": int(payload.get("updatedAt", 0) or 0), "orders": orders}
        except Exception:
            return self._empty()

    def _write(self, payload: dict) -> None:
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.path)

    @staticmethod
    def _normalize_order(order_id: str, raw: dict | None) -> dict:
        source = raw if isinstance(raw, dict) else {}
        return {
            "orderId": order_id,
            "userId": sanitize_user_id(source.get("userId", "default")),
            "plan": normalize_plan(source.get("plan")),
            "channel": normalize_pay_channel(source.get("channel")),
            "amountFen": max(1, int(source.get("amountFen", PRO_PRICE_FEN) or PRO_PRICE_FEN)),
            "status": str(source.get("status", "pending") or "pending").strip().lower(),
            "payUrl": str(source.get("payUrl", "") or "").strip(),
            "createdAt": int(source.get("createdAt", 0) or 0),
            "updatedAt": int(source.get("updatedAt", 0) or 0),
            "expiresAt": int(source.get("expiresAt", 0) or 0),
            "paidAt": int(source.get("paidAt", 0) or 0),
            "paidSource": str(source.get("paidSource", "") or "").strip(),
            "externalTradeNo": str(source.get("externalTradeNo", "") or "").strip(),
        }

    @staticmethod
    def _for_write(order: dict) -> dict:
        return {
            "userId": sanitize_user_id(order.get("userId", "default")),
            "plan": normalize_plan(order.get("plan")),
            "channel": normalize_pay_channel(order.get("channel")),
            "amountFen": max(1, int(order.get("amountFen", PRO_PRICE_FEN) or PRO_PRICE_FEN)),
            "status": str(order.get("status", "pending") or "pending").strip().lower(),
            "payUrl": str(order.get("payUrl", "") or "").strip(),
            "createdAt": int(order.get("createdAt", 0) or 0),
            "updatedAt": int(order.get("updatedAt", 0) or 0),
            "expiresAt": int(order.get("expiresAt", 0) or 0),
            "paidAt": int(order.get("paidAt", 0) or 0),
            "paidSource": str(order.get("paidSource", "") or "").strip(),
            "externalTradeNo": str(order.get("externalTradeNo", "") or "").strip(),
        }

    def create_order(
        self,
        *,
        user_id: str,
        channel: str,
        amount_fen: int,
        plan: str = PRO_PLAN,
        pay_url: str = "",
    ) -> dict:
        now_ms = self._now_ms()
        expires_at = now_ms + ORDER_EXPIRE_MINUTES * 60 * 1000
        order_id = f"pay_{now_ms}_{secrets.token_hex(4)}"
        order = {
            "orderId": order_id,
            "userId": sanitize_user_id(user_id),
            "plan": normalize_plan(plan),
            "channel": normalize_pay_channel(channel),
            "amountFen": max(1, int(amount_fen or PRO_PRICE_FEN)),
            "status": "pending",
            "payUrl": str(pay_url or "").strip(),
            "createdAt": now_ms,
            "updatedAt": now_ms,
            "expiresAt": expires_at,
            "paidAt": 0,
            "paidSource": "",
            "externalTradeNo": "",
        }
        with self._lock:
            payload = self._read()
            orders = payload.setdefault("orders", {})
            orders[order_id] = self._for_write(order)
            payload["updatedAt"] = now_ms
            self._write(payload)
        return order

    def get_order(self, order_id: str) -> dict | None:
        key = str(order_id or "").strip()
        if not key:
            return None
        changed = False
        with self._lock:
            payload = self._read()
            raw = payload.get("orders", {}).get(key)
            if not raw:
                return None
            order = self._normalize_order(key, raw)
            if order["status"] == "pending" and order["expiresAt"] > 0 and self._now_ms() > order["expiresAt"]:
                order["status"] = "expired"
                order["updatedAt"] = self._now_ms()
                payload["orders"][key] = self._for_write(order)
                payload["updatedAt"] = order["updatedAt"]
                changed = True
            if changed:
                self._write(payload)
        return order

    def mark_paid(
        self,
        order_id: str,
        *,
        paid_source: str,
        external_trade_no: str = "",
    ) -> dict | None:
        key = str(order_id or "").strip()
        if not key:
            return None
        with self._lock:
            payload = self._read()
            raw = payload.get("orders", {}).get(key)
            if not raw:
                return None
            order = self._normalize_order(key, raw)
            now_ms = self._now_ms()
            if order["status"] != "paid":
                order["status"] = "paid"
                order["paidAt"] = now_ms
                order["paidSource"] = str(paid_source or "manual").strip()
                if external_trade_no:
                    order["externalTradeNo"] = str(external_trade_no).strip()
                order["updatedAt"] = now_ms
                payload["orders"][key] = self._for_write(order)
                payload["updatedAt"] = now_ms
                self._write(payload)
            return order

    def set_pay_url(self, order_id: str, pay_url: str) -> dict | None:
        key = str(order_id or "").strip()
        if not key:
            return None
        with self._lock:
            payload = self._read()
            raw = payload.get("orders", {}).get(key)
            if not raw:
                return None
            order = self._normalize_order(key, raw)
            order["payUrl"] = str(pay_url or "").strip()
            order["updatedAt"] = self._now_ms()
            payload["orders"][key] = self._for_write(order)
            payload["updatedAt"] = order["updatedAt"]
            self._write(payload)
            return order


class HtmlTextExtractor(HTMLParser):
    BLOCK_TAGS = {
        "p",
        "div",
        "article",
        "section",
        "br",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "tr",
        "blockquote",
    }

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if data and not data.isspace():
            self.parts.append(data)

    def text(self) -> str:
        joined = "".join(self.parts)
        joined = re.sub(r"[ \t\f\v]+", " ", joined)
        joined = re.sub(r"\n{3,}", "\n\n", joined)
        return joined.strip()


def html_to_text(html: str) -> str:
    parser = HtmlTextExtractor()
    parser.feed(html)
    return parser.text()


def element_text(root: ET.Element, xpath: str) -> str:
    node = root.find(xpath)
    if node is None or node.text is None:
        return ""
    return node.text.strip()


def parse_txt(raw: bytes, name: str) -> dict:
    text = safe_decode(raw).replace("\r", "").strip()
    title = Path(name).stem or "TXT 文档"
    return {"title": title, "format": "txt", "chapters": [{"title": title, "text": text}]}


def parse_epub(raw: bytes, name: str) -> dict:
    chapters: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="yomuyomu_epub_") as tmp:
        epub_path = Path(tmp) / "book.epub"
        epub_path.write_bytes(raw)
        with zipfile.ZipFile(epub_path) as zf:
            container_xml = zf.read("META-INF/container.xml").decode("utf-8", errors="ignore")
            container_root = ET.fromstring(container_xml)
            rootfile = container_root.find(
                ".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile"
            )
            if rootfile is None:
                raise ValueError("EPUB container.xml missing rootfile.")
            opf_path = rootfile.attrib.get("full-path", "")
            if not opf_path:
                raise ValueError("EPUB OPF path is empty.")

            opf_root = ET.fromstring(zf.read(opf_path))
            ns_uri = opf_root.tag.split("}")[0].strip("{")
            ns = {"opf": ns_uri}
            manifest: dict[str, dict] = {}
            for item in opf_root.findall(".//opf:manifest/opf:item", ns):
                item_id = item.attrib.get("id")
                if not item_id:
                    continue
                manifest[item_id] = {
                    "href": item.attrib.get("href", ""),
                    "media_type": item.attrib.get("media-type", ""),
                }

            spine_ids = [
                item.attrib.get("idref", "")
                for item in opf_root.findall(".//opf:spine/opf:itemref", ns)
                if item.attrib.get("idref")
            ]
            opf_dir = posixpath.dirname(opf_path)

            def to_archive_path(href: str) -> str:
                joined = posixpath.normpath(posixpath.join(opf_dir, href))
                return joined.lstrip("/")

            for order, item_id in enumerate(spine_ids, start=1):
                manifest_item = manifest.get(item_id)
                if not manifest_item:
                    continue
                href = manifest_item["href"]
                media_type = manifest_item["media_type"]
                if "html" not in media_type and not href.endswith((".xhtml", ".html", ".htm")):
                    continue
                archive_path = to_archive_path(href)
                try:
                    html_raw = zf.read(archive_path)
                except KeyError:
                    continue
                html = safe_decode(html_raw)
                text = html_to_text(html)
                if not text:
                    continue
                html_root = None
                if "<html" in html:
                    try:
                        html_root = ET.fromstring(re.sub(r"&[a-zA-Z]+?;", "", html))
                    except ET.ParseError:
                        html_root = None
                title = ""
                if html_root is not None:
                    title = element_text(html_root, ".//{http://www.w3.org/1999/xhtml}title")
                if not title:
                    title = f"Chapter {order:03d}"
                chapters.append({"title": title, "text": text})

            if not chapters:
                for archive_name in sorted(zf.namelist()):
                    if not archive_name.endswith((".xhtml", ".html", ".htm")):
                        continue
                    text = html_to_text(safe_decode(zf.read(archive_name)))
                    if text:
                        chapters.append({"title": Path(archive_name).stem, "text": text})

    if not chapters:
        raise ValueError("EPUB parse result is empty.")
    title = Path(name).stem or "EPUB 文档"
    return {"title": title, "format": "epub", "chapters": chapters}


def parse_pdf(raw: bytes, name: str) -> dict:
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("PDF parsing needs pypdf (`pip install pypdf`).") from exc

    chapters = []
    with tempfile.TemporaryDirectory(prefix="yomuyomu_pdf_") as tmp:
        pdf_path = Path(tmp) / "book.pdf"
        pdf_path.write_bytes(raw)
        reader = PdfReader(str(pdf_path))
        for i, page in enumerate(reader.pages, start=1):
            text = (page.extract_text() or "").strip()
            if text:
                chapters.append({"title": f"Page {i}", "text": text})
    if not chapters:
        raise ValueError("PDF parse result is empty.")
    title = Path(name).stem or "PDF 文档"
    return {"title": title, "format": "pdf", "chapters": chapters}


def parse_mobi(raw: bytes, name: str) -> dict:
    converter = shutil.which("ebook-convert")
    if not converter:
        raise RuntimeError(
            "MOBI import needs Calibre `ebook-convert`. Please install Calibre first."
        )

    with tempfile.TemporaryDirectory(prefix="yomuyomu_mobi_") as tmp:
        mobi_path = Path(tmp) / "book.mobi"
        epub_path = Path(tmp) / "book.epub"
        mobi_path.write_bytes(raw)
        proc = subprocess.run(
            [converter, str(mobi_path), str(epub_path)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if proc.returncode != 0 or not epub_path.exists():
            raise RuntimeError(f"MOBI convert failed: {proc.stderr.strip()[:200]}")
        epub_raw = epub_path.read_bytes()
        result = parse_epub(epub_raw, name)
        result["format"] = "mobi"
        return result


def parse_book(raw: bytes, name: str, file_type: str) -> dict:
    normalized = file_type.lower().strip(".")
    if normalized == "txt":
        return parse_txt(raw, name)
    if normalized == "epub":
        return parse_epub(raw, name)
    if normalized == "pdf":
        return parse_pdf(raw, name)
    if normalized == "mobi":
        return parse_mobi(raw, name)
    raise ValueError(f"Unsupported type: {file_type}")


def parse_multipart_form(
    raw: bytes, content_type: str
) -> tuple[dict[str, str], dict[str, tuple[str, bytes]]] | tuple[None, None]:
    """
    Very small multipart parser for this project.
    Returns:
      - fields: key -> value
      - files: key -> (filename, bytes)
    """
    boundary_match = re.search(r'boundary="?([^";]+)"?', content_type)
    if not boundary_match:
        return None, None
    boundary = boundary_match.group(1).encode("utf-8")
    delimiter = b"--" + boundary
    fields: dict[str, str] = {}
    files: dict[str, tuple[str, bytes]] = {}

    parts = raw.split(delimiter)
    for part in parts:
        part = part.strip()
        if not part or part == b"--":
            continue
        if part.startswith(b"--"):
            part = part[2:]
        if b"\r\n\r\n" not in part:
            continue
        header_blob, body = part.split(b"\r\n\r\n", 1)
        body = body.rstrip(b"\r\n")
        header_lines = header_blob.decode("utf-8", errors="ignore").split("\r\n")
        headers: dict[str, str] = {}
        for line in header_lines:
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.strip().lower()] = value.strip()

        disposition = headers.get("content-disposition", "")
        name_match = re.search(r'name="([^"]+)"', disposition)
        if not name_match:
            continue
        field_name = name_match.group(1)
        filename_match = re.search(r'filename="([^"]*)"', disposition)
        if filename_match:
            files[field_name] = (filename_match.group(1), body)
        else:
            fields[field_name] = body.decode("utf-8", errors="ignore")
    return fields, files


def fallback_tokenize(text: str) -> list[dict]:
    pattern = re.compile(r"[一-龯々]+[ぁ-ゖー]*|[ァ-ヺー]+|[ぁ-ゖー]+|[A-Za-z0-9]+|[^\s]")
    tokens = []
    for match in pattern.finditer(text):
        surface = match.group(0)
        tokens.append(
            {
                "surface": surface,
                "lemma": surface,
                "reading": "",
                "pos": "fallback",
                "start": match.start(),
                "end": match.end(),
            }
        )
    return tokens


class JapaneseTokenizer:
    def __init__(self) -> None:
        self.backend = "fallback"
        self._tokenizer = None
        self._mode = None
        self._try_init()

    def _try_init(self) -> None:
        try:
            from sudachipy import dictionary, tokenizer  # type: ignore

            self._tokenizer = dictionary.Dictionary().create()
            self._mode = tokenizer.Tokenizer.SplitMode.C
            self.backend = "sudachipy"
            return
        except Exception:
            pass

        try:
            from fugashi import Tagger  # type: ignore

            self._tokenizer = Tagger()
            self.backend = "fugashi-mecab"
            return
        except Exception:
            self.backend = "fallback"

    def tokenize(self, text: str) -> list[dict]:
        if self.backend == "sudachipy":
            return self._tokenize_sudachi(text)
        if self.backend == "fugashi-mecab":
            return self._tokenize_fugashi(text)
        return fallback_tokenize(text)

    def _tokenize_sudachi(self, text: str) -> list[dict]:
        out = []
        for token in self._tokenizer.tokenize(text, self._mode):
            surface = token.surface()
            out.append(
                {
                    "surface": surface,
                    "lemma": token.dictionary_form() or surface,
                    "reading": token.reading_form() or "",
                    "pos": ",".join(token.part_of_speech()[:2]).strip(","),
                    "start": token.begin(),
                    "end": token.end(),
                }
            )
        return out

    def _tokenize_fugashi(self, text: str) -> list[dict]:
        out = []
        offset = 0
        for token in self._tokenizer(text):
            surface = token.surface
            feat = token.feature
            lemma = getattr(feat, "lemma", None) or getattr(feat, "orthBase", None) or surface
            reading = getattr(feat, "kana", None) or getattr(feat, "pron", None) or ""
            pos1 = getattr(feat, "pos1", None) or ""
            pos2 = getattr(feat, "pos2", None) or ""
            start = offset
            end = offset + len(surface)
            offset = end
            out.append(
                {
                    "surface": surface,
                    "lemma": lemma,
                    "reading": reading,
                    "pos": ",".join([x for x in (pos1, pos2) if x]),
                    "start": start,
                    "end": end,
                }
            )
        return out


class JMDictStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    def available(self) -> bool:
        return self.db_path.exists()

    @staticmethod
    def _entry_columns(conn: sqlite3.Connection) -> set[str]:
        rows = conn.execute("PRAGMA table_info(entries)").fetchall()
        return {row[1] for row in rows}

    @staticmethod
    def _katakana_to_hiragana(text: str) -> str:
        out = []
        for ch in str(text or ""):
            code = ord(ch)
            if 0x30A1 <= code <= 0x30F6:
                out.append(chr(code - 0x60))
            else:
                out.append(ch)
        return "".join(out)

    @staticmethod
    def _hiragana_to_katakana(text: str) -> str:
        out = []
        for ch in str(text or ""):
            code = ord(ch)
            if 0x3041 <= code <= 0x3096:
                out.append(chr(code + 0x60))
            else:
                out.append(ch)
        return "".join(out)

    @staticmethod
    def _strip_word_noise(text: str) -> str:
        return WORD_NOISE_RE.sub("", str(text or "").strip()).strip()

    def _build_lookup_candidates(self, surface: str, lemma: str) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for raw in (surface, lemma):
            base = str(raw or "").strip()
            if not base:
                continue
            values = (
                base,
                self._strip_word_noise(base),
                self._katakana_to_hiragana(base),
                self._hiragana_to_katakana(base),
            )
            for value in values:
                val = self._strip_word_noise(value)
                if not val or val in seen:
                    continue
                seen.add(val)
                out.append(val)
        return out

    def lookup(self, surface: str, lemma: str, limit: int = 8) -> list[dict]:
        if not self.available():
            return []
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            columns = self._entry_columns(conn)
            candidates = self._build_lookup_candidates(surface, lemma)
            if not candidates:
                return []
            select_fields = [
                "surface",
                "lemma",
                "reading",
                "gloss",
                "pos",
                "gloss_zh" if "gloss_zh" in columns else "'' AS gloss_zh",
                "gloss_en" if "gloss_en" in columns else "'' AS gloss_en",
            ]
            select_sql = ", ".join(select_fields)
            placeholders = ", ".join("?" for _ in candidates)
            rows = conn.execute(
                f"""
                SELECT {select_sql}
                FROM entries
                WHERE surface IN ({placeholders}) OR lemma IN ({placeholders})
                LIMIT ?
                """,
                (*candidates, *candidates, limit),
            ).fetchall()
            if not rows:
                like_clauses = " OR ".join(["surface LIKE ? OR lemma LIKE ?"] * len(candidates))
                like_params: list[str | int] = []
                for cand in candidates:
                    like_params.extend([f"{cand}%", f"{cand}%"])
                like_params.append(limit)
                rows = conn.execute(
                    f"""
                    SELECT {select_sql}
                    FROM entries
                    WHERE {like_clauses}
                    LIMIT ?
                    """,
                    tuple(like_params),
                ).fetchall()
            return [dict(row) for row in rows]
        finally:
            conn.close()


class ApiHandler(SimpleHTTPRequestHandler):
    tokenizer = ServiceJapaneseTokenizer()
    dict_store = RepositoryJMDictStore(DB_PATH)
    billing_store = RepositoryBillingStore(settings.APP_DB_PATH, BILLING_PATH)
    order_store = RepositoryPaymentOrderStore(ORDER_PATH)
    user_repository = UserRepository(settings.APP_DB_PATH)
    sync_repository = SyncSnapshotRepository(settings.APP_DB_PATH, CLOUD_DIR)
    event_repository = EventRepository(settings.APP_DB_PATH)
    book_repository = BookRepository(settings.APP_DB_PATH)
    import_job_repository = ImportJobRepository(settings.APP_DB_PATH)
    progress_repository = ReadingProgressRepository(settings.APP_DB_PATH)
    chapter_analysis_service = ChapterAnalysisService(tokenizer, dict_store)
    ai_repository = AIExplainRepository(settings.APP_DB_PATH)
    ai_explain_service = AIExplainService(ai_repository)
    account_service = AccountService(
        users=user_repository,
        sync_repository=sync_repository,
        progress_repository=progress_repository,
        book_repository=book_repository,
        billing_store=billing_store,
        event_repository=event_repository,
        ai_repository=ai_repository,
    )
    ops_service = OpsService(event_repository)
    ai_rate_limiter = RateLimitService()
    import_rate_limiter = RateLimitService()
    library_import_service = LibraryImportService(
        jobs=import_job_repository,
        books=book_repository,
        events=event_repository,
        analyzer=chapter_analysis_service,
        import_jobs_dir=settings.IMPORT_JOBS_DIR,
    )

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type,X-Admin-Token,X-Payment-Token,X-Account-Token",
        )
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        for cookie_header in list(getattr(self, "_pending_response_cookies", [])):
            self.send_header("Set-Cookie", cookie_header)
        self._pending_response_cookies = []
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.end_headers()

    def resolve_app_base_url(self, preferred: str = "") -> str:
        if is_abs_http_url(preferred):
            return preferred.rstrip("/")
        if is_abs_http_url(APP_BASE_URL):
            return APP_BASE_URL.rstrip("/")
        origin = str(self.headers.get("Origin", "")).strip()
        if is_abs_http_url(origin):
            return origin.rstrip("/")
        host = str(self.headers.get("Host", "")).strip()
        if host:
            forwarded_proto = str(self.headers.get("X-Forwarded-Proto", "")).split(",")[0].strip()
            scheme = forwarded_proto if forwarded_proto in {"http", "https"} else "http"
            return f"{scheme}://{host}".rstrip("/")
        return "http://127.0.0.1:8000"

    def client_ip(self) -> str:
        forwarded = str(self.headers.get("X-Forwarded-For", "") or "").split(",")[0].strip()
        if forwarded:
            return forwarded
        return str(self.client_address[0] if self.client_address else "").strip() or "127.0.0.1"

    def request_is_secure(self) -> bool:
        forwarded_proto = str(self.headers.get("X-Forwarded-Proto", "") or "").split(",")[0].strip().lower()
        if forwarded_proto:
            return forwarded_proto == "https"
        origin = str(self.headers.get("Origin", "") or "").strip().lower()
        return origin.startswith("https://")

    def request_cookie_value(self, cookie_name: str) -> str:
        raw_cookie = str(self.headers.get("Cookie", "") or "").strip()
        target = str(cookie_name or "").strip()
        if not raw_cookie or not target:
            return ""
        parser = SimpleCookie()
        try:
            parser.load(raw_cookie)
        except Exception:
            return ""
        morsel = parser.get(target)
        return str(morsel.value or "").strip() if morsel is not None else ""

    def queue_response_cookie(self, cookie_header: str) -> None:
        normalized = str(cookie_header or "").strip()
        if not normalized:
            return
        pending = list(getattr(self, "_pending_response_cookies", []))
        pending.append(normalized)
        self._pending_response_cookies = pending

    def build_anonymous_cookie_header(self, anonymous_id: str) -> str:
        encoded_value = quote(str(anonymous_id or "").strip(), safe="")
        parts = [
            f"{settings.ANONYMOUS_ID_COOKIE_NAME}={encoded_value}",
            "Path=/",
            f"Max-Age={int(settings.ANONYMOUS_ID_COOKIE_MAX_AGE_SECONDS)}",
            "HttpOnly",
            "SameSite=Lax",
        ]
        if self.request_is_secure():
            parts.append("Secure")
        return "; ".join(parts)

    def resolve_explain_subject(self, payload: dict | None = None) -> dict:
        token = self.account_token_from_request(payload)
        if token:
            account = self.user_repository.find_by_token(token)
            if account and bool(account.get("isRegistered")):
                resolved_user_id = sanitize_user_id(str(account.get("userId", "") or ""))
                if resolved_user_id and resolved_user_id != "default":
                    return {
                        "subjectType": "user",
                        "subjectId": resolved_user_id,
                        "billingUserId": resolved_user_id,
                        "accountMode": "registered",
                    }
        raw_cookie_id = self.request_cookie_value(settings.ANONYMOUS_ID_COOKIE_NAME)
        anonymous_id = sanitize_user_id(raw_cookie_id)
        if not anonymous_id or anonymous_id == "default":
            anonymous_id = f"guest_{secrets.token_hex(8)}"
            self.queue_response_cookie(self.build_anonymous_cookie_header(anonymous_id))
        return {
            "subjectType": "guest",
            "subjectId": anonymous_id,
            "billingUserId": anonymous_id,
            "accountMode": "guest",
        }

    def account_mode(self, user_id: str) -> str:
        return "registered" if self.user_repository.is_registered(user_id) else "guest"

    def account_token_from_request(self, payload: dict | None = None) -> str:
        header_token = str(self.headers.get("X-Account-Token", "") or "").strip()
        if header_token:
            return header_token
        query_token = parse_qs(urlparse(self.path).query).get("accountToken", [""])[0].strip()
        if query_token:
            return query_token
        if isinstance(payload, dict):
            return str(payload.get("accountToken", "") or "").strip()
        return ""

    def account_token_valid(self, user_id: str, payload: dict | None = None) -> bool:
        token = self.account_token_from_request(payload)
        return self.user_repository.verify_token(user_id, token)

    def respond_entitlement_error(
        self,
        *,
        status: int,
        code: str,
        error: str,
        billing: dict,
        extra: dict | None = None,
    ) -> None:
        payload = {"ok": False, "code": code, "error": error, "billing": billing}
        if extra:
            payload.update(extra)
        json_response(self, status, payload)

    def require_registered_account(
        self,
        *,
        user_id: str,
        payload: dict | None = None,
        billing: dict | None = None,
    ) -> dict | None:
        current_billing = billing or self.billing_payload(user_id)
        if current_billing["accountMode"] != "registered":
            self.respond_entitlement_error(
                status=401,
                code="REGISTER_REQUIRED",
                error="请先注册账号，再使用该功能。",
                billing=current_billing,
            )
            return None
        if not self.account_token_valid(user_id, payload):
            self.respond_entitlement_error(
                status=403,
                code="INVALID_ACCOUNT_TOKEN",
                error="账号令牌无效，请重新注册当前设备。",
                billing=current_billing,
            )
            return None
        return current_billing

    def gate_plan_access(
        self,
        *,
        user_id: str,
        feature: str,
        payload: dict | None = None,
        file_ext: str = "",
    ) -> dict | None:
        billing = self.billing_payload(user_id)
        if feature == "ai_explain":
            return billing
        if feature == "import":
            if str(file_ext or "").strip().lower() not in settings.IMPORT_ALLOWED_TYPES:
                self.respond_entitlement_error(
                    status=400,
                    code="UNSUPPORTED_FILE_TYPE",
                    error="仅支持 TXT / EPUB / PDF / MOBI。",
                    billing=billing,
                )
                return None
            return billing
        if feature.startswith("sync"):
            authorized = self.require_registered_account(user_id=user_id, payload=payload, billing=billing)
            if authorized is None:
                return None
            if not billing["features"]["cloudSync"]:
                self.respond_entitlement_error(
                    status=402,
                    code="PRO_REQUIRED",
                    error="云同步仅对 Pro 套餐开放。",
                    billing=billing,
                )
                return None
            return billing
        return billing

    def track_sync_event(self, *, user_id: str, direction: str, success: bool, error: str = "") -> None:
        self.event_repository.track(
            "sync_succeeded" if success else "sync_failed",
            user_id=user_id,
            payload={
                "direction": str(direction or "").strip(),
                "error": str(error or "").strip(),
            },
        )

    def billing_payload(
        self,
        user_id: str,
        *,
        usage_subject_type: str | None = None,
        usage_subject_id: str | None = None,
    ) -> dict:
        normalized_user_id = sanitize_user_id(user_id)
        billing = self.billing_store.get_billing(normalized_user_id)
        stripe_link = stripe_payment_link_url()
        stripe_link_ready = self._stripe_payment_link_ready()
        stripe_checkout_ready = self._stripe_checkout_ready()
        billing["paymentChannels"] = payment_channels()
        billing["paymentEnabled"] = settings.payment_enabled()
        billing["manualPlanChangeEnabled"] = BILLING_ALLOW_MANUAL_PLAN_CHANGE
        billing["manualPaymentConfirmEnabled"] = BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM
        billing["priceFen"] = PRO_PRICE_FEN
        billing["orderExpireMinutes"] = ORDER_EXPIRE_MINUTES
        billing["stripe"] = {
            "checkoutReady": stripe_checkout_ready,
            "portalReady": self._stripe_portal_ready(),
            "paymentLinkReady": stripe_link_ready,
            "paymentLink": stripe_link if stripe_link_ready else "",
            "paymentMode": (
                "payment_link"
                if stripe_link_ready
                else ("checkout" if stripe_checkout_ready else "none")
            ),
            "intervals": {
                "monthly": bool(STRIPE_PRICE_ID_MONTHLY),
                "yearly": bool(STRIPE_PRICE_ID_YEARLY),
            },
            "defaultInterval": "monthly" if STRIPE_PRICE_ID_MONTHLY or not STRIPE_PRICE_ID_YEARLY else "yearly",
            "customerId": str(billing.get("stripeCustomerId", "") or "").strip(),
            "subscriptionId": str(billing.get("stripeSubscriptionId", "") or "").strip(),
        }
        billing["officialGateway"] = {
            PAY_CHANNEL_WECHAT: self._wechat_official_order_ready(),
            PAY_CHANNEL_ALIPAY: self._alipay_official_order_ready(),
            PAY_CHANNEL_STRIPE: bool(stripe_link_ready or stripe_checkout_ready),
        }
        billing["accountMode"] = self.account_mode(normalized_user_id)
        normalized_subject_type = str(usage_subject_type or "").strip().lower()
        normalized_subject_id = str(usage_subject_id or "").strip()
        if normalized_subject_type not in {"user", "guest", "guest_ip"}:
            normalized_subject_type = "user" if billing["accountMode"] == "registered" else "guest"
        if not normalized_subject_id:
            normalized_subject_id = normalized_user_id
        usage_stats = self.ai_explain_service.daily_usage_stats(
            subject_type=normalized_subject_type,
            subject_id=normalized_subject_id,
            plan=billing["plan"],
        )
        billing["features"]["aiExplainDailyLimit"] = usage_stats["dailyLimit"]
        billing["aiExplainUsedToday"] = usage_stats["usedToday"]
        billing["aiExplainRemainingToday"] = usage_stats["remainingToday"]
        billing["aiExplainCachedToday"] = usage_stats["cachedToday"]
        billing["aiExplainLimitedToday"] = usage_stats["limitedToday"]
        return billing

    @staticmethod
    def _book_brief(book: dict | None) -> dict:
        source = book if isinstance(book, dict) else {}
        return {
            "id": str(source.get("id", "") or "").strip(),
            "title": str(source.get("title", "") or "").strip(),
            "format": str(source.get("format", "") or "").strip(),
            "chapterCount": int(source.get("chapterCount", 0) or 0),
            "sourceFileName": str(source.get("sourceFileName", "") or "").strip(),
            "sampleSlug": str(source.get("sampleSlug", "") or "").strip(),
            "stats": source.get("stats") if isinstance(source.get("stats"), dict) else {},
            "chapters": source.get("chapters") if isinstance(source.get("chapters"), list) else [],
        }

    def _book_metadata_payload(self, *, book_id: str, user_id: str) -> dict | None:
        book = self.book_repository.get_book_metadata(book_id)
        if not book:
            return None
        payload = self._book_brief(book)
        payload["userId"] = str(book.get("userId", "") or "")
        payload["normalizedVersion"] = int(book.get("normalizedVersion", 1) or 1)
        payload["importedAt"] = int(book.get("importedAt", 0) or 0)
        payload["progress"] = self.progress_repository.get_progress(user_id, book_id)
        return payload

    def _current_chapter_payload(self, *, book_id: str, chapter_id: str) -> dict | None:
        chapter = self.book_repository.get_chapter_payload(book_id, chapter_id)
        if not chapter:
            return None
        analysis = chapter.get("analysis") if isinstance(chapter.get("analysis"), dict) else {}
        if not self.chapter_analysis_service.analysis_is_current(analysis):
            refreshed = self.chapter_analysis_service.analyze_chapter(chapter)
            self.book_repository.update_chapter_analysis(
                book_id=book_id,
                chapter_id=chapter_id,
                analysis=refreshed,
            )
            chapter["analysis"] = refreshed
        return chapter

    @staticmethod
    def _stripe_checkout_ready() -> bool:
        return stripe_checkout_enabled()

    @staticmethod
    def _stripe_payment_link_ready() -> bool:
        return stripe_payment_link_enabled()

    @staticmethod
    def _stripe_portal_ready() -> bool:
        return bool(stripe_runtime_enabled())

    def _stripe_success_url(self) -> str:
        if is_abs_http_url(STRIPE_SUCCESS_URL):
            return STRIPE_SUCCESS_URL
        if STRIPE_SUCCESS_URL.startswith("/"):
            base = f"{self.resolve_app_base_url()}{STRIPE_SUCCESS_URL}"
        else:
            base = self.resolve_app_base_url(STRIPE_SUCCESS_URL)
        sep = "&" if "?" in base else "?"
        return (
            f"{base}{sep}billing=success"
            f"&channel={PAY_CHANNEL_STRIPE}"
            "&session_id={CHECKOUT_SESSION_ID}"
        )

    def _stripe_cancel_url(self) -> str:
        if is_abs_http_url(STRIPE_CANCEL_URL):
            return STRIPE_CANCEL_URL
        if STRIPE_CANCEL_URL.startswith("/"):
            base = f"{self.resolve_app_base_url()}{STRIPE_CANCEL_URL}"
        else:
            base = self.resolve_app_base_url(STRIPE_CANCEL_URL)
        sep = "&" if "?" in base else "?"
        return f"{base}{sep}billing=cancel&channel={PAY_CHANNEL_STRIPE}"

    def _stripe_portal_return_url(self) -> str:
        if is_abs_http_url(STRIPE_PORTAL_RETURN_URL):
            return STRIPE_PORTAL_RETURN_URL
        if STRIPE_PORTAL_RETURN_URL.startswith("/"):
            base = f"{self.resolve_app_base_url()}{STRIPE_PORTAL_RETURN_URL}"
        else:
            base = self.resolve_app_base_url(STRIPE_PORTAL_RETURN_URL)
        sep = "&" if "?" in base else "?"
        return f"{base}{sep}billing=portal&channel={PAY_CHANNEL_STRIPE}"

    def _stripe_retrieve_checkout_session(self, session_id: str) -> tuple[dict | None, str]:
        session_key = str(session_id or "").strip()
        if not session_key:
            return None, "缺少 sessionId。"
        data = {"expand[]": ["subscription", "customer"]}
        return stripe_api_request("GET", f"/v1/checkout/sessions/{quote_plus(session_key)}", data=data)

    def _stripe_retrieve_subscription(self, subscription_id: str) -> tuple[dict | None, str]:
        sub_key = str(subscription_id or "").strip()
        if not sub_key:
            return None, "缺少订阅 ID。"
        return stripe_api_request("GET", f"/v1/subscriptions/{quote_plus(sub_key)}")

    def _resolve_billing_user_for_stripe(
        self,
        customer_id: str = "",
        user_id_hint: str = "",
        metadata: dict | None = None,
    ) -> str:
        if isinstance(metadata, dict):
            candidate = sanitize_user_id(str(metadata.get("userId", "") or ""))
            if candidate and candidate != "default":
                return candidate
        hint = sanitize_user_id(user_id_hint)
        if hint and hint != "default":
            return hint
        if customer_id:
            mapped = self.billing_store.find_user_by_stripe_customer_id(customer_id)
            if mapped:
                return mapped
        return ""

    def _sync_billing_from_stripe_subscription(
        self,
        *,
        subscription: dict | None = None,
        subscription_id: str = "",
        customer_id: str = "",
        user_id_hint: str = "",
        metadata: dict | None = None,
        source: str = "stripe",
        last_order_id: str = "",
    ) -> tuple[dict | None, str]:
        sub_obj = subscription if isinstance(subscription, dict) else None
        sub_id = str(subscription_id or "").strip()
        if sub_obj is None and sub_id:
            sub_obj, fetch_error = self._stripe_retrieve_subscription(sub_id)
            if sub_obj is None:
                return None, fetch_error or "无法查询 Stripe 订阅状态。"
        if sub_obj is None:
            return None, "缺少 Stripe 订阅信息。"
        sub_id = str(sub_obj.get("id", "") or "").strip() or sub_id
        customer = sub_obj.get("customer")
        if not customer_id:
            if isinstance(customer, dict):
                customer_id = str(customer.get("id", "") or "").strip()
            else:
                customer_id = str(customer or "").strip()
        status = normalize_subscription_status(sub_obj.get("status"))
        period_end_ms = stripe_period_end_ms(sub_obj.get("current_period_end"))
        user_id = self._resolve_billing_user_for_stripe(
            customer_id=customer_id,
            user_id_hint=user_id_hint,
            metadata=metadata if isinstance(metadata, dict) else sub_obj.get("metadata"),
        )
        if not user_id:
            return None, "无法将 Stripe 订阅映射到用户。"
        now_ms = int(time.time() * 1000)
        inactive_statuses = {"canceled", "incomplete_expired"}
        grace_statuses = {"past_due", "unpaid", "incomplete"}
        target_plan = PRO_PLAN
        grace_until_at = 0
        payment_failed_at = 0
        billing_state = "active"
        if status in grace_statuses:
            payment_failed_at = now_ms
            grace_until_at = max(
                period_end_ms,
                now_ms + settings.BILLING_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
            )
            billing_state = "grace"
        elif status in inactive_statuses:
            target_plan = PRO_PLAN if period_end_ms > now_ms else FREE_PLAN
            billing_state = "canceled"
        billing = self.billing_store.set_plan(
            user_id,
            target_plan,
            source=source,
            last_paid_channel=PAY_CHANNEL_STRIPE,
            last_order_id=last_order_id,
            plan_status="active" if target_plan == PRO_PLAN else "inactive",
            subscription_status=status,
            plan_expire_at=period_end_ms if period_end_ms > 0 else 0,
            stripe_customer_id=customer_id,
            stripe_subscription_id=sub_id,
            grace_until_at=grace_until_at,
            payment_failed_at=payment_failed_at,
            billing_state=billing_state,
        )
        return billing, ""

    def _sync_billing_from_checkout_session(
        self,
        session: dict,
        *,
        source: str,
        user_id_hint: str = "",
    ) -> tuple[dict | None, dict | None, str]:
        if not isinstance(session, dict):
            return None, None, "无效的 Stripe Checkout Session。"
        mode = str(session.get("mode", "") or "").strip().lower()
        if mode != "subscription":
            return None, None, "仅支持 Stripe 订阅模式。"
        session_status = str(session.get("status", "") or "").strip().lower()
        if session_status and session_status != "complete":
            return None, None, "Stripe Checkout 尚未完成。"
        payment_status = str(session.get("payment_status", "") or "").strip().lower()
        if payment_status and payment_status not in {"paid", "no_payment_required"}:
            return None, None, "Stripe 支付尚未成功。"
        session_id = str(session.get("id", "") or "").strip()
        metadata = session.get("metadata") if isinstance(session.get("metadata"), dict) else {}
        order_id = str(metadata.get("orderId", "") or "").strip() if isinstance(metadata, dict) else ""
        customer = session.get("customer")
        customer_id = str(customer.get("id", "") or "").strip() if isinstance(customer, dict) else str(customer or "").strip()
        subscription_ref = session.get("subscription")
        subscription_obj = subscription_ref if isinstance(subscription_ref, dict) else None
        subscription_id = (
            str(subscription_ref.get("id", "") or "").strip()
            if isinstance(subscription_ref, dict)
            else str(subscription_ref or "").strip()
        )
        billing, sync_error = self._sync_billing_from_stripe_subscription(
            subscription=subscription_obj,
            subscription_id=subscription_id,
            customer_id=customer_id,
            user_id_hint=user_id_hint,
            metadata=metadata,
            source=source,
            last_order_id=order_id or session_id,
        )
        if billing is None:
            return None, None, sync_error or "同步订阅状态失败。"
        order = None
        if order_id:
            order = self.order_store.mark_paid(
                order_id,
                paid_source=source,
                external_trade_no=session_id,
            )
            self._track_payment_success(order)
        return billing, order, ""

    def _create_stripe_checkout_session(self, *, user_id: str, interval: str, order_id: str) -> tuple[dict | None, str]:
        price_id = stripe_price_id(interval)
        if not price_id:
            return None, f"Stripe 未配置 {normalize_stripe_interval(interval)} 的 price_id。"
        billing = self.billing_store.get_billing(user_id)
        data: dict[str, str] = {
            "mode": "subscription",
            "line_items[0][price]": price_id,
            "line_items[0][quantity]": "1",
            "success_url": self._stripe_success_url(),
            "cancel_url": self._stripe_cancel_url(),
            "client_reference_id": user_id,
            "metadata[userId]": user_id,
            "metadata[plan]": PRO_PLAN,
            "metadata[interval]": normalize_stripe_interval(interval),
            "metadata[orderId]": order_id,
            "allow_promotion_codes": "true",
        }
        customer_id = str(billing.get("stripeCustomerId", "") or "").strip()
        if customer_id:
            data["customer"] = customer_id
        else:
            data["customer_creation"] = "always"
        session, error = stripe_api_request("POST", "/v1/checkout/sessions", data=data)
        if session is None:
            return None, error or "Stripe Checkout Session 创建失败。"
        return session, ""

    def _create_stripe_portal_session(self, *, customer_id: str) -> tuple[dict | None, str]:
        target_customer = str(customer_id or "").strip()
        if not target_customer:
            return None, "缺少 Stripe customerId。"
        data = {
            "customer": target_customer,
            "return_url": self._stripe_portal_return_url(),
        }
        portal, error = stripe_api_request("POST", "/v1/billing_portal/sessions", data=data)
        if portal is None:
            return None, error or "Stripe Portal Session 创建失败。"
        return portal, ""

    @staticmethod
    def _parse_json_or_form_raw(raw: bytes, content_type: str) -> dict | None:
        if not raw:
            return {}
        lower_type = str(content_type or "").lower()
        if "application/x-www-form-urlencoded" in lower_type:
            text = raw.decode("utf-8", errors="ignore")
            form = parse_qs(text, keep_blank_values=True)
            return {key: values[0] if values else "" for key, values in form.items()}
        try:
            parsed = json.loads(raw.decode("utf-8"))
            if isinstance(parsed, dict):
                return parsed
            return {}
        except Exception:
            text = raw.decode("utf-8", errors="ignore").strip()
            if "=" in text:
                form = parse_qs(text, keep_blank_values=True)
                return {key: values[0] if values else "" for key, values in form.items()}
            return None

    @staticmethod
    def _wechat_official_order_ready() -> bool:
        return bool(
            requests is not None
            and crypto_runtime_ready()
            and WECHAT_APP_ID
            and WECHAT_MCH_ID
            and WECHAT_MCH_SERIAL
            and wechat_private_key_obj() is not None
        )

    @staticmethod
    def _wechat_official_notify_ready() -> bool:
        return bool(
            ApiHandler._wechat_official_order_ready()
            and AESGCM is not None
            and WECHAT_API_V3_KEY
            and wechat_platform_public_key_obj() is not None
        )

    @staticmethod
    def _alipay_official_order_ready() -> bool:
        return bool(
            crypto_runtime_ready()
            and ALIPAY_APP_ID
            and ALIPAY_GATEWAY
            and alipay_private_key_obj() is not None
        )

    @staticmethod
    def _alipay_official_notify_ready() -> bool:
        return bool(ApiHandler._alipay_official_order_ready() and alipay_public_key_obj() is not None)

    def _wechat_notify_url(self) -> str:
        if is_abs_http_url(WECHAT_NOTIFY_URL):
            return WECHAT_NOTIFY_URL
        return f"{self.resolve_app_base_url(WECHAT_NOTIFY_URL)}/api/billing/wechat/notify"

    def _alipay_notify_url(self) -> str:
        if is_abs_http_url(ALIPAY_NOTIFY_URL):
            return ALIPAY_NOTIFY_URL
        return f"{self.resolve_app_base_url(ALIPAY_NOTIFY_URL)}/api/billing/alipay/notify"

    def _alipay_return_url(self, order: dict) -> str:
        if is_abs_http_url(ALIPAY_RETURN_URL):
            base = ALIPAY_RETURN_URL
        else:
            base = f"{self.resolve_app_base_url(ALIPAY_RETURN_URL)}/"
        sep = "&" if "?" in base else "?"
        return (
            f"{base}{sep}billing=success"
            f"&orderId={quote(str(order.get('orderId', '') or '').strip())}"
            f"&channel={PAY_CHANNEL_ALIPAY}"
        )

    def _create_wechat_official_pay_url(self, order: dict) -> str:
        if not self._wechat_official_order_ready():
            return ""
        private_key = wechat_private_key_obj()
        if private_key is None or requests is None:
            return ""
        path = "/v3/pay/transactions/native"
        api_base = WECHAT_PAY_API_BASE.rstrip("/") or "https://api.mch.weixin.qq.com"
        payload = {
            "appid": WECHAT_APP_ID,
            "mchid": WECHAT_MCH_ID,
            "description": f"YomuYomu Pro ({PRO_PLAN_DAYS} days)",
            "out_trade_no": str(order.get("orderId", "") or "").strip(),
            "notify_url": self._wechat_notify_url(),
            "amount": {
                "total": int(order.get("amountFen", PRO_PRICE_FEN) or PRO_PRICE_FEN),
                "currency": "CNY",
            },
            "time_expire": utc_iso8601(int(order.get("expiresAt", 0) or 0)),
        }
        body_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        timestamp = str(int(time.time()))
        nonce_str = secrets.token_hex(16)
        message = f"POST\n{path}\n{timestamp}\n{nonce_str}\n{body_text}\n".encode("utf-8")
        signature = rsa_sign_sha256_base64(private_key, message)
        if not signature:
            return ""
        authorization = (
            'WECHATPAY2-SHA256-RSA2048 '
            f'mchid="{WECHAT_MCH_ID}",'
            f'nonce_str="{nonce_str}",'
            f'timestamp="{timestamp}",'
            f'serial_no="{WECHAT_MCH_SERIAL}",'
            f'signature="{signature}"'
        )
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": authorization,
            "Wechatpay-Serial": WECHAT_MCH_SERIAL,
        }
        try:
            resp = requests.post(
                f"{api_base}{path}",
                data=body_text.encode("utf-8"),
                headers=headers,
                timeout=10,
            )
            if resp.status_code not in {200, 201}:
                return ""
            data = resp.json() if resp.text else {}
            if not isinstance(data, dict):
                return ""
            for key in ("code_url", "mweb_url", "h5_url", "qr_code"):
                value = str(data.get(key, "") or "").strip()
                if value:
                    return value
            return ""
        except Exception:
            return ""

    def _create_alipay_official_pay_url(self, order: dict) -> str:
        if not self._alipay_official_order_ready():
            return ""
        private_key = alipay_private_key_obj()
        if private_key is None:
            return ""
        biz_content = {
            "out_trade_no": str(order.get("orderId", "") or "").strip(),
            "product_code": "FAST_INSTANT_TRADE_PAY",
            "total_amount": f"{(int(order.get('amountFen', PRO_PRICE_FEN) or PRO_PRICE_FEN) / 100):.2f}",
            "subject": f"YomuYomu Pro ({PRO_PLAN_DAYS} days)",
            "timeout_express": f"{ORDER_EXPIRE_MINUTES}m",
        }
        params = {
            "app_id": ALIPAY_APP_ID,
            "method": "alipay.trade.page.pay",
            "format": "JSON",
            "charset": "utf-8",
            "sign_type": "RSA2",
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "version": "1.0",
            "notify_url": self._alipay_notify_url(),
            "return_url": self._alipay_return_url(order),
            "biz_content": json.dumps(biz_content, ensure_ascii=False, separators=(",", ":")),
        }
        unsigned = "&".join(
            f"{key}={params[key]}"
            for key in sorted(params.keys())
            if str(params[key]).strip() != ""
        )
        signature = rsa_sign_sha256_base64(private_key, unsigned.encode("utf-8"))
        if not signature:
            return ""
        params["sign"] = signature
        gateway = ALIPAY_GATEWAY.rstrip("?")
        return f"{gateway}?{urlencode(params, quote_via=quote_plus)}"

    def _parse_wechat_official_notify(self, raw: bytes) -> tuple[dict | None, bool, str]:
        body_text = raw.decode("utf-8", errors="ignore")
        payload = self._parse_json_or_form_raw(raw, self.headers.get("Content-Type", ""))
        if payload is None or not isinstance(payload, dict):
            return None, False, "Invalid notify payload"
        signature = str(self.headers.get("Wechatpay-Signature", "") or "").strip()
        timestamp = str(self.headers.get("Wechatpay-Timestamp", "") or "").strip()
        nonce = str(self.headers.get("Wechatpay-Nonce", "") or "").strip()
        has_wechat_headers = bool(signature and timestamp and nonce)
        has_resource = isinstance(payload.get("resource"), dict)
        if not has_wechat_headers and not has_resource:
            return payload, False, ""
        if not self._wechat_official_notify_ready():
            return None, True, "微信官方回调参数未完整配置，无法验签。"
        if not has_wechat_headers or not has_resource:
            return None, True, "微信回调缺少签名头或 resource 字段。"
        public_key = wechat_platform_public_key_obj()
        if public_key is None:
            return None, True, "微信平台公钥无效。"
        message = f"{timestamp}\n{nonce}\n{body_text}\n".encode("utf-8")
        if not rsa_verify_sha256_base64(public_key, message, signature):
            return None, True, "微信回调签名校验失败。"
        resource = payload.get("resource", {})
        ciphertext = str(resource.get("ciphertext", "") or "").strip()
        nonce_value = str(resource.get("nonce", "") or "").strip()
        associated_data = str(resource.get("associated_data", "") or "")
        if not ciphertext or not nonce_value:
            return None, True, "微信回调 resource 不完整。"
        try:
            key_bytes = WECHAT_API_V3_KEY.encode("utf-8")
            aad = associated_data.encode("utf-8") if associated_data else None
            plain_text = AESGCM(key_bytes).decrypt(nonce_value.encode("utf-8"), base64.b64decode(ciphertext), aad)
            trade_payload = json.loads(plain_text.decode("utf-8"))
            if not isinstance(trade_payload, dict):
                return None, True, "微信回调解密结果无效。"
            if not str(trade_payload.get("trade_state", "") or "").strip():
                if str(payload.get("event_type", "")).strip().upper() == "TRANSACTION.SUCCESS":
                    trade_payload["trade_state"] = "SUCCESS"
            return trade_payload, True, ""
        except Exception:
            return None, True, "微信回调解密失败。"

    def _parse_alipay_official_notify(self, payload: dict) -> tuple[dict, bool, str]:
        sign = str(payload.get("sign", "") or "").strip()
        if not sign:
            return payload, False, ""
        if not self._alipay_official_notify_ready():
            return payload, True, "支付宝公钥或应用配置缺失，无法验签。"
        public_key = alipay_public_key_obj()
        if public_key is None:
            return payload, True, "支付宝公钥无效。"
        unsigned = "&".join(
            f"{key}={str(value or '')}"
            for key, value in sorted(payload.items(), key=lambda item: item[0])
            if key not in {"sign", "sign_type"}
        )
        if not rsa_verify_sha256_base64(public_key, unsigned.encode("utf-8"), sign):
            return payload, True, "支付宝回调签名校验失败。"
        return payload, True, ""

    def _payment_token_valid(self) -> bool:
        if not BILLING_NOTIFY_TOKEN:
            return True
        token = str(self.headers.get("X-Payment-Token", "") or "").strip()
        if token == BILLING_NOTIFY_TOKEN:
            return True
        parsed = urlparse(self.path)
        query_token = parse_qs(parsed.query).get("token", [""])[0].strip()
        return query_token == BILLING_NOTIFY_TOKEN

    @staticmethod
    def _extract_order_id(payload: dict) -> str:
        for key in (
            "orderId",
            "order_id",
            "out_trade_no",
            "outTradeNo",
            "merchantOrderNo",
            "biz_order_no",
        ):
            raw = str(payload.get(key, "") or "").strip()
            if raw:
                return raw
        return ""

    @staticmethod
    def _extract_external_trade_no(payload: dict) -> str:
        for key in ("trade_no", "tradeNo", "transaction_id", "transactionId"):
            raw = str(payload.get(key, "") or "").strip()
            if raw:
                return raw
        return ""

    @staticmethod
    def _notify_success(channel: str, payload: dict) -> bool:
        normalized = normalize_pay_channel(channel)
        if normalized == PAY_CHANNEL_ALIPAY:
            raw = (
                str(payload.get("trade_status", "") or "")
                or str(payload.get("status", "") or "")
            ).strip().upper()
            if not raw:
                return True
            return raw in {"TRADE_SUCCESS", "TRADE_FINISHED", "SUCCESS"}
        raw = (
            str(payload.get("trade_state", "") or "")
            or str(payload.get("tradeStatus", "") or "")
            or str(payload.get("status", "") or "")
            or str(payload.get("result_code", "") or "")
        ).strip().upper()
        if not raw:
            return True
        return raw in {"SUCCESS", "TRADE_SUCCESS", "PAY_SUCCESS"}

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in {"/admin", "/admin/"}:
            self.path = "/admin.html"
            super().do_GET()
            return
        if parsed.path in {"/ops.html", "/ops.js"} and not BILLING_ADMIN_TOKEN:
            self.send_error(404)
            return
        if parsed.path == "/api/health":
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "tokenizer": self.tokenizer.backend,
                    "jmdict": self.dict_store.available(),
                    "paymentChannels": payment_channels(),
                    "officialGateway": {
                        PAY_CHANNEL_WECHAT: {
                            "order": self._wechat_official_order_ready(),
                            "notify": self._wechat_official_notify_ready(),
                        },
                        PAY_CHANNEL_ALIPAY: {
                            "order": self._alipay_official_order_ready(),
                            "notify": self._alipay_official_notify_ready(),
                        },
                        PAY_CHANNEL_STRIPE: {
                            "order": bool(
                                self._stripe_payment_link_ready()
                                or self._stripe_checkout_ready()
                            ),
                            "notify": bool(stripe_runtime_enabled() and STRIPE_WEBHOOK_SECRET),
                        },
                    },
                },
            )
            return
        if parsed.path == "/api/admin/ops/daily":
            self.handle_admin_ops_daily()
            return
        if parsed.path == "/api/admin/users":
            self.handle_admin_users()
            return
        if parsed.path == "/api/admin/ai-usage":
            self.handle_admin_ai_usage()
            return
        if parsed.path == "/api/export/vocab":
            self.handle_export_vocab()
            return
        if parsed.path == "/api/export/progress":
            self.handle_export_progress()
            return
        job_match = re.fullmatch(r"/api/import-jobs/([^/]+)", parsed.path)
        if job_match:
            self.handle_import_job_status(job_match.group(1))
            return
        chapter_match = re.fullmatch(r"/api/books/([^/]+)/chapters/([^/]+)", parsed.path)
        if chapter_match:
            query = parse_qs(parsed.query)
            user_id = sanitize_user_id(query.get("userId", ["default"])[0])
            self.handle_book_chapter(
                book_id=chapter_match.group(1),
                chapter_id=chapter_match.group(2),
                user_id=user_id,
            )
            return
        book_match = re.fullmatch(r"/api/books/([^/]+)", parsed.path)
        if book_match:
            query = parse_qs(parsed.query)
            user_id = sanitize_user_id(query.get("userId", ["default"])[0])
            self.handle_book_metadata(book_match.group(1), user_id=user_id)
            return
        if parsed.path == "/api/sample-book":
            query = parse_qs(parsed.query)
            user_id = sanitize_user_id(query.get("userId", ["default"])[0])
            self.handle_sample_book(user_id=user_id)
            return
        if parsed.path == "/api/billing/plan":
            query = parse_qs(parsed.query)
            user_id = sanitize_user_id(query.get("userId", ["default"])[0])
            json_response(self, 200, {"ok": True, "billing": self.billing_payload(user_id)})
            return
        if parsed.path == "/api/payment/options":
            if not settings.payment_enabled():
                json_response(self, 200, {"enabled": False})
                return
            json_response(
                self,
                200,
                {
                    "enabled": True,
                    "channels": payment_channels(),
                    "stripe": {
                        "paymentLinkReady": self._stripe_payment_link_ready(),
                        "paymentLink": stripe_payment_link_url(),
                        "checkoutReady": self._stripe_checkout_ready(),
                    },
                },
            )
            return
        if parsed.path == "/api/billing/order-status":
            self.handle_billing_order_status()
            return
        if parsed.path == "/api/sync/pull":
            self.handle_sync_pull()
            return
        if parsed.path.startswith("/api/"):
            json_response(self, 404, {"ok": False, "error": "API route not found"})
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        admin_plan_match = re.fullmatch(r"/api/admin/users/([^/]+)/plan", parsed.path)
        if admin_plan_match:
            self.handle_admin_user_plan_update(admin_plan_match.group(1))
            return
        delete_book_match = re.fullmatch(r"/api/books/([^/]+)/delete", parsed.path)
        if delete_book_match:
            self.handle_delete_book(delete_book_match.group(1))
            return
        progress_match = re.fullmatch(r"/api/books/([^/]+)/progress", parsed.path)
        if progress_match:
            self.handle_save_progress(progress_match.group(1))
            return
        if parsed.path == "/api/books/import":
            self.handle_async_import()
            return
        if parsed.path == "/api/auth/register":
            self.handle_auth_register()
            return
        if parsed.path == "/api/auth/login":
            self.handle_auth_login()
            return
        if parsed.path == "/api/feedback":
            self.handle_feedback()
            return
        if parsed.path == "/api/cloud/delete":
            self.handle_cloud_delete()
            return
        if parsed.path == "/api/account/delete":
            self.handle_account_delete()
            return
        if parsed.path == "/api/events":
            self.handle_event_ingest()
            return
        if parsed.path == "/api/billing/create-order":
            self.handle_billing_create_order()
            return
        if parsed.path == "/api/billing/create-checkout-session":
            self.handle_billing_create_checkout_session()
            return
        if parsed.path == "/api/billing/checkout-complete":
            self.handle_billing_checkout_complete()
            return
        if parsed.path == "/api/billing/create-portal-session":
            self.handle_billing_create_portal_session()
            return
        if parsed.path == "/api/billing/confirm-paid":
            self.handle_billing_confirm_paid(source="manual-confirm")
            return
        if parsed.path == "/api/billing/stripe/webhook":
            self.handle_billing_stripe_webhook()
            return
        if parsed.path == "/api/billing/wechat/notify":
            self.handle_billing_notify(PAY_CHANNEL_WECHAT)
            return
        if parsed.path == "/api/billing/alipay/notify":
            self.handle_billing_notify(PAY_CHANNEL_ALIPAY)
            return
        if parsed.path == "/api/import":
            self.handle_import()
            return
        if parsed.path == "/api/billing/set-plan":
            self.handle_set_billing_plan()
            return
        if parsed.path == "/api/nlp/tokenize":
            self.handle_tokenize()
            return
        if parsed.path == "/api/dict/lookup":
            self.handle_lookup()
            return
        if parsed.path == "/api/ai/explain":
            self.handle_ai_explain()
            return
        if parsed.path == "/api/sync/push":
            self.handle_sync_push()
            return
        json_response(self, 404, {"ok": False, "error": "API route not found"})

    def handle_import(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            json_response(self, 400, {"ok": False, "error": "Use multipart/form-data with file"})
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            json_response(self, 400, {"ok": False, "error": "Empty body"})
            return
        if length > settings.IMPORT_MAX_FILE_BYTES + 64 * 1024:
            json_response(self, 413, {"ok": False, "error": "上传文件过大。"})
            return
        raw_body = self.rfile.read(length)
        fields, files = parse_multipart_form(raw_body, content_type)
        if not files or "file" not in files:
            json_response(self, 400, {"ok": False, "error": "Missing `file` field"})
            return
        user_id = sanitize_user_id((fields or {}).get("userId", "default"))
        filename, raw = files["file"]
        filename = filename or "book.txt"
        ext = Path(filename).suffix.lower().lstrip(".")
        if len(raw) > settings.IMPORT_MAX_FILE_BYTES:
            json_response(self, 413, {"ok": False, "error": "上传文件过大。"})
            return
        billing = self.gate_plan_access(
            user_id=user_id,
            feature="import",
            payload=fields or {},
            file_ext=ext or "txt",
        )
        if billing is None:
            return
        try:
            result = service_parse_book(raw, filename, ext)
            json_response(self, 200, {"ok": True, "book": result})
        except Exception as exc:
            json_response(self, 500, {"ok": False, "error": str(exc)})

    def handle_async_import(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            json_response(self, 400, {"ok": False, "error": "Use multipart/form-data with file"})
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            json_response(self, 400, {"ok": False, "error": "Empty body"})
            return
        if length > settings.IMPORT_MAX_FILE_BYTES + 64 * 1024:
            json_response(self, 413, {"ok": False, "error": "上传文件过大。"})
            return
        raw_body = self.rfile.read(length)
        fields, files = parse_multipart_form(raw_body, content_type)
        if not files or "file" not in files:
            json_response(self, 400, {"ok": False, "error": "Missing `file` field"})
            return

        user_id = sanitize_user_id((fields or {}).get("userId", "default"))
        filename, raw = files["file"]
        filename = filename or "book.txt"
        ext = Path(filename).suffix.lower().lstrip(".")
        if len(raw) > settings.IMPORT_MAX_FILE_BYTES:
            json_response(self, 413, {"ok": False, "error": "上传文件过大。"})
            return
        billing = self.gate_plan_access(
            user_id=user_id,
            feature="import",
            payload=fields or {},
            file_ext=ext or "txt",
        )
        if billing is None:
            return
        allow_user, retry_after_user = self.import_rate_limiter.check(
            key=f"import:user:{user_id}",
            limit=settings.IMPORT_RATE_LIMIT_MAX_PER_USER,
            window_seconds=settings.IMPORT_RATE_LIMIT_WINDOW_SECONDS,
        )
        if not allow_user:
            self.respond_entitlement_error(
                status=429,
                code="IMPORT_RATE_LIMITED",
                error=f"导入过于频繁，请 {retry_after_user} 秒后再试。",
                billing=billing,
                extra={"retryAfterSeconds": retry_after_user},
            )
            return
        allow_ip, retry_after_ip = self.import_rate_limiter.check(
            key=f"import:ip:{self.client_ip()}",
            limit=settings.IMPORT_RATE_LIMIT_MAX_PER_IP,
            window_seconds=settings.IMPORT_RATE_LIMIT_WINDOW_SECONDS,
        )
        if not allow_ip:
            self.respond_entitlement_error(
                status=429,
                code="IMPORT_RATE_LIMITED",
                error=f"该网络请求过于频繁，请 {retry_after_ip} 秒后再试。",
                billing=billing,
                extra={"retryAfterSeconds": retry_after_ip},
            )
            return

        self.event_repository.track(
            "book_import_requested",
            user_id=user_id,
            payload={"fileName": filename, "fileType": ext or "txt"},
        )
        job = self.library_import_service.enqueue_import(
            user_id=user_id,
            file_name=filename,
            file_type=ext or "txt",
            raw=raw,
        )
        json_response(
            self,
            202,
            {
                "ok": True,
                "jobId": job["jobId"],
                "job": job,
            },
        )

    def handle_import_job_status(self, job_id: str) -> None:
        job = self.import_job_repository.get_job(job_id)
        if not job:
            json_response(self, 404, {"ok": False, "error": "Import job not found"})
            return
        json_response(self, 200, {"ok": True, "job": job})

    def handle_sample_book(self, *, user_id: str) -> None:
        book = self.library_import_service.sample_book_metadata()
        if not book:
            json_response(self, 503, {"ok": False, "error": "Sample book unavailable"})
            return
        metadata = self._book_metadata_payload(book_id=str(book.get("id", "") or ""), user_id=user_id)
        if not metadata:
            json_response(self, 503, {"ok": False, "error": "Sample book unavailable"})
            return
        self.event_repository.track("sample_opened", user_id=user_id)
        json_response(self, 200, {"ok": True, "book": metadata})

    def handle_book_metadata(self, book_id: str, *, user_id: str) -> None:
        book = self._book_metadata_payload(book_id=book_id, user_id=user_id)
        if not book:
            json_response(self, 404, {"ok": False, "error": "Book not found"})
            return
        json_response(self, 200, {"ok": True, "book": book})

    def handle_book_chapter(self, *, book_id: str, chapter_id: str, user_id: str) -> None:
        chapter = self._current_chapter_payload(book_id=book_id, chapter_id=chapter_id)
        if not chapter:
            json_response(self, 404, {"ok": False, "error": "Chapter not found"})
            return
        progress = self.progress_repository.get_progress(user_id, book_id)
        json_response(
            self,
            200,
            {
                "ok": True,
                "chapter": chapter,
                "progress": progress,
            },
        )

    def handle_save_progress(self, book_id: str) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        user_id = sanitize_user_id(str(payload.get("userId", "default") or "default"))
        saved = self.progress_repository.save_progress(
            user_id=user_id,
            book_id=book_id,
            chapter_id=str(payload.get("chapterId", "") or "").strip(),
            chapter_index=int(payload.get("chapterIndex", 0) or 0),
            paragraph_index=int(payload.get("paragraphIndex", 0) or 0),
            char_index=int(payload.get("charIndex", 0) or 0),
        )
        json_response(self, 200, {"ok": True, "progress": saved})

    def handle_event_ingest(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        event_name = str(payload.get("name", "") or payload.get("event", "")).strip()
        if not event_name:
            json_response(self, 400, {"ok": False, "error": "Missing event name"})
            return
        self.event_repository.track(
            event_name,
            user_id=sanitize_user_id(str(payload.get("userId", "default") or "default")),
            book_id=str(payload.get("bookId", "") or "").strip(),
            chapter_id=str(payload.get("chapterId", "") or "").strip(),
            payload=payload.get("payload") if isinstance(payload.get("payload"), dict) else {},
        )
        json_response(self, 200, {"ok": True})

    def handle_auth_register(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        username = self.user_repository.normalize_username(str(payload.get("username", "") or ""))
        password = str(payload.get("password", "") or "")
        if username or password:
            if not self.user_repository.valid_username(username):
                json_response(
                    self,
                    400,
                    {
                        "ok": False,
                        "code": "INVALID_USERNAME",
                        "error": "用户名仅支持 3-32 位小写字母、数字、下划线和连字符。",
                    },
                )
                return
            if username in {"default"} or username.startswith("guest_") or username.startswith("guest-"):
                json_response(
                    self,
                    400,
                    {
                        "ok": False,
                        "code": "INVALID_USERNAME",
                        "error": "用户名不可使用 guest/default 保留前缀。",
                    },
                )
                return
            if len(password) < 8:
                json_response(
                    self,
                    400,
                    {
                        "ok": False,
                        "code": "WEAK_PASSWORD",
                        "error": "密码至少需要 8 位。",
                    },
                )
                return
            if self.user_repository.find_by_username(username):
                json_response(
                    self,
                    409,
                    {
                        "ok": False,
                        "code": "USERNAME_EXISTS",
                        "error": "该用户名已存在，请换一个。",
                    },
                )
                return
            user_id = sanitize_user_id(username)
            result, error = self.account_service.register_account(
                user_id=user_id,
                local_snapshot=payload.get("snapshot") if isinstance(payload.get("snapshot"), dict) else {},
                anonymous_id=str(payload.get("anonymousId", "") or "").strip(),
                display_name=username,
            )
            if result is None:
                json_response(
                    self,
                    409,
                    {
                        "ok": False,
                        "code": "ACCOUNT_EXISTS",
                        "error": error or "该用户名已存在。",
                    },
                )
                return
            if not self.user_repository.set_credentials(
                user_id=user_id,
                username=username,
                password_hash=self.user_repository.hash_password(password),
            ):
                json_response(
                    self,
                    409,
                    {
                        "ok": False,
                        "code": "USERNAME_EXISTS",
                        "error": "该用户名已存在，请换一个。",
                    },
                )
                return
            refreshed_user = self.user_repository.get_user(user_id)
            if refreshed_user is not None:
                result["account"] = refreshed_user
            result["userId"] = user_id
            json_response(self, 200, {"ok": True, **result})
            return
        user_id = sanitize_user_id(str(payload.get("userId", "") or ""))
        if not user_id or user_id == "default" or user_id.startswith("guest_") or user_id.startswith("guest-"):
            json_response(
                self,
                400,
                {
                    "ok": False,
                    "code": "INVALID_ACCOUNT_ID",
                    "error": "请使用一个稳定的账号 ID，不能使用 guest/default。",
                },
            )
            return
        result, error = self.account_service.register_account(
            user_id=user_id,
            local_snapshot=payload.get("snapshot") if isinstance(payload.get("snapshot"), dict) else {},
            anonymous_id=str(payload.get("anonymousId", "") or "").strip(),
            display_name=str(payload.get("displayName", "") or "").strip(),
        )
        if result is None:
            json_response(
                self,
                409,
                {
                    "ok": False,
                    "code": "ACCOUNT_EXISTS",
                    "error": error or "该账号已存在。",
                },
            )
            return
        json_response(self, 200, {"ok": True, **result})

    def handle_auth_login(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        username = self.user_repository.normalize_username(str(payload.get("username", "") or ""))
        password = str(payload.get("password", "") or "")
        account = self.user_repository.authenticate(username=username, password=password)
        if account is None:
            json_response(
                self,
                401,
                {
                    "ok": False,
                    "code": "INVALID_CREDENTIALS",
                    "error": "用户名或密码错误。",
                },
            )
            return
        json_response(
            self,
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

    def handle_feedback(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        message = str(payload.get("message", "") or "").strip()
        kind = str(payload.get("kind", "feedback") or "feedback").strip().lower()
        user_id = sanitize_user_id(str(payload.get("userId", "default") or "default"))
        if not message:
            json_response(self, 400, {"ok": False, "error": "反馈内容不能为空。"})
            return
        self.event_repository.track(
            "feedback_submitted",
            user_id=user_id,
            book_id=str(payload.get("bookId", "") or "").strip(),
            chapter_id=str(payload.get("chapterId", "") or "").strip(),
            payload={
                "kind": kind,
                "message": message[:500],
            },
        )
        json_response(self, 200, {"ok": True})

    def handle_delete_book(self, book_id: str) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        user_id = sanitize_user_id(str(payload.get("userId", "default") or "default"))
        billing = self.require_registered_account(user_id=user_id, payload=payload)
        if billing is None:
            return
        if not self.account_service.delete_book(user_id=user_id, book_id=book_id):
            json_response(self, 404, {"ok": False, "error": "Book not found"})
            return
        remote = self.sync_repository.pull(user_id) or {}
        snapshot = remote.get("snapshot") if isinstance(remote, dict) else {}
        if isinstance(snapshot, dict):
            current_book = snapshot.get("book") if isinstance(snapshot.get("book"), dict) else {}
            if str(current_book.get("id", "") or "").strip() == str(book_id or "").strip():
                snapshot["book"] = None
                snapshot["currentChapter"] = 0
                snapshot["savedAt"] = int(time.time() * 1000)
                self.sync_repository.push(user_id, snapshot)
        self.event_repository.track("book_deleted", user_id=user_id, book_id=book_id)
        json_response(self, 200, {"ok": True, "billing": billing})

    def handle_cloud_delete(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        user_id = sanitize_user_id(str(payload.get("userId", "default") or "default"))
        billing = self.require_registered_account(user_id=user_id, payload=payload)
        if billing is None:
            return
        result = self.account_service.delete_cloud_data(user_id)
        json_response(self, 200, {"ok": True, "billing": self.billing_payload(user_id), **result})

    def handle_account_delete(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        user_id = sanitize_user_id(str(payload.get("userId", "default") or "default"))
        billing = self.require_registered_account(user_id=user_id, payload=payload)
        if billing is None:
            return
        result = self.account_service.delete_account(user_id)
        json_response(self, 200, {"ok": True, **result})

    def handle_export_vocab(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        user_id = sanitize_user_id(query.get("userId", ["default"])[0])
        billing = self.require_registered_account(user_id=user_id)
        if billing is None:
            return
        json_response(self, 200, {"ok": True, **self.account_service.export_vocabulary(user_id)})

    def handle_export_progress(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        user_id = sanitize_user_id(query.get("userId", ["default"])[0])
        billing = self.require_registered_account(user_id=user_id)
        if billing is None:
            return
        json_response(self, 200, {"ok": True, **self.account_service.export_progress(user_id)})

    def handle_admin_ops_daily(self) -> None:
        if not BILLING_ADMIN_TOKEN:
            json_response(
                self,
                404,
                {"ok": False, "code": "OPS_DISABLED", "error": "Admin ops 未启用。"},
            )
            return
        provided = str(self.headers.get("X-Admin-Token", "") or "").strip()
        if provided != BILLING_ADMIN_TOKEN:
            json_response(
                self,
                403,
                {"ok": False, "code": "INVALID_ADMIN_TOKEN", "error": "管理员令牌无效。"},
            )
            return
        query = parse_qs(urlparse(self.path).query)
        try:
            days = int(query.get("days", ["14"])[0] or 14)
        except ValueError:
            days = 14
        json_response(self, 200, {"ok": True, "rows": self.ops_service.daily_metrics(days=days)})

    def _require_admin_token(self) -> bool:
        if not ADMIN_TOKEN:
            json_response(
                self,
                403,
                {
                    "ok": False,
                    "code": "ADMIN_TOKEN_REQUIRED",
                    "error": "请先配置 ADMIN_TOKEN。",
                },
            )
            return False
        provided = str(self.headers.get("X-Admin-Token", "") or "").strip()
        if provided != ADMIN_TOKEN:
            json_response(
                self,
                403,
                {"ok": False, "code": "INVALID_ADMIN_TOKEN", "error": "管理员令牌无效。"},
            )
            return False
        return True

    def handle_admin_users(self) -> None:
        if not self._require_admin_token():
            return
        users = []
        for row in self.user_repository.list_admin_users():
            user_id = str(row.get("userId", "") or "")
            billing = self.billing_store.get_billing(user_id)
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
        json_response(self, 200, {"ok": True, "users": users})

    def handle_admin_ai_usage(self) -> None:
        if not self._require_admin_token():
            return
        query = parse_qs(urlparse(self.path).query)
        try:
            limit = max(1, min(1000, int(query.get("limit", ["200"])[0] or 200)))
        except ValueError:
            limit = 200
        rows = self.ai_repository.list_recent_daily_usage(limit=limit)
        events = self.ai_repository.list_recent_usage_events(limit=limit)
        for row in rows:
            row["lastUsedAtIso"] = utc_iso8601(int(row.get("lastUsedAt", 0) or 0))
        for row in events:
            row["createdAtIso"] = utc_iso8601(int(row.get("createdAt", 0) or 0))
        json_response(
            self,
            200,
            {
                "ok": True,
                "rows": rows,
                "events": events,
            },
        )

    def handle_admin_user_plan_update(self, raw_user_id: str) -> None:
        if not self._require_admin_token():
            return
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        user_id = sanitize_user_id(raw_user_id)
        if not self.user_repository.get_user(user_id):
            json_response(
                self,
                404,
                {"ok": False, "code": "USER_NOT_FOUND", "error": "用户不存在。"},
            )
            return
        plan = normalize_plan(str(payload.get("plan", FREE_PLAN)))
        status = normalize_plan_status(
            str(payload.get("status", "active" if plan == PRO_PLAN else "inactive"))
        )
        self.billing_store.set_plan(
            user_id,
            plan,
            source="admin-manual",
            plan_status=status,
            subscription_status="manual",
            billing_state="active" if status == "active" else "inactive",
        )
        json_response(self, 200, {"ok": True, "billing": self.billing_payload(user_id)})

    def _sync_plan_from_paid_order(self, order: dict) -> dict:
        if normalize_pay_channel(order.get("channel")) == PAY_CHANNEL_STRIPE:
            return self.billing_store.get_billing(order.get("userId", "default"))
        paid_at = int(order.get("paidAt", 0) or int(time.time() * 1000))
        expire_at = paid_at + PRO_PLAN_DAYS * 24 * 60 * 60 * 1000
        return self.billing_store.set_plan(
            order.get("userId", "default"),
            order.get("plan", PRO_PLAN),
            source=order.get("channel", "payment"),
            last_paid_channel=order.get("channel", ""),
            last_order_id=order.get("orderId", ""),
            plan_status="active",
            subscription_status="paid",
            plan_expire_at=expire_at,
            grace_until_at=0,
            payment_failed_at=0,
            billing_state="active",
        )

    def _track_payment_success(self, order: dict | None) -> None:
        if not isinstance(order, dict) or not order.get("statusChanged"):
            return
        self.event_repository.track(
            "payment_paid",
            user_id=str(order.get("userId", "") or ""),
            payload={
                "orderId": str(order.get("orderId", "") or ""),
                "channel": str(order.get("channel", "") or ""),
                "amountFen": int(order.get("amountFen", 0) or 0),
            },
        )

    def handle_billing_create_order(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        user_id = sanitize_user_id(str(payload.get("userId", "default")))
        channel = normalize_pay_channel(payload.get("channel", PAY_CHANNEL_WECHAT))
        billing = self.require_registered_account(user_id=user_id, payload=payload)
        if billing is None:
            return
        channels = billing["paymentChannels"]
        if not any_payment_channel_enabled():
            json_response(
                self,
                503,
                {
                    "ok": False,
                    "code": "PAYMENT_NOT_CONFIGURED",
                    "error": "支付通道未开启。",
                    "billing": billing,
                },
            )
            return
        if channel == PAY_CHANNEL_STRIPE:
            json_response(
                self,
                400,
                {
                    "ok": False,
                    "code": "USE_CHECKOUT_SESSION",
                    "error": "Stripe 请使用 create-checkout-session 接口。",
                    "billing": billing,
                },
            )
            return
        if not channels.get(channel):
            json_response(
                self,
                400,
                {
                    "ok": False,
                    "code": "CHANNEL_DISABLED",
                    "error": f"支付通道 `{channel}` 未开启。",
                    "billing": billing,
                },
            )
            return
        order = self.order_store.create_order(
            user_id=user_id,
            channel=channel,
            amount_fen=PRO_PRICE_FEN,
            plan=PRO_PLAN,
        )
        pay_url = ""
        payment_mode = "fallback"
        if channel == PAY_CHANNEL_WECHAT:
            pay_url = self._create_wechat_official_pay_url(order)
        elif channel == PAY_CHANNEL_ALIPAY:
            pay_url = self._create_alipay_official_pay_url(order)
        if pay_url:
            payment_mode = "official"
        if not pay_url:
            template = pay_entry_url(channel)
            pay_url = build_pay_url(
                template,
                order_id=order["orderId"],
                user_id=user_id,
                channel=channel,
            )
        if pay_url:
            order = self.order_store.set_pay_url(order["orderId"], pay_url) or order
        json_response(
            self,
            200,
            {
                "ok": True,
                "order": order,
                "paymentMode": payment_mode,
                "billing": self.billing_payload(user_id),
            },
        )

    def handle_billing_create_checkout_session(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        user_id = sanitize_user_id(str(payload.get("userId", "default")))
        interval = normalize_stripe_interval(payload.get("interval", "monthly"))
        if interval == "yearly" and not STRIPE_PRICE_ID_YEARLY:
            json_response(
                self,
                400,
                {
                    "ok": False,
                    "code": "YEARLY_NOT_CONFIGURED",
                    "error": "Stripe 年付套餐尚未配置。",
                },
            )
            return
        if interval == "monthly" and not STRIPE_PRICE_ID_MONTHLY and STRIPE_PRICE_ID_YEARLY:
            interval = "yearly"
        billing = self.require_registered_account(user_id=user_id, payload=payload)
        if billing is None:
            return
        channels = billing["paymentChannels"]
        if not channels.get(PAY_CHANNEL_STRIPE):
            json_response(
                self,
                400,
                {
                    "ok": False,
                    "code": "STRIPE_NOT_ENABLED",
                    "error": "Stripe 支付未启用或配置不完整。",
                    "billing": billing,
                },
            )
            return
        if not self._stripe_checkout_ready():
            json_response(
                self,
                503,
                {
                    "ok": False,
                    "code": "STRIPE_NOT_READY",
                    "error": "Stripe Checkout 未就绪，请检查秘钥和 Price 配置。",
                    "billing": billing,
                },
            )
            return
        order = self.order_store.create_order(
            user_id=user_id,
            channel=PAY_CHANNEL_STRIPE,
            amount_fen=PRO_PRICE_FEN,
            plan=PRO_PLAN,
        )
        session, error = self._create_stripe_checkout_session(
            user_id=user_id,
            interval=interval,
            order_id=order["orderId"],
        )
        if session is None:
            json_response(
                self,
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
            order = self.order_store.set_pay_url(order["orderId"], checkout_url) or order
        json_response(
            self,
            200,
            {
                "ok": True,
                "url": checkout_url,
                "checkoutUrl": checkout_url,
                "sessionId": str(session.get("id", "") or "").strip(),
                "interval": interval,
                "order": order,
                "billing": self.billing_payload(user_id),
            },
        )

    def handle_billing_checkout_complete(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        session_id = str(payload.get("sessionId", "") or "").strip()
        user_id_hint = sanitize_user_id(str(payload.get("userId", "default")))
        if not session_id:
            json_response(self, 400, {"ok": False, "error": "Missing sessionId"})
            return
        session, error = self._stripe_retrieve_checkout_session(session_id)
        if session is None:
            json_response(
                self,
                502,
                {
                    "ok": False,
                    "code": "STRIPE_SESSION_FETCH_FAILED",
                    "error": error or "无法查询 Stripe Checkout Session。",
                },
            )
            return
        billing, order, sync_error = self._sync_billing_from_checkout_session(
            session,
            source="stripe-checkout-complete",
            user_id_hint=user_id_hint,
        )
        if billing is None:
            json_response(
                self,
                400,
                {
                    "ok": False,
                    "code": "CHECKOUT_NOT_COMPLETED",
                    "error": sync_error or "Checkout 尚未完成。",
                },
            )
            return
        json_response(
            self,
            200,
            {
                "ok": True,
                "billing": self.billing_payload(billing["userId"]),
                "order": order or {},
                "session": {
                    "id": str(session.get("id", "") or "").strip(),
                    "status": str(session.get("status", "") or "").strip(),
                    "paymentStatus": str(session.get("payment_status", "") or "").strip(),
                },
            },
        )

    def handle_billing_create_portal_session(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        user_id = sanitize_user_id(str(payload.get("userId", "default")))
        billing = self.require_registered_account(user_id=user_id, payload=payload)
        if billing is None:
            return
        if not billing["paymentChannels"].get(PAY_CHANNEL_STRIPE):
            json_response(
                self,
                400,
                {
                    "ok": False,
                    "code": "STRIPE_NOT_ENABLED",
                    "error": "Stripe 支付未启用或配置不完整。",
                    "billing": billing,
                },
            )
            return
        if not self._stripe_portal_ready():
            json_response(
                self,
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
            json_response(
                self,
                400,
                {
                    "ok": False,
                    "code": "NO_STRIPE_CUSTOMER",
                    "error": "当前账号还没有 Stripe 客户记录，请先完成一次订阅支付。",
                    "billing": billing,
                },
            )
            return
        session, error = self._create_stripe_portal_session(customer_id=customer_id)
        if session is None:
            json_response(
                self,
                502,
                {
                    "ok": False,
                    "code": "STRIPE_PORTAL_SESSION_FAILED",
                    "error": error or "无法创建 Stripe Portal 会话。",
                    "billing": billing,
                },
            )
            return
        json_response(
            self,
            200,
            {
                "ok": True,
                "portalUrl": str(session.get("url", "") or "").strip(),
                "billing": billing,
            },
        )

    def handle_billing_stripe_webhook(self) -> None:
        raw = self.read_raw_body()
        signature = str(self.headers.get("Stripe-Signature", "") or "").strip()
        if not verify_stripe_signature(raw, signature):
            json_response(
                self,
                400,
                {
                    "ok": False,
                    "code": "INVALID_STRIPE_SIGNATURE",
                    "error": "Stripe Webhook 签名校验失败。",
                },
            )
            return
        payload = self._parse_json_or_form_raw(raw, self.headers.get("Content-Type", ""))
        if payload is None or not isinstance(payload, dict):
            json_response(self, 400, {"ok": False, "error": "Invalid webhook payload"})
            return
        event_type = str(payload.get("type", "") or "").strip()
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        event_obj = data.get("object") if isinstance(data.get("object"), dict) else {}
        if event_type == "checkout.session.completed":
            self._sync_billing_from_checkout_session(
                event_obj,
                source="stripe-webhook-checkout",
            )
        elif event_type in {"customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"}:
            self._sync_billing_from_stripe_subscription(
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
            self._sync_billing_from_stripe_subscription(
                subscription_id=subscription_id,
                customer_id=customer_id,
                metadata=metadata,
                source=f"stripe-webhook:{event_type}",
                last_order_id=str(event_obj.get("id", "") or "").strip(),
            )
        json_response(self, 200, {"ok": True, "received": True})

    def handle_billing_order_status(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        order_id = str(query.get("orderId", [""])[0] or "").strip()
        if not order_id:
            json_response(self, 400, {"ok": False, "error": "Missing orderId"})
            return
        order = self.order_store.get_order(order_id)
        if not order:
            json_response(self, 404, {"ok": False, "error": "Order not found"})
            return
        query_user = sanitize_user_id(query.get("userId", [""])[0])
        if query_user and query_user != "default" and query_user != order["userId"]:
            json_response(
                self,
                403,
                {
                    "ok": False,
                    "error": "Order does not belong to current user",
                },
            )
            return
        if order["status"] == "paid":
            self._sync_plan_from_paid_order(order)
        json_response(
            self,
            200,
            {
                "ok": True,
                "order": order,
                "billing": self.billing_payload(order["userId"]),
            },
        )

    def handle_billing_confirm_paid(self, source: str = "manual-confirm") -> None:
        payload = self.read_json_or_form_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid payment payload"})
            return
        if BILLING_NOTIFY_TOKEN and not self._payment_token_valid():
            json_response(
                self,
                403,
                {
                    "ok": False,
                    "code": "INVALID_PAYMENT_TOKEN",
                    "error": "支付确认令牌无效。",
                },
            )
            return
        if not BILLING_NOTIFY_TOKEN and not BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM:
            json_response(
                self,
                403,
                {
                    "ok": False,
                    "code": "MANUAL_PAYMENT_CONFIRM_DISABLED",
                    "error": "手动支付确认已禁用。",
                },
            )
            return
        order_id = self._extract_order_id(payload)
        if not order_id:
            json_response(self, 400, {"ok": False, "error": "Missing orderId"})
            return
        external_trade_no = self._extract_external_trade_no(payload)
        order = self.order_store.mark_paid(
            order_id,
            paid_source=source,
            external_trade_no=external_trade_no,
        )
        if not order:
            json_response(self, 404, {"ok": False, "error": "Order not found"})
            return
        self._track_payment_success(order)
        billing = self._sync_plan_from_paid_order(order)
        json_response(
            self,
            200,
            {
                "ok": True,
                "order": order,
                "billing": self.billing_payload(billing["userId"]),
            },
        )

    def handle_billing_notify(self, channel: str) -> None:
        normalized_channel = normalize_pay_channel(channel)
        raw = self.read_raw_body()
        payload: dict | None
        official_used = False
        official_error = ""
        if normalized_channel == PAY_CHANNEL_WECHAT:
            payload, official_used, official_error = self._parse_wechat_official_notify(raw)
        else:
            payload = self._parse_json_or_form_raw(raw, self.headers.get("Content-Type", ""))
            if payload is None:
                json_response(self, 400, {"ok": False, "error": "Invalid notify payload"})
                return
            if normalized_channel == PAY_CHANNEL_ALIPAY:
                payload, official_used, official_error = self._parse_alipay_official_notify(payload)
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid notify payload"})
            return
        if official_used and official_error:
            if normalized_channel == PAY_CHANNEL_ALIPAY:
                text_response(self, 400, "failure")
            elif normalized_channel == PAY_CHANNEL_WECHAT:
                json_response(self, 400, {"code": "FAIL", "message": official_error})
            else:
                json_response(self, 400, {"ok": False, "error": official_error})
            return
        official_verified = official_used and not official_error
        if not official_verified and BILLING_NOTIFY_TOKEN and not self._payment_token_valid():
            json_response(
                self,
                403,
                {
                    "ok": False,
                    "code": "INVALID_PAYMENT_TOKEN",
                    "error": "支付通知令牌无效。",
                },
            )
            return
        if not self._notify_success(normalized_channel, payload):
            if official_verified and normalized_channel == PAY_CHANNEL_ALIPAY:
                text_response(self, 200, "success")
                return
            if official_verified and normalized_channel == PAY_CHANNEL_WECHAT:
                json_response(self, 200, {"code": "SUCCESS", "message": "成功", "ignored": True})
                return
            json_response(self, 200, {"ok": True, "ignored": True})
            return
        order_id = self._extract_order_id(payload)
        if not order_id:
            json_response(self, 400, {"ok": False, "error": "Missing orderId in notify payload"})
            return
        external_trade_no = self._extract_external_trade_no(payload)
        order = self.order_store.mark_paid(
            order_id,
            paid_source=f"{normalized_channel}-notify",
            external_trade_no=external_trade_no,
        )
        if not order:
            json_response(self, 404, {"ok": False, "error": "Order not found"})
            return
        self._track_payment_success(order)
        self._sync_plan_from_paid_order(order)
        if official_verified and normalized_channel == PAY_CHANNEL_ALIPAY:
            text_response(self, 200, "success")
            return
        if official_verified and normalized_channel == PAY_CHANNEL_WECHAT:
            json_response(self, 200, {"code": "SUCCESS", "message": "成功", "order": order})
            return
        json_response(self, 200, {"ok": True, "order": order})

    def handle_tokenize(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        text = str(payload.get("text", ""))
        if not text.strip():
            json_response(self, 200, {"ok": True, "tokens": []})
            return
        tokens = self.tokenizer.tokenize(text)
        json_response(self, 200, {"ok": True, "backend": self.tokenizer.backend, "tokens": tokens})

    def handle_lookup(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        surface = str(payload.get("surface", "")).strip()
        lemma = str(payload.get("lemma", "")).strip()
        entries = self.dict_store.lookup(surface, lemma)
        json_response(self, 200, {"ok": True, "entries": entries})

    def handle_ai_explain(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        sentence = str(payload.get("sentence", "") or "")
        subject = self.resolve_explain_subject(payload)
        subject_type = str(subject.get("subjectType", "guest") or "guest").strip().lower()
        subject_id = str(subject.get("subjectId", "") or "").strip()
        billing_user_id = sanitize_user_id(str(subject.get("billingUserId", "default") or "default"))
        if not subject_id:
            subject_id = billing_user_id

        billing = self.gate_plan_access(user_id=billing_user_id, feature="ai_explain", payload=payload)
        if billing is None:
            return

        allow_subject, retry_after_subject = self.ai_rate_limiter.check(
            key=f"explain:{subject_type}:{subject_id}",
            limit=settings.AI_EXPLAIN_RATE_LIMIT_MAX_PER_USER,
            window_seconds=settings.AI_EXPLAIN_RATE_LIMIT_WINDOW_SECONDS,
        )
        if not allow_subject:
            self.respond_entitlement_error(
                status=429,
                code="AI_EXPLAIN_RATE_LIMITED",
                error=f"解释请求过于频繁，请 {retry_after_subject} 秒后再试。",
                billing=billing,
                extra={"retryAfterSeconds": retry_after_subject},
            )
            return
        request_ip = self.client_ip()
        allow_ip, retry_after_ip = self.ai_rate_limiter.check(
            key=f"explain:ip:{request_ip}",
            limit=settings.AI_EXPLAIN_RATE_LIMIT_MAX_PER_IP,
            window_seconds=settings.AI_EXPLAIN_RATE_LIMIT_WINDOW_SECONDS,
        )
        if not allow_ip:
            self.respond_entitlement_error(
                status=429,
                code="AI_EXPLAIN_RATE_LIMITED",
                error=f"该网络请求过于频繁，请 {retry_after_ip} 秒后再试。",
                billing=billing,
                extra={"retryAfterSeconds": retry_after_ip},
            )
            return
        guest_ip_quota_reserved = False
        if subject_type == "guest" and settings.AI_EXPLAIN_GUEST_IP_DAILY_LIMIT > 0:
            guest_ip_quota_reserved = self.ai_repository.reserve_daily_usage(
                subject_type="guest_ip",
                subject_id=request_ip,
                daily_limit=settings.AI_EXPLAIN_GUEST_IP_DAILY_LIMIT,
            )
            if not guest_ip_quota_reserved:
                billing = self.billing_payload(
                    billing_user_id,
                    usage_subject_type=subject_type,
                    usage_subject_id=subject_id,
                )
                json_response(
                    self,
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
            result = self.ai_explain_service.explain(
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
                self.ai_repository.release_daily_usage(
                    subject_type="guest_ip",
                    subject_id=request_ip,
                )
            json_response(
                self,
                400,
                {"ok": False, "code": "INVALID_SENTENCE", "error": str(exc)},
            )
            return
        except AIExplainLimitError as exc:
            if guest_ip_quota_reserved:
                self.ai_repository.release_daily_usage(
                    subject_type="guest_ip",
                    subject_id=request_ip,
                )
            billing = self.billing_payload(
                billing_user_id,
                usage_subject_type=subject_type,
                usage_subject_id=subject_id,
            )
            json_response(
                self,
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
                self.ai_repository.release_daily_usage(
                    subject_type="guest_ip",
                    subject_id=request_ip,
                )
            json_response(
                self,
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
                self.ai_repository.release_daily_usage(
                    subject_type="guest_ip",
                    subject_id=request_ip,
                )
            json_response(
                self,
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
                self.ai_repository.release_daily_usage(
                    subject_type="guest_ip",
                    subject_id=request_ip,
                )
            json_response(
                self,
                503,
                {
                    "ok": False,
                    "code": "AI_PROVIDER_ERROR",
                    "error": str(exc),
                    "billing": billing,
                },
            )
            return
        billing = self.billing_payload(
            billing_user_id,
            usage_subject_type=subject_type,
            usage_subject_id=subject_id,
        )
        self.event_repository.track(
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
            self.event_repository.track(
                "ai_explain_cache_hit",
                user_id=billing_user_id,
                book_id=str(payload.get("bookId", "") or "").strip(),
                chapter_id=str(payload.get("chapterId", "") or "").strip(),
            )
        json_response(self, 200, {"ok": True, "billing": billing, **result})

    def handle_sync_pull(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        user_id = sanitize_user_id(query.get("userId", ["default"])[0])
        billing = self.gate_plan_access(user_id=user_id, feature="sync_pull")
        if billing is None:
            self.track_sync_event(user_id=user_id, direction="pull", success=False, error="entitlement")
            return
        payload = self.sync_repository.pull(user_id) or {"updatedAt": 0, "snapshot": {}}
        self.track_sync_event(user_id=user_id, direction="pull", success=True)
        json_response(self, 200, {"ok": True, "data": payload})

    def handle_sync_push(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        user_id = sanitize_user_id(str(payload.get("userId", "default")))
        billing = self.gate_plan_access(user_id=user_id, feature="sync_push", payload=payload)
        if billing is None:
            self.track_sync_event(user_id=user_id, direction="push", success=False, error="entitlement")
            return
        snapshot = payload.get("snapshot", {})
        if not isinstance(snapshot, dict):
            self.track_sync_event(user_id=user_id, direction="push", success=False, error="invalid_snapshot")
            json_response(self, 400, {"ok": False, "error": "Invalid snapshot payload"})
            return
        data = {"updatedAt": int(time.time() * 1000), "snapshot": snapshot}
        self.sync_repository.push(user_id, data)
        self.track_sync_event(user_id=user_id, direction="push", success=True)
        json_response(self, 200, {"ok": True, "data": data})

    def handle_set_billing_plan(self) -> None:
        if not BILLING_ALLOW_MANUAL_PLAN_CHANGE:
            json_response(
                self,
                403,
                {
                    "ok": False,
                    "code": "MANUAL_PLAN_CHANGE_DISABLED",
                    "error": "手动套餐切换已禁用。",
                },
            )
            return
        if not BILLING_ADMIN_TOKEN:
            json_response(
                self,
                403,
                {
                    "ok": False,
                    "code": "ADMIN_TOKEN_REQUIRED",
                    "error": "请先配置 BILLING_ADMIN_TOKEN。",
                },
            )
            return
        provided = str(self.headers.get("X-Admin-Token", "") or "").strip()
        if provided != BILLING_ADMIN_TOKEN:
            json_response(
                self,
                403,
                {
                    "ok": False,
                    "code": "INVALID_ADMIN_TOKEN",
                    "error": "管理员令牌无效。",
                },
            )
            return
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        user_id = sanitize_user_id(str(payload.get("userId", "default")))
        plan = normalize_plan(str(payload.get("plan", FREE_PLAN)))
        status = normalize_plan_status(
            str(payload.get("status", "active" if plan == PRO_PLAN else "inactive"))
        )
        self.billing_store.set_plan(
            user_id,
            plan,
            source="manual",
            plan_status=status,
            billing_state="active" if status == "active" else "inactive",
        )
        json_response(self, 200, {"ok": True, "billing": self.billing_payload(user_id)})

    def read_raw_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def read_json_or_form_body(self) -> dict | None:
        raw = self.read_raw_body()
        return self._parse_json_or_form_raw(raw, self.headers.get("Content-Type", ""))

    def read_json_body(self) -> dict | None:
        raw = self.read_raw_body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None


def sanitize_user_id(user_id: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", user_id).strip("._")
    return cleaned or "default"


def run_server(host: str, port: int) -> None:
    ensure_dirs()
    handler_cls = lambda *args, **kwargs: ApiHandler(*args, directory=str(PROJECT_ROOT), **kwargs)
    with ThreadingHTTPServer((host, port), handler_cls) as server:
        print(f"YomuYomu server running at http://{host}:{port}")
        print(f"Tokenizer backend: {ApiHandler.tokenizer.backend}")
        print(f"JMDict DB: {DB_PATH} ({'found' if DB_PATH.exists() else 'not found'})")
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
            f"notify={'on' if bool(stripe_runtime_enabled() and STRIPE_WEBHOOK_SECRET) else 'off'})"
        )
        if requests is None or not crypto_runtime_ready() or AESGCM is None:
            print("Official gateway deps: missing requests/cryptography, fallback mode only")
        print(f"Pro price: {PRO_PRICE_FEN} fen / {PRO_PLAN_DAYS} days")
        print(f"Order expire: {ORDER_EXPIRE_MINUTES} minutes")
        print(
            "Payment confirm: "
            f"{'token-protected' if BILLING_NOTIFY_TOKEN else ('manual-enabled' if BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM else 'disabled')}"
        )
        print(f"Manual plan change: {'enabled' if BILLING_ALLOW_MANUAL_PLAN_CHANGE else 'disabled'}")
        server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run YomuYomu backend server.")
    default_host = os.getenv("HOST", "0.0.0.0").strip() or "0.0.0.0"
    try:
        default_port = int(os.getenv("PORT", "8000"))
    except ValueError:
        default_port = 8000
    parser.add_argument("--host", default=default_host)
    parser.add_argument("--port", type=int, default=default_port)
    args = parser.parse_args()
    run_server(args.host, args.port)


if __name__ == "__main__":
    main()
