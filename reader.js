import {
  BLOCKED_POS_RE,
  DAY_MS,
  DEFAULT_BILLING,
  DEFAULT_SETTINGS,
  DEFAULT_SYNC,
  FREE_FEATURE_HINT,
  HIGHLIGHT_LEVELS,
  HIRAGANA_ONLY_RE,
  JP_WORD_RE,
  KNOWN_WORD_ONLY_RE,
  KNOWN_WORD_MAX_LEN,
  LEVEL_PRIORITY,
  LOCAL_API_ORIGIN,
  MAC_DICT_SCHEME,
  MINI_DICT,
  MOJI_SCHEME_MAP,
  MOJI_WEB_HOME,
  MOJI_WEB_SEARCH,
  PRO_FEATURE_HINT,
  READER_FONT_MAP,
  SAMPLE_BOOK,
  STORAGE_KEYS,
  els,
  state,
} from "./readerStore.js";

export function initApp() {
  ensureSessionIdentity();
  state.billing = normalizeBilling(state.billing);
  state.billingOrder = normalizeBillingOrder(state.billingOrder);
  if (!state.billingOrder.channel) {
    state.billingOrder.channel = "wechat";
  }
  updateBilling({ userId: state.sync.userId }, false);
  bindEvents();
  applySettings();
  hydrateBook();
  renderAll();
  requestAnimationFrame(() => {
    scrollToChapter(state.currentChapter, false);
  });
  checkApiHealth().then(() => {
    void (async () => {
      await refreshPaymentOptions(true);
      await refreshBillingPlan(true);
      await bootstrapBookExperience();
    })();
  });
  handleBillingReturnParams();
  loadJlptMap().then(() => {
    requestAnalyze(true);
  });
  requestAnalyze(false);
  startTimer();
  initTtsVoices();
}

const REGISTER_USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
const REGISTER_BUTTON_LABEL = "注册";
const REGISTER_LOADING_LABEL = "注册中...";
const REGISTER_ERROR_MESSAGES = {
  INVALID_USERNAME: "用户名不合法，请使用小写字母、数字、_ 或 -。",
  WEAK_PASSWORD: "密码至少需要 8 位。",
  USERNAME_EXISTS: "用户名已存在。",
};
const LOGIN_BUTTON_LABEL = "登录";
const LOGIN_LOADING_LABEL = "登录中...";
const LOGIN_ERROR_MESSAGES = {
  INVALID_CREDENTIALS: "用户名或密码错误。",
};
const RIGHT_PANEL_TABS = ["vocab", "notes", "more"];

function createAnonymousId() {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `guest_${randomPart}`;
}

function isRegisteredAccount() {
  return (
    state.sync.accountMode === "registered" &&
    Boolean(sanitizeSyncUserId(state.sync.userId)) &&
    Boolean(String(state.sync.accountToken || "").trim())
  );
}

function readLegacyAccountStorage() {
  return {
    userId: sanitizeSyncUserId(localStorage.getItem("userId") || ""),
    accountToken: String(localStorage.getItem("accountToken") || "").trim(),
  };
}

function syncLegacyAccountStorage() {
  if (isRegisteredAccount()) {
    localStorage.setItem("userId", state.sync.userId);
    if (state.sync.accountToken) {
      localStorage.setItem("accountToken", state.sync.accountToken);
    } else {
      localStorage.removeItem("accountToken");
    }
    return;
  }
  const guestId = sanitizeSyncUserId(state.sync.anonymousId || state.sync.userId) || createAnonymousId();
  localStorage.setItem("userId", guestId);
  localStorage.removeItem("accountToken");
}

function persistSyncState() {
  saveJSON(STORAGE_KEYS.sync, state.sync);
  syncLegacyAccountStorage();
}

function currentAccountName() {
  return sanitizeSyncUserId(state.sync.userId) || "";
}

function ensureSessionIdentity() {
  const legacyAccount = readLegacyAccountStorage();
  const registeredUserId = sanitizeSyncUserId(state.sync.userId || legacyAccount.userId);
  const registeredToken = String(state.sync.accountToken || legacyAccount.accountToken || "").trim();
  const hasRegisteredSession =
    (state.sync.accountMode === "registered" || Boolean(registeredToken)) &&
    Boolean(registeredUserId) &&
    Boolean(registeredToken);
  if (hasRegisteredSession) {
    state.sync = {
      ...DEFAULT_SYNC,
      ...state.sync,
      userId: registeredUserId,
      accountMode: "registered",
      accountToken: registeredToken,
      anonymousId: "",
    };
    persistSyncState();
    return;
  }
  const anonymousId =
    sanitizeSyncUserId(state.sync.anonymousId || legacyAccount.userId || state.sync.userId) ||
    createAnonymousId();
  state.sync = {
    ...DEFAULT_SYNC,
    ...state.sync,
    userId: anonymousId,
    anonymousId,
    accountMode: "guest",
    accountToken: "",
    registeredAt: 0,
  };
  persistSyncState();
  if (state.book && !state.book.sampleSlug) {
    state.book = null;
    state.currentChapter = 0;
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
    clearPersistedBookState();
  }
}

function isAccountModalOpen() {
  return Boolean(els.accountModal && !els.accountModal.hidden);
}

function closeAccountMenu() {
  if (els.accountMenu) {
    els.accountMenu.open = false;
  }
}

function openAccountModal(options = {}) {
  if (!els.accountModal || isAccountModalOpen()) return;
  els.accountModal.hidden = false;
  document.body.classList.add("modal-open");
  const preferredPanel = String(options.panel || "").trim().toLowerCase();
  const focusTarget = isRegisteredAccount()
    ? els.accountLogoutButton
    : preferredPanel === "register"
    ? els.registerAccountInput || els.registerPasswordInput
    : els.loginAccountInput || els.registerAccountInput;
  requestAnimationFrame(() => {
    focusTarget?.focus?.();
  });
}

function closeAccountModal() {
  if (!els.accountModal || !isAccountModalOpen()) return;
  els.accountModal.hidden = true;
  document.body.classList.remove("modal-open");
}

function initMoreAccordion() {
  const sections = Array.from(document.querySelectorAll(".more-section"));
  sections.forEach((section) => {
    section.addEventListener("toggle", () => {
      if (!section.open) return;
      sections.forEach((other) => {
        if (other !== section) {
          other.open = false;
        }
      });
    });
  });
}

function openToolsSection() {
  setRightPanelTab("vocab");
}

function readerScrollContainer() {
  return els.readerViewport || els.readerContent;
}

function bindEvents() {
  els.fileInput.addEventListener("change", onFileChange);
  els.loadSampleBtn.addEventListener("click", () => {
    void onLoadSampleBook();
  });
  els.registerAccountButton?.addEventListener("click", () => {
    void onRegisterAccount();
  });
  els.loginButton?.addEventListener("click", () => {
    void loginAccount();
  });
  els.signInButton?.addEventListener("click", () => {
    closeAccountMenu();
    openAccountModal({ panel: "login" });
  });
  els.registerMenuButton?.addEventListener("click", () => {
    closeAccountMenu();
    openAccountModal({ panel: "register" });
  });
  els.closeAccountModalBtn?.addEventListener("click", closeAccountModal);
  els.accountModalBackdrop?.addEventListener("click", closeAccountModal);
  if (els.logoutButton) {
    els.logoutButton.onclick = () => {
      closeAccountMenu();
      logoutAccount();
    };
  }
  if (els.accountLogoutButton) {
    els.accountLogoutButton.onclick = logoutAccount;
  }

  els.chapterList.addEventListener("click", onChapterListClick);
  els.bookmarkList.addEventListener("click", onBookmarkListClick);
  els.notesBookmarkList?.addEventListener("click", onBookmarkListClick);
  els.noteList.addEventListener("click", onNoteListClick);
  els.addBookmarkBtn.addEventListener("click", onAddBookmark);
  els.prevPageBtn.addEventListener("click", onPrevPage);
  els.nextPageBtn.addEventListener("click", onNextPage);
  els.scrollModeBtn?.addEventListener("click", () => {
    setReadingMode("scroll");
  });
  els.pagedModeBtn?.addEventListener("click", () => {
    setReadingMode("paged");
  });
  els.toggleAutoPageBtn.addEventListener("click", onToggleAutoPage);
  els.toggleFocusBtn.addEventListener("click", onToggleFocusMode);
  els.fontDecreaseBtn?.addEventListener("click", () => {
    adjustFontSize(-1);
  });
  els.fontIncreaseBtn?.addEventListener("click", () => {
    adjustFontSize(1);
  });
  els.lineHeightDecreaseBtn?.addEventListener("click", () => {
    adjustLineHeight(-0.1);
  });
  els.lineHeightIncreaseBtn?.addEventListener("click", () => {
    adjustLineHeight(0.1);
  });

  els.readerContent.addEventListener("mouseup", onReaderMouseUp);
  els.readerContent.addEventListener("touchend", onReaderTouchEnd, { passive: true });
  els.readerContent.addEventListener("click", onReaderClick);
  document.addEventListener("mouseup", onReaderMouseUp);
  readerScrollContainer().addEventListener("scroll", onReaderScroll);
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
  els.exportProgressBtn?.addEventListener("click", () => {
    void exportProgressJson();
  });
  els.deleteBookBtn?.addEventListener("click", () => {
    void onDeleteCurrentBook();
  });
  els.deleteCloudBtn?.addEventListener("click", () => {
    void onDeleteCloudData();
  });
  els.deleteAccountBtn?.addEventListener("click", () => {
    void onDeleteAccount();
  });
  els.vocabList.addEventListener("click", onVocabAction);
  els.rightTabs?.addEventListener("click", onRightTabsClick);

  els.fontSizeRange?.addEventListener("input", onSettingsChange);
  els.lineHeightRange?.addEventListener("input", onSettingsChange);
  els.difficultyModeSelect.addEventListener("change", onSettingsChange);
  els.mojiSchemeSelect.addEventListener("change", onSettingsChange);
  els.readerFontSelect.addEventListener("change", onSettingsChange);
  els.autoPageSecondsRange.addEventListener("input", onSettingsChange);
  els.ttsRateRange.addEventListener("input", onSettingsChange);
  els.ttsVoiceSelect.addEventListener("change", onSettingsChange);
  els.ttsPlayBtn.addEventListener("click", onPlayTts);
  els.ttsStopBtn.addEventListener("click", onStopTts);

  els.userIdInput.addEventListener("change", onSyncUserChange);
  els.pullSyncBtn?.addEventListener("click", () => {
    closeAccountMenu();
    void onSyncPull();
  });
  els.pushSyncBtn?.addEventListener("click", () => {
    closeAccountMenu();
    void onSyncPush();
  });
  els.cloudPullActionBtn?.addEventListener("click", () => {
    void onSyncPull();
  });
  els.cloudPushActionBtn?.addEventListener("click", () => {
    void onSyncPush();
  });
  els.reportIssueBtn?.addEventListener("click", () => {
    void openFeedbackPrompt("bug");
  });
  els.sendFeedbackBtn?.addEventListener("click", () => {
    void openFeedbackPrompt("feedback");
  });
  els.payChannelSelect.addEventListener("change", onPayChannelChange);
  els.billingIntervalSelect.addEventListener("change", onBillingIntervalChange);
  els.upgradeProBtn.addEventListener("click", onUpgradeProPlan);
  els.manageBillingBtn.addEventListener("click", onOpenBillingPortal);
  els.joinWaitlistBtn?.addEventListener("click", () => {
    showToast("当前暂未开放升级。");
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (els.accountMenu?.open && !target?.closest("#accountMenu")) {
      els.accountMenu.open = false;
    }
    const settingsPopover = document.getElementById("readerSettingsPopover");
    if (settingsPopover?.open && !target?.closest("#readerSettingsPopover")) {
      settingsPopover.open = false;
    }
  });

  window.addEventListener("beforeunload", () => {
    persistAll();
    onStopTts();
    stopAutoPage();
  });

  window.addEventListener("keydown", onReaderHotkey);

  initMoreAccordion();
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
  renderExplainPanel();
  renderStats();
  renderVocab();
  renderSyncUi();
  renderBillingUi();
}

