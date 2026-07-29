/**
 * Small backup-status dot, overlaid top-right (mobile has no app header).
 * Parity with web's BackupIndicatorIcon colors:
 *   unsaved/error — red, saving — pulsing orange (#f97316, same as New Post),
 *   saved — green. Hidden when idle.
 */
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { useSyncExternalStore } from 'react';
import {
  getBackupIndicatorState,
  subscribeBackupIndicator,
} from '../lib/backupIndicatorStore';

const COLORS: Record<string, string> = {
  unsaved: '#ef4444',
  saving: '#f97316',
  saved: '#22c55e',
  error: '#ef4444',
};

export function BackupIndicatorDot() {
  const state = useSyncExternalStore(
    subscribeBackupIndicator,
    getBackupIndicatorState,
    getBackupIndicatorState,
  );
  const opacity = useRef(new Animated.Value(1)).current;

  // Pulse while saving (the web side uses animate-pulse for the same state).
  useEffect(() => {
    if (state !== 'saving') {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [state, opacity]);

  if (state === 'idle') return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.dot, { backgroundColor: COLORS[state], opacity }]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    position: 'absolute',
    top: 62,
    right: 14,
    width: 8,
    height: 8,
    borderRadius: 4,
    zIndex: 100,
  },
});
