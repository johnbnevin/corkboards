/**
 * Mobile emoji picker — React Native translation of web's CombinedEmojiPicker.
 *
 * Renders as a bottom-sheet Modal with:
 * - Search across standard + custom emoji
 * - Tabs: ⭐ Favorites | 📌 Default | category icons | custom sets
 * - NIP-30 custom emoji support (image-based, shortcode tags)
 * - Favorites tracked in MMKV (same key as web: 'corkboard:emoji-favorites')
 */
import { useState, useMemo, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  Image,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { EMOJI_CATEGORIES } from '@core/emojiCategories';
import { CORKBOARDS_DEFAULT_EMOJIS } from '@core/defaultEmojiSet';
import { useCustomEmojiSets } from '../hooks/useCustomEmojiSets';
import { mobileStorage } from '../storage/MmkvStorage';

// ── Favorites tracking (mirrors web's trackEmojiUse in EmojiSetEditor.tsx) ──
const FAVORITES_KEY = 'corkboard:emoji-favorites';
const MAX_FAVORITES = 50;

function getEmojiFavorites(): Record<string, number> {
  try {
    return JSON.parse(mobileStorage.getSync(FAVORITES_KEY) || '{}');
  } catch { return {}; }
}

function trackEmojiUse(emoji: string): void {
  const favs = getEmojiFavorites();
  favs[emoji] = (favs[emoji] || 0) + 1;
  const sorted = Object.entries(favs).sort((a, b) => b[1] - a[1]).slice(0, MAX_FAVORITES);
  try { mobileStorage.setSync(FAVORITES_KEY, JSON.stringify(Object.fromEntries(sorted))); } catch { /* ignore */ }
}

function getFavoriteEmojis(): string[] {
  const favs = getEmojiFavorites();
  return Object.entries(favs).sort((a, b) => b[1] - a[1]).slice(0, 32).map(([e]) => e);
}

function isValidMediaUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}

// ── Props ────────────────────────────────────────────────────────────────────

interface EmojiPickerProps {
  /** Triggered when a standard unicode emoji is selected */
  onSelectEmoji: (emoji: string) => void;
  /** Triggered when a NIP-30 custom emoji is selected */
  onSelectCustomEmoji: (shortcode: string, url: string) => void;
}

// ── Tab types (mirrors web) ──────────────────────────────────────────────────

type TabKind =
  | { type: 'favorites' }
  | { type: 'corkboards-default' }
  | { type: 'category'; index: number }
  | { type: 'custom'; setIndex: number };

// ── Component ────────────────────────────────────────────────────────────────

const SCREEN_WIDTH = Dimensions.get('window').width;
const STANDARD_COLS = 8;
const CUSTOM_COLS = 6;
const CELL_SIZE = Math.floor(SCREEN_WIDTH / STANDARD_COLS);
const CUSTOM_CELL_SIZE = Math.floor(SCREEN_WIDTH / CUSTOM_COLS);

