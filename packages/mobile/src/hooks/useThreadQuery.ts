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
  getParentId,
  type ThreadNode,
  type FlatThreadRow,
} from '@core/threadTree';
import { fetchEventWithOutbox, setCachedEvent, getCachedEvent, clearEventCache } from '../lib/fetchEvent';

const THREAD_STALE_TIME = 2 * 60 * 1000;
const THREAD_GC_TIME = 10 * 60 * 1000;

// Max levels to walk up when reconstructing the ancestor chain above the target.
const MAX_ANCESTOR_HOPS = 24;

// Second-pass (author-outbox) discovery tuning.
// A cap on how many thread participants we re-query by outbox, and a chunk size
// kept *under* the pool's BULK_AUTHOR_THRESHOLD (10) so each chunk stays in the
// per-author outbox tier instead of collapsing to the narrow bulk tier.
const MAX_THREAD_AUTHORS = 48;
const OUTBOX_AUTHOR_CHUNK = 8;

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
      // Instant hit if the event is already cached (e.g. just seen in the feed).
      const cached = getCachedEvent(eventId);
      if (cached) return cached;
      const events = await nostr.query(
        [{ ids: [eventId], limit: 1 }],
        { signal: AbortSignal.timeout(5000) },
      );
      if (events[0]) {
        setCachedEvent(events[0].id, events[0]);
        return events[0];
      }
      const viaOutbox = await fetchEventWithOutbox(eventId, nostr);
      if (viaOutbox) return viaOutbox;
      // Not found this attempt. THROW (don't return null) so React Query retries
      // and the UI shows a loading/stuck indicator instead of a permanent
      // "No thread data found" empty state.
      throw new Error('Event not found');
    },
    enabled: !!eventId,
    staleTime: THREAD_STALE_TIME,
    gcTime: THREAD_GC_TIME,
    retry: 3,
    retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 4000),
  });

  // Fall back to the immediate reply parent (not just self) when a note carries
  // only a `reply` marker and no `root` marker — otherwise the thread would root
  // at the reply itself and never show the note being replied to.
  const rootId = useMemo(() => {
    if (!targetEvent) return null;
    const tags = parseThreadTags(targetEvent);
    return tags.root || tags.reply || targetEvent.id;
  }, [targetEvent]);

  // Reconstruct the ancestor chain above the target by walking parent refs
  // upward and fetching each one, so opening a deep reply shows the notes it
  // replied to — not just the reply and its descendants.
  const { data: ancestorEvents } = useQuery({
    queryKey: ['thread-ancestors', targetEvent?.id],
    queryFn: async () => {
      if (!targetEvent) return [] as NostrEvent[];
      const chain: NostrEvent[] = [];
      const seen = new Set<string>([targetEvent.id]);
      let current = targetEvent;
      for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
        const parentId = getParentId(current);
        if (!parentId || seen.has(parentId)) break;
        seen.add(parentId);
        const parent = getCachedEvent(parentId)
          ?? await fetchEventWithOutbox(parentId, nostr).catch(() => null);
        if (!parent) break;
        setCachedEvent(parent.id, parent);
        chain.push(parent);
        current = parent;
      }
      return chain;
    },
    enabled: !!targetEvent,
    staleTime: THREAD_STALE_TIME,
    gcTime: THREAD_GC_TIME,
    retry: 1,
  });

  const effectiveRootId = useMemo(() => {
    if (ancestorEvents && ancestorEvents.length > 0) {
      return ancestorEvents[ancestorEvents.length - 1].id;
    }
    return rootId;
  }, [ancestorEvents, rootId]);

  // Query 2 (pass 1): Fetch the thread by reference.
  // This #e-tag query has no `authors`, so the pool routes it via the wide-net
  // "reference" tier (user read relays + fallbacks). It catches replies that
  // were broadcast to common relays and renders immediately.
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
    retry: 2,
  });

  // Participants discovered in pass 1 — the pubkeys we can now route by outbox.
  // Sorted for a stable query key so this doesn't refetch on every render.
  const participantAuthors = useMemo(() => {
    const set = new Set<string>();
    for (const e of threadEvents ?? []) set.add(e.pubkey);
    if (targetEvent) set.add(targetEvent.pubkey);
    return Array.from(set).sort().slice(0, MAX_THREAD_AUTHORS);
  }, [threadEvents, targetEvent]);

  // Query 2 (pass 2): Author-outbox discovery.
  // An author-less #e query can't use the outbox model, so a reply written only
  // to its author's own relay is invisible to pass 1. Re-query the same thread
  // scoped to the participants we just found — adding `authors` lets the pool
  // route to each author's own relays. Chunked under BULK_AUTHOR_THRESHOLD so
  // each chunk stays in the per-author outbox tier. Runs after pass 1 so the UI
  // shows results first, then fills in.
  const { data: outboxEvents } = useQuery({
    queryKey: ['thread-outbox', rootId, participantAuthors],
    queryFn: async () => {
      if (!rootId || participantAuthors.length === 0) return [];
      const idsToQuery = rootId === eventId ? [rootId] : [rootId, eventId!];
      const chunks: string[][] = [];
      for (let i = 0; i < participantAuthors.length; i += OUTBOX_AUTHOR_CHUNK) {
        chunks.push(participantAuthors.slice(i, i + OUTBOX_AUTHOR_CHUNK));
      }
      const results = await Promise.all(
        chunks.map(chunk =>
          nostr.query(
            [{ kinds: [1, 7], '#e': idsToQuery, authors: chunk, limit: 500 }],
            { signal: AbortSignal.timeout(6000) },
          ).catch(() => [] as NostrEvent[]),
        ),
      );
      return results.flat();
    },
    enabled: !!rootId && !!targetEvent && participantAuthors.length > 0,
    staleTime: THREAD_STALE_TIME,
    gcTime: THREAD_GC_TIME,
    retry: 2,
  });

  const allEvents = useMemo(
    () => deduplicateEvents([
      ...(threadEvents ?? []),
      ...(outboxEvents ?? []),
      ...(ancestorEvents ?? []),
    ]),
    [threadEvents, outboxEvents, ancestorEvents],
  );

  // Try the true (highest) root first, then the tag root, then the target
  // itself — so we never show a blank thread when we do have the target, and we
  // show as much ancestry as we've fetched.
  const tree = useMemo(() => {
    if (allEvents.length === 0) return null;
    const candidates = [effectiveRootId, rootId, targetEvent?.id];
    const tried = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate || tried.has(candidate)) continue;
      tried.add(candidate);
      const t = buildThreadTree(allEvents, candidate, injectedReply);
      if (t) return t;
    }
    return null;
  }, [effectiveRootId, rootId, targetEvent?.id, allEvents, injectedReply]);

  const rows = useMemo(() => {
    if (!tree || !eventId) return [];
    return flattenTree(tree, eventId, collapsedIds);
  }, [tree, eventId, collapsedIds]);

  const refetch = useCallback(() => {
    setInjectedReply(null);
    // A manual refresh should hit the network fresh, not re-serve a stale/partial
    // cached result. Drop the cached target so query 1 re-runs outbox discovery,
    // and reset (not just invalidate) the tree/outbox passes so they refetch.
    if (eventId) {
      clearEventCache(eventId);
      queryClient.resetQueries({ queryKey: ['thread-target', eventId] });
      queryClient.resetQueries({ queryKey: ['thread-ancestors', eventId] });
    }
    if (rootId) {
      queryClient.resetQueries({ queryKey: ['thread-tree', rootId] });
      queryClient.resetQueries({ queryKey: ['thread-outbox', rootId] });
    }
  }, [eventId, rootId, queryClient]);

  const injectReply = useCallback((event: NostrEvent) => {
    setInjectedReply(event);
    setCachedEvent(event.id, event);
    // Merge into TanStack Query cache so reply persists across navigation
    if (rootId) {
      queryClient.setQueryData<NostrEvent[]>(
        ['thread-tree', rootId],
        // Dedup by id — a double-submit or a concurrent refetch can inject the
        // same reply twice, bloating the cache and miscounting allEvents.
        (old) => old?.some(e => e.id === event.id) ? old : [...(old ?? []), event],
      );
    }
  }, [rootId, queryClient]);

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
