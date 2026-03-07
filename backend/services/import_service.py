from __future__ import annotations

import multiprocessing as mp
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree as ET

from backend.config import normalize_archive_path, safe_decode


@dataclass(slots=True)
class NormalizedChapter:
    id: str
    index: int
    title: str
    text: str
    paragraphs: list[str]
    sourceType: str
    sourceRef: str = ""


@dataclass(slots=True)
class NormalizedBook:
    title: str
    format: str
    chapters: list[NormalizedChapter]
    chapterCount: int
    normalizedVersion: int = 1
    importedAt: int = 0
    sourceFileName: str = ""

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["chapters"] = [asdict(chapter) for chapter in self.chapters]
        return payload


def normalize_paragraphs(text: str) -> list[str]:
    return [line.strip() for line in str(text or "").replace("\r", "").split("\n") if line.strip()]


def normalize_text(text: str) -> str:
    paragraphs = normalize_paragraphs(text)
    return "\n\n".join(paragraphs).strip()


def build_chapter(
    *,
    index: int,
    title: str,
    text: str,
    source_type: str,
    source_ref: str = "",
) -> NormalizedChapter | None:
    normalized_text = normalize_text(text)
    paragraphs = normalize_paragraphs(normalized_text)
    if not paragraphs:
        return None
    return NormalizedChapter(
        id=f"ch-{index + 1}",
        index=index,
        title=str(title or f"Chapter {index + 1}").strip() or f"Chapter {index + 1}",
        text=normalized_text,
        paragraphs=paragraphs,
        sourceType=str(source_type or "unknown").strip() or "unknown",
        sourceRef=str(source_ref or "").strip(),
    )


def build_book(
    *,
    title: str,
    format_name: str,
    source_file_name: str,
    chapters: list[NormalizedChapter],
) -> dict:
    if not chapters:
        raise ValueError("Import result is empty.")
    book = NormalizedBook(
        title=str(title or "Untitled").strip() or "Untitled",
        format=str(format_name or "txt").strip().lower() or "txt",
        chapters=chapters,
        chapterCount=len(chapters),
        importedAt=int(time.time() * 1000),
        sourceFileName=str(source_file_name or "").strip(),
    )
    return book.to_dict()


class HtmlTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if tag in {"p", "div", "section", "article", "br", "li", "h1", "h2", "h3", "h4"}:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"p", "div", "section", "article", "li", "h1", "h2", "h3", "h4"}:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        self._parts.append(data)

    @property
    def text(self) -> str:
        merged = "".join(self._parts)
        merged = re.sub(r"\n{3,}", "\n\n", merged)
        return normalize_text(merged)


def html_to_text(html: str) -> str:
    parser = HtmlTextExtractor()
    parser.feed(str(html or ""))
    parser.close()
    return parser.text


def element_text(root: ET.Element, xpath: str) -> str:
    node = root.find(xpath)
    if node is None or node.text is None:
        return ""
    return node.text.strip()


def parse_txt(raw: bytes, name: str) -> dict:
    title = Path(name).stem or "TXT 文档"
    text = safe_decode(raw)
    chapter_heading_re = re.compile(r"^\s*(第[^\n]{0,40}(?:章|节|節|回|幕)[^\n]*)\s*$", re.MULTILINE)
    matches = list(chapter_heading_re.finditer(text))
    chapters: list[NormalizedChapter] = []
    if matches:
        for index, match in enumerate(matches):
            start = match.end()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            body = text[start:end].strip()
            chapter = build_chapter(
                index=index,
                title=match.group(1).strip(),
                text=body,
                source_type="txt",
                source_ref=f"chapter-{index + 1}",
            )
            if chapter is not None:
                chapters.append(chapter)
    if not chapters:
        chapter = build_chapter(
            index=0,
            title=title,
            text=text,
            source_type="txt",
            source_ref="document",
        )
        if chapter is None:
            raise ValueError("TXT parse result is empty.")
        chapters = [chapter]
    return build_book(
        title=title,
        format_name="txt",
        source_file_name=name,
        chapters=chapters,
    )


