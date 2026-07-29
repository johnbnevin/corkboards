/**
 * useNostrBackup — encrypted cloud backup and restore for mobile.
 *
 * Port of packages/web/src/hooks/useNostrBackup.ts.
 * Platform differences:
 *   - Uses MMKV (synchronous) instead of IndexedDB
 *   - Blossom upload via fetch PUT (no File/Blob Web API)
 *   - Auto-save/sync orchestration lives in AutoSaveManager (web:
 *     useAutoSaveTrigger + useCloudSync)
 *
 * Architecture (identical to web):
 *   1. Serialize BACKED_UP_KEYS from MMKV → JSON
 *   2. AES-256-GCM encrypt with random key
 *   3. Upload encrypted blob to Blossom server (kind 24242 auth)
 *   4. Publish NIP-78 kind 30078 manifest with Blossom URL + wrapped AES key
 *   5. Restore: find manifest → unwrap AES key → download + decrypt → write to MMKV
 */
import { useState, useCallback, useRef } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import type { NSecSigner, NConnectSigner } from '@nostrify/nostrify';

// Backup operations only require signEvent + nip04/nip44 encrypt/decrypt,
// which both NSecSigner and NConnectSigner provide.
type BackupSigner = NSecSigner | NConnectSigner;
import { mobileStorage, isStorageHealthy } from '../storage/MmkvStorage';
import { BACKED_UP_KEYS, STORAGE_KEYS } from '../lib/storageKeys';
import { FALLBACK_RELAYS, getUserRelays, getRelayCache, createRelayFresh } from '../lib/NostrProvider';
import {
  importAesKey, aesDecrypt, hexToRawKey, encryptForSelf,
} from '../lib/nostrEncrypt';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { normalizeRelay } from '@core/normalizeRelay';
import { randomUuid } from '@core/cryptoUtils';

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
  corkboardNames?: string[];
  name?: string;
}

const D_TAG_PREFIX = 'corkboard:backup';
// Bounded ring for manual saves — same slots as web (`s0`..`s{N-1}`), so relay
// storage stays capped and every platform's sync check can query the same tags.
const MANUAL_BACKUP_SLOTS = 5;
import {
  mergeState,
  hasLocalContributions,
  STATE_FORMAT_VERSION,
  type StateSnapshot,
  type MergeResult,
  type TombstoneMap,
} from '@core/stateMerge';
import { SILENT_REMOVAL_LIMIT } from '@core/cacheConfig';
import {
  getTombstones,
  mergeInTombstones,
  serializeTombstones,
  TOMBSTONE_STORAGE_KEY,
} from '@core/tombstones';
import { withoutTombstoneRecording } from '../storage/MmkvStorage';

const LAST_BACKUP_TS_KEY = STORAGE_KEYS.LAST_BACKUP_TS;
const CHECKPOINTS_KEY = STORAGE_KEYS.REMOTE_CHECKPOINTS;

/**
 * Cache of DECRYPTED manifest JSON keyed by manifest event id (immutable
 * content, so cache-forever is safe). Manifests are NIP-44 encrypted since
 * 0.8.1; without this cache every discovery pass paid a signer decrypt per
 * manifest — a network round-trip on NIP-46 logins. Parity with web.
 */
const MANIFEST_PLAIN_CACHE_KEY = 'corkboard:manifest-plain-cache';
const MANIFEST_CACHE_MAX = 40;

