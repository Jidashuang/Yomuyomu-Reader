import {
  BLOCKED_POS_RE,
  DAY_MS,
  DEFAULT_BILLING,
  DEFAULT_SETTINGS,
  DEFAULT_SYNC,
  FREE_FEATURE_HINT,
  HARD_WORD_LEVELS,
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
import {
  normalizeBilling as normalizeBillingData,
  normalizeBillingCycle,
  normalizeBillingInterval,
  normalizeBillingOrder as normalizeBillingOrderData,
  normalizePayChannel,
  normalizePlan,
  sanitizeSyncUserId,
} from "./utils/normalize.js";
import {
  loadStorageValue,
  removeStorageItem,
  saveJSON as saveStoredJSON,
  saveStorageValue,
} from "./utils/storage.js";
import { createReaderSession } from "./features/reader/readerSession.js";
import { createReaderUi } from "./features/reader/readerUi.js";
import { createReaderActions } from "./features/reader/readerActions.js";
import { createReaderSelection } from "./features/reader/readerSelection.js";
import { createReaderAnnotations } from "./features/reader/readerAnnotations.js";
import { createReaderCore } from "./features/reader/readerCore.js";
import { createReaderNavigation } from "./features/reader/readerNavigation.js";
import { setAccountTokenProvider } from "./services/apiClient.js";
import * as accountService from "./services/accountService.js";
import * as billingService from "./services/billingService.js";
import * as syncService from "./services/syncService.js";
import * as analysisService from "./services/analysisService.js";
import * as dictionaryService from "./services/dictionaryService.js";
import {
  alignMatchedWordToToken,
  findJlptMatch,
} from "./services/localDictionaryLookup.js";
import {
  isSuspiciousGluedLexicalToken,
  shouldTrustAnalysisTokens,
} from "./services/analysisTokenReliability.js";
import * as ttsService from "./services/ttsService.js";

export function initApp() {
  ensureSessionIdentity();
  state.billing = normalizeBillingState(state.billing);
  state.billingOrder = normalizeBillingOrderState(state.billingOrder);
  if (!state.billingOrder.channel) {
    state.billingOrder.channel = "stripe";
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
const REGISTER_PASSWORD_MIN_LENGTH = 8;
const REGISTER_BUTTON_LABEL = "注册";
const REGISTER_LOADING_LABEL = "注册中...";
const REGISTER_ERROR_MESSAGES = {
  INVALID_USERNAME: "用户名不合法，请使用小写字母、数字、_ 或 -。",
  WEAK_PASSWORD: `密码至少需要 ${REGISTER_PASSWORD_MIN_LENGTH} 位字符。`,
  USERNAME_EXISTS: "用户名已存在。",
};
const LOGIN_BUTTON_LABEL = "登录";
const LOGIN_LOADING_LABEL = "登录中...";
const LOGIN_ERROR_MESSAGES = {
  INVALID_CREDENTIALS: "用户名或密码错误。",
};
const FORGOT_PASSWORD_PLACEHOLDER_MESSAGE = "重置密码功能即将开放，请联系管理员协助重置密码。";
const RIGHT_PANEL_TABS = ["vocab", "notes", "more"];
const STRIPE_JS_URL = "https://js.stripe.com/v3";

let stripeSdkLoadPromise = null;
let stripeClient = null;
let stripeClientKey = "";
const uiStore = state.uiStore || state.ui;
const readerSessionStore = state.readerStore?.sessionState;

function setCurrentChapterIndex(chapterIndex) {
  if (readerSessionStore?.setCurrentChapter) {
    readerSessionStore.setCurrentChapter(chapterIndex);
    return;
  }
  state.currentChapter = clampChapterIndex(chapterIndex);
}

function setSelectionState(partial = {}) {
  if (readerSessionStore?.setSelection) {
    readerSessionStore.setSelection(partial);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(partial, "selected")) {
    state.selected = partial.selected;
  }
  if (Object.prototype.hasOwnProperty.call(partial, "selectedRange")) {
    state.selectedRange = partial.selectedRange;
  }
  if (Object.prototype.hasOwnProperty.call(partial, "selectedSentence")) {
    state.selectedSentence = partial.selectedSentence;
  }
}

function resetExplainState() {
  const nextExplain = {
    loading: false,
    sentenceId: "",
    cached: false,
    result: null,
    error: "",
  };
  if (readerSessionStore?.setExplain) {
    readerSessionStore.setExplain(nextExplain);
    return;
  }
  state.explain = nextExplain;
}

// Reader directly uses services; bootstrap bridge stays as legacy compatibility only.
setAccountTokenProvider(() =>
  state.sync.accountMode === "registered" ? String(state.sync.accountToken || "").trim() : ""
);

function normalizeBillingState(raw) {
  return normalizeBillingData(raw, {
    defaultBilling: DEFAULT_BILLING,
    syncUserId: state.sync?.userId,
  });
}

function normalizeBillingOrderState(raw) {
  return normalizeBillingOrderData(raw, {
    defaultChannel: "stripe",
    defaultInterval: "monthly",
  });
}

function currentStripePublishableKey() {
  return String(state.billing?.stripe?.publishableKey || "").trim();
}

function loadStripeSdk() {
  if (typeof window.Stripe === "function") {
    return Promise.resolve();
  }
  if (stripeSdkLoadPromise) {
    return stripeSdkLoadPromise;
  }
  stripeSdkLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${STRIPE_JS_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Stripe.js 加载失败。")), {
        once: true,
      });
      return;
    }
    const script = document.createElement("script");
    script.src = STRIPE_JS_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Stripe.js 加载失败。"));
    document.head.appendChild(script);
  });
  return stripeSdkLoadPromise;
}

async function ensureStripeClient() {
  const publishableKey = currentStripePublishableKey();
  if (!publishableKey) {
    throw new Error("缺少 STRIPE_PUBLISHABLE_KEY，无法发起 Stripe Checkout。");
  }
  await loadStripeSdk();
  if (typeof window.Stripe !== "function") {
    throw new Error("Stripe.js 未就绪。");
  }
  if (!stripeClient || stripeClientKey !== publishableKey) {
    stripeClient = window.Stripe(publishableKey);
    stripeClientKey = publishableKey;
  }
  return stripeClient;
}

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
    userId: sanitizeSyncUserId(loadStorageValue("userId", "")),
    accountToken: String(loadStorageValue("accountToken", "")).trim(),
  };
}

