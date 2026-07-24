/**
 * Per-pubkey "has onboarded" flag.
 *
 * Onboarding used to be gated only on a GLOBAL skip key restored by the per-user
 * stash/restore machinery, which didn't reliably reload on login — so a user who
 * skipped was re-prompted every login. This flag is keyed directly by pubkey, so
 * it is inherently per-account and survives logout/login/reload without relying
 * on that machinery. Set it when the user skips OR completes onboarding; a brand-
 * new account (different pubkey) has no flag and still onboards.
 */
import { idbGetSync, idbSetSync, idbRemoveSync, idbReady } from '@/lib/idb';

const key = (pubkey: string) => `corkboard:onboarded:${pubkey}`;

/** Whether this account has skipped or completed onboarding. */
export function getOnboarded(pubkey: string): boolean {
  return idbGetSync(key(pubkey)) === 'true';
}

/** Mark this account as having skipped/completed onboarding (persisted). */
export function setOnboarded(pubkey: string): void {
  idbSetSync(key(pubkey), 'true');
}

/** Clear the flag so onboarding shows again (e.g. "Restart Onboarding"). */
export function clearOnboarded(pubkey: string): void {
  idbRemoveSync(key(pubkey));
}

export { idbReady };
