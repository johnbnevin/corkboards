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
import { idbReady, idbSet } from '@/lib/idb';
import { ACTIVE_USER_KEY } from '@core/storageKeys';

const ISOLATION_GUARD_KEY = 'corkboard:isolation-switched';

export function useAccountIsolation(pubkey: string | undefined): void {
  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;

    (async () => {
      // CRITICAL: the active-user marker lives in IndexedDB, whose synchronous
      // memCache is EMPTY until idbReady resolves. Reading it before then returns
      // null → a false mismatch → switchActiveUser + reload on every load → an
      // infinite reload loop. Wait for the cache to populate before comparing.
      await idbReady;
      if (cancelled) return;

      const activePubkey = getActiveUserPubkey();
      if (activePubkey === pubkey) return;

      // Loop-breaker: perform at most one isolation switch+reload per pubkey per
      // tab session. Even if the marker write below fails to persist before the
      // reload, this guarantees we never reload more than once for this account.
      try {
        if (sessionStorage.getItem(ISOLATION_GUARD_KEY) === pubkey) return;
        sessionStorage.setItem(ISOLATION_GUARD_KEY, pubkey);
      } catch { /* sessionStorage unavailable — proceed; the marker flush below still guards */ }

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

      // Persist the active-user marker to IDB and AWAIT it before reloading.
      // switchActiveUser only schedules the write via setSync; reloading
      // immediately would interrupt it, so the next load would read a stale
      // marker and switch again. Awaiting the flush makes the swap stick.
      try { await idbSet(ACTIVE_USER_KEY, pubkey); } catch { /* best-effort */ }
      if (cancelled) return;
      window.location.reload();
    })();

    return () => { cancelled = true; };
  }, [pubkey]);
}