def parse_epub(raw: bytes, name: str, *, format_name: str = "epub") -> dict:
    chapters: list[NormalizedChapter] = []
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
            opf_dir = Path(opf_path).parent.as_posix()

            for item_id in spine_ids:
                manifest_item = manifest.get(item_id)
                if not manifest_item:
                    continue
                href = manifest_item["href"]
                media_type = manifest_item["media_type"]
                if "html" not in media_type and not href.endswith((".xhtml", ".html", ".htm")):
                    continue
                archive_path = normalize_archive_path(opf_dir, href)
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
                chapter_title = ""
                if html_root is not None:
                    chapter_title = element_text(
                        html_root,
                        ".//{http://www.w3.org/1999/xhtml}title",
                    )
                chapter = build_chapter(
                    index=len(chapters),
                    title=chapter_title or Path(href).stem or f"Chapter {len(chapters) + 1:03d}",
                    text=text,
                    source_type=f"{format_name}-spine",
                    source_ref=archive_path,
                )
                if chapter is not None:
                    chapters.append(chapter)

            if not chapters:
                for archive_name in sorted(zf.namelist()):
                    if not archive_name.endswith((".xhtml", ".html", ".htm")):
                        continue
                    chapter = build_chapter(
                        index=len(chapters),
                        title=Path(archive_name).stem,
                        text=html_to_text(safe_decode(zf.read(archive_name))),
                        source_type=f"{format_name}-archive",
                        source_ref=archive_name,
                    )
                    if chapter is not None:
                        chapters.append(chapter)

    if not chapters:
        raise ValueError("EPUB parse result is empty.")
    return build_book(
        title=Path(name).stem or "EPUB 文档",
        format_name=format_name,
        source_file_name=name,
        chapters=chapters,
    )


def parse_pdf(raw: bytes, name: str) -> dict:
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("PDF parsing needs pypdf (`pip install pypdf`).") from exc

    chapters: list[NormalizedChapter] = []
    with tempfile.TemporaryDirectory(prefix="yomuyomu_pdf_") as tmp:
        pdf_path = Path(tmp) / "book.pdf"
        pdf_path.write_bytes(raw)
        reader = PdfReader(str(pdf_path))
        for page_index, page in enumerate(reader.pages):
            chapter = build_chapter(
                index=len(chapters),
                title=f"Page {page_index + 1}",
                text=page.extract_text() or "",
                source_type="pdf-page",
                source_ref=str(page_index + 1),
            )
            if chapter is not None:
                chapters.append(chapter)
    if not chapters:
        raise ValueError("PDF parse result is empty.")
    return build_book(
        title=Path(name).stem or "PDF 文档",
        format_name="pdf",
        source_file_name=name,
        chapters=chapters,
    )


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
        return parse_epub(epub_path.read_bytes(), name, format_name="mobi")


def parse_book(raw: bytes, name: str, file_type: str) -> dict:
    normalized = str(file_type or "").lower().strip(".")
    if normalized == "txt":
        return parse_txt(raw, name)
    if normalized == "epub":
        return parse_epub(raw, name)
    if normalized == "pdf":
        return parse_pdf(raw, name)
    if normalized == "mobi":
        return parse_mobi(raw, name)
    raise ValueError(f"Unsupported type: {file_type}")


def _parse_worker(conn, raw: bytes, name: str, file_type: str) -> None:  # noqa: ANN001
    try:
        conn.send({"ok": True, "book": parse_book(raw, name, file_type)})
    except Exception as exc:
        conn.send({"ok": False, "error": str(exc)})
    finally:
        conn.close()


def parse_book_with_timeout(raw: bytes, name: str, file_type: str, *, timeout_seconds: int) -> dict:
    if timeout_seconds <= 0:
        return parse_book(raw, name, file_type)
    ctx = mp.get_context("spawn")
    parent_conn, child_conn = ctx.Pipe(duplex=False)
    process = ctx.Process(
        target=_parse_worker,
        args=(child_conn, raw, name, file_type),
        daemon=True,
    )
    process.start()
    child_conn.close()
    payload: dict | None = None
    try:
        if not parent_conn.poll(timeout_seconds):
            raise TimeoutError(f"解析超时（>{timeout_seconds} 秒）。")
        payload = parent_conn.recv()
    finally:
        parent_conn.close()
        if process.is_alive():
            process.terminate()
        process.join(timeout=2)
    if not isinstance(payload, dict) or not payload.get("ok"):
        raise RuntimeError(str(payload.get("error", "解析失败。")) if isinstance(payload, dict) else "解析失败。")
    return payload["book"]
