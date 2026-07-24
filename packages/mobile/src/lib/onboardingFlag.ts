/**
 * Per-pubkey "has onboarded" flag (mobile mirror of web's lib/onboardingFlag).
 *
 * Keyed directly by pubkey so it survives logout/login without depending on the
 * per-user stash/restore machinery (which mobile never ran on fresh login — the
 * cause of "re-prompted to onboard every login"). Set on skip OR completion.
 */
import { mobileStorage } from '../storage/MmkvStorage';

const key = (pubkey: string) => `corkboard:onboarded:${pubkey}`;

/** Whether this account has skipped or completed onboarding. */
export function getOnboarded(pubkey: string): boolean {
  return mobileStorage.getSync(key(pubkey)) === 'true';
}

/** Mark this account as having skipped/completed onboarding (persisted). */
export function setOnboarded(pubkey: string): void {
  mobileStorage.setSync(key(pubkey), 'true');
}

/** Clear the flag so onboarding shows again ("Restart Onboarding"). */
export function clearOnboarded(pubkey: string): void {
  mobileStorage.removeSync(key(pubkey));
}
