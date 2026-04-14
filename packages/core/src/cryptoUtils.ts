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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    crypto.getRandomValues(arr);
    if (arr[0] < limit) return arr[0] % max;
  }
}
