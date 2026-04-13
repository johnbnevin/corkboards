/**
 * ProfileLink — Tappable profile reference that shows avatar + name inline.
 * For use inside note content when mentioning users.
 * Mirrors web's ProfileLink.tsx.
 */
import { Text, View, StyleSheet, ActivityIndicator } from 'react-native';
import { nip19 } from 'nostr-tools';
import { useAuthor } from '../hooks/useAuthor';
import { genUserName } from '@core/genUserName';
import { SizeGuardedImage } from './SizeGuardedImage';
import { TappableProfile } from './ProfileModal';

function getPubkeyFromIdentifier(identifier: string): string {
  try {
    const decoded = nip19.decode(identifier);
    if (decoded.type === 'npub') {
      return decoded.data;
    }
    if (decoded.type === 'nprofile') {
      return decoded.data.pubkey;
    }
  } catch {
    // Fall through
  }
  return identifier;
}

function getDisplayName(
  metadata: { name?: string; display_name?: string; nip05?: string } | undefined,
  pubkey: string,
): string {
  if (metadata?.display_name) return metadata.display_name;
  if (metadata?.name) return metadata.name;
  if (metadata?.nip05) {
    const nip05User = metadata.nip05.split('@')[0];
    if (nip05User && nip05User !== '_') return nip05User;
  }
  return genUserName(pubkey);
}

interface ProfileLinkProps {
  pubkey: string;
}

export function ProfileLink({ pubkey }: ProfileLinkProps) {
  const resolvedPubkey = getPubkeyFromIdentifier(pubkey);
  const { data: author, isLoading } = useAuthor(resolvedPubkey);

  const profileName = getDisplayName(author?.metadata, resolvedPubkey);
  const hasRealName = !!(author?.metadata?.display_name || author?.metadata?.name);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <View style={styles.loadingSkeleton} />
      </View>
    );
  }

  return (
    <TappableProfile pubkey={resolvedPubkey} style={styles.container}>
      {author?.metadata?.picture && (
        <SizeGuardedImage
          uri={author.metadata.picture}
          style={styles.avatar}
          type="avatar"
        />
      )}
      <Text
        style={[styles.name, hasRealName ? styles.nameReal : styles.nameFallback]}
        numberOfLines={1}
      >
        @{profileName}
      </Text>
    </TappableProfile>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  avatar: {
    width: 16,
    height: 16,
    borderRadius: 8,
  },
  name: {
    fontSize: 14,
    fontWeight: '500',
  },
  nameReal: {
    color: '#a855f7',
  },
  nameFallback: {
    color: '#999',
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  loadingSkeleton: {
    width: 80,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#333',
  },
});