function readManifestCache(): Record<string, string> {
  try {
    const raw = mobileStorage.getSync(MANIFEST_PLAIN_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

function getCachedManifestJson(eventId: string): string | null {
  return readManifestCache()[eventId] ?? null;
}

function cacheManifestJson(eventId: string, json: string): void {
  const cache = readManifestCache();
  cache[eventId] = json;
  const ids = Object.keys(cache);
  if (ids.length > MANIFEST_CACHE_MAX) {
    for (const old of ids.slice(0, ids.length - MANIFEST_CACHE_MAX)) delete cache[old];
  }
  mobileStorage.setSync(MANIFEST_PLAIN_CACHE_KEY, JSON.stringify(cache));
}

// Relay blacklist — persists across sessions (mirrors web)
const BLOCKED_RELAYS_KEY = 'corkboard:blocked-relays';

export function getBlockedRelays(): Set<string> {
  const stored = mobileStorage.getSync(BLOCKED_RELAYS_KEY);
  return stored ? new Set(JSON.parse(stored)) : new Set();
}

export function blockRelay(url: string): void {
  const normalized = url.endsWith('/') ? url : url + '/';
  const blocked = getBlockedRelays();
  blocked.add(normalized);
  mobileStorage.setSync(BLOCKED_RELAYS_KEY, JSON.stringify(Array.from(blocked)));
}

export function isRelayBlocked(url: string): boolean {
  const normalized = url.endsWith('/') ? url : url + '/';
  return getBlockedRelays().has(normalized);
}

// Default blossom servers for backup file upload. blossom.band is excluded
// because it rejects text/octet-stream blobs (HTTP 415). Servers that turn out
// to reject the blob type at runtime are flagged (markBlobRejectingServer) and
// skipped by getActiveBlossomServers.
export const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.primal.net/',
  'https://blossom.nostr.build/',
  'https://blossom.yakihonne.com/',
  'https://blossom.ditto.pub/',
];

const BLOSSOM_SERVERS_KEY = STORAGE_KEYS.BLOSSOM_SERVERS;
const BLOSSOM_BLOB_REJECTS_KEY = STORAGE_KEYS.BLOSSOM_BLOB_REJECTS;
// Aim for this many independent Blossom copies of each backup blob (redundancy).
const REDUNDANT_COPIES = 3;

function normalizeServer(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

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

// created_at of the kind-10063 event the stored blossom list was last synced
// from (0 if only ever from local edits / defaults / a backup). Used for
// newer-wins reconciliation on login. Keep in sync with web's useNostrBackup.
const BLOSSOM_SERVERS_TS_KEY = STORAGE_KEYS.BLOSSOM_SERVERS_UPDATED_AT;

export function getBlossomServersUpdatedAt(): number {
  const raw = mobileStorage.getSync(BLOSSOM_SERVERS_TS_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

export function setBlossomServersUpdatedAt(ts: number): void {
  mobileStorage.setSync(BLOSSOM_SERVERS_TS_KEY, String(ts));
}

/**
 * Servers that have rejected the backup-blob content type (HTTP 415). They still
 * work for image/media uploads (separate path), but are useless for the backup
 * blob, so we skip them on save and surface them in Settings.
 */
export function getBlobRejectingServers(): Set<string> {
  const stored = mobileStorage.getSync(BLOSSOM_BLOB_REJECTS_KEY);
  if (!stored) return new Set();
  try {
    const arr = JSON.parse(stored);
    return Array.isArray(arr) ? new Set(arr.map(normalizeServer)) : new Set();
  } catch { return new Set(); }
}

export function markBlobRejectingServer(url: string): void {
  const set = getBlobRejectingServers();
  const norm = normalizeServer(url);
  if (!set.has(norm)) {
    set.add(norm);
    mobileStorage.setSync(BLOSSOM_BLOB_REJECTS_KEY, JSON.stringify(Array.from(set)));
  }
}

export function clearBlobRejectingServer(url: string): void {
  const set = getBlobRejectingServers();
  if (set.delete(normalizeServer(url))) {
    mobileStorage.setSync(BLOSSOM_BLOB_REJECTS_KEY, JSON.stringify(Array.from(set)));
  }
}

export function isBlobRejectingServer(url: string): boolean {
  return getBlobRejectingServers().has(normalizeServer(url));
}

// Skips servers known to reject the blob type; falls back to the full list if
// that would leave nothing (flags may be stale / network may have changed).
function getActiveBlossomServers(): string[] {
  const all = getBlossomServers();
  const rejects = getBlobRejectingServers();
  const usable = all.filter(s => !rejects.has(normalizeServer(s)));
  return usable.length > 0 ? usable : all;
}

/** Result of an auto-save attempt — lets callers show accurate messaging. */
export type AutoSaveResult = 'saved' | 'skipped' | 'no-servers' | 'error';


// Exported so AutoSaveManager can read the fresh list straight from storage
// right after a check, without racing React state propagation.
export function getStoredCheckpoints(): RemoteCheckpoint[] {
  const raw = mobileStorage.getSync(CHECKPOINTS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function setStoredCheckpoints(cps: RemoteCheckpoint[]): void {
  // Dedup by d-tag only — addressable events replace each other, keep newest per tag.
  const byDTag = new Map<string, RemoteCheckpoint>();
  for (const cp of cps) {
    const key = cp.dTag || cp.eventId;
    const existing = byDTag.get(key);
    if (!existing || cp.timestamp > existing.timestamp) {
      byDTag.set(key, cp);
    }
  }
  const sorted = [...byDTag.values()].sort((a, b) => b.timestamp - a.timestamp);
  // Keep max 3 total: always preserve named (user-created) checkpoints
  const named = sorted.filter(c => c.name);
  const unnamed = sorted.filter(c => !c.name);
  const trimmed = [...named, ...unnamed.slice(0, Math.max(0, 3 - named.length))].sort((a, b) => b.timestamp - a.timestamp);
  mobileStorage.setSync(CHECKPOINTS_KEY, JSON.stringify(trimmed));
}

// Keys checked for change detection — subset of BACKED_UP_KEYS that
// represent meaningful user data (mirrors web's SNAPSHOT_KEYS).
const SNAPSHOT_KEYS = [
  'nostr-custom-feeds', 'collapsed-notes', 'dismissed-notes', 'nostr-friends',
  'nostr-browse-relays', 'nostr-rss-feeds', 'saved-minimized-notes',
  'corkboard:tab-filters', 'corkboard:onboarding-skipped',
  'corkboard:banner-height-pct', 'corkboard:banner-fit-mode',
] as const;

/**
 * Detect whether any backed-up key has changed since the last snapshot.
 *
 * Divergence from web (intentional): web uses `fnv1a32` from `@core/hashCore`
 * to compare hashes stored in a small companion key, because its full snapshot
 * lives in an IDB key excluded from the in-memory cache (size-prohibitive).
 * Mobile's MMKV is mmap-backed and synchronous, so reading the full snapshot
 * blob is free — direct string equality is simpler and equally correct.
 */
function hasUnsavedChanges(): boolean {
  const saved = mobileStorage.getSync(STORAGE_KEYS.LAST_BACKUP_DATA);
  if (!saved) {
    const feeds = mobileStorage.getSync('nostr-custom-feeds');
    const dismissed = mobileStorage.getSync('dismissed-notes');
    const collapsed = mobileStorage.getSync('collapsed-notes');
    const onboardingSkipped = mobileStorage.getSync('corkboard:onboarding-skipped');
    return !!((feeds && feeds !== '[]') || (dismissed && dismissed !== '[]') || (collapsed && collapsed !== '[]') || onboardingSkipped === 'true');
  }
  try {
    const lastData = JSON.parse(saved);
    for (const key of SNAPSHOT_KEYS) {
      if ((mobileStorage.getSync(key) || '') !== (lastData[key] || '')) return true;
    }
    return false;
  } catch {
    return parseInt(mobileStorage.getSync(LAST_BACKUP_TS_KEY) || '0', 10) === 0;
  }
}

/**
 * Persist the change-detection baseline. With no argument the baseline is the
 * current local state ("everything is saved"). After a pull-merge where local
 * contributed content the cloud lacks, pass the REMOTE snapshot's keys instead:
 * the local-only content then reads as unsaved and the auto-save trigger pushes
 * the union — baselining the merged state was why local-only work sat unpushed
 * until the next unrelated edit.
 */
function saveSnapshot(baselineKeys?: Record<string, string | null>): void {
  const snapshot: Record<string, string> = {};
  for (const key of SNAPSHOT_KEYS) {
    snapshot[key] = baselineKeys
      ? (baselineKeys[key] ?? '')
      : (mobileStorage.getSync(key) || '');
  }
  mobileStorage.setSync(STORAGE_KEYS.LAST_BACKUP_DATA, JSON.stringify(snapshot));
}

function parseIdArr(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((s: unknown): s is string => typeof s === 'string') : [];
  } catch { return []; }
}

/** Count saved notes = union of collapsed-notes + nostr-bookmark-ids (matches web) */
function savedNoteCount(): number {
  const collapsed = parseIdArr(mobileStorage.getSync('collapsed-notes'));
  const bookmarks = parseIdArr(mobileStorage.getSync('nostr-bookmark-ids'));
  return new Set([...collapsed, ...bookmarks]).size;
}

/**
 * Serialize all backed-up keys, plus the metadata a merge needs (v5).
 * Mirrors packages/web/src/hooks/useNostrBackup.ts — keep the two in step, or
 * a snapshot written on one platform can't be merged correctly on the other.
 */
function serializeBackup(): string {
  const keys: Record<string, string | null> = {};
  for (const key of BACKED_UP_KEYS) {
    keys[key] = mobileStorage.getSync(key);
  }
  return JSON.stringify({
    v: STATE_FORMAT_VERSION,
    savedAt: Math.floor(Date.now() / 1000),
    keys,
    tombstones: getTombstones(),
  });
}

/** Read either format. A v4 blob is a bare key map with no timestamp. */
function parseBackup(json: string): StateSnapshot {
  const parsed = JSON.parse(json);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'keys' in parsed) {
    const env = parsed as { savedAt?: number; keys: Record<string, string | null>; tombstones?: TombstoneMap };
    return {
      keys: env.keys ?? {},
      savedAt: typeof env.savedAt === 'number' ? env.savedAt : 0,
      tombstones: env.tombstones ?? {},
    };
  }
  return { keys: parsed as Record<string, string | null>, savedAt: 0, tombstones: {} };
}

function localSnapshot(): StateSnapshot {
  const keys: Record<string, string | null> = {};
  for (const key of BACKED_UP_KEYS) keys[key] = mobileStorage.getSync(key);
  return {
    keys,
    savedAt: parseInt(mobileStorage.getSync(LAST_BACKUP_TS_KEY) || '0', 10),
    tombstones: getTombstones(),
  };
}

/**
 * MERGE a cloud snapshot into local state (was: overwrite local with it).
 *
 * Id sets union, corkboards merge per board, deletions travel as tombstones —
 * so this is safe to run whenever the cloud is ahead, which is what lets a
 * second device pick up where the first left off. See @core/stateMerge.
 */
function mergeBackupIntoLocal(
  json: string,
  opts?: { dryRun?: boolean },
): { changed: number; removals: MergeResult['removals'] } {
  const result = mergeState(localSnapshot(), parseBackup(json));

  // Dry run: answer "would this take anything away?" without touching storage,
  // so a background sync can apply small merges silently and hold a mass
  // deletion for the user (mirrors web's loadRemoteBackup preview).
  if (opts?.dryRun) {
    return { changed: result.changedKeys.length, removals: result.removals };
  }

  // The merged values are authoritative — recording removals off them would
  // tombstone ids the merge deliberately dropped.
  withoutTombstoneRecording(() => {
    for (const key of result.changedKeys) {
      if (!(BACKED_UP_KEYS as readonly string[]).includes(key)) continue;
      const value = result.keys[key];
      if (value === null || value === undefined) mobileStorage.removeSync(key);
      else mobileStorage.setSync(key, value);
    }
  });

  mergeInTombstones(result.tombstones);
  withoutTombstoneRecording(() => {
    mobileStorage.setSync(TOMBSTONE_STORAGE_KEY, serializeTombstones());
  });

  return { changed: result.changedKeys.length, removals: result.removals };
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
  signer: BackupSigner,
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
      // 415 = server rejects the backup-blob content type. Flag it so future
      // saves skip it (it may still work for image uploads — separate path).
      if (response.status === 415) {
        markBlobRejectingServer(server);
        if (__DEV__) console.warn(`[backup] ${server} rejects backup blobs (415) — flagged`);
      } else if (__DEV__) {
        console.warn(`[backup] ${server} upload failed: ${response.status}`);
      }
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

/**
 * Upload to Blossom servers aiming for REDUNDANT_COPIES copies. Stops once
 * enough copies land; returns the primary URL/hash and how many landed.
 * 415-rejecting servers are flagged inside blossomUpload and skipped next time.
 */
async function blossomUploadWithRedundancy(
  servers: string[],
  content: string,
  signer: BackupSigner,
  onLog?: (msg: string) => void,
): Promise<{ url: string | null; hash?: string; count: number }> {
  let url: string | null = null;
  let hash: string | undefined;
  let count = 0;
  for (const server of servers) {
    if (count >= REDUNDANT_COPIES) break;
    const result = await blossomUpload(server, content, signer);
    if (result) {
      if (!url) { url = result.url; hash = result.hash; }
      count++;
      onLog?.(`  Uploaded to ${server} (${count}/${REDUNDANT_COPIES})`);
    }
  }
  return { url, hash, count };
}

export function useNostrBackup(pubkey: string | null, signer: BackupSigner | null) {
  const [status, setStatus] = useState<BackupStatus>('idle');
  const [message, setMessage] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [checkpoints, setCheckpoints] = useState<RemoteCheckpoint[]>(() => getStoredCheckpoints());
  const [lastBackupTs, setLastBackupTs] = useState<number>(() => {
    return parseInt(mobileStorage.getSync(LAST_BACKUP_TS_KEY) || '0', 10);
  });

  // Persistent device ID for cross-device sync — stays local, never backed up.
  // `randomUuid` (getRandomValues only) rather than `crypto.randomUUID`, which
  // does not exist on Hermes: this initializer runs on the very first render
  // after a fresh install or a logout (which rotates the device id away), so a
  // bare `crypto.randomUUID()` threw and took the whole app down at launch.
  const [deviceId] = useState(() => {
    const existing = mobileStorage.getSync(STORAGE_KEYS.DEVICE_ID);
    if (existing) return existing;
    const id = randomUuid();
    mobileStorage.setSync(STORAGE_KEYS.DEVICE_ID, id);
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
    // NIP-44 only on the write path (see @core/nostrEncrypt.encryptForSelf).
    // NIP-04 stays supported for *reading* legacy backups below.
    if (!signer.nip44) {
      setStatus('save-error');
      setMessage('Signer does not support NIP-44 encryption');
      return;
    }

    isSaving.current = true;
    setStatus('encrypting');
    setMessage('Encrypting backup…');

    try {
      const json = serializeBackup();
      log(`Serialized: ${new TextEncoder().encode(json).length} bytes`);

      // AES-256-GCM blob + NIP-44-wrapped key, via the shared core helper.
      // Doing the wrap inline used to fall back to NIP-04 whenever `nip44` was
      // merely momentarily unavailable (a dismissed NIP-46 prompt, a signer
      // timeout) — a silent downgrade to an unrecommended, length-leaking
      // scheme with no user consent. encryptForSelf throws instead.
      const { content: encryptedData, wrappedKey, signerMethod } =
        await encryptForSelf(json, signer, pubkey);
      log(`Encrypted: ${encryptedData.length} chars`);

      setStatus('saving');
      setMessage('Uploading to Blossom…');

      const { url: blossomUrl, hash: blossomHash, count: blossomCount } =
        await blossomUploadWithRedundancy(getActiveBlossomServers(), encryptedData, signer, log);

      if (!blossomUrl) throw new Error('All Blossom servers failed');
      log(`Backup landed on ${blossomCount} Blossom server(s)`);

      // Publish manifest (kind 30078). Manual saves rotate through a bounded
      // ring of slot d-tags (matches web) — a timestamp d-tag per save leaked a
      // fresh addressable event onto relays forever, and no other device ever
      // queried those tags, so manual saves were invisible to sync.
      const now = Math.floor(Date.now() / 1000);
      const slotCursor = parseInt(mobileStorage.getSync(STORAGE_KEYS.BACKUP_SLOT_CURSOR) || '0', 10) || 0;
      const slot = ((slotCursor % MANUAL_BACKUP_SLOTS) + MANUAL_BACKUP_SLOTS) % MANUAL_BACKUP_SLOTS;
      const dTag = `${D_TAG_PREFIX}:s${slot}`;
      const keysPresent = BACKED_UP_KEYS.filter(k => mobileStorage.getSync(k) !== null);
      const jsonLen = (k: string) => { try { return JSON.parse(mobileStorage.getSync(k) || '[]').length; } catch { return 0; } };
      const stats = {
        corkboards: jsonLen('nostr-custom-feeds'),
        savedForLater: savedNoteCount(),
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
      // Encrypt manifest so stats and Blossom URL aren't leaked. NIP-44 only —
      // encryptForSelf above already established the signer has it, and the old
      // chain ended in `: manifestJson`, i.e. publishing the Blossom URL and the
      // user's corkboard names in the clear if both encrypt paths were missing.
      const encryptedManifest = await signer.nip44!.encrypt(pubkey, manifestJson);

      const manifestEvent = await signer.signEvent({
        kind: 30078,
        content: encryptedManifest,
        tags: [['d', dTag]],
        created_at: now,
      });

      const relays = getPublishRelays(pubkey);
      let published = 0;
      for (const url of relays) {
        const relay = createRelayFresh(url, { backoff: false });
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
      mobileStorage.setSync(STORAGE_KEYS.BACKUP_SLOT_CURSOR, String(slotCursor + 1)); // advance the ring
      setLastBackupTs(now);
      saveSnapshot();
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
  }, [pubkey, signer, log, deviceId]);

  // Silent auto-save — same logic as saveBackup but no status/message updates.
  // Returns a status so callers can distinguish a real upload failure
  // ('no-servers'/'error') from a benign protective skip ('skipped', silent).
  const autoSaveBackup = useCallback(async (): Promise<AutoSaveResult> => {
    if (!pubkey || !signer || isSaving.current || isRestoring.current) return 'skipped';
    if (!signer.nip44) return 'skipped'; // NIP-44 only on the write path
    if (!hasUnsavedChanges()) return 'skipped';

    // Guard: don't overwrite a good cloud backup with empty/corrupt local state.
    // If MMKV writes have been failing, local data may not reflect what's on disk.
    if (!isStorageHealthy()) {
      if (__DEV__) console.warn('[backup] Auto-save blocked: MMKV writes are failing — protecting cloud backup');
      return 'skipped';
    }

    // Guard: don't save if the data is essentially empty (no feeds, no dismissed, no collapsed).
    // This prevents overwriting a good backup after storage was wiped.
    const feeds = mobileStorage.getSync('nostr-custom-feeds');
    const dismissed = mobileStorage.getSync('dismissed-notes');
    const collapsed = mobileStorage.getSync('collapsed-notes');
    const hasMeaningfulData = (feeds && feeds !== '[]') || (dismissed && dismissed !== '[]') || (collapsed && collapsed !== '[]');
    if (!hasMeaningfulData) {
      if (__DEV__) console.warn('[backup] Auto-save blocked: no meaningful data to save');
      return 'skipped';
    }

    // Guard: don't save if key data regressed significantly vs last snapshot.
    // Large sudden regressions suggest MMKV was partially cleared, not intentional user action.
    // Block save to protect the cloud backup.
    const lastSnapshotRaw = mobileStorage.getSync(STORAGE_KEYS.LAST_BACKUP_DATA);
    if (lastSnapshotRaw) {
      try {
        const prevSnap = JSON.parse(lastSnapshotRaw) as Record<string, string>;

        const prevDismissed = JSON.parse(prevSnap[STORAGE_KEYS.DISMISSED_NOTES] || '[]').length as number;
        const currDismissed = JSON.parse(dismissed || '[]').length as number;
        if (prevDismissed > 20 && currDismissed < prevDismissed * 0.5) {
          if (__DEV__) console.warn(`[backup] Auto-save blocked: dismissed notes dropped from ${prevDismissed} to ${currDismissed} — MMKV may be partially cleared`);
          return 'skipped';
        }

        const prevFeeds = JSON.parse(prevSnap[STORAGE_KEYS.CUSTOM_FEEDS] || '[]') as unknown[];
        const currFeeds = JSON.parse(feeds || '[]') as unknown[];
        if (prevFeeds.length > 0 && currFeeds.length === 0) {
          if (__DEV__) console.warn('[backup] Auto-save blocked: custom feeds dropped to zero — MMKV may be partially cleared');
          return 'skipped';
        }

        const prevCollapsed = JSON.parse(prevSnap[STORAGE_KEYS.COLLAPSED_NOTES] || '[]').length as number;
        const currCollapsed = JSON.parse(collapsed || '[]').length as number;
        if (prevCollapsed > 10 && currCollapsed < prevCollapsed * 0.5) {
          if (__DEV__) console.warn(`[backup] Auto-save blocked: saved notes dropped from ${prevCollapsed} to ${currCollapsed} — MMKV may be partially cleared`);
          return 'skipped';
        }
      } catch { /* ignore parse errors — don't block save on unexpected format */ }
    }

    isSaving.current = true;
    try {
      const json = serializeBackup();

      // NIP-44 only — same reasoning as saveBackup above.
      const { content: encryptedData, wrappedKey, signerMethod } =
        await encryptForSelf(json, signer, pubkey);

      // Redundant, 415-aware upload (skips servers known to reject the blob type).
      const { url: blossomUrl, hash: blossomHash } =
        await blossomUploadWithRedundancy(getActiveBlossomServers(), encryptedData, signer);
      if (!blossomUrl) return 'no-servers';

      const now = Math.floor(Date.now() / 1000);
      const dTag = `${D_TAG_PREFIX}:auto`;
      const jsonLen = (k: string) => { try { return JSON.parse(mobileStorage.getSync(k) || '[]').length; } catch { return 0; } };
      const stats = {
        corkboards: jsonLen('nostr-custom-feeds'),
        savedForLater: savedNoteCount(),
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
        keys: BACKED_UP_KEYS.filter(k => mobileStorage.getSync(k) !== null),
        stats, corkboardNames,
      });
      const encryptedManifest = await signer.nip44!.encrypt(pubkey, manifestJson);

      const manifestEvent = await signer.signEvent({
        kind: 30078,
        content: encryptedManifest,
        tags: [['d', dTag]],
        created_at: now,
      });

      const relays = getPublishRelays(pubkey);
      let manifestPublished = 0;
      for (const url of relays) {
        const relay = createRelayFresh(url, { backoff: false });
        try {
          await relay.event(manifestEvent, { signal: AbortSignal.timeout(8000) });
          manifestPublished++;
        }
        catch { /* continue */ }
        finally { try { relay.close(); } catch { /* */ } }
      }

      // A blob with no discoverable manifest is a failed save, not a green one
      // — other devices find the backup through the manifest (parity with web).
      if (manifestPublished === 0) {
        if (__DEV__) console.warn('[backup] Auto-save: blob uploaded but NO relay accepted the manifest — reporting error');
        return 'error';
      }

      // Update local state
      mobileStorage.setSync(LAST_BACKUP_TS_KEY, String(now));
      setLastBackupTs(now);
      saveSnapshot();

      // Update checkpoint list — keep last 5 autosaves
      const cps = getStoredCheckpoints();
      const autoEntry: RemoteCheckpoint = {
        eventId: manifestEvent.id, dTag, timestamp: now,
        blossomUrl: blossomUrl!, ...(blossomHash ? { blossomHash } : {}),
        wrappedKey, signerMethod, stats,
      };
      const latestAuto = cps.find(c => c.dTag?.includes(':auto'));
      const statsChanged = !latestAuto?.stats
        || latestAuto.stats.corkboards !== stats.corkboards
        || latestAuto.stats.savedForLater !== stats.savedForLater
        || latestAuto.stats.dismissed !== stats.dismissed;
      if (statsChanged) {
        cps.unshift(autoEntry);
      } else if (latestAuto) {
        latestAuto.timestamp = now;
        latestAuto.eventId = manifestEvent.id;
        latestAuto.blossomUrl = blossomUrl!;
        if (blossomHash) latestAuto.blossomHash = blossomHash;
        latestAuto.wrappedKey = wrappedKey;
      } else {
        cps.unshift(autoEntry);
      }
      const allCps = cps.sort((a, b) => b.timestamp - a.timestamp);
      const namedCps = allCps.filter(c => c.name);
      const unnamedCps = allCps.filter(c => !c.name);
      const merged = [...namedCps, ...unnamedCps.slice(0, Math.max(0, 3 - namedCps.length))].sort((a, b) => b.timestamp - a.timestamp);
      setStoredCheckpoints(merged);
      setCheckpoints(merged);

      if (__DEV__) console.log('[backup] Auto-save complete');
      return 'saved';
    } catch {
      if (__DEV__) console.warn('[backup] Auto-save failed');
      return 'error';
    } finally {
      isSaving.current = false;
    }
  }, [pubkey, signer, deviceId]);

  const checkForBackup = useCallback(async () => {
    if (!pubkey || !signer) return;

    setStatus('checking');
    setMessage('Looking for backups…');

    const seen = new Set<string>();
    const allEvents: NostrEvent[] = [];

    const relays = [...new Set(getPublishRelays(pubkey))];

    log(`Checking ${relays.length} relays…`);

    // Query every backup slot by d-tag — the autosave slot plus the manual
    // slot ring. kind:30078 is addressable, so every relay stores exactly one
    // event per d-tag, and relays can DISAGREE: ask ALL of them and let the
    // newest event win. The old early-exit stopped at the first batch with any
    // result, which let a lagging relay's stale manifest be treated as current
    // simply because it answered fastest — and only `:auto` was queried, so a
    // manual save on another device was invisible here entirely.
    const slotDTags = [
      `${D_TAG_PREFIX}:auto`,
      ...Array.from({ length: MANUAL_BACKUP_SLOTS }, (_, i) => `${D_TAG_PREFIX}:s${i}`),
    ];
    for (let i = 0; i < relays.length; i += 4) {
      const batch = relays.slice(i, i + 4);
      await Promise.allSettled(batch.map(async url => {
        const relay = createRelayFresh(url, { backoff: false });
        try {
          const events = await relay.query(
            [{ kinds: [30078], authors: [pubkey], '#d': slotDTags, limit: slotDTags.length }],
            { signal: AbortSignal.timeout(5000) },
          );
          for (const ev of events) {
            if (!seen.has(ev.id)) { seen.add(ev.id); allEvents.push(ev); }
          }
          log(`  ${url}: ${events.length} backup manifest(s)`);
        } catch { /* timeout ok */ } finally {
          try { relay.close(); } catch { /* */ }
        }
      }));
    }

    if (allEvents.length === 0) {
      setStatus('no-backup');
      setMessage('No backups found');
      log('No backups found');
      return;
    }

    // Parse checkpoints from events (plaintext → cached decrypt → live decrypt).
    // A signer timeout trips a circuit breaker for the rest of the pass —
    // serially timing out per manifest is the "hangs then finds nothing" bug.
    const cps: RemoteCheckpoint[] = [];
    let signerTimedOut = false;
    for (const ev of allEvents) {
      let data: Record<string, unknown> | null = null;
      try { data = JSON.parse(ev.content); } catch {
        const cachedJson = getCachedManifestJson(ev.id);
        if (cachedJson) {
          try { data = JSON.parse(cachedJson); } catch { /* fall through */ }
        }
        if (!data && signer?.nip44 && !signerTimedOut) {
          try {
            const json = await Promise.race([
              signer.nip44.decrypt(pubkey, ev.content),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('decrypt_timeout')), 10000)),
            ]);
            data = JSON.parse(json);
            cacheManifestJson(ev.id, json);
          } catch (err) {
            if (err instanceof Error && err.message === 'decrypt_timeout') signerTimedOut = true;
            /* decrypt failed or timed out — skip */
          }
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

    // Safety: merge with stored checkpoints; don't let a thin manifest wipe a richer stored one.
    const stored = getStoredCheckpoints();
    const newestStored = stored.length > 0 ? stored[0] : null;
    const safeCps = cps.filter(cp => {
      if (!newestStored?.stats || !cp.stats) return true;
      const isThinnerThanStored =
        (newestStored.stats.savedForLater - cp.stats.savedForLater > 10
          || newestStored.stats.dismissed - cp.stats.dismissed > 50);
      return !isThinnerThanStored;
    });
    // Merge: prefer fresh events over stored, preserve named checkpoints
    const merged = new Map<string, RemoteCheckpoint>();
    for (const cp of [...safeCps, ...stored]) {
      const key = cp.dTag || cp.eventId;
      if (!merged.has(key) || cp.timestamp > merged.get(key)!.timestamp) merged.set(key, cp);
    }
    setStoredCheckpoints([...merged.values()]);
    const deduped = getStoredCheckpoints();
    setCheckpoints(deduped);

    setStatus('found');
    setMessage(`Found ${deduped.length} backup${deduped.length === 1 ? '' : 's'}`);
    log(`Found ${deduped.length} backups (${cps.length} raw, ${safeCps.length} passed safety check)`);
  }, [pubkey, signer, log]);

  /**
   * Pull a checkpoint's state in via merge (see @core/stateMerge).
   *
   * `silent` keeps the UI out of restoring/restored states — a background sync
   * should not look like a restore. In silent mode a merge that would remove
   * more than SILENT_REMOVAL_LIMIT items applies NOTHING; small removals are
   * another device's deliberate deletions and apply without asking (parity
   * with web's loadRemoteBackup askOnRemovals path).
   */
  const restoreBackup = useCallback(async (checkpoint: RemoteCheckpoint, opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (!pubkey || !signer || isRestoring.current) return;
    isRestoring.current = true;

    if (!silent) {
      setStatus('restoring');
      setMessage('Downloading backup…');
    }

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

      if (!silent) setMessage('Decrypting…');

      // Unwrap AES key
      const keyHex = checkpoint.signerMethod === 'nip04'
        ? await signer.nip04!.decrypt(pubkey, checkpoint.wrappedKey)
        : await signer.nip44!.decrypt(pubkey, checkpoint.wrappedKey);

      const raw = hexToRawKey(keyHex);
      const aesKey = await importAesKey(raw);
      const json = await aesDecrypt(aesKey, encryptedData);
      log('Decrypted successfully');

      if (silent) {
        const preview = mergeBackupIntoLocal(json, { dryRun: true });
        const count = preview.removals.reduce((n, r) => n + r.ids.length, 0);
        if (count > SILENT_REMOVAL_LIMIT) {
          log(`Silent sync held: merge would remove ${count} item(s) — user can restore manually`);
          return;
        }
      }

      // Capture BEFORE the merge writes — afterwards local IS the merged state.
      const remoteSnapshot = parseBackup(json);
      const localContributed = hasLocalContributions(localSnapshot(), remoteSnapshot);

      if (!silent) setMessage('Restoring settings…');
      const { changed, removals } = mergeBackupIntoLocal(json);
      log(`Settings merged: ${changed} keys changed, ${removals.length} with removals`);

      // Record what we're now synced to, or the next sync tick re-merges the
      // same snapshot forever and hasUnsavedChanges() misfires. Baseline is
      // the remote state when local contributed content the cloud lacks, so
      // the auto-save trigger pushes the union (see saveSnapshot).
      mobileStorage.setSync(LAST_BACKUP_TS_KEY, String(checkpoint.timestamp));
      setLastBackupTs(checkpoint.timestamp);
      saveSnapshot(localContributed ? remoteSnapshot.keys : undefined);
      if (localContributed) log('Local content not yet in cloud — auto-save will push the merged state');

      if (silent) {
        log(`Background sync merged ${changed} keys`);
      } else {
        setStatus('restored');
        setMessage('Backup restored! Restart the app to apply all settings.');
        // Resume auto-save after a brief flash of "restored" status
        setTimeout(() => setStatus('idle'), 3000);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('Restore failed: ' + errMsg);
      if (!silent) {
        setStatus('restore-error');
        setMessage('Restore failed: ' + errMsg);
      }
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
    autoSaveBackup,
    hasUnsavedChanges,
    checkForBackup,
    restoreBackup,
  };
}

// Re-export for use outside the hook (e.g. AppState listeners)
export { hasUnsavedChanges };
