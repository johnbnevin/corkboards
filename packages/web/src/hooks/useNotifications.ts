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
 */

import { useState, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@/hooks/useNostr';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import type { NostrEvent } from '@nostrify/nostrify';

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

  // For kind 1 (reply), kind 6 (repost), and kind 16 (generic repost), find the root or parent e-tag
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

export function useNotifications(enabled: boolean) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const limitRef = useRef(100);
  const [, forceUpdate] = useState(0);
  // Track the newest notification timestamp so StatusBar can show "Newer" button
  const newestTimestampRef = useRef<number | null>(null);
  const [newestTimestamp, setNewestTimestamp] = useState<number | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['notifications', user?.pubkey],
    queryFn: async () => {
      if (!user?.pubkey) return [];

      const events = await nostr.query(
        [{ kinds: [1, 6, 7, 16, 9735], '#p': [user.pubkey], limit: limitRef.current }],
        { signal: AbortSignal.timeout(12000) },
      );

      const seen = new Set<string>();
      const items = events
        .filter(e => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return e.pubkey !== user.pubkey; // exclude own events
        })
        .sort((a, b) => b.created_at - a.created_at)
        .map((event): NotificationItem => ({
          event,
          type: classifyNotification(event),
          ...getTargetInfo(event),
          senderPubkey: event.kind === 9735 ? getZapSenderPubkey(event) : null,
        }));

      // Track the newest timestamp for "Newer" button
      if (items.length > 0) {
        const newest = items[0].event.created_at;
        newestTimestampRef.current = newest;
        setNewestTimestamp(newest);
      }

      return items;
    },
    enabled: enabled && !!user?.pubkey,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  const loadMore = useCallback((count = 100) => {
    limitRef.current += count;
    // Refetch with the new limit — existing data stays visible (same queryKey)
    refetch();
    forceUpdate(n => n + 1);
  }, [refetch]);

  // Load newer notifications since the newest one we have
  const loadNewer = useCallback(() => {
    // Simply refetch — the query fetches the newest N notifications,
    // so any newer ones since last fetch will be included.
    refetch();
  }, [refetch]);

  return {
    notifications: data ?? [],
    isLoading,
    refetch,
    loadMore,
    loadNewer,
    hasMore: (data?.length ?? 0) >= limitRef.current,
    newestTimestamp,
  };
}
