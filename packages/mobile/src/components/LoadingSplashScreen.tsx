/**
 * LoadingSplashScreen -- Full-screen loading indicator with app branding,
 * optional relay status, and elapsed timer.
 *
 * Port of packages/web/src/components/LoadingSplashScreen.tsx for React Native.
 */
import { useEffect, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
} from 'react-native';

interface RelayInfo {
  url: string;
  status: 'healthy' | 'slow' | 'error' | 'unknown';
  latency: number | null;
  hostname: string;
}

interface LoadingSplashScreenProps {
  message?: string;
  status?: string;
  detail?: string;
  relays?: RelayInfo[];
}

const STATUS_ICONS: Record<string, { symbol: string; color: string }> = {
  healthy: { symbol: '\u2713', color: '#22c55e' },
  slow: { symbol: '\u26A0', color: '#eab308' },
  error: { symbol: '\u2717', color: '#ef4444' },
  unknown: { symbol: '\u25CB', color: '#666' },
};

export function LoadingSplashScreen({ message, status, detail, relays }: LoadingSplashScreenProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const displayMessage = message ?? status ?? 'Loading notes...';

  const healthyCount = relays?.filter(r => r.status === 'healthy').length ?? 0;
  const slowCount = relays?.filter(r => r.status === 'slow').length ?? 0;
  const errorCount = relays?.filter(r => r.status === 'error').length ?? 0;
  const totalRelays = relays?.length ?? 0;

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.brandIcon}>{'\u{1F4CC}'}</Text>
        <Text style={styles.brandName}>corkboards.me</Text>

        <View style={styles.spinnerRow}>
          <ActivityIndicator color="#a855f7" size="small" />
          <Text style={styles.message}>{displayMessage}</Text>
        </View>

        {detail ? (
          <View style={styles.detailBox}>
            <Text style={styles.detailText}>{detail}</Text>
          </View>
        ) : null}

        {relays && relays.length > 0 && (
          <View style={styles.relaySection}>
            <Text style={styles.relayHeader}>
              Searching {totalRelays} relay{totalRelays !== 1 ? 's' : ''} for notes from follows...
            </Text>
            <ScrollView style={styles.relayList}>
              {relays.map(relay => {
                const info = STATUS_ICONS[relay.status] || STATUS_ICONS.unknown;
                return (
                  <View key={relay.url} style={styles.relayRow}>
                    <Text style={[styles.relayIcon, { color: info.color }]}>{info.symbol}</Text>
                    <Text style={styles.relayHostname} numberOfLines={1}>{relay.hostname}</Text>
                    {relay.latency !== null && (
                      <Text style={styles.relayLatency}>{relay.latency}ms</Text>
                    )}
                  </View>
                );
              })}
            </ScrollView>
            <View style={styles.relaySummary}>
              {healthyCount > 0 && <Text style={[styles.summaryText, { color: '#22c55e' }]}>{healthyCount} healthy</Text>}
              {slowCount > 0 && <Text style={[styles.summaryText, { color: '#eab308' }]}>{slowCount} slow</Text>}
              {errorCount > 0 && <Text style={[styles.summaryText, { color: '#ef4444' }]}>{errorCount} error</Text>}
            </View>
          </View>
        )}

        {elapsed >= 3 && (!relays || relays.length === 0) && (
          <Text style={styles.elapsedText}>{elapsed}s elapsed -- fetching from relays...</Text>
        )}
        {elapsed >= 15 && (
          <Text style={styles.elapsedHint}>Still loading... {30 - elapsed}s until continue</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1f1f1f',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },
  content: {
    alignItems: 'center',
    gap: 16,
    maxWidth: 320,
    paddingHorizontal: 24,
  },
  brandIcon: {
    fontSize: 48,
  },
  brandName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#a855f7',
  },

  spinnerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  message: {
    fontSize: 14,
    fontWeight: '500',
    color: '#f2f2f2',
  },

  detailBox: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    padding: 12,
    width: '100%',
    maxHeight: 100,
  },
  detailText: {
    fontSize: 11,
    color: '#b3b3b3',
    fontFamily: 'monospace',
  },

  relaySection: {
    width: '100%',
    gap: 8,
  },
  relayHeader: {
    fontSize: 12,
    color: '#b3b3b3',
    fontWeight: '500',
    textAlign: 'center',
  },
  relayList: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    padding: 8,
    maxHeight: 160,
  },
  relayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
  },
  relayIcon: {
    fontSize: 12,
    fontFamily: 'monospace',
    width: 16,
    textAlign: 'center',
  },
  relayHostname: {
    fontSize: 11,
    color: '#b3b3b3',
    fontFamily: 'monospace',
    flex: 1,
  },
  relayLatency: {
    fontSize: 11,
    color: '#666',
    fontFamily: 'monospace',
  },
  relaySummary: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  summaryText: {
    fontSize: 10,
  },

  elapsedText: {
    fontSize: 11,
    color: '#666',
  },
  elapsedHint: {
    fontSize: 11,
    color: '#555',
  },
});
