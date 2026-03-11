import {
  DEFAULT_BILLING,
  state,
} from "./readerStore.js";

export function normalizeBook(rawBook) {
  const chaptersRaw = Array.isArray(rawBook?.chapters) ? rawBook.chapters : [];
  const chapters = chaptersRaw.map((item, idx) => {
    const paragraphsSource = Array.isArray(item?.paragraphs) ? item.paragraphs : null;
    const text = String(item?.text || "").replace(/\r/g, "").trim();
    const paragraphs = (paragraphsSource || (text ? text.split(/\n+/) : []))
      .map((line) => String(line || "").trim())
      .filter(Boolean);
    return {
      id: String(item?.id || `ch-${idx + 1}`),
      index: Number.isFinite(Number(item?.index)) ? Number(item.index) : idx,
      title: String(item?.title || `Chapter ${idx + 1}`),
      text: text || paragraphs.join("\n\n"),
      paragraphs,
      sourceType: String(item?.sourceType || rawBook?.format || "txt"),
      sourceRef: String(item?.sourceRef || ""),
      analysis:
        item?.analysis && typeof item.analysis === "object"
          ? {
              chapterId: String(item.analysis.chapterId || item.id || `ch-${idx + 1}`),
              sentences: Array.isArray(item.analysis.sentences) ? item.analysis.sentences : [],
              tokens: Array.isArray(item.analysis.tokens) ? item.analysis.tokens : [],
              jlptStats:
                item.analysis.jlptStats && typeof item.analysis.jlptStats === "object"
                  ? item.analysis.jlptStats
                  : {},
              difficultVocab: Array.isArray(item.analysis.difficultVocab)
                ? item.analysis.difficultVocab
                : [],
              analysisVersion: String(item.analysis.analysis_version || item.analysis.analysisVersion || ""),
              tokenizerVersion: String(item.analysis.tokenizer_version || item.analysis.tokenizerVersion || ""),
              jlptVersion: String(item.analysis.jlpt_version || item.analysis.jlptVersion || ""),
              dictVersion: String(item.analysis.dict_version || item.analysis.dictVersion || ""),
              promptVersion: String(item.analysis.prompt_version || item.analysis.promptVersion || ""),
            }
          : null,
    };
  });

  return {
    id: String(rawBook?.id || ""),
    userId: String(rawBook?.userId || ""),
    title: String(rawBook?.title || "Untitled"),
    format: String(rawBook?.format || "txt"),
    chapterCount: Number(rawBook?.chapterCount || chapters.length || 0),
    normalizedVersion: Number(rawBook?.normalizedVersion || 1),
    importedAt: Number(rawBook?.importedAt || 0),
    sourceFileName: String(rawBook?.sourceFileName || ""),
    sampleSlug: String(rawBook?.sampleSlug || ""),
    stats: rawBook?.stats && typeof rawBook.stats === "object" ? rawBook.stats : {},
    progress: rawBook?.progress && typeof rawBook.progress === "object" ? rawBook.progress : null,
    chapters,
  };
}

export function currentChapterData() {
  if (!state.book || !state.book.chapters.length) return null;
  return state.book.chapters[clampChapterIndex(state.currentChapter)];
}

export function getChapterById(chapterId) {
  if (!state.book || !state.book.chapters.length) return null;
  return state.book.chapters.find((chapter) => chapter.id === chapterId) || null;
}

export function chapterIndexById(chapterId) {
  if (!state.book || !state.book.chapters.length) return 0;
  const idx = state.book.chapters.findIndex((chapter) => chapter.id === chapterId);
  return idx >= 0 ? idx : 0;
}

export function clampChapterIndex(index) {
  if (!state.book || !state.book.chapters.length) return 0;
  return Math.max(0, Math.min(Number(index) || 0, state.book.chapters.length - 1));
}

export function sanitizeSyncUserId(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned;
}

export function normalizePlan(value) {
  return String(value || "").toLowerCase() === "pro" ? "pro" : "free";
}

export function normalizePayChannel(value) {
  const raw = String(value || "").toLowerCase();
  if (raw === "stripe") return "stripe";
  if (raw === "alipay") return "alipay";
  if (raw === "wechat") return "wechat";
  return "stripe";
}

export function normalizeBillingInterval(value) {
  return String(value || "").toLowerCase() === "yearly" ? "yearly" : "monthly";
}

export function normalizeBillingCycle(value) {
  const raw = String(value || "").toLowerCase();
  if (raw === "monthly") return "monthly";
  if (raw === "yearly") return "yearly";
  return "";
}

