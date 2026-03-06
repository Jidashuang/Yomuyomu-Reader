#!/usr/bin/env python3
"""
Fetch a large JLPT vocab map (N1-N5) and build backend/data/jlpt_levels.json.

Source datasets:
- open-anki-jlpt-decks (MIT) by jamsinclair
  https://github.com/jamsinclair/open-anki-jlpt-decks
- JLPT_Vocabulary by Bluskyo (Tanos-derived full list)
  https://github.com/Bluskyo/JLPT_Vocabulary
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import ssl
import urllib.request
from pathlib import Path
from urllib.error import URLError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = PROJECT_ROOT / "backend" / "data" / "jlpt_levels.json"

OPEN_ANKI_SOURCES = {
    "N1": "https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n1.csv",
    "N2": "https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n2.csv",
    "N3": "https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n3.csv",
    "N4": "https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n4.csv",
    "N5": "https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n5.csv",
}

FULL_LIST_SOURCES = [
    {
        "name": "bluskyo_jlpt_vocabulary",
        "url": (
            "https://raw.githubusercontent.com/Bluskyo/JLPT_Vocabulary/"
            "master/data/results/JLPTWords.csv"
        ),
    }
]

WORD_COLUMNS = {
    "word",
    "expression",
    "surface",
    "lemma",
    "vocab",
    "kanji",
    "japanese",
    "term",
}
LEVEL_COLUMNS = {"level", "jlpt", "jlptlevel", "nlevel", "n"}
LEVEL_RANK = {"N5": 1, "N4": 2, "N3": 3, "N2": 4, "N1": 5}
LEVEL_RE = re.compile(r"n?\s*([1-5])", re.IGNORECASE)


def build_ssl_context(cafile: str | None, insecure: bool) -> ssl.SSLContext:
    if insecure:
        return ssl._create_unverified_context()  # noqa: SLF001

    if cafile:
        return ssl.create_default_context(cafile=cafile)

    try:
        import certifi  # type: ignore

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def fetch_text(url: str, timeout: int, context: ssl.SSLContext) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "yomuyomu-jlpt-fetch/1.0",
            "Accept": "text/csv,text/plain,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout, context=context) as resp:  # noqa: S310
        raw = resp.read()
    return raw.decode("utf-8", errors="replace")


def choose_word_index(header: list[str]) -> int:
    lowered = [col.strip().lower() for col in header]
    for i, name in enumerate(lowered):
        if name in WORD_COLUMNS:
            return i
    return 0


def choose_level_index(header: list[str]) -> int | None:
    lowered = [col.strip().lower() for col in header]
    for i, name in enumerate(lowered):
        if name in LEVEL_COLUMNS:
            return i
    return None


def normalize_word(value: str) -> str:
    return str(value or "").strip()


def normalize_level(value: str) -> str:
    raw = str(value or "").strip().upper().replace(" ", "")
    if raw in LEVEL_RANK:
        return raw
    matched = LEVEL_RE.search(raw)
    if not matched:
        return ""
    return f"N{matched.group(1)}"


def parse_level_csv(level: str, text: str) -> list[str]:
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return []

    word_index = 0
    start_index = 0
    if rows and rows[0]:
        maybe_header = [cell.strip().lower() for cell in rows[0]]
        if any(name in WORD_COLUMNS for name in maybe_header):
            word_index = choose_word_index(rows[0])
            start_index = 1

    words = []
    for row in rows[start_index:]:
        if word_index >= len(row):
            continue
        word = normalize_word(row[word_index])
        if word:
            words.append(word)
    return words


def parse_word_level_csv(text: str) -> list[tuple[str, str]]:
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return []

    entries: list[tuple[str, str]] = []
    start_index = 0
    word_index = 0
    level_index = 1

    if rows[0]:
        maybe_header = [cell.strip().lower() for cell in rows[0]]
        header_word_index = choose_word_index(rows[0])
        header_level_index = choose_level_index(rows[0])
        has_header = any(name in WORD_COLUMNS for name in maybe_header) and header_level_index is not None
        if has_header:
            start_index = 1
            word_index = header_word_index
            level_index = header_level_index

    for row in rows[start_index:]:
        if not row:
            continue

        word = ""
        level = ""

        if word_index < len(row) and level_index < len(row):
            word = normalize_word(row[word_index])
            level = normalize_level(row[level_index])

        if not word or not level:
            if len(row) >= 2:
                maybe_level_left = normalize_level(row[0])
                maybe_level_right = normalize_level(row[1])
                if maybe_level_left:
                    word = normalize_word(row[1])
                    level = maybe_level_left
                elif maybe_level_right:
                    word = normalize_word(row[0])
                    level = maybe_level_right

        if word and level:
            entries.append((word, level))

    return entries


def merge_word(mapping: dict[str, str], word: str, level: str) -> None:
    prev = mapping.get(word)
    if not prev:
        mapping[word] = level
        return
    # If sources disagree, keep the easier level to avoid over-highlighting
    # common words as "hard" (e.g. words that appear in both N5 and N1 lists).
    if LEVEL_RANK[level] < LEVEL_RANK[prev]:
        mapping[word] = level


def build_jlpt_map(
    timeout: int, cafile: str | None, insecure: bool
) -> tuple[dict[str, str], dict[str, int], dict[str, int]]:
    mapping: dict[str, str] = {}
    level_counts: dict[str, int] = {level: 0 for level in LEVEL_RANK}
    source_counts: dict[str, int] = {}
    context = build_ssl_context(cafile=cafile, insecure=insecure)

    for level, url in OPEN_ANKI_SOURCES.items():
        text = fetch_text(url, timeout=timeout, context=context)
        words = parse_level_csv(level, text)
        source_counts[f"open_anki_{level}"] = len(words)
        for word in words:
            merge_word(mapping, word, level)
            level_counts[level] += 1

    for source in FULL_LIST_SOURCES:
        text = fetch_text(source["url"], timeout=timeout, context=context)
        entries = parse_word_level_csv(text)
        source_counts[source["name"]] = len(entries)
        for word, level in entries:
            merge_word(mapping, word, level)
            level_counts[level] += 1
    return mapping, level_counts, source_counts


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch full JLPT vocab and build jlpt_levels.json")
    parser.add_argument("--output", default=str(DEFAULT_OUT), help="Output JSON path")
    parser.add_argument("--timeout", type=int, default=25, help="HTTP timeout seconds")
    parser.add_argument(
        "--cafile", default=None, help="Path to CA bundle pem file (optional)"
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Disable TLS certificate verification (temporary workaround)",
    )
    args = parser.parse_args()

    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        mapping, level_counts, source_counts = build_jlpt_map(
            timeout=args.timeout,
            cafile=args.cafile,
            insecure=args.insecure,
        )
    except URLError as exc:
        print("Fetch failed.")
        print(f"Reason: {exc}")
        print("")
        print("Try one of the following:")
        print("1) python3 -m pip install certifi")
        print("2) /Applications/Python\\ 3.13/Install\\ Certificates.command")
        print(
            "3) python3 backend/fetch_full_jlpt_wordlist.py --insecure "
            "(temporary workaround only)"
        )
        raise SystemExit(2) from exc

    output_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Saved JLPT map: {output_path}")
    print(f"Total unique words: {len(mapping)}")
    print("Source rows:")
    for source_name in sorted(source_counts):
        print(f"- {source_name}: {source_counts[source_name]}")
    print("Merged rows by level (before de-dup):")
    for level in ("N1", "N2", "N3", "N4", "N5"):
        print(f"{level}: {level_counts.get(level, 0)}")


if __name__ == "__main__":
    main()
