/**
 * Cryptographically secure random utilities.
 *
 * Uses crypto.getRandomValues() — available in all modern browsers, Node.js 15+,
 * React Native (via Hermes/JSC), and Deno. Do NOT use Math.random() for any
 * security-sensitive purpose (timestamp obfuscation, nonces, key material, etc.).
 */

/**
 * Returns a cryptographically secure random integer in [0, max).
 *
 * Uses rejection sampling to eliminate modulo bias: values that would
 * cause uneven distribution are discarded and re-sampled.
 */
export function secureRandomInt(max: number): number {
  if (max <= 0 || !Number.isInteger(max)) throw new RangeError('max must be a positive integer');
  if (max === 1) return 0;
  const arr = new Uint32Array(1);
  // Rejection threshold: largest multiple of max that fits in 2^32
  const limit = Math.floor(0x100000000 / max) * max;
  // Rejection probability per iteration is < max/2^32, so exhausting this cap
  // is astronomically unlikely with a real CSPRNG — it only guards against a
  // broken/stubbed getRandomValues hanging the thread forever.
  for (let i = 0; i < 1024; i++) {
    crypto.getRandomValues(arr);
    if (arr[0] < limit) return arr[0] % max;
  }
  throw new Error('secureRandomInt: CSPRNG rejection sampling failed to converge');
}

/**
 * A RFC-4122 v4 UUID built from `crypto.getRandomValues` only.
 *
 * Deliberately does NOT call `crypto.randomUUID`: that member is absent on
 * React Native / Hermes (whose only WebCrypto surface, via
 * react-native-get-random-values, is `getRandomValues`), so a bare
 * `crypto.randomUUID()` throws on-device — a crash that was reachable from app
 * startup when a device id had to be minted. `getRandomValues` is polyfilled on
 * every target, so this works everywhere the app runs.
 */
export function randomUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Version 4 and RFC-4122 variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 256; i++) hex.push((i + 0x100).toString(16).slice(1));
  const h = (i: number) => hex[bytes[i]];
  return (
    h(0) + h(1) + h(2) + h(3) + '-' +
    h(4) + h(5) + '-' +
    h(6) + h(7) + '-' +
    h(8) + h(9) + '-' +
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
  );
}