function hydrateBook() {
  if (!state.book || !Array.isArray(state.book.chapters)) return;
  state.book = normalizeBook(state.book);
  state.currentChapter = clampChapterIndex(state.currentChapter);
  state.scrollBaseChapter = state.currentChapter;
  state.renderedChapterCount = initialRenderedChapterCount();
  syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
}

function normalizeBook(rawBook) {
  const chaptersRaw = Array.isArray(rawBook.chapters) ? rawBook.chapters : [];
  const chapters = chaptersRaw.map((item, idx) => {
    const paragraphsSource = Array.isArray(item?.paragraphs) ? item.paragraphs : null;
    const text = String(item?.text || "").replace(/\r/g, "").trim();
    const paragraphs = (paragraphsSource || (text ? text.split(/\n+/) : []))
      .map((line) => String(line || "").trim())
      .filter(Boolean);
    return {
      id: String(item?.id || `ch-${idx + 1}`),
      index: Number.isFinite(Number(item?.index)) ? Number(item.index) : idx,
      title: String(item?.title || `Chapter ${idx + 1}`),
      text: text || paragraphs.join("\n\n"),
      paragraphs,
      sourceType: String(item?.sourceType || rawBook?.format || "txt"),
      sourceRef: String(item?.sourceRef || ""),
      analysis:
        item?.analysis && typeof item.analysis === "object"
          ? {
              chapterId: String(item.analysis.chapterId || item.id || `ch-${idx + 1}`),
              sentences: Array.isArray(item.analysis.sentences) ? item.analysis.sentences : [],
              tokens: Array.isArray(item.analysis.tokens) ? item.analysis.tokens : [],
              jlptStats:
                item.analysis.jlptStats && typeof item.analysis.jlptStats === "object"
                  ? item.analysis.jlptStats
                  : {},
              difficultVocab: Array.isArray(item.analysis.difficultVocab)
                ? item.analysis.difficultVocab
                : [],
              analysisVersion: String(item.analysis.analysis_version || item.analysis.analysisVersion || ""),
              tokenizerVersion: String(item.analysis.tokenizer_version || item.analysis.tokenizerVersion || ""),
              jlptVersion: String(item.analysis.jlpt_version || item.analysis.jlptVersion || ""),
              dictVersion: String(item.analysis.dict_version || item.analysis.dictVersion || ""),
              promptVersion: String(item.analysis.prompt_version || item.analysis.promptVersion || ""),
            }
          : null,
    };
  });

  return {
    id: String(rawBook.id || ""),
    userId: String(rawBook.userId || ""),
    title: String(rawBook.title || "Untitled"),
    author: String(rawBook.author || rawBook.meta?.author || rawBook.metadata?.author || ""),
    format: String(rawBook.format || "txt"),
    chapterCount: Number(rawBook.chapterCount || chapters.length || 0),
    normalizedVersion: Number(rawBook.normalizedVersion || 1),
    importedAt: Number(rawBook.importedAt || 0),
    sourceFileName: String(rawBook.sourceFileName || ""),
    sampleSlug: String(rawBook.sampleSlug || ""),
    stats: rawBook.stats && typeof rawBook.stats === "object" ? rawBook.stats : {},
    progress: rawBook.progress && typeof rawBook.progress === "object" ? rawBook.progress : null,
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
      if (normalizeReadingMode(state.settings.readingMode) === "scroll") {
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
      const payload = await fetchJson("/api/books/import", {
        method: "POST",
        body: formData,
      }, 12000);
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
  setStatus(
    `该格式需要后端 API。请使用 \`python3 backend/server.py\` 启动。${openHint}`,
    true
  );
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
  state.currentChapter = clampChapterIndex(initialChapter);
  state.scrollBaseChapter = state.currentChapter;
  state.renderedChapterCount = initialRenderedChapterCount();
  syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
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
    chapterId: state.book?.chapters?.[state.currentChapter]?.id || "",
    chapterIndex: state.currentChapter,
    paraIndex: 0,
    charIndex: 0,
  };
  state.paragraphTokensCache.clear();
  state.difficultyRangesCache.clear();
  state.difficultyPending.clear();
  state.hardWordsByChapter = new Map();
  state.bookFrequencyStats = null;
  state.analysisReady = false;
  persistBookState({ persistLocal: options.persistLocal });
  renderAll();
  readerScrollContainer().scrollTop = 0;
  requestAnalyze(true);
  if (state.apiOnline && state.book?.id) {
    try {
      await ensureChapterLoaded(state.currentChapter, { prefetch: false });
      renderAll();
      void prefetchNextChapter(state.currentChapter);
      if (normalizeReadingMode(state.settings.readingMode) === "scroll") {
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
  return normalizeReadingMode(state.settings.readingMode) === "scroll" ? 2 : 1;
}

function ensureRenderedThrough(chapterIndex) {
  if (normalizeReadingMode(state.settings.readingMode) !== "scroll") return true;
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
  void setCurrentChapter(chapterIndex);
}

async function setCurrentChapter(index) {
  state.currentChapter = clampChapterIndex(index);
  if (normalizeReadingMode(state.settings.readingMode) === "scroll") {
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
  if (normalizeReadingMode(state.settings.readingMode) === "scroll") {
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

function chapterIndexesForRender() {
  if (!state.book || !state.book.chapters.length) return [];
  const mode = normalizeReadingMode(state.settings.readingMode);
  if (mode === "paged") {
    return [clampChapterIndex(state.currentChapter)];
  }
  const base = clampChapterIndex(state.scrollBaseChapter);
  state.scrollBaseChapter = base;
  const maxCount = Math.max(1, state.book.chapters.length - base);
  const fallbackCount = initialRenderedChapterCount();
  state.renderedChapterCount = clampNumber(
    Number(state.renderedChapterCount) || fallbackCount,
    1,
    maxCount
  );
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

function isPagedMode() {
  return normalizeReadingMode(state.settings.readingMode) === "paged";
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

function syncReaderState(partial = {}) {
  state.reader = {
    ...state.reader,
    mode: normalizeReadingMode(state.settings.readingMode),
    currentChapterIndex: clampChapterIndex(state.currentChapter),
    currentPageIndex: Math.max(0, Number(state.reader?.currentPageIndex) || 0),
    totalPagesInChapter: Math.max(1, Number(state.reader?.totalPagesInChapter) || 1),
    ...partial,
  };
}

function syncPagedPageState() {
  if (!state.book?.chapters?.length || !isPagedMode()) {
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
    return { currentPageIndex: 0, totalPagesInChapter: 1, maxScrollTop: 0, step: 1 };
  }
  const scrollContainer = readerScrollContainer();
  const viewport = Math.max(1, scrollContainer.clientHeight || 1);
  const step = getPagedStep(viewport);
  const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - viewport);
  const totalPagesInChapter = Math.max(1, Math.floor(maxScrollTop / step) + 1);
  const currentPageIndex = clampNumber(
    Math.round((scrollContainer.scrollTop || 0) / step),
    0,
    totalPagesInChapter - 1
  );
  syncReaderState({ currentPageIndex, totalPagesInChapter });
  return { currentPageIndex, totalPagesInChapter, maxScrollTop, step };
}

function getCurrentChapterPageCount() {
  return syncPagedPageState().totalPagesInChapter;
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

function updateReaderProgress(location = {}) {
  persistCurrentChapterState();
  void syncReadingProgress(location);
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

async function loadChapterByIndex(index) {
  if (!state.book?.chapters?.length) return false;
  const chapterIndex = clampChapterIndex(index);
  state.currentChapter = chapterIndex;
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
  const scrollContainer = readerScrollContainer();
  const viewport = Math.max(1, scrollContainer.clientHeight || 1);
  const step = getPagedStep(viewport);
  const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - viewport);
  const totalPagesInChapter = Math.max(1, Math.floor(maxScrollTop / step) + 1);
  const currentPageIndex = clampNumber(
    Number(state.reader?.currentPageIndex) || 0,
    0,
    totalPagesInChapter - 1
  );
  const targetTop = Math.min(currentPageIndex * step, maxScrollTop);
  syncReaderState({ currentPageIndex, totalPagesInChapter });
  scrollContainer.scrollTo({
    top: targetTop,
    behavior: options.smooth ? "smooth" : "auto",
  });
}

function maybeLoadMoreChapters() {
  if (normalizeReadingMode(state.settings.readingMode) !== "scroll") return;
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
    state.currentChapter = clampChapterIndex(bestIdx);
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

function onToggleAutoPage() {
  if (normalizeReadingMode(state.settings.readingMode) !== "paged") {
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
  if (!els.rightTabs) return;
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
  if (normalizeReadingMode(state.settings.readingMode) !== "paged") {
    setStatus("自动翻页仅在分页模式下可用。", true);
    return;
  }
  stopAutoPage();
  const seconds = clampNumber(Number(state.settings.autoPageSeconds) || 12, 6, 40);
  state.settings.autoPageSeconds = seconds;
  saveJSON(STORAGE_KEYS.settings, state.settings);
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

function stopAutoPage() {
  if (!state.autoPageTimerId) return;
  clearInterval(state.autoPageTimerId);
  state.autoPageTimerId = null;
  state.autoPageTicking = false;
  renderAutoPageUi();
}

function renderAutoPageUi() {
  const pagedMode = normalizeReadingMode(state.settings.readingMode) === "paged";
  const on = pagedMode && Boolean(state.autoPageTimerId);
  els.toggleAutoPageBtn.hidden = !pagedMode;
  els.toggleAutoPageBtn.disabled = !pagedMode;
  els.toggleAutoPageBtn.textContent = `自动翻页: ${on ? "开" : "关"}`;
  els.toggleAutoPageBtn.classList.toggle("auto-on", on);
}

function normalizeReadingMode(value) {
  return String(value || "").trim() === "paged" ? "paged" : "scroll";
}

function setReadingMode(mode, options = {}) {
  const nextMode = normalizeReadingMode(mode);
  const prevMode = normalizeReadingMode(state.settings.readingMode);
  if (nextMode === prevMode) {
    syncReaderState();
    renderReadingModeUi();
    renderAutoPageUi();
    return;
  }
  state.settings.readingMode = nextMode;
  syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
  if (options.persist !== false) {
    saveJSON(STORAGE_KEYS.settings, state.settings);
  }
  if (nextMode !== "paged") {
    stopAutoPage();
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

function renderReadingModeUi() {
  const mode = normalizeReadingMode(state.settings.readingMode);
  if (els.scrollModeBtn) {
    const isScroll = mode === "scroll";
    els.scrollModeBtn.classList.toggle("active", isScroll);
    els.scrollModeBtn.setAttribute("aria-pressed", isScroll ? "true" : "false");
  }
  if (els.pagedModeBtn) {
    const isPaged = mode === "paged";
    els.pagedModeBtn.classList.toggle("active", isPaged);
    els.pagedModeBtn.setAttribute("aria-pressed", isPaged ? "true" : "false");
  }
  if (els.pagedControls) {
    els.pagedControls.hidden = mode !== "paged";
  }
}

function adjustFontSize(delta) {
  state.settings.fontSize = clampNumber((Number(state.settings.fontSize) || 21) + delta, 16, 32);
  saveJSON(STORAGE_KEYS.settings, state.settings);
  applySettings();
}

function adjustLineHeight(delta) {
  const next = clampNumber((Number(state.settings.lineHeight) || 1.9) + delta, 1.4, 2.4);
  state.settings.lineHeight = Math.round(next * 10) / 10;
  saveJSON(STORAGE_KEYS.settings, state.settings);
  applySettings();
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
  if (!hasFullJlptMap() && !bookHasPrecomputedAnalysis()) {
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

  state.analysisReady = false;
  renderHardWords();
  renderFrequencyStats();

  const hardWordsByChapter = new Map();
  const knownSet = new Set(getKnownWords().map((item) => normalizeWordKey(item)));
  state.book.chapters.forEach((chapter) => {
    const chapterHardWords = Array.isArray(chapter?.analysis?.difficultVocab)
      ? chapter.analysis.difficultVocab
      : [];
    hardWordsByChapter.set(
      chapter.id,
      chapterHardWords
        .filter((item) => !knownSet.has(normalizeWordKey(item?.lemma || item?.word)))
        .map((item) => ({
          word: String(item.word || item.lemma || ""),
          level: String(item.level || ""),
          count: Number(item.count || 0),
          reading: String(item.reading || "-"),
          meaning: String(item.meaning || "点击查看释义"),
        }))
    );
  });

  const sourceStats = state.book.stats && typeof state.book.stats === "object" ? state.book.stats : {};
  const levelBucketsSource =
    sourceStats.levelBuckets && typeof sourceStats.levelBuckets === "object"
      ? sourceStats.levelBuckets
      : {};

  state.hardWordsByChapter = hardWordsByChapter;
  state.bookFrequencyStats = {
    totalTokens: Number(sourceStats.totalTokens || 0),
    uniqueWords: Number(sourceStats.uniqueWords || 0),
    topWords: Array.isArray(sourceStats.topWords) ? sourceStats.topWords : [],
    levelBuckets: {
      N1: Number(levelBucketsSource.N1 || 0),
      N2: Number(levelBucketsSource.N2 || 0),
      N3: Number(levelBucketsSource.N3 || 0),
      other: Number(levelBucketsSource.other || 0),
    },
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
  if (!hasFullJlptMap() && !bookHasPrecomputedAnalysis()) {
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
  if (!hasFullJlptMap() && !bookHasPrecomputedAnalysis()) {
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

function getChapterAnalysis(chapterOrId) {
  if (!chapterOrId) return null;
  if (typeof chapterOrId === "object" && chapterOrId.analysis) {
    return chapterOrId.analysis;
  }
  const chapter = getChapterById(String(chapterOrId || ""));
  return chapter?.analysis || null;
}

function getSentenceRangesForParagraph(chapter, paraIndex, paragraph) {
  const analysis = getChapterAnalysis(chapter);
  const sentences = Array.isArray(analysis?.sentences)
    ? analysis.sentences.filter((item) => Number(item?.paragraphIndex) === Number(paraIndex))
    : [];
  if (sentences.length) {
    return sentences
      .map((item, idx) => ({
        id: String(item.id || `p${paraIndex}-s${idx}`),
        start: clampNumber(Number(item.start) || 0, 0, paragraph.length),
        end: clampNumber(Number(item.end) || paragraph.length, 0, paragraph.length),
        text: String(item.text || ""),
      }))
      .filter((item) => item.end > item.start);
  }

  const fallback = [];
  const sentenceDelim = /[。！？!?]/;
  let start = 0;
  let localIndex = 0;
  for (let i = 0; i < paragraph.length; i += 1) {
    if (!sentenceDelim.test(paragraph[i])) continue;
    fallback.push({ id: `p${paraIndex}-s${localIndex}`, start, end: i + 1, text: paragraph.slice(start, i + 1) });
    start = i + 1;
    localIndex += 1;
  }
  if (start < paragraph.length) {
    fallback.push({
      id: `p${paraIndex}-s${localIndex}`,
      start,
      end: paragraph.length,
      text: paragraph.slice(start),
    });
  }
  return fallback.filter((item) => item.end > item.start);
}

function findSentenceAt(chapterId, paraIndex, charIndex) {
  const chapter = getChapterById(chapterId);
  if (!chapter) return null;
  const paragraph = chapter.paragraphs[paraIndex] || "";
  return (
    getSentenceRangesForParagraph(chapter, paraIndex, paragraph).find(
      (item) => charIndex >= item.start && charIndex < item.end
    ) || null
  );
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
        level: String(token.jlpt || getJlptLevel(token.surface, token.lemma) || ""),
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
  void syncReadingProgress(state.lastCursor);
  if (state.currentChapter !== chapterIndex) {
    state.currentChapter = chapterIndex;
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
    persistCurrentChapterState();
    renderBookMeta();
    renderChapterList();
    renderHardWords();
    scheduleDifficultyPaint();
  }
  const paragraph = chapter.paragraphs[paraIndex] || "";
  const token = await findTokenAt(chapterId, paraIndex, paragraph, charIndex, para);
  const isDifficultyWordChar =
    target.classList.contains("jlpt-n1") ||
    target.classList.contains("jlpt-n2") ||
    target.classList.contains("jlpt-n3");
  if (token && isDifficultyWordChar) {
    await selectToken(token, chapterId, chapterIndex, paraIndex);
    return;
  }
  const sentence = findSentenceAt(chapterId, paraIndex, charIndex);
  if (!sentence) return;
  await explainSentence(sentence, {
    chapterId,
    chapterIndex,
    paraIndex,
    bookId: state.book?.id || "",
    chapterTitle: chapter.title,
    paragraph,
  });
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
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
    persistCurrentChapterState();
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
  const chapter = getChapterById(chapterId);
  const analysisTokens = Array.isArray(chapter?.analysis?.tokens)
    ? chapter.analysis.tokens
        .filter((token) => Number(token?.paragraphIndex) === Number(paraIndex))
        .map(normalizeToken)
    : [];
  if (analysisTokens.length) {
    state.paragraphTokensCache.set(key, analysisTokens);
    return analysisTokens;
  }
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
    paragraphIndex: Number.isFinite(Number(token.paragraphIndex)) ? Number(token.paragraphIndex) : 0,
    surface,
    lemma: String(token.lemma || surface),
    reading: normalizeReading(token.reading, surface),
    pos: String(token.pos || ""),
    jlpt: String(token.jlpt || ""),
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
  syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
  persistCurrentChapterState();
  renderBookMeta();
  renderChapterList();
  markSelection();
  void syncReadingProgress({
    chapterId,
    chapterIndex,
    paraIndex,
    charIndex: token.start,
  });

  const paragraph = getParagraphByLocation(chapterId, chapterIndex, paraIndex);
  const normalizedToken = normalizeToken(token);
  const resolvedToken = await enrichTokenDetails(normalizedToken);
  const contextExample = extractSentenceExample(paragraph, resolvedToken.start, resolvedToken.end);
  const entries = await lookupDictionary(resolvedToken.surface, resolvedToken.lemma);
  const dict = buildDictionaryView(resolvedToken, entries, contextExample);
  dict.jlpt = getJlptLevel(resolvedToken.surface, resolvedToken.lemma);
  state.selected = dict;
  state.stats.lookupCount += 1;
  saveJSON(STORAGE_KEYS.stats, state.stats);
  renderLookupPanel();
  renderStats();
  void trackEvent("word_clicked", {
    word: dict.word,
    lemma: dict.lemma,
    chapterId,
    paraIndex,
  });
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
  if (key === "lookup") return "vocab";
  if (["stats", "tts", "settings", "data", "billing"].includes(key)) return "more";
  return RIGHT_PANEL_TABS.includes(key) ? key : "vocab";
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

function renderExplainPanel() {
  if (!els.explainStatus) return;
  const explain = state.explain || {};
  if (els.explainQuota) {
    const remaining = Number(state.billing.aiExplainRemainingToday);
    const limit = Number(state.billing.features?.aiExplainDailyLimit);
    const isUnlimited = limit < 0 || remaining < 0;
    const prefix = state.sync.accountMode === "registered" ? "账号" : "游客";
    els.explainQuota.textContent = isUnlimited
      ? `${prefix} AI 解释配额：不限量`
      : `${prefix} AI 解释剩余：${remaining} / ${limit}`;
  }
  if (explain.loading) {
    els.explainStatus.textContent = "AI 正在解释句子...";
    els.explainTranslation.textContent = "";
    els.explainGrammar.innerHTML = "";
    els.explainNotes.innerHTML = "";
    els.explainDifficulty.textContent = "";
    return;
  }
  if (explain.error) {
    els.explainStatus.textContent = explain.error;
    els.explainTranslation.textContent = "";
    els.explainGrammar.innerHTML = "";
    els.explainNotes.innerHTML = "";
    els.explainDifficulty.textContent = "";
    return;
  }
  if (!explain.result) {
    els.explainStatus.textContent = "点击阅读区中的句子查看 AI 解释。";
    els.explainTranslation.textContent = "";
    els.explainGrammar.innerHTML = "";
    els.explainNotes.innerHTML = "";
    els.explainDifficulty.textContent = "";
    return;
  }
  els.explainStatus.textContent = explain.cached ? "AI 解释已加载（命中缓存）" : "AI 解释已加载";
  els.explainTranslation.textContent = `翻译：${explain.result.translation || "-"}`;
  renderExplainList(els.explainGrammar, explain.result.grammar || [], "语法");
  renderExplainList(els.explainNotes, explain.result.notes || [], "说明");
  els.explainDifficulty.textContent = `难度：${explain.result.difficulty || "-"}`;
}

function renderExplainList(listEl, items, label) {
  listEl.innerHTML = "";
  if (!Array.isArray(items) || !items.length) {
    const li = document.createElement("li");
    li.textContent = `${label}：-`;
    listEl.appendChild(li);
    return;
  }
  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.textContent = `${label} ${index + 1}：${item}`;
    listEl.appendChild(li);
  });
}

function buildExplainContext(paragraph, sentence) {
  const text = String(paragraph || "");
  const start = Math.max(0, Number(sentence?.start || 0) - 24);
  const end = Math.min(text.length, Number(sentence?.end || 0) + 24);
  return text.slice(start, end);
}

async function explainSentence(sentence, meta = {}) {
  const text = String(sentence?.text || "").trim();
  if (!text) return;
  state.selectedSentence = {
    id: String(sentence.id || ""),
    text,
    chapterId: String(meta.chapterId || ""),
    paraIndex: Number(meta.paraIndex || 0),
    start: Number(sentence.start || 0),
    end: Number(sentence.end || 0),
  };
  state.explain = {
    loading: true,
    sentenceId: String(sentence.id || ""),
    cached: false,
    result: null,
    error: "",
  };
  renderReader({ preserveScroll: true });
  renderExplainPanel();

  try {
    const payload = await fetchJson(
      "/api/ai/explain",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: state.sync.userId,
          bookId: String(meta.bookId || state.book?.id || ""),
          chapterId: String(meta.chapterId || ""),
          sentence: text,
          mode: "reader",
          context: {
            bookTitle: state.book?.title || "",
            chapterTitle: String(meta.chapterTitle || ""),
            paragraph: buildExplainContext(meta.paragraph, sentence),
          },
        }),
      },
      12000
    );
    if (payload?.billing) {
      updateBilling(payload.billing);
    }
    state.explain = {
      loading: false,
      sentenceId: String(sentence.id || ""),
      cached: Boolean(payload.cached),
      result: payload.result || null,
      error: "",
    };
  } catch (error) {
    const errorCode = String(error?.payload?.code || "").trim().toUpperCase();
    let friendly = `句子解释失败：${String(error?.message || "").trim() || "未知错误"}`;
    if (errorCode === "AI_NOT_CONFIGURED") {
      friendly = "AI 解释功能暂未配置。";
    } else if (errorCode === "EXPLAIN_LIMIT_REACHED") {
      friendly = "今日 AI 解释次数已用完。";
    } else if (errorCode === "AI_PROVIDER_ERROR") {
      friendly = "AI 解释服务暂时不可用，请稍后再试。";
    }
    state.explain = {
      loading: false,
      sentenceId: String(sentence.id || ""),
      cached: false,
      result: null,
      error: friendly,
    };
    showToast(friendly, true);
  }
  renderExplainPanel();
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
  void trackEvent("vocab_added", {
    word: state.selected.word,
    lemma: state.selected.lemma,
  });
}

function onAddNoteClick() {
  if (!state.selected) return;
  openToolsSection();
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
    void jumpToPosition(note.chapterId, note.paraIndex, note.start, note.end, note.word, note.lemma);
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
  const containers = [els.bookmarkList, els.notesBookmarkList].filter(Boolean);
  containers.forEach((listEl) => {
    listEl.textContent = "";
    if (!state.bookmarks.length) {
      appendListEmpty(listEl, "暂无书签");
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
      listEl.appendChild(li);
    });
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
    void jumpToPosition(bookmark.chapterId, bookmark.paraIndex, bookmark.charIndex, bookmark.charIndex + 1);
  }
}

async function jumpToPosition(chapterId, paraIndex, start, end, word = "", lemma = "") {
  if (!state.book || !state.book.chapters.length) return;
  const idx = state.book.chapters.findIndex((item) => item.id === chapterId);
  if (idx >= 0) {
    state.currentChapter = idx;
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
    ensureRenderedThrough(idx);
  }
  persistCurrentChapterState();
  if (idx >= 0) {
    try {
      await ensureChapterLoaded(idx, { prefetch: false });
    } catch {
      // Keep local state if remote chapter load fails.
    }
  }
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
  renderLookupPanel();

  const para = els.readerContent.querySelector(
    `.reader-para[data-chapter-id="${chapterId}"][data-pindex="${paraIndex}"]`
  );
  if (para) {
    para.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  void syncReadingProgress({
    chapterId,
    chapterIndex: idx >= 0 ? idx : state.currentChapter,
    paraIndex,
    charIndex: start,
  });
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

async function exportVocabCsv() {
  let sourceVocab = state.vocab;
  if (state.sync.accountMode === "registered" && hasFeature("cloudSync")) {
    try {
      const payload = await fetchJson(
        `/api/export/vocab?userId=${encodeURIComponent(state.sync.userId)}`,
        { method: "GET" }
      );
      if (Array.isArray(payload?.vocab)) {
        sourceVocab = payload.vocab;
        state.vocab = payload.vocab;
        saveJSON(STORAGE_KEYS.vocab, state.vocab);
      }
    } catch (error) {
      setStatus(`同步云端词汇失败，改用本地数据导出：${error.message}`, true);
    }
  }
  if (!sourceVocab.length) return;
  const maxRows = Math.max(1, Number(state.billing.features.csvExportMaxRows) || 60);
  const fullExportEnabled = maxRows >= sourceVocab.length;
  const exportItems = fullExportEnabled ? sourceVocab : sourceVocab.slice(0, maxRows);

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
  exportItems.forEach((item) => {
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
  if (!fullExportEnabled) {
    setStatus(`基础版仅可导出前 ${maxRows} 条，升级 Pro 可导出全部。`, true);
  } else {
    setStatus(`导出完成，共 ${exportItems.length} 条。`);
  }
}

function onSettingsChange() {
  const prevDifficultyMode = state.settings.difficultyMode;
  const prevMojiScheme = state.settings.mojiScheme;
  const prevAutoPageSeconds = state.settings.autoPageSeconds;
  state.settings.fontSize = Number(els.fontSizeRange?.value || state.settings.fontSize || 21);
  state.settings.lineHeight = Number(els.lineHeightRange?.value || state.settings.lineHeight || 1.9);
  state.settings.readerFont = normalizeReaderFont(els.readerFontSelect?.value || state.settings.readerFont);
  state.settings.difficultyMode = String(els.difficultyModeSelect?.value || "n1n2n3");
  state.settings.mojiScheme = normalizeMojiScheme(els.mojiSchemeSelect?.value || state.settings.mojiScheme);
  state.settings.autoPageSeconds = clampNumber(
    Number(els.autoPageSecondsRange?.value) || 12,
    6,
    40
  );
  state.settings.ttsRate = Number(els.ttsRateRange?.value || state.settings.ttsRate || 1);
  state.settings.ttsVoice = els.ttsVoiceSelect?.value || "";
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
  state.settings.readingMode = normalizeReadingMode(state.settings.readingMode);
  state.settings.focusMode = Boolean(state.settings.focusMode);
  state.settings.rightPanelTab = normalizeRightPanelTab(state.settings.rightPanelTab);
  state.settings.readerFont = normalizeReaderFont(state.settings.readerFont);
  state.settings.mojiScheme = normalizeMojiScheme(state.settings.mojiScheme);
  state.settings.fontSize = clampNumber(Number(state.settings.fontSize) || 21, 16, 32);
  state.settings.lineHeight = clampNumber(Number(state.settings.lineHeight) || 1.9, 1.4, 2.4);
  state.settings.autoPageSeconds = clampNumber(
    Number(state.settings.autoPageSeconds) || 12,
    6,
    40
  );
  syncReaderState();
  if (els.fontSizeRange) {
    els.fontSizeRange.value = String(state.settings.fontSize);
  }
  if (els.lineHeightRange) {
    els.lineHeightRange.value = String(state.settings.lineHeight);
  }
  if (els.readerFontSelect) {
    els.readerFontSelect.value = state.settings.readerFont;
  }
  if (els.difficultyModeSelect) {
    els.difficultyModeSelect.value = state.settings.difficultyMode;
  }
  if (els.mojiSchemeSelect) {
    els.mojiSchemeSelect.value = state.settings.mojiScheme;
  }
  if (els.autoPageSecondsRange) {
    els.autoPageSecondsRange.value = String(state.settings.autoPageSeconds);
  }
  if (els.autoPageSecondsText) {
    els.autoPageSecondsText.textContent = `${state.settings.autoPageSeconds} 秒 / 页`;
  }
  if (els.ttsRateRange) {
    els.ttsRateRange.value = String(state.settings.ttsRate);
  }
  els.readerContent.style.fontSize = `${state.settings.fontSize}px`;
  els.readerContent.style.lineHeight = String(state.settings.lineHeight);
  els.readerContent.style.fontFamily = READER_FONT_MAP[state.settings.readerFont];
  document.body.classList.toggle("focus-mode", state.settings.focusMode);
  els.toggleFocusBtn.textContent = `专注模式: ${state.settings.focusMode ? "开" : "关"}`;
  els.toggleFocusBtn.classList.toggle("auto-on", state.settings.focusMode);
  renderReadingModeUi();
  if (state.settings.readingMode !== "paged" && state.autoPageTimerId) {
    stopAutoPage();
  }
  renderRightTabs();
  renderAutoPageUi();
  if (isPagedMode()) {
    syncPagedPageState();
  }
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
      renderApiStatus();
      if (state.apiOnline && !state.jmdictReady) {
        setStatus("未检测到 jmdict.db：当前词典释义有限。请先构建词典库。", true);
      } else if (state.apiOnline && state.tokenizerBackend === "fallback") {
        setStatus("当前分词为 fallback，读音显示会不完整。建议安装 Sudachi/MeCab。", true);
      }
      if (state.apiOnline && !previousOnline) {
        void refreshBillingPlan(true);
      }
    } catch {
      state.apiOnline = false;
      state.jmdictReady = false;
      renderApiStatus();
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

function enabledPaymentChannelLabels(channels = {}) {
  const labels = [];
  if (channels.wechat) labels.push("微信支付");
  if (channels.alipay) labels.push("支付宝");
  if (channels.stripe) labels.push("Stripe（国际卡）");
  return labels;
}

function planUiLabel(plan) {
  return normalizePlan(plan) === "pro" ? "Pro" : "基础版";
}

function renderApiStatus() {
  const plan = normalizePlan(state.billing.plan);
  const tokenizerText = state.apiOnline
    ? state.tokenizerBackend === "fallback"
      ? "在线(回退分词)"
      : "在线"
    : "离线";
  if (state.apiOnline) {
    const chips = [
      makeStatusChip("API", tokenizerText, state.tokenizerBackend === "fallback" ? "warn" : "ok"),
      makeStatusChip("套餐", planUiLabel(plan), plan === "pro" ? "ok" : "warn"),
    ];
    els.apiStatus.innerHTML = chips.join("");
    return;
  }
  const offlineChips = [
    makeStatusChip("API", "离线", "bad"),
    makeStatusChip("套餐", planUiLabel(plan), plan === "pro" ? "ok" : "warn"),
  ];
  els.apiStatus.innerHTML = offlineChips.join("");
}

function hasFullJlptMap() {
  return state.jlptSource === "file" && Object.keys(state.jlptMap).length >= 5000;
}

function handleBillingReturnParams() {
  let url;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  const billingState = String(url.searchParams.get("billing") || "").trim().toLowerCase();
  const channel = normalizePayChannel(url.searchParams.get("channel") || "");
  const sessionId = String(url.searchParams.get("session_id") || "").trim();
  if (!billingState) return;
  if (billingState === "success") {
    if (channel === "stripe" && sessionId) {
      setStatus("Stripe 支付成功，正在确认订阅状态...");
      void completeStripeCheckout(sessionId);
    } else {
      setStatus("支付成功，正在同步套餐状态...");
      void refreshBillingPlan(true);
    }
  } else if (billingState === "cancel") {
    setStatus("已取消支付。");
  } else if (billingState === "portal") {
    setStatus("已返回订阅管理页面。");
  }
  url.searchParams.delete("billing");
  url.searchParams.delete("orderId");
  url.searchParams.delete("channel");
  url.searchParams.delete("session_id");
  window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
}

function sanitizeSyncUserId(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned;
}

function normalizePlan(value) {
  return String(value || "").toLowerCase() === "pro" ? "pro" : "free";
}

function normalizePayChannel(value) {
  const raw = String(value || "").toLowerCase();
  if (raw === "stripe") return "stripe";
  if (raw === "alipay") return "alipay";
  return "wechat";
}

function normalizeBillingInterval(value) {
  return String(value || "").toLowerCase() === "yearly" ? "yearly" : "monthly";
}

function normalizeBilling(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const mergedFeatures = {
    ...DEFAULT_BILLING.features,
    ...(source.features && typeof source.features === "object" ? source.features : {}),
  };
  const mergedChannels = {
    ...DEFAULT_BILLING.paymentChannels,
    ...(source.paymentChannels && typeof source.paymentChannels === "object"
      ? source.paymentChannels
      : {}),
  };
  const sourceStripe = source.stripe && typeof source.stripe === "object" ? source.stripe : {};
  const mergedStripeIntervals = {
    ...DEFAULT_BILLING.stripe.intervals,
    ...(sourceStripe.intervals && typeof sourceStripe.intervals === "object"
      ? sourceStripe.intervals
      : {}),
  };
  const stripeCustomerId = String(source.stripeCustomerId || sourceStripe.customerId || "");
  const stripeSubscriptionId = String(source.stripeSubscriptionId || sourceStripe.subscriptionId || "");
  return {
    userId: sanitizeSyncUserId(source.userId || state.sync?.userId || ""),
    paymentEnabled:
      source.paymentEnabled === undefined
        ? Boolean(DEFAULT_BILLING.paymentEnabled)
        : Boolean(source.paymentEnabled),
    entitlementPlan: normalizePlan(source.entitlementPlan || source.plan),
    plan: normalizePlan(source.plan),
    source: String(source.source || DEFAULT_BILLING.source),
    subscriptionStatus: String(source.subscriptionStatus || ""),
    lastPaidChannel: source.lastPaidChannel ? normalizePayChannel(source.lastPaidChannel) : "",
    lastOrderId: String(source.lastOrderId || ""),
    planExpireAt: Number(source.planExpireAt || 0),
    graceUntilAt: Number(source.graceUntilAt || 0),
    paymentFailedAt: Number(source.paymentFailedAt || 0),
    billingState: String(source.billingState || ""),
    accessState: String(source.accessState || "free"),
    accountMode: String(source.accountMode || "guest"),
    features: {
      advancedImport: Boolean(mergedFeatures.advancedImport),
      cloudSync: Boolean(mergedFeatures.cloudSync),
      csvExportMaxRows: Math.max(1, Number(mergedFeatures.csvExportMaxRows) || 60),
      aiExplainDailyLimit: Number(mergedFeatures.aiExplainDailyLimit ?? 3),
    },
    paymentChannels: {
      stripe: Boolean(mergedChannels.stripe),
      wechat: Boolean(mergedChannels.wechat),
      alipay: Boolean(mergedChannels.alipay),
    },
    stripe: {
      checkoutReady:
        sourceStripe.checkoutReady === undefined
          ? DEFAULT_BILLING.stripe.checkoutReady
          : Boolean(sourceStripe.checkoutReady),
      portalReady:
        sourceStripe.portalReady === undefined
          ? DEFAULT_BILLING.stripe.portalReady
          : Boolean(sourceStripe.portalReady),
      paymentLinkReady:
        sourceStripe.paymentLinkReady === undefined
          ? DEFAULT_BILLING.stripe.paymentLinkReady
          : Boolean(sourceStripe.paymentLinkReady),
      paymentLink: String(sourceStripe.paymentLink || "").trim(),
      paymentMode: String(sourceStripe.paymentMode || DEFAULT_BILLING.stripe.paymentMode || "none"),
      intervals: {
        monthly: Boolean(mergedStripeIntervals.monthly),
        yearly: Boolean(mergedStripeIntervals.yearly),
      },
      defaultInterval: normalizeBillingInterval(
        sourceStripe.defaultInterval || (mergedStripeIntervals.monthly ? "monthly" : "yearly")
      ),
      customerId: stripeCustomerId,
      subscriptionId: stripeSubscriptionId,
    },
    manualPlanChangeEnabled: Boolean(source.manualPlanChangeEnabled),
    manualPaymentConfirmEnabled:
      source.manualPaymentConfirmEnabled === undefined
        ? DEFAULT_BILLING.manualPaymentConfirmEnabled
        : Boolean(source.manualPaymentConfirmEnabled),
    priceFen: Math.max(1, Number(source.priceFen || DEFAULT_BILLING.priceFen) || DEFAULT_BILLING.priceFen),
    orderExpireMinutes: Math.max(
      5,
      Number(source.orderExpireMinutes || DEFAULT_BILLING.orderExpireMinutes) ||
        DEFAULT_BILLING.orderExpireMinutes
    ),
    aiExplainUsedToday: Math.max(0, Number(source.aiExplainUsedToday || 0)),
    aiExplainRemainingToday:
      Number(source.aiExplainRemainingToday) < 0
        ? -1
        : Math.max(0, Number(source.aiExplainRemainingToday || 0)),
    aiExplainCachedToday: Math.max(0, Number(source.aiExplainCachedToday || 0)),
    aiExplainLimitedToday: Math.max(0, Number(source.aiExplainLimitedToday || 0)),
    updatedAt: Number(source.updatedAt || 0),
  };
}

function normalizeBillingOrder(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    orderId: String(source.orderId || ""),
    status: String(source.status || ""),
    channel: normalizePayChannel(source.channel || "wechat"),
    interval: normalizeBillingInterval(source.interval || "monthly"),
    sessionId: String(source.sessionId || ""),
    paidAt: Number(source.paidAt || 0),
  };
}

function updateBilling(nextBilling, persist = true) {
  state.billing = normalizeBilling({
    ...state.billing,
    ...nextBilling,
    userId: nextBilling?.userId || state.sync.userId,
  });
  if (persist) {
    saveJSON(STORAGE_KEYS.billing, state.billing);
  }
  renderBillingUi();
  renderApiStatus();
}

function updateBillingOrder(nextOrder, persist = true) {
  state.billingOrder = normalizeBillingOrder({
    ...state.billingOrder,
    ...nextOrder,
  });
  if (persist) {
    saveJSON(STORAGE_KEYS.billingOrder, state.billingOrder);
  }
}

function hasFeature(featureName) {
  return Boolean(state.billing?.features?.[featureName]);
}

function channelEnabled(channel) {
  const key = normalizePayChannel(channel);
  return Boolean(state.billing?.paymentChannels?.[key]);
}

function activePayChannel() {
  const selected = normalizePayChannel(els.payChannelSelect?.value || state.billingOrder.channel);
  if (channelEnabled(selected)) return selected;
  if (channelEnabled("wechat")) return "wechat";
  if (channelEnabled("alipay")) return "alipay";
  if (channelEnabled("stripe")) return "stripe";
  return selected;
}

function hasAnyPaymentChannel() {
  return channelEnabled("stripe") || channelEnabled("wechat") || channelEnabled("alipay");
}

function paymentChannelLabel(channel) {
  const key = normalizePayChannel(channel);
  if (key === "stripe") return "Stripe（国际卡）";
  if (key === "alipay") return "支付宝";
  return "微信支付";
}

function renderBillingUi() {
  const plan = normalizePlan(state.billing.plan);
  const accountMode = isRegisteredAccount() ? "registered" : "guest";
  const isRegistered = accountMode === "registered";
  const accountName = currentAccountName();
  const stripeConfig = state.billing.stripe || DEFAULT_BILLING.stripe;
  const stripePaymentLinkReady = Boolean(
    stripeConfig.paymentLinkReady && String(stripeConfig.paymentLink || "").trim()
  );
  const statusText = state.billing.subscriptionStatus
    ? `（订阅状态: ${state.billing.subscriptionStatus}）`
    : "";
  const graceText = state.billing.accessState === "grace" ? " 当前处于宽限期。" : "";
  const priceText = `￥${(Number(state.billing.priceFen || 0) / 100).toFixed(2)}`;
  const advancedImportEnabled = hasFeature("advancedImport");
  const cloudSyncEnabled = hasFeature("cloudSync");
  const csvLimit = Math.max(1, Number(state.billing.features?.csvExportMaxRows || 60) || 60);
  const csvUnlimited = plan === "pro" || csvLimit >= 100000;
  const paymentsEnabled = Boolean(state.billing.paymentEnabled);
  const enabledLabels = enabledPaymentChannelLabels(state.billing.paymentChannels);
  const channelText = enabledLabels.length ? enabledLabels.join(" / ") : "无可用通道";
  if (els.accountModeLabel) {
    els.accountModeLabel.textContent = isRegistered ? accountName : "游客模式";
  }
  if (els.accountMenu) {
    if (!isRegistered) {
      els.accountMenu.open = false;
    }
  }
  if (els.signInButton) {
    els.signInButton.hidden = isRegistered;
    els.signInButton.disabled = isRegistered || state.registeringAccount || state.loggingInAccount;
  }
  if (els.registerMenuButton) {
    els.registerMenuButton.hidden = isRegistered;
    els.registerMenuButton.disabled = isRegistered || state.registeringAccount || state.loggingInAccount;
  }
  if (els.usernameDisplay) {
    els.usernameDisplay.textContent = isRegistered ? accountName : "";
  }
  if (els.userIdInput) {
    els.userIdInput.value = isRegistered ? accountName : state.sync.anonymousId || "游客模式";
    els.userIdInput.disabled = true;
  }
  if (els.accountGuestPanel) {
    els.accountGuestPanel.hidden = isRegistered;
  }
  if (els.accountRegisteredPanel) {
    els.accountRegisteredPanel.hidden = !isRegistered;
  }
  if (els.accountDisplayName) {
    els.accountDisplayName.textContent = isRegistered ? accountName : "-";
  }
  if (els.accountPlanText) {
    els.accountPlanText.textContent = planUiLabel(plan);
  }
  if (els.logoutButton) {
    els.logoutButton.hidden = !isRegistered;
    els.logoutButton.disabled = !isRegistered;
  }
  if (els.pullSyncBtn) {
    els.pullSyncBtn.hidden = !isRegistered;
  }
  if (els.pushSyncBtn) {
    els.pushSyncBtn.hidden = !isRegistered;
  }
  if (els.accountLogoutButton) {
    els.accountLogoutButton.hidden = !isRegistered;
    els.accountLogoutButton.disabled = !isRegistered;
  }
  if (els.registerAccountInput) {
    els.registerAccountInput.disabled = isRegistered || state.registeringAccount || state.loggingInAccount;
    if (isRegistered) {
      els.registerAccountInput.value = "";
    }
  }
  if (els.registerPasswordInput) {
    els.registerPasswordInput.disabled = isRegistered || state.registeringAccount || state.loggingInAccount;
    if (isRegistered) {
      els.registerPasswordInput.value = "";
    }
  }
  if (els.registerAccountButton) {
    els.registerAccountButton.disabled = isRegistered || state.registeringAccount || state.loggingInAccount;
    els.registerAccountButton.textContent = state.registeringAccount
      ? REGISTER_LOADING_LABEL
      : REGISTER_BUTTON_LABEL;
  }
  if (els.loginAccountInput) {
    els.loginAccountInput.disabled = isRegistered || state.loggingInAccount || state.registeringAccount;
    if (isRegistered) {
      els.loginAccountInput.value = "";
    }
  }
  if (els.loginPasswordInput) {
    els.loginPasswordInput.disabled = isRegistered || state.loggingInAccount || state.registeringAccount;
    if (isRegistered) {
      els.loginPasswordInput.value = "";
    }
  }
  if (els.loginButton) {
    els.loginButton.disabled = isRegistered || state.loggingInAccount || state.registeringAccount;
    els.loginButton.textContent = state.loggingInAccount ? LOGIN_LOADING_LABEL : LOGIN_BUTTON_LABEL;
  }
  const minimalPlanCard = !paymentsEnabled;
  if (els.planCard) {
    els.planCard.classList.toggle("minimal-plan", minimalPlanCard);
  }
  if (els.planLiteBlock) {
    els.planLiteBlock.hidden = !minimalPlanCard;
  }
  if (els.planFullBlock) {
    els.planFullBlock.hidden = minimalPlanCard;
  }
  if (els.planLabel) {
    els.planLabel.textContent = planUiLabel(plan);
    els.planLabel.className = `plan-pill ${plan}`;
  }
  if (els.planComingSoon) {
    els.planComingSoon.hidden = true;
    els.planComingSoon.textContent = "当前暂未开放升级。";
  }
  if (els.planHint) {
    if (!paymentsEnabled) {
      els.planHint.textContent = "当前暂未开放升级。";
    } else if (!hasAnyPaymentChannel()) {
      els.planHint.textContent = `支付通道未开启，请配置微信支付 / 支付宝 / Stripe。${statusText}${graceText}`;
    } else {
      const baseHint =
        accountMode === "registered"
          ? `${plan === "pro" ? PRO_FEATURE_HINT : FREE_FEATURE_HINT} 当前价格 ${priceText}，支持 ${channelText}${statusText}${graceText}`
          : `游客可先体验示例阅读与少量 AI 解释，注册后可升级并同步云端。`;
      els.planHint.textContent = baseHint;
    }
  }
  if (els.benefitAdvancedImport) {
    els.benefitAdvancedImport.textContent = advancedImportEnabled ? "已开通" : "未开通";
    els.benefitAdvancedImport.className = advancedImportEnabled ? "enabled" : "disabled";
  }
  if (els.benefitCloudSync) {
    els.benefitCloudSync.textContent = cloudSyncEnabled ? "已开通" : "未开通";
    els.benefitCloudSync.className = cloudSyncEnabled ? "enabled" : "disabled";
  }
  if (els.benefitCsvLimit) {
    els.benefitCsvLimit.textContent = csvUnlimited ? "不限量" : `${csvLimit} 条`;
    els.benefitCsvLimit.className = csvUnlimited ? "enabled" : "disabled";
  }
  if (els.paymentControls) {
    els.paymentControls.hidden = !paymentsEnabled;
  }
  if (els.paymentDisabledHint) {
    els.paymentDisabledHint.hidden = true;
    els.paymentDisabledHint.textContent = "当前暂未开放升级。";
  }
  if (els.billingFlowHint) {
    els.billingFlowHint.hidden = !paymentsEnabled;
  }
  const currentChannel = activePayChannel();
  const preferredInterval = normalizeBillingInterval(
    state.billingOrder.interval || stripeConfig.defaultInterval || "monthly"
  );
  const monthlyEnabled = Boolean(stripeConfig.intervals?.monthly);
  const yearlyEnabled = Boolean(stripeConfig.intervals?.yearly);
  let currentInterval = preferredInterval;
  if (currentInterval === "yearly" && !yearlyEnabled && monthlyEnabled) currentInterval = "monthly";
  if (currentInterval === "monthly" && !monthlyEnabled && yearlyEnabled) currentInterval = "yearly";
  if (!monthlyEnabled && !yearlyEnabled) currentInterval = stripeConfig.defaultInterval || "monthly";

  if (paymentsEnabled) {
    els.payChannelSelect.disabled = false;
    els.payChannelSelect.value = currentChannel;
    const stripeOption = els.payChannelSelect.querySelector('option[value="stripe"]');
    const disableWechat = !channelEnabled("wechat");
    const disableAlipay = !channelEnabled("alipay");
    const disableStripe = !channelEnabled("stripe");
    if (stripeOption) stripeOption.disabled = disableStripe;
    const wechatOption = els.payChannelSelect.querySelector('option[value="wechat"]');
    const alipayOption = els.payChannelSelect.querySelector('option[value="alipay"]');
    if (wechatOption) wechatOption.disabled = disableWechat;
    if (alipayOption) alipayOption.disabled = disableAlipay;

    const monthlyOption = els.billingIntervalSelect.querySelector('option[value="monthly"]');
    const yearlyOption = els.billingIntervalSelect.querySelector('option[value="yearly"]');
    const stripeUsesPaymentLink = currentChannel === "stripe" && stripePaymentLinkReady;
    if (monthlyOption) {
      monthlyOption.disabled = currentChannel !== "stripe" || stripeUsesPaymentLink || !monthlyEnabled;
    }
    if (yearlyOption) {
      yearlyOption.disabled = currentChannel !== "stripe" || stripeUsesPaymentLink || !yearlyEnabled;
    }
    els.billingIntervalSelect.value = currentInterval;
    els.billingIntervalSelect.disabled = currentChannel !== "stripe" || stripeUsesPaymentLink;
    if (currentInterval !== state.billingOrder.interval) {
      updateBillingOrder({ interval: currentInterval }, false);
    }
  } else {
    els.payChannelSelect.disabled = true;
    els.billingIntervalSelect.disabled = true;
  }

  const canStripeCheckout =
    channelEnabled("stripe") && Boolean(stripeConfig.checkoutReady || stripePaymentLinkReady);
  const canSelectedChannelPay =
    currentChannel === "stripe" ? canStripeCheckout : channelEnabled(currentChannel);
  els.upgradeProBtn.disabled = !paymentsEnabled || plan === "pro" || !canSelectedChannelPay;
  els.upgradeProBtn.textContent = isRegistered ? "升级 Pro" : "注册并升级";
  if (els.pullSyncBtn) els.pullSyncBtn.disabled = !isRegistered;
  if (els.pushSyncBtn) els.pushSyncBtn.disabled = !isRegistered;
  // Keep upload clickable in guest mode so users receive a clear upgrade/register prompt.
  if (els.fileInput) els.fileInput.disabled = false;
  if (els.exportProgressBtn) els.exportProgressBtn.disabled = !isRegistered;
  if (els.deleteBookBtn) els.deleteBookBtn.disabled = !isRegistered || !state.book?.id;
  if (els.deleteCloudBtn) els.deleteCloudBtn.disabled = !isRegistered;
  if (els.deleteAccountBtn) els.deleteAccountBtn.disabled = !isRegistered;

  if (!paymentsEnabled) {
    els.manageBillingBtn.disabled = true;
    els.manageBillingBtn.textContent = "管理支付";
    if (els.billingFlowHint) {
      els.billingFlowHint.textContent = "当前暂未开放升级。";
    }
  } else if (currentChannel === "stripe") {
    const hasCustomer = Boolean(stripeConfig.customerId);
    const canOpenPortal = Boolean(stripeConfig.portalReady && hasCustomer && !stripePaymentLinkReady);
    els.manageBillingBtn.disabled = !isRegistered || !canOpenPortal;
    els.manageBillingBtn.textContent = "管理订阅";
    if (els.billingFlowHint) {
      if (stripePaymentLinkReady) {
        els.billingFlowHint.textContent = "升级将跳转到 Stripe 支付链接。";
      } else if (!stripeConfig.checkoutReady) {
        els.billingFlowHint.textContent = "Stripe 未完成配置（秘钥或价格缺失），请先补全后端环境变量。";
      } else {
        const intervalLabel = currentInterval === "yearly" ? "年付" : "月付";
        els.billingFlowHint.textContent = `Stripe Checkout（${intervalLabel}）自动续费；可在“管理订阅”中变更或取消。`;
      }
    }
  } else {
    const hasOrder = Boolean(state.billingOrder.orderId);
    els.manageBillingBtn.disabled = !isRegistered || !hasOrder;
    els.manageBillingBtn.textContent = state.billing.manualPaymentConfirmEnabled
      ? "确认已支付"
      : "刷新支付状态";
    if (els.billingFlowHint) {
      els.billingFlowHint.textContent = `${paymentChannelLabel(currentChannel)} 支付完成后，点击右侧按钮同步开通状态。`;
    }
  }
  renderSyncUi();
}

async function refreshPaymentOptions(silent = true) {
  if (!state.apiOnline) {
    updateBilling({ paymentEnabled: false });
    return false;
  }
  try {
    const payload = await fetchJson("/api/payment/options", { method: "GET" });
    updateBilling({ paymentEnabled: Boolean(payload?.enabled) });
    return true;
  } catch (error) {
    updateBilling({ paymentEnabled: false });
    if (!silent) {
      setStatus(`支付配置拉取失败：${error.message}`, true);
    }
    return false;
  }
}

async function refreshBillingPlan(silent = false) {
  const userId = sanitizeSyncUserId(state.sync.userId);
  updateBilling({ userId });
  if (!state.apiOnline) {
    if (!silent) setStatus("API 离线：当前使用本地套餐缓存。", true);
    return false;
  }
  try {
    await refreshPaymentOptions(true);
    const payload = await fetchJson(
      `/api/billing/plan?userId=${encodeURIComponent(userId)}`,
      { method: "GET" }
    );
    if (payload?.billing) {
      updateBilling(payload.billing);
      if (payload.billing.lastOrderId) {
        updateBillingOrder({
          orderId: payload.billing.lastOrderId,
          channel: payload.billing.lastPaidChannel || state.billingOrder.channel,
        });
      }
    }
    if (!silent) {
      setStatus(`套餐已同步：${planUiLabel(state.billing.plan)}`);
    }
    return true;
  } catch (error) {
    if (!silent) {
      setStatus(`套餐同步失败：${error.message}`, true);
    }
    return false;
  }
}

function onPayChannelChange() {
  updateBillingOrder({ channel: normalizePayChannel(els.payChannelSelect.value) });
  renderBillingUi();
}

function onBillingIntervalChange() {
  updateBillingOrder({ interval: normalizeBillingInterval(els.billingIntervalSelect.value) });
  renderBillingUi();
}

async function onRegisterAccount(options = {}) {
  const username = String(els.registerAccountInput?.value || "").trim().toLowerCase();
  const password = String(els.registerPasswordInput?.value || "");
  if (els.registerAccountInput) {
    els.registerAccountInput.value = username;
  }
  if (
    !username ||
    !REGISTER_USERNAME_RE.test(username) ||
    username === "default" ||
    username.startsWith("guest_") ||
    username.startsWith("guest-")
  ) {
    const message = REGISTER_ERROR_MESSAGES.INVALID_USERNAME;
    setStatus(message, true);
    showToast(message, true);
    return false;
  }
  if (password.length < 8) {
    const message = REGISTER_ERROR_MESSAGES.WEAK_PASSWORD;
    setStatus(message, true);
    showToast(message, true);
    return false;
  }
  if (!state.apiOnline) {
    setStatus("API 离线，暂时无法注册账号。", true);
    showToast("API 离线，暂时无法注册账号。", true);
    return false;
  }
  setRegisterButtonLoading(true);
  try {
    const payload = await fetchJson("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        anonymousId: state.sync.anonymousId || state.sync.userId,
        snapshot: createSnapshot(),
      }),
    });
    state.sync = {
      ...DEFAULT_SYNC,
      ...state.sync,
      userId: payload.account?.userId || payload.userId || username,
      accountMode: "registered",
      accountToken: String(payload.account?.accountToken || ""),
      anonymousId: "",
      registeredAt: Date.now(),
    };
    persistSyncState();
    if (payload?.snapshot) {
      applySnapshot(payload.snapshot);
    }
    if (payload?.billing) {
      updateBilling(payload.billing);
    } else {
      await refreshBillingPlan(true);
    }
    renderSyncUi();
    renderBillingUi();
    renderExplainPanel();
    closeAccountModal();
    if (els.registerAccountInput) {
      els.registerAccountInput.value = "";
    }
    if (els.registerPasswordInput) {
      els.registerPasswordInput.value = "";
    }
    showToast("账号注册成功。");
    setStatus("账号注册成功。");
    if (options.upgradeAfter) {
      await onUpgradeProPlan();
    }
    return true;
  } catch (error) {
    const message = getRegisterErrorMessage(error);
    setStatus(message, true);
    showToast(message, true);
    return false;
  } finally {
    setRegisterButtonLoading(false);
  }
}

async function loginAccount() {
  const username = String(els.loginAccountInput?.value || "").trim().toLowerCase();
  const password = String(els.loginPasswordInput?.value || "");
  if (els.loginAccountInput) {
    els.loginAccountInput.value = username;
  }
  if (!username || !password) {
    const message = "请输入用户名和密码。";
    setStatus(message, true);
    showToast(message, true);
    return false;
  }
  if (!state.apiOnline) {
    const message = "API 离线，暂时无法登录账号。";
    setStatus(message, true);
    showToast(message, true);
    return false;
  }
  setLoginButtonLoading(true);
  try {
    const payload = await fetchJson("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
      }),
    });
    state.sync = {
      ...DEFAULT_SYNC,
      ...state.sync,
      userId: sanitizeSyncUserId(payload.account?.userId || username),
      accountMode: "registered",
      accountToken: String(payload.account?.accountToken || "").trim(),
      anonymousId: "",
      registeredAt: state.sync.registeredAt || Date.now(),
    };
    persistSyncState();
    localStorage.setItem("accountToken", state.sync.accountToken);
    localStorage.setItem("userId", state.sync.userId);
    closeAccountModal();
    window.location.reload();
    return true;
  } catch (error) {
    const message = getLoginErrorMessage(error);
    setStatus(message, true);
    showToast(message, true);
    return false;
  } finally {
    setLoginButtonLoading(false);
  }
}

async function completeStripeCheckout(sessionId) {
  await ensureApiHealthFresh(0);
  if (!state.apiOnline) {
    setStatus("API 离线，暂时无法确认 Stripe 订阅状态。", true);
    return false;
  }
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    setStatus("缺少 Stripe session_id，无法完成订阅确认。", true);
    return false;
  }
  try {
    const payload = await fetchJson("/api/billing/checkout-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: normalizedSessionId,
        userId: state.sync.userId,
      }),
    });
    if (payload?.billing) {
      updateBilling(payload.billing);
    }
    if (payload?.order) {
      updateBillingOrder({
        ...payload.order,
        channel: "stripe",
        sessionId: normalizedSessionId,
      });
    } else {
      updateBillingOrder({ channel: "stripe", sessionId: normalizedSessionId });
    }
    setStatus("Stripe 订阅已确认，Pro 套餐已生效。");
    return true;
  } catch (error) {
    if (error?.payload?.billing) {
      updateBilling(error.payload.billing);
    }
    setStatus(`Stripe 订阅确认失败：${error.message}`, true);
    return false;
  }
}

async function onUpgradeProPlan() {
  if (!state.billing.paymentEnabled) {
    setStatus("当前暂未开放升级。", true);
    return;
  }
  if (state.sync.accountMode !== "registered") {
    const registered = await onRegisterAccount({ upgradeAfter: false });
    if (!registered) return;
  }
  onSyncUserChange({ refreshBilling: false });
  if (!state.apiOnline) {
    setStatus("API 离线，无法发起支付。", true);
    return;
  }
  const channel = activePayChannel();
  void trackEvent("upgrade_clicked", {
    channel,
    plan: state.billing.plan,
  });
  if (!channelEnabled(channel)) {
    setStatus("当前支付渠道不可用。", true);
    return;
  }
  if (channel === "stripe") {
    await onUpgradeProPlanByStripe();
    return;
  }
  await onUpgradeProPlanByLegacyChannel(channel);
}

async function onUpgradeProPlanByStripe() {
  const stripeConfig = state.billing.stripe || {};
  const paymentLink = String(stripeConfig.paymentLink || "").trim();
  if (Boolean(stripeConfig.paymentLinkReady) && paymentLink) {
    setStatus("正在打开 Stripe 支付链接...");
    window.location.assign(paymentLink);
    return;
  }
  const interval = normalizeBillingInterval(state.billingOrder.interval || "monthly");
  try {
    const payload = await fetchJson("/api/billing/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: state.sync.userId,
        interval,
      }),
    });
    if (payload?.billing) {
      updateBilling(payload.billing);
    }
    if (payload?.order) {
      updateBillingOrder({
        ...payload.order,
        channel: "stripe",
        interval,
        sessionId: String(payload.sessionId || ""),
      });
    }
    const checkoutUrl = String(payload?.url || payload?.checkoutUrl || "").trim();
    if (!checkoutUrl) {
      setStatus("Stripe 支付链接为空，请检查后端配置。", true);
      return;
    }
    setStatus("正在跳转到 Stripe 支付页面...");
    window.location.assign(checkoutUrl);
  } catch (error) {
    if (error?.payload?.billing) {
      updateBilling(error.payload.billing);
    }
    setStatus(`Stripe 支付发起失败：${error.message}`, true);
  }
}

async function onUpgradeProPlanByLegacyChannel(channel) {
  try {
    const payload = await fetchJson("/api/billing/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: state.sync.userId,
        channel,
      }),
    });
    if (payload?.billing) {
      updateBilling(payload.billing);
    }
    if (payload?.order) {
      updateBillingOrder(payload.order);
      if (payload.order.orderId) {
        const paymentMode = String(payload.paymentMode || "").toLowerCase() === "official"
          ? "官方网关"
          : "支付页";
        setStatus(
          `订单已创建：${payload.order.orderId}，请完成${channel === "wechat" ? "微信" : "支付宝"}支付（${paymentMode}）。`
        );
      }
    }
    const payUrl = String(payload?.order?.payUrl || "").trim();
    if (payUrl) {
      window.open(payUrl, "_blank", "noopener,noreferrer");
    } else {
      setStatus("未配置支付跳转链接。支付完成后点击“确认已支付”。", true);
    }
  } catch (error) {
    if (error?.payload?.billing) {
      updateBilling(error.payload.billing);
    }
    setStatus(`发起支付失败：${error.message}`, true);
  }
}

async function onOpenBillingPortal() {
  onSyncUserChange({ refreshBilling: false });
  if (!state.apiOnline) {
    setStatus("API 离线，无法确认支付状态。", true);
    return;
  }
  if (activePayChannel() === "stripe") {
    await onOpenStripeBillingPortal();
    return;
  }
  await onOpenLegacyBillingPortal();
}

async function onOpenStripeBillingPortal() {
  try {
    const payload = await fetchJson("/api/billing/create-portal-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: state.sync.userId,
      }),
    });
    if (payload?.billing) {
      updateBilling(payload.billing);
    }
    const portalUrl = String(payload?.portalUrl || "").trim();
    if (!portalUrl) {
      setStatus("Stripe 管理页链接为空，请稍后重试。", true);
      return;
    }
    setStatus("正在打开 Stripe 订阅管理页...");
    window.location.assign(portalUrl);
  } catch (error) {
    if (error?.payload?.billing) {
      updateBilling(error.payload.billing);
    }
    setStatus(`打开 Stripe 订阅管理页失败：${error.message}`, true);
  }
}

