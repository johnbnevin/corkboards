/**
 * NIP-30 Custom Emoji Sets (kind 30030).
 *
 * Fetches the user's own emoji sets, any sets referenced in their
 * kind 10030 (emoji favorites) list, and a default set for new users.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@/hooks/useNostr';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { DEFAULT_EMOJI_SET_ADDR } from '@/components/EmojiSetEditor';
import {
  CORKBOARDS_DEFAULT_EMOJIS,
  CORKBOARDS_DEFAULT_SET_NAME,
  CORKBOARDS_DEFAULT_SET_DTAG,
} from '@core/defaultEmojiSet';

export interface CustomEmoji {
  shortcode: string;
  url: string;
}

export interface EmojiSet {
  name: string;
  dTag: string;
  emojis: CustomEmoji[];
  /** Creator's pubkey — 'built-in' for the hardcoded default set */
  pubkey: string;
}

export function useCustomEmojiSets() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser(false);

  // Fetch user's own emoji sets (kind 30030) + emoji favorites list (kind 10030)
  const { data: rawEvents, isLoading } = useQuery({
    queryKey: ['custom-emoji-sets', user?.pubkey],
    queryFn: async ({ signal }) => {
      if (!user?.pubkey) return { sets: [], favorites: null };
      const [sets, favs] = await Promise.all([
        nostr.query(
          [{ kinds: [30030], authors: [user.pubkey] }],
          { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
        ),
        nostr.query(
          [{ kinds: [10030], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
        ),
      ]);
      return { sets, favorites: favs[0] ?? null };
    },
    enabled: !!user?.pubkey,
    staleTime: 5 * 60_000,
  });

  // Collect followed set addresses from kind 10030 + default set
  const followedSetAddresses = useMemo(() => {
    const addrs: string[] = [];
    if (rawEvents?.favorites) {
      for (const t of rawEvents.favorites.tags) {
        if (t[0] === 'a' && t[1]?.startsWith('30030:')) addrs.push(t[1]);
      }
    }
    // Include the default set if configured and user has no own sets
    if (DEFAULT_EMOJI_SET_ADDR && (rawEvents?.sets ?? []).length === 0) {
      if (!addrs.includes(DEFAULT_EMOJI_SET_ADDR)) {
        addrs.push(DEFAULT_EMOJI_SET_ADDR);
      }
    }
    return addrs;
  }, [rawEvents]);

  const { data: followedSets } = useQuery({
    queryKey: ['followed-emoji-sets', followedSetAddresses],
    queryFn: async ({ signal }) => {
      if (followedSetAddresses.length === 0) return [];
      // Parse addresses into filters
      const filters = followedSetAddresses.map(addr => {
        const [, pubkey, dTag] = addr.split(':');
        return { kinds: [30030 as number], authors: [pubkey], '#d': [dTag] };
      });
      return nostr.query(filters, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
    },
    enabled: followedSetAddresses.length > 0,
    staleTime: 5 * 60_000,
  });

  const sets = useMemo<EmojiSet[]>(() => {
    const allEvents = [...(rawEvents?.sets ?? []), ...(followedSets ?? [])];

    // Deduplicate by d-tag + author
    const byKey = new Map<string, typeof allEvents[0]>();
    for (const ev of allEvents) {
      const dTag = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
      const key = `${ev.pubkey}:${dTag}`;
      const existing = byKey.get(key);
      if (!existing || ev.created_at > existing.created_at) {
        byKey.set(key, ev);
      }
    }

    const userSets = Array.from(byKey.values())
      .map(ev => {
        const dTag = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
        const title = ev.tags.find(t => t[0] === 'title')?.[1];
        const emojis = ev.tags
          .filter(t => t[0] === 'emoji' && t[1] && t[2])
          .map(t => ({ shortcode: t[1], url: t[2] }));
        return { name: title || dTag || 'Custom', dTag, emojis, pubkey: ev.pubkey };
      })
      .filter(s => s.emojis.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    // Hardcoded default always first
    const builtIn: EmojiSet = {
      name: CORKBOARDS_DEFAULT_SET_NAME,
      dTag: CORKBOARDS_DEFAULT_SET_DTAG,
      emojis: CORKBOARDS_DEFAULT_EMOJIS,
      pubkey: 'built-in',
    };

    return [builtIn, ...userSets];
  }, [rawEvents?.sets, followedSets]);

  return { sets, isLoading };
}
