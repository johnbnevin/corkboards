/**
 * MMKV-backed DM message store for React Native.
 *
 * Sharded layout (per user):
 *   dm:idx:{userPubkey}              → JSON index { participants: {[pk]: {lastActivity, hasNIP04, hasNIP17}}, lastSync }
 *   dm:msgs:{userPubkey}:{partnerPk} → JSON array of NostrEvents for that conversation
 *
 * Why sharded: a power user with thousands of DMs would otherwise rewrite a
 * multi-MB blob on every new message. With sharding, each new message only
 * rewrites that partner's shard (typically a few KB) plus a small index update.
 *
 * Backward compatibility:
 *   The legacy single-blob key `dm:messages:{userPubkey}` (one MessageStore
 *   JSON per user) is auto-migrated to the sharded layout on first read.
 */
import { createMMKV, type MMKV } from 'react-native-mmkv';
import type { NostrEvent } from '@nostrify/nostrify';
import { openEncryptedShard } from '../storage/MmkvStorage';

// DM history contains decrypted plaintext for NIP-04 and NIP-44/17. It MUST
// live in the encrypted shard (shared keychain-backed key) — never in a bare
// MMKV instance. We use a temporary in-memory shim until the encrypted shard
// is ready, then drain queued writes/reads through it.
const DM_SHARD_ID = 'nostr-dm-store-encrypted';
const LEGACY_DM_SHARD_ID = 'nostr-dm-store';
const DM_MIGRATION_FLAG = '__dm_migrated_from_unencrypted__';

const _memFallback = new Map<string, string>();
let dmMmkv: MMKV = {
  getString: (key: string) => _memFallback.get(key),
  set: (key: string, value: string) => { _memFallback.set(key, value); },
  remove: (key: string) => { _memFallback.delete(key); },
  clearAll: () => { _memFallback.clear(); },
  getAllKeys: () => [..._memFallback.keys()],
} as unknown as MMKV;

let _dmReady = false;
export const dmStoreReady: Promise<void> = (async () => {
  try {
    const encrypted = await openEncryptedShard(DM_SHARD_ID);
    // One-time migration: copy from the legacy unencrypted instance (which
    // previously stored decrypted DMs in cleartext on disk).
    if (!encrypted.getString(DM_MIGRATION_FLAG)) {
      try {
        // Safe to open the legacy unencrypted instance here: this code path
        // runs at most once per install (gated by the migration flag), the
        // module-level `_memFallback` shim catches all consumer writes until
        // `dmMmkv = encrypted` below, and we `clearAll()` immediately after
        // copying so no cleartext lingers on disk.
        const legacy = createMMKV({ id: LEGACY_DM_SHARD_ID });
        const legacyKeys = legacy.getAllKeys();
        if (legacyKeys.length > 0) {
          for (const k of legacyKeys) {
            const v = legacy.getString(k);
            if (v !== undefined) encrypted.set(k, v);
          }
          // Wipe cleartext copies off disk.
          legacy.clearAll();
        }
        encrypted.set(DM_MIGRATION_FLAG, '1');
      } catch (e) {
        console.warn('[dmMessageStore] Legacy DM shard migration skipped:', e);
      }
    }
    // Drain anything written before the shard opened.
    for (const [k, v] of _memFallback.entries()) encrypted.set(k, v);
    _memFallback.clear();
    dmMmkv = encrypted;
    _dmReady = true;
  } catch (e) {
    console.error('[dmMessageStore] Failed to open encrypted DM shard, staying in-memory:', e);
  }
})();

/** True once the encrypted shard is open and any queued writes have been drained. */
export function isDmStoreReady(): boolean { return _dmReady; }

// ============================================================================
// Types (public API stays compatible with the previous version)
// ============================================================================

export interface StoredParticipant {
  messages: NostrEvent[];
  lastActivity: number;
  hasNIP04: boolean;
  hasNIP17: boolean;
}

export interface MessageStore {
  participants: Record<string, StoredParticipant>;
  lastSync: {
    nip04: number | null;
    nip17: number | null;
  };
}

interface ParticipantMeta {
  lastActivity: number;
  hasNIP04: boolean;
  hasNIP17: boolean;
}

interface IndexBlob {
  participants: Record<string, ParticipantMeta>;
  lastSync: { nip04: number | null; nip17: number | null };
}

// ============================================================================
// Key helpers
// ============================================================================

const LEGACY_PREFIX = 'dm:messages:';
const INDEX_PREFIX = 'dm:idx:';
const MSGS_PREFIX = 'dm:msgs:';

