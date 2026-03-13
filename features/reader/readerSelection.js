import {
  alignMatchedWordToToken as alignMatchedWordToTokenShared,
  buildLookupCandidates as buildLookupCandidatesShared,
  buildLookupPayloads as buildLookupPayloadsShared,
  expandKanaTailCandidates as expandKanaTailCandidatesShared,
  fallbackReadingFromSurface as fallbackReadingFromSurfaceShared,
  hiraganaToKatakana as hiraganaToKatakanaShared,
  katakanaToHiragana as katakanaToHiraganaShared,
  lookupLocalDictionary as lookupLocalDictionaryShared,
  normalizeReading as normalizeReadingShared,
  stripWordNoise as stripWordNoiseShared,
} from "../../services/localDictionaryLookup.js";
import { shouldTrustAnalysisTokens } from "../../services/analysisTokenReliability.js";

export function createReaderSelection({
  state,
  els,
  STORAGE_KEYS,
  JP_WORD_RE,
  MINI_DICT,
  tokenizeText,
  lookupWord,
  explainSentenceByAi,
  ensureApiHealthFresh,
  renderApiStatus,
  getChapterById,
  clampChapterIndex,
  syncReadingProgress,
  syncReaderState,
  persistCurrentChapterState,
  renderBookMeta,
  renderChapterList,
  renderHardWords,
  scheduleDifficultyPaint,
  findSentenceAt,
  normalizeKnownWordCandidate,
  isBoundary,
  trackEvent,
  saveJSON,
  getJlptLevel,
  renderLookupPanel,
  renderStats,
  updateBilling,
  showToast,
  renderReader,
  renderExplainPanel,
}) {
  const readerSessionStore = state.readerStore?.sessionState;

  function setReaderCursor(cursor) {
    if (readerSessionStore?.setLastCursor) {
      readerSessionStore.setLastCursor(cursor);
      return;
    }
    state.lastCursor = {
      chapterId: String(cursor.chapterId || ""),
      chapterIndex: Number(cursor.chapterIndex || 0),
      paraIndex: Number(cursor.paraIndex || 0),
      charIndex: Number(cursor.charIndex || 0),
    };
  }

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

  function setExplainState(nextExplain = {}) {
    if (readerSessionStore?.setExplain) {
      readerSessionStore.setExplain(nextExplain);
      return;
    }
    state.explain = {
      ...state.explain,
      ...(nextExplain || {}),
    };
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
    setReaderCursor({ chapterId, chapterIndex, paraIndex, charIndex });
    void syncReadingProgress(state.lastCursor);
    if (state.currentChapter !== chapterIndex) {
      setCurrentChapterIndex(chapterIndex);
      syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
      persistCurrentChapterState();
      renderBookMeta();
      renderChapterList();
      renderHardWords();
      scheduleDifficultyPaint();
    }
    const paragraph = chapter.paragraphs[paraIndex] || "";
    const token = await findTokenAt(chapterId, paraIndex, paragraph, charIndex, para);
    if (token && canLookupToken(token)) {
      await selectToken(token, chapterId, chapterIndex, paraIndex);
    }
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

    const sentenceSelection = resolveSentenceSelection(chapterId, paraIndex, paragraph, selected);
    selection.removeAllRanges();
    setReaderCursor({
      chapterId,
      chapterIndex,
      paraIndex,
      charIndex: selected.start,
    });
    if (state.currentChapter !== chapterIndex) {
      setCurrentChapterIndex(chapterIndex);
      syncReaderState({ currentPageIndex: 0, totalPagesInChapter: 1 });
      persistCurrentChapterState();
      renderBookMeta();
      renderChapterList();
      renderHardWords();
      scheduleDifficultyPaint();
    }
    if (sentenceSelection) {
      await explainSentence(sentenceSelection, {
        chapterId,
        chapterIndex,
        paraIndex,
        bookId: state.book?.id || "",
        chapterTitle: chapter.title,
        paragraph,
      });
      return;
    }
    await selectToken(
      {
        surface: selected.surface,
        lemma: selected.surface,
        dictionaryForm: selected.surface,
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

  function resolveSentenceSelection(chapterId, paraIndex, paragraph, selected) {
    const sentenceDelim = /[。！？!?]/;
    const rawText = String(selected?.surface || "");
    const selectedText = rawText.trim();
    if (!selectedText) return null;
    const selectedStart = Math.max(0, Number(selected?.start || 0));
    const selectedEnd = Math.max(selectedStart + 1, Number(selected?.end || selectedStart + 1));
    const selectedLength = selectedText.replace(/\s+/g, "").length;
    const hasSentenceDelim = sentenceDelim.test(selectedText);

    const sentenceAtStart = findSentenceAt(chapterId, paraIndex, selectedStart);
    const sentenceAtEnd = findSentenceAt(chapterId, paraIndex, Math.max(selectedStart, selectedEnd - 1));
    const sameSentence =
      sentenceAtStart &&
      sentenceAtEnd &&
      String(sentenceAtStart.id || "") === String(sentenceAtEnd.id || "");

    if (sameSentence) {
      const base = sentenceAtStart;
      const sentenceText = String(
        base.text || String(paragraph || "").slice(Number(base.start || 0), Number(base.end || 0))
      ).trim();
      const sentenceLength = sentenceText.replace(/\s+/g, "").length;
      const coversMostOfSentence =
        sentenceLength > 0 &&
        selectedLength >= Math.max(6, Math.ceil(sentenceLength * 0.68));
      const startsNearSentenceStart = selectedStart <= Number(base.start || 0) + 1;
      const endsNearSentenceEnd = selectedEnd >= Number(base.end || 0) - 1;
      const nearFullSentence = startsNearSentenceStart && endsNearSentenceEnd;
      if (nearFullSentence || coversMostOfSentence || (hasSentenceDelim && selectedLength >= 6)) {
        return {
          id: String(base.id || `p${paraIndex}-selection`),
          start: Number(base.start || 0),
          end: Number(base.end || selectedEnd),
          text: sentenceText || selectedText,
        };
      }
    }

    if (hasSentenceDelim && selectedLength >= 8) {
      return {
        id: `p${paraIndex}-selection-${selectedStart}-${selectedEnd}`,
        start: selectedStart,
        end: selectedEnd,
        text: selectedText,
      };
    }
    return null;
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
    const safeStart = Math.max(0, Math.min(Math.max(0, paragraph.length - 1), start));
    const safeEnd = Math.max(
      safeStart + 1,
      Math.min(paragraph.length, Math.max(safeStart + 1, end + 1))
    );
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
        dictionaryForm: knownWord,
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
      dictionaryForm: ch,
      reading: normalizeReading("", ch),
      pos: "fallback",
      start: charIndex,
      end: charIndex + 1,
    };
  }

  async function getParagraphTokens(chapterId, paraIndex, paragraph) {
    const key = `${chapterId}:${paraIndex}`;
    const chapter = getChapterById(chapterId);
    const chapterAnalysisTokens = Array.isArray(chapter?.analysis?.tokens)
      ? chapter.analysis.tokens.map(normalizeToken).filter((token) => token.surface)
      : [];
    const analysisTokens = shouldTrustAnalysisTokens(chapterAnalysisTokens)
      ? chapterAnalysisTokens.filter((token) => Number(token.paragraphIndex) === Number(paraIndex))
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
        const payload = await tokenizeText({ text });
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
    return katakanaToHiraganaShared(text);
  }

  function hiraganaToKatakana(text) {
    return hiraganaToKatakanaShared(text);
  }

  function fallbackReadingFromSurface(surface) {
    return fallbackReadingFromSurfaceShared(surface);
  }

  function normalizeReading(reading, surface = "") {
    return normalizeReadingShared(reading, surface);
  }

  function canLookupToken(token) {
    const surface = stripWordNoise(token?.surface || "");
    if (!surface) return false;
    if (!JP_WORD_RE.test(surface)) return false;
    if (isBoundary(surface)) return false;
    if (/^[ぁ-ゖー]$/u.test(surface)) return false;
    return true;
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
      dictionaryForm: String(token.dictionaryForm || token.base || token.baseForm || token.lemma || surface),
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
        dictionaryForm: surface,
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
    const safeStart = Math.max(0, Math.min(Math.max(0, text.length - 1), Number(start) || 0));
    const safeEnd = Math.max(
      safeStart + 1,
      Math.min(text.length, Number(end) || safeStart + 1)
    );
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

    const sentence = text.slice(left, right).trim();
    if (!sentence) return "";
    if (sentence.length <= 110) return sentence;

    const localStart = safeStart - left;
    const localEnd = safeEnd - left;
    const clipStart = Math.max(0, Math.min(Math.max(0, sentence.length - 2), localStart - 24));
    const clipEnd = Math.max(clipStart + 1, Math.min(sentence.length, localEnd + 32));
    const clipped = sentence.slice(clipStart, clipEnd).trim();
    if (!clipped) return sentence.slice(0, 110).trim();
    const prefix = clipStart > 0 ? "…" : "";
    const suffix = clipEnd < sentence.length ? "…" : "";
    return `${prefix}${clipped}${suffix}`;
  }

  function clearSelectionMark() {
    els.readerContent
      .querySelectorAll(".jp-char.selected")
      .forEach((el) => el.classList.remove("selected"));
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

  async function selectToken(token, chapterId, chapterIndex, paraIndex) {
    clearSelectionMark();
    setSelectionState({
      selectedRange: {
        chapterId,
        paraIndex,
        start: token.start,
        end: token.end,
      },
    });
    setCurrentChapterIndex(chapterIndex);
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
      setSelectionState({
        selectedRange: {
          chapterId,
          paraIndex,
          start: alignedRange.start,
          end: alignedRange.end,
        },
      });
      markSelection();
    }
    setSelectionState({ selected: dict });
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
        let fallbackEntries = [];
        let primaryExactEntries = [];
        const primarySurface = stripWordNoise(surface);
        const primaryLemma = stripWordNoise(lemma || dictionaryForm || surface);
        for (const lookupPayload of payloads) {
          const payload = await lookupWord(lookupPayload);
          if (payload.ok && Array.isArray(payload.entries) && payload.entries.length) {
            if (!fallbackEntries.length) {
              fallbackEntries = payload.entries;
            }
            if (entriesMatchLookupPayload(payload.entries, lookupPayload)) {
              const lookupSurface = stripWordNoise(lookupPayload?.surface || "");
              const lookupLemma = stripWordNoise(lookupPayload?.lemma || "");
              const matchesPrimary =
                (primarySurface && (lookupSurface === primarySurface || lookupLemma === primarySurface)) ||
                (primaryLemma && (lookupSurface === primaryLemma || lookupLemma === primaryLemma));
              if (!matchesPrimary) {
                return payload.entries;
              }
              if (!primaryExactEntries.length) {
                primaryExactEntries = payload.entries;
              }
            }
          }
        }
        if (primaryExactEntries.length) {
          return primaryExactEntries;
        }
        if (fallbackEntries.length) {
          return fallbackEntries;
        }
      } catch {
        state.apiOnline = false;
        renderApiStatus();
      }
    }
    return [];
  }

  function entriesMatchLookupPayload(entries, payload) {
    const targetSurface = stripWordNoise(payload?.surface || "");
    const targetLemma = stripWordNoise(payload?.lemma || "");
    if (!targetSurface && !targetLemma) return false;
    return entries.some((entry) => {
      const entrySurface = dictionaryEntrySurface(entry);
      const entryLemma = dictionaryEntryLemma(entry);
      if (targetSurface && (entrySurface === targetSurface || entryLemma === targetSurface)) {
        return true;
      }
      if (targetLemma && (entrySurface === targetLemma || entryLemma === targetLemma)) {
        return true;
      }
      return false;
    });
  }

  function buildDictionaryView(token, entries, contextExample = "") {
    const candidates = buildLookupCandidates(token.surface, token.lemma, token.dictionaryForm);
    const local = lookupLocalDictionary(token.surface, token.lemma, token.dictionaryForm);
    if (entries.length) {
      const bestEntry = pickBestDictionaryEntry(entries, token, candidates);
      const bestRank = dictionaryCandidateRank(bestEntry, candidates);
      const tokenPos = String(token.pos || "").trim();
      const preferTokenPos = tokenPos && tokenPos !== "fallback" && tokenPos !== "known";
      const resolvedLemma =
        String(bestEntry.lemma || token.lemma || token.surface).trim() || token.surface;
      const resolvedWord =
        String(bestEntry.surface || token.surface || resolvedLemma).trim() || resolvedLemma;
      const meaning = buildDictionaryMeaning(entries);
      const localMeaning = String(local?.meaning || "");
      const localHasHit = Boolean(local && local.source && local.source !== "none" && local.matchedWord);
      const preferLocal =
        localHasHit &&
        (
          local.source === "mini_dict" ||
          bestRank.tier > 0 ||
          (!hasCjkText(meaning) && hasCjkText(localMeaning))
        );
      if (preferLocal) {
        return buildLocalDictionaryView(token, local, candidates, contextExample);
      }
      const example = String(
        bestEntry.example ||
          bestEntry.example_ja ||
          bestEntry.sentence ||
          bestEntry.sample ||
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
        reading: normalizeReading(token.reading || bestEntry.reading || "", resolvedWord) || "-",
        pos: preferTokenPos ? tokenPos : String(bestEntry.pos || tokenPos || "-"),
        meaning,
        example: example || "未提取到例句",
      };
    }
    return buildLocalDictionaryView(token, local, candidates, contextExample);
  }

  function buildLocalDictionaryView(token, local, candidates, contextExample = "") {
    const tokenPos = String(token.pos || "").trim();
    const resolvedWord = String(local?.matchedWord || token.surface || "").trim() || token.surface;
    const resolvedLemma = String(
      local?.matchedLemma || local?.matchedWord || token.lemma || resolvedWord
    ).trim();
    return {
      word: resolvedWord,
      lemma: resolvedLemma || resolvedWord,
      matchedWord: resolvedWord,
      matchedLemma: resolvedLemma || resolvedWord,
      source: local?.source || "none",
      candidates: Array.isArray(local?.candidates) ? local.candidates : candidates,
      reading: normalizeReading(token.reading || local?.reading || "", resolvedWord) || "-",
      pos: tokenPos && tokenPos !== "fallback" ? tokenPos : "-",
      meaning: String(local?.meaning || "词典无释义"),
      example: contextExample || "未提取到例句",
    };
  }

  function dictionaryEntryField(entry, key) {
    return String(entry?.[key] || "").trim();
  }

  function dictionaryEntrySurface(entry) {
    return stripWordNoise(dictionaryEntryField(entry, "surface"));
  }

  function dictionaryEntryLemma(entry) {
    return stripWordNoise(dictionaryEntryField(entry, "lemma"));
  }

  function dictionaryEntryGloss(entry) {
    return String(
      entry?.gloss_zh ||
        entry?.glossZh ||
        entry?.gloss ||
        entry?.gloss_en ||
        entry?.glossEn ||
        ""
    ).trim();
  }

  function dictionaryCandidateRank(entry, candidates) {
    const surface = dictionaryEntrySurface(entry);
    const lemma = dictionaryEntryLemma(entry);
    let exactIndex = Number.POSITIVE_INFINITY;
    let prefixIndex = Number.POSITIVE_INFINITY;
    let prefixExtra = Number.POSITIVE_INFINITY;
    candidates.forEach((candidate, index) => {
      if (!candidate) return;
      if (surface === candidate || lemma === candidate) {
        exactIndex = Math.min(exactIndex, index);
        return;
      }
      const surfaceStarts = surface.startsWith(candidate);
      const lemmaStarts = lemma.startsWith(candidate);
      if (surfaceStarts || lemmaStarts) {
        prefixIndex = Math.min(prefixIndex, index);
        const extra = Math.min(
          surfaceStarts ? Math.max(0, surface.length - candidate.length) : Number.POSITIVE_INFINITY,
          lemmaStarts ? Math.max(0, lemma.length - candidate.length) : Number.POSITIVE_INFINITY
        );
        prefixExtra = Math.min(prefixExtra, extra);
      }
    });
    if (Number.isFinite(exactIndex)) {
      return { tier: 0, index: exactIndex, extra: 0 };
    }
    if (Number.isFinite(prefixIndex)) {
      return { tier: 1, index: prefixIndex, extra: Number.isFinite(prefixExtra) ? prefixExtra : 0 };
    }
    return { tier: 2, index: 999, extra: 999 };
  }

  function pickBestDictionaryEntry(entries, token, candidates) {
    const tokenSurface = stripWordNoise(token?.surface || "");
    const tokenLemma = stripWordNoise(token?.lemma || "");
    const tokenDictionaryForm = stripWordNoise(token?.dictionaryForm || "");
    const expectedLength = Math.max(1, tokenSurface.length || tokenLemma.length || tokenDictionaryForm.length || 1);
    const sorted = [...entries].sort((left, right) => {
      const leftRank = dictionaryCandidateRank(left, candidates);
      const rightRank = dictionaryCandidateRank(right, candidates);
      if (leftRank.tier !== rightRank.tier) return leftRank.tier - rightRank.tier;
      if (leftRank.index !== rightRank.index) return leftRank.index - rightRank.index;
      if (leftRank.extra !== rightRank.extra) return leftRank.extra - rightRank.extra;

      const leftSurface = dictionaryEntrySurface(left);
      const rightSurface = dictionaryEntrySurface(right);
      const leftLengthDiff = Math.abs(leftSurface.length - expectedLength);
      const rightLengthDiff = Math.abs(rightSurface.length - expectedLength);
      if (leftLengthDiff !== rightLengthDiff) return leftLengthDiff - rightLengthDiff;

      const leftGloss = dictionaryEntryGloss(left);
      const rightGloss = dictionaryEntryGloss(right);
      const leftHasCjk = hasCjkText(leftGloss);
      const rightHasCjk = hasCjkText(rightGloss);
      if (leftHasCjk !== rightHasCjk) return leftHasCjk ? -1 : 1;

      return leftSurface.length - rightSurface.length;
    });
    return sorted[0] || entries[0];
  }

  function buildDictionaryMeaning(entries) {
    const unique = [];
    const seen = new Set();
    entries.forEach((entry) => {
      const gloss = dictionaryEntryGloss(entry);
      if (!gloss || seen.has(gloss)) return;
      seen.add(gloss);
      unique.push(gloss);
    });
    if (!unique.length) return "词典无释义";
    const cjk = unique.filter((item) => hasCjkText(item));
    const preferred = (cjk.length ? cjk : unique).slice(0, 3).join(" / ");
    return cjk.length ? preferred : `英释: ${preferred}`;
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

  function buildExplainContext(paragraph, sentence) {
    const text = String(paragraph || "");
    const start = Math.max(0, Number(sentence?.start || 0) - 24);
    const end = Math.min(text.length, Number(sentence?.end || 0) + 24);
    return text.slice(start, end);
  }

  async function explainSentence(sentence, meta = {}) {
    const text = String(sentence?.text || "").trim();
    if (!text) return;
    setSelectionState({
      selectedSentence: {
        id: String(sentence.id || ""),
        text,
        chapterId: String(meta.chapterId || ""),
        paraIndex: Number(meta.paraIndex || 0),
        start: Number(sentence.start || 0),
        end: Number(sentence.end || 0),
      },
    });
    setExplainState({
      loading: true,
      sentenceId: String(sentence.id || ""),
      cached: false,
      result: null,
      error: "",
    });
    renderReader({ preserveScroll: true });
    renderExplainPanel();

    try {
      const payload = await explainSentenceByAi(
        {
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
        },
        { timeoutMs: 12000 }
      );
      if (payload?.billing) {
        updateBilling(payload.billing);
      }
      setExplainState({
        loading: false,
        sentenceId: String(sentence.id || ""),
        cached: Boolean(payload.cached),
        result: payload.result || null,
        error: "",
      });
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
      setExplainState({
        loading: false,
        sentenceId: String(sentence.id || ""),
        cached: false,
        result: null,
        error: friendly,
      });
      showToast(friendly, true);
    }
    renderExplainPanel();
  }

  return {
    onReaderClick,
    onReaderMouseUp,
    onReaderTouchEnd,
    handleReaderSelectionLookup,
    getSelectionParagraph,
    getSelectedRangeInParagraph,
    findTokenAt,
    getParagraphTokens,
    tokenizeParagraph,
    katakanaToHiragana,
    hiraganaToKatakana,
    fallbackReadingFromSurface,
    normalizeReading,
    hasCjkText,
    normalizeToken,
    fallbackTokenize,
    expandKnownRange,
    getParagraphByLocation,
    extractSentenceExample,
    clearSelectionMark,
    markSelection,
    selectToken,
    enrichTokenDetails,
    lookupDictionary,
    buildDictionaryView,
    stripWordNoise,
    buildLookupCandidates,
    buildLookupPayloads,
    expandKanaTailCandidates,
    alignMatchedWordToToken,
    lookupLocalDictionary,
    buildExplainContext,
    explainSentence,
  };
}
