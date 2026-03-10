import { els, state, STORAGE_KEYS, saveJSON } from "./readerStore.js";
import {
  clampChapterIndex,
  normalizeBook,
  sanitizeSyncUserId,
} from "./state.js";

export function createSyncModule(deps) {
  const {
    applySettings,
    fetchJson,
    hasFeature,
    initialRenderedChapterCount,
    refreshBillingPlan,
    renderAll,
    requestAnalyze,
    scrollToChapter,
    setStatus,
    stopAutoPage,
    updateBilling,
  } = deps;

  function renderSyncUi() {
    els.userIdInput.value = state.sync.userId || "demo-user";
  }

  function onSyncUserChange(options = {}) {
    const previousUserId = state.sync.userId;
    state.sync.userId = sanitizeSyncUserId(els.userIdInput.value || state.sync.userId);
    els.userIdInput.value = state.sync.userId;
    saveJSON(STORAGE_KEYS.sync, state.sync);
    if (previousUserId !== state.sync.userId) {
      deps.updateBillingOrder({
        orderId: "",
        status: "",
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
        sessionId: "",
        paidAt: 0,
      });
    }
    if (options.refreshBilling !== false) {
      void refreshBillingPlan(true);
    }
  }

  async function onSyncPush() {
    onSyncUserChange({ refreshBilling: false });
    if (!state.apiOnline) {
      setStatus("API 离线，无法云端上传。", true);
      return;
    }
    if (!hasFeature("cloudSync")) {
      await refreshBillingPlan(true);
      if (!hasFeature("cloudSync")) {
        setStatus("云同步仅对 Pro 套餐开放。", true);
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
      setStatus(`云端上传成功（用户: ${state.sync.userId}）。`);
    } catch (error) {
      if (error?.payload?.billing) {
        updateBilling(error.payload.billing);
      }
      setStatus(`云端上传失败：${error.message}`, true);
    }
  }

  async function onSyncPull() {
    onSyncUserChange({ refreshBilling: false });
    if (!state.apiOnline) {
      setStatus("API 离线，无法云端拉取。", true);
      return;
    }
    if (!hasFeature("cloudSync")) {
      await refreshBillingPlan(true);
      if (!hasFeature("cloudSync")) {
        setStatus("云同步仅对 Pro 套餐开放。", true);
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
        setStatus("云端暂无可用数据。");
        return;
      }
      applySnapshot(snapshot);
      setStatus(`云端拉取成功（用户: ${state.sync.userId}）。`);
    } catch (error) {
      if (error?.payload?.billing) {
        updateBilling(error.payload.billing);
      }
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
    state.sync.userId = sanitizeSyncUserId(state.sync.userId);
    updateBilling({ userId: state.sync.userId }, false);
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
    void refreshBillingPlan(true);
    requestAnalyze(true);
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
    saveJSON(STORAGE_KEYS.billing, state.billing);
    saveJSON(STORAGE_KEYS.billingOrder, state.billingOrder);
  }

  return {
    applySnapshot,
    createSnapshot,
    onSyncPull,
    onSyncPush,
    onSyncUserChange,
    persistAll,
    renderSyncUi,
  };
}
