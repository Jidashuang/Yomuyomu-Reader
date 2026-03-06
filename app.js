const STORAGE_KEYS = {
  book: "yomuyomu_book_v2",
  currentChapter: "yomuyomu_current_chapter_v2",
  vocab: "yomuyomu_vocab_v2",
  notes: "yomuyomu_notes_v2",
  bookmarks: "yomuyomu_bookmarks_v2",
  settings: "yomuyomu_settings_v2",
  stats: "yomuyomu_stats_v2",
  sync: "yomuyomu_sync_v2",
};

const DAY_MS = 24 * 60 * 60 * 1000;

const SAMPLE_BOOK = {
  title: "Sample Novel",
  format: "txt",
  chapters: [
    {
      title: "第一章 春の駅",
      text: `夕方の駅前は、いつもより少しだけ静かだった。
改札を出ると、春の匂いが風に混じっていた。

僕は古い本屋に寄って、文庫本を一冊買った。
ページをめくるたびに、知らない時代の声が聞こえる気がする。`,
    },
    {
      title: "第二章 雨の窓",
      text: `電車の窓には雨の粒が流れ、街の光がにじんで見えた。
前の席では、小さな子どもが眠そうに母親の肩へ寄りかかっている。

僕は鞄からノートを取り出し、今日の出来事を短く書き留めた。`,
    },
    {
      title: "第三章 夜の約束",
      text: `終点に着くころには、雨は細い霧に変わっていた。
ホームで深呼吸すると、冷たい空気が肺の奥まで届いた。

明日もまた、同じ時間にこの電車へ乗るだろう。
それでも、今日とは少し違う景色が見える気がした。`,
    },
  ],
};

const MINI_DICT = {
  夕方: { reading: "ゆうがた", meaning: "傍晚" },
  駅前: { reading: "えきまえ", meaning: "车站前" },
  静か: { reading: "しずか", meaning: "安静、宁静" },
  改札: { reading: "かいさつ", meaning: "检票口（闸机）" },
  春: { reading: "はる", meaning: "春天" },
  匂い: { reading: "におい", meaning: "气味、香气" },
  風: { reading: "かぜ", meaning: "风" },
  本屋: { reading: "ほんや", meaning: "书店" },
  文庫本: { reading: "ぶんこぼん", meaning: "文库本（袖珍本）" },
  一冊: { reading: "いっさつ", meaning: "一册（书）" },
  電車: { reading: "でんしゃ", meaning: "电车" },
  窓: { reading: "まど", meaning: "窗户" },
  雨: { reading: "あめ", meaning: "雨" },
  街: { reading: "まち", meaning: "街道、城市" },
  光: { reading: "ひかり", meaning: "光" },
  終点: { reading: "しゅうてん", meaning: "终点站" },
  ホーム: { reading: "ほーむ", meaning: "站台" },
};

const DEFAULT_SETTINGS = {
  fontSize: 21,
  lineHeight: 1.9,
  readerFont: "mincho",
  focusMode: false,
  rightPanelTab: "lookup",
  ttsRate: 1,
  ttsVoice: "",
  difficultyMode: "n1n2n3",
  mojiScheme: "jp",
  autoPageSeconds: 12,
};

const READER_FONT_MAP = {
  mincho: '"Zen Old Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif',
  noto: '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif',
  shippori: '"Shippori Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif',
  gothic: '"M PLUS 1p", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif',
  rounded: '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif',
};

const HIRAGANA_ONLY_RE = /^[ぁ-ゖー]+$/;
const JP_WORD_RE = /[一-龯々ぁ-ゖァ-ヺー]/;
const KNOWN_WORD_ONLY_RE = /^[一-龯々ぁ-ゖァ-ヺー]+$/;
const KNOWN_WORD_MAX_LEN = 10;
const BLOCKED_POS_RE = /(助詞|助動詞|記号|連体詞|代名詞|接続詞|感動詞|接頭詞|接尾辞|非自立|補助)/;
const HIGHLIGHT_LEVELS = ["N1", "N2", "N3"];
const LEVEL_PRIORITY = { N1: 0, N2: 1, N3: 2 };
const MOJI_SCHEME_MAP = {
  jp: "mojisho://?search=",
  en: "mojishoen4cn://?search=",
};
const MOJI_WEB_SEARCH = "https://www.mojidict.com/searchText/";
const MOJI_WEB_HOME = "https://www.mojidict.com";
const LOCAL_API_ORIGIN = "http://127.0.0.1:8000";
const MAC_DICT_SCHEME = "dict://";

const state = {
  apiOnline: false,
  jmdictReady: false,
  lastApiHealthCheckAt: 0,
  apiHealthPromise: null,
  tokenizerBackend: "fallback",
  book: loadJSON(STORAGE_KEYS.book, null),
  currentChapter: loadJSON(STORAGE_KEYS.currentChapter, 0),
  vocab: loadJSON(STORAGE_KEYS.vocab, []),
  notes: loadJSON(STORAGE_KEYS.notes, []),
  bookmarks: loadJSON(STORAGE_KEYS.bookmarks, []),
  settings: { ...DEFAULT_SETTINGS, ...loadJSON(STORAGE_KEYS.settings, {}) },
  stats: loadJSON(STORAGE_KEYS.stats, {
    lookupCount: 0,
    totalSeconds: 0,
  }),
  sync: loadJSON(STORAGE_KEYS.sync, { userId: "demo-user" }),
  selected: null,
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
  renderedChapterCount: 0,
  scrollTicking: false,
  autoPageTimerId: null,
  pageTurnTimerId: null,
  timerId: null,
  ttsUtterance: null,
};

const els = {
  fileInput: document.getElementById("fileInput"),
  loadSampleBtn: document.getElementById("loadSampleBtn"),
  userIdInput: document.getElementById("userIdInput"),
  pullSyncBtn: document.getElementById("pullSyncBtn"),
  pushSyncBtn: document.getElementById("pushSyncBtn"),
  apiStatus: document.getElementById("apiStatus"),
  statusText: document.getElementById("statusText"),

  bookTitle: document.getElementById("bookTitle"),
  bookMeta: document.getElementById("bookMeta"),
  chapterCount: document.getElementById("chapterCount"),
  chapterList: document.getElementById("chapterList"),
  bookmarkList: document.getElementById("bookmarkList"),
  noteList: document.getElementById("noteList"),
  addBookmarkBtn: document.getElementById("addBookmarkBtn"),

  chapterTitle: document.getElementById("chapterTitle"),
  chapterProgress: document.getElementById("chapterProgress"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  toggleAutoPageBtn: document.getElementById("toggleAutoPageBtn"),
  toggleFocusBtn: document.getElementById("toggleFocusBtn"),
  readerContent: document.getElementById("readerContent"),
  lookupCount: document.getElementById("lookupCount"),
  readingTime: document.getElementById("readingTime"),
  dueCount: document.getElementById("dueCount"),

  selectedWord: document.getElementById("selectedWord"),
  selectedLemma: document.getElementById("selectedLemma"),
  selectedReading: document.getElementById("selectedReading"),
  selectedPos: document.getElementById("selectedPos"),
  selectedMeaning: document.getElementById("selectedMeaning"),
  selectedExample: document.getElementById("selectedExample"),
  addWordBtn: document.getElementById("addWordBtn"),
  addNoteBtn: document.getElementById("addNoteBtn"),
  dictLink: document.getElementById("dictLink"),
  macDictLink: document.getElementById("macDictLink"),
  hardWordList: document.getElementById("hardWordList"),
  refreshHardWordsBtn: document.getElementById("refreshHardWordsBtn"),
  freqSummary: document.getElementById("freqSummary"),
  freqList: document.getElementById("freqList"),

  noteEditorTarget: document.getElementById("noteEditorTarget"),
  noteInput: document.getElementById("noteInput"),
  saveNoteBtn: document.getElementById("saveNoteBtn"),
  clearNoteBtn: document.getElementById("clearNoteBtn"),

  ttsVoiceSelect: document.getElementById("ttsVoiceSelect"),
  ttsRateRange: document.getElementById("ttsRateRange"),
  ttsPlayBtn: document.getElementById("ttsPlayBtn"),
  ttsStopBtn: document.getElementById("ttsStopBtn"),

  difficultyModeSelect: document.getElementById("difficultyModeSelect"),
  mojiSchemeSelect: document.getElementById("mojiSchemeSelect"),
  readerFontSelect: document.getElementById("readerFontSelect"),
  autoPageSecondsRange: document.getElementById("autoPageSecondsRange"),
  autoPageSecondsText: document.getElementById("autoPageSecondsText"),
  fontSizeRange: document.getElementById("fontSizeRange"),
  lineHeightRange: document.getElementById("lineHeightRange"),
  rightTabs: document.getElementById("rightTabs"),
  exportBtn: document.getElementById("exportBtn"),
  vocabList: document.getElementById("vocabList"),
};

init();

function init() {
  bindEvents();
  applySettings();
  hydrateBook();
  renderAll();
  requestAnimationFrame(() => {
    scrollToChapter(state.currentChapter, false);
  });
  checkApiHealth();
  loadJlptMap().then(() => {
    requestAnalyze(true);
  });
  requestAnalyze(false);
  startTimer();
  initTtsVoices();
}

function bindEvents() {
  els.fileInput.addEventListener("change", onFileChange);
  els.loadSampleBtn.addEventListener("click", () => {
    setBook(normalizeBook(SAMPLE_BOOK));
    setStatus("示例书籍已载入。");
  });

  els.chapterList.addEventListener("click", onChapterListClick);
  els.bookmarkList.addEventListener("click", onBookmarkListClick);
  els.noteList.addEventListener("click", onNoteListClick);
  els.addBookmarkBtn.addEventListener("click", onAddBookmark);
  els.prevPageBtn.addEventListener("click", onPrevPage);
  els.nextPageBtn.addEventListener("click", onNextPage);
  els.toggleAutoPageBtn.addEventListener("click", onToggleAutoPage);
  els.toggleFocusBtn.addEventListener("click", onToggleFocusMode);

  els.readerContent.addEventListener("mouseup", onReaderMouseUp);
  els.readerContent.addEventListener("touchend", onReaderTouchEnd, { passive: true });
  els.readerContent.addEventListener("click", onReaderClick);
  document.addEventListener("mouseup", onReaderMouseUp);
  els.readerContent.addEventListener("scroll", onReaderScroll);
  els.addWordBtn.addEventListener("click", onAddWord);
  els.addNoteBtn.addEventListener("click", onAddNoteClick);
  els.dictLink.addEventListener("click", onDictLinkClick);
  els.hardWordList.addEventListener("click", onHardWordListClick);
  els.refreshHardWordsBtn.addEventListener("click", () => {
    requestAnalyze(true);
  });
  els.saveNoteBtn.addEventListener("click", onSaveNote);
  els.clearNoteBtn.addEventListener("click", () => {
    els.noteInput.value = "";
  });

  els.exportBtn.addEventListener("click", exportVocabCsv);
  els.vocabList.addEventListener("click", onVocabAction);
  els.rightTabs.addEventListener("click", onRightTabsClick);

  els.fontSizeRange.addEventListener("input", onSettingsChange);
  els.lineHeightRange.addEventListener("input", onSettingsChange);
  els.difficultyModeSelect.addEventListener("change", onSettingsChange);
  els.mojiSchemeSelect.addEventListener("change", onSettingsChange);
  els.readerFontSelect.addEventListener("change", onSettingsChange);
  els.autoPageSecondsRange.addEventListener("input", onSettingsChange);
  els.ttsRateRange.addEventListener("input", onSettingsChange);
  els.ttsVoiceSelect.addEventListener("change", onSettingsChange);
  els.ttsPlayBtn.addEventListener("click", onPlayTts);
  els.ttsStopBtn.addEventListener("click", onStopTts);

  els.userIdInput.addEventListener("change", onSyncUserChange);
  els.pullSyncBtn.addEventListener("click", onSyncPull);
  els.pushSyncBtn.addEventListener("click", onSyncPush);

  window.addEventListener("beforeunload", () => {
    persistAll();
    onStopTts();
    stopAutoPage();
  });

  window.addEventListener("keydown", onReaderHotkey);
}

function renderAll() {
  renderBookMeta();
  renderChapterList();
  renderReader();
  renderHardWords();
  renderFrequencyStats();
  renderBookmarks();
  renderNotes();
  renderLookupPanel();
  renderStats();
  renderVocab();
  renderSyncUi();
}

function hydrateBook() {
  if (!state.book || !Array.isArray(state.book.chapters)) return;
  state.book = normalizeBook(state.book);
  state.currentChapter = clampChapterIndex(state.currentChapter);
  state.renderedChapterCount = initialRenderedChapterCount();
}

function normalizeBook(rawBook) {
  const chaptersRaw = Array.isArray(rawBook.chapters) ? rawBook.chapters : [];
  const chapters = chaptersRaw
    .map((item, idx) => {
      const text = String(item.text || "").replace(/\r/g, "").trim();
      const paragraphs = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      if (!paragraphs.length) return null;
      return {
        id: String(item.id || `ch-${idx + 1}`),
        title: String(item.title || `Chapter ${idx + 1}`),
        text: paragraphs.join("\n\n"),
        paragraphs,
      };
    })
    .filter(Boolean);

  return {
    title: String(rawBook.title || "Untitled"),
    format: String(rawBook.format || "txt"),
    chapters,
  };
}

function currentChapterData() {
  if (!state.book || !state.book.chapters.length) return null;
  return state.book.chapters[clampChapterIndex(state.currentChapter)];
}

function getChapterById(chapterId) {
  if (!state.book || !state.book.chapters.length) return null;
  return state.book.chapters.find((chapter) => chapter.id === chapterId) || null;
}

function chapterIndexById(chapterId) {
  if (!state.book || !state.book.chapters.length) return 0;
  const idx = state.book.chapters.findIndex((chapter) => chapter.id === chapterId);
  return idx >= 0 ? idx : 0;
}

function clampChapterIndex(index) {
  if (!state.book || !state.book.chapters.length) return 0;
  return Math.max(0, Math.min(Number(index) || 0, state.book.chapters.length - 1));
}

async function onFileChange(event) {
  const [file] = event.target.files || [];
  if (!file) return;
  await importBookFile(file);
  els.fileInput.value = "";
}

async function importBookFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  const isTxt = ext === "txt";
  setStatus(`正在导入 ${file.name} ...`);

  if (!isTxt && !state.apiOnline) {
    await checkApiHealth();
  }

  if (state.apiOnline) {
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(resolveRequestUrl("/api/import"), {
        method: "POST",
        body: formData,
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || "导入失败");
      }
      setBook(normalizeBook(payload.book));
      setStatus(`已导入 ${file.name}，共 ${state.book.chapters.length} 章。`);
      return;
    } catch (error) {
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
    setBook(book);
    setStatus("已按 TXT 方式导入。");
    return;
  }

  const openHint =
    window.location.protocol === "file:"
      ? "当前是本地文件打开，请改为访问 `http://127.0.0.1:8000`。"
      : "";
  setStatus(
    `该格式需要后端 API。请使用 \`python3 backend/server.py\` 启动。${openHint}`,
    true
  );
}

