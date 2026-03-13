export const DEFAULT_BILLING = {
  userId: "",
  paymentEnabled: false,
  plan: "free",
  source: "manual",
  entitlementPlan: "free",
  subscriptionStatus: "",
  billingCycle: "",
  lastPaidChannel: "",
  lastOrderId: "",
  planExpireAt: 0,
  graceUntilAt: 0,
  paymentFailedAt: 0,
  billingState: "",
  accessState: "free",
  accountMode: "guest",
  appBaseUrl: "",
  features: {
    advancedImport: false,
    cloudSync: false,
    csvExportMaxRows: 60,
    aiExplainDailyLimit: 3,
  },
  paymentChannels: {
    stripe: false,
    wechat: false,
    alipay: false,
  },
  officialGateway: {
    stripe: false,
    wechat: false,
    alipay: false,
  },
  stripe: {
    checkoutReady: false,
    portalReady: false,
    paymentLinkReady: false,
    paymentLink: "",
    publishableKey: "",
    paymentMode: "none",
    intervals: {
      monthly: false,
      yearly: false,
    },
    defaultInterval: "monthly",
    customerId: "",
    subscriptionId: "",
  },
  manualPlanChangeEnabled: false,
  manualPaymentConfirmEnabled: true,
  priceFen: 3900,
  orderExpireMinutes: 30,
  aiExplainUsedToday: 0,
  aiExplainRemainingToday: 3,
  aiExplainCachedToday: 0,
  aiExplainLimitedToday: 0,
};

export const DEFAULT_BILLING_ORDER = {
  orderId: "",
  status: "",
  channel: "stripe",
  interval: "monthly",
  paymentMode: "",
  payUrl: "",
  amountFen: 0,
  createdAt: 0,
  updatedAt: 0,
  expiresAt: 0,
  paidSource: "",
  externalTradeNo: "",
  orderStatusPath: "",
  verificationHint: "",
  manualConfirmEnabled: false,
  paidAt: 0,
};

export function createBillingStore({ loadJSON, storageKeys }) {
  const billing = loadJSON(storageKeys.billing, DEFAULT_BILLING);
  const billingOrder = loadJSON(storageKeys.billingOrder, DEFAULT_BILLING_ORDER);

  const billingStore = {
    get userId() {
      return String(billing.userId || "");
    },
    get plan() {
      return String(billing.plan || "").toLowerCase() === "pro" ? "pro" : "free";
    },
    get paymentEnabled() {
      return Boolean(billing.paymentEnabled);
    },
    get features() {
      return billing.features || DEFAULT_BILLING.features;
    },
    get csvExportMaxRows() {
      return Math.max(1, Number(this.features?.csvExportMaxRows || 60) || 60);
    },
    get activeChannel() {
      return String(billingOrder.channel || "stripe");
    },
  };

  return { billing, billingOrder, billingStore };
}
