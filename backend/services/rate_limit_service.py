from __future__ import annotations

import threading
import time
from collections import deque


class RateLimitService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buckets: dict[str, deque[float]] = {}

    def check(self, *, key: str, limit: int, window_seconds: int) -> tuple[bool, int]:
        if limit <= 0 or window_seconds <= 0:
            return True, 0
        now = time.time()
        cutoff = now - window_seconds
        with self._lock:
            bucket = self._buckets.setdefault(str(key or ""), deque())
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= limit:
                retry_after = max(1, int(bucket[0] + window_seconds - now))
                return False, retry_after
            bucket.append(now)
        return True, 0
