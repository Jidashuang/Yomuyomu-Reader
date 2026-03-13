export function createReaderSession({ state }) {
  const readerSessionStore = state.readerStore?.sessionState;

  function normalizeSessionReadingMode(value) {
    return String(value || "").trim() === "paged" ? "paged" : "scroll";
  }

  function clampSessionChapterIndex(index) {
    const count = Number(state.book?.chapters?.length) || 0;
    if (count <= 0) return 0;
    return Math.max(0, Math.min(Number(index) || 0, count - 1));
  }

  function syncReaderState(partial = {}) {
    const nextReaderState = {
      mode: normalizeSessionReadingMode(state.settingsStore?.readingMode || state.settings.readingMode),
      currentChapterIndex: clampSessionChapterIndex(state.currentChapter),
      currentPageIndex: Math.max(0, Number(state.reader?.currentPageIndex) || 0),
      totalPagesInChapter: Math.max(1, Number(state.reader?.totalPagesInChapter) || 1),
      ...partial,
    };
    if (readerSessionStore?.setReaderSession) {
      readerSessionStore.setReaderSession(nextReaderState);
      return;
    }
    state.reader = {
      ...state.reader,
      ...nextReaderState,
    };
  }

  function resetReaderTransientState(options = {}) {
    const chapterId = String(options.chapterId || state.book?.chapters?.[state.currentChapter]?.id || "");
    const chapterIndex = Math.max(0, Number(options.chapterIndex ?? state.currentChapter) || 0);
    if (readerSessionStore?.resetTransient) {
      readerSessionStore.resetTransient({
        chapterId,
        chapterIndex,
        paraIndex: Number(options.paraIndex || 0),
        charIndex: Number(options.charIndex || 0),
      });
      return;
    }
    state.selected = null;
    state.selectedSentence = null;
    state.explain = {
      loading: false,
      sentenceId: "",
      cached: false,
      result: null,
      error: "",
    };
    state.selectedRange = null;
    state.lastCursor = {
      chapterId,
      chapterIndex,
      paraIndex: Number(options.paraIndex || 0),
      charIndex: Number(options.charIndex || 0),
    };
  }

  function resetReaderAnalysisCaches() {
    if (readerSessionStore?.resetAnalysisCaches) {
      readerSessionStore.resetAnalysisCaches();
      return;
    }
    state.paragraphTokensCache.clear();
    state.difficultyRangesCache.clear();
    state.difficultyPending.clear();
    state.hardWordsByChapter = new Map();
    state.bookFrequencyStats = null;
    state.analysisReady = false;
  }

  return {
    syncReaderState,
    resetReaderTransientState,
    resetReaderAnalysisCaches,
  };
}
