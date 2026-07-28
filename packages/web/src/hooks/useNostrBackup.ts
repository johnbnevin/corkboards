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
 *   5. The AES key is encrypted to the user's own pubkey (NIP-44 when the
 *      signer supports it, falling back to NIP-04 only for legacy signers)
 *      and stored in the kind:30078 event — restore requires the same nsec.
 *
 * For NIP-46 (bunker) users, the AES key is encrypted locally first, and
 * the remote signer only signs the envelope event.
 *
 * Relevant NIPs: 44/04 (encryption), 78 (app-specific data), 94 (file metadata).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { triggerDownload } from '@/lib/triggerDownload';
import { BlossomUploader } from '@nostrify/nostrify/uploaders';
import type { NostrEvent, NPool } from '@nostrify/nostrify';
import type { NUser } from '@nostrify/react/login';
import { FALLBACK_RELAYS, getUserRelays, getRelayCache, updateRelayCache, createRelayFresh } from '@/components/NostrProvider';
import { BACKED_UP_KEYS, STORAGE_KEYS } from '@/lib/storageKeys';
import { fnv1a32 } from '@core/hashCore';
import { randomUuid } from '@core/cryptoUtils';
import { formatTimeAgo } from '@/lib/formatTimeAgo';
import { debugLog, debugWarn } from '@/lib/debug';
import { idbGetSync, idbGet, idbSetSync, idbRemoveSync, idbKeys, idbSet, idbReady, isIdbHealthy, withoutTombstoneRecording } from '@/lib/idb';
import {
  mergeState,
  STATE_FORMAT_VERSION,
  type StateSnapshot,
  type MergeResult,
  type TombstoneMap,
} from '@core/stateMerge';
import {
  getTombstones,
  mergeInTombstones,
  serializeTombstones,
  TOMBSTONE_STORAGE_KEY,
} from '@core/tombstones';
import {
  importAesKey, aesDecrypt, hexToRawKey, encryptForSelf,
} from '@/lib/nostrEncrypt';

/**
 * Decrypt a payload that was encrypted directly TO SELF with the signer (the
 * manifest envelope — not the AES-wrapped blob, which goes through
 * `@core/nostrEncrypt.decryptFromSelf`).
 *
 * Tries NIP-44 first, then falls back to NIP-04. The fallback is READ-ONLY and
 * exists because manifests written by older builds of this app (and by any
 * nip04-only signer) are NIP-04 and were otherwise permanently unrestorable:
 * the decrypt path called `nip44!.decrypt` and nothing else, so a legacy backup
 * failed with a bare "Decrypt failed" and the user's only cloud copy was
 * unreadable. Reading a legacy ciphertext is not a downgrade; WRITING one would
 * be, which is why the encrypt path (encryptForSelf) is NIP-44 only. (M7a)
 */
async function decryptSelfPayload(
  signer: { nip44?: { decrypt(pk: string, c: string): Promise<string> }; nip04?: { decrypt(pk: string, c: string): Promise<string> } },
  pubkey: string,
  ciphertext: string,
  timeoutMs = 5000,
): Promise<string> {
  const withTimeout = <T>(p: Promise<T>) => Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('decrypt_timeout')), timeoutMs)),
  ]);
  let firstErr: unknown;
  if (signer.nip44) {
    try { return await withTimeout(signer.nip44.decrypt(pubkey, ciphertext)); }
    catch (err) { firstErr = err; }
  }
  if (signer.nip04) {
    return withTimeout(signer.nip04.decrypt(pubkey, ciphertext));
  }
  throw firstErr ?? new Error('Signer supports neither NIP-44 nor NIP-04 decryption');
}

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
// Bounded ring for manual/named backups. Each manual save reuses one of a fixed
// set of slot d-tags (`corkboard:backup:s0`..`s{N-1}`) round-robin, so on-relay
// storage stays capped at N addressable events instead of leaking a fresh
// timestamp-tagged event on every save. Autosave keeps its own `:auto` slot.
const MANUAL_BACKUP_SLOTS = 5;
const BACKUP_SLOT_CURSOR_KEY = STORAGE_KEYS.BACKUP_SLOT_CURSOR;

// Default blossom servers for backup file upload.
// blossom.band is excluded: it rejects application/octet-stream blobs (HTTP 415)
// and only accepts image/media uploads. The remaining servers accept text/plain blobs.
// Servers that turn out to reject the backup-blob type at runtime are flagged via
// markBlobRejectingServer (below) and skipped by getActiveBlossomServers.
export const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.primal.net/',
  'https://blossom.nostr.build/',
  'https://blossom.yakihonne.com/',
  'https://blossom.ditto.pub/',
];

const BLOSSOM_SERVERS_KEY = STORAGE_KEYS.BLOSSOM_SERVERS;
const BLOSSOM_BLOB_REJECTS_KEY = STORAGE_KEYS.BLOSSOM_BLOB_REJECTS;
// Aim for this many independent Blossom copies of each backup blob (redundancy).
// We stop once this many succeed; a save is only a failure when ZERO copies land.
const REDUNDANT_COPIES = 3;

function normalizeServer(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

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
  // idbSetSync already schedules the async IDB persist internally — no need to
  // also call idbSet (that was a redundant double-write of the same value).
  idbSetSync(BLOSSOM_SERVERS_KEY, JSON.stringify(servers));
}

// created_at of the kind-10063 event the stored blossom list was last synced
// from (0 if it has only ever come from local edits / defaults / a backup). Used
// for newer-wins reconciliation on login so a fresh relay list overrides a stale
// cached/restored one, but a local edit isn't clobbered by an older relay event.
const BLOSSOM_SERVERS_TS_KEY = 'corkboard:blossom-servers-updated-at';

export function getBlossomServersUpdatedAt(): number {
  const raw = idbGetSync(BLOSSOM_SERVERS_TS_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

export function setBlossomServersUpdatedAt(ts: number): void {
  idbSetSync(BLOSSOM_SERVERS_TS_KEY, String(ts));
}

/**
 * Servers that have rejected the backup-blob content type (HTTP 415). These
 * still work for image/media uploads (that path is separate — see useUploadFile),
 * but are useless for the text/octet-stream backup blob, so we skip them on save
 * and surface them in Settings with a "consider removing" prompt.
 */
/**
 * How long a server stays flagged after rejecting a backup blob.
 *
 * Flags used to be PERMANENT. One 415 — or anything misread as one, including a
 * transient proxy error — and that server was excluded from every future save
 * for the life of the profile, with nothing in the UI to say so. Over time the
 * flagged set grows and `getActiveBlossomServers` can whittle a healthy list of
 * eight servers down to the one that is actually broken, at which point every
 * save fails while the settings screen still shows eight. Servers get fixed and
 * reconfigured; the flag has to be able to expire.
 */
const BLOB_REJECT_TTL_MS = 24 * 60 * 60 * 1000;

/** Flag records: server -> when it was flagged. Legacy arrays are read as
 *  "flagged just now" so an upgrade doesn't resurrect a stale blacklist. */
function readBlobRejectRecords(): Map<string, number> {
  const stored = idbGetSync(BLOSSOM_BLOB_REJECTS_KEY);
  if (!stored) return new Map();
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) {
      const now = Date.now();
      return new Map(parsed.map((s: string) => [normalizeServer(s), now]));
    }
    if (parsed && typeof parsed === 'object') {
      return new Map(Object.entries(parsed as Record<string, number>)
        .map(([k, v]) => [normalizeServer(k), Number(v) || 0]));
    }
  } catch { /* fall through */ }
  return new Map();
}

