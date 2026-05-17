/**
 * MMKV-backed DM message store for React Native.
 *
 * Sharded layout (per user):
 *   dm:idx:{userPubkey}              → JSON index { participants: {[pk]: {lastActivity, hasNIP17}}, lastSync }
 *   dm:msgs:{userPubkey}:{partnerPk} → JSON array of NostrEvents for that conversation
 *
 * Why sharded: a power user with thousands of DMs would otherwise rewrite a
 * multi-MB blob on every new message. With sharding, each new message only
 * rewrites that partner's shard (typically a few KB) plus a small index update.
 *
 * Encryption: lives in the keychain-backed encrypted MMKV shard
 * (`openEncryptedShard`), with a one-time migration off the legacy
 * unencrypted shard.
 *
 * NIP-04 (kind 4) removal (v0.7): on first read after upgrade, all kind-4
 * messages are purged from each `dm:msgs:*` shard, hasNIP04 flags are
 * dropped from indices, and `lastSync.nip04` is cleared. The purge is
 * idempotent and gated by `__nip04_purged__` written into the encrypted shard.
 */
import { createMMKV, type MMKV } from 'react-native-mmkv';
import type { NostrEvent } from '@nostrify/nostrify';
import { openEncryptedShard } from '../storage/MmkvStorage';

const DM_SHARD_ID = 'nostr-dm-store-encrypted';
const LEGACY_DM_SHARD_ID = 'nostr-dm-store';
const DM_MIGRATION_FLAG = '__dm_migrated_from_unencrypted__';
const NIP04_PURGE_FLAG = '__nip04_purged__';

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
          legacy.clearAll();
        }
        encrypted.set(DM_MIGRATION_FLAG, '1');
      } catch (e) {
        console.warn('[dmMessageStore] Legacy DM shard migration skipped:', e);
      }
    }
    for (const [k, v] of _memFallback.entries()) encrypted.set(k, v);
    _memFallback.clear();
    dmMmkv = encrypted;
    _dmReady = true;

    // One-time purge of kind-4 history. Runs after migration so legacy data
    // is in the new shard before we scrub it. Gated by NIP04_PURGE_FLAG.
    purgeLegacyNip04Once();
  } catch (e) {
    console.error('[dmMessageStore] Failed to open encrypted DM shard, staying in-memory:', e);
  }
})();

/** True once the encrypted shard is open and any queued writes have been drained. */
export function isDmStoreReady(): boolean { return _dmReady; }

// ============================================================================
// Types
// ============================================================================

export interface StoredParticipant {
  messages: NostrEvent[];
  lastActivity: number;
  hasNIP17: boolean;
}

export interface MessageStore {
  participants: Record<string, StoredParticipant>;
  lastSync: {
    nip17: number | null;
  };
}

interface ParticipantMeta {
  lastActivity: number;
  hasNIP17: boolean;
}

interface IndexBlob {
  participants: Record<string, ParticipantMeta>;
  lastSync: { nip17: number | null };
}

/**
 * Wider type for reading legacy data — older versions wrote hasNIP04 and
 * lastSync.nip04 fields. We accept them on read and strip them on write.
 */
interface LegacyIndexBlob {
  participants: Record<string, ParticipantMeta & { hasNIP04?: boolean }>;
  lastSync: { nip17: number | null; nip04?: number | null };
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

function readIndexRaw(userPubkey: string): LegacyIndexBlob | undefined {
  const raw = dmMmkv.getString(indexKey(userPubkey));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as LegacyIndexBlob;
    if (!parsed || typeof parsed.participants !== 'object' || !parsed.lastSync) return undefined;
    return parsed;
  } catch { return undefined; }
}

