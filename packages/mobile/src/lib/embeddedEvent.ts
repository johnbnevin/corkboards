import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '@nostrify/nostrify';
import { unwrapVerifiedRepost } from '@core/noteCategories';

/**
 * Parse and signature-verify a repost/quote's embedded JSON before it is
 * rendered as an authored note. Mobile twin of the web helper.
 *
 * A kind-6/16 `content` (NIP-18) is fully attacker-controlled. Rendering it with
 * the pubkey it claims, without checking the signature, lets a hostile relay
 * impersonate anyone. Returns the innermost event only when every envelope
 * verifies (id recompute + Schnorr, via nostr-tools), else null. Core owns the
 * unwrap loop (`unwrapVerifiedRepost`) and stays crypto-free; this injects the
 * platform verifier.
 */
export function verifyEmbeddedEvent(content: string | undefined | null): NostrEvent | null {
  return unwrapVerifiedRepost(content, verifyEvent as (event: NostrEvent) => boolean);
}