export function getBlobRejectingServers(): Set<string> {
  const now = Date.now();
  const live = new Set<string>();
  for (const [server, at] of readBlobRejectRecords()) {
    if (now - at < BLOB_REJECT_TTL_MS) live.add(server);
  }
  return live;
}

export function markBlobRejectingServer(url: string): void {
  const records = readBlobRejectRecords();
  records.set(normalizeServer(url), Date.now());
  idbSetSync(BLOSSOM_BLOB_REJECTS_KEY, JSON.stringify(Object.fromEntries(records)));
}

export function clearBlobRejectingServer(url: string): void {
  const records = readBlobRejectRecords();
  if (records.delete(normalizeServer(url))) {
    idbSetSync(BLOSSOM_BLOB_REJECTS_KEY, JSON.stringify(Object.fromEntries(records)));
  }
}

export function isBlobRejectingServer(url: string): boolean {
  return getBlobRejectingServers().has(normalizeServer(url));
}

/** True when an upload error indicates the server rejected the blob's content type. */
function isContentTypeRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b415\b/.test(msg) || /unsupported media type/i.test(msg);
}

// Resolved list used throughout this module. Skips servers known to reject the
// backup-blob type; if that would leave nothing, falls back to the full list
// (the flags may be stale / the network may have changed).
function getActiveBlossomServers(): string[] {
  const all = getBlossomServers();
  const rejects = getBlobRejectingServers();
  const usable = all.filter(s => !rejects.has(normalizeServer(s)));
  const flagged = all.filter(s => rejects.has(normalizeServer(s)));
  // Flagged servers go to the BACK of the queue rather than being dropped. The
  // upload stops as soon as it has enough copies, so a healthy server list never
  // reaches them — but if the healthy ones are down, trying a maybe-broken
  // server beats reporting "no servers" while the user is looking at eight of
  // them in settings.
  return [...usable, ...flagged];
}

/**
 * Upload the backup blob to Blossom servers aiming for REDUNDANT_COPIES copies.
 * Tries servers in priority order and stops once enough copies land. Detects
 * content-type rejections (415) and flags those servers so future saves skip them.
 * Returns the first (primary) URL/hash, the number of copies that landed, and any
 * per-server errors.
 */
async function uploadBlobWithRedundancy(
  file: File,
  signer: NUser['signer'],
  servers: string[],
  onLog?: (msg: string, level?: 'log' | 'warn' | 'error') => void,
): Promise<{ url: string | null; hash: string | null; count: number; errors: string[] }> {
  let url: string | null = null;
  let hash: string | null = null;
  let count = 0;
  const errors: string[] = [];
  for (const server of servers) {
    if (count >= REDUNDANT_COPIES) break;
    try {
      const uploader = new BlossomUploader({ servers: [server], signer });
      const tags = await Promise.race([
        uploader.upload(file),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
      ]);
      const urlTag = tags.find((t: string[]) => t[0] === 'url');
      const hashTag = tags.find((t: string[]) => t[0] === 'x' || t[0] === 'sha256');
      if (urlTag?.[1]) {
        if (!url) { url = urlTag[1]; hash = hashTag?.[1] ?? null; }
        count++;
        onLog?.(`  Uploaded to ${server} (${count}/${REDUNDANT_COPIES})`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isContentTypeRejection(err)) {
        markBlobRejectingServer(server);
        onLog?.(`  ${server} rejects backup blobs (HTTP 415) — flagged; consider removing it`, 'warn');
      } else {
        onLog?.(`  ${server} failed: ${errMsg}`, 'warn');
      }
      try { errors.push(`${new URL(server).hostname}: ${errMsg}`); } catch { errors.push(errMsg); }
    }
  }
  return { url, hash, count, errors };
}

/** Result of an auto-save attempt — lets callers show accurate messaging. */
/**
 * `blocked` is distinct from `skipped` on purpose. A skip is benign — nothing to
 * save, or a save already running. A block is a protective guard refusing to
 * overwrite the cloud because local data looks smaller than the last backup.
 * Both used to return 'skipped', so a device whose guard was tripping sat with a
 * red indicator and no toast, saving nothing, indefinitely — which is the exact
 * data-loss scenario the guard exists to prevent, just moved to the other end.
 */
export type AutoSaveResult = 'saved' | 'skipped' | 'blocked' | 'no-servers' | 'error';

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
  // Dedup by d-tag only — addressable events replace each other, keep newest per tag.
  // Stats-based dedup was removed: it silently discarded valid checkpoints that
  // happened to share the same corkboard/dismissed counts.
  const byDTag = new Map<string, RemoteCheckpoint>();
  for (const cp of cps) {
    const key = cp.dTag || cp.eventId;
    const existing = byDTag.get(key);
    if (!existing || cp.timestamp > existing.timestamp) {
      byDTag.set(key, cp);
    }
  }
  const deduped = [...byDTag.values()].sort((a, b) => b.timestamp - a.timestamp);
  idbSetSync(CHECKPOINTS_KEY, JSON.stringify(deduped));
}

interface RelayResult {
  url: string;
  success: boolean;
  error?: string;
}

/**
 * Serialize all backed-up keys, plus the metadata a merge needs.
 *
 * v5 wraps the flat key map in an envelope carrying `savedAt` and the removal
 * log. Both are what let the other device MERGE this snapshot instead of
 * replacing its own state with it: `savedAt` orders the two sides, tombstones
 * say which absences are deliberate. A v4 blob (a bare key map) still restores
 * — see `parseBackup` — it just can't contribute removals.
 */
function serializeBackup(): string {
  const keys: Record<string, string | null> = {};
  for (const key of BACKED_UP_KEYS) {
    keys[key] = idbGetSync(key);
  }
  return JSON.stringify({
    v: STATE_FORMAT_VERSION,
    savedAt: Math.floor(Date.now() / 1000),
    keys,
    tombstones: getTombstones(),
  });
}

/**
 * Read either format. v4 blobs are a bare `{key: value}` map with no timestamp;
 * they get `savedAt: 0` so any v5 snapshot is treated as newer, which is right
 * — a v4 blob predates this build.
 */
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

/** The local side of a merge, read straight out of the cache. */
function localSnapshot(): StateSnapshot {
  const keys: Record<string, string | null> = {};
  for (const key of BACKED_UP_KEYS) keys[key] = idbGetSync(key);
  return {
    keys,
    savedAt: parseInt(idbGetSync(LAST_BACKUP_TS_KEY) || '0', 10),
    tombstones: getTombstones(),
  };
}

// Write backup data back to IDB - returns promise that resolves when all writes complete.
// Uses idbSet (async, awaited) for persistence guarantee before page reload,
// plus idbSetSync dispatches sync events so useLocalStorage hooks update in-flight.
/**
 * MERGE a cloud snapshot into local state (was: overwrite local with it).
 *
 * The old wholesale replace is why restore had to be fenced off behind "only
 * when local looks empty" and "only when the cloud has 5+ more dismissed" — run
 * unguarded, it could delete work. A merge cannot: id sets union, corkboards
 * merge per board, and removals are carried by tombstones rather than by
 * absence. So this can run whenever the cloud is newer, which is what makes a
 * second device actually pick up where the first left off.
 *
 * Returns what changed, so the caller can tell the difference between a silent
 * additive merge and one that would drop something the user has locally.
 */
