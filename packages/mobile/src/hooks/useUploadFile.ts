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
import { useAuth } from '../lib/AuthContext';
import { useNostr } from '../lib/NostrProvider';

const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.band/',
  'https://blossom.yakihonne.com/',
  'https://blossom.f7z.io/',
  'https://blossom.ditto.pub/',
  'https://cdn.sovbit.host/',
  'https://blossom.primal.net/',
];

const UPLOAD_TIMEOUT_MS = 10000;

function withTimeout<T>(promise: Promise<T>, ms: number, server: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Upload to ${server} timed out after ${ms}ms`)), ms)
    )
  ]);
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

      for (const server of serverList) {
        try {
          const uploader = new BlossomUploader({
            servers: [server],
            signer,
          });

          const tags = await withTimeout(uploader.upload(file), UPLOAD_TIMEOUT_MS, server);
          return tags;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }

      throw lastError || new Error('All upload servers failed');
    },
  });
}
