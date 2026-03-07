from __future__ import annotations

import hashlib
import json
import re
import threading
from datetime import datetime, timezone

try:
    import requests
except Exception:  # pragma: no cover - optional dependency
    requests = None

from backend.config import (
    AI_EXPLAIN_API_KEY,
    AI_EXPLAIN_ANON_DAILY_LIMIT,
    AI_EXPLAIN_BASE_URL,
    AI_EXPLAIN_CACHE_TTL_SECONDS,
    AI_EXPLAIN_ENABLED,
    AI_EXPLAIN_MAX_CHARS,
    AI_EXPLAIN_MODEL,
    AI_EXPLAIN_PROMPT_VERSION,
    AI_EXPLAIN_PROVIDER,
    AI_EXPLAIN_SINGLEFLIGHT_WAIT_SECONDS,
    AI_EXPLAIN_TIMEOUT_SECONDS,
    FREE_PLAN,
    PLAN_FEATURES,
)
from backend.repositories.ai import AIExplainRepository


class AIExplainLimitError(RuntimeError):
    pass


ALLOWED_DIFFICULTIES = {"N1", "N2", "N3", "N4", "N5"}
MAX_CONTEXT_CHARS = 160


class _InflightExplain:
    def __init__(self) -> None:
        self.event = threading.Event()
        self.result: dict | None = None
        self.error: Exception | None = None


