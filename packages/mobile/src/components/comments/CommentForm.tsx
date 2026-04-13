/**
 * CommentForm — Comment input with text field and submit button.
 *
 * Port of packages/web/src/components/comments/CommentForm.tsx for React Native.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { usePostComment } from '../../hooks/usePostComment';

interface CommentFormProps {
  root: NostrEvent | URL;
  reply?: NostrEvent | URL;
  onSuccess?: () => void;
  placeholder?: string;
  compact?: boolean;
}

export function CommentForm({
  root,
  reply,
  onSuccess,
  placeholder = 'Write a comment...',
  compact = false,
}: CommentFormProps) {
  const [content, setContent] = useState('');
  const { user } = useCurrentUser();
  const { mutate: postComment, isPending } = usePostComment();

  const handleSubmit = () => {
    if (!content.trim() || !user) return;

    postComment(
      { content: content.trim(), root, reply },
      {
        onSuccess: () => {
          setContent('');
          onSuccess?.();
        },
      },
    );
  };

  if (!user) {
    return (
      <View style={[styles.card, compact && styles.cardCompact]}>
        <Text style={styles.signInText}>
          Sign in to {reply ? 'reply' : 'comment'}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.card, compact && styles.cardCompact]}>
      <TextInput
        style={[styles.input, compact && styles.inputCompact]}
        placeholder={placeholder}
        placeholderTextColor="#666"
        value={content}
        onChangeText={setContent}
        multiline
        maxLength={2000}
        editable={!isPending}
      />
      <View style={styles.footer}>
        <Text style={styles.hint}>
          {reply ? 'Replying to comment' : 'Adding to the discussion'}
        </Text>
        <TouchableOpacity
          style={[
            styles.submitBtn,
            (!content.trim() || isPending) && styles.submitBtnDisabled,
          ]}
          onPress={handleSubmit}
          disabled={!content.trim() || isPending}
        >
          {isPending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.submitText}>{reply ? 'Reply' : 'Comment'}</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#404040',
    gap: 10,
  },
  cardCompact: {
    padding: 10,
    borderStyle: 'dashed',
  },
  input: {
    backgroundColor: '#1f1f1f',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#f2f2f2',
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  inputCompact: { minHeight: 60 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  hint: { color: '#b3b3b3', fontSize: 12, flex: 1 },
  submitBtn: {
    backgroundColor: '#f97316',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  signInText: {
    color: '#b3b3b3',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 16,
  },
});
