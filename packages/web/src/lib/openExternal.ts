/**
 * Single sink for "send the user to an external web page".
 *
 * In a browser this is just a guarded `window.open`. Inside the Tauri desktop
 * shell it has to go through the host process instead: WebKitGTK returns null
 * from `window.open(url, '_blank')` and ignores `<a target="_blank">` unless the
 * host handles new-window requests, which is why every external link on Linux
 * desktop appeared to do nothing at all. Worse, an `<a href>` *without* a target
 * navigates the app's own webview away from the app, with no way back.
 *
 * Mirrors packages/mobile/src/lib/openExternal.ts. The rule on this codebase is
 * the same on every platform: no bare `window.open` / `Linking.openURL` for
 * anything derived from a note, a profile, or a relay.
 */
import { isSafeExternalUrl } from '@core/sanitizeUtils';
import { isTauri, tauriOpenExternal } from './tauri';

/**
 * Open `url` in the user's browser. Returns true when the open was attempted.
 *
 * Silently refuses anything that isn't http(s) — a blocked link should look
 * inert rather than pop an error whose text the note's author controls.
 */
export function openExternal(url: string | null | undefined): boolean {
  if (!isSafeExternalUrl(url)) {
    console.warn('[openExternal] refused non-http(s) URL:', url);
    return false;
  }
  const trimmed = url!.trim();
  if (isTauri) {
    // Fire-and-forget: the host validates again and logs its own refusal.
    void tauriOpenExternal(trimmed).then((ok) => {
      // Deliberately no window.open fallback — inside the webview it cannot
      // work, and retrying would only navigate the app away from itself.
      if (!ok) console.warn('[openExternal] desktop host refused:', trimmed);
    });
    return true;
  }
  window.open(trimmed, '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * Desktop only: catch clicks on ordinary `<a href="http…">` elements before the
 * webview can act on them and route them through the host opener instead.
 *
 * There are ~20 plain anchors across the app (settings, help links, profile
 * websites, markdown links). Rewriting each one would leave the next one added
 * broken, so this intercepts them all at the document root. Runs in the capture
 * phase so it still wins when a component calls `stopPropagation`, but it
 * respects `defaultPrevented` — a component that already handled the click
 * (e.g. the tracker-warning dialog) keeps ownership of it.
 *
 * Returns a cleanup function; a no-op outside Tauri.
 */
export function installDesktopLinkInterceptor(): () => void {
  if (!isTauri || typeof document === 'undefined') return () => {};

  const onClick = (e: MouseEvent) => {
    // Let modified clicks and non-primary buttons alone — the webview has no
    // useful behaviour for them either, but they're not "open this link".
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target as Element | null;
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    // `href` (the IDL attribute) is already resolved against the document, so a
    // relative in-app route reads as http://tauri.localhost/... — compare the
    // raw attribute instead so internal navigation is left to the router.
    const raw = anchor.getAttribute('href') ?? '';
    if (!isSafeExternalUrl(raw)) return;
    e.preventDefault();
    e.stopPropagation();
    openExternal(raw);
  };

  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
