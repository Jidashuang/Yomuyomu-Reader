import { requestJson } from "./apiClient.js";

export async function getPaymentOptions(options = {}) {
  return requestJson("/api/payment/options", { method: "GET", ...options });
}

export async function getPlan(userId, options = {}) {
  const query = new URLSearchParams();
  if (userId) query.set("userId", String(userId));
  const suffix = query.toString();
  const path = suffix ? `/api/billing/plan?${suffix}` : "/api/billing/plan";
  return requestJson(path, { method: "GET", ...options });
}

export async function createCheckoutSession(payload, options = {}) {
  return requestJson("/api/billing/create-checkout-session", {
    method: "POST",
    body: payload,
    ...options,
  });
}

export async function checkoutComplete(payload, options = {}) {
  return requestJson("/api/billing/checkout-complete", {
    method: "POST",
    body: payload,
    ...options,
  });
}

export async function createPortalSession(payload, options = {}) {
  return requestJson("/api/billing/create-portal-session", {
    method: "POST",
    body: payload,
    ...options,
  });
}

const billingService = {
  checkoutComplete,
  createCheckoutSession,
  createPortalSession,
  getPaymentOptions,
  getPlan,
};

export default billingService;
