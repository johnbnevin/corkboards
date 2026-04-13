/**
 * BackupRestoreUI — backup and restore settings via Nostr (encrypted Blossom).
 *
 * Mirrors packages/web/src/components/BackupRestoreButtons.tsx and BackupDownloadPrompt.tsx.
 * Uses the existing useNostrBackup hook for all backup/restore logic.
 */
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import { useAuth } from '../lib/AuthContext';
import { useNostrBackup } from '../hooks/useNostrBackup';
import { formatTimeAgo } from '@core/formatTimeAgo';
import type { NSecSigner } from '@nostrify/nostrify';
import type { RemoteCheckpoint } from '../hooks/useNostrBackup';

export function BackupRestoreUI() {
  const { pubkey, signer } = useAuth();
  const {
    status,
    message,
    checkpoints,
    lastBackupAgo,
    saveBackup,
    checkForBackup,
    restoreBackup,
  } = useNostrBackup(pubkey ?? null, signer as NSecSigner | null);

  const isSaving = status === 'encrypting' || status === 'saving';
  const isChecking = status === 'checking';
  const isRestoring = status === 'restoring';
  const isBusy = isSaving || isChecking || isRestoring;

  const handleRestore = (cp: RemoteCheckpoint) => {
    Alert.alert(
      'Restore backup',
      `Restore backup from ${formatTimeAgo(cp.timestamp)}?\n\nThis will overwrite your current settings.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore', onPress: () => restoreBackup(cp) },
      ],
    );
  };

  if (!pubkey) {
    return (
      <View style={styles.container}>
        <Text style={styles.hintText}>Log in to back up and restore your settings.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Last backup info */}
      {lastBackupAgo && (
        <Text style={styles.info}>Last backup: {lastBackupAgo}</Text>
      )}

      {/* Status indicator */}
      {isBusy && (
        <View style={styles.statusRow}>
          <ActivityIndicator color="#b3b3b3" size="small" />
          <Text style={styles.statusText}>{message}</Text>
        </View>
      )}

      {/* Status message (non-busy states) */}
      {message && !isBusy && status !== 'idle' && (
        <Text
          style={[
            styles.statusText,
            (status === 'saved' || status === 'restored') && styles.successText,
            (status === 'save-error' || status === 'restore-error') && styles.errorText,
          ]}
        >
          {message}
        </Text>
      )}

      {/* Action buttons */}
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, isSaving && styles.buttonDisabled]}
          onPress={saveBackup}
          disabled={isSaving}
        >
          {isSaving ? (
            <ActivityIndicator color="#f97316" size="small" />
          ) : (
            <Text style={styles.buttonText}>Back up now</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, isChecking && styles.buttonDisabled]}
          onPress={checkForBackup}
          disabled={isChecking}
        >
          {isChecking ? (
            <ActivityIndicator color="#f97316" size="small" />
          ) : (
            <Text style={styles.buttonText}>Check for backup</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Available checkpoints */}
      {checkpoints.length > 0 && (
        <View style={styles.checkpointsSection}>
          <Text style={styles.hintText}>Available backups:</Text>
          {checkpoints.slice(0, 5).map(cp => (
            <TouchableOpacity
              key={cp.eventId}
              style={styles.checkpointRow}
              onPress={() => handleRestore(cp)}
              disabled={isRestoring}
            >
              <Text style={styles.checkpointTime}>{formatTimeAgo(cp.timestamp)}</Text>
              <Text style={styles.checkpointAction}>Restore {'\u2192'}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },

  info: {
    color: '#b3b3b3',
    fontSize: 13,
  },

  // Status
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    color: '#b3b3b3',
    fontSize: 13,
  },
  successText: {
    color: '#4ade80',
  },
  errorText: {
    color: '#f87171',
  },

  // Buttons
  buttonRow: { gap: 8 },
  button: {
    backgroundColor: '#333',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: {
    color: '#f97316',
    fontSize: 15,
    fontWeight: '500',
  },

  // Checkpoints
  checkpointsSection: { marginTop: 4 },
  hintText: {
    color: '#b3b3b3',
    fontSize: 12,
    marginBottom: 8,
  },
  checkpointRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#404040',
  },
  checkpointTime: {
    color: '#b3b3b3',
    fontSize: 13,
  },
  checkpointAction: {
    color: '#f97316',
    fontSize: 13,
  },
});
