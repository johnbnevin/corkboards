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
import { useState, useCallback, useEffect, useRef } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import type { NSecSigner, NConnectSigner } from '@nostrify/nostrify';

// Backup operations only require signEvent + nip04/nip44 encrypt/decrypt,
// which both NSecSigner and NConnectSigner provide.
type BackupSigner = NSecSigner | NConnectSigner;
import { mobileStorage, isStorageHealthy } from '../storage/MmkvStorage';
import { BACKED_UP_KEYS, STORAGE_KEYS } from '../lib/storageKeys';
import { FALLBACK_RELAYS, getUserRelays, getRelayCache, createRelayFresh, useNostr } from '../lib/NostrProvider';
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
/** A save/restore mutex older than this is presumed dead (hung signer) and may
 *  be superseded — parity with web's MUTEX_STALE_MS. */
const MUTEX_STALE_MS = 90_000;
import {
  mergeState,
  hasLocalContributions,
  snapshotHasBackedUpData,
  STATE_FORMAT_VERSION,
  type StateSnapshot,
  type MergeResult,
  type TombstoneMap,
} from '@core/stateMerge';
import { SILENT_REMOVAL_LIMIT } from '@core/cacheConfig';
import {
  mergeInTombstones,
  serializeTombstones,
  TOMBSTONE_STORAGE_KEY,
} from '@core/tombstones';
import {
  evaluateAutoSaveGuard,
  evaluateManifestThinness,
  evaluateMergeHold,
  retainCheckpoints,
  verifyBlobMatchesManifest,
  shouldSuppressSilentSync,
  type BackupCounts,
  type ExplicitRestoreRecord,
} from '@core/backupGuards';
import { SNAPSHOT_KEYS } from '@core/backupKeys';
import { withoutTombstoneRecording, getStoredTombstones } from '../storage/MmkvStorage';
import { emitStorageSync } from '../lib/storageSync';

const LAST_BACKUP_TS_KEY = STORAGE_KEYS.LAST_BACKUP_TS;
/**
 * Event id of the newest manifest this device already holds (published or
 * merged). "Have I seen THIS manifest?" replaces timestamp comparison as the
 * sync criterion — a clock can be wrong or deliberately stamped ahead, an
 * event id cannot. Parity with web.
 */
export const LAST_SYNCED_MANIFEST_KEY = 'corkboard:last-synced-manifest-id';
export function getLastSyncedManifestId(): string {
  return mobileStorage.getSync(LAST_SYNCED_MANIFEST_KEY) || '';
}
export function setLastSyncedManifestId(eventId: string): void {
  if (eventId) mobileStorage.setSync(LAST_SYNCED_MANIFEST_KEY, eventId);
}

/**
 * The checkpoint the USER explicitly restored (`restoreBackup` called with
 * `silent` falsy), as opposed to `LAST_SYNCED_MANIFEST_KEY`, which a silent
 * background merge also advances. See `@core/backupGuards.shouldSuppressSilentSync`
 * for why the distinction exists: without it, a manifest that is merely
 * LATER by clock (not better) permanently outranks whatever the user
 * deliberately chose, and every periodic check silently re-applies it.
 * Parity with web.
 */
function getLastExplicitRestore(): ExplicitRestoreRecord | null {
  const raw = mobileStorage.getSync(STORAGE_KEYS.LAST_EXPLICIT_RESTORE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ExplicitRestoreRecord>;
    if (typeof parsed.id === 'string' && typeof parsed.timestamp === 'number') return parsed as ExplicitRestoreRecord;
    return null;
  } catch { return null; }
}
function setLastExplicitRestore(record: ExplicitRestoreRecord): void {
  mobileStorage.setSync(STORAGE_KEYS.LAST_EXPLICIT_RESTORE, JSON.stringify(record));
}
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

/**
 * Unwrapped AES keys, keyed by the wrappedKey ciphertext. Session-only — this
 * is key material, so it never touches disk. Unwrapping is a signer decrypt
 * (a bunker round-trip), and the same ciphertext is unwrapped more than once
 * on a normal login. Parity with web.
 */
