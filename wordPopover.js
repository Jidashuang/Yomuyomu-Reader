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

export function createWordPopoverModule(deps) {
  const {
    clampChapterIndex,
    ensureApiHealthFresh,
    extractSentenceExample,
    fetchJson,
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

  return {
    clearSelectionMark,
    lookupDictionary,
    markSelection,
    onDictLinkClick,
    renderLookupPanel,
    selectToken,
  };
}
