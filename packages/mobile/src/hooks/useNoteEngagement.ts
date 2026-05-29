/**
 * useNoteEngagement — aggregate reaction / repost / zap state for one note.
 *
 * Web derives this from events already fetched at the feed/thread level
 * (EngagementBar receives them as props). Mobile's single-column feed doesn't
 * carry those, so this hook fetches them per-note: kinds 7 (reactions),
 * 6 (reposts) and 9735 (zap receipts) tagged with the note id. It also reports
 * whether the *current* user already reacted/reposted so the UI can show the
 * active state and avoid publishing duplicate events.
 */
import { useQuery } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';

export interface NoteEngagement {
  likeCount: number;
  repostCount: number;
  zapCount: number;
  /** True when the current user has an existing kind-7 reaction on this note. */
  liked: boolean;
  /** True when the current user has an existing kind-6 repost of this note. */
  reposted: boolean;
}

const EMPTY: NoteEngagement = { likeCount: 0, repostCount: 0, zapCount: 0, liked: false, reposted: false };

export function useNoteEngagement(eventId: string | undefined) {
  const { nostr } = useNostr();
  const { pubkey } = useAuth();

  return useQuery<NoteEngagement>({
    queryKey: ['note-engagement', eventId, pubkey ?? ''],
    enabled: !!eventId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!eventId) return EMPTY;
      const events = await nostr.query(
        [{ kinds: [6, 7, 9735], '#e': [eventId], limit: 500 }],
        { signal: AbortSignal.timeout(8000) },
      );

      let likeCount = 0, repostCount = 0, zapCount = 0, liked = false, reposted = false;
      for (const e of events) {
        // Reactions/reposts target the LAST e-tag (NIP-25/NIP-18); ignore events
        // that merely reference this note in an earlier tag.
        const eTags = e.tags.filter(t => t[0] === 'e');
        if (eTags[eTags.length - 1]?.[1] !== eventId) continue;

        if (e.kind === 7) {
          if (e.content === '-') continue; // explicit downvote — not a like
          likeCount++;
          if (pubkey && e.pubkey === pubkey) liked = true;
        } else if (e.kind === 6) {
          repostCount++;
          if (pubkey && e.pubkey === pubkey) reposted = true;
        } else if (e.kind === 9735) {
          zapCount++;
        }
      }
      return { likeCount, repostCount, zapCount, liked, reposted };
    },
  });
}

export type { NoteEngagement as NoteEngagementResult };
