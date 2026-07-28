import { useNostr } from "@nostrify/react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { useCurrentUser } from "./useCurrentUser";
import { useAppContext } from "./useAppContext";
import { isPublishBlockedByProxy } from "@/lib/tauri";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Hook for publishing Nostr events.
 *
 * Publishing succeeds when the event is signed AND at least one relay accepted
 * it. A total relay failure REJECTS, so callers can tell the user the truth.
 *
 * The old contract ("successful if the event is signed") swallowed the failure
 * into a `console.warn`, and it swallowed precisely the case worth surfacing:
 * `NPool.event()` is `Promise.any(...)` over the routed relays
 * (node_modules/@nostrify/nostrify/NPool.ts), so it only rejects when EVERY
 * relay rejected. The comment claimed "the event may have been accepted by at
 * least one relay" — but if one had, there would be no error at all. So a note
 * that reached nobody, a follow nobody stored, a reaction that never happened
 * all reported success, and the user found out later, if ever. A green
 * checkmark you haven't earned is a lie the protocol never asked you to tell.
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

      // Clone so we never mutate the caller's tags array in place. A shared
      // reference would otherwise accumulate a duplicate `client` tag on retry
      // / resubmit and silently mutate the caller's source object.
      const tags = [...(t.tags ?? [])];

      // Client tag is OFF by default — attaching it to every event creates
      // fingerprintable metadata that survives in the public relay record
      // forever. Users can opt in via settings.publishClientTag.
      // Skip for kind 0 (profile metadata) regardless — some relays reject
      // extra tags on metadata events.
      if (config.publishClientTag === true && t.kind !== 0 && !tags.some(([name]) => name === "client")) {
        tags.push(["client", "corkboards.me"]);
      }

      // Desktop kill-switch, applied BEFORE signing.
      //
      // `proxy_required` makes relay.rs refuse a direct connection, but that
      // only covers NATIVE relay sockets. Publishing goes out over the webview's
      // own WebSocket, which the Rust kill-switch never sees — so a Tor-only
      // user whose window could not be proxied kept quietly emitting SIGNED,
      // identity-bearing events over clearnet while reads were correctly
      // blocked. That is the highest-value traffic to leak: it ties the npub to
      // the IP at a known time. Fail closed instead, and refuse before signing
      // so nothing exists to be replayed later.
      if (await isPublishBlockedByProxy()) {
        throw new Error(
          'Publishing is blocked: you require a proxy, but this window is not routed through one, ' +
          'so posting would reveal your IP address alongside your signed event. ' +
          'Set a working proxy in Settings → Network Privacy and restart Corkboards.',
        );
      }

      const event = await user.signer.signEvent({
        kind: t.kind,
        content: t.content ?? "",
        tags,
        created_at: t.created_at ?? Math.floor(Date.now() / 1000),
      });

      // Partial relay failure is fine and expected — NPool resolves as soon as
      // ONE relay accepts. A rejection here therefore means ZERO relays took it,
      // which is a failed publish and must surface to the caller.
      try {
        await nostr.event(event, { signal: AbortSignal.timeout(8000) });
      } catch (err) {
        // AggregateError from Promise.any carries the per-relay errors; keep the
        // count in the message so the UI can be specific rather than generic.
        const relayCount = err instanceof AggregateError ? err.errors.length : 0;
        const detail = relayCount > 0 ? ` (0 of ${relayCount} relays accepted it)` : '';
        console.warn("Publish failed on every relay:", err);
        throw new Error(`Could not send to any relay${detail}. Please check your connection and try again.`, { cause: err });
      }

      return event;
    },
  });
}