/**
 * useNostrBackup — encrypted cloud backup and restore for user settings.
 *
 * Architecture:
 *   1. All backed-up keys (from BACKED_UP_KEYS) are serialized to JSON.
 *   2. The JSON blob is AES-256-GCM encrypted with a randomly generated key.
 *   3. The encrypted blob is uploaded to user-chosen Blossom servers (NIP-94
 *      file metadata) in 32 KB chunks.
 *   4. A NIP-78 app-specific event (kind:30078, d-tag `corkboard:backup`)
 *      is published referencing the uploaded chunks and their Blossom URLs.
 *   5. The AES key is NIP-04 encrypted to the user's own pubkey and stored
 *      in the kind:30078 event — restore requires the same nsec.
 *
 * For NIP-46 (bunker) users, the AES key is encrypted locally first, and
 * the remote signer only signs the envelope event.
 *
 * Relevant NIPs: 04 (encryption), 78 (app-specific data), 94 (file metadata).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { NRelay1 } from '@nostrify/nostrify';
import { triggerDownload } from '@/lib/triggerDownload';
import { BlossomUploader } from '@nostrify/nostrify/uploaders';
import type { NostrEvent, NPool } from '@nostrify/nostrify';
import type { NUser } from '@nostrify/react/login';
import { FALLBACK_RELAYS, getUserRelays, getRelayCache, updateRelayCache } from '@/components/NostrProvider';
import { BACKED_UP_KEYS, STORAGE_KEYS } from '@/lib/storageKeys';
import { formatTimeAgo } from '@/lib/formatTimeAgo';
import { debugLog, debugWarn } from '@/lib/debug';
import { idbGetSync, idbSetSync, idbRemoveSync, idbKeys, idbSet, idbReady } from '@/lib/idb';
import {
  generateAesKey, importAesKey,
  aesEncrypt, aesDecrypt, rawKeyToHex, hexToRawKey,
} from '@/lib/nostrEncrypt';

// Relay blacklist - persists across sessions
const BLOCKED_RELAYS_KEY = 'corkboard:blocked-relays';

export function getBlockedRelays(): Set<string> {
  const stored = idbGetSync(BLOCKED_RELAYS_KEY);
  return stored ? new Set(JSON.parse(stored)) : new Set();
}

export function blockRelay(url: string): void {
  const normalized = url.endsWith('/') ? url : url + '/';
  const blocked = getBlockedRelays();
  blocked.add(normalized);
  idbSetSync(BLOCKED_RELAYS_KEY, JSON.stringify(Array.from(blocked)));
}

export function isRelayBlocked(url: string): boolean {
  const normalized = url.endsWith('/') ? url : url + '/';
  return getBlockedRelays().has(normalized);
}

const LAST_BACKUP_TS_KEY = 'corkboard:last-backup-ts';
const LAST_CHUNK_COUNT_KEY = 'corkboard:last-chunk-count';
const BACKUP_CHECKED_KEY = 'corkboard:backup-checked';
// Synchronous mirror of BACKUP_CHECKED_KEY in localStorage so we can skip
// the blocking splash instantly on page load for returning users.
const LS_BACKUP_CHECKED_PREFIX = 'corkboard:backup-checked-ls:';
function markBackupCheckedSync(pubkey: string) {
  try { localStorage.setItem(LS_BACKUP_CHECKED_PREFIX + pubkey, '1'); } catch { /* unavailable in private/restricted contexts */ }
}

function clearBackupCheckedSync(pubkey: string) {
  try { localStorage.removeItem(LS_BACKUP_CHECKED_PREFIX + pubkey); } catch { /* unavailable in private/restricted contexts */ }
}
// Legacy chunked backups (v3) used 32KB chunks — kept for restore compatibility
const _CHUNK_SIZE = 32768;
const D_TAG_PREFIX = 'corkboard:backup';
const MAX_LOG_ENTRIES = 100;

// Default blossom servers for backup file upload.
// blossom.band is excluded: it rejects application/octet-stream blobs (HTTP 415)
// and only accepts image/media uploads. The remaining servers accept text/plain blobs.
export const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.primal.net/',
  'https://blossom.nostr.build/',
  'https://nostr.download/',
  'https://cdn.sovbit.host/',
];

const BLOSSOM_SERVERS_KEY = STORAGE_KEYS.BLOSSOM_SERVERS;

/** Get user-configured blossom servers, falling back to defaults */
export function getBlossomServers(): string[] {
  const stored = idbGetSync(BLOSSOM_SERVERS_KEY);
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
  idbSetSync(BLOSSOM_SERVERS_KEY, JSON.stringify(servers));
  idbSet(BLOSSOM_SERVERS_KEY, JSON.stringify(servers));
}

// Resolved list used throughout this module
function getActiveBlossomServers(): string[] {
  return getBlossomServers();
}

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

export interface RemoteBackup {
  timestamp: number;
  keys: string[];
  chunks: number;
  encryption?: string;
  relays?: string[];
  corkboardNames?: string[];
  stats?: {
    corkboards: number;
    savedForLater: number;
    dismissed: number;
  };
}

/** A checkpoint is a Blossom backup with enough metadata to restore without re-querying relays. */
export interface RemoteCheckpoint {
  eventId: string;
  dTag: string;
  timestamp: number;
  blossomUrl: string;
  blossomHash?: string;
  wrappedKey: string;
  signerMethod: 'nip44' | 'nip04';
  stats?: { corkboards: number; savedForLater: number; dismissed: number };
  corkboardNames?: string[];
  name?: string;
}

const CHECKPOINTS_KEY = STORAGE_KEYS.REMOTE_CHECKPOINTS;

function getStoredCheckpoints(): RemoteCheckpoint[] {
  const raw = idbGetSync(CHECKPOINTS_KEY);
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
      // Preserve user-given names
      if (existing?.name && !cp.name) cp.name = existing.name;
      byStats.set(key, cp);
    }
  }
  const deduped = [...byStats.values()].sort((a, b) => b.timestamp - a.timestamp);
  idbSetSync(CHECKPOINTS_KEY, JSON.stringify(deduped));
}

interface RelayResult {
  url: string;
  success: boolean;
  error?: string;
}

// Serialize all backed-up keys from IDB cache into a JSON string
function serializeBackup(): string {
  const data: Record<string, string | null> = {};
  for (const key of BACKED_UP_KEYS) {
    data[key] = idbGetSync(key);
  }
  return JSON.stringify(data);
}

// Write backup data back to IDB - returns promise that resolves when all writes complete.
// Uses idbSet (async, awaited) for persistence guarantee before page reload,
// plus idbSetSync dispatches sync events so useLocalStorage hooks update in-flight.
async function deserializeBackup(json: string, log?: (msg: string) => void): Promise<number> {
  const data: Record<string, string | null> = JSON.parse(json);
  const writes: Promise<void>[] = [];
  let restored = 0;

  for (const [key, value] of Object.entries(data)) {
    if (!(BACKED_UP_KEYS as readonly string[]).includes(key)) continue;
    if (value === null || value === undefined) {
      idbRemoveSync(key);
      continue;
    }
    // Write to memCache + IDB, and dispatch sync event immediately so
    // useLocalStorage hooks pick up the change without needing a reload.
    idbSetSync(key, value);
    writes.push(idbSet(key, value));
    restored++;
  }

  // Dispatch sync events NOW (don't wait for idbSetSync's async .then())
  // so React hooks update while IDB writes finish in the background.
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (!(BACKED_UP_KEYS as readonly string[]).includes(key)) continue;
    window.dispatchEvent(
      new CustomEvent('idb-storage-sync', {
        detail: { key, value: (() => { try { return JSON.parse(value); } catch { return value; } })() },
      })
    );
  }

  await Promise.all(writes);
  log?.(`Deserialized: ${restored} keys written to IDB`);
  return restored;
}

// Split a string into chunks of maxBytes (UTF-8 byte length)
function _chunkString(str: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(str);
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for (let offset = 0; offset < encoded.length; offset += maxBytes) {
    chunks.push(decoder.decode(encoded.slice(offset, offset + maxBytes)));
  }
  return chunks.length > 0 ? chunks : [''];
}

