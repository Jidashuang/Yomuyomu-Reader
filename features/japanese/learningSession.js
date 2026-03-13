function now() {
  return Date.now();
}

export function createLearningSession(initialState = {}) {
  let state = {
    sessionId: String(initialState.sessionId || `session-${now()}`),
    currentWord: null,
    currentSentence: null,
    updatedAt: now(),
  };

  const subscribers = new Set();

  function notify() {
    subscribers.forEach((listener) => {
      try {
        listener({ ...state });
      } catch {
        // Ignore subscriber errors.
      }
    });
  }

  function setPartial(next) {
    state = {
      ...state,
      ...next,
      updatedAt: now(),
    };
    notify();
    return { ...state };
  }

  return {
    getState() {
      return { ...state };
    },
    start(sessionId = "") {
      return setPartial({
        sessionId: String(sessionId || `session-${now()}`),
        currentWord: null,
        currentSentence: null,
      });
    },
    setCurrentWord(word) {
      return setPartial({ currentWord: word || null });
    },
    setCurrentSentence(sentence) {
      return setPartial({ currentSentence: sentence || null });
    },
    clearSelection() {
      return setPartial({ currentWord: null, currentSentence: null });
    },
    subscribe(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      subscribers.add(listener);
      listener({ ...state });
      return () => subscribers.delete(listener);
    },
  };
}

const defaultLearningSession = createLearningSession();

export default defaultLearningSession;
