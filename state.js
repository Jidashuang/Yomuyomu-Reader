import {
  DEFAULT_BILLING,
  state,
} from "./readerStore.js";
import {
  chapterIndexById as chapterIndexByIdForBook,
  clampChapterIndex as clampChapterIndexForBook,
  getChapterAt,
  getChapterById as getChapterByIdForBook,
} from "./utils/chapters.js";
import {
  normalizeBilling as normalizeBillingData,
  normalizeBillingCycle,
  normalizeBillingInterval,
  normalizeBillingOrder as normalizeBillingOrderData,
  normalizeBook,
  normalizePayChannel,
  normalizePlan,
  sanitizeSyncUserId,
} from "./utils/normalize.js";

export { normalizeBook, sanitizeSyncUserId, normalizePlan, normalizePayChannel, normalizeBillingInterval, normalizeBillingCycle };

export function currentChapterData() {
  return getChapterAt(state.book, state.currentChapter);
}

export function getChapterById(chapterId) {
  return getChapterByIdForBook(state.book, chapterId);
}

export function chapterIndexById(chapterId) {
  return chapterIndexByIdForBook(state.book, chapterId);
}

export function clampChapterIndex(index) {
  return clampChapterIndexForBook(index, state.book);
}

export function normalizeBilling(raw) {
  return normalizeBillingData(raw, {
    defaultBilling: DEFAULT_BILLING,
    syncUserId: state.sync?.userId,
  });
}

export function normalizeBillingOrder(raw) {
  return normalizeBillingOrderData(raw, {
    defaultChannel: "wechat",
    defaultInterval: "monthly",
  });
}

export function hasFeature(featureName) {
  return Boolean(state.billing?.features?.[featureName]);
}
