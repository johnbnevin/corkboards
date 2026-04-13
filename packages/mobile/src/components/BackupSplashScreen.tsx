/**
 * BackupSplashScreen -- Full-screen backup status display showing restore
 * progress, checkpoint selection, and scrolling log output.
 *
 * Port of packages/web/src/components/BackupSplashScreen.tsx for React Native.
 */
import { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import type { BackupStatus, RemoteCheckpoint } from '../hooks/useNostrBackup';
import { TIPS } from '../lib/tips';

interface BackupSplashScreenProps {
  backupStatus: BackupStatus;
  message: string;
  remoteBackup: {
    stats?: { corkboards: number; savedForLater: number; dismissed: number };
    corkboardNames?: string[];
    timestamp: number;
    keys: string[];
  } | null;
  onRestore: () => void;
  onDismiss: () => void;
  scanOlderStates: () => Promise<void>;
  isScanning: boolean;
  checkpoints: RemoteCheckpoint[];
  loadCheckpoint: (cp: RemoteCheckpoint) => Promise<void>;
  logs?: string[];
}

export function BackupSplashScreen({
  backupStatus,
  remoteBackup,
  onRestore,
  onDismiss,
  scanOlderStates,
  isScanning,
  checkpoints,
  loadCheckpoint,
  logs = [],
}: BackupSplashScreenProps) {
  const logScrollRef = useRef<ScrollView>(null);
  const [showList, setShowList] = useState(false);

  // Cycling tips
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => {
    const timer = setInterval(() => setTipIndex(prev => (prev + 1) % TIPS.length), 5000);
    return () => clearInterval(timer);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logScrollRef.current?.scrollToEnd({ animated: true });
  }, [logs.length]);

  // Auto-dismiss after restore
  useEffect(() => {
    if (backupStatus === 'restored') {
      const t = setTimeout(onDismiss, 2500);
      return () => clearTimeout(t);
    }
  }, [backupStatus, onDismiss]);

  const isDone = backupStatus === 'restored';
  const isError = backupStatus === 'restore-error' || backupStatus === 'no-backup';
  const isFound = backupStatus === 'found';
  const isRestoring = backupStatus === 'restoring';

  const displayStats = remoteBackup?.stats;
  const displayNames = remoteBackup?.corkboardNames;
  const displayTs = remoteBackup?.timestamp;
  const dateStr = displayTs ? new Date(displayTs * 1000).toLocaleString() : null;

  const visibleLogs = logs.slice(-12);

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={[styles.brandIcon, isDone ? {} : isFound ? {} : styles.bounce]}>
          {'\u{1F4CC}'}
        </Text>
        <Text style={styles.brandName}>corkboards.me</Text>

        {/* Found a restore point */}
        {isFound && !showList && remoteBackup && (
          <View style={styles.section}>
            <Text style={styles.sectionText}>Found restore point</Text>
            {dateStr && <Text style={styles.dateText}>{dateStr}</Text>}
            {displayStats && (
              <View style={styles.statsBox}>
                <Text style={styles.statLine}>
                  {displayStats.corkboards} corkboard{displayStats.corkboards !== 1 ? 's' : ''}
                  {displayNames?.length ? `: ${displayNames.join(', ')}` : ''}
                </Text>
                <Text style={styles.statLine}>
                  {displayStats.savedForLater} saved, {displayStats.dismissed} dismissed
                </Text>
              </View>
            )}
            <TouchableOpacity style={styles.primaryBtn} onPress={onRestore}>
              <Text style={styles.primaryBtnText}>Restore</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.outlineBtn} onPress={() => setShowList(true)}>
              <Text style={styles.outlineBtnText}>No, let me choose another one.</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Checkpoint list */}
        {isFound && showList && (
          <View style={styles.section}>
            <Text style={styles.sectionText}>
              {checkpoints.length} restore point{checkpoints.length !== 1 ? 's' : ''}
            </Text>
            <ScrollView style={styles.checkpointList}>
              {checkpoints.map((c, i) => (
                <View key={c.eventId} style={[styles.checkpointCard, i === 0 && styles.checkpointCardNewest]}>
                  <View style={styles.checkpointHeader}>
                    <Text style={styles.checkpointDate}>{new Date(c.timestamp * 1000).toLocaleString()}</Text>
                    {i === 0 && <Text style={styles.newestBadge}>newest</Text>}
                  </View>
                  {c.stats && (
                    <View>
                      <Text style={styles.checkpointStat}>
                        {c.stats.corkboards} corkboard{c.stats.corkboards !== 1 ? 's' : ''}
                        {c.corkboardNames?.length ? `: ${c.corkboardNames.join(', ')}` : ''}
                      </Text>
                      <Text style={styles.checkpointStat}>
                        {c.stats.savedForLater} saved, {c.stats.dismissed} dismissed
                      </Text>
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.smallBtn}
                    onPress={() => loadCheckpoint(c)}
                  >
                    <Text style={styles.smallBtnText}>Restore</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={[styles.outlineBtn, isScanning && styles.btnDisabled]}
              onPress={scanOlderStates}
              disabled={isScanning}
            >
              {isScanning ? (
                <View style={styles.scanRow}>
                  <ActivityIndicator color="#b3b3b3" size="small" />
                  <Text style={styles.outlineBtnText}>Searching relays...</Text>
                </View>
              ) : (
                <Text style={styles.outlineBtnText}>Search for more</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.ghostBtn} onPress={onDismiss}>
              <Text style={styles.ghostBtnText}>Skip restore</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Loading / restoring spinner */}
        {!isFound && !isDone && !isError && (
          <ActivityIndicator color="#a855f7" size="large" />
        )}

        {isDone && <Text style={styles.doneIcon}>{'\u2713'}</Text>}
        {isError && <Text style={styles.errorIcon}>{'\u2717'}</Text>}

        {/* Scrolling log */}
        {(isRestoring || isDone || isError || (!isFound && !isDone)) && (
          <ScrollView ref={logScrollRef} style={styles.logBox}>
            {visibleLogs.map((entry, i) => {
              const age = visibleLogs.length - 1 - i;
              const opacity = age === 0 ? 1 : age < 3 ? 0.7 : age < 6 ? 0.4 : 0.2;
              return (
                <Text
                  key={`${logs.length - visibleLogs.length + i}`}
                  style={[styles.logLine, { opacity }]}
                >
                  {entry}
                </Text>
              );
            })}
          </ScrollView>
        )}

        <Text style={styles.tip}>{TIPS[tipIndex]}</Text>
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
    gap: 12,
    maxWidth: 340,
    paddingHorizontal: 16,
    width: '100%',
  },
  brandIcon: {
    fontSize: 48,
  },
  bounce: {
    // Animated bounce could be added with Animated API if desired
  },
  brandName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#a855f7',
  },

  section: {
    width: '100%',
    gap: 10,
    alignItems: 'center',
  },
  sectionText: {
    fontSize: 14,
    color: '#b3b3b3',
  },
  dateText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#f2f2f2',
  },
  statsBox: {
    gap: 2,
    alignItems: 'center',
  },
  statLine: {
    fontSize: 13,
    color: '#b3b3b3',
  },

  primaryBtn: {
    width: '100%',
    backgroundColor: '#f97316',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  outlineBtn: {
    width: '100%',
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
    alignItems: 'center',
  },
  outlineBtnText: {
    color: '#b3b3b3',
    fontSize: 13,
  },
  ghostBtn: {
    paddingVertical: 8,
  },
  ghostBtnText: {
    color: '#666',
    fontSize: 13,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  scanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  smallBtn: {
    backgroundColor: '#f97316',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 6,
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  smallBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },

  checkpointList: {
    maxHeight: 280,
    width: '100%',
  },
  checkpointCard: {
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#404040',
  },
  checkpointCardNewest: {
    borderColor: '#22c55e',
  },
  checkpointHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  checkpointDate: {
    fontSize: 12,
    fontWeight: '600',
    color: '#f2f2f2',
  },
  newestBadge: {
    fontSize: 9,
    fontWeight: '600',
    color: '#22c55e',
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
  },
  checkpointStat: {
    fontSize: 12,
    color: '#b3b3b3',
    lineHeight: 17,
  },

  doneIcon: {
    fontSize: 32,
    color: '#22c55e',
  },
  errorIcon: {
    fontSize: 32,
    color: '#ef4444',
  },

  logBox: {
    width: '100%',
    minHeight: 100,
    maxHeight: 160,
    paddingHorizontal: 8,
  },
  logLine: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#b3b3b3',
    lineHeight: 15,
  },

  tip: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingTop: 20,
    paddingHorizontal: 8,
  },
});
