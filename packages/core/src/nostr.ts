/**
 * Shared Nostr constants and utilities.
 *
 * Pure TypeScript — no DOM or fetch dependencies. Safe to import on any
 * platform (web, mobile, desktop, server).
 */

/** Bech32 charset used by Nostr NIP-19 identifiers. */
export const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Nostr NIP-19 identifier prefixes (npub, note, nprofile, nevent, naddr). */
export const NOSTR_PREFIXES = ['npub1', 'note1', 'nprofile1', 'nevent1', 'naddr1'] as const;
export type NostrPrefix = typeof NOSTR_PREFIXES[number];

/**
 * Canonical regex pattern string for matching Nostr identifiers.
 * Matches both `nostr:`-prefixed and bare identifiers using strict Bech32 charset.
 *
 * This is a string, not a RegExp — callers must construct their own RegExp
 * instance with `new RegExp(NOSTR_IDENTIFIER_PATTERN, 'g')`. This avoids the
 * classic stateful-/g-flag bug where a module-level RegExp singleton shares
 * `.lastIndex` across unrelated callers.
 */
export const NOSTR_IDENTIFIER_PATTERN =
  'nostr:(npub1|note1|nprofile1|nevent1|naddr1)([qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)|(npub1|note1|nprofile1|nevent1|naddr1)([qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)';

/**
 * Creates a fresh RegExp instance for matching Nostr identifiers (with /g flag).
 * Always call this instead of reusing a module-level regex — the /g flag makes
 * RegExp stateful, and sharing an instance across callers causes subtle bugs.
 */
export function createNostrIdentifierRegex(): RegExp {
  return new RegExp(NOSTR_IDENTIFIER_PATTERN, 'g');
}

/**
 * Validates if a string looks like a valid Nostr NIP-19 identifier.
 * Checks prefix and charset but does NOT verify checksum or decode.
 */
export function isValidNostrIdentifier(str: string): boolean {
  const withoutPrefix = str.replace(/^nostr:/, '');
  return NOSTR_PREFIXES.some(prefix =>
    withoutPrefix.startsWith(prefix) &&
    withoutPrefix.slice(prefix.length).split('').every(c => BECH32_CHARSET.includes(c))
  );
}

/**
 * Extracts the NIP-19 prefix type from a Nostr identifier string.
 * Returns null if the string doesn't start with a known prefix.
 */
export function getNostrIdentifierType(identifier: string): NostrPrefix | null {
  const withoutPrefix = identifier.replace(/^nostr:/, '');
  for (const prefix of NOSTR_PREFIXES) {
    if (withoutPrefix.startsWith(prefix)) {
      return prefix;
    }
  }
  return null;
}
