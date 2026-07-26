/**
 * CorkboardBuilderModal — create or edit a custom corkboard from mixed sources:
 * Nostr authors (npub/nprofile/hex), #hashtags, relay URLs (wss://), and RSS
 * feeds (https URL / bare domain). Mobile parity with web's TabBar builder.
 *
 * Source classification is the shared core `parseFeedSource` (nip19 injected);
 * this component is just the RN entry UI + badge management.
 */
import { useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert } from 'react-native';
import { nip19 } from 'nostr-tools';
import { parseFeedSource } from '@core/feedSource';
import { genUserName } from '@core/genUserName';
import { useAuthor } from '../hooks/useAuthor';

export interface CorkboardDraft {
  id: string;
  title: string;
  pubkeys: string[];
  relays: string[];
  rssUrls: string[];
  hashtags: string[];
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onSave: (feed: CorkboardDraft) => void;
  onDelete?: (id: string) => void;
  /** When set, the modal edits this board; otherwise it creates a new one. */
  editingFeed?: CorkboardDraft | null;
  /** Bumped by the parent on each open so the form re-seeds from `editingFeed`. */
  resetKey: number;
}

function decodeNpub(input: string): string | null {
  try {
    const d = nip19.decode(input);
    if (d.type === 'npub') return d.data as string;
    if (d.type === 'nprofile') return (d.data as { pubkey: string }).pubkey;
  } catch { /* not an npub/nprofile */ }
  return null;
}

/** A removable author chip that shows the display name, not raw hex. */
function AuthorChip({ pubkey, onRemove }: { pubkey: string; onRemove: () => void }) {
  const { data } = useAuthor(pubkey);
  const name = data?.metadata?.display_name || data?.metadata?.name || genUserName(pubkey);
  return (
    <View style={[styles.chip, styles.chipPubkey]}>
      <Text style={styles.chipText} numberOfLines={1}>{name}</Text>
      <TouchableOpacity onPress={onRemove} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
        <Text style={styles.chipRemove}>×</Text>
      </TouchableOpacity>
    </View>
  );
}

function Chip({ label, style, onRemove }: { label: string; style?: object; onRemove: () => void }) {
  return (
    <View style={[styles.chip, style]}>
      <Text style={styles.chipText} numberOfLines={1}>{label}</Text>
      <TouchableOpacity onPress={onRemove} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
        <Text style={styles.chipRemove}>×</Text>
      </TouchableOpacity>
    </View>
  );
}

