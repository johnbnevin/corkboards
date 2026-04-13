/**
 * DMConversationList -- list of DM conversations with Active/Requests tabs,
 * loading phase indicators, last message preview, skeleton loading, and
 * unread count badges.
 *
 * Mirrors web's DMConversationList adapted for React Native.
 */
import { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useConversations } from '../../hooks/useDMs';
import type { Conversation } from '../../hooks/useDMs';
import { useAuth } from '../../lib/AuthContext';
import { useContacts } from '../../hooks/useFeed';
import { useAuthor } from '../../hooks/useAuthor';
import { SizeGuardedImage } from '../SizeGuardedImage';
import { genUserName } from '@core/genUserName';

// ============================================================================
// Types
// ============================================================================

type TabId = 'active' | 'requests';

interface EnrichedConversation extends Conversation {
  /** User has sent at least one message to this partner */
  isKnown: boolean;
  /** Incoming-only conversation from someone we haven't replied to */
  isRequest: boolean;
}

// ============================================================================
// Skeleton placeholder
// ============================================================================

function SkeletonRow() {
  return (
    <View style={styles.conversationRow}>
      <View style={[styles.avatar, styles.skeletonCircle]} />
      <View style={styles.conversationInfo}>
        <View style={styles.nameRow}>
          <View style={styles.skeletonName} />
          <View style={styles.skeletonTime} />
        </View>
        <View style={styles.skeletonPreview} />
      </View>
    </View>
  );
}

function ConversationListSkeleton() {
  return (
    <View>
      {[1, 2, 3, 4, 5].map(i => (
        <SkeletonRow key={i} />
      ))}
    </View>
  );
}

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

