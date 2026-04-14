/**
 * MMKV-backed DM message store for React Native.
 *
 * Port of the web's IndexedDB-based dmMessageStore, adapted for
 * synchronous MMKV access. Messages are keyed by the logged-in
 * user's pubkey and stored as JSON.
 *
 * Storage layout (MMKV keys):
 *   dm:messages:{userPubkey}   -> JSON-serialized MessageStore
 */
import { MMKV } from 'react-native-mmkv';
import type { NostrEvent } from '@nostrify/nostrify';

// Dedicated MMKV instance for DM data — keeps it isolated from
// general app storage so a clearAll() on either side is safe.
let dmMmkv: MMKV;
try {
  dmMmkv = new MMKV({ id: 'nostr-dm-store' });
} catch (e) {
  console.error('[dmMessageStore] Failed to initialize MMKV:', e);
  // Fallback: in-memory map so the app can still launch
  const fallback = new Map<string, string>();
  dmMmkv = {
    getString: (key: string) => fallback.get(key),
    set: (key: string, value: string) => { fallback.set(key, value); },
    delete: (key: string) => { fallback.delete(key); },
    clearAll: () => { fallback.clear(); },
    getAllKeys: () => [...fallback.keys()],
  } as unknown as MMKV;
}

// ============================================================================
// Types (mirrors web's dmMessageStore)
// ============================================================================

interface StoredParticipant {
  messages: NostrEvent[];
  lastActivity: number;
  hasNIP4: boolean;
  hasNIP17: boolean;
}

export interface MessageStore {
  participants: Record<string, StoredParticipant>;
  lastSync: {
    nip4: number | null;
    nip17: number | null;
  };
}

// ============================================================================
// Key helpers
// ============================================================================

function storeKey(userPubkey: string): string {
  return `dm:messages:${userPubkey}`;
}

// ============================================================================
// Read / Write / Delete / Clear
// ============================================================================

/**
 * Write the full message store for a user (sync).
 * Serialises to JSON and writes to MMKV in one shot.
 */
export function writeMessagesToDB(
  userPubkey: string,
  messageStore: MessageStore,
): void {
  try {
    // Deep-copy to avoid callers mutating the stored object
    const json = JSON.stringify(messageStore);
    dmMmkv.set(storeKey(userPubkey), json);
  } catch (error) {
    console.error('[dmMessageStore] Error writing to MMKV:', error);
    throw error;
  }
}

/**
 * Read the full message store for a user (sync).
 * Returns undefined when no data exists yet.
 */
export function readMessagesFromDB(
  userPubkey: string,
): MessageStore | undefined {
  try {
    const json = dmMmkv.getString(storeKey(userPubkey));
    if (!json) return undefined;
    const parsed = JSON.parse(json) as MessageStore;
    // Validate structure — guard against corrupted/legacy data
    if (!parsed || typeof parsed !== 'object' || typeof parsed.participants !== 'object' || !parsed.lastSync) {
      console.warn('[dmMessageStore] Invalid store format, resetting');
      dmMmkv.delete(storeKey(userPubkey));
      return undefined;
    }
    return parsed;
  } catch (error) {
    console.error('[dmMessageStore] Error reading from MMKV:', error);
    throw error;
  }
}

/**
 * Delete all stored messages for a specific user.
 */
export function deleteMessagesFromDB(userPubkey: string): void {
  try {
    dmMmkv.delete(storeKey(userPubkey));
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
// Convenience helpers (no web equivalent — useful for mobile hooks)
// ============================================================================

/**
 * Get or create a MessageStore for a user, initialising with empty defaults.
 */
export function getOrCreateStore(userPubkey: string): MessageStore {
  const existing = readMessagesFromDB(userPubkey);
  if (existing) return existing;

  const empty: MessageStore = {
    participants: {},
    lastSync: { nip4: null, nip17: null },
  };
  writeMessagesToDB(userPubkey, empty);
  return empty;
}

/**
 * Upsert messages for a conversation partner into the store.
 * Deduplicates by event ID and updates lastActivity / protocol flags.
 */
export function upsertMessages(
  userPubkey: string,
  partnerPubkey: string,
  newMessages: NostrEvent[],
  protocol: 'nip04' | 'nip17',
): void {
  const store = getOrCreateStore(userPubkey);

  const participant: StoredParticipant = store.participants[partnerPubkey] ?? {
    messages: [],
    lastActivity: 0,
    hasNIP4: false,
    hasNIP17: false,
  };

  // Dedup by event ID
  const existingIds = new Set(participant.messages.map(m => m.id));
  for (const msg of newMessages) {
    if (!existingIds.has(msg.id)) {
      participant.messages.push(msg);
      existingIds.add(msg.id);
    }
  }

  // Sort chronologically
  participant.messages.sort((a, b) => a.created_at - b.created_at);

  // Update metadata
  if (protocol === 'nip04') participant.hasNIP4 = true;
  if (protocol === 'nip17') participant.hasNIP17 = true;

  const latestTime = participant.messages.length > 0
    ? participant.messages[participant.messages.length - 1].created_at
    : 0;
  participant.lastActivity = Math.max(participant.lastActivity, latestTime);

  store.participants[partnerPubkey] = participant;
  writeMessagesToDB(userPubkey, store);
}

/**
 * Update the last-sync timestamp for a protocol.
 */
export function updateLastSync(
  userPubkey: string,
  protocol: 'nip04' | 'nip17',
  timestamp: number,
): void {
  const store = getOrCreateStore(userPubkey);
  if (protocol === 'nip04') {
    store.lastSync.nip4 = timestamp;
  } else {
    store.lastSync.nip17 = timestamp;
  }
  writeMessagesToDB(userPubkey, store);
}

/**
 * Get the last-sync timestamp for a protocol (or null if never synced).
 */
export function getLastSync(
  userPubkey: string,
  protocol: 'nip04' | 'nip17',
): number | null {
  const store = readMessagesFromDB(userPubkey);
  if (!store) return null;
  return protocol === 'nip04' ? store.lastSync.nip4 : store.lastSync.nip17;
}
