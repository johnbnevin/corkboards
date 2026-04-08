/**
 * Deterministic fallback display name for users who haven't set a `name` or
 * `display_name` in their NIP-01 kind-0 metadata.
 *
 * Not cryptographically derived — just a short pubkey prefix for legibility.
 * Collision-resistant enough for display purposes (8 hex chars = 2^32 space).
 *
 * @param seed - Typically the user's hex pubkey
 * @returns A display name like `user_a1b2c3d4`
 */
export function genUserName(seed: string): string {
  return `user_${seed.slice(0, 8)}`;
}
