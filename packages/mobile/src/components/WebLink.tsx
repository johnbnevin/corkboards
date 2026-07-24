/**
 * WebLink — link preview card for URLs.
 *
 * Shows a card with the domain name and full URL, tappable to open
 * in the device browser. The URL renders exactly as the note's author wrote
 * it — we never rewrite notes. When known tracking params are detected, an
 * amber shield glyph warns the user and tapping opens a dialog offering:
 * open clean, open original, copy either, or cancel.
 *
 * Mobile equivalent of packages/web/src/components/WebLink.tsx.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Linking,
  StyleSheet,
} from 'react-native';
import { stripTrackingParams, getTrackingParams } from '@core/sanitizeUtils';
import { TrackerWarningDialog } from './TrackerWarningDialog';

function isSafeUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

interface WebLinkProps {
  url: string;
}

export function WebLink({ url }: WebLinkProps) {
  const [warningOpen, setWarningOpen] = useState(false);
  const cleanUrl = stripTrackingParams(url);
  const trackingParams = getTrackingParams(url);
  const hasTracker = cleanUrl !== url;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }

  if (!isSafeUrl(url)) {
    return <Text style={styles.unsafeUrl}>{url}</Text>;
  }

  const onPress = () => {
    // Intercept: let the user decide clean vs original before leaving.
    if (hasTracker) setWarningOpen(true);
    else Linking.openURL(url);
  };

  return (
    <>
      <TouchableOpacity
        style={styles.card}
        onPress={onPress}
        activeOpacity={0.7}
      >
        <Text style={styles.linkIcon}>L</Text>
        <View style={styles.info}>
          <View style={styles.hostnameRow}>
            <Text style={styles.hostname} numberOfLines={1}>{hostname}</Text>
            {/* Shield opens the link-options sheet on every link. Amber when
                trackers are present, gray when clean. */}
            <TouchableOpacity
              onPress={() => setWarningOpen(true)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={hasTracker ? styles.trackerShield : styles.cleanShield}>
                {hasTracker ? '⚠' : '🛡'}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.url} numberOfLines={1}>{url}</Text>
        </View>
      </TouchableOpacity>
      <TrackerWarningDialog
        visible={warningOpen}
        onClose={() => setWarningOpen(false)}
        rawUrl={url}
        cleanUrl={cleanUrl}
        trackingParams={trackingParams}
      />
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#404040',
    marginBottom: 6,
  },
  linkIcon: {
    color: '#999',
    fontSize: 14,
    fontWeight: '600',
  },
  info: {
    flex: 1,
  },
  hostnameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  hostname: {
    color: '#f2f2f2',
    fontSize: 13,
    fontWeight: '500',
    flexShrink: 1,
  },
  trackerShield: {
    color: '#f59e0b',
    fontSize: 12,
  },
  cleanShield: {
    color: '#999',
    fontSize: 12,
  },
  url: {
    color: '#999',
    fontSize: 11,
    marginTop: 2,
  },
  unsafeUrl: {
    color: '#666',
    fontSize: 12,
  },
});
