/**
 * ProfileModal — Full profile view opened from note cards.
 * Shows banner, avatar, name, about, website, NIP-05, lightning address,
 * relay list, follow/mute buttons, and recent notes.
 * Mirrors web's ProfileModal.tsx.
 */
import { createContext, useContext, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Clipboard,
  Linking,
  Alert,
} from 'react-native';
import { nip19 } from 'nostr-tools';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { useAuthor } from '../hooks/useAuthor';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { useNip65Relays } from '../hooks/useNip65Relays';
import { useContacts } from '../hooks/useFeed';
import { useMuteList } from '../hooks/useMuteList';
import { useNostrPublish } from '../hooks/useNostrPublish';
import { genUserName } from '@core/genUserName';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { ProfileAbout } from './ProfileAbout';
import { NoteContent } from './NoteContent';
import { SizeGuardedImage } from './SizeGuardedImage';

// ---------------------------------------------------------------------------
// Context for opening profiles from anywhere in the app
// ---------------------------------------------------------------------------

interface ProfileModalContextType {
  openProfile: (pubkey: string) => void;
  closeProfile: () => void;
}

const ProfileModalContext = createContext<ProfileModalContextType | null>(null);

export function useProfileModal() {
  const context = useContext(ProfileModalContext);
  if (!context) {
    throw new Error('useProfileModal must be used within ProfileModalProvider');
  }
  return context;
}

interface ProfileModalProviderProps {
  children: React.ReactNode;
  onViewThread?: (eventId: string) => void;
}

