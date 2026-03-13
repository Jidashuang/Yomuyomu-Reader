function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
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

export function normalizeBook(rawBook) {
  const source = isObject(rawBook) ? rawBook : {};
  const chaptersRaw = Array.isArray(source.chapters) ? source.chapters : [];
  const chapters = chaptersRaw.map((item, idx) => {
    const chapter = isObject(item) ? item : {};
    const paragraphsSource = Array.isArray(chapter.paragraphs) ? chapter.paragraphs : null;
    const text = String(chapter.text || "").replace(/\r/g, "").trim();
    const paragraphs = (paragraphsSource || (text ? text.split(/\n+/) : []))
      .map((line) => String(line || "").trim())
      .filter(Boolean);
    const analysis = isObject(chapter.analysis) ? chapter.analysis : null;

    return {
      id: String(chapter.id || `ch-${idx + 1}`),
      index: Number.isFinite(Number(chapter.index)) ? Number(chapter.index) : idx,
      title: String(chapter.title || `Chapter ${idx + 1}`),
      text: text || paragraphs.join("\n\n"),
      paragraphs,
      sourceType: String(chapter.sourceType || source.format || "txt"),
      sourceRef: String(chapter.sourceRef || ""),
      analysis: analysis
        ? {
            chapterId: String(analysis.chapterId || chapter.id || `ch-${idx + 1}`),
            sentences: Array.isArray(analysis.sentences) ? analysis.sentences : [],
            tokens: Array.isArray(analysis.tokens) ? analysis.tokens : [],
            jlptStats: isObject(analysis.jlptStats) ? analysis.jlptStats : {},
            difficultVocab: Array.isArray(analysis.difficultVocab) ? analysis.difficultVocab : [],
            analysisVersion: String(analysis.analysis_version || analysis.analysisVersion || ""),
            tokenizerVersion: String(analysis.tokenizer_version || analysis.tokenizerVersion || ""),
            jlptVersion: String(analysis.jlpt_version || analysis.jlptVersion || ""),
            dictVersion: String(analysis.dict_version || analysis.dictVersion || ""),
            promptVersion: String(analysis.prompt_version || analysis.promptVersion || ""),
          }
        : null,
    };
  });

  return {
    id: String(source.id || ""),
    userId: String(source.userId || ""),
    title: String(source.title || "Untitled"),
    author: String(source.author || source.meta?.author || source.metadata?.author || ""),
    format: String(source.format || "txt"),
    chapterCount: Number(source.chapterCount || chapters.length || 0),
    normalizedVersion: Number(source.normalizedVersion || 1),
    importedAt: Number(source.importedAt || 0),
    sourceFileName: String(source.sourceFileName || ""),
    sampleSlug: String(source.sampleSlug || ""),
    stats: isObject(source.stats) ? source.stats : {},
    progress: isObject(source.progress) ? source.progress : null,
    chapters,
  };
}

export function normalizeUser(rawUser, fallback = {}) {
  const source = isObject(rawUser) ? rawUser : {};
  const backup = isObject(fallback) ? fallback : {};
  const accountMode = String(source.accountMode || backup.accountMode || "guest").toLowerCase();
  return {
    userId: sanitizeSyncUserId(source.userId || backup.userId || ""),
    anonymousId: sanitizeSyncUserId(source.anonymousId || backup.anonymousId || ""),
    accountMode: accountMode === "registered" ? "registered" : "guest",
    accountToken: String(source.accountToken || backup.accountToken || "").trim(),
    registeredAt: Number(source.registeredAt || backup.registeredAt || 0),
  };
}

