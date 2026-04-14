/**
 * useNostrBackup — encrypted cloud backup and restore for mobile.
 *
 * Port of packages/web/src/hooks/useNostrBackup.ts.
 * Platform differences:
 *   - Uses MMKV (synchronous) instead of IndexedDB
 *   - Blossom upload via fetch PUT (no File/Blob Web API)
 *   - No auto-save or change-detection (manual backup only)
 *
 * Architecture (identical to web):
 *   1. Serialize BACKED_UP_KEYS from MMKV → JSON
 *   2. AES-256-GCM encrypt with random key
 *   3. Upload encrypted blob to Blossom server (kind 24242 auth)
 *   4. Publish NIP-78 kind 30078 manifest with Blossom URL + wrapped AES key
 *   5. Restore: find manifest → unwrap AES key → download + decrypt → write to MMKV
 */
import { useState, useCallback, useRef } from 'react';
import { NRelay1 } from '@nostrify/nostrify';
import type { NostrEvent } from '@nostrify/nostrify';
import type { NSecSigner } from '@nostrify/nostrify';
import { mobileStorage } from '../storage/MmkvStorage';
import { BACKED_UP_KEYS, STORAGE_KEYS } from '../lib/storageKeys';
import { FALLBACK_RELAYS, APP_CONFIG_KEY, getUserRelays, getRelayCache } from '../lib/NostrProvider';
import {
  generateAesKey, importAesKey,
  aesEncrypt, aesDecrypt, rawKeyToHex, hexToRawKey,
} from '../lib/nostrEncrypt';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { normalizeRelay } from '@core/normalizeRelay';

export type BackupStatus =
  | 'idle'
  | 'encrypting'
  | 'saving'
  | 'saved'
  | 'save-error'
  | 'checking'
  | 'found'
  | 'no-backup'
  | 'restoring'
  | 'restored'
  | 'restore-error';

export interface RemoteCheckpoint {
  eventId: string;
  dTag: string;
  timestamp: number;
  blossomUrl: string;
  blossomHash?: string;
  wrappedKey: string;
  signerMethod: 'nip44' | 'nip04';
  stats?: { corkboards: number; savedForLater: number; dismissed: number };
}

const D_TAG_PREFIX = 'corkboard:backup';
const LAST_BACKUP_TS_KEY = STORAGE_KEYS.LAST_BACKUP_TS;
const CHECKPOINTS_KEY = STORAGE_KEYS.REMOTE_CHECKPOINTS;

export const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.primal.net/',
  'https://blossom.nostr.build/',
  'https://nostr.download/',
  'https://cdn.sovbit.host/',
];

const BLOSSOM_SERVERS_KEY = STORAGE_KEYS.BLOSSOM_SERVERS;

/** Get user-configured blossom servers, falling back to defaults */
export function getBlossomServers(): string[] {
  const stored = mobileStorage.getSync(BLOSSOM_SERVERS_KEY);
  if (stored) {
    try {
      const servers = JSON.parse(stored);
      if (Array.isArray(servers) && servers.length > 0) return servers;
    } catch { /* fall through */ }
  }
  return [...DEFAULT_BLOSSOM_SERVERS];
}

/** Save custom blossom server list */
export function setBlossomServers(servers: string[]): void {
  mobileStorage.setSync(BLOSSOM_SERVERS_KEY, JSON.stringify(servers));
}

function getActiveBlossomServers(): string[] {
  return getBlossomServers();
}