export function EmojiPicker({ onSelectEmoji, onSelectCustomEmoji }: EmojiPickerProps) {
  const { sets, isLoading } = useCustomEmojiSets();
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<TabKind>({ type: 'favorites' });

  const favorites = useMemo(() => getFavoriteEmojis(), []);

  const handleSelectEmoji = useCallback((emoji: string) => {
    trackEmojiUse(emoji);
    onSelectEmoji(emoji);
  }, [onSelectEmoji]);

  // Search across standard + custom emoji (mirrors web)
  const searchResults = useMemo(() => {
    if (!search) return null;
    const q = search.toLowerCase();
    const standardMatches: string[] = [];
    for (const cat of EMOJI_CATEGORIES) {
      if (cat.name.toLowerCase().includes(q)) standardMatches.push(...cat.emojis);
    }
    const customMatches: { shortcode: string; url: string }[] = [];
    for (const s of sets) {
      for (const e of s.emojis) {
        if (e.shortcode.toLowerCase().includes(q) && isValidMediaUrl(e.url)) customMatches.push(e);
      }
    }
    return { standardMatches, customMatches };
  }, [search, sets]);

  // What to render in the main grid
  const standardEmojis = useMemo(() => {
    if (activeTab.type === 'favorites') {
      return favorites.length > 0 ? favorites : (EMOJI_CATEGORIES[0]?.emojis ?? []);
    }
    if (activeTab.type === 'category') return EMOJI_CATEGORIES[activeTab.index]?.emojis ?? [];
    return [];
  }, [activeTab, favorites]);

  const customEmojis = useMemo(() => {
    if (activeTab.type === 'corkboards-default') {
      return CORKBOARDS_DEFAULT_EMOJIS.filter(e => isValidMediaUrl(e.url));
    }
    if (activeTab.type === 'custom') {
      return (sets[activeTab.setIndex]?.emojis ?? []).filter(e => isValidMediaUrl(e.url));
    }
    return [];
  }, [activeTab, sets]);

  const isCustomTab = activeTab.type === 'corkboards-default' || activeTab.type === 'custom';

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={styles.sheet}>
      {/* Handle bar */}
      <View style={styles.handle} />

      {/* Search */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search emoji..."
          placeholderTextColor="#666"
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>

      {/* Tabs */}
      {!search && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBar}
          contentContainerStyle={styles.tabBarContent}
        >
          {/* Favorites */}
          {favorites.length > 0 && (
            <TouchableOpacity
              style={[styles.tab, activeTab.type === 'favorites' && styles.tabActive]}
              onPress={() => setActiveTab({ type: 'favorites' })}
            >
              <Text style={styles.tabEmoji}>⭐</Text>
            </TouchableOpacity>
          )}

          {/* Corkboards Default */}
          <TouchableOpacity
            style={[styles.tab, activeTab.type === 'corkboards-default' && styles.tabActive]}
            onPress={() => setActiveTab({ type: 'corkboards-default' })}
          >
            <Text style={styles.tabEmoji}>📌</Text>
            <Text style={styles.tabLabel}>default</Text>
          </TouchableOpacity>

          {/* Standard emoji category icons */}
          {EMOJI_CATEGORIES.map((cat, i) => (
            <TouchableOpacity
              key={cat.name}
              style={[styles.tab, activeTab.type === 'category' && activeTab.index === i && styles.tabActive]}
              onPress={() => setActiveTab({ type: 'category', index: i })}
            >
              <Text style={styles.tabEmoji}>{cat.icon}</Text>
            </TouchableOpacity>
          ))}

          {/* Separator before custom sets */}
          {sets.length > 0 && <View style={styles.tabSeparator} />}

          {/* Custom emoji set tabs */}
          {sets.map((s, i) => (
            <TouchableOpacity
              key={`${s.dTag}-${i}`}
              style={[
                styles.tab,
                styles.tabText,
                activeTab.type === 'custom' && activeTab.setIndex === i && styles.tabCustomActive,
              ]}
              onPress={() => setActiveTab({ type: 'custom', setIndex: i })}
            >
              <Text
                style={[
                  styles.tabTextLabel,
                  activeTab.type === 'custom' && activeTab.setIndex === i && styles.tabCustomActiveText,
                ]}
                numberOfLines={1}
              >
                {s.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Content */}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color="#888" />
        </View>
      ) : search && searchResults ? (
        // Search results
        <ScrollView style={styles.scrollArea} keyboardShouldPersistTaps="always">
          {searchResults.standardMatches.length > 0 && (
            <View style={styles.grid}>
              {searchResults.standardMatches.map((emoji, i) => (
                <TouchableOpacity
                  key={`${emoji}-${i}`}
                  style={[styles.cell, { width: CELL_SIZE, height: CELL_SIZE }]}
                  onPress={() => handleSelectEmoji(emoji)}
                >
                  <Text style={styles.emoji}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {searchResults.standardMatches.length > 0 && searchResults.customMatches.length > 0 && (
            <View style={styles.divider} />
          )}
          {searchResults.customMatches.length > 0 && (
            <View style={styles.customGrid}>
              {searchResults.customMatches.map(e => (
                <TouchableOpacity
                  key={e.shortcode}
                  style={[styles.customCell, { width: CUSTOM_CELL_SIZE, height: CUSTOM_CELL_SIZE }]}
                  onPress={() => onSelectCustomEmoji(e.shortcode, e.url)}
                >
                  <Image
                    source={{ uri: e.url }}
                    style={styles.customImage}
                    resizeMode="contain"
                  />
                </TouchableOpacity>
              ))}
            </View>
          )}
          {searchResults.standardMatches.length === 0 && searchResults.customMatches.length === 0 && (
            <Text style={styles.noResults}>No matches</Text>
          )}
        </ScrollView>
      ) : isCustomTab ? (
        // Custom emoji grid (image-based)
        <FlatList
          data={customEmojis}
          keyExtractor={e => e.shortcode}
          numColumns={CUSTOM_COLS}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.customCell, { width: CUSTOM_CELL_SIZE, height: CUSTOM_CELL_SIZE }]}
              onPress={() => onSelectCustomEmoji(item.shortcode, item.url)}
            >
              <Image
                source={{ uri: item.url }}
                style={styles.customImage}
                resizeMode="contain"
              />
            </TouchableOpacity>
          )}
          keyboardShouldPersistTaps="always"
          style={styles.scrollArea}
        />
      ) : (
        // Standard unicode emoji grid
        <FlatList
          data={standardEmojis}
          keyExtractor={(item, i) => `${item}-${i}`}
          numColumns={STANDARD_COLS}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.cell, { width: CELL_SIZE, height: CELL_SIZE }]}
              onPress={() => handleSelectEmoji(item)}
            >
              <Text style={styles.emoji}>{item}</Text>
            </TouchableOpacity>
          )}
          keyboardShouldPersistTaps="always"
          style={styles.scrollArea}
        />
      )}
    </View>
  );
}

