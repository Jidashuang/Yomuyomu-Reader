from __future__ import annotations

from backend.config import DEFAULT_SAMPLE_BOOK_SLUG


SAMPLE_CHAPTERS = [
    {
        "id": "sample-ch-1",
        "index": 0,
        "title": "第一章 春の駅",
        "paragraphs": [
            "夕方の駅前は、いつもより少しだけ静かだった。",
            "改札を出ると、春の匂いが風に混じっていた。",
            "僕は古い本屋に寄って、文庫本を一冊買った。",
            "ページをめくるたびに、知らない時代の声が聞こえる気がする。",
        ],
    },
    {
        "id": "sample-ch-2",
        "index": 1,
        "title": "第二章 雨の窓",
        "paragraphs": [
            "電車の窓には雨の粒が流れ、街の光がにじんで見えた。",
            "前の席では、小さな子どもが眠そうに母親の肩へ寄りかかっている。",
            "僕は鞄からノートを取り出し、今日の出来事を短く書き留めた。",
        ],
    },
    {
        "id": "sample-ch-3",
        "index": 2,
        "title": "第三章 夜の約束",
        "paragraphs": [
            "終点に着くころには、雨は細い霧に変わっていた。",
            "ホームで深呼吸すると、冷たい空気が肺の奥まで届いた。",
            "明日もまた、同じ時間にこの電車へ乗るだろう。",
            "それでも、今日とは少し違う景色が見える気がした。",
        ],
    },
]


def build_sample_book() -> dict:
    chapters = []
    for chapter in SAMPLE_CHAPTERS:
        paragraphs = list(chapter["paragraphs"])
        chapters.append(
            {
                "id": chapter["id"],
                "index": chapter["index"],
                "title": chapter["title"],
                "text": "\n\n".join(paragraphs),
                "paragraphs": paragraphs,
                "sourceType": "sample",
                "sourceRef": chapter["id"],
            }
        )
    return {
        "title": "YomuYomu Starter Sample",
        "format": "sample",
        "chapterCount": len(chapters),
        "normalizedVersion": 1,
        "importedAt": 0,
        "sourceFileName": "starter-sample",
        "sampleSlug": DEFAULT_SAMPLE_BOOK_SLUG,
        "chapters": chapters,
    }