async function onOpenLegacyBillingPortal() {
  if (!state.billingOrder.orderId) {
    setStatus("请先创建支付订单。", true);
    return;
  }
  try {
    const statusPayload = await fetchJson(
      `/api/billing/order-status?orderId=${encodeURIComponent(state.billingOrder.orderId)}&userId=${encodeURIComponent(
        state.sync.userId
      )}`,
      { method: "GET" }
    );
    if (statusPayload?.order) {
      updateBillingOrder(statusPayload.order);
    }
    if (statusPayload?.billing) {
      updateBilling(statusPayload.billing);
    }

    if (String(statusPayload?.order?.status || "").toLowerCase() === "paid") {
      setStatus("支付已确认，Pro 套餐已生效。");
      return;
    }
    if (!state.billing.manualPaymentConfirmEnabled) {
      setStatus("支付未完成或尚未到账，请稍后重试。");
      return;
    }

    const confirmPayload = await fetchJson("/api/billing/confirm-paid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: state.billingOrder.orderId,
      }),
    });
    if (confirmPayload?.order) {
      updateBillingOrder(confirmPayload.order);
    }
    if (confirmPayload?.billing) {
      updateBilling(confirmPayload.billing);
    }
    setStatus("支付已确认，Pro 套餐已开通。");
  } catch (error) {
    if (error?.payload?.billing) {
      updateBilling(error.payload.billing);
    }
    setStatus(`确认支付失败：${error.message}`, true);
  }
}

