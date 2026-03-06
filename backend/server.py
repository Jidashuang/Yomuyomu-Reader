#!/usr/bin/env python3
"""
YomuYomu backend service.

Provides:
- /api/import (TXT/EPUB/PDF/MOBI)
- /api/nlp/tokenize (Sudachi or MeCab/fugashi with heuristic fallback)
- /api/dict/lookup (JMDict SQLite lookup)
- /api/sync/push and /api/sync/pull (simple cloud snapshot sync)
- Static file hosting for the frontend
"""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
import zipfile
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from xml.etree import ElementTree as ET

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "backend" / "data"
CLOUD_DIR = DATA_DIR / "cloud"
DB_PATH = DATA_DIR / "jmdict.db"
WORD_NOISE_RE = re.compile(
    r"""^[\s「」『』【】［］（）()〈〉《》〔〕｛｝{}'"“”‘’、。・，．！？!?：:；;]+|"""
    r"""[\s「」『』【】［］（）()〈〉《》〔〕｛｝{}'"“”‘’、。・，．！？!?：:；;]+$"""
)


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CLOUD_DIR.mkdir(parents=True, exist_ok=True)


def json_response(handler: SimpleHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.end_headers()
    handler.wfile.write(body)


def safe_decode(raw: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "shift_jis", "cp932", "euc_jp"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


class HtmlTextExtractor(HTMLParser):
    BLOCK_TAGS = {
        "p",
        "div",
        "article",
        "section",
        "br",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "tr",
        "blockquote",
    }

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if data and not data.isspace():
            self.parts.append(data)

    def text(self) -> str:
        joined = "".join(self.parts)
        joined = re.sub(r"[ \t\f\v]+", " ", joined)
        joined = re.sub(r"\n{3,}", "\n\n", joined)
        return joined.strip()


def html_to_text(html: str) -> str:
    parser = HtmlTextExtractor()
    parser.feed(html)
    return parser.text()


def element_text(root: ET.Element, xpath: str) -> str:
    node = root.find(xpath)
    if node is None or node.text is None:
        return ""
    return node.text.strip()


def parse_txt(raw: bytes, name: str) -> dict:
    text = safe_decode(raw).replace("\r", "").strip()
    title = Path(name).stem or "TXT 文档"
    return {"title": title, "format": "txt", "chapters": [{"title": title, "text": text}]}


def parse_epub(raw: bytes, name: str) -> dict:
    chapters: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="yomuyomu_epub_") as tmp:
        epub_path = Path(tmp) / "book.epub"
        epub_path.write_bytes(raw)
        with zipfile.ZipFile(epub_path) as zf:
            container_xml = zf.read("META-INF/container.xml").decode("utf-8", errors="ignore")
            container_root = ET.fromstring(container_xml)
            rootfile = container_root.find(
                ".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile"
            )
            if rootfile is None:
                raise ValueError("EPUB container.xml missing rootfile.")
            opf_path = rootfile.attrib.get("full-path", "")
            if not opf_path:
                raise ValueError("EPUB OPF path is empty.")

            opf_root = ET.fromstring(zf.read(opf_path))
            ns_uri = opf_root.tag.split("}")[0].strip("{")
            ns = {"opf": ns_uri}
            manifest: dict[str, dict] = {}
            for item in opf_root.findall(".//opf:manifest/opf:item", ns):
                item_id = item.attrib.get("id")
                if not item_id:
                    continue
                manifest[item_id] = {
                    "href": item.attrib.get("href", ""),
                    "media_type": item.attrib.get("media-type", ""),
                }

            spine_ids = [
                item.attrib.get("idref", "")
                for item in opf_root.findall(".//opf:spine/opf:itemref", ns)
                if item.attrib.get("idref")
            ]
            opf_dir = posixpath.dirname(opf_path)

            def to_archive_path(href: str) -> str:
                joined = posixpath.normpath(posixpath.join(opf_dir, href))
                return joined.lstrip("/")

            for order, item_id in enumerate(spine_ids, start=1):
                manifest_item = manifest.get(item_id)
                if not manifest_item:
                    continue
                href = manifest_item["href"]
                media_type = manifest_item["media_type"]
                if "html" not in media_type and not href.endswith((".xhtml", ".html", ".htm")):
                    continue
                archive_path = to_archive_path(href)
                try:
                    html_raw = zf.read(archive_path)
                except KeyError:
                    continue
                html = safe_decode(html_raw)
                text = html_to_text(html)
                if not text:
                    continue
                html_root = None
                if "<html" in html:
                    try:
                        html_root = ET.fromstring(re.sub(r"&[a-zA-Z]+?;", "", html))
                    except ET.ParseError:
                        html_root = None
                title = ""
                if html_root is not None:
                    title = element_text(html_root, ".//{http://www.w3.org/1999/xhtml}title")
                if not title:
                    title = f"Chapter {order:03d}"
                chapters.append({"title": title, "text": text})

            if not chapters:
                for archive_name in sorted(zf.namelist()):
                    if not archive_name.endswith((".xhtml", ".html", ".htm")):
                        continue
                    text = html_to_text(safe_decode(zf.read(archive_name)))
                    if text:
                        chapters.append({"title": Path(archive_name).stem, "text": text})

    if not chapters:
        raise ValueError("EPUB parse result is empty.")
    title = Path(name).stem or "EPUB 文档"
    return {"title": title, "format": "epub", "chapters": chapters}


def parse_pdf(raw: bytes, name: str) -> dict:
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("PDF parsing needs pypdf (`pip install pypdf`).") from exc

    chapters = []
    with tempfile.TemporaryDirectory(prefix="yomuyomu_pdf_") as tmp:
        pdf_path = Path(tmp) / "book.pdf"
        pdf_path.write_bytes(raw)
        reader = PdfReader(str(pdf_path))
        for i, page in enumerate(reader.pages, start=1):
            text = (page.extract_text() or "").strip()
            if text:
                chapters.append({"title": f"Page {i}", "text": text})
    if not chapters:
        raise ValueError("PDF parse result is empty.")
    title = Path(name).stem or "PDF 文档"
    return {"title": title, "format": "pdf", "chapters": chapters}


def parse_mobi(raw: bytes, name: str) -> dict:
    converter = shutil.which("ebook-convert")
    if not converter:
        raise RuntimeError(
            "MOBI import needs Calibre `ebook-convert`. Please install Calibre first."
        )

    with tempfile.TemporaryDirectory(prefix="yomuyomu_mobi_") as tmp:
        mobi_path = Path(tmp) / "book.mobi"
        epub_path = Path(tmp) / "book.epub"
        mobi_path.write_bytes(raw)
        proc = subprocess.run(
            [converter, str(mobi_path), str(epub_path)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if proc.returncode != 0 or not epub_path.exists():
            raise RuntimeError(f"MOBI convert failed: {proc.stderr.strip()[:200]}")
        epub_raw = epub_path.read_bytes()
        result = parse_epub(epub_raw, name)
        result["format"] = "mobi"
        return result


def parse_book(raw: bytes, name: str, file_type: str) -> dict:
    normalized = file_type.lower().strip(".")
    if normalized == "txt":
        return parse_txt(raw, name)
    if normalized == "epub":
        return parse_epub(raw, name)
    if normalized == "pdf":
        return parse_pdf(raw, name)
    if normalized == "mobi":
        return parse_mobi(raw, name)
    raise ValueError(f"Unsupported type: {file_type}")


def parse_multipart_form(
    raw: bytes, content_type: str
) -> tuple[dict[str, str], dict[str, tuple[str, bytes]]] | tuple[None, None]:
    """
    Very small multipart parser for this project.
    Returns:
      - fields: key -> value
      - files: key -> (filename, bytes)
    """
    boundary_match = re.search(r'boundary="?([^";]+)"?', content_type)
    if not boundary_match:
        return None, None
    boundary = boundary_match.group(1).encode("utf-8")
    delimiter = b"--" + boundary
    fields: dict[str, str] = {}
    files: dict[str, tuple[str, bytes]] = {}

    parts = raw.split(delimiter)
    for part in parts:
        part = part.strip()
        if not part or part == b"--":
            continue
        if part.startswith(b"--"):
            part = part[2:]
        if b"\r\n\r\n" not in part:
            continue
        header_blob, body = part.split(b"\r\n\r\n", 1)
        body = body.rstrip(b"\r\n")
        header_lines = header_blob.decode("utf-8", errors="ignore").split("\r\n")
        headers: dict[str, str] = {}
        for line in header_lines:
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.strip().lower()] = value.strip()

        disposition = headers.get("content-disposition", "")
        name_match = re.search(r'name="([^"]+)"', disposition)
        if not name_match:
            continue
        field_name = name_match.group(1)
        filename_match = re.search(r'filename="([^"]*)"', disposition)
        if filename_match:
            files[field_name] = (filename_match.group(1), body)
        else:
            fields[field_name] = body.decode("utf-8", errors="ignore")
    return fields, files


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


class JMDictStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    def available(self) -> bool:
        return self.db_path.exists()

    @staticmethod
    def _entry_columns(conn: sqlite3.Connection) -> set[str]:
        rows = conn.execute("PRAGMA table_info(entries)").fetchall()
        return {row[1] for row in rows}

    @staticmethod
    def _katakana_to_hiragana(text: str) -> str:
        out = []
        for ch in str(text or ""):
            code = ord(ch)
            if 0x30A1 <= code <= 0x30F6:
                out.append(chr(code - 0x60))
            else:
                out.append(ch)
        return "".join(out)

    @staticmethod
    def _hiragana_to_katakana(text: str) -> str:
        out = []
        for ch in str(text or ""):
            code = ord(ch)
            if 0x3041 <= code <= 0x3096:
                out.append(chr(code + 0x60))
            else:
                out.append(ch)
        return "".join(out)

    @staticmethod
    def _strip_word_noise(text: str) -> str:
        return WORD_NOISE_RE.sub("", str(text or "").strip()).strip()

    def _build_lookup_candidates(self, surface: str, lemma: str) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for raw in (surface, lemma):
            base = str(raw or "").strip()
            if not base:
                continue
            values = (
                base,
                self._strip_word_noise(base),
                self._katakana_to_hiragana(base),
                self._hiragana_to_katakana(base),
            )
            for value in values:
                val = self._strip_word_noise(value)
                if not val or val in seen:
                    continue
                seen.add(val)
                out.append(val)
        return out

    def lookup(self, surface: str, lemma: str, limit: int = 8) -> list[dict]:
        if not self.available():
            return []
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            columns = self._entry_columns(conn)
            candidates = self._build_lookup_candidates(surface, lemma)
            if not candidates:
                return []
            select_fields = [
                "surface",
                "lemma",
                "reading",
                "gloss",
                "pos",
                "gloss_zh" if "gloss_zh" in columns else "'' AS gloss_zh",
                "gloss_en" if "gloss_en" in columns else "'' AS gloss_en",
            ]
            select_sql = ", ".join(select_fields)
            placeholders = ", ".join("?" for _ in candidates)
            rows = conn.execute(
                f"""
                SELECT {select_sql}
                FROM entries
                WHERE surface IN ({placeholders}) OR lemma IN ({placeholders})
                LIMIT ?
                """,
                (*candidates, *candidates, limit),
            ).fetchall()
            if not rows:
                like_clauses = " OR ".join(["surface LIKE ? OR lemma LIKE ?"] * len(candidates))
                like_params: list[str | int] = []
                for cand in candidates:
                    like_params.extend([f"{cand}%", f"{cand}%"])
                like_params.append(limit)
                rows = conn.execute(
                    f"""
                    SELECT {select_sql}
                    FROM entries
                    WHERE {like_clauses}
                    LIMIT ?
                    """,
                    tuple(like_params),
                ).fetchall()
            return [dict(row) for row in rows]
        finally:
            conn.close()


class ApiHandler(SimpleHTTPRequestHandler):
    tokenizer = JapaneseTokenizer()
    dict_store = JMDictStore(DB_PATH)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "tokenizer": self.tokenizer.backend,
                    "jmdict": self.dict_store.available(),
                },
            )
            return
        if parsed.path == "/api/sync/pull":
            query = parse_qs(parsed.query)
            user_id = query.get("userId", ["default"])[0]
            sync_file = CLOUD_DIR / f"{sanitize_user_id(user_id)}.json"
            if sync_file.exists():
                payload = json.loads(sync_file.read_text(encoding="utf-8"))
            else:
                payload = {"updatedAt": 0, "snapshot": {}}
            json_response(self, 200, {"ok": True, "data": payload})
            return
        if parsed.path.startswith("/api/"):
            json_response(self, 404, {"ok": False, "error": "API route not found"})
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/import":
            self.handle_import()
            return
        if parsed.path == "/api/nlp/tokenize":
            self.handle_tokenize()
            return
        if parsed.path == "/api/dict/lookup":
            self.handle_lookup()
            return
        if parsed.path == "/api/sync/push":
            self.handle_sync_push()
            return
        json_response(self, 404, {"ok": False, "error": "API route not found"})

    def handle_import(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            json_response(self, 400, {"ok": False, "error": "Use multipart/form-data with file"})
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            json_response(self, 400, {"ok": False, "error": "Empty body"})
            return
        raw_body = self.rfile.read(length)
        _, files = parse_multipart_form(raw_body, content_type)
        if not files or "file" not in files:
            json_response(self, 400, {"ok": False, "error": "Missing `file` field"})
            return
        filename, raw = files["file"]
        filename = filename or "book.txt"
        ext = Path(filename).suffix.lower().lstrip(".")
        try:
            result = parse_book(raw, filename, ext)
            json_response(self, 200, {"ok": True, "book": result})
        except Exception as exc:
            json_response(self, 500, {"ok": False, "error": str(exc)})

    def handle_tokenize(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        text = str(payload.get("text", ""))
        if not text.strip():
            json_response(self, 200, {"ok": True, "tokens": []})
            return
        tokens = self.tokenizer.tokenize(text)
        json_response(self, 200, {"ok": True, "backend": self.tokenizer.backend, "tokens": tokens})

    def handle_lookup(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        surface = str(payload.get("surface", "")).strip()
        lemma = str(payload.get("lemma", "")).strip()
        entries = self.dict_store.lookup(surface, lemma)
        json_response(self, 200, {"ok": True, "entries": entries})

    def handle_sync_push(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            json_response(self, 400, {"ok": False, "error": "Invalid JSON body"})
            return
        user_id = sanitize_user_id(str(payload.get("userId", "default")))
        snapshot = payload.get("snapshot", {})
        sync_file = CLOUD_DIR / f"{user_id}.json"
        data = {"updatedAt": int(time.time() * 1000), "snapshot": snapshot}
        sync_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        json_response(self, 200, {"ok": True, "data": data})

    def read_json_body(self) -> dict | None:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None


def sanitize_user_id(user_id: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", user_id).strip("._")
    return cleaned or "default"


def run_server(host: str, port: int) -> None:
    ensure_dirs()
    handler_cls = lambda *args, **kwargs: ApiHandler(*args, directory=str(PROJECT_ROOT), **kwargs)
    with ThreadingHTTPServer((host, port), handler_cls) as server:
        print(f"YomuYomu server running at http://{host}:{port}")
        print(f"Tokenizer backend: {ApiHandler.tokenizer.backend}")
        print(f"JMDict DB: {DB_PATH} ({'found' if DB_PATH.exists() else 'not found'})")
        server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run YomuYomu backend server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    run_server(args.host, args.port)


if __name__ == "__main__":
    main()
