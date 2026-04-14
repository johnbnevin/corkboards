/**
 * FeedInfoCard — info card showing feed metadata (name, description, author count).
 *
 * Each feed type (Relay, Custom corkboard, All-Follows, Discover) gets a
 * unique info card. Supports collapsed/expanded states.
 *
 * Mobile equivalent of packages/web/src/components/FeedInfoCard.tsx.
 */
import React, { memo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { SizeGuardedImage } from './SizeGuardedImage';
import { useAuthor } from '../hooks/useAuthor';
import { genUserName } from '@core/genUserName';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CustomFeedDef {
  id: string;
  title: string;
  pubkeys: string[];
  relays: string[];
  rssUrls: string[];
}

interface FeedInfoCardProps {
  activeTab: string;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;

  // Tab-type flags
  isRelayTab?: boolean;
  isCustomFeedTab?: boolean;
  isAllFollowsTab?: boolean;
  isDiscoverTab?: boolean;

  activeCustomFeed?: CustomFeedDef | null;
  contactsCount?: number;

  // Stats
  notesCount: number;
  totalLoaded?: number;
  dismissedCount?: number;
  isLoading?: boolean;

  // Actions
  onEditFeed?: (feedId: string) => void;
  onDeleteFeed?: (feedId: string) => void;
  onRemoveRelay?: (url: string) => void;
  onRefreshDiscover?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export const FeedInfoCard = memo(function FeedInfoCard({
  activeTab,
  isCollapsed,
  onToggleCollapsed,
  isRelayTab = false,
  isCustomFeedTab = false,
  isAllFollowsTab = false,
  isDiscoverTab = false,
  activeCustomFeed,
  contactsCount = 0,
  notesCount,
  totalLoaded,
  dismissedCount,
  isLoading = false,
  onEditFeed,
  onDeleteFeed,
  onRemoveRelay,
  onRefreshDiscover,
}: FeedInfoCardProps) {
  // Hook must be called unconditionally
  const singlePubkey = isCustomFeedTab && activeCustomFeed?.pubkeys.length === 1
    ? activeCustomFeed.pubkeys[0] : '';
  const { data: singleAuthor } = useAuthor(singlePubkey);

  // ── Relay tab ──────────────────────────────────────────────────────────────
  if (isRelayTab) {
    let shortName: string;
    try { shortName = new URL(activeTab).hostname; } catch { shortName = activeTab; }

    if (isCollapsed) {
      return (
        <TouchableOpacity style={styles.collapsedCard} onPress={onToggleCollapsed}>
          <Text style={styles.iconEmoji}>R</Text>
          <Text style={styles.collapsedLabel} numberOfLines={1}>{shortName}</Text>
          <Text style={styles.infoLabel}>Info</Text>
        </TouchableOpacity>
      );
    }

    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.iconEmoji}>R</Text>
          <View style={styles.flex}>
            <Text style={styles.title}>{shortName}</Text>
            <Text style={styles.subtitle} numberOfLines={1}>{activeTab}</Text>
          </View>
          <TouchableOpacity onPress={onToggleCollapsed}>
            <Text style={styles.collapseArrow}>^</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.statsRow}>
          <Text style={styles.statText}><Text style={styles.statBold}>{notesCount}</Text> showing{totalLoaded && totalLoaded > notesCount ? ` (${totalLoaded} loaded)` : ''}{(dismissedCount ?? 0) > 0 ? ` · ${dismissedCount} dismissed` : ''}</Text>
          {onRemoveRelay && (
            <TouchableOpacity onPress={() => onRemoveRelay(activeTab)}>
              <Text style={styles.removeText}>Remove relay</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  // ── Custom corkboard tab ───────────────────────────────────────────────────
  if (isCustomFeedTab && activeCustomFeed) {
    const isSingle = activeCustomFeed.pubkeys.length === 1;
    const meta = singleAuthor?.metadata;
    const displayName = meta?.display_name || meta?.name || (isSingle ? genUserName(activeCustomFeed.pubkeys[0]) : '');
    const avatar = meta?.picture;

    if (isCollapsed) {
      return (
        <TouchableOpacity style={styles.collapsedCard} onPress={onToggleCollapsed}>
          {isSingle && avatar ? (
            <SizeGuardedImage uri={avatar} style={styles.smallAvatar} type="avatar" />
          ) : (
            <Text style={styles.iconEmoji}>B</Text>
          )}
          <Text style={styles.collapsedLabel} numberOfLines={1}>{activeCustomFeed.title}</Text>
          <View style={styles.flex} />
          {onEditFeed && (
            <TouchableOpacity onPress={() => onEditFeed(activeCustomFeed.id)}>
              <Text style={styles.actionIcon}>E</Text>
            </TouchableOpacity>
          )}
          {onDeleteFeed && (
            <TouchableOpacity onPress={() => onDeleteFeed(activeCustomFeed.id)}>
              <Text style={[styles.actionIcon, styles.removeText]}>X</Text>
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      );
    }

    return (
      <View style={[styles.card, styles.customFeedCard]}>
        <View style={styles.headerRow}>
          {isSingle && avatar ? (
            <SizeGuardedImage uri={avatar} style={styles.avatar} type="avatar" />
          ) : (
            <Text style={[styles.iconEmoji, { fontSize: 24 }]}>B</Text>
          )}
          <View style={styles.flex}>
            {isSingle ? (
              <>
                <Text style={styles.title}>{displayName}</Text>
                {meta?.nip05 && <Text style={styles.subtitle} numberOfLines={1}>{meta.nip05}</Text>}
              </>
            ) : (
              <>
                <Text style={styles.title}>{activeCustomFeed.title}</Text>
                <Text style={styles.subtitle}>
                  {activeCustomFeed.pubkeys.length} friends
                  {activeCustomFeed.relays.length > 0 && ` · ${activeCustomFeed.relays.length} relays`}
                  {activeCustomFeed.rssUrls?.length > 0 && ` · ${activeCustomFeed.rssUrls.length} RSS`}
                </Text>
              </>
            )}
          </View>
          <TouchableOpacity onPress={onToggleCollapsed}>
            <Text style={styles.collapseArrow}>^</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.statsRow}>
          <Text style={styles.statText}><Text style={styles.statBold}>{notesCount}</Text> showing{totalLoaded && totalLoaded > notesCount ? ` (${totalLoaded} loaded)` : ''}{(dismissedCount ?? 0) > 0 ? ` · ${dismissedCount} dismissed` : ''}</Text>
          <View style={styles.actionsRow}>
            {onEditFeed && (
              <TouchableOpacity style={styles.actionBtn} onPress={() => onEditFeed(activeCustomFeed.id)}>
                <Text style={styles.actionBtnText}>Edit</Text>
              </TouchableOpacity>
            )}
            {onDeleteFeed && (
              <TouchableOpacity style={[styles.actionBtn, styles.removeBtn]} onPress={() => onDeleteFeed(activeCustomFeed.id)}>
                <Text style={styles.removeBtnText}>Remove</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    );
  }

  // ── All-follows tab ────────────────────────────────────────────────────────
  if (isAllFollowsTab) {
    if (isCollapsed) {
      return (
        <TouchableOpacity style={styles.collapsedCard} onPress={onToggleCollapsed}>
          <Text style={styles.iconEmoji}>A</Text>
          <Text style={styles.collapsedLabel}>All Follows</Text>
          <Text style={styles.infoLabel}>Info</Text>
        </TouchableOpacity>
      );
    }

    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={[styles.iconEmoji, { fontSize: 24 }]}>A</Text>
          <View style={styles.flex}>
            <Text style={styles.title}>All Follows</Text>
            <Text style={styles.subtitle}>Recent notes from everyone you follow</Text>
          </View>
          <TouchableOpacity onPress={onToggleCollapsed}>
            <Text style={styles.collapseArrow}>^</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.statsRow}>
          <Text style={styles.statText}><Text style={styles.statBold}>{contactsCount}</Text> followed</Text>
          <Text style={styles.statText}><Text style={styles.statBold}>{notesCount}</Text> showing{totalLoaded && totalLoaded > notesCount ? ` (${totalLoaded} loaded)` : ''}</Text>
          {(dismissedCount ?? 0) > 0 && <Text style={styles.statText}>· {dismissedCount} dismissed</Text>}
          {isLoading && <Text style={styles.loadingText}>Loading...</Text>}
        </View>
      </View>
    );
  }

  // ── Discover tab ───────────────────────────────────────────────────────────
  if (isDiscoverTab) {
    if (isCollapsed) {
      return (
        <TouchableOpacity style={styles.collapsedCard} onPress={onToggleCollapsed}>
          <Text style={styles.iconEmoji}>D</Text>
          <Text style={styles.collapsedLabel}>Discover</Text>
          <Text style={styles.infoLabel}>Info</Text>
        </TouchableOpacity>
      );
    }

    return (
      <View style={[styles.card, styles.discoverCard]}>
        <View style={styles.headerRow}>
          <Text style={[styles.iconEmoji, { fontSize: 24 }]}>D</Text>
          <View style={styles.flex}>
            <Text style={styles.title}>Discover</Text>
            <Text style={styles.subtitle}>Content your friends engaged with from people you don't follow</Text>
          </View>
          <TouchableOpacity onPress={onToggleCollapsed}>
            <Text style={styles.collapseArrow}>^</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.statsRow}>
          <Text style={styles.statText}><Text style={styles.statBold}>{notesCount}</Text> showing{totalLoaded && totalLoaded > notesCount ? ` (${totalLoaded} discovered)` : ' discovered'}</Text>
          {(dismissedCount ?? 0) > 0 && <Text style={styles.statText}>· {dismissedCount} dismissed</Text>}
          {isLoading && <Text style={styles.loadingText}>Searching...</Text>}
          {onRefreshDiscover && (
            <TouchableOpacity onPress={onRefreshDiscover}>
              <Text style={styles.refreshText}>Refresh</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return null;
});

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#404040',
  },
  customFeedCard: {
    borderColor: '#7c3aed',
  },
  discoverCard: {
    borderColor: '#d97706',
  },
  collapsedCard: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#404040',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  flex: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  iconEmoji: {
    color: '#a855f7',
    fontSize: 16,
    fontWeight: '700',
  },
  title: {
    color: '#f2f2f2',
    fontSize: 15,
    fontWeight: '600',
  },
  subtitle: {
    color: '#999',
    fontSize: 12,
    marginTop: 2,
  },
  collapsedLabel: {
    color: '#999',
    fontSize: 12,
    flex: 1,
  },
  infoLabel: {
    color: '#666',
    fontSize: 11,
  },
  collapseArrow: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: '#404040',
    paddingTop: 8,
  },
  statText: {
    color: '#999',
    fontSize: 12,
  },
  statBold: {
    color: '#f2f2f2',
    fontWeight: '600',
  },
  loadingText: {
    color: '#a855f7',
    fontSize: 12,
  },
  removeText: {
    color: '#ef4444',
    fontSize: 12,
  },
  refreshText: {
    color: '#d97706',
    fontSize: 12,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 6,
    marginLeft: 'auto',
  },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#555',
  },
  actionBtnText: {
    color: '#ccc',
    fontSize: 12,
  },
  removeBtn: {
    borderColor: '#7f1d1d',
  },
  removeBtnText: {
    color: '#ef4444',
    fontSize: 12,
  },
  actionIcon: {
    color: '#999',
    fontSize: 14,
    fontWeight: '600',
  },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  smallAvatar: { width: 20, height: 20, borderRadius: 10 },
});
