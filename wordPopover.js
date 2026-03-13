import {
  MAC_DICT_SCHEME,
  MINI_DICT,
  MOJI_SCHEME_MAP,
  MOJI_WEB_HOME,
  MOJI_WEB_SEARCH,
  STORAGE_KEYS,
  els,
  saveJSON,
  state,
} from "./readerStore.js";
import * as analysisService from "./services/analysisService.js";
import * as dictionaryService from "./services/dictionaryService.js";
import {
  alignMatchedWordToToken as alignMatchedWordToTokenShared,
  buildLookupCandidates as buildLookupCandidatesShared,
  buildLookupPayloads as buildLookupPayloadsShared,
  expandKanaTailCandidates as expandKanaTailCandidatesShared,
  lookupLocalDictionary as lookupLocalDictionaryShared,
  normalizeReading as normalizeReadingShared,
  stripWordNoise as stripWordNoiseShared,
} from "./services/localDictionaryLookup.js";

export function createWordPopoverModule(deps) {
  const readerSessionStore = state.readerStore?.sessionState;
  const {
    clampChapterIndex,
    ensureApiHealthFresh,
    extractSentenceExample,
    tokenizeText = (payload, options) => analysisService.tokenize(payload, options),
    lookupWord = (payload, options) => dictionaryService.lookup(payload, options),
    getJlptLevel,
    getParagraphByLocation,
    hasCjkText,
    hiraganaToKatakana,
    katakanaToHiragana,
    normalizeReading,
    normalizeToken,
    renderApiStatus,
    renderBookMeta,
    renderChapterList,
    renderStats,
    setRightPanelTab,
  } = deps;

  async function selectToken(token, chapterId, chapterIndex, paraIndex) {
    clearSelectionMark();
    if (readerSessionStore?.setSelection) {
      readerSessionStore.setSelection({
        selectedRange: {
          chapterId,
          paraIndex,
          start: token.start,
          end: token.end,
        },
      });
    } else {
      state.selectedRange = {
        chapterId,
        paraIndex,
        start: token.start,
        end: token.end,
      };
    }
    if (readerSessionStore?.setCurrentChapter) {
      readerSessionStore.setCurrentChapter(chapterIndex);
    } else {
      state.currentChapter = clampChapterIndex(chapterIndex);
    }
    saveJSON(STORAGE_KEYS.currentChapter, state.currentChapter);
    renderBookMeta();
    renderChapterList();
    markSelection();

    const paragraph = getParagraphByLocation(chapterId, chapterIndex, paraIndex);
    const normalizedToken = normalizeToken(token);
    const resolvedToken = await enrichTokenDetails(normalizedToken);
    const contextExample = extractSentenceExample(paragraph, resolvedToken.start, resolvedToken.end);
    const entries = await lookupDictionary(
      resolvedToken.surface,
      resolvedToken.lemma,
      resolvedToken.dictionaryForm
    );
    const dict = buildDictionaryView(resolvedToken, entries, contextExample);
    dict.jlpt = getJlptLevel(
      resolvedToken.surface,
      resolvedToken.lemma,
      resolvedToken.dictionaryForm
    );
    const alignedRange = alignMatchedWordToToken(
      resolvedToken,
      dict.matchedWord || dict.word || resolvedToken.surface
    );
    if (alignedRange.start !== resolvedToken.start || alignedRange.end !== resolvedToken.end) {
      clearSelectionMark();
      if (readerSessionStore?.setSelection) {
        readerSessionStore.setSelection({
          selectedRange: {
            chapterId,
            paraIndex,
            start: alignedRange.start,
            end: alignedRange.end,
          },
        });
      } else {
        state.selectedRange = {
          chapterId,
          paraIndex,
          start: alignedRange.start,
          end: alignedRange.end,
        };
      }
      markSelection();
    }
    if (readerSessionStore?.setSelection) {
      readerSessionStore.setSelection({ selected: dict });
    } else {
      state.selected = dict;
    }
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
      const payload = await tokenizeText({ text: token.surface });
      if (!payload.ok || !Array.isArray(payload.tokens) || !payload.tokens.length) return token;
      const exact = payload.tokens
        .map(normalizeToken)
        .find((item) => item.surface === token.surface);
      if (!exact) return token;
      return {
        ...token,
        lemma: String(exact.lemma || token.lemma || token.surface),
        dictionaryForm: String(
          exact.dictionaryForm || exact.base || exact.baseForm || exact.lemma || token.dictionaryForm || token.lemma
        ),
        reading: normalizeReading(exact.reading || token.reading || "", token.surface),
        pos: String(exact.pos || token.pos || ""),
      };
    } catch {
      return token;
    }
  }

  async function lookupDictionary(surface, lemma, dictionaryForm = "") {
    if (!state.apiOnline) {
      await ensureApiHealthFresh();
    }
    if (state.apiOnline) {
      try {
        const payloads = buildLookupPayloads(surface, lemma, dictionaryForm);
        for (const lookupPayload of payloads) {
          const payload = await lookupWord(lookupPayload);
          if (payload.ok && Array.isArray(payload.entries) && payload.entries.length) {
            return payload.entries;
          }
        }
      } catch {
        state.apiOnline = false;
        renderApiStatus();
      }
    }
    return [];
  }

  function buildDictionaryView(token, entries, contextExample = "") {
    const candidates = buildLookupCandidates(token.surface, token.lemma, token.dictionaryForm);
    if (entries.length) {
      const first = entries[0];
      const tokenPos = String(token.pos || "").trim();
      const preferTokenPos = tokenPos && tokenPos !== "fallback" && tokenPos !== "known";
      const resolvedLemma = String(first.lemma || token.lemma || token.surface).trim() || token.surface;
      const resolvedWord = String(first.surface || token.surface || resolvedLemma).trim() || resolvedLemma;
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
        word: resolvedWord,
        lemma: resolvedLemma,
        matchedWord: resolvedWord,
        matchedLemma: resolvedLemma,
        source: "api",
        candidates,
        reading: normalizeReading(token.reading || first.reading || "", resolvedWord) || "-",
        pos: preferTokenPos ? tokenPos : String(first.pos || tokenPos || "-"),
        meaning,
        example: example || "未提取到例句",
      };
    }
    const local = lookupLocalDictionary(token.surface, token.lemma, token.dictionaryForm);
    const tokenPos = String(token.pos || "").trim();
    const resolvedWord = String(local.matchedWord || token.surface || "").trim() || token.surface;
    const resolvedLemma = String(local.matchedLemma || local.matchedWord || token.lemma || resolvedWord).trim();
    return {
      word: resolvedWord,
      lemma: resolvedLemma || resolvedWord,
      matchedWord: resolvedWord,
      matchedLemma: resolvedLemma || resolvedWord,
      source: local.source || "none",
      candidates: Array.isArray(local.candidates) ? local.candidates : candidates,
      reading: normalizeReading(token.reading || local.reading || "", resolvedWord) || "-",
      pos: tokenPos && tokenPos !== "fallback" ? tokenPos : "-",
      meaning: local.meaning,
      example: contextExample || "未提取到例句",
    };
  }

  function stripWordNoise(value) {
    return stripWordNoiseShared(value);
  }

  function buildLookupCandidates(surface, lemma, dictionaryForm = "") {
    return buildLookupCandidatesShared(surface, lemma, dictionaryForm);
  }

  function buildLookupPayloads(surface, lemma, dictionaryForm = "") {
    return buildLookupPayloadsShared(surface, lemma, dictionaryForm);
  }

  function expandKanaTailCandidates(value) {
    return expandKanaTailCandidatesShared(value);
  }

  function alignMatchedWordToToken(token, matchedWord) {
    return alignMatchedWordToTokenShared(token, matchedWord);
  }

  function lookupLocalDictionary(surface, lemma, dictionaryForm = "") {
    return lookupLocalDictionaryShared({
      surface,
      lemma,
      dictionaryForm,
      miniDict: MINI_DICT,
      vocab: state.vocab,
      apiOnline: state.apiOnline,
      jmdictReady: state.jmdictReady,
      normalizeReading: normalizeReadingShared,
    });
  }

  function normalizeMojiScheme(value) {
    return value === "en" ? "en" : "jp";
  }

  function isMacDesktop() {
    return /Mac/i.test(navigator.platform || "");
  }

  function getMacDictUrl(word) {
    const query = String(word || "").trim();
    return query ? `${MAC_DICT_SCHEME}${encodeURIComponent(query)}` : "";
  }

  function getMojiLinks(word) {
    const scheme = normalizeMojiScheme(state.settingsStore?.mojiScheme || state.settings?.mojiScheme);
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

  return {
    clearSelectionMark,
    lookupDictionary,
    markSelection,
    onDictLinkClick,
    renderLookupPanel,
    selectToken,
  };
}
