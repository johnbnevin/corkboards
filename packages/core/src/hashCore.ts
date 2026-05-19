/**
 * Fast non-cryptographic string hash for local change detection.
 *
 * FNV-1a 32-bit. Not collision-resistant for adversarial inputs, but
 * we only use it to detect whether a JSON string has changed since the
 * last backup snapshot. With ~10 keys per snapshot and ~10KB inputs the
 * collision probability on uniform-ish text is well below 1e-9 per key
 * per comparison — orders of magnitude safer than the user noticing.
 *
 * Cryptographic hashing (SHA-256 via subtle.crypto) would be async-only
 * on web and add ~1-3ms per snapshot key on cold start. Not worth it for
 * a local equality check.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit hash of a UTF-16 string, returned as 8-char hex. */
export function fnv1a32(s: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    // Math.imul keeps it 32-bit without precision loss
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
