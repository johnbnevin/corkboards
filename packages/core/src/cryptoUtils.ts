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
 * Modulo bias is negligible for small `max` values relative to 2^32
 * (e.g. max = 172800 produces bias < 0.005%).
 */
export function secureRandomInt(max: number): number {
  if (max <= 0 || !Number.isInteger(max)) throw new RangeError('max must be a positive integer');
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
}
