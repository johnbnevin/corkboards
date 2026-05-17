import type { NostrEvent } from '@nostrify/nostrify';

// ============================================================================
// Message Protocol Types
//
// NIP-04 (kind 4) DM support was removed in v0.7. NIP-17 (sealed-sender,
// kind 1059) is the only supported DM protocol — NIP-04 leaks recipient
// pubkeys to relays and stored plaintext at rest.
//
// The NIP-04 encryption primitive (signer.nip04.encrypt/decrypt) is still
// imported elsewhere in the codebase for two reasons:
//   1. NIP-47 (Nostr Wallet Connect) mandates NIP-04 for wallet RPC.
//   2. Own-data sync events (backup, dismissed, custom-feeds) may have
//      been written with NIP-04 in older versions; readers fall back to
//      it for legacy decryption.
// Neither of those use kind 4 — they reuse only the cipher.
// ============================================================================

export const DM_PROTOCOL = {
  NIP17: 'nip17',
  UNKNOWN: 'unknown',
} as const;

export type DMProtocol = typeof DM_PROTOCOL[keyof typeof DM_PROTOCOL];

// ============================================================================
// Loading Phases
// ============================================================================

export const DM_LOADING_PHASES = {
  IDLE: 'idle',
  CACHE: 'cache',
  RELAYS: 'relays',
  SUBSCRIPTIONS: 'subscriptions',
  READY: 'ready',
} as const;

export type DMLoadingPhase = typeof DM_LOADING_PHASES[keyof typeof DM_LOADING_PHASES];

// ============================================================================
// Protocol Configuration
// ============================================================================

export const DM_PROTOCOL_CONFIG = {
  [DM_PROTOCOL.NIP17]: {
    label: 'NIP-17',
    description: 'Private DMs',
    kind: 1059,
  },
  [DM_PROTOCOL.UNKNOWN]: {
    label: 'Unknown',
    description: 'Unknown protocol',
    kind: 0,
  },
} as const;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the message protocol from an event kind. Kind 4 (NIP-04 DMs) is
 * intentionally treated as UNKNOWN — the app no longer recognises legacy
 * DMs as a valid protocol.
 */
export function getDMProtocol(event: NostrEvent): DMProtocol {
  switch (event.kind) {
    case 1059:
      return DM_PROTOCOL.NIP17;
    default:
      return DM_PROTOCOL.UNKNOWN;
  }
}

/**
 * Check if a protocol is valid for sending messages.
 */
export function isValidDMSendProtocol(protocol: DMProtocol): boolean {
  return protocol === DM_PROTOCOL.NIP17;
}
