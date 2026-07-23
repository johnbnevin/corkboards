/**
 * useUploadFile — upload files to Blossom servers with fallback list.
 *
 * Port of packages/web/src/hooks/useUploadFile.ts for mobile.
 * Uses mobile's AuthContext + NostrProvider.
 *
 * Note: React Native doesn't have the browser File API. Callers should
 * construct a File-like object from the RN image/document picker result.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { BlossomUploader } from '@nostrify/nostrify/uploaders';
import type { NostrSigner } from '@nostrify/nostrify';
import { KNOWN_BLOSSOM_SERVERS, extractBlossomRef, getBlossomUrlsForHash } from '@core/blossom';
import { useAuth } from '../lib/AuthContext';
import { useNostr } from '../lib/NostrProvider';

// Shared with the render-time fallback set so a mirrored blob can always be
// re-fetched from a peer server.
const DEFAULT_BLOSSOM_SERVERS = [...KNOWN_BLOSSOM_SERVERS];

const UPLOAD_TIMEOUT_MS = 10000;

// Total servers we try to land each blob on, for redundancy. First success is
// returned immediately; the rest are mirrored in the background.
const MIRROR_COPIES = 3;

// How long we wait for background mirrors to confirm before returning the note.
// Slow mirrors keep running past this — they just won't be listed as confirmed
// fallbacks (render-time sha256 reconstruction covers them anyway).
const MIRROR_GRACE_MS = 4000;

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
  const { pubkey, signer } = useAuth();
  const { nostr } = useNostr();

  // Fetch user's blossom server list (kind 10063)
  const { data: userBlossomServers } = useQuery({
    queryKey: ['blossom-servers', pubkey],
    queryFn: async () => {
      if (!pubkey || !nostr) return [];

      const events = await nostr.query([{
        kinds: [10063],
        authors: [pubkey],
        limit: 1
      }], { signal: AbortSignal.timeout(5000) }).catch(() => []);

      if (events.length === 0) return [];

      const servers = events[0].tags
        .filter(t => t[0] === 'server' && t[1])
        .map(t => {
          let url = t[1];
          if (!url.endsWith('/')) url += '/';
          return url;
        })
        .filter(url => {
          try { return new URL(url).protocol === 'https:'; } catch { return false; }
        });

      return servers;
    },
    enabled: !!pubkey && !!nostr,
    staleTime: 5 * 60 * 1000,
  });

  return useMutation({
    mutationFn: async (file: File) => {
      if (!signer) {
        throw new Error('Must be logged in to upload files');
      }

      const servers = new Set<string>();

      if (userBlossomServers && userBlossomServers.length > 0) {
        for (const server of userBlossomServers) {
          servers.add(server);
        }
      }

      for (const server of DEFAULT_BLOSSOM_SERVERS) {
        servers.add(server);
      }

      const serverList = Array.from(servers);
      let lastError: Error | null = null;

      // Return the first success immediately, then mirror the same blob to
      // MIRROR_COPIES-1 more servers in the background for redundancy.
      for (let i = 0; i < serverList.length; i++) {
        const server = serverList[i];
        try {
          const uploader = new BlossomUploader({
            servers: [server],
            signer,
          });

          const tags = await withTimeout(uploader.upload(file), UPLOAD_TIMEOUT_MS, server);

          // Pull the blob descriptor from the returned tags so we can record
          // cross-server fallback URLs on the note (NIP-92).
          const url = tags.find((t: string[]) => t[0] === 'url')?.[1] ?? '';
          const sha256 = tags.find((t: string[]) => t[0] === 'x')?.[1];
          const ext = extractBlossomRef(url)?.ext ?? '';

          // Mirror to the remaining servers, but only wait up to MIRROR_GRACE_MS
          // for confirmations — slow mirrors keep running in the background and
          // are covered by render-time sha256 reconstruction.
          const others = serverList.filter((_, idx) => idx !== i);
          const confirmed = await Promise.race([
            mirrorToServers(file, others, MIRROR_COPIES - 1, signer),
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
        }
      }

      throw lastError || new Error('All upload servers failed');
    },
  });
}
