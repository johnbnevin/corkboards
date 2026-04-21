import { createRoot } from 'react-dom/client';

// Import polyfills first
import './lib/polyfills.ts';

import { isTauri, tauriLog, clearTauriLog } from '@/lib/tauri';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import App from './App.tsx';
import './index.css';

// When running inside Tauri, redirect console output to a log file so we can
// diagnose production issues without a devtools window.
if (isTauri) {
  clearTauriLog();

  const fmt = (args: unknown[]): string => {
    const ts = new Date().toISOString();
    const msg = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    return `${ts} ${msg}`;
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

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

// Register service worker for offline app shell caching (prevents reload on mobile background return)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