// ── EmojiPickerModal — wraps EmojiPicker in a slide-up Modal ─────────────────

interface EmojiPickerModalProps extends EmojiPickerProps {
  visible: boolean;
  onClose: () => void;
}

export function EmojiPickerModal({ visible, onClose, onSelectEmoji, onSelectCustomEmoji }: EmojiPickerModalProps) {
  const handleSelectEmoji = useCallback((emoji: string) => {
    onSelectEmoji(emoji);
    onClose();
  }, [onSelectEmoji, onClose]);

  const handleSelectCustomEmoji = useCallback((shortcode: string, url: string) => {
    onSelectCustomEmoji(shortcode, url);
    onClose();
  }, [onSelectCustomEmoji, onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent={Platform.OS === 'android'}
    >
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose} />
      <EmojiPicker onSelectEmoji={handleSelectEmoji} onSelectCustomEmoji={handleSelectCustomEmoji} />
    </Modal>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: '#1f1f1f',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '60%',
    paddingBottom: Platform.OS === 'ios' ? 24 : 8,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#444',
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 4,
  },

  // Search
  searchRow: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  searchInput: {
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    color: '#f2f2f2',
    fontSize: 14,
  },

  // Tabs
  tabBar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
    maxHeight: 44,
  },
  tabBarContent: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    gap: 2,
    alignItems: 'center',
  },
  tab: {
    padding: 4,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 32,
  },
  tabActive: {
    backgroundColor: '#333',
  },
  tabText: {
    paddingHorizontal: 8,
  },
  tabCustomActive: {
    backgroundColor: '#3b1f5e',
  },
  tabEmoji: {
    fontSize: 18,
    lineHeight: 22,
  },
  tabLabel: {
    fontSize: 7,
    color: '#888',
    lineHeight: 8,
    marginTop: -1,
  },
  tabTextLabel: {
    fontSize: 12,
    color: '#ccc',
  },
  tabCustomActiveText: {
    color: '#c084fc',
  },
  tabSeparator: {
    width: 1,
    height: 24,
    backgroundColor: '#333',
    marginHorizontal: 2,
  },

  // Content
  scrollArea: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
  },

  // Standard emoji grid
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 4,
  },
  cell: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 22,
  },

  // Custom emoji grid
  customGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 4,
  },
  customCell: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  customImage: {
    width: '80%',
    height: '80%',
  },

  // Search
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#333',
    marginVertical: 6,
    marginHorizontal: 8,
  },
  noResults: {
    textAlign: 'center',
    color: '#666',
    fontSize: 14,
    paddingVertical: 24,
  },
});
