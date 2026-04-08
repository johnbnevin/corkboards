import { useNostr } from "@nostrify/react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { useCurrentUser } from "./useCurrentUser";
import { useAppContext } from "./useAppContext";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Hook for publishing Nostr events.
 *
 * Publishing is considered successful if the event is signed.
 * Relay failures are logged but don't fail the mutation,
 * since the event may have been accepted by at least one relay.
 */
export function useNostrPublish(): UseMutationResult<NostrEvent> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();

  return useMutation({
    mutationFn: async (t: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>) => {
      if (!user) {
        throw new Error("User is not logged in");
      }

      const tags = t.tags ?? [];

      // Add the client tag unless explicitly disabled (default: on).
      // Skip for kind 0 (profile metadata) — some relays reject extra tags on metadata events.
      if (config.publishClientTag !== false && t.kind !== 0 && !tags.some(([name]) => name === "client")) {
        tags.push(["client", "corkboards.me"]);
      }

      const event = await user.signer.signEvent({
        kind: t.kind,
        content: t.content ?? "",
        tags,
        created_at: t.created_at ?? Math.floor(Date.now() / 1000),
      });

      // Publish to relays - don't fail if some relays reject
      // The event is valid once signed; relay acceptance is best-effort
      try {
        await nostr.event(event, { signal: AbortSignal.timeout(8000) });
      } catch (err) {
        // Log but don't throw - the event was signed and may have been
        // accepted by at least one relay before the error occurred
        console.warn("Some relays may have rejected the event:", err);
      }

      return event;
    },
  });
}