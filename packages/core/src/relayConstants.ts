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
  'wss://nos.lol',
  'wss://relay.nostr.net',
  'wss://relay.ditto.pub',
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
 * The widest net the app ever casts for a single event id, used ONLY by the
 * user's explicit "Retry now" on an unresolved reference — never by any
 * automatic path, so it costs the shared socket budget nothing until a human
 * clicks. Deep-history archives first (per references/relays.md they exist for
 * exactly this), then the big general relays where a stray event most likely
 * landed. An event findable nowhere in this union plus the authors' outboxes
 * is genuinely unreachable.
 */
export const LAST_RESORT_LOOKUP_RELAYS = [
  ...READ_ONLY_RELAYS,           // archives: deep history
  'wss://relay.nostr.band',      // indexer/archive with broad event coverage
  ...FALLBACK_RELAYS,            // large general relays
  'wss://relay.primal.net',      // large caching service
  'wss://theforest.nostr1.com',
];

/**
 * Profile/relay-list indexers — aggregators that hold kind-0 (profile) and
 * kind-10002 (NIP-65 relay list) for essentially everyone. Queried to resolve a
 * profile when it isn't on the author's own/known relays (fixes stuck
 * "user_xxxx" nicknames). purplepag.es is the canonical NIP-65/profile indexer.
 */
export const PROFILE_INDEXER_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.nostr.band',
];

/**
 * Relays embedded in NIP-57 kind-9734 zap requests for receipt delivery.
 * These must be stable, well-connected relays that zap receipt processors
 * (wallets, clients) are likely to query.
 */
export const ZAP_RELAYS = [
  'wss://relay.nostr.net',
  'wss://nos.lol',
];

/**
 * Signaling relays for NIP-46 remote signer negotiation (nostrconnect:// QR
 * flow and Amber deep link flow). Must support kind 24133 event relay.
 * Multiple relays for redundancy — if one is down, login still works.
 */
export const NOSTRCONNECT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.nostr.net',
  'wss://relay.ditto.pub',
];

/** Primary relay used by nsec.app (noauth) for NIP-46 signer communication. */
export const NSEC_APP_RELAY = 'wss://relay.nsec.app';

/**
 * NIP-50 full-text search relay used for profile discovery during onboarding.
 * Must support the `search` filter field.
 */
export const NIP50_SEARCH_RELAY = 'wss://relay.nostr.band';
