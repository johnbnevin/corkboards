/**
 * DeepLinkHandler — routes incoming NIP-19 deep links to the right view.
 *
 * Handles both the initial URL (cold start) and runtime `url` events for the
 * app's custom scheme (`corkboards://`) and `nostr:` links. Decodes the NIP-19
 * identifier and opens a profile (npub/nprofile) or a thread (note/nevent).
 *
 * Renders nothing. Must be mounted inside ProfileModalProvider so
 * `useProfileModal()` is available; the thread opener is passed in by the host
 * screen (HomeScreen owns the thread view state).
 *
 * Parity with web's NIP19Page route (npub/note/nprofile/nevent/naddr URLs).
 */
import { useEffect } from 'react';
import { Linking } from 'react-native';
import { nip19 } from 'nostr-tools';
import { useProfileModal } from './ProfileModal';

interface DeepLinkHandlerProps {
  onThread: (eventId: string) => void;
}

/** Extract the NIP-19 token from a deep link URL (after a scheme/host/nostr: prefix). */
function extractNip19Token(url: string): string | null {
  // Accept: corkboards://<token>, corkboards:///<token>, nostr:<token>,
  // https://corkboards.me/<token>, or a bare token.
  const cleaned = url
    .replace(/^[a-z]+:\/\//i, '')   // strip scheme://
    .replace(/^nostr:/i, '')         // strip nostr:
    .replace(/^[^/]*\//, '')         // strip host/ if present (corkboards.me/…)
    .replace(/[?#].*$/, '')          // strip query/fragment
    .replace(/\/+$/, '');            // strip trailing slashes
  const token = cleaned.split('/').pop() ?? '';
  return /^(npub|nprofile|note|nevent|naddr)1[0-9a-z]+$/i.test(token) ? token : null;
}

export function DeepLinkHandler({ onThread }: DeepLinkHandlerProps): null {
  const { openProfile } = useProfileModal();

  useEffect(() => {
    const route = (url: string | null) => {
      if (!url) return;
      const token = extractNip19Token(url);
      if (!token) return;
      try {
        const decoded = nip19.decode(token);
        switch (decoded.type) {
          case 'npub':
            openProfile(decoded.data);
            break;
          case 'nprofile':
            openProfile(decoded.data.pubkey);
            break;
          case 'note':
            onThread(decoded.data);
            break;
          case 'nevent':
            onThread(decoded.data.id);
            break;
          // naddr (addressable) has no dedicated mobile view yet — ignore.
        }
      } catch {
        /* malformed identifier — ignore */
      }
    };

    Linking.getInitialURL().then(route).catch(() => {});
    const sub = Linking.addEventListener('url', (e) => route(e.url));
    return () => sub.remove();
  }, [openProfile, onThread]);

  return null;
}