function setBook(book) {
  stopAutoPage();
  state.book = book;
  state.currentChapter = 0;
  state.renderedChapterCount = initialRenderedChapterCount();
  state.selected = null;
  state.selectedRange = null;
  state.lastCursor = {
    chapterId: book?.chapters?.[0]?.id || "",
    chapterIndex: 0,
    paraIndex: 0,
    charIndex: 0,
  };
  state.paragraphTokensCache.clear();
  state.difficultyRangesCache.clear();
  state.difficultyPending.clear();
  state.hardWordsByChapter = new Map();
  state.bookFrequencyStats = null;
  state.analysisReady = false;
  saveJSON(STORAGE_KEYS.book, state.book);
  saveJSON(STORAGE_KEYS.currentChapter, state.currentChapter);
  renderAll();
  els.readerContent.scrollTop = 0;
  requestAnalyze(true);
}

function initialRenderedChapterCount() {
  if (!state.book || !state.book.chapters?.length) return 0;
  return Math.min(Math.max(state.currentChapter + 3, 4), state.book.chapters.length);
}

function ensureRenderedThrough(chapterIndex) {
  if (!state.book || !state.book.chapters.length) return false;
  const target = Math.min(state.book.chapters.length, chapterIndex + 3);
  if (target <= state.renderedChapterCount) return false;
  state.renderedChapterCount = target;
  return true;
}

function renderBookMeta() {
  if (!state.book || !state.book.chapters.length) {
    els.bookTitle.textContent = "未导入书籍";
    els.bookMeta.textContent = "格式: -";
    els.chapterCount.textContent = "章节: 0";
    els.chapterTitle.textContent = "阅读区";
    els.chapterProgress.textContent = "章节 0 / 0";
    return;
  }
  const chapter = currentChapterData();
  els.bookTitle.textContent = state.book.title;
  els.bookMeta.textContent = `格式: ${state.book.format.toUpperCase()}`;
  els.chapterCount.textContent = `章节: ${state.book.chapters.length}`;
  els.chapterTitle.textContent = `${chapter.title} · 连续阅读`;
  els.chapterProgress.textContent = `章节 ${state.currentChapter + 1} / ${
    state.book.chapters.length
  }`;
}

function renderChapterList() {
  els.chapterList.textContent = "";
  if (!state.book || !state.book.chapters.length) {
    appendListEmpty(els.chapterList, "暂无章节");
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

function onChapterListClick(event) {
  const button = event.target.closest("[data-chapter]");
  if (!button) return;
  const chapterIndex = Number(button.dataset.chapter);
  setCurrentChapter(chapterIndex);
}

function setCurrentChapter(index) {
  state.currentChapter = clampChapterIndex(index);
  const expanded = ensureRenderedThrough(state.currentChapter);
  if (expanded) {
    renderReader({ preserveScroll: false });
  }
  saveJSON(STORAGE_KEYS.currentChapter, state.currentChapter);
  renderBookMeta();
  renderChapterList();
  renderHardWords();
  scheduleDifficultyPaint();
  scrollToChapter(state.currentChapter, true);
}

function scrollToChapter(index, smooth = false) {
  const block = els.readerContent.querySelector(`.chapter-block[data-chapter="${index}"]`);
  if (!block) return;
  block.scrollIntoView({
    behavior: smooth ? "smooth" : "auto",
    block: "start",
  });
}

function renderReader(options = {}) {
  const preserveScroll = options.preserveScroll !== false;
  const prevScrollTop = els.readerContent.scrollTop;
  els.readerContent.textContent = "";
  if (!state.book || !state.book.chapters.length) {
    const p = document.createElement("p");
    p.className = "empty-tip";
    p.textContent = "先导入书籍，开始阅读。";
    els.readerContent.appendChild(p);
    return;
  }

  const renderCount =
    state.renderedChapterCount > 0
      ? Math.min(state.renderedChapterCount, state.book.chapters.length)
      : initialRenderedChapterCount();
  state.renderedChapterCount = renderCount;
  const chapters = state.book.chapters.slice(0, renderCount);

  chapters.forEach((chapter, chapterIndex) => {
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

      const knownRanges = getKnownRanges(paragraph);
      const noteRanges = getNoteRanges(chapter.id, paraIndex);
      const difficultyRanges = getDifficultyRanges(chapter.id, paraIndex);

      for (let i = 0; i < paragraph.length; i += 1) {
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
        if (difficultyHit?.level === "N2" && shouldHighlightLevel("N2")) {
          span.classList.add("jlpt-n2");
        }
        if (difficultyHit?.level === "N1" && shouldHighlightLevel("N1")) {
          span.classList.add("jlpt-n1");
        }
        if (difficultyHit?.level === "N3" && shouldHighlightLevel("N3")) {
          span.classList.add("jlpt-n3");
        }
        para.appendChild(span);
      }
      block.appendChild(para);
    });
    els.readerContent.appendChild(block);
  });

  if (renderCount < state.book.chapters.length) {
    const hint = document.createElement("p");
    hint.className = "empty-tip";
    hint.textContent = `继续向下滚动将自动加载后续章节（已加载 ${renderCount}/${state.book.chapters.length}）`;
    els.readerContent.appendChild(hint);
  }

  scheduleDifficultyPaint();
  markSelection();
  if (preserveScroll) {
    const viewport = els.readerContent.clientHeight;
    const maxScrollTop = Math.max(0, els.readerContent.scrollHeight - viewport);
    els.readerContent.scrollTop = clampNumber(prevScrollTop, 0, maxScrollTop);
  }
}

function onReaderScroll() {
  if (state.scrollTicking) return;
  state.scrollTicking = true;
  requestAnimationFrame(() => {
    state.scrollTicking = false;
    syncCurrentChapterByScroll();
    maybeLoadMoreChapters();
  });
}

function maybeLoadMoreChapters() {
  if (!state.book || !state.book.chapters.length) return;
  if (state.renderedChapterCount >= state.book.chapters.length) return;
  const viewport = els.readerContent.clientHeight;
  const maxScrollTop = Math.max(0, els.readerContent.scrollHeight - viewport);
  const current = els.readerContent.scrollTop;
  if (current < maxScrollTop - 200) return;

  const before = state.renderedChapterCount;
  state.renderedChapterCount = Math.min(state.book.chapters.length, before + 2);
  if (state.renderedChapterCount !== before) {
    renderReader({ preserveScroll: true });
  }
}

function syncCurrentChapterByScroll() {
  if (!state.book || !state.book.chapters.length) return;
  const containerRect = els.readerContent.getBoundingClientRect();
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
    state.currentChapter = clampChapterIndex(bestIdx);
    saveJSON(STORAGE_KEYS.currentChapter, state.currentChapter);
    renderBookMeta();
    renderChapterList();
    renderHardWords();
    scheduleDifficultyPaint();
  }
}

function onReaderHotkey(event) {
  const target = event.target;
  const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
    return;
  }
  if (event.key === "PageDown") {
    event.preventDefault();
    onNextPage();
  } else if (event.key === "PageUp") {
    event.preventDefault();
    onPrevPage();
  }
}

function onPrevPage() {
  pageTurnScroll(-1);
}

