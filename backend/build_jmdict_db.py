#!/usr/bin/env python3
"""
Build a compact SQLite dictionary from JMDict XML.

Usage:
  python3 backend/build_jmdict_db.py --xml /path/to/JMdict.xml
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path
from xml.etree import ElementTree as ET

DEFAULT_DB = Path(__file__).resolve().parent / "data" / "jmdict.db"


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        DROP TABLE IF EXISTS entries;
        CREATE TABLE entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            surface TEXT NOT NULL,
            lemma TEXT NOT NULL,
            reading TEXT,
            gloss TEXT,
            gloss_zh TEXT,
            gloss_en TEXT,
            pos TEXT
        );
        CREATE INDEX idx_entries_surface ON entries(surface);
        CREATE INDEX idx_entries_lemma ON entries(lemma);
        CREATE INDEX idx_entries_reading ON entries(reading);
        """
    )


def strip_tag(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def child_texts(node: ET.Element, wanted_tag: str) -> list[str]:
    values = []
    for child in node:
        if strip_tag(child.tag) == wanted_tag and child.text:
            text = child.text.strip()
            if text:
                values.append(text)
    return values


XML_LANG_KEY = "{http://www.w3.org/XML/1998/namespace}lang"
ZH_LANG_PREFIXES = ("zh", "chi", "zho", "cmn")


def split_glosses_by_lang(sense_node: ET.Element) -> tuple[list[str], list[str]]:
    zh_glosses: list[str] = []
    en_glosses: list[str] = []
    for child in sense_node:
        if strip_tag(child.tag) != "gloss" or not child.text:
            continue
        text = child.text.strip()
        if not text:
            continue
        lang = (
            child.attrib.get(XML_LANG_KEY)
            or child.attrib.get("xml:lang")
            or child.attrib.get("lang")
            or "eng"
        ).lower()
        if lang.startswith(ZH_LANG_PREFIXES):
            zh_glosses.append(text)
        elif lang.startswith("en") or lang == "eng":
            en_glosses.append(text)
    return zh_glosses, en_glosses


def build_db(xml_path: Path, db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    create_schema(conn)

    total_rows = 0
    total_entries = 0
    batch = []

    context = ET.iterparse(str(xml_path), events=("end",))
    for _, elem in context:
        if strip_tag(elem.tag) != "entry":
            continue

        kebs = []
        rebs = []
        senses = []
        for child in elem:
            tag = strip_tag(child.tag)
            if tag == "k_ele":
                kebs.extend(child_texts(child, "keb"))
            elif tag == "r_ele":
                rebs.extend(child_texts(child, "reb"))
            elif tag == "sense":
                zh_glosses, en_glosses = split_glosses_by_lang(child)
                poses = child_texts(child, "pos")
                if zh_glosses or en_glosses:
                    senses.append(
                        {
                            "gloss": "; ".join((zh_glosses[:4] or en_glosses[:4])),
                            "gloss_zh": "; ".join(zh_glosses[:4]),
                            "gloss_en": "; ".join(en_glosses[:4]),
                            "pos": ", ".join(poses[:3]),
                        }
                    )

        lemmas = kebs if kebs else rebs
        if not lemmas:
            elem.clear()
            continue

        reading = rebs[0] if rebs else ""
        sense = senses[0] if senses else {"gloss": "", "gloss_zh": "", "gloss_en": "", "pos": ""}
        surfaces = []
        surfaces.extend(kebs)
        surfaces.extend(rebs)
        if not surfaces:
            surfaces.extend(lemmas)

        total_entries += 1
        for surface in sorted(set(surfaces)):
            lemma = lemmas[0]
            batch.append(
                (
                    surface,
                    lemma,
                    reading,
                    sense["gloss"],
                    sense["gloss_zh"],
                    sense["gloss_en"],
                    sense["pos"],
                )
            )
            total_rows += 1

        if len(batch) >= 4000:
            conn.executemany(
                """
                INSERT INTO entries(
                    surface, lemma, reading, gloss, gloss_zh, gloss_en, pos
                ) VALUES(?,?,?,?,?,?,?)
                """,
                batch,
            )
            conn.commit()
            print(f"[build] entries={total_entries} rows={total_rows}")
            batch = []

        elem.clear()

    if batch:
        conn.executemany(
            """
            INSERT INTO entries(
                surface, lemma, reading, gloss, gloss_zh, gloss_en, pos
            ) VALUES(?,?,?,?,?,?,?)
            """,
            batch,
        )
        conn.commit()

    conn.close()
    print(f"Done. Parsed entries={total_entries}, inserted rows={total_rows}")
    print(f"DB path: {db_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build SQLite dictionary from JMDict XML")
    parser.add_argument("--xml", required=True, help="Path to JMdict_e.xml")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="Output SQLite path")
    args = parser.parse_args()

    xml_path = Path(args.xml).expanduser().resolve()
    db_path = Path(args.db).expanduser().resolve()
    if not xml_path.exists():
        raise FileNotFoundError(f"XML not found: {xml_path}")

    build_db(xml_path, db_path)


if __name__ == "__main__":
    main()
