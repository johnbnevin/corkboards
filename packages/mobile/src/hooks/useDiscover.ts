/**
 * useDiscover — Discovery feed with engagement ranking.
 *
 * Port of packages/web/src/hooks/useDiscover.ts for mobile.
 * Uses mobile's AuthContext + NostrProvider.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { type NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';

interface DiscoverState {
  notes: NostrEvent[];
  allRanked: NostrEvent[];
  isLoading: boolean;
  lastUpdated: number | null;
  engagementMap: Map<string, { type: 'reply' | 'repost' | 'quote'; by: string }[]>;
  shownCount: number;
}

const discoverCache: Map<string, DiscoverState> = new Map();

export function useDiscover(follows: string[] | undefined, enabled: boolean = true) {
  const { pubkey: userPubkey } = useAuth();
  const { nostr } = useNostr();
  const [state, setState] = useState<DiscoverState>({
    notes: [],
    allRanked: [],
    isLoading: false,
    lastUpdated: null,
    engagementMap: new Map(),
    shownCount: 100,
  });
  const isRunningRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const shouldRun = enabled && userPubkey && follows && follows.length > 0;

  const runDiscovery = useCallback(async () => {
    if (!shouldRun || !follows || isRunningRef.current) return;

    const cacheKey = userPubkey!;
    const cached = discoverCache.get(cacheKey);
    if (cached && cached.lastUpdated && Date.now() - cached.lastUpdated < 5 * 60 * 1000) {
      setState(cached);
      return;
    }

    isRunningRef.current = true;
    setState(prev => ({ ...prev, isLoading: true }));

    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    try {
      const followSet = new Set(follows);
      const engagementMap = new Map<string, { type: 'reply' | 'repost' | 'quote'; by: string }[]>();
      const originalNoteIds = new Set<string>();
      const seenNotes = new Map<string, NostrEvent>();

      const processEngagement = (event: NostrEvent) => {
        if (event.pubkey === userPubkey) return;
        const eTags = event.tags.filter(t => t[0] === 'e');
        const qTags = event.tags.filter(t => t[0] === 'q');

        for (const qTag of qTags) {
          const quotedId = qTag[1];
          if (quotedId) {
            originalNoteIds.add(quotedId);
            const existing = engagementMap.get(quotedId) || [];
            existing.push({ type: 'quote', by: event.pubkey });
            engagementMap.set(quotedId, existing);
          }
        }

        if (eTags.length > 0) {
          const replyTag = eTags.find(t => t[3] === 'reply') || eTags[eTags.length - 1];
          const parentId = replyTag[1];
          if (parentId) {
            originalNoteIds.add(parentId);
            const existing = engagementMap.get(parentId) || [];
            existing.push({ type: 'reply', by: event.pubkey });
            engagementMap.set(parentId, existing);
          }
        }
      };

      const processRepost = (event: NostrEvent) => {
        if (event.pubkey === userPubkey) return;
        const eTag = event.tags.find(t => t[0] === 'e');
        if (eTag?.[1]) {
          const repostedId = eTag[1];
          originalNoteIds.add(repostedId);
          const existing = engagementMap.get(repostedId) || [];
          existing.push({ type: 'repost', by: event.pubkey });
          engagementMap.set(repostedId, existing);
        }
      };

      const updateState = (notes: NostrEvent[], loading: boolean) => {
        const ranked = notes
          .filter(note => note.pubkey !== userPubkey)
          .filter(note => !followSet.has(note.pubkey))
          .filter(note => note.kind === 1 || note.kind === 30023)
          .sort((a, b) => {
            const aEngagements = engagementMap.get(a.id)?.length || 0;
            const bEngagements = engagementMap.get(b.id)?.length || 0;
            if (bEngagements !== aEngagements) return bEngagements - aEngagements;
            return b.created_at - a.created_at;
          });

        const authorSeen = new Set<string>();
        const onePerAuthor: NostrEvent[] = [];
        for (const note of ranked) {
          if (!authorSeen.has(note.pubkey)) {
            onePerAuthor.push(note);
            authorSeen.add(note.pubkey);
          }
        }

        setState(prev => ({
          notes: onePerAuthor.slice(0, prev.shownCount),
          allRanked: onePerAuthor,
          isLoading: loading,
          lastUpdated: loading ? null : Date.now(),
          engagementMap,
          shownCount: prev.shownCount,
        }));
      };

      // PHASE 1: Quick first batch
      const quickFriends = follows.slice(0, 30);
      const quickEngagements = await nostr.query([{
        kinds: [1, 6],
        authors: quickFriends,
        limit: 75
      }], { signal: AbortSignal.timeout(2000) }).catch((): NostrEvent[] => []);

      if (signal.aborted) return;

      const quickReplies = quickEngagements.filter(e => e.kind === 1);
      const quickReposts = quickEngagements.filter(e => e.kind === 6);
      quickReplies.forEach(processEngagement);
      quickReposts.forEach(processRepost);

      const quickNoteIds = Array.from(originalNoteIds).slice(0, 20);
      if (quickNoteIds.length > 0) {
        const quickNotes = await nostr.query([{ ids: quickNoteIds }], {
          signal: AbortSignal.timeout(2000)
        }).catch((): NostrEvent[] => []);

        quickNotes.forEach(note => seenNotes.set(note.id, note));
        if (seenNotes.size > 0) {
          updateState(Array.from(seenNotes.values()), true);
        }
      }

      if (signal.aborted) return;

      // PHASE 2: More in background
      const remainingFriends = follows.slice(30, 200);
      if (remainingFriends.length > 0) {
        const batchSize = 50;
        const batches: string[][] = [];
        for (let i = 0; i < remainingFriends.length; i += batchSize) {
          batches.push(remainingFriends.slice(i, i + batchSize));
        }

        const batchResults = await Promise.all(batches.map(async (batch) => {
          const engagements = await nostr.query([{
            kinds: [1, 6],
            authors: batch,
            limit: 150
          }], { signal: AbortSignal.timeout(4000) }).catch((): NostrEvent[] => []);
          return {
            replies: engagements.filter(e => e.kind === 1),
            reposts: engagements.filter(e => e.kind === 6),
          };
        }));

        if (signal.aborted) return;

        for (const { replies, reposts } of batchResults) {
          replies.forEach(processEngagement);
          reposts.forEach(processRepost);
        }

        const allNoteIds = Array.from(originalNoteIds)
          .filter(id => !seenNotes.has(id))
          .slice(0, 150);

        if (allNoteIds.length > 0) {
          const noteBatches: string[][] = [];
          for (let i = 0; i < allNoteIds.length; i += 50) {
            noteBatches.push(allNoteIds.slice(i, i + 50));
          }

          const noteResults = await Promise.all(noteBatches.map(batch =>
            nostr.query([{ ids: batch }], {
              signal: AbortSignal.timeout(4000)
            }).catch((): NostrEvent[] => [])
          ));

          if (signal.aborted) return;

          for (const notes of noteResults) {
            notes.forEach(note => seenNotes.set(note.id, note));
          }
        }
      }

      if (signal.aborted) return;

      const finalNotes = Array.from(seenNotes.values());
      updateState(finalNotes, false);

      setState(prev => {
        discoverCache.set(cacheKey, { ...prev, isLoading: false, lastUpdated: Date.now() });
        return prev;
      });

    } catch (err) {
      console.error('Discovery error:', err);
      setState(prev => ({ ...prev, isLoading: false }));
    } finally {
      isRunningRef.current = false;
    }
  }, [shouldRun, follows, userPubkey, nostr]);

  useEffect(() => {
    if (!shouldRun) return;

    const timer = setTimeout(() => {
      runDiscovery();
    }, 500);

    return () => {
      clearTimeout(timer);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [shouldRun, runDiscovery]);

  const refresh = useCallback(() => {
    if (userPubkey) {
      discoverCache.delete(userPubkey);
    }
    setState(prev => ({ ...prev, shownCount: 100 }));
    runDiscovery();
  }, [userPubkey, runDiscovery]);

  const loadMore = useCallback(() => {
    setState(prev => {
      const newCount = prev.shownCount + 100;
      return {
        ...prev,
        shownCount: newCount,
        notes: prev.allRanked.slice(0, newCount),
      };
    });
  }, []);

  const hasMoreDiscover = state.allRanked.length > state.notes.length;

  return {
    discoveredNotes: state.notes,
    isLoading: state.isLoading,
    lastUpdated: state.lastUpdated,
    engagementMap: state.engagementMap,
    refresh,
    loadMore,
    hasMoreDiscover,
    totalDiscoverCount: state.allRanked.length,
  };
}
