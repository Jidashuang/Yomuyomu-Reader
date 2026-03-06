#!/usr/bin/env python3
"""
Download and extract JMdict_e to backend/data/JMdict_e.

Usage:
  python3 backend/download_jmdict.py
"""

from __future__ import annotations

import argparse
import gzip
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

DEFAULT_URL = "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "backend" / "data"
DEFAULT_OUTPUT = DATA_DIR / "JMdict_e"


def download(url: str, target: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "yomuyomu-downloader/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp, target.open("wb") as fp:
        shutil.copyfileobj(resp, fp)


def extract_gzip(src_gz: Path, dst_file: Path) -> None:
    with gzip.open(src_gz, "rb") as fin, dst_file.open("wb") as fout:
        shutil.copyfileobj(fin, fout)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download JMdict_e to backend/data.")
    parser.add_argument("--url", default=DEFAULT_URL, help="JMdict gzip URL")
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help="Output path for extracted JMdict_e (default: backend/data/JMdict_e)",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite existing output file")
    args = parser.parse_args()

    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    if output.exists() and not args.force:
        print(f"[skip] {output} already exists. Use --force to overwrite.")
        return 0

    with tempfile.TemporaryDirectory(prefix="yomuyomu_jmdict_") as tmp:
        gz_path = Path(tmp) / "JMdict_e.gz"
        print(f"[download] {args.url}")
        download(args.url, gz_path)
        print(f"[extract] -> {output}")
        extract_gzip(gz_path, output)

    size_mb = output.stat().st_size / (1024 * 1024)
    print(f"[done] Saved {output} ({size_mb:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
