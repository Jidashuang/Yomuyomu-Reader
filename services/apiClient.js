const DEFAULT_TIMEOUT_MS = 8000;
const LOCAL_API_ORIGIN = "http://127.0.0.1:8000";

const nativeFetch =
  typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;

let accountTokenProvider = () => "";

function ensureFetch() {
  if (typeof nativeFetch !== "function") {
    throw new Error("Fetch API is not available in this environment.");
  }
  return nativeFetch;
}

function createAbortSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timeout = Number(timeoutMs);
  const hasTimeout = Number.isFinite(timeout) && timeout > 0;
  const timerId = hasTimeout
    ? setTimeout(() => {
        controller.abort(new DOMException("Request timeout", "AbortError"));
      }, timeout)
    : null;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener(
        "abort",
        () => {
          controller.abort(externalSignal.reason);
        },
        { once: true }
      );
    }
  }

  return {
    signal: controller.signal,
    clear() {
      if (timerId) clearTimeout(timerId);
    },
  };
}

function normalizeBody(body, headers) {
  if (body == null) return body;
  if (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer
  ) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return body;
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return JSON.stringify(body);
}

function withAccountToken(headers, includeAccountToken) {
  if (!includeAccountToken) return;
  if (headers.has("X-Account-Token")) return;
  const token = String(accountTokenProvider?.() || "").trim();
  if (token) headers.set("X-Account-Token", token);
}

function parseJsonSafe(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON response", raw: text };
  }
}

export function setAccountTokenProvider(provider) {
  accountTokenProvider = typeof provider === "function" ? provider : () => "";
}

export function getNativeFetch() {
  return ensureFetch();
}

export function resolveRequestUrl(url) {
  const raw = String(url || "");
  if (!raw) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!raw.startsWith("/")) return raw;

  const isApiLikePath = raw.startsWith("/api/") || raw.startsWith("/backend/data/");
  if (isApiLikePath && typeof window !== "undefined") {
    const protocol = String(window.location?.protocol || "").toLowerCase();
    const host = String(window.location?.hostname || "").toLowerCase();
    const port = String(window.location?.port || "");
    const isLocalHost = !host || host === "127.0.0.1" || host === "localhost";
    const shouldForceLocalBackend = protocol === "file:" || (isLocalHost && port !== "8000");
    if (shouldForceLocalBackend) {
      return `${LOCAL_API_ORIGIN}${raw}`;
    }
  }

  return raw;
}

export function extractApiPath(input) {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : String(input?.url || "");

  if (!raw) return "";
  if (raw.startsWith("/api/") || raw.startsWith("/backend/data/")) return raw;

  try {
    const base =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : LOCAL_API_ORIGIN;
    const parsed = new URL(raw, base);
    if (parsed.pathname.startsWith("/api/") || parsed.pathname.startsWith("/backend/data/")) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    return "";
  }

  return "";
}

export async function requestRaw(url, options = {}) {
  const {
    method = "GET",
    headers,
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    includeAccountToken = true,
    ...rest
  } = options;

  const requestHeaders = new Headers(headers || {});
  withAccountToken(requestHeaders, includeAccountToken);
  const requestBody = normalizeBody(body, requestHeaders);
  const abort = createAbortSignal(timeoutMs, signal);

  try {
    return await ensureFetch()(resolveRequestUrl(url), {
      method,
      headers: requestHeaders,
      body: requestBody,
      signal: abort.signal,
      ...rest,
    });
  } finally {
    abort.clear();
  }
}

export async function requestJson(url, options = {}) {
  const response = await requestRaw(url, options);
  const text = await response.text();
  const payload = parseJsonSafe(text);

  if (!response.ok) {
    const errorMessage = payload?.error || payload?.message || `HTTP ${response.status}`;
    const error = new Error(errorMessage);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}
