from __future__ import annotations

import json
import threading
from pathlib import Path

from backend.config import (
    PLAN_FEATURES,
    normalize_optional_pay_channel,
    normalize_pay_channel,
    normalize_plan,
    normalize_plan_status,
    normalize_subscription_status,
    sanitize_user_id,
)
from backend.repositories.app_db import AppDatabase, now_ms


def normalize_billing_cycle(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"monthly", "month"}:
        return "monthly"
    if raw in {"yearly", "year", "annual"}:
        return "yearly"
    return ""


class BillingStore:
    def __init__(self, db_path: Path, legacy_path: Path | None = None) -> None:
        self.db = AppDatabase(db_path)
        self.legacy_path = legacy_path
        self._lock = threading.Lock()
        self._legacy_migrated = False

    def _migrate_legacy_if_needed(self) -> None:
        if self._legacy_migrated:
            return
        with self._lock:
            if self._legacy_migrated:
                return
            if not self.legacy_path or not self.legacy_path.exists():
                self._legacy_migrated = True
                return
            try:
                payload = json.loads(self.legacy_path.read_text(encoding="utf-8"))
            except Exception:
                self._legacy_migrated = True
                return
            users = payload.get("users")
            if not isinstance(users, dict):
                self._legacy_migrated = True
                return
            with self.db.transaction(immediate=True) as conn:
                existing_count = conn.execute("SELECT COUNT(*) AS count FROM plans").fetchone()["count"]
                if existing_count:
                    self._legacy_migrated = True
                    return
                for raw_user_id, raw_record in users.items():
                    user_key = sanitize_user_id(raw_user_id)
                    record = self._normalize_record(
                        user_key,
                        raw_record if isinstance(raw_record, dict) else {},
                    )
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO plans (
                          user_id,
                          plan_name,
                          plan,
                          plan_status,
                          updated_at,
                          source,
                          last_paid_channel,
                          last_order_id,
                          plan_expire_at,
                          subscription_status,
                          stripe_customer_id,
                          stripe_subscription_id,
                          billing_cycle
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            user_key,
                            record["planName"],
                            record["plan"],
                            record["planStatus"],
                            record["updatedAt"],
                            record["source"],
                            record["lastPaidChannel"],
                            record["lastOrderId"],
                            record["planExpireAt"],
                            record["subscriptionStatus"],
                            record["stripeCustomerId"],
                            record["stripeSubscriptionId"],
                            record["billingCycle"],
                        ),
                    )
            self._legacy_migrated = True

    @staticmethod
    def _normalize_record(user_key: str, raw: dict | None) -> dict:
        source = raw if isinstance(raw, dict) else {}
        normalized_plan = normalize_plan(source.get("planName", source.get("plan")))
        return {
            "userId": user_key,
            "planName": normalized_plan,
            "plan": normalized_plan,
            "planStatus": normalize_plan_status(
                source.get("planStatus", "active" if normalized_plan == "pro" else "inactive")
            ),
            "updatedAt": int(source.get("updatedAt", 0) or 0),
            "source": str(source.get("source", "manual") or "manual"),
            "lastPaidChannel": normalize_optional_pay_channel(source.get("lastPaidChannel")),
            "lastOrderId": str(source.get("lastOrderId", "") or "").strip(),
            "planExpireAt": int(source.get("planExpireAt", 0) or 0),
            "subscriptionStatus": normalize_subscription_status(source.get("subscriptionStatus")),
            "stripeCustomerId": str(source.get("stripeCustomerId", "") or "").strip(),
            "stripeSubscriptionId": str(source.get("stripeSubscriptionId", "") or "").strip(),
            "billingCycle": normalize_billing_cycle(source.get("billingCycle")),
            "graceUntilAt": int(source.get("graceUntilAt", 0) or 0),
            "paymentFailedAt": int(source.get("paymentFailedAt", 0) or 0),
            "billingState": str(source.get("billingState", "") or "").strip().lower(),
        }

    def get_billing(self, user_id: str) -> dict:
        self._migrate_legacy_if_needed()
        user_key = sanitize_user_id(user_id)
        conn = self.db.connect()
        try:
            row = conn.execute(
                """
                SELECT
                  user_id,
                  plan_name,
                  plan,
                  plan_status,
                  updated_at,
                  source,
                  last_paid_channel,
                  last_order_id,
                  plan_expire_at,
                  subscription_status,
                  stripe_customer_id,
                  stripe_subscription_id,
                  billing_cycle,
                  grace_until_at,
                  payment_failed_at,
                  billing_state
                FROM plans
                WHERE user_id = ?
                """,
                (user_key,),
            ).fetchone()
        finally:
            conn.close()
        record = self._normalize_record(
            user_key,
            {
                "plan": row["plan"],
                "planName": row["plan_name"],
                "planStatus": row["plan_status"],
                "updatedAt": row["updated_at"],
                "source": row["source"],
                "lastPaidChannel": row["last_paid_channel"],
                "lastOrderId": row["last_order_id"],
                "planExpireAt": row["plan_expire_at"],
                "subscriptionStatus": row["subscription_status"],
                "stripeCustomerId": row["stripe_customer_id"],
                "stripeSubscriptionId": row["stripe_subscription_id"],
                "billingCycle": row["billing_cycle"],
                "graceUntilAt": row["grace_until_at"],
                "paymentFailedAt": row["payment_failed_at"],
                "billingState": row["billing_state"],
            }
            if row
            else {},
        )
        plan, access_state = self._effective_plan(record)
        return {
            "userId": user_key,
            "plan": plan,
            "planName": record["planName"],
            "planStatus": record["planStatus"],
            "entitlementPlan": record["planName"],
            "features": dict(PLAN_FEATURES[plan]),
            "updatedAt": record["updatedAt"],
            "source": record["source"],
            "lastPaidChannel": record["lastPaidChannel"],
            "lastOrderId": record["lastOrderId"],
            "planExpireAt": record["planExpireAt"],
            "subscriptionStatus": record["subscriptionStatus"],
            "stripeCustomerId": record["stripeCustomerId"],
            "stripeSubscriptionId": record["stripeSubscriptionId"],
            "billingCycle": record["billingCycle"],
            "graceUntilAt": record["graceUntilAt"],
            "paymentFailedAt": record["paymentFailedAt"],
            "billingState": record["billingState"],
            "accessState": access_state,
        }

    @staticmethod
    def _effective_plan(record: dict) -> tuple[str, str]:
        entitlement_plan = normalize_plan(record.get("planName", record.get("plan")))
        plan_status = normalize_plan_status(record.get("planStatus", "inactive"))
        now = now_ms()
        plan_expire_at = int(record.get("planExpireAt", 0) or 0)
        grace_until_at = int(record.get("graceUntilAt", 0) or 0)
        billing_state = str(record.get("billingState", "") or "").strip().lower()
        subscription_status = normalize_subscription_status(record.get("subscriptionStatus"))
        if entitlement_plan != "pro":
            return entitlement_plan, "free"
        if plan_status != "active":
            return "free", "inactive"
        if plan_expire_at > now:
            if billing_state == "grace" or subscription_status in {"past_due", "unpaid", "incomplete"}:
                return "pro", "grace"
            return "pro", "active"
        if grace_until_at > now:
            return "pro", "grace"
        return "free", "downgraded"

    def set_plan(
        self,
        user_id: str,
        plan: str,
        source: str = "manual",
        *,
        last_paid_channel: str = "",
        last_order_id: str = "",
        plan_status: str | None = None,
        subscription_status: str | None = None,
        plan_expire_at: int | None = None,
        stripe_customer_id: str = "",
        stripe_subscription_id: str = "",
        billing_cycle: str | None = None,
        grace_until_at: int | None = None,
        payment_failed_at: int | None = None,
        billing_state: str | None = None,
    ) -> dict:
        self._migrate_legacy_if_needed()
        user_key = sanitize_user_id(user_id)
        now = now_ms()
        current = self.get_billing(user_key)
        normalized_plan = normalize_plan(plan)
        record = {
            "planName": normalized_plan,
            "plan": normalized_plan,
            "planStatus": current.get("planStatus", "inactive"),
            "updatedAt": now,
            "source": str(source or "manual"),
            "lastPaidChannel": current["lastPaidChannel"],
            "lastOrderId": current["lastOrderId"],
            "planExpireAt": current["planExpireAt"],
            "subscriptionStatus": current["subscriptionStatus"],
            "stripeCustomerId": current["stripeCustomerId"],
            "stripeSubscriptionId": current["stripeSubscriptionId"],
            "billingCycle": current.get("billingCycle", ""),
            "graceUntilAt": current.get("graceUntilAt", 0),
            "paymentFailedAt": current.get("paymentFailedAt", 0),
            "billingState": current.get("billingState", ""),
        }
        if plan_status is not None:
            record["planStatus"] = normalize_plan_status(plan_status)
        else:
            record["planStatus"] = "active" if normalized_plan == "pro" else "inactive"
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
        if billing_cycle is not None:
            record["billingCycle"] = normalize_billing_cycle(billing_cycle)
        if grace_until_at is not None:
            record["graceUntilAt"] = max(0, int(grace_until_at or 0))
        if payment_failed_at is not None:
            record["paymentFailedAt"] = max(0, int(payment_failed_at or 0))
        if billing_state is not None:
            record["billingState"] = str(billing_state or "").strip().lower()

        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                INSERT INTO plans (
                  user_id,
                  plan_name,
                  plan,
                  plan_status,
                  updated_at,
                  source,
                  last_paid_channel,
                  last_order_id,
                  plan_expire_at,
                  subscription_status,
                  stripe_customer_id,
                  stripe_subscription_id,
                  billing_cycle,
                  grace_until_at,
                  payment_failed_at,
                  billing_state
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                  plan_name = excluded.plan_name,
                  plan = excluded.plan,
                  plan_status = excluded.plan_status,
                  updated_at = excluded.updated_at,
                  source = excluded.source,
                  last_paid_channel = excluded.last_paid_channel,
                  last_order_id = excluded.last_order_id,
                  plan_expire_at = excluded.plan_expire_at,
                  subscription_status = excluded.subscription_status,
                  stripe_customer_id = excluded.stripe_customer_id,
                  stripe_subscription_id = excluded.stripe_subscription_id,
                  billing_cycle = excluded.billing_cycle,
                  grace_until_at = excluded.grace_until_at,
                  payment_failed_at = excluded.payment_failed_at,
                  billing_state = excluded.billing_state
                """,
                (
                    user_key,
                    record["planName"],
                    record["plan"],
                    record["planStatus"],
                    record["updatedAt"],
                    record["source"],
                    record["lastPaidChannel"],
                    record["lastOrderId"],
                    record["planExpireAt"],
                    record["subscriptionStatus"],
                    record["stripeCustomerId"],
                    record["stripeSubscriptionId"],
                    record["billingCycle"],
                    record["graceUntilAt"],
                    record["paymentFailedAt"],
                    record["billingState"],
                ),
            )
        return self.get_billing(user_key)

    def delete_billing(self, user_id: str) -> None:
        user_key = sanitize_user_id(user_id)
        with self.db.transaction(immediate=True) as conn:
            conn.execute("DELETE FROM plans WHERE user_id = ?", (user_key,))

    def find_user_by_stripe_customer_id(self, customer_id: str) -> str:
        self._migrate_legacy_if_needed()
        target = str(customer_id or "").strip()
        if not target:
            return ""
        conn = self.db.connect()
        try:
            row = conn.execute(
                "SELECT user_id FROM plans WHERE stripe_customer_id = ? LIMIT 1",
                (target,),
            ).fetchone()
        finally:
            conn.close()
        return str(row["user_id"]) if row else ""
