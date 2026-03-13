from __future__ import annotations

import re

TOKEN_PATTERN = re.compile(r"[一-龯々]+[ぁ-ゖー]*|[ァ-ヺー]+|[ぁ-ゖー]+|[A-Za-z0-9]+|[^\s]")
LEXICAL_SCRIPT_RE = re.compile(r"[一-龯々ァ-ヺー]")
HEURISTIC_AUX_SUFFIXES = ("でした", "です", "だ", "で", "に", "を", "へ", "と", "が", "は", "も", "の", "な")
HEURISTIC_AUX_POS = {
    "でした": "助動詞,heuristic",
    "です": "助動詞,heuristic",
    "だ": "助動詞,heuristic",
    "な": "助動詞,heuristic",
}


def _has_lexical_script(text: str) -> bool:
    return bool(LEXICAL_SCRIPT_RE.search(str(text or "")))


def _split_heuristic_suffixes(surface: str) -> list[tuple[str, str]]:
    value = str(surface or "")
    if not value or len(value) <= 1 or not _has_lexical_script(value):
        return [(value, "fallback")]

    tails: list[str] = []
    current = value
    for _ in range(3):
        matched = next(
            (
                suffix
                for suffix in HEURISTIC_AUX_SUFFIXES
                if current.endswith(suffix) and len(current) > len(suffix)
            ),
            "",
        )
        if not matched:
            break
        stem = current[: -len(matched)]
        if not stem or not _has_lexical_script(stem):
            break
        tails.insert(0, matched)
        current = stem

    parts = [(current, "fallback")]
    for tail in tails:
        parts.append((tail, HEURISTIC_AUX_POS.get(tail, "助詞,heuristic")))
    return parts


def fallback_tokenize(text: str) -> list[dict]:
    tokens = []
    for match in TOKEN_PATTERN.finditer(text):
        start = match.start()
        for surface, pos in _split_heuristic_suffixes(match.group(0)):
            end = start + len(surface)
            tokens.append(
                {
                    "surface": surface,
                    "lemma": surface,
                    "reading": "",
                    "pos": pos,
                    "start": start,
                    "end": end,
                }
            )
            start = end
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
