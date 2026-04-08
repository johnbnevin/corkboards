/** Insert text at the current cursor position in a textarea, then restore focus. */
export function insertAtCursor(
  textarea: HTMLTextAreaElement,
  text: string,
  setContent: (updater: (prev: string) => string) => void,
) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  setContent((prev) => prev.slice(0, start) + text + prev.slice(end));
  // Restore cursor after React re-render
  requestAnimationFrame(() => {
    textarea.focus();
    const pos = start + text.length;
    textarea.selectionStart = pos;
    textarea.selectionEnd = pos;
  });
}

/** Validate that a URL is safe for use as media src (no XSS vectors). */
export function isValidMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
