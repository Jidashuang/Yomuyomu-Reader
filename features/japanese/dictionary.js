import { lookup as lookupViaService } from "../../services/dictionaryService.js";

function normalizeEntry(entry) {
  return {
    surface: String(entry?.surface || "").trim(),
    lemma: String(entry?.lemma || "").trim(),
    reading: String(entry?.reading || "").trim(),
    pos: String(entry?.pos || "").trim(),
    glossZh: String(entry?.gloss_zh || entry?.glossZh || "").trim(),
    glossEn: String(entry?.gloss_en || entry?.glossEn || "").trim(),
    example: String(entry?.example || entry?.example_ja || "").trim(),
  };
}

export async function lookup(surface, lemma = "", options = {}) {
  const payload = await lookupViaService({ surface, lemma }, options);
  const entries = Array.isArray(payload?.entries) ? payload.entries.map(normalizeEntry) : [];
  return { ok: Boolean(payload?.ok), entries, raw: payload };
}

const dictionary = {
  lookup,
};

export default dictionary;
