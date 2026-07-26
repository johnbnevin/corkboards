/**
 * Note action bar — like, repost, reply, bookmark, zap.
 * Mirrors the web version's interaction patterns.
 */
import { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Modal } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import * as Clipboard from 'expo-clipboard';
import { useNostr, getRelayCache, getUserRelays, FALLBACK_RELAYS } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { ComposeScreen } from '../screens/ComposeScreen';
import { useZap } from '../hooks/useZap';
import { useNoteEngagement } from '../hooks/useNoteEngagement';
import { EmojiPickerModal } from './EmojiPicker';
import { ZapDialog } from './ZapDialog';
import { recordUserZap, hasUserZapped } from '../lib/userZapCache';

interface NoteActionsProps {
  event: NostrEvent;
  onReply?: () => void;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
  /** NIP-51 pin state; when `onTogglePin` is provided the pin button renders. */
  isPinned?: boolean;
  onTogglePin?: () => void;
  /** Called after a deletion request is published, so the parent can optimistically
   *  remove the card. Optional — deletion still publishes without it. */
  onDeleted?: () => void;
}

export function NoteActions({ event, onReply, isBookmarked = false, onToggleBookmark, isPinned = false, onTogglePin, onDeleted }: NoteActionsProps) {
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
  const [emojiPickerVisible, setEmojiPickerVisible] = useState(false);
  const [quoting, setQuoting] = useState(false);
  // Optimistic zapped flag — seeded from the session cache so a note the user
  // already zapped shows active immediately, before the zap receipt is fetched.
  const [zappedOverride, setZappedOverride] = useState<boolean>(() => hasUserZapped(event.id));
  const zapped = zappedOverride || (engagement?.zapCount ?? 0) > 0;

  // Real relay state wins once it confirms the action; the optimistic override
  // only fills the gap until the engagement query refetches (and is reverted in
  // the publish catch on failure), so no clearing effect is needed.
  const liked = engagement?.liked || (likedOverride ?? false);
  const reposted = engagement?.reposted || (repostedOverride ?? false);
  const likeCount = (engagement?.likeCount ?? 0) + (likedOverride && !engagement?.liked ? 1 : 0);
  const repostCount = (engagement?.repostCount ?? 0) + (repostedOverride && !engagement?.reposted ? 1 : 0);

  // Only `canZap` — whether to show the button at all. The zap itself, its
  // progress spinner and its errors all now live inside ZapDialog, which holds
  // its own useZap; reading those from this instance would show a spinner that
  // never spins and an error that never fires.
  const { canZap } = useZap(event);

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
  // useCallback so this reads as an event handler rather than a value computed
  // during render — otherwise the `Date.now()` below trips
  // react-hooks/purity, which can't see that the body only ever runs from a tap.
  const publishReaction = useCallback(async (content: string, emojiTag?: string[]) => {
    if (!signer || likePending) return;
    setLikePending(true);
    setLikedOverride(true);
    try {
      // NIP-25: reacted event (last e) with a relay hint + author (p) + kind (k),
      // plus an a-coordinate for addressable targets. Parity with web.
      const relayHint = getRelayCache(event.pubkey)?.[0] || FALLBACK_RELAYS[0] || '';
      const tags: string[][] = [['e', event.id, relayHint], ['p', event.pubkey], ['k', String(event.kind)]];
      if (event.kind >= 30000 && event.kind < 40000) {
        const d = event.tags.find(t => t[0] === 'd')?.[1] ?? '';
        tags.push(['a', `${event.kind}:${event.pubkey}:${d}`, relayHint]);
      }
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
  }, [signer, likePending, nostr, queryClient, event.id, event.pubkey, event.kind, event.tags]);

  const handleLike = async () => {
    // Guard against double-publish: already liked, or a publish is in flight.
    if (!signer || liked || likePending) return;
    await publishReaction('+');
  };

  // Tap a grouped reaction chip to add that reaction. If the user already
  // reacted with it (or a like publish is mid-flight) this is a no-op, matching
  // handleLike's duplicate-publish guard. `:shortcode:` custom emoji can't be
  // re-published from the badge alone (no NIP-30 url), so they're display-only.
  const handleChipPress = async (group: { emoji: string; reacted: boolean }) => {
    if (!signer || group.reacted || likePending) return;
    if (group.emoji === '❤️') return publishReaction('+');
    if (group.emoji === '👎') return publishReaction('-');
    if (/^:[^:]+:$/.test(group.emoji)) return; // custom emoji — display only
    await publishReaction(group.emoji);
  };

  const handleRepost = async () => {
    if (!signer || reposted || repostPending) return;
    setRepostPending(true);
    setRepostedOverride(true);
    try {
      // NIP-18: kind 6 reposts kind-1 notes; anything else is a generic repost
      // (kind 16) and must carry a ['k', kind] tag. The e tag carries a relay
      // hint pointing at where the original can be found. (Mirrors web
      // ComposeDialog handleRepost.)
      const authorRelays = getRelayCache(event.pubkey);
      const userRelays = getUserRelays();
      const relayHint = authorRelays[0] || userRelays.write[0] || FALLBACK_RELAYS[0] || '';

      const isKind1 = event.kind === 1;
      const tags: string[][] = [
        ['e', event.id, relayHint],
        ['p', event.pubkey],
      ];
      if (!isKind1) tags.push(['k', String(event.kind)]);

      const template = {
        kind: isKind1 ? 6 : 16,
        content: JSON.stringify(event),
        tags,
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

  // Repost button: offer plain repost or quote (compose with embedded note),
  // mirroring web's repost dialog which has both options.
  const handleRepostPress = () => {
    Alert.alert('Repost', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Quote', onPress: () => setQuoting(true) },
      { text: 'Repost', onPress: () => { handleRepost(); } },
    ]);
  };

  // Record a paid zap optimistically so the zap icon lights up right away
  // (mirrors web's recordUserZap in NoteCard).
  const handleZapped = useCallback(() => {
    recordUserZap(event.id);
    setZappedOverride(true);
    queryClient.invalidateQueries({ queryKey: ['note-engagement', event.id] });
  }, [event.id, queryClient]);

  // The shared ZapDialog handles everything from here: presets, a custom
  // amount, a message, and — with no wallet connected — a QR code for an
  // external one. This used to be a bare amount prompt that refused to open at
  // all without NWC, which left anyone whose sats live in another app with no
  // way to zap and no way to find out why.
  const handleZapPress = () => {
    if (!canZap) {
      Alert.alert('No lightning address', 'This user has no lightning address set.');
      return;
    }
    setZapModalVisible(true);
  };

  const reactionGroups = engagement?.reactionGroups ?? [];

  // Only the author can request deletion of their own note.
  const isOwnNote = !!pubkey && event.pubkey === pubkey;

  // Copy the note's NIP-19 id (note1…) — no auth needed, it's a public id.
  const handleCopyId = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(nip19.noteEncode(event.id));
      Alert.alert('Copied', 'Note ID copied to clipboard');
    } catch {
      Alert.alert('Copy failed', 'Could not copy the note ID');
    }
  }, [event.id]);

  // NIP-09: publish a kind-5 deletion request for the user's own note. Framed as
  // a *request* — relays may refuse and copies others already fetched can persist
  // — so we never claim the note is gone. Parity with web's DeleteNoteButton
  // ({ kind: 5, content: 'Deleted by author', tags: [['e', id]] }).
  const handleDelete = useCallback(() => {
    if (!signer) return;
    Alert.alert(
      'Request deletion?',
      'This asks relays to delete your note (NIP-09). Relays may refuse, and copies others already downloaded can persist.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Request deletion',
          style: 'destructive',
          onPress: async () => {
            try {
              const signed = await signer.signEvent({
                kind: 5,
                content: 'Deleted by author',
                tags: [['e', event.id], ['k', String(event.kind)]],
                created_at: Math.floor(Date.now() / 1000),
              });
              await nostr.event(signed);
              queryClient.invalidateQueries({ queryKey: ['note-engagement', event.id] });
              onDeleted?.();
              Alert.alert('Deletion requested', 'Your note’s deletion request was published to relays.');
            } catch {
              Alert.alert('Deletion failed', 'Could not publish the deletion request. Please try again.');
            }
          },
        },
      ],
    );
  }, [signer, nostr, queryClient, event.id, event.kind, onDeleted]);

  return (
    <>
      {reactionGroups.length > 0 && (
        <View style={styles.reactionChips}>
          {reactionGroups.map((g) => (
            <TouchableOpacity
              key={g.emoji}
              style={[styles.chip, g.reacted && styles.chipActive]}
              onPress={() => requireAuth(() => handleChipPress(g))}
              disabled={likePending}
            >
              <Text style={styles.chipEmoji}>{g.emoji}</Text>
              <Text style={[styles.chipCount, g.reacted && styles.chipCountActive]}>{g.count}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.bar}>
        <TouchableOpacity
          style={styles.action}
          onPress={() => requireAuth(() => onReply?.())}
        >
          <Text style={styles.icon}>💬</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.action}
          onPress={() => requireAuth(handleRepostPress)}
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

        <TouchableOpacity style={styles.action} onPress={handleCopyId} accessibilityLabel="Copy note ID">
          <Text style={styles.icon}>🔗</Text>
        </TouchableOpacity>

        {/* Pin to your board (NIP-51 kind 10001) — faded when not pinned. */}
        {onTogglePin ? (
          <TouchableOpacity
            style={styles.action}
            onPress={() => requireAuth(() => onTogglePin())}
            accessibilityLabel={isPinned ? 'Unpin from your board' : 'Pin to your board'}
          >
            <Text style={[styles.icon, !isPinned && styles.pinInactive]}>📌</Text>
          </TouchableOpacity>
        ) : null}

        {/* Zap button — shown when author has a lightning address (lud16 or lud06) */}
        {canZap ? (
          <TouchableOpacity
            style={styles.action}
            onPress={() => requireAuth(handleZapPress)}
          >
            <Text style={[styles.icon, styles.zapIcon, zapped && styles.activeZap]}>⚡</Text>
            {(engagement?.zapCount ?? 0) > 0 && <Text style={[styles.count, styles.zapIcon, zapped && styles.activeZap]}>{engagement?.zapCount}</Text>}
          </TouchableOpacity>
        ) : null}

        {/* Request deletion (NIP-09) — only on the user's own notes. */}
        {isOwnNote ? (
          <TouchableOpacity
            style={styles.action}
            onPress={handleDelete}
            accessibilityLabel="Request deletion from relays"
          >
            <Text style={[styles.icon, styles.deleteIcon]}>🗑</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Zap dialog — the same one the thread and saved screens use */}
      <ZapDialog
        note={event}
        visible={zapModalVisible}
        onClose={() => setZapModalVisible(false)}
        onZapped={handleZapped}
      />

      {/* Quote compose modal */}
      <Modal visible={quoting} animationType="slide" onRequestClose={() => setQuoting(false)}>
        <ComposeScreen
          onClose={() => setQuoting(false)}
          quotedEvent={{ id: event.id, pubkey: event.pubkey, tags: event.tags, content: event.content, kind: event.kind }}
        />
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
  activeZap: { color: '#f59e0b', fontWeight: '700' },
  deleteIcon: { color: '#ef4444' },
  pinInactive: { opacity: 0.4 },
  count: { fontSize: 12, color: '#b3b3b3' },
  // Grouped emoji reaction chips (mirrors web's ReactionBadges)
  reactionChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12,
    backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040',
  },
  chipActive: { backgroundColor: '#3a2a33', borderColor: '#ec4899' },
  chipEmoji: { fontSize: 13, color: '#f2f2f2' },
  chipCount: { fontSize: 11, color: '#b3b3b3' },
  chipCountActive: { color: '#ec4899', fontWeight: '600' },
});
