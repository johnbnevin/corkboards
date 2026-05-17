import { createContext } from 'react';
import { type DMLoadingPhase } from '@/lib/dmConstants';
import { type NostrEvent } from '@nostrify/nostrify';

// ============================================================================
// DM Types and Constants
//
// NIP-04 (kind 4) DM types and state slots were removed in v0.7. NIP-17
// (sealed-sender, kind 1059) is the only supported DM protocol.
// ============================================================================

export interface ParticipantData {
  messages: DecryptedMessage[];
  lastActivity: number;
  lastMessage: DecryptedMessage | null;
  hasNIP17: boolean;
}

export type MessagesState = Map<string, ParticipantData>;

export interface LastSyncData {
  nip17: number | null;
}

export interface SubscriptionStatus {
  isNIP17Connected: boolean;
}

export interface ScanProgress {
  current: number;
  status: string;
}

export interface ScanProgressState {
  nip17: ScanProgress | null;
}

export interface ConversationSummary {
  id: string;
  pubkey: string;
  lastMessage: DecryptedMessage | null;
  lastActivity: number;
  hasNIP17Messages: boolean;
  isKnown: boolean;
  isRequest: boolean;
  lastMessageFromUser: boolean;
}

export interface DecryptedMessage extends NostrEvent {
  decryptedContent?: string;
  error?: string;
  isSending?: boolean;
  clientFirstSeen?: number;
  decryptedEvent?: NostrEvent; // For NIP-17: the inner kind 14/15 event
  originalGiftWrapId?: string; // Store gift wrap ID for NIP-17 deduplication
}

/**
 * File attachment for direct messages (NIP-92 compatible).
 */
export interface FileAttachment {
  url: string;
  mimeType: string;
  size: number;
  name: string;
  tags: string[][];
}

/**
 * Direct Messaging context interface providing access to all DM functionality.
 *
 * @property messages - Raw message state (Map of pubkey -> participant data)
 * @property isLoading - True during initial load phases
 * @property loadingPhase - Current loading phase (CACHE, RELAYS, SUBSCRIPTIONS, READY, IDLE)
 * @property isDoingInitialLoad - True only during cache/relay loading (not subscriptions)
 * @property lastSync - Unix timestamps of last successful sync for NIP-17
 * @property subscriptions - Connection status for real-time message subscriptions
 * @property conversations - Array of conversation summaries sorted by last activity
 * @property sendMessage - Send an encrypted NIP-17 direct message
 * @property scanProgress - Progress info for large message history scans
 * @property clearCacheAndRefetch - Clear IndexedDB cache and reload all messages from relays
 */
export interface DMContextType {
  messages: MessagesState;
  isLoading: boolean;
  loadingPhase: DMLoadingPhase;
  isDoingInitialLoad: boolean;
  lastSync: LastSyncData;
  subscriptions: SubscriptionStatus;
  conversations: ConversationSummary[];
  sendMessage: (params: {
    recipientPubkey: string;
    content: string;
    attachments?: FileAttachment[];
  }) => Promise<void>;
  scanProgress: ScanProgressState;
  clearCacheAndRefetch: () => Promise<void>;
}

export const DMContext = createContext<DMContextType | null>(null);
