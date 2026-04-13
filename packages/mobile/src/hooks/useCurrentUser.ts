import { useAuth } from '../lib/AuthContext';
import { useAuthor } from './useAuthor';

/**
 * Combines auth state with profile data for the current user.
 * Mirrors web's useCurrentUser pattern.
 */
export function useCurrentUser(fetchProfile = true) {
  const { pubkey, signer, accounts } = useAuth();
  const author = useAuthor(fetchProfile ? pubkey ?? undefined : undefined);

  return {
    pubkey,
    signer,
    accounts,
    metadata: author.data?.metadata,
    event: author.data?.event,
    isLoading: author.isLoading,
  };
}
