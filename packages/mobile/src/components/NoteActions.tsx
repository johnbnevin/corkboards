/**
 * Note action bar — like, repost, reply, bookmark, zap.
 * Mirrors the web version's interaction patterns.
 */
import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Platform, TextInput, Modal } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { useZap } from '../hooks/useZap';

interface NoteActionsProps {
  event: NostrEvent;
  onReply?: () => void;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
}

export function NoteActions({ event, onReply, isBookmarked = false, onToggleBookmark }: NoteActionsProps) {
  const { nostr } = useNostr();
  const { pubkey, signer } = useAuth();
  const [liked, setLiked] = useState(false);
  const [reposted, setReposted] = useState(false);
  const [zapModalVisible, setZapModalVisible] = useState(false);
  const [zapAmount, setZapAmount] = useState('21');

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

  const handleLike = async () => {
    if (!signer) return;
    setLiked(true);
    try {
      const template = {
        kind: 7,
        content: '+',
        tags: [
          ['e', event.id],
          ['p', event.pubkey],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };
      const signed = await signer.signEvent(template);
      await nostr.event(signed);
    } catch {
      setLiked(false);
    }
  };

  const handleRepost = async () => {
    if (!signer) return;
    setReposted(true);
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
    } catch {
      setReposted(false);
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
        >
          <Text style={[styles.icon, reposted && styles.activeRepost]}>↻</Text>
          {reposted && <Text style={styles.repostLabel}>reposted</Text>}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.action}
          onPress={() => requireAuth(handleLike)}
        >
          <Text style={[styles.icon, liked && styles.activeLike]}>
            {liked ? '♥' : '♡'}
          </Text>
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
  repostLabel: { fontSize: 11, color: '#22c55e' },
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