function getStoredCheckpoints(): RemoteCheckpoint[] {
  const raw = mobileStorage.getSync(CHECKPOINTS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function setStoredCheckpoints(cps: RemoteCheckpoint[]): void {
  // Always dedup before storing:
  // 1. By d-tag (addressable events replace each other — keep newest)
  const byDTag = new Map<string, RemoteCheckpoint>();
  for (const cp of cps) {
    const key = cp.dTag || cp.eventId;
    const existing = byDTag.get(key);
    if (!existing || cp.timestamp > existing.timestamp) {
      byDTag.set(key, cp);
    }
  }
  // 2. Collapse checkpoints with identical stats (keep newest per stats signature)
  const byStats = new Map<string, RemoteCheckpoint>();
  for (const cp of byDTag.values()) {
    const key = `${cp.stats?.corkboards ?? '?'}:${cp.stats?.savedForLater ?? '?'}:${cp.stats?.dismissed ?? '?'}`;
    const existing = byStats.get(key);
    if (!existing || cp.timestamp > existing.timestamp) {
      if (existing?.name && !cp.name) cp.name = existing.name;
      byStats.set(key, cp);
    }
  }
  const deduped = [...byStats.values()].sort((a, b) => b.timestamp - a.timestamp);
  mobileStorage.setSync(CHECKPOINTS_KEY, JSON.stringify(deduped));
}

function serializeBackup(): string {
  const data: Record<string, string | null> = {};
  for (const key of BACKED_UP_KEYS) {
    data[key] = mobileStorage.getSync(key);
  }
  return JSON.stringify(data);
}

function deserializeBackup(json: string): void {
  const data: Record<string, string | null> = JSON.parse(json);
  for (const [key, value] of Object.entries(data)) {
    if (!(BACKED_UP_KEYS as readonly string[]).includes(key)) continue;
    if (value === null || value === undefined) {
      mobileStorage.removeSync(key);
    } else {
      mobileStorage.setSync(key, value);
    }
  }
}

function getPublishRelays(pubkey: string): string[] {
  const relays = new Set<string>();
  for (const r of getUserRelays().write) relays.add(normalizeRelay(r));
  for (const r of getRelayCache(pubkey)) relays.add(normalizeRelay(r));
  for (const r of FALLBACK_RELAYS) relays.add(normalizeRelay(r));
  return Array.from(relays);
}

/** Upload encrypted text to a Blossom server using fetch PUT + kind 24242 auth */
async function blossomUpload(
  server: string,
  content: string,
  signer: NSecSigner,
): Promise<{ url: string; hash?: string } | null> {
  try {
    // Compute SHA-256 of content for auth event
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    const now = Math.floor(Date.now() / 1000);
    const authEvent = await signer.signEvent({
      kind: 24242,
      content: 'Upload corkboard backup',
      tags: [
        ['t', 'upload'],
        ['x', hashHex],
        ['expiration', String(now + 3600)],
      ],
      created_at: now,
    });

    const authHeader = 'Nostr ' + btoa(JSON.stringify(authEvent));
    const uploadUrl = server.replace(/\/$/, '') + '/upload';

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: content,
      headers: {
        'Content-Type': 'text/plain',
        'Authorization': authHeader,
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      if (__DEV__) console.warn(`[backup] ${server} upload failed: ${response.status}`);
      return null;
    }

    const result = await response.json();
    const url = result.url || result.nip94_event?.tags?.find((t: string[]) => t[0] === 'url')?.[1];
    const hash = result.sha256 || hashHex;
    if (!url) return null;
    return { url, hash };
  } catch (err) {
    if (__DEV__) console.warn(`[backup] ${server} upload error:`, err);
    return null;
  }
}

export function useNostrBackup(pubkey: string | null, signer: NSecSigner | null) {
  const [status, setStatus] = useState<BackupStatus>('idle');
  const [message, setMessage] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [checkpoints, setCheckpoints] = useState<RemoteCheckpoint[]>(() => getStoredCheckpoints());
  const [lastBackupTs, setLastBackupTs] = useState<number>(() => {
    return parseInt(mobileStorage.getSync(LAST_BACKUP_TS_KEY) || '0', 10);
  });

  // Persistent device ID for cross-device sync — stays local, never backed up.
  const [deviceId] = useState(() => {
    const existing = mobileStorage.getSync('corkboard:device-id');
    if (existing) return existing;
    const id = crypto.randomUUID();
    mobileStorage.setSync('corkboard:device-id', id);
    return id;
  });

  const isSaving = useRef(false);
  const isRestoring = useRef(false);

  const log = useCallback((msg: string) => {
    if (__DEV__) console.log('[backup]', msg);
    const ts = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-99), `[${ts}] ${msg}`]);
  }, []);

  const saveBackup = useCallback(async () => {
    if (!pubkey || !signer || isSaving.current) return;
    if (!signer.nip04 && !signer.nip44) {
      setStatus('save-error');
      setMessage('Signer does not support encryption');
      return;
    }

    isSaving.current = true;
    setStatus('encrypting');
    setMessage('Encrypting backup…');

    try {
      const json = serializeBackup();
      log(`Serialized: ${new TextEncoder().encode(json).length} bytes`);

      // Generate AES key + encrypt
      const { raw: aesRaw, key: aesKey } = await generateAesKey();
      const aesKeyHex = rawKeyToHex(aesRaw);

      const signerMethod: 'nip44' | 'nip04' = signer.nip44 ? 'nip44' : 'nip04';
      const wrappedKey = signerMethod === 'nip44'
        ? await signer.nip44!.encrypt(pubkey, aesKeyHex)
        : await signer.nip04!.encrypt(pubkey, aesKeyHex);

      const encryptedData = await aesEncrypt(aesKey, json);
      log(`Encrypted: ${encryptedData.length} chars`);

      setStatus('saving');
      setMessage('Uploading to Blossom…');

      let blossomUrl: string | null = null;
      let blossomHash: string | undefined;
      for (const server of getActiveBlossomServers()) {
        log(`  Uploading to ${server}…`);
        const result = await blossomUpload(server, encryptedData, signer);
        if (result) {
          blossomUrl = result.url;
          blossomHash = result.hash;
          log(`  Uploaded: ${blossomUrl}`);
          break;
        }
      }

      if (!blossomUrl) throw new Error('All Blossom servers failed');

      // Publish manifest (kind 30078)
      const now = Math.floor(Date.now() / 1000);
      const dTag = `${D_TAG_PREFIX}:auto`;
      const keysPresent = BACKED_UP_KEYS.filter(k => mobileStorage.getSync(k) !== null);
      const jsonLen = (k: string) => { try { return JSON.parse(mobileStorage.getSync(k) || '[]').length; } catch { return 0; } };
      const stats = {
        corkboards: jsonLen('nostr-custom-feeds'),
        savedForLater: jsonLen('collapsed-notes'),
        dismissed: jsonLen('dismissed-notes'),
      };
      let corkboardNames: string[] = [];
      try {
        const feeds = JSON.parse(mobileStorage.getSync('nostr-custom-feeds') || '[]');
        corkboardNames = feeds.map((f: { title?: string }) => f.title).filter(Boolean) as string[];
      } catch { /* ignore */ }
      const manifestJson = JSON.stringify({
        v: 4, timestamp: now, encryption: 'aes-gcm',
        wrappedKey, signerMethod, blossomUrl, deviceId,
        ...(blossomHash ? { blossomHash } : {}),
        keys: keysPresent, stats, corkboardNames,
      });
      // Encrypt manifest so stats and Blossom URL aren't leaked
      const encryptedManifest = signer.nip44
        ? await signer.nip44.encrypt(pubkey, manifestJson)
        : manifestJson;

      const manifestEvent = await signer.signEvent({
        kind: 30078,
        content: encryptedManifest,
        tags: [['d', dTag]],
        created_at: now,
      });

      const relays = getPublishRelays(pubkey);
      let published = 0;
      for (const url of relays) {
        const relay = new NRelay1(url, { backoff: false });
        try {
          await relay.event(manifestEvent, { signal: AbortSignal.timeout(8000) });
          log(`  ${url} ← manifest OK`);
          published++;
        } catch (err) {
          log(`  ${url} ← FAILED: ${err instanceof Error ? err.message : err}`);
        } finally {
          try { relay.close(); } catch { /* */ }
        }
      }

      if (published === 0) throw new Error('No relays accepted the manifest');

      // Store checkpoint locally
      const cp: RemoteCheckpoint = {
        eventId: manifestEvent.id,
        dTag,
        timestamp: now,
        blossomUrl: blossomUrl!,
        ...(blossomHash ? { blossomHash } : {}),
        wrappedKey,
        signerMethod,
      };
      const existing = getStoredCheckpoints();
      const updated = [cp, ...existing];
      setStoredCheckpoints(updated);
      setCheckpoints(updated);

      mobileStorage.setSync(LAST_BACKUP_TS_KEY, String(now));
      setLastBackupTs(now);
      setStatus('saved');
      setMessage(`Backup saved (${published} relays, Blossom: ${blossomUrl})`);
      log(`Done: manifest on ${published}/${relays.length} relays`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('Save failed: ' + errMsg);
      setStatus('save-error');
      setMessage('Backup failed: ' + errMsg);
    } finally {
      isSaving.current = false;
    }
  }, [pubkey, signer, log]);

  const checkForBackup = useCallback(async () => {
    if (!pubkey || !signer) return;

    setStatus('checking');
    setMessage('Looking for backups…');

    const seen = new Set<string>();
    const allEvents: NostrEvent[] = [];

    const relays = [...new Set(getPublishRelays(pubkey))];

    log(`Checking ${relays.length} relays…`);

    // Fetch recent backup manifests (limit 5 for fast login).
    // User can manually check for older states from the backup UI.
    for (let i = 0; i < relays.length; i += 3) {
      const batch = relays.slice(i, i + 3);
      await Promise.allSettled(batch.map(async url => {
        const relay = new NRelay1(url, { backoff: false });
        try {
          const events = await relay.query(
            [{ kinds: [30078], authors: [pubkey], limit: 5 }],
            { signal: AbortSignal.timeout(5000) },
          );
          for (const ev of events) {
            const dTag = ev.tags.find(t => t[0] === 'd')?.[1];
            if (!dTag || !(dTag === D_TAG_PREFIX || dTag.startsWith(D_TAG_PREFIX + ':'))) continue;
            if (!seen.has(ev.id)) { seen.add(ev.id); allEvents.push(ev); }
          }
          log(`  ${url}: ${events.length} kind:30078, ${allEvents.length} backup manifests`);
        } catch { /* timeout ok */ } finally {
          try { relay.close(); } catch { /* */ }
        }
      }));
      if (allEvents.length > 0) break; // Early exit
    }

    if (allEvents.length === 0) {
      setStatus('no-backup');
      setMessage('No backups found');
      log('No backups found');
      return;
    }

    // Parse checkpoints from events (try plaintext first, then NIP-44 decrypt)
    const cps: RemoteCheckpoint[] = [];
    for (const ev of allEvents) {
      let data: Record<string, unknown> | null = null;
      try { data = JSON.parse(ev.content); } catch {
        if (signer?.nip44) {
          try {
            const json = await signer.nip44.decrypt(pubkey, ev.content);
            data = JSON.parse(json);
          } catch { /* decrypt failed — skip */ }
        }
      }
      try {
        if (!data || !data.blossomUrl || !data.wrappedKey || !data.signerMethod) continue;
        const dTag = ev.tags.find(t => t[0] === 'd')?.[1] || '';
        cps.push({
          eventId: ev.id,
          dTag,
          timestamp: ev.created_at,
          blossomUrl: data.blossomUrl as string,
          blossomHash: data.blossomHash as string | undefined,
          wrappedKey: data.wrappedKey as string,
          signerMethod: data.signerMethod as 'nip44' | 'nip04',
          stats: data.stats as RemoteCheckpoint['stats'],
        });
      } catch { /* ignore malformed */ }
    }

    // setStoredCheckpoints handles d-tag + stats dedup automatically
    setStoredCheckpoints(cps);
    const deduped = getStoredCheckpoints();
    setCheckpoints(deduped);

    setStatus('found');
    setMessage(`Found ${deduped.length} backup${deduped.length === 1 ? '' : 's'}`);
    log(`Found ${deduped.length} backups (${cps.length} raw → ${deduped.length} after dedup)`);
  }, [pubkey, signer, log]);

  const restoreBackup = useCallback(async (checkpoint: RemoteCheckpoint) => {
    if (!pubkey || !signer || isRestoring.current) return;
    isRestoring.current = true;

    setStatus('restoring');
    setMessage('Downloading backup…');

    try {
      // Try primary URL, then fallback to other Blossom servers using hash
      let encryptedData: string | null = null;
      const urls = [checkpoint.blossomUrl];
      if (checkpoint.blossomHash) {
        for (const server of getActiveBlossomServers()) {
          const fallbackUrl = `${server.replace(/\/$/, '')}/${checkpoint.blossomHash}`;
          if (fallbackUrl !== checkpoint.blossomUrl) urls.push(fallbackUrl);
        }
      }
      for (const url of urls) {
        try {
          log(`Fetching from ${url}…`);
          const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
          if (!response.ok) { log(`  ${url}: HTTP ${response.status}`); continue; }
          encryptedData = await response.text();
          log(`Downloaded: ${encryptedData.length} chars`);
          break;
        } catch (err) {
          log(`  ${url}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (!encryptedData) throw new Error('Could not download backup from any Blossom server');

      // Verify Blossom hash if present (integrity check)
      if (checkpoint.blossomHash) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encryptedData));
        const computed = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        if (computed !== checkpoint.blossomHash) {
          throw new Error('Backup integrity check failed — data may be corrupted.');
        }
        log('Blossom hash verified');
      }

      setMessage('Decrypting…');

      // Unwrap AES key
      const keyHex = checkpoint.signerMethod === 'nip04'
        ? await signer.nip04!.decrypt(pubkey, checkpoint.wrappedKey)
        : await signer.nip44!.decrypt(pubkey, checkpoint.wrappedKey);

      const raw = hexToRawKey(keyHex);
      const aesKey = await importAesKey(raw);
      const json = await aesDecrypt(aesKey, encryptedData);
      log('Decrypted successfully');

      setMessage('Restoring settings…');
      deserializeBackup(json);
      log('Settings restored');

      setStatus('restored');
      setMessage('Backup restored! Restart the app to apply all settings.');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('Restore failed: ' + errMsg);
      setStatus('restore-error');
      setMessage('Restore failed: ' + errMsg);
    } finally {
      isRestoring.current = false;
    }
  }, [pubkey, signer, log]);

  const lastBackupAgo = lastBackupTs > 0 ? formatTimeAgo(lastBackupTs) : null;

  return {
    status,
    message,
    logs,
    checkpoints,
    lastBackupTs,
    lastBackupAgo,
    saveBackup,
    checkForBackup,
    restoreBackup,
  };
}
