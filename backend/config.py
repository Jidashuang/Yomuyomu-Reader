from __future__ import annotations

import os
import posixpath
import re
from pathlib import Path
from urllib.parse import urlparse


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
IMPORT_JOBS_DIR = DATA_DIR / "import_jobs"
BACKUP_DIR = DATA_DIR / "backups"
DB_PATH = DATA_DIR / "jmdict.db"
BILLING_PATH = DATA_DIR / "billing.json"
ORDER_PATH = DATA_DIR / "billing_orders.json"
APP_DB_PATH = DATA_DIR / "app.db"
AI_CACHE_PATH = DATA_DIR / "ai_explain_cache.json"
AI_STATS_PATH = DATA_DIR / "ai_explain_stats.json"
JLPT_LEVELS_PATH = DATA_DIR / "jlpt_levels.json"
JLPT_LEVELS_EXAMPLE_PATH = DATA_DIR / "jlpt_levels.json.example"

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
        "aiExplainDailyLimit": int(os.getenv("FREE_AI_EXPLAIN_DAILY_LIMIT", "20") or 20),
    },
    PRO_PLAN: {
        "advancedImport": True,
        "cloudSync": True,
        "csvExportMaxRows": 100000,
        "aiExplainDailyLimit": int(os.getenv("PRO_AI_EXPLAIN_DAILY_LIMIT", "500") or 500),
    },
}

APP_BASE_URL = os.getenv("APP_BASE_URL", "").strip()
BILLING_ALLOW_MANUAL_PLAN_CHANGE = os.getenv("BILLING_ALLOW_MANUAL_PLAN_CHANGE", "0").strip() == "1"
BILLING_ADMIN_TOKEN = os.getenv("BILLING_ADMIN_TOKEN", "").strip()
WECHAT_PAY_ENABLED = os.getenv("WECHAT_PAY_ENABLED", "0").strip() == "1"
ALIPAY_PAY_ENABLED = os.getenv("ALIPAY_PAY_ENABLED", "0").strip() == "1"
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
BILLING_GRACE_PERIOD_DAYS = max(1, int(os.getenv("BILLING_GRACE_PERIOD_DAYS", "3") or 3))

AI_EXPLAIN_ENABLED = os.getenv("AI_EXPLAIN_ENABLED", "0").strip() == "1"
AI_EXPLAIN_PROVIDER = os.getenv("AI_EXPLAIN_PROVIDER", "openai").strip().lower() or "openai"
AI_EXPLAIN_API_KEY = os.getenv("AI_EXPLAIN_API_KEY", os.getenv("OPENAI_API_KEY", "")).strip()
AI_EXPLAIN_MODEL = os.getenv("AI_EXPLAIN_MODEL", os.getenv("OPENAI_MODEL", "gpt-4o-mini")).strip()
AI_EXPLAIN_BASE_URL = os.getenv(
    "AI_EXPLAIN_BASE_URL",
    os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
).strip()
AI_EXPLAIN_TIMEOUT_SECONDS = max(3, int(os.getenv("AI_EXPLAIN_TIMEOUT_SECONDS", "20") or 20))
AI_EXPLAIN_CACHE_TTL_SECONDS = max(
    60, int(os.getenv("AI_EXPLAIN_CACHE_TTL_SECONDS", str(30 * 24 * 60 * 60)) or 60)
)
AI_EXPLAIN_MAX_CHARS = max(20, int(os.getenv("AI_EXPLAIN_MAX_CHARS", "220") or 220))
AI_EXPLAIN_ANON_DAILY_LIMIT = max(
    1,
    int(
        os.getenv(
            "ANON_AI_EXPLAIN_DAILY_LIMIT",
            "3",
        )
        or 1
    ),
)
AI_EXPLAIN_GUEST_IP_DAILY_LIMIT = max(
    1,
    int(
        os.getenv(
            "AI_EXPLAIN_GUEST_IP_DAILY_LIMIT",
            "20",
        )
        or 1
    ),
)
AI_EXPLAIN_RATE_LIMIT_WINDOW_SECONDS = max(
    10, int(os.getenv("AI_EXPLAIN_RATE_LIMIT_WINDOW_SECONDS", "60") or 60)
)
AI_EXPLAIN_RATE_LIMIT_MAX_PER_USER = max(
    1, int(os.getenv("AI_EXPLAIN_RATE_LIMIT_MAX_PER_USER", "12") or 12)
)
AI_EXPLAIN_RATE_LIMIT_MAX_PER_IP = max(
    1, int(os.getenv("AI_EXPLAIN_RATE_LIMIT_MAX_PER_IP", "24") or 24)
)
AI_EXPLAIN_SINGLEFLIGHT_WAIT_SECONDS = max(
    1,
    int(
        os.getenv(
            "AI_EXPLAIN_SINGLEFLIGHT_WAIT_SECONDS",
            str(AI_EXPLAIN_TIMEOUT_SECONDS + 3),
        )
        or 1
    ),
)
AI_EXPLAIN_PROMPT_VERSION = str(os.getenv("AI_EXPLAIN_PROMPT_VERSION", "v2") or "v2").strip()
ANONYMOUS_ID_COOKIE_NAME = str(
    os.getenv(
        "ANONYMOUS_ID_COOKIE_NAME",
        "anonymous_id",
    )
    or "anonymous_id"
).strip() or "anonymous_id"
ANONYMOUS_ID_COOKIE_MAX_AGE_SECONDS = max(
    3600,
    int(
        os.getenv(
            "ANONYMOUS_ID_COOKIE_MAX_AGE_SECONDS",
            str(365 * 24 * 60 * 60),
        )
        or 3600
    ),
)
ANALYSIS_VERSION = str(os.getenv("ANALYSIS_VERSION", "v2") or "v2").strip()
TOKENIZER_VERSION = str(os.getenv("TOKENIZER_VERSION", "sudachi-split-c-v1") or "sudachi-split-c-v1").strip()
JLPT_VERSION = str(os.getenv("JLPT_VERSION", "local-jlpt-v1") or "local-jlpt-v1").strip()
DICT_VERSION = str(os.getenv("DICT_VERSION", "jmdict-local-v1") or "jmdict-local-v1").strip()
DEFAULT_SAMPLE_BOOK_SLUG = "starter-sample"
IMPORT_ALLOWED_TYPES = {"txt", "epub", "pdf", "mobi"}
IMPORT_MAX_FILE_BYTES = max(
    1024, int(os.getenv("IMPORT_MAX_FILE_BYTES", str(15 * 1024 * 1024)) or 1024)
)
IMPORT_PARSE_TIMEOUT_SECONDS = max(
    5, int(os.getenv("IMPORT_PARSE_TIMEOUT_SECONDS", "30") or 30)
)
IMPORT_RATE_LIMIT_WINDOW_SECONDS = max(
    10, int(os.getenv("IMPORT_RATE_LIMIT_WINDOW_SECONDS", "3600") or 3600)
)
IMPORT_RATE_LIMIT_MAX_PER_USER = max(
    1, int(os.getenv("IMPORT_RATE_LIMIT_MAX_PER_USER", "8") or 8)
)
IMPORT_RATE_LIMIT_MAX_PER_IP = max(
    1, int(os.getenv("IMPORT_RATE_LIMIT_MAX_PER_IP", "12") or 12)
)
BACKUP_RETENTION_DAYS = max(1, int(os.getenv("BACKUP_RETENTION_DAYS", "14") or 14))

