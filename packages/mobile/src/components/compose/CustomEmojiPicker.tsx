/**
 * CustomEmojiPicker -- Grid picker for NIP-30 custom emoji sets.
 * Shows search, set tabs, and a grid of custom emoji images.
 *
 * Port of packages/web/src/components/compose/CustomEmojiPicker.tsx for React Native.
 */
import { useState, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  Image,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { useCustomEmojiSets } from '../../hooks/useCustomEmojiSets';

function isValidMediaUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}

const SCREEN_WIDTH = Dimensions.get('window').width;
const COLS = 6;
const CELL_SIZE = Math.floor((SCREEN_WIDTH - 32) / COLS);

interface CustomEmojiPickerProps {
  /** Called when a custom emoji is selected */
  onSelect: (shortcode: string, url: string) => void;
  /** When true, show emoji larger (sticker mode) */
  stickerMode?: boolean;
  /** Open the emoji set builder/manager */
  onOpenSetBuilder?: () => void;
}

export function CustomEmojiPicker({ onSelect, stickerMode = false, onOpenSetBuilder }: CustomEmojiPickerProps) {
  const { sets, isLoading } = useCustomEmojiSets();
  const [search, setSearch] = useState('');
  const [activeSet, setActiveSet] = useState(0);

  const filtered = useMemo(() => {
    if (!search) return null;
    const q = search.toLowerCase();
    const results: { shortcode: string; url: string }[] = [];
    for (const s of sets) {
      for (const e of s.emojis) {
        if (e.shortcode.toLowerCase().includes(q) && isValidMediaUrl(e.url)) {
          results.push(e);
        }
      }
    }
    return results;
  }, [search, sets]);

  const displayEmojis = filtered ?? (sets[activeSet]?.emojis.filter(e => isValidMediaUrl(e.url)) ?? []);
  const imgSize = stickerMode ? 56 : 32;
  const cols = stickerMode ? 4 : COLS;

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#888" />
      </View>
    );
  }

  if (sets.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No custom emoji sets found.</Text>
        {onOpenSetBuilder ? (
          <TouchableOpacity onPress={onOpenSetBuilder}>
            <Text style={styles.createLink}>Create Emoji Set</Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.emptyHint}>
            Create emoji sets in Settings, or follow someone who shares theirs.
          </Text>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Search */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search custom emoji..."
          placeholderTextColor="#666"
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>

      {/* Set tabs */}
      {!search && sets.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBar}
          contentContainerStyle={styles.tabBarContent}
        >
          {sets.map((s, i) => (
            <TouchableOpacity
              key={s.dTag}
              style={[styles.tab, activeSet === i && styles.tabActive]}
              onPress={() => setActiveSet(i)}
            >
              <Text
                style={[styles.tabText, activeSet === i && styles.tabTextActive]}
                numberOfLines={1}
              >
                {s.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Emoji grid */}
      <FlatList
        data={displayEmojis}
        keyExtractor={e => e.shortcode}
        numColumns={cols}
        key={cols}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.cell, { width: CELL_SIZE, height: CELL_SIZE }]}
            onPress={() => onSelect(item.shortcode, item.url)}
          >
            <Image
              source={{ uri: item.url }}
              style={{ width: imgSize, height: imgSize }}
              resizeMode="contain"
            />
          </TouchableOpacity>
        )}
        style={styles.grid}
        keyboardShouldPersistTaps="always"
        ListEmptyComponent={<Text style={styles.noResults}>No matches</Text>}
      />

      {/* Footer */}
      {onOpenSetBuilder && (
        <TouchableOpacity style={styles.footer} onPress={onOpenSetBuilder}>
          <Text style={styles.footerText}>{'\u2699\uFE0F'} Manage Sets</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 300,
  },
  loadingContainer: {
    height: 300,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    padding: 16,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#b3b3b3',
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
  },
  createLink: {
    fontSize: 13,
    color: '#a855f7',
    fontWeight: '500',
  },

  searchRow: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  searchInput: {
    backgroundColor: '#2a2a2a',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: '#f2f2f2',
    fontSize: 13,
  },

  tabBar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
    maxHeight: 38,
  },
  tabBarContent: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    gap: 4,
    alignItems: 'center',
  },
  tab: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  tabActive: {
    backgroundColor: '#3b1f5e',
  },
  tabText: {
    fontSize: 12,
    color: '#ccc',
  },
  tabTextActive: {
    color: '#c084fc',
  },

  grid: {
    flex: 1,
  },
  cell: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  noResults: {
    textAlign: 'center',
    color: '#666',
    fontSize: 13,
    paddingVertical: 24,
  },

  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#333',
    paddingVertical: 8,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 11,
    color: '#b3b3b3',
  },
});
