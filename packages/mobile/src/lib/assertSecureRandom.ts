/**
 * assertSecureRandom — refuse to generate identity material with weak entropy.
 *
 * The Coldcard-shaped hazard: `react-native-get-random-values` (our
 * crypto.getRandomValues polyfill) SILENTLY substitutes `Math.random()` when a
 * dev build runs under remote (Chrome) JS debugging — its only signal is a
 * console.warn that nobody sees on a device. An nsec generated in that state
 * is a real, publishable account seeded from a non-cryptographic PRNG.
 *
 * This mirrors the polyfill's own detection condition and THROWS instead of
 * proceeding. Call it before every identity-material generation: signup,
 * add-account, NIP-46 client key / connect secret. Release builds
 * (`__DEV__ === false`) can never trip it, so users are unaffected.
 */

declare const global: {
  nativeCallSyncHook?: unknown;
  RN$Bridgeless?: boolean;
} & typeof globalThis;

/** True when the RNG polyfill would be running on Math.random(). */
export function isInsecureRandomEnvironment(): boolean {
  // Same condition react-native-get-random-values uses for
  // isRemoteDebuggingInChrome(): dev build, no native sync hook (JS runs in a
  // remote VM), and not bridgeless (where remote debugging can't detach RNG).
  return __DEV__ && typeof global.nativeCallSyncHook === 'undefined' && global.RN$Bridgeless !== true;
}

/**
 * Throw before any key/secret generation if the entropy source is degraded.
 * The error message tells the developer exactly how to proceed safely.
 */
export function assertSecureRandom(): void {
  if (isInsecureRandomEnvironment()) {
    throw new Error(
      'Refusing to generate keys: this dev session is using an INSECURE random ' +
      'number generator (remote JS debugging replaces crypto.getRandomValues ' +
      'with Math.random). Detach the remote debugger or use a release build.',
    );
  }
}
