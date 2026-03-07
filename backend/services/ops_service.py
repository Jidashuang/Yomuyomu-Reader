from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from backend.repositories.events import EventRepository


OPS_EVENT_NAMES = [
    "sample_opened",
    "word_clicked",
    "ai_explain_requested",
    "book_imported",
    "book_import_failed",
    "import_job_requeued",
    "sync_succeeded",
    "sync_failed",
    "upgrade_clicked",
    "payment_paid",
    "ai_explain_cache_hit",
]


@dataclass(slots=True)
class OpsService:
    events: EventRepository

    def daily_metrics(self, *, days: int = 14) -> list[dict]:
        safe_days = max(1, min(int(days or 14), 90))
        today = datetime.now().date()
        start_day = today - timedelta(days=safe_days - 1)
        since = datetime.combine(start_day, datetime.min.time())
        until = datetime.combine(today + timedelta(days=1), datetime.min.time())
        counts = self.events.daily_counts(
            since_ms=int(since.timestamp() * 1000),
            until_ms=int(until.timestamp() * 1000),
            event_names=OPS_EVENT_NAMES,
        )
        day_buckets: dict[str, dict[str, int]] = {}
        for item in counts:
            bucket = day_buckets.setdefault(str(item["day"]), {})
            bucket[str(item["eventName"])] = int(item["count"] or 0)
        rows: list[dict] = []
        for offset in range(safe_days):
            day = start_day + timedelta(days=offset)
            key = day.isoformat()
            bucket = day_buckets.get(key, {})
            explain_requests = int(bucket.get("ai_explain_requested", 0))
            import_successes = int(bucket.get("book_imported", 0))
            import_failures = int(bucket.get("book_import_failed", 0))
            sync_successes = int(bucket.get("sync_succeeded", 0))
            sync_failures = int(bucket.get("sync_failed", 0))
            cache_hits = int(bucket.get("ai_explain_cache_hit", 0))
            rows.append(
                {
                    "day": key,
                    "sampleOpens": int(bucket.get("sample_opened", 0)),
                    "wordClicks": int(bucket.get("word_clicked", 0)),
                    "explainRequests": explain_requests,
                    "cacheHitRate": round((cache_hits / explain_requests) if explain_requests else 0.0, 4),
                    "importSuccessRate": round(
                        (import_successes / (import_successes + import_failures))
                        if (import_successes + import_failures)
                        else 0.0,
                        4,
                    ),
                    "jobRequeues": int(bucket.get("import_job_requeued", 0)),
                    "syncFailureRate": round(
                        (sync_failures / (sync_successes + sync_failures))
                        if (sync_successes + sync_failures)
                        else 0.0,
                        4,
                    ),
                    "upgradeClicks": int(bucket.get("upgrade_clicked", 0)),
                    "paidSuccesses": int(bucket.get("payment_paid", 0)),
                }
            )
        return rows
