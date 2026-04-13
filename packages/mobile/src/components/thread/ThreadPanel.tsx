/**
 * ThreadPanel — Container that loads thread data, shows root note,
 * and renders ThreadTree below. Handles loading/error states.
 *
 * Port of packages/web/src/components/thread/ThreadPanel.tsx for React Native.
 */
import { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useThreadQuery } from '../../hooks/useThreadQuery';
import { ThreadTree } from './ThreadTree';
import { InlineReplyComposer } from './InlineReplyComposer';

interface ThreadPanelProps {
  eventId: string | null;
  onClose: () => void;
  onNavigateThread?: (eventId: string) => void;
}

export function ThreadPanel({ eventId, onClose, onNavigateThread }: ThreadPanelProps) {
  const {
    rows,
    isLoading,
    error,
    collapsedIds,
    toggleCollapse,
    injectReply,
    refetch,
  } = useThreadQuery(eventId);

  const [replyTarget, setReplyTarget] = useState<NostrEvent | null>(null);
  const totalReplies = rows.length > 0 ? rows.length - 1 : 0;

  const handleReply = useCallback((event: NostrEvent) => {
    setReplyTarget(event);
  }, []);

  const handleReplyPublished = useCallback(
    (event: NostrEvent) => {
      injectReply(event);
      setReplyTarget(null);
    },
    [injectReply],
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} style={styles.backBtn}>
          <Text style={styles.backText}>{'<'} Back</Text>
        </TouchableOpacity>
        <View style={styles.headerRight}>
          <Text style={styles.title}>Thread</Text>
          {!isLoading && totalReplies > 0 && (
            <Text style={styles.replyCount}>
              ({totalReplies} {totalReplies === 1 ? 'reply' : 'replies'})
            </Text>
          )}
        </View>
        <TouchableOpacity onPress={() => refetch()} style={styles.refreshBtn}>
          {isLoading ? (
            <ActivityIndicator color="#b3b3b3" size="small" />
          ) : (
            <Text style={styles.refreshText}>Refresh</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Content */}
      {isLoading && rows.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color="#b3b3b3" size="large" />
          <Text style={styles.loadingText}>Loading thread...</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => refetch()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : rows.length > 0 ? (
        <ThreadTree
          rows={rows}
          targetId={eventId}
          collapsedIds={collapsedIds}
          onToggleCollapse={toggleCollapse}
          onReply={handleReply}
        />
      ) : (
        <View style={styles.center}>
          <Text style={styles.emptyText}>No thread data found.</Text>
        </View>
      )}

      {/* Inline reply composer */}
      {replyTarget && (
        <InlineReplyComposer
          replyTo={replyTarget}
          onCancel={() => setReplyTarget(null)}
          onPublished={handleReplyPublished}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#404040',
  },
  backBtn: { paddingRight: 8 },
  backText: { color: '#b3b3b3', fontSize: 16 },
  headerRight: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  title: { fontSize: 20, fontWeight: 'bold', color: '#f2f2f2' },
  replyCount: { fontSize: 13, color: '#b3b3b3' },
  refreshBtn: { paddingLeft: 8 },
  refreshText: { color: '#b3b3b3', fontSize: 13 },
  loadingText: { color: '#b3b3b3', fontSize: 14 },
  errorText: { color: '#b3b3b3', fontSize: 14, textAlign: 'center', marginBottom: 8 },
  retryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
  },
  retryText: { color: '#f2f2f2', fontSize: 13 },
  emptyText: { color: '#666', fontSize: 14 },
});
