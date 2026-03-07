from __future__ import annotations

import json
import re
from functools import lru_cache

from backend.config import (
    AI_EXPLAIN_PROMPT_VERSION,
    ANALYSIS_VERSION,
    DICT_VERSION,
    JLPT_LEVELS_EXAMPLE_PATH,
    JLPT_LEVELS_PATH,
    JLPT_VERSION,
    TOKENIZER_VERSION,
)
from backend.repositories.dictionary import JMDictStore
from backend.services.tokenizer_service import JapaneseTokenizer


HIRAGANA_ONLY_RE = re.compile(r"^[ぁ-ゖー]+$")
JP_WORD_RE = re.compile(r"[一-龯々ぁ-ゖァ-ヺー]")
BLOCKED_POS_RE = re.compile(
    r"(助詞|助動詞|記号|連体詞|代名詞|接続詞|感動詞|接頭詞|接尾辞|非自立|補助)"
)
LEVEL_PRIORITY = {"N1": 0, "N2": 1, "N3": 2, "N4": 3, "N5": 4}
SENTENCE_END_RE = re.compile(r"[。！？!?]")


def _normalize_word_key(value: str) -> str:
    return str(value or "").strip()


def _normalize_jlpt_level(value: str | None) -> str:
    normalized = str(value or "").strip().upper()
    return normalized if normalized in {"N1", "N2", "N3", "N4", "N5"} else ""


def _is_analyzable_word(token: dict, word: str) -> bool:
    if not word:
        return False
    if len(word) <= 1:
        return False
    if not JP_WORD_RE.search(word):
        return False
    if HIRAGANA_ONLY_RE.fullmatch(word):
        return False
    pos = str(token.get("pos", "") or "")
    if pos and BLOCKED_POS_RE.search(pos):
        return False
    return True


@lru_cache(maxsize=1)
def _load_jlpt_map() -> dict[str, str]:
    source_path = JLPT_LEVELS_PATH if JLPT_LEVELS_PATH.exists() else JLPT_LEVELS_EXAMPLE_PATH
    if not source_path.exists():
        return {}
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if isinstance(payload, dict):
        return {str(key).strip(): _normalize_jlpt_level(value) for key, value in payload.items()}
    if isinstance(payload, list):
        out: dict[str, str] = {}
        for item in payload:
            if not isinstance(item, dict):
                continue
            word = str(item.get("word", "") or "").strip()
            level = _normalize_jlpt_level(item.get("level"))
            if word and level:
                out[word] = level
        return out
    return {}


