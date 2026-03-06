#!/usr/bin/env python3
"""
Convert JLPT level data into frontend-consumable JSON map.

Supported inputs:
- CSV/TSV with headers, e.g. word,level
- CSV/TSV without headers (first column word, second column level)
- JSON object map or JSON array entries

Output:
- backend/data/jlpt_levels.json
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = PROJECT_ROOT / "backend" / "data" / "jlpt_levels.json"

VALID_LEVELS = {"N1", "N2", "N3", "N4", "N5"}


def normalize_level(value: str) -> str:
    raw = str(value or "").strip().upper().replace(" ", "")
    if raw in VALID_LEVELS:
        return raw
    if raw in {"1", "2", "3", "4", "5"}:
        return f"N{raw}"
    return ""


def normalize_word(value: str) -> str:
    return str(value or "").strip()


def parse_json(path: Path) -> dict[str, str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    result: dict[str, str] = {}
    if isinstance(payload, dict):
        for word, level in payload.items():
            w = normalize_word(word)
            lv = normalize_level(level)
            if w and lv:
                result[w] = lv
        return result
    if isinstance(payload, list):
        for item in payload:
            if not isinstance(item, dict):
                continue
            word = normalize_word(item.get("word") or item.get("surface") or item.get("lemma"))
            level = normalize_level(item.get("level") or item.get("jlpt"))
            if word and level:
                result[word] = level
        return result
    raise ValueError("JSON must be an object map or array of objects.")


def pick_column(fieldnames: list[str], explicit: str | None, candidates: list[str]) -> str | None:
    if explicit:
        return explicit if explicit in fieldnames else None
    lowered = {name.lower(): name for name in fieldnames}
    for candidate in candidates:
        if candidate.lower() in lowered:
            return lowered[candidate.lower()]
    return None


def parse_delimited(path: Path, delimiter: str, word_col: str | None, level_col: str | None) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    rows = [line for line in text.splitlines() if line.strip()]
    if not rows:
        return {}

    has_header = not all(token.replace("N", "").isdigit() for token in rows[0].split(delimiter)[1:2])
    result: dict[str, str] = {}

    if has_header:
        reader = csv.DictReader(rows, delimiter=delimiter)
        if reader.fieldnames is None:
            return {}
        word_key = pick_column(reader.fieldnames, word_col, ["word", "surface", "lemma", "term", "vocab"])
        level_key = pick_column(reader.fieldnames, level_col, ["level", "jlpt", "nlevel", "n"])
        if not word_key or not level_key:
            raise ValueError(
                "Cannot infer word/level columns from headers. "
                "Use --word-col and --level-col explicitly."
            )
        for row in reader:
            word = normalize_word(row.get(word_key, ""))
            level = normalize_level(row.get(level_key, ""))
            if word and level:
                result[word] = level
        return result

    reader = csv.reader(rows, delimiter=delimiter)
    for row in reader:
        if len(row) < 2:
            continue
        word = normalize_word(row[0])
        level = normalize_level(row[1])
        if word and level:
            result[word] = level
    return result


def parse_input(path: Path, word_col: str | None, level_col: str | None) -> dict[str, str]:
    suffix = path.suffix.lower()
    if suffix == ".json":
        return parse_json(path)
    if suffix == ".csv":
        return parse_delimited(path, ",", word_col, level_col)
    if suffix in {".tsv", ".txt"}:
        return parse_delimited(path, "\t", word_col, level_col)
    raise ValueError(f"Unsupported extension: {suffix}. Use .json/.csv/.tsv")


def main() -> None:
    parser = argparse.ArgumentParser(description="Import JLPT levels to backend/data/jlpt_levels.json")
    parser.add_argument("--input", required=True, help="Path to JSON/CSV/TSV source")
    parser.add_argument("--output", default=str(DEFAULT_OUT), help="Output JSON path")
    parser.add_argument("--word-col", default=None, help="Word column name for CSV/TSV")
    parser.add_argument("--level-col", default=None, help="Level column name for CSV/TSV")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    result = parse_input(input_path, args.word_col, args.level_col)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Imported {len(result)} JLPT entries -> {output_path}")


if __name__ == "__main__":
    main()
