import { requestJson } from "./apiClient.js";

export async function tokenize(textOrPayload, options = {}) {
  const payload =
    typeof textOrPayload === "string"
      ? { text: textOrPayload }
      : { ...(textOrPayload || {}) };

  return requestJson("/api/nlp/tokenize", {
    method: "POST",
    body: payload,
    ...options,
  });
}

export async function explain(payload, options = {}) {
  return requestJson("/api/ai/explain", {
    method: "POST",
    body: payload,
    ...options,
  });
}

const analysisService = {
  explain,
  tokenize,
};

export default analysisService;