const _aesKeyCache = new Map<string, string>();
const AES_KEY_CACHE_MAX = 16;
/** In-flight unwraps by ciphertext — see unwrapAesKey. */
const _aesKeyInFlight = new Map<string, Promise<string>>();

/** In-flight and completed manifest decrypts, keyed by ciphertext. The
 *  timeout on a bunker decrypt bounds only THE WAIT, not the RPC — a late
 *  answer still lands here, so the next check succeeds instead of firing yet
 *  another round-trip at a signer that was already behind (parity with web's
 *  decryptSelfPayload). Session-only. */
const _manifestDecryptInFlight = new Map<string, Promise<string>>();
const _manifestDecryptCache = new Map<string, string>();
const MANIFEST_DECRYPT_CACHE_MAX = 40;

async function decryptManifestContent(
  decryptor: { decrypt(pk: string, c: string): Promise<string> },
  pubkey: string,
  ciphertext: string,
  timeoutMs: number,
): Promise<string> {
  const cached = _manifestDecryptCache.get(ciphertext);
  if (cached) return cached;
  let pending = _manifestDecryptInFlight.get(ciphertext);
  if (!pending) {
    pending = decryptor.decrypt(pubkey, ciphertext)
      .then((json) => {
        if (_manifestDecryptCache.size >= MANIFEST_DECRYPT_CACHE_MAX) {
          const oldest = _manifestDecryptCache.keys().next();
          if (!oldest.done) _manifestDecryptCache.delete(oldest.value);
        }
        _manifestDecryptCache.set(ciphertext, json);
        return json;
      })
      .finally(() => { _manifestDecryptInFlight.delete(ciphertext); });
    _manifestDecryptInFlight.set(ciphertext, pending);
    // A rejection after every waiter has timed out must not surface as an
    // unhandled promise rejection.
    pending.catch(() => {});
  }
  return await Promise.race([
    pending,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('decrypt_timeout')), timeoutMs)),
  ]);
}

async function unwrapAesKey(
  signer: BackupSigner,
  pubkey: string,
  wrappedKey: string,
  signerMethod: string,
  timeoutMs = 20000,
): Promise<string> {
  const cached = _aesKeyCache.get(wrappedKey);
  if (cached) return cached;
  const decryptor = signerMethod === 'nip04' ? signer.nip04 : signer.nip44;
  if (!decryptor) throw new Error(`Signer does not support ${signerMethod} decryption`);

  // Single-flight, and the timeout bounds only THE WAIT, not the RPC — a late
  // bunker answer still lands in the cache so the retry succeeds instantly
  // instead of firing yet another round-trip at a struggling signer (parity
  // with web).
  let pending = _aesKeyInFlight.get(wrappedKey);
  if (!pending) {
    pending = decryptor.decrypt(pubkey, wrappedKey)
      .then((hex) => {
        if (_aesKeyCache.size >= AES_KEY_CACHE_MAX) {
          const oldest = _aesKeyCache.keys().next();
          if (!oldest.done) _aesKeyCache.delete(oldest.value);
        }
        _aesKeyCache.set(wrappedKey, hex);
        return hex;
      })
      .finally(() => { _aesKeyInFlight.delete(wrappedKey); });
    _aesKeyInFlight.set(wrappedKey, pending);
    // A rejection after every waiter has timed out must not surface as an
    // unhandled promise rejection.
    pending.catch(() => {});
  }
  return await Promise.race([
    pending,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Signer timed out unwrapping the backup key — it may still answer; retry in a moment')), timeoutMs)),
  ]);
}

/** Pubkeys whose remote signer has been permission-warmed this session. */
const _signerWarmupDone = new Set<string>();

/**
 * Ask the remote signer (Amber, nsec.app, …) for every permission the backup
 * pipeline needs AT LOGIN — while the user is present — instead of when the
 * first autosave fires a minute later. Amber remembers per-operation
 * approvals, so without this the first background save raised a permission
 * dialog long after login, and a missed dialog surfaced as "signer timed
 * out". The four operations are exactly the pipeline's; everything here is
 * throwaway and never leaves the device. Sequential on purpose: bunkers
 * serve one round-trip at a time. Parity with web.
 */
