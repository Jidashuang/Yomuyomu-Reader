import { DAY_MS, els, state, STORAGE_KEYS, saveJSON } from "./readerStore.js";

export function createVocabModule(deps) {
  const {
    appendListEmpty,
    chapterIndexById,
    csvEscape,
    ensureRenderedThrough,
    formatDate,
    getChapterById,
    makeId,
    markSelection,
    renderBookMeta,
    renderChapterList,
    renderLookupPanel,
    renderReader,
    renderStats,
    requestAnalyze,
    setRightPanelTab,
    setStatus,
  } = deps;

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
    const maxRows = Math.max(1, Number(state.billing.features.csvExportMaxRows) || 60);
    const fullExportEnabled = maxRows >= state.vocab.length;
    const exportItems = fullExportEnabled ? state.vocab : state.vocab.slice(0, maxRows);

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
      setStatus(`Free 套餐仅可导出前 ${maxRows} 条，升级 Pro 可导出全部。`, true);
    } else {
      setStatus(`导出完成，共 ${exportItems.length} 条。`);
    }
  }

  return {
    exportVocabCsv,
    jumpToPosition,
    onAddBookmark,
    onAddNoteClick,
    onAddWord,
    onBookmarkListClick,
    onNoteListClick,
    onSaveNote,
    onVocabAction,
    renderBookmarks,
    renderNotes,
    renderVocab,
  };
}