// Get array length from a JSON-encoded IDB cache value
function jsonLen(key: string): number {
  try {
    const v = idbGetSync(key);
    if (!v) return 0;
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.length : 0;
  } catch { return 0; }
}

/** Count saved notes = union of collapsed-notes + nostr-bookmark-ids */
function savedNoteCount(): number {
  const collapsed = parseIdArr(idbGetSync('collapsed-notes'));
  const bookmarks = parseIdArr(idbGetSync('nostr-bookmark-ids'));
  return new Set([...collapsed, ...bookmarks]).size;
}

function parseIdArr(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((s: unknown): s is string => typeof s === 'string') : [];
  } catch { return []; }
}

// Normalize relay URL: ensure trailing slash for deduplication
function normalizeRelay(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

// Get relays ordered: user write relays first, then relay cache, then fallbacks
// No filtering — try everything, let timeouts handle bad relays
function getPublishRelays(pubkey: string): { primary: string[]; fallback: string[] } {
  const primary = new Set<string>();
  const fallback = new Set<string>();

  // 1. User's write relays (highest priority)
  const userRelays = getUserRelays();
  for (const r of userRelays.write) {
    primary.add(normalizeRelay(r));
  }

  // 2. Relay cache for this pubkey
  for (const r of getRelayCache(pubkey)) {
    const n = normalizeRelay(r);
    if (!primary.has(n)) primary.add(n);
  }

  // 3. Fallbacks (only if not already in primary)
  for (const r of FALLBACK_RELAYS) {
    const n = normalizeRelay(r);
    if (!primary.has(n)) fallback.add(n);
  }

  return { primary: Array.from(primary), fallback: Array.from(fallback) };
}


// Keys tracked for change detection (shared between save, auto-save, and restore)
const SNAPSHOT_KEYS = ['nostr-custom-feeds','collapsed-notes','dismissed-notes','nostr-friends','nostr-browse-relays','nostr-rss-feeds','saved-minimized-notes','corkboard:tab-filters','corkboard:onboarding-skipped','corkboard:banner-height-pct','corkboard:banner-fit-mode'] as const;

// Module-level guard: prevents double backup check across component remounts.
// Keyed by pubkey so switching accounts still triggers a check.
let _checkedPubkey: string | null = null;

// Track which relays were used during backup check/restore so other fetches
// can prefer different relays and avoid rate-limiting the same ones.
const _backupRelaysUsed = new Set<string>();
export function getBackupRelaysUsed(): Set<string> { return _backupRelaysUsed; }

export function useNostrBackup(user: NUser | undefined, _nostr: NPool) {
  const [status, setStatus] = useState<BackupStatus>('idle');
  // True once the single login check has resolved (found, no-backup, or error).
  // Starts settled if we already checked this session (module-level guard).
  const [checkSettled, setCheckSettled] = useState(() => _checkedPubkey === user?.pubkey);
  const [message, setMessage] = useState('');
  const [remoteBackup, setRemoteBackup] = useState<RemoteBackup | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [lastBackupTs, setLastBackupTs] = useState<number>(() => {
    return parseInt(idbGetSync(LAST_BACKUP_TS_KEY) || '0', 10);
  });

  const isSaving = useRef(false);
  const isRestoring = useRef(false);
  const manifestEventRef = useRef<NostrEvent | null>(null);
  const manifestDataRef = useRef<Record<string, unknown> | null>(null);
  const idbReadyChecked = useRef(false);

  // Persistent device ID for cross-device sync — stays local, never backed up.
  // Included in backup manifests so we can detect when a different device saved.
  const [deviceId] = useState(() => {
    const existing = idbGetSync('corkboard:device-id');
    if (existing) return existing;
    const id = crypto.randomUUID();
    idbSetSync('corkboard:device-id', id);
    idbSet('corkboard:device-id', id);
    return id;
  });

  // Append to log (UI always; console only in debug mode)
  const log = useCallback((msg: string, level: 'log' | 'warn' | 'error' = 'log') => {
    const ts = new Date().toLocaleTimeString();
    const entry = `[${ts}] ${msg}`;
    if (level === 'warn') {
      debugWarn('[backup]', msg);
    } else {
      debugLog('[backup]', msg);
    }
    setLogs(prev => [...prev.slice(-(MAX_LOG_ENTRIES - 1)), entry]);
  }, []);

  // Check if there are unsaved changes by comparing IDB with last backup snapshot.
  // No React state dependencies — reads directly from IDB sync cache so the function
  // identity is stable and doesn't reset the idle auto-save timer.
  const hasUnsavedChanges = useCallback(() => {
    const saved = idbGetSync('corkboard:last-backup-data');
    if (!saved) {
      // No snapshot means we haven't saved or restored yet this session.
      // Only consider it "unsaved" if there's actually meaningful data to save.
      const feeds = idbGetSync('nostr-custom-feeds');
      const dismissed = idbGetSync('dismissed-notes');
      const collapsed = idbGetSync('collapsed-notes');
      const onboardingSkipped = idbGetSync('corkboard:onboarding-skipped');
      const hasMeaningfulData = (feeds && feeds !== '[]') || (dismissed && dismissed !== '[]') || (collapsed && collapsed !== '[]') || onboardingSkipped === 'true';
      return !!hasMeaningfulData;
    }

    try {
      const lastData = JSON.parse(saved);
      for (const key of SNAPSHOT_KEYS) {
        const current = idbGetSync(key) || '';
        const lastSaved = lastData[key] || '';
        if (current !== lastSaved) {
          return true;
        }
      }
      return false;
    } catch {
      const ts = parseInt(idbGetSync(LAST_BACKUP_TS_KEY) || '0', 10);
      return ts === 0;
    }
  }, []);

  // Auto-dismiss "saved" status after 5s
  // "restored" is NOT auto-dismissed - user must click Continue to reload
  useEffect(() => {
    if (status === 'saved') {
      const t = setTimeout(() => {
        setStatus('idle');
        setMessage('');
      }, 5000);
      return () => clearTimeout(t);
    }
  }, [status]);

  // Save backup to Nostr
  const saveBackup = useCallback(async () => {
    if (!user || isSaving.current) {
      log('Save skipped: ' + (!user ? 'no user' : 'already saving'));
      return;
    }
    isSaving.current = true;
    log('Starting save...');

    try {
      const json = serializeBackup();
      const jsonBytes = new TextEncoder().encode(json).length;
      log(`Serialized: ${jsonBytes} bytes`);

      setStatus('encrypting');
      setMessage('Encrypting backup...');

      const pubkey = user.pubkey;
      const signer = user.signer;

      if (!signer.nip04 && !signer.nip44) {
        log('Signer does not support encryption', 'error');
        setStatus('save-error');
        setMessage('Backup failed: signer does not support encryption');
        isSaving.current = false;
        return;
      }

      const now = Math.floor(Date.now() / 1000);

      // Generate AES key, encrypt the entire backup as a single blob
      log('Generating AES key...');
      const { raw: aesRaw, key: aesKey } = await generateAesKey();
      const aesKeyHex = rawKeyToHex(aesRaw);

      const signerMethod = signer.nip44 ? 'nip44' : 'nip04';
      log(`Wrapping AES key with ${signerMethod}...`);
      const wrappedKey = signerMethod === 'nip44'
        ? await signer.nip44!.encrypt(pubkey, aesKeyHex)
        : await signer.nip04!.encrypt(pubkey, aesKeyHex);

      log('Encrypting backup...');
      const encryptedData = await aesEncrypt(aesKey, json);
      log(`Encrypted: ${encryptedData.length} chars`);

      // Upload encrypted backup to Blossom as a single file
      setStatus('saving');
      setMessage('Uploading encrypted backup to Blossom...');

      const blob = new Blob([encryptedData], { type: 'text/plain' });
      const file = new File([blob], 'corkboard-backup.txt', { type: 'text/plain' });

      let blossomUrl: string | null = null;
      let blossomHash: string | null = null;
      const servers = getActiveBlossomServers();
      const serverErrors: string[] = [];
      for (const server of servers) {
        try {
          log(`  Uploading to ${server}...`);
          setMessage(`Uploading to ${new URL(server).hostname}...`);
          const uploader = new BlossomUploader({ servers: [server], signer });
          const tags = await Promise.race([
            uploader.upload(file),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
          ]);
          const urlTag = tags.find((t: string[]) => t[0] === 'url');
          const hashTag = tags.find((t: string[]) => t[0] === 'x' || t[0] === 'sha256');
          if (urlTag?.[1]) {
            blossomUrl = urlTag[1];
            blossomHash = hashTag?.[1] ?? null;
            log(`  Uploaded: ${blossomUrl}`);
            break;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          serverErrors.push(`${new URL(server).hostname}: ${errMsg}`);
          log(`  ${server} failed: ${errMsg}`, 'warn');
        }
      }

      if (!blossomUrl) {
        throw new Error(`All ${servers.length} Blossom servers failed:\n${serverErrors.join('\n')}`);
      }

      // Create manifest with Blossom URL (no chunks, single file)
      const keysPresent = BACKED_UP_KEYS.filter(k => idbGetSync(k) !== null);
      const stats = {
        corkboards: jsonLen('nostr-custom-feeds'),
        savedForLater: savedNoteCount(),
        dismissed: jsonLen('dismissed-notes'),
      };
      let corkboardNames: string[] = [];
      try {
        const feeds = JSON.parse(idbGetSync('nostr-custom-feeds') || '[]');
        corkboardNames = feeds.map((f: { title?: string }) => f.title).filter(Boolean) as string[];
      } catch { /* ignore */ }

      const manifestData = {
        v: 4, timestamp: now,
        encryption: 'aes-gcm',
        wrappedKey, signerMethod,
        blossomUrl, deviceId,
        ...(blossomHash ? { blossomHash } : {}),
        keys: keysPresent, stats, corkboardNames,
      };
      log(`Manifest v4: ${keysPresent.length} keys, blossom: ${blossomUrl}, device: ${deviceId.slice(0, 8)}`);

      // Encrypt manifest so corkboard names, stats, and Blossom URL aren't leaked
      const manifestJson = JSON.stringify(manifestData);
      const encryptedManifest = signer.nip44
        ? await signer.nip44.encrypt(pubkey, manifestJson)
        : signer.nip04
          ? await signer.nip04.encrypt(pubkey, manifestJson)
          : manifestJson;

      const dTag = `${D_TAG_PREFIX}:${now}`;
      const manifestEvent = await signer.signEvent({
        kind: 30078,
        content: encryptedManifest,
        tags: [['d', dTag]],
        created_at: now,
      });

      // Publish manifest to write relays + fallbacks
      const { primary, fallback } = getPublishRelays(pubkey);
      const allRelayUrls = [...primary, ...fallback];
      const succeeded: RelayResult[] = [];
      for (const url of allRelayUrls) {
        const relay = new NRelay1(url, { backoff: false });
        try {
          await relay.event(manifestEvent, { signal: AbortSignal.timeout(8000) });
          log(`  ${url} <- manifest OK`);
          succeeded.push({ url, success: true });
        } catch (err) {
          log(`  ${url} <- manifest FAILED: ${err instanceof Error ? err.message : err}`, 'warn');
        } finally {
          try { relay.close(); } catch { /* */ }
        }
      }

      log(`Results: manifest on ${succeeded.length}/${allRelayUrls.length} relays, backup at ${blossomUrl}`);
      log(`Saved: ${stats.corkboards} corkboards, ${stats.savedForLater} saved-for-later, ${stats.dismissed} dismissed`);

      // Tombstone old chunk events from v3 backups
      const prevChunkCount = parseInt(idbGetSync(LAST_CHUNK_COUNT_KEY) || '0', 10);
      if (prevChunkCount > 0) {
        log(`Tombstoning ${prevChunkCount} legacy chunk events`);
        for (let i = 0; i < prevChunkCount; i++) {
          const tombstone = await signer.signEvent({
            kind: 30078, content: '', tags: [['d', `${D_TAG_PREFIX}:${i}`]], created_at: now,
          });
          for (const r of succeeded) {
            const relay = new NRelay1(r.url, { backoff: false });
            try { await relay.event(tombstone, { signal: AbortSignal.timeout(5000) }); } catch { /* ignore */ }
            finally { try { relay.close(); } catch { /* ignore */ } }
          }
        }
      }

      if (succeeded.length === 0) {
        setStatus('save-error');
        setMessage('Backup failed: could not reach any relay');
        log('TOTAL FAILURE: no relays accepted', 'error');
      } else {
        setStatus('saved');
        idbSetSync(LAST_BACKUP_TS_KEY, String(now));
        idbSetSync(LAST_CHUNK_COUNT_KEY, '0'); // v4 uses Blossom, no chunks
        idbRemoveSync('corkboard:preferred-checkpoint'); // new save is now the latest
        setLastBackupTs(now);

        // Store snapshot of data for change detection
        const snapshot: Record<string, string> = {};
        for (const key of SNAPSHOT_KEYS) snapshot[key] = idbGetSync(key) || '';
        idbSetSync('corkboard:last-backup-data', JSON.stringify(snapshot));
        
        // Store checkpoint metadata locally for the Checkpoints dialog
        const cp: RemoteCheckpoint = {
          eventId: manifestEvent.id,
          dTag,
          timestamp: now,
          blossomUrl: blossomUrl!,
          ...(blossomHash ? { blossomHash } : {}),
          wrappedKey,
          signerMethod,
          stats,
          corkboardNames,
        };
        const existing = getStoredCheckpoints();
        setStoredCheckpoints([cp, ...existing]);

        setMessage(`Backup uploaded to Blossom, manifest on ${succeeded.length} relays`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('Save failed: ' + errMsg, 'error');
      setStatus('save-error');
      setMessage('Backup failed: ' + errMsg);
    } finally {
      isSaving.current = false;
    }
  }, [user, log, deviceId]);

  // Ref for refreshing checkpoint React state from autoSaveBackup (defined before
  // checkpoint state, but populated after — avoids circular dependency).
  const refreshCheckpointsRef = useRef<() => void>(() => {});

  // Auto-save: silent background save using a fixed d-tag (overwrites itself).
  const autoSaveBackup = useCallback(async (): Promise<boolean> => {
    if (!user || isSaving.current || isRestoring.current) return false;
    // Block auto-save while a forced background check is running — prevents
    if (!hasUnsavedChanges()) return false;
    isSaving.current = true;

    try {
      const json = serializeBackup();
      const pubkey = user.pubkey;
      const signer = user.signer;
      if (!signer.nip04 && !signer.nip44) { isSaving.current = false; return false; }

      const now = Math.floor(Date.now() / 1000);
      const { raw: aesRaw, key: aesKey } = await generateAesKey();
      const aesKeyHex = rawKeyToHex(aesRaw);
      const signerMethod = signer.nip44 ? 'nip44' : 'nip04';
      const wrappedKey = signerMethod === 'nip44'
        ? await signer.nip44!.encrypt(pubkey, aesKeyHex)
        : await signer.nip04!.encrypt(pubkey, aesKeyHex);
      const encryptedData = await aesEncrypt(aesKey, json);

      const blob = new Blob([encryptedData], { type: 'text/plain' });
      const file = new File([blob], 'corkboard-autosave.txt', { type: 'text/plain' });

      let blossomUrl: string | null = null;
      let blossomHash: string | null = null;
      for (const server of getActiveBlossomServers()) {
        try {
          const uploader = new BlossomUploader({ servers: [server], signer });
          const tags = await Promise.race([
            uploader.upload(file),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
          ]);
          const urlTag = tags.find((t: string[]) => t[0] === 'url');
          const hashTag = tags.find((t: string[]) => t[0] === 'x' || t[0] === 'sha256');
          if (urlTag?.[1]) {
            blossomUrl = urlTag[1];
            blossomHash = hashTag?.[1] ?? null;
            break;
          }
        } catch { /* continue */ }
      }
      if (!blossomUrl) { isSaving.current = false; return false; }

      const keysPresent = BACKED_UP_KEYS.filter(k => idbGetSync(k) !== null);
      const stats = {
        corkboards: jsonLen('nostr-custom-feeds'),
        savedForLater: savedNoteCount(),
        dismissed: jsonLen('dismissed-notes'),
      };
      let corkboardNames: string[] = [];
      try {
        const feeds = JSON.parse(idbGetSync('nostr-custom-feeds') || '[]');
        corkboardNames = feeds.map((f: { title?: string }) => f.title).filter(Boolean) as string[];
      } catch { /* ignore */ }
      // Encrypt manifest so corkboard names, stats, and Blossom URL aren't leaked
      const autoManifestJson = JSON.stringify({
        v: 4, timestamp: now, encryption: 'aes-gcm',
        wrappedKey, signerMethod, blossomUrl, deviceId,
        ...(blossomHash ? { blossomHash } : {}),
        keys: keysPresent, stats, corkboardNames,
      });
      const encryptedAutoManifest = signer.nip44
        ? await signer.nip44.encrypt(pubkey, autoManifestJson)
        : signer.nip04
          ? await signer.nip04.encrypt(pubkey, autoManifestJson)
          : autoManifestJson;

      const manifestEvent = await signer.signEvent({
        kind: 30078,
        content: encryptedAutoManifest,
        tags: [['d', `${D_TAG_PREFIX}:auto`]],
        created_at: now,
      });

      const { primary, fallback } = getPublishRelays(pubkey);
      for (const url of [...primary, ...fallback]) {
        const relay = new NRelay1(url, { backoff: false });
        try { await relay.event(manifestEvent, { signal: AbortSignal.timeout(8000) }); }
        catch { /* continue */ }
        finally { try { relay.close(); } catch { /* */ } }
      }

      // Update timestamp so auto-restore knows local is current
      idbSetSync(LAST_BACKUP_TS_KEY, String(now));
      setLastBackupTs(now);

      // Snapshot for change detection
      const snapshot: Record<string, string> = {};
      for (const key of SNAPSHOT_KEYS) snapshot[key] = idbGetSync(key) || '';
      idbSetSync('corkboard:last-backup-data', JSON.stringify(snapshot));

      // Add autosave entry to local checkpoint list, keep last 5 autosaves
      const cps = getStoredCheckpoints();
      const autoEntry: RemoteCheckpoint = {
        eventId: manifestEvent.id,
        dTag: `${D_TAG_PREFIX}:auto`,
        timestamp: now,
        blossomUrl: blossomUrl!,
        ...(blossomHash ? { blossomHash } : {}),
        wrappedKey,
        signerMethod,
        stats,
        corkboardNames,
      };
      // Only add if stats differ from the most recent autosave
      const latestAuto = cps.find(c => c.dTag?.includes(':auto'));
      const statsChanged = !latestAuto?.stats
        || latestAuto.stats.corkboards !== stats.corkboards
        || latestAuto.stats.savedForLater !== stats.savedForLater
        || latestAuto.stats.dismissed !== stats.dismissed;
      if (statsChanged) {
        cps.unshift(autoEntry);
      } else if (latestAuto) {
        // Same stats — just update the timestamp on the latest entry
        latestAuto.timestamp = now;
        latestAuto.eventId = manifestEvent.id;
        latestAuto.blossomUrl = blossomUrl!;
        if (blossomHash) latestAuto.blossomHash = blossomHash;
        latestAuto.wrappedKey = wrappedKey;
      } else {
        cps.unshift(autoEntry);
      }
      // Keep only last 5 autosaves, preserve any manual checkpoints
      const manualCps = cps.filter(c => !c.dTag?.includes(':auto'));
      const autoCps = cps.filter(c => c.dTag?.includes(':auto')).slice(0, 5);
      const merged = [...manualCps, ...autoCps].sort((a, b) => b.timestamp - a.timestamp);
      setStoredCheckpoints(merged);
      refreshCheckpointsRef.current();

      debugLog('[backup]', 'Auto-save complete');
      return true;
    } catch {
      debugWarn('[backup]', 'Auto-save failed');
      return false;
    } finally {
      isSaving.current = false;
    }
  }, [user, hasUnsavedChanges, deviceId]);

  // Query relays in small batches (2–3 at a time) — stop early when results found.
  // Avoids overwhelming mobile browsers with 10+ simultaneous WebSocket connections.
  // Tracks which relays were used so post-login fetches can prefer the others.
  const queryAll = useCallback(async (filter: { kinds: number[]; authors: string[]; '#d'?: string[]; limit?: number }, label: string, specificRelays?: string[], _checkAll = false, overallTimeoutMs = 15000, perRelayTimeoutMs = 5000): Promise<NostrEvent[]> => {
    const pubkey = user?.pubkey || '';
    const primaryRelays = specificRelays?.map(normalizeRelay) || [];
    const { primary: writePrimary, fallback: writeFallback } = pubkey
      ? getPublishRelays(pubkey)
      : { primary: [], fallback: [] };
    const relayUrls = [...primaryRelays];
    for (const r of [...writePrimary, ...writeFallback]) {
      if (!relayUrls.includes(r)) relayUrls.push(r);
    }

    const activeRelayUrls = relayUrls.filter(url => !isRelayBlocked(url));
    log(`  Checking ${activeRelayUrls.length} relays for ${label} (batches of 3)`);

    const seen = new Set<string>();
    const allEvents: NostrEvent[] = [];
    const overallAbort = new AbortController();
    const overallTimeout = setTimeout(() => overallAbort.abort(), overallTimeoutMs);

    const queryRelay = async (url: string): Promise<NostrEvent[]> => {
      try {
        const relay = new NRelay1(normalizeRelay(url), { backoff: false });
        const signal = AbortSignal.any([AbortSignal.timeout(perRelayTimeoutMs), overallAbort.signal]);
        const events = await relay.query([filter], { signal });
        log(`  ${url}: ${events.length} ${label}`);
        _backupRelaysUsed.add(url);
        try { relay.close(); } catch { /* */ }
        return events;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('abort')) {
          log(`  ${url}: ${msg.includes('aborted') ? 'timeout' : msg}`, 'warn');
        }
        return [];
      }
    };

    // Query relays in batches of 3, stop early once we have results (unless checkAll)
    for (let i = 0; i < activeRelayUrls.length; i += 3) {
      if (overallAbort.signal.aborted) break;
      const batch = activeRelayUrls.slice(i, i + 3);
      const results = await Promise.allSettled(batch.map(queryRelay));
      for (const r of results) {
        if (r.status === 'fulfilled') {
          for (const ev of r.value) {
            if (!seen.has(ev.id)) { seen.add(ev.id); allEvents.push(ev); }
          }
        }
      }
      if (!_checkAll && allEvents.length > 0) break;
    }

    clearTimeout(overallTimeout);
    log(`  Total: ${allEvents.length} unique ${label}`);
    return allEvents;
  }, [log, user]);

   // Check for remote backup (runs on every login/refresh)
   // Check for remote backup (runs on every login/refresh)
   // Set force=true to bypass the "already checked" guard (e.g. user-triggered re-check)
   const checkRemoteBackup = useCallback(async (force = false) => {
     if (!user) {
       log('Check skipped: no user');
       setCheckSettled(true);
       return;
     }

     // Skip if already checked this session (module-level guard persists across remounts) — unless forced
     if (!force && _checkedPubkey === user.pubkey) {
       log('Check skipped: already checked this session');
       // Ensure checkpoints are loaded (React state may have been empty at mount)
       const stored = getStoredCheckpoints();
       if (stored.length > 0 && checkpoints.length === 0) setCheckpoints(stored);
       setCheckSettled(true);
       return;
     }

     // Skip if a file restore just happened (sessionStorage survives reload, unlike memCache)
     if (!force && sessionStorage.getItem('corkboard:skip-backup-check')) {
       log('Check skipped: file restore just happened (sessionStorage flag)');
       sessionStorage.removeItem('corkboard:skip-backup-check');
       _checkedPubkey = user.pubkey;
       const stored = getStoredCheckpoints();
       if (stored.length > 0) setCheckpoints(stored);
       setStatus('idle');
       setCheckSettled(true);
       return;
     }

     // CRITICAL: Wait for IDB memCache to be populated before reading the checked flag.
     // On page reload, memCache is empty until idbReady resolves, so idbGetSync() would
     // return null even if the flag was persisted — causing a double backup check.
     if (!idbReadyChecked.current) {
       log('Waiting for IDB to be ready...');
       await idbReady;
       idbReadyChecked.current = true;
       log('IDB ready, memCache populated');
     }

     // Skip if backup was already checked/restored for this user (persisted across refreshes) — unless forced
     const checkedKey = `${BACKUP_CHECKED_KEY}:${user.pubkey}`;
     if (!force && idbGetSync(checkedKey)) {
       log('Check skipped: backup already checked for this user (flag found after IDB ready)');
       _checkedPubkey = user.pubkey;
       const stored = getStoredCheckpoints();
       if (stored.length > 0) setCheckpoints(stored);
       setStatus('idle');
       setCheckSettled(true);
       return;
     }

    // Log signer diagnostics
    const wn = (globalThis as unknown as { nostr?: { nip44?: unknown } }).nostr;
    log(`Signer: method=${user.method || 'unknown'}, type=${user.signer.constructor.name}, window.nostr=${!!wn}, window.nostr.nip44=${!!wn?.nip44}`);

    log('Checking for remote backup...');
    setStatus('checking');
    setMessage('Checking for backup...');

    // Prevent concurrent calls
    _checkedPubkey = user.pubkey;

    try {
      const pubkey = user.pubkey;

      // Step 0: Fetch user's kind 10002 relay list so we know their write relays.
      // Query discovery relays in batches of 3, stop early once found.
      if (getRelayCache(pubkey).length === 0) {
        setMessage('Finding your relays...');
        log('Fetching kind 10002 relay list from fallback relays...');
        const relayEvents: NostrEvent[] = [];
        const relayResults = await Promise.allSettled(
          FALLBACK_RELAYS.map(async (url) => {
            const relay = new NRelay1(normalizeRelay(url), { backoff: false });
            try {
              const evts = await relay.query(
                [{ kinds: [10002], authors: [pubkey], limit: 1 }],
                { signal: AbortSignal.timeout(6000) }
              );
              return evts;
            } finally {
              try { relay.close(); } catch { /* */ }
            }
          })
        );
        for (const r of relayResults) {
          if (r.status === 'fulfilled') relayEvents.push(...r.value);
        }
        if (relayEvents.length > 0) {
          const best = relayEvents.reduce((a, b) => a.created_at > b.created_at ? a : b);
          const writeRelays: string[] = [];
          for (const tag of best.tags) {
            if (tag[0] === 'r' && tag[1]?.startsWith('wss://')) {
              if (!tag[2] || tag[2] === 'write') writeRelays.push(tag[1]);
            }
          }
          if (writeRelays.length > 0) {
            updateRelayCache(pubkey, writeRelays);
            log(`Found ${writeRelays.length} write relays from kind 10002`);
          }
        }
        setMessage('Checking for backup...');
      }

      // Fetch recent backup manifests — one attempt, try ALL known relays.
      const allEvents = await queryAll(
        { kinds: [30078], authors: [pubkey], limit: 5 },
        'backup manifest events',
        undefined,
        true, // checkAll — query every relay in one pass
        20000,
        8000
      );
      // Filter for backup manifests (d-tag starts with the prefix)
      const manifestEvents = allEvents.filter(ev => {
        const dTag = ev.tags.find(t => t[0] === 'd')?.[1];
        return dTag === D_TAG_PREFIX || dTag?.startsWith(D_TAG_PREFIX + ':');
      });
      log(`Total: ${manifestEvents.length} backup manifest events (from ${allEvents.length} kind:30078, limit 5)`);

      if (manifestEvents.length === 0) {
        log(allEvents.length === 0 ? 'No events returned from relays' : 'No remote backup found');
        idbSetSync(`${BACKUP_CHECKED_KEY}:${user.pubkey}`, 'true');
        markBackupCheckedSync(user.pubkey);
        setStatus('no-backup');
        setCheckSettled(true);
        setMessage('No backup found');
        return;
      }

      // Pick the newest manifest by created_at
      const bestManifestEvent = manifestEvents.reduce((best, ev) =>
        ev.created_at > best.created_at ? ev : best
      );
      log(`Found backup event (created_at: ${bestManifestEvent.created_at})`);

      // Store the raw manifest event for later use
      manifestEventRef.current = bestManifestEvent;

      // Parse all v4 manifest events to rebuild the checkpoint list from relay data.
      // This ensures checkpoints survive logout/login and appear on other devices.
      type ManifestData = { v?: number; chunks?: number; timestamp?: number; keys?: string[]; relays?: string[]; corkboardNames?: string[]; encryption?: string; wrappedKey?: string; signerMethod?: string; blossomUrl?: string; blossomHash?: string; deviceId?: string; stats?: { corkboards: number; savedForLater: number; dismissed: number } };

      const discoveredCheckpoints: RemoteCheckpoint[] = [];
      for (const ev of manifestEvents) {
        let m: ManifestData | null = null;
        try {
          m = JSON.parse(ev.content);
        } catch {
          // Not plaintext — try NIP-44 decrypt (same as scanOlderStates)
          try {
            const json = await Promise.race([
              user.signer.nip44!.decrypt(user.pubkey, ev.content),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('decrypt_timeout')), 3000)),
            ]);
            m = JSON.parse(json);
          } catch { /* decrypt failed or timed out — skip */ }
        }
        if (m && m.blossomUrl && m.wrappedKey && m.signerMethod) {
          const dTag = ev.tags.find(t => t[0] === 'd')?.[1] || '';
          discoveredCheckpoints.push({
            eventId: ev.id,
            dTag,
            timestamp: m.timestamp || ev.created_at,
            blossomUrl: m.blossomUrl,
            ...(m.blossomHash ? { blossomHash: m.blossomHash } : {}),
            wrappedKey: m.wrappedKey,
            signerMethod: (m.signerMethod as 'nip44' | 'nip04'),
            stats: m.stats,
            corkboardNames: m.corkboardNames,
          });
        }
      }

      // Dedup by d-tag: keep only the newest event per d-tag (addressable events replace each other)
      const byDTag = new Map<string, RemoteCheckpoint>();
      for (const cp of discoveredCheckpoints) {
        const key = cp.dTag || cp.eventId;
        const existing = byDTag.get(key);
        if (!existing || cp.timestamp > existing.timestamp) {
          byDTag.set(key, cp);
        }
      }
      const dedupedCheckpoints = [...byDTag.values()];

      // Merge with locally stored checkpoints (preserve user-given names)
      if (dedupedCheckpoints.length > 0) {
        const existing = getStoredCheckpoints();
        const nameMap = new Map(existing.filter(c => c.name).map(c => [c.eventId, c.name!]));
        // Also check names by dTag for renamed autosaves that got a new eventId
        for (const c of existing) { if (c.name && c.dTag) nameMap.set(c.dTag, c.name); }
        // Deduplicate by eventId, prefer discovered (fresh from relay)
        const merged = new Map<string, RemoteCheckpoint>();
        for (const cp of dedupedCheckpoints) {
          if (nameMap.has(cp.eventId)) cp.name = nameMap.get(cp.eventId);
          else if (cp.dTag && nameMap.has(cp.dTag)) cp.name = nameMap.get(cp.dTag);
          merged.set(cp.eventId, cp);
        }
        // Add any local-only checkpoints — but skip if a newer version with same dTag was discovered
        const discoveredDTags = new Set(dedupedCheckpoints.map(c => c.dTag).filter(Boolean));
        for (const cp of existing) {
          if (!merged.has(cp.eventId) && !(cp.dTag && discoveredDTags.has(cp.dTag))) {
            merged.set(cp.eventId, cp);
          }
        }
        const sorted = [...merged.values()].sort((a, b) => b.timestamp - a.timestamp);
        setStoredCheckpoints(sorted);
        const deduped = getStoredCheckpoints();
        setCheckpoints(deduped);
        log(`Checkpoints: ${sorted.length} → ${deduped.length} after dedup (${discoveredCheckpoints.length} from relays, ${dedupedCheckpoints.length} unique d-tags, ${existing.length} local)`);
      }

      // Parse the best (newest) manifest for the restore flow
      let manifest: ManifestData | null = null;

      // New format: manifest is plaintext JSON
      try {
        manifest = JSON.parse(bestManifestEvent.content);
        manifestDataRef.current = manifest;
        log(`Manifest (plaintext): v=${manifest!.v}, chunks=${manifest!.chunks}, ts=${manifest!.timestamp}, relays=${manifest!.relays?.length || 'none'}`);
      } catch {
        // Old format: manifest is NIP-44 encrypted
        log('Manifest is not plaintext JSON, trying NIP-44 decrypt...');
        try {
          const manifestJson = await Promise.race([
            user.signer.nip44!.decrypt(pubkey, bestManifestEvent.content),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('decrypt_timeout')), 5000)),
          ]);
          manifest = JSON.parse(manifestJson);
          manifestDataRef.current = manifest;
          log(`Manifest (decrypted): v=${manifest!.v}, chunks=${manifest!.chunks}, ts=${manifest!.timestamp}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(msg === 'decrypt_timeout'
            ? 'Old encrypted manifest — signer timed out. Make a fresh backup from desktop.'
            : `Decrypt failed: ${msg}`, 'warn');
        }
      }

      const ago = formatTimeAgo(bestManifestEvent.created_at);

      if (manifest) {
        const stats = manifest.stats || undefined;
        if (stats) {
          log(`Stats: ${stats.corkboards} corkboards, ${stats.savedForLater} saved, ${stats.dismissed} dismissed`);
        }
        if (manifest.corkboardNames?.length) {
          log(`Corkboards: ${manifest.corkboardNames.join(', ')}`);
        }
        setRemoteBackup({
          timestamp: manifest.timestamp || bestManifestEvent.created_at,
          keys: manifest.keys || [],
          chunks: manifest.chunks || 1,
          encryption: manifest.encryption || 'nip44',
          relays: manifest.relays || undefined,
          corkboardNames: manifest.corkboardNames || undefined,
          stats: stats ? { corkboards: stats.corkboards, savedForLater: stats.savedForLater, dismissed: stats.dismissed } : undefined,
        });
      } else {
        // Couldn't read manifest at all — still show that a backup exists
        setRemoteBackup({
          timestamp: bestManifestEvent.created_at,
          keys: [],
          chunks: 1,
          stats: undefined,
        });
      }

      // If local data already exists (corkboards, dismissed notes), this is likely
      // a storage eviction scenario — the browser cleared localStorage/IDB flags but
      // the user's actual data survived. Auto-dismiss instead of blocking with splash.
      const localFeeds = idbGetSync('nostr-custom-feeds');
      const hasLocalData = localFeeds && localFeeds !== '[]' && localFeeds !== 'null';
      if (hasLocalData && !force) {
        log('Local data exists — auto-dismissing (likely storage eviction)');
        _checkedPubkey = user.pubkey;
        idbSetSync(`${BACKUP_CHECKED_KEY}:${user.pubkey}`, 'true');
        markBackupCheckedSync(user.pubkey);
        setStatus('idle');
        setCheckSettled(true);
        return;
      }

      log(`Found restore point from ${ago}`);
      setStatus('found');
      setCheckSettled(true);
      setMessage(`Restore point from ${ago}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('Check failed: ' + errMsg, 'error');
      setStatus('idle');
      setCheckSettled(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- checkpoints declared after this hook (forward ref); deviceId is stable useState
  }, [user, queryAll, log, deviceId]);

  // Load remote backup
  const loadRemoteBackup = useCallback(async () => {
    if (!user || !remoteBackup) {
      log('Restore skipped: ' + (!user ? 'no user' : 'no remote backup'));
      return;
    }
    if (isRestoring.current) {
      log('Restore skipped: already restoring');
      return;
    }
    isRestoring.current = true;

    setStatus('restoring');
    setMessage('Restoring backup...');

    try {
      const pubkey = user.pubkey;
      let backup = remoteBackup;

      // Use the decrypted manifest data (cached during checkRemoteBackup)
      const manifest = manifestDataRef.current as Record<string, unknown> | null;

      // If manifest has more data than remoteBackup, merge it
      if (manifest && !backup.relays) {
        backup = {
          timestamp: (manifest.timestamp as number) || backup.timestamp,
          keys: (manifest.keys as string[]) || [],
          chunks: (manifest.chunks as number) || 1,
          encryption: (manifest.encryption as string) || 'nip44',
          relays: (manifest.relays as string[]) || undefined,
          corkboardNames: (manifest.corkboardNames as string[]) || undefined,
          stats: backup.stats,
        };
        setRemoteBackup(backup);
      }

      const isV4Blossom = manifest && (manifest.v as number) >= 4 && manifest.blossomUrl;

      let fullJson: string;

      if (isV4Blossom) {
        // v4: download single encrypted file from Blossom, decrypt locally
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = manifest as any;
        log(`Restoring v4 backup from Blossom: ${m.blossomUrl}`);
        setMessage('Downloading backup from Blossom...');

        // Try primary URL, then fallback to other Blossom servers using hash
        let encryptedData: string | null = null;
        const urls = [m.blossomUrl as string];
        if (m.blossomHash) {
          for (const server of getActiveBlossomServers()) {
            const fallbackUrl = `${server.replace(/\/$/, '')}/${m.blossomHash}`;
            if (fallbackUrl !== m.blossomUrl) urls.push(fallbackUrl);
          }
        }
        for (const url of urls) {
          try {
            setMessage(`Downloading from ${new URL(url).hostname}...`);
            const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!response.ok) { log(`  ${url}: HTTP ${response.status}`, 'warn'); continue; }
            encryptedData = await response.text();
            log(`Downloaded: ${encryptedData.length} chars from ${new URL(url).hostname}`);
            break;
          } catch (err) {
            log(`  ${url}: ${err instanceof Error ? err.message : err}`, 'warn');
          }
        }
        if (!encryptedData) throw new Error('Could not download backup from any Blossom server');

        // Verify Blossom hash if present in manifest (v4+ integrity check)
        if (m.blossomHash) {
          const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encryptedData));
          const computed = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
          if (computed !== m.blossomHash) {
            throw new Error('Backup integrity check failed — downloaded data does not match stored hash. The file may be corrupted or tampered with.');
          }
          log('Blossom hash verified');
        }

        // Unwrap AES key
        if (!m.wrappedKey) throw new Error('Manifest missing wrappedKey');
        const sm = m.signerMethod || 'nip44';
        log(`Unwrapping AES key via ${sm}...`);
        setMessage('Decrypting key via signer...');
        const aesKeyHex = sm === 'nip04'
          ? await user.signer.nip04!.decrypt(pubkey, m.wrappedKey)
          : await user.signer.nip44!.decrypt(pubkey, m.wrappedKey);

        const aesRaw = hexToRawKey(aesKeyHex);
        const aesKey = await importAesKey(aesRaw);

        log('Decrypting backup...');
        setMessage('Decrypting backup...');
        fullJson = await aesDecrypt(aesKey, encryptedData);
        log(`Decrypted: ${fullJson.length} chars`);
      } else {
        // v1-v3: fetch chunks from relays
        log(`Restoring: ${backup.chunks} chunks, relays=${backup.relays?.join(', ') || 'none'}`);

        const chunkDTags: string[] = [];
        for (let i = 0; i < backup.chunks; i++) {
          chunkDTags.push(`${D_TAG_PREFIX}:${i}`);
        }
        log(`Fetching ${chunkDTags.length} chunks...`);

        const chunkEvents = await queryAll(
          { kinds: [30078], authors: [pubkey], '#d': chunkDTags, limit: chunkDTags.length * 2 },
          'chunk events',
          backup.relays
        );
        log(`Total: ${chunkEvents.length} chunk events`);

        const chunkMap = new Map<string, NostrEvent>();
        for (const ev of chunkEvents) {
          const dTag = ev.tags.find(t => t[0] === 'd')?.[1];
          if (!dTag) continue;
          const existing = chunkMap.get(dTag);
          if (!existing || ev.created_at > existing.created_at) {
            chunkMap.set(dTag, ev);
          }
        }

        const missingChunks: number[] = [];
        for (let i = 0; i < backup.chunks; i++) {
          if (!chunkMap.has(`${D_TAG_PREFIX}:${i}`)) missingChunks.push(i);
        }

        log(`Got ${chunkMap.size}/${backup.chunks} chunks`);
        if (missingChunks.length > 0) {
          log('Missing chunks: ' + missingChunks.join(', '), 'error');
          setStatus('restore-error');
          setMessage(`Restore failed: missing chunks ${missingChunks.join(', ')}`);
          return;
        }

        const encryption = backup.encryption || 'nip44';
        log(`Decrypt method: ${encryption}`);

        const decryptedParts: string[] = [];

        if (encryption === 'aes-gcm') {
          const mf = manifest as Record<string, string> | null;
          if (!mf?.wrappedKey) throw new Error('Manifest missing wrappedKey');
          const sm = mf.signerMethod || 'nip44';
          log(`Unwrapping AES key via ${sm}...`);
          setMessage('Decrypting key via signer...');
          const aesKeyHex = sm === 'nip04'
            ? await user.signer.nip04!.decrypt(pubkey, mf.wrappedKey)
            : await user.signer.nip44!.decrypt(pubkey, mf.wrappedKey);

          const aesRaw = hexToRawKey(aesKeyHex);
          const aesKey = await importAesKey(aesRaw);

          for (let i = 0; i < backup.chunks; i++) {
            const ev = chunkMap.get(`${D_TAG_PREFIX}:${i}`)!;
            setMessage(`Decrypting chunk ${i + 1}/${backup.chunks}...`);
            try {
              const decrypted = await aesDecrypt(aesKey, ev.content);
              decryptedParts.push(decrypted);
            } catch (chunkErr) {
              const name = (chunkErr as DOMException).name || '';
              throw new Error(`Chunk ${i} decryption failed (${name}). The backup may need to be re-saved.`);
            }
          }
        } else {
          for (let i = 0; i < backup.chunks; i++) {
            const ev = chunkMap.get(`${D_TAG_PREFIX}:${i}`)!;
            setMessage(`Decrypting chunk ${i + 1}/${backup.chunks} via signer...`);
            const decrypted = encryption === 'nip04'
              ? await user.signer.nip04!.decrypt(pubkey, ev.content)
              : await user.signer.nip44!.decrypt(pubkey, ev.content);
            decryptedParts.push(decrypted);
          }
        }

        fullJson = decryptedParts.join('');
        log(`Reassembled: ${fullJson.length} chars`);
      }

      // Validate JSON before writing
      try {
        JSON.parse(fullJson);
      } catch (parseErr) {
        const pos = (parseErr instanceof SyntaxError && parseErr.message.match(/position (\d+)/))
          ? parseInt(parseErr.message.match(/position (\d+)/)![1])
          : -1;
        if (pos >= 0) {
          const around = fullJson.slice(Math.max(0, pos - 50), pos + 50);
          log(`JSON error at position ${pos}. Context: ...${around}...`, 'error');
        }
        throw new Error('Backup data is corrupt. Make a fresh backup from your computer first, then restore.');
      }

      const restoredCount = await deserializeBackup(fullJson, log);

      log(`Written to IDB: ${restoredCount} keys`);

      idbSetSync(LAST_BACKUP_TS_KEY, String(backup.timestamp));
      idbSetSync(LAST_CHUNK_COUNT_KEY, String(backup.chunks));
      setLastBackupTs(backup.timestamp);

      // Store snapshot of restored data for change detection
      const snapshot: Record<string, string> = {};
      for (const key of SNAPSHOT_KEYS) snapshot[key] = idbGetSync(key) || '';
      idbSetSync('corkboard:last-backup-data', JSON.stringify(snapshot));

      // Mark as checked so future checks skip
      markBackupCheckedSync(user.pubkey);
      await Promise.all([
        idbSet(`${BACKUP_CHECKED_KEY}:${user.pubkey}`, 'true'),
        idbSet('corkboard:active-user-pubkey', user.pubkey),
      ]);

      setStatus('restored');
      setMessage(`Restored ${restoredCount} keys`);
      log('Restore complete');
      // Resume auto-save after a brief flash of "restored" status
      setTimeout(() => setStatus('idle'), 3000);
    } catch (err) {
      const errMsg = err instanceof Error
        ? (err.message || (err as DOMException).name || err.constructor.name)
        : String(err);
      log('Restore failed: ' + errMsg, 'error');
      setStatus('restore-error');
      setMessage('Restore failed: ' + errMsg);
    } finally {
      isRestoring.current = false;
    }
  }, [user, queryAll, remoteBackup, log]);

  const dismissRemoteBackup = useCallback(() => {
    setRemoteBackup(null);
    manifestEventRef.current = null;
    manifestDataRef.current = null;
    setStatus('idle');
    setMessage('');
    // Mark as checked so we don't prompt again
    if (user) {
      idbSetSync(`${BACKUP_CHECKED_KEY}:${user.pubkey}`, 'true');
      markBackupCheckedSync(user.pubkey);
    }
  }, [user]);

  // ── Checkpoint management (Blossom backups) ───────────────────────────────

  const [checkpoints, setCheckpoints] = useState<RemoteCheckpoint[]>(getStoredCheckpoints);
  // Refresh local state after save
  const refreshCheckpoints = useCallback(() => setCheckpoints(getStoredCheckpoints()), []);
  refreshCheckpointsRef.current = refreshCheckpoints;

  // On old devices the IDB migration may not have finished when useState
  // initializes above (memCache is still empty → returns []).  Re-read
  // once idbReady resolves so checkpoints and stats are correct.
  useEffect(() => { idbReady.then(() => setCheckpoints(getStoredCheckpoints())); }, []);

  const renameCheckpointFn = useCallback((index: number, name: string) => {
    const cps = getStoredCheckpoints();
    if (index >= 0 && index < cps.length) {
      cps[index].name = name;
      setStoredCheckpoints(cps);
      setCheckpoints(getStoredCheckpoints());
    }
  }, []);

  const deleteCheckpointFn = useCallback((eventId: string) => {
    const cps = getStoredCheckpoints();
    const idx = cps.findIndex(c => c.eventId === eventId);
    if (idx < 0) return;
    const cp = cps[idx];

    // Update local state immediately (optimistic)
    cps.splice(idx, 1);
    setStoredCheckpoints(cps);
    setCheckpoints(getStoredCheckpoints());

    // Publish NIP-09 deletion event in the background (best effort)
    if (user) {
      (async () => {
        try {
          const delEvent = await user.signer.signEvent({
            kind: 5,
            content: 'checkpoint deleted',
            tags: [['e', cp.eventId], ['a', `30078:${user.pubkey}:${cp.dTag}`]],
            created_at: Math.floor(Date.now() / 1000),
          });
          const { primary, fallback } = getPublishRelays(user.pubkey);
          for (const url of [...primary, ...fallback].slice(0, 5)) {
            const relay = new NRelay1(url, { backoff: false });
            try { await relay.event(delEvent, { signal: AbortSignal.timeout(5000) }); }
            catch { /* best effort */ }
            finally { try { relay.close(); } catch { /* */ } }
          }
        } catch { /* best effort */ }
      })();
    }
  }, [user]);

  const loadCheckpointFn = useCallback(async (cp: RemoteCheckpoint) => {
    if (!user) return;
    setStatus('restoring');
    setMessage('Saving current state before restoring...');

    // If current state is newer than the checkpoint being restored,
    // auto-save it as a checkpoint first so it's not lost
    const currentTs = parseInt(idbGetSync(LAST_BACKUP_TS_KEY) || '0', 10);
    if (currentTs > cp.timestamp && hasUnsavedChanges()) {
      try {
        log('Current state is newer than checkpoint — auto-saving before restore...');
        await autoSaveBackup();
        log('Pre-restore auto-save complete');
      } catch (err) {
        log('Pre-restore auto-save failed (continuing): ' + (err instanceof Error ? err.message : err), 'warn');
      }
    }

    setMessage('Restoring from checkpoint...');

    try {
      // Try the original Blossom URL first, then fall back to other servers using the hash
      let encryptedData: string | null = null;
      const urls = [cp.blossomUrl];
      // If we have a hash, construct fallback URLs on other Blossom servers
      if (cp.blossomHash) {
        for (const server of getActiveBlossomServers()) {
          const fallbackUrl = `${server.replace(/\/$/, '')}/${cp.blossomHash}`;
          if (fallbackUrl !== cp.blossomUrl) urls.push(fallbackUrl);
        }
      }
      for (const url of urls) {
        try {
          log(`Fetching checkpoint from ${url}...`);
          setMessage(`Downloading from ${new URL(url).hostname}...`);
          const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!resp.ok) { log(`  ${url}: HTTP ${resp.status}`, 'warn'); continue; }
          encryptedData = await resp.text();
          break;
        } catch (err) {
          log(`  ${url}: ${err instanceof Error ? err.message : err}`, 'warn');
        }
      }
      if (!encryptedData) throw new Error('Could not download backup from any Blossom server');

      log('Decrypting...');
      const aesRaw = await hexToRawKey(
        cp.signerMethod === 'nip44'
          ? await user.signer.nip44!.decrypt(user.pubkey, cp.wrappedKey)
          : await user.signer.nip04!.decrypt(user.pubkey, cp.wrappedKey)
      );
      const aesKey = await importAesKey(aesRaw);
      const json = await aesDecrypt(aesKey, encryptedData);

      const restoredCount = await deserializeBackup(json, log);
      log(`Checkpoint restored: ${restoredCount} keys`);

      // Store snapshot of restored data for change detection
      const cpSnapshot: Record<string, string> = {};
      for (const key of SNAPSHOT_KEYS) cpSnapshot[key] = idbGetSync(key) || '';
      idbSetSync('corkboard:last-backup-data', JSON.stringify(cpSnapshot));

      // Move this checkpoint to the top so it becomes the "most recent" for auto-restore
      const cps = getStoredCheckpoints();
      const idx = cps.findIndex(c => c.eventId === cp.eventId);
      if (idx > 0) {
        const [moved] = cps.splice(idx, 1);
        cps.unshift(moved);
        setStoredCheckpoints(cps);
      }

      idbSetSync(LAST_BACKUP_TS_KEY, String(cp.timestamp));
      idbSetSync('corkboard:preferred-checkpoint', cp.eventId);
      setLastBackupTs(cp.timestamp);

      markBackupCheckedSync(user.pubkey);
      await Promise.all([
        idbSet(`${BACKUP_CHECKED_KEY}:${user.pubkey}`, 'true'),
        idbSet('corkboard:active-user-pubkey', user.pubkey),
      ]);

      setStatus('restored');
      setMessage(`Restored ${restoredCount} keys`);
      log('Restore complete');
      // Resume auto-save after a brief flash of "restored" status
      setTimeout(() => setStatus('idle'), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('Checkpoint restore failed: ' + msg, 'error');
      setStatus('restore-error');
      setMessage('Restore failed: ' + msg);
    }
  }, [user, log, autoSaveBackup, hasUnsavedChanges]);

  // Single check on login — one attempt, all relays, no retries.
  // Shows splash with tips while checking. If a checkpoint is found,
  // MultiColumnClient auto-restores the best one.
  useEffect(() => {
    if (!user) return;
    checkRemoteBackup();
  }, [user, checkRemoteBackup]);

  // Refresh checkpoints list after save completes
  useEffect(() => {
    if (status === 'saved') refreshCheckpoints();
  }, [status, refreshCheckpoints]);

  // Download plaintext backup as a JSON file — no encryption, for emergency recovery.
  const downloadBackupAsFile = useCallback(() => {
    const json = serializeBackup();
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `corkboard-backup-${date}.json`);
    URL.revokeObjectURL(url);
  }, []);

  // Scan relays for ALL backup events (not just the latest) — discovers older states
  const [isScanning, setIsScanning] = useState(false);
  const scanOlderStates = useCallback(async () => {
    if (!user || isScanning) return;
    setIsScanning(true);
    log('Scanning relays for older backup states...');
    // Ensure memCache is populated before reading stored checkpoints
    await idbReady;
    try {
      const events = await queryAll(
        { kinds: [30078], authors: [user.pubkey], limit: 50 },
        'all backup manifests',
        undefined,
        true, // checkAll — query every relay
        20000,
        8000,
      );
      const manifests = events.filter(ev => {
        const dTag = ev.tags.find(t => t[0] === 'd')?.[1];
        return dTag === D_TAG_PREFIX || dTag?.startsWith(D_TAG_PREFIX + ':');
      });
      log(`Found ${manifests.length} total backup manifests`);

      if (manifests.length > 0) {
        const discovered: RemoteCheckpoint[] = [];
        for (const ev of manifests) {
          let m: Record<string, unknown> | null = null;
          try { m = JSON.parse(ev.content); } catch {
            try {
              const json = await user.signer.nip44!.decrypt(user.pubkey, ev.content);
              m = JSON.parse(json);
            } catch { continue; }
          }
          if (!m) continue;
          discovered.push({
            eventId: ev.id,
            dTag: ev.tags.find(t => t[0] === 'd')?.[1] || '',
            timestamp: (m.timestamp as number) || ev.created_at,
            blossomUrl: (m.blossomUrl as string) || '',
            blossomHash: m.blossomHash as string | undefined,
            wrappedKey: (m.wrappedKey as string) || '',
            signerMethod: (m.signerMethod as 'nip44' | 'nip04') || 'nip44',
            stats: m.stats as RemoteCheckpoint['stats'],
            corkboardNames: m.corkboardNames as string[] | undefined,
          });
        }
        // Merge discovered with existing checkpoints
        const existing = getStoredCheckpoints();
        const all = [...existing, ...discovered];
        // setStoredCheckpoints handles d-tag + stats dedup automatically
        setStoredCheckpoints(all);
        const result = getStoredCheckpoints();
        setCheckpoints(result);
        log(`Discovered: ${discovered.length}, existing: ${existing.length} → ${result.length} after dedup`);
      }
    } catch (err) {
      log('Scan failed: ' + (err instanceof Error ? err.message : String(err)), 'warn');
    } finally {
      setIsScanning(false);
    }
  }, [user, isScanning, queryAll, log]);

  return {
    backupStatus: status,
    backupCheckSettled: checkSettled,
    backupMessage: message,
    remoteBackup,
    loadRemoteBackup,
    dismissRemoteBackup,
    saveBackup,
    autoSaveBackup,
    downloadBackupAsFile,
    checkRemoteBackup,
    logs,
    lastBackupTs,
    hasUnsavedChanges,
    // Checkpoint management
    checkpoints,
    renameCheckpoint: renameCheckpointFn,
    deleteCheckpoint: deleteCheckpointFn,
    loadCheckpoint: loadCheckpointFn,
    scanOlderStates,
    isScanning,
  };
}

// Clear backup checked flag for a user (call on logout)
export function clearBackupChecked(pubkey: string): void {
  idbRemoveSync(`${BACKUP_CHECKED_KEY}:${pubkey}`);
  clearBackupCheckedSync(pubkey);
}

// Clear all backup checked flags (call when switching accounts)
// Returns a Promise because key enumeration requires async IDB access.
export async function clearAllBackupChecked(): Promise<void> {
  const prefix = BACKUP_CHECKED_KEY + ':';
  const allKeys = await idbKeys();
  for (const key of allKeys) {
    if (key.startsWith(prefix)) {
      idbRemoveSync(key);
    }
  }
}

export { BACKED_UP_KEYS };
