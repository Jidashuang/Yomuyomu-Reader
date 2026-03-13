import {
  chapterIndexById as chapterIndexByIdForBook,
  clampChapterIndex as clampChapterIndexForBook,
} from "../../utils/chapters.js";

export function createReaderNavigation({
  state,
  els,
  isAccountModalOpen,
  closeAccountModal,
  normalizeReadingMode,
  isPagedMode,
  syncReaderState,
  initialRenderedChapterCount,
  ensureRenderedThrough,
  persistCurrentChapterState,
  renderReader,
  renderHardWords,
  scheduleDifficultyPaint,
  updateChapterHeader,
  updateTocHighlight,
  ensureChapterLoaded,
  renderAll,
  prefetchNextChapter,
  syncReadingProgress,
  readerScrollContainer,
  setStatus,
  renderBookMeta,
  renderChapterList,
  scrollReaderToTop,
  flashChapterHeader,
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

  function chapterIndexById(chapterId) {
    return chapterIndexByIdForBook(state.book, chapterId);
  }

  function clampChapterIndex(index) {
    return clampChapterIndexForBook(index, state.book);
  }

  function onChapterListClick(event) {
    const button = event.target.closest("[data-chapter]");
    if (!button) return;
    const chapterIndex = Number(button.dataset.chapter);
    void setCurrentChapter(chapterIndex);
  }

  async function setCurrentChapter(index) {
    setCurrentChapterIndex(index);
    if (currentReadingMode() === "scroll") {
      state.scrollBaseChapter = state.currentChapter;
      state.renderedChapterCount = initialRenderedChapterCount();
    } else {
      state.renderedChapterCount = 1;
    }
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
    ensureRenderedThrough(state.currentChapter);
    updateChapterHeader();
    updateTocHighlight();
    persistCurrentChapterState();
    renderReader({ preserveScroll: false });
    renderHardWords();
    scheduleDifficultyPaint();
    if (isPagedMode()) {
      renderCurrentPage();
    } else {
      scrollToChapter(state.currentChapter, true);
    }
    try {
      await ensureChapterLoaded(state.currentChapter, { prefetch: false });
      renderAll();
      if (isPagedMode()) {
        syncReaderState({ currentPageIndex: 0 });
        renderCurrentPage();
      }
      void prefetchNextChapter(state.currentChapter);
      if (!isPagedMode()) {
        const nextIndex = clampChapterIndex(state.currentChapter + 1);
        if (nextIndex !== state.currentChapter) {
          void ensureChapterLoaded(nextIndex, { prefetch: true }).then(() => {
            renderReader({ preserveScroll: true });
          });
        }
      }
      updateReaderProgress();
    } catch (error) {
      setStatus(`章节加载失败：${error.message}`, true);
    }
  }

  function scrollToChapter(index, smooth = false) {
    const chapterIndex = clampChapterIndex(index);
    const scrollContainer = readerScrollContainer();
    if (currentReadingMode() === "scroll") {
      const block = els.readerContent.querySelector(`.chapter-block[data-chapter="${chapterIndex}"]`);
      if (block) {
        scrollContainer.scrollTo({
          top: Math.max(0, block.offsetTop - 6),
          behavior: smooth ? "smooth" : "auto",
        });
        return;
      }
    }
    scrollContainer.scrollTo({
      top: 0,
      behavior: smooth ? "smooth" : "auto",
    });
  }

  function onReaderScroll() {
    if (isPagedMode()) {
      syncPagedPageState();
      return;
    }
    if (state.scrollTicking) return;
    state.scrollTicking = true;
    requestAnimationFrame(() => {
      state.scrollTicking = false;
      syncCurrentChapterByScroll();
      maybeLoadMoreChapters();
    });
  }

  function hasNextChapter() {
    if (!state.book?.chapters?.length) return false;
    return state.currentChapter < state.book.chapters.length - 1;
  }

  function hasPrevChapter() {
    if (!state.book?.chapters?.length) return false;
    return state.currentChapter > 0;
  }

  function getPagedStep(viewportHeight = readerScrollContainer().clientHeight) {
    return Math.max(120, Math.floor(Math.max(1, viewportHeight) * 0.92));
  }

  function getPagedMetrics() {
    const scrollContainer = readerScrollContainer();
    const viewport = Math.max(1, Math.floor(scrollContainer.clientHeight || 1));
    const step = getPagedStep(viewport);
    const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - viewport);
    const totalPagesInChapter = Math.max(1, Math.floor(maxScrollTop / step) + 1);
    const scrollTop = Math.max(0, Math.min(maxScrollTop, Number(scrollContainer.scrollTop) || 0));
    const currentPageIndex = Math.max(
      0,
      Math.min(totalPagesInChapter - 1, Math.floor((scrollTop + 0.5) / step))
    );
    return {
      scrollContainer,
      viewport,
      step,
      maxScrollTop,
      totalPagesInChapter,
      currentPageIndex,
    };
  }

  function syncPagedPageState() {
    if (!state.book?.chapters?.length || !isPagedMode()) {
      syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
      return { currentPageIndex: 0, totalPagesInChapter: 1, maxScrollTop: 0, step: 1 };
    }
    const { currentPageIndex, totalPagesInChapter, maxScrollTop, step } = getPagedMetrics();
    syncReaderState({ currentPageIndex, totalPagesInChapter });
    return { currentPageIndex, totalPagesInChapter, maxScrollTop, step };
  }

  function getCurrentChapterPageCount() {
    return syncPagedPageState().totalPagesInChapter;
  }

  function updateReaderProgress(location = {}) {
    persistCurrentChapterState();
    void syncReadingProgress(location);
  }

  async function loadChapterByIndex(index) {
    if (!state.book?.chapters?.length) return false;
    const chapterIndex = clampChapterIndex(index);
    setCurrentChapterIndex(chapterIndex);
    if (isPagedMode()) {
      state.renderedChapterCount = 1;
    } else {
      state.scrollBaseChapter = state.currentChapter;
      state.renderedChapterCount = initialRenderedChapterCount();
    }
    persistCurrentChapterState();
    ensureRenderedThrough(state.currentChapter);
    try {
      await ensureChapterLoaded(state.currentChapter, { prefetch: false });
    } catch (error) {
      setStatus(`章节加载失败：${error.message}`, true);
      return false;
    }
    renderReader({ preserveScroll: false });
    renderHardWords();
    scheduleDifficultyPaint();
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
    void prefetchNextChapter(state.currentChapter);
    return true;
  }

  function renderCurrentPage(options = {}) {
    if (!isPagedMode()) return;
    const { scrollContainer, step, maxScrollTop, totalPagesInChapter } = getPagedMetrics();
    const currentPageIndex = Math.max(
      0,
      Math.min(totalPagesInChapter - 1, Number(state.reader?.currentPageIndex) || 0)
    );
    const targetTop = Math.min(currentPageIndex * step, maxScrollTop);
    syncReaderState({ currentPageIndex, totalPagesInChapter });
    scrollContainer.scrollTo({
      top: targetTop,
      behavior: options.smooth ? "smooth" : "auto",
    });
  }

  function maybeLoadMoreChapters() {
    if (currentReadingMode() !== "scroll") return;
    if (!state.book || !state.book.chapters.length) return;
    const base = clampChapterIndex(state.scrollBaseChapter);
    const maxCount = Math.max(1, state.book.chapters.length - base);
    if (state.renderedChapterCount >= maxCount) return;
    const scrollContainer = readerScrollContainer();
    const viewport = scrollContainer.clientHeight;
    const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - viewport);
    const current = scrollContainer.scrollTop;
    if (current < maxScrollTop - 200) return;

    const before = state.renderedChapterCount;
    state.renderedChapterCount = Math.min(maxCount, before + 2);
    if (state.renderedChapterCount !== before) {
      renderReader({ preserveScroll: true });
      const tailChapterIndex = base + state.renderedChapterCount - 1;
      void ensureChapterLoaded(tailChapterIndex, { prefetch: true }).then(() => {
        renderReader({ preserveScroll: true });
      });
    }
  }

  function syncCurrentChapterByScroll() {
    if (!state.book || !state.book.chapters.length) return;
    const containerRect = readerScrollContainer().getBoundingClientRect();
    const blocks = els.readerContent.querySelectorAll(".chapter-block");
    let bestIdx = state.currentChapter;
    let bestDist = Number.POSITIVE_INFINITY;

    blocks.forEach((block) => {
      const rect = block.getBoundingClientRect();
      if (rect.bottom < containerRect.top + 10 || rect.top > containerRect.bottom - 10) return;
      const idx = Number(block.dataset.chapter);
      const dist = Math.abs(rect.top - containerRect.top - 6);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    });

    if (bestIdx !== state.currentChapter) {
      setCurrentChapterIndex(bestIdx);
      syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
      persistCurrentChapterState();
      renderBookMeta();
      renderChapterList();
      renderHardWords();
      scheduleDifficultyPaint();
    }
  }

  function onReaderHotkey(event) {
    if (event.key === "Escape" && isAccountModalOpen()) {
      event.preventDefault();
      closeAccountModal();
      return;
    }
    const target = event.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
      return;
    }
    if (!isPagedMode()) return;
    if (event.key === "PageDown" || event.key === "ArrowRight") {
      event.preventDefault();
      onNextPage();
    } else if (event.key === "PageUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      onPrevPage();
    }
  }

  function onPrevPage() {
    void goPrevPage();
  }

  function onNextPage() {
    void goNextPage();
  }

  async function goNextPage() {
    if (!state.book?.chapters?.length || !isPagedMode()) return false;
    if (state.pageNavInFlight) return false;
    state.pageNavInFlight = true;
    try {
      const { currentPageIndex, totalPagesInChapter } = syncPagedPageState();
      const lastPageIndex = Math.max(0, totalPagesInChapter - 1);
      if (currentPageIndex < lastPageIndex) {
        syncReaderState({ currentPageIndex: currentPageIndex + 1, totalPagesInChapter });
        triggerPageTurn("next");
        renderCurrentPage({ smooth: true });
        updateReaderProgress();
        return true;
      }

      if (!hasNextChapter()) return false;
      const nextChapterIndex = clampChapterIndex(state.currentChapter + 1);
      const loaded = await loadChapterByIndex(nextChapterIndex);
      if (!loaded) return false;

      scrollReaderToTop(false);
      syncReaderState({ currentPageIndex: 0, totalPagesInChapter: getCurrentChapterPageCount() });
      triggerPageTurn("next");
      renderCurrentPage();
      scrollReaderToTop(true);
      updateChapterHeader({ flash: true });
      updateTocHighlight();
      updateReaderProgress();
      return true;
    } finally {
      state.pageNavInFlight = false;
    }
  }

  async function goPrevPage() {
    if (!state.book?.chapters?.length || !isPagedMode()) return false;
    if (state.pageNavInFlight) return false;
    state.pageNavInFlight = true;
    try {
      const { currentPageIndex, totalPagesInChapter } = syncPagedPageState();
      if (currentPageIndex > 0) {
        syncReaderState({ currentPageIndex: currentPageIndex - 1, totalPagesInChapter });
        triggerPageTurn("prev");
        renderCurrentPage({ smooth: true });
        updateReaderProgress();
        return true;
      }

      if (!hasPrevChapter()) return false;
      const prevChapterIndex = clampChapterIndex(state.currentChapter - 1);
      const loaded = await loadChapterByIndex(prevChapterIndex);
      if (!loaded) return false;

      scrollReaderToTop(false);
      const totalPages = getCurrentChapterPageCount();
      syncReaderState({
        currentPageIndex: Math.max(0, totalPages - 1),
        totalPagesInChapter: totalPages,
      });
      triggerPageTurn("prev");
      renderCurrentPage();
      updateChapterHeader({ flash: true });
      updateTocHighlight();
      updateReaderProgress();
      return true;
    } finally {
      state.pageNavInFlight = false;
    }
  }

  function triggerPageTurn(direction) {
    const className = direction === "prev" ? "page-turn-prev" : "page-turn-next";
    els.readerContent.classList.remove("page-turn-prev", "page-turn-next");
    void els.readerContent.offsetWidth;
    els.readerContent.classList.add(className);
    if (state.pageTurnTimerId) {
      clearTimeout(state.pageTurnTimerId);
    }
    state.pageTurnTimerId = setTimeout(() => {
      els.readerContent.classList.remove("page-turn-prev", "page-turn-next");
      state.pageTurnTimerId = null;
    }, 320);
  }

  return {
    chapterIndexById,
    clampChapterIndex,
    onChapterListClick,
    setCurrentChapter,
    scrollToChapter,
    onReaderScroll,
    hasNextChapter,
    hasPrevChapter,
    getPagedStep,
    syncPagedPageState,
    getCurrentChapterPageCount,
    updateReaderProgress,
    loadChapterByIndex,
    renderCurrentPage,
    maybeLoadMoreChapters,
    syncCurrentChapterByScroll,
    onReaderHotkey,
    onPrevPage,
    onNextPage,
    goNextPage,
    goPrevPage,
    triggerPageTurn,
  };
}
