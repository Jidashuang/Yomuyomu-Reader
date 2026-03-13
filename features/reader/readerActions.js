export function createReaderActions({
  state,
  STORAGE_KEYS,
  saveJSON,
  setStatus,
  clampNumber,
  applySettings,
  renderAutoPageUi,
  renderReadingModeUi,
  syncReaderState,
  stopAutoPageExternal,
  renderReader,
  scrollToChapter,
  getCurrentChapterPageCount,
  renderCurrentPage,
  goNextPage,
  clampChapterIndex,
  initialRenderedChapterCount,
  analyzeBookVocabulary,
}) {
  const settingsStore = state.settingsStore;

  function settingsValues() {
    return settingsStore?.values || state.settings;
  }

  function readSetting(key, fallback = "") {
    const value = settingsStore?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
    const settings = settingsValues();
    const fromValues = settings?.[key];
    return fromValues === undefined ? fallback : fromValues;
  }

  function writeSetting(key, value) {
    if (settingsStore?.set) {
      settingsStore.set(key, value);
      return;
    }
    settingsValues()[key] = value;
  }

  function persistSettings() {
    saveJSON(STORAGE_KEYS.settings, settingsValues());
  }

  function normalizeReadingMode(value) {
    return String(value || "").trim() === "paged" ? "paged" : "scroll";
  }

  function isPagedMode() {
    return normalizeReadingMode(readSetting("readingMode", "scroll")) === "paged";
  }

  function requestAnalyze(force = false) {
    if (state.analysisTimerId) {
      clearTimeout(state.analysisTimerId);
      state.analysisTimerId = null;
    }
    const delayMs = force ? 20 : 180;
    state.analysisTimerId = setTimeout(() => {
      state.analysisTimerId = null;
      void analyzeBookVocabulary(force);
    }, delayMs);
  }

  function stopAutoPage() {
    if (!state.autoPageTimerId) return;
    clearInterval(state.autoPageTimerId);
    state.autoPageTimerId = null;
    state.autoPageTicking = false;
    renderAutoPageUi();
  }

  function onToggleAutoPage() {
    if (normalizeReadingMode(readSetting("readingMode", "scroll")) !== "paged") {
      setStatus("自动翻页仅在分页模式下可用。");
      return;
    }
    if (state.autoPageTimerId) {
      stopAutoPage();
      setStatus("自动翻页已关闭。");
    } else {
      startAutoPage();
      setStatus("自动翻页已开启。");
    }
  }

  function onToggleFocusMode() {
    writeSetting("focusMode", !Boolean(readSetting("focusMode", false)));
    persistSettings();
    applySettings();
    setStatus(readSetting("focusMode", false) ? "专注模式已开启。" : "专注模式已关闭。");
  }

  function startAutoPage() {
    if (!state.book || !state.book.chapters.length) {
      setStatus("请先导入书籍后再开启自动翻页。", true);
      return;
    }
    if (normalizeReadingMode(readSetting("readingMode", "scroll")) !== "paged") {
      setStatus("自动翻页仅在分页模式下可用。", true);
      return;
    }
    stopAutoPage();
    const seconds = clampNumber(Number(readSetting("autoPageSeconds", 12)) || 12, 6, 40);
    writeSetting("autoPageSeconds", seconds);
    persistSettings();
    state.autoPageTimerId = setInterval(() => {
      if (state.autoPageTicking) return;
      state.autoPageTicking = true;
      void goNextPage()
        .then((moved) => {
          if (!moved) {
            stopAutoPage();
            setStatus("已到末页，自动翻页停止。");
          }
        })
        .finally(() => {
          state.autoPageTicking = false;
        });
    }, seconds * 1000);
    renderAutoPageUi();
  }

  function setReadingMode(mode, options = {}) {
    const nextMode = normalizeReadingMode(mode);
    const prevMode = normalizeReadingMode(readSetting("readingMode", "scroll"));
    if (nextMode === prevMode) {
      syncReaderState();
      renderReadingModeUi();
      renderAutoPageUi();
      return;
    }
    writeSetting("readingMode", nextMode);
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
    if (options.persist !== false) {
      persistSettings();
    }
    if (nextMode !== "paged") {
      stopAutoPage();
      if (typeof stopAutoPageExternal === "function") {
        stopAutoPageExternal();
      }
    }
    if (state.book?.chapters?.length) {
      state.scrollBaseChapter = clampChapterIndex(state.currentChapter);
      state.renderedChapterCount = nextMode === "scroll" ? initialRenderedChapterCount() : 1;
      renderReader({ preserveScroll: false });
      if (nextMode === "paged") {
        syncReaderState({ currentPageIndex: 0, totalPagesInChapter: getCurrentChapterPageCount() });
        renderCurrentPage();
      } else {
        scrollToChapter(state.currentChapter, false);
      }
    }
    renderReadingModeUi();
    renderAutoPageUi();
    if (options.announce !== false) {
      setStatus(nextMode === "paged" ? "已切换到分页模式。" : "已切换到滚动模式。");
    }
  }

  function adjustFontSize(delta) {
    writeSetting("fontSize", clampNumber((Number(readSetting("fontSize", 21)) || 21) + delta, 16, 32));
    persistSettings();
    applySettings();
  }

  function adjustLineHeight(delta) {
    const next = clampNumber((Number(readSetting("lineHeight", 1.9)) || 1.9) + delta, 1.4, 2.4);
    writeSetting("lineHeight", Math.round(next * 10) / 10);
    persistSettings();
    applySettings();
  }

  return {
    normalizeReadingMode,
    isPagedMode,
    requestAnalyze,
    onToggleAutoPage,
    onToggleFocusMode,
    startAutoPage,
    stopAutoPage,
    setReadingMode,
    adjustFontSize,
    adjustLineHeight,
  };
}
