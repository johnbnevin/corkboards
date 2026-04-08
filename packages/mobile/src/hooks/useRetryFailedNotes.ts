/**
 * After the app settles, retry any referenced notes that failed to load.
 * Accounts for flaky relays that may have been temporarily unavailable.
 *
 * Port of packages/web/src/hooks/useRetryFailedNotes.ts for mobile.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getFailedNoteIds } from '@core/failedNotes';

export function useRetryFailedNotes(delayMs = 15000) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const innerTimers: ReturnType<typeof setTimeout>[] = [];
    const timer = setTimeout(() => {
      const failedIds = getFailedNoteIds();
      if (failedIds.length === 0) return;

      // Stagger retries to avoid a burst of relay connections
      failedIds.forEach((noteId, i) => {
        innerTimers.push(setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['note', noteId] });
        }, i * 500));
      });
    }, delayMs);
    return () => {
      clearTimeout(timer);
      innerTimers.forEach(t => clearTimeout(t));
    };
  }, [queryClient, delayMs]);
}
