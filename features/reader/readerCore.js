import { getChapterAt, getChapterById as getChapterByIdForBook } from "../../utils/chapters.js";
import { normalizeBook as normalizeBookData } from "../../utils/normalize.js";

// Reader core keeps rendering/opening flow together while allowing reader.js to stay a thin entry.
export function createReaderCore({
  state,
  els,
  SAMPLE_BOOK,
  fetchJson,
  wait,
  checkApiHealth,
  setStatus,
  updateBilling,
  normalizeReadingMode,
  clampChapterIndex,
  chapterIndexById,
  syncReaderState,
  resetReaderTransientState,
  resetReaderAnalysisCaches,
  stopAutoPage,
  persistBookState,
  persistCurrentChapterState,
  clearPersistedBookState,
  renderAll,
  renderHardWords,
  requestAnalyze,
  readerScrollContainer,
  scheduleDifficultyPaint,
  markSelection,
  isPagedMode,
  syncPagedPageState,
  getKnownRanges,
  getNoteRanges,
  getDifficultyRanges,
  getSentenceRangesForParagraph,
  findRangeHit,
  shouldHighlightLevel,
  clampNumber,
  syncReadingProgressExternal,
}) {
  const readerSessionStore = state.readerStore?.sessionState;

  function currentReadingMode() {
    return normalizeReadingMode(state.settingsStore?.readingMode || state.settings?.readingMode);
  }

  function setCurrentChapterIndex(chapterIndex) {
    if (readerSessionStore?.setCurrentChapter) {
      readerSessionStore.setCurrentChapter(chapterIndex);
      return;
    }
    state.currentChapter = clampChapterIndex(chapterIndex);
  }

  function hydrateBook() {
    if (!state.book || !Array.isArray(state.book.chapters)) return;
    state.book = normalizeBook(state.book);
    setCurrentChapterIndex(state.currentChapter);
    state.scrollBaseChapter = state.currentChapter;
    state.renderedChapterCount = initialRenderedChapterCount();
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
  }

  function normalizeBook(rawBook) {
    return normalizeBookData(rawBook);
  }

  function currentChapterData() {
    return getChapterAt(state.book, clampChapterIndex(state.currentChapter));
  }

  function getChapterById(chapterId) {
    return getChapterByIdForBook(state.book, chapterId);
  }

  function chapterIsLoaded(chapter) {
    return Boolean(chapter && Array.isArray(chapter.paragraphs) && chapter.paragraphs.length);
  }

  function mergeChapterPayload(chapterPayload) {
    if (!state.book || !Array.isArray(state.book.chapters) || !chapterPayload) return null;
    const chapterId = String(chapterPayload.id || "");
    const index = state.book.chapters.findIndex((item) => item.id === chapterId);
    if (index < 0) return null;
    const normalized = normalizeBook({
      ...state.book,
      chapters: state.book.chapters.map((chapter, chapterIndex) =>
        chapterIndex === index ? { ...chapter, ...chapterPayload } : chapter
      ),
    });
    state.book = normalized;
    persistBookState();
    return state.book.chapters[index];
  }

  async function fetchBookMetadata(bookId) {
    const payload = await fetchJson(
      `/api/books/${encodeURIComponent(bookId)}?userId=${encodeURIComponent(state.sync.userId)}`,
      { method: "GET" },
      12000
    );
    if (!payload.ok || !payload.book) {
      throw new Error(payload.error || "读取书籍目录失败");
    }
    return payload.book;
  }

  async function fetchChapterPayload(bookId, chapterId) {
    const payload = await fetchJson(
      `/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(
        chapterId
      )}?userId=${encodeURIComponent(state.sync.userId)}`,
      { method: "GET" },
      12000
    );
    if (!payload.ok || !payload.chapter) {
      throw new Error(payload.error || "读取章节失败");
    }
    return payload.chapter;
  }

  async function fetchSampleBook() {
    const payload = await fetchJson(
      `/api/sample-book?userId=${encodeURIComponent(state.sync.userId)}`,
      { method: "GET" },
      12000
    );
    if (!payload.ok || !payload.book) {
      throw new Error(payload.error || "示例书不可用");
    }
    return payload.book;
  }

  async function ensureChapterLoaded(chapterIndex, options = {}) {
    const chapter = state.book?.chapters?.[clampChapterIndex(chapterIndex)];
    if (!chapter || !state.book?.id || !state.apiOnline) return chapter || null;
    if (chapterIsLoaded(chapter) && !options.force) return chapter;
    if (options.prefetch !== true) {
      setStatus(`正在加载 ${chapter.title} ...`);
    }
    const payload = await fetchChapterPayload(state.book.id, chapter.id);
    return mergeChapterPayload(payload);
  }

  async function prefetchNextChapter(chapterIndex = state.currentChapter) {
    if (!state.book?.id || !state.apiOnline) return;
    const nextIndex = clampChapterIndex(Number(chapterIndex) + 1);
    if (nextIndex === clampChapterIndex(chapterIndex)) return;
    const nextChapter = state.book?.chapters?.[nextIndex];
    if (!nextChapter || chapterIsLoaded(nextChapter)) return;
    try {
      await ensureChapterLoaded(nextIndex, { prefetch: true });
    } catch {
      // Ignore prefetch failures. Reading should stay uninterrupted.
    }
  }

  async function syncReadingProgress(location = {}) {
    if (typeof syncReadingProgressExternal === "function") {
      return syncReadingProgressExternal(location);
    }
    if (!state.apiOnline || !state.book?.id) return;
    const chapter = currentChapterData();
    if (!chapter) return;
    try {
      await fetchJson(
        `/api/books/${encodeURIComponent(state.book.id)}/progress`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: state.sync.userId,
            chapterId: String(location.chapterId || chapter.id || ""),
            chapterIndex: Number(location.chapterIndex ?? state.currentChapter) || 0,
            paragraphIndex: Number(location.paraIndex ?? 0) || 0,
            charIndex: Number(location.charIndex ?? 0) || 0,
          }),
        },
        4000
      );
    } catch {
      // Ignore progress sync failures. Local reading state remains primary.
    }
  }

  async function bootstrapBookExperience() {
    if (state.book?.id && state.apiOnline) {
      try {
        const metadata = await fetchBookMetadata(state.book.id);
        await setBook(normalizeBook(metadata), {
          chapterIndex:
            Number(metadata.progress?.chapterIndex) ||
            Number(metadata.chapters?.findIndex?.((item) => item.id === metadata.progress?.chapterId)) ||
            state.currentChapter,
          syncProgress: false,
        });
        return;
      } catch {
        // Fall through to sample fallback.
      }
    }
    if (!state.book) {
      await onLoadSampleBook({ silentStatus: true });
    } else if (state.book?.id && state.apiOnline) {
      try {
        await ensureChapterLoaded(state.currentChapter, { prefetch: false });
        renderAll();
        void prefetchNextChapter(state.currentChapter);
        if (currentReadingMode() === "scroll") {
          const nextIndex = clampChapterIndex(state.currentChapter + 1);
          if (nextIndex !== state.currentChapter) {
            void ensureChapterLoaded(nextIndex, { prefetch: true }).then(() => {
              renderReader({ preserveScroll: true });
            });
          }
        }
      } catch {
        // Keep local snapshot if refresh fails.
      }
    }
  }

  async function onFileChange(event) {
    const [file] = event.target.files || [];
    if (!file) return;
    await importBookFile(file);
    els.fileInput.value = "";
  }

  async function onLoadSampleBook(options = {}) {
    if (!state.apiOnline) {
      await checkApiHealth();
    }
    try {
      if (state.apiOnline) {
        const sampleBook = await fetchSampleBook();
        await setBook(normalizeBook(sampleBook), {
          chapterIndex: Number(sampleBook.progress?.chapterIndex) || 0,
          syncProgress: false,
        });
      } else {
        await setBook(normalizeBook(SAMPLE_BOOK), { syncProgress: false });
      }
      if (!options.silentStatus) {
        setStatus("示例书籍已就绪。");
      }
    } catch (error) {
      await setBook(normalizeBook(SAMPLE_BOOK), { syncProgress: false });
      if (!options.silentStatus) {
        setStatus(`示例书载入失败，已回退本地示例：${error.message}`, true);
      }
    }
  }

  function sampleBookToImportFile() {
    const text = SAMPLE_BOOK.chapters
      .map((chapter) => `${chapter.title}\n${chapter.text}`)
      .join("\n\n");
    return new File([text], "sample-novel.txt", { type: "text/plain" });
  }

  async function importBookFile(file, options = {}) {
    const ext = file.name.split(".").pop().toLowerCase();
    const isTxt = ext === "txt";
    const isGuest = state.sync.accountMode !== "registered";
    setStatus(`正在导入 ${file.name} ...`);

    if (!isTxt && !state.apiOnline) {
      await checkApiHealth();
    }

    if (state.apiOnline) {
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("userId", state.sync.userId || "");
        const payload = await fetchJson(
          "/api/books/import",
          {
            method: "POST",
            body: formData,
          },
          12000
        );
        const jobId = String(payload.jobId || payload.job?.jobId || "");
        if (!jobId) throw new Error("导入任务未返回 jobId");
        state.activeImportJobId = jobId;
        const job = await pollImportJob(jobId);
        const importedBook = await fetchImportedBook(job.bookId);
        await setBook(normalizeBook(importedBook), {
          chapterIndex: Number(importedBook.progress?.chapterIndex) || 0,
          syncProgress: false,
          persistLocal: !isGuest,
        });
        setStatus(
          String(
            options.successMessage ||
              (isGuest
                ? `已导入 ${file.name}（游客会话内可读，刷新后可能消失）。`
                : `已导入 ${file.name}，共 ${state.book.chapters.length} 章。`)
          )
        );
        return;
      } catch (error) {
        if (error?.payload?.billing) {
          updateBilling(error.payload.billing);
        }
        setStatus(`后端导入失败：${error.message}`, true);
      }
    }

    if (isTxt) {
      const text = await file.text();
      const book = normalizeBook({
        title: file.name.replace(/\.txt$/i, ""),
        format: "txt",
        chapters: [{ title: "正文", text }],
      });
      await setBook(book, { syncProgress: false, persistLocal: !isGuest });
      setStatus(isGuest ? "已按 TXT 方式导入（游客会话内可读）。" : "已按 TXT 方式导入。");
      return;
    }

    const openHint =
      window.location.protocol === "file:"
        ? "当前是本地文件打开，请改为访问 `http://127.0.0.1:8000`。"
        : "";
    setStatus(`该格式需要后端 API。请使用 \`python3 backend/server.py\` 启动。${openHint}`, true);
  }

  async function pollImportJob(jobId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120000) {
      const payload = await fetchJson(`/api/import-jobs/${encodeURIComponent(jobId)}`, {
        method: "GET",
      });
      const job = payload.job || {};
      if (job.status === "completed") return job;
      if (job.status === "failed") {
        throw new Error(job.error || "导入失败");
      }
      await wait(300);
    }
    throw new Error("导入超时");
  }

  async function fetchImportedBook(bookId) {
    return fetchBookMetadata(bookId);
  }

  async function setBook(book, options = {}) {
    stopAutoPage();
    state.book = normalizeBook(book);
    const initialChapter =
      Number.isFinite(Number(options.chapterIndex)) && Number(options.chapterIndex) >= 0
        ? Number(options.chapterIndex)
        : Number(state.book?.progress?.chapterIndex) || 0;
    setCurrentChapterIndex(initialChapter);
    state.scrollBaseChapter = state.currentChapter;
    state.renderedChapterCount = initialRenderedChapterCount();
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
    resetReaderTransientState({
      chapterId: state.book?.chapters?.[state.currentChapter]?.id || "",
      chapterIndex: state.currentChapter,
      paraIndex: 0,
      charIndex: 0,
    });
    resetReaderAnalysisCaches();
    persistBookState({ persistLocal: options.persistLocal });
    renderAll();
    readerScrollContainer().scrollTop = 0;
    requestAnalyze(true);
    if (state.apiOnline && state.book?.id) {
      try {
        await ensureChapterLoaded(state.currentChapter, { prefetch: false });
        renderAll();
        void prefetchNextChapter(state.currentChapter);
        if (currentReadingMode() === "scroll") {
          const nextIndex = clampChapterIndex(state.currentChapter + 1);
          if (nextIndex !== state.currentChapter) {
            void ensureChapterLoaded(nextIndex, { prefetch: true }).then(() => {
              renderReader({ preserveScroll: true });
            });
          }
        }
        if (options.syncProgress !== false) {
          void syncReadingProgress();
        }
      } catch (error) {
        setStatus(`章节加载失败：${error.message}`, true);
      }
    }
  }

  function initialRenderedChapterCount() {
    if (!state.book?.chapters?.length) return 0;
    return currentReadingMode() === "scroll" ? 2 : 1;
  }

  function ensureRenderedThrough(chapterIndex) {
    if (currentReadingMode() !== "scroll") return true;
    const base = clampChapterIndex(state.scrollBaseChapter);
    if (chapterIndex < base) {
      state.scrollBaseChapter = chapterIndex;
      state.renderedChapterCount = initialRenderedChapterCount();
      return true;
    }
    const needed = chapterIndex - base + 1;
    if (needed > state.renderedChapterCount) {
      state.renderedChapterCount = needed;
    }
    return true;
  }

  function renderBookMeta() {
    if (!state.book || !state.book.chapters.length) {
      els.bookTitle.textContent = "未导入书籍";
      if (els.bookAuthor) {
        els.bookAuthor.hidden = true;
        els.bookAuthor.textContent = "作者: -";
      }
      els.bookMeta.textContent = "格式: -";
      els.chapterCount.textContent = "章节: 0";
      els.chapterTitle.textContent = "阅读区";
      els.chapterProgress.textContent = "章节 0 / 0";
      return;
    }
    const chapter = currentChapterData();
    els.bookTitle.textContent = state.book.title;
    const author = String(state.book.author || "").trim();
    if (els.bookAuthor) {
      els.bookAuthor.hidden = !author;
      els.bookAuthor.textContent = `作者: ${author || "-"}`;
    }
    els.bookMeta.textContent = `格式: ${state.book.format.toUpperCase()}`;
    els.chapterCount.textContent = `章节: ${state.book.chapters.length}`;
    els.chapterTitle.textContent = chapter.title;
    els.chapterProgress.textContent = `章节 ${state.currentChapter + 1} / ${state.book.chapters.length}`;
  }

  function renderChapterList() {
    els.chapterList.textContent = "";
    if (!state.book || !state.book.chapters.length) {
      const li = document.createElement("li");
      li.className = "simple-item";
      li.textContent = "暂无章节";
      els.chapterList.appendChild(li);
      return;
    }
    state.book.chapters.forEach((chapter, idx) => {
      const li = document.createElement("li");
      li.className = `simple-item${idx === state.currentChapter ? " active" : ""}`;
      const button = document.createElement("button");
      button.className = "tiny-btn";
      button.dataset.chapter = String(idx);
      button.textContent = chapter.title;
      li.appendChild(button);
      els.chapterList.appendChild(li);
    });
  }

  function chapterIndexesForRender() {
    if (!state.book || !state.book.chapters.length) return [];
    const mode = currentReadingMode();
    if (mode === "paged") {
      return [clampChapterIndex(state.currentChapter)];
    }
    const base = clampChapterIndex(state.scrollBaseChapter);
    state.scrollBaseChapter = base;
    const maxCount = Math.max(1, state.book.chapters.length - base);
    const fallbackCount = initialRenderedChapterCount();
    state.renderedChapterCount = clampNumber(Number(state.renderedChapterCount) || fallbackCount, 1, maxCount);
    const indexes = [];
    for (let offset = 0; offset < state.renderedChapterCount; offset += 1) {
      indexes.push(base + offset);
    }
    return indexes;
  }

  function renderLoadingChapterBlock(chapter, chapterIndex) {
    const block = document.createElement("section");
    block.className = "chapter-block loading";
    block.dataset.chapter = String(chapterIndex);
    block.dataset.chapterId = chapter.id;

    const heading = document.createElement("h3");
    heading.className = "chapter-heading";
    heading.textContent = `${chapterIndex + 1}. ${chapter.title}`;
    block.appendChild(heading);

    const p = document.createElement("p");
    p.className = "empty-tip";
    p.textContent = `正在加载 ${chapter.title} ...`;
    block.appendChild(p);
    return block;
  }

  function renderChapterBlock(chapter, chapterIndex) {
    const block = document.createElement("section");
    block.className = "chapter-block";
    block.dataset.chapter = String(chapterIndex);
    block.dataset.chapterId = chapter.id;

    const heading = document.createElement("h3");
    heading.className = "chapter-heading";
    heading.textContent = `${chapterIndex + 1}. ${chapter.title}`;
    block.appendChild(heading);

    chapter.paragraphs.forEach((paragraph, paraIndex) => {
      const para = document.createElement("p");
      para.className = "reader-para";
      para.dataset.chapter = String(chapterIndex);
      para.dataset.chapterId = chapter.id;
      para.dataset.pindex = String(paraIndex);
      para.setAttribute("data-testid", `paragraph-${chapter.id}-${paraIndex}`);

      const knownRanges = getKnownRanges(paragraph);
      const noteRanges = getNoteRanges(chapter.id, paraIndex);
      const difficultyRanges = getDifficultyRanges(chapter.id, paraIndex);

      const sentenceRanges = getSentenceRangesForParagraph(chapter, paraIndex, paragraph);
      sentenceRanges.forEach((sentenceRange) => {
        const sentenceEl = document.createElement("span");
        sentenceEl.className = "sentence-segment";
        sentenceEl.dataset.sentenceId = sentenceRange.id;
        sentenceEl.dataset.chapterId = chapter.id;
        sentenceEl.dataset.pindex = String(paraIndex);
        sentenceEl.dataset.start = String(sentenceRange.start);
        sentenceEl.dataset.end = String(sentenceRange.end);
        sentenceEl.setAttribute("data-testid", `sentence-${chapter.id}-${paraIndex}-${sentenceRange.id}`);
        if (state.selectedSentence?.id === sentenceRange.id) {
          sentenceEl.classList.add("active");
        }

        for (let i = sentenceRange.start; i < sentenceRange.end; i += 1) {
          const span = document.createElement("span");
          span.className = "jp-char";
          span.dataset.index = String(i);
          span.textContent = paragraph[i];

          const knownHit = findRangeHit(knownRanges, i);
          if (knownHit) {
            span.classList.add("known");
            span.dataset.knownWord = knownHit.word;
          }
          const noteHit = findRangeHit(noteRanges, i);
          if (noteHit) {
            span.classList.add("annotated");
          }
          const difficultyHit = findRangeHit(difficultyRanges, i);
          if (difficultyHit?.level) {
            span.setAttribute("data-testid", "jlpt-token");
          }
          if (difficultyHit?.level === "N2" && shouldHighlightLevel("N2")) {
            span.classList.add("jlpt-n2");
          }
          if (difficultyHit?.level === "N1" && shouldHighlightLevel("N1")) {
            span.classList.add("jlpt-n1");
          }
          if (difficultyHit?.level === "N3" && shouldHighlightLevel("N3")) {
            span.classList.add("jlpt-n3");
          }
          sentenceEl.appendChild(span);
        }
        para.appendChild(sentenceEl);
      });
      if (!sentenceRanges.length) {
        for (let i = 0; i < paragraph.length; i += 1) {
          const span = document.createElement("span");
          span.className = "jp-char";
          span.dataset.index = String(i);
          span.textContent = paragraph[i];
          para.appendChild(span);
        }
      }
      block.appendChild(para);
    });

    return block;
  }

  function renderReader(options = {}) {
    const preserveScroll = options.preserveScroll !== false;
    const scrollContainer = readerScrollContainer();
    const prevScrollTop = scrollContainer.scrollTop;
    els.readerContent.textContent = "";
    if (!state.book || !state.book.chapters.length) {
      const p = document.createElement("p");
      p.className = "empty-tip";
      p.textContent = "先导入书籍，开始阅读。";
      els.readerContent.appendChild(p);
      return;
    }
    const chapterIndexes = chapterIndexesForRender();
    chapterIndexes.forEach((chapterIndex) => {
      const chapter = state.book.chapters[chapterIndex];
      if (!chapter) return;
      if (!chapterIsLoaded(chapter)) {
        els.readerContent.appendChild(renderLoadingChapterBlock(chapter, chapterIndex));
        return;
      }
      els.readerContent.appendChild(renderChapterBlock(chapter, chapterIndex));
    });

    scheduleDifficultyPaint();
    markSelection();
    if (preserveScroll) {
      const viewport = scrollContainer.clientHeight;
      const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - viewport);
      scrollContainer.scrollTop = clampNumber(prevScrollTop, 0, maxScrollTop);
    }
    if (isPagedMode()) {
      syncPagedPageState();
    }
  }

  function updateChapterHeader(options = {}) {
    renderBookMeta();
    if (options.flash) {
      flashChapterHeader();
    }
  }

  function updateTocHighlight() {
    renderChapterList();
  }

  function scrollReaderToTop(smooth = false) {
    const scrollContainer = readerScrollContainer();
    if (scrollContainer && scrollContainer !== document.body && scrollContainer !== document.documentElement) {
      scrollContainer.scrollTo({
        top: 0,
        behavior: smooth ? "smooth" : "auto",
      });
      return;
    }
    els.chapterTitle?.scrollIntoView({
      behavior: smooth ? "smooth" : "auto",
      block: "start",
    });
  }

  function flashChapterHeader() {
    if (!els.chapterTitle) return;
    els.chapterTitle.classList.remove("chapter-title-flash");
    void els.chapterTitle.offsetWidth;
    els.chapterTitle.classList.add("chapter-title-flash");
    if (state.chapterTitleFlashTimerId) {
      clearTimeout(state.chapterTitleFlashTimerId);
    }
    state.chapterTitleFlashTimerId = setTimeout(() => {
      els.chapterTitle.classList.remove("chapter-title-flash");
      state.chapterTitleFlashTimerId = null;
    }, 680);
  }

  return {
    hydrateBook,
    normalizeBook,
    currentChapterData,
    getChapterById,
    chapterIsLoaded,
    mergeChapterPayload,
    fetchBookMetadata,
    fetchChapterPayload,
    fetchSampleBook,
    ensureChapterLoaded,
    prefetchNextChapter,
    syncReadingProgress,
    bootstrapBookExperience,
    onFileChange,
    onLoadSampleBook,
    sampleBookToImportFile,
    importBookFile,
    pollImportJob,
    fetchImportedBook,
    setBook,
    initialRenderedChapterCount,
    ensureRenderedThrough,
    renderBookMeta,
    renderChapterList,
    chapterIndexesForRender,
    renderLoadingChapterBlock,
    renderChapterBlock,
    renderReader,
    updateChapterHeader,
    updateTocHighlight,
    scrollReaderToTop,
    flashChapterHeader,
  };
}
