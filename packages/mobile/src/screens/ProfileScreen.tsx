/**
 * Profile viewing screen — shows user metadata, follower stats, recent notes,
 * plus follow/unfollow/mute actions. Mirrors web's ProfileModal.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Linking,
  Alert,
  Modal,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { nip19 } from 'nostr-tools';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { useAuthor } from '../hooks/useAuthor';
import { useContacts } from '../hooks/useFeed';
import { useMuteList } from '../hooks/useMuteList';
import { useBookmarks } from '../hooks/useBookmarks';
import { useNostrPublish } from '../hooks/useNostrPublish';
import { useNip65Relays } from '../hooks/useNip65Relays';
import { NoteContent } from '../components/NoteContent';
import { NoteActions } from '../components/NoteActions';
import { ProfileAbout } from '../components/ProfileAbout';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { SizeGuardedImage } from '../components/SizeGuardedImage';

interface ProfileScreenProps {
  pubkey: string;
  onBack: () => void;
  onViewThread?: (eventId: string) => void;
  onCreateCorkboard?: (pubkey: string) => void;
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
  return useQuery<{ following: number; followers: number }>({
    queryKey: ['follow-count', pubkey],
    queryFn: async () => {
      // Fetch this user's contact list to count who they follow
      const [event] = await nostr.query(
        [{ kinds: [3], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.timeout(5000) },
      );
      const following = event?.tags.filter(t => t[0] === 'p').length ?? 0;

      // Fetch kind 3 events that reference this pubkey (followers)
      let followers = 0;
      try {
        const followerEvents = await nostr.query(
          [{ kinds: [3], '#p': [pubkey], limit: 500 }],
          { signal: AbortSignal.timeout(8000) },
        );
        // Deduplicate by pubkey — only count the latest contact list per author
        const seen = new Set<string>();
        for (const ev of followerEvents) {
          if (!seen.has(ev.pubkey)) {
            seen.add(ev.pubkey);
            followers++;
          }
        }
      } catch {
        // best-effort follower count
      }

      return { following, followers };
    },
    staleTime: 5 * 60_000,
  });
}

export function ProfileScreen({ pubkey, onBack, onViewThread, onCreateCorkboard }: ProfileScreenProps) {
  const { pubkey: myPubkey, signer } = useAuth();
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { data: author, isLoading } = useAuthor(pubkey);
  const { data: notes } = useProfileNotes(pubkey);
  const { data: counts } = useFollowerCount(pubkey);
  const { data: contacts } = useContacts(myPubkey ?? undefined);
  const { isMuted, mute, unmute } = useMuteList();
  const { isBookmarked, toggleBookmark } = useBookmarks();
  const { mutateAsync: publish } = useNostrPublish();
  const { fetchRelaysForPubkey } = useNip65Relays();

  const [followLoading, setFollowLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [relaysOpen, setRelaysOpen] = useState(false);
  const [relays, setRelays] = useState<string[]>([]);
  const [relaysLoading, setRelaysLoading] = useState(false);
  const relaysFetchedRef = useRef(false);

  // Reset relay state when pubkey changes
  useEffect(() => {
    setRelays([]);
    setRelaysOpen(false);
    setRelaysLoading(false);
    relaysFetchedRef.current = false;
  }, [pubkey]);

  const isMe = myPubkey === pubkey;
  const isFollowing = contacts?.includes(pubkey) ?? false;
  const isMutedUser = isMuted(pubkey);

  const meta = author?.metadata;
  const npub = nip19.npubEncode(pubkey);
  const displayName = meta?.display_name || meta?.name || pubkey.slice(0, 12) + '...';

  const handleCopyNpub = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(npub);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      Alert.alert('Copy failed', 'Could not copy to clipboard.');
    }
  }, [npub]);

  const handleRelaysToggle = useCallback(() => {
    const willOpen = !relaysOpen;
    setRelaysOpen(willOpen);
    if (willOpen && !relaysFetchedRef.current) {
      relaysFetchedRef.current = true;
      setRelaysLoading(true);
      fetchRelaysForPubkey(pubkey).then((r) => {
        setRelays(r);
        setRelaysLoading(false);
      });
    }
  }, [relaysOpen, pubkey, fetchRelaysForPubkey]);

  const handleFollow = useCallback(async () => {
    if (!myPubkey || !signer || !contacts) return;
    setFollowLoading(true);
    try {
      const newContacts = [...contacts, pubkey];
      const event = await signer.signEvent({
        kind: 3,
        content: '',
        tags: newContacts.map(pk => ['p', pk]),
        created_at: Math.floor(Date.now() / 1000),
      });
      await nostr.event(event);
      queryClient.setQueryData(['contacts', myPubkey], newContacts);
      Alert.alert('Followed', `Now following ${displayName}`);
    } catch (err) {
      Alert.alert('Failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setFollowLoading(false);
    }
  }, [myPubkey, signer, contacts, pubkey, nostr, queryClient, displayName]);

  const handleUnfollow = useCallback(async () => {
    if (!myPubkey || !signer || !contacts) return;
    Alert.alert('Unfollow', `Stop following ${displayName}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unfollow', style: 'destructive', onPress: async () => {
          setFollowLoading(true);
          try {
            const newContacts = contacts.filter(pk => pk !== pubkey);
            const event = await signer.signEvent({
              kind: 3,
              content: '',
              tags: newContacts.map(pk => ['p', pk]),
              created_at: Math.floor(Date.now() / 1000),
            });
            await nostr.event(event);
            queryClient.setQueryData(['contacts', myPubkey], newContacts);
          } catch (err) {
            Alert.alert('Failed', err instanceof Error ? err.message : 'Unknown error');
          } finally {
            setFollowLoading(false);
          }
        },
      },
    ]);
  }, [myPubkey, signer, contacts, pubkey, nostr, queryClient, displayName]);

  const handleToggleMute = useCallback(async () => {
    if (isMutedUser) {
      await unmute(pubkey);
      Alert.alert('Unmuted', `${displayName} is now visible`);
    } else {
      Alert.alert('Mute', `Mute ${displayName}? Their notes will be hidden.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mute', style: 'destructive', onPress: async () => {
            await mute(pubkey);
            Alert.alert('Muted', `${displayName} is now muted`);
          },
        },
      ]);
    }
  }, [isMutedUser, pubkey, displayName, mute, unmute]);

  const renderHeader = () => (
    <View>
      {/* Banner */}
      {meta?.banner && /^https?:\/\//.test(meta.banner) ? (
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
        {/* Npub with copy button */}
        <TouchableOpacity onPress={handleCopyNpub} style={styles.npubRow}>
          <Text style={styles.npub} numberOfLines={1}>
            {npub.slice(0, 16)}...{npub.slice(-8)}
          </Text>
          <Text style={styles.copyIcon}>{copied ? '\u2713' : '\u2398'}</Text>
        </TouchableOpacity>

        {meta?.about && (
          <ProfileAbout about={meta.about} pubkey={pubkey} style={styles.about} />
        )}

        {meta?.website && (
          <TouchableOpacity onPress={() => Linking.openURL(meta.website!)}>
            <Text style={styles.website}>{meta.website}</Text>
          </TouchableOpacity>
        )}

        {meta?.lud16 && (
          <Text style={styles.lud16}>{meta.lud16}</Text>
        )}

        {counts && (
          <View style={styles.statsRow}>
            <Text style={styles.stat}><Text style={styles.statNum}>{counts.following}</Text> following</Text>
            {counts.followers > 0 && (
              <Text style={styles.stat}><Text style={styles.statNum}>{counts.followers}</Text> followers</Text>
            )}
          </View>
        )}

        {/* Action buttons */}
        {myPubkey && !isMe && (
          <View style={styles.actionRow}>
            {isFollowing ? (
              <TouchableOpacity
                style={[styles.actionBtn, styles.unfollowBtn]}
                onPress={handleUnfollow}
                disabled={followLoading}
              >
                <Text style={styles.unfollowText}>
                  {followLoading ? '...' : 'Following'}
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.actionBtn, styles.followBtn]}
                onPress={handleFollow}
                disabled={followLoading}
              >
                <Text style={styles.followText}>
                  {followLoading ? '...' : 'Follow'}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.actionBtn, isMutedUser ? styles.unmuteBtn : styles.muteBtn]}
              onPress={handleToggleMute}
            >
              <Text style={isMutedUser ? styles.unmuteText : styles.muteText}>
                {isMutedUser ? 'Unmute' : 'Mute'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Collapsible NIP-65 relay list */}
        <TouchableOpacity style={styles.relayToggle} onPress={handleRelaysToggle}>
          <Text style={styles.relayToggleText}>
            Relays{!relaysLoading && relays.length > 0 ? ` (${relays.length})` : ''}
          </Text>
          <Text style={styles.chevron}>{relaysOpen ? '\u25B2' : '\u25BC'}</Text>
        </TouchableOpacity>
        {relaysOpen && (
          <View style={styles.relayListBox}>
            {relaysLoading ? (
              <ActivityIndicator color="#b3b3b3" size="small" />
            ) : relays.length > 0 ? (
              relays.map(relay => (
                <Text key={relay} style={styles.relayItemText}>
                  {relay.replace('wss://', '').replace('ws://', '').replace(/\/$/, '')}
                </Text>
              ))
            ) : (
              <Text style={styles.relayEmptyText}>No relays published</Text>
            )}
          </View>
        )}

        {/* Create corkboard from this profile */}
        {onCreateCorkboard && (
          <TouchableOpacity
            style={styles.corkboardBtn}
            onPress={() => onCreateCorkboard(pubkey)}
          >
            <Text style={styles.corkboardBtnText}>+ Open in new corkboard</Text>
          </TouchableOpacity>
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
          <Text style={styles.backText}>{'<'} Back</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={notes ?? []}
        keyExtractor={item => item.id}
        ListHeaderComponent={renderHeader}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.noteCard}
            onPress={() => onViewThread?.(item.id)}
            activeOpacity={0.7}
          >
            <Text style={styles.noteTime}>{formatTimeAgo(item.created_at)}</Text>
            <NoteContent event={item} numberOfLines={8} />
            <NoteActions
              event={item}
              isBookmarked={isBookmarked(item.id)}
              onToggleBookmark={() => toggleBookmark(item.id)}
            />
          </TouchableOpacity>
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
  npubRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  npub: { fontSize: 11, color: '#b3b3b3', fontFamily: 'monospace' },
  copyIcon: { fontSize: 14, color: '#a855f7' },
  about: { fontSize: 14, color: '#b3b3b3', marginTop: 10, lineHeight: 20 },
  website: { fontSize: 13, color: '#a855f7', marginTop: 6 },
  lud16: { fontSize: 12, color: '#f97316', marginTop: 4 },
  statsRow: { flexDirection: 'row', gap: 16, marginTop: 10 },
  stat: { fontSize: 13, color: '#b3b3b3' },
  statNum: { color: '#f2f2f2', fontWeight: '600' },

  // Action buttons
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  actionBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1 },
  followBtn: { backgroundColor: '#f97316', borderColor: '#f97316' },
  followText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  unfollowBtn: { backgroundColor: 'transparent', borderColor: '#404040' },
  unfollowText: { color: '#b3b3b3', fontSize: 14, fontWeight: '500' },
  muteBtn: { backgroundColor: 'transparent', borderColor: '#404040' },
  muteText: { color: '#b3b3b3', fontSize: 14 },
  unmuteBtn: { backgroundColor: '#2a1a1a', borderColor: '#4a2020' },
  unmuteText: { color: '#ef4444', fontSize: 14 },

  // Relay section
  relayToggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, marginTop: 14 },
  relayToggleText: { color: '#b3b3b3', fontSize: 13, fontWeight: '500' },
  chevron: { color: '#b3b3b3', fontSize: 10 },
  relayListBox: { backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040', borderRadius: 8, padding: 12, marginTop: 4 },
  relayItemText: { color: '#b3b3b3', fontSize: 12, fontFamily: 'monospace', marginBottom: 4 },
  relayEmptyText: { color: '#666', fontSize: 12, fontStyle: 'italic' },

  // Corkboard button
  corkboardBtn: { backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, marginTop: 10, alignItems: 'center' },
  corkboardBtnText: { color: '#f97316', fontSize: 13, fontWeight: '500' },

  notesHeader: { fontSize: 14, fontWeight: '600', color: '#999', paddingHorizontal: 16, paddingTop: 12, textTransform: 'uppercase', letterSpacing: 1 },
  listContent: { paddingBottom: 40 },
  noteCard: { backgroundColor: '#2a2a2a', marginHorizontal: 12, marginTop: 8, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#404040' },
  noteTime: { fontSize: 11, color: '#b3b3b3', marginBottom: 6 },
  emptyText: { color: '#666', textAlign: 'center', marginTop: 20, paddingHorizontal: 16 },
});
