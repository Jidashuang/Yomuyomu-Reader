export const DEFAULT_SYNC = {
  userId: "",
  accountMode: "guest",
  accountToken: "",
  anonymousId: "",
  registeredAt: 0,
  lastCloudSyncAt: 0,
  lastCloudSyncAction: "",
  lastCloudSyncStatus: "",
  lastCloudSyncMessage: "",
};

export function createAccountStore({ loadJSON, storageKeys }) {
  const sync = {
    ...DEFAULT_SYNC,
    ...loadJSON(storageKeys.sync, DEFAULT_SYNC),
  };

  const accountStore = {
    get userId() {
      return String(sync.userId || "");
    },
    get accountMode() {
      return String(sync.accountMode || "").toLowerCase() === "registered"
        ? "registered"
        : "guest";
    },
    get isRegistered() {
      return this.accountMode === "registered";
    },
    get hasToken() {
      return Boolean(String(sync.accountToken || "").trim());
    },
  };

  return { sync, accountStore };
}
