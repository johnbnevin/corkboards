/**
 * useOnboardFollowActivity — Onboarding feed of reactions, reposts,
 * and replies from the user's current follows.
 *
 * Port of packages/web/src/hooks/useOnboardFollowActivity.ts for mobile.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { type NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';

export function useOnboardFollowActivity(
  contacts: string[] | undefined,
  enabled: boolean,
) {
  const { nostr } = useNostr();
  const [notes, setNotes] = useState<NostrEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const seenIds = useRef(new Set<string>());
  const abortRef = useRef<AbortController | null>(null);
  const hasFetchedOnceRef = useRef(false);

  const fetchActivity = useCallback(async (pubkeys: string[]) => {
    if (pubkeys.length === 0) return;

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    try {
      const since = Math.floor(Date.now() / 1000) - 48 * 3600;
      const batchSize = 50;
      const newNotes: NostrEvent[] = [];

      for (let i = 0; i < pubkeys.length; i += batchSize) {
        if (signal.aborted) return;
        const batch = pubkeys.slice(i, i + batchSize);

        const events = await nostr.query(
          [{ kinds: [1, 6, 7], authors: batch, since, limit: 200 }],
          { signal: AbortSignal.timeout(5000) }
        ).catch((): NostrEvent[] => []);

        for (const ev of events) {
          if (seenIds.current.has(ev.id)) continue;
          if (ev.kind === 1 && !ev.tags.some(t => t[0] === 'e')) continue;
          seenIds.current.add(ev.id);
          newNotes.push(ev);
        }
      }

      if (signal.aborted) return;

      if (newNotes.length > 0) {
        setNotes(prev => {
          const merged = [...prev, ...newNotes];
          merged.sort((a, b) => b.created_at - a.created_at);
          return merged.slice(0, 60);
        });
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        console.error('[onboard-follow-activity]', err);
      }
    }
  }, [nostr]);

  useEffect(() => {
    if (!enabled || !contacts || contacts.length === 0) return;
    if (hasFetchedOnceRef.current) return;
    hasFetchedOnceRef.current = true;
    setIsLoading(true);
    fetchActivity(contacts).finally(() => setIsLoading(false));
  }, [enabled, contacts, fetchActivity]);

  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const fetchNow = useCallback(() => {
    if (!contacts || contacts.length === 0) return;
    setIsLoading(true);
    fetchActivity(contacts).finally(() => setIsLoading(false));
  }, [contacts, fetchActivity]);

  return { notes, isLoading, fetchNow };
}
