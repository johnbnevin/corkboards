/**
 * useAutoSaveTrigger — orchestrates cloud backup saves with three safety gates:
 *
 *   1. **Page-load cooldown.** No auto-save for AUTO_SAVE_COOLDOWN_MS after
 *      mount. Prevents overwriting a good cloud backup with empty/stale state
 *      after an unexpected refresh where IDB hasn't fully restored.
 *   2. **Inter-save minimum.** No more often than every 30s.
 *   3. **Change-detection debounce.** Once unsaved changes appear, wait
 *      another 30s before firing. Bundles rapid edits into one upload.
 *
 * Drives via two paths:
 *   - 30-second poll for ambient detection (and called once on mount)
 *   - Immediate fire on `visibilitychange:hidden` and `beforeunload`
 *
 * Extracted from MultiColumnClient because three production save-storm
 * incidents traced to one of these gates being subtly wrong; isolating the
 * orchestration makes the next regression easier to bisect.
 */
import { useEffect, useRef } from 'react';
import { debugLog, debugWarn } from '@/lib/debug';

const MIN_INTERVAL_MS = 30 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;

export interface UseAutoSaveTriggerOptions {
  /** Whether the user is signed in. */
  enabled: boolean;
  /** Skip auto-save while a backup check / restore is in progress. */
  backupStatus: string;
  /** Last successful upload timestamp (Unix seconds). */
  lastBackupTs: number;
  /** Returns true when there's something new worth uploading. */
  hasUnsavedChanges: () => boolean;
  /** Perform the actual upload; resolves true on success. */
  autoSaveBackup: () => Promise<boolean>;
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
      // Never auto-save while a restore is in flight.
      if (backupStatus === 'found' || backupStatus === 'restoring' || backupStatus === 'restored') {
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
        debugLog(`[AutoSave] changes detected (${source}), will save in ${MIN_INTERVAL_MS / 1000}s`);
        return;
      }
      const msSinceChange = Date.now() - changeDetectedAt;
      if (msSinceChange < MIN_INTERVAL_MS) {
        debugLog(`[AutoSave] skip (${source}): ${Math.round(msSinceChange / 1000)}s since change, need ${MIN_INTERVAL_MS / 1000}s`);
        return;
      }
      debugLog(`[AutoSave] triggering (${source})`);
      changeDetectedAt = null;
      autoSaveBackup().then((saved) => {
        if (saved) {
          setBackupIndicator('saved');
        } else {
          debugWarn('[AutoSave] Blossom upload failed');
          toast({
            title: 'Auto-save failed',
            description: 'Could not save to Blossom. Use the backup menu to retry or download a local copy.',
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
              .then((saved) => { if (saved) setBackupIndicator('saved'); })
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
