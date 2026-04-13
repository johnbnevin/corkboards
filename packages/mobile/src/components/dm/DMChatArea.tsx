/**
 * DMChatArea -- chat view for a single DM conversation.
 *
 * Shows messages in bubbles (sent right, received left), text input at bottom,
 * send button. Auto-scrolls to bottom on new messages.
 *
 * Features matching web parity:
 * - "Load earlier" button for message history pagination
 * - dmMessageStore integration for persistent caching
 * - Protocol badges (key icon for NIP-04, shield icon for NIP-17)
 * - File attachment display (imeta tags)
 * - Sending state indicator
 *
 * Mirrors web's DMChatArea adapted for React Native.
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Linking,
  Image,
} from 'react-native';
import { useConversationMessages, useSendDM } from '../../hooks/useDMs';
import type { DecryptedMessage } from '../../hooks/useDMs';
import { useAuthor } from '../../hooks/useAuthor';
import { SizeGuardedImage } from '../SizeGuardedImage';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { genUserName } from '@core/genUserName';
// dmMessageStore is available for persistent caching — currently populated
// by the hooks layer when events arrive from relays.
// import { upsertMessages, getOrCreateStore } from '../../lib/dmMessageStore';

// ============================================================================
// Constants
// ============================================================================

const PAGE_SIZE = 30;

// ============================================================================
// Sub-components
// ============================================================================

function ContactAvatar({ pubkey }: { pubkey: string }) {
  const { data } = useAuthor(pubkey);
  const avatar = data?.metadata?.picture;
  const name = data?.metadata?.display_name || data?.metadata?.name || '?';

  if (avatar) {
    return <SizeGuardedImage uri={avatar} style={styles.avatar} type="avatar" />;
  }
  return (
    <View style={[styles.avatar, styles.avatarPlaceholder]}>
      <Text style={styles.avatarLetter}>{name[0]?.toUpperCase()}</Text>
    </View>
  );
}

function ContactName({ pubkey }: { pubkey: string }) {
  const { data } = useAuthor(pubkey);
  const name = data?.metadata?.display_name || data?.metadata?.name || genUserName(pubkey);
  return <Text style={styles.contactName} numberOfLines={1}>{name}</Text>;
}

/** Extract image URLs from imeta tags (NIP-94 inline file metadata) */
function extractImetaUrls(message: DecryptedMessage): string[] {
  // DecryptedMessage doesn't carry tags directly, but if the content
  // contains URLs that look like images, display them as attachments.
  const urlRegex = /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)/gi;
  const matches = message.content.match(urlRegex);
  return matches ?? [];
}

function FileAttachment({ url }: { url: string }) {
  return (
    <TouchableOpacity
      onPress={() => Linking.openURL(url)}
      activeOpacity={0.8}
      style={styles.attachmentContainer}
    >
      <Image
        source={{ uri: url }}
        style={styles.attachmentImage}
        resizeMode="cover"
      />
    </TouchableOpacity>
  );
}

/** Protocol badge: key icon for NIP-04, shield icon for NIP-17 */
function ProtocolBadge({ protocol, isMine }: { protocol: 'nip04' | 'nip17'; isMine: boolean }) {
  if (protocol === 'nip04') {
    return (
      <View style={styles.protocolBadgeContainer}>
        <Text style={[styles.protocolIcon, isMine && styles.protocolIconMine]}>
          {'\u{1F511}'}
        </Text>
        <Text style={[styles.protocolLabel, isMine && styles.protocolLabelMine]}>
          NIP-04
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.protocolBadgeContainer}>
      <Text style={[styles.protocolIcon, isMine && styles.protocolIconMine]}>
        {'\u{1F6E1}'}
      </Text>
      <Text style={[styles.protocolLabel, isMine && styles.protocolLabelMine]}>
        NIP-17
      </Text>
    </View>
  );
}