export function ProfileModalProvider({ children, onViewThread }: ProfileModalProviderProps) {
  const [activePubkey, setActivePubkey] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const openProfile = useCallback((pubkey: string) => {
    setActivePubkey(pubkey);
    setIsOpen(true);
  }, []);

  const closeProfile = useCallback(() => {
    setIsOpen(false);
    setTimeout(() => setActivePubkey(null), 200);
  }, []);

  return (
    <ProfileModalContext.Provider value={{ openProfile, closeProfile }}>
      {children}
      <ProfileModalDialog
        pubkey={activePubkey}
        isOpen={isOpen}
        onClose={closeProfile}
        onViewThread={onViewThread}
      />
    </ProfileModalContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Tappable wrapper — opens profile modal for a given pubkey
// ---------------------------------------------------------------------------

interface TappableProfileProps {
  pubkey: string;
  children: React.ReactNode;
  style?: object;
}

export function TappableProfile({ pubkey, children, style }: TappableProfileProps) {
  const { openProfile } = useProfileModal();
  return (
    <TouchableOpacity onPress={() => openProfile(pubkey)} activeOpacity={0.7} style={style}>
      {children}
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// The modal dialog itself
// ---------------------------------------------------------------------------

interface ProfileModalDialogProps {
  pubkey: string | null;
  isOpen: boolean;
  onClose: () => void;
  onViewThread?: (eventId: string) => void;
}

function ProfileModalDialog({ pubkey, isOpen, onClose, onViewThread }: ProfileModalDialogProps) {
  const { data: author, isLoading } = useAuthor(pubkey || '');
  const { nostr } = useNostr();
  const { pubkey: myPubkey, signer } = useAuth();
  const queryClient = useQueryClient();
  const { fetchRelaysForPubkey } = useNip65Relays();
  const { data: contacts } = useContacts(myPubkey ?? undefined);
  const { isMuted, mute, unmute } = useMuteList();
  const { mutateAsync: publish } = useNostrPublish();

  const [copied, setCopied] = useState(false);
  const [relaysOpen, setRelaysOpen] = useState(false);
  const [relays, setRelays] = useState<string[]>([]);
  const [relaysLoading, setRelaysLoading] = useState(false);
  const relaysFetchedRef = useRef(false);
  const [followLoading, setFollowLoading] = useState(false);

  if (!pubkey) return null;

  const metadata = author?.metadata;
  const displayName = metadata?.display_name || metadata?.name || genUserName(pubkey);
  const npub = nip19.npubEncode(pubkey);
  const shortNpub = `${npub.slice(0, 16)}...${npub.slice(-8)}`;

  const nip05Display = metadata?.nip05?.startsWith('_@')
    ? metadata.nip05.slice(2)
    : metadata?.nip05;

  const websiteDisplay = metadata?.website
    ? (() => {
        try {
          const url = new URL(metadata.website);
          const fullPath = url.hostname + url.pathname.replace(/\/$/, '');
          return fullPath.length <= 40 ? fullPath : url.hostname;
        } catch {
          return metadata.website!.length <= 40 ? metadata.website : metadata.website!.slice(0, 37) + '...';
        }
      })()
    : null;

  const isMe = myPubkey === pubkey;
  const isFollowing = contacts?.includes(pubkey) ?? false;
  const isMutedUser = isMuted(pubkey);

  const copyNpub = () => {
    Clipboard.setString(npub);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRelaysToggle = () => {
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
  };

  const handleFollow = async () => {
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
  };

  const handleUnfollow = () => {
    if (!myPubkey || !signer || !contacts) return;
    Alert.alert('Unfollow', `Stop following ${displayName}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unfollow',
        style: 'destructive',
        onPress: async () => {
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
  };

  const handleToggleMute = () => {
    if (isMutedUser) {
      unmute(pubkey);
      Alert.alert('Unmuted', `${displayName} is now visible`);
    } else {
      Alert.alert('Mute', `Mute ${displayName}? Their notes will be hidden.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mute',
          style: 'destructive',
          onPress: () => {
            mute(pubkey);
            Alert.alert('Muted', `${displayName} is now muted`);
          },
        },
      ]);
    }
  };

  return (
    <Modal visible={isOpen} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.modalContainer}>
          {/* Close button */}
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>

          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {/* Banner */}
            {metadata?.banner && /^https?:\/\//.test(metadata.banner) ? (
              <SizeGuardedImage uri={metadata.banner} style={styles.banner} type="image" />
            ) : (
              <View style={styles.bannerPlaceholder} />
            )}

            {/* Profile content */}
            <View style={styles.profileContent}>
              {/* Avatar */}
              <View style={styles.avatarContainer}>
                {isLoading ? (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <ActivityIndicator color="#b3b3b3" />
                  </View>
                ) : metadata?.picture ? (
                  <SizeGuardedImage uri={metadata.picture} style={styles.avatar} type="avatar" />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarLetter}>
                      {displayName.slice(0, 2).toUpperCase()}
                    </Text>
                  </View>
                )}
              </View>

              {isLoading ? (
                <View style={styles.loadingBlock}>
                  <View style={styles.skeletonLine} />
                  <View style={[styles.skeletonLine, { width: '60%' }]} />
                </View>
              ) : (
                <>
                  {/* Name + NIP-05 */}
                  <View style={styles.nameRow}>
                    <Text style={styles.displayName} numberOfLines={1}>
                      {displayName}
                    </Text>
                    {metadata?.bot && (
                      <View style={styles.botBadge}>
                        <Text style={styles.botBadgeText}>BOT</Text>
                      </View>
                    )}
                  </View>

                  {metadata?.nip05 && (
                    <View style={styles.nip05Row}>
                      <Text style={styles.nip05Check}>✓</Text>
                      <Text style={styles.nip05Text} numberOfLines={1}>{nip05Display}</Text>
                    </View>
                  )}

                  {/* npub with copy */}
                  <TouchableOpacity onPress={copyNpub} style={styles.npubRow}>
                    <Text style={styles.npubText}>{shortNpub}</Text>
                    <Text style={styles.copyIcon}>{copied ? '✓' : '⧉'}</Text>
                  </TouchableOpacity>

                  {/* About */}
                  {metadata?.about && (
                    <View style={styles.aboutContainer}>
                      <ProfileAbout about={metadata.about} pubkey={pubkey} />
                    </View>
                  )}

                  {/* Website + Lightning */}
                  {(metadata?.website || metadata?.lud16) && (
                    <View style={styles.linksRow}>
                      {metadata?.website && /^https?:\/\//.test(metadata.website) && (
                        <TouchableOpacity
                          onPress={() => Linking.openURL(metadata.website!)}
                          style={styles.linkItem}
                        >
                          <Text style={styles.websiteText} numberOfLines={1}>
                            ⊕ {websiteDisplay}
                          </Text>
                        </TouchableOpacity>
                      )}
                      {metadata?.lud16 && (
                        <Text style={styles.lightningText} numberOfLines={1}>
                          ⚡ {metadata.lud16}
                        </Text>
                      )}
                    </View>
                  )}

                  {/* Relays */}
                  <TouchableOpacity style={styles.relayToggle} onPress={handleRelaysToggle}>
                    <Text style={styles.relayToggleText}>
                      {relaysOpen ? '▾' : '▸'} Relays
                    </Text>
                    {!relaysLoading && relays.length > 0 && (
                      <View style={styles.relayBadge}>
                        <Text style={styles.relayBadgeText}>{relays.length}</Text>
                      </View>
                    )}
                  </TouchableOpacity>

                  {relaysOpen && (
                    <View style={styles.relayList}>
                      {relaysLoading ? (
                        <ActivityIndicator color="#b3b3b3" size="small" />
                      ) : relays.length > 0 ? (
                        relays.map((relay, i) => (
                          <Text key={i} style={styles.relayItem} numberOfLines={1}>
                            {relay.replace('wss://', '').replace('ws://', '').replace(/\/$/, '')}
                          </Text>
                        ))
                      ) : (
                        <Text style={styles.relayEmpty}>No relays published</Text>
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

                  {/* Recent notes */}
                  <RecentNotes pubkey={pubkey} onViewThread={onViewThread} />
                </>
              )}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Recent notes sub-component
// ---------------------------------------------------------------------------

function RecentNotes({
  pubkey,
  onViewThread,
}: {
  pubkey: string;
  onViewThread?: (eventId: string) => void;
}) {
  const { nostr } = useNostr();

  const { data: notes, isLoading } = useQuery<NostrEvent[]>({
    queryKey: ['profile-recent-notes', pubkey],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1], authors: [pubkey], limit: 5 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      );
      return events
        .filter(e => !e.tags.some(t => t[0] === 'e'))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 5);
    },
    staleTime: 2 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <View style={styles.recentSection}>
        <Text style={styles.recentHeader}>Recent notes</Text>
        <View style={styles.skeletonNote} />
        <View style={styles.skeletonNote} />
      </View>
    );
  }

  if (!notes || notes.length === 0) return null;

  return (
    <View style={styles.recentSection}>
      <Text style={styles.recentHeader}>Recent notes</Text>
      {notes.map(note => (
        <TouchableOpacity
          key={note.id}
          style={styles.noteCard}
          onPress={() => onViewThread?.(note.id)}
          activeOpacity={onViewThread ? 0.7 : 1}
          disabled={!onViewThread}
        >
          <Text style={styles.noteTime}>{formatTimeAgo(note.created_at)}</Text>
          <NoteContent event={note} numberOfLines={3} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    backgroundColor: '#1f1f1f',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '90%',
    overflow: 'hidden',
  },
  scrollContent: { flex: 1 },
  closeButton: {
    position: 'absolute',
    top: 8,
    right: 12,
    zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  // Banner
  banner: { width: '100%', height: 120 },
  bannerPlaceholder: { width: '100%', height: 100, backgroundColor: '#333' },

  // Profile content
  profileContent: { paddingHorizontal: 16, paddingBottom: 32 },

  // Avatar
  avatarContainer: { marginTop: -32, marginBottom: 10 },
  avatar: { width: 72, height: 72, borderRadius: 36, borderWidth: 3, borderColor: '#1f1f1f' },
  avatarFallback: { backgroundColor: '#444', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#b3b3b3', fontSize: 28, fontWeight: '600' },

  // Loading
  loadingBlock: { gap: 10, marginTop: 8 },
  skeletonLine: { height: 14, borderRadius: 7, backgroundColor: '#333', width: '50%' },

  // Name
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  displayName: { fontSize: 20, fontWeight: 'bold', color: '#f2f2f2', flexShrink: 1 },
  botBadge: { backgroundColor: '#333', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  botBadgeText: { fontSize: 10, color: '#b3b3b3', fontWeight: '600' },

  // NIP-05
  nip05Row: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  nip05Check: { color: '#a855f7', fontSize: 13, fontWeight: '600' },
  nip05Text: { color: '#a855f7', fontSize: 13, flexShrink: 1 },

  // npub
  npubRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  npubText: { fontFamily: 'monospace', fontSize: 12, color: '#b3b3b3' },
  copyIcon: { color: '#a855f7', fontSize: 13 },

  // About
  aboutContainer: { marginTop: 12 },

  // Links
  linksRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 10 },
  linkItem: { flexDirection: 'row', alignItems: 'center' },
  websiteText: { fontSize: 13, color: '#a855f7' },
  lightningText: { fontSize: 13, color: '#f59e0b' },

  // Relays
  relayToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
  },
  relayToggleText: { fontSize: 13, color: '#b3b3b3', fontWeight: '500' },
  relayBadge: { backgroundColor: '#333', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  relayBadgeText: { fontSize: 11, color: '#b3b3b3' },
  relayList: {
    backgroundColor: '#252525',
    borderRadius: 8,
    padding: 10,
    marginTop: 6,
  },
  relayItem: { fontFamily: 'monospace', fontSize: 12, color: '#b3b3b3', marginBottom: 3 },
  relayEmpty: { fontSize: 12, color: '#666', fontStyle: 'italic' },

  // Action buttons
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  actionBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1 },
  followBtn: { backgroundColor: '#f97316', borderColor: '#f97316' },
  followText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  unfollowBtn: { backgroundColor: 'transparent', borderColor: '#404040' },
  unfollowText: { color: '#b3b3b3', fontSize: 14, fontWeight: '500' },
  muteBtn: { backgroundColor: 'transparent', borderColor: '#404040' },
  muteText: { color: '#b3b3b3', fontSize: 14 },
  unmuteBtn: { backgroundColor: '#2a1a1a', borderColor: '#4a2020' },
  unmuteText: { color: '#ef4444', fontSize: 14 },

  // Recent notes
  recentSection: { marginTop: 16 },
  recentHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  skeletonNote: { height: 48, borderRadius: 8, backgroundColor: '#333', marginBottom: 6 },
  noteCard: {
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#404040',
  },
  noteTime: { fontSize: 11, color: '#b3b3b3', marginBottom: 4 },
});