class ChapterAnalysisService:
    def __init__(self, tokenizer: JapaneseTokenizer, dict_store: JMDictStore) -> None:
        self.tokenizer = tokenizer
        self.dict_store = dict_store
        self.jlpt_map = _load_jlpt_map()

    @staticmethod
    def current_versions() -> dict[str, str]:
        return {
            "analysis_version": ANALYSIS_VERSION,
            "tokenizer_version": TOKENIZER_VERSION,
            "jlpt_version": JLPT_VERSION,
            "dict_version": DICT_VERSION,
            "prompt_version": AI_EXPLAIN_PROMPT_VERSION,
        }

    def analysis_is_current(self, analysis: dict | None) -> bool:
        if not isinstance(analysis, dict):
            return False
        versions = self.current_versions()
        return all(str(analysis.get(key, "") or "") == value for key, value in versions.items())

    def _jlpt_level(self, surface: str, lemma: str) -> str:
        for candidate in (str(lemma or "").strip(), str(surface or "").strip()):
            if candidate and self.jlpt_map.get(candidate):
                return self.jlpt_map[candidate]
        return ""

    def _sentence_items(self, paragraph: str, paragraph_index: int, tokens: list[dict]) -> list[dict]:
        items = []
        start = 0
        local_index = 0
        for match in SENTENCE_END_RE.finditer(paragraph):
            end = match.end()
            text = paragraph[start:end].strip()
            if text:
                items.append(
                    {
                        "id": f"p{paragraph_index}-s{local_index}",
                        "paragraphIndex": paragraph_index,
                        "text": text,
                        "start": start,
                        "end": end,
                        "tokenCount": sum(
                            1 for token in tokens if token["start"] < end and token["end"] > start
                        ),
                    }
                )
                local_index += 1
            start = end
        if start < len(paragraph):
            text = paragraph[start:].strip()
            if text:
                items.append(
                    {
                        "id": f"p{paragraph_index}-s{local_index}",
                        "paragraphIndex": paragraph_index,
                        "text": text,
                        "start": start,
                        "end": len(paragraph),
                        "tokenCount": sum(
                            1
                            for token in tokens
                            if token["start"] < len(paragraph) and token["end"] > start
                        ),
                    }
                )
        return items

    def _difficult_vocab(self, freq_map: dict[str, dict]) -> list[dict]:
        items = []
        for word, data in freq_map.items():
            level = _normalize_jlpt_level(data.get("level"))
            if level not in {"N1", "N2", "N3"}:
                continue
            meaning = ""
            if self.dict_store.available():
                entries = self.dict_store.lookup(data.get("surface", word), data.get("lemma", word), limit=1)
                if entries:
                    meaning = (
                        str(
                            entries[0].get("gloss_zh")
                            or entries[0].get("gloss")
                            or entries[0].get("gloss_en")
                            or ""
                        )
                        .strip()
                    )
            items.append(
                {
                    "word": data.get("surface", word),
                    "lemma": data.get("lemma", word),
                    "reading": data.get("reading", ""),
                    "level": level,
                    "count": int(data.get("count", 0) or 0),
                    "meaning": meaning,
                }
            )
        items.sort(
            key=lambda item: (
                LEVEL_PRIORITY.get(item["level"], 99),
                -int(item["count"] or 0),
                str(item["word"]),
            )
        )
        return items[:18]

    def analyze_chapter(self, chapter: dict) -> dict:
        chapter_id = str(chapter.get("id", "") or "")
        paragraphs = list(chapter.get("paragraphs") or [])
        all_tokens: list[dict] = []
        sentences: list[dict] = []
        freq_map: dict[str, dict] = {}
        jlpt_stats = {"N1": 0, "N2": 0, "N3": 0, "N4": 0, "N5": 0, "other": 0, "total": 0}

        for paragraph_index, paragraph in enumerate(paragraphs):
            raw_tokens = self.tokenizer.tokenize(str(paragraph or ""))
            paragraph_tokens = []
            for raw_token in raw_tokens:
                surface = str(raw_token.get("surface", "") or "")
                lemma = str(raw_token.get("lemma", surface) or surface)
                reading = str(raw_token.get("reading", "") or "")
                token = {
                    "paragraphIndex": paragraph_index,
                    "surface": surface,
                    "lemma": lemma,
                    "reading": reading,
                    "pos": str(raw_token.get("pos", "") or ""),
                    "start": int(raw_token.get("start", 0) or 0),
                    "end": int(raw_token.get("end", len(surface)) or len(surface)),
                    "jlpt": self._jlpt_level(surface, lemma),
                }
                paragraph_tokens.append(token)
                all_tokens.append(token)
                word = _normalize_word_key(lemma or surface)
                if not _is_analyzable_word(token, word):
                    continue
                level = _normalize_jlpt_level(token["jlpt"])
                jlpt_stats["total"] += 1
                if level:
                    jlpt_stats[level] += 1
                else:
                    jlpt_stats["other"] += 1
                bucket = freq_map.setdefault(
                    word,
                    {
                        "surface": surface,
                        "lemma": lemma,
                        "reading": reading,
                        "level": level,
                        "count": 0,
                    },
                )
                bucket["count"] += 1
                if not bucket.get("level") and level:
                    bucket["level"] = level
                if not bucket.get("reading") and reading:
                    bucket["reading"] = reading
            sentences.extend(self._sentence_items(str(paragraph or ""), paragraph_index, paragraph_tokens))

        return {
            "chapterId": chapter_id,
            "sentences": sentences,
            "tokens": all_tokens,
            "jlptStats": jlpt_stats,
            "difficultVocab": self._difficult_vocab(freq_map),
            **self.current_versions(),
        }

    def analyze_book(self, book: dict, on_chapter_done=None):  # noqa: ANN001
        chapters = list(book.get("chapters") or [])
        out = []
        for chapter in chapters:
            analysis = self.analyze_chapter(chapter)
            out.append(analysis)
            if callable(on_chapter_done):
                on_chapter_done(chapter, analysis)
        return out
