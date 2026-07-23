/**
 * TrackerWarningDialog — shown when the user taps a link that carries known
 * tracking parameters. We never rewrite the note — the link renders exactly as
 * the author wrote it — but before following it the user chooses: open it
 * clean, open the original, or just copy either form. Cypherpunk default: the
 * primary action is clean.
 *
 * Mobile equivalent of packages/web/src/components/TrackerWarningDialog.tsx.
 */
import { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Linking,
  StyleSheet,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';

interface TrackerWarningDialogProps {
  visible: boolean;
  onClose: () => void;
  /** The URL exactly as it appeared in the note (with trackers). */
  rawUrl: string;
  /** The tracker-stripped URL. */
  cleanUrl: string;
  /** Names of the tracking params detected (utm_source, fbclid, …). */
  trackingParams: string[];
}

export function TrackerWarningDialog({ visible, onClose, rawUrl, cleanUrl, trackingParams }: TrackerWarningDialogProps) {
  const [copiedWhich, setCopiedWhich] = useState<'clean' | 'original' | null>(null);

  const copy = async (text: string, which: 'clean' | 'original') => {
    try {
      await Clipboard.setStringAsync(text);
      setCopiedWhich(which);
      setTimeout(() => setCopiedWhich(null), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const open = (url: string) => {
    onClose();
    Linking.openURL(url);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.card} onPress={() => { /* swallow */ }}>
          <View style={styles.header}>
            <Text style={styles.shield}>⚠</Text>
            <Text style={styles.title}>This link contains trackers</Text>
          </View>
          <Text style={styles.description}>
            Tracking parameter{trackingParams.length === 1 ? '' : 's'} detected:{' '}
            <Text style={styles.mono}>{trackingParams.join(', ')}</Text>
          </Text>
          <View style={styles.urlBox}>
            <Text style={styles.urlText} numberOfLines={4}>{cleanUrl}</Text>
          </View>

          <TouchableOpacity style={styles.primaryButton} onPress={() => open(cleanUrl)}>
            <Text style={styles.primaryButtonText}>Open without trackers</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.outlineButton} onPress={() => open(rawUrl)}>
            <Text style={styles.outlineButtonText}>Open original (with trackers)</Text>
          </TouchableOpacity>
          <View style={styles.copyRow}>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => copy(cleanUrl, 'clean')}>
              <Text style={styles.secondaryButtonText}>
                {copiedWhich === 'clean' ? 'Copied' : 'Copy clean'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => copy(rawUrl, 'original')}>
              <Text style={styles.secondaryButtonText}>
                {copiedWhich === 'original' ? 'Copied' : 'Copy original'}
              </Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.outlineButton} onPress={onClose}>
            <Text style={styles.outlineButtonText}>Cancel</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#2a2a2a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#404040',
    padding: 16,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  shield: { color: '#f59e0b', fontSize: 18 },
  title: { color: '#f2f2f2', fontSize: 15, fontWeight: '600', flex: 1 },
  description: { color: '#b3b3b3', fontSize: 13, lineHeight: 18 },
  mono: { fontFamily: 'monospace', fontSize: 11, color: '#b3b3b3' },
  urlBox: {
    backgroundColor: '#1f1f1f',
    borderRadius: 8,
    padding: 8,
    marginBottom: 4,
  },
  urlText: { color: '#999', fontFamily: 'monospace', fontSize: 11 },
  primaryButton: {
    backgroundColor: '#a855f7',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  outlineButton: {
    borderWidth: 1,
    borderColor: '#404040',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  outlineButtonText: { color: '#f2f2f2', fontSize: 14, fontWeight: '500' },
  copyRow: { flexDirection: 'row', gap: 8 },
  secondaryButton: {
    flex: 1,
    backgroundColor: '#333',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryButtonText: { color: '#f2f2f2', fontSize: 13, fontWeight: '500' },
});
