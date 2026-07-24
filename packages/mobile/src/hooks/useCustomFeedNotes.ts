/**
 * useCustomFeedNotes — notes for a custom corkboard with caching and filtering.
 * Mobile port of packages/web/src/hooks/useCustomFeedNotes.ts.
 *
 * Two-tier architecture:
 *  - MMKV is the persistent store (replaces web's IndexedDB)
 *  - React Query holds the current in-memory view
 *
 * On mount: seeds React Query from MMKV cache (instant, no relay).
 * Background: fetches fresh notes from relays and merges into both stores.
 * loadMore: fetches older notes, merges into both stores.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import { batchFetchByAuthors } from './useCustomFeed';
import {
  mergeCustomFeedNotes,
  getCustomFeedNotesFromMemory,
  isCustomFeedCacheLoaded,
} from './useCustomFeedNotesCache';
import { FEED_KINDS } from '@core/feedConstants';
import { hashtagFeedVerdict } from '@core/noteCategories';
import { dedupBatch, initialUntilCursor, PAGINATION_MAX_ITERATIONS } from '@core/paginationCore';
import { fetchRssFeed, rssItemsToEvents, rssItemId } from '../lib/feedUtils';
import { useEffect, useRef, useCallback, useMemo } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';

export interface CustomFeedDef {
  id: string;
  pubkeys: string[];
  relays: string[];
  rssUrls: string[];
  hashtags?: string[];
}

export interface UseCustomFeedNotesOptions {
  feed: CustomFeedDef | null;
  isActive: boolean;
  limit: number;
  multiplier: number;
  onProgress?: (loaded: number, total: number) => void;
  /** Outbox pass: discover the authors' NIP-65 relays before fetching notes. */
  ensureRelays?: (pubkeys: string[]) => Promise<unknown>;
}

export interface UseCustomFeedNotesResult {
  notes: NostrEvent[];
  isLoading: boolean;
  isLookingFurther: boolean;
  hasMore: boolean;
  loadMore: (hours: number) => Promise<number>;
  addNotes: (events: NostrEvent[]) => void;
  refresh: () => void;
  hoursLoaded: number;
}

