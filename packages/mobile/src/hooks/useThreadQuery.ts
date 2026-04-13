/**
 * useThreadQuery — TanStack Query-based thread fetching.
 *
 * Port of packages/web/src/hooks/useThreadQuery.ts for mobile.
 * Uses mobile's NostrProvider and fetchEvent utilities.
 */
import { useMemo, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import type { NostrEvent } from '@nostrify/nostrify';
import {
  parseThreadTags,
  buildThreadTree,
  flattenTree,
  deduplicateEvents,
  type ThreadNode,
  type FlatThreadRow,
} from '@core/threadTree';
import { fetchEventWithOutbox, setCachedEvent } from '../lib/fetchEvent';

const THREAD_STALE_TIME = 2 * 60 * 1000;
const THREAD_GC_TIME = 10 * 60 * 1000;

export interface UseThreadQueryResult {
  tree: ThreadNode | null;
  rows: FlatThreadRow[];
  targetEvent: NostrEvent | null;
  rootId: string | null;
  allEvents: NostrEvent[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  injectReply: (event: NostrEvent) => void;
  collapsedIds: Set<string>;
  toggleCollapse: (eventId: string) => void;
}

export function useThreadQuery(eventId: string | null): UseThreadQueryResult {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const [injectedReply, setInjectedReply] = useState<NostrEvent | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const [prevEventId, setPrevEventId] = useState(eventId);
  if (eventId !== prevEventId) {
    setPrevEventId(eventId);
    setInjectedReply(null);
    setCollapsedIds(new Set());
  }

  // Query 1: Fetch the target event
  const { data: targetEvent, isLoading: isLoadingTarget, error: targetError } = useQuery({
    queryKey: ['thread-target', eventId],
    queryFn: async () => {
      if (!eventId) return null;
      const events = await nostr.query(
        [{ ids: [eventId], limit: 1 }],
        { signal: AbortSignal.timeout(5000) },
      );
      if (events[0]) {
        setCachedEvent(events[0].id, events[0]);
        return events[0];
      }
      return fetchEventWithOutbox(eventId, nostr);
    },
    enabled: !!eventId,
    staleTime: THREAD_STALE_TIME,
    gcTime: THREAD_GC_TIME,
    retry: 2,
    retryDelay: 1000,
  });

  const rootId = useMemo(() => {
    if (!targetEvent) return null;
    const tags = parseThreadTags(targetEvent);
    return tags.root || targetEvent.id;
  }, [targetEvent]);

  // Query 2: Fetch entire thread
  const { data: threadEvents, isLoading: isLoadingThread, error: threadError } = useQuery({
    queryKey: ['thread-tree', rootId],
    queryFn: async () => {
      if (!rootId) return [];

      const idsToQuery = rootId === eventId ? [rootId] : [rootId, eventId!];
      const events = await nostr.query(
        [{ kinds: [1, 7], '#e': idsToQuery, limit: 500 }],
        { signal: AbortSignal.timeout(8000) },
      );

      if (!events.some(e => e.id === rootId)) {
        const rootEvents = await nostr.query(
          [{ ids: [rootId], limit: 1 }],
          { signal: AbortSignal.timeout(3000) },
        ).catch(() => [] as NostrEvent[]);
        events.push(...rootEvents);
      }

      if (targetEvent && !events.some(e => e.id === targetEvent.id)) {
        events.push(targetEvent);
      }

      return deduplicateEvents(events);
    },
    enabled: !!rootId && !!targetEvent,
    staleTime: THREAD_STALE_TIME,
    gcTime: THREAD_GC_TIME,
    retry: 1,
  });

  const allEvents = useMemo(() => threadEvents ?? [], [threadEvents]);

  const tree = useMemo(() => {
    if (!rootId || allEvents.length === 0) return null;
    return buildThreadTree(allEvents, rootId, injectedReply);
  }, [rootId, allEvents, injectedReply]);

  const rows = useMemo(() => {
    if (!tree || !eventId) return [];
    return flattenTree(tree, eventId, collapsedIds);
  }, [tree, eventId, collapsedIds]);

  const refetch = useCallback(() => {
    setInjectedReply(null);
    if (eventId) queryClient.invalidateQueries({ queryKey: ['thread-target', eventId] });
    if (rootId) queryClient.invalidateQueries({ queryKey: ['thread-tree', rootId] });
  }, [eventId, rootId, queryClient]);

  const injectReply = useCallback((event: NostrEvent) => {
    setInjectedReply(event);
    setCachedEvent(event.id, event);
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isLoading = isLoadingTarget || isLoadingThread;
  const error = targetError ? 'Failed to load event' : threadError ? 'Failed to load thread' : null;

  return {
    tree,
    rows,
    targetEvent: targetEvent ?? null,
    rootId,
    allEvents,
    isLoading,
    error,
    refetch,
    injectReply,
    collapsedIds,
    toggleCollapse,
  };
}