export function normalizeBilling(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const mergedFeatures = {
    ...DEFAULT_BILLING.features,
    ...(source.features && typeof source.features === "object" ? source.features : {}),
  };
  const mergedChannels = {
    ...DEFAULT_BILLING.paymentChannels,
    ...(source.paymentChannels && typeof source.paymentChannels === "object"
      ? source.paymentChannels
      : {}),
  };
  const mergedOfficialGateway = {
    ...DEFAULT_BILLING.officialGateway,
    ...(source.officialGateway && typeof source.officialGateway === "object"
      ? source.officialGateway
      : {}),
  };
  const sourceStripe = source.stripe && typeof source.stripe === "object" ? source.stripe : {};
  const mergedStripeIntervals = {
    ...DEFAULT_BILLING.stripe.intervals,
    ...(sourceStripe.intervals && typeof sourceStripe.intervals === "object"
      ? sourceStripe.intervals
      : {}),
  };
  const stripeCustomerId = String(source.stripeCustomerId || sourceStripe.customerId || "");
  const stripeSubscriptionId = String(
    source.stripeSubscriptionId || sourceStripe.subscriptionId || ""
  );
  return {
    userId: sanitizeSyncUserId(source.userId || state.sync?.userId || ""),
    entitlementPlan: normalizePlan(source.entitlementPlan || source.plan),
    plan: normalizePlan(source.plan),
    source: String(source.source || DEFAULT_BILLING.source),
    subscriptionStatus: String(source.subscriptionStatus || ""),
    billingCycle: normalizeBillingCycle(source.billingCycle || ""),
    lastPaidChannel: source.lastPaidChannel ? normalizePayChannel(source.lastPaidChannel) : "",
    lastOrderId: String(source.lastOrderId || ""),
    planExpireAt: Number(source.planExpireAt || 0),
    graceUntilAt: Number(source.graceUntilAt || 0),
    paymentFailedAt: Number(source.paymentFailedAt || 0),
    billingState: String(source.billingState || ""),
    accessState: String(source.accessState || "free"),
    accountMode: String(source.accountMode || "guest"),
    appBaseUrl: String(source.appBaseUrl || DEFAULT_BILLING.appBaseUrl || ""),
    features: {
      advancedImport: Boolean(mergedFeatures.advancedImport),
      cloudSync: Boolean(mergedFeatures.cloudSync),
      csvExportMaxRows: Math.max(1, Number(mergedFeatures.csvExportMaxRows) || 60),
      aiExplainDailyLimit: Number(mergedFeatures.aiExplainDailyLimit ?? 3),
    },
    paymentChannels: {
      stripe: Boolean(mergedChannels.stripe),
      wechat: Boolean(mergedChannels.wechat),
      alipay: Boolean(mergedChannels.alipay),
    },
    officialGateway: {
      stripe: Boolean(mergedOfficialGateway.stripe),
      wechat: Boolean(mergedOfficialGateway.wechat),
      alipay: Boolean(mergedOfficialGateway.alipay),
    },
    stripe: {
      checkoutReady:
        sourceStripe.checkoutReady === undefined
          ? DEFAULT_BILLING.stripe.checkoutReady
          : Boolean(sourceStripe.checkoutReady),
      portalReady:
        sourceStripe.portalReady === undefined
          ? DEFAULT_BILLING.stripe.portalReady
          : Boolean(sourceStripe.portalReady),
      paymentLinkReady:
        sourceStripe.paymentLinkReady === undefined
          ? DEFAULT_BILLING.stripe.paymentLinkReady
          : Boolean(sourceStripe.paymentLinkReady),
      paymentLink: String(sourceStripe.paymentLink || "").trim(),
      publishableKey: String(sourceStripe.publishableKey || DEFAULT_BILLING.stripe.publishableKey || ""),
      paymentMode: String(sourceStripe.paymentMode || DEFAULT_BILLING.stripe.paymentMode || "none"),
      intervals: {
        monthly: Boolean(mergedStripeIntervals.monthly),
        yearly: Boolean(mergedStripeIntervals.yearly),
      },
      defaultInterval: normalizeBillingInterval(
        sourceStripe.defaultInterval || (mergedStripeIntervals.monthly ? "monthly" : "yearly")
      ),
      customerId: stripeCustomerId,
      subscriptionId: stripeSubscriptionId,
    },
    manualPlanChangeEnabled: Boolean(source.manualPlanChangeEnabled),
    manualPaymentConfirmEnabled:
      source.manualPaymentConfirmEnabled === undefined
        ? DEFAULT_BILLING.manualPaymentConfirmEnabled
        : Boolean(source.manualPaymentConfirmEnabled),
    priceFen: Math.max(
      1,
      Number(source.priceFen || DEFAULT_BILLING.priceFen) || DEFAULT_BILLING.priceFen
    ),
    orderExpireMinutes: Math.max(
      5,
      Number(source.orderExpireMinutes || DEFAULT_BILLING.orderExpireMinutes) ||
        DEFAULT_BILLING.orderExpireMinutes
    ),
    aiExplainUsedToday: Math.max(0, Number(source.aiExplainUsedToday || 0)),
    aiExplainRemainingToday:
      Number(source.aiExplainRemainingToday) < 0
        ? -1
        : Math.max(0, Number(source.aiExplainRemainingToday || 0)),
    aiExplainCachedToday: Math.max(0, Number(source.aiExplainCachedToday || 0)),
    aiExplainLimitedToday: Math.max(0, Number(source.aiExplainLimitedToday || 0)),
    updatedAt: Number(source.updatedAt || 0),
  };
}

export function normalizeBillingOrder(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    orderId: String(source.orderId || ""),
    status: String(source.status || ""),
    channel: normalizePayChannel(source.channel || "wechat"),
    interval: normalizeBillingInterval(source.interval || "monthly"),
    sessionId: String(source.sessionId || ""),
    paymentMode: String(source.paymentMode || ""),
    payUrl: String(source.payUrl || ""),
    amountFen: Math.max(0, Number(source.amountFen || 0)),
    createdAt: Number(source.createdAt || 0),
    updatedAt: Number(source.updatedAt || 0),
    expiresAt: Number(source.expiresAt || 0),
    paidSource: String(source.paidSource || ""),
    externalTradeNo: String(source.externalTradeNo || ""),
    orderStatusPath: String(source.orderStatusPath || ""),
    verificationHint: String(source.verificationHint || ""),
    manualConfirmEnabled: Boolean(source.manualConfirmEnabled),
    paidAt: Number(source.paidAt || 0),
  };
}

export function hasFeature(featureName) {
  return Boolean(state.billing?.features?.[featureName]);
}
