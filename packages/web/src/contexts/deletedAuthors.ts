import { createContext, useContext } from 'react';

/**
 * Set of author pubkeys confirmed deleted/vanished — via a NIP-09 kind-5 event
 * targeting the author's own kind-0 profile, or a NIP-62 (kind 62) request to
 * vanish. Populated by a batched per-feed query (useDeletedAuthors) and provided
 * to note renderers so they can show a graceful "Deleted account" treatment.
 * Empty by default (e.g. outside the main feed) — renders normally.
 */
export const DeletedAuthorsContext = createContext<Set<string>>(new Set());

export function useIsDeletedAuthor(pubkey: string | undefined): boolean {
  const set = useContext(DeletedAuthorsContext);
  return !!pubkey && set.has(pubkey);
}
