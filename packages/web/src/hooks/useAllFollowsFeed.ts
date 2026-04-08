import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@/hooks/useNostr';
import { batchFetchByAuthors } from '@/lib/feedUtils';
import type { NostrEvent } from '@nostrify/nostrify';

export interface UseAllFollowsFeedOptions {
  contacts: string[];
  enabled?: boolean;
  onProgress?: (loaded: number, total: number) => void;
  limit: number;
}

export function useAllFollowsFeed({ contacts, enabled = true, onProgress, limit }: UseAllFollowsFeedOptions) {
  const { nostr } = useNostr();

  return {
    data: useQuery<NostrEvent[]>({
      queryKey: ['all-follows-notes', contacts.length, limit],
      queryFn: async () => {
        if (contacts.length === 0) return [];

        const events = await batchFetchByAuthors({
          nostr,
          authors: contacts,
          limit,
          onProgress: onProgress ?? (() => {}),
        });

        return events;
      },
      enabled: enabled && contacts.length > 0,
      retry: 2,
      retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 10_000),
    }),
  };
}
