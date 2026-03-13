export function createReaderUi({
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
  normalizeReadingMode,
  isPagedMode,
  syncPagedPageState,
  stopAutoPage,
  scheduleDifficultyPaint,
  applyVisibleDifficultyToDom,
  restartAutoPage,
}) {
  const settingsStore = state.settingsStore;
  const uiStore = state.uiStore || state.ui;

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

  function writeSettings(partial = {}) {
    if (settingsStore?.update) {
      settingsStore.update(partial);
      return;
    }
    Object.assign(settingsValues(), partial || {});
  }

  function openToolsSection() {
    setRightPanelTab("vocab");
  }

  function readerScrollContainer() {
    return els.readerViewport || els.readerContent;
  }

  function adjustReaderSettingsPanelPosition() {
    const settingsPopover = document.getElementById("readerSettingsPopover");
    const settingsPanel = document.getElementById("readerSettingsPanel");
    if (!settingsPopover || !settingsPanel || !settingsPopover.open) {
      return;
    }
    settingsPanel.style.setProperty("--reader-settings-shift-x", "0px");
    const margin = 8;
    const rect = settingsPanel.getBoundingClientRect();
    let shiftX = 0;
    if (rect.left < margin) {
      shiftX += margin - rect.left;
    }
    if (rect.right > window.innerWidth - margin) {
      shiftX -= rect.right - (window.innerWidth - margin);
    }
    if (Math.abs(shiftX) < 0.5) {
      shiftX = 0;
    }
    settingsPanel.style.setProperty("--reader-settings-shift-x", `${Math.round(shiftX)}px`);
  }

  function scheduleReaderSettingsPanelPosition() {
    requestAnimationFrame(() => {
      adjustReaderSettingsPanelPosition();
    });
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

  function onRightTabsClick(event) {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    setRightPanelTab(button.dataset.tab);
  }

  function setRightPanelTab(tab, persist = true) {
    const nextTab = normalizeRightPanelTab(tab);
    if (readSetting("rightPanelTab", "vocab") === nextTab) return;
    writeSetting("rightPanelTab", nextTab);
    if (uiStore?.setSidePanelTab) {
      uiStore.setSidePanelTab(nextTab);
    } else if (uiStore?.sidePanel) {
      uiStore.sidePanel.tab = nextTab;
      uiStore.sidePanel.openPanel = nextTab;
    }
    if (persist) {
      saveJSON(STORAGE_KEYS.settings, settingsValues());
    }
    renderRightTabs();
  }

  function renderRightTabs() {
    const activeTab = normalizeRightPanelTab(readSetting("rightPanelTab", "vocab"));
    if (uiStore?.setSidePanelTab) {
      uiStore.setSidePanelTab(activeTab);
    } else if (uiStore?.sidePanel) {
      uiStore.sidePanel.tab = activeTab;
      uiStore.sidePanel.openPanel = activeTab;
    }
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

  function renderReadingModeUi() {
    const mode = normalizeReadingMode(readSetting("readingMode", "scroll"));
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

  function renderAutoPageUi() {
    const pagedMode = normalizeReadingMode(readSetting("readingMode", "scroll")) === "paged";
    const on = pagedMode && Boolean(state.autoPageTimerId);
    els.toggleAutoPageBtn.hidden = !pagedMode;
    els.toggleAutoPageBtn.disabled = !pagedMode;
    els.toggleAutoPageBtn.textContent = `自动翻页: ${on ? "开" : "关"}`;
    els.toggleAutoPageBtn.classList.toggle("auto-on", on);
  }

  function isMacDesktop() {
    return /Mac/i.test(navigator.platform || "");
  }

  function getMacDictUrl(word) {
    const query = String(word || "").trim();
    return query ? `${MAC_DICT_SCHEME}${encodeURIComponent(query)}` : "";
  }

  function getMojiLinks(word) {
    const scheme = normalizeMojiScheme(readSetting("mojiScheme", "jp"));
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
      els.explainStatus.textContent = "先点词，再拖选整句并松开，可触发 AI 解释。";
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

  function onSettingsChange() {
    const prevDifficultyMode = readSetting("difficultyMode", "n1n2n3");
    const prevMojiScheme = readSetting("mojiScheme", "jp");
    const prevAutoPageSeconds = Number(readSetting("autoPageSeconds", 12)) || 12;
    const settings = settingsValues();
    writeSettings({
      fontSize: Number(els.fontSizeRange?.value || settings.fontSize || 21),
      lineHeight: Number(els.lineHeightRange?.value || settings.lineHeight || 1.9),
      readerFont: normalizeReaderFont(els.readerFontSelect?.value || settings.readerFont),
      difficultyMode: String(els.difficultyModeSelect?.value || "n1n2n3"),
      mojiScheme: normalizeMojiScheme(els.mojiSchemeSelect?.value || settings.mojiScheme),
      autoPageSeconds: clampNumber(Number(els.autoPageSecondsRange?.value) || 12, 6, 40),
      ttsRate: Number(els.ttsRateRange?.value || settings.ttsRate || 1),
      ttsVoice: els.ttsVoiceSelect?.value || "",
    });
    saveJSON(STORAGE_KEYS.settings, settingsValues());
    applySettings();

    if (prevDifficultyMode !== readSetting("difficultyMode", "n1n2n3")) {
      scheduleDifficultyPaint(true);
      applyVisibleDifficultyToDom();
    }
    if (prevMojiScheme !== readSetting("mojiScheme", "jp")) {
      renderLookupPanel();
    }
    if (
      state.autoPageTimerId &&
      prevAutoPageSeconds !== (Number(readSetting("autoPageSeconds", 12)) || 12)
    ) {
      restartAutoPage();
      setStatus(`自动翻页间隔已更新为 ${readSetting("autoPageSeconds", 12)} 秒。`);
    }
  }

  function applySettings() {
    const settings = settingsValues();
    if (!["n1n2n3", "n1n2", "n1", "off"].includes(settings.difficultyMode)) {
      settings.difficultyMode = "n1n2n3";
    }
    settings.readingMode = normalizeReadingMode(settings.readingMode);
    settings.focusMode = Boolean(settings.focusMode);
    settings.rightPanelTab = normalizeRightPanelTab(settings.rightPanelTab);
    settings.readerFont = normalizeReaderFont(settings.readerFont);
    settings.mojiScheme = normalizeMojiScheme(settings.mojiScheme);
    settings.fontSize = clampNumber(Number(settings.fontSize) || 21, 16, 32);
    settings.lineHeight = clampNumber(Number(settings.lineHeight) || 1.9, 1.4, 2.4);
    settings.autoPageSeconds = clampNumber(Number(settings.autoPageSeconds) || 12, 6, 40);
    syncReaderState();
    if (els.fontSizeRange) {
      els.fontSizeRange.value = String(settings.fontSize);
    }
    if (els.lineHeightRange) {
      els.lineHeightRange.value = String(settings.lineHeight);
    }
    if (els.readerFontSelect) {
      els.readerFontSelect.value = settings.readerFont;
    }
    if (els.difficultyModeSelect) {
      els.difficultyModeSelect.value = settings.difficultyMode;
    }
    if (els.mojiSchemeSelect) {
      els.mojiSchemeSelect.value = settings.mojiScheme;
    }
    if (els.autoPageSecondsRange) {
      els.autoPageSecondsRange.value = String(settings.autoPageSeconds);
    }
    if (els.autoPageSecondsText) {
      els.autoPageSecondsText.textContent = `${settings.autoPageSeconds} 秒 / 页`;
    }
    if (els.ttsRateRange) {
      els.ttsRateRange.value = String(settings.ttsRate);
    }
    els.readerContent.style.fontSize = `${settings.fontSize}px`;
    els.readerContent.style.lineHeight = String(settings.lineHeight);
    els.readerContent.style.fontFamily = READER_FONT_MAP[settings.readerFont];
    document.body.classList.toggle("focus-mode", settings.focusMode);
    els.toggleFocusBtn.textContent = `专注模式: ${settings.focusMode ? "开" : "关"}`;
    els.toggleFocusBtn.classList.toggle("auto-on", settings.focusMode);
    renderReadingModeUi();
    if (settings.readingMode !== "paged" && state.autoPageTimerId) {
      stopAutoPage();
    }
    renderRightTabs();
    renderAutoPageUi();
    if (isPagedMode()) {
      syncPagedPageState();
    }
  }

  return {
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
  };
}
