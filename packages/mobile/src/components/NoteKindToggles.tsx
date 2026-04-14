/**
 * NoteKindToggles — row of toggle chips for filtering by note kind.
 *
 * Horizontal ScrollView of chips: posts, replies, articles, videos,
 * images, reposts, reactions, highlights, recipes.
 *
 * Mobile equivalent of packages/web/src/components/NoteKindToggles.tsx.
 */
import { useState, useEffect, memo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Switch,
  StyleSheet,
} from 'react-native';

// ─── Shared types ────────────────────────────────────────────────────────────

export type KindFilter =
  | 'posts' | 'replies' | 'articles' | 'videos' | 'images'
  | 'reposts' | 'reactions' | 'highlights' | 'recipes';

export const ALL_NOTE_KIND_FILTERS: readonly KindFilter[] = [
  'posts', 'replies', 'articles', 'videos', 'images',
  'reposts', 'reactions', 'highlights', 'recipes',
] as const;

export interface NoteKindStats {
  total: number;
  shortNotes: number;
  replies: number;
  longForm: number;
  reposts: number;
  reactions: number;
  videos: number;
  images: number;
  highlights: number;
  recipes: number;
  other: number;
}

// ─── Toggle config ───────────────────────────────────────────────────────────

type StatsKey = keyof Omit<NoteKindStats, 'total' | 'other'>;

const TOGGLE_CONFIG: ReadonlyArray<{
  kind: KindFilter;
  emoji: string;
  label: string;
  countKey: StatsKey;
}> = [
  { kind: 'posts',      emoji: 'T',  label: 'posts',      countKey: 'shortNotes' },
  { kind: 'replies',    emoji: 'R',  label: 'replies',    countKey: 'replies'    },
  { kind: 'articles',   emoji: 'A',  label: 'articles',   countKey: 'longForm'   },
  { kind: 'videos',     emoji: 'V',  label: 'videos',     countKey: 'videos'     },
  { kind: 'images',     emoji: 'I',  label: 'images',     countKey: 'images'     },
  { kind: 'reposts',    emoji: 'P',  label: 'reposts',    countKey: 'reposts'    },
  { kind: 'reactions',  emoji: 'L',  label: 'reactions',  countKey: 'reactions'  },
  { kind: 'highlights', emoji: 'H',  label: 'highlights', countKey: 'highlights' },
  { kind: 'recipes',    emoji: 'C',  label: 'recipes',    countKey: 'recipes'    },
];

// ─── Component ───────────────────────────────────────────────────────────────

interface NoteKindTogglesProps {
  kindFilters: Set<KindFilter>;
  onFilterByKind: (kind: KindFilter | 'all' | 'none') => void;
  filterMode?: 'any' | 'strict';
  onToggleFilterMode?: () => void;
  stats?: NoteKindStats;
}

export const NoteKindToggles = memo(function NoteKindToggles({
  kindFilters,
  onFilterByKind,
  filterMode = 'any',
  onToggleFilterMode,
  stats,
}: NoteKindTogglesProps) {
  const [localFilters, setLocalFilters] = useState(kindFilters);

  useEffect(() => { setLocalFilters(kindFilters); }, [kindFilters]);

  const allShowing = localFilters.size === 0;

  const handleAllNone = () => {
    const next = allShowing ? new Set(ALL_NOTE_KIND_FILTERS) : new Set<KindFilter>();
    setLocalFilters(next);
    onFilterByKind(allShowing ? 'none' : 'all');
  };

  const handleToggle = (kind: KindFilter) => {
    setLocalFilters(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
    onFilterByKind(kind);
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.container}
    >
      {/* Master all/none toggle */}
      <View style={styles.toggleItem}>
        <Switch
          value={allShowing}
          onValueChange={handleAllNone}
          trackColor={{ false: '#555', true: '#a855f7' }}
          thumbColor={allShowing ? '#f2f2f2' : '#999'}
          style={styles.smallSwitch}
        />
        <Text style={styles.toggleLabel}>{allShowing ? 'All' : 'None'}</Text>
      </View>

      {/* Filter mode toggle */}
      {onToggleFilterMode && localFilters.size > 0 && (
        <>
          <Text style={styles.separator}>|</Text>
          <TouchableOpacity
            onPress={onToggleFilterMode}
            style={[
              styles.modeChip,
              filterMode === 'strict' && styles.modeChipStrict,
            ]}
          >
            <Text style={[
              styles.modeChipText,
              filterMode === 'strict' && styles.modeChipTextStrict,
            ]}>
              {filterMode === 'strict' ? 'Strict' : 'Loose'}
            </Text>
          </TouchableOpacity>
        </>
      )}

      <Text style={styles.separator}>|</Text>

      {/* Individual kind toggles */}
      {TOGGLE_CONFIG.map(({ kind, emoji, label, countKey }, i) => (
        <View key={kind} style={styles.kindRow}>
          {i > 0 && <Text style={styles.separator}>|</Text>}
          <View style={styles.toggleItem}>
            <Switch
              value={!localFilters.has(kind)}
              onValueChange={() => handleToggle(kind)}
              trackColor={{ false: '#555', true: '#a855f7' }}
              thumbColor={!localFilters.has(kind) ? '#f2f2f2' : '#999'}
              style={styles.smallSwitch}
            />
            <Text style={styles.kindIcon}>{emoji}</Text>
            <Text style={styles.toggleLabel}>
              {stats?.[countKey] ?? 0} {label}
            </Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  toggleItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  smallSwitch: {
    transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }],
  },
  toggleLabel: {
    fontSize: 11,
    color: '#999',
  },
  kindIcon: {
    fontSize: 10,
    color: '#999',
    fontWeight: '600',
  },
  separator: {
    color: '#555',
    fontSize: 12,
    marginHorizontal: 4,
  },
  kindRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  modeChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: '#333',
  },
  modeChipStrict: {
    backgroundColor: 'rgba(239,68,68,0.15)',
  },
  modeChipText: {
    fontSize: 10,
    fontWeight: '500',
    color: '#999',
  },
  modeChipTextStrict: {
    color: '#f87171',
  },
});
