/**
 * useRelayHealth — monitors relay health (latency, errors, status).
 *
 * Port of packages/web/src/hooks/useRelayHealth.ts for mobile.
 * Uses MMKV instead of IDB for user relay config access.
 */
import { useState, useEffect, useCallback } from 'react';
import { NRelay1 } from '@nostrify/nostrify';
import { FALLBACK_RELAYS, getRelayCache, getUserRelays } from '../lib/NostrProvider';
import { normalizeRelay } from '@core/normalizeRelay';
import { mobileStorage } from '../storage/MmkvStorage';

export interface RelayHealth {
  url: string;
  status: 'healthy' | 'slow' | 'error' | 'unknown';
  latency: number | null;
  lastCheck: number;
  errorCount: number;
}

const HEALTH_CHECK_INTERVAL = 120000;
const SLOW_THRESHOLD = 3000;
const ERROR_THRESHOLD = 3;

const relayHealthMap = new Map<string, RelayHealth>();
const listeners = new Set<() => void>();

function getShortName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function notifyListeners() {
  listeners.forEach(fn => fn());
}

export function getAllRelayHealth(): RelayHealth[] {
  return Array.from(relayHealthMap.values());
}

export function useRelayHealth() {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const fn = () => forceUpdate(n => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const activeRelays = useCallback(() => {
    const userRelays = getUserRelays();
    const all = new Set<string>();

    userRelays.read.forEach(r => all.add(normalizeRelay(r)));
    userRelays.write.forEach(r => all.add(normalizeRelay(r)));

    // Include logged-in user's NIP-65 relays
    try {
      const activePubkey = mobileStorage.getSync('corkboard:active-user-pubkey');
      if (activePubkey) {
        const nip65 = getRelayCache(activePubkey);
        nip65.forEach(r => all.add(normalizeRelay(r)));
      }
    } catch { /* ignore */ }

    FALLBACK_RELAYS.forEach(r => all.add(normalizeRelay(r)));

    return Array.from(all);
  }, []);

  const checkRelay = useCallback(async (url: string): Promise<RelayHealth> => {
    const existing = relayHealthMap.get(url);
    const relay = new NRelay1(url, { backoff: false });
    const start = Date.now();

    try {
      await relay.query([{ kinds: [1], limit: 1 }], {
        signal: AbortSignal.timeout(5000)
      });

      const latency = Date.now() - start;
      const status = latency > SLOW_THRESHOLD ? 'slow' : 'healthy';

      const health: RelayHealth = {
        url,
        status,
        latency,
        lastCheck: Date.now(),
        errorCount: 0,
      };

      relayHealthMap.set(url, health);
      notifyListeners();

      try { relay.close(); } catch { /* ignore */ }
      return health;
    } catch {
      const errorCount = (existing?.errorCount || 0) + 1;
      const health: RelayHealth = {
        url,
        status: errorCount >= ERROR_THRESHOLD ? 'error' : 'slow',
        latency: null,
        lastCheck: Date.now(),
        errorCount,
      };

      relayHealthMap.set(url, health);
      notifyListeners();

      try { relay.close(); } catch { /* ignore */ }
      return health;
    }
  }, []);

  const checkAllRelays = useCallback(async () => {
    const relays = activeRelays();
    for (let i = 0; i < relays.length; i += 3) { const batch = relays.slice(i, i + 3); await Promise.allSettled(batch.map(checkRelay)); }
  }, [activeRelays, checkRelay]);

  return {
    relayHealth: getAllRelayHealth(),
    checkRelay,
    checkAllRelays,
    activeRelays,
    getShortName,
  };
}

export function useRelayHealthAuto() {
  const { relayHealth, checkAllRelays, activeRelays, getShortName } = useRelayHealth();

  useEffect(() => {
    const relays = activeRelays();
    relays.forEach(url => {
      if (!relayHealthMap.has(url)) {
        relayHealthMap.set(url, {
          url,
          status: 'unknown',
          latency: null,
          lastCheck: 0,
          errorCount: 0,
        });
      }
    });
    notifyListeners();

    const timeout = setTimeout(checkAllRelays, 30000);
    return () => clearTimeout(timeout);
  }, [activeRelays, checkAllRelays]);

  useEffect(() => {
    const interval = setInterval(checkAllRelays, HEALTH_CHECK_INTERVAL);
    return () => clearInterval(interval);
  }, [checkAllRelays]);

  return { relayHealth, getShortName, checkAllRelays };
}
