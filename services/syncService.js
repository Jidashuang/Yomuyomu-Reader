import { requestJson } from "./apiClient.js";

export async function pull(userId, options = {}) {
  const query = new URLSearchParams();
  if (userId) query.set("userId", String(userId));
  const suffix = query.toString();
  const path = suffix ? `/api/sync/pull?${suffix}` : "/api/sync/pull";
  return requestJson(path, { method: "GET", ...options });
}

export async function push(payload, options = {}) {
  return requestJson("/api/sync/push", {
    method: "POST",
    body: payload,
    ...options,
  });
}

export async function exportProgress(userId, options = {}) {
  const query = new URLSearchParams();
  if (userId) query.set("userId", String(userId));
  const suffix = query.toString();
  const path = suffix ? `/api/export/progress?${suffix}` : "/api/export/progress";
  return requestJson(path, { method: "GET", ...options });
}

export async function exportVocab(userId, options = {}) {
  const query = new URLSearchParams();
  if (userId) query.set("userId", String(userId));
  const suffix = query.toString();
  const path = suffix ? `/api/export/vocab?${suffix}` : "/api/export/vocab";
  return requestJson(path, { method: "GET", ...options });
}

const syncService = {
  exportProgress,
  exportVocab,
  pull,
  push,
};

export default syncService;
