/**
 * BackupDownloadPrompt -- Prompt suggesting user create/share a local backup.
 *
 * Port of packages/web/src/components/BackupDownloadPrompt.tsx for React Native.
 * On mobile, "download" means creating the backup JSON and sharing it via the
 * system share sheet (requires expo-sharing or react-native-share in the host).
 */
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Alert,
} from 'react-native';
import { createBackup, dismissBackupPrompt } from '../lib/downloadBackup';
import { useToast } from '../hooks/useToast';

interface BackupDownloadPromptProps {
  visible: boolean;
  onClose: () => void;
}

export function BackupDownloadPrompt({ visible, onClose }: BackupDownloadPromptProps) {
  const { toast } = useToast();

  const handleDownload = async () => {
    try {
      const { json, filename } = await createBackup();
      // Attempt native sharing -- fallback to an alert with instructions
      try {
        const Sharing = require('expo-sharing');
        const FileSystem = require('expo-file-system');
        const path = `${FileSystem.cacheDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(path, json);
        await Sharing.shareAsync(path, { mimeType: 'application/json' });
      } catch {
        // expo-sharing not available -- show the backup was created
        Alert.alert('Backup created', `${filename}\n\nTo save, copy the backup data from Settings > Backup.`);
      }
      toast({ title: 'Settings backup created' });
      onClose();
    } catch {
      toast({ title: 'Backup creation failed', variant: 'destructive' });
    }
  };

  const handleRemindLater = () => {
    dismissBackupPrompt();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent={Platform.OS === 'android'}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>{'\u2B07\uFE0F'} Save a settings backup</Text>

          <Text style={styles.body}>
            It's been a while since you last saved a local backup of your settings.
          </Text>

          <View style={styles.infoBox}>
            <Text style={styles.infoText}>
              <Text style={styles.infoBold}>Why save? </Text>
              If you ever lose access to your account, this file restores all your
              corkboards.me settings -- custom feeds, filters, dismissed notes, RSS feeds,
              wallet connection, and display preferences. Everything except your follower list.
            </Text>
          </View>

          <View style={styles.buttonRow}>
            <TouchableOpacity style={styles.outlineBtn} onPress={handleRemindLater}>
              <Text style={styles.outlineBtnText}>Remind me later</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primaryBtn} onPress={handleDownload}>
              <Text style={styles.primaryBtnText}>{'\u2B07\uFE0F'} Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#1f1f1f',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 360,
    gap: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#f2f2f2',
  },
  body: {
    fontSize: 14,
    color: '#b3b3b3',
    lineHeight: 20,
  },
  infoBox: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.3)',
    borderRadius: 8,
    padding: 12,
  },
  infoText: {
    fontSize: 12,
    color: '#93c5fd',
    lineHeight: 18,
  },
  infoBold: {
    fontWeight: '600',
  },

  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  outlineBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
    alignItems: 'center',
  },
  outlineBtnText: {
    fontSize: 14,
    color: '#b3b3b3',
  },
  primaryBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#f97316',
    alignItems: 'center',
  },
  primaryBtnText: {
    fontSize: 14,
    color: '#fff',
    fontWeight: '600',
  },
});
