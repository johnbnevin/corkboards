/**
 * InlineReplyComposer — compact reply input that appears inline within a thread.
 *
 * Shows who you're replying to, a text input, and send/cancel buttons.
 * Mirrors web's InlineReplyComposer adapted for React Native.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { NostrEvent } from '@nostrify/nostrify';
import { buildReplyTags } from '@core/noteClassifier';
import { getRelayCache, FALLBACK_RELAYS } from '../../lib/NostrProvider';
import { useNostrPublish } from '../../hooks/useNostrPublish';
import { useAuthor } from '../../hooks/useAuthor';
import { useUploadFile } from '../../hooks/useUploadFile';
import { genUserName } from '@core/genUserName';
import { CombinedEmojiPickerModal } from '../compose/CombinedEmojiPicker';

interface InlineReplyComposerProps {
  replyTo: NostrEvent;
  onCancel: () => void;
  onPublished: (event: NostrEvent) => void;
}

export function InlineReplyComposer({
  replyTo,
  onCancel,
  onPublished,
}: InlineReplyComposerProps) {
  const [content, setContent] = useState('');
  const [customEmojiTags, setCustomEmojiTags] = useState<string[][]>([]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const { mutate: publish, isPending } = useNostrPublish();
  const { mutateAsync: uploadFile, isPending: uploading } = useUploadFile();
  const inputRef = useRef<TextInput>(null);
  const { data: author } = useAuthor(replyTo.pubkey);
  const displayName =
    author?.metadata?.display_name ||
    author?.metadata?.name ||
    genUserName(replyTo.pubkey);

  // Track cursor position for emoji insertion
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
    setContent((prev) => {
      const next = prev.slice(0, start) + text + prev.slice(end);
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
    setCustomEmojiTags((prev) => {
      if (prev.some((t) => t[1] === shortcode)) return prev; // dedup
      return [...prev, ['emoji', shortcode, url]];
    });
  }, [insertAtCursor]);

  // Pick an image, upload via Blossom, and append the URL to the reply text —
  // mirrors the compose screen's upload+append UX.
  const handlePickImage = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        allowsEditing: false,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      const response = await fetch(asset.uri);
      const blob = await response.blob();
      const fileName = asset.fileName || `image-${Date.now()}.jpg`;
      const file = new File([blob], fileName, { type: asset.mimeType || 'image/jpeg' });

      const tags = await uploadFile(file);
      const urlTag = tags.find((t: string[]) => t[0] === 'url');
      const oxTag = tags.find((t: string[]) => t[0] === 'ox');
      const uploadedUrl = urlTag?.[1] || oxTag?.[1];
      if (uploadedUrl) {
        setContent((prev) => (prev ? `${prev.trimEnd()}\n${uploadedUrl}` : uploadedUrl));
      }
    } catch (err) {
      Alert.alert('Upload failed', err instanceof Error ? err.message : 'Unknown error');
    }
  }, [uploadFile]);

  // Auto-focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 150);
  }, []);

  const handleSubmit = useCallback(() => {
    const text = content.trim();
    if (!text) return;

    const replyRelayHint = getRelayCache(replyTo.pubkey)?.[0] || FALLBACK_RELAYS[0] || '';
    const tags: string[][] = [...buildReplyTags(replyTo, replyRelayHint)];

    // Extract hashtags
    const hashtagMatches = text.matchAll(/#([a-zA-Z]\w*)/g);
    for (const match of hashtagMatches) {
      tags.push(['t', match[1].toLowerCase()]);
    }

    // Custom emoji tags (NIP-30) — validate format before publishing
    for (const tag of customEmojiTags) {
      if (tag.length >= 3 && tag[0] === 'emoji' && /^[\w-]{1,64}$/.test(tag[1]) && tag[2].startsWith('https://')) {
        tags.push(tag);
      }
    }

    publish(
      { kind: 1, content: text, tags, created_at: Math.floor(Date.now() / 1000) },
      {
        onSuccess: (event) => {
          setContent('');
          setCustomEmojiTags([]);
          onPublished(event);
        },
      },
    );
  }, [content, customEmojiTags, replyTo, publish, onPublished]);

  return (
    <View style={styles.container}>
      {/* Reply-to indicator */}
      <View style={styles.header}>
        <Text style={styles.replyLabel}>
          Replying to{' '}
          <Text style={styles.replyName}>{displayName}</Text>
        </Text>
        <TouchableOpacity onPress={onCancel} style={styles.cancelBtn}>
          <Text style={styles.cancelText}>X</Text>
        </TouchableOpacity>
      </View>

      {/* Input + send */}
      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder="Write your reply..."
          placeholderTextColor="#666"
          value={content}
          onChangeText={setContent}
          onSelectionChange={handleSelectionChange}
          multiline
          maxLength={2000}
        />
        <TouchableOpacity
          style={[
            styles.sendBtn,
            (!content.trim() || isPending || uploading) && styles.sendBtnDisabled,
          ]}
          onPress={handleSubmit}
          disabled={!content.trim() || isPending || uploading}
        >
          {isPending ? (
            <ActivityIndicator color="#f97316" size="small" />
          ) : (
            <Text style={styles.sendText}>Reply</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Toolbar: emoji + image attach */}
      <View style={styles.toolbar}>
        <TouchableOpacity
          style={styles.toolBtn}
          onPress={() => setShowEmojiPicker(true)}
          accessibilityLabel="Open emoji picker"
        >
          <Text style={styles.toolBtnText}>😀</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolBtn, uploading && styles.toolBtnDisabled]}
          onPress={handlePickImage}
          disabled={uploading}
          accessibilityLabel="Attach image"
        >
          {uploading ? (
            <ActivityIndicator color="#f97316" size="small" />
          ) : (
            <Text style={styles.toolBtnText}>📷</Text>
          )}
        </TouchableOpacity>
        {uploading && <Text style={styles.uploadingLabel}>Uploading…</Text>}
      </View>

      {/* Emoji picker modal (combined standard + custom) */}
      <CombinedEmojiPickerModal
        visible={showEmojiPicker}
        onClose={() => setShowEmojiPicker(false)}
        onSelectEmoji={handleSelectEmoji}
        onSelectCustomEmoji={handleSelectCustomEmoji}
      />
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: '#404040',
    backgroundColor: '#2a2a2a',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  replyLabel: { fontSize: 12, color: '#b3b3b3' },
  replyName: { color: '#f2f2f2', fontWeight: '600' },
  cancelBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#404040',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { color: '#b3b3b3', fontSize: 11, fontWeight: '700' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#1f1f1f',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
    color: '#f2f2f2',
    fontSize: 14,
    maxHeight: 100,
    minHeight: 38,
  },
  sendBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: '#f97316',
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  toolBtn: {
    padding: 4,
    borderRadius: 6,
  },
  toolBtnDisabled: { opacity: 0.5 },
  toolBtnText: {
    fontSize: 22,
    lineHeight: 26,
  },
  uploadingLabel: {
    color: '#b3b3b3',
    fontSize: 12,
    marginLeft: 4,
  },
});
