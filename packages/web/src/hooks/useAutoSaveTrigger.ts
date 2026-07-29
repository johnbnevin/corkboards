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
import type { AutoSaveResult } from '@/hooks/useNostrBackup';
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

  useEffect(() => {
    if (!enabled) return;

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
          toast({
            title: 'Auto-save paused',
            description: 'Local data looks smaller than your last backup, so auto-save is holding off to avoid overwriting it. Use Save now in the backup menu to save anyway.',
            variant: 'destructive',
          });
        } else if (result === 'no-servers') {
          debugWarn('[AutoSave] every Blossom server failed/rejected the backup');
          toast({
            title: 'Backup not saved',
            description: 'Couldn’t reach any of your backup servers. Check your Blossom server list in Advanced Settings.',
            variant: 'destructive',
          });
        } else {
          debugWarn('[AutoSave] unexpected error while saving backup');
          toast({
            title: 'Backup error',
            description: 'Something went wrong while saving. Use the backup menu to retry or download a local copy.',
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
