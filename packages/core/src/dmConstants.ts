import type { NostrEvent } from '@nostrify/nostrify';

// ============================================================================
// Message Protocol Types
// ============================================================================

export const DM_PROTOCOL = {
  NIP04: 'nip04',
  NIP17: 'nip17',
  UNKNOWN: 'unknown',
} as const;

export type DMProtocol = typeof DM_PROTOCOL[keyof typeof DM_PROTOCOL];

// ============================================================================
// Protocol Mode (for user selection)
// ============================================================================

export const DM_PROTOCOL_MODE = {
  NIP04_ONLY: 'nip04_only',
  NIP17_ONLY: 'nip17_only',
  NIP04_OR_NIP17: 'nip04_or_nip17',
} as const;

export type DMProtocolMode = typeof DM_PROTOCOL_MODE[keyof typeof DM_PROTOCOL_MODE];

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
  [DM_PROTOCOL.NIP04]: {
    label: 'NIP-04',
    description: 'Legacy DMs',
    kind: 4,
  },
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
 * Get the message protocol from an event kind
 */
export function getDMProtocol(event: NostrEvent): DMProtocol {
  switch (event.kind) {
    case 4:
      return DM_PROTOCOL.NIP04;
    case 1059:
      return DM_PROTOCOL.NIP17;
    default:
      return DM_PROTOCOL.UNKNOWN;
  }
}

/**
 * Check if a protocol is valid for sending messages
 */
export function isValidDMSendProtocol(protocol: DMProtocol): boolean {
  return protocol === DM_PROTOCOL.NIP04 || protocol === DM_PROTOCOL.NIP17;
}
