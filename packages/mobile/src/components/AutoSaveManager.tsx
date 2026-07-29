/**
 * AutoSaveManager — headless component that orchestrates automatic cloud backup.
 *
 * Mirrors the web's auto-save + cloud-sync orchestration (useAutoSaveTrigger
 * and useCloudSync; cadences shared via @core/cacheConfig):
 *   - Poll to detect and save changes (push)
 *   - Immediate save when app goes to background
 *   - Silent pull-merge of a newer cloud snapshot on launch, on foreground
 *     return, and on an interval
 *
 * Mount alongside NostrSync in App.tsx — renders nothing.
 */
import { useEffect, useRef, useCallback } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useAuth } from '../lib/AuthContext';
import { useNostrBackup, getStoredCheckpoints } from '../hooks/useNostrBackup';
import { registerBackupFlush } from '../lib/backupFlush';
import { mobileStorage } from '../storage/MmkvStorage';
import { STORAGE_KEYS } from '../lib/storageKeys';
import {
  CLOUD_SYNC_INTERVAL_MS,
  CLOUD_SYNC_MIN_GAP_MS,
  AUTO_SAVE_MIN_INTERVAL_MS,
  AUTO_SAVE_DEBOUNCE_MS,
  AUTO_SAVE_POLL_MS,
  AUTO_SAVE_STARTUP_COOLDOWN_MS,
} from '@core/cacheConfig';

