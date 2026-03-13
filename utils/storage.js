function hasLocalStorage() {
  return typeof globalThis !== "undefined" && Boolean(globalThis.localStorage);
}

export function safeParseJSON(raw, fallback) {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function loadJSON(key, fallback) {
  if (!hasLocalStorage()) return fallback;
  try {
    const raw = globalThis.localStorage.getItem(String(key || ""));
    if (!raw) return fallback;
    return safeParseJSON(raw, fallback);
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  if (!hasLocalStorage()) return false;
  try {
    globalThis.localStorage.setItem(String(key || ""), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadStorageValue(key, fallback = "") {
  if (!hasLocalStorage()) return fallback;
  try {
    const value = globalThis.localStorage.getItem(String(key || ""));
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function saveStorageValue(key, value) {
  if (!hasLocalStorage()) return false;
  try {
    globalThis.localStorage.setItem(String(key || ""), String(value ?? ""));
    return true;
  } catch {
    return false;
  }
}

export function removeStorageItem(key) {
  if (!hasLocalStorage()) return false;
  try {
    globalThis.localStorage.removeItem(String(key || ""));
    return true;
  } catch {
    return false;
  }
}
