import { clampChapterIndex, getChapterAt } from "../utils/chapters.js";

const DEFAULT_STATS = {
  lookupCount: 0,
  totalSeconds: 0,
};

function computeProgressPercent(state) {
  const chapter = getChapterAt(state.book, state.currentChapter);
  if (!chapter || !Array.isArray(chapter.paragraphs) || !chapter.paragraphs.length) return 0;
  const paraIndex = Math.max(0, Number(state.lastCursor?.paraIndex || 0));
  const ratio = (paraIndex + 1) / chapter.paragraphs.length;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

export function createReaderBaseState({ loadJSON, storageKeys }) {
  return {
    apiOnline: false,
    jmdictReady: false,
    lastApiHealthCheckAt: 0,
    apiHealthPromise: null,
    tokenizerBackend: "fallback",
    book: loadJSON(storageKeys.book, null),
    currentChapter: loadJSON(storageKeys.currentChapter, 0),
    vocab: loadJSON(storageKeys.vocab, []),
    notes: loadJSON(storageKeys.notes, []),
    bookmarks: loadJSON(storageKeys.bookmarks, []),
    stats: loadJSON(storageKeys.stats, DEFAULT_STATS),
    selected: null,
    selectedSentence: null,
    explain: {
      loading: false,
      sentenceId: "",
      cached: false,
      result: null,
      error: "",
    },
    selectedRange: null,
    lastSelectionLookupKey: "",
    lastSelectionLookupAt: 0,
    lastCursor: {
      chapterId: "",
      chapterIndex: 0,
      paraIndex: 0,
      charIndex: 0,
    },
    paragraphTokensCache: new Map(),
    difficultyRangesCache: new Map(),
    difficultyPending: new Set(),
    jlptMap: {},
    jlptSource: "none",
    hardWordsByChapter: new Map(),
    bookFrequencyStats: null,
    analysisReady: false,
    analysisRunId: 0,
    analysisTimerId: null,
    activeImportJobId: "",
    renderedChapterCount: 0,
    scrollBaseChapter: 0,
    scrollTicking: false,
    reader: {
      mode: "scroll",
      currentChapterIndex: 0,
      currentPageIndex: 0,
      totalPagesInChapter: 1,
    },
    autoPageTimerId: null,
    autoPageTicking: false,
    pageNavInFlight: false,
    pageTurnTimerId: null,
    timerId: null,
    ttsUtterance: null,
  };
}

export function createReaderStoreView(state) {
  const progress = {};
  Object.defineProperties(progress, {
    chapterId: {
      enumerable: true,
      get() {
        const chapter = getChapterAt(state.book, state.currentChapter);
        return String(state.lastCursor?.chapterId || chapter?.id || "");
      },
    },
    location: {
      enumerable: true,
      get() {
        return {
          chapterIndex: Number(state.lastCursor?.chapterIndex ?? state.currentChapter) || 0,
          paraIndex: Number(state.lastCursor?.paraIndex || 0) || 0,
          charIndex: Number(state.lastCursor?.charIndex || 0) || 0,
        };
      },
    },
    percent: {
      enumerable: true,
      get() {
        return computeProgressPercent(state);
      },
    },
    sentenceIndex: {
      enumerable: true,
      get() {
        return Number(state.selectedSentence?.index || 0) || 0;
      },
    },
  });

  const layout = {};
  Object.defineProperties(layout, {
    fontSize: {
      enumerable: true,
      get() {
        return Number(state.settings?.fontSize || 21) || 21;
      },
    },
    lineHeight: {
      enumerable: true,
      get() {
        return Number(state.settings?.lineHeight || 1.9) || 1.9;
      },
    },
    theme: {
      enumerable: true,
      get() {
        return String(state.settings?.theme || "light");
      },
    },
    contentWidth: {
      enumerable: true,
      get() {
        return String(state.settings?.contentWidth || "comfortable");
      },
    },
  });

  const session = {};
  Object.defineProperties(session, {
    selectedText: {
      enumerable: true,
      get() {
        return String(state.selectedSentence?.text || state.selected?.word || "");
      },
    },
    selectedToken: {
      enumerable: true,
      get() {
        return String(state.selected?.lemma || state.selected?.word || "");
      },
    },
    openPanel: {
      enumerable: true,
      get() {
        return String(state.settings?.rightPanelTab || state.ui?.sidePanel?.tab || "");
      },
    },
    isLoading: {
      enumerable: true,
      get() {
        return Boolean(
          state.explain?.loading || state.activeImportJobId || state.analysisTimerId || state.pageNavInFlight
        );
      },
    },
  });

  const loading = {};
  Object.defineProperties(loading, {
    chapter: {
      enumerable: true,
      get() {
        return Boolean(state.pageNavInFlight);
      },
    },
    analysis: {
      enumerable: true,
      get() {
        return Boolean(state.analysisTimerId || state.difficultyPending?.size);
      },
    },
    import: {
      enumerable: true,
      get() {
        return Boolean(state.activeImportJobId);
      },
    },
  });

  const error = {};
  Object.defineProperties(error, {
    explain: {
      enumerable: true,
      get() {
        return String(state.explain?.error || "");
      },
    },
  });

  function normalizeCursor(cursor = {}) {
    return {
      chapterId: String(cursor.chapterId || ""),
      chapterIndex: Number.isFinite(Number(cursor.chapterIndex)) ? Number(cursor.chapterIndex) : 0,
      paraIndex: Number.isFinite(Number(cursor.paraIndex)) ? Number(cursor.paraIndex) : 0,
      charIndex: Number.isFinite(Number(cursor.charIndex)) ? Number(cursor.charIndex) : 0,
    };
  }

  // Keep reader session mutations in one place so reader modules avoid parallel state copies.
  const sessionState = {
    get currentChapterIndex() {
      return clampChapterIndex(state.currentChapter, state.book);
    },
    setCurrentChapter(index) {
      state.currentChapter = clampChapterIndex(index, state.book);
      return state.currentChapter;
    },
    setReaderSession(partial = {}) {
      state.reader = {
        ...state.reader,
        ...partial,
      };
      return state.reader;
    },
    setLastCursor(cursor = {}) {
      state.lastCursor = normalizeCursor(cursor);
      return state.lastCursor;
    },
    setSelection(partial = {}) {
      if (Object.prototype.hasOwnProperty.call(partial, "selected")) {
        state.selected = partial.selected;
      }
      if (Object.prototype.hasOwnProperty.call(partial, "selectedRange")) {
        state.selectedRange = partial.selectedRange;
      }
      if (Object.prototype.hasOwnProperty.call(partial, "selectedSentence")) {
        state.selectedSentence = partial.selectedSentence;
      }
      return {
        selected: state.selected,
        selectedRange: state.selectedRange,
        selectedSentence: state.selectedSentence,
      };
    },
    setExplain(nextExplain = {}) {
      state.explain = {
        ...state.explain,
        ...(nextExplain || {}),
      };
      return state.explain;
    },
    clearSelection() {
      state.selected = null;
      state.selectedRange = null;
      state.selectedSentence = null;
      return {
        selected: state.selected,
        selectedRange: state.selectedRange,
        selectedSentence: state.selectedSentence,
      };
    },
    resetTransient(options = {}) {
      const chapter = getChapterAt(state.book, clampChapterIndex(state.currentChapter, state.book));
      const chapterId = String(options.chapterId || chapter?.id || "");
      const chapterIndex =
        Number.isFinite(Number(options.chapterIndex)) && Number(options.chapterIndex) >= 0
          ? Number(options.chapterIndex)
          : clampChapterIndex(state.currentChapter, state.book);
      this.clearSelection();
      this.setExplain({
        loading: false,
        sentenceId: "",
        cached: false,
        result: null,
        error: "",
      });
      this.setLastCursor({
        chapterId,
        chapterIndex,
        paraIndex: Number(options.paraIndex || 0),
        charIndex: Number(options.charIndex || 0),
      });
    },
    resetAnalysisCaches() {
      state.paragraphTokensCache.clear();
      state.difficultyRangesCache.clear();
      state.difficultyPending.clear();
      state.hardWordsByChapter = new Map();
      state.bookFrequencyStats = null;
      state.analysisReady = false;
    },
  };

  const readerStore = {
    progress,
    layout,
    session,
    loading,
    error,
    sessionState,
  };

  Object.defineProperties(readerStore, {
    currentBookId: {
      enumerable: true,
      get() {
        return String(state.book?.id || "");
      },
    },
    currentChapterId: {
      enumerable: true,
      get() {
        const chapter = getChapterAt(state.book, clampChapterIndex(state.currentChapter, state.book));
        return String(chapter?.id || state.lastCursor?.chapterId || "");
      },
    },
  });

  return readerStore;
}