function syncLegacyAccountStorage() {
  if (isRegisteredAccount()) {
    saveStorageValue("userId", state.sync.userId);
    if (state.sync.accountToken) {
      saveStorageValue("accountToken", state.sync.accountToken);
    } else {
      removeStorageItem("accountToken");
    }
    return;
  }
  const guestId = sanitizeSyncUserId(state.sync.anonymousId || state.sync.userId) || createAnonymousId();
  saveStorageValue("userId", guestId);
  removeStorageItem("accountToken");
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
    setCurrentChapterIndex(0);
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
  if (uiStore?.setDropdownActive) {
    uiStore.setDropdownActive("");
  } else if (uiStore?.dropdown) {
    uiStore.dropdown.activeId = "";
  }
}

function openAccountModal(options = {}) {
  if (!els.accountModal || isAccountModalOpen()) return;
  els.accountModal.hidden = false;
  document.body.classList.add("modal-open");
  if (uiStore?.setAccountModal) {
    uiStore.setAccountModal(true);
  } else if (uiStore?.modal) {
    uiStore.modal.account = true;
  }
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
  if (uiStore?.setAccountModal) {
    uiStore.setAccountModal(false);
  } else if (uiStore?.modal) {
    uiStore.modal.account = false;
  }
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

let readerActions = null;
let readerCore = null;
let readerNavigation = null;

const readerSession = createReaderSession({ state });
const { syncReaderState, resetReaderTransientState, resetReaderAnalysisCaches } = readerSession;

const readerUi = createReaderUi({
  state,
  els,
  STORAGE_KEYS,
  RIGHT_PANEL_TABS,
  READER_FONT_MAP,
  MOJI_SCHEME_MAP,
  MOJI_WEB_HOME,
  MOJI_WEB_SEARCH,
  MAC_DICT_SCHEME,
  saveJSON,
  setStatus,
  clampNumber,
  syncReaderState,
  normalizeReadingMode: (...args) => readerActions.normalizeReadingMode(...args),
  isPagedMode: (...args) => readerActions.isPagedMode(...args),
  syncPagedPageState: (...args) => readerNavigation.syncPagedPageState(...args),
  stopAutoPage: (...args) => readerActions.stopAutoPage(...args),
  scheduleDifficultyPaint,
  applyVisibleDifficultyToDom,
  restartAutoPage: () => readerActions.startAutoPage(),
});
const {
  openToolsSection,
  readerScrollContainer,
  adjustReaderSettingsPanelPosition,
  scheduleReaderSettingsPanelPosition,
  normalizeMojiScheme,
  normalizeReaderFont,
  normalizeRightPanelTab,
  onRightTabsClick,
  setRightPanelTab,
  renderRightTabs,
  renderReadingModeUi,
  renderAutoPageUi,
  onDictLinkClick,
  renderLookupPanel,
  renderExplainPanel,
  onSettingsChange,
  applySettings,
} = readerUi;

const readerSelection = createReaderSelection({
  state,
  els,
  STORAGE_KEYS,
  JP_WORD_RE,
  MINI_DICT,
  tokenizeText: (payload, options) => analysisService.tokenize(payload, options),
  lookupWord: (payload, options) => dictionaryService.lookup(payload, options),
  explainSentenceByAi: (payload, options) => analysisService.explain(payload, options),
  ensureApiHealthFresh,
  renderApiStatus,
  getChapterById: (...args) => readerCore.getChapterById(...args),
  clampChapterIndex: (...args) => readerNavigation.clampChapterIndex(...args),
  syncReadingProgress: (...args) => readerCore.syncReadingProgress(...args),
  syncReaderState,
  persistCurrentChapterState,
  renderBookMeta: (...args) => readerCore.renderBookMeta(...args),
  renderChapterList: (...args) => readerCore.renderChapterList(...args),
  renderHardWords,
  scheduleDifficultyPaint,
  findSentenceAt,
  normalizeKnownWordCandidate,
  isBoundary,
  trackEvent,
  saveJSON,
  getJlptLevel,
  renderLookupPanel: (...args) => readerUi.renderLookupPanel(...args),
  renderStats,
  updateBilling,
  showToast,
  renderReader: (...args) => readerCore.renderReader(...args),
  renderExplainPanel: (...args) => readerUi.renderExplainPanel(...args),
});
const {
  onReaderClick,
  onReaderMouseUp,
  onReaderTouchEnd,
  getParagraphTokens,
  extractSentenceExample,
  lookupLocalDictionary,
  stripWordNoise,
  normalizeReading,
  normalizeToken,
  markSelection,
  clearSelectionMark,
  explainSentence,
} = readerSelection;

const readerAnnotations = createReaderAnnotations({
  state,
  els,
  STORAGE_KEYS,
  DAY_MS,
  saveJSON,
  setStatus,
  appendListEmpty,
  makeId,
  chapterIndexById: (...args) => readerNavigation.chapterIndexById(...args),
  getChapterById: (...args) => readerCore.getChapterById(...args),
  syncReaderState,
  persistCurrentChapterState,
  ensureRenderedThrough: (...args) => readerCore.ensureRenderedThrough(...args),
  ensureChapterLoaded: (...args) => readerCore.ensureChapterLoaded(...args),
  renderBookMeta: (...args) => readerCore.renderBookMeta(...args),
  renderChapterList: (...args) => readerCore.renderChapterList(...args),
  renderReader: (...args) => readerCore.renderReader(...args),
  renderStats,
  markSelection: (...args) => readerSelection.markSelection(...args),
  renderLookupPanel: (...args) => readerUi.renderLookupPanel(...args),
  syncReadingProgress: (...args) => readerCore.syncReadingProgress(...args),
  requestAnalyze: (...args) => readerActions.requestAnalyze(...args),
  trackEvent,
  formatDate,
  csvEscape,
  exportVocabByUser: (userId, options) => syncService.exportVocab(userId, options),
  hasFeature,
  openToolsSection: (...args) => readerUi.openToolsSection(...args),
  setRightPanelTab: (...args) => readerUi.setRightPanelTab(...args),
});
const {
  getNoteRanges,
  findRangeHit,
  onAddWord,
  onAddNoteClick,
  onSaveNote,
  renderNotes,
  onNoteListClick,
  onAddBookmark,
  renderBookmarks,
  onBookmarkListClick,
  jumpToPosition,
  renderVocab,
  onVocabAction,
  exportVocabCsv,
} = readerAnnotations;

readerCore = createReaderCore({
  state,
  els,
  SAMPLE_BOOK,
  fetchJson,
  wait,
  checkApiHealth,
  setStatus,
  updateBilling,
  normalizeReadingMode: (...args) => readerActions.normalizeReadingMode(...args),
  clampChapterIndex: (...args) => readerNavigation.clampChapterIndex(...args),
  chapterIndexById: (...args) => readerNavigation.chapterIndexById(...args),
  syncReaderState,
  resetReaderTransientState,
  resetReaderAnalysisCaches,
  stopAutoPage: (...args) => readerActions.stopAutoPage(...args),
  persistBookState,
  persistCurrentChapterState,
  clearPersistedBookState,
  renderAll,
  renderHardWords,
  requestAnalyze: (...args) => readerActions.requestAnalyze(...args),
  readerScrollContainer: (...args) => readerUi.readerScrollContainer(...args),
  scheduleDifficultyPaint,
  markSelection: (...args) => readerSelection.markSelection(...args),
  isPagedMode: (...args) => readerActions.isPagedMode(...args),
  syncPagedPageState: (...args) => readerNavigation.syncPagedPageState(...args),
  getKnownRanges,
  getNoteRanges: (...args) => readerAnnotations.getNoteRanges(...args),
  getDifficultyRanges,
  getSentenceRangesForParagraph,
  findRangeHit: (...args) => readerAnnotations.findRangeHit(...args),
  shouldHighlightLevel,
  clampNumber,
});
const {
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
} = readerCore;

readerNavigation = createReaderNavigation({
  state,
  els,
  isAccountModalOpen,
  closeAccountModal,
  normalizeReadingMode: (...args) => readerActions.normalizeReadingMode(...args),
  isPagedMode: (...args) => readerActions.isPagedMode(...args),
  syncReaderState,
  initialRenderedChapterCount: (...args) => readerCore.initialRenderedChapterCount(...args),
  ensureRenderedThrough: (...args) => readerCore.ensureRenderedThrough(...args),
  persistCurrentChapterState,
  renderReader: (...args) => readerCore.renderReader(...args),
  renderHardWords,
  scheduleDifficultyPaint,
  updateChapterHeader: (...args) => readerCore.updateChapterHeader(...args),
  updateTocHighlight: (...args) => readerCore.updateTocHighlight(...args),
  ensureChapterLoaded: (...args) => readerCore.ensureChapterLoaded(...args),
  renderAll,
  prefetchNextChapter: (...args) => readerCore.prefetchNextChapter(...args),
  syncReadingProgress: (...args) => readerCore.syncReadingProgress(...args),
  readerScrollContainer: (...args) => readerUi.readerScrollContainer(...args),
  setStatus,
  renderBookMeta: (...args) => readerCore.renderBookMeta(...args),
  renderChapterList: (...args) => readerCore.renderChapterList(...args),
  scrollReaderToTop: (...args) => readerCore.scrollReaderToTop(...args),
  flashChapterHeader: (...args) => readerCore.flashChapterHeader(...args),
});
const {
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
} = readerNavigation;

readerActions = createReaderActions({
  state,
  STORAGE_KEYS,
  saveJSON,
  setStatus,
  clampNumber,
  applySettings: (...args) => readerUi.applySettings(...args),
  renderAutoPageUi: (...args) => readerUi.renderAutoPageUi(...args),
  renderReadingModeUi: (...args) => readerUi.renderReadingModeUi(...args),
  syncReaderState,
  stopAutoPageExternal: null,
  renderReader: (...args) => readerCore.renderReader(...args),
  scrollToChapter: (...args) => readerNavigation.scrollToChapter(...args),
  getCurrentChapterPageCount: (...args) => readerNavigation.getCurrentChapterPageCount(...args),
  renderCurrentPage: (...args) => readerNavigation.renderCurrentPage(...args),
  goNextPage: (...args) => readerNavigation.goNextPage(...args),
  clampChapterIndex: (...args) => readerNavigation.clampChapterIndex(...args),
  initialRenderedChapterCount: (...args) => readerCore.initialRenderedChapterCount(...args),
  analyzeBookVocabulary,
});
const {
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
} = readerActions;

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
  els.forgotPasswordBtn?.addEventListener("click", onForgotPasswordClick);
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
  els.payChannelSelect?.addEventListener("change", onPayChannelChange);
  els.billingIntervalSelect?.addEventListener("change", onBillingIntervalChange);
  els.upgradeProBtn?.addEventListener("click", onUpgradeProPlan);
  els.manageBillingBtn?.addEventListener("click", onOpenBillingPortal);
  const settingsPopoverEl = document.getElementById("readerSettingsPopover");
  settingsPopoverEl?.addEventListener("toggle", () => {
    if (settingsPopoverEl.open) {
      scheduleReaderSettingsPanelPosition();
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (els.accountMenu?.open && !target?.closest("#accountMenu")) {
      els.accountMenu.open = false;
    }
    if (settingsPopoverEl?.open && !target?.closest("#readerSettingsPopover")) {
      settingsPopoverEl.open = false;
    }
  });

  window.addEventListener("beforeunload", () => {
    persistAll();
    onStopTts();
    stopAutoPage();
  });

  window.addEventListener("keydown", onReaderHotkey);
  window.addEventListener("resize", scheduleReaderSettingsPanelPosition);

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

// Reader core/navigation/actions/session are delegated to features/reader modules above.

const JLPT_LEVEL_ORDER = {
  N1: 0,
  N2: 1,
  N3: 2,
  N4: 3,
  N5: 4,
};

function jlptLevelRank(level) {
  return Number.isFinite(JLPT_LEVEL_ORDER[level]) ? JLPT_LEVEL_ORDER[level] : 99;
}

function mergePreferredJlptLevel(current, next) {
  const currentLevel = normalizeJlptLevel(current);
  const nextLevel = normalizeJlptLevel(next);
  if (!nextLevel) return currentLevel;
  if (!currentLevel) return nextLevel;
  return jlptLevelRank(nextLevel) < jlptLevelRank(currentLevel) ? nextLevel : currentLevel;
}

async function ensureChapterForAnalysis(chapterIndex) {
  const chapter = state.book?.chapters?.[chapterIndex];
  if (!chapter) return null;
  if (Array.isArray(chapter.paragraphs) && chapter.paragraphs.length) return chapter;
  if (!state.apiOnline || !state.book?.id) return chapter;
  try {
    return (await ensureChapterLoaded(chapterIndex, { prefetch: true })) || state.book?.chapters?.[chapterIndex] || chapter;
  } catch {
    return state.book?.chapters?.[chapterIndex] || chapter;
  }
}

async function collectChapterTokensForAnalysis(chapter, chapterIndex) {
  const resolvedChapter = await ensureChapterForAnalysis(chapterIndex);
  if (!resolvedChapter) return { chapter: null, tokens: [] };

  const analysisTokens = Array.isArray(resolvedChapter?.analysis?.tokens)
    ? resolvedChapter.analysis.tokens.map(normalizeToken).filter((token) => token.surface)
    : [];
  if (shouldTrustAnalysisTokens(analysisTokens)) {
    return { chapter: resolvedChapter, tokens: analysisTokens };
  }

  const paragraphs = Array.isArray(resolvedChapter?.paragraphs) ? resolvedChapter.paragraphs : [];
  if (!paragraphs.length) {
    return { chapter: resolvedChapter, tokens: [] };
  }

  const tokens = [];
  for (let paraIndex = 0; paraIndex < paragraphs.length; paraIndex += 1) {
    const paragraph = String(paragraphs[paraIndex] || "");
    if (!paragraph) continue;
    const paragraphTokens = await getParagraphTokens(resolvedChapter.id, paraIndex, paragraph);
    paragraphTokens.map(normalizeToken).forEach((token) => {
      tokens.push({
        ...token,
        paragraphIndex: Number(token.paragraphIndex ?? paraIndex) || paraIndex,
      });
    });
  }
  return { chapter: resolvedChapter, tokens };
}

function normalizeTopWords(rawTopWords) {
  if (!Array.isArray(rawTopWords)) return [];
  return rawTopWords
    .map((item) => {
      const word = String(item?.word || item?.surface || item?.lemma || "").trim();
      const lemma = String(item?.lemma || word).trim() || word;
      const count = Number(item?.count || item?.freq || item?.occurrences || 0);
      const level = normalizeJlptLevel(item?.level || item?.jlpt || "");
      if (!word || !Number.isFinite(count) || count <= 0) return null;
      return {
        word,
        lemma,
        count,
        level,
        reading: normalizeReading(item?.reading || "", word) || "-",
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count || jlptLevelRank(a.level) - jlptLevelRank(b.level) || a.word.localeCompare(b.word, "ja"));
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

  const runId = Number(state.analysisRunId || 0) + 1;
  state.analysisRunId = runId;
  state.analysisReady = false;
  renderHardWords();
  renderFrequencyStats();

  const hardWordsByChapter = new Map();
  const knownSet = new Set(getKnownWords().map((item) => normalizeWordKey(item)));
  const levelBuckets = { N1: 0, N2: 0, N3: 0, other: 0 };
  const allTokenWordSet = new Set();
  let totalTokens = 0;
  const bookFreqMap = new Map();

  for (let chapterIndex = 0; chapterIndex < state.book.chapters.length; chapterIndex += 1) {
    if (state.analysisRunId !== runId) return;
    const rawChapter = state.book.chapters[chapterIndex];
    const { chapter, tokens } = await collectChapterTokensForAnalysis(rawChapter, chapterIndex);
    if (state.analysisRunId !== runId) return;
    if (!chapter) continue;
    const canUsePrecomputedHardWords = chapterHasTrustedAnalysisTokens(chapter);

    const chapterFreqMap = new Map();
    totalTokens += tokens.length;
    tokens.forEach((rawToken) => {
      const token = resolveAnalysisLexeme(rawToken);
      const lemmaOrSurface = normalizeWordKey(token.matchedLemma || token.lemma || token.surface);
      if (lemmaOrSurface && JP_WORD_RE.test(lemmaOrSurface) && !isBoundary(lemmaOrSurface)) {
        allTokenWordSet.add(lemmaOrSurface);
      }
      if (!isAnalyzableWord(token, lemmaOrSurface)) return;
      const level = normalizeJlptLevel(
        token.jlpt || getJlptLevel(token.surface, token.lemma, token.dictionaryForm)
      );
      if (level && Object.prototype.hasOwnProperty.call(levelBuckets, level)) {
        levelBuckets[level] += 1;
      } else {
        levelBuckets.other += 1;
      }

      const word = stripWordNoise(token.matchedWord || token.surface) || lemmaOrSurface;
      const reading = normalizeReading(token.reading || "", word) || "-";
      const upsert = (target) => {
        const current = target.get(lemmaOrSurface) || {
          word: word || lemmaOrSurface,
          lemma: lemmaOrSurface,
          reading: reading || "-",
          level,
          count: 0,
          meaning: "",
        };
        current.count += 1;
        if (!current.word && word) current.word = word;
        if (!current.reading || current.reading === "-") current.reading = reading || "-";
        current.level = mergePreferredJlptLevel(current.level, level);
        target.set(lemmaOrSurface, current);
      };
      upsert(chapterFreqMap);
      upsert(bookFreqMap);
    });

    const chapterHardMap = new Map();
    const precomputedHardWords = Array.isArray(chapter?.analysis?.difficultVocab)
      ? chapter.analysis.difficultVocab
      : [];
    if (canUsePrecomputedHardWords) {
      precomputedHardWords.forEach((item) => {
        const entry = buildHardWordOverviewEntry(item);
        const key = normalizeWordKey(entry?.lemma || "");
        if (!entry || !key || knownSet.has(key)) return;
        chapterHardMap.set(key, entry);
      });
    }

    chapterFreqMap.forEach((item, key) => {
      const entry = buildHardWordOverviewEntry(item);
      const entryKey = normalizeWordKey(entry?.lemma || key);
      if (!entry || !entryKey || knownSet.has(entryKey)) return;
      if (!chapterHardMap.has(entryKey)) {
        chapterHardMap.set(entryKey, entry);
        return;
      }
      const merged = chapterHardMap.get(entryKey);
      merged.count = Math.max(Number(merged.count || 0), Number(entry.count || 0));
      merged.level = mergePreferredJlptLevel(merged.level, entry.level);
      if (!merged.reading || merged.reading === "-") merged.reading = entry.reading || "-";
      if (!merged.word) merged.word = entry.word || entryKey;
      if (!merged.lemma) merged.lemma = entry.lemma || entryKey;
      if (!merged.meaning) merged.meaning = entry.meaning || "";
      chapterHardMap.set(entryKey, merged);
    });

    const chapterHardWords = [...chapterHardMap.values()]
      .sort(
        (a, b) =>
          jlptLevelRank(a.level) - jlptLevelRank(b.level) ||
          Number(b.count || 0) - Number(a.count || 0) ||
          String(a.word || a.lemma || "").localeCompare(String(b.word || b.lemma || ""), "ja")
      )
      .slice(0, 18)
      .map((item) => {
        const fallbackMeaning = lookupLocalDictionary(item.word || item.lemma, item.lemma || item.word);
        const meaning =
          String(item.meaning || "").trim() ||
          (fallbackMeaning.source && fallbackMeaning.source !== "none" ? fallbackMeaning.meaning : "") ||
          "点击查看释义";
        return {
          word: String(item.word || item.lemma || ""),
          lemma: String(item.lemma || item.word || ""),
          level: String(item.level || ""),
          count: Number(item.count || 0),
          reading: String(item.reading || "-"),
          meaning,
        };
      });
    hardWordsByChapter.set(chapter.id, chapterHardWords);
  }

  const sourceStats = state.book.stats && typeof state.book.stats === "object" ? state.book.stats : {};
  const levelBucketsSource =
    sourceStats.levelBuckets && typeof sourceStats.levelBuckets === "object"
      ? sourceStats.levelBuckets
      : {};
  const sourceTopWords = normalizeTopWords(sourceStats.topWords || sourceStats.top_words);

  const computedTopWords = [...bookFreqMap.values()]
    .filter((item) => item && Number(item.count || 0) > 0)
    .map((item) => ({
      word: String(item.word || item.lemma || ""),
      lemma: String(item.lemma || item.word || ""),
      reading: String(item.reading || "-"),
      level: String(item.level || ""),
      count: Number(item.count || 0),
    }))
    .filter((item) => item.word)
    .sort(
      (a, b) =>
        Number(b.count || 0) - Number(a.count || 0) ||
        jlptLevelRank(a.level) - jlptLevelRank(b.level) ||
        String(a.word || "").localeCompare(String(b.word || ""), "ja")
    );

  const hasComputedTokens = totalTokens > 0 || allTokenWordSet.size > 0;
  const finalTopWords = computedTopWords.length ? computedTopWords : sourceTopWords;
  const finalLevelBuckets = hasComputedTokens
    ? levelBuckets
    : {
        N1: Number(levelBucketsSource.N1 || 0),
        N2: Number(levelBucketsSource.N2 || 0),
        N3: Number(levelBucketsSource.N3 || 0),
        other: Number(levelBucketsSource.other || 0),
      };

  if (state.analysisRunId !== runId) return;
  state.hardWordsByChapter = hardWordsByChapter;
  state.bookFrequencyStats = {
    totalTokens: hasComputedTokens ? Number(totalTokens || 0) : Number(sourceStats.totalTokens || 0),
    uniqueWords: hasComputedTokens ? Number(allTokenWordSet.size || 0) : Number(sourceStats.uniqueWords || 0),
    topWords: finalTopWords,
    levelBuckets: finalLevelBuckets,
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
    button.dataset.hardLemma = item.lemma || item.word;
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
  const lemma = String(button.dataset.hardLemma || word).trim() || word;
  const level = String(button.dataset.level || "").trim();
  if (!word) return;
  inspectWordFromList(word, lemma, level);
}

function inspectWordFromList(word, lemma = word, level = "") {
  const local = lookupLocalDictionary(word, lemma);
  const chapter = currentChapterData();
  const hit = chapter ? findWordInChapter(chapter, word, lemma) : null;
  const example = hit
    ? extractSentenceExample(chapter.paragraphs[hit.paraIndex], hit.start, hit.end)
    : "未提取到例句";
  const selectedWord = String(local.matchedWord || word).trim() || word;
  const selectedLemma = String(local.matchedLemma || lemma || selectedWord).trim() || selectedWord;
  setSelectionState({
    selected: {
      word: selectedWord,
      lemma: selectedLemma,
      matchedWord: selectedWord,
      matchedLemma: selectedLemma,
      reading: local.reading || "-",
      pos: "难词速览",
      meaning: local.meaning,
      example,
      jlpt: level || getJlptLevel(word, lemma),
    },
  });
  renderLookupPanel();

  if (!chapter) return;
  if (!hit) return;
  clearSelectionMark();
  setSelectionState({
    selectedRange: {
      chapterId: chapter.id,
      paraIndex: hit.paraIndex,
      start: hit.start,
      end: hit.end,
    },
  });
  markSelection();
  const para = els.readerContent.querySelector(
    `.reader-para[data-chapter-id="${chapter.id}"][data-pindex="${hit.paraIndex}"]`
  );
  if (para) {
    para.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function findWordInChapter(chapter, ...words) {
  const candidates = [...new Set(words.map((item) => String(item || "").trim()).filter(Boolean))];
  for (let i = 0; i < chapter.paragraphs.length; i += 1) {
    const paragraph = chapter.paragraphs[i];
    for (const word of candidates) {
      const start = paragraph.indexOf(word);
      if (start < 0) continue;
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

function hasLexicalJapaneseChar(word) {
  return /[\u3400-\u9fff々ァ-ヺー]/u.test(String(word || ""));
}

function isAnalyzableWord(token, word) {
  if (!word) return false;
  if (isBoundary(word)) return false;
  if (!JP_WORD_RE.test(word)) return false;
  if (word.length <= 1 && !hasLexicalJapaneseChar(word)) return false;
  if (HIRAGANA_ONLY_RE.test(word)) return false;
  if (token?.pos && BLOCKED_POS_RE.test(String(token.pos))) return false;
  return true;
}

function shouldIncludeHardWordLevel(level) {
  return HARD_WORD_LEVELS.includes(level);
}

function chapterHasTrustedAnalysisTokens(chapter) {
  const tokens = Array.isArray(chapter?.analysis?.tokens)
    ? chapter.analysis.tokens.map(normalizeToken).filter((token) => token.surface)
    : [];
  return shouldTrustAnalysisTokens(tokens);
}

function buildHardWordOverviewEntry(item = {}) {
  const level = normalizeJlptLevel(item.level || item.jlpt || "");
  if (!shouldIncludeHardWordLevel(level)) return null;

  const rawWord = String(item.word || item.surface || item.lemma || "").trim();
  const rawLemma = String(item.lemma || item.word || item.surface || "").trim();
  const word = stripWordNoise(rawLemma || rawWord);
  const lemma = normalizeWordKey(word || stripWordNoise(rawWord));
  if (!lemma || !isAnalyzableWord({ pos: item.pos || "" }, lemma)) return null;

  if (
    isSuspiciousGluedLexicalToken({
      surface: rawWord || rawLemma || lemma,
      lemma,
      dictionaryForm: lemma,
      pos: item.pos || "",
    })
  ) {
    return null;
  }

  return {
    word: word || lemma,
    lemma,
    level,
    count: Number(item.count || 0),
    reading: normalizeReading(item.reading || "", word || lemma) || "-",
    meaning: String(item.meaning || "").trim(),
  };
}

function resolveAnalysisLexeme(token) {
  const normalized = normalizeToken(token);
  const jlptMatch = findJlptMatch({
    surface: normalized.surface,
    lemma: normalized.lemma,
    dictionaryForm: normalized.dictionaryForm,
    jlptMap: state.jlptMap,
  });
  const fallbackWord =
    stripWordNoise(normalized.dictionaryForm || normalized.lemma || normalized.surface) ||
    stripWordNoise(normalized.surface) ||
    normalized.surface;
  const matchedWord = String(jlptMatch.matchedWord || fallbackWord).trim() || fallbackWord;
  const matchedLemma =
    String(
      stripWordNoise(
        jlptMatch.matchedLemma ||
          (normalized.dictionaryForm && normalized.dictionaryForm !== normalized.surface
            ? normalized.dictionaryForm
            : "") ||
          (normalized.lemma && normalized.lemma !== normalized.surface ? normalized.lemma : "") ||
          matchedWord
      ) || matchedWord
    ).trim() || matchedWord;
  const alignedRange = alignMatchedWordToToken(normalized, matchedWord);
  return {
    ...normalized,
    matchedWord,
    matchedLemma,
    jlpt: normalizeJlptLevel(normalized.jlpt || jlptMatch.level),
    start: alignedRange.start,
    end: alignedRange.end,
  };
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
    .map((rawToken) => {
      const token = resolveAnalysisLexeme(rawToken);
      const word = normalizeWordKey(token.matchedLemma || token.lemma || token.surface);
      if (!isAnalyzableWord(token, word)) return null;
      const level = normalizeJlptLevel(
        token.jlpt || getJlptLevel(token.surface, token.lemma, token.dictionaryForm)
      );
      if (!HIGHLIGHT_LEVELS.includes(level)) return null;
      return {
        start: token.start,
        end: token.end,
        level,
      };
    })
    .filter(Boolean);
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
  const mode = state.settingsStore?.difficultyMode || state.settings.difficultyMode || "n1n2n3";
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

// Reader selection/annotations/ui logic lives in features/reader modules.

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
      const payload = await accountService.health({ timeoutMs: 2200 });
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

function getJlptLevel(surface, lemma, dictionaryForm = "") {
  if (!hasFullJlptMap()) return "";
  return findJlptMatch({
    surface,
    lemma,
    dictionaryForm,
    jlptMap: state.jlptMap,
  }).level;
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

function updateBilling(nextBilling, persist = true) {
  state.billing = normalizeBillingState({
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
  state.billingOrder = normalizeBillingOrderState({
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
  return "stripe";
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
  const stripePublishableReady = Boolean(currentStripePublishableKey());
  const statusText = state.billing.subscriptionStatus
    ? `（订阅状态: ${state.billing.subscriptionStatus}）`
    : "";
  const graceText = state.billing.accessState === "grace" ? " 当前处于宽限期。" : "";
  const activeBillingCycle = normalizeBillingCycle(state.billing.billingCycle);
  const billingCycleText =
    activeBillingCycle === "yearly" ? "（当前已开通年付）" : activeBillingCycle === "monthly" ? "（当前已开通月付）" : "";
  const advancedImportEnabled = hasFeature("advancedImport");
  const cloudSyncEnabled = hasFeature("cloudSync");
  const csvLimit = Math.max(1, Number(state.billing.features?.csvExportMaxRows || 60) || 60);
  const csvUnlimited = plan === "pro" || csvLimit >= 100000;
  const paymentsEnabled = Boolean(state.billing.paymentEnabled);
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
    els.planComingSoon.textContent = "";
  }
  if (els.planHint) {
    if (!paymentsEnabled) {
      els.planHint.textContent = "当前支付渠道尚未配置（Stripe 未启用）。";
    } else if (!channelEnabled("stripe")) {
      els.planHint.textContent = "当前仅支持 Stripe 订阅，请联系管理员完成 Stripe 配置。";
    } else {
      const baseHint =
        accountMode === "registered"
          ? `${plan === "pro" ? PRO_FEATURE_HINT : FREE_FEATURE_HINT} 可选 Pro Monthly — $6/month 或 Pro Yearly — $60/year（年付更优惠）。${billingCycleText}${statusText}${graceText}`
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
    els.paymentDisabledHint.textContent = "Stripe 支付未配置，暂时无法升级。";
  }
  if (els.billingFlowHint) {
    els.billingFlowHint.hidden = !paymentsEnabled;
  }
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
    if (els.payChannelSelect) {
      els.payChannelSelect.disabled = true;
      els.payChannelSelect.value = "stripe";
    }
    const monthlyOption = els.billingIntervalSelect?.querySelector('option[value="monthly"]');
    const yearlyOption = els.billingIntervalSelect?.querySelector('option[value="yearly"]');
    if (monthlyOption) monthlyOption.disabled = stripePaymentLinkReady || !monthlyEnabled;
    if (yearlyOption) yearlyOption.disabled = stripePaymentLinkReady || !yearlyEnabled;
    if (els.billingIntervalSelect) {
      els.billingIntervalSelect.value = currentInterval;
      els.billingIntervalSelect.disabled = stripePaymentLinkReady || (!monthlyEnabled && !yearlyEnabled);
    }
    if (currentInterval !== state.billingOrder.interval) {
      updateBillingOrder({ interval: currentInterval }, false);
    }
  } else {
    if (els.payChannelSelect) els.payChannelSelect.disabled = true;
    if (els.billingIntervalSelect) els.billingIntervalSelect.disabled = true;
  }

  const canStripeCheckout =
    channelEnabled("stripe") &&
    Boolean(stripeConfig.checkoutReady || stripePaymentLinkReady) &&
    (stripePaymentLinkReady || stripePublishableReady);
  if (els.upgradeProBtn) {
    els.upgradeProBtn.disabled = !paymentsEnabled || plan === "pro" || !canStripeCheckout;
    els.upgradeProBtn.textContent = isRegistered ? "订阅 Pro" : "注册并订阅";
  }
  if (els.pullSyncBtn) els.pullSyncBtn.disabled = !isRegistered;
  if (els.pushSyncBtn) els.pushSyncBtn.disabled = !isRegistered;
  // Keep upload clickable in guest mode so users receive a clear upgrade/register prompt.
  if (els.fileInput) els.fileInput.disabled = false;
  if (els.exportProgressBtn) els.exportProgressBtn.disabled = !isRegistered;
  if (els.deleteBookBtn) els.deleteBookBtn.disabled = !isRegistered || !state.book?.id;
  if (els.deleteCloudBtn) els.deleteCloudBtn.disabled = !isRegistered;
  if (els.deleteAccountBtn) els.deleteAccountBtn.disabled = !isRegistered;

  if (!paymentsEnabled) {
    if (els.manageBillingBtn) {
      els.manageBillingBtn.disabled = true;
      els.manageBillingBtn.textContent = "管理订阅";
    }
    if (els.billingFlowHint) {
      els.billingFlowHint.textContent = "当前支付渠道尚未配置（Stripe 未启用）。";
    }
  } else {
    const hasCustomer = Boolean(stripeConfig.customerId);
    const canOpenPortal = Boolean(stripeConfig.portalReady && hasCustomer && !stripePaymentLinkReady);
    if (els.manageBillingBtn) {
      els.manageBillingBtn.disabled = !isRegistered || !canOpenPortal;
      els.manageBillingBtn.textContent = "管理订阅";
    }
    if (els.billingFlowHint) {
      if (!stripePublishableReady && stripeConfig.checkoutReady && !stripePaymentLinkReady) {
        els.billingFlowHint.textContent =
          "Stripe 公钥未配置（STRIPE_PUBLISHABLE_KEY），请补全后重试。";
      } else if (stripePaymentLinkReady) {
        els.billingFlowHint.textContent =
          "升级将跳转到 Stripe 托管支付页，支付成功后会回跳并由服务端验单。";
      } else if (!stripeConfig.checkoutReady) {
        els.billingFlowHint.textContent =
          "Stripe Checkout 未就绪：请检查 STRIPE_SECRET_KEY 与月付/年付 Price ID 配置。";
      } else {
        const intervalLabel = currentInterval === "yearly" ? "Pro Yearly — $60/year" : "Pro Monthly — $6/month";
        els.billingFlowHint.textContent = `即将订阅 ${intervalLabel}，支付成功后由服务端验单后才会开通。`;
      }
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
    const payload = await billingService.getPaymentOptions();
    const stripeOptions = payload?.stripe && typeof payload.stripe === "object" ? payload.stripe : {};
    updateBilling({
      paymentEnabled: Boolean(payload?.enabled),
      appBaseUrl: String(payload?.appBaseUrl || state.billing.appBaseUrl || ""),
      stripe: {
        ...state.billing.stripe,
        checkoutReady:
          stripeOptions.checkoutReady === undefined
            ? state.billing.stripe.checkoutReady
            : Boolean(stripeOptions.checkoutReady),
        paymentLinkReady:
          stripeOptions.paymentLinkReady === undefined
            ? state.billing.stripe.paymentLinkReady
            : Boolean(stripeOptions.paymentLinkReady),
        paymentLink: String(stripeOptions.paymentLink || state.billing.stripe.paymentLink || ""),
        publishableKey: String(
          stripeOptions.publishableKey || state.billing.stripe.publishableKey || ""
        ).trim(),
      },
    });
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
    const payload = await billingService.getPlan(userId);
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
  updateBillingOrder({ channel: "stripe" });
  renderBillingUi();
}

function onBillingIntervalChange() {
  updateBillingOrder({ interval: normalizeBillingInterval(els.billingIntervalSelect.value) });
  renderBillingUi();
}

function onForgotPasswordClick() {
  setStatus(FORGOT_PASSWORD_PLACEHOLDER_MESSAGE);
  showToast(FORGOT_PASSWORD_PLACEHOLDER_MESSAGE);
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
  if (password.length < REGISTER_PASSWORD_MIN_LENGTH) {
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
    const payload = await accountService.register({
      username,
      password,
      anonymousId: state.sync.anonymousId || state.sync.userId,
      snapshot: createSnapshot(),
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
    const payload = await accountService.login({
      username,
      password,
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
    saveStorageValue("accountToken", state.sync.accountToken);
    saveStorageValue("userId", state.sync.userId);
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
    const payload = await billingService.checkoutComplete({
      sessionId: normalizedSessionId,
      userId: state.sync.userId,
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
    setStatus("当前支付渠道尚未配置（Stripe 未启用）。", true);
    return;
  }
  if (state.sync.accountMode !== "registered") {
    closeAccountMenu();
    openAccountModal({ panel: "register" });
    setStatus("请先注册或登录账号，再发起 Pro 订阅。");
    return;
  }
  onSyncUserChange({ refreshBilling: false });
  if (!state.apiOnline) {
    setStatus("API 离线，无法发起支付。", true);
    return;
  }
  void trackEvent("upgrade_clicked", {
    channel: "stripe",
    plan: state.billing.plan,
  });
  if (!channelEnabled("stripe")) {
    setStatus("Stripe 支付未启用，请检查后端配置。", true);
    return;
  }
  await onUpgradeProPlanByStripe();
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
    const payload = await billingService.createCheckoutSession({
      userId: state.sync.userId,
      interval,
      billingCycle: interval,
      billing_cycle: interval,
    });
    if (payload?.billing) {
      updateBilling(payload.billing);
    }
    const sessionId = String(payload?.sessionId || "").trim();
    if (payload?.order) {
      updateBillingOrder({
        ...payload.order,
        channel: "stripe",
        interval,
        sessionId,
      });
    }
    const checkoutUrl = String(payload?.url || payload?.checkoutUrl || "").trim();
    if (!sessionId && !checkoutUrl) {
      setStatus("Stripe Checkout 会话创建失败：缺少 sessionId 与跳转链接。", true);
      return;
    }
    if (sessionId) {
      try {
        setStatus("正在跳转到 Stripe Checkout...");
        const stripeClientInstance = await ensureStripeClient();
        const result = await stripeClientInstance.redirectToCheckout({ sessionId });
        if (result?.error) {
          throw new Error(result.error.message || "Stripe Checkout 跳转失败。");
        }
        return;
      } catch (redirectError) {
        const redirectMessage = String(redirectError?.message || "");
        if (redirectMessage.includes("STRIPE_PUBLISHABLE_KEY")) {
          throw redirectError;
        }
        if (!checkoutUrl) {
          throw redirectError;
        }
        setStatus("Stripe.js 跳转失败，正在使用后端 checkout_url 跳转...");
      }
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

async function onOpenBillingPortal() {
  onSyncUserChange({ refreshBilling: false });
  if (!state.apiOnline) {
    setStatus("API 离线，无法确认支付状态。", true);
    return;
  }
  await onOpenStripeBillingPortal();
}

async function onOpenStripeBillingPortal() {
  try {
    const payload = await billingService.createPortalSession({
      userId: state.sync.userId,
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

async function openFeedbackPrompt(kind) {
  const promptLabel = kind === "bug" ? "报告问题" : "发送反馈";
  const message = window.prompt(`${promptLabel}：请输入要提交的内容`);
  if (!message || !message.trim()) return;
  try {
    await accountService.sendFeedback({
      kind,
      message: message.trim(),
      userId: state.sync.userId,
      bookId: state.book?.id || "",
      chapterId: currentChapterData()?.id || "",
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
    const payload = await syncService.exportProgress(state.sync.userId);
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
    await accountService.deleteCloudData({ userId: state.sync.userId });
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
    await accountService.deleteAccount({ userId: state.sync.userId });
    state.vocab = [];
    state.notes = [];
    state.bookmarks = [];
    state.stats = { lookupCount: 0, totalSeconds: 0 };
    state.book = null;
    setCurrentChapterIndex(0);
    syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
    state.sync = { ...DEFAULT_SYNC };
    ensureSessionIdentity();
    state.billing = normalizeBillingState(DEFAULT_BILLING);
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
    const payload = await syncService.push({
      userId: state.sync.userId,
      snapshot: createSnapshot(),
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
    const payload = await syncService.pull(state.sync.userId);
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
  setCurrentChapterIndex(snapshot.currentChapter);
  syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
  if (Array.isArray(snapshot.vocab)) state.vocab = snapshot.vocab;
  if (Array.isArray(snapshot.notes)) state.notes = snapshot.notes;
  if (Array.isArray(snapshot.bookmarks)) state.bookmarks = snapshot.bookmarks;
  if (snapshot.settings) {
    state.settingsStore.update(snapshot.settings);
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
  setSelectionState({
    selected: null,
    selectedSentence: null,
    selectedRange: null,
  });
  resetExplainState();
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
  if (!ttsService.isSupported()) {
    els.ttsPlayBtn.disabled = true;
    els.ttsStopBtn.disabled = true;
    els.ttsVoiceSelect.disabled = true;
    setStatus("当前浏览器不支持 TTS。", true);
    return;
  }
  const updateVoices = () => {
    const voices = ttsService.listVoices();
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

    const preferred = activeVoices.find((voice) => voice.name === state.settingsStore.ttsVoice);
    const finalVoice = preferred || activeVoices[0];
    els.ttsVoiceSelect.value = finalVoice.name;
    state.settingsStore.set("ttsVoice", finalVoice.name);
    saveJSON(STORAGE_KEYS.settings, state.settingsStore.values);
  };

  updateVoices();
  window.speechSynthesis.onvoiceschanged = updateVoices;
}

function onPlayTts() {
  const chapter = currentChapterData();
  if (!chapter) return;
  onStopTts();
  state.ttsUtterance = ttsService.speak(chapter.text, {
    lang: "ja-JP",
    rate: Number(state.settingsStore.ttsRate || 1),
    voiceName: state.settingsStore.ttsVoice || els.ttsVoiceSelect.value,
    onStart: () => setStatus(`开始朗读：${chapter.title}`),
    onEnd: () => setStatus("朗读完成。"),
    onError: () => setStatus("朗读失败。", true),
  });
}

function onStopTts() {
  ttsService.stop();
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
  if (uiStore?.setToast) {
    uiStore.setToast(message, isError);
  } else if (uiStore?.toast) {
    uiStore.toast.visible = true;
    uiStore.toast.message = String(message || "");
    uiStore.toast.isError = Boolean(isError);
  }
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
    if (uiStore?.setToast) {
      uiStore.setToast("", false);
    } else if (uiStore?.toast) {
      uiStore.toast.visible = false;
    }
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
  // Keep this helper only for endpoints not yet wrapped by services/* (books/import/events/local data).
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
  removeStorageItem(STORAGE_KEYS.book);
  removeStorageItem(STORAGE_KEYS.currentChapter);
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
  removeStorageItem("accountToken");
  removeStorageItem("userId");

  const guestId = createAnonymousId();
  saveStorageValue("userId", guestId);

  state.sync = {
    ...DEFAULT_SYNC,
    userId: guestId,
    anonymousId: guestId,
    accountMode: "guest",
    accountToken: "",
    registeredAt: 0,
  };
  state.billing = normalizeBillingState({
    ...DEFAULT_BILLING,
    userId: guestId,
    accountMode: "guest",
  });
  state.billingOrder = normalizeBillingOrderState({});
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
    removeStorageItem(key);
    return;
  }
  saveStoredJSON(key, value);
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
