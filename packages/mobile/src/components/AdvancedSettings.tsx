/**
 * AdvancedSettings — less-frequently-used settings with confirmation dialogs.
 *
 * Mirrors packages/web/src/components/AdvancedSettings.tsx.
 * Options: clear dismissed notes, client tag toggle, public bookmarks toggle,
 * profile cache management, delete account.
 */
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';

interface AdvancedSettingsProps {
  dismissedCount: number;
  onClearDismissed: () => void;
  onOpenProfileCache: () => void;
  publishClientTag: boolean;
  onToggleClientTag: () => void;
  publicBookmarks: boolean;
  onTogglePublicBookmarks: () => void;
  onDeleteAccount: () => void;
}

export function AdvancedSettings({
  dismissedCount,
  onClearDismissed,
  onOpenProfileCache,
  publishClientTag,
  onToggleClientTag,
  publicBookmarks,
  onTogglePublicBookmarks,
  onDeleteAccount,
}: AdvancedSettingsProps) {

  const handleClearDismissed = () => {
    if (dismissedCount === 0) {
      Alert.alert('No dismissed notes', 'There are no dismissed notes to restore.');
      return;
    }
    Alert.alert(
      'Bring back dismissed notes?',
      `This will restore ${dismissedCount} dismissed note${dismissedCount === 1 ? '' : 's'} to your feed. They will reappear in their original positions.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore notes', onPress: onClearDismissed },
      ],
    );
  };

  const handleProfileCache = () => {
    Alert.alert(
      'Open Profile Cache?',
      'View and manage locally cached profile data. You can clear stale profiles or force a refresh.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open', onPress: onOpenProfileCache },
      ],
    );
  };

  const handleClientTag = () => {
    Alert.alert(
      publishClientTag ? 'Disable client tag?' : 'Enable client tag?',
      publishClientTag
        ? 'Your posts will no longer include a tag identifying Corkboards as the client. Other users won\'t see which app you used.'
        : 'Your posts will include a tag identifying Corkboards as the client. This helps the Nostr ecosystem track client diversity.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: publishClientTag ? 'Disable' : 'Enable', onPress: onToggleClientTag },
      ],
    );
  };

  const handleBookmarks = () => {
    Alert.alert(
      publicBookmarks ? 'Make bookmarks private?' : 'Make bookmarks public?',
      publicBookmarks
        ? 'Your saved notes will be encrypted so only you can see them. This is the recommended setting for privacy.'
        : 'Your saved notes will be visible to anyone who looks at your bookmark list. Other Nostr clients may display them on your profile.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: publicBookmarks ? 'Make private' : 'Make public', onPress: onTogglePublicBookmarks },
      ],
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete your account?',
      'This will broadcast a deletion event to all relays. Your profile and notes may still exist on some relays. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete account', style: 'destructive', onPress: onDeleteAccount },
      ],
    );
  };

  return (
    <View style={styles.container}>
      {/* Dismissed notes */}
      {dismissedCount > 0 && (
        <TouchableOpacity style={styles.settingRow} onPress={handleClearDismissed}>
          <Text style={styles.settingTitle}>Bring back dismissed ({dismissedCount})</Text>
          <Text style={styles.settingHint}>Restore dismissed notes back into your feed</Text>
        </TouchableOpacity>
      )}

      {/* Profile cache */}
      <TouchableOpacity style={styles.settingRow} onPress={handleProfileCache}>
        <Text style={styles.settingTitle}>Profile Cache</Text>
        <Text style={styles.settingHint}>Manage locally cached Nostr profile data</Text>
      </TouchableOpacity>

      {/* Client tag */}
      <TouchableOpacity style={styles.settingRow} onPress={handleClientTag}>
        <Text style={styles.settingTitle}>
          {publishClientTag ? '\u2713 ' : ''}Client Tag
        </Text>
        <Text style={styles.settingHint}>Tag your posts as sent from Corkboards</Text>
      </TouchableOpacity>

      {/* Public bookmarks */}
      <TouchableOpacity style={styles.settingRow} onPress={handleBookmarks}>
        <Text style={styles.settingTitle}>
          {publicBookmarks ? '\u2713 ' : ''}Public Bookmarks
        </Text>
        <Text style={styles.settingHint}>
          {publicBookmarks
            ? 'Your saved notes are visible to others'
            : 'Your saved notes are encrypted and private'}
        </Text>
      </TouchableOpacity>

      {/* Separator */}
      <View style={styles.separator} />

      {/* Delete account */}
      <TouchableOpacity style={styles.dangerRow} onPress={handleDeleteAccount}>
        <Text style={styles.dangerTitle}>Delete Account</Text>
        <Text style={styles.dangerHint}>Broadcast a deletion event to all relays</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 2 },

  settingRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  settingTitle: {
    color: '#f2f2f2',
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 2,
  },
  settingHint: {
    color: '#888',
    fontSize: 12,
    paddingLeft: 0,
  },

  separator: {
    height: 1,
    backgroundColor: '#404040',
    marginVertical: 8,
  },

  dangerRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  dangerTitle: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 2,
  },
  dangerHint: {
    color: '#f87171',
    fontSize: 12,
    opacity: 0.7,
  },
});
