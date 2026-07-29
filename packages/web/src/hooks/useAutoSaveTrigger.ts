/**
 * useAutoSaveTrigger — orchestrates cloud backup saves.
 *
 * Detection is EVENT-DRIVEN: the storage layer marks the backup dirty at its
 * write choke point (lib/backupDirty), and each dirty event (re)arms a short
 * trailing debounce — a burst of edits becomes one upload, and a lone edit
 * uploads ~AUTO_SAVE_DEBOUNCE_MS after it happens instead of waiting out a
 * 30-second poll. A slow safety-net poll remains as belt-and-braces for any
 * write path that somehow bypassed the choke point.
 *
 * Safety gates, DEFERRING instead of dropping:
 *   1. **Page-load cooldown.** No auto-save for `cooldownMs` after mount —
 *      protects the cloud copy while IDB is still hydrating. A change made
 *      during the cooldown is saved at the cooldown's END, not forgotten.
 *   2. **Inter-save floor.** No more often than AUTO_SAVE_MIN_INTERVAL_MS;
 *      a fire landing inside the floor is rescheduled to the floor's expiry.
 *   3. **hasUnsavedChanges()** (the content hash) remains the arbiter — dirty
 *      events only schedule the check, they never force an upload.
 *
 * Immediate flush on `visibilitychange:hidden` and `beforeunload` as before.
 *
 * Extracted from MultiColumnClient because three production save-storm
 * incidents traced to one of these gates being subtly wrong; isolating the
 * orchestration makes the next regression easier to bisect.
 */
import { useEffect, useRef } from 'react';
import { debugLog, debugWarn } from '@/lib/debug';
import { registerBackupDirtyListener } from '@/lib/backupDirty';
import { resetCloudSyncIdle } from '@/hooks/useCloudSync';
import { getLastAutoSaveError, takeLastAutoSaveWarning, type AutoSaveResult } from '@/hooks/useNostrBackup';
import type { BackupIndicatorState } from '@/components/BackupIndicatorIcon';
import {
  AUTO_SAVE_MIN_INTERVAL_MS,
  AUTO_SAVE_DEBOUNCE_MS,
  AUTO_SAVE_POLL_MS,
} from '@core/cacheConfig';

// Cadence lives in @core/cacheConfig so web and mobile cannot drift apart.
const MIN_INTERVAL_MS = AUTO_SAVE_MIN_INTERVAL_MS;
const DEBOUNCE_MS = AUTO_SAVE_DEBOUNCE_MS;
const POLL_INTERVAL_MS = AUTO_SAVE_POLL_MS;

export interface UseAutoSaveTriggerOptions {
  /** Whether the user is signed in. */
  enabled: boolean;
  /** Skip auto-save while a backup check / restore is in progress. */
  backupStatus: string;
  /** Last successful upload timestamp (Unix seconds). */
  lastBackupTs: number;
  /** Returns true when there's something new worth uploading. */
  hasUnsavedChanges: () => boolean;
  /** Perform the actual upload; resolves with a status describing the outcome. */
  autoSaveBackup: () => Promise<AutoSaveResult>;
  /** Indicator state setter for UI. */
  setBackupIndicator: (state: BackupIndicatorState) => void;
  /** Toast for surfacing failures. */
  toast: (input: { title: string; description?: string; variant?: 'destructive' | 'default' }) => void;
  /** Page-load cooldown in ms. */
  cooldownMs: number;
}

/**
 * Failure toasts are rate-limited per distinct message. Auto-save retries on
 * every poll, so a persistent failure (a relay set that won't take the
 * manifest, a Blossom outage) otherwise fires the same destructive toast every
 * cycle — which reads as the app getting worse and buries whatever the user
 * was doing. One toast per distinct problem per FAILURE_TOAST_GAP_MS; the
 * indicator and the backup log still reflect every attempt.
 */
const FAILURE_TOAST_GAP_MS = 10 * 60 * 1000;

