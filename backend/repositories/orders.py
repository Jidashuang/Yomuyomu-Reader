from __future__ import annotations

import json
import secrets
import threading
import time
from pathlib import Path

from backend.config import (
    ORDER_EXPIRE_MINUTES,
    PRO_PLAN,
    PRO_PRICE_FEN,
    normalize_pay_channel,
    normalize_plan,
    sanitize_user_id,
)


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
            status_changed = False
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
                status_changed = True
            order["statusChanged"] = status_changed
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