async function mergeBackupIntoLocal(
  json: string,
  log?: (msg: string) => void,
  opts?: { dryRun?: boolean },
): Promise<{ restored: number; removals: MergeResult['removals'] }> {
  const remote = parseBackup(json);
  const result = mergeState(localSnapshot(), remote);

  // Dry run: answer "would this take anything away?" without touching storage,
  // so the caller can apply a purely additive merge silently and ask first when
  // it would not be.
  if (opts?.dryRun) {
    return { restored: result.changedKeys.length, removals: result.removals };
  }

  // The merged values are authoritative — recording removals off them would
  // tombstone ids the merge deliberately dropped and make them unrestorable.
  const writes: Promise<void>[] = [];
  let restored = 0;
  withoutTombstoneRecording(() => {
    for (const key of result.changedKeys) {
      const value = result.keys[key];
      if (!(BACKED_UP_KEYS as readonly string[]).includes(key)) continue;
      if (value === null || value === undefined) {
        idbRemoveSync(key);
        continue;
      }
      idbSetSync(key, value);
      writes.push(idbSet(key, value));
      restored++;
    }
  });

  // Adopt the union of both logs so this device now enforces the other's
  // deletions too, and persist it.
  mergeInTombstones(result.tombstones);
  withoutTombstoneRecording(() => {
    idbSetSync(TOMBSTONE_STORAGE_KEY, serializeTombstones());
  });

  for (const key of result.changedKeys) {
    const value = result.keys[key];
    if (value === null || value === undefined) continue;
    if (!(BACKED_UP_KEYS as readonly string[]).includes(key)) continue;
    window.dispatchEvent(
      new CustomEvent('idb-storage-sync', {
        detail: { key, value: (() => { try { return JSON.parse(value); } catch { return value; } })() },
      })
    );
  }

  await Promise.all(writes);
  log?.(`Merged: ${restored} keys changed, ${result.removals.length} keys had removals`);
  return { restored, removals: result.removals };
}

