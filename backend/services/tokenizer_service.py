from __future__ import annotations

import re


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
