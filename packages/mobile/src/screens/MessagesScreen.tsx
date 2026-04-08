import { useState, useRef, useEffect } from 'react';
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
  Image,
} from 'react-native';
import { useAuth } from '../lib/AuthContext';
import { SizeGuardedImage } from '../components/SizeGuardedImage';
import { useConversations, useConversationMessages, useSendDM } from '../hooks/useDMs';
import type { Conversation, DecryptedMessage } from '../hooks/useDMs';
import { useAuthor } from '../hooks/useAuthor';
import { formatConversationTime } from '@core/dmUtils';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { genUserName } from '@core/genUserName';

// ============================================================================
// Sub-components
// ============================================================================

function ContactName({ pubkey }: { pubkey: string }) {
  const { data } = useAuthor(pubkey);
  const name = data?.metadata?.display_name || data?.metadata?.name || genUserName(pubkey);
  return <Text style={styles.contactName} numberOfLines={1}>{name}</Text>;
}

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

function ConversationRow({
  conversation,
  onPress,
}: {
  conversation: Conversation;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.conversationRow} onPress={onPress} activeOpacity={0.7}>
      <ContactAvatar pubkey={conversation.partnerPubkey} />
      <View style={styles.conversationInfo}>
        <ContactName pubkey={conversation.partnerPubkey} />
        <Text style={styles.lastTime}>{conversation.lastMessage}</Text>
      </View>
      {conversation.unreadHint && <View style={styles.unreadDot} />}
    </TouchableOpacity>
  );
}

function MessageBubble({ message }: { message: DecryptedMessage }) {
  return (
    <View style={[styles.bubble, message.isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
      <Text style={[styles.bubbleText, message.isMine && styles.bubbleTextMine]}>{message.content}</Text>
      <Text style={[styles.bubbleTime, message.isMine && styles.bubbleTimeMine]}>{formatTimeAgo(message.created_at)}</Text>
    </View>
  );
}

// ============================================================================
// Chat view
// ============================================================================

function ChatView({
  partnerPubkey,
  onBack,
}: {
  partnerPubkey: string;
  onBack: () => void;
}) {
  const { data: messages, isLoading } = useConversationMessages(partnerPubkey);
  const { mutate: sendDM, isPending } = useSendDM();
  const [draft, setDraft] = useState('');
  const flatListRef = useRef<FlatList<DecryptedMessage>>(null);

  // Scroll to bottom when messages load
  useEffect(() => {
    if (messages && messages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 100);
    }
  }, [messages?.length]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    sendDM({ recipientPubkey: partnerPubkey, content: text });
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.chatHeader}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>{'‹'}</Text>
        </TouchableOpacity>
        <ContactAvatar pubkey={partnerPubkey} />
        <ContactName pubkey={partnerPubkey} />
      </View>

      {/* Messages */}
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#b3b3b3" />
          <Text style={styles.loadingText}>Decrypting messages…</Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages ?? []}
          keyExtractor={item => item.id}
          renderItem={({ item }) => <MessageBubble message={item} />}
          contentContainerStyle={styles.messageList}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No messages yet</Text>
          }
        />
      )}

      {/* Compose */}
      <View style={styles.composeBar}>
        <TextInput
          style={styles.composeInput}
          placeholder="Message…"
          placeholderTextColor="#444"
          value={draft}
          onChangeText={setDraft}
          multiline
          maxLength={2000}
        />
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
      </View>
    </KeyboardAvoidingView>
  );
}

// ============================================================================
// Main screen
// ============================================================================

export function MessagesScreen() {
  const { pubkey } = useAuth();
  const { conversations, isLoading } = useConversations();
  const [activeChat, setActiveChat] = useState<string | null>(null);

  if (!pubkey) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Messages</Text>
        <Text style={styles.emptyText}>Log in to view your messages</Text>
      </View>
    );
  }

  if (activeChat) {
    return <ChatView partnerPubkey={activeChat} onBack={() => setActiveChat(null)} />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Messages</Text>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#b3b3b3" />
          <Text style={styles.loadingText}>Loading conversations…</Text>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={item => item.partnerPubkey}
          renderItem={({ item }) => (
            <ConversationRow
              conversation={item}
              onPress={() => setActiveChat(item.partnerPubkey)}
            />
          )}
          contentContainerStyle={styles.convList}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No conversations yet</Text>
          }
        />
      )}
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: { flex: 1, backgroundColor: '#1f1f1f', alignItems: 'center', justifyContent: 'center', gap: 12 },
  header: { paddingHorizontal: 16, paddingTop: 60, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#404040' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f2f2f2' },
  // Conversation list
  convList: { padding: 8 },
  conversationRow: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12, borderBottomWidth: 1, borderBottomColor: '#404040' },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  avatarPlaceholder: { backgroundColor: '#333', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#b3b3b3', fontSize: 16, fontWeight: '600' },
  conversationInfo: { flex: 1 },
  contactName: { fontSize: 15, fontWeight: '500', color: '#f2f2f2' },
  lastTime: { fontSize: 12, color: '#b3b3b3', marginTop: 2 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#3b82f6' },
  // Chat header
  chatHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#404040' },
  backBtn: { paddingRight: 4 },
  backText: { fontSize: 28, color: '#f2f2f2', fontWeight: '300' },
  // Messages
  messageList: { padding: 12, gap: 6, flexGrow: 1 },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 14, marginBottom: 2 },
  bubbleMine: { alignSelf: 'flex-end', backgroundColor: '#f2f2f2' },
  bubbleTheirs: { alignSelf: 'flex-start', backgroundColor: '#333' },
  bubbleText: { color: '#f2f2f2', fontSize: 14, lineHeight: 20 },
  bubbleTextMine: { color: '#1f1f1f' },
  bubbleTime: { color: '#b3b3b3', fontSize: 10, marginTop: 4, textAlign: 'right' },
  bubbleTimeMine: { color: '#666' },
  // Compose
  composeBar: { flexDirection: 'row', alignItems: 'flex-end', padding: 8, paddingBottom: 28, borderTopWidth: 1, borderTopColor: '#404040', gap: 8 },
  composeInput: { flex: 1, backgroundColor: '#2a2a2a', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, color: '#f2f2f2', fontSize: 15, maxHeight: 100 },
  sendBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, backgroundColor: '#333' },
  sendBtnDisabled: { opacity: 0.5 },
  sendText: { color: '#f97316', fontSize: 14, fontWeight: '600' },
  loadingText: { color: '#b3b3b3', fontSize: 14 },
  emptyText: { color: '#666', textAlign: 'center', marginTop: 60, fontSize: 15 },
});