export function useCustomFeedNotes({
  feed,
  isActive,
  limit,
  multiplier,
  onProgress,
  ensureRelays,
}: UseCustomFeedNotesOptions): UseCustomFeedNotesResult {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const hoursLoadedRef = useRef(0);
  const hasSeededRef = useRef(false);

  // Normalized hashtag list (lowercase, no leading #). A corkboard can be
  // driven by any combination of authors, hashtags, relays, and RSS urls —
  // parity with web (MultiColumnClient corkboardNotes sources).
  const hashtags = useMemo(
    () => (feed?.hashtags ?? []).map(t => t.replace(/^#/, '').toLowerCase()).filter(Boolean),
    [feed?.hashtags],
  );
  const hasAnySource = !!feed && (
    feed.pubkeys.length > 0 ||
    hashtags.length > 0 ||
    feed.relays.length > 0 ||
    feed.rssUrls.length > 0
  );

  // Small corkboards look back far further (sparse posters); larger feeds stay
  // tight. Keep in sync with web useCustomFeedNotesCache.
  const baseWindowSeconds = (() => {
    const n = feed?.pubkeys.length ?? 0;
    if (n <= 25) return 3600 * 24 * 3; // ≤25 authors → 3 days
    if (n <= 100) return 3600 * 12;    // ≤100 → 12h
    return 3600;                        // 1h
  })();

  // Stable query key: feed id + source signature (sources changing = new feed)
  const queryKey = useMemo(
    () => [
      'custom-feed-notes',
      feed?.id ?? '',
      feed?.pubkeys?.join(',') ?? '',
      hashtags.join(','),
      feed?.relays?.join(',') ?? '',
      feed?.rssUrls?.join(',') ?? '',
    ] as const,
    [feed?.id, feed?.pubkeys, hashtags, feed?.relays, feed?.rssUrls],
  );

  // Seed React Query from MMKV cache instantly on first render
  useEffect(() => {
    if (!feed || !hasAnySource) return;
    if (hasSeededRef.current) return;
    if (!isCustomFeedCacheLoaded()) return;

    // Only restrict cached notes to the author set for pure author-driven
    // corkboards; hashtag/relay-sourced notes come from arbitrary pubkeys.
    const authorOnly = feed.pubkeys.length > 0 && hashtags.length === 0 && feed.relays.length === 0;
    const pubkeySet = new Set(feed.pubkeys);
    const cached = authorOnly
      ? getCustomFeedNotesFromMemory(feed.id).filter(e => pubkeySet.has(e.pubkey))
      : getCustomFeedNotesFromMemory(feed.id);
    if (cached.length > 0) {
      if (__DEV__) console.log('[customFeedNotes] Seeding', cached.length, 'notes from MMKV for', feed.id);
      queryClient.setQueryData(queryKey, cached);
    }
    hasSeededRef.current = true;
  // Only run once per feed, after cache is loaded
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed?.id, feed?.pubkeys?.join(','), hashtags.join(',')]);

  // Reset seed flag when feed changes
  useEffect(() => {
    hasSeededRef.current = false;
    hoursLoadedRef.current = 0;
  }, [feed?.id]);

  // Background fetch from relay — merges into MMKV + React Query.
  // Queries every configured source (authors, hashtags, custom relays) and
  // always runs the RSS pass, so hashtag-/relay-/RSS-only corkboards and mixed
  // corkboards with zero relay events all populate. Parity with web
  // (MultiColumnClient hashtag query + custom-feed-rss + useCustomFeed relays).
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      if (!feed || !hasAnySource) return [];

      const timeWindowSeconds = baseWindowSeconds * multiplier;
      const now = Math.floor(Date.now() / 1000);
      const since = now - timeWindowSeconds;

      if (__DEV__) console.log('[customFeedNotes] Fetching from relay, window:', timeWindowSeconds / 3600, 'hr');

      const nostrEvents: NostrEvent[] = [];
      const seen = new Set<string>();
      const addEvents = (events: NostrEvent[]) => {
        for (const e of events) {
          if (!seen.has(e.id)) { seen.add(e.id); nostrEvents.push(e); }
        }
      };

      // 1. Author notes
      if (feed.pubkeys.length > 0) {
        // Outbox pass: discover the authors' own write relays before fetching.
        if (ensureRelays) {
          try { await ensureRelays(feed.pubkeys); } catch { /* best-effort */ }
        }

        let events = await batchFetchByAuthors({
          nostr,
          authors: feed.pubkeys,
          limit,
          since,
          onProgress: onProgress ?? (() => {}),
        });

        if (__DEV__) console.log('[customFeedNotes] Got', events.length, 'author events from relay');

        // If nothing in time window, find most recent note and fetch around it.
        // Skip this when we already have cached notes for these authors: an empty
        // window on resume usually means cold relays after idle, and pulling a
        // stale most-recent-per-author set on top of a good cached feed would
        // show old, partial results (mobile analog of the web idle-resume bug).
        const cachedForFeed = (queryClient.getQueryData(queryKey) as NostrEvent[] | undefined) ?? [];
        const hasCachedAuthorNotes = cachedForFeed.some(e => feed.pubkeys.includes(e.pubkey));
        if (events.length === 0 && !hasCachedAuthorNotes) {
          if (__DEV__) console.log('[customFeedNotes] No events in window, searching for most recent');
          const kinds = [...FEED_KINDS] as number[];
          const recent = await nostr.query([{
            kinds,
            authors: feed.pubkeys,
            limit: 1,
          }], { signal: AbortSignal.timeout(10000) }).catch(() => [] as NostrEvent[]);

          if (recent.length > 0) {
            const anchor = recent[0].created_at;
            const olderEvents = await batchFetchByAuthors({
              nostr,
              authors: feed.pubkeys,
              limit,
              since: anchor - timeWindowSeconds,
              until: anchor,
              onProgress: onProgress ?? (() => {}),
            });
            events = olderEvents.length > 0 ? olderEvents : recent;
          }
        }
        addEvents(events);
      }

      // 2. Hashtag notes (#t filter). Wide window (7 days × multiplier),
      // limit-capped — same rationale as web: hashtag notes should appear on
      // first load regardless of the (narrow) author window.
      if (hashtags.length > 0) {
        const kinds = [...FEED_KINDS].filter(k => k !== 5) as number[];
        const htEvents = await nostr.query([{
          kinds,
          '#t': hashtags,
          limit,
          since: now - 3600 * 24 * 7 * multiplier,
        }], { signal: AbortSignal.timeout(15000) }).catch(() => [] as NostrEvent[]);
        // Drop tag-stuffing spam (see hashtagFeedVerdict / NIP-24): notes tagged
        // with this topic but not mentioning it inline while carrying many
        // unrelated topic tags. Keep genuine + lightly-tagged matches.
        const htClean = htEvents.filter(note => hashtags.some(tag => hashtagFeedVerdict(note, tag) !== 'spam'));
        if (__DEV__) console.log('[customFeedNotes] Got', htEvents.length, 'hashtag events,', htClean.length, 'after spam filter');
        addEvents(htClean);
      }

      // 3. Custom relays — query each configured relay directly (per-relay,
      // like web's relay-group query in useCustomFeed).
      if (feed.relays.length > 0 && nostrEvents.length < limit) {
        const kinds = [...FEED_KINDS] as number[];
        const relayFilter = feed.pubkeys.length > 0
          ? { kinds, authors: feed.pubkeys, limit }
          : { kinds, limit };
        const relayResults = await Promise.allSettled(
          feed.relays.map(url => {
            try {
              return nostr.relay(url).query([relayFilter], { signal: AbortSignal.timeout(8000) });
            } catch {
              return Promise.resolve([] as NostrEvent[]);
            }
          }),
        );
        for (const result of relayResults) {
          if (result.status === 'fulfilled') addEvents(result.value as NostrEvent[]);
        }
      }

      // Merge fresh nostr events into MMKV cache
      if (nostrEvents.length > 0) {
        await mergeCustomFeedNotes(feed.id, nostrEvents);
      }
      hoursLoadedRef.current = multiplier;

      // 4. RSS feeds — always fetched, independent of the relay results, so an
      // RSS-only corkboard (or a mixed one whose relay pass returned nothing)
      // still shows its items.
      const rssEvents: NostrEvent[] = [];
      if (feed.rssUrls && feed.rssUrls.length > 0) {
        for (const feedUrl of feed.rssUrls) {
          try {
            const rssFeed = await fetchRssFeed(feedUrl, 20);
            if (!rssFeed) continue;
            for (const item of rssFeed.items) {
              const id = rssItemId(item.link || item.title, feedUrl);
              if (!seen.has(id)) {
                seen.add(id);
                rssEvents.push(...rssItemsToEvents([item], rssFeed.title, rssFeed.icon, feedUrl));
              }
            }
          } catch (err) {
            if (__DEV__) console.warn('[customFeedNotes] RSS failed for', feedUrl, err instanceof Error ? err.message : err);
          }
        }
      }

      // Merge with any existing cached data already in React Query
      const existing = (queryClient.getQueryData(queryKey) as NostrEvent[] | undefined) ?? [];
      const existingIds = new Set(existing.map(e => e.id));
      const fresh = [...nostrEvents, ...rssEvents].filter(e => !existingIds.has(e.id));
      return [...existing, ...fresh].sort((a, b) => b.created_at - a.created_at);
    },
    enabled: isActive && hasAnySource,
    staleTime: 5 * 60 * 1000,
  });

  // Combined windowed fetch across the feed's nostr sources (authors +
  // hashtags + custom relays) — used by loadMore and gap-fill so non-author
  // corkboards paginate too. RSS has no time cursor, so it isn't part of this.
  const fetchCombinedWindow = useCallback(async (opts: { since: number; until?: number; limit: number }): Promise<NostrEvent[]> => {
    if (!feed) return [];
    const out: NostrEvent[] = [];
    const seen = new Set<string>();
    const add = (events: NostrEvent[]) => {
      for (const e of events) {
        if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
      }
    };

    if (feed.pubkeys.length > 0) {
      const raw = await batchFetchByAuthors({
        nostr,
        authors: feed.pubkeys,
        limit: opts.limit,
        since: opts.since,
        until: opts.until,
        onProgress: onProgress ?? (() => {}),
      }).catch(() => [] as NostrEvent[]);
      add(raw);
    }

    if (hashtags.length > 0) {
      const kinds = [...FEED_KINDS].filter(k => k !== 5) as number[];
      const raw = await nostr.query([{
        kinds,
        '#t': hashtags,
        limit: opts.limit,
        since: opts.since,
        ...(opts.until !== undefined ? { until: opts.until } : {}),
      }], { signal: AbortSignal.timeout(15000) }).catch(() => [] as NostrEvent[]);
      // Same tag-stuffing spam filter as the initial load (see hashtagFeedVerdict).
      add(raw.filter(note => hashtags.some(tag => hashtagFeedVerdict(note, tag) !== 'spam')));
    }

    if (feed.relays.length > 0) {
      const kinds = [...FEED_KINDS] as number[];
      const relayFilter = {
        kinds,
        limit: opts.limit,
        since: opts.since,
        ...(opts.until !== undefined ? { until: opts.until } : {}),
        ...(feed.pubkeys.length > 0 ? { authors: feed.pubkeys } : {}),
      };
      const relayResults = await Promise.allSettled(
        feed.relays.map(url => {
          try {
            return nostr.relay(url).query([relayFilter], { signal: AbortSignal.timeout(8000) });
          } catch {
            return Promise.resolve([] as NostrEvent[]);
          }
        }),
      );
      for (const result of relayResults) {
        if (result.status === 'fulfilled') add(result.value as NostrEvent[]);
      }
    }

    return out.sort((a, b) => b.created_at - a.created_at);
  }, [feed, hashtags, nostr, onProgress]);

  // loadMore — fetches older notes, saves to MMKV + React Query
  const loadMore = useCallback(async (hours: number): Promise<number> => {
    if (!feed || !hasAnySource) return 0;

    hoursLoadedRef.current += hours;

    const existing = (queryClient.getQueryData(queryKey) as NostrEvent[] | undefined) ?? [];
    const existingIds = new Set(existing.map(e => e.id));

    // Iteratively accumulate ~one page of NEW notes, walking the `until` cursor
    // back CONTIGUOUSLY (via dedupBatch's oldestReturned) so we cross gaps without
    // skipping and actually load a full page — not just "a few more". Parity with
    // web loadMoreByCount. `since:0` lets each query cross an empty stretch to the
    // next real notes; the cursor advance keeps successive pages contiguous.
    const target = limit;
    const allNew: NostrEvent[] = [];
    let untilCursor = initialUntilCursor(existing);

    for (let iter = 0; iter < PAGINATION_MAX_ITERATIONS && allNew.length < target; iter++) {
      const raw = await fetchCombinedWindow({
        since: 0,
        until: untilCursor,
        limit: target,
      });
      if (raw.length === 0) break;
      const { trulyNew, oldestReturned } = dedupBatch(raw, existingIds);
      if (oldestReturned >= untilCursor) break; // no cursor progress — stop
      untilCursor = oldestReturned - 1;
      for (const n of trulyNew) { existingIds.add(n.id); allNew.push(n); }
    }

    if (__DEV__) console.log('[customFeedNotes] loadMore accumulated', allNew.length, 'new notes');

    if (allNew.length > 0) {
      await mergeCustomFeedNotes(feed.id, allNew);
      queryClient.setQueryData(queryKey, (prev: NostrEvent[] | undefined) => {
        const prevEvents = prev ?? [];
        const seen = new Set(prevEvents.map(e => e.id));
        const freshEvents = allNew.filter(e => !seen.has(e.id));
        return [...prevEvents, ...freshEvents].sort((a, b) => b.created_at - a.created_at);
      });
    }

    // Second pass: bounded gap-fill. Scan the timeline for gaps > 30 min and
    // backfill the biggest few (≤3), each capped at one page (`limit`) of the
    // newest notes in the gap — so a 6-hour gap fills but a huge one won't load
    // thousands. Parity with web fillGaps.
    const timeline = ((queryClient.getQueryData(queryKey) as NostrEvent[] | undefined) ?? [])
      .slice().sort((a, b) => b.created_at - a.created_at);
    const GAP_FILL_THRESHOLD_SECONDS = 30 * 60;
    const MAX_GAPS_PER_FILL = 3;
    const gaps: { since: number; until: number; span: number }[] = [];
    for (let i = 0; i < timeline.length - 1; i++) {
      const span = timeline[i].created_at - timeline[i + 1].created_at;
      if (span > GAP_FILL_THRESHOLD_SECONDS) {
        gaps.push({ since: timeline[i + 1].created_at + 1, until: timeline[i].created_at - 1, span });
      }
    }
    gaps.sort((a, b) => b.span - a.span);
    const seenIds = new Set(timeline.map(e => e.id));
    const filled: NostrEvent[] = [];
    for (const g of gaps.slice(0, MAX_GAPS_PER_FILL)) {
      const raw = await fetchCombinedWindow({ since: g.since, until: g.until, limit })
        .catch(() => [] as NostrEvent[]);
      for (const e of raw) if (!seenIds.has(e.id)) { seenIds.add(e.id); filled.push(e); }
    }
    if (filled.length > 0) {
      await mergeCustomFeedNotes(feed.id, filled);
      queryClient.setQueryData(queryKey, (prev: NostrEvent[] | undefined) => {
        const prevEvents = prev ?? [];
        const seen = new Set(prevEvents.map(e => e.id));
        const fresh = filled.filter(e => !seen.has(e.id));
        return [...prevEvents, ...fresh].sort((a, b) => b.created_at - a.created_at);
      });
      if (__DEV__) console.log('[customFeedNotes] gap-fill added', filled.length);
    }

    return allNew.length + filled.length;
  }, [feed, hasAnySource, queryKey, queryClient, limit, fetchCombinedWindow]);

  // addNotes — external merge (e.g. from loadMoreByCount)
  const addNotes = useCallback((newEvents: NostrEvent[]) => {
    if (newEvents.length === 0 || !feed) return;
    mergeCustomFeedNotes(feed.id, newEvents).catch(err =>
      console.warn('[customFeedNotes] mergeCustomFeedNotes error:', err)
    );
    queryClient.setQueryData(queryKey, (prev: NostrEvent[] | undefined) => {
      const existing = prev ?? [];
      const existingIds = new Set(existing.map(e => e.id));
      const fresh = newEvents.filter(e => !existingIds.has(e.id));
      if (fresh.length === 0) return existing;
      return [...existing, ...fresh].sort((a, b) => b.created_at - a.created_at);
    });
  }, [feed, queryKey, queryClient]);

  // refresh — re-run the relay query
  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const notes = (query.data ?? []) as NostrEvent[];

  return {
    notes,
    isLoading: query.isLoading && notes.length === 0,
    isLookingFurther: false,
    hasMore: true,
    loadMore,
    addNotes,
    refresh,
    // Same per-tab Map pattern as useFeedPagination — reading the ref at return
    // time is deliberate, see useFeedPagination's design comment.
    // eslint-disable-next-line react-hooks/refs
    hoursLoaded: hoursLoadedRef.current,
  };
}
