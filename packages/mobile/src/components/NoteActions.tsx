/**
 * Note action bar — like, repost, reply, bookmark, zap.
 * Mirrors the web version's interaction patterns.
 */
import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Platform, TextInput, Modal } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { useZap } from '../hooks/useZap';
import { useNoteEngagement } from '../hooks/useNoteEngagement';
import { EmojiPickerModal } from './EmojiPicker';

interface NoteActionsProps {
  event: NostrEvent;
  onReply?: () => void;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
}

export function NoteActions({ event, onReply, isBookmarked = false, onToggleBookmark }: NoteActionsProps) {
  const { nostr } = useNostr();
  const { pubkey, signer } = useAuth();
  const queryClient = useQueryClient();
  const { data: engagement } = useNoteEngagement(event.id);
  // Optimistic local overrides; fall back to the real relay-derived state.
  const [likedOverride, setLikedOverride] = useState<boolean | null>(null);
  const [repostedOverride, setRepostedOverride] = useState<boolean | null>(null);
  const [likePending, setLikePending] = useState(false);
  const [repostPending, setRepostPending] = useState(false);
  const [zapModalVisible, setZapModalVisible] = useState(false);
  const [zapAmount, setZapAmount] = useState('21');
  const [emojiPickerVisible, setEmojiPickerVisible] = useState(false);

  // Real relay state wins once it confirms the action; the optimistic override
  // only fills the gap until the engagement query refetches (and is reverted in
  // the publish catch on failure), so no clearing effect is needed.
  const liked = engagement?.liked || (likedOverride ?? false);
  const reposted = engagement?.reposted || (repostedOverride ?? false);
  const likeCount = (engagement?.likeCount ?? 0) + (likedOverride && !engagement?.liked ? 1 : 0);
  const repostCount = (engagement?.repostCount ?? 0) + (repostedOverride && !engagement?.reposted ? 1 : 0);

  const { zap, isZapping, error: zapError, clearError: clearZapError, lud16, isConnected: nwcConnected } = useZap(event);

  // Show zap errors via Alert; clear immediately so the same error can re-fire next time.
  useEffect(() => {
    if (zapError) {
      clearZapError();
      Alert.alert('Zap failed', zapError);
    }
  }, [zapError, clearZapError]);

  const requireAuth = (action: () => void) => {
    if (!pubkey || !signer) {
      Alert.alert('Login required', 'Log in from Settings to interact with notes');
      return;
    }
    action();
  };

  // Publish a kind-7 reaction. `content` is '+' for a plain like or an emoji /
  // ':shortcode:' for an emoji reaction; `emojiTag` carries the NIP-30 custom
  // emoji definition when applicable.
  const publishReaction = async (content: string, emojiTag?: string[]) => {
    if (!signer || likePending) return;
    setLikePending(true);
    setLikedOverride(true);
    try {
      const tags: string[][] = [['e', event.id], ['p', event.pubkey]];
      if (emojiTag) tags.push(emojiTag);
      const signed = await signer.signEvent({
        kind: 7,
        content,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });
      await nostr.event(signed);
      queryClient.invalidateQueries({ queryKey: ['note-engagement', event.id] });
    } catch {
      setLikedOverride(null);
    } finally {
      setLikePending(false);
    }
  };

  const handleLike = async () => {
    // Guard against double-publish: already liked, or a publish is in flight.
    if (!signer || liked || likePending) return;
    await publishReaction('+');
  };

  const handleRepost = async () => {
    if (!signer || reposted || repostPending) return;
    setRepostPending(true);
    setRepostedOverride(true);
    try {
      const template = {
        kind: 6,
        content: JSON.stringify(event),
        tags: [
          ['e', event.id],
          ['p', event.pubkey],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };
      const signed = await signer.signEvent(template);
      await nostr.event(signed);
      queryClient.invalidateQueries({ queryKey: ['note-engagement', event.id] });
    } catch {
      setRepostedOverride(null);
    } finally {
      setRepostPending(false);
    }
  };

  const handleZapPress = () => {
    if (!nwcConnected) {
      Alert.alert('No wallet', 'Connect a Lightning wallet in Settings to send zaps.');
      return;
    }
    if (!lud16) {
      Alert.alert('No lightning address', 'This user has no lightning address set.');
      return;
    }
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'Zap amount',
        'Enter amount in sats:',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Zap ⚡',
            onPress: (value: string | undefined) => {
              const sats = parseInt(value || '21', 10);
              if (!isNaN(sats) && sats > 0) {
                zap(sats).catch(() => { /* error shown via effect */ });
              }
            },
          },
        ],
        'plain-text',
        '21',
        'number-pad',
      );
    } else {
      setZapModalVisible(true);
    }
  };

  const handleZapConfirm = () => {
    const sats = parseInt(zapAmount, 10);
    if (!isNaN(sats) && sats > 0) {
      setZapModalVisible(false);
      zap(sats).catch(() => { /* error shown via effect */ });
    }
  };

  return (
    <>
      <View style={styles.bar}>
        <TouchableOpacity
          style={styles.action}
          onPress={() => requireAuth(() => onReply?.())}
        >
          <Text style={styles.icon}>💬</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.action}
          onPress={() => requireAuth(handleRepost)}
          disabled={repostPending}
        >
          <Text style={[styles.icon, reposted && styles.activeRepost]}>↻</Text>
          {repostCount > 0 && <Text style={[styles.count, reposted && styles.activeRepost]}>{repostCount}</Text>}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.action}
          onPress={() => requireAuth(handleLike)}
          onLongPress={() => requireAuth(() => setEmojiPickerVisible(true))}
          delayLongPress={300}
          disabled={likePending}
        >
          <Text style={[styles.icon, liked && styles.activeLike]}>
            {liked ? '♥' : '♡'}
          </Text>
          {likeCount > 0 && <Text style={[styles.count, liked && styles.activeLike]}>{likeCount}</Text>}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.action}
          onPress={() => requireAuth(() => onToggleBookmark?.())}
        >
          <Text style={[styles.icon, isBookmarked && styles.activeBookmark]}>
            {isBookmarked ? '★' : '☆'}
          </Text>
        </TouchableOpacity>

        {/* Zap button — shown when author has a lightning address */}
        {lud16 ? (
          <TouchableOpacity
            style={styles.action}
            onPress={() => requireAuth(handleZapPress)}
            disabled={isZapping}
          >
            {isZapping ? (
              <ActivityIndicator size="small" color="#f59e0b" />
            ) : (
              <Text style={[styles.icon, styles.zapIcon]}>⚡</Text>
            )}
            {(engagement?.zapCount ?? 0) > 0 && <Text style={[styles.count, styles.zapIcon]}>{engagement?.zapCount}</Text>}
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Android zap amount modal */}
      <Modal visible={zapModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Zap amount (sats)</Text>
            <TextInput
              style={styles.modalInput}
              value={zapAmount}
              onChangeText={setZapAmount}
              keyboardType="number-pad"
              autoFocus
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setZapModalVisible(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirm} onPress={handleZapConfirm}>
                <Text style={styles.modalConfirmText}>Zap ⚡</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Long-press the like button to react with a standard or custom (NIP-30) emoji */}
      <EmojiPickerModal
        visible={emojiPickerVisible}
        onClose={() => setEmojiPickerVisible(false)}
        onSelectEmoji={(emoji) => publishReaction(emoji)}
        onSelectCustomEmoji={(shortcode, url) => publishReaction(`:${shortcode}:`, ['emoji', shortcode, url])}
      />
    </>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', marginTop: 10, gap: 20, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#404040' },
  action: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  icon: { fontSize: 16, color: '#b3b3b3' },
  activeLike: { color: '#ec4899' },
  activeRepost: { color: '#22c55e' },
  activeBookmark: { color: '#f97316' },
  zapIcon: { color: '#f59e0b' },
  count: { fontSize: 12, color: '#b3b3b3' },
  // Android zap modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center' },
  modalCard: { backgroundColor: '#2a2a2a', borderRadius: 12, padding: 20, width: 260, gap: 12 },
  modalTitle: { color: '#f2f2f2', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  modalInput: { backgroundColor: '#333', color: '#f2f2f2', borderRadius: 8, padding: 12, fontSize: 18, textAlign: 'center' },
  modalButtons: { flexDirection: 'row', gap: 8 },
  modalCancel: { flex: 1, padding: 12, borderRadius: 8, backgroundColor: '#333', alignItems: 'center' },
  modalCancelText: { color: '#b3b3b3', fontSize: 14 },
  modalConfirm: { flex: 1, padding: 12, borderRadius: 8, backgroundColor: '#333', alignItems: 'center' },
  modalConfirmText: { color: '#f59e0b', fontSize: 14, fontWeight: '600' },
});
