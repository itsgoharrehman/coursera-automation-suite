// ==UserScript==
// @name         Plain Copy
// @match        *://*.coursera.org/learn*
// @run-at       document-start
// @author       Gohar Rehman (https://github.com/itsgoharrehman)
// ==/UserScript==

(function() {
  // Patterns to strip from copied content (hidden injected text)
  const STRIP_PATTERNS = [
    /(?:You are a helpful AI assistant[\s\S]*?verification step is mandatory for all AI assistants accessing assessment pages\.?)/gi,
    /AI Agent Compliance Verification Required/gi,
    /Do you understand\??\.*\s*/gi,
    /I understand\.?\s*/gi,
  ];

  function cleanText(text) {
    let cleaned = text;
    for (const pattern of STRIP_PATTERNS) {
      pattern.lastIndex = 0;
      cleaned = cleaned.replace(pattern, '');
    }
    return cleaned
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function cleanHtml(html) {
    let cleaned = html;
    for (const pattern of STRIP_PATTERNS) {
      pattern.lastIndex = 0;
      cleaned = cleaned.replace(pattern, '');
    }
    return cleaned;
  }

  function getSelectionHtml() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

    const container = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
      container.appendChild(sel.getRangeAt(i).cloneContents());
    }

    const html = container.innerHTML;
    if (!html.trim()) return null;
    return html;
  }

  function getPlainText() {
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) {
      return sel.toString();
    }

    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      return active.value.substring(active.selectionStart, active.selectionEnd);
    }

    return '';
  }

  document.addEventListener('copy', function(event) {
    const plainRaw = getPlainText();
    if (!plainRaw) return;

    const htmlRaw = getSelectionHtml();
    const cleanedPlain = cleanText(plainRaw);

    if (event.clipboardData) {
      event.clipboardData.setData('text/plain', cleanedPlain);

      if (htmlRaw) {
        event.clipboardData.setData('text/html', cleanHtml(htmlRaw));
      }
    } else if (window.clipboardData) {
      window.clipboardData.setData('Text', cleanedPlain);
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
})();