export const DEFAULT_SETTINGS = {
  fontSize: 21,
  lineHeight: 1.9,
  theme: "light",
  contentWidth: "comfortable",
  readerFont: "mincho",
  readingMode: "scroll",
  focusMode: false,
  rightPanelTab: "vocab",
  furiganaMode: "auto",
  dictionaryDisplay: "inline",
  translationDisplay: "inline",
  ttsRate: 1,
  ttsVoice: "",
  difficultyMode: "n1n2n3",
  mojiScheme: "jp",
  autoPageSeconds: 12,
};

export function createSettingsStore({ loadJSON, storageKeys }) {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...loadJSON(storageKeys.settings, {}),
  };

  const settingsStore = {
    get fontSize() {
      return Number(settings.fontSize) || DEFAULT_SETTINGS.fontSize;
    },
    get lineHeight() {
      return Number(settings.lineHeight) || DEFAULT_SETTINGS.lineHeight;
    },
    get theme() {
      return String(settings.theme || DEFAULT_SETTINGS.theme);
    },
    get readerFont() {
      return String(settings.readerFont || DEFAULT_SETTINGS.readerFont);
    },
    get readingMode() {
      return String(settings.readingMode || DEFAULT_SETTINGS.readingMode);
    },
    get focusMode() {
      return Boolean(settings.focusMode);
    },
    get rightPanelTab() {
      return String(settings.rightPanelTab || DEFAULT_SETTINGS.rightPanelTab);
    },
    get furiganaMode() {
      return String(settings.furiganaMode || DEFAULT_SETTINGS.furiganaMode);
    },
    get dictionaryDisplay() {
      return String(settings.dictionaryDisplay || DEFAULT_SETTINGS.dictionaryDisplay);
    },
    get translationDisplay() {
      return String(settings.translationDisplay || DEFAULT_SETTINGS.translationDisplay);
    },
    get difficultyMode() {
      return String(settings.difficultyMode || DEFAULT_SETTINGS.difficultyMode);
    },
    get mojiScheme() {
      return String(settings.mojiScheme || DEFAULT_SETTINGS.mojiScheme);
    },
    get autoPageSeconds() {
      return Number(settings.autoPageSeconds) || DEFAULT_SETTINGS.autoPageSeconds;
    },
    get ttsRate() {
      return Number(settings.ttsRate) || DEFAULT_SETTINGS.ttsRate;
    },
    get ttsVoice() {
      return String(settings.ttsVoice || DEFAULT_SETTINGS.ttsVoice);
    },
    get tts() {
      return {
        rate: Number(settings.ttsRate) || DEFAULT_SETTINGS.ttsRate,
        voice: String(settings.ttsVoice || ""),
      };
    },
    get values() {
      return settings;
    },
    set(key, value) {
      settings[key] = value;
      return settings;
    },
    update(partial = {}) {
      Object.assign(settings, partial || {});
      return settings;
    },
  };

  return { settings, settingsStore };
}
