/**
 * Profile viewing screen — shows user metadata, follower stats, recent notes.
 */
import { useEffect } from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { nip19 } from 'nostr-tools';
import { useQuery } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { useAuthor } from '../hooks/useAuthor';
import { NoteContent } from '../components/NoteContent';
import { NoteActions } from '../components/NoteActions';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { SizeGuardedImage } from '../components/SizeGuardedImage';

interface ProfileScreenProps {
  pubkey: string;
  onBack: () => void;
}

function useProfileNotes(pubkey: string) {
  const { nostr } = useNostr();
  return useQuery<NostrEvent[]>({
    queryKey: ['profile-notes', pubkey],
    queryFn: async () => {
      const events = await nostr.query(
        [{ kinds: [1], authors: [pubkey], limit: 20 }],
        { signal: AbortSignal.timeout(8000) },
      );
      return events.sort((a, b) => b.created_at - a.created_at);
    },
    staleTime: 2 * 60_000,
  });
}

function useFollowerCount(pubkey: string) {
  const { nostr } = useNostr();
  return useQuery<{ following: number }>({
    queryKey: ['follow-count', pubkey],
    queryFn: async () => {
      const [event] = await nostr.query(
        [{ kinds: [3], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.timeout(5000) },
      );
      const following = event?.tags.filter(t => t[0] === 'p').length ?? 0;
      return { following };
    },
    staleTime: 5 * 60_000,
  });
}

export function ProfileScreen({ pubkey, onBack }: ProfileScreenProps) {
  const { data: author, isLoading } = useAuthor(pubkey);
  const { data: notes } = useProfileNotes(pubkey);
  const { data: counts } = useFollowerCount(pubkey);

  const meta = author?.metadata;
  const npub = nip19.npubEncode(pubkey);
  const displayName = meta?.display_name || meta?.name || pubkey.slice(0, 12) + '…';

  const renderHeader = () => (
    <View>
      {/* Banner */}
      {meta?.banner ? (
        <Image source={{ uri: meta.banner }} style={styles.banner} />
      ) : (
        <View style={[styles.banner, styles.bannerPlaceholder]} />
      )}

      {/* Avatar + name */}
      <View style={styles.profileInfo}>
        {meta?.picture ? (
          <SizeGuardedImage uri={meta.picture} style={styles.avatar} type="avatar" />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Text style={styles.avatarLetter}>{displayName[0]?.toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.displayName}>{displayName}</Text>
        {meta?.nip05 && <Text style={styles.nip05}>{meta.nip05}</Text>}
        <Text style={styles.npub} selectable numberOfLines={1}>{npub}</Text>

        {meta?.about && (
          <Text style={styles.about}>{meta.about}</Text>
        )}

        {meta?.website && (
          <TouchableOpacity onPress={() => Linking.openURL(meta.website!)}>
            <Text style={styles.website}>{meta.website}</Text>
          </TouchableOpacity>
        )}

        {counts && (
          <View style={styles.statsRow}>
            <Text style={styles.stat}><Text style={styles.statNum}>{counts.following}</Text> following</Text>
          </View>
        )}
      </View>

      <Text style={styles.notesHeader}>Recent notes</Text>
    </View>
  );

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#b3b3b3" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Back button */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.backText}>{'‹'} Back</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={notes ?? []}
        keyExtractor={item => item.id}
        ListHeaderComponent={renderHeader}
        renderItem={({ item }) => (
          <View style={styles.noteCard}>
            <Text style={styles.noteTime}>{formatTimeAgo(item.created_at)}</Text>
            <NoteContent event={item} numberOfLines={8} />
            <NoteActions event={item} />
          </View>
        )}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={<Text style={styles.emptyText}>No notes</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: { flex: 1, backgroundColor: '#1f1f1f', alignItems: 'center', justifyContent: 'center' },
  header: { position: 'absolute', top: 52, left: 12, zIndex: 10 },
  backText: { color: '#f2f2f2', fontSize: 16, fontWeight: '500', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  banner: { width: '100%', height: 140 },
  bannerPlaceholder: { backgroundColor: '#333' },
  profileInfo: { padding: 16, marginTop: -30 },
  avatar: { width: 72, height: 72, borderRadius: 36, borderWidth: 3, borderColor: '#1f1f1f' },
  avatarPlaceholder: { backgroundColor: '#333', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#b3b3b3', fontSize: 28, fontWeight: '600' },
  displayName: { fontSize: 22, fontWeight: 'bold', color: '#f2f2f2', marginTop: 8 },
  nip05: { fontSize: 13, color: '#a855f7', marginTop: 2 },
  npub: { fontSize: 11, color: '#b3b3b3', fontFamily: 'monospace', marginTop: 4 },
  about: { fontSize: 14, color: '#b3b3b3', marginTop: 10, lineHeight: 20 },
  website: { fontSize: 13, color: '#a855f7', marginTop: 6 },
  statsRow: { flexDirection: 'row', gap: 16, marginTop: 10 },
  stat: { fontSize: 13, color: '#b3b3b3' },
  statNum: { color: '#f2f2f2', fontWeight: '600' },
  notesHeader: { fontSize: 14, fontWeight: '600', color: '#999', paddingHorizontal: 16, paddingTop: 12, textTransform: 'uppercase', letterSpacing: 1 },
  listContent: { paddingBottom: 40 },
  noteCard: { backgroundColor: '#2a2a2a', marginHorizontal: 12, marginTop: 8, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#404040' },
  noteTime: { fontSize: 11, color: '#b3b3b3', marginBottom: 6 },
  emptyText: { color: '#666', textAlign: 'center', marginTop: 20, paddingHorizontal: 16 },
});
