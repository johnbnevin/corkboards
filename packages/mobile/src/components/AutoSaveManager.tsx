/**
 * AutoSaveManager — headless component that orchestrates automatic cloud backup.
 *
 * Mirrors the web's auto-save + cloud-sync orchestration (useAutoSaveTrigger
 * and useCloudSync; cadences shared via @core/cacheConfig):
 *   - Event-driven push: the storage layer marks the backup dirty at its write
 *     choke point (lib/backupDirty); each dirty event (re)arms a short trailing
 *     debounce, so a burst of edits becomes one upload ~3s after the last one.
 *     Gates DEFER instead of dropping (startup cooldown, inter-save floor).
 *   - Immediate save when app goes to background
 *   - Silent pull-merge of a newer cloud snapshot on launch, on foreground
 *     return, and on a 30s interval with the 3-strike idle stop: after
 *     CLOUD_SYNC_IDLE_STRIKES consecutive nothing-new checks, ticks go quiet
 *     until the app comes back from idle (or a local save happens).
 *   - Drives the backup indicator dot (lib/backupIndicatorStore).
 *
 * Mount alongside NostrSync in App.tsx — renders nothing.
 */
import { useEffect, useRef, useCallback } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useAuth } from '../lib/AuthContext';
import { useNostrBackup, getStoredCheckpoints, getLastSyncedManifestId } from '../hooks/useNostrBackup';
import { registerBackupFlush } from '../lib/backupFlush';
import { registerBackupDirtyListener } from '../lib/backupDirty';
import { setBackupIndicatorState } from '../lib/backupIndicatorStore';
import { mobileStorage } from '../storage/MmkvStorage';
import { STORAGE_KEYS } from '../lib/storageKeys';
import {
  CLOUD_SYNC_INTERVAL_MS,
  CLOUD_SYNC_MIN_GAP_MS,
  CLOUD_SYNC_IDLE_STRIKES,
  CLOUD_SYNC_IDLE_HEARTBEAT_MS,
  AUTO_SAVE_MIN_INTERVAL_MS,
  AUTO_SAVE_DEBOUNCE_MS,
  AUTO_SAVE_POLL_MS,
  AUTO_SAVE_STARTUP_COOLDOWN_MS,
} from '@core/cacheConfig';
import { createSyncScheduler, type SchedulerResetReason } from '@core/syncScheduler';
import { pickRestoreCandidate } from '@core/backupGuards';

/** A sync attempt that has not settled in this long is presumed dead —
 *  without the escape, a hung check wedges every future tick (parity with
 *  web's useCloudSync). */
const SYNC_STALE_MS = 90_000;