export function AutoSaveManager() {
  const { pubkey, signer } = useAuth();
  const {
    autoSaveBackup,
    hasUnsavedChanges,
    checkForBackup,
    restoreBackup,
  } = useNostrBackup(pubkey, signer);

  const lastHiddenRef = useRef(0);
  const syncInFlightRef = useRef(false);
  const lastSyncAtRef = useRef(0);
  const launchedAtRef = useRef(Date.now());

  /**
   * Look for a newer cloud snapshot AND apply it (silent merge). Guarded so
   * the interval and the foreground handler cannot pile up on each other.
   * `force` skips the gap check for a genuine long-idle return.
   *
   * The apply step is what the old version was missing: it refreshed the
   * checkpoint list every interval but only a once-per-session effect after a
   * 5-minute background stint ever merged anything — so a phone sitting open
   * next to a desktop pulled metadata forever and state never.
   */
  const syncNow = useCallback((force: boolean) => {
    if (syncInFlightRef.current) return;
    if (!force && Date.now() - lastSyncAtRef.current < CLOUD_SYNC_MIN_GAP_MS) return;
    syncInFlightRef.current = true;
    lastSyncAtRef.current = Date.now();
    (async () => {
      try {
        await checkForBackup();
        // Read straight from storage — checkForBackup persists before React
        // state propagates, so this is fresh where the hook state may not be.
        const cps = getStoredCheckpoints();
        if (!cps.length) return;
        const newest = cps.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
        let localTs = parseInt(mobileStorage.getSync(STORAGE_KEYS.LAST_BACKUP_TS) || '0', 10);

        // Local data that predates timestamping: stamp it NOW so it counts as
        // newer than any existing cloud save (it holds changes no save has
        // captured), and let the normal push/merge machinery take over from
        // here. Mirrors web's checkRemoteBackup. The auto-save trigger will
        // upload this state shortly, making the stamp honest.
        if (localTs === 0) {
          const feeds = mobileStorage.getSync('nostr-custom-feeds');
          const filters = mobileStorage.getSync('corkboard:tab-filters');
          const hasMeaningfulLocal =
            (feeds && feeds !== '[]' && feeds !== 'null') ||
            (filters && filters !== '{}' && filters !== 'null');
          if (hasMeaningfulLocal) {
            localTs = Math.floor(Date.now() / 1000);
            mobileStorage.setSync(STORAGE_KEYS.LAST_BACKUP_TS, String(localTs));
            if (__DEV__) console.log('[AutoSave] stamped LAST_BACKUP_TS to protect unsynced local data');
            return;
          }
        }

        // Strictly newer: equal timestamps mean this device wrote it.
        if (newest.timestamp <= localTs) return;
        if (__DEV__) console.log(`[AutoSave] cloud ${newest.timestamp} newer than local ${localTs} — merging`);
        await restoreBackup(newest, { silent: true });
      } catch (e) {
        if (__DEV__) console.warn('[AutoSave] sync failed (will retry):', e);
      } finally {
        syncInFlightRef.current = false;
      }
    })();
  }, [checkForBackup, restoreBackup]);

  // Expose the backup flush so AuthContext.switchAccount can flush pending cloud
  // backup for the departing account before swapping (parity with logout).
  useEffect(() => {
    registerBackupFlush(async () => { if (hasUnsavedChanges()) { await autoSaveBackup(); } });
    return () => registerBackupFlush(null);
  }, [autoSaveBackup, hasUnsavedChanges]);

  // Trigger auto-save if conditions are met (mirrors web's triggerBlossomIfReady).
  const changeDetectedAtRef = useRef<number | null>(null);

  const triggerIfReady = useCallback((source: string) => {
    // Startup cooldown (parity with web): no auto-save right after launch,
    // while the login check / a pending silent merge may still be in flight.
    if (Date.now() - launchedAtRef.current < AUTO_SAVE_STARTUP_COOLDOWN_MS) return;
    const lastUploadMs = parseInt(mobileStorage.getSync(STORAGE_KEYS.LAST_BACKUP_TS) || '0', 10) * 1000;
    if (Date.now() - lastUploadMs < AUTO_SAVE_MIN_INTERVAL_MS) return;
    if (!hasUnsavedChanges()) {
      changeDetectedAtRef.current = null;
      return;
    }
    if (changeDetectedAtRef.current === null) {
      changeDetectedAtRef.current = Date.now();
      if (__DEV__) console.log(`[AutoSave] changes detected (${source}), will save in ${AUTO_SAVE_DEBOUNCE_MS / 1000}s`);
      return;
    }
    if (Date.now() - changeDetectedAtRef.current < AUTO_SAVE_DEBOUNCE_MS) return;
    if (__DEV__) console.log(`[AutoSave] triggering (${source})`);
    changeDetectedAtRef.current = null;
    autoSaveBackup().catch(e => {
      if (__DEV__) console.warn('[AutoSave] failed:', e);
    });
  }, [autoSaveBackup, hasUnsavedChanges]);

  // Change-detection polling + AppState listener
  useEffect(() => {
    if (!pubkey || !signer) return;

    const pollInterval = setInterval(() => triggerIfReady('poll'), AUTO_SAVE_POLL_MS);
    // Initial check on mount
    triggerIfReady('mount');

    // Pull on launch — the moment that matters most for a device that has been
    // away (parity with web's load-time sync). Delayed so it doesn't compete
    // with first render.
    const initialSync = setTimeout(() => syncNow(true), 4000);

    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        // Force immediate save on background — bypass interval check
        lastHiddenRef.current = Date.now();
        if (hasUnsavedChanges()) {
          if (__DEV__) console.log('[AutoSave] forcing save on background');
          autoSaveBackup().catch(e => {
            if (__DEV__) console.warn('[AutoSave] bg save failed:', e);
          });
        }
      } else if (nextState === 'active' && lastHiddenRef.current > 0) {
        const awayMs = Date.now() - lastHiddenRef.current;

        // Retry the save that likely FAILED when we backgrounded: the OS tears
        // down the network as the app suspends, so the forced background upload
        // to Blossom often times out, leaving changes unsaved (the red notice
        // the user sees on return). Wait briefly for connectivity to recover,
        // then save again. This is the main fix for "autosaves failing".
        if (hasUnsavedChanges()) {
          if (__DEV__) console.log('[AutoSave] resume — retrying save for unsaved changes');
          setTimeout(() => {
            if (hasUnsavedChanges()) {
              autoSaveBackup().catch(e => {
                if (__DEV__) console.warn('[AutoSave] resume save failed:', e);
              });
            }
          }, 2500);
        }

        // Check for a newer backup on EVERY return to the foreground, not only
        // after 5+ minutes away. The old threshold meant a phone picked up a
        // desktop's save only if it had been backgrounded for five minutes
        // first — so switching between the two never propagated anything, which
        // is the "phone never says newer found" report. The gap guard in
        // syncNow keeps this from firing on every app-switch.
        syncNow(awayMs >= 5 * 60 * 1000);
      }
    };

    // Poll for a newer cloud snapshot while the app is in the foreground, at the
    // same cadence web uses (shared constant, so the two ends stay in step).
    const syncInterval = setInterval(() => {
      if (AppState.currentState === 'active') syncNow(false);
    }, CLOUD_SYNC_INTERVAL_MS);

    const subscription = AppState.addEventListener('change', handleAppState);
    return () => {
      clearInterval(pollInterval);
      clearInterval(syncInterval);
      clearTimeout(initialSync);
      subscription.remove();
    };
  }, [pubkey, signer, triggerIfReady, autoSaveBackup, hasUnsavedChanges, checkForBackup, syncNow]);

  // The old once-per-session "idle restore" effect is gone: syncNow now applies
  // the newest checkpoint (silent merge, removal-capped) on every trigger —
  // load, foreground return, and the interval — with the unstamped-local-data
  // guard folded in. One path instead of two that disagreed.

  return null;
}
