/**
 * Compose / publish a new note — modal screen.
 *
 * Features:
 * - Short note (kind 1) and long-form article (kind 30023) modes
 * - Quote mode with quoted note preview and q-tag
 * - Image preview thumbnails with removal
 * - Combined emoji picker (standard + custom NIP-30)
 * - Color-coded character count
 */
import { useState, useCallback, useRef, useMemo } from 'react';
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
  Image,
  ScrollView,
  Switch,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { buildReplyTags } from '@core/noteClassifier';
import { useAuth } from '../lib/AuthContext';
import { useNostrPublish } from '../hooks/useNostrPublish';
import { useUploadFile } from '../hooks/useUploadFile';
import { CombinedEmojiPickerModal } from '../components/compose/CombinedEmojiPicker';

interface ComposeScreenProps {
  onClose: () => void;
  /** If provided, the new note is a reply to this event */
  replyTo?: { id: string; pubkey: string; tags: string[][]; content?: string };
  /** If provided, the new note quotes this event */
  quotedEvent?: { id: string; pubkey: string; tags: string[][]; content?: string; kind?: number };
}

/** Character count color thresholds */
const CHAR_GREEN_MAX = 280;
const CHAR_YELLOW_MAX = 4500;
const CHAR_LIMIT = 5000;

function getCharCountColor(len: number): string {
  if (len <= CHAR_GREEN_MAX) return '#4ade80'; // green
  if (len <= CHAR_YELLOW_MAX) return '#facc15'; // yellow
  return '#ef4444'; // red
}

