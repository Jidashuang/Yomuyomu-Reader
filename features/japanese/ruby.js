function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function katakanaToHiragana(value) {
  return String(value || "").replace(/[ァ-ヶ]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60)
  );
}

export function hiraganaToKatakana(value) {
  return String(value || "").replace(/[ぁ-ゖ]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 0x60)
  );
}

export function createRubyHtml(surface, reading) {
  const word = String(surface || "").trim();
  const yomi = String(reading || "").trim();
  if (!word || !yomi) return escapeHtml(word || yomi);
  return `<ruby>${escapeHtml(word)}<rt>${escapeHtml(yomi)}</rt></ruby>`;
}

export function createRubyElement(surface, reading, doc = document) {
  const ruby = doc.createElement("ruby");
  ruby.textContent = String(surface || "").trim();
  const rt = doc.createElement("rt");
  rt.textContent = String(reading || "").trim();
  ruby.appendChild(rt);
  return ruby;
}

export function applyRubyMap(text, rubyMap = []) {
  let output = String(text || "");
  rubyMap.forEach((item) => {
    const surface = String(item?.surface || item?.word || "").trim();
    const reading = String(item?.reading || "").trim();
    if (!surface || !reading) return;
    output = output.replace(surface, createRubyHtml(surface, reading));
  });
  return output;
}

const ruby = {
  applyRubyMap,
  createRubyElement,
  createRubyHtml,
  hiraganaToKatakana,
  katakanaToHiragana,
};

export default ruby;
