/**
 * useIdleAutoRestoreCheck — after the user returns from N+ minutes of true
 * idle (tab hidden, not just scrolling or watching), silently re-check the
 * cloud for a newer backup checkpoint. If one has substantially more
 * dismissed-note progress, propose it for restore.
 *
 * This is the *idle-return* gate, separate from useAutoRestoreGuard which
 * runs once at app launch. Both share the same safety property: never
 * silently overwrite local data without user awareness.
 *
 * Extracted from MultiColumnClient so the visibility-event plumbing is
 * testable and the "5 minutes" threshold lives in @core/cacheConfig.
 */
import { useEffect, useRef } from 'react';
import { IDLE_AUTO_RESTORE_THRESHOLD_MS } from '@core/cacheConfig';

export interface CheckpointStats {
  stats?: { dismissed?: number };
}

export interface UseIdleAutoRestoreCheckOptions<T extends CheckpointStats> {
  /** True when a user is logged in. Skip the effect when false. */
  enabled: boolean;
  /** Trigger a forced backup check; resolves when the check is settled. */
  checkRemoteBackup: (force: boolean) => Promise<void>;
  /** Reads the current set of cloud checkpoints (post-check). */
  getCheckpoints: () => T[];
  /** Current local dismissed-note count — used to detect "more progress" remote checkpoints. */
  dismissedCount: number;
  /**
   * Called with the best (most-dismissed-progress) remote checkpoint when
   * it's substantially ahead. Show a restore-suggestion UI; never silently
   * apply the restore.
   */
  onSuggestRestore: (target: { checkpoint: T; reason: string }) => void;
  /** Minimum dismissed-count delta before suggesting a restore. */
  minDismissedDelta?: number;
}

export function useIdleAutoRestoreCheck<T extends CheckpointStats>({
  enabled,
  checkRemoteBackup,
  getCheckpoints,
  dismissedCount,
  onSuggestRestore,
  minDismissedDelta = 5,
}: UseIdleAutoRestoreCheckOptions<T>): void {
  const doneRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let lastHidden = 0;
    const onVisChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHidden = Date.now();
        doneRef.current = false;
        return;
      }
      if (document.visibilityState !== 'visible') return;
      if (lastHidden === 0 || doneRef.current) return;
      const awayMs = Date.now() - lastHidden;
      if (awayMs < IDLE_AUTO_RESTORE_THRESHOLD_MS) return;
      doneRef.current = true;
      checkRemoteBackup(true).then(() => {
        const cps = getCheckpoints();
        if (!cps.length) return;
        let best: T | null = null;
        let bestDismissed = dismissedCount;
        for (const cp of cps) {
          const d = cp.stats?.dismissed ?? 0;
          if (d > bestDismissed) {
            best = cp;
            bestDismissed = d;
          }
        }
        if (best && (bestDismissed - dismissedCount) > minDismissedDelta) {
          onSuggestRestore({
            checkpoint: best,
            reason: `Newer backup found (${bestDismissed - dismissedCount} more dismissed)`,
          });
        }
      });
    };
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  }, [enabled, checkRemoteBackup, getCheckpoints, dismissedCount, onSuggestRestore, minDismissedDelta]);
}
