import { useMutation, useQuery } from "@tanstack/react-query";
import { BlossomUploader } from '@nostrify/nostrify/uploaders';

import { useCurrentUser } from "./useCurrentUser";
import { useNostr } from "./useNostr";

// Default blossom servers in order of preference
// nostr.build is first (most reliable), then major community servers
const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.band/',
  'https://blossom.yakihonne.com/',
  'https://blossom.f7z.io/',
  'https://blossom.ditto.pub/',
  'https://cdn.sovbit.host/',
  'https://blossom.primal.net/',
];

// Timeout for each upload attempt (10 seconds)
const UPLOAD_TIMEOUT_MS = 10000;

// Helper to add timeout to a promise
function withTimeout<T>(promise: Promise<T>, ms: number, server: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Upload to ${server} timed out after ${ms}ms`)), ms)
    )
  ]);
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

      // Try each server until one succeeds (with timeout)
      for (const server of serverList) {
        try {
          const uploader = new BlossomUploader({
            servers: [server],
            signer: user.signer,
          });

          const tags = await withTimeout(uploader.upload(file), UPLOAD_TIMEOUT_MS, server);
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
