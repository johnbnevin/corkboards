import { useMutation, useQuery } from "@tanstack/react-query";
import { BlossomUploader } from '@nostrify/nostrify/uploaders';
import type { NostrSigner } from '@nostrify/nostrify';
import { KNOWN_BLOSSOM_SERVERS, extractBlossomRef, getBlossomUrlsForHash } from '@core/blossom';

import { useCurrentUser } from "./useCurrentUser";
import { useNostr } from "./useNostr";

// Default blossom servers in order of preference (shared with the render-time
// fallback set so a mirrored blob can always be re-fetched from a peer server).
const DEFAULT_BLOSSOM_SERVERS = [...KNOWN_BLOSSOM_SERVERS];

// Timeout for each upload attempt (10 seconds)
const UPLOAD_TIMEOUT_MS = 10000;

// Total number of servers we try to land each blob on, for redundancy. The
// first success is returned immediately; the rest are mirrored in the
// background so the same sha256 survives any single server pruning the file.
const MIRROR_COPIES = 3;

// How long we wait for background mirrors to confirm before returning the note.
// Slow mirrors keep running past this — they just won't be listed as confirmed
// fallbacks (render-time sha256 reconstruction covers them anyway).
const MIRROR_GRACE_MS = 4000;

// Helper to add timeout to a promise
function withTimeout<T>(promise: Promise<T>, ms: number, server: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Upload to ${server} timed out after ${ms}ms`)), ms)
    )
  ]);
}

// Mirror a file to additional servers IN PARALLEL (best effort). Every upload is
// wrapped in the same per-server timeout and launched at once; we stop counting
// once `count` succeed but let the rest settle. Never throws. Returns the base
// origins that confirmed the blob (the servers whose upload fulfilled).
async function mirrorToServers(file: File, servers: string[], count: number, signer: NostrSigner): Promise<string[]> {
  let landed = 0;
  const confirmed: string[] = [];
  const results = await Promise.allSettled(
    servers.map(async (server) => {
      const uploader = new BlossomUploader({ servers: [server], signer });
      await withTimeout(uploader.upload(file), UPLOAD_TIMEOUT_MS, server);
      return server;
    })
  );
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (landed >= count) continue;
      landed++;
      confirmed.push(result.value);
    }
  }
  return confirmed;
}

export function useUploadFile() {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();

  // Fetch user's blossom server list (kind 10063)
  const { data: userBlossomServers } = useQuery({
    queryKey: ['blossom-servers', user?.pubkey],
    queryFn: async () => {
      if (!user?.pubkey || !nostr) return [];

      const events = await nostr.query([{
        kinds: [10063],
        authors: [user.pubkey],
        limit: 1
      }], { signal: AbortSignal.timeout(5000) }).catch(() => []);

      if (events.length === 0) return [];

      // Extract server URLs from tags — only accept HTTPS servers
      const servers = events[0].tags
        .filter(t => t[0] === 'server' && t[1])
        .map(t => {
          let url = t[1];
          // Ensure URL ends with /
          if (!url.endsWith('/')) url += '/';
          return url;
        })
        .filter(url => {
          try { return new URL(url).protocol === 'https:'; } catch { return false; }
        });

      return servers;
    },
    enabled: !!user?.pubkey && !!nostr,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  return useMutation({
    mutationFn: async (file: File) => {
      if (!user) {
        throw new Error('Must be logged in to upload files');
      }

      // Build server list: user's servers first, then defaults (deduplicated)
      const servers = new Set<string>();

      // Add user's blossom servers first (outbox model)
      if (userBlossomServers && userBlossomServers.length > 0) {
        for (const server of userBlossomServers) {
          servers.add(server);
        }
      }

      // Add default servers as fallbacks
      for (const server of DEFAULT_BLOSSOM_SERVERS) {
        servers.add(server);
      }

      const serverList = Array.from(servers);
      let lastError: Error | null = null;

      // Try each server until one succeeds (with timeout). Return the first
      // success right away so posting stays responsive, then mirror the same
      // blob to MIRROR_COPIES-1 more servers in the background for redundancy.
      for (let i = 0; i < serverList.length; i++) {
        const server = serverList[i];
        try {
          const uploader = new BlossomUploader({
            servers: [server],
            signer: user.signer,
          });

          const tags = await withTimeout(uploader.upload(file), UPLOAD_TIMEOUT_MS, server);

          // Pull the blob descriptor from the returned tags so we can record
          // cross-server fallback URLs on the note (NIP-92).
          const url = tags.find(t => t[0] === 'url')?.[1] ?? '';
          const sha256 = tags.find(t => t[0] === 'x')?.[1];
          const ext = extractBlossomRef(url)?.ext ?? '';

          // Mirror to the remaining servers, but only wait up to MIRROR_GRACE_MS
          // for confirmations — slow mirrors keep running in the background and
          // are covered by render-time sha256 reconstruction.
          const others = serverList.filter((_, idx) => idx !== i);
          const confirmed = await Promise.race([
            mirrorToServers(file, others, MIRROR_COPIES - 1, user.signer),
            new Promise<string[]>(r => setTimeout(() => r([]), MIRROR_GRACE_MS)),
          ]);

          // Append one ['fallback', url] tag per confirmed mirror so the note
          // carries explicit alternate URLs for the same content-addressed blob.
          if (sha256) {
            for (const base of confirmed) {
              const fallbackUrl = getBlossomUrlsForHash(sha256, ext, [base])[0];
              if (fallbackUrl) tags.push(['fallback', fallbackUrl]);
            }
            // Redundancy check: the primary landing + confirmed mirrors should be
            // at least 2 servers, or the blob survives no single-server pruning.
            if ((1 + confirmed.length) < 2) {
              console.warn('[blossom] blob landed on only 1 server; redundancy not guaranteed', { sha256 });
            }
          }

          return tags;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          // Continue to next server
        }
      }

      // All servers failed
      throw lastError || new Error('All upload servers failed');
    },
  });
}
