/**
 * ZapDialog -- Modal for sending zaps with amount presets, custom amount,
 * optional message, and send button.
 *
 * Port of packages/web/src/components/ZapDialog.tsx for React Native.
 * Uses useNwc for payment and useZap for zap request creation.
 */
import { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useAuthor } from '../hooks/useAuthor';
import { useZap } from '../hooks/useZap';
import { useToast } from '../hooks/useToast';
import { SizeGuardedImage } from './SizeGuardedImage';
import { genUserName } from '@core/genUserName';

const PRESETS = [21, 100, 500, 1000, 5000];

interface ZapDialogProps {
  note: NostrEvent | null;
  visible: boolean;
  onClose: () => void;
  onOpenWalletSettings?: () => void;
}

export function ZapDialog({ note, visible, onClose, onOpenWalletSettings }: ZapDialogProps) {
  const { data: authorData } = useAuthor(note?.pubkey);
  const { zap, isZapping, error, lud16, isConnected } = useZap(note);
  const { toast } = useToast();
  const [amount, setAmount] = useState(21);
  const [customAmount, setCustomAmount] = useState('');
  const [comment, setComment] = useState('');
  const [useCustom, setUseCustom] = useState(false);

  const metadata = authorData?.metadata;
  const displayName = metadata?.display_name || metadata?.name || (note ? genUserName(note.pubkey) : 'Unknown');
  const effectiveAmount = useCustom ? parseInt(customAmount) || 0 : amount;

  const handleZap = async () => {
    if (effectiveAmount <= 0) return;
    try {
      await zap(effectiveAmount, comment || undefined);
      toast({ title: 'Zap sent!', description: `${effectiveAmount} sats to ${displayName}` });
      onClose();
      setComment('');
      setCustomAmount('');
      setUseCustom(false);
      setAmount(21);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      toast({ title: 'Zap failed', description: message, variant: 'destructive' });
    }
  };

  const noLud16 = !lud16 && note;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent={Platform.OS === 'android'}
    >
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerIcon}>{'\u26A1'}</Text>
          <Text style={styles.headerTitle}>Zap</Text>
        </View>
        <Text style={styles.headerSub}>Send sats to {displayName}</Text>

        {/* Recipient */}
        <View style={styles.recipient}>
          {metadata?.picture ? (
            <SizeGuardedImage uri={metadata.picture} style={styles.avatar} type="avatar" />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.avatarLetter}>{displayName.slice(0, 2).toUpperCase()}</Text>
            </View>
          )}
          <View style={styles.recipientInfo}>
            <Text style={styles.recipientName} numberOfLines={1}>{displayName}</Text>
            {lud16 ? <Text style={styles.lud16} numberOfLines={1}>{lud16}</Text> : null}
          </View>
        </View>

        {noLud16 ? (
          <Text style={styles.noLud16}>
            This author hasn't set a lightning address -- they can't receive zaps yet.
          </Text>
        ) : !isConnected ? (
          <View style={styles.connectSection}>
            <Text style={styles.connectText}>Connect a wallet to send zaps.</Text>
            <TouchableOpacity
              style={styles.connectBtn}
              onPress={() => { onClose(); onOpenWalletSettings?.(); }}
            >
              <Text style={styles.connectBtnText}>Connect Wallet</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.zapSection}>
            {/* Presets */}
            <View style={styles.presetRow}>
              {PRESETS.map(preset => (
                <TouchableOpacity
                  key={preset}
                  style={[
                    styles.presetBtn,
                    !useCustom && amount === preset && styles.presetBtnActive,
                  ]}
                  onPress={() => { setAmount(preset); setUseCustom(false); }}
                >
                  <Text style={[
                    styles.presetText,
                    !useCustom && amount === preset && styles.presetTextActive,
                  ]}>
                    {'\u26A1'} {preset >= 1000 ? `${preset / 1000}k` : preset}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Custom amount */}
            <View style={styles.customRow}>
              <TextInput
                style={styles.input}
                placeholder="Custom amount"
                placeholderTextColor="#666"
                value={customAmount}
                onChangeText={(v) => { setCustomAmount(v); setUseCustom(true); }}
                onFocus={() => setUseCustom(true)}
                keyboardType="number-pad"
              />
              <Text style={styles.satsLabel}>sats</Text>
            </View>

            {/* Comment */}
            <TextInput
              style={styles.input}
              placeholder="Add a message (optional)"
              placeholderTextColor="#666"
              value={comment}
              onChangeText={setComment}
              maxLength={280}
            />

            {/* Send button */}
            <TouchableOpacity
              style={[styles.zapBtn, (isZapping || effectiveAmount <= 0) && styles.zapBtnDisabled]}
              onPress={handleZap}
              disabled={isZapping || effectiveAmount <= 0}
            >
              {isZapping ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.zapBtnText}>
                  {'\u26A1'} Zap {effectiveAmount > 0 ? `${effectiveAmount} sats` : ''}
                </Text>
              )}
            </TouchableOpacity>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: '#1f1f1f',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#444',
    alignSelf: 'center',
    marginBottom: 12,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  headerIcon: {
    fontSize: 20,
    color: '#f59e0b',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#f2f2f2',
  },
  headerSub: {
    fontSize: 13,
    color: '#b3b3b3',
    marginBottom: 12,
  },

  recipient: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    marginBottom: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  avatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: '#b3b3b3',
    fontSize: 14,
    fontWeight: '600',
  },
  recipientInfo: {
    flex: 1,
  },
  recipientName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#f2f2f2',
  },
  lud16: {
    fontSize: 12,
    color: '#b3b3b3',
    marginTop: 1,
  },

  noLud16: {
    fontSize: 14,
    color: '#b3b3b3',
    paddingVertical: 8,
  },

  connectSection: {
    gap: 12,
    paddingVertical: 8,
  },
  connectText: {
    fontSize: 14,
    color: '#b3b3b3',
  },
  connectBtn: {
    backgroundColor: '#f97316',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  connectBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },

  zapSection: {
    gap: 12,
  },
  presetRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  presetBtn: {
    flex: 1,
    minWidth: 56,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
    alignItems: 'center',
  },
  presetBtnActive: {
    backgroundColor: '#f59e0b',
    borderColor: '#f59e0b',
  },
  presetText: {
    fontSize: 13,
    color: '#b3b3b3',
    fontWeight: '500',
  },
  presetTextActive: {
    color: '#000',
  },

  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f2f2f2',
    fontSize: 14,
  },
  satsLabel: {
    fontSize: 13,
    color: '#b3b3b3',
  },

  zapBtn: {
    backgroundColor: '#f59e0b',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  zapBtnDisabled: {
    opacity: 0.5,
  },
  zapBtnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '600',
  },

  errorText: {
    fontSize: 12,
    color: '#ef4444',
    textAlign: 'center',
  },
});
