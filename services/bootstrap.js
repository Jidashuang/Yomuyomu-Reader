import * as apiClient from "./apiClient.js";
import * as accountService from "./accountService.js";
import * as billingService from "./billingService.js";
import * as syncService from "./syncService.js";
import * as dictionaryService from "./dictionaryService.js";
import * as analysisService from "./analysisService.js";
import * as ttsService from "./ttsService.js";

import * as tokenizer from "../features/japanese/tokenizer.js";
import * as dictionaryFeature from "../features/japanese/dictionary.js";
import * as ruby from "../features/japanese/ruby.js";
import * as grammar from "../features/japanese/grammar.js";
import { createLearningSession } from "../features/japanese/learningSession.js";

// Transitional compatibility bridge:
// new reader code should call services directly; this fetch monkey-patch only keeps legacy callers alive.

function readAccountTokenFromStorage() {
  try {
    const raw = window.localStorage.getItem("yomuyomu_sync_v2");
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    return String(parsed?.accountToken || "").trim();
  } catch {
    return "";
  }
}

apiClient.setAccountTokenProvider(readAccountTokenFromStorage);

window.yomuyomuServices = {
  accountService,
  analysisService,
  apiClient,
  billingService,
  dictionaryService,
  syncService,
  ttsService,
};

window.yomuyomuJapanese = {
  dictionary: dictionaryFeature,
  grammar,
  learningSession: createLearningSession(),
  ruby,
  tokenizer,
};

function methodOf(input, init) {
  if (init?.method) return String(init.method).toUpperCase();
  if (input instanceof Request) return String(input.method || "GET").toUpperCase();
  return "GET";
}

async function readJsonBody(input, init) {
  if (init?.body != null) {
    if (typeof init.body === "string") {
      return init.body.trim() ? JSON.parse(init.body) : {};
    }
    if (init.body instanceof URLSearchParams) {
      return Object.fromEntries(init.body.entries());
    }
    if (init.body instanceof FormData) {
      return Object.fromEntries(init.body.entries());
    }
    if (typeof init.body === "object") {
      return init.body;
    }
  }

  if (input instanceof Request) {
    const text = await input.clone().text();
    return text.trim() ? JSON.parse(text) : {};
  }

  return {};
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload ?? {}), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function errorResponse(error) {
  const rawStatus = Number(error?.status || error?.statusCode || 0);
  const status = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 503;
  const payload =
    error?.payload && typeof error.payload === "object"
      ? error.payload
      : { ok: false, error: String(error?.message || "Request failed") };
  return jsonResponse(payload, status);
}

function normalizePath(input) {
  const path = apiClient.extractApiPath(input);
  if (!path) return "";
  try {
    const parsed = new URL(path, window.location.origin);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return path;
  }
}

function queryParam(path, key, fallback = "") {
  try {
    const parsed = new URL(path, window.location.origin);
    return parsed.searchParams.get(key) || fallback;
  } catch {
    return fallback;
  }
}

async function bridgeApi(path, input, init) {
  const route = path.split("?")[0];
  const method = methodOf(input, init);
  const headers = init?.headers;

  if (route === "/api/dict/lookup" && method === "POST") {
    const body = await readJsonBody(input, init);
    return dictionaryService.lookup(body, { headers });
  }

  if (route === "/api/nlp/tokenize" && method === "POST") {
    const body = await readJsonBody(input, init);
    return analysisService.tokenize(body, { headers });
  }

  if (route === "/api/ai/explain" && method === "POST") {
    const body = await readJsonBody(input, init);
    return analysisService.explain(body, { headers });
  }

  if (route === "/api/sync/push" && method === "POST") {
    const body = await readJsonBody(input, init);
    return syncService.push(body, { headers });
  }

  if (route === "/api/sync/pull" && method === "GET") {
    const userId = queryParam(path, "userId", "default");
    return syncService.pull(userId, { headers });
  }

  if (route === "/api/payment/options" && method === "GET") {
    return billingService.getPaymentOptions({ headers });
  }

  if (route === "/api/billing/plan" && method === "GET") {
    const userId = queryParam(path, "userId", "default");
    return billingService.getPlan(userId, { headers });
  }

  if (route === "/api/billing/create-checkout-session" && method === "POST") {
    const body = await readJsonBody(input, init);
    return billingService.createCheckoutSession(body, { headers });
  }

  if (route === "/api/billing/checkout-complete" && method === "POST") {
    const body = await readJsonBody(input, init);
    return billingService.checkoutComplete(body, { headers });
  }

  if (route === "/api/billing/create-portal-session" && method === "POST") {
    const body = await readJsonBody(input, init);
    return billingService.createPortalSession(body, { headers });
  }

  return null;
}

function installFetchBridge() {
  if (window.__yomuyomuServiceBridgeInstalled) return;

  const nativeFetch = apiClient.getNativeFetch();

  window.fetch = async (input, init = {}) => {
    const path = normalizePath(input);
    if (!path) {
      return nativeFetch(input, init);
    }

    try {
      const payload = await bridgeApi(path, input, init);
      if (payload == null) {
        return nativeFetch(input, init);
      }
      if (payload instanceof Response) {
        return payload;
      }
      return jsonResponse(payload, 200);
    } catch (error) {
      return errorResponse(error);
    }
  };

  window.__yomuyomuServiceBridgeInstalled = true;
}

installFetchBridge();
