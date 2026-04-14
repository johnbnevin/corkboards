/**
 * Centralized relay URL constants — single source of truth for all platforms.
 *
 * All hardcoded relay URLs should live here — not scattered across components
 * and hooks. This makes it easy for self-hosters and forks to swap relays,
 * and prevents silent inconsistencies across the codebase.
 *
 * Users configure their own relays at runtime via NIP-65 and the settings UI.
 * These constants are fallbacks and protocol-specific defaults only.
 */

/**
 * Last-resort fallback relays, used only when a user has no relays configured
 * and no author relays are cached. Users are expected to supply their own
 * relay list via NIP-65; these exist to bootstrap first-time connections.
 * These relays accept both reads AND writes.
 */
export const FALLBACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.ditto.pub',
  'wss://relay.nostr.band',
];

/**
 * Read-only archive/indexer relays, queried for discovery and event lookups
 * but never written to. Appended to FALLBACK_RELAYS for read operations.
 */
export const READ_ONLY_RELAYS = [
  'wss://antiprimal.net',
  'wss://indexer.nostrarchives.com',
];

/**
 * Relays embedded in NIP-57 kind-9734 zap requests for receipt delivery.
 * These must be stable, well-connected relays that zap receipt processors
 * (wallets, clients) are likely to query.
 */
export const ZAP_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

/**
 * Signaling relays for NIP-46 remote signer negotiation (nostrconnect:// QR
 * flow and Amber deep link flow). Must support kind 24133 event relay.
 * Multiple relays for redundancy — if one is down, login still works.
 */
export const NOSTRCONNECT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.ditto.pub',
];

/**
 * NIP-50 full-text search relay used for profile discovery during onboarding.
 * Must support the `search` filter field.
 */
export const SEARCH_RELAY = 'wss://relay.nostr.band';
