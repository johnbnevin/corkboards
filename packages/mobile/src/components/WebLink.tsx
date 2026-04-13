/**
 * WebLink — link preview card for URLs.
 *
 * Shows a card with the domain name and full URL, tappable to open
 * in the device browser.
 *
 * Mobile equivalent of packages/web/src/components/WebLink.tsx.
 */
import {
  View,
  Text,
  TouchableOpacity,
  Linking,
  StyleSheet,
} from 'react-native';

function isSafeUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

interface WebLinkProps {
  url: string;
}

export function WebLink({ url }: WebLinkProps) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }

  if (!isSafeUrl(url)) {
    return <Text style={styles.unsafeUrl}>{url}</Text>;
  }

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => Linking.openURL(url)}
      activeOpacity={0.7}
    >
      <Text style={styles.linkIcon}>L</Text>
      <View style={styles.info}>
        <Text style={styles.hostname} numberOfLines={1}>{hostname}</Text>
        <Text style={styles.url} numberOfLines={1}>{url}</Text>
      </View>
    </TouchableOpacity>
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
  hostname: {
    color: '#f2f2f2',
    fontSize: 13,
    fontWeight: '500',
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