function onNextPage() {
  pageTurnScroll(1);
}

function pageTurnScroll(direction) {
  if (!state.book || !state.book.chapters.length) return;
  const viewport = els.readerContent.clientHeight;
  const step = Math.max(120, Math.floor(viewport * 0.92));
  const maxScrollTop = els.readerContent.scrollHeight - viewport;
  const current = els.readerContent.scrollTop;
  const target = clampNumber(current + direction * step, 0, maxScrollTop);
  triggerPageTurn(direction > 0 ? "next" : "prev");
  els.readerContent.scrollTo({
    top: target,
    behavior: "smooth",
  });
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

function onToggleAutoPage() {
  if (state.autoPageTimerId) {
    stopAutoPage();
    setStatus("自动翻页已关闭。");
  } else {
    startAutoPage();
    setStatus("自动翻页已开启。");
  }
}

function onToggleFocusMode() {
  state.settings.focusMode = !Boolean(state.settings.focusMode);
  saveJSON(STORAGE_KEYS.settings, state.settings);
  applySettings();
  setStatus(state.settings.focusMode ? "专注模式已开启。" : "专注模式已关闭。");
}

function onRightTabsClick(event) {
  const button = event.target.closest("[data-tab]");
  if (!button) return;
  setRightPanelTab(button.dataset.tab);
}

function setRightPanelTab(tab, persist = true) {
  const nextTab = normalizeRightPanelTab(tab);
  if (state.settings.rightPanelTab === nextTab) return;
  state.settings.rightPanelTab = nextTab;
  if (persist) {
    saveJSON(STORAGE_KEYS.settings, state.settings);
  }
  renderRightTabs();
}

function renderRightTabs() {
  const activeTab = normalizeRightPanelTab(state.settings.rightPanelTab);
  const tabButtons = els.rightTabs.querySelectorAll("[data-tab]");
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === activeTab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  document.querySelectorAll(".right-pane[data-pane]").forEach((pane) => {
    const isActive = pane.dataset.pane === activeTab;
    pane.classList.toggle("active", isActive);
    pane.hidden = !isActive;
  });
}

function startAutoPage() {
  if (!state.book || !state.book.chapters.length) {
    setStatus("请先导入书籍后再开启自动翻页。", true);
    return;
  }
  stopAutoPage();
  const seconds = clampNumber(Number(state.settings.autoPageSeconds) || 12, 6, 40);
  state.settings.autoPageSeconds = seconds;
  saveJSON(STORAGE_KEYS.settings, state.settings);
  state.autoPageTimerId = setInterval(() => {
    const viewport = els.readerContent.clientHeight;
    const maxScrollTop = Math.max(0, els.readerContent.scrollHeight - viewport);
    const current = els.readerContent.scrollTop;
    if (current >= maxScrollTop - 4) {
      stopAutoPage();
      setStatus("已到末页，自动翻页停止。");
      return;
    }
    pageTurnScroll(1);
  }, seconds * 1000);
  renderAutoPageUi();
}

function stopAutoPage() {
  if (!state.autoPageTimerId) return;
  clearInterval(state.autoPageTimerId);
  state.autoPageTimerId = null;
  renderAutoPageUi();
}

function renderAutoPageUi() {
  const on = Boolean(state.autoPageTimerId);
  els.toggleAutoPageBtn.textContent = `自动翻页: ${on ? "开" : "关"}`;
  els.toggleAutoPageBtn.classList.toggle("auto-on", on);
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

async function analyzeBookVocabulary(force = false) {
  if (!state.book || !state.book.chapters.length) {
    state.hardWordsByChapter = new Map();
    state.bookFrequencyStats = null;
    state.analysisReady = false;
    renderHardWords();
    renderFrequencyStats();
    return;
  }
  if (!hasFullJlptMap()) {
    state.hardWordsByChapter = new Map();
    state.bookFrequencyStats = null;
    state.analysisReady = false;
    renderHardWords();
    renderFrequencyStats();
    return;
  }
  if (state.analysisReady && !force) {
    renderHardWords();
    renderFrequencyStats();
    return;
  }

  const runId = ++state.analysisRunId;
  state.analysisReady = false;
  renderHardWords();
  renderFrequencyStats();

  const freqMap = new Map();
  const chapterFreqMaps = new Map();
  let totalTokens = 0;

  for (const chapter of state.book.chapters) {
    const chapterMap = new Map();
    chapterFreqMaps.set(chapter.id, chapterMap);
    for (let paraIndex = 0; paraIndex < chapter.paragraphs.length; paraIndex += 1) {
      const paragraph = chapter.paragraphs[paraIndex];
      const tokens = await getParagraphTokens(chapter.id, paraIndex, paragraph);
      if (runId !== state.analysisRunId) return;

      tokens.forEach((token) => {
        const key = normalizeWordKey(token.lemma || token.surface);
        if (!isAnalyzableWord(token, key)) return;
        totalTokens += 1;
        freqMap.set(key, (freqMap.get(key) || 0) + 1);
        chapterMap.set(key, (chapterMap.get(key) || 0) + 1);
      });
    }
  }

  if (runId !== state.analysisRunId) return;

  const knownSet = new Set(getKnownWords().map((item) => normalizeWordKey(item)));
  const hardWordsByChapter = new Map();

  chapterFreqMaps.forEach((chapterMap, chapterId) => {
    const items = [];
    chapterMap.forEach((count, word) => {
      const level = normalizeJlptLevel(state.jlptMap[word]);
      if (!HIGHLIGHT_LEVELS.includes(level)) return;
      if (knownSet.has(word)) return;
      const local = lookupLocalDictionary(word, word);
      const meaningText = local.meaning?.includes("未命中") ? "点击查看释义" : local.meaning;
      items.push({
        word,
        level,
        count,
        reading: local.reading || "-",
        meaning: meaningText || "点击查看释义",
      });
    });

    items.sort((a, b) => {
      if (a.level !== b.level) return LEVEL_PRIORITY[a.level] - LEVEL_PRIORITY[b.level];
      if (a.count !== b.count) return b.count - a.count;
      return a.word.localeCompare(b.word, "ja");
    });
    hardWordsByChapter.set(chapterId, items.slice(0, 18));
  });

  const topWords = [...freqMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([word, count]) => ({
      word,
      count,
      level: normalizeJlptLevel(state.jlptMap[word]) || "",
    }));

  const levelBuckets = { N1: 0, N2: 0, N3: 0, other: 0 };
  freqMap.forEach((_, word) => {
    const level = normalizeJlptLevel(state.jlptMap[word]);
    if (level === "N1") levelBuckets.N1 += 1;
    else if (level === "N2") levelBuckets.N2 += 1;
    else if (level === "N3") levelBuckets.N3 += 1;
    else levelBuckets.other += 1;
  });

  state.hardWordsByChapter = hardWordsByChapter;
  state.bookFrequencyStats = {
    totalTokens,
    uniqueWords: freqMap.size,
    topWords,
    levelBuckets,
  };
  state.analysisReady = true;
  state.difficultyRangesCache.clear();
  state.difficultyPending.clear();
  scheduleDifficultyPaint(true);
  applyVisibleDifficultyToDom();
  renderHardWords();
  renderFrequencyStats();
}

function renderHardWords() {
  els.hardWordList.textContent = "";
  if (!state.book || !state.book.chapters.length) {
    appendListEmpty(els.hardWordList, "导入书籍后可分析");
    return;
  }
  if (!hasFullJlptMap()) {
    appendListEmpty(els.hardWordList, "请先加载完整 JLPT 词表");
    return;
  }
  if (!state.analysisReady) {
    appendListEmpty(els.hardWordList, "正在分析难词...");
    return;
  }
  const chapter = currentChapterData();
  if (!chapter) {
    appendListEmpty(els.hardWordList, "暂无章节");
    return;
  }
  const list = state.hardWordsByChapter.get(chapter.id) || [];
  if (!list.length) {
    appendListEmpty(els.hardWordList, "该章节暂无高难词");
    return;
  }
  list.forEach((item) => {
    const li = document.createElement("li");
    li.className = "simple-item hardword-item";

    const main = document.createElement("div");
    main.className = "hardword-main";
    const word = document.createElement("strong");
    word.textContent = item.word;
    const tag = document.createElement("span");
    tag.className = `difficulty-tag ${item.level.toLowerCase()}`;
    tag.textContent = item.level;
    main.append(word, tag);

    const desc = document.createElement("p");
    desc.className = "meta";
    desc.textContent = `${item.meaning} · 频次 ${item.count}`;

    const button = document.createElement("button");
    button.className = "tiny-btn";
    button.dataset.hardWord = item.word;
    button.dataset.level = item.level;
    button.textContent = "查看释义";

    li.append(main, desc, button);
    els.hardWordList.appendChild(li);
  });
}

function renderFrequencyStats() {
  els.freqList.textContent = "";
  if (!state.book || !state.book.chapters.length) {
    els.freqSummary.textContent = "导入书籍后可统计";
    appendListEmpty(els.freqList, "暂无统计");
    return;
  }
  if (!hasFullJlptMap()) {
    els.freqSummary.textContent = "请先加载完整 JLPT 词表";
    appendListEmpty(els.freqList, "等待词表");
    return;
  }
  if (!state.analysisReady || !state.bookFrequencyStats) {
    els.freqSummary.textContent = "正在统计词频...";
    appendListEmpty(els.freqList, "分析中");
    return;
  }
  const stats = state.bookFrequencyStats;
  els.freqSummary.textContent = `总词数 ${stats.totalTokens} · 词汇量 ${stats.uniqueWords} · N1 ${stats.levelBuckets.N1} · N2 ${stats.levelBuckets.N2} · N3 ${stats.levelBuckets.N3}`;

  if (!stats.topWords.length) {
    appendListEmpty(els.freqList, "暂无高频词");
    return;
  }

  stats.topWords.slice(0, 14).forEach((item) => {
    const li = document.createElement("li");
    li.className = "simple-item hardword-item";
    const main = document.createElement("div");
    main.className = "hardword-main";
    const word = document.createElement("strong");
    word.textContent = item.word;
    main.appendChild(word);
    if (HIGHLIGHT_LEVELS.includes(item.level)) {
      const tag = document.createElement("span");
      tag.className = `difficulty-tag ${item.level.toLowerCase()}`;
      tag.textContent = item.level;
      main.appendChild(tag);
    }
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `出现 ${item.count} 次`;
    li.append(main, meta);
    els.freqList.appendChild(li);
  });
}

function onHardWordListClick(event) {
  const button = event.target.closest("[data-hard-word]");
  if (!button) return;
  const word = String(button.dataset.hardWord || "").trim();
  const level = String(button.dataset.level || "").trim();
  if (!word) return;
  inspectWordFromList(word, level);
}

function inspectWordFromList(word, level = "") {
  const local = lookupLocalDictionary(word, word);
  const chapter = currentChapterData();
  const hit = chapter ? findWordInChapter(chapter, word) : null;
  const example = hit
    ? extractSentenceExample(chapter.paragraphs[hit.paraIndex], hit.start, hit.end)
    : "未提取到例句";
  state.selected = {
    word,
    lemma: word,
    reading: local.reading || "-",
    pos: "难词速览",
    meaning: local.meaning,
    example,
    jlpt: level || getJlptLevel(word, word),
  };
  setRightPanelTab("lookup", false);
  renderLookupPanel();

  if (!chapter) return;
  if (!hit) return;
  clearSelectionMark();
  state.selectedRange = {
    chapterId: chapter.id,
    paraIndex: hit.paraIndex,
    start: hit.start,
    end: hit.end,
  };
  markSelection();
  const para = els.readerContent.querySelector(
    `.reader-para[data-chapter-id="${chapter.id}"][data-pindex="${hit.paraIndex}"]`
  );
  if (para) {
    para.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function findWordInChapter(chapter, word) {
  for (let i = 0; i < chapter.paragraphs.length; i += 1) {
    const paragraph = chapter.paragraphs[i];
    const start = paragraph.indexOf(word);
    if (start >= 0) {
      return { paraIndex: i, start, end: start + word.length };
    }
  }
  return null;
}

function normalizeWordKey(value) {
  return String(value || "").trim();
}

function isAnalyzableWord(token, word) {
  if (!word) return false;
  if (isBoundary(word)) return false;
  if (!JP_WORD_RE.test(word)) return false;
  if (word.length <= 1) return false;
  if (HIRAGANA_ONLY_RE.test(word)) return false;
  if (token?.pos && BLOCKED_POS_RE.test(String(token.pos))) return false;
  return true;
}

function scheduleDifficultyPaint(force = false) {
  if (!state.book || !state.book.chapters.length) return;
  const minIndex = clampChapterIndex(state.currentChapter - 1);
  const maxIndex = clampChapterIndex(state.currentChapter + 1);
  for (let chapterIndex = minIndex; chapterIndex <= maxIndex; chapterIndex += 1) {
    const chapter = state.book.chapters[chapterIndex];
    if (!chapter) continue;
    chapter.paragraphs.forEach((paragraph, paraIndex) => {
      void ensureDifficultyRanges(chapter.id, paraIndex, paragraph, force);
    });
  }
}

async function ensureDifficultyRanges(chapterId, paraIndex, paragraph, force = false) {
  const key = difficultyKey(chapterId, paraIndex);
  if (!force && state.difficultyRangesCache.has(key)) {
    applyDifficultyToDom(chapterId, paraIndex, getDifficultyRanges(chapterId, paraIndex));
    return;
  }
  if (state.difficultyPending.has(key)) return;
  state.difficultyPending.add(key);
  try {
    const tokens = await getParagraphTokens(chapterId, paraIndex, paragraph);
    const ranges = buildDifficultyRanges(tokens);
    state.difficultyRangesCache.set(key, ranges);
    applyDifficultyToDom(chapterId, paraIndex, ranges);
  } finally {
    state.difficultyPending.delete(key);
  }
}

function buildDifficultyRanges(tokens) {
  return tokens
    .map((token) => {
      const word = normalizeWordKey(token.lemma || token.surface);
      if (!isAnalyzableWord(token, word)) return null;
      return {
        start: token.start,
        end: token.end,
        level: getJlptLevel(token.surface, token.lemma),
      };
    })
    .filter((item) => item && HIGHLIGHT_LEVELS.includes(item.level));
}

function applyDifficultyToDom(chapterId, paraIndex, ranges) {
  const para = els.readerContent.querySelector(
    `.reader-para[data-chapter-id="${chapterId}"][data-pindex="${paraIndex}"]`
  );
  if (!para) return;
  const chars = para.querySelectorAll(".jp-char");
  chars.forEach((charEl) => {
    charEl.classList.remove("jlpt-n1");
    charEl.classList.remove("jlpt-n2");
    charEl.classList.remove("jlpt-n3");
  });
  ranges.forEach((range) => {
    if (!shouldHighlightLevel(range.level)) return;
    for (let i = range.start; i < range.end; i += 1) {
      if (!chars[i]) continue;
      if (range.level === "N1") {
        chars[i].classList.add("jlpt-n1");
      } else if (range.level === "N2") {
        chars[i].classList.add("jlpt-n2");
      } else if (range.level === "N3") {
        chars[i].classList.add("jlpt-n3");
      }
    }
  });
}

function difficultyKey(chapterId, paraIndex) {
  return `${chapterId}:${paraIndex}`;
}

function getDifficultyRanges(chapterId, paraIndex) {
  return state.difficultyRangesCache.get(difficultyKey(chapterId, paraIndex)) || [];
}

function applyVisibleDifficultyToDom() {
  if (!state.book || !state.book.chapters.length) return;
  const minIndex = clampChapterIndex(state.currentChapter - 1);
  const maxIndex = clampChapterIndex(state.currentChapter + 1);
  for (let chapterIndex = minIndex; chapterIndex <= maxIndex; chapterIndex += 1) {
    const chapter = state.book.chapters[chapterIndex];
    if (!chapter) continue;
    chapter.paragraphs.forEach((_, paraIndex) => {
      const ranges = getDifficultyRanges(chapter.id, paraIndex);
      applyDifficultyToDom(chapter.id, paraIndex, ranges);
    });
  }
}

function shouldHighlightLevel(level) {
  const mode = state.settings.difficultyMode || "n1n2n3";
  if (mode === "off") return false;
  if (mode === "n1") return level === "N1";
  if (mode === "n1n2") return level === "N1" || level === "N2";
  return HIGHLIGHT_LEVELS.includes(level);
}

function getKnownRanges(text) {
  const words = getKnownWords()
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const ranges = [];
  for (let i = 0; i < text.length; i += 1) {
    const hit = words.find((word) => text.startsWith(word, i));
    if (hit) {
      ranges.push({ start: i, end: i + hit.length, word: hit });
      i += hit.length - 1;
    }
  }
  return ranges;
}

function normalizeKnownWordCandidate(value) {
  const word = stripWordNoise(value);
  if (!word) return "";
  if (word.length > KNOWN_WORD_MAX_LEN) return "";
  if (/\s/.test(word)) return "";
  if (!KNOWN_WORD_ONLY_RE.test(word)) return "";
  return word;
}

function getKnownWords() {
  const out = new Set();
  state.vocab.forEach((item) => {
    const word = normalizeKnownWordCandidate(item.word);
    const lemma = normalizeKnownWordCandidate(item.lemma);
    if (word) out.add(word);
    if (lemma) out.add(lemma);
  });
  return [...out];
}

function getNoteRanges(chapterId, paraIndex) {
  return state.notes
    .filter((note) => note.chapterId === chapterId && note.paraIndex === paraIndex)
    .map((note) => ({ start: note.start, end: note.end, word: note.word }));
}

function findRangeHit(ranges, index) {
  return ranges.find((item) => index >= item.start && index < item.end);
}

async function onReaderClick(event) {
  const target = event.target.closest(".jp-char");
  if (!target) return;
  const selection = window.getSelection ? window.getSelection() : null;
  if (selection && !selection.isCollapsed) return;
  const isDifficultyWordChar =
    target.classList.contains("jlpt-n1") ||
    target.classList.contains("jlpt-n2") ||
    target.classList.contains("jlpt-n3");
  if (!isDifficultyWordChar) return;
  const para = target.closest(".reader-para");
  if (!para) return;
  const chapterIndex = Number(para.dataset.chapter);
  if (!Number.isFinite(chapterIndex)) return;
  const chapter = state.book?.chapters?.[chapterIndex];
  if (!chapter) return;
  const chapterId = para.dataset.chapterId || chapter.id;
  const paraIndex = Number(para.dataset.pindex);
  const charIndex = Number(target.dataset.index);
  state.lastCursor = { chapterId, chapterIndex, paraIndex, charIndex };
  if (state.currentChapter !== chapterIndex) {
    state.currentChapter = chapterIndex;
    saveJSON(STORAGE_KEYS.currentChapter, state.currentChapter);
    renderBookMeta();
    renderChapterList();
    renderHardWords();
    scheduleDifficultyPaint();
  }
  const paragraph = chapter.paragraphs[paraIndex] || "";
  const token = await findTokenAt(chapterId, paraIndex, paragraph, charIndex, para);
  if (!token) return;
  await selectToken(token, chapterId, chapterIndex, paraIndex);
}

function onReaderMouseUp() {
  window.setTimeout(() => {
    void handleReaderSelectionLookup();
  }, 0);
}

function onReaderTouchEnd() {
  window.setTimeout(() => {
    void handleReaderSelectionLookup();
  }, 80);
}

async function handleReaderSelectionLookup() {
  const selection = window.getSelection ? window.getSelection() : null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const para = getSelectionParagraph(range);
  if (!els.readerContent.contains(para)) return;

  const chapterIndex = Number(para.dataset.chapter);
  const chapter = state.book?.chapters?.[chapterIndex];
  if (!chapter) return;
  const chapterId = para.dataset.chapterId || chapter.id;
  const paraIndex = Number(para.dataset.pindex);
  const paragraph = chapter.paragraphs[paraIndex] || "";
  const selected = getSelectedRangeInParagraph(range, para, paragraph);
  if (!selected) return;
  if (!JP_WORD_RE.test(selected.surface)) return;
  const selectionKey = `${chapterId}:${paraIndex}:${selected.start}:${selected.end}`;
  const now = Date.now();
  if (
    selectionKey === state.lastSelectionLookupKey &&
    now - Number(state.lastSelectionLookupAt || 0) < 360
  ) {
    return;
  }
  state.lastSelectionLookupKey = selectionKey;
  state.lastSelectionLookupAt = now;

  selection.removeAllRanges();
  state.lastCursor = {
    chapterId,
    chapterIndex,
    paraIndex,
    charIndex: selected.start,
  };
  if (state.currentChapter !== chapterIndex) {
    state.currentChapter = chapterIndex;
    saveJSON(STORAGE_KEYS.currentChapter, state.currentChapter);
    renderBookMeta();
    renderChapterList();
    renderHardWords();
    scheduleDifficultyPaint();
  }
  await selectToken(
    {
      surface: selected.surface,
      lemma: selected.surface,
      reading: normalizeReading("", selected.surface),
      pos: "",
      start: selected.start,
      end: selected.end,
    },
    chapterId,
    chapterIndex,
    paraIndex
  );
}

function getSelectionParagraph(range) {
  const probeNodes = [range.commonAncestorContainer, range.startContainer, range.endContainer];
  for (const node of probeNodes) {
    if (!node) continue;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || typeof el.closest !== "function") continue;
    const para = el.closest(".reader-para");
    if (para) return para;
  }
  return null;
}

function getSelectedRangeInParagraph(range, paraEl, paragraph) {
  const chars = paraEl.querySelectorAll(".jp-char");
  let start = Number.POSITIVE_INFINITY;
  let end = -1;
  chars.forEach((charEl, index) => {
    try {
      if (!range.intersectsNode(charEl)) return;
    } catch {
      return;
    }
    if (index < start) start = index;
    if (index > end) end = index;
  });
  if (!Number.isFinite(start) || end < start) return null;
  const safeStart = clampNumber(start, 0, Math.max(0, paragraph.length - 1));
  const safeEnd = clampNumber(end + 1, safeStart + 1, paragraph.length);
  const surface = paragraph.slice(safeStart, safeEnd);
  if (!surface.trim()) return null;
  return { start: safeStart, end: safeEnd, surface };
}

async function findTokenAt(chapterId, paraIndex, paragraph, charIndex, paraEl) {
  const tokens = await getParagraphTokens(chapterId, paraIndex, paragraph);
  const token = tokens.find((item) => charIndex >= item.start && charIndex < item.end);
  if (token) return token;

  const knownWordRaw = paraEl.querySelector(`.jp-char[data-index="${charIndex}"]`)?.dataset.knownWord;
  const knownWord = normalizeKnownWordCandidate(knownWordRaw);
  if (knownWord) {
    const expanded = expandKnownRange(paraEl, charIndex, knownWord);
    const cappedEnd = Math.min(expanded.end, expanded.start + knownWord.length);
    return {
      surface: knownWord,
      lemma: knownWord,
      reading: normalizeReading("", knownWord),
      pos: "known",
      start: expanded.start,
      end: cappedEnd,
    };
  }

  const ch = paragraph[charIndex];
  if (!ch || isBoundary(ch)) return null;
  return {
    surface: ch,
    lemma: ch,
    reading: normalizeReading("", ch),
    pos: "fallback",
    start: charIndex,
    end: charIndex + 1,
  };
}

async function getParagraphTokens(chapterId, paraIndex, paragraph) {
  const key = `${chapterId}:${paraIndex}`;
  if (state.paragraphTokensCache.has(key)) {
    const cached = state.paragraphTokensCache.get(key);
    const cachedAllFallback =
      Array.isArray(cached) &&
      cached.length > 0 &&
      cached.every((token) => String(token?.pos || "") === "fallback");
    if (!cachedAllFallback) return cached;
    if (!state.apiOnline) {
      await ensureApiHealthFresh();
    }
    if (!state.apiOnline) return cached;
    state.paragraphTokensCache.delete(key);
  }
  const tokens = await tokenizeParagraph(paragraph);
  state.paragraphTokensCache.set(key, tokens);
  return tokens;
}

async function tokenizeParagraph(text) {
  if (!state.apiOnline) {
    await ensureApiHealthFresh();
  }
  if (state.apiOnline) {
    try {
      const payload = await fetchJson("/api/nlp/tokenize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (payload.ok && Array.isArray(payload.tokens)) {
        state.tokenizerBackend = payload.backend || state.tokenizerBackend;
        renderApiStatus();
        return payload.tokens.map(normalizeToken);
      }
    } catch {
      state.apiOnline = false;
      renderApiStatus();
    }
  }
  return fallbackTokenize(text);
}

function katakanaToHiragana(text) {
  return String(text || "").replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

function hiraganaToKatakana(text) {
  return String(text || "").replace(/[ぁ-ゖ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

function fallbackReadingFromSurface(surface) {
  const value = String(surface || "").trim();
  if (!value) return "";
  if (/^[ぁ-ゖー]+$/.test(value)) return value;
  if (/^[ァ-ヺー]+$/.test(value)) return katakanaToHiragana(value);
  return "";
}

function normalizeReading(reading, surface = "") {
  const raw = String(reading || "").trim() || fallbackReadingFromSurface(surface);
  if (!raw) return "";
  if (/^[ァ-ヺー]+$/.test(raw)) return katakanaToHiragana(raw);
  return raw;
}

function hasCjkText(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function normalizeToken(token) {
  const start = Number(token.start);
  const end = Number(token.end);
  const surface = String(token.surface || "");
  return {
    surface,
    lemma: String(token.lemma || surface),
    reading: normalizeReading(token.reading, surface),
    pos: String(token.pos || ""),
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : surface.length,
  };
}

function fallbackTokenize(text) {
  const pattern = /[一-龯々]+[ぁ-ゖー]*|[ァ-ヺー]+|[ぁ-ゖー]+|[A-Za-z0-9]+|[^\s]/g;
  const tokens = [];
  let match;
  while ((match = pattern.exec(text))) {
    const surface = match[0];
    tokens.push({
      surface,
      lemma: surface,
      reading: "",
      pos: "fallback",
      start: match.index,
      end: match.index + surface.length,
    });
  }
  return tokens;
}

function expandKnownRange(paragraphEl, index, word) {
  const chars = paragraphEl.querySelectorAll(".jp-char");
  let start = index;
  let end = index + 1;
  while (start > 0 && chars[start - 1].dataset.knownWord === word) start -= 1;
  while (end < chars.length && chars[end].dataset.knownWord === word) end += 1;
  return { start, end };
}

function getParagraphByLocation(chapterId, chapterIndex, paraIndex) {
  const chapter =
    getChapterById(chapterId) ||
    (state.book?.chapters?.[clampChapterIndex(Number(chapterIndex) || 0)] ?? null);
  if (!chapter || !Array.isArray(chapter.paragraphs)) return "";
  return String(chapter.paragraphs[Number(paraIndex)] || "");
}

function extractSentenceExample(paragraph, start, end) {
  const text = String(paragraph || "");
  if (!text) return "";
  const safeStart = clampNumber(Number(start) || 0, 0, Math.max(0, text.length - 1));
  const safeEnd = clampNumber(Number(end) || safeStart + 1, safeStart + 1, text.length);
  const sentenceDelim = /[。！？!?]/;

  let left = 0;
  for (let i = safeStart - 1; i >= 0; i -= 1) {
    if (sentenceDelim.test(text[i])) {
      left = i + 1;
      break;
    }
  }
  let right = text.length;
  for (let i = safeEnd; i < text.length; i += 1) {
    if (sentenceDelim.test(text[i])) {
      right = i + 1;
      break;
    }
  }

  let sentence = text.slice(left, right).trim();
  if (!sentence) return "";
  if (sentence.length <= 110) return sentence;

  const localStart = safeStart - left;
  const localEnd = safeEnd - left;
  const clipStart = clampNumber(localStart - 24, 0, Math.max(0, sentence.length - 2));
  const clipEnd = clampNumber(localEnd + 32, clipStart + 1, sentence.length);
  const clipped = sentence.slice(clipStart, clipEnd).trim();
  if (!clipped) return sentence.slice(0, 110).trim();
  const prefix = clipStart > 0 ? "…" : "";
  const suffix = clipEnd < sentence.length ? "…" : "";
  return `${prefix}${clipped}${suffix}`;
}

async function selectToken(token, chapterId, chapterIndex, paraIndex) {
  clearSelectionMark();
  state.selectedRange = {
    chapterId,
    paraIndex,
    start: token.start,
    end: token.end,
  };
  state.currentChapter = clampChapterIndex(chapterIndex);
  saveJSON(STORAGE_KEYS.currentChapter, state.currentChapter);
  renderBookMeta();
  renderChapterList();
  markSelection();

  const paragraph = getParagraphByLocation(chapterId, chapterIndex, paraIndex);
  const normalizedToken = normalizeToken(token);
  const resolvedToken = await enrichTokenDetails(normalizedToken);
  const contextExample = extractSentenceExample(paragraph, resolvedToken.start, resolvedToken.end);
  const entries = await lookupDictionary(resolvedToken.surface, resolvedToken.lemma);
  const dict = buildDictionaryView(resolvedToken, entries, contextExample);
  dict.jlpt = getJlptLevel(resolvedToken.surface, resolvedToken.lemma);
  state.selected = dict;
  setRightPanelTab("lookup", false);
  state.stats.lookupCount += 1;
  saveJSON(STORAGE_KEYS.stats, state.stats);
  renderLookupPanel();
  renderStats();
}

async function enrichTokenDetails(token) {
  const pos = String(token?.pos || "").trim();
  const reading = String(token?.reading || "").trim();
  const needsUpgrade = pos === "fallback" || !reading;
  if (!needsUpgrade) return token;

  await ensureApiHealthFresh(0);
  if (!state.apiOnline) return token;

  try {
    const payload = await fetchJson("/api/nlp/tokenize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: token.surface }),
    });
    if (!payload.ok || !Array.isArray(payload.tokens) || !payload.tokens.length) return token;
    const exact = payload.tokens
      .map(normalizeToken)
      .find((item) => item.surface === token.surface);
    if (!exact) return token;
    return {
      ...token,
      lemma: String(exact.lemma || token.lemma || token.surface),
      reading: normalizeReading(exact.reading || token.reading || "", token.surface),
      pos: String(exact.pos || token.pos || ""),
    };
  } catch {
    return token;
  }
}

async function lookupDictionary(surface, lemma) {
  if (!state.apiOnline) {
    await ensureApiHealthFresh();
  }
  if (state.apiOnline) {
    try {
      const payload = await fetchJson("/api/dict/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ surface, lemma }),
      });
      if (payload.ok && Array.isArray(payload.entries)) {
        return payload.entries;
      }
    } catch {
      state.apiOnline = false;
      renderApiStatus();
    }
  }
  return [];
}

function buildDictionaryView(token, entries, contextExample = "") {
  if (entries.length) {
    const first = entries[0];
    const tokenPos = String(token.pos || "").trim();
    const preferTokenPos = tokenPos && tokenPos !== "fallback" && tokenPos !== "known";
    const gloss = entries
      .map((item) => item.gloss_zh || item.glossZh || item.gloss || item.gloss_en || item.glossEn)
      .filter(Boolean)
      .slice(0, 3)
      .join(" / ");
    const meaning = gloss ? (hasCjkText(gloss) ? gloss : `英释: ${gloss}`) : "词典无释义";
    const example = String(
      first.example ||
        first.example_ja ||
        first.sentence ||
        first.sample ||
        contextExample ||
        ""
    ).trim();
    return {
      word: token.surface,
      lemma: first.lemma || token.lemma || token.surface,
      reading: normalizeReading(token.reading || first.reading || "", token.surface) || "-",
      pos: preferTokenPos ? tokenPos : String(first.pos || tokenPos || "-"),
      meaning,
      example: example || "未提取到例句",
    };
  }
  const local = lookupLocalDictionary(token.surface, token.lemma);
  const tokenPos = String(token.pos || "").trim();
  return {
    word: token.surface,
    lemma: token.lemma || token.surface,
    reading: normalizeReading(token.reading || local.reading || "", token.surface) || "-",
    pos: tokenPos && tokenPos !== "fallback" ? tokenPos : "-",
    meaning: local.meaning,
    example: contextExample || "未提取到例句",
  };
}

function stripWordNoise(value) {
  return String(value || "")
    .trim()
    .replace(
      /^[\s「」『』【】［］（）()〈〉《》〔〕｛｝{}'"“”‘’、。・，．！？!?：:；;]+|[\s「」『』【】［］（）()〈〉《》〔〕｛｝{}'"“”‘’、。・，．！？!?：:；;]+$/g,
      ""
    )
    .trim();
}

function buildLookupCandidates(surface, lemma) {
  const candidates = new Set();
  const seed = [surface, lemma];
  seed.forEach((raw) => {
    const value = String(raw || "").trim();
    if (!value) return;
    candidates.add(value);
    const stripped = stripWordNoise(value);
    if (stripped) candidates.add(stripped);
    const hira = katakanaToHiragana(stripped || value);
    if (hira) candidates.add(hira);
    const kata = hiraganaToKatakana(stripped || value);
    if (kata) candidates.add(kata);
  });
  return [...candidates];
}

function lookupLocalDictionary(surface, lemma) {
  const candidates = buildLookupCandidates(surface, lemma);
  for (const key of candidates) {
    if (MINI_DICT[key]) {
      return {
        reading: normalizeReading(MINI_DICT[key].reading || "", key) || "-",
        meaning: MINI_DICT[key].meaning || "词典无释义",
      };
    }
    const fromVocab = state.vocab.find((item) => {
      const word = stripWordNoise(item.word);
      const itemLemma = stripWordNoise(item.lemma);
      return word === key || itemLemma === key;
    });
    if (fromVocab) {
      return {
        reading: normalizeReading(fromVocab.reading || "", key) || "-",
        meaning: fromVocab.meaning || "词典无释义",
      };
    }
  }
  const missingHint =
    state.apiOnline && !state.jmdictReady
      ? "未加载 jmdict.db，本地词库命中有限。可先构建词典库或点外部词典。"
      : "本地词库未命中。可点“在 MOJi 中查”继续检索。";
  return {
    reading: normalizeReading("", surface || lemma) || "-",
    meaning: missingHint,
  };
}

function normalizeMojiScheme(value) {
  return value === "en" ? "en" : "jp";
}

function normalizeReaderFont(value) {
  const key = String(value || "").trim();
  return READER_FONT_MAP[key] ? key : "mincho";
}

function normalizeRightPanelTab(value) {
  const key = String(value || "").trim();
  return ["lookup", "vocab", "notes", "stats"].includes(key) ? key : "lookup";
}

function isMacDesktop() {
  return /Mac/i.test(navigator.platform || "");
}

function getMacDictUrl(word) {
  const query = String(word || "").trim();
  return query ? `${MAC_DICT_SCHEME}${encodeURIComponent(query)}` : "";
}

function getMojiLinks(word) {
  const scheme = normalizeMojiScheme(state.settings.mojiScheme);
  const query = String(word || "").trim();
  const encoded = encodeURIComponent(query);
  return {
    appUrl: query ? `${MOJI_SCHEME_MAP[scheme]}${encoded}` : "",
    webUrl: query ? `${MOJI_WEB_SEARCH}${encoded}` : MOJI_WEB_HOME,
    label: scheme === "en" ? "在 MOJi（英版）中查" : "在 MOJi（日版）中查",
  };
}

function isIosLikeDevice() {
  const ua = navigator.userAgent || "";
  const isClassicIOS = /iPad|iPhone|iPod/i.test(ua);
  const isIpadDesktopMode =
    navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1;
  return isClassicIOS || isIpadDesktopMode;
}

function syncDictLink(word) {
  const links = getMojiLinks(word);
  els.dictLink.href = links.webUrl;
  els.dictLink.dataset.appUrl = links.appUrl;
  els.dictLink.dataset.webUrl = links.webUrl;
  els.dictLink.textContent = links.label;
  if (els.macDictLink) {
    const macUrl = getMacDictUrl(word);
    els.macDictLink.hidden = !isMacDesktop();
    els.macDictLink.href = macUrl || "#";
    els.macDictLink.classList.toggle("disabled-link", !macUrl);
  }
}

function onDictLinkClick(event) {
  const appUrl = String(els.dictLink.dataset.appUrl || "").trim();
  const webUrl = String(els.dictLink.dataset.webUrl || els.dictLink.href || MOJI_WEB_HOME).trim();
  if (!appUrl || !isIosLikeDevice()) return;

  event.preventDefault();
  const timerId = window.setTimeout(() => {
    if (!document.hidden) window.location.href = webUrl;
  }, 900);

  const clearFallback = () => window.clearTimeout(timerId);
  window.addEventListener("pagehide", clearFallback, { once: true });
  document.addEventListener("visibilitychange", clearFallback, { once: true });
  window.location.href = appUrl;
}

function renderLookupPanel() {
  if (!state.selected) {
    els.selectedWord.textContent = "未选中";
    els.selectedLemma.textContent = "原形: -";
    els.selectedReading.textContent = "读音: -";
    els.selectedPos.textContent = "词性: -";
    els.selectedMeaning.textContent =
      "在阅读区拖选要查询的文字，或直接点击已标注的 N1/N2/N3 词。";
    els.selectedExample.textContent = "例句: -";
    els.noteEditorTarget.textContent = "未选中词";
    syncDictLink("");
    return;
  }
  els.selectedWord.textContent = state.selected.word;
  els.selectedLemma.textContent = `原形: ${state.selected.lemma || "-"}`;
  els.selectedReading.textContent = `读音: ${state.selected.reading || "-"}`;
  const jlptText = state.selected.jlpt ? ` · ${state.selected.jlpt}` : "";
  els.selectedPos.textContent = `词性: ${state.selected.pos || "-"}${jlptText}`;
  els.selectedMeaning.textContent = state.selected.meaning;
  els.selectedExample.textContent = `例句: ${state.selected.example || "-"}`;
  els.noteEditorTarget.textContent = `当前词: ${state.selected.word}`;
  syncDictLink(state.selected.lemma || state.selected.word);
}

function markSelection() {
  if (!state.selectedRange) return;
  const para = els.readerContent.querySelector(
    `.reader-para[data-chapter-id="${state.selectedRange.chapterId}"][data-pindex="${state.selectedRange.paraIndex}"]`
  );
  if (!para) return;
  const chars = para.querySelectorAll(".jp-char");
  for (let i = state.selectedRange.start; i < state.selectedRange.end; i += 1) {
    if (chars[i]) chars[i].classList.add("selected");
  }
}

function clearSelectionMark() {
  els.readerContent
    .querySelectorAll(".jp-char.selected")
    .forEach((el) => el.classList.remove("selected"));
}

function onAddWord() {
  if (!state.selected) return;
  const existed = state.vocab.find(
    (item) => item.word === state.selected.word || item.lemma === state.selected.lemma
  );
  if (existed) {
    existed.lookupCount = (existed.lookupCount || 1) + 1;
    saveJSON(STORAGE_KEYS.vocab, state.vocab);
    renderVocab();
    return;
  }

  state.vocab.push({
    word: state.selected.word,
    lemma: state.selected.lemma,
    reading: state.selected.reading,
    pos: state.selected.pos,
    meaning: state.selected.meaning,
    level: 0,
    lookupCount: 1,
    nextReview: Date.now(),
    createdAt: Date.now(),
  });
  saveJSON(STORAGE_KEYS.vocab, state.vocab);
  renderVocab();
  renderReader();
  requestAnalyze(true);
}

function onAddNoteClick() {
  if (!state.selected) return;
  setRightPanelTab("notes", false);
  els.noteInput.value = `${state.selected.word}: `;
  els.noteInput.focus();
}

function onSaveNote() {
  if (!state.selected || !state.selectedRange) {
    setStatus("先选中一个词再保存批注。", true);
    return;
  }
  const text = els.noteInput.value.trim();
  if (!text) {
    setStatus("批注内容不能为空。", true);
    return;
  }
  const note = {
    id: makeId("note"),
    chapterId: state.selectedRange.chapterId,
    chapterIndex: chapterIndexById(state.selectedRange.chapterId),
    paraIndex: state.selectedRange.paraIndex,
    start: state.selectedRange.start,
    end: state.selectedRange.end,
    word: state.selected.word,
    lemma: state.selected.lemma,
    note: text,
    createdAt: Date.now(),
  };
  state.notes.unshift(note);
  saveJSON(STORAGE_KEYS.notes, state.notes);
  els.noteInput.value = "";
  renderNotes();
  renderReader();
  setStatus("批注已保存。");
}

function renderNotes() {
  els.noteList.textContent = "";
  if (!state.notes.length) {
    appendListEmpty(els.noteList, "暂无批注");
    return;
  }
  state.notes.slice(0, 80).forEach((item) => {
    const li = document.createElement("li");
    li.className = "simple-item";

    const title = document.createElement("strong");
    title.textContent = item.word || item.lemma || "批注";
    const text = document.createElement("p");
    text.className = "meta";
    text.textContent = item.note.slice(0, 48);

    const jumpBtn = document.createElement("button");
    jumpBtn.className = "tiny-btn";
    jumpBtn.dataset.action = "jump";
    jumpBtn.dataset.noteId = item.id;
    jumpBtn.textContent = "跳转";

    const removeBtn = document.createElement("button");
    removeBtn.className = "tiny-btn";
    removeBtn.dataset.action = "remove";
    removeBtn.dataset.noteId = item.id;
    removeBtn.textContent = "删除";

    li.append(title, text, jumpBtn, removeBtn);
    els.noteList.appendChild(li);
  });
}

function onNoteListClick(event) {
  const button = event.target.closest("[data-action][data-note-id]");
  if (!button) return;
  const noteId = button.dataset.noteId;
  const action = button.dataset.action;
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) return;

  if (action === "remove") {
    state.notes = state.notes.filter((item) => item.id !== noteId);
    saveJSON(STORAGE_KEYS.notes, state.notes);
    renderNotes();
    renderReader();
    return;
  }

  if (action === "jump") {
    jumpToPosition(note.chapterId, note.paraIndex, note.start, note.end, note.word, note.lemma);
  }
}

function onAddBookmark() {
  const chapterId = state.selectedRange?.chapterId || state.lastCursor.chapterId;
  const chapterIndex = state.selectedRange
    ? chapterIndexById(chapterId)
    : Number.isFinite(state.lastCursor.chapterIndex)
    ? state.lastCursor.chapterIndex
    : state.currentChapter;
  const chapter = getChapterById(chapterId) || state.book?.chapters?.[chapterIndex];
  if (!chapter) return;

  const paraIndex = state.selectedRange ? state.selectedRange.paraIndex : state.lastCursor.paraIndex;
  const charIndex = state.selectedRange ? state.selectedRange.start : state.lastCursor.charIndex;
  const paragraph = chapter.paragraphs[paraIndex] || "";
  const excerpt = paragraph.slice(Math.max(0, charIndex - 8), charIndex + 18).trim() || "书签";

  state.bookmarks.unshift({
    id: makeId("bm"),
    chapterId: chapter.id,
    chapterIndex: chapterIndexById(chapter.id),
    paraIndex,
    charIndex,
    excerpt,
    createdAt: Date.now(),
  });
  saveJSON(STORAGE_KEYS.bookmarks, state.bookmarks);
  renderBookmarks();
  setStatus("书签已添加。");
}

function renderBookmarks() {
  els.bookmarkList.textContent = "";
  if (!state.bookmarks.length) {
    appendListEmpty(els.bookmarkList, "暂无书签");
    return;
  }
  state.bookmarks.slice(0, 80).forEach((item) => {
    const li = document.createElement("li");
    li.className = "simple-item";
    const title = document.createElement("strong");
    title.textContent = item.excerpt;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `章节 ${Number(item.chapterIndex) + 1}`;

    const jumpBtn = document.createElement("button");
    jumpBtn.className = "tiny-btn";
    jumpBtn.dataset.action = "jump";
    jumpBtn.dataset.bookmarkId = item.id;
    jumpBtn.textContent = "跳转";

    const removeBtn = document.createElement("button");
    removeBtn.className = "tiny-btn";
    removeBtn.dataset.action = "remove";
    removeBtn.dataset.bookmarkId = item.id;
    removeBtn.textContent = "删除";

    li.append(title, meta, jumpBtn, removeBtn);
    els.bookmarkList.appendChild(li);
  });
}

function onBookmarkListClick(event) {
  const button = event.target.closest("[data-action][data-bookmark-id]");
  if (!button) return;
  const bookmarkId = button.dataset.bookmarkId;
  const action = button.dataset.action;
  const bookmark = state.bookmarks.find((item) => item.id === bookmarkId);
  if (!bookmark) return;

  if (action === "remove") {
    state.bookmarks = state.bookmarks.filter((item) => item.id !== bookmarkId);
    saveJSON(STORAGE_KEYS.bookmarks, state.bookmarks);
    renderBookmarks();
    return;
  }
  if (action === "jump") {
    jumpToPosition(bookmark.chapterId, bookmark.paraIndex, bookmark.charIndex, bookmark.charIndex + 1);
  }
}

function jumpToPosition(chapterId, paraIndex, start, end, word = "", lemma = "") {
  if (!state.book || !state.book.chapters.length) return;
  const idx = state.book.chapters.findIndex((item) => item.id === chapterId);
  if (idx >= 0) {
    state.currentChapter = idx;
    ensureRenderedThrough(idx);
  }
  saveJSON(STORAGE_KEYS.currentChapter, state.currentChapter);
  renderBookMeta();
  renderChapterList();
  renderReader();

  state.selectedRange = {
    chapterId: state.book.chapters[state.currentChapter].id,
    paraIndex: Number(paraIndex),
    start: Number(start),
    end: Number(end),
  };
  state.selected = {
    word: word || state.selected?.word || "定位",
    lemma: lemma || word || state.selected?.lemma || "-",
    reading: state.selected?.reading || "-",
    pos: state.selected?.pos || "-",
    meaning: state.selected?.meaning || "-",
    example: state.selected?.example || "-",
    jlpt: state.selected?.jlpt || "",
  };
  markSelection();
  setRightPanelTab("lookup", false);
  renderLookupPanel();

  const para = els.readerContent.querySelector(
    `.reader-para[data-chapter-id="${chapterId}"][data-pindex="${paraIndex}"]`
  );
  if (para) {
    para.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function renderVocab() {
  els.vocabList.textContent = "";
  if (!state.vocab.length) {
    appendListEmpty(els.vocabList, "还没有生词");
    renderStats();
    return;
  }

  const sorted = [...state.vocab].sort((a, b) => a.nextReview - b.nextReview);
  sorted.forEach((item) => {
    const li = document.createElement("li");
    li.className = "vocab-item";

    const main = document.createElement("div");
    main.className = "vocab-main";
    const word = document.createElement("strong");
    word.className = "vocab-word";
    word.textContent = `${item.word} (${item.reading || "-"})`;
    const due = document.createElement("span");
    const isDue = item.nextReview <= Date.now();
    due.className = "meta";
    due.textContent = isDue ? "可复习" : formatDate(item.nextReview);
    main.append(word, due);

    const meaning = document.createElement("p");
    meaning.className = "vocab-meaning";
    meaning.textContent = `${item.meaning} · 次数 ${item.lookupCount || 1}`;

    const actions = document.createElement("div");
    actions.className = "vocab-actions";
    actions.append(
      tinyBtn("记住", "known", item.word),
      tinyBtn("再看", "again", item.word),
      tinyBtn("删词", "remove", item.word)
    );

    li.append(main, meaning, actions);
    els.vocabList.appendChild(li);
  });
  renderStats();
}

function tinyBtn(label, action, word) {
  const button = document.createElement("button");
  button.className = "tiny-btn";
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.word = word;
  return button;
}

function onVocabAction(event) {
  const actionBtn = event.target.closest("[data-action][data-word]");
  if (!actionBtn) return;
  const word = actionBtn.dataset.word;
  const action = actionBtn.dataset.action;
  const item = state.vocab.find((entry) => entry.word === word);
  if (!item) return;

  if (action === "known") {
    const intervals = [1, 3, 7, 14, 30, 60];
    item.level = Math.min((item.level || 0) + 1, intervals.length - 1);
    item.nextReview = Date.now() + intervals[item.level] * DAY_MS;
  }
  if (action === "again") {
    item.level = 0;
    item.nextReview = Date.now() + DAY_MS;
  }
  if (action === "remove") {
    state.vocab = state.vocab.filter((entry) => entry.word !== word);
  }

  saveJSON(STORAGE_KEYS.vocab, state.vocab);
  renderVocab();
  renderReader();
  requestAnalyze(true);
}

function exportVocabCsv() {
  if (!state.vocab.length) return;
  const headers = [
    "word",
    "lemma",
    "reading",
    "pos",
    "meaning",
    "level",
    "lookupCount",
    "nextReview",
  ];
  const rows = [headers.join(",")];
  state.vocab.forEach((item) => {
    const row = [
      item.word,
      item.lemma,
      item.reading,
      item.pos,
      item.meaning,
      item.level,
      item.lookupCount,
      formatDate(item.nextReview),
    ].map(csvEscape);
    rows.push(row.join(","));
  });
  const blob = new Blob([`\ufeff${rows.join("\n")}`], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `jp_vocab_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function onSettingsChange() {
  const prevDifficultyMode = state.settings.difficultyMode;
  const prevMojiScheme = state.settings.mojiScheme;
  const prevAutoPageSeconds = state.settings.autoPageSeconds;
  state.settings.fontSize = Number(els.fontSizeRange.value);
  state.settings.lineHeight = Number(els.lineHeightRange.value);
  state.settings.readerFont = normalizeReaderFont(els.readerFontSelect.value);
  state.settings.difficultyMode = String(els.difficultyModeSelect.value || "n1n2n3");
  state.settings.mojiScheme = normalizeMojiScheme(els.mojiSchemeSelect.value);
  state.settings.autoPageSeconds = clampNumber(
    Number(els.autoPageSecondsRange.value) || 12,
    6,
    40
  );
  state.settings.ttsRate = Number(els.ttsRateRange.value);
  state.settings.ttsVoice = els.ttsVoiceSelect.value || "";
  saveJSON(STORAGE_KEYS.settings, state.settings);
  applySettings();

  if (prevDifficultyMode !== state.settings.difficultyMode) {
    scheduleDifficultyPaint(true);
    applyVisibleDifficultyToDom();
  }
  if (prevMojiScheme !== state.settings.mojiScheme) {
    renderLookupPanel();
  }
  if (state.autoPageTimerId && prevAutoPageSeconds !== state.settings.autoPageSeconds) {
    startAutoPage();
    setStatus(`自动翻页间隔已更新为 ${state.settings.autoPageSeconds} 秒。`);
  }
}

function applySettings() {
  if (!["n1n2n3", "n1n2", "n1", "off"].includes(state.settings.difficultyMode)) {
    state.settings.difficultyMode = "n1n2n3";
  }
  state.settings.focusMode = Boolean(state.settings.focusMode);
  state.settings.rightPanelTab = normalizeRightPanelTab(state.settings.rightPanelTab);
  state.settings.readerFont = normalizeReaderFont(state.settings.readerFont);
  state.settings.mojiScheme = normalizeMojiScheme(state.settings.mojiScheme);
  state.settings.autoPageSeconds = clampNumber(
    Number(state.settings.autoPageSeconds) || 12,
    6,
    40
  );
  els.fontSizeRange.value = String(state.settings.fontSize);
  els.lineHeightRange.value = String(state.settings.lineHeight);
  els.readerFontSelect.value = state.settings.readerFont;
  els.difficultyModeSelect.value = state.settings.difficultyMode;
  els.mojiSchemeSelect.value = state.settings.mojiScheme;
  els.autoPageSecondsRange.value = String(state.settings.autoPageSeconds);
  els.autoPageSecondsText.textContent = `${state.settings.autoPageSeconds} 秒 / 页`;
  els.ttsRateRange.value = String(state.settings.ttsRate);
  els.readerContent.style.fontSize = `${state.settings.fontSize}px`;
  els.readerContent.style.lineHeight = String(state.settings.lineHeight);
  els.readerContent.style.fontFamily = READER_FONT_MAP[state.settings.readerFont];
  document.body.classList.toggle("focus-mode", state.settings.focusMode);
  els.toggleFocusBtn.textContent = `专注模式: ${state.settings.focusMode ? "开" : "关"}`;
  els.toggleFocusBtn.classList.toggle("auto-on", state.settings.focusMode);
  renderRightTabs();
  renderAutoPageUi();
}

function startTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = setInterval(() => {
    state.stats.totalSeconds += 1;
    if (state.stats.totalSeconds % 10 === 0) {
      saveJSON(STORAGE_KEYS.stats, state.stats);
    }
    renderStats();
  }, 1000);
}

function renderStats() {
  els.lookupCount.textContent = String(state.stats.lookupCount || 0);
  els.readingTime.textContent = formatDuration(state.stats.totalSeconds || 0);
  const due = state.vocab.filter((item) => item.nextReview <= Date.now()).length;
  els.dueCount.textContent = String(due);
}

async function checkApiHealth() {
  if (state.apiHealthPromise) {
    await state.apiHealthPromise;
    return;
  }
  const previousOnline = state.apiOnline;
  const previousBackend = state.tokenizerBackend;
  state.apiHealthPromise = (async () => {
    state.lastApiHealthCheckAt = Date.now();
    try {
      const payload = await fetchJson("/api/health", { method: "GET" }, 2200);
      state.apiOnline = Boolean(payload.ok);
      state.jmdictReady = Boolean(payload.jmdict);
      state.tokenizerBackend = payload.tokenizer || "fallback";
      const tokenizerUpgraded =
        state.apiOnline &&
        state.tokenizerBackend !== "fallback" &&
        (!previousOnline || previousBackend === "fallback");
      if (tokenizerUpgraded) {
        state.paragraphTokensCache.clear();
        state.difficultyRangesCache.clear();
        state.difficultyPending.clear();
        requestAnalyze(true);
      }
      renderApiStatus(state.jmdictReady);
      if (state.apiOnline && !state.jmdictReady) {
        setStatus("未检测到 jmdict.db：当前词典释义有限。请先构建词典库。", true);
      } else if (state.apiOnline && state.tokenizerBackend === "fallback") {
        setStatus("当前分词为 fallback，读音显示会不完整。建议安装 Sudachi/MeCab。", true);
      }
    } catch {
      state.apiOnline = false;
      state.jmdictReady = false;
      renderApiStatus(false);
    }
  })();
  try {
    await state.apiHealthPromise;
  } finally {
    state.apiHealthPromise = null;
  }
}

async function ensureApiHealthFresh(minIntervalMs = 1600) {
  if (state.apiHealthPromise) {
    await state.apiHealthPromise;
    return state.apiOnline;
  }
  const now = Date.now();
  if (now - (state.lastApiHealthCheckAt || 0) < minIntervalMs) {
    return state.apiOnline;
  }
  await checkApiHealth();
  return state.apiOnline;
}

async function loadJlptMap() {
  try {
    const response = await fetch(resolveRequestUrl("/backend/data/jlpt_levels.json"), {
      method: "GET",
      cache: "no-store",
    });
    if (!response.ok) {
      state.jlptMap = {};
      state.jlptSource = "none";
      renderApiStatus();
      return;
    }
    const payload = await response.json();
    const loadedMap = normalizeJlptMap(payload);
    if (!Object.keys(loadedMap).length) {
      state.jlptMap = {};
      state.jlptSource = "none";
      renderApiStatus();
      return;
    }
    state.jlptMap = loadedMap;
    state.jlptSource = "file";
    state.difficultyRangesCache.clear();
    scheduleDifficultyPaint(true);
    applyVisibleDifficultyToDom();
    renderApiStatus();
    setStatus(`JLPT 词表已加载：${Object.keys(loadedMap).length} 条。`);
    requestAnalyze(true);
  } catch {
    state.jlptMap = {};
    state.jlptSource = "none";
    renderApiStatus();
  }
}

function normalizeJlptMap(raw) {
  const map = {};
  if (Array.isArray(raw)) {
    raw.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const word = String(item.word || item.surface || item.lemma || "").trim();
      const level = normalizeJlptLevel(item.level || item.jlpt);
      if (word && level) map[word] = level;
    });
    return map;
  }
  if (raw && typeof raw === "object") {
    Object.entries(raw).forEach(([word, levelValue]) => {
      const level = normalizeJlptLevel(levelValue);
      if (word && level) map[word] = level;
    });
  }
  return map;
}

function normalizeJlptLevel(value) {
  if (!value) return "";
  const raw = String(value).toUpperCase().replace(/\s+/g, "");
  if (["N1", "1"].includes(raw)) return "N1";
  if (["N2", "2"].includes(raw)) return "N2";
  if (["N3", "3"].includes(raw)) return "N3";
  if (["N4", "4"].includes(raw)) return "N4";
  if (["N5", "5"].includes(raw)) return "N5";
  return "";
}

function getJlptLevel(surface, lemma) {
  if (!hasFullJlptMap()) return "";
  const candidates = [lemma, surface]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  for (const word of candidates) {
    const level = normalizeJlptLevel(state.jlptMap[word]);
    if (level) return level;
  }
  return "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function makeStatusChip(label, value, tone = "normal") {
  return `<span class="status-chip ${tone}"><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</span>`;
}

function renderApiStatus(jmdictReady = state.jmdictReady) {
  const jlptCount = Object.keys(state.jlptMap).length;
  const jlptText =
    hasFullJlptMap()
      ? `完整词表(${jlptCount})`
      : state.jlptSource === "file"
      ? `词表不完整(${jlptCount})`
      : "未加载";
  if (state.apiOnline) {
    const chips = [
      makeStatusChip("API", "在线", "ok"),
      makeStatusChip(
        "分词",
        state.tokenizerBackend,
        state.tokenizerBackend === "fallback" ? "warn" : "ok"
      ),
      makeStatusChip("词典", jmdictReady ? "已加载" : "未加载", jmdictReady ? "ok" : "warn"),
      makeStatusChip("JLPT", jlptText, hasFullJlptMap() ? "ok" : "warn"),
    ];
    els.apiStatus.innerHTML = chips.join("");
    return;
  }
  const offlineChips = [
    makeStatusChip("API", "离线", "bad"),
    makeStatusChip("说明", "TXT/本地回退可用", "normal"),
    makeStatusChip("JLPT", jlptText, hasFullJlptMap() ? "ok" : "warn"),
  ];
  els.apiStatus.innerHTML = offlineChips.join("");
}

function hasFullJlptMap() {
  return state.jlptSource === "file" && Object.keys(state.jlptMap).length >= 5000;
}

function renderSyncUi() {
  els.userIdInput.value = state.sync.userId || "demo-user";
}

function onSyncUserChange() {
  state.sync.userId = els.userIdInput.value.trim() || "demo-user";
  saveJSON(STORAGE_KEYS.sync, state.sync);
}

async function onSyncPush() {
  onSyncUserChange();
  if (!state.apiOnline) {
    setStatus("API 离线，无法云端上传。", true);
    return;
  }
  try {
    const payload = await fetchJson("/api/sync/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: state.sync.userId,
        snapshot: createSnapshot(),
      }),
    });
    if (!payload.ok) throw new Error(payload.error || "上传失败");
    setStatus(`云端上传成功（用户: ${state.sync.userId}）。`);
  } catch (error) {
    setStatus(`云端上传失败：${error.message}`, true);
  }
}

async function onSyncPull() {
  onSyncUserChange();
  if (!state.apiOnline) {
    setStatus("API 离线，无法云端拉取。", true);
    return;
  }
  try {
    const payload = await fetchJson(
      `/api/sync/pull?userId=${encodeURIComponent(state.sync.userId)}`,
      { method: "GET" }
    );
    if (!payload.ok) throw new Error(payload.error || "拉取失败");
    const snapshot = payload.data?.snapshot || {};
    if (!Object.keys(snapshot).length) {
      setStatus("云端暂无可用数据。");
      return;
    }
    applySnapshot(snapshot);
    setStatus(`云端拉取成功（用户: ${state.sync.userId}）。`);
  } catch (error) {
    setStatus(`云端拉取失败：${error.message}`, true);
  }
}

function createSnapshot() {
  return {
    book: state.book,
    currentChapter: state.currentChapter,
    vocab: state.vocab,
    notes: state.notes,
    bookmarks: state.bookmarks,
    settings: state.settings,
    stats: state.stats,
    sync: state.sync,
    savedAt: Date.now(),
  };
}

function applySnapshot(snapshot) {
  stopAutoPage();
  if (snapshot.book && Array.isArray(snapshot.book.chapters)) {
    state.book = normalizeBook(snapshot.book);
  }
  state.currentChapter = clampChapterIndex(snapshot.currentChapter);
  if (Array.isArray(snapshot.vocab)) state.vocab = snapshot.vocab;
  if (Array.isArray(snapshot.notes)) state.notes = snapshot.notes;
  if (Array.isArray(snapshot.bookmarks)) state.bookmarks = snapshot.bookmarks;
  if (snapshot.settings) {
    state.settings = {
      ...state.settings,
      ...snapshot.settings,
    };
  }
  if (snapshot.stats) {
    state.stats = {
      ...state.stats,
      ...snapshot.stats,
    };
  }
  if (snapshot.sync) {
    state.sync = {
      ...state.sync,
      ...snapshot.sync,
    };
  }
  state.renderedChapterCount = initialRenderedChapterCount();
  state.selected = null;
  state.selectedRange = null;
  state.paragraphTokensCache.clear();
  state.difficultyRangesCache.clear();
  state.difficultyPending.clear();
  state.hardWordsByChapter = new Map();
  state.bookFrequencyStats = null;
  state.analysisReady = false;
  persistAll();
  applySettings();
  renderAll();
  requestAnimationFrame(() => {
    scrollToChapter(state.currentChapter, false);
  });
  requestAnalyze(true);
}

function initTtsVoices() {
  if (!("speechSynthesis" in window)) {
    els.ttsPlayBtn.disabled = true;
    els.ttsStopBtn.disabled = true;
    els.ttsVoiceSelect.disabled = true;
    setStatus("当前浏览器不支持 TTS。", true);
    return;
  }
  const updateVoices = () => {
    const voices = speechSynthesis.getVoices();
    const jpVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith("ja"));
    const activeVoices = jpVoices.length ? jpVoices : voices;

    els.ttsVoiceSelect.textContent = "";
    activeVoices.forEach((voice) => {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = `${voice.name} (${voice.lang})`;
      els.ttsVoiceSelect.appendChild(option);
    });

    if (!activeVoices.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "无可用语音";
      els.ttsVoiceSelect.appendChild(option);
      return;
    }

    const preferred = activeVoices.find((voice) => voice.name === state.settings.ttsVoice);
    const finalVoice = preferred || activeVoices[0];
    els.ttsVoiceSelect.value = finalVoice.name;
    state.settings.ttsVoice = finalVoice.name;
    saveJSON(STORAGE_KEYS.settings, state.settings);
  };

  updateVoices();
  speechSynthesis.onvoiceschanged = updateVoices;
}

function onPlayTts() {
  const chapter = currentChapterData();
  if (!chapter) return;
  onStopTts();
  const utter = new SpeechSynthesisUtterance(chapter.text);
  utter.lang = "ja-JP";
  utter.rate = Number(state.settings.ttsRate || 1);

  const voice = speechSynthesis
    .getVoices()
    .find((item) => item.name === (state.settings.ttsVoice || els.ttsVoiceSelect.value));
  if (voice) utter.voice = voice;

  utter.onstart = () => setStatus(`开始朗读：${chapter.title}`);
  utter.onend = () => setStatus("朗读完成。");
  utter.onerror = () => setStatus("朗读失败。", true);
  state.ttsUtterance = utter;
  speechSynthesis.speak(utter);
}

function onStopTts() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  state.ttsUtterance = null;
}

function persistAll() {
  saveJSON(STORAGE_KEYS.book, state.book);
  saveJSON(STORAGE_KEYS.currentChapter, state.currentChapter);
  saveJSON(STORAGE_KEYS.vocab, state.vocab);
  saveJSON(STORAGE_KEYS.notes, state.notes);
  saveJSON(STORAGE_KEYS.bookmarks, state.bookmarks);
  saveJSON(STORAGE_KEYS.settings, state.settings);
  saveJSON(STORAGE_KEYS.stats, state.stats);
  saveJSON(STORAGE_KEYS.sync, state.sync);
}

function setStatus(message, isError = false) {
  els.statusText.textContent = message;
  els.statusText.style.color = isError ? "#8f1f0a" : "";
}

function appendListEmpty(listEl, text) {
  const li = document.createElement("li");
  li.className = "simple-item";
  li.textContent = text;
  listEl.appendChild(li);
}

async function fetchJson(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(resolveRequestUrl(url), {
      ...options,
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function resolveRequestUrl(url) {
  const raw = String(url || "");
  if (!raw) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!raw.startsWith("/")) return raw;
  const isApiLikePath = raw.startsWith("/api/") || raw.startsWith("/backend/data/");
  if (isApiLikePath) {
    const protocol = String(window.location.protocol || "").toLowerCase();
    const host = String(window.location.hostname || "").toLowerCase();
    const port = String(window.location.port || "");
    const isLocalHost = !host || host === "127.0.0.1" || host === "localhost";
    const shouldForceLocalBackend =
      protocol === "file:" || (isLocalHost && port !== "8000");
    if (shouldForceLocalBackend) {
      return `${LOCAL_API_ORIGIN}${raw}`;
    }
  }
  return raw;
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isBoundary(ch) {
  return /[\s。、「」『』（）()【】《》〈〉.,!?！？：；…\-]/.test(ch);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  if (hh === "00") return `${mm}:${ss}`;
  return `${hh}:${mm}:${ss}`;
}

function formatDate(ts) {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getDate()).padStart(2, "0")}`;
}
