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

/** One grouped emoji reaction: the display emoji, its count, and whether the current user reacted with it. */
export interface ReactionGroup {
  emoji: string;
  count: number;
  reacted: boolean;
}

export interface NoteEngagement {
  likeCount: number;
  repostCount: number;
  zapCount: number;
  /** True when the current user has an existing kind-7 reaction on this note. */
  liked: boolean;
  /** True when the current user has an existing kind-6 repost of this note. */
  reposted: boolean;
  /** Kind-7 reactions grouped by normalized emoji, sorted by count desc. */
  reactionGroups: ReactionGroup[];
}

const EMPTY: NoteEngagement = { likeCount: 0, repostCount: 0, zapCount: 0, liked: false, reposted: false, reactionGroups: [] };

/**
 * Normalize a kind-7 reaction content to a display emoji.
 * "" or "+" → heart (like); "-" → thumbs-down (dislike); otherwise the
 * emoji / :shortcode: as-is (mirrors web's resolveReactionEmoji intent).
 */
function normalizeReaction(content: string): string {
  if (content === '' || content === '+') return '❤️';
  if (content === '-') return '👎';
  return content;
}

/** Ceiling on engagement events pulled per note (was 500 — see the query). */
const ENGAGEMENT_LIMIT = 150;

export function useNoteEngagement(eventId: string | undefined) {
  const { nostr } = useNostr();
  const { pubkey } = useAuth();

  return useQuery<NoteEngagement>({
    queryKey: ['note-engagement', eventId, pubkey ?? ''],
    enabled: !!eventId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!eventId) return EMPTY;
      // 150, not 500: this fires once PER VISIBLE NOTE, and every returned
      // event costs deserialization, a signature check, and a pass through the
      // grouping loop below — all on the JS thread. The counts rendered from it
      // are badges; nothing downstream needs hundreds of reactions per note.
      const events = await nostr.query(
        [{ kinds: [6, 7, 9735], '#e': [eventId], limit: ENGAGEMENT_LIMIT }],
        { signal: AbortSignal.timeout(8000) },
      );

      let likeCount = 0, repostCount = 0, zapCount = 0, liked = false, reposted = false;
      // emoji → { count, reacted } — groups every kind-7 reaction (likes,
      // dislikes, emoji) so the UI can render grouped badges like web.
      const groupMap = new Map<string, { count: number; reacted: boolean }>();
      for (const e of events) {
        // Reactions/reposts target the LAST e-tag (NIP-25/NIP-18); ignore events
        // that merely reference this note in an earlier tag.
        const eTags = e.tags.filter(t => t[0] === 'e');
        if (eTags[eTags.length - 1]?.[1] !== eventId) continue;

        if (e.kind === 7) {
          const emoji = normalizeReaction(e.content);
          const mine = !!pubkey && e.pubkey === pubkey;
          const g = groupMap.get(emoji);
          if (g) { g.count++; if (mine) g.reacted = true; }
          else groupMap.set(emoji, { count: 1, reacted: mine });

          if (e.content === '-') continue; // explicit downvote — not a like
          likeCount++;
          if (mine) liked = true;
        } else if (e.kind === 6) {
          repostCount++;
          if (pubkey && e.pubkey === pubkey) reposted = true;
        } else if (e.kind === 9735) {
          zapCount++;
        }
      }
      const reactionGroups: ReactionGroup[] = Array.from(groupMap.entries())
        .map(([emoji, g]) => ({ emoji, count: g.count, reacted: g.reacted }))
        .sort((a, b) => b.count - a.count);
      return { likeCount, repostCount, zapCount, liked, reposted, reactionGroups };
    },
  });
}

export type { NoteEngagement as NoteEngagementResult };
