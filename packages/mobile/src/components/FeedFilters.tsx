/**
 * FeedFilters — collapsible filter UI for feed content types.
 *
 * Renders kind toggles, hashtag badges, and a clear-all button
 * inside a collapsible card.
 *
 * Mobile equivalent of packages/web/src/components/FeedFilters.tsx.
 */
import React, { memo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Switch,
  StyleSheet,
} from 'react-native';
import { NoteKindToggles } from './NoteKindToggles';
import type { KindFilter, NoteKindStats } from './NoteKindToggles';
import { HashtagBadges } from './HashtagBadges';

export type { KindFilter, NoteKindStats };

// ─── Props ───────────────────────────────────────────────────────────────────

export interface FeedFiltersProps {
  // Collapse state
  collapsed: boolean;
  onToggleCollapsed: () => void;

  // Own notes toggle
  showOwnNotes?: boolean;
  onToggleOwnNotes?: () => void;

  // Kind filters
  kindFilters: Set<KindFilter>;
  onFilterByKind: (kind: KindFilter | 'all' | 'none') => void;
  filterMode: 'any' | 'strict';
  onToggleFilterMode: () => void;
  stats?: NoteKindStats;

  // Hashtag filters
  hashtagFilters: Set<string>;
  onFilterByHashtag: (tag: string) => void;
  hashtags: { tag: string; count: number }[];

  // Clear all
  hasActiveFilters: boolean;
  onClearFilters: () => void;

  // Optional children
  children?: React.ReactNode;
}

// ─── Component ───────────────────────────────────────────────────────────────

export const FeedFilters = memo(function FeedFilters({
  collapsed,
  onToggleCollapsed,
  showOwnNotes,
  onToggleOwnNotes,
  kindFilters,
  onFilterByKind,
  filterMode,
  onToggleFilterMode,
  stats,
  hashtagFilters,
  onFilterByHashtag,
  hashtags,
  hasActiveFilters,
  onClearFilters,
  children,
}: FeedFiltersProps) {
  if (collapsed) {
    return (
      <TouchableOpacity style={styles.collapsedCard} onPress={onToggleCollapsed}>
        <Text style={styles.filterIcon}>F</Text>
        <Text style={styles.collapsedLabel}>Filters</Text>
        {hasActiveFilters && <View style={styles.activeDot} />}
        <View style={styles.flex} />
        <Text style={styles.expandArrow}>v</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={styles.filterIcon}>F</Text>
        <Text style={styles.headerLabel}>Filters</Text>
        <View style={styles.flex} />
        <TouchableOpacity onPress={onToggleCollapsed}>
          <Text style={styles.collapseArrow}>^</Text>
        </TouchableOpacity>
      </View>

      {/* Own notes toggle */}
      {onToggleOwnNotes && (
        <View style={styles.toggleRow}>
          <Switch
            value={showOwnNotes ?? false}
            onValueChange={onToggleOwnNotes}
            trackColor={{ false: '#555', true: '#a855f7' }}
            thumbColor={showOwnNotes ? '#f2f2f2' : '#999'}
            style={styles.smallSwitch}
          />
          <Text style={styles.toggleLabel}>Include my notes</Text>
        </View>
      )}

      {/* Kind toggles */}
      <View style={styles.section}>
        <NoteKindToggles
          kindFilters={kindFilters}
          onFilterByKind={onFilterByKind}
          filterMode={filterMode}
          onToggleFilterMode={onToggleFilterMode}
          stats={stats}
        />
      </View>

      {/* Children slot */}
      {children}

      {/* Hashtag badges */}
      {hashtags.length > 0 && (
        <View style={styles.section}>
          <HashtagBadges
            hashtags={hashtags}
            hashtagFilters={hashtagFilters}
            onFilterByHashtag={onFilterByHashtag}
          />
        </View>
      )}

      {/* Clear all */}
      {hasActiveFilters && (
        <View style={styles.section}>
          <TouchableOpacity style={styles.clearButton} onPress={onClearFilters}>
            <Text style={styles.clearButtonText}>X Clear all filters</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#404040',
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
    gap: 8,
    marginBottom: 8,
  },
  filterIcon: {
    color: '#a855f7',
    fontSize: 14,
    fontWeight: '600',
  },
  headerLabel: {
    color: '#f2f2f2',
    fontSize: 14,
    fontWeight: '500',
  },
  collapsedLabel: {
    color: '#999',
    fontSize: 12,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#a855f7',
  },
  expandArrow: {
    color: '#22c55e',
    fontSize: 14,
    fontWeight: '600',
  },
  collapseArrow: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '600',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  smallSwitch: {
    transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }],
  },
  toggleLabel: {
    color: '#999',
    fontSize: 12,
  },
  section: {
    marginTop: 8,
  },
  clearButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#333',
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  clearButtonText: {
    color: '#999',
    fontSize: 12,
  },
});