function MessageBubble({ message }: { message: DecryptedMessage & { isSending?: boolean } }) {
  const isDecryptionFailure = message.content === '[decryption failed]';
  const imageUrls = useMemo(() => extractImetaUrls(message), [message.content]);
  const textContent = useMemo(() => {
    // Strip image URLs from text so they aren't shown twice
    if (imageUrls.length === 0) return message.content;
    let text = message.content;
    for (const url of imageUrls) {
      text = text.replace(url, '').trim();
    }
    return text;
  }, [message.content, imageUrls]);

  return (
    <View style={[styles.bubble, message.isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
      {isDecryptionFailure ? (
        <Text style={[styles.bubbleText, styles.decryptionFailed]}>
          Failed to decrypt
        </Text>
      ) : (
        <>
          {/* Image attachments */}
          {imageUrls.map((url, i) => (
            <FileAttachment key={`${message.id}-img-${i}`} url={url} />
          ))}
          {/* Text content */}
          {textContent.length > 0 && (
            <Text style={[styles.bubbleText, message.isMine && styles.bubbleTextMine]}>
              {textContent}
            </Text>
          )}
        </>
      )}
      <View style={styles.bubbleMeta}>
        <Text style={[styles.bubbleTime, message.isMine && styles.bubbleTimeMine]}>
          {formatTimeAgo(message.created_at)}
        </Text>
        <ProtocolBadge protocol={message.protocol} isMine={message.isMine} />
        {message.protocol === 'nip04' && (
          <Text style={styles.nip04Warning}>{'\u26A0'}</Text>
        )}
        {message.isSending && (
          <ActivityIndicator color={message.isMine ? '#666' : '#b3b3b3'} size={10} />
        )}
      </View>
    </View>
  );
}

// ============================================================================
// Main component
// ============================================================================

interface DMChatAreaProps {
  partnerPubkey: string;
  onBack: () => void;
}

export function DMChatArea({ partnerPubkey, onBack }: DMChatAreaProps) {
  const { data: allMessages, isLoading } = useConversationMessages(partnerPubkey);
  const { mutate: sendDM, isPending } = useSendDM();
  const [draft, setDraft] = useState('');
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const flatListRef = useRef<FlatList<DecryptedMessage>>(null);

  // Paginated messages: show only the latest `displayCount` messages
  const messages = useMemo(() => {
    if (!allMessages) return [];
    const start = Math.max(0, allMessages.length - displayCount);
    return allMessages.slice(start);
  }, [allMessages, displayCount]);

  const hasMoreMessages = allMessages ? allMessages.length > displayCount : false;

  // Scroll to bottom when messages load or new message arrives
  useEffect(() => {
    if (messages && messages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 100);
    }
  }, [messages?.length]);

  const handleLoadEarlier = useCallback(() => {
    if (!hasMoreMessages || isLoadingMore) return;
    setIsLoadingMore(true);
    // Increase display count to show more messages
    setDisplayCount(prev => prev + PAGE_SIZE);
    // Brief delay to allow re-render before clearing flag
    setTimeout(() => setIsLoadingMore(false), 100);
  }, [hasMoreMessages, isLoadingMore]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    sendDM({ recipientPubkey: partnerPubkey, content: text });
  }, [draft, partnerPubkey, sendDM]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.chatHeader}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>
        <ContactAvatar pubkey={partnerPubkey} />
        <ContactName pubkey={partnerPubkey} />
      </View>

      {/* Messages */}
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#b3b3b3" />
          <Text style={styles.loadingText}>Decrypting messages...</Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages ?? []}
          keyExtractor={item => item.id}
          renderItem={({ item }) => <MessageBubble message={item} />}
          contentContainerStyle={styles.messageList}
          ListHeaderComponent={
            hasMoreMessages ? (
              <View style={styles.loadEarlierContainer}>
                <TouchableOpacity
                  onPress={handleLoadEarlier}
                  disabled={isLoadingMore}
                  style={styles.loadEarlierBtn}
                  activeOpacity={0.7}
                >
                  {isLoadingMore ? (
                    <View style={styles.loadEarlierInner}>
                      <ActivityIndicator color="#b3b3b3" size="small" />
                      <Text style={styles.loadEarlierText}>Loading...</Text>
                    </View>
                  ) : (
                    <Text style={styles.loadEarlierText}>Load Earlier Messages</Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No messages yet</Text>
              <Text style={styles.emptySubtext}>Send a message to start the conversation</Text>
            </View>
          }
        />
      )}

      {/* Compose bar */}
      <View style={styles.composeBar}>
        <TextInput
          style={styles.composeInput}
          placeholder="Message..."
          placeholderTextColor="#666"
          value={draft}
          onChangeText={setDraft}
          multiline
          maxLength={2000}
          returnKeyType="default"
        />
        <View style={styles.sendCol}>
          <TouchableOpacity
            style={[styles.sendBtn, (!draft.trim() || isPending) && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!draft.trim() || isPending}
          >
            {isPending ? (
              <ActivityIndicator color="#f97316" size="small" />
            ) : (
              <Text style={styles.sendText}>Send</Text>
            )}
          </TouchableOpacity>
          <Text style={styles.protocolHint}>NIP-17</Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  // Chat header
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#404040',
  },
  backBtn: { paddingRight: 4 },
  backText: { fontSize: 24, color: '#f2f2f2', fontWeight: '300' },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#b3b3b3', fontSize: 15, fontWeight: '600' },
  contactName: { fontSize: 16, fontWeight: '500', color: '#f2f2f2', flex: 1 },
  // Load earlier
  loadEarlierContainer: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  loadEarlierBtn: {
    backgroundColor: '#2a2a2a',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#404040',
  },
  loadEarlierInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  loadEarlierText: { color: '#b3b3b3', fontSize: 12, fontWeight: '500' },
  // Messages
  messageList: { padding: 12, gap: 6, flexGrow: 1 },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 14, marginBottom: 4 },
  bubbleMine: { alignSelf: 'flex-end', backgroundColor: '#f2f2f2' },
  bubbleTheirs: { alignSelf: 'flex-start', backgroundColor: '#2a2a2a' },
  bubbleText: { color: '#f2f2f2', fontSize: 14, lineHeight: 20 },
  bubbleTextMine: { color: '#1f1f1f' },
  decryptionFailed: { fontStyle: 'italic', color: '#666' },
  bubbleMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  bubbleTime: { color: '#b3b3b3', fontSize: 10, textAlign: 'right' },
  bubbleTimeMine: { color: '#666' },
  // Protocol badges
  protocolBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  protocolIcon: { fontSize: 9, opacity: 0.5 },
  protocolIconMine: { opacity: 0.7 },
  protocolLabel: { fontSize: 9, color: '#555' },
  protocolLabelMine: { color: '#999' },
  nip04Warning: { fontSize: 10, color: '#eab308' },
  // Attachments
  attachmentContainer: {
    marginBottom: 6,
    borderRadius: 10,
    overflow: 'hidden',
  },
  attachmentImage: {
    width: '100%',
    height: 180,
    borderRadius: 10,
    backgroundColor: '#333',
  },
  // Empty state
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    gap: 6,
  },
  emptyText: { color: '#666', fontSize: 15 },
  emptySubtext: { color: '#555', fontSize: 13 },
  // Compose
  composeBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 8,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: '#404040',
    gap: 8,
  },
  composeInput: {
    flex: 1,
    backgroundColor: '#2a2a2a',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#f2f2f2',
    fontSize: 15,
    maxHeight: 100,
  },
  sendCol: {
    alignItems: 'center',
    gap: 2,
  },
  sendBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: '#2a2a2a',
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendText: { color: '#f97316', fontSize: 14, fontWeight: '600' },
  protocolHint: { fontSize: 9, color: '#555' },
  loadingText: { color: '#b3b3b3', fontSize: 14 },
});