// One logical sync loop per app — module-level like web's.
const _scheduler = createSyncScheduler(CLOUD_SYNC_IDLE_STRIKES);

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
  const syncInFlightSinceRef = useRef(0);
  const lastSyncAtRef = useRef(0);
  const launchedAtRef = useRef(Date.now());

  /** Run a save and mirror the outcome into the indicator dot. */
  const runSave = useCallback(async (): Promise<string> => {
    setBackupIndicatorState('saving');
    try {
      const result = await autoSaveBackup();
      if (result === 'saved') {
        setBackupIndicatorState('saved');
        _scheduler.reset('local-save');
      } else if (result === 'error') {
        setBackupIndicatorState('error');
      } else if (hasUnsavedChanges()) {
        // skipped/guarded with changes still pending — stay honest.
        setBackupIndicatorState('unsaved');
      } else {
        setBackupIndicatorState('idle');
      }
      return result;
    } catch (e) {
      setBackupIndicatorState('error');
      throw e;
    }
  }, [autoSaveBackup, hasUnsavedChanges]);

  /**
   * Look for a newer cloud snapshot AND apply it (silent merge). Guarded so
   * the interval and the foreground handler cannot pile up on each other.
   *
   * `resetReason` marks a back-from-idle trigger: it clears the 3-strike idle
   * stop and bypasses the min-gap when the app was away 5+ minutes. Interval
   * ticks pass none, so the idle stop applies to them alone.
   *
   * The apply step is what the old version was missing: it refreshed the
   * checkpoint list every interval but only a once-per-session effect after a
   * 5-minute background stint ever merged anything — so a phone sitting open
   * next to a desktop pulled metadata forever and state never.
   */
  const syncNow = useCallback((opts?: { resetReason?: SchedulerResetReason; force?: boolean }) => {
    if (opts?.resetReason) _scheduler.reset(opts.resetReason);
    else if (_scheduler.isIdle()) {
      // A slower cadence, never a full stop — a phone left open on the app
      // must still converge with the other devices (parity with web).
      if (Date.now() - lastSyncAtRef.current < CLOUD_SYNC_IDLE_HEARTBEAT_MS) return;
      if (__DEV__) console.log('[AutoSave] idle heartbeat check');
    }
    if (syncInFlightRef.current) {
      // Stale-escape: a NIP-46 signer that never answers must not wedge every
      // future check for the rest of the session.
      if (Date.now() - syncInFlightSinceRef.current < SYNC_STALE_MS) return;
      if (__DEV__) console.log('[AutoSave] previous sync never settled — starting a fresh one');
      syncInFlightRef.current = false;
    }
    if (!opts?.force && Date.now() - lastSyncAtRef.current < CLOUD_SYNC_MIN_GAP_MS) return;
    syncInFlightRef.current = true;
    syncInFlightSinceRef.current = Date.now();
    lastSyncAtRef.current = Date.now();
    (async () => {
      try {
        await checkForBackup();
        // Read straight from storage — checkForBackup persists before React
        // state propagates, so this is fresh where the hook state may not be.
        const cps = getStoredCheckpoints();
        if (!cps.length) {
          _scheduler.recordCheckResult('nothing-new');
          return;
        }
        // Newest wins; content is only a data-loss veto (zero corkboards
        // while another candidate has some). The previous richest-first rank
        // was the "phone keeps loading the older save" bug: run on the WHOLE
        // stored checkpoint history every 30 s, any older checkpoint with
        // one more board or more saved/dismissed items outranked the user's
        // newest save forever — and once merged, its id became the
        // already-synced id, so every later tick reported "nothing new".
        const newest = pickRestoreCandidate(
          cps.map(cp => ({ id: cp.eventId, timestamp: cp.timestamp, stats: cp.stats, _cp: cp })),
        )._cp;

        // Identity, not clocks: merge whenever the chosen manifest is one this
        // device has not already published or merged.
        //
        // This replaces a timestamp comparison AND the stamp-now heuristic that
        // used to sit here (stamping LAST_BACKUP_TS to the current time for a
        // device holding un-backed-up data, so a wholesale restore couldn't
        // overwrite it). Restores are union merges now, so there was nothing to
        // protect — and the stamp made the device permanently "newer" than every
        // real cloud save, so it never pulled again.
        if (newest.eventId === getLastSyncedManifestId()) {
          _scheduler.recordCheckResult('nothing-new');
          return;
        }
        _scheduler.recordCheckResult('found-new');
        if (__DEV__) console.log(`[AutoSave] cloud manifest ${newest.timestamp} not yet merged here — merging`);
        await restoreBackup(newest, { silent: true });
      } catch (e) {
        // An outage is not idleness — failed checks are never strikes.
        _scheduler.recordCheckResult('failed');
        if (__DEV__) console.warn('[AutoSave] sync failed (will retry):', e);
      } finally {
        syncInFlightRef.current = false;
      }
    })();
  }, [checkForBackup, restoreBackup]);

  // Expose the backup flush so AuthContext.switchAccount can flush pending cloud
  // backup for the departing account before swapping (parity with logout).
  useEffect(() => {
    registerBackupFlush(async () => { if (hasUnsavedChanges()) { await runSave(); } });
    return () => registerBackupFlush(null);
  }, [runSave, hasUnsavedChanges]);

  // One pending fire at a time; a new schedule replaces the old one. Dirty
  // events re-arm the trailing debounce; gate deferrals reuse it.
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const attemptSaveRef = useRef<(source: string) => void>(() => {});

  const scheduleAttempt = useCallback((delayMs: number, source: string) => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      attemptSaveRef.current(source);
    }, delayMs);
  }, []);

  const attemptSave = useCallback((source: string) => {
    // Startup cooldown (parity with web): no auto-save right after launch —
    // but DEFER to the cooldown's end rather than dropping, so a change made
    // during the cooldown still saves the moment it lifts.
    const msSinceLaunch = Date.now() - launchedAtRef.current;
    if (msSinceLaunch < AUTO_SAVE_STARTUP_COOLDOWN_MS) {
      scheduleAttempt(AUTO_SAVE_STARTUP_COOLDOWN_MS - msSinceLaunch + 250, `${source}→cooldown-end`);
      return;
    }
    const lastUploadMs = parseInt(mobileStorage.getSync(STORAGE_KEYS.LAST_BACKUP_TS) || '0', 10) * 1000;
    const msSinceLast = Date.now() - lastUploadMs;
    if (msSinceLast < AUTO_SAVE_MIN_INTERVAL_MS) {
      scheduleAttempt(AUTO_SAVE_MIN_INTERVAL_MS - msSinceLast + 250, `${source}→floor-end`);
      return;
    }
    if (!hasUnsavedChanges()) return;
    if (__DEV__) console.log(`[AutoSave] triggering (${source})`);
    runSave().catch(e => {
      if (__DEV__) console.warn('[AutoSave] failed:', e);
    });
  }, [hasUnsavedChanges, runSave, scheduleAttempt]);
  useEffect(() => { attemptSaveRef.current = attemptSave; }, [attemptSave]);

  // Event-driven detection + safety poll + AppState listener
  useEffect(() => {
    if (!pubkey || !signer) return;

    // A SNAPSHOT_KEY write lands → dot flips to 'unsaved' → the trailing
    // debounce (re)arms. The hash check filters writes that changed nothing.
    const unregisterDirty = registerBackupDirtyListener((key) => {
      if (!hasUnsavedChanges()) return;
      setBackupIndicatorState('unsaved');
      if (__DEV__) console.log(`[AutoSave] dirty (${key}), will save in ${AUTO_SAVE_DEBOUNCE_MS / 1000}s of quiet`);
      scheduleAttempt(AUTO_SAVE_DEBOUNCE_MS, `dirty:${key}`);
    });

    // Safety net only — detection is event-driven above.
    const pollInterval = setInterval(() => {
      if (pendingTimerRef.current) return;
      if (!hasUnsavedChanges()) return;
      setBackupIndicatorState('unsaved');
      attemptSaveRef.current('safety-poll');
    }, AUTO_SAVE_POLL_MS);
    // Pick up pre-existing unsaved changes on mount.
    if (hasUnsavedChanges()) attemptSaveRef.current('mount');

    // Pull on launch — the moment that matters most for a device that has been
    // away (parity with web's load-time sync). Delayed so it doesn't compete
    // with first render.
    const initialSync = setTimeout(() => syncNow({ resetReason: 'login', force: true }), 4000);

    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        // Force immediate save on background — bypass interval check
        lastHiddenRef.current = Date.now();
        if (hasUnsavedChanges()) {
          if (__DEV__) console.log('[AutoSave] forcing save on background');
          runSave().catch(e => {
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
              runSave().catch(e => {
                if (__DEV__) console.warn('[AutoSave] resume save failed:', e);
              });
            }
          }, 2500);
        }

        // Check for a newer backup on EVERY return to the foreground — this is
        // also the back-from-idle signal that clears the 3-strike idle stop.
        // The gap guard in syncNow keeps app-switch flapping from hammering
        // relays; a 5-minute absence bypasses even that.
        syncNow({ resetReason: 'app-active', force: awayMs >= 5 * 60 * 1000 });
      }
    };

    // Poll for a newer cloud snapshot while the app is in the foreground, at the
    // same cadence web uses (shared constant, so the two ends stay in step).
    // No reset reason: the 3-strike idle stop applies to these ticks alone.
    const syncInterval = setInterval(() => {
      if (AppState.currentState === 'active') syncNow();
    }, CLOUD_SYNC_INTERVAL_MS);

    const subscription = AppState.addEventListener('change', handleAppState);
    return () => {
      unregisterDirty();
      if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
      clearInterval(pollInterval);
      clearInterval(syncInterval);
      clearTimeout(initialSync);
      subscription.remove();
    };
  }, [pubkey, signer, hasUnsavedChanges, runSave, scheduleAttempt, syncNow]);

  // The old once-per-session "idle restore" effect is gone: syncNow now applies
  // the newest checkpoint (silent merge, removal-capped) on every trigger —
  // load, foreground return, and the interval — with the unstamped-local-data
  // guard folded in. One path instead of two that disagreed.

  return null;
}