export function useAutoSaveTrigger({
  enabled,
  backupStatus,
  lastBackupTs,
  hasUnsavedChanges,
  autoSaveBackup,
  setBackupIndicator,
  toast,
  cooldownMs,
}: UseAutoSaveTriggerOptions): void {
  const pageLoadTime = useRef(Date.now());
  const lastFailureToast = useRef<{ key: string; at: number }>({ key: '', at: 0 });

  useEffect(() => {
    if (!enabled) return;

    // One toast per distinct failure per gap — see FAILURE_TOAST_GAP_MS.
    const toastOnce = (key: string, input: { title: string; description?: string; variant?: 'destructive' | 'default' }) => {
      const prev = lastFailureToast.current;
      if (prev.key === key && Date.now() - prev.at < FAILURE_TOAST_GAP_MS) {
        debugLog(`[AutoSave] suppressing repeat failure toast (${key})`);
        return;
      }
      lastFailureToast.current = { key, at: Date.now() };
      toast(input);
    };

    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    /** One pending fire at a time; a new schedule replaces the old one.
     *  Dirty events re-arm the trailing debounce; gate deferrals reuse it. */
    const scheduleAttempt = (delayMs: number, source: string) => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        attemptSave(source);
      }, delayMs);
    };

    const attemptSave = (source: string) => {
      // Never auto-save while a restore is in flight. 'found' is deliberately
      // NOT in this list anymore: it means "a newer cloud snapshot exists",
      // which can persist for a while (held mass-removal merge, a manifest
      // that won't decrypt this round) — and while it persisted, this skip
      // kept the device from ever saving its own changes: permanently red
      // indicator, no uploads. The safety poll retries once the restore ends.
      if (backupStatus === 'restoring' || backupStatus === 'restored') {
        debugLog(`[AutoSave] skip (${source}): backup ${backupStatus}, waiting for restore to complete`);
        return;
      }
      const msSinceLoad = Date.now() - pageLoadTime.current;
      if (msSinceLoad < cooldownMs) {
        // Defer to the cooldown's end — a change made 30s after load must
        // save when the cooldown lifts, not wait for another change.
        debugLog(`[AutoSave] defer (${source}): ${Math.round(msSinceLoad / 1000)}s since page load, will fire at cooldown end`);
        scheduleAttempt(cooldownMs - msSinceLoad + 250, `${source}→cooldown-end`);
        return;
      }
      const lastUploadMs = (lastBackupTs ?? 0) * 1000;
      const msSinceLast = Date.now() - lastUploadMs;
      if (msSinceLast < MIN_INTERVAL_MS) {
        debugLog(`[AutoSave] defer (${source}): ${Math.round(msSinceLast / 1000)}s since last upload, will fire at floor expiry`);
        scheduleAttempt(MIN_INTERVAL_MS - msSinceLast + 250, `${source}→floor-end`);
        return;
      }
      if (!hasUnsavedChanges()) {
        debugLog(`[AutoSave] nothing to save (${source})`);
        return;
      }
      debugLog(`[AutoSave] triggering (${source})`);
      autoSaveBackup().then((result) => {
        if (result === 'saved') {
          setBackupIndicator('saved');
          // A local save gives other devices something new — and symmetric
          // activity means they may be saving too, so resume pull checks.
          resetCloudSyncIdle('local-save');
          // Informational, not destructive: the save went through.
          if (takeLastAutoSaveWarning() === 'saved-cleanup') {
            toastOnce('saved-cleanup', {
              title: 'Saved notes cleaned up',
              description: 'Looks like you just cleaned your Saved for Later notes — if not, something may be wrong. Checkpoints in the backup menu can restore an earlier state.',
            });
          }
        } else if (result === 'skipped') {
          // Genuinely benign: nothing to save, or a save already running.
          debugLog('[AutoSave] skipped (nothing to save)');
        } else if (result === 'blocked') {
          // A protective guard refused to overwrite the cloud because local data
          // looks smaller than the last backup. That is the right call, but it
          // must not be silent: it used to share the 'skipped' path, so a device
          // in this state showed a red indicator, no toast, and never saved
          // again — losing exactly the changes the guard was protecting.
          debugWarn('[AutoSave] blocked by a protective guard — surfacing to the user');
          setBackupIndicator('unsaved');
          toastOnce('blocked', {
            title: 'Auto-save paused',
            description: `${getLastAutoSaveError() || 'Local data looks smaller than your last backup, so auto-save is holding off to avoid overwriting it.'} Use Save now in the backup menu to save anyway.`,
            variant: 'destructive',
          });
        } else if (result === 'no-servers') {
          const detail = getLastAutoSaveError();
          debugWarn('[AutoSave] every Blossom server failed/rejected the backup:', detail);
          setBackupIndicator('error');
          toastOnce('no-servers', {
            title: 'Backup not saved — no storage server accepted it',
            description: `${detail || 'Every configured Blossom server refused the upload.'} Check your Blossom servers in Advanced Settings; the app keeps retrying.`,
            variant: 'destructive',
          });
        } else if (result === 'no-relays') {
          // Distinct from the Blossom failure on purpose: the file DID upload,
          // so pointing at the storage-server list (what the old generic toast
          // implied) sends the user to the one part that is working.
          const detail = getLastAutoSaveError();
          debugWarn('[AutoSave] no relay accepted the backup manifest:', detail);
          setBackupIndicator('error');
          toastOnce('no-relays', {
            title: 'Backup stored, but not announced',
            description: `${detail || 'No relay accepted the backup manifest.'} Your data reached storage, but other devices can’t discover it until a relay accepts the manifest. Check your relays in Advanced Settings.`,
            variant: 'destructive',
          });
        } else {
          const detail = getLastAutoSaveError();
          debugWarn('[AutoSave] unexpected error while saving backup:', detail);
          setBackupIndicator('error');
          toastOnce('error', {
            title: 'Backup error',
            description: detail
              ? `${detail} — use the backup menu to retry or download a local copy.`
              : 'Something went wrong while saving. Use the backup menu to retry or download a local copy.',
            variant: 'destructive',
          });
        }
      }).catch((e) => debugWarn('[AutoSave] Unexpected error during Blossom auto-save:', e));
    };

    // Event-driven detection: a SNAPSHOT_KEY write lands → indicator flips to
    // 'unsaved' immediately → the trailing debounce (re)arms. The hash check
    // filters writes that didn't actually change anything vs the baseline.
    const unregisterDirty = registerBackupDirtyListener((key) => {
      if (!hasUnsavedChanges()) return;
      setBackupIndicator('unsaved');
      debugLog(`[AutoSave] dirty (${key}), will save in ${DEBOUNCE_MS / 1000}s of quiet`);
      scheduleAttempt(DEBOUNCE_MS, `dirty:${key}`);
    });

    const onVisibilityChange = () => {
      const pastCooldown = Date.now() - pageLoadTime.current >= cooldownMs;
      if (document.visibilityState === 'hidden') {
        if (hasUnsavedChanges() && pastCooldown) {
          debugLog('[AutoSave] forcing save on background (cross-device sync)');
          autoSaveBackup().catch(e => debugWarn('[AutoSave] bg save failed:', e));
        }
      } else if (document.visibilityState === 'visible' && hasUnsavedChanges() && pastCooldown) {
        // Returning to the tab: the save attempted while hidden may have failed
        // (suspended tab / dropped connection), leaving the "Auto-save failed"
        // state. Retry shortly after regaining focus so it recovers on its own.
        debugLog('[AutoSave] visible — retrying save for unsaved changes');
        setTimeout(() => {
          if (hasUnsavedChanges()) {
            autoSaveBackup()
              .then((result) => { if (result === 'saved') setBackupIndicator('saved'); })
              .catch(e => debugWarn('[AutoSave] resume save failed:', e));
          }
        }, 2000);
      }
    };
    const onBeforeUnload = () => {
      if (hasUnsavedChanges() && Date.now() - pageLoadTime.current >= cooldownMs) {
        autoSaveBackup().catch(e => debugWarn('[AutoSave] close save failed:', e));
      }
    };

    // Safety net only — detection is event-driven above. Also repairs the
    // indicator if a dirty event was missed entirely.
    const pollInterval = setInterval(() => {
      if (pendingTimer) return; // a fire is already scheduled
      if (!hasUnsavedChanges()) return;
      setBackupIndicator('unsaved');
      attemptSave('safety-poll');
    }, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);
    // Pick up pre-existing unsaved changes (mount, or effect re-run after a
    // dependency change cleared a pending timer).
    if (hasUnsavedChanges()) attemptSave('mount');

    return () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      unregisterDirty();
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [enabled, backupStatus, autoSaveBackup, hasUnsavedChanges, lastBackupTs, toast, setBackupIndicator, cooldownMs]);
}