async function deserializeBackup(json: string, log?: (msg: string) => void): Promise<number> {
  const data: Record<string, string | null> = parseBackup(json).keys;
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


// Keys tracked for change detection (shared between save, auto-save, and restore).
//
// This list is what `hasUnsavedChanges()` hashes and what the auto-save
// regression guard counts, so a key missing from it is a key whose changes never
// trigger a backup. Two consequences that were live bugs:
//   - BOOKMARK_IDS was absent while `snapshotCounts()` read
//     `snapshot['nostr-bookmark-ids']` — so the bookmark count was ALWAYS 0 and
//     the guard could never notice bookmarks disappearing.
//   - DISMISSED_THREAD_ROOTS / PINNED_NOTE_IDS / RENDER_MARKDOWN are per-user
//     isolated and backed up, but edits to them alone left the app believing
//     nothing had changed.
const SNAPSHOT_KEYS = [
  STORAGE_KEYS.CUSTOM_FEEDS,
  STORAGE_KEYS.COLLAPSED_NOTES,
  STORAGE_KEYS.DISMISSED_NOTES,
  STORAGE_KEYS.DISMISSED_THREAD_ROOTS,
  STORAGE_KEYS.FRIENDS,
  STORAGE_KEYS.BROWSE_RELAYS,
  STORAGE_KEYS.RSS_FEEDS,
  STORAGE_KEYS.SAVED_MINIMIZED_NOTES,
  STORAGE_KEYS.BOOKMARK_IDS,
  STORAGE_KEYS.PINNED_NOTE_IDS,
  STORAGE_KEYS.TAB_FILTERS,
  STORAGE_KEYS.ONBOARDING_SKIPPED,
  STORAGE_KEYS.BANNER_HEIGHT_PCT,
  STORAGE_KEYS.BANNER_FIT_MODE,
  STORAGE_KEYS.RENDER_MARKDOWN,
] as const;

/**
 * Counts of meaningful items at last-backup time — small enough to keep in
 * memCache so the auto-save regression guard can read them synchronously.
 * (The full LAST_BACKUP_DATA blob is excluded from memCache because it can
 * grow to several MB; that exclusion made the legacy guard a no-op.)
 */
interface LastBackupCounts {
  dismissed: number;
  feeds: number;
  collapsed: number;
  bookmarks: number;
}

function countArrayJson(raw: string | undefined | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch { return 0; }
}

function snapshotCounts(snapshot: Record<string, string>): LastBackupCounts {
  return {
    dismissed: countArrayJson(snapshot['dismissed-notes']),
    feeds: countArrayJson(snapshot['nostr-custom-feeds']),
    collapsed: countArrayJson(snapshot['collapsed-notes']),
    bookmarks: countArrayJson(snapshot['nostr-bookmark-ids']),
  };
}

/**
 * Write the full snapshot blob (for restore/preflight) plus two small
 * companion keys that DO fit in memCache:
 *   - last-backup-hashes: per-key FNV-1a hashes for fast change detection
 *   - last-backup-counts: item counts for the auto-save regression guard
 */
function persistSnapshotAndHashes(snapshot: Record<string, string>): void {
  idbSetSync('corkboard:last-backup-data', JSON.stringify(snapshot));
  const hashes: Record<string, string> = {};
  for (const key of SNAPSHOT_KEYS) hashes[key] = fnv1a32(snapshot[key] || '');
  idbSetSync('corkboard:last-backup-hashes', JSON.stringify(hashes));
  idbSetSync('corkboard:last-backup-counts', JSON.stringify(snapshotCounts(snapshot)));
}

// Module-level guard: prevents double backup check across component remounts.
// Keyed by pubkey so switching accounts still triggers a check.
let _checkedPubkey: string | null = null;

// Module-level save/restore mutexes.
//
// These were per-instance `useRef`s, which made them no guard at all: every
// mount of useNostrBackup got its OWN flag, so a manual save from Settings and
// the visibilitychange auto-save (different component trees, different
// instances) could run concurrently, each uploading a blob and each publishing a
// kind-30078 to the same d-tag — last writer wins, and the loser's data is gone.
// Worse, `autoSaveBackup` checks `isRestoring` to avoid uploading a HALF-RESTORED
// IDB as the canonical cloud state; with a per-instance ref, a restore running
// in one component simply did not stop an auto-save in another. Backup state is
// process-global, so its mutex must be too. (L19)
const _backupMutex = { saving: false, restoring: false };

// Module-level in-flight dedupe: if a check is already running for a pubkey,
// concurrent callers share that promise instead of starting a parallel run.
// Defends against effect-deps changes during the (potentially slow, with
// bunker signers) network phase — every extra concurrent call would
// otherwise open a fresh set of relay sockets and flood the splash log.
let _checkInFlight: { pubkey: string; promise: Promise<void> } | null = null;

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

  const manifestEventRef = useRef<NostrEvent | null>(null);
  const manifestDataRef = useRef<Record<string, unknown> | null>(null);
  const idbReadyChecked = useRef(false);

  // Persistent device ID for cross-device sync — stays local, never backed up.
  // Included in backup manifests so we can detect when a different device saved.
  const [deviceId] = useState(() => {
    const existing = idbGetSync('corkboard:device-id');
    if (existing) return existing;
    // randomUuid() (getRandomValues-based) rather than crypto.randomUUID(),
    // which is absent on React Native/Hermes — keeps this identical across
    // platforms and non-crashing wherever the shared code is reused.
    const id = randomUuid();
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
  // Reads a per-key hash map (small, memCache-friendly) instead of the full snapshot
  // blob — LAST_BACKUP_DATA is intentionally excluded from memCache because it can
  // be hundreds of KB and would inflate every cold-start. The hash map fits in
  // ~500 bytes so it's always sync-readable.
  const hasUnsavedChanges = useCallback(() => {
    const savedHashes = idbGetSync('corkboard:last-backup-hashes');
    if (!savedHashes) {
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
      const lastHashes: Record<string, string> = JSON.parse(savedHashes);
      for (const key of SNAPSHOT_KEYS) {
        const current = idbGetSync(key) || '';
        const currentHash = fnv1a32(current);
        const lastHash = lastHashes[key] || fnv1a32('');
        if (currentHash !== lastHash) {
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
  const saveBackup = useCallback(async (): Promise<boolean> => {
    if (!user || _backupMutex.saving) {
      log('Save skipped: ' + (!user ? 'no user' : 'already saving'));
      return false;
    }
    _backupMutex.saving = true;
    log('Starting save...');

    try {
      const json = serializeBackup();
      const jsonBytes = new TextEncoder().encode(json).length;
      log(`Serialized: ${jsonBytes} bytes`);

      setStatus('encrypting');
      setMessage('Encrypting backup...');

      const pubkey = user.pubkey;
      const signer = user.signer;

      // NIP-44 is required to WRITE a backup. This used to accept a nip04-only
      // signer and silently wrap the AES key with deprecated NIP-04, and the
      // manifest below fell back further still — to PLAINTEXT — leaking the
      // user's corkboard names, item counts and Blossom URL onto public relays
      // whenever nip44 was absent. A weaker-or-absent encryption path is a
      // consent decision, not a catch block, so we fail loudly instead.
      // Legacy NIP-04 backups remain RESTORABLE (see decryptSelfPayload). (M7b)
      if (!signer.nip44) {
        log('Signer does not support NIP-44 encryption', 'error');
        setStatus('save-error');
        setMessage('Backup failed: your signer does not support NIP-44 encryption, which is required to encrypt a backup.');
        _backupMutex.saving = false;
        return false;
      }

      const now = Math.floor(Date.now() / 1000);

      // AES-256-GCM blob + NIP-44-wrapped key, via the single shared
      // implementation in @core/nostrEncrypt (which is NIP-44-only by design).
      log('Encrypting backup (AES-256-GCM, NIP-44 wrapped key)...');
      const { content: encryptedData, wrappedKey, signerMethod } =
        await encryptForSelf(json, signer, pubkey);
      log(`Encrypted: ${encryptedData.length} chars`);

      // Upload encrypted backup to Blossom as a single file
      setStatus('saving');
      setMessage('Uploading encrypted backup to Blossom...');

      const blob = new Blob([encryptedData], { type: 'text/plain' });
      const file = new File([blob], 'corkboard-backup.txt', { type: 'text/plain' });

      const servers = getActiveBlossomServers();
      setMessage(`Uploading to Blossom (${servers.length} server${servers.length === 1 ? '' : 's'})...`);
      const { url: blossomUrl, hash: blossomHash, count: blossomServerCount, errors: serverErrors } =
        await uploadBlobWithRedundancy(file, signer, servers, log);

      if (!blossomUrl) {
        throw new Error(`All ${servers.length} Blossom servers failed:\n${serverErrors.join('\n')}`);
      }
      log(`Backup landed on ${blossomServerCount}/${servers.length} Blossom server(s)`);

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

      // Encrypt manifest so corkboard names, stats, and Blossom URL aren't leaked.
      // NIP-44 only — the nip04-then-plaintext ladder that used to live here is
      // gone (see the guard above); `signer.nip44` is proven present by now.
      const manifestJson = JSON.stringify(manifestData);
      const encryptedManifest = await signer.nip44!.encrypt(pubkey, manifestJson);

      // Bounded ring: rotate through a fixed set of slots instead of minting a
      // new timestamp d-tag per save (which accumulated forever on relays).
      // Forward-only — pre-existing timestamp-tagged backups are left untouched
      // and age out with the relays naturally.
      const slotCursor = parseInt(idbGetSync(BACKUP_SLOT_CURSOR_KEY) || '0', 10) || 0;
      const slot = ((slotCursor % MANUAL_BACKUP_SLOTS) + MANUAL_BACKUP_SLOTS) % MANUAL_BACKUP_SLOTS;
      const dTag = `${D_TAG_PREFIX}:s${slot}`;
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
        const relay = createRelayFresh(url, { backoff: false });
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
            const relay = createRelayFresh(r.url, { backoff: false });
            try { await relay.event(tombstone, { signal: AbortSignal.timeout(5000) }); } catch { /* ignore */ }
            finally { try { relay.close(); } catch { /* ignore */ } }
          }
        }
      }

      if (succeeded.length === 0) {
        setStatus('save-error');
        setMessage('Backup failed: could not reach any relay');
        log('TOTAL FAILURE: no relays accepted', 'error');
        return false;
      } else {
        setStatus('saved');
        idbSetSync(LAST_BACKUP_TS_KEY, String(now));
        idbSetSync(LAST_CHUNK_COUNT_KEY, '0'); // v4 uses Blossom, no chunks
        idbSetSync(BACKUP_SLOT_CURSOR_KEY, String(slotCursor + 1)); // advance the ring
        idbRemoveSync('corkboard:preferred-checkpoint'); // new save is now the latest
        setLastBackupTs(now);

        // Store snapshot of data + per-key hashes for change detection
        const snapshot: Record<string, string> = {};
        for (const key of SNAPSHOT_KEYS) snapshot[key] = idbGetSync(key) || '';
        persistSnapshotAndHashes(snapshot);

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
        return true;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('Save failed: ' + errMsg, 'error');
      setStatus('save-error');
      setMessage('Backup failed: ' + errMsg);
      return false;
    } finally {
      _backupMutex.saving = false;
    }
  }, [user, log, deviceId]);

  // Ref for refreshing checkpoint React state from autoSaveBackup (defined before
  // checkpoint state, but populated after — avoids circular dependency).
  const refreshCheckpointsRef = useRef<() => void>(() => {});

  // Auto-save: silent background save using a fixed d-tag (overwrites itself).
  // Returns a status so callers can distinguish a genuine upload failure
  // ('no-servers'/'error', worth a toast) from a benign protective skip
  // ('skipped', silent) — the two used to collapse into a bare false and
  // surface the same misleading "Could not save to Blossom" toast.
  const autoSaveBackup = useCallback(async (): Promise<AutoSaveResult> => {
    if (!user || _backupMutex.saving || _backupMutex.restoring) return 'skipped';
    if (!hasUnsavedChanges()) return 'skipped';

    // Guard: don't overwrite a good cloud backup with empty/corrupt local state.
    // If IDB writes have been failing, memCache may not reflect what's on disk.
    if (!isIdbHealthy()) {
      debugWarn('[backup]', 'Auto-save blocked: IDB writes are failing — protecting cloud backup');
      return 'blocked';
    }

    // Guard: don't save if the data is essentially empty (no feeds, no dismissed, no collapsed).
    // This prevents overwriting a good backup after IDB was wiped (e.g. browser cleanup).
    const feeds = idbGetSync('nostr-custom-feeds');
    const dismissed = idbGetSync('dismissed-notes');
    const collapsed = idbGetSync('collapsed-notes');
    const hasMeaningfulData = (feeds && feeds !== '[]') || (dismissed && dismissed !== '[]') || (collapsed && collapsed !== '[]');
    if (!hasMeaningfulData) {
      debugWarn('[backup]', 'Auto-save blocked: no meaningful data to save (feeds/dismissed/collapsed all empty)');
      return 'skipped';
    }

    // Guard: don't save if key data regressed significantly vs last snapshot.
    // Reads the small last-backup-counts companion key (which IS in memCache)
    // instead of the LAST_BACKUP_DATA full blob (which isn't). Three real
    // production data-loss incidents were caused by this guard being dead
    // code; now it actually runs.
    const lastCountsRaw = idbGetSync('corkboard:last-backup-counts');
    if (lastCountsRaw) {
      try {
        const prev = JSON.parse(lastCountsRaw) as LastBackupCounts;

        const currDismissed = countArrayJson(dismissed);
        if (prev.dismissed > 20 && currDismissed < prev.dismissed * 0.5) {
          debugWarn('[backup]', `Auto-save blocked: dismissed notes dropped from ${prev.dismissed} to ${currDismissed} — IDB may be partially cleared`);
          return 'blocked';
        }

        const currFeeds = countArrayJson(feeds);
        if (prev.feeds > 0 && currFeeds === 0) {
          debugWarn('[backup]', 'Auto-save blocked: custom feeds dropped to zero — IDB may be partially cleared');
          return 'blocked';
        }

        const currCollapsed = countArrayJson(collapsed);
        if (prev.collapsed > 10 && currCollapsed < prev.collapsed * 0.5) {
          debugWarn('[backup]', `Auto-save blocked: saved notes dropped from ${prev.collapsed} to ${currCollapsed} — IDB may be partially cleared`);
          return 'blocked';
        }
      } catch { /* ignore parse errors — don't block save on unexpected format */ }
    }

    _backupMutex.saving = true;

    try {
      const json = serializeBackup();
      const pubkey = user.pubkey;
      const signer = user.signer;
      // NIP-44 only on the write path — same reasoning as saveBackup. (M7b)
      if (!signer.nip44) { _backupMutex.saving = false; return 'skipped'; }

      const now = Math.floor(Date.now() / 1000);
      const { content: encryptedData, wrappedKey, signerMethod } =
        await encryptForSelf(json, signer, pubkey);

      const blob = new Blob([encryptedData], { type: 'text/plain' });
      const file = new File([blob], 'corkboard-autosave.txt', { type: 'text/plain' });

      // Redundant, 415-aware upload (skips servers known to reject the blob type).
      const { url: blossomUrl, hash: blossomHash } =
        await uploadBlobWithRedundancy(file, signer, getActiveBlossomServers());
      if (!blossomUrl) { _backupMutex.saving = false; return 'no-servers'; }

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
      // NIP-44 only — never NIP-04, never plaintext. (M7b)
      const encryptedAutoManifest = await signer.nip44!.encrypt(pubkey, autoManifestJson);

      const manifestEvent = await signer.signEvent({
        kind: 30078,
        content: encryptedAutoManifest,
        tags: [['d', `${D_TAG_PREFIX}:auto`]],
        created_at: now,
      });

      const { primary, fallback } = getPublishRelays(pubkey);
      for (const url of [...primary, ...fallback]) {
        const relay = createRelayFresh(url, { backoff: false });
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
      persistSnapshotAndHashes(snapshot);

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
      let updatedCps: RemoteCheckpoint[];
      if (statsChanged || !latestAuto) {
        updatedCps = [autoEntry, ...cps];
      } else {
        // Same stats — update the latest entry immutably
        updatedCps = cps.map(c => c === latestAuto
          ? { ...c, timestamp: now, eventId: manifestEvent.id, blossomUrl: blossomUrl!, ...(blossomHash ? { blossomHash } : {}), wrappedKey }
          : c
        );
      }
      // Keep max 3 total: always preserve named (user-created) checkpoints, fill rest with most recent
      const updatedSorted = updatedCps.sort((a, b) => b.timestamp - a.timestamp);
      const namedCpsAuto = updatedSorted.filter(c => c.name);
      const unnamedCpsAuto = updatedSorted.filter(c => !c.name);
      const merged = [...namedCpsAuto, ...unnamedCpsAuto.slice(0, Math.max(0, 3 - namedCpsAuto.length))].sort((a, b) => b.timestamp - a.timestamp);
      setStoredCheckpoints(merged);
      refreshCheckpointsRef.current();

      debugLog('[backup]', 'Auto-save complete');
      return 'saved';
    } catch {
      debugWarn('[backup]', 'Auto-save failed');
      return 'error';
    } finally {
      _backupMutex.saving = false;
    }
  }, [user, hasUnsavedChanges, deviceId]);

  // Query relays in small batches (2–3 at a time) — stop early when results found.
  // Avoids overwhelming mobile browsers with 10+ simultaneous WebSocket connections.
  // Tracks which relays were used so post-login fetches can prefer the others.
  //
  // `minRelaysWithResults` is how many relays must ANSWER WITH DATA before we
  // stop early. Default 1 preserves the cheap "first hit wins" behaviour for
  // chunk fetches, where any copy is as good as another. For the addressable
  // manifest it must be higher: kind 30078 is replaceable per d-tag, so each
  // relay holds exactly one event per tag and they can DISAGREE — a relay that
  // missed the last few autosaves answers instantly with a stale manifest, and
  // stopping there restored an old backup over newer data. Collecting from a
  // few relays and taking max(created_at) is what makes "newest wins" true
  // rather than "fastest wins".
  const queryAll = useCallback(async (filter: { kinds: number[]; authors: string[]; '#d'?: string[]; limit?: number }, label: string, specificRelays?: string[], _checkAll = false, overallTimeoutMs = 15000, perRelayTimeoutMs = 5000, minRelaysWithResults = 1): Promise<NostrEvent[]> => {
    const pubkey = user?.pubkey || '';
    const primaryRelays = specificRelays?.map(normalizeRelay) || [];
    const { primary: writePrimary, fallback: writeFallback } = pubkey
      ? getPublishRelays(pubkey)
      : { primary: [], fallback: [] };
    const relayUrls = [...primaryRelays];
    for (const r of [...writePrimary, ...writeFallback]) {
      if (!relayUrls.includes(r)) relayUrls.push(r);
    }

    // Only filter user-blocked relays, NOT rate-limit backoff — backup queries
    // are critical for login and must try every relay even if it failed recently.
    const activeRelayUrls = relayUrls.filter(url => !isRelayBlocked(url));
    log(`  Checking ${activeRelayUrls.length} relays for ${label}${_checkAll ? ' (all, newest wins)' : ` (stop after ${minRelaysWithResults} with results)`}`);

    const seen = new Set<string>();
    const allEvents: NostrEvent[] = [];
    const overallAbort = new AbortController();
    const overallTimeout = setTimeout(() => overallAbort.abort(), overallTimeoutMs);

    const queryRelay = async (url: string): Promise<NostrEvent[]> => {
      try {
        // Bypass backoff — backup queries are critical for login
        const relay = createRelayFresh(normalizeRelay(url), { backoff: false });
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

    // Query relays one at a time — stop once enough relays have answered with
    // data (unless checkAll). This avoids opening connections to relays that are
    // down when another works, while still sampling more than one source when
    // the caller needs a newest-wins comparison.
    if (_checkAll) {
      // Ask EVERY relay, in parallel, and keep everything. Required whenever the
      // caller picks by max(created_at): a replaceable event can be stale on any
      // given relay, and the relays that answer FASTEST are not the ones that
      // are freshest. Sampling the first few responders is how a lagging relay's
      // old manifest gets treated as current. One tiny event per relay, so the
      // cost of asking all of them is a few hundred ms in parallel.
      const results = await Promise.all(activeRelayUrls.map(queryRelay));
      for (const events of results) {
        for (const ev of events) {
          if (!seen.has(ev.id)) { seen.add(ev.id); allEvents.push(ev); }
        }
      }
    } else {
      let relaysWithResults = 0;
      for (const url of activeRelayUrls) {
        if (overallAbort.signal.aborted) break;
        const events = await queryRelay(url);
        if (events.length > 0) relaysWithResults++;
        for (const ev of events) {
          if (!seen.has(ev.id)) { seen.add(ev.id); allEvents.push(ev); }
        }
        if (relaysWithResults >= minRelaysWithResults) break;
      }
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

     // Concurrent-call dedupe: if a check is already running for this pubkey,
     // join its promise instead of starting a parallel run. Effective even if
     // a future change re-introduces effect re-firing.
     if (!force && _checkInFlight && _checkInFlight.pubkey === user.pubkey) {
       return _checkInFlight.promise;
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

     // Fast path: localStorage mirror is written after every restore/dismiss and survives
     // IDB clears (e.g. fresh AppImage install, browser data wipe). Lets us skip the
     // blocking relay check without waiting for idbReady.
     if (!force) {
       try {
         if (localStorage.getItem(LS_BACKUP_CHECKED_PREFIX + user.pubkey)) {
           log('Check skipped: backup already handled (localStorage mirror)');
           _checkedPubkey = user.pubkey;
           const stored = getStoredCheckpoints();
           if (stored.length > 0) setCheckpoints(stored);
           setStatus('idle');
           setCheckSettled(true);
           return;
         }
       } catch { /* localStorage unavailable */ }
     }

     // Register the in-flight promise NOW — before any awaits — so concurrent
     // callers (effect re-fires, multi-mount of useNostrBackup) all short-
     // circuit at the guard above instead of slipping through and racing to
     // log "Waiting for IDB to be ready...", "Checking for remote backup...",
     // etc. into the splash log. This pairs with v0.7.6's later registration
     // (kept as a defence-in-depth no-op) and supersedes it as the primary
     // dedupe point.
     let _resolveInFlight: () => void = () => {};
     _checkInFlight = {
       pubkey: user.pubkey,
       promise: new Promise<void>((resolve) => { _resolveInFlight = resolve; }),
     };
     const _clearInFlight = () => {
       _resolveInFlight();
       if (_checkInFlight && _checkInFlight.pubkey === user.pubkey) _checkInFlight = null;
     };

     // CRITICAL: Wait for IDB memCache to be populated before reading the checked flag.
     // On page reload, memCache is empty until idbReady resolves, so idbGetSync() would
     // return null even if the flag was persisted — causing a double backup check.
     if (!idbReadyChecked.current) {
       idbReadyChecked.current = true;
       log('Waiting for IDB to be ready...');
       await idbReady;
       log('IDB ready, memCache populated');
     }

     // Skip if backup was already checked/restored for this user (persisted across refreshes) — unless forced
     const checkedKey = `${BACKUP_CHECKED_KEY}:${user.pubkey}`;
     if (!force && idbGetSync(checkedKey)) {
       log('Check skipped: backup already checked for this user (flag found after IDB ready)');
       _checkedPubkey = user.pubkey;
       _clearInFlight();
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

    // Prevent concurrent calls (post-await; the in-flight Promise above
    // catches anyone who entered while we were awaiting IDB).
    _checkedPubkey = user.pubkey;

    try {
      const pubkey = user.pubkey;

      // Step 0: Fetch user's kind 10002 relay list so we know their write relays.
      // Query discovery relays in batches of 3, stop early once found.
      if (getRelayCache(pubkey).length === 0) {
        setMessage('Finding your relays...');
        log('Fetching kind 10002 relay list from fallback relays...');
        const relayEvents: NostrEvent[] = [];
        // Sample up to 3 relays rather than stopping at the first responder.
        // kind 10002 is replaceable, so relays hold one event each and they can
        // disagree; the reduce below picks max(created_at), which needs more than
        // one candidate to mean anything. Adopting a stale relay list here poisons
        // the whole session's outbox routing. (M7c)
        let answered = 0;
        for (const url of FALLBACK_RELAYS) {
          if (answered >= 3) break;
          let relay;
          try {
            relay = createRelayFresh(normalizeRelay(url), { backoff: false });
            const evts = await relay.query(
              [{ kinds: [10002], authors: [pubkey], limit: 1 }],
              { signal: AbortSignal.timeout(6000) }
            );
            // Guard against a relay answering with someone else's relay list.
            const mine = evts.filter(e => e.kind === 10002 && e.pubkey === pubkey);
            if (mine.length > 0) { relayEvents.push(...mine); answered++; }
          } catch { /* try next relay */ }
          finally { try { relay?.close(); } catch { /* */ } }
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

      // Query the autosave slot directly by d-tag — kind:30078 is addressable, so every
      // relay stores exactly 1 event per d-tag. No crowding from other NIP-78 apps.
      const allEvents = await queryAll(
        { kinds: [30078], authors: [pubkey], '#d': [`${D_TAG_PREFIX}:auto`], limit: 1 },
        'autosave manifest',
        undefined,
        // ALL relays, not a sample. `bestManifestEvent` below picks
        // max(created_at), and that is only correct if every relay was asked:
        // sampling the first 3 responders meant a lagging relay's stale manifest
        // could win simply by being quick, which then fed a stale timestamp to
        // the newer-backup check and stale counts to the auto-save regression
        // guard — the guard would refuse to save because "local looks smaller
        // than the backup", comparing against a backup that was not the newest.
        true,
        12000,
        5000,
      );
      const manifestEvents = allEvents; // relay already filtered by d-tag
      log(`Total: ${manifestEvents.length} autosave manifest events`);

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

      // Heal the divergence instead of only routing around it.
      //
      // Relays disagree because a publish failed on some of them at save time
      // and nothing ever retried, so one relay can sit on a months-old manifest
      // forever. Reading all relays and taking the newest (above) makes THIS
      // read correct; mirroring the winner back to the laggards makes every
      // future read correct, on every device.
      //
      // Cheap on purpose: the event is ALREADY SIGNED, so this re-publishes the
      // same bytes — no signer round-trip, which matters when signing goes
      // through a NIP-46 bunker. A couple of KB per lagging relay, fire and
      // forget, and only when the relays actually disagree.
      const staleManifest = manifestEvents.some(ev => ev.created_at < bestManifestEvent.created_at)
        || manifestEvents.length < _backupRelaysUsed.size;
      if (staleManifest) {
        const { primary, fallback } = getPublishRelays(pubkey);
        const targets = [...primary, ...fallback];
        log(`  Manifest differs across relays — mirroring the newest to ${targets.length}`);
        void (async () => {
          for (const url of targets) {
            const relay = createRelayFresh(normalizeRelay(url), { backoff: false });
            try { await relay.event(bestManifestEvent, { signal: AbortSignal.timeout(8000) }); }
            catch { /* a relay that won't take it is exactly the case we can't fix here */ }
            finally { try { relay.close(); } catch { /* */ } }
          }
        })();
      }

      // Store the raw manifest event for later use
      manifestEventRef.current = bestManifestEvent;

      type ManifestData = { v?: number; chunks?: number; timestamp?: number; keys?: string[]; relays?: string[]; corkboardNames?: string[]; encryption?: string; wrappedKey?: string; signerMethod?: string; blossomUrl?: string; blossomHash?: string; deviceId?: string; stats?: { corkboards: number; savedForLater: number; dismissed: number } };

      // Parse the best (newest) manifest for the restore flow
      let manifest: ManifestData | null = null;

      // New format: manifest is plaintext JSON
      try {
        manifest = JSON.parse(bestManifestEvent.content);
        manifestDataRef.current = manifest;
        log(`Manifest (plaintext): v=${manifest!.v}, chunks=${manifest!.chunks}, ts=${manifest!.timestamp}, relays=${manifest!.relays?.length || 'none'}`);
      } catch {
        // Encrypted manifest — NIP-44, or NIP-04 for backups written by older
        // builds. Trying only nip44 (what this did) made every legacy backup
        // permanently unrestorable. (M7a)
        log('Manifest is not plaintext JSON, decrypting (NIP-44, then legacy NIP-04)...');
        try {
          const manifestJson = await decryptSelfPayload(user.signer, pubkey, bestManifestEvent.content);
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

      // Update rolling checkpoint list (max 3) with the best manifest.
      // Safety: reject if the new manifest is significantly thinner than our stored newest
      // (e.g. a freshly-installed device autosaved with no data and became the newest event).
      if (manifest && manifest.blossomUrl && manifest.wrappedKey && manifest.signerMethod) {
        const newCp: RemoteCheckpoint = {
          eventId: bestManifestEvent.id,
          dTag: bestManifestEvent.tags.find(t => t[0] === 'd')?.[1] || '',
          timestamp: manifest.timestamp || bestManifestEvent.created_at,
          blossomUrl: manifest.blossomUrl,
          ...(manifest.blossomHash ? { blossomHash: manifest.blossomHash } : {}),
          wrappedKey: manifest.wrappedKey,
          signerMethod: manifest.signerMethod as 'nip44' | 'nip04',
          stats: manifest.stats,
          corkboardNames: manifest.corkboardNames,
        };
        const stored = getStoredCheckpoints();
        const newestStored = stored.length > 0 ? stored[0] : null;
        const isThinnerThanStored = !!(newestStored?.stats && manifest.stats
          && (newestStored.stats.savedForLater - manifest.stats.savedForLater > 10
            || newestStored.stats.dismissed - manifest.stats.dismissed > 50));
        if (isThinnerThanStored) {
          log(`Manifest is thinner than stored checkpoint (saved:${manifest.stats?.savedForLater} vs stored:${newestStored?.stats?.savedForLater}) — skipping checkpoint update`, 'warn');
        } else {
          const nameMap = new Map(stored.filter(c => c.name).map(c => [c.eventId, c.name!]));
          if (nameMap.has(newCp.eventId)) newCp.name = nameMap.get(newCp.eventId);
          const dedupMap = new Map<string, RemoteCheckpoint>([[newCp.eventId, newCp]]);
          for (const cp of stored) {
            if (!dedupMap.has(cp.eventId)) dedupMap.set(cp.eventId, cp);
          }
          const allSorted = [...dedupMap.values()].sort((a, b) => b.timestamp - a.timestamp);
          // Always preserve named (user-created) checkpoints; fill up to 3 with unnamed
          const namedCps = allSorted.filter(c => c.name);
          const unnamedCps = allSorted.filter(c => !c.name);
          const trimmed = [...namedCps, ...unnamedCps.slice(0, Math.max(0, 3 - namedCps.length))].sort((a, b) => b.timestamp - a.timestamp);
          setStoredCheckpoints(trimmed);
          setCheckpoints(getStoredCheckpoints());
          log(`Checkpoints: ${trimmed.length} in rolling history (${namedCps.length} named)`);
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

      // Auto-dismiss only when BOTH conditions hold: local has meaningful data AND the
      // local timestamp is at-or-ahead of remote. Using AND (not OR) preserves the
      // original safety property — if local is empty but stale, we must still allow the
      // user to pull a newer remote checkpoint rather than silently locking them out.
      //
      // Read via async idbGet when sync returns null, in case memCache was evicted under
      // pressure. Without this, a value that exists on disk would be invisible here.
      const readKey = async (k: string) => idbGetSync(k) ?? (await idbGet(k));
      const localFeeds = await readKey('nostr-custom-feeds');
      const localDismissed = await readKey('dismissed-notes');
      const localCollapsed = await readKey('collapsed-notes');
      const hasLocalData =
        (localFeeds && localFeeds !== '[]' && localFeeds !== 'null') ||
        (localDismissed && localDismissed !== '[]' && localDismissed !== 'null') ||
        (localCollapsed && localCollapsed !== '[]' && localCollapsed !== 'null');
      let localLastBackupTs = parseInt(idbGetSync(LAST_BACKUP_TS_KEY) || '0', 10);
      // If we see real local data with no timestamp yet, stamp it now so subsequent
      // checks can rely on timestamp comparisons. Independent of the dismiss decision.
      if (hasLocalData && localLastBackupTs === 0) {
        const stamp = Math.floor(Date.now() / 1000);
        idbSetSync(LAST_BACKUP_TS_KEY, String(stamp));
        idbSet(LAST_BACKUP_TS_KEY, String(stamp)).catch(() => {});
        setLastBackupTs(stamp);
        log(`Stamped LAST_BACKUP_TS=${stamp} to protect existing local data`);
        localLastBackupTs = stamp;
      }
      const newestRemoteTs = manifest?.timestamp || bestManifestEvent.created_at;
      const localIsCurrentOrNewer = localLastBackupTs > 0 && localLastBackupTs >= newestRemoteTs;
      log(`checkRemoteBackup: hasLocalData=${!!hasLocalData} localTs=${localLastBackupTs} newestRemoteTs=${newestRemoteTs} localIsCurrentOrNewer=${localIsCurrentOrNewer} force=${force}`);
      if ((hasLocalData && localIsCurrentOrNewer) && !force) {
        log('Local data is current — auto-dismissing');
        _checkedPubkey = user.pubkey;
        idbSetSync(`${BACKUP_CHECKED_KEY}:${user.pubkey}`, 'true');
        idbSet(`${BACKUP_CHECKED_KEY}:${user.pubkey}`, 'true').catch(() => {});
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
    } finally {
      _clearInFlight();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- checkpoints declared after this hook (forward ref); deviceId is stable useState
  }, [user, queryAll, log, deviceId]);

  // Load remote backup
  /**
   * Pull the cloud state in.
   *
   * `silent` keeps the UI out of restoring/restored states — a background sync
   * should not look like a restore. `askOnRemovals` computes the merge first
   * and, if it would drop anything this device has, applies NOTHING and leaves
   * the remote-backup prompt standing so the user decides. A purely additive
   * merge needs no confirmation: it cannot lose anything.
   */
  const loadRemoteBackup = useCallback(async (opts?: { silent?: boolean; askOnRemovals?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (!user || !remoteBackup) {
      log('Restore skipped: ' + (!user ? 'no user' : 'no remote backup'));
      return;
    }
    if (_backupMutex.restoring) {
      log('Restore skipped: already restoring');
      return;
    }
    _backupMutex.restoring = true;

    if (!silent) {
      setStatus('restoring');
      setMessage('Restoring backup...');
    }

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

      // MERGE, not replace. This is the automatic cloud-restore path, so it has
      // to be safe to run whenever the cloud is ahead — union the id sets, keep
      // both devices' corkboards, and let tombstones carry deletions. A replace
      // here is what forced the old "only when local looks empty" gate.
      if (opts?.askOnRemovals) {
        const preview = await mergeBackupIntoLocal(fullJson, undefined, { dryRun: true });
        if (preview.removals.length > 0) {
          const count = preview.removals.reduce((n, r) => n + r.ids.length, 0);
          log(`Sync paused: merge would remove ${count} item(s) — leaving it for the user to confirm`);
          if (!silent) { setStatus('found'); setMessage('A newer backup is available'); }
          return;
        }
      }

      const { restored: restoredCount, removals } = await mergeBackupIntoLocal(fullJson, log);

      log(`Written to IDB: ${restoredCount} keys`);
      if (removals.length > 0) {
        log(`Applied removals from another device: ${removals.map(r => `${r.key}×${r.ids.length}`).join(', ')}`);
      }

      idbSetSync(LAST_BACKUP_TS_KEY, String(backup.timestamp));
      idbSetSync(LAST_CHUNK_COUNT_KEY, String(backup.chunks));
      setLastBackupTs(backup.timestamp);
      const wasSilent = silent;

      // Store snapshot of restored data for change detection
      const snapshot: Record<string, string> = {};
      for (const key of SNAPSHOT_KEYS) snapshot[key] = idbGetSync(key) || '';
      persistSnapshotAndHashes(snapshot);

      // Mark as checked so future checks skip
      markBackupCheckedSync(user.pubkey);
      await Promise.all([
        idbSet(`${BACKUP_CHECKED_KEY}:${user.pubkey}`, 'true'),
        idbSet('corkboard:active-user-pubkey', user.pubkey),
      ]);

      if (wasSilent) {
        // A background sync leaves no trace in the UI beyond the data arriving.
        setStatus('idle');
        setRemoteBackup(null);
        log(`Background sync merged ${restoredCount} keys`);
      } else {
        setStatus('restored');
        setMessage(`Restored ${restoredCount} keys`);
        log('Restore complete');
        // Resume auto-save after a brief flash of "restored" status
        setTimeout(() => setStatus('idle'), 3000);
      }
    } catch (err) {
      const errMsg = err instanceof Error
        ? (err.message || (err as DOMException).name || err.constructor.name)
        : String(err);
      log('Restore failed: ' + errMsg, 'error');
      setStatus('restore-error');
      setMessage('Restore failed: ' + errMsg);
    } finally {
      _backupMutex.restoring = false;
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
    const cps = [...getStoredCheckpoints()];
    if (index >= 0 && index < cps.length) {
      cps[index] = { ...cps[index], name };
      setStoredCheckpoints(cps);
      setCheckpoints(getStoredCheckpoints());
    }
  }, []);

  const deleteCheckpointFn = useCallback((eventId: string) => {
    const cps = [...getStoredCheckpoints()];
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
            const relay = createRelayFresh(url, { backoff: false });
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
    if (currentTs > cp.timestamp) {
      try {
        log('Current state is newer than checkpoint — auto-saving before restore...');
        await autoSaveBackup();
        log('Pre-restore auto-save complete');
      } catch (err) {
        log('Pre-restore auto-save failed (continuing): ' + (err instanceof Error ? err.message : err), 'warn');
      }
    }

    setMessage('Restoring from checkpoint...');

    // Pause auto-save for the whole restore. Writing the checkpoint's rows into
    // IDB is multi-step and non-atomic, so a visibilitychange/beforeunload
    // auto-save firing mid-restore would upload the HALF-restored state as the
    // canonical cloud autosave and clobber the good backup. autoSaveBackup()
    // already skips while isRestoring is set — loadRemoteBackup set this flag but
    // this checkpoint path (auto-restore, idle-return, manual restore) never did.
    // Set it AFTER the intentional pre-restore save above, or that save would be
    // skipped and the newer current state lost.
    _backupMutex.restoring = true;
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
      persistSnapshotAndHashes(cpSnapshot);

      // Move this checkpoint to the top so it becomes the "most recent" for auto-restore
      const cps = getStoredCheckpoints();
      const idx = cps.findIndex(c => c.eventId === cp.eventId);
      if (idx > 0) {
        const reordered = [cps[idx], ...cps.slice(0, idx), ...cps.slice(idx + 1)];
        setStoredCheckpoints(reordered);
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
    } finally {
      // Restore writes are done (or failed) — let auto-save resume. The 3s
      // 'restored'→'idle' status flash above is only cosmetic; data safety is
      // governed by this ref, which autoSaveBackup checks.
      _backupMutex.restoring = false;
    }
  }, [user, log, autoSaveBackup]);

  // Single check on login — one attempt, all relays, no retries.
  // Shows splash with tips while checking. If a checkpoint is found,
  // MultiColumnClient auto-restores the best one.
  //
  // Gate on user.pubkey (not the user object identity) and on a ref tracking
  // the last pubkey we checked. Without these guards we re-fire every time
  // useCurrentUser produces a fresh NUser instance (NUser.fromNsecLogin
  // creates a new object per memo recomputation), which made checkRemoteBackup
  // fan out into a storm of "Waiting for IDB to be ready..." log lines while
  // the splash was visible. The user shouldn't see this as anything other
  // than a single check.
  const lastCheckPubkeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!user) return;
    if (lastCheckPubkeyRef.current === user.pubkey) return;
    lastCheckPubkeyRef.current = user.pubkey;
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
        { kinds: [30078], authors: [user.pubkey], limit: 20 },
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
        // Process at most 20 most-recent manifests — bunker signers (NIP-46) incur
        // a round-trip per decrypt, so iterating all 38+ would timeout in seconds.
        const recent = [...manifests].sort((a, b) => b.created_at - a.created_at).slice(0, 20);
        for (const ev of recent) {
          let m: Record<string, unknown> | null = null;
          try { m = JSON.parse(ev.content); } catch {
            try {
              // NIP-44 first, legacy NIP-04 fallback — otherwise older
              // checkpoints are invisible to the scan. (M7a)
              const json = await decryptSelfPayload(user.signer, user.pubkey, ev.content, 3000);
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
    getCheckpoints: (): RemoteCheckpoint[] => getStoredCheckpoints(),
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
