import { stripWordNoise } from "./localDictionaryLookup.js";

const JP_TEXT_RE = /[一-龯々ぁ-ゖァ-ヺー]/u;
const LEXICAL_SCRIPT_RE = /[\u3400-\u9fff々ァ-ヺー]/u;
const GLUED_GRAMMAR_SUFFIXES = [
  "でした",
  "です",
  "だ",
  "で",
  "に",
  "を",
  "へ",
  "と",
  "が",
  "は",
  "も",
  "の",
  "ね",
  "よ",
  "か",
  "な",
];

function hasLexicalScript(value) {
  return LEXICAL_SCRIPT_RE.test(String(value || ""));
}

function normalizedBaseForm(token = {}) {
  return stripWordNoise(
    token.dictionaryForm || token.base || token.baseForm || token.lemma || token.surface || ""
  );
}

export function isSuspiciousGluedLexicalToken(token = {}) {
  const surface = stripWordNoise(token.surface || "");
  if (!surface || surface.length <= 1 || !JP_TEXT_RE.test(surface) || !hasLexicalScript(surface)) {
    return false;
  }

  const base = normalizedBaseForm(token);
  if (base && base !== surface) {
    return false;
  }

  return GLUED_GRAMMAR_SUFFIXES.some((suffix) => {
    if (!surface.endsWith(suffix) || surface.length <= suffix.length) return false;
    const stem = surface.slice(0, -suffix.length);
    return Boolean(stem) && hasLexicalScript(stem);
  });
}

export function shouldTrustAnalysisTokens(tokens = []) {
  if (!Array.isArray(tokens) || !tokens.length) return false;

  const lastEndByParagraph = new Map();
  let sawJapaneseToken = false;

  for (const token of tokens) {
    const surface = String(token?.surface || "");
    if (!surface) continue;
    if (JP_TEXT_RE.test(surface)) {
      sawJapaneseToken = true;
    }

    const paragraphIndex = Number.isFinite(Number(token?.paragraphIndex))
      ? Number(token.paragraphIndex)
      : 0;
    const start = Number(token?.start);
    const end = Number(token?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return false;
    }

    const previousEnd = lastEndByParagraph.get(paragraphIndex);
    if (Number.isFinite(previousEnd) && start < previousEnd) {
      return false;
    }
    lastEndByParagraph.set(paragraphIndex, end);

    if (isSuspiciousGluedLexicalToken(token)) {
      return false;
    }
  }

  return sawJapaneseToken;
}
