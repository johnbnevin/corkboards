/**
 * Renders the toast state from useToast as a bottom-anchored stack.
 *
 * This component is what makes mobile toasts VISIBLE: the old system used
 * the native Android toast (auto-hiding, outside our control) and rendered
 * nothing at all on iOS. Toasts stay until tapped — parity with web's
 * duration=Infinity — so an error can't flash past unread.
 */
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useToast, type ToastType } from '../hooks/useToast';

const ACCENT: Record<ToastType, string> = {
  default: '#666666',
  success: '#22c55e',
  error: '#ef4444',
};

export function ToastOverlay() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;

  return (
    <View style={styles.stack} pointerEvents="box-none">
      {toasts.map((t) => (
        <TouchableOpacity
          key={t.id}
          style={[styles.toast, { borderLeftColor: ACCENT[t.type] }]}
          onPress={() => dismiss(t.id)}
          accessibilityRole="alert"
          accessibilityLabel={`${t.message} — tap to dismiss`}
          activeOpacity={0.85}
        >
          <Text style={styles.message}>{t.message}</Text>
          <Text style={styles.hint}>tap to dismiss</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    position: 'absolute',
    left: 12,
    right: 12,
    // Clear the bottom tab bar.
    bottom: 96,
    gap: 8,
    zIndex: 200,
  },
  toast: {
    backgroundColor: '#2a2a2a',
    borderColor: '#404040',
    borderWidth: 1,
    borderLeftWidth: 4,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  message: { color: '#f2f2f2', fontSize: 13, lineHeight: 18 },
  hint: { color: '#666666', fontSize: 10, marginTop: 4 },
});