export function normalizeBilling(raw, options = {}) {
  const source = isObject(raw) ? raw : {};
  const defaultBilling = isObject(options.defaultBilling) ? options.defaultBilling : {};
  const defaultFeatures = isObject(defaultBilling.features) ? defaultBilling.features : {};
  const defaultChannels = isObject(defaultBilling.paymentChannels)
    ? defaultBilling.paymentChannels
    : {};
  const defaultOfficialGateway = isObject(defaultBilling.officialGateway)
    ? defaultBilling.officialGateway
    : {};
  const defaultStripe = isObject(defaultBilling.stripe) ? defaultBilling.stripe : {};
  const defaultStripeIntervals = isObject(defaultStripe.intervals) ? defaultStripe.intervals : {};

  const mergedFeatures = {
    ...defaultFeatures,
    ...(isObject(source.features) ? source.features : {}),
  };
  const mergedChannels = {
    ...defaultChannels,
    ...(isObject(source.paymentChannels) ? source.paymentChannels : {}),
  };
  const mergedOfficialGateway = {
    ...defaultOfficialGateway,
    ...(isObject(source.officialGateway) ? source.officialGateway : {}),
  };

  const sourceStripe = isObject(source.stripe) ? source.stripe : {};
  const mergedStripeIntervals = {
    ...defaultStripeIntervals,
    ...(isObject(sourceStripe.intervals) ? sourceStripe.intervals : {}),
  };

  const fallbackUserId = sanitizeSyncUserId(options.syncUserId || "");
  const userId = sanitizeSyncUserId(source.userId || fallbackUserId);
  const stripeCustomerId = String(source.stripeCustomerId || sourceStripe.customerId || "");
  const stripeSubscriptionId = String(
    source.stripeSubscriptionId || sourceStripe.subscriptionId || ""
  );

  return {
    userId,
    paymentEnabled:
      source.paymentEnabled === undefined
        ? Boolean(defaultBilling.paymentEnabled)
        : Boolean(source.paymentEnabled),
    entitlementPlan: normalizePlan(source.entitlementPlan || source.plan),
    plan: normalizePlan(source.plan),
    source: String(source.source || defaultBilling.source || "manual"),
    subscriptionStatus: String(source.subscriptionStatus || ""),
    billingCycle: normalizeBillingCycle(source.billingCycle || sourceStripe.billingCycle),
    lastPaidChannel: source.lastPaidChannel ? normalizePayChannel(source.lastPaidChannel) : "",
    lastOrderId: String(source.lastOrderId || ""),
    planExpireAt: Number(source.planExpireAt || 0),
    graceUntilAt: Number(source.graceUntilAt || 0),
    paymentFailedAt: Number(source.paymentFailedAt || 0),
    billingState: String(source.billingState || ""),
    accessState: String(source.accessState || "free"),
    accountMode: String(source.accountMode || "guest"),
    appBaseUrl: String(source.appBaseUrl || defaultBilling.appBaseUrl || ""),
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
          ? Boolean(defaultStripe.checkoutReady)
          : Boolean(sourceStripe.checkoutReady),
      portalReady:
        sourceStripe.portalReady === undefined
          ? Boolean(defaultStripe.portalReady)
          : Boolean(sourceStripe.portalReady),
      paymentLinkReady:
        sourceStripe.paymentLinkReady === undefined
          ? Boolean(defaultStripe.paymentLinkReady)
          : Boolean(sourceStripe.paymentLinkReady),
      paymentLink: String(sourceStripe.paymentLink || "").trim(),
      publishableKey: String(sourceStripe.publishableKey || defaultStripe.publishableKey || "").trim(),
      paymentMode: String(sourceStripe.paymentMode || defaultStripe.paymentMode || "none"),
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
        ? Boolean(defaultBilling.manualPaymentConfirmEnabled)
        : Boolean(source.manualPaymentConfirmEnabled),
    priceFen: Math.max(
      1,
      Number(source.priceFen || defaultBilling.priceFen || 3900) || Number(defaultBilling.priceFen) || 3900
    ),
    orderExpireMinutes: Math.max(
      5,
      Number(source.orderExpireMinutes || defaultBilling.orderExpireMinutes || 30) ||
        Number(defaultBilling.orderExpireMinutes) ||
        30
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

export function normalizeBillingOrder(raw, options = {}) {
  const source = isObject(raw) ? raw : {};
  const defaultChannel = normalizePayChannel(options.defaultChannel || "stripe");
  const defaultInterval = normalizeBillingInterval(options.defaultInterval || "monthly");

  return {
    orderId: String(source.orderId || ""),
    status: String(source.status || ""),
    channel: normalizePayChannel(source.channel || defaultChannel),
    interval: normalizeBillingInterval(source.interval || defaultInterval),
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