export function ComposeScreen({ onClose, replyTo, quotedEvent }: ComposeScreenProps) {
  const { pubkey } = useAuth();
  const { mutateAsync: publish, isPending: publishing } = useNostrPublish();
  const { mutateAsync: uploadFile, isPending: uploading } = useUploadFile();
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [isLongForm, setIsLongForm] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [customEmojiTags, setCustomEmojiTags] = useState<string[][]>([]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

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
    setContent(prev => {
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
    setCustomEmojiTags(prev => {
      if (prev.some(t => t[1] === shortcode)) return prev; // dedup
      return [...prev, ['emoji', shortcode, url]];
    });
  }, [insertAtCursor]);

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
        setImages(prev => [...prev, uploadedUrl]);
      }
    } catch (err) {
      Alert.alert('Upload failed', err instanceof Error ? err.message : 'Unknown error');
    }
  }, [uploadFile]);

  const removeImage = useCallback((url: string) => {
    setImages(prev => prev.filter(u => u !== url));
  }, []);

  const handlePublish = async () => {
    const text = content.trim();
    if (!text && images.length === 0) return;
    if (!pubkey) return;

    try {
      // Build final content: text + images + quote reference
      let finalContent = text;
      if (images.length > 0) {
        finalContent += '\n\n' + images.join('\n');
      }
      if (quotedEvent) {
        finalContent += `\n\nnostr:${quotedEvent.id}`;
      }

      const tags: string[][] = [];

      // NIP-10 reply tags (shared with web via @core)
      if (replyTo) {
        tags.push(...buildReplyTags(replyTo as import('@nostrify/nostrify').NostrEvent));
      }

      // Quote tags
      if (quotedEvent) {
        tags.push(['q', quotedEvent.id]);
        tags.push(['p', quotedEvent.pubkey]);
      }

      // Extract hashtags
      const hashtags = finalContent.match(/(?<!\w)#(\w{1,64})(?!\w)/g);
      if (hashtags) {
        for (const tag of new Set(hashtags)) {
          tags.push(['t', tag.slice(1).toLowerCase()]);
        }
      }

      // Long-form article specific tags
      if (isLongForm) {
        const dTag = `${Date.now()}`;
        tags.push(['d', dTag]);
        if (title.trim()) tags.push(['title', title.trim()]);
        tags.push(['published_at', Math.floor(Date.now() / 1000).toString()]);
      }

      // Add custom emoji tags (NIP-30) — validate format before publishing
      for (const tag of customEmojiTags) {
        if (tag.length >= 3 && tag[0] === 'emoji' && /^[\w-]{1,64}$/.test(tag[1]) && tag[2].startsWith('https://')) {
          tags.push(tag);
        }
      }

      const kind = isLongForm ? 30023 : 1;

      await publish({
        kind,
        content: finalContent,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });

      setCustomEmojiTags([]);
      onClose();
    } catch (err: unknown) {
      Alert.alert('Publish failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const charCountColor = useMemo(() => getCharCountColor(content.length), [content.length]);

  // Header title text
  const headerTitle = replyTo
    ? 'Reply'
    : quotedEvent
      ? 'Quote'
      : isLongForm
        ? 'New Article'
        : 'New Post';

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
        <Text style={styles.headerTitle}>{headerTitle}</Text>
        <TouchableOpacity
          style={[styles.publishBtn, (!content.trim() && images.length === 0 || publishing) && styles.publishBtnDisabled]}
          onPress={handlePublish}
          disabled={(!content.trim() && images.length === 0) || publishing}
        >
          {publishing ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.publishText}>Publish</Text>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scrollArea} keyboardShouldPersistTaps="handled">
        {/* Reply context */}
        {replyTo && (
          <View style={styles.contextBox}>
            <Text style={styles.contextLabel}>Replying to a note</Text>
            {replyTo.content ? (
              <Text style={styles.contextPreview} numberOfLines={2}>
                {replyTo.content.slice(0, 150)}
              </Text>
            ) : null}
          </View>
        )}

        {/* Quote context */}
        {quotedEvent && (
          <View style={[styles.contextBox, styles.quoteBox]}>
            <Text style={styles.contextLabel}>Quoting</Text>
            {quotedEvent.content ? (
              <Text style={styles.contextPreview} numberOfLines={4}>
                {quotedEvent.content.slice(0, 300)}
              </Text>
            ) : null}
          </View>
        )}

        {/* Long-form toggle (not for replies/quotes) */}
        {!replyTo && !quotedEvent && (
          <View style={styles.longFormToggle}>
            <Text style={styles.longFormLabel}>Long-form article</Text>
            <Switch
              value={isLongForm}
              onValueChange={setIsLongForm}
              trackColor={{ false: '#555', true: '#f97316' }}
              thumbColor={isLongForm ? '#fff' : '#ccc'}
            />
          </View>
        )}

        {/* Title field for long-form */}
        {isLongForm && (
          <TextInput
            style={styles.titleInput}
            placeholder="Article title..."
            placeholderTextColor="#555"
            value={title}
            onChangeText={setTitle}
            maxLength={200}
          />
        )}

        {/* Editor */}
        <TextInput
          style={styles.editor}
          placeholder={
            replyTo
              ? 'Write your reply...'
              : isLongForm
                ? 'Write your article...'
                : "What's on your mind?"
          }
          placeholderTextColor="#444"
          value={content}
          onChangeText={setContent}
          onSelectionChange={handleSelectionChange}
          multiline
          autoFocus
          maxLength={CHAR_LIMIT}
          textAlignVertical="top"
        />

        {/* Image previews */}
        {images.length > 0 && (
          <View style={styles.imageRow}>
            {images.map((url) => (
              <View key={url} style={styles.imageThumbWrapper}>
                <Image source={{ uri: url }} style={styles.imageThumb} />
                <TouchableOpacity
                  style={styles.imageRemoveBtn}
                  onPress={() => removeImage(url)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.imageRemoveText}>X</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Toolbar: emoji button + image button + char count */}
      <View style={styles.toolbar}>
        <View style={styles.toolbarLeft}>
          <TouchableOpacity
            style={styles.emojiBtn}
            onPress={() => setShowEmojiPicker(true)}
            accessibilityLabel="Open emoji picker"
          >
            <Text style={styles.emojiBtnText}>😀</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.emojiBtn, uploading && { opacity: 0.5 }]}
            onPress={handlePickImage}
            disabled={uploading}
            accessibilityLabel="Attach image"
          >
            {uploading ? (
              <ActivityIndicator color="#f97316" size="small" />
            ) : (
              <Text style={styles.emojiBtnText}>📷</Text>
            )}
          </TouchableOpacity>
        </View>
        <Text style={[styles.charCount, { color: charCountColor }]}>
          {content.length} / {CHAR_LIMIT}
        </Text>
      </View>

      {/* Emoji picker modal (combined standard + custom) */}
      <CombinedEmojiPickerModal
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
  headerTitle: {
    color: '#e5e5e5',
    fontSize: 16,
    fontWeight: '600',
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
  scrollArea: {
    flex: 1,
  },
  contextBox: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 10,
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
  },
  quoteBox: {
    borderLeftWidth: 3,
    borderLeftColor: '#f97316',
  },
  contextLabel: { color: '#b3b3b3', fontSize: 12, marginBottom: 4 },
  contextPreview: { color: '#999', fontSize: 13, lineHeight: 18 },
  longFormToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  longFormLabel: {
    color: '#b3b3b3',
    fontSize: 14,
  },
  titleInput: {
    color: '#f2f2f2',
    fontSize: 18,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  editor: {
    color: '#f2f2f2',
    fontSize: 16,
    lineHeight: 22,
    padding: 16,
    paddingTop: 12,
    minHeight: 180,
  },
  imageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  imageThumbWrapper: {
    position: 'relative',
  },
  imageThumb: {
    width: 72,
    height: 72,
    borderRadius: 8,
    backgroundColor: '#333',
  },
  imageRemoveBtn: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageRemoveText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
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
  toolbarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  emojiBtn: {
    padding: 4,
    borderRadius: 6,
  },
  emojiBtnText: {
    fontSize: 24,
    lineHeight: 28,
  },
  charCount: { fontSize: 12, fontWeight: '500' },
  emptyText: { color: '#666', fontSize: 15 },
});