WORD_NOISE_RE = re.compile(
    r"""^[\s「」『』【】［］（）()〈〉《》〔〕｛｝{}'"“”‘’、。・，．！？!?：:；;]+|"""
    r"""[\s「」『』【】［］（）()〈〉《》〔〕｛｝{}'"“”‘’、。・，．！？!?：:；;]+$"""
)


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CLOUD_DIR.mkdir(parents=True, exist_ok=True)
    IMPORT_JOBS_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def safe_decode(raw: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "shift_jis", "cp932", "euc_jp"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def sanitize_user_id(user_id: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", str(user_id or "")).strip("._")
    return cleaned or "default"


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


def payment_enabled() -> bool:
    return bool(STRIPE_PAY_ENABLED or WECHAT_PAY_ENABLED or ALIPAY_PAY_ENABLED)


def stripe_payment_link_enabled() -> bool:
    if not payment_enabled():
        return False
    return bool(STRIPE_PAY_ENABLED and is_abs_http_url(STRIPE_PAYMENT_LINK_MONTHLY))


def wechat_runtime_enabled() -> bool:
    if not payment_enabled():
        return False
    return bool(
        WECHAT_PAY_ENABLED
        and (
            WECHAT_PAY_ENTRY_URL
            or (
                WECHAT_APP_ID
                and WECHAT_MCH_ID
                and WECHAT_MCH_SERIAL
                and (WECHAT_MCH_PRIVATE_KEY or WECHAT_MCH_PRIVATE_KEY_PATH)
            )
        )
    )


def alipay_runtime_enabled() -> bool:
    if not payment_enabled():
        return False
    return bool(
        ALIPAY_PAY_ENABLED
        and (
            ALIPAY_PAY_ENTRY_URL
            or (
                ALIPAY_APP_ID
                and ALIPAY_GATEWAY
                and (ALIPAY_PRIVATE_KEY or ALIPAY_PRIVATE_KEY_PATH)
            )
        )
    )


def payment_channels() -> dict[str, bool]:
    return {
        PAY_CHANNEL_WECHAT: wechat_runtime_enabled(),
        PAY_CHANNEL_ALIPAY: alipay_runtime_enabled(),
        PAY_CHANNEL_STRIPE: bool(stripe_payment_link_enabled() or stripe_runtime_enabled()),
    }


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


def stripe_runtime_enabled() -> bool:
    if not payment_enabled():
        return False
    try:
        import requests  # type: ignore
    except Exception:
        return False
    return bool(STRIPE_PAY_ENABLED and requests is not None and STRIPE_SECRET_KEY)


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


def normalize_archive_path(base_path: str, href: str) -> str:
    joined = posixpath.normpath(posixpath.join(base_path, href))
    return joined.lstrip("/")
