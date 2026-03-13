import { requestJson } from "./apiClient.js";

export async function lookup(payload, options = {}) {
  return requestJson("/api/dict/lookup", {
    method: "POST",
    body: payload,
    ...options,
  });
}

const dictionaryService = {
  lookup,
};

export default dictionaryService;
