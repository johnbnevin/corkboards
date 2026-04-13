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
} from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { buildReplyTags } from '@core/noteClassifier';
import { useNostrPublish } from '../../hooks/useNostrPublish';
import { useAuthor } from '../../hooks/useAuthor';
import { genUserName } from '@core/genUserName';

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
  const { mutate: publish, isPending } = useNostrPublish();
  const inputRef = useRef<TextInput>(null);
  const { data: author } = useAuthor(replyTo.pubkey);
  const displayName =
    author?.metadata?.display_name ||
    author?.metadata?.name ||
    genUserName(replyTo.pubkey);

  // Auto-focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 150);
  }, []);

  const handleSubmit = useCallback(() => {
    const text = content.trim();
    if (!text) return;

    const tags: string[][] = [...buildReplyTags(replyTo)];

    // Extract hashtags
    const hashtagMatches = text.matchAll(/#([a-zA-Z]\w*)/g);
    for (const match of hashtagMatches) {
      tags.push(['t', match[1].toLowerCase()]);
    }

    publish(
      { kind: 1, content: text, tags, created_at: Math.floor(Date.now() / 1000) },
      {
        onSuccess: (event) => {
          setContent('');
          onPublished(event);
        },
      },
    );
  }, [content, replyTo, publish, onPublished]);

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
          multiline
          maxLength={2000}
        />
        <TouchableOpacity
          style={[
            styles.sendBtn,
            (!content.trim() || isPending) && styles.sendBtnDisabled,
          ]}
          onPress={handleSubmit}
          disabled={!content.trim() || isPending}
        >
          {isPending ? (
            <ActivityIndicator color="#f97316" size="small" />
          ) : (
            <Text style={styles.sendText}>Reply</Text>
          )}
        </TouchableOpacity>
      </View>
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
});
