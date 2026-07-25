import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '@nostrify/nostrify';
import { unwrapVerifiedRepost } from '@core/noteCategories';

/**
 * Parse and signature-verify a repost/quote's embedded JSON before it is
 * rendered as an authored note.
 *
 * A kind-6/16 `content` (NIP-18) — and the JSON some clients embed for a quoted
 * note — is fully attacker-controlled. Rendering it with the pubkey it claims,
 * without checking the signature, lets a hostile relay impersonate anyone. This
 * returns the innermost event only when every envelope verifies (id recompute +
 * Schnorr, via nostr-tools), else null so the caller falls back to fetching the
 * real event by id through the verified transport.
 *
 * Core owns the unwrap loop (`unwrapVerifiedRepost`) and stays crypto-free; this
 * injects the platform's verifier.
 */
export function verifyEmbeddedEvent(content: string | undefined | null): NostrEvent | null {
  return unwrapVerifiedRepost(content, verifyEvent as (event: NostrEvent) => boolean);
}
