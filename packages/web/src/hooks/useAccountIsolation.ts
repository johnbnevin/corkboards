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

      // No PREVIOUS account means nothing to isolate from — record the marker
      // and carry on. This is the first login on a fresh profile, and reloading
      // there is not just unnecessary, it actively breaks the login:
      //
      // the login lands, this effect fires, the page reloads, and the user is
      // put back on the login screen while the app re-bootstraps its signer.
      // It looks exactly like a failed login, so they do it again — and the
      // second attempt "works" only because the marker now matches and no
      // reload happens. That is the "QR login always takes two tries on a fresh
      // install" report, and the debug log confirmed the first attempt had
      // already succeeded (secret matched, user resolved, bookmarks decrypted)
      // before the reload threw it away.
      //
      // The reload's purpose is to kill subscriptions belonging to the account
      // being switched AWAY from. With no such account there is nothing to
      // kill. Any data stashed under this pubkey from an earlier session is
      // still restored by switchActiveUser below.
      if (!activePubkey) {
        switchActiveUser(activePubkey, pubkey);
        try { await idbSet(ACTIVE_USER_KEY, pubkey); } catch { /* best-effort */ }
        return;
      }

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
