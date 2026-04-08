/**
 * Compose / publish a new note — modal screen.
 */
import { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { buildReplyTags } from '@core/noteClassifier';
import { useAuth } from '../lib/AuthContext';
import { useNostrPublish } from '../hooks/useNostrPublish';
import { EmojiPickerModal } from '../components/EmojiPicker';

interface ComposeScreenProps {
  onClose: () => void;
  /** If provided, the new note is a reply to this event */
  replyTo?: { id: string; pubkey: string; tags: string[][] };
}

export function ComposeScreen({ onClose, replyTo }: ComposeScreenProps) {
  const { pubkey } = useAuth();
  const { mutateAsync: publish, isPending: publishing } = useNostrPublish();
  const [content, setContent] = useState('');
  const [customEmojiTags, setCustomEmojiTags] = useState<string[][]>([]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // Track cursor position for emoji insertion (React Native equivalent of selectionStart)
  const cursorPosRef = useRef({ start: 0, end: 0 });

  const handleSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      cursorPosRef.current = e.nativeEvent.selection;
    },
    [],
  );

  /** Insert text at the current cursor position */
  const insertAtCursor = useCallback((text: string) => {
    const { start, end } = cursorPosRef.current;
    setContent(prev => {
      const next = prev.slice(0, start) + text + prev.slice(end);
      // Advance cursor past inserted text
      const newPos = start + text.length;
      cursorPosRef.current = { start: newPos, end: newPos };
      return next;
    });
  }, []);

  const handleSelectEmoji = useCallback((emoji: string) => {
    insertAtCursor(emoji);
  }, [insertAtCursor]);

  const handleSelectCustomEmoji = useCallback((shortcode: string, url: string) => {
    insertAtCursor(`:${shortcode}:`);
    setCustomEmojiTags(prev => {
      if (prev.some(t => t[1] === shortcode)) return prev; // dedup
      return [...prev, ['emoji', shortcode, url]];
    });
  }, [insertAtCursor]);

  const handlePublish = async () => {
    const text = content.trim();
    if (!text || !pubkey) return;

    try {
      const tags: string[][] = [];

      // NIP-10 reply tags (shared with web via @core)
      if (replyTo) {
        tags.push(...buildReplyTags(replyTo as import('@nostrify/nostrify').NostrEvent));
      }

      // Extract hashtags
      const hashtags = text.match(/(?<!\w)#(\w{1,64})(?!\w)/g);
      if (hashtags) {
        for (const tag of new Set(hashtags)) {
          tags.push(['t', tag.slice(1).toLowerCase()]);
        }
      }

      // Add custom emoji tags (NIP-30) — validate format before publishing
      for (const tag of customEmojiTags) {
        if (tag.length >= 3 && tag[0] === 'emoji' && /^[\w-]{1,64}$/.test(tag[1]) && tag[2].startsWith('https://')) {
          tags.push(tag);
        }
      }

      await publish({
        kind: 1,
        content: text,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });

      setCustomEmojiTags([]);
      onClose();
    } catch (err: unknown) {
      Alert.alert('Publish failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  if (!pubkey) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.center}>
          <Text style={styles.emptyText}>Log in to publish notes</Text>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.publishBtn, (!content.trim() || publishing) && styles.publishBtnDisabled]}
          onPress={handlePublish}
          disabled={!content.trim() || publishing}
        >
          {publishing ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.publishText}>Publish</Text>
          )}
        </TouchableOpacity>
      </View>

      {replyTo && (
        <Text style={styles.replyLabel}>Replying to a note</Text>
      )}

      {/* Editor */}
      <TextInput
        style={styles.editor}
        placeholder="What's on your mind?"
        placeholderTextColor="#444"
        value={content}
        onChangeText={setContent}
        onSelectionChange={handleSelectionChange}
        multiline
        autoFocus
        maxLength={5000}
        textAlignVertical="top"
      />

      {/* Toolbar: emoji button + char count */}
      <View style={styles.toolbar}>
        <TouchableOpacity
          style={styles.emojiBtn}
          onPress={() => setShowEmojiPicker(true)}
          accessibilityLabel="Open emoji picker"
        >
          <Text style={styles.emojiBtnText}>😀</Text>
        </TouchableOpacity>
        <Text style={styles.charCount}>{content.length} / 5000</Text>
      </View>

      {/* Emoji picker modal */}
      <EmojiPickerModal
        visible={showEmojiPicker}
        onClose={() => setShowEmojiPicker(false)}
        onSelectEmoji={handleSelectEmoji}
        onSelectCustomEmoji={handleSelectCustomEmoji}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#404040',
  },
  cancelText: { color: '#b3b3b3', fontSize: 16 },
  publishBtn: {
    backgroundColor: '#f97316',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
  },
  publishBtnDisabled: { opacity: 0.5 },
  publishText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  replyLabel: { color: '#b3b3b3', fontSize: 12, paddingHorizontal: 16, paddingTop: 8 },
  editor: {
    flex: 1,
    color: '#f2f2f2',
    fontSize: 16,
    lineHeight: 22,
    padding: 16,
    paddingTop: 12,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#333',
  },
  emojiBtn: {
    padding: 4,
    borderRadius: 6,
  },
  emojiBtnText: {
    fontSize: 24,
    lineHeight: 28,
  },
  charCount: { color: '#666', fontSize: 12 },
  emptyText: { color: '#666', fontSize: 15 },
});
