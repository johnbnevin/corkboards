/**
 * useNotifications — fetches Nostr events that mention the logged-in user.
 *
 * Covers:
 *   - Kind 1  with #p tag → reply (has e-tag) or mention (no e-tag)
 *   - Kind 6  with #p tag → repost of user's note
 *   - Kind 7  with #p tag → reaction to user's note
 *   - Kind 9735 with #p tag → zap receipt
 *
 * Own events (pubkey === user.pubkey) are excluded.
 *
 * Mirrors the web version (packages/web/src/hooks/useNotifications.ts).
 */

import { useCallback, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';

export type NotificationType = 'reaction' | 'reply' | 'mention' | 'repost' | 'zap';

export interface NotificationItem {
  event: NostrEvent;
  type: NotificationType;
  /** The event ID this notification is about (target note), if applicable */
  targetEventId: string | null;
  /** Relay hint for fetching the target event */
  targetRelayHint: string | null;
  /** The pubkey of the note author (for outbox routing) */
  targetAuthorPubkey: string | null;
  /** For zaps: the real sender pubkey (from the zap request, not the LNURL server) */
  senderPubkey: string | null;
}

function classifyNotification(event: NostrEvent): NotificationType {
  if (event.kind === 6 || event.kind === 16) return 'repost';
  if (event.kind === 7) return 'reaction';
  if (event.kind === 9735) return 'zap';
  if (event.kind === 1) {
    const hasETag = event.tags.some(t => t[0] === 'e');
    return hasETag ? 'reply' : 'mention';
  }
  return 'mention';
}

function getTargetInfo(event: NostrEvent): {
  targetEventId: string | null;
  targetRelayHint: string | null;
  targetAuthorPubkey: string | null;
} {
  // For zap receipts, the bolt11 description JSON has the zapped event
  if (event.kind === 9735) {
    const eTag = event.tags.find(t => t[0] === 'e');
    const pTag = event.tags.find(t => t[0] === 'p');
    return {
      targetEventId: eTag?.[1] ?? null,
      targetRelayHint: eTag?.[2] ?? null,
      targetAuthorPubkey: pTag?.[1] ?? null,
    };
  }

  // For kind 1 (reply) and kind 6/16 (repost), find the root or parent e-tag
  if (event.kind === 1 || event.kind === 6 || event.kind === 16) {
    const eTags = event.tags.filter(t => t[0] === 'e');
    // NIP-10: prefer 'reply' marker, then 'root', then last e-tag
    const replyTag = eTags.find(t => t[3] === 'reply') ?? eTags.find(t => t[3] === 'root');
    const eTag = replyTag ?? eTags[eTags.length - 1] ?? null;
    const pTag = event.tags.find(t => t[0] === 'p');
    return {
      targetEventId: eTag?.[1] ?? null,
      targetRelayHint: eTag?.[2] ?? null,
      targetAuthorPubkey: pTag?.[1] ?? null,
    };
  }

  // For reactions (kind 7), the last e-tag is the reacted-to event
  if (event.kind === 7) {
    const eTags = event.tags.filter(t => t[0] === 'e');
    const eTag = eTags[eTags.length - 1] ?? null;
    const pTag = event.tags.find(t => t[0] === 'p');
    return {
      targetEventId: eTag?.[1] ?? null,
      targetRelayHint: eTag?.[2] ?? null,
      targetAuthorPubkey: pTag?.[1] ?? null,
    };
  }

  return { targetEventId: null, targetRelayHint: null, targetAuthorPubkey: null };
}

/** Extract the real sender pubkey from a zap receipt (kind 9735).
 *  The receipt's own pubkey belongs to the LNURL server, not the person who zapped.
 *  The real sender is in the `description` tag (the kind-9734 zap request JSON). */
export function getZapSenderPubkey(event: NostrEvent): string | null {
  if (event.kind !== 9735) return null;
  const descTag = event.tags.find(t => t[0] === 'description');
  if (descTag?.[1]) {
    try {
      const zapRequest = JSON.parse(descTag[1]) as { pubkey?: string };
      if (zapRequest.pubkey && typeof zapRequest.pubkey === 'string') return zapRequest.pubkey;
    } catch { /* ignore */ }
  }
  return null;
}

/** Extract sats from a zap receipt (kind 9735) */
export function getZapAmountSats(event: NostrEvent): number | null {
  if (event.kind !== 9735) return null;

  // Try direct amount tag (msats)
  const amountTag = event.tags.find(t => t[0] === 'amount');
  if (amountTag?.[1]) {
    const msats = parseInt(amountTag[1], 10);
    if (!isNaN(msats) && msats > 0) return Math.floor(msats / 1000);
  }

  // Try description tag (JSON of zap request kind 9734)
  const descTag = event.tags.find(t => t[0] === 'description');
  if (descTag?.[1]) {
    try {
      const zapRequest = JSON.parse(descTag[1]) as { tags?: string[][] };
      const zapAmountTag = zapRequest.tags?.find(t => t[0] === 'amount');
      if (zapAmountTag?.[1]) {
        const msats = parseInt(zapAmountTag[1], 10);
        if (!isNaN(msats) && msats > 0) return Math.floor(msats / 1000);
      }
    } catch {
      // ignore parse errors
    }
  }

  return null;
}

const NOTIF_PAGE_SIZE = 100;
const NOTIF_KINDS = [1, 6, 7, 16, 9735];

interface NotifPage {
  items: NotificationItem[];
  /** Cursor for the next (older) page: oldest raw created_at − 1, or null. */
  cursor: number | null;
  /** Raw event count from the relay (before own/dupe filtering) — drives hasMore. */
  rawCount: number;
}

export function useNotifications(enabled = true) {
  const { nostr } = useNostr();
  const { pubkey } = useAuth();

  // Incremental, cursor-based paging — the old approach inflated `limit` and
  // re-pulled the entire window on every "load more". Each page now fetches only
  // the next PAGE_SIZE older notifications via `until`. (Mirrors web.)
  const { data, isLoading, refetch, fetchNextPage, hasNextPage } = useInfiniteQuery({
    queryKey: ['notifications', pubkey],
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }): Promise<NotifPage> => {
      if (!pubkey) return { items: [], cursor: null, rawCount: 0 };

      const events = await nostr.query(
        [{
          kinds: NOTIF_KINDS,
          '#p': [pubkey],
          limit: NOTIF_PAGE_SIZE,
          ...(pageParam ? { until: pageParam } : {}),
        }],
        { signal: AbortSignal.timeout(12000) },
      );

      let oldest = Infinity;
      const seen = new Set<string>();
      const items = events
        .filter(e => {
          if (e.created_at < oldest) oldest = e.created_at;
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return e.pubkey !== pubkey; // exclude own events
        })
        .sort((a, b) => b.created_at - a.created_at)
        .map((event): NotificationItem => ({
          event,
          type: classifyNotification(event),
          ...getTargetInfo(event),
          senderPubkey: event.kind === 9735 ? getZapSenderPubkey(event) : null,
        }));

      return { items, cursor: oldest === Infinity ? null : oldest - 1, rawCount: events.length };
    },
    getNextPageParam: (last) =>
      last.rawCount >= NOTIF_PAGE_SIZE && last.cursor !== null ? last.cursor : undefined,
    enabled: enabled && !!pubkey,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    // Match the feed's resilience so a single slow-relay timeout doesn't leave
    // notifications stuck empty: retry on failure/abort, and refetch on reconnect.
    retry: 2,
    retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 10_000),
    refetchOnReconnect: true,
  });

  const notifications = useMemo(() => {
    const seen = new Set<string>();
    const out: NotificationItem[] = [];
    for (const page of data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.event.id)) continue;
        seen.add(item.event.id);
        out.push(item);
      }
    }
    return out.sort((a, b) => b.event.created_at - a.event.created_at);
  }, [data]);

  const loadMore = useCallback(() => { fetchNextPage(); }, [fetchNextPage]);
  const loadNewer = useCallback(() => { refetch(); }, [refetch]);

  return {
    notifications,
    isLoading,
    refetch,
    loadMore,
    loadNewer,
    hasMore: !!hasNextPage,
    newestTimestamp: notifications.length > 0 ? notifications[0].event.created_at : null,
  };
}
