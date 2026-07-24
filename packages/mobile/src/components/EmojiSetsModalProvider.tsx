/**
 * EmojiSetsModalProvider — makes the custom emoji set editor ("Manage Sets")
 * reachable from anywhere (note reaction pickers, compose pickers), not just the
 * Settings screen. Renders the EmojiSetEditor in a full-screen modal and exposes
 * open() via context. Mount once near the app root, inside the auth/nostr tree.
 */
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { EmojiSetEditor } from './EmojiSetEditor';

interface EmojiSetsModalValue {
  /** Open the "Manage Sets" editor modal. */
  open: () => void;
}

const EmojiSetsModalContext = createContext<EmojiSetsModalValue>({ open: () => {} });

/** Open the custom emoji set editor from anywhere. */
export function useEmojiSetsModal(): EmojiSetsModalValue {
  return useContext(EmojiSetsModalContext);
}

export function EmojiSetsModalProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);

  return (
    <EmojiSetsModalContext.Provider value={{ open }}>
      {children}
      <Modal visible={visible} animationType="slide" onRequestClose={close} statusBarTranslucent>
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>Emoji Sets</Text>
            <TouchableOpacity onPress={close} style={styles.closeBtn}>
              <Text style={styles.closeText}>Done</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <EmojiSetEditor />
          </ScrollView>
        </View>
      </Modal>
    </EmojiSetsModalContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#404040',
  },
  title: { color: '#f2f2f2', fontSize: 18, fontWeight: '600' },
  closeBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  closeText: { color: '#a855f7', fontSize: 15, fontWeight: '600' },
  body: { padding: 16 },
});