class AIExplainService:
    def __init__(self, repository: AIExplainRepository) -> None:
        self.repository = repository
        self._inflight_lock = threading.Lock()
        self._inflight: dict[str, _InflightExplain] = {}

    @staticmethod
    def _normalize_sentence(sentence: str) -> str:
        return re.sub(r"\s+", " ", str(sentence or "").strip())

    @staticmethod
    def _normalize_context(context) -> str:  # noqa: ANN001
        if context is None:
            return ""
        if isinstance(context, str):
            normalized = re.sub(r"\s+", " ", context).strip()
            return normalized[:MAX_CONTEXT_CHARS]
        try:
            normalized = json.dumps(context, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except Exception:
            normalized = re.sub(r"\s+", " ", str(context)).strip()
        return normalized[:MAX_CONTEXT_CHARS]

    def validate_sentence(self, sentence: str) -> str:
        normalized = self._normalize_sentence(sentence)
        if not normalized:
            raise ValueError("缺少 sentence。")
        if "\n" in str(sentence or ""):
            raise ValueError("只支持单句解释，请不要传入多行内容。")
        if len(normalized) > AI_EXPLAIN_MAX_CHARS:
            raise ValueError(f"句子过长，只支持 {AI_EXPLAIN_MAX_CHARS} 字以内的单句解释。")
        if normalized.count("。") + normalized.count("！") + normalized.count("？") > 2:
            raise ValueError("只支持句子级解释，请不要传入整段内容。")
        return normalized

    @staticmethod
    def _sha256(value: str) -> str:
        return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()

    def _cache_metadata(
        self,
        *,
        sentence: str,
        context: str,
        mode: str,
        model: str,
        prompt_version: str,
    ) -> dict:
        sentence_hash = self._sha256(sentence)
        context_hash = self._sha256(context)
        cache_key = self._sha256(
            "|".join(
                [
                    sentence_hash,
                    context_hash,
                    str(mode or "").strip(),
                    str(model or "").strip(),
                    str(prompt_version or "").strip(),
                ]
            )
        )
        return {
            "cacheKey": cache_key,
            "sentenceHash": sentence_hash,
            "contextHash": context_hash,
            "mode": str(mode or "reader").strip() or "reader",
            "model": str(model or AI_EXPLAIN_MODEL).strip() or AI_EXPLAIN_MODEL,
            "promptVersion": str(prompt_version or AI_EXPLAIN_PROMPT_VERSION).strip()
            or AI_EXPLAIN_PROMPT_VERSION,
        }

    @staticmethod
    def _start_of_today_ms() -> int:
        now = datetime.now(timezone.utc)
        start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        return int(start.timestamp() * 1000)

    @staticmethod
    def _daily_limit(plan: str, *, is_anonymous: bool) -> int:
        if is_anonymous:
            return AI_EXPLAIN_ANON_DAILY_LIMIT
        if plan != FREE_PLAN:
            return -1
        return int(PLAN_FEATURES[FREE_PLAN].get("aiExplainDailyLimit", 0) or 0)

    def daily_usage_stats(self, *, user_id: str, plan: str, is_anonymous: bool = False) -> dict:
        limit = self._daily_limit(plan, is_anonymous=is_anonymous)
        usage = self.repository.count_usage_since(
            user_id=user_id,
            since_ms=self._start_of_today_ms(),
        )
        uncached_ok = int(usage.get("uncachedOk", 0) or 0)
        remaining = -1 if limit < 0 else max(0, limit - uncached_ok)
        return {
            "dailyLimit": limit,
            "usedToday": uncached_ok,
            "remainingToday": remaining,
            "cachedToday": int(usage.get("cachedTotal", 0) or 0),
            "limitedToday": int(usage.get("limitedTotal", 0) or 0),
        }

    def _claim_inflight(self, cache_key: str) -> tuple[_InflightExplain, bool]:
        with self._inflight_lock:
            if cache_key in self._inflight:
                return self._inflight[cache_key], False
            pending = _InflightExplain()
            self._inflight[cache_key] = pending
            return pending, True

    def _release_inflight(self, cache_key: str) -> None:
        with self._inflight_lock:
            self._inflight.pop(cache_key, None)

    def explain(
        self,
        *,
        user_id: str,
        plan: str,
        is_anonymous: bool = False,
        sentence: str,
        context=None,  # noqa: ANN001
        mode: str = "reader",
        model: str = "",
        prompt_version: str = "",
    ) -> dict:
        normalized_sentence = self.validate_sentence(sentence)
        normalized_context = self._normalize_context(context)
        meta = self._cache_metadata(
            sentence=normalized_sentence,
            context=normalized_context,
            mode=mode,
            model=model or AI_EXPLAIN_MODEL,
            prompt_version=prompt_version or AI_EXPLAIN_PROMPT_VERSION,
        )

        cached = self.repository.get_cached(meta["cacheKey"], AI_EXPLAIN_CACHE_TTL_SECONDS)
        if cached and isinstance(cached.get("response"), dict):
            self.repository.record_usage(
                user_id=user_id,
                cache_key=meta["cacheKey"],
                sentence_hash=meta["sentenceHash"],
                context_hash=meta["contextHash"],
                mode=meta["mode"],
                model=meta["model"],
                prompt_version=meta["promptVersion"],
                cached=True,
                status="ok",
                provider=str(cached.get("provider", "") or ""),
            )
            return {
                "sentence": normalized_sentence,
                "contextHash": meta["contextHash"],
                "cached": True,
                "provider": str(cached.get("provider", "") or ""),
                "model": meta["model"],
                "promptVersion": meta["promptVersion"],
                "result": cached["response"],
            }

        inflight, is_leader = self._claim_inflight(meta["cacheKey"])
        if not is_leader:
            if not inflight.event.wait(AI_EXPLAIN_SINGLEFLIGHT_WAIT_SECONDS):
                raise RuntimeError("同句 explain 正在处理中，请稍后重试。")
            if inflight.error is not None:
                raise inflight.error
            if inflight.result is None:
                raise RuntimeError("同句 explain 处理结果缺失。")
            self.repository.record_usage(
                user_id=user_id,
                cache_key=meta["cacheKey"],
                sentence_hash=meta["sentenceHash"],
                context_hash=meta["contextHash"],
                mode=meta["mode"],
                model=meta["model"],
                prompt_version=meta["promptVersion"],
                cached=True,
                status="ok",
                provider=str(inflight.result.get("provider", "") or ""),
            )
            return inflight.result

        reservation_token = ""
        try:
            daily_limit = self._daily_limit(plan, is_anonymous=is_anonymous)
            if daily_limit > 0:
                reservation_token = self.repository.reserve_uncached_usage(
                    user_id=user_id,
                    daily_limit=daily_limit,
                    since_ms=self._start_of_today_ms(),
                    cache_key=meta["cacheKey"],
                    sentence_hash=meta["sentenceHash"],
                    context_hash=meta["contextHash"],
                    mode=meta["mode"],
                    model=meta["model"],
                    prompt_version=meta["promptVersion"],
                )
            if daily_limit > 0 and not reservation_token:
                exc = AIExplainLimitError(
                    f"Free 用户今日 AI explain 次数已用完（{daily_limit}/{daily_limit}）。"
                )
                self.repository.record_usage(
                    user_id=user_id,
                    cache_key=meta["cacheKey"],
                    sentence_hash=meta["sentenceHash"],
                    context_hash=meta["contextHash"],
                    mode=meta["mode"],
                    model=meta["model"],
                    prompt_version=meta["promptVersion"],
                    cached=False,
                    status="limited",
                    provider=AI_EXPLAIN_PROVIDER,
                    error_message=str(exc),
                )
                raise exc
            try:
                structured, provider = self._provider_explain(
                    sentence=normalized_sentence,
                    context=normalized_context,
                    mode=meta["mode"],
                    model=meta["model"],
                )
            except Exception as exc:
                if reservation_token:
                    self.repository.finalize_reservation(
                        reservation_token=reservation_token,
                        provider=AI_EXPLAIN_PROVIDER,
                        status="error",
                        error_message=str(exc),
                    )
                else:
                    self.repository.record_usage(
                        user_id=user_id,
                        cache_key=meta["cacheKey"],
                        sentence_hash=meta["sentenceHash"],
                        context_hash=meta["contextHash"],
                        mode=meta["mode"],
                        model=meta["model"],
                        prompt_version=meta["promptVersion"],
                        cached=False,
                        status="error",
                        provider=AI_EXPLAIN_PROVIDER,
                        error_message=str(exc),
                    )
                raise

            self.repository.set_cached(
                cache_key=meta["cacheKey"],
                sentence_hash=meta["sentenceHash"],
                context_hash=meta["contextHash"],
                mode=meta["mode"],
                model=meta["model"],
                prompt_version=meta["promptVersion"],
                provider=provider,
                response=structured,
            )
            if reservation_token:
                self.repository.finalize_reservation(
                    reservation_token=reservation_token,
                    provider=provider,
                    status="ok",
                )
            else:
                self.repository.record_usage(
                    user_id=user_id,
                    cache_key=meta["cacheKey"],
                    sentence_hash=meta["sentenceHash"],
                    context_hash=meta["contextHash"],
                    mode=meta["mode"],
                    model=meta["model"],
                    prompt_version=meta["promptVersion"],
                    cached=False,
                    status="ok",
                    provider=provider,
                )
            payload = {
                "sentence": normalized_sentence,
                "contextHash": meta["contextHash"],
                "cached": False,
                "provider": provider,
                "model": meta["model"],
                "promptVersion": meta["promptVersion"],
                "result": structured,
            }
            inflight.result = payload
            return payload
        except Exception as exc:
            inflight.error = exc
            raise
        finally:
            inflight.event.set()
            self._release_inflight(meta["cacheKey"])

    @staticmethod
    def _normalize_structured(payload: dict) -> dict:
        grammar = payload.get("grammar") or []
        notes = payload.get("notes") or []
        if not isinstance(grammar, list):
            grammar = [str(grammar)]
        if not isinstance(notes, list):
            notes = [str(notes)]
        difficulty = str(payload.get("difficulty", "") or "N3").strip().upper() or "N3"
        if difficulty not in ALLOWED_DIFFICULTIES:
            difficulty = "N3"
        return {
            "translation": str(payload.get("translation", "") or "").strip(),
            "grammar": [str(item).strip() for item in grammar if str(item or "").strip()],
            "notes": [str(item).strip() for item in notes if str(item or "").strip()],
            "difficulty": difficulty,
        }

    def _validate_structured(self, payload: dict) -> dict:
        normalized = self._normalize_structured(payload)
        if not normalized["translation"]:
            raise RuntimeError("AI 服务返回了无效结构：translation 为空。")
        if normalized["difficulty"] not in ALLOWED_DIFFICULTIES:
            raise RuntimeError("AI 服务返回了无效结构：difficulty 不合法。")
        return normalized

    def _provider_explain(
        self,
        *,
        sentence: str,
        context: str,
        mode: str,
        model: str,
    ) -> tuple[dict, str]:
        if not AI_EXPLAIN_ENABLED:
            raise RuntimeError("AI explain is disabled.")
        if AI_EXPLAIN_PROVIDER == "openai" and requests is not None and AI_EXPLAIN_API_KEY:
            structured = self._openai_explain(sentence=sentence, context=context, mode=mode, model=model)
            return structured, "openai"
        return self._mock_explain(sentence), "builtin-mock"

    def _openai_explain(
        self,
        *,
        sentence: str,
        context: str,
        mode: str,
        model: str,
    ) -> dict:
        endpoint = f"{AI_EXPLAIN_BASE_URL.rstrip('/')}/chat/completions"
        prompt = (
            "你是日语阅读助手。严格返回 JSON 对象，字段固定为 "
            "translation(string)、grammar(array of strings)、notes(array of strings)、difficulty(string)。"
            "difficulty 只能返回 N5/N4/N3/N2/N1。"
            "translation 用简洁中文。grammar 和 notes 各给 1-3 条，避免冗长。"
            "只解释给定句子，若提供 context 仅用于消歧，不要复述上下文。"
        )
        user_content = {"sentence": sentence, "context": context, "mode": mode}
        payload = {
            "model": model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": json.dumps(user_content, ensure_ascii=False)},
            ],
        }
        response = requests.post(
            endpoint,
            headers={
                "Authorization": f"Bearer {AI_EXPLAIN_API_KEY}",
                "Content-Type": "application/json",
            },
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            timeout=AI_EXPLAIN_TIMEOUT_SECONDS,
        )
        try:
            raw = response.json()
        except Exception as exc:
            raise RuntimeError(f"AI 服务返回非 JSON：HTTP {response.status_code}") from exc
        if not response.ok:
            message = (
                raw.get("error", {}).get("message")
                or raw.get("message")
                or f"AI 服务调用失败：HTTP {response.status_code}"
            )
            raise RuntimeError(str(message))
        choices = raw.get("choices")
        if not isinstance(choices, list) or not choices:
            raise RuntimeError("AI 服务未返回解释内容。")
        message = choices[0].get("message", {})
        content = str(message.get("content", "") or "").strip()
        if not content:
            raise RuntimeError("AI 服务返回空解释。")
        parsed = self._parse_structured_response(content)
        return self._validate_structured(parsed)

    @staticmethod
    def _parse_structured_response(content: str) -> dict:
        raw = str(content or "").strip()
        for candidate in (raw, raw.strip("`"), raw.replace("```json", "").replace("```", "").strip()):
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                continue
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(raw[start : end + 1])
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
        raise RuntimeError("AI 服务返回了非结构化内容。")

    @staticmethod
    def _mock_explain(sentence: str) -> dict:
        difficulty = "N3"
        kanji_count = sum(1 for ch in sentence if "\u4e00" <= ch <= "\u9fff")
        if kanji_count >= 7:
            difficulty = "N2"
        if kanji_count >= 11 or len(sentence) >= 40:
            difficulty = "N1"
        return {
            "translation": sentence,
            "grammar": ["本地回退解释：未配置远端 AI Key，返回结构化占位结果。"],
            "notes": ["接入真实模型后会返回更准确的翻译与语法说明。"],
            "difficulty": difficulty,
        }
