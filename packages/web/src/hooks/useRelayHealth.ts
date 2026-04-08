import { useState, useEffect, useCallback } from 'react';
import { NRelay1 } from '@nostrify/nostrify';
import { FALLBACK_RELAYS, getRelayCache } from '@/components/NostrProvider';
import { idbGetSync } from '@/lib/idb';
import { normalizeRelay } from '@/lib/normalizeRelay';

export interface RelayHealth {
  url: string;
  status: 'healthy' | 'slow' | 'error' | 'unknown';
  latency: number | null;
  lastCheck: number;
  errorCount: number;
}

const HEALTH_CHECK_INTERVAL = 60000;
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

// Get user's configured relays directly from IDB
function getUserRelaysFromIdb(): { read: string[]; write: string[] } {
  try {
    const stored = idbGetSync('corkboard:app-config');
    if (stored) {
      const config = JSON.parse(stored);
      const relays = config?.relayMetadata?.relays || [];
      const isSecure = (url: string) => url.startsWith('wss://');
      return {
        read: relays.filter((r: { read: boolean; url: string }) => r.read).map((r: { url: string }) => r.url).filter(isSecure),
        write: relays.filter((r: { write: boolean; url: string }) => r.write).map((r: { url: string }) => r.url).filter(isSecure),
      };
    }
  } catch {
    // Ignore parse errors
  }
  return { read: [], write: [] };
}

export function useRelayHealth() {
  const [, forceUpdate] = useState(0);
  
  useEffect(() => {
    const fn = () => forceUpdate(n => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const activeRelays = useCallback(() => {
    const userRelays = getUserRelaysFromIdb();
    const all = new Set<string>();

    userRelays.read.forEach(r => all.add(normalizeRelay(r)));
    userRelays.write.forEach(r => all.add(normalizeRelay(r)));

    // Include logged-in user's NIP-65 relays
    const activePubkey = idbGetSync('corkboard:active-user-pubkey');
    if (activePubkey) {
      const nip65 = getRelayCache(activePubkey);
      nip65.forEach(r => all.add(normalizeRelay(r)));
    }

    // Always include fallback relays for health monitoring
    FALLBACK_RELAYS.forEach(r => all.add(normalizeRelay(r)));

    return Array.from(all);
  }, []);

  const checkRelay = useCallback(async (url: string): Promise<RelayHealth> => {
    const existing = relayHealthMap.get(url);
    const relay = new NRelay1(url);
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
      
      try { relay.close(); } catch { /* ignore cleanup errors */ }
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
      
      try { relay.close(); } catch { /* ignore cleanup errors */ }
      return health;
    }
  }, []);

  const checkAllRelays = useCallback(async () => {
    const relays = activeRelays();
    await Promise.all(relays.map(checkRelay));
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
    // Always populate relay list first
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
    
    // Delay the first health check to let feeds load first (feeds exercise the relays)
    const timeout = setTimeout(checkAllRelays, 10000);
    return () => clearTimeout(timeout);
  }, [activeRelays, checkAllRelays]);

  useEffect(() => {
    const interval = setInterval(checkAllRelays, HEALTH_CHECK_INTERVAL);
    return () => clearInterval(interval);
  }, [checkAllRelays]);

  return { relayHealth, getShortName, checkAllRelays };
}
