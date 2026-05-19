/**
 * useScrollPersistence — preserves scroll position per tab across:
 *   - Tab switches (saves on leave, restores on enter)
 *   - Page reloads (sessionStorage)
 *   - Tab-backgrounded → returns (visibilitychange)
 *
 * Extracted from MultiColumnClient.tsx to reduce file size and make the
 * scroll-restoration retry logic testable in isolation. The retry windows
 * exist because mobile browsers can evict a backgrounded page; when it
 * reloads, feed content arrives async from relays and isn't tall enough
 * for `scrollTo` to take effect immediately.
 */
import { useEffect, useRef, useCallback } from 'react';

export interface UseScrollPersistenceOptions {
  activeTab: string;
  /** Called with current window.scrollY > 0; useful for "back to top" affordances. */
  onScrolledFromTopChange?: (isScrolled: boolean) => void;
}

export interface UseScrollPersistenceResult {
  /** Saves the scroll position for the *previous* tab and restores for the new one. */
  onTabChange: (nextTab: string) => void;
  /** A ref pointing to the active-tab key used by save() — kept in sync internally. */
  activeTabRef: React.MutableRefObject<string>;
  /** The Map<tab, scrollY> — exposed so callers can read it for diagnostics. */
  scrollPositions: React.MutableRefObject<Map<string, number>>;
}

const STORAGE_KEY = 'corkboard:scroll-positions';
const SAVE_DEBOUNCE_MS = 1000;
const RAF_RETRY_LIMIT = 8;
const POLL_INTERVAL_MS = 200;
const POLL_GIVE_UP_MS = 5000;
const VISIBILITY_NUDGE_THRESHOLD = 50;
const TAB_SWITCH_RAF_RETRIES = 5;

export function useScrollPersistence({
  activeTab,
  onScrolledFromTopChange,
}: UseScrollPersistenceOptions): UseScrollPersistenceResult {
  // Initialize from sessionStorage once
  const scrollPositions = useRef<Map<string, number>>((() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      return saved ? new Map<string, number>(JSON.parse(saved)) : new Map();
    } catch { return new Map(); }
  })());

  const activeTabRef = useRef(activeTab);

  // Debounced persistence to sessionStorage
  const persistTimer = useRef<ReturnType<typeof setTimeout>>();
  const schedulePersist = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      try {
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(Array.from(scrollPositions.current.entries())),
        );
      } catch { /* sessionStorage may be unavailable */ }
    }, SAVE_DEBOUNCE_MS);
  }, []);

  // Track scroll for the current tab + persist debounced
  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        scrollPositions.current.set(activeTab, window.scrollY);
        schedulePersist();
        if (onScrolledFromTopChange) {
          onScrolledFromTopChange(window.scrollY > 0);
        }
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [activeTab, schedulePersist, onScrolledFromTopChange]);

  // Initial mount: restore scroll for current tab.
  // Phase 1: rAF burst (fast restore when DOM is already tall enough).
  // Phase 2: slow poll for content-dependent restores after mobile bg eviction.
  useEffect(() => {
    const savedPos = scrollPositions.current.get(activeTabRef.current) ?? 0;
    if (savedPos <= 0) return;
    let cancelled = false;
    let rafCount = 0;
    const tryRAF = () => {
      if (cancelled) return;
      window.scrollTo(0, savedPos);
      rafCount++;
      if (Math.abs(window.scrollY - savedPos) < 20) return;
      if (rafCount < RAF_RETRY_LIMIT) requestAnimationFrame(tryRAF);
    };
    requestAnimationFrame(tryRAF);
    const pollTimer = setInterval(() => {
      if (cancelled) return;
      if (document.body.scrollHeight >= savedPos + window.innerHeight * 0.5) {
        window.scrollTo(0, savedPos);
        clearInterval(pollTimer);
      }
    }, POLL_INTERVAL_MS);
    const giveUp = setTimeout(() => clearInterval(pollTimer), POLL_GIVE_UP_MS);
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearTimeout(giveUp);
    };
  // mount-only
  }, []);

  // Re-nudge scroll on visibility-return (browser may have re-rendered)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const savedPos = scrollPositions.current.get(activeTabRef.current) ?? 0;
      if (savedPos > 0 && Math.abs(window.scrollY - savedPos) > VISIBILITY_NUDGE_THRESHOLD) {
        requestAnimationFrame(() => window.scrollTo(0, savedPos));
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Cleanup pending persist timer on unmount
  useEffect(() => () => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
  }, []);

  const onTabChange = useCallback((nextTab: string) => {
    // Save the leaving tab's current scroll
    scrollPositions.current.set(activeTabRef.current, window.scrollY);
    activeTabRef.current = nextTab;
    // Restore target tab's position with rAF retries (content may still be rendering)
    const savedPos = scrollPositions.current.get(nextTab) ?? 0;
    let attempts = 0;
    const tryRestore = () => {
      window.scrollTo(0, savedPos);
      attempts++;
      if (attempts < TAB_SWITCH_RAF_RETRIES) requestAnimationFrame(tryRestore);
    };
    requestAnimationFrame(tryRestore);
  }, []);

  return { onTabChange, activeTabRef, scrollPositions };
}
