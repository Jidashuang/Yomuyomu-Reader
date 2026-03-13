function normalizeChapterList(chaptersOrBook) {
  if (Array.isArray(chaptersOrBook)) return chaptersOrBook;
  if (Array.isArray(chaptersOrBook?.chapters)) return chaptersOrBook.chapters;
  return [];
}

export function clampChapterIndex(index, chaptersOrBook) {
  const chapters = normalizeChapterList(chaptersOrBook);
  if (!chapters.length) return 0;
  return Math.max(0, Math.min(Number(index) || 0, chapters.length - 1));
}

export function chapterIndexById(chaptersOrBook, chapterId) {
  const chapters = normalizeChapterList(chaptersOrBook);
  if (!chapters.length) return 0;
  const target = String(chapterId || "");
  if (!target) return 0;
  const idx = chapters.findIndex((chapter) => String(chapter?.id || "") === target);
  return idx >= 0 ? idx : 0;
}

export function getChapterById(chaptersOrBook, chapterId) {
  const chapters = normalizeChapterList(chaptersOrBook);
  if (!chapters.length) return null;
  const target = String(chapterId || "");
  if (!target) return null;
  return chapters.find((chapter) => String(chapter?.id || "") === target) || null;
}

export function getChapterAt(chaptersOrBook, index) {
  const chapters = normalizeChapterList(chaptersOrBook);
  if (!chapters.length) return null;
  return chapters[clampChapterIndex(index, chapters)] || null;
}
