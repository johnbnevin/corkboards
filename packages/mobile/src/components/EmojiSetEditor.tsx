/**
 * EmojiSetEditor -- Editor for creating/editing custom NIP-30 emoji sets (kind 30030).
 * Supports upload, manual URL, inline shortcode editing, reordering,
 * browsing public sets, and favorites tracking.
 *
 * Port of packages/web/src/components/EmojiSetEditor.tsx for React Native.
 */
import { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Image,
  ActivityIndicator,
  Alert,
  StyleSheet,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useCustomEmojiSets, type EmojiSet, type CustomEmoji } from '../hooks/useCustomEmojiSets';
import { useNostrPublish } from '../hooks/useNostrPublish';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../hooks/useToast';
import { mobileStorage } from '../storage/MmkvStorage';

// ---- Favorites tracking ----
const FAVORITES_KEY = 'corkboard:emoji-favorites';
const MAX_FAVORITES = 50;

function getEmojiFavorites(): Record<string, number> {
  try { return JSON.parse(mobileStorage.getSync(FAVORITES_KEY) || '{}'); }
  catch { return {}; }
}

export function trackEmojiUse(emoji: string): void {
  const favs = getEmojiFavorites();
  favs[emoji] = (favs[emoji] || 0) + 1;
  const sorted = Object.entries(favs).sort((a, b) => b[1] - a[1]).slice(0, MAX_FAVORITES);
  try { mobileStorage.setSync(FAVORITES_KEY, JSON.stringify(Object.fromEntries(sorted))); } catch { /* */ }
}

function getTopFavorites(n = 32): string[] {
  const favs = getEmojiFavorites();
  return Object.entries(favs).sort((a, b) => b[1] - a[1]).slice(0, n).map(([e]) => e);
}

// ---- Types ----

type EditorView = 'list' | 'edit' | 'favorites';

interface EditingSet {
  dTag: string;
  name: string;
  emojis: CustomEmoji[];
  isNew: boolean;
}

// ---- Component ----

