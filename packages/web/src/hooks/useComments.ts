import { NKinds, NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

export function useComments(root: NostrEvent | URL, limit?: number) {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ['nostr', 'comments', root instanceof URL ? root.toString() : root.id, limit],
    queryFn: async (c) => {
      const filter: NostrFilter = { kinds: [1111] };

      if (root instanceof URL) {
        filter['#I'] = [root.toString()];
      } else if (NKinds.addressable(root.kind)) {
        const d = root.tags.find(([name]) => name === 'd')?.[1] ?? '';
        filter['#A'] = [`${root.kind}:${root.pubkey}:${d}`];
      } else if (NKinds.replaceable(root.kind)) {
        filter['#A'] = [`${root.kind}:${root.pubkey}:`];
      } else {
        filter['#E'] = [root.id];
      }

      if (typeof limit === 'number') {
        filter.limit = limit;
      }

      // Query for all kind 1111 comments that reference this addressable event regardless of depth
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(5000)]);
      const events = await nostr.query([filter], { signal });

      // Helper function to get tag value
      const getTagValue = (event: NostrEvent, tagName: string): string | undefined => {
        const tag = event.tags.find(([name]) => name === tagName);
        return tag?.[1];
      };

      // Filter top-level comments (those with lowercase tag matching the root)
      const topLevelComments = events.filter(comment => {
        if (root instanceof URL) {
          return getTagValue(comment, 'i') === root.toString();
        } else if (NKinds.addressable(root.kind)) {
          const d = getTagValue(root, 'd') ?? '';
          return getTagValue(comment, 'a') === `${root.kind}:${root.pubkey}:${d}`;
        } else if (NKinds.replaceable(root.kind)) {
          return getTagValue(comment, 'a') === `${root.kind}:${root.pubkey}:`;
        } else {
          return getTagValue(comment, 'e') === root.id;
        }
      });

      // Build a children map for O(n) subtree traversal
      const childrenMap = new Map<string, NostrEvent[]>();
      for (const comment of events) {
        const parentId = getTagValue(comment, 'e');
        if (parentId) {
          const siblings = childrenMap.get(parentId) ?? [];
          siblings.push(comment);
          childrenMap.set(parentId, siblings);
        }
      }

      // Iterative BFS to collect all descendants — O(n), cycle-safe
      const getDescendantsIterative = (startId: string): NostrEvent[] => {
        const result: NostrEvent[] = [];
        const visited = new Set<string>([startId]);
        const queue: string[] = [startId];
        while (queue.length > 0) {
          const id = queue.shift()!;
          const children = childrenMap.get(id) ?? [];
          for (const child of children) {
            if (!visited.has(child.id)) {
              visited.add(child.id);
              result.push(child);
              queue.push(child.id);
            }
          }
        }
        return result;
      };

      // Create a map of comment ID to its descendants
      const commentDescendants = new Map<string, NostrEvent[]>();
      for (const comment of events) {
        commentDescendants.set(comment.id, getDescendantsIterative(comment.id));
      }

      // Sort top-level comments by creation time (newest first)
      const sortedTopLevel = topLevelComments.sort((a, b) => b.created_at - a.created_at);

      return {
        allComments: events,
        topLevelComments: sortedTopLevel,
        getDescendants: (commentId: string) => {
          const descendants = commentDescendants.get(commentId) || [];
          // Sort descendants by creation time (oldest first for threaded display)
          return descendants.sort((a, b) => a.created_at - b.created_at);
        },
        getDirectReplies: (commentId: string) => {
          // Use childrenMap for O(1) lookup instead of scanning all events
          const directReplies = childrenMap.get(commentId) ?? [];
          // Sort direct replies by creation time (oldest first for threaded display)
          return [...directReplies].sort((a, b) => a.created_at - b.created_at);
        }
      };
    },
    enabled: !!root,
  });
}