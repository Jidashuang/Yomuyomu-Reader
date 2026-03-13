let activeUtterance = null;

export function isSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function listVoices() {
  if (!isSupported()) return [];
  return window.speechSynthesis.getVoices();
}

export function stop() {
  if (!isSupported()) return;
  window.speechSynthesis.cancel();
  activeUtterance = null;
}

export function speak(text, options = {}) {
  if (!isSupported()) {
    throw new Error("TTS is not supported in this browser.");
  }

  stop();

  const utterance = new SpeechSynthesisUtterance(String(text || ""));
  utterance.lang = options.lang || "ja-JP";
  utterance.rate = Number(options.rate || 1);

  if (options.voiceName) {
    const voice = listVoices().find((item) => item.name === options.voiceName);
    if (voice) utterance.voice = voice;
  }

  if (typeof options.onStart === "function") {
    utterance.onstart = () => options.onStart();
  }
  if (typeof options.onEnd === "function") {
    utterance.onend = () => options.onEnd();
  }
  if (typeof options.onError === "function") {
    utterance.onerror = (event) => options.onError(event);
  }

  activeUtterance = utterance;
  window.speechSynthesis.speak(utterance);
  return utterance;
}

const ttsService = {
  isSupported,
  listVoices,
  speak,
  stop,
};

export default ttsService;
