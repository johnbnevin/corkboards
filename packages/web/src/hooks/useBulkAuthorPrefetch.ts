/**
 * useBulkAuthorPrefetch — populate the React Query author cache for notes
 * being displayed, so individual NoteCard renders don't each trigger a
 * separate `useAuthor` network fetch.
 *
 * Two prefetch passes:
 *   1. Debounced (~50ms) prefetch of the currently-displayed notes — fires
 *      after `deduplicatedNotes` changes.
 *   2. Eager all-follows prefetch — runs as soon as all-follows notes load,
 *      regardless of the active tab. Avoids 60+ simultaneous useAuthor
 *      fetches (and a WebKit-on-Tauri crash) when the user switches to that
 *      tab and everything renders at once.
 *
 * The note-id fingerprint avoids re-prefetching when only the array
 * reference changed but the contents are equivalent.
 */
import { useEffect, useRef } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { useBulkAuthors } from '@/hooks/useBulkAuthors';
import { debugWarn } from '@/lib/debug';

const PREFETCH_DEBOUNCE_MS = 50;
const FINGERPRINT_PREFIX = 30;

export interface UseBulkAuthorPrefetchOptions {
  /** Notes currently displayed (typically `deduplicatedNotes`). */
  displayedNotes: readonly NostrEvent[];
  /** Background prefetch target — usually `allFollowsNotes`. Optional. */
  allFollowsNotes?: readonly NostrEvent[] | undefined;
  /** Slice limit — we only prefetch the first N notes of each set. */
  feedLimit: number;
  /** Skip when false (e.g. backup splash still showing). */
  enabled: boolean;
}

export function useBulkAuthorPrefetch({
  displayedNotes,
  allFollowsNotes,
  feedLimit,
  enabled,
}: UseBulkAuthorPrefetchOptions): void {
  const { prefetchFromNotes } = useBulkAuthors();
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced prefetch for the currently-displayed notes
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    if (!enabled) return;

    debounceTimer.current = setTimeout(() => {
      const slice = displayedNotes.slice(0, feedLimit);
      if (slice.length > 0) {
        prefetchFromNotes(slice).catch(err => {
          debugWarn('[useBulkAuthorPrefetch] visible prefetch failed:', err);
        });
      }
    }, PREFETCH_DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [displayedNotes, feedLimit, prefetchFromNotes, enabled]);

  // Eager all-follows prefetch — fingerprint-gated so repeated identical arrays don't refire
  const allFollowsKeyRef = useRef('');
  useEffect(() => {
    if (!enabled || !allFollowsNotes || allFollowsNotes.length === 0) return;
    const key = allFollowsNotes.slice(0, FINGERPRINT_PREFIX).map(n => n.id).join(',');
    if (key === allFollowsKeyRef.current) return;
    allFollowsKeyRef.current = key;
    prefetchFromNotes(allFollowsNotes.slice(0, feedLimit)).catch(() => {});
  }, [allFollowsNotes, feedLimit, prefetchFromNotes, enabled]);
}
