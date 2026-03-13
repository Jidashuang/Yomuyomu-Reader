import { explain as explainViaService } from "../../services/analysisService.js";

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeDifficulty(value) {
  const difficulty = String(value || "").trim().toUpperCase();
  if (["N1", "N2", "N3", "N4", "N5"].includes(difficulty)) return difficulty;
  return "N3";
}

export async function explain(sentence, context = "", options = {}) {
  const payload = await explainViaService({ sentence, context }, options);
  return {
    ok: Boolean(payload?.ok),
    translation: String(payload?.translation || "").trim(),
    grammar: normalizeList(payload?.grammar),
    notes: normalizeList(payload?.notes),
    difficulty: normalizeDifficulty(payload?.difficulty),
    billing: payload?.billing || null,
    raw: payload,
  };
}

const grammar = {
  explain,
};

export default grammar;