export function CorkboardBuilderModal({ visible, onClose, onSave, onDelete, editingFeed, resetKey }: Props) {
  const [title, setTitle] = useState('');
  const [pubkeys, setPubkeys] = useState<string[]>([]);
  const [relays, setRelays] = useState<string[]>([]);
  const [rssUrls, setRssUrls] = useState<string[]>([]);
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [input, setInput] = useState('');

  // Seed (or reset) the form each time the parent opens the modal. The parent
  // bumps `resetKey` on open; adjusting state during render (React's supported
  // "reset on prop change" pattern) re-seeds without an effect or cascading render.
  const [seededKey, setSeededKey] = useState(resetKey);
  if (resetKey !== seededKey) {
    setSeededKey(resetKey);
    setTitle(editingFeed?.title ?? '');
    setPubkeys(editingFeed?.pubkeys ?? []);
    setRelays(editingFeed?.relays ?? []);
    setRssUrls(editingFeed?.rssUrls ?? []);
    setHashtags(editingFeed?.hashtags ?? []);
    setInput('');
  }

  const addToSet = (setter: React.Dispatch<React.SetStateAction<string[]>>, value: string) =>
    setter(prev => (prev.includes(value) ? prev : [...prev, value]));

  const addSources = () => {
    const items = input.split(',').map(s => s.trim()).filter(Boolean);
    let added = false;
    let upgraded = false;
    const rejected: string[] = [];
    for (const item of items) {
      const parsed = parseFeedSource(item, decodeNpub);
      if (!parsed) { rejected.push(item); continue; }
      added = true;
      if (parsed.type === 'pubkey') addToSet(setPubkeys, parsed.value);
      else if (parsed.type === 'relay') addToSet(setRelays, parsed.value);
      else if (parsed.type === 'hashtag') addToSet(setHashtags, parsed.value);
      else { addToSet(setRssUrls, parsed.value); if (parsed.httpsUpgraded) upgraded = true; }
    }
    if (added) setInput('');
    if (rejected.length) {
      Alert.alert('Not recognized', `Couldn't add: ${rejected.join(', ')}\n\nUse an npub, #hashtag, wss:// relay, or a website/RSS URL.`);
    } else if (upgraded) {
      Alert.alert('Upgraded to https', 'RSS feeds are fetched over https.');
    }
  };

  const total = pubkeys.length + relays.length + rssUrls.length + hashtags.length;

  const save = () => {
    if (total === 0) {
      Alert.alert('Add a source', 'Add at least one npub, #hashtag, relay, or RSS feed.');
      return;
    }
    onSave({
      id: editingFeed?.id ?? Date.now().toString(),
      title: title.trim() || (hashtags[0] ? `#${hashtags[0]}` : 'Corkboard'),
      pubkeys, relays, rssUrls, hashtags,
    });
    onClose();
  };

  const confirmDelete = () => {
    if (!editingFeed || !onDelete) return;
    Alert.alert('Delete corkboard?', `Remove "${editingFeed.title}"? This can't be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { onDelete(editingFeed.id); onClose(); } },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.headerRow}>
            <Text style={styles.heading}>{editingFeed ? 'Edit corkboard' : 'New corkboard'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.close}>×</Text>
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Title</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="My corkboard"
              placeholderTextColor="#666"
            />

            <Text style={styles.label}>Add a source</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                value={input}
                onChangeText={setInput}
                placeholder="npub…, #hashtag, wss://relay, website.com"
                placeholderTextColor="#666"
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={addSources}
                returnKeyType="done"
              />
              <TouchableOpacity style={styles.addBtn} onPress={addSources}>
                <Text style={styles.addBtnText}>Add</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>npubs, #hashtags, wss:// relays, and RSS/website URLs. Separate multiple with commas.</Text>

            {total > 0 && (
              <View style={styles.chipWrap}>
                {hashtags.map(h => <Chip key={`h-${h}`} label={`#${h}`} style={styles.chipHashtag} onRemove={() => setHashtags(prev => prev.filter(x => x !== h))} />)}
                {pubkeys.map(pk => <AuthorChip key={`p-${pk}`} pubkey={pk} onRemove={() => setPubkeys(prev => prev.filter(x => x !== pk))} />)}
                {relays.map(r => <Chip key={`r-${r}`} label={r.replace(/^wss?:\/\//, '')} style={styles.chipRelay} onRemove={() => setRelays(prev => prev.filter(x => x !== r))} />)}
                {rssUrls.map(u => <Chip key={`u-${u}`} label={u.replace(/^https?:\/\//, '')} style={styles.chipRss} onRemove={() => setRssUrls(prev => prev.filter(x => x !== u))} />)}
              </View>
            )}
          </ScrollView>

          <View style={styles.footer}>
            {editingFeed && onDelete ? (
              <TouchableOpacity style={styles.deleteBtn} onPress={confirmDelete}>
                <Text style={styles.deleteBtnText}>Delete</Text>
              </TouchableOpacity>
            ) : <View style={{ flex: 1 }} />}
            <TouchableOpacity style={styles.saveBtn} onPress={save}>
              <Text style={styles.saveBtnText}>{editingFeed ? 'Save' : 'Create'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#1f1f1f', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 18, maxHeight: '85%' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  heading: { color: '#f2f2f2', fontSize: 18, fontWeight: '700' },
  close: { color: '#b3b3b3', fontSize: 26, lineHeight: 26 },
  label: { color: '#b3b3b3', fontSize: 12, marginBottom: 6, marginTop: 8 },
  input: {
    backgroundColor: '#2a2a2a', color: '#f2f2f2', borderRadius: 8,
    borderWidth: 1, borderColor: '#404040', paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8,
  },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addBtn: { backgroundColor: '#f97316', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 11 },
  addBtnText: { color: '#fff', fontWeight: '700' },
  hint: { color: '#666', fontSize: 11, marginTop: 4, marginBottom: 4 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, borderWidth: 1,
  },
  chipPubkey: { backgroundColor: '#2a2333', borderColor: '#7c3aed' },
  chipHashtag: { backgroundColor: '#1e2a33', borderColor: '#3b82f6' },
  chipRelay: { backgroundColor: '#1e3325', borderColor: '#22c55e' },
  chipRss: { backgroundColor: '#33261e', borderColor: '#f97316' },
  chipText: { color: '#f2f2f2', fontSize: 12, flexShrink: 1 },
  chipRemove: { color: '#b3b3b3', fontSize: 16, fontWeight: '700' },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, gap: 10 },
  deleteBtn: { paddingVertical: 11, paddingHorizontal: 16 },
  deleteBtnText: { color: '#ef4444', fontWeight: '600' },
  saveBtn: { backgroundColor: '#f97316', borderRadius: 8, paddingVertical: 11, paddingHorizontal: 28 },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
