/**
 * DMMessagingInterface -- Router/container for DM screens.
 * Shows conversation list or chat area based on selected conversation.
 *
 * Port of packages/web/src/components/dm/DMMessagingInterface.tsx for React Native.
 * On mobile, always shows one panel at a time (list or chat).
 */
import { useState, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { DMConversationList } from './DMConversationList';
import { DMChatArea } from './DMChatArea';

interface DMMessagingInterfaceProps {
  onStatusPress?: () => void;
}

export function DMMessagingInterface({ onStatusPress }: DMMessagingInterfaceProps) {
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null);

  const handleSelectConversation = useCallback((pubkey: string) => {
    setSelectedPubkey(pubkey);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedPubkey(null);
  }, []);

  return (
    <View style={styles.container}>
      {selectedPubkey ? (
        <DMChatArea
          partnerPubkey={selectedPubkey}
          onBack={handleBack}
        />
      ) : (
        <DMConversationList
          onSelectConversation={handleSelectConversation}
          onStatusPress={onStatusPress}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
});