function readIndex(userPubkey: string): IndexBlob | undefined {
  const raw = readIndexRaw(userPubkey);
  if (!raw) return undefined;
  // Strip legacy nip04 fields on read so callers never see them.
  const participants: Record<string, ParticipantMeta> = {};
  for (const [pk, p] of Object.entries(raw.participants)) {
    participants[pk] = { lastActivity: p.lastActivity, hasNIP17: !!p.hasNIP17 };
  }
  return {
    participants,
    lastSync: { nip17: raw.lastSync.nip17 ?? null },
  };
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
  if (readIndex(userPubkey)) return;
  const legacy = dmMmkv.getString(legacyKey(userPubkey));
  if (!legacy) return;
  try {
    const old = JSON.parse(legacy) as { participants?: Record<string, { messages: NostrEvent[]; lastActivity: number; hasNIP17?: boolean }>; lastSync?: { nip17?: number | null } };
    if (!old || typeof old.participants !== 'object' || !old.lastSync) {
      dmMmkv.remove(legacyKey(userPubkey));
      return;
    }
    const idx: IndexBlob = { participants: {}, lastSync: { nip17: old.lastSync.nip17 ?? null } };
    for (const [pk, p] of Object.entries(old.participants)) {
      idx.participants[pk] = {
        lastActivity: p.lastActivity,
        hasNIP17: !!p.hasNIP17,
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

/**
 * Strip every kind-4 event from every user's shards and drop hasNIP04
 * markers / lastSync.nip04 from each index. Runs at most once per install.
 */
function purgeLegacyNip04Once(): void {
  try {
    if (dmMmkv.getString(NIP04_PURGE_FLAG)) return;
    const allKeys = dmMmkv.getAllKeys();

    for (const key of allKeys) {
      if (key.startsWith(INDEX_PREFIX)) {
        const raw = dmMmkv.getString(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as LegacyIndexBlob;
          if (!parsed || typeof parsed.participants !== 'object' || !parsed.lastSync) continue;
          const cleanedParticipants: Record<string, ParticipantMeta> = {};
          for (const [pk, p] of Object.entries(parsed.participants)) {
            cleanedParticipants[pk] = { lastActivity: p.lastActivity, hasNIP17: !!p.hasNIP17 };
          }
          const cleaned: IndexBlob = {
            participants: cleanedParticipants,
            lastSync: { nip17: parsed.lastSync.nip17 ?? null },
          };
          dmMmkv.set(key, JSON.stringify(cleaned));
        } catch { /* skip */ }
      } else if (key.startsWith(MSGS_PREFIX)) {
        const raw = dmMmkv.getString(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as NostrEvent[];
          if (!Array.isArray(parsed)) continue;
          const filtered = parsed.filter(m => m && m.kind !== 4);
          if (filtered.length === 0) {
            // All-kind-4 shard: remove entirely.
            dmMmkv.remove(key);
          } else if (filtered.length !== parsed.length) {
            dmMmkv.set(key, JSON.stringify(filtered));
          }
        } catch { /* skip */ }
      }
    }

    dmMmkv.set(NIP04_PURGE_FLAG, '1');
    console.log('[dmMessageStore] NIP-04 history purged');
  } catch (e) {
    console.warn('[dmMessageStore] NIP-04 purge skipped (will retry next launch):', e);
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

function getOrCreateIndex(userPubkey: string): IndexBlob {
  migrateLegacyIfNeeded(userPubkey);
  const existing = readIndex(userPubkey);
  if (existing) return existing;
  const empty: IndexBlob = { participants: {}, lastSync: { nip17: null } };
  writeIndex(userPubkey, empty);
  return empty;
}

export function getOrCreateStore(userPubkey: string): MessageStore {
  return readMessagesFromDB(userPubkey) ?? { participants: {}, lastSync: { nip17: null } };
}

/**
 * Upsert messages for a conversation partner. Only writes the partner's shard
 * plus the index entry — no rewriting of unrelated conversations.
 */
export function upsertMessages(
  userPubkey: string,
  partnerPubkey: string,
  newMessages: NostrEvent[],
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
    const meta = idx.participants[partnerPubkey];
    if (meta && meta.hasNIP17) return;
  }
  existingMsgs.sort((a, b) => a.created_at - b.created_at);
  writePartnerMessages(userPubkey, partnerPubkey, existingMsgs);

  const latestTime = existingMsgs.length > 0 ? existingMsgs[existingMsgs.length - 1].created_at : 0;
  const prevMeta = idx.participants[partnerPubkey];
  idx.participants[partnerPubkey] = {
    lastActivity: Math.max(prevMeta?.lastActivity ?? 0, latestTime),
    hasNIP17: true,
  };
  writeIndex(userPubkey, idx);
}

/**
 * Update the NIP-17 last-sync timestamp.
 */
export function updateLastSync(userPubkey: string, timestamp: number): void {
  const idx = getOrCreateIndex(userPubkey);
  idx.lastSync.nip17 = timestamp;
  writeIndex(userPubkey, idx);
}

/**
 * Get the NIP-17 last-sync timestamp (or null if never synced).
 */
export function getLastSync(userPubkey: string): number | null {
  migrateLegacyIfNeeded(userPubkey);
  const idx = readIndex(userPubkey);
  if (!idx) return null;
  return idx.lastSync.nip17;
}
