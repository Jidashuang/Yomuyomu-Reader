import { tokenize as tokenizeViaAnalysis } from "../../services/analysisService.js";

function normalizeToken(token) {
  return {
    surface: String(token?.surface || token?.word || "").trim(),
    lemma: String(token?.lemma || token?.base || "").trim(),
    reading: String(token?.reading || "").trim(),
    pos: String(token?.pos || token?.partOfSpeech || "").trim(),
    start: Number.isFinite(Number(token?.start)) ? Number(token.start) : undefined,
    end: Number.isFinite(Number(token?.end)) ? Number(token.end) : undefined,
  };
}

export async function tokenize(text, options = {}) {
  const payload = await tokenizeViaAnalysis({ text }, options);
  const tokens = Array.isArray(payload?.tokens) ? payload.tokens : [];
  return tokens.map(normalizeToken).filter((token) => token.surface);
}

export async function tokenizeWithPayload(text, options = {}) {
  const payload = await tokenizeViaAnalysis({ text }, options);
  const tokens = Array.isArray(payload?.tokens) ? payload.tokens.map(normalizeToken) : [];
  return { ok: Boolean(payload?.ok), tokens, raw: payload };
}

const tokenizer = {
  tokenize,
  tokenizeWithPayload,
};

export default tokenizer;
