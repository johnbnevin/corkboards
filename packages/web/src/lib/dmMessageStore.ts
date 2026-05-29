import { openDB, type IDBPDatabase } from 'idb';
import type { NostrEvent } from '@nostrify/nostrify';

// ============================================================================
// IndexedDB Schema
//
// NIP-04 kind-4 message storage was removed in v0.7. On first read after
// upgrade, all kind-4 events are purged from each participant's `messages`
// array, `lastSync.nip04` is cleared, and a `__nip04_purged__` flag is set
// at a sentinel pubkey so we never re-run the purge.
// ============================================================================

const getDBName = () => {
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'default';
  return `nostr-dm-store-${hostname}`;
};
const DB_NAME = getDBName();
const DB_VERSION = 1;
const STORE_NAME = 'messages';

// Sentinel keys (not valid 64-char hex pubkeys, so they cannot collide with users)
const NIP04_PURGE_FLAG_KEY = '__nip04_purged__';

interface StoredParticipant {
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

// ============================================================================
// Database Operations
// ============================================================================

async function openDatabase(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    },
  });
}

/**
 * One-time purge of kind-4 (NIP-04) events from every user's stored
 * conversations. Safe to call repeatedly: gated by a sentinel flag so it
 * only runs once per browser profile. Wipes the stored plaintext that older
 * versions accumulated even after NIP-04 sending was disabled.
 */
async function purgeLegacyNip04Once(db: IDBPDatabase): Promise<void> {
  const alreadyPurged = await db.get(STORE_NAME, NIP04_PURGE_FLAG_KEY);
  if (alreadyPurged) return;

  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const allKeys = await store.getAllKeys();

    for (const key of allKeys) {
      if (key === NIP04_PURGE_FLAG_KEY) continue;
      const raw = await store.get(key);
      if (!raw || typeof raw !== 'object') continue;
      const data = raw as Record<string, unknown> & {
        participants?: Record<string, {
          messages?: NostrEvent[];
          hasNIP04?: boolean;
          hasNIP17?: boolean;
          lastActivity?: number;
        }>;
        lastSync?: { nip04?: number | null; nip17?: number | null };
      };
      if (!data.participants) continue;

      const cleanedParticipants: Record<string, StoredParticipant> = {};
      for (const [pk, p] of Object.entries(data.participants)) {
        const filteredMessages = (p.messages || []).filter(m => m.kind !== 4);
        if (filteredMessages.length === 0) {
          // Drop participants who had nothing but kind-4 history.
          continue;
        }
        cleanedParticipants[pk] = {
          messages: filteredMessages,
          lastActivity: p.lastActivity ?? 0,
          hasNIP17: !!p.hasNIP17,
        };
      }

      const cleaned: MessageStore = {
        participants: cleanedParticipants,
        lastSync: { nip17: data.lastSync?.nip17 ?? null },
      };
      await store.put(cleaned, key);
    }

    await store.put('1', NIP04_PURGE_FLAG_KEY);
    await tx.done;
    if (import.meta.env.DEV) console.info('[MessageStore] NIP-04 history purged');
  } catch (e) {
    if (import.meta.env.DEV) console.warn('[MessageStore] NIP-04 purge skipped (will retry next launch):', e);
  }
}

/**
 * Write messages to IndexedDB for a specific user.
 * Messages are stored in their original encrypted form (NIP-17 kind 13 seals).
 */
export async function writeMessagesToDB(
  userPubkey: string,
  messageStore: MessageStore
): Promise<void> {
  try {
    const db = await openDatabase();
    // Deep-clone before writing so in-flight mutations from concurrent callers
    // don't corrupt the stored data.
    await db.put(STORE_NAME, structuredClone(messageStore), userPubkey);
  } catch (error) {
    console.error('[MessageStore] ❌ Error writing to IndexedDB:', error);
    throw error;
  }
}

/**
 * Read messages from IndexedDB for a specific user.
 * On first call after upgrade, also runs the one-time NIP-04 purge.
 */
export async function readMessagesFromDB(
  userPubkey: string
): Promise<MessageStore | undefined> {
  try {
    const db = await openDatabase();
    await purgeLegacyNip04Once(db);
    const data = await db.get(STORE_NAME, userPubkey);

    if (!data) {
      return undefined;
    }

    return data as MessageStore;
  } catch (error) {
    console.error('[MessageStore] Error reading from IndexedDB:', error);
    throw error;
  }
}

/**
 * Delete messages from IndexedDB for a specific user
 */
export async function deleteMessagesFromDB(userPubkey: string): Promise<void> {
  try {
    const db = await openDatabase();
    await db.delete(STORE_NAME, userPubkey);
  } catch (error) {
    console.error('[MessageStore] Error deleting from IndexedDB:', error);
    throw error;
  }
}

/**
 * Clear all messages from IndexedDB
 */
export async function clearAllMessages(): Promise<void> {
  try {
    const db = await openDatabase();
    await db.clear(STORE_NAME);
  } catch (error) {
    console.error('[MessageStore] Error clearing IndexedDB:', error);
    throw error;
  }
}
