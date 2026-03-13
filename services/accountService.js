import { requestJson } from "./apiClient.js";

export async function health(options = {}) {
  return requestJson("/api/health", { method: "GET", ...options });
}

export async function register(payload, options = {}) {
  return requestJson("/api/auth/register", {
    method: "POST",
    body: payload,
    ...options,
  });
}

export async function login(payload, options = {}) {
  return requestJson("/api/auth/login", {
    method: "POST",
    body: payload,
    ...options,
  });
}

export async function sendFeedback(payload, options = {}) {
  return requestJson("/api/feedback", {
    method: "POST",
    body: payload,
    ...options,
  });
}

export async function deleteCloudData(payload, options = {}) {
  return requestJson("/api/cloud/delete", {
    method: "POST",
    body: payload,
    ...options,
  });
}

export async function deleteAccount(payload, options = {}) {
  return requestJson("/api/account/delete", {
    method: "POST",
    body: payload,
    ...options,
  });
}

const accountService = {
  deleteAccount,
  deleteCloudData,
  health,
  login,
  register,
  sendFeedback,
};

export default accountService;