async function warmUpSignerPermissions(
  pubkey: string,
  signer: BackupSigner,
  log: (msg: string) => void,
): Promise<void> {
  if (_signerWarmupDone.has(pubkey)) return;
  _signerWarmupDone.add(pubkey);
  const now = Math.floor(Date.now() / 1000);
  try {
    log('Warming up signer permissions (encrypt, decrypt, upload auth, manifest)...');
    if (signer.nip44) {
      const probe = await signer.nip44.encrypt(pubkey, 'corkboards permission warm-up');
      await signer.nip44.decrypt(pubkey, probe);
    }
    await signer.signEvent({
      kind: 24242,
      content: 'Corkboards permission warm-up (never uploaded)',
      created_at: now,
      // Already expired, so even a leaked copy authorizes nothing.
      tags: [['t', 'upload'], ['expiration', String(now)]],
    });
    await signer.signEvent({
      kind: 30078,
      content: '',
      created_at: now,
      tags: [['d', `${D_TAG_PREFIX}:warmup`]],
    });
    log('Signer permissions granted — autosave and restore will not prompt later');
  } catch (err) {
    // Not fatal: the real operation re-asks when it runs. Clearing the guard
    // lets the next login attempt warm up again.
    _signerWarmupDone.delete(pubkey);
    log('Signer permission warm-up incomplete: ' + (err instanceof Error ? err.message : err));
  }
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
 *
 * Flags EXPIRE after 24 hours (parity with web's BLOB_REJECT_TTL_MS): a
 * permanent flag from one transient misread quietly removed a server from the
 * redundancy set for the life of the profile. Stored as url → flaggedAt ms;
 * the legacy plain-array format is read as flagged-now once and migrates on
 * the next write.
 */
const BLOB_REJECT_TTL_MS = 24 * 60 * 60 * 1000;

function readBlobRejectMap(): Record<string, number> {
  const stored = mobileStorage.getSync(BLOSSOM_BLOB_REJECTS_KEY);
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) {
      const now = Date.now();
      const map: Record<string, number> = {};
      for (const url of parsed) if (typeof url === 'string') map[normalizeServer(url)] = now;
      return map;
    }
    if (parsed && typeof parsed === 'object') {
      const map: Record<string, number> = {};
      for (const [url, ts] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof ts === 'number') map[normalizeServer(url)] = ts;
      }
      return map;
    }
    return {};
  } catch { return {}; }
}

export function getBlobRejectingServers(): Set<string> {
  const map = readBlobRejectMap();
  const now = Date.now();
  return new Set(Object.entries(map).filter(([, ts]) => now - ts < BLOB_REJECT_TTL_MS).map(([url]) => url));
}

export function markBlobRejectingServer(url: string): void {
  const map = readBlobRejectMap();
  map[normalizeServer(url)] = Date.now();
  mobileStorage.setSync(BLOSSOM_BLOB_REJECTS_KEY, JSON.stringify(map));
}

export function clearBlobRejectingServer(url: string): void {
  const map = readBlobRejectMap();
  if (delete map[normalizeServer(url)]) {
    mobileStorage.setSync(BLOSSOM_BLOB_REJECTS_KEY, JSON.stringify(map));
  }
}

export function isBlobRejectingServer(url: string): boolean {
  return getBlobRejectingServers().has(normalizeServer(url));
}

// DEMOTES servers known to reject the blob type to the back of the list rather
// than dropping them (parity with web): flags may be stale, and losing a
// redundancy target entirely is worse than trying it last.
function getActiveBlossomServers(): string[] {
  const all = getBlossomServers();
  const rejects = getBlobRejectingServers();
  const usable = all.filter(s => !rejects.has(normalizeServer(s)));
  const flagged = all.filter(s => rejects.has(normalizeServer(s)));
  return [...usable, ...flagged];
}

/** Result of an auto-save attempt — lets callers show accurate messaging.
 *  'blocked' = a protective guard refused (data regressed vs last backup);
 *  distinct from a benign 'skipped' so it is never silent (parity with web). */
export type AutoSaveResult = 'saved' | 'skipped' | 'blocked' | 'no-servers' | 'error';


