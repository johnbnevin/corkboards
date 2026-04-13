/**
 * CombinedEmojiPicker -- Combined picker with tabs for standard + custom emoji.
 * Includes favorites, corkboards default set, standard emoji categories, and
 * NIP-30 custom emoji sets.
 *
 * Port of packages/web/src/components/compose/CombinedEmojiPicker.tsx for React Native.
 * This is essentially the same as EmojiPicker.tsx but exported with a different name
 * for API parity with web. The existing EmojiPicker already implements CombinedEmojiPicker
 * functionality, so this is a thin re-export wrapper.
 */
import { useCallback } from 'react';
import {
  View,
  Modal,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { EmojiPicker } from '../EmojiPicker';

interface CombinedEmojiPickerProps {
  /** Standard emoji selected (unicode string) */
  onSelectEmoji: (emoji: string) => void;
  /** Custom emoji selected (shortcode + image URL) */
  onSelectCustomEmoji: (shortcode: string, url: string) => void;
  /** Open the emoji set builder/manager */
  onOpenSetBuilder?: () => void;
}

/**
 * CombinedEmojiPicker -- renders the combined standard + custom emoji picker inline.
 * This wraps the existing EmojiPicker component which already has tabs for
 * favorites, default set, standard categories, and custom sets.
 */
export function CombinedEmojiPicker({
  onSelectEmoji,
  onSelectCustomEmoji,
  onOpenSetBuilder: _onOpenSetBuilder,
}: CombinedEmojiPickerProps) {
  return (
    <View style={styles.container}>
      <EmojiPicker
        onSelectEmoji={onSelectEmoji}
        onSelectCustomEmoji={onSelectCustomEmoji}
      />
    </View>
  );
}

/**
 * CombinedEmojiPickerModal -- modal wrapper for CombinedEmojiPicker.
 */
interface CombinedEmojiPickerModalProps extends CombinedEmojiPickerProps {
  visible: boolean;
  onClose: () => void;
}

export function CombinedEmojiPickerModal({
  visible,
  onClose,
  onSelectEmoji,
  onSelectCustomEmoji,
  onOpenSetBuilder,
}: CombinedEmojiPickerModalProps) {
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
      <EmojiPicker
        onSelectEmoji={handleSelectEmoji}
        onSelectCustomEmoji={handleSelectCustomEmoji}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1f1f1f',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
});
