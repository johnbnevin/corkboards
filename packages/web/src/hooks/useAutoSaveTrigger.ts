/**
 * useAutoSaveTrigger — orchestrates cloud backup saves with three safety gates:
 *
 *   1. **Page-load cooldown.** No auto-save for AUTO_SAVE_COOLDOWN_MS after
 *      mount. Prevents overwriting a good cloud backup with empty/stale state
 *      after an unexpected refresh where IDB hasn't fully restored.
 *   2. **Inter-save minimum.** No more often than AUTO_SAVE_MIN_INTERVAL_MS.
 *   3. **Change-detection debounce.** Once unsaved changes appear, wait
 *      AUTO_SAVE_DEBOUNCE_MS before firing. Bundles rapid edits into one upload.
 *
 * Drives via two paths:
 *   - AUTO_SAVE_POLL_MS poll for ambient detection (and called once on mount)
 *   - Immediate fire on `visibilitychange:hidden` and `beforeunload`
 *
 * Extracted from MultiColumnClient because three production save-storm
 * incidents traced to one of these gates being subtly wrong; isolating the
 * orchestration makes the next regression easier to bisect.
 */
import { useEffect, useRef } from 'react';
import { debugLog, debugWarn } from '@/lib/debug';
import { getLastAutoSaveError, type AutoSaveResult } from '@/hooks/useNostrBackup';
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
  /** Indicator state setter for UI ("unsaved" / "saved"). */
  setBackupIndicator: (state: 'idle' | 'unsaved' | 'saved') => void;
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

    let changeDetectedAt: number | null = null;

    const triggerIfReady = (source: string) => {
      // Never auto-save while a restore is in flight. 'found' is deliberately
      // NOT in this list anymore: it means "a newer cloud snapshot exists",
      // which can persist for a while (held mass-removal merge, a manifest
      // that won't decrypt this round) — and while it persisted, this skip
      // kept the device from ever saving its own changes: permanently red
      // indicator, no uploads. The login-time window between 'found' and the
      // auto-restore starting is already covered by the startup cooldown, and
      // autoSaveBackup itself refuses to run during an actual restore.
      if (backupStatus === 'restoring' || backupStatus === 'restored') {
        debugLog(`[AutoSave] skip (${source}): backup ${backupStatus}, waiting for restore to complete`);
        return;
      }
      const msSinceLoad = Date.now() - pageLoadTime.current;
      if (msSinceLoad < cooldownMs) {
        debugLog(`[AutoSave] skip (${source}): ${Math.round(msSinceLoad / 1000)}s since page load, need ${cooldownMs / 1000}s cooldown`);
        return;
      }
      const lastUploadMs = (lastBackupTs ?? 0) * 1000;
      const msSinceLast = Date.now() - lastUploadMs;
      if (msSinceLast < MIN_INTERVAL_MS) {
        debugLog(`[AutoSave] skip (${source}): ${Math.round(msSinceLast / 1000)}s since last upload, need ${MIN_INTERVAL_MS / 1000}s`);
        return;
      }
      if (!hasUnsavedChanges()) {
        // Log the transition, not every tick: this branch returning silently
        // made "the indicator says saved but my other device disagrees"
        // impossible to tell apart from "the poll died" in a log — the poll
        // looks identical to a stopped timer when it has nothing to do.
        if (changeDetectedAt !== null) debugLog(`[AutoSave] nothing left to save (${source})`);
        changeDetectedAt = null;
        return;
      }
      if (changeDetectedAt === null) {
        changeDetectedAt = Date.now();
        setBackupIndicator('unsaved');
        debugLog(`[AutoSave] changes detected (${source}), will save in ${DEBOUNCE_MS / 1000}s`);
        return;
      }
      const msSinceChange = Date.now() - changeDetectedAt;
      if (msSinceChange < DEBOUNCE_MS) {
        debugLog(`[AutoSave] skip (${source}): ${Math.round(msSinceChange / 1000)}s since change, need ${DEBOUNCE_MS / 1000}s`);
        return;
      }
      debugLog(`[AutoSave] triggering (${source})`);
      changeDetectedAt = null;
      autoSaveBackup().then((result) => {
        if (result === 'saved') {
          setBackupIndicator('saved');
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
            description: 'Local data looks smaller than your last backup, so auto-save is holding off to avoid overwriting it. Use Save now in the backup menu to save anyway.',
            variant: 'destructive',
          });
        } else if (result === 'no-servers') {
          const detail = getLastAutoSaveError();
          debugWarn('[AutoSave] every Blossom server failed/rejected the backup:', detail);
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
          toastOnce('no-relays', {
            title: 'Backup stored, but not announced',
            description: `${detail || 'No relay accepted the backup manifest.'} Your data reached storage, but other devices can’t discover it until a relay accepts the manifest. Check your relays in Advanced Settings.`,
            variant: 'destructive',
          });
        } else {
          const detail = getLastAutoSaveError();
          debugWarn('[AutoSave] unexpected error while saving backup:', detail);
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

    const pollInterval = setInterval(() => triggerIfReady('poll-30s'), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);
    triggerIfReady('mount');

    return () => {
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [enabled, backupStatus, autoSaveBackup, hasUnsavedChanges, lastBackupTs, toast, setBackupIndicator, cooldownMs]);
}
