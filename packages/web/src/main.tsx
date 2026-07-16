import { createRoot } from 'react-dom/client';

// Import polyfills first
import './lib/polyfills.ts';

import { isTauri, tauriLog, clearTauriLog } from '@/lib/tauri';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { setImageProxyTemplate } from '@core/imageProxy';
import { IMAGE_PROXY_TEMPLATE_KEY } from '@/lib/imageProxySettings';
import App from './App.tsx';
import './index.css';

// ── DOM-mutation guard ────────────────────────────────────────────────────────
// React cannot recover from "Failed to execute 'removeChild'/'insertBefore' on
// 'Node'" — when a DOM node is mutated out from under it (browser translation
// extensions, signer-extension injection, or a portal teardown race), the throw
// propagates to the top-level ErrorBoundary and unmounts the entire app, leaving
// the UI frozen. This guard makes those operations no-op safely when the node
// isn't actually a child, instead of throwing. Normal removals/insertions are
// unaffected. (Well-known React workaround; see facebook/react#11538.)
function installDomMutationGuard(): void {
  if (typeof Node !== 'function' || !Node.prototype) return;

  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) {
      if (import.meta.env.DEV) console.warn('[dom-guard] removeChild: node is not a child of this node — ignoring');
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
    if (ref && ref.parentNode !== this) {
      if (import.meta.env.DEV) console.warn('[dom-guard] insertBefore: reference is not a child of this node — appending');
      return originalInsertBefore.call(this, node, null) as T;
    }
    return originalInsertBefore.call(this, node, ref) as T;
  };
}
installDomMutationGuard();

// Initialize the image-proxy template before any image renders so the very
// first paint already routes through the user's chosen proxy (if set).
try {
  setImageProxyTemplate(localStorage.getItem(IMAGE_PROXY_TEMPLATE_KEY));
} catch {
  /* localStorage unavailable — proxy stays disabled */
}

// When running inside Tauri, redirect console output to a log file so we can
// diagnose production issues without a devtools window.
if (isTauri && !('__tauriConsoleOverride' in window)) {
  (window as unknown as Record<string, unknown>).__tauriConsoleOverride = true;
  clearTauriLog();

  // Defense-in-depth: tauriLog persists to a plaintext file on disk, so scrub
  // any secret that a stray log statement might carry before it lands there.
  // We redact only unambiguous secrets — nsec/ncryptsec keys and `secret=`
  // params — NOT bare 64-hex, since pubkeys and event ids are also 64-hex and
  // public; blanket-redacting them would make the logs useless.
  const SECRET_PATTERNS: Array<[RegExp, string]> = [
    [/nsec1[0-9a-z]{20,}/gi, 'nsec1[REDACTED]'],
    [/ncryptsec1[0-9a-z]{20,}/gi, 'ncryptsec1[REDACTED]'],
    [/(secret=)[^&\s"']+/gi, '$1[REDACTED]'],
  ];
  const redactSecrets = (s: string): string => {
    let out = s;
    for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
    return out;
  };

  const fmt = (args: unknown[]): string => {
    const ts = new Date().toISOString();
    const msg = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    return redactSecrets(`${ts} ${msg}`);
  };

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    tauriLog(`[LOG] ${fmt(args)}`);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    tauriLog(`[WARN] ${fmt(args)}`);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    tauriLog(`[ERR] ${fmt(args)}`);
  };

  tauriLog(`[LOG] Corkboards starting — isTauri=true ua=${navigator.userAgent}`);
}

// ── Broken-bundle self-heal ───────────────────────────────────────────────────
// If an app JS/CSS chunk fails to load (e.g. a stale cached vendor chunk left by
// an older cache-first service worker that no longer matches the entry), the app
// boots blank and a plain refresh can't recover — the SW keeps serving the stale
// bundle. Catch that once per session, drop the SW + all caches, and reload for a
// clean fetch, so a user never has to manually clear site data.
window.addEventListener('error', (event) => {
  const target = event.target as (HTMLScriptElement & HTMLLinkElement) | null;
  if (!target || (target.tagName !== 'SCRIPT' && target.tagName !== 'LINK')) return;
  const href = target.src || target.href || '';
  if (!href.includes('/assets/')) return;
  try {
    if (sessionStorage.getItem('corkboard:bundle-recovery')) return;
    sessionStorage.setItem('corkboard:bundle-recovery', '1');
  } catch { /* sessionStorage unavailable */ }
  void (async () => {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch { /* best-effort */ }
    window.location.reload();
  })();
}, true); // capture — resource-load errors don't bubble

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

// Register service worker for offline app shell caching (prevents reload on mobile background return)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // When a new SW takes control (e.g. after a deploy bumped CACHE_NAME), reload
  // ONCE so the fresh app shell — including the up-to-date CSP in index.html —
  // is served instead of the stale cached one. sessionStorage-guarded so this
  // can never become a reload loop.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    try {
      if (sessionStorage.getItem('corkboard:sw-reloaded')) return;
      sessionStorage.setItem('corkboard:sw-reloaded', '1');
    } catch { /* sessionStorage unavailable — fall through to a single reload */ }
    window.location.reload();
  });
}