// Exported so AutoSaveManager can read the fresh list straight from storage
// right after a check, without racing React state propagation.
export function getStoredCheckpoints(): RemoteCheckpoint[] {
  const raw = mobileStorage.getSync(CHECKPOINTS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function setStoredCheckpoints(cps: RemoteCheckpoint[]): void {
  // Dedup by EVENT id and trim via the shared retention rule (named always
  // survive; newest 5 unnamed plus the richest-by-content). The old d-tag
  // dedup deleted every older autosave entry the moment a newer one existed —
  // all autosaves share the `…:auto` d-tag — so one thin autosave from any
  // device evicted the only entry still pointing at the corkboard-rich blob.
  // Every entry restores from its own Blossom blob + wrapped key, so a relay
  // replacing the addressable event does not make an older entry unrestorable.
  mobileStorage.setSync(CHECKPOINTS_KEY, JSON.stringify(retainCheckpoints(cps)));
}

// Keys checked for change detection — now the SHARED list in @core/backupKeys.
// Mobile's own copy had drifted four keys behind web's (bookmark ids,
// dismissed thread roots, pins, markdown pref), so edits to those on mobile
// never triggered a backup.

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
    // THE DATA. This line was accidentally dropped in a refactor of the line
    // below it (parity with web) — every backup written until it was noticed
    // was an empty envelope that restored zero keys.
    keys,
    // getStoredTombstones, not getTombstones: the log loads lazily on first
    // write, and a save before any local write this session would otherwise
    // upload an EMPTY removal log (parity with web).
    tombstones: getStoredTombstones(),
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
    // Loaded, not just in-memory — a merge before any local write this
    // session must still see this device's graves (parity with web).
    tombstones: getStoredTombstones(),
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
  const remote = parseBackup(json);
  if (!snapshotHasBackedUpData(remote, BACKED_UP_KEYS)) {
    throw new Error('This backup contains no data (saved by a build with a broken serializer) — nothing to merge. Restore an older checkpoint.');
  }
  const result = mergeState(localSnapshot(), remote);

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

  // Tell mounted hooks their keys changed — web dispatches idb-storage-sync
  // here; mobile had NO equivalent, so a silent merge was invisible until app
  // restart, which was the phone half of "restore never sticks".
  for (const key of result.changedKeys) {
    if (!(BACKED_UP_KEYS as readonly string[]).includes(key)) continue;
    const value = result.keys[key];
    emitStorageSync(key, value ?? null);
  }

  return { changed: result.changedKeys.length, removals: result.removals };
}

function getPublishRelays(pubkey: string): string[] {
  const relays = new Set<string>();
  for (const r of getUserRelays().write) relays.add(normalizeRelay(r));
  for (const r of getRelayCache(pubkey)) relays.add(normalizeRelay(r));
  for (const r of FALLBACK_RELAYS) relays.add(normalizeRelay(r));
  return Array.from(relays);
}

/** Upload encrypted text to one Blossom server with a PRE-SIGNED auth header.
 *  The signature is made once per save by the caller and reused across every
 *  server (BUD-01 binds it to the blob hash, not to a server). */
async function blossomUpload(
  server: string,
  content: string,
  authHeader: string,
  hashHex: string,
): Promise<{ url: string; hash?: string } | null> {
  try {
    const uploadUrl = server.replace(/\/+$/, '') + '/upload';
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

    const result = await response.json().catch(() => null);
    const url = result?.url || result?.nip94_event?.tags?.find((t: string[]) => t[0] === 'url')?.[1]
      || `${server.replace(/\/+$/, '')}/${hashHex}`;
    const hash = result?.sha256 || hashHex;
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
): Promise<{ url: string | null; hash?: string; count: number; signerFailed?: boolean }> {
  let url: string | null = null;
  let hash: string | undefined;
  let count = 0;
  if (servers.length === 0) return { url, hash, count };

  // Sign the upload authorization ONCE for every server. blossomUpload used to
  // sign its own kind-24242 event per call, so a save cost one signature per
  // server — through a NIP-46 bunker that is a network round-trip each, every
  // save. BUD-01 binds this auth to the blob hash (`x`) and `t=upload`, not to
  // any server, so one signature is valid everywhere. Parity with web.
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  const now = Math.floor(Date.now() / 1000);

  let authHeader: string;
  try {
    const authEvent = await signer.signEvent({
      kind: 24242,
      content: 'Upload corkboard backup',
      tags: [
        ['t', 'upload'],
        ['x', hashHex],
        ['size', String(data.length)],
        ['expiration', String(now + 3600)],
      ],
      created_at: now,
    });
    authHeader = 'Nostr ' + btoa(JSON.stringify(authEvent));
  } catch (err) {
    if (__DEV__) console.warn('[backup] Could not sign upload authorization:', err);
    onLog?.(`  Could not sign the upload authorization: ${err instanceof Error ? err.message : err}`);
    // No server was contacted — the failure is the SIGNER's, and callers must
    // say so instead of blaming the storage servers (parity with web).
    return { url, hash, count, signerFailed: true };
  }

  for (const server of servers) {
    if (count >= REDUNDANT_COPIES) break;
    const result = await blossomUpload(server, content, authHeader, hashHex);
    if (result) {
      if (!url) { url = result.url; hash = result.hash; }
      count++;
      onLog?.(`  Uploaded to ${server} (${count}/${REDUNDANT_COPIES})`);
    }
  }
  return { url, hash, count };
}

export function useNostrBackup(pubkey: string | null, signer: BackupSigner | null) {
  // The pool publishes through connections that are already open; the
  // per-relay loops below open a fresh socket each. Pool-first keeps a save
  // from depending entirely on new connections succeeding. (Parity with web,
  // where that dependency made every desktop manifest publish fail.)
  const { nostr } = useNostr();
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

  // Timestamped mutexes with a staleness escape (parity with web's
  // MUTEX_STALE_MS): a NIP-46 signer that never answers used to leave the
  // old boolean stuck true, wedging every save/restore for the session.
  const savingSince = useRef(0);
  const restoringSince = useRef(0);
  const isSavingNow = useCallback(() =>
    savingSince.current > 0 && Date.now() - savingSince.current < MUTEX_STALE_MS, []);
  const isRestoringNow = useCallback(() =>
    restoringSince.current > 0 && Date.now() - restoringSince.current < MUTEX_STALE_MS, []);

  const log = useCallback((msg: string) => {
    if (__DEV__) console.log('[backup]', msg);
    const ts = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-99), `[${ts}] ${msg}`]);
  }, []);

  // Remote signers get their permission prompts NOW, at login, not when the
  // first autosave fires a minute later. Account type is what AuthContext
  // recorded at login; the module-level guard keeps this to once per session
  // even though several components mount this hook.
  useEffect(() => {
    if (!pubkey || !signer) return;
    if (mobileStorage.getSync(`corkboard:account-type:${pubkey}`) !== 'bunker') return;
    void warmUpSignerPermissions(pubkey, signer, log);
  }, [pubkey, signer, log]);

  const saveBackup = useCallback(async () => {
    if (!pubkey || !signer || isSavingNow()) return;
    // NIP-44 only on the write path (see @core/nostrEncrypt.encryptForSelf).
    // NIP-04 stays supported for *reading* legacy backups below.
    if (!signer.nip44) {
      setStatus('save-error');
      setMessage('Signer does not support NIP-44 encryption');
      return;
    }

    savingSince.current = Date.now();
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

      const { url: blossomUrl, hash: blossomHash, count: blossomCount, signerFailed } =
        await blossomUploadWithRedundancy(getActiveBlossomServers(), encryptedData, signer, log);

      if (!blossomUrl) {
        throw new Error(signerFailed
          ? 'Could not sign the upload authorization — the signer did not respond. No storage server was contacted.'
          : 'All Blossom servers failed');
      }
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
      try {
        await nostr.event(manifestEvent, { signal: AbortSignal.timeout(10000) });
        published++;
        log('  pool <- manifest OK');
      } catch (err) {
        log(`  pool <- manifest FAILED: ${err instanceof Error ? err.message : err}`);
      }
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
      setLastSyncedManifestId(manifestEvent.id);
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
      savingSince.current = 0;
    }
  }, [pubkey, signer, log, deviceId, nostr, isSavingNow]);

  // Silent auto-save — same logic as saveBackup but no status/message updates.
  // Returns a status so callers can distinguish a real upload failure
  // ('no-servers'/'error') from a benign protective skip ('skipped', silent).
  const autoSaveBackup = useCallback(async (): Promise<AutoSaveResult> => {
    if (!pubkey || !signer || isSavingNow() || isRestoringNow()) return 'skipped';
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

    // Guard: don't save if key data regressed significantly vs last snapshot —
    // via the shared, tested rules in @core/backupGuards. Only DISMISSED
    // regression and feeds→0 block ('blocked', so the caller can surface it —
    // the old bare 'skipped' hid the refusal entirely); a saved-notes cleanup
    // proceeds with a logged notice (parity with web).
    const lastSnapshotRaw = mobileStorage.getSync(STORAGE_KEYS.LAST_BACKUP_DATA);
    if (lastSnapshotRaw) {
      try {
        const prevSnap = JSON.parse(lastSnapshotRaw) as Record<string, string>;
        const countOf = (raw: string | null | undefined) => {
          try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.length : 0; } catch { return 0; }
        };
        const prev: BackupCounts = {
          dismissed: countOf(prevSnap[STORAGE_KEYS.DISMISSED_NOTES]),
          feeds: countOf(prevSnap[STORAGE_KEYS.CUSTOM_FEEDS]),
          collapsed: countOf(prevSnap[STORAGE_KEYS.COLLAPSED_NOTES]),
          bookmarks: countOf(prevSnap[STORAGE_KEYS.BOOKMARK_IDS]),
        };
        const curr: BackupCounts = {
          dismissed: countOf(dismissed),
          feeds: countOf(feeds),
          collapsed: countOf(collapsed),
          bookmarks: countOf(mobileStorage.getSync(STORAGE_KEYS.BOOKMARK_IDS)),
        };
        const verdict = evaluateAutoSaveGuard(prev, curr);
        if (verdict.action === 'block') {
          if (__DEV__) console.warn(`[backup] Auto-save blocked: ${verdict.detail}`);
          return 'blocked';
        }
        if (verdict.warning === 'saved-cleanup' && __DEV__) {
          console.log('[backup] Saved notes dropped by half — proceeding (looks like a cleanup)');
        }
      } catch { /* ignore parse errors — don't block save on unexpected format */ }
    }

    savingSince.current = Date.now();
    try {
      const json = serializeBackup();

      // NIP-44 only — same reasoning as saveBackup above.
      const { content: encryptedData, wrappedKey, signerMethod } =
        await encryptForSelf(json, signer, pubkey);

      // Redundant, 415-aware upload (skips servers known to reject the blob type).
      const { url: blossomUrl, hash: blossomHash, signerFailed } =
        await blossomUploadWithRedundancy(getActiveBlossomServers(), encryptedData, signer);
      // A signer failure is not a storage-server failure — 'no-servers'
      // drives "check your Blossom servers" advice, wrong for it (parity
      // with web).
      if (!blossomUrl) return signerFailed ? 'error' : 'no-servers';

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
      try {
        await nostr.event(manifestEvent, { signal: AbortSignal.timeout(10000) });
        manifestPublished++;
      } catch { /* fall through to the per-relay loop */ }
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
      setLastSyncedManifestId(manifestEvent.id);
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
      // Retention (named survive, last-5 unnamed + richest) lives in
      // setStoredCheckpoints — trimming here first could drop the rich entry
      // before the shared rule ever saw it.
      setStoredCheckpoints(cps);
      setCheckpoints(getStoredCheckpoints());

      if (__DEV__) console.log('[backup] Auto-save complete');
      return 'saved';
    } catch {
      if (__DEV__) console.warn('[backup] Auto-save failed');
      return 'error';
    } finally {
      savingSince.current = 0;
    }
  }, [pubkey, signer, deviceId, nostr, isSavingNow, isRestoringNow]);

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
    //
    // Manifests that are NOT newer than what this device already has are
    // skipped without decrypting at all: `created_at` is on the signed event,
    // so "is there anything new?" is answerable without a signer round-trip.
    // Through a NIP-46 bunker each of those decrypts is a network round-trip,
    // and paying them just to re-learn "nothing changed" is what made a bunker
    // login crawl. Parity with web's checkRemoteBackup.
    const alreadySyncedId = getLastSyncedManifestId();
    const cps: RemoteCheckpoint[] = [];
    let signerTimedOut = false;
    // Newest first, and at most ONE live signer decrypt per check — the newest
    // unseen manifest is the only one a sync decision needs. Older slot
    // manifests still surface via plaintext or the decrypt cache; spending a
    // bunker round-trip on each of up to six slots is what made a check crawl
    // even when the signer was healthy. (Web pays at most one for the same
    // reason.)
    let liveDecryptSpent = false;
    const eventsNewestFirst = [...allEvents].sort((a, b) => b.created_at - a.created_at);
    for (const ev of eventsNewestFirst) {
      // The manifest we already hold needs no signer round-trip to re-read.
      if (ev.id === alreadySyncedId && !getCachedManifestJson(ev.id)) continue;
      let data: Record<string, unknown> | null = null;
      try { data = JSON.parse(ev.content); } catch {
        const cachedJson = getCachedManifestJson(ev.id);
        if (cachedJson) {
          try { data = JSON.parse(cachedJson); } catch { /* fall through */ }
        }
        if (!data && signer?.nip44 && !signerTimedOut && !liveDecryptSpent) {
          try {
            const json = await decryptManifestContent(signer.nip44, pubkey, ev.content, 10000);
            data = JSON.parse(json);
            cacheManifestJson(ev.id, json);
            liveDecryptSpent = true;
          } catch (err) {
            if (err instanceof Error && err.message === 'decrypt_timeout') signerTimedOut = true;
            liveDecryptSpent = true;
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

    // Safety: merge with stored checkpoints. Only a DISMISSED regression is a
    // worry (a fresh install autosaving an empty list over a full one) —
    // fewer saved notes is a legitimate cleanup that must stay visible to
    // other devices (parity with web; shared rule in @core/backupGuards).
    const stored = getStoredCheckpoints();
    const newestStored = stored.length > 0 ? stored[0] : null;
    const safeCps = cps.filter(cp =>
      evaluateManifestThinness(newestStored?.stats, cp.stats) === 'ok');
    // Merge fresh events with stored — dedup by event id, name preservation,
    // and retention all live in setStoredCheckpoints (shared @core rule), so
    // a fresh thin manifest can no longer evict an older, richer entry.
    setStoredCheckpoints([...safeCps, ...stored]);
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
    if (!pubkey || !signer || isRestoringNow()) return;
    restoringSince.current = Date.now();

    if (!silent) {
      setStatus('restoring');
      setMessage('Downloading backup…');
    }

    // A SILENT sync must not fight a choice the user already made. The
    // "newest" manifest is picked by wall-clock timestamp, and a
    // clock-skewed device (or a save that raced a richer one) can outrank an
    // explicit restore forever — every tick rediscovers it as "a different
    // event, not yet synced" and silently reapplies it. A manual restore
    // (silent falsy) always goes through — this only suppresses the
    // automatic path. Parity with web.
    if (silent) {
      const explicit = getLastExplicitRestore();
      const localTsNow = parseInt(mobileStorage.getSync(LAST_BACKUP_TS_KEY) || '0', 10);
      if (shouldSuppressSilentSync(explicit, checkpoint.eventId, localTsNow)) {
        log(`Background sync suppressed: manifest ${checkpoint.eventId.slice(0, 8)} conflicts with your explicit restore of ${explicit!.id.slice(0, 8)}`);
        restoringSince.current = 0;
        return;
      }
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
      const failedHosts: string[] = [];
      for (const url of urls) {
        try {
          log(`Fetching from ${url}…`);
          const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
          if (!response.ok) {
            log(`  ${url}: HTTP ${response.status}`);
            try { failedHosts.push(`${new URL(url).hostname} (HTTP ${response.status})`); } catch { /* ignore */ }
            continue;
          }
          encryptedData = await response.text();
          log(`Downloaded: ${encryptedData.length} chars`);
          break;
        } catch (err) {
          log(`  ${url}: ${err instanceof Error ? err.message : err}`);
          try { failedHosts.push(new URL(url).hostname); } catch { /* ignore */ }
        }
      }
      // Name the servers — the one thing the user can act on (parity with web).
      if (!encryptedData) throw new Error(`Could not download the backup from any Blossom server (tried: ${failedHosts.join(', ') || 'none reachable'})`);

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

      // Unwrap AES key (cached + bounded — see unwrapAesKey)
      const keyHex = await unwrapAesKey(signer, pubkey, checkpoint.wrappedKey, checkpoint.signerMethod);

      const raw = hexToRawKey(keyHex);
      const aesKey = await importAesKey(raw);
      const json = await aesDecrypt(aesKey, encryptedData);
      log('Decrypted successfully');

      // The blob must actually belong to the manifest that named it: hash
      // integrity is checked above; this is about WHICH save. Applying a
      // mismatched blob as "the newest" silently rolls the user back.
      const blobSavedAt = parseBackup(json).savedAt;
      if (checkpoint.timestamp && !verifyBlobMatchesManifest(blobSavedAt, checkpoint.timestamp)) {
        throw new Error('Backup content does not match its manifest — not applying it. Try an earlier checkpoint.');
      }

      if (silent) {
        const preview = mergeBackupIntoLocal(json, { dryRun: true });
        // Saved-for-later removals never hold — a cleanup on one device must
        // land here. Only a mass removal of guarded data (dismissed notes,
        // boards, pins) is held, and the hold is SURFACED: the old bare
        // `return` left the user never told a decision was waiting.
        const hold = evaluateMergeHold(preview.removals, SILENT_REMOVAL_LIMIT);
        if (hold.hold) {
          log(`Silent sync held: merge would remove ${hold.guardedCount} guarded item(s) — needs your confirmation`);
          setStatus('found');
          setMessage(`A newer backup is waiting — applying it would remove ${hold.guardedCount} item(s), so it needs your confirmation`);
          return;
        }
        if (hold.savedCleanupCount > SILENT_REMOVAL_LIMIT) {
          log(`Applying a large Saved for Later cleanup from another device (${hold.savedCleanupCount} notes)`);
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
      setLastSyncedManifestId(checkpoint.eventId);
      // Only a MANUAL restore counts as an explicit choice worth protecting
      // against a later silent override — a silent merge just following the
      // clock is not a deliberate decision to defend.
      if (!silent) setLastExplicitRestore({ id: checkpoint.eventId, timestamp: checkpoint.timestamp });
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
      restoringSince.current = 0;
    }
  }, [pubkey, signer, log, isRestoringNow]);

  const lastBackupAgo = lastBackupTs > 0 ? formatTimeAgo(lastBackupTs) : null;

  // Ship this device's log ring buffer as a NIP-44 self-encrypted event (kind
  // 30078, replaceable per device) so it's readable from web/desktop without
  // physical access to the phone. Publish-only here — web/desktop own the
  // fetch+decrypt+view side. Parity with web's publishDebugLog.
  const publishDebugLog = useCallback(async (): Promise<{ published: number; error?: string }> => {
    if (!pubkey || !signer?.nip44) return { published: 0, error: 'Not signed in, or signer lacks NIP-44.' };
    try {
      const payload = JSON.stringify({
        deviceId,
        platform: 'mobile',
        savedAt: Math.floor(Date.now() / 1000),
        lines: logs,
      });
      const encrypted = await signer.nip44.encrypt(pubkey, payload);
      const event = await signer.signEvent({
        kind: 30078,
        content: encrypted,
        tags: [['d', `corkboard:debug-log:${deviceId}`]],
        created_at: Math.floor(Date.now() / 1000),
      });
      const relays = getPublishRelays(pubkey);
      let published = 0;
      try { await nostr.event(event, { signal: AbortSignal.timeout(10000) }); published++; } catch { /* fall through */ }
      for (const url of relays) {
        const relay = createRelayFresh(url, { backoff: false });
        try { await relay.event(event, { signal: AbortSignal.timeout(8000) }); published++; }
        catch { /* continue */ }
        finally { try { relay.close(); } catch { /* */ } }
      }
      log(`Debug log published to ${published} relay target(s)`);
      return { published };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('Debug log publish failed: ' + msg);
      return { published: 0, error: msg };
    }
  }, [pubkey, signer, deviceId, logs, log, nostr]);

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
    publishDebugLog,
  };
}

// Re-export for use outside the hook (e.g. AppState listeners)
export { hasUnsavedChanges };
