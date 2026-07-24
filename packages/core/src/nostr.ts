/**
 * Shared Nostr constants and utilities.
 *
 * Pure TypeScript — no DOM or fetch dependencies. Safe to import on any
 * platform (web, mobile, desktop, server).
 */

/** Bech32 charset used by Nostr NIP-19 identifiers. */
export const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Nostr NIP-19 identifier prefixes (npub, note, nprofile, nevent, naddr). */
export const NIP19_PREFIXES = ['npub1', 'note1', 'nprofile1', 'nevent1', 'naddr1'] as const;
export type Nip19Prefix = typeof NIP19_PREFIXES[number];

/**
 * Canonical regex pattern string for matching Nostr identifiers.
 * Matches both `nostr:`-prefixed and bare identifiers using strict Bech32 charset.
 *
 * This is a string, not a RegExp — callers must construct their own RegExp
 * instance with `new RegExp(NIP19_IDENTIFIER_PATTERN, 'g')`. This avoids the
 * classic stateful-/g-flag bug where a module-level RegExp singleton shares
 * `.lastIndex` across unrelated callers.
 */
/*
 * Both branches carry a `(?<![\w/:])` boundary guard so an identifier embedded
 * in a URL path or in the middle of a word is not treated as a mention —
 * `https://njump.me/npub1…` should render as the link the author wrote, not
 * silently become a profile chip. Mobile's NoteContent had this guard and the
 * shared pattern did not, so the two parsers disagreed on the same note.
 *
 * The four capture groups (nostr:-prefixed prefix/data, then bare prefix/data)
 * are load-bearing: ProfileAbout on both platforms destructures matches
 * positionally. Keep the group structure if you touch this.
 */
export const NIP19_IDENTIFIER_PATTERN =
  '(?<![\\w/:])nostr:(npub1|note1|nprofile1|nevent1|naddr1)([qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)|(?<![\\w/:])(npub1|note1|nprofile1|nevent1|naddr1)([qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)';

/**
 * Creates a fresh RegExp instance for matching Nostr identifiers (with /g flag).
 * Always call this instead of reusing a module-level regex — the /g flag makes
 * RegExp stateful, and sharing an instance across callers causes subtle bugs.
 */
export function createNip19IdentifierRegex(): RegExp {
  return new RegExp(NIP19_IDENTIFIER_PATTERN, 'g');
}

/**
 * Validates if a string looks like a valid Nostr NIP-19 identifier.
 * Checks prefix and charset but does NOT verify checksum or decode.
 */
export function isValidNip19Identifier(str: string): boolean {
  const withoutPrefix = str.replace(/^nostr:/, '');
  return NIP19_PREFIXES.some(prefix => {
    if (!withoutPrefix.startsWith(prefix)) return false;
    const data = withoutPrefix.slice(prefix.length);
    // Reject empty / implausibly short data (an `npub1` with no payload is not
    // a real identifier). The shortest valid bech32 payload here (npub/note)
    // is ~52 chars; require a conservative minimum to avoid false positives.
    if (data.length < 10) return false;
    return data.split('').every(c => BECH32_CHARSET.includes(c));
  });
}

/**
 * Extracts the NIP-19 prefix type from a Nostr identifier string.
 * Returns null if the string doesn't start with a known prefix.
 */
export function getNip19PrefixType(identifier: string): Nip19Prefix | null {
  const withoutPrefix = identifier.replace(/^nostr:/, '');
  for (const prefix of NIP19_PREFIXES) {
    if (withoutPrefix.startsWith(prefix)) {
      return prefix;
    }
  }
  return null;
}
