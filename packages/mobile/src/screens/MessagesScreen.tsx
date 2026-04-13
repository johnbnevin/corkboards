/**
 * Messages screen -- DM conversation list + chat view.
 *
 * Uses DMMessagingInterface as the main router, plus a DMStatusInfo
 * modal accessible from the header info button.
 */
import { useState, useCallback } from 'react';
import { View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { useAuth } from '../lib/AuthContext';
import { DMMessagingInterface } from '../components/dm/DMMessagingInterface';
import { DMStatusInfo } from '../components/dm/DMStatusInfo';
import { deleteMessagesFromDB } from '../lib/dmMessageStore';
import { useQueryClient } from '@tanstack/react-query';

export function MessagesScreen() {
  const { pubkey } = useAuth();
  const queryClient = useQueryClient();
  const [statusVisible, setStatusVisible] = useState(false);

  const handleClearCache = useCallback(async () => {
    if (!pubkey) return;
    deleteMessagesFromDB(pubkey);
    await queryClient.invalidateQueries({ queryKey: ['dm-events'] });
    await queryClient.invalidateQueries({ queryKey: ['nip17-dm-events'] });
    await queryClient.invalidateQueries({ queryKey: ['dm-messages'] });
  }, [pubkey, queryClient]);

  if (!pubkey) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Messages</Text>
        <Text style={styles.emptyText}>Log in to view your messages</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <DMMessagingInterface
        onStatusPress={() => setStatusVisible(true)}
      />

      {/* Status Info Modal */}
      <Modal
        visible={statusVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setStatusVisible(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>DM Status</Text>
            <TouchableOpacity onPress={() => setStatusVisible(false)}>
              <Text style={styles.modalClose}>Done</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody} contentContainerStyle={{ paddingBottom: 40 }}>
            <DMStatusInfo clearCacheAndRefetch={handleClearCache} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: {
    flex: 1,
    backgroundColor: '#1f1f1f',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f2f2f2' },
  emptyText: { color: '#666', textAlign: 'center', fontSize: 15 },
  // Modal
  modalContainer: { flex: 1, backgroundColor: '#1f1f1f' },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#404040',
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#f2f2f2' },
  modalClose: { fontSize: 15, fontWeight: '500', color: '#f97316' },
  modalBody: { flex: 1, padding: 16 },
});