function indexKey(userPubkey: string): string { return `${INDEX_PREFIX}${userPubkey}`; }
function msgsKey(userPubkey: string, partnerPubkey: string): string { return `${MSGS_PREFIX}${userPubkey}:${partnerPubkey}`; }
function legacyKey(userPubkey: string): string { return `${LEGACY_PREFIX}${userPubkey}`; }

// ============================================================================
// Internal helpers (sharded reads/writes)
// ============================================================================

function readIndex(userPubkey: string): IndexBlob | undefined {
  const raw = dmMmkv.getString(indexKey(userPubkey));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as IndexBlob;
    if (!parsed || typeof parsed.participants !== 'object' || !parsed.lastSync) return undefined;
    return parsed;
  } catch { return undefined; }
}

function writeIndex(userPubkey: string, idx: IndexBlob): void {
  dmMmkv.set(indexKey(userPubkey), JSON.stringify(idx));
}

function readPartnerMessages(userPubkey: string, partnerPubkey: string): NostrEvent[] {
  const raw = dmMmkv.getString(msgsKey(userPubkey, partnerPubkey));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as NostrEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writePartnerMessages(userPubkey: string, partnerPubkey: string, msgs: NostrEvent[]): void {
  dmMmkv.set(msgsKey(userPubkey, partnerPubkey), JSON.stringify(msgs));
}

/** One-time migration from the legacy single-blob layout. */
function migrateLegacyIfNeeded(userPubkey: string): void {
  if (readIndex(userPubkey)) return; // already on new layout
  const legacy = dmMmkv.getString(legacyKey(userPubkey));
  if (!legacy) return;
  try {
    const old = JSON.parse(legacy) as MessageStore;
    if (!old || typeof old.participants !== 'object' || !old.lastSync) {
      dmMmkv.remove(legacyKey(userPubkey));
      return;
    }
    const idx: IndexBlob = { participants: {}, lastSync: old.lastSync };
    for (const [pk, p] of Object.entries(old.participants)) {
      idx.participants[pk] = {
        lastActivity: p.lastActivity,
        hasNIP04: p.hasNIP04,
        hasNIP17: p.hasNIP17,
      };
      writePartnerMessages(userPubkey, pk, p.messages);
    }
    writeIndex(userPubkey, idx);
    dmMmkv.remove(legacyKey(userPubkey));
    console.log(`[dmMessageStore] Migrated ${Object.keys(old.participants).length} partners from legacy blob`);
  } catch (e) {
    console.warn('[dmMessageStore] Legacy migration failed (ignoring):', e);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Write the full message store for a user.
 * Splits into per-partner shards + a small index.
 */
export function writeMessagesToDB(
  userPubkey: string,
  messageStore: MessageStore,
): void {
  try {
    const idx: IndexBlob = { participants: {}, lastSync: messageStore.lastSync };
    for (const [pk, p] of Object.entries(messageStore.participants)) {
      idx.participants[pk] = {
        lastActivity: p.lastActivity,
        hasNIP04: p.hasNIP04,
        hasNIP17: p.hasNIP17,
      };
      writePartnerMessages(userPubkey, pk, p.messages);
    }
    writeIndex(userPubkey, idx);
  } catch (error) {
    console.error('[dmMessageStore] Error writing to MMKV:', error);
    throw error;
  }
}

/**
 * Read the full message store for a user. Combines the index with each
 * partner's shard. Returns undefined when no data exists yet.
 *
 * Power users beware: this reassembles every conversation into a single
 * object. For most callers, prefer `getPartnerMessages` and the existing
 * `getLastSync`.
 */
export function readMessagesFromDB(
  userPubkey: string,
): MessageStore | undefined {
  try {
    migrateLegacyIfNeeded(userPubkey);
    const idx = readIndex(userPubkey);
    if (!idx) return undefined;
    const store: MessageStore = { participants: {}, lastSync: idx.lastSync };
    for (const [pk, meta] of Object.entries(idx.participants)) {
      store.participants[pk] = {
        messages: readPartnerMessages(userPubkey, pk),
        lastActivity: meta.lastActivity,
        hasNIP04: meta.hasNIP04,
        hasNIP17: meta.hasNIP17,
      };
    }
    return store;
  } catch (error) {
    console.error('[dmMessageStore] Error reading from MMKV:', error);
    throw error;
  }
}

/** Read just one partner's conversation — cheap, no full-store assembly. */
export function getPartnerMessages(userPubkey: string, partnerPubkey: string): NostrEvent[] {
  migrateLegacyIfNeeded(userPubkey);
  return readPartnerMessages(userPubkey, partnerPubkey);
}

/**
 * Delete all stored messages for a specific user (index + all shards).
 */
export function deleteMessagesFromDB(userPubkey: string): void {
  try {
    const idx = readIndex(userPubkey);
    if (idx) {
      for (const pk of Object.keys(idx.participants)) {
        dmMmkv.remove(msgsKey(userPubkey, pk));
      }
    }
    dmMmkv.remove(indexKey(userPubkey));
    dmMmkv.remove(legacyKey(userPubkey));
  } catch (error) {
    console.error('[dmMessageStore] Error deleting from MMKV:', error);
    throw error;
  }
}

/**
 * Clear the entire DM message store (all users).
 */
export function clearAllMessages(): void {
  try {
    dmMmkv.clearAll();
  } catch (error) {
    console.error('[dmMessageStore] Error clearing MMKV:', error);
    throw error;
  }
}

// ============================================================================
// Convenience helpers
// ============================================================================

/**
 * Get or create the index, initialising with empty defaults. Returns an
 * IndexBlob for cheap "who do I have conversations with" reads.
 */
function getOrCreateIndex(userPubkey: string): IndexBlob {
  migrateLegacyIfNeeded(userPubkey);
  const existing = readIndex(userPubkey);
  if (existing) return existing;
  const empty: IndexBlob = { participants: {}, lastSync: { nip04: null, nip17: null } };
  writeIndex(userPubkey, empty);
  return empty;
}

/**
 * Backwards-compatible helper. Now backed by per-partner shards.
 */
export function getOrCreateStore(userPubkey: string): MessageStore {
  return readMessagesFromDB(userPubkey) ?? { participants: {}, lastSync: { nip04: null, nip17: null } };
}

/**
 * Upsert messages for a conversation partner. Only writes the partner's shard
 * plus the index entry — no rewriting of unrelated conversations.
 */
export function upsertMessages(
  userPubkey: string,
  partnerPubkey: string,
  newMessages: NostrEvent[],
  protocol: 'nip04' | 'nip17',
): void {
  const idx = getOrCreateIndex(userPubkey);
  const existingMsgs = readPartnerMessages(userPubkey, partnerPubkey);
  const existingIds = new Set(existingMsgs.map(m => m.id));
  let changed = false;
  for (const msg of newMessages) {
    if (!existingIds.has(msg.id)) {
      existingMsgs.push(msg);
      existingIds.add(msg.id);
      changed = true;
    }
  }
  if (!changed) {
    // Even with no new messages, the protocol flag could have changed
    const meta = idx.participants[partnerPubkey];
    if (meta && ((protocol === 'nip04' && meta.hasNIP04) || (protocol === 'nip17' && meta.hasNIP17))) {
      return;
    }
  }
  existingMsgs.sort((a, b) => a.created_at - b.created_at);
  writePartnerMessages(userPubkey, partnerPubkey, existingMsgs);

  const latestTime = existingMsgs.length > 0 ? existingMsgs[existingMsgs.length - 1].created_at : 0;
  const prevMeta = idx.participants[partnerPubkey];
  idx.participants[partnerPubkey] = {
    lastActivity: Math.max(prevMeta?.lastActivity ?? 0, latestTime),
    hasNIP04: (prevMeta?.hasNIP04 ?? false) || protocol === 'nip04',
    hasNIP17: (prevMeta?.hasNIP17 ?? false) || protocol === 'nip17',
  };
  writeIndex(userPubkey, idx);
}

/**
 * Update the last-sync timestamp for a protocol.
 */
export function updateLastSync(
  userPubkey: string,
  protocol: 'nip04' | 'nip17',
  timestamp: number,
): void {
  const idx = getOrCreateIndex(userPubkey);
  if (protocol === 'nip04') idx.lastSync.nip04 = timestamp;
  else idx.lastSync.nip17 = timestamp;
  writeIndex(userPubkey, idx);
}

/**
 * Get the last-sync timestamp for a protocol (or null if never synced).
 */
export function getLastSync(
  userPubkey: string,
  protocol: 'nip04' | 'nip17',
): number | null {
  migrateLegacyIfNeeded(userPubkey);
  const idx = readIndex(userPubkey);
  if (!idx) return null;
  return protocol === 'nip04' ? idx.lastSync.nip04 : idx.lastSync.nip17;
}
