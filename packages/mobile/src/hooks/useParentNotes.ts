/**
 * useParentNotes — Batch fetch parent notes with two-pass outbox model.
 *
 * Port of packages/web/src/hooks/useParentNotes.ts for mobile.
 */
import { useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import { type NostrEvent } from '@nostrify/nostrify';
import { fetchEventWithOutbox } from '../lib/fetchEvent';

const parentNoteCache = new Map<string, NostrEvent>();
const failedFirstPass = new Set<string>();

interface ParentRequest {
  eventId: string;
  hints?: string[];
  authorPubkey?: string;
}

export function useParentNote(eventId: string | undefined) {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ['parent-note', eventId],
    queryFn: async () => {
      if (!eventId) return null;
      if (parentNoteCache.has(eventId)) return parentNoteCache.get(eventId)!;

      const result = await fetchEventWithOutbox(eventId, nostr);
      if (result) parentNoteCache.set(eventId, result);
      return result;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    enabled: !!eventId,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}

export function useParentNotes(requests: (ParentRequest | string)[]) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const secondPassScheduled = useRef(false);

  const normalized: ParentRequest[] = requests.map(r =>
    typeof r === 'string' ? { eventId: r } : r
  );

  const uniqueRequests = Array.from(
    new Map(normalized.filter(r => r.eventId?.length > 0).map(r => [r.eventId, r])).values()
  );
  const uniqueIds = uniqueRequests.map(r => r.eventId);
  const cacheKey = uniqueIds.sort().join(',');
  const queryKey = useMemo(() => ['parent-notes', cacheKey], [cacheKey]);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (uniqueRequests.length === 0) {
        return {} as Record<string, NostrEvent | null>;
      }

      const uncachedIds = uniqueIds.filter(id => !parentNoteCache.has(id));

      if (uncachedIds.length > 0) {
        try {
          const events = await nostr.query(
            [{ ids: uncachedIds }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) }
          );
          for (const event of events) {
            parentNoteCache.set(event.id, event);
          }
        } catch {
          // Pool query failed
        }

        for (const id of uncachedIds) {
          if (!parentNoteCache.has(id)) {
            failedFirstPass.add(id);
          } else {
            failedFirstPass.delete(id);
          }
        }
      }

      const result: Record<string, NostrEvent | null> = {};
      for (const id of uniqueIds) {
        result[id] = parentNoteCache.get(id) || null;
      }
      return result;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    enabled: uniqueIds.length > 0,
    placeholderData: keepPreviousData,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });

  // Second pass: retry failed IDs individually with full outbox discovery
  useEffect(() => {
    if (secondPassScheduled.current) return;
    if (!query.data) return;

    const missing = uniqueRequests.filter(r => failedFirstPass.has(r.eventId));
    if (missing.length === 0) return;

    secondPassScheduled.current = true;
    let mounted = true;
    const timer = setTimeout(async () => {
      let found = 0;
      const results = await Promise.all(
        missing.map(r =>
          fetchEventWithOutbox(r.eventId, nostr, {
            hints: r.hints,
            authorPubkey: r.authorPubkey,
          }).catch(() => null)
        )
      );

      if (!mounted) return;

      for (let i = 0; i < missing.length; i++) {
        if (results[i]) {
          parentNoteCache.set(missing[i].eventId, results[i]!);
          failedFirstPass.delete(missing[i].eventId);
          found++;
        }
      }

      if (found > 0) {
        queryClient.invalidateQueries({ queryKey });
      }
      secondPassScheduled.current = false;
    }, 3000);

    return () => {
      mounted = false;
      clearTimeout(timer);
      secondPassScheduled.current = false;
    };
  }, [query.data, uniqueRequests, nostr, queryClient, queryKey]);

  return query;
}

export function isParentNoteCached(eventId: string): boolean {
  return parentNoteCache.has(eventId);
}

export function getCachedParentNote(eventId: string): NostrEvent | undefined {
  return parentNoteCache.get(eventId);
}

export function clearParentNoteCache(): void {
  parentNoteCache.clear();
  failedFirstPass.clear();
}