async function openFeedbackPrompt(kind) {
  const promptLabel = kind === "bug" ? "报告问题" : "发送反馈";
  const message = window.prompt(`${promptLabel}：请输入要提交的内容`);
  if (!message || !message.trim()) return;
  try {
    await fetchJson("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        message: message.trim(),
        userId: state.sync.userId,
        bookId: state.book?.id || "",
        chapterId: currentChapterData()?.id || "",
      }),
    });
    setStatus(`${promptLabel}已发送。`);
  } catch (error) {
    setStatus(`${promptLabel}失败：${error.message}`, true);
  }
}

function downloadJsonFile(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportProgressJson() {
  if (state.sync.accountMode !== "registered" || !hasFeature("cloudSync")) {
    const chapter = currentChapterData();
    downloadJsonFile("progress-export.json", {
      userId: state.sync.userId,
      exportedAt: Date.now(),
      progress: chapter
        ? [
            {
              bookId: state.book?.id || "",
              chapterId: chapter.id,
              chapterIndex: state.currentChapter,
              paragraphIndex: Number(state.lastCursor.paraIndex || 0),
              charIndex: Number(state.lastCursor.charIndex || 0),
            },
          ]
        : [],
    });
    setStatus("已导出本地进度。");
    return;
  }
  try {
    const payload = await fetchJson(
      `/api/export/progress?userId=${encodeURIComponent(state.sync.userId)}`,
      { method: "GET" }
    );
    downloadJsonFile(`progress-${state.sync.userId}.json`, payload);
    setStatus("已导出云端进度。");
  } catch (error) {
    setStatus(`导出进度失败：${error.message}`, true);
  }
}

async function onDeleteCurrentBook() {
  if (state.sync.accountMode !== "registered" || !state.book?.id) {
    setStatus("当前书籍不支持云端删除。", true);
    return;
  }
  if (!window.confirm("删除当前书籍及其云端进度？")) return;
  try {
    await fetchJson(`/api/books/${encodeURIComponent(state.book.id)}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: state.sync.userId }),
    });
    await onLoadSampleBook({ silentStatus: true });
    setStatus("当前书籍已删除，已回到示例书。");
  } catch (error) {
    setStatus(`删除书籍失败：${error.message}`, true);
  }
}

async function onDeleteCloudData() {
  if (state.sync.accountMode !== "registered") {
    setStatus("当前没有可删除的云端数据。", true);
    return;
  }
  if (!window.confirm("删除云端书籍、同步快照和进度？")) return;
  try {
    await fetchJson("/api/cloud/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: state.sync.userId }),
    });
    await onLoadSampleBook({ silentStatus: true });
    setStatus("云端数据已删除。");
  } catch (error) {
    setStatus(`删除云端数据失败：${error.message}`, true);
  }
}

async function onDeleteAccount() {
  if (state.sync.accountMode !== "registered") {
    setStatus("当前没有已注册账号。", true);
    return;
  }
  if (!window.confirm("删除账号及其全部云端数据？此操作不可恢复。")) return;
  try {
    await fetchJson("/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: state.sync.userId }),
    });
    state.vocab = [];
    state.notes = [];
    state.bookmarks = [];
    state.stats = { lookupCount: 0, totalSeconds: 0 };
    state.book = null;
    state.currentChapter = 0;
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
    state.sync = { ...DEFAULT_SYNC };
    ensureSessionIdentity();
    state.billing = normalizeBilling(DEFAULT_BILLING);
    saveJSON(STORAGE_KEYS.vocab, state.vocab);
    saveJSON(STORAGE_KEYS.notes, state.notes);
    saveJSON(STORAGE_KEYS.bookmarks, state.bookmarks);
    saveJSON(STORAGE_KEYS.stats, state.stats);
    persistSyncState();
    saveJSON(STORAGE_KEYS.billing, state.billing);
    await onLoadSampleBook({ silentStatus: true });
    await refreshBillingPlan(true);
    setStatus("账号已删除，已返回游客模式。");
  } catch (error) {
    setStatus(`删除账号失败：${error.message}`, true);
  }
}

function updateCloudSyncMeta(payload = {}) {
  state.sync = {
    ...state.sync,
    lastCloudSyncAction: String(payload.action || "").trim(),
    lastCloudSyncStatus: String(payload.status || "").trim(),
    lastCloudSyncMessage: String(payload.message || "").trim(),
    lastCloudSyncAt: Number(payload.updatedAt || state.sync.lastCloudSyncAt || 0),
  };
  persistSyncState();
  renderSyncUi();
}

function renderSyncUi() {
  const isRegistered = isRegisteredAccount();
  const cloudSyncEnabled = hasFeature("cloudSync");
  const lastStatus = String(state.sync.lastCloudSyncStatus || "").trim();
  const lastMessage = String(state.sync.lastCloudSyncMessage || "").trim();
  const lastAction = String(state.sync.lastCloudSyncAction || "").trim();
  const lastAt = Number(state.sync.lastCloudSyncAt || 0);

  if (els.userIdInput) {
    els.userIdInput.value =
      isRegistered ? currentAccountName() : state.sync.anonymousId || "游客模式";
    els.userIdInput.disabled = true;
  }
  if (els.cloudSyncSummary) {
    if (!isRegistered) {
      els.cloudSyncSummary.textContent = "注册后可在多设备同步阅读进度、生词和批注。";
    } else if (!cloudSyncEnabled) {
      els.cloudSyncSummary.textContent = "当前套餐暂不含云同步，升级 Pro 后可使用。";
    } else {
      els.cloudSyncSummary.textContent = "支持手动上传当前进度到云端，或从云端拉取并覆盖本地。";
    }
  }
  if (els.cloudSyncStatus) {
    if (!lastStatus) {
      els.cloudSyncStatus.textContent = "同步状态：尚未同步";
    } else {
      const actionText = lastAction === "pull" ? "拉取" : lastAction === "push" ? "上传" : "同步";
      const statusText =
        lastStatus === "success"
          ? "成功"
          : lastStatus === "empty"
          ? "云端无数据"
          : lastStatus === "blocked"
          ? "权限受限"
          : "失败";
      const detail = lastMessage ? `（${lastMessage}）` : "";
      els.cloudSyncStatus.textContent = `同步状态：${actionText}${statusText}${detail}`;
    }
  }
  if (els.cloudSyncUpdatedAt) {
    els.cloudSyncUpdatedAt.textContent = lastAt
      ? `最近同步：${formatDateTime(lastAt)}`
      : "最近同步：-";
  }
  if (els.cloudPullActionBtn) {
    els.cloudPullActionBtn.disabled = false;
  }
  if (els.cloudPushActionBtn) {
    els.cloudPushActionBtn.disabled = false;
  }
}

function onSyncUserChange(options = {}) {
  persistSyncState();
  if (options.refreshBilling !== false) {
    void refreshBillingPlan(true);
  }
}

async function onSyncPush() {
  onSyncUserChange({ refreshBilling: false });
  if (!isRegisteredAccount()) {
    updateCloudSyncMeta({
      action: "push",
      status: "blocked",
      message: "请先登录或注册账号",
    });
    showToast("请先登录或注册账号后再使用云同步。", true);
    return;
  }
  if (!state.apiOnline) {
    updateCloudSyncMeta({
      action: "push",
      status: "failed",
      message: "API 离线",
    });
    showToast("API 离线，无法云端上传。", true);
    return;
  }
  if (!hasFeature("cloudSync")) {
    await refreshBillingPlan(true);
    if (!hasFeature("cloudSync")) {
      updateCloudSyncMeta({
        action: "push",
        status: "blocked",
        message: "当前套餐不支持云同步",
      });
      showToast("云同步仅对 Pro 套餐开放。", true);
      return;
    }
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
    updateCloudSyncMeta({
      action: "push",
      status: "success",
      message: "已上传到云端",
      updatedAt: Number(payload?.data?.updatedAt || Date.now()),
    });
    setStatus(`云端上传成功（用户: ${state.sync.userId}）。`);
  } catch (error) {
    if (error?.payload?.billing) {
      updateBilling(error.payload.billing);
    }
    updateCloudSyncMeta({
      action: "push",
      status: "failed",
      message: String(error?.message || "上传失败"),
    });
    showToast(`云端上传失败：${error.message}`, true);
  }
}

async function onSyncPull() {
  onSyncUserChange({ refreshBilling: false });
  if (!isRegisteredAccount()) {
    updateCloudSyncMeta({
      action: "pull",
      status: "blocked",
      message: "请先登录或注册账号",
    });
    showToast("请先登录或注册账号后再使用云同步。", true);
    return;
  }
  if (!state.apiOnline) {
    updateCloudSyncMeta({
      action: "pull",
      status: "failed",
      message: "API 离线",
    });
    showToast("API 离线，无法云端拉取。", true);
    return;
  }
  if (!hasFeature("cloudSync")) {
    await refreshBillingPlan(true);
    if (!hasFeature("cloudSync")) {
      updateCloudSyncMeta({
        action: "pull",
        status: "blocked",
        message: "当前套餐不支持云同步",
      });
      showToast("云同步仅对 Pro 套餐开放。", true);
      return;
    }
  }
  try {
    const payload = await fetchJson(
      `/api/sync/pull?userId=${encodeURIComponent(state.sync.userId)}`,
      { method: "GET" }
    );
    if (!payload.ok) throw new Error(payload.error || "拉取失败");
    const snapshot = payload.data?.snapshot || {};
    if (!Object.keys(snapshot).length) {
      updateCloudSyncMeta({
        action: "pull",
        status: "empty",
        message: "云端暂无可用数据",
        updatedAt: Number(payload?.data?.updatedAt || 0),
      });
      setStatus("云端暂无可用数据。");
      return;
    }
    applySnapshot(snapshot);
    updateCloudSyncMeta({
      action: "pull",
      status: "success",
      message: "已拉取云端数据",
      updatedAt: Number(payload?.data?.updatedAt || Date.now()),
    });
    setStatus(`云端拉取成功（用户: ${state.sync.userId}）。`);
  } catch (error) {
    if (error?.payload?.billing) {
      updateBilling(error.payload.billing);
    }
    updateCloudSyncMeta({
      action: "pull",
      status: "failed",
      message: String(error?.message || "拉取失败"),
    });
    showToast(`云端拉取失败：${error.message}`, true);
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
    sync: {
      userId: state.sync.userId,
      accountMode: state.sync.accountMode,
    },
    savedAt: Date.now(),
  };
}

function applySnapshot(snapshot) {
  stopAutoPage();
  if (snapshot.book && Array.isArray(snapshot.book.chapters)) {
    state.book = normalizeBook(snapshot.book);
  }
  state.currentChapter = clampChapterIndex(snapshot.currentChapter);
  syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
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
      userId: String(snapshot.sync.userId || state.sync.userId || ""),
      accountMode:
        String(snapshot.sync.accountMode || state.sync.accountMode || "guest") === "registered"
          ? "registered"
          : state.sync.accountMode,
    };
  }
  if (state.sync.accountMode === "registered") {
    state.sync.userId = sanitizeSyncUserId(state.sync.userId) || state.sync.userId;
    state.sync.anonymousId = "";
  } else {
    state.sync.userId = sanitizeSyncUserId(state.sync.userId) || createAnonymousId();
    state.sync.anonymousId = state.sync.userId;
  }
  persistSyncState();
  updateBilling({ userId: state.sync.userId }, false);
  state.scrollBaseChapter = clampChapterIndex(state.currentChapter);
  state.renderedChapterCount = initialRenderedChapterCount();
  syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
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
  void refreshBillingPlan(true);
  void bootstrapBookExperience();
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
  persistBookState();
  saveJSON(STORAGE_KEYS.vocab, state.vocab);
  saveJSON(STORAGE_KEYS.notes, state.notes);
  saveJSON(STORAGE_KEYS.bookmarks, state.bookmarks);
  saveJSON(STORAGE_KEYS.settings, state.settings);
  saveJSON(STORAGE_KEYS.stats, state.stats);
  persistSyncState();
  saveJSON(STORAGE_KEYS.billing, state.billing);
  saveJSON(STORAGE_KEYS.billingOrder, state.billingOrder);
}

function setStatus(message, isError = false) {
  els.statusText.textContent = message;
  els.statusText.style.color = isError ? "#8f1f0a" : "";
}

function showToast(message, isError = false) {
  if (!els.toast) {
    setStatus(message, isError);
    return;
  }
  els.toast.textContent = message;
  els.toast.hidden = false;
  els.toast.classList.toggle("error", Boolean(isError));
  if (state.toastTimerId) {
    clearTimeout(state.toastTimerId);
  }
  state.toastTimerId = setTimeout(() => {
    els.toast.hidden = true;
    state.toastTimerId = null;
  }, 2400);
}

function appendListEmpty(listEl, text) {
  const li = document.createElement("li");
  li.className = "simple-item";
  li.textContent = text;
  listEl.appendChild(li);
}

async function trackEvent(name, payload = {}, options = {}) {
  if (!state.apiOnline || options.apiRequired === false) return;
  try {
    await fetchJson(
      "/api/events",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          userId: state.sync.userId,
          bookId: state.book?.id || "",
          chapterId: currentChapterData()?.id || "",
          payload,
        }),
      },
      3000
    );
  } catch {
    // Ignore analytics delivery failures.
  }
}

async function fetchJson(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(options.headers || {});
    if (state.sync.accountMode === "registered" && state.sync.accountToken) {
      headers.set("X-Account-Token", state.sync.accountToken);
    }
    const response = await fetch(resolveRequestUrl(url), {
      ...options,
      headers,
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.payload = payload;
      throw error;
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

function setRegisterButtonLoading(isLoading) {
  state.registeringAccount = Boolean(isLoading);
  if (els.registerAccountInput) {
    els.registerAccountInput.disabled =
      state.registeringAccount || isRegisteredAccount() || state.loggingInAccount;
  }
  if (els.registerPasswordInput) {
    els.registerPasswordInput.disabled =
      state.registeringAccount || isRegisteredAccount() || state.loggingInAccount;
  }
  if (!els.registerAccountButton) return;
  els.registerAccountButton.disabled =
    state.registeringAccount || isRegisteredAccount() || state.loggingInAccount;
  els.registerAccountButton.textContent = state.registeringAccount
    ? REGISTER_LOADING_LABEL
    : REGISTER_BUTTON_LABEL;
}

function setLoginButtonLoading(isLoading) {
  state.loggingInAccount = Boolean(isLoading);
  if (els.loginAccountInput) {
    els.loginAccountInput.disabled =
      state.loggingInAccount || isRegisteredAccount() || state.registeringAccount;
  }
  if (els.loginPasswordInput) {
    els.loginPasswordInput.disabled =
      state.loggingInAccount || isRegisteredAccount() || state.registeringAccount;
  }
  if (!els.loginButton) return;
  els.loginButton.disabled = state.loggingInAccount || isRegisteredAccount() || state.registeringAccount;
  els.loginButton.textContent = state.loggingInAccount ? LOGIN_LOADING_LABEL : LOGIN_BUTTON_LABEL;
}

function shouldPersistBookStateToLocal() {
  if (state.sync.accountMode === "registered") return true;
  return Boolean(state.book?.sampleSlug);
}

function clearPersistedBookState() {
  localStorage.removeItem(STORAGE_KEYS.book);
  localStorage.removeItem(STORAGE_KEYS.currentChapter);
}

function persistBookState(options = {}) {
  const persistLocal =
    options.persistLocal === undefined
      ? shouldPersistBookStateToLocal()
      : Boolean(options.persistLocal);
  if (!persistLocal) {
    clearPersistedBookState();
    return;
  }
  saveJSON(STORAGE_KEYS.book, state.book);
  saveJSON(STORAGE_KEYS.currentChapter, state.currentChapter);
}

function persistCurrentChapterState() {
  if (!shouldPersistBookStateToLocal()) {
    clearPersistedBookState();
    return;
  }
  saveJSON(STORAGE_KEYS.currentChapter, state.currentChapter);
}

function getRegisterErrorMessage(error) {
  const code = String(error?.payload?.code || error?.code || "")
    .trim()
    .toUpperCase();
  if (code === "ACCOUNT_EXISTS") {
    return REGISTER_ERROR_MESSAGES.USERNAME_EXISTS;
  }
  return REGISTER_ERROR_MESSAGES[code] || String(error?.message || "注册失败。");
}

function getLoginErrorMessage(error) {
  const code = String(error?.payload?.code || error?.code || "")
    .trim()
    .toUpperCase();
  return LOGIN_ERROR_MESSAGES[code] || String(error?.message || "登录失败。");
}

function logoutAccount() {
  localStorage.removeItem("accountToken");
  localStorage.removeItem("userId");

  const guestId = createAnonymousId();
  localStorage.setItem("userId", guestId);

  state.sync = {
    ...DEFAULT_SYNC,
    userId: guestId,
    anonymousId: guestId,
    accountMode: "guest",
    accountToken: "",
    registeredAt: 0,
  };
  state.billing = normalizeBilling({
    ...DEFAULT_BILLING,
    userId: guestId,
    accountMode: "guest",
  });
  state.billingOrder = normalizeBillingOrder({});
  persistSyncState();
  saveJSON(STORAGE_KEYS.billing, state.billing);
  saveJSON(STORAGE_KEYS.billingOrder, state.billingOrder);

  window.location.reload();
}

function saveJSON(key, value) {
  if (
    (key === STORAGE_KEYS.book || key === STORAGE_KEYS.currentChapter) &&
    !shouldPersistBookStateToLocal()
  ) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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

function formatDateTime(ts) {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return "-";
  return `${formatDate(ts)} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

function bookHasPrecomputedAnalysis() {
  return Boolean(
    state.book?.chapters?.some(
      (chapter) =>
        chapter?.analysis &&
        Array.isArray(chapter.analysis.tokens) &&
        chapter.analysis.tokens.length
    )
  );
}
