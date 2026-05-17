/**
 * useAccountIsolation — wipe stale per-user data when the active pubkey changes.
 *
 * Extracted from MultiColumnClient.tsx so the bug-prone account-switch flow
 * can be tested in isolation. Three production data-loss incidents traced
 * back to this effect; centralising it here makes future fixes safer.
 *
 * Behaviour:
 *   - On mount, if the marker `corkboard:active-user-pubkey` disagrees with
 *     the logged-in `pubkey`, we call `switchActiveUser` (atomic stash of
 *     departing user → clear → restore of arriving user → marker update),
 *     wipe session-scoped state that isn't keyed by pubkey, and reload.
 *   - If the marker already matches, no-op.
 *   - If `pubkey` is undefined (signed out), no-op.
 */
import { useEffect } from 'react';
import { getActiveUserPubkey, switchActiveUser } from '@/lib/storageKeys';
import { bumpSessionEpoch } from '@/hooks/useSessionAbort';

export function useAccountIsolation(pubkey: string | undefined): void {
  useEffect(() => {
    if (!pubkey) return;
    const activePubkey = getActiveUserPubkey();
    if (activePubkey === pubkey) return;

    // Abort BEFORE the storage swap and reload. The reload is the primary
    // safety net (it kills all in-flight subscriptions), but the abort also
    // signals other tabs and any code that observes the user change before
    // the navigation lands.
    bumpSessionEpoch();
    switchActiveUser(activePubkey, pubkey);
    try {
      sessionStorage.removeItem('corkboard:scroll-positions');
      sessionStorage.removeItem('corkboard:active-tab');
      sessionStorage.removeItem('corkboard:new-user');
      sessionStorage.removeItem('corkboard:soft-dismissed');
      sessionStorage.removeItem('corkboard:session-collapsed');
      sessionStorage.removeItem('corkboard:skip-backup-check');
    } catch { /* sessionStorage may be unavailable */ }
    window.location.reload();
  }, [pubkey]);
}