export function EmojiSetEditor() {
  const { sets, isLoading } = useCustomEmojiSets();
  const { mutateAsync: publish } = useNostrPublish();
  const { pubkey } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [view, setView] = useState<EditorView>('list');
  const [editing, setEditing] = useState<EditingSet | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Manual URL input
  const [manualUrl, setManualUrl] = useState('');
  const [manualShortcode, setManualShortcode] = useState('');

  // Inline shortcode editing
  const [editingShortcode, setEditingShortcode] = useState<string | null>(null);
  const [editingShortcodeValue, setEditingShortcodeValue] = useState('');

  const favorites = useMemo(() => getTopFavorites(32), []);

  // ---- Actions ----

  const startNewSet = useCallback(() => {
    setEditing({ dTag: `emoji-${Date.now()}`, name: '', emojis: [], isNew: true });
    setView('edit');
  }, []);

  const startEditSet = useCallback((set: EmojiSet) => {
    setEditing({ dTag: set.dTag, name: set.name, emojis: [...set.emojis], isNew: false });
    setView('edit');
  }, []);

  const addEmojiToSet = useCallback((shortcode: string, url: string) => {
    if (!editing) return;
    if (editing.emojis.some(e => e.shortcode === shortcode)) return;
    setEditing({ ...editing, emojis: [...editing.emojis, { shortcode, url }] });
  }, [editing]);

  const removeEmojiFromSet = useCallback((shortcode: string) => {
    if (!editing) return;
    setEditing({ ...editing, emojis: editing.emojis.filter(e => e.shortcode !== shortcode) });
  }, [editing]);

  const moveEmoji = useCallback((shortcode: string, direction: 'up' | 'down') => {
    if (!editing) return;
    const idx = editing.emojis.findIndex(e => e.shortcode === shortcode);
    if (idx < 0) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= editing.emojis.length) return;
    const newEmojis = [...editing.emojis];
    [newEmojis[idx], newEmojis[newIdx]] = [newEmojis[newIdx], newEmojis[idx]];
    setEditing({ ...editing, emojis: newEmojis });
  }, [editing]);

  const renameEmoji = useCallback((oldShortcode: string, newShortcode: string) => {
    if (!editing) return;
    const clean = newShortcode.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    if (!clean || clean === oldShortcode) { setEditingShortcode(null); return; }
    if (editing.emojis.some(e => e.shortcode === clean && e.shortcode !== oldShortcode)) {
      toast({ title: 'Duplicate shortcode', variant: 'destructive' });
      return;
    }
    setEditing({
      ...editing,
      emojis: editing.emojis.map(e => e.shortcode === oldShortcode ? { ...e, shortcode: clean } : e),
    });
    setEditingShortcode(null);
  }, [editing, toast]);

  const handleAddManualUrl = useCallback(() => {
    if (!manualUrl.trim() || !manualShortcode.trim()) return;
    const clean = manualShortcode.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    if (!clean) return;
    addEmojiToSet(clean, manualUrl.trim());
    setManualUrl('');
    setManualShortcode('');
  }, [manualUrl, manualShortcode, addEmojiToSet]);

  const handleSave = useCallback(async () => {
    if (!editing || !pubkey) return;
    if (!editing.name.trim()) {
      toast({ title: 'Name required', description: 'Give your emoji set a name', variant: 'destructive' });
      return;
    }
    if (editing.emojis.length === 0) {
      toast({ title: 'Empty set', description: 'Add at least one emoji', variant: 'destructive' });
      return;
    }

    setIsSaving(true);
    try {
      const tags: string[][] = [['d', editing.dTag], ['title', editing.name.trim()]];
      for (const emoji of editing.emojis) {
        tags.push(['emoji', emoji.shortcode, emoji.url]);
      }
      await publish({ kind: 30030, content: '', tags } as never);
      toast({ title: 'Published', description: `"${editing.name}" -- ${editing.emojis.length} emojis` });
      queryClient.invalidateQueries({ queryKey: ['custom-emoji-sets'] });
      setView('list');
      setEditing(null);
    } catch (err) {
      toast({ title: 'Save failed', description: String(err), variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  }, [editing, pubkey, publish, toast, queryClient]);

  const handleDelete = useCallback(async () => {
    if (!editing || !pubkey) return;
    Alert.alert(
      'Delete emoji set?',
      `This will permanently delete "${editing.name}" from Nostr.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setIsDeleting(true);
            try {
              await publish({ kind: 30030, content: '', tags: [['d', editing.dTag]] } as never);
              toast({ title: 'Deleted' });
              queryClient.invalidateQueries({ queryKey: ['custom-emoji-sets'] });
              setView('list');
              setEditing(null);
            } catch (err) {
              toast({ title: 'Delete failed', description: String(err), variant: 'destructive' });
            } finally {
              setIsDeleting(false);
            }
          },
        },
      ],
    );
  }, [editing, pubkey, publish, toast, queryClient]);

  const duplicateSet = useCallback((set: EmojiSet) => {
    setEditing({
      dTag: `emoji-${Date.now()}`,
      name: `${set.name} (copy)`,
      emojis: [...set.emojis],
      isNew: true,
    });
    setView('edit');
  }, []);

  // ---- Render ----

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#b3b3b3" />
      </View>
    );
  }

  // ---- Favorites view ----
  if (view === 'favorites') {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => setView('list')}>
            <Text style={styles.backBtn}>{'\u2190'} Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Emoji Favorites</Text>
        </View>
        <Text style={styles.hintText}>
          Your most-used emojis appear here automatically when you use them in posts.
        </Text>
        {favorites.length > 0 ? (
          <View style={styles.favoritesGrid}>
            {favorites.map((emoji, i) => (
              <Text key={`${emoji}-${i}`} style={styles.favoriteEmoji}>{emoji}</Text>
            ))}
          </View>
        ) : (
          <Text style={styles.emptyText}>
            No favorites yet. Use emojis in your posts and they'll appear here.
          </Text>
        )}
      </View>
    );
  }

  // ---- Edit view ----
  if (view === 'edit' && editing) {
    return (
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => { setView('list'); setEditing(null); }}>
            <Text style={styles.backBtn}>{'\u2190'} Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{editing.isNew ? 'New Emoji Set' : 'Edit Emoji Set'}</Text>
        </View>

        {/* Set name */}
        <TextInput
          style={styles.nameInput}
          placeholder="Set name (e.g. Reaction GIFs, My Stickers)"
          placeholderTextColor="#666"
          value={editing.name}
          onChangeText={name => setEditing({ ...editing, name })}
          autoFocus={editing.isNew}
        />

        {/* Current emojis */}
        {editing.emojis.length > 0 && (
          <View style={styles.emojiListCard}>
            <Text style={styles.emojiCountText}>{editing.emojis.length} emojis</Text>
            {editing.emojis.map((emoji, idx) => (
              <View key={emoji.shortcode} style={styles.emojiRow}>
                <Image
                  source={{ uri: emoji.url }}
                  style={styles.emojiThumb}
                  resizeMode="contain"
                />
                {editingShortcode === emoji.shortcode ? (
                  <View style={styles.editShortcodeRow}>
                    <TextInput
                      style={styles.shortcodeInput}
                      value={editingShortcodeValue}
                      onChangeText={setEditingShortcodeValue}
                      onSubmitEditing={() => renameEmoji(emoji.shortcode, editingShortcodeValue)}
                      autoFocus
                    />
                    <TouchableOpacity onPress={() => renameEmoji(emoji.shortcode, editingShortcodeValue)}>
                      <Text style={styles.confirmText}>{'\u2713'}</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.shortcodeBtn}
                    onPress={() => {
                      setEditingShortcode(emoji.shortcode);
                      setEditingShortcodeValue(emoji.shortcode);
                    }}
                  >
                    <Text style={styles.shortcodeText}>:{emoji.shortcode}:</Text>
                  </TouchableOpacity>
                )}
                <View style={styles.emojiActions}>
                  <TouchableOpacity
                    onPress={() => moveEmoji(emoji.shortcode, 'up')}
                    disabled={idx === 0}
                    style={[styles.actionBtn, idx === 0 && styles.actionBtnDisabled]}
                  >
                    <Text style={styles.actionBtnText}>{'\u2191'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => moveEmoji(emoji.shortcode, 'down')}
                    disabled={idx === editing.emojis.length - 1}
                    style={[styles.actionBtn, idx === editing.emojis.length - 1 && styles.actionBtnDisabled]}
                  >
                    <Text style={styles.actionBtnText}>{'\u2193'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => removeEmojiFromSet(emoji.shortcode)}
                    style={styles.removeBtn}
                  >
                    <Text style={styles.removeBtnText}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Manual URL input */}
        <Text style={styles.sectionLabel}>Add emoji by URL</Text>
        <View style={styles.manualRow}>
          <TextInput
            style={[styles.manualInput, { width: 80 }]}
            placeholder="shortcode"
            placeholderTextColor="#666"
            value={manualShortcode}
            onChangeText={setManualShortcode}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={[styles.manualInput, { flex: 1 }]}
            placeholder="Image or GIF URL..."
            placeholderTextColor="#666"
            value={manualUrl}
            onChangeText={setManualUrl}
            onSubmitEditing={handleAddManualUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[styles.addBtn, (!manualUrl.trim() || !manualShortcode.trim()) && styles.addBtnDisabled]}
            onPress={handleAddManualUrl}
            disabled={!manualUrl.trim() || !manualShortcode.trim()}
          >
            <Text style={styles.addBtnText}>+</Text>
          </TouchableOpacity>
        </View>

        {/* Save / Delete */}
        <View style={styles.saveRow}>
          <TouchableOpacity
            style={[styles.saveBtn, isSaving && styles.saveBtnDisabled]}
            onPress={handleSave}
            disabled={isSaving}
          >
            {isSaving ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.saveBtnText}>
                {editing.isNew ? 'Publish Set' : 'Save Changes'}
              </Text>
            )}
          </TouchableOpacity>
          {!editing.isNew && (
            <TouchableOpacity
              style={styles.deleteBtn}
              onPress={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.deleteBtnText}>{'\u{1F5D1}'}</Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Bottom spacing */}
        <View style={{ height: 40 }} />
      </ScrollView>
    );
  }

  // ---- List view (default) ----
  return (
    <ScrollView style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>Custom Emoji Sets</Text>
        <TouchableOpacity style={styles.newBtn} onPress={startNewSet}>
          <Text style={styles.newBtnText}>+ New Set</Text>
        </TouchableOpacity>
      </View>

      {/* Favorites card */}
      <TouchableOpacity style={styles.listCard} onPress={() => setView('favorites')}>
        <Text style={styles.cardIcon}>{'\u2B50'}</Text>
        <View style={styles.cardInfo}>
          <Text style={styles.cardTitle}>Favorites</Text>
          <Text style={styles.cardSub}>
            {favorites.length > 0 ? `${favorites.length} frequently used` : 'Auto-tracked from usage'}
          </Text>
        </View>
        {favorites.length > 0 && (
          <View style={styles.previewRow}>
            {favorites.slice(0, 5).map((e, i) => (
              <Text key={i} style={styles.previewEmoji}>{e}</Text>
            ))}
          </View>
        )}
      </TouchableOpacity>

      {/* Existing sets */}
      {sets.filter(s => s.pubkey !== 'built-in').length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>No custom emoji sets yet.</Text>
          <Text style={styles.hintText}>
            Create a set and add images or GIFs, or browse public sets from other Nostr users.
          </Text>
        </View>
      ) : (
        sets.filter(s => s.pubkey !== 'built-in').map(set => {
          const isOwned = set.pubkey === pubkey;
          return (
            <TouchableOpacity
              key={`${set.pubkey}:${set.dTag}`}
              style={[styles.listCard, isOwned && styles.listCardOwned]}
              onPress={() => isOwned ? startEditSet(set) : duplicateSet(set)}
            >
              <View style={styles.cardInfo}>
                <View style={styles.cardTitleRow}>
                  <Text style={[styles.cardTitle, isOwned && styles.cardTitleOwned]}>{set.name}</Text>
                  {isOwned ? (
                    <Text style={styles.ownedBadge}>Your set</Text>
                  ) : (
                    <Text style={styles.savedBadge}>Saved</Text>
                  )}
                </View>
                <Text style={styles.cardSub}>{set.emojis.length} emojis</Text>
              </View>
              <View style={styles.previewRow}>
                {set.emojis.slice(0, 4).map(e => (
                  <Image
                    key={e.shortcode}
                    source={{ uri: e.url }}
                    style={styles.previewImage}
                    resizeMode="contain"
                  />
                ))}
                {set.emojis.length > 4 && (
                  <Text style={styles.moreText}>+{set.emojis.length - 4}</Text>
                )}
              </View>
            </TouchableOpacity>
          );
        })
      )}

      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
  },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    gap: 8,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#f2f2f2',
    flex: 1,
  },
  backBtn: {
    fontSize: 14,
    color: '#a855f7',
    fontWeight: '500',
  },
  newBtn: {
    backgroundColor: '#a855f7',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  newBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },

  // List card
  listCard: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: '#404040',
  },
  listCardOwned: {
    borderColor: 'rgba(168, 85, 247, 0.4)',
  },
  cardIcon: {
    fontSize: 18,
  },
  cardInfo: {
    flex: 1,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#f2f2f2',
  },
  cardTitleOwned: {
    color: '#c084fc',
  },
  cardSub: {
    fontSize: 12,
    color: '#b3b3b3',
    marginTop: 1,
  },
  ownedBadge: {
    fontSize: 10,
    color: '#a855f7',
    backgroundColor: 'rgba(168, 85, 247, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  savedBadge: {
    fontSize: 10,
    color: '#b3b3b3',
    backgroundColor: '#333',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  previewRow: {
    flexDirection: 'row',
    gap: 4,
    alignItems: 'center',
  },
  previewEmoji: {
    fontSize: 14,
  },
  previewImage: {
    width: 24,
    height: 24,
    borderRadius: 4,
  },
  moreText: {
    fontSize: 11,
    color: '#b3b3b3',
  },

  // Empty
  emptyState: {
    paddingVertical: 24,
    alignItems: 'center',
    gap: 4,
  },
  emptyText: {
    fontSize: 14,
    color: '#b3b3b3',
    textAlign: 'center',
  },
  hintText: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
    paddingHorizontal: 16,
  },

  // Favorites
  favoritesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    paddingVertical: 12,
  },
  favoriteEmoji: {
    fontSize: 22,
    width: 36,
    height: 36,
    textAlign: 'center',
    lineHeight: 36,
  },

  // Edit view
  nameInput: {
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f2f2f2',
    fontSize: 14,
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 12,
    color: '#b3b3b3',
    fontWeight: '500',
    marginTop: 12,
    marginBottom: 6,
  },

  emojiListCard: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  emojiCountText: {
    fontSize: 12,
    color: '#b3b3b3',
    marginBottom: 8,
  },
  emojiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#404040',
  },
  emojiThumb: {
    width: 32,
    height: 32,
    borderRadius: 4,
  },
  shortcodeBtn: {
    flex: 1,
  },
  shortcodeText: {
    fontSize: 12,
    color: '#b3b3b3',
    fontFamily: 'monospace',
  },
  editShortcodeRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  shortcodeInput: {
    flex: 1,
    backgroundColor: '#333',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    color: '#f2f2f2',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  confirmText: {
    color: '#22c55e',
    fontSize: 16,
    fontWeight: '700',
  },
  emojiActions: {
    flexDirection: 'row',
    gap: 4,
  },
  actionBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnDisabled: {
    opacity: 0.3,
  },
  actionBtnText: {
    color: '#b3b3b3',
    fontSize: 14,
  },
  removeBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: {
    color: '#ef4444',
    fontSize: 12,
  },

  // Manual URL
  manualRow: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  manualInput: {
    backgroundColor: '#2a2a2a',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 8,
    color: '#f2f2f2',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  addBtn: {
    backgroundColor: '#a855f7',
    width: 36,
    height: 36,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnDisabled: {
    opacity: 0.4,
  },
  addBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },

  // Save/Delete
  saveRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  saveBtn: {
    flex: 1,
    backgroundColor: '#7c3aed',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  deleteBtn: {
    backgroundColor: '#ef4444',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnText: {
    fontSize: 18,
  },
});
