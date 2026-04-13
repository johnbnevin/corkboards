/**
 * AccountSwitcher — dropdown-style account list for mobile.
 * Shows current user, other accounts, switch/add/remove actions.
 * Mirrors web's AccountSwitcher component.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Alert,
  Image,
} from 'react-native';
import { nip19 } from 'nostr-tools';
import { useAuth } from '../lib/AuthContext';
import { useAuthor } from '../hooks/useAuthor';
import { genUserName } from '@core/genUserName';

interface AccountRowProps {
  pubkey: string;
  isActive: boolean;
  onPress: () => void;
  onRemove: () => void;
}

function AccountRow({ pubkey, isActive, onPress, onRemove }: AccountRowProps) {
  const { data: author } = useAuthor(pubkey);
  const displayName = author?.metadata?.name ?? author?.metadata?.display_name ?? genUserName(pubkey);
  const picture = author?.metadata?.picture;
  const npubShort = nip19.npubEncode(pubkey).slice(0, 16) + '...';

  return (
    <TouchableOpacity style={[styles.accountRow, isActive && styles.accountRowActive]} onPress={onPress}>
      <View style={styles.avatarWrap}>
        {picture ? (
          <Image source={{ uri: picture }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarText}>{displayName.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={styles.accountInfo}>
        <Text style={styles.accountName} numberOfLines={1}>{displayName}</Text>
        <Text style={styles.accountNpub} numberOfLines={1}>{npubShort}</Text>
      </View>
      {isActive && <View style={styles.activeDot} />}
      {!isActive && (
        <TouchableOpacity
          style={styles.removeBtn}
          onPress={(e) => { e.stopPropagation?.(); onRemove(); }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.removeText}>x</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

interface AccountSwitcherProps {
  onAddAccount: () => void;
  onLogout: () => void;
}

export function AccountSwitcher({ onAddAccount, onLogout }: AccountSwitcherProps) {
  const { pubkey: activePubkey, accounts, switchAccount, removeAccount } = useAuth();
  const [visible, setVisible] = useState(false);

  if (!activePubkey) return null;

  const handleSwitch = async (pubkey: string) => {
    if (pubkey === activePubkey) {
      setVisible(false);
      return;
    }
    try {
      await switchAccount(pubkey);
      setVisible(false);
    } catch (err) {
      Alert.alert('Switch failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleRemove = (pubkey: string) => {
    const { data: author } = { data: undefined as { metadata?: { name?: string } } | undefined };
    // Use npub for the alert since we can't call hooks here
    const label = nip19.npubEncode(pubkey).slice(0, 16) + '...';
    Alert.alert(
      'Remove account',
      `Remove ${label} from this device? The account still exists on Nostr — you can re-add it later.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await removeAccount(pubkey);
            if (accounts.length <= 1) setVisible(false);
          },
        },
      ],
    );
    void author; // suppress unused
  };

  return (
    <>
      <TouchableOpacity style={styles.trigger} onPress={() => setVisible(true)}>
        <CurrentUserAvatar pubkey={activePubkey} />
        <Text style={styles.triggerChevron}>v</Text>
      </TouchableOpacity>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setVisible(false)}>
          <View style={styles.menu} onStartShouldSetResponder={() => true}>
            <Text style={styles.menuTitle}>Switch Account</Text>

            {accounts.map(pk => (
              <AccountRow
                key={pk}
                pubkey={pk}
                isActive={pk === activePubkey}
                onPress={() => handleSwitch(pk)}
                onRemove={() => handleRemove(pk)}
              />
            ))}

            <View style={styles.separator} />

            <TouchableOpacity
              style={styles.menuAction}
              onPress={() => { setVisible(false); onAddAccount(); }}
            >
              <Text style={styles.menuActionText}>+ Add another account</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuAction} onPress={() => { setVisible(false); onLogout(); }}>
              <Text style={styles.menuActionTextDanger}>Log out all accounts</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

/** Small avatar for the trigger button */
function CurrentUserAvatar({ pubkey }: { pubkey: string }) {
  const { data: author } = useAuthor(pubkey);
  const displayName = author?.metadata?.name ?? author?.metadata?.display_name ?? genUserName(pubkey);
  const picture = author?.metadata?.picture;

  return (
    <View style={styles.triggerInner}>
      {picture ? (
        <Image source={{ uri: picture }} style={styles.triggerAvatar} />
      ) : (
        <View style={[styles.triggerAvatar, styles.avatarFallback]}>
          <Text style={styles.avatarTextSmall}>{displayName.charAt(0).toUpperCase()}</Text>
        </View>
      )}
      <Text style={styles.triggerName} numberOfLines={1}>{displayName}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Trigger button
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    padding: 8,
    gap: 4,
  },
  triggerInner: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  triggerAvatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#404040' },
  triggerName: { color: '#f2f2f2', fontSize: 13, fontWeight: '500', flex: 1 },
  triggerChevron: { color: '#999', fontSize: 12, paddingHorizontal: 4 },

  // Modal backdrop + menu
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  menu: {
    backgroundColor: '#2a2a2a',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    maxWidth: 340,
  },
  menuTitle: { color: '#999', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },

  // Account row
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
    marginBottom: 4,
  },
  accountRowActive: { backgroundColor: '#333' },
  avatarWrap: { marginRight: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#404040' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#f2f2f2', fontSize: 16, fontWeight: '600' },
  avatarTextSmall: { color: '#f2f2f2', fontSize: 12, fontWeight: '600' },
  accountInfo: { flex: 1 },
  accountName: { color: '#f2f2f2', fontSize: 14, fontWeight: '500' },
  accountNpub: { color: '#999', fontSize: 11, fontFamily: 'monospace' },
  activeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e', marginLeft: 8 },
  removeBtn: { padding: 6, marginLeft: 8 },
  removeText: { color: '#666', fontSize: 14 },

  // Menu actions
  separator: { height: 1, backgroundColor: '#404040', marginVertical: 8 },
  menuAction: { padding: 12, borderRadius: 8 },
  menuActionText: { color: '#f97316', fontSize: 14, fontWeight: '500' },
  menuActionTextDanger: { color: '#ef4444', fontSize: 14, fontWeight: '500' },
});
