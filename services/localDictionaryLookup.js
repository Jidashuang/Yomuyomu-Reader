function uniquePush(list, seen, value) {
  const normalized = String(value || "").trim();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  list.push(normalized);
}

function normalizeJlptLevel(value) {
  const raw = String(value || "").toUpperCase().replace(/\s+/g, "");
  if (["N1", "1"].includes(raw)) return "N1";
  if (["N2", "2"].includes(raw)) return "N2";
  if (["N3", "3"].includes(raw)) return "N3";
  if (["N4", "4"].includes(raw)) return "N4";
  if (["N5", "5"].includes(raw)) return "N5";
  return "";
}

export function stripWordNoise(value) {
  return String(value || "")
    .trim()
    .replace(
      /^[\s「」『』【】［］（）()〈〉《》〔〕｛｝{}'"“”‘’、。・，．！？!?：:；;]+|[\s「」『』【】［］（）()〈〉《》〔〕｛｝{}'"“”‘’、。・，．！？!?：:；;]+$/g,
      ""
    )
    .trim();
}

export function katakanaToHiragana(text) {
  return String(text || "").replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

export function hiraganaToKatakana(text) {
  return String(text || "").replace(/[ぁ-ゖ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

export function fallbackReadingFromSurface(surface) {
  const value = stripWordNoise(surface);
  if (!value) return "";
  if (/^[ぁ-ゖー]+$/u.test(value)) return value;
  if (/^[ァ-ヺー]+$/u.test(value)) return katakanaToHiragana(value);
  return "";
}

export function normalizeReading(reading, surface = "") {
  const raw = String(reading || "").trim() || fallbackReadingFromSurface(surface);
  if (!raw) return "";
  if (/^[ァ-ヺー]+$/u.test(raw)) return katakanaToHiragana(raw);
  return raw;
}

function addCandidateFamily(list, seen, raw) {
  const value = String(raw || "").trim();
  if (!value) return;
  uniquePush(list, seen, value);
  const stripped = stripWordNoise(value);
  uniquePush(list, seen, stripped);
  uniquePush(list, seen, katakanaToHiragana(stripped || value));
  uniquePush(list, seen, hiraganaToKatakana(stripped || value));
}

export function expandKanaTailCandidates(value) {
  const normalized = stripWordNoise(value);
  if (!normalized) return [];
  const tailMatch = normalized.match(/[ぁ-ゖァ-ヺー]+$/u);
  if (!tailMatch?.[0]) return [];
  const tail = tailMatch[0];
  const variants = [];
  for (let cut = 1; cut <= tail.length; cut += 1) {
    const candidate = normalized.slice(0, -cut);
    if (candidate) variants.push(candidate);
  }
  return variants;
}

function expandParticleCandidates(value) {
  const normalized = stripWordNoise(value);
  if (!normalized) return [];
  const variants = [];
  const suffixes = ["です", "でした", "だ", "で", "に", "を", "へ", "と", "が", "は", "も", "の", "ね", "よ"];
  let current = normalized;
  for (let i = 0; i < 2; i += 1) {
    const matched = suffixes.find((suffix) => current.endsWith(suffix) && current.length > suffix.length);
    if (!matched) break;
    current = current.slice(0, -matched.length);
    if (current) variants.push(current);
  }
  return variants;
}

export function expandCommonInflectionCandidates(value) {
  const normalized = stripWordNoise(value);
  if (!normalized) return [];
  const variants = [];
  const add = (next) => {
    const trimmed = stripWordNoise(next);
    if (trimmed && trimmed !== normalized) variants.push(trimmed);
  };

  const plainRules = [
    ["でした", ["だ"]],
    ["ます", ["る", "う"]],
    ["ました", ["る", "う"]],
    ["ません", ["る", "う"]],
    ["ませんでした", ["る", "う"]],
    ["ない", ["る", "う"]],
    ["なかった", ["る", "う"]],
    ["くない", ["い"]],
    ["くなかった", ["い"]],
    ["かった", ["い"]],
    ["して", ["する"]],
    ["した", ["する"]],
    ["しない", ["する"]],
    ["します", ["する"]],
    ["った", ["う", "つ", "る"]],
    ["って", ["う", "つ", "る"]],
    ["んだ", ["む", "ぶ", "ぬ"]],
    ["んで", ["む", "ぶ", "ぬ"]],
    ["いた", ["く"]],
    ["いて", ["く"]],
    ["いだ", ["ぐ"]],
    ["いで", ["ぐ"]],
    ["た", ["る"]],
    ["て", ["る"]],
  ];

  plainRules.forEach(([suffix, endings]) => {
    if (!normalized.endsWith(suffix) || normalized.length <= suffix.length) return;
    const stem = normalized.slice(0, -suffix.length);
    add(stem);
    endings.forEach((ending) => add(stem + ending));
  });

  return variants;
}

export function buildLookupCandidates(surface, lemma = "", dictionaryForm = "") {
  const ordered = [];
  const seen = new Set();
  const seeds = [surface, lemma, dictionaryForm];

  seeds.forEach((seed) => {
    addCandidateFamily(ordered, seen, seed);
    const base = stripWordNoise(seed);
    if (!base) return;

    expandParticleCandidates(base).forEach((candidate) => addCandidateFamily(ordered, seen, candidate));
    expandCommonInflectionCandidates(base).forEach((candidate) => addCandidateFamily(ordered, seen, candidate));
    // Keep tail-truncation as a last resort to avoid matching overly broad stems too early.
    expandKanaTailCandidates(base).forEach((candidate) => addCandidateFamily(ordered, seen, candidate));
  });

  return ordered;
}

export function buildLookupPayloads(surface, lemma = "", dictionaryForm = "") {
  const ordered = [];
  const seen = new Set();
  const push = (nextSurface, nextLemma = nextSurface) => {
    const normalizedSurface = stripWordNoise(nextSurface) || String(nextSurface || "").trim();
    const normalizedLemma =
      stripWordNoise(nextLemma) || String(nextLemma || "").trim() || normalizedSurface;
    const finalSurface = normalizedSurface || normalizedLemma;
    const finalLemma = normalizedLemma || normalizedSurface;
    if (!finalSurface && !finalLemma) return;
    const key = `${finalSurface}\n${finalLemma}`;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push({
      surface: finalSurface,
      lemma: finalLemma,
    });
  };

  push(surface, lemma || dictionaryForm || surface);
  buildLookupCandidates(surface, lemma, dictionaryForm).forEach((candidate) => {
    push(candidate, candidate);
  });

  return ordered;
}

export function findJlptMatch({ surface = "", lemma = "", dictionaryForm = "", jlptMap = {} } = {}) {
  const candidates = buildLookupCandidates(surface, lemma, dictionaryForm);
  for (const key of candidates) {
    const level = normalizeJlptLevel(jlptMap?.[key]);
    if (!level) continue;
    return {
      level,
      matchedWord: key,
      matchedLemma: key,
      candidates,
    };
  }
  return {
    level: "",
    matchedWord: "",
    matchedLemma: "",
    candidates,
  };
}

export function alignMatchedWordToToken(token = {}, matchedWord = "") {
  const start = Number.isFinite(Number(token?.start)) ? Number(token.start) : 0;
  const surface = String(token?.surface || "");
  const tokenLength = surface.length;
  const end = Number.isFinite(Number(token?.end)) ? Number(token.end) : start + tokenLength;
  const normalizedMatched = stripWordNoise(matchedWord);
  if (!normalizedMatched) {
    return { start, end, surface };
  }

  const directIndex = surface.indexOf(normalizedMatched);
  if (directIndex >= 0) {
    return {
      start: start + directIndex,
      end: start + directIndex + normalizedMatched.length,
      surface: normalizedMatched,
    };
  }

  const strippedSurface = stripWordNoise(surface);
  if (strippedSurface.startsWith(normalizedMatched) && start + normalizedMatched.length <= end) {
    return {
      start,
      end: start + normalizedMatched.length,
      surface: normalizedMatched,
    };
  }

  return { start, end, surface };
}

function lookupFromVocab(candidates, vocab, readFn) {
  if (!Array.isArray(vocab) || !vocab.length) return null;
  // Build a Map of normalized word/lemma → item once so each candidate
  // lookup is O(1) instead of O(vocab_size). First occurrence wins, which
  // matches the original vocab.find() behaviour.
  const vocabIndex = new Map();
  for (const item of vocab) {
    const word = stripWordNoise(item?.word);
    const lemma = stripWordNoise(item?.lemma);
    if (word && !vocabIndex.has(word)) vocabIndex.set(word, item);
    if (lemma && !vocabIndex.has(lemma)) vocabIndex.set(lemma, item);
  }
  for (const key of candidates) {
    const hit = vocabIndex.get(key);
    if (!hit) continue;
    const matchedWord = stripWordNoise(hit.word) || stripWordNoise(hit.lemma) || key;
    const matchedLemma = stripWordNoise(hit.lemma) || matchedWord;
    return {
      source: "vocab",
      matchedWord,
      matchedLemma,
      reading: readFn(hit.reading || "", matchedWord) || "-",
      meaning: String(hit.meaning || "词典无释义"),
    };
  }
  return null;
}

export function lookupLocalDictionary({
  surface = "",
  lemma = "",
  dictionaryForm = "",
  miniDict = {},
  vocab = [],
  apiOnline = false,
  jmdictReady = false,
  normalizeReading: customNormalizeReading,
} = {}) {
  const readFn = typeof customNormalizeReading === "function" ? customNormalizeReading : normalizeReading;
  const candidates = buildLookupCandidates(surface, lemma, dictionaryForm);

  for (const key of candidates) {
    if (!miniDict || typeof miniDict !== "object" || !miniDict[key]) continue;
    return {
      source: "mini_dict",
      matchedWord: key,
      matchedLemma: key,
      reading: readFn(miniDict[key].reading || "", key) || "-",
      meaning: miniDict[key].meaning || "词典无释义",
      candidates,
    };
  }

  const vocabHit = lookupFromVocab(candidates, vocab, readFn);
  if (vocabHit) {
    return {
      ...vocabHit,
      candidates,
    };
  }

  const missingHint =
    apiOnline && !jmdictReady
      ? "未加载 jmdict.db，本地词库命中有限。可先构建词典库或点外部词典。"
      : "本地词库未命中。可点“在 MOJi 中查”继续检索。";
  return {
    source: "none",
    matchedWord: "",
    matchedLemma: "",
    reading: readFn("", surface || lemma) || "-",
    meaning: missingHint,
    candidates,
  };
}

export function findExistingVocabEntry(vocab, word = "", lemma = "", dictionaryForm = "") {
  const vocabList = Array.isArray(vocab) ? vocab : [];
  if (!vocabList.length) return undefined;
  const selectedSet = new Set(buildLookupCandidates(word, lemma, dictionaryForm));
  return vocabList.find((item) => {
    const itemWord = stripWordNoise(item?.word);
    const itemLemma = stripWordNoise(item?.lemma);
    // Fast path: direct match against the already-computed candidate set.
    if (itemWord && selectedSet.has(itemWord)) return true;
    if (itemLemma && selectedSet.has(itemLemma)) return true;
    // Slow path: expand the item's own candidates and cross-check.
    return buildLookupCandidates(item?.word, item?.lemma).some((c) => selectedSet.has(c));
  });
}
