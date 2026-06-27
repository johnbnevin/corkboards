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
import { KNOWN_BLOSSOM_SERVERS } from '@core/blossom';
import { useAuth } from '../lib/AuthContext';
import { useNostr } from '../lib/NostrProvider';

// Shared with the render-time fallback set so a mirrored blob can always be
// re-fetched from a peer server.
const DEFAULT_BLOSSOM_SERVERS = [...KNOWN_BLOSSOM_SERVERS];

const UPLOAD_TIMEOUT_MS = 10000;

// Total servers we try to land each blob on, for redundancy. First success is
// returned immediately; the rest are mirrored in the background.
const MIRROR_COPIES = 3;

function withTimeout<T>(promise: Promise<T>, ms: number, server: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Upload to ${server} timed out after ${ms}ms`)), ms)
    )
  ]);
}

// Mirror a file to additional servers in the background (best effort). Stops
// once `count` copies succeed. Never throws — failures are silently ignored.
async function mirrorToServers(file: File, servers: string[], count: number, signer: NostrSigner): Promise<void> {
  let landed = 0;
  for (const server of servers) {
    if (landed >= count) break;
    try {
      const uploader = new BlossomUploader({ servers: [server], signer });
      await withTimeout(uploader.upload(file), UPLOAD_TIMEOUT_MS, server);
      landed++;
    } catch {
      // best effort — try the next server
    }
  }
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

          const others = serverList.filter((_, idx) => idx !== i);
          void mirrorToServers(file, others, MIRROR_COPIES - 1, signer);

          return tags;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }

      throw lastError || new Error('All upload servers failed');
    },
  });
}
