/**
 * useAutoRestoreGuard — auto-restore the newest cloud checkpoint when the
 * backup check finds one, but ONLY when there's no meaningful local data.
 *
 * Critical safety: a cloud checkpoint can be months old. If we restore it
 * over the user's live IDB rows, months of work disappear silently. The
 * guard inside this hook is what prevents that — three production incidents
 * traced to its absence.
 *
 * Reads `nostr-custom-feeds` and `corkboard:tab-filters` via async `idbGet`
 * when sync returns null, so an evicted-from-memCache large value doesn't
 * fool us into thinking local is empty.
 */
import { useEffect, useRef } from 'react';
import { idbGet, idbGetSync } from '@/lib/idb';
import { pickRestoreCandidate } from '@core/backupGuards';

export interface CheckpointSummary {
  timestamp: number;
  stats?: { corkboards?: number; savedForLater?: number; dismissed?: number };
  /** Only used to label the pick internally — never compared. */
  eventId?: string;
}

export interface UseAutoRestoreGuardOptions<T extends CheckpointSummary> {
  /** Whether the backup-check round-trip has settled. */
  backupCheckSettled: boolean;
  /** Current backup hook status — only triggers when 'found'. */
  backupStatus: string;
  /** Available remote checkpoints. */
  checkpoints: readonly T[];
  /** Local last-backup-ts; skip restore if local is already at/ahead. */
  lastBackupTs: number;
  /** Restore the chosen checkpoint. */
  loadCheckpoint: (cp: T) => void;
}

export function useAutoRestoreGuard<T extends CheckpointSummary>({
  backupCheckSettled,
  backupStatus,
  checkpoints,
  lastBackupTs,
  loadCheckpoint,
}: UseAutoRestoreGuardOptions<T>): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    if (!backupCheckSettled || backupStatus !== 'found') return;
    if (!checkpoints.length) return;
    done.current = true;

    let cancelled = false;
    (async () => {
      const feeds = idbGetSync('nostr-custom-feeds') ?? (await idbGet('nostr-custom-feeds'));
      if (cancelled) return;
      const filters = idbGetSync('corkboard:tab-filters') ?? (await idbGet('corkboard:tab-filters'));
      if (cancelled) return;
      const hasMeaningfulLocal =
        (feeds && feeds !== '[]' && feeds !== 'null') ||
        (filters && filters !== '{}' && filters !== 'null');
      if (hasMeaningfulLocal) return;

      const withData = checkpoints.filter(cp =>
        (cp.stats?.corkboards ?? 0) > 0 ||
        (cp.stats?.savedForLater ?? 0) > 0 ||
        (cp.stats?.dismissed ?? 0) > 0,
      );
      const pool = withData.length > 0 ? withData : checkpoints;
      // Newest wins; content is only a data-loss veto (zero corkboards while
      // another candidate has some). Ranking content first here was the
      // "keeps loading an older save state" bug: after any deletion/cleanup,
      // an older-but-richer checkpoint outranked every newer save forever.
      const best = pickRestoreCandidate(
        pool.map(cp => ({ id: cp.eventId ?? '', timestamp: cp.timestamp, stats: cp.stats, _cp: cp })),
      )._cp;
      if (lastBackupTs && lastBackupTs >= best.timestamp) return;
      if (cancelled) return;
      loadCheckpoint(best);
    })().catch((err) => {
      if (!cancelled) console.warn('[useAutoRestoreGuard] async check failed:', err);
    });
    return () => { cancelled = true; };
  // lastBackupTs intentionally omitted — it changes after loadCheckpoint, would re-trigger
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupCheckSettled, backupStatus, checkpoints, loadCheckpoint]);
}