function ConversationRow({
  conversation,
  onPress,
}: {
  conversation: EnrichedConversation;
  onPress: () => void;
}) {
  // Show a preview: for now we show "Encrypted message" since we don't
  // have a pre-decrypted last-message cache in the list hook yet.
  const preview = 'Encrypted message';

  return (
    <TouchableOpacity style={styles.conversationRow} onPress={onPress} activeOpacity={0.7}>
      <ContactAvatar pubkey={conversation.partnerPubkey} />
      <View style={styles.conversationInfo}>
        <View style={styles.nameRow}>
          <ContactName pubkey={conversation.partnerPubkey} />
          <Text style={styles.lastTime}>{conversation.lastMessage}</Text>
        </View>
        <View style={styles.previewRow}>
          <Text style={styles.lockIcon}>{'🔒 '}</Text>
          <Text style={styles.preview} numberOfLines={1}>
            {preview}
          </Text>
        </View>
      </View>
      {conversation.unreadHint && (
        <View style={styles.unreadBadge}>
          <Text style={styles.unreadBadgeText}>{'!'}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ============================================================================
// Main component
// ============================================================================

interface DMConversationListProps {
  onSelectConversation: (pubkey: string) => void;
  onStatusPress?: () => void;
}

export function DMConversationList({ onSelectConversation, onStatusPress }: DMConversationListProps) {
  const { pubkey } = useAuth();
  const { conversations, isLoading } = useConversations();
  const { data: contacts } = useContacts(pubkey);
  const [activeTab, setActiveTab] = useState<TabId>('active');

  // Enrich conversations with isKnown/isRequest based on whether the user
  // has sent at least one message (mirroring web's DMProvider logic).
  // Since the mobile hook doesn't track sent-by-user per conversation,
  // we approximate: if the last message's unreadHint is false (meaning
  // the user sent the last message) OR the partner is in the user's
  // contact list, treat as "known".
  const enriched = useMemo<EnrichedConversation[]>(() => {
    const contactSet = new Set(contacts ?? []);
    return conversations.map(c => {
      const isKnown = !c.unreadHint || contactSet.has(c.partnerPubkey);
      return { ...c, isKnown, isRequest: !isKnown };
    });
  }, [conversations, contacts]);

  const activeConversations = useMemo(
    () => enriched.filter(c => c.isKnown),
    [enriched],
  );
  const requestConversations = useMemo(
    () => enriched.filter(c => c.isRequest),
    [enriched],
  );

  const currentList = activeTab === 'active' ? activeConversations : requestConversations;

  const requestUnreadCount = useMemo(
    () => requestConversations.filter(c => c.unreadHint).length,
    [requestConversations],
  );

  const renderItem = useCallback(
    ({ item }: { item: EnrichedConversation }) => (
      <ConversationRow
        conversation={item}
        onPress={() => onSelectConversation(item.partnerPubkey)}
      />
    ),
    [onSelectConversation],
  );

  const isInitialLoad = isLoading && conversations.length === 0;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <View style={styles.headerLeft}>
            <Text style={styles.title}>Messages</Text>
            {isLoading && conversations.length > 0 && (
              <ActivityIndicator color="#b3b3b3" size="small" style={{ marginLeft: 8 }} />
            )}
          </View>
          {onStatusPress && (
            <TouchableOpacity onPress={onStatusPress} style={styles.infoBtn}>
              <Text style={styles.infoBtnText}>{'i'}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'active' && styles.tabActive]}
          onPress={() => setActiveTab('active')}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabText, activeTab === 'active' && styles.tabTextActive]}>
            Active{activeConversations.length > 0 ? ` (${activeConversations.length})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'requests' && styles.tabActive]}
          onPress={() => setActiveTab('requests')}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabText, activeTab === 'requests' && styles.tabTextActive]}>
            Requests{requestConversations.length > 0 ? ` (${requestConversations.length})` : ''}
          </Text>
          {requestUnreadCount > 0 && (
            <View style={styles.tabBadge}>
              <Text style={styles.tabBadgeText}>{requestUnreadCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* Content */}
      {isInitialLoad ? (
        <ConversationListSkeleton />
      ) : conversations.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>No conversations yet</Text>
          <Text style={styles.emptySubtext}>
            Start a new conversation to get started
          </Text>
        </View>
      ) : currentList.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>
            No {activeTab === 'active' ? 'active' : 'request'} conversations
          </Text>
        </View>
      ) : (
        <FlatList
          data={currentList}
          keyExtractor={item => item.partnerPubkey}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingTop: 60,
  },
  // Header
  header: {
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#404040',
  },
  headerTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f2f2f2' },
  infoBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoBtnText: { color: '#b3b3b3', fontSize: 14, fontWeight: '600', fontStyle: 'italic' },
  // Tab bar
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 4,
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    padding: 3,
    gap: 3,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 6,
    gap: 6,
  },
  tabActive: {
    backgroundColor: '#1f1f1f',
  },
  tabText: { fontSize: 13, color: '#666', fontWeight: '500' },
  tabTextActive: { color: '#f2f2f2', fontWeight: '600' },
  tabBadge: {
    backgroundColor: '#f97316',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  // List
  list: { paddingVertical: 4 },
  conversationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#404040',
  },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#b3b3b3', fontSize: 17, fontWeight: '600' },
  conversationInfo: { flex: 1 },
  nameRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  contactName: { fontSize: 15, fontWeight: '500', color: '#f2f2f2', flex: 1 },
  lastTime: { fontSize: 12, color: '#b3b3b3', flexShrink: 0 },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 3,
  },
  lockIcon: { fontSize: 11 },
  preview: { fontSize: 13, color: '#666', flex: 1 },
  // Unread badge
  unreadBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#f97316',
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  // Skeleton
  skeletonCircle: { backgroundColor: '#333' },
  skeletonName: {
    width: 100,
    height: 14,
    borderRadius: 4,
    backgroundColor: '#333',
  },
  skeletonTime: {
    width: 40,
    height: 10,
    borderRadius: 3,
    backgroundColor: '#333',
  },
  skeletonPreview: {
    width: '80%',
    height: 12,
    borderRadius: 4,
    backgroundColor: '#333',
    marginTop: 6,
  },
  // Empty
  emptyText: { color: '#666', fontSize: 15 },
  emptySubtext: { color: '#555', fontSize: 13 },
});
