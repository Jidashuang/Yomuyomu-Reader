export const STORAGE_KEYS = {
  book: "yomuyomu_book_v3",
  currentChapter: "yomuyomu_current_chapter_v3",
  vocab: "yomuyomu_vocab_v2",
  notes: "yomuyomu_notes_v2",
  bookmarks: "yomuyomu_bookmarks_v2",
  settings: "yomuyomu_settings_v2",
  stats: "yomuyomu_stats_v2",
  sync: "yomuyomu_sync_v2",
  billing: "yomuyomu_billing_v1",
  billingOrder: "yomuyomu_billing_order_v1",
};

export const DEFAULT_SYNC = {
  userId: "",
  accountMode: "guest",
  accountToken: "",
  anonymousId: "",
  registeredAt: 0,
  lastCloudSyncAt: 0,
  lastCloudSyncAction: "",
  lastCloudSyncStatus: "",
  lastCloudSyncMessage: "",
};

export const DAY_MS = 24 * 60 * 60 * 1000;

export const SAMPLE_BOOK = {
  title: "示例小说",
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

export const MINI_DICT = {
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

export const DEFAULT_SETTINGS = {
  fontSize: 21,
  lineHeight: 1.9,
  readerFont: "mincho",
  readingMode: "scroll",
  focusMode: false,
  rightPanelTab: "vocab",
  ttsRate: 1,
  ttsVoice: "",
  difficultyMode: "n1n2n3",
  mojiScheme: "jp",
  autoPageSeconds: 12,
};

export const READER_FONT_MAP = {
  mincho: '"Zen Old Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif',
  noto: '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif',
  shippori: '"Shippori Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif',
  gothic: '"M PLUS 1p", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif',
  rounded: '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif',
};

export const HIRAGANA_ONLY_RE = /^[ぁ-ゖー]+$/;
export const JP_WORD_RE = /[一-龯々ぁ-ゖァ-ヺー]/;
export const KNOWN_WORD_ONLY_RE = /^[一-龯々ぁ-ゖァ-ヺー]+$/;
export const KNOWN_WORD_MAX_LEN = 10;
export const BLOCKED_POS_RE =
  /(助詞|助動詞|記号|連体詞|代名詞|接続詞|感動詞|接頭詞|接尾辞|非自立|補助)/;
export const HIGHLIGHT_LEVELS = ["N1", "N2", "N3"];
export const LEVEL_PRIORITY = { N1: 0, N2: 1, N3: 2 };
export const MOJI_SCHEME_MAP = {
  jp: "mojisho://?search=",
  en: "mojishoen4cn://?search=",
};
export const MOJI_WEB_SEARCH = "https://www.mojidict.com/searchText/";
export const MOJI_WEB_HOME = "https://www.mojidict.com";
export const LOCAL_API_ORIGIN = "http://127.0.0.1:8000";
export const MAC_DICT_SCHEME = "dict://";

export const DEFAULT_BILLING = {
  userId: "",
  paymentEnabled: false,
  plan: "free",
  source: "manual",
  entitlementPlan: "free",
  subscriptionStatus: "",
  billingCycle: "",
  lastPaidChannel: "",
  lastOrderId: "",
  planExpireAt: 0,
  graceUntilAt: 0,
  paymentFailedAt: 0,
  billingState: "",
  accessState: "free",
  accountMode: "guest",
  appBaseUrl: "",
  features: {
    advancedImport: false,
    cloudSync: false,
    csvExportMaxRows: 60,
    aiExplainDailyLimit: 3,
  },
  paymentChannels: {
    stripe: false,
    wechat: false,
    alipay: false,
  },
  officialGateway: {
    stripe: false,
    wechat: false,
    alipay: false,
  },
  stripe: {
    checkoutReady: false,
    portalReady: false,
    paymentLinkReady: false,
    paymentLink: "",
    publishableKey: "",
    paymentMode: "none",
    intervals: {
      monthly: false,
      yearly: false,
    },
    defaultInterval: "monthly",
    customerId: "",
    subscriptionId: "",
  },
  manualPlanChangeEnabled: false,
  manualPaymentConfirmEnabled: true,
  priceFen: 3900,
  orderExpireMinutes: 30,
  aiExplainUsedToday: 0,
  aiExplainRemainingToday: 3,
  aiExplainCachedToday: 0,
  aiExplainLimitedToday: 0,
};

export const PRO_FEATURE_HINT = "Pro：已解锁高级导入、云同步和全量导出。";
export const FREE_FEATURE_HINT = "基础版：仅支持 TXT 导入，云同步与全量导出需升级。";

export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const state = {
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
  sync: { ...DEFAULT_SYNC, ...loadJSON(STORAGE_KEYS.sync, DEFAULT_SYNC) },
  billing: loadJSON(STORAGE_KEYS.billing, DEFAULT_BILLING),
  billingOrder: loadJSON(STORAGE_KEYS.billingOrder, {
    orderId: "",
    status: "",
    channel: "stripe",
    interval: "monthly",
    paymentMode: "",
    payUrl: "",
    amountFen: 0,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: 0,
    paidSource: "",
    externalTradeNo: "",
    orderStatusPath: "",
    verificationHint: "",
    manualConfirmEnabled: false,
    paidAt: 0,
  }),
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
  toastTimerId: null,
  registeringAccount: false,
  loggingInAccount: false,
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
  chapterTitleFlashTimerId: null,
  timerId: null,
  ttsUtterance: null,
};

export const els = {
  fileInput: document.getElementById("fileInput"),
  loadSampleBtn: document.getElementById("loadSampleBtn"),
  registerAccountInput: document.getElementById("registerAccountInput"),
  registerPasswordInput: document.getElementById("registerPasswordInput"),
  registerAccountButton: document.getElementById("registerAccountButton"),
  loginAccountInput: document.getElementById("loginAccountInput"),
  loginPasswordInput: document.getElementById("loginPasswordInput"),
  loginButton: document.getElementById("loginButton"),
  forgotPasswordBtn: document.getElementById("forgotPasswordBtn"),
  accountModeLabel: document.getElementById("accountModeLabel"),
  signInButton: document.getElementById("signInButton"),
  registerMenuButton: document.getElementById("registerMenuButton"),
  usernameDisplay: document.getElementById("usernameDisplay"),
  logoutButton: document.getElementById("logoutButton"),
  accountMenu: document.getElementById("accountMenu"),
  accountMenuSummary: document.getElementById("accountMenuSummary"),
  accountModal: document.getElementById("accountModal"),
  accountModalBackdrop: document.getElementById("accountModalBackdrop"),
  closeAccountModalBtn: document.getElementById("closeAccountModalBtn"),
  accountLogoutButton: document.getElementById("accountLogoutButton"),
  accountGuestPanel: document.getElementById("accountGuestPanel"),
  accountRegisteredPanel: document.getElementById("accountRegisteredPanel"),
  accountDisplayName: document.getElementById("accountDisplayName"),
  accountPlanText: document.getElementById("accountPlanText"),
  userIdInput: document.getElementById("userIdInput"),
  pullSyncBtn: document.getElementById("pullSyncBtn"),
  pushSyncBtn: document.getElementById("pushSyncBtn"),
  cloudSyncSummary: document.getElementById("cloudSyncSummary"),
  cloudSyncStatus: document.getElementById("cloudSyncStatus"),
  cloudSyncUpdatedAt: document.getElementById("cloudSyncUpdatedAt"),
  cloudPullActionBtn: document.getElementById("cloudPullActionBtn"),
  cloudPushActionBtn: document.getElementById("cloudPushActionBtn"),
  planCard: document.getElementById("planCard"),
  planLiteBlock: document.getElementById("planLiteBlock"),
  planFullBlock: document.getElementById("planFullBlock"),
  planLabel: document.getElementById("planLabel"),
  planHint: document.getElementById("planHint"),
  planComingSoon: document.getElementById("planComingSoon"),
  planBenefitList: document.getElementById("planBenefitList"),
  benefitAdvancedImport: document.getElementById("benefitAdvancedImport"),
  benefitCloudSync: document.getElementById("benefitCloudSync"),
  benefitCsvLimit: document.getElementById("benefitCsvLimit"),
  payChannelSelect: document.getElementById("payChannelSelect"),
  billingIntervalSelect: document.getElementById("billingIntervalSelect"),
  upgradeProBtn: document.getElementById("upgradeProBtn"),
  manageBillingBtn: document.getElementById("manageBillingBtn"),
  billingFlowHint: document.getElementById("billingFlowHint"),
  paymentControls: document.getElementById("paymentControls"),
  paymentDisabledHint: document.getElementById("paymentDisabledHint"),
  apiStatus: document.getElementById("apiStatus"),
  statusText: document.getElementById("statusText"),
  bookTitle: document.getElementById("bookTitle"),
  bookAuthor: document.getElementById("bookAuthor"),
  bookMeta: document.getElementById("bookMeta"),
  chapterCount: document.getElementById("chapterCount"),
  chapterList: document.getElementById("chapterList"),
  bookmarkList: document.getElementById("bookmarkList"),
  notesBookmarkList: document.getElementById("notesBookmarkList"),
  noteList: document.getElementById("noteList"),
  addBookmarkBtn: document.getElementById("addBookmarkBtn"),
  chapterTitle: document.getElementById("chapterTitle"),
  chapterProgress: document.getElementById("chapterProgress"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  pagedControls: document.getElementById("pagedControls"),
  scrollModeBtn: document.getElementById("scrollModeBtn"),
  pagedModeBtn: document.getElementById("pagedModeBtn"),
  fontDecreaseBtn: document.getElementById("fontDecreaseBtn"),
  fontIncreaseBtn: document.getElementById("fontIncreaseBtn"),
  lineHeightDecreaseBtn: document.getElementById("lineHeightDecreaseBtn"),
  lineHeightIncreaseBtn: document.getElementById("lineHeightIncreaseBtn"),
  toggleAutoPageBtn: document.getElementById("toggleAutoPageBtn"),
  toggleFocusBtn: document.getElementById("toggleFocusBtn"),
  readerViewport: document.getElementById("readerViewport"),
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
  explainStatus: document.getElementById("explainStatus"),
  explainQuota: document.getElementById("explainQuota"),
  explainTranslation: document.getElementById("explainTranslation"),
  explainGrammar: document.getElementById("explainGrammar"),
  explainNotes: document.getElementById("explainNotes"),
  explainDifficulty: document.getElementById("explainDifficulty"),
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
  toolsSection: document.getElementById("toolsSection"),
  rightTabs: document.getElementById("rightTabs"),
  exportBtn: document.getElementById("exportBtn"),
  exportProgressBtn: document.getElementById("exportProgressBtn"),
  deleteBookBtn: document.getElementById("deleteBookBtn"),
  deleteCloudBtn: document.getElementById("deleteCloudBtn"),
  deleteAccountBtn: document.getElementById("deleteAccountBtn"),
  reportIssueBtn: document.getElementById("reportIssueBtn"),
  sendFeedbackBtn: document.getElementById("sendFeedbackBtn"),
  vocabList: document.getElementById("vocabList"),
  toast: document.getElementById("appToast"),
};
