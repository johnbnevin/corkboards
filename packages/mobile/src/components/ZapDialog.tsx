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
import * as Clipboard from 'expo-clipboard';
import type { NostrEvent } from '@nostrify/nostrify';
import { useAuthor } from '../hooks/useAuthor';
import { useZap } from '../hooks/useZap';
import { useToast } from '../hooks/useToast';
import { SizeGuardedImage } from './SizeGuardedImage';
import { QrCode } from './QrCode';
import { openLightningInvoice } from '../lib/openExternal';
import { genUserName } from '@core/genUserName';
import { toLightningUri } from '@core/lightningTarget';

const PRESETS = [21, 100, 500, 1000, 5000];

interface ZapDialogProps {
  note: NostrEvent | null;
  visible: boolean;
  onClose: () => void;
  onOpenWalletSettings?: () => void;
  /**
   * Fired after a zap is paid through the connected wallet, so the caller can
   * light its zap icon up straight away. Not fired for the external-wallet
   * path: this app never learns when that invoice is settled — the zap receipt
   * arriving from the relay is what confirms it.
   */
  onZapped?: (amountSats: number) => void;
}

export function ZapDialog({ note, visible, onClose, onOpenWalletSettings, onZapped }: ZapDialogProps) {
  const { data: authorData } = useAuthor(note?.pubkey);
  const { zap, createInvoice, isZapping, error, lud16, canZap, isConnected } = useZap(note);
  const { toast } = useToast();
  const [amount, setAmount] = useState(21);
  const [customAmount, setCustomAmount] = useState('');
  const [comment, setComment] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  // External-wallet flow: an invoice to show as a QR code, for a wallet this app
  // isn't connected to.
  const [invoice, setInvoice] = useState('');
  const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const metadata = authorData?.metadata;
  const displayName = metadata?.display_name || metadata?.name || (note ? genUserName(note.pubkey) : 'Unknown');
  const effectiveAmount = useCustom ? parseInt(customAmount) || 0 : amount;

  // An invoice is for one exact amount. Editing the amount or the message after
  // one is on screen has to discard it, or the QR code silently stops matching
  // the numbers next to it.
  const discardInvoice = () => {
    setInvoice('');
    setInvoiceError(null);
    setCopied(false);
  };

  const handleZap = async () => {
    if (effectiveAmount <= 0) return;
    try {
      await zap(effectiveAmount, comment || undefined);
      onZapped?.(effectiveAmount);
      toast({ title: 'Zap sent!', description: `${effectiveAmount} sats to ${displayName}` });
      onClose();
      setComment('');
      setCustomAmount('');
      setUseCustom(false);
      setAmount(21);
      discardInvoice();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      toast({ title: 'Zap failed', description: message, variant: 'destructive' });
    }
  };

  const handleCreateInvoice = async () => {
    if (effectiveAmount <= 0) return;
    setIsCreatingInvoice(true);
    setInvoiceError(null);
    try {
      setInvoice(await createInvoice(effectiveAmount, comment || undefined));
    } catch (err) {
      setInvoiceError(err instanceof Error ? err.message : 'Could not create an invoice');
    } finally {
      setIsCreatingInvoice(false);
    }
  };

  const handleCopyInvoice = async () => {
    await Clipboard.setStringAsync(invoice);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // "Can't receive zaps" only when neither lud16 nor lud06 resolves an endpoint.
  const noZapAddress = !canZap && note;
  const qrPayload = toLightningUri(invoice, true) ?? '';

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

        {noZapAddress ? (
          <Text style={styles.noLud16}>
            This author hasn't set a lightning address -- they can't receive zaps yet.
          </Text>
        ) : invoice ? (
          /* External wallet: the invoice is already made, so all that's left is
             getting it into a wallet this app has no connection to. */
          <View style={styles.zapSection}>
            <QrCode value={qrPayload} />
            <Text style={styles.qrHint}>
              Scan with any Lightning wallet to send {effectiveAmount.toLocaleString()} sats.
              The zap shows up on the note once your wallet pays it.
            </Text>
            <View style={styles.qrActions}>
              <TouchableOpacity style={[styles.secondaryBtn, styles.qrAction]} onPress={handleCopyInvoice}>
                <Text style={styles.secondaryBtnText}>{copied ? 'Copied' : 'Copy invoice'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.zapBtn, styles.qrAction]}
                onPress={() => openLightningInvoice(invoice)}
              >
                <Text style={styles.zapBtnText}>Open wallet</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.ghostBtn} onPress={discardInvoice}>
              <Text style={styles.ghostBtnText}>{'\u2190'} Change amount</Text>
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
                  onPress={() => { setAmount(preset); setUseCustom(false); discardInvoice(); }}
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
                onChangeText={(v) => { setCustomAmount(v); setUseCustom(true); discardInvoice(); }}
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
              onChangeText={(v) => { setComment(v); discardInvoice(); }}
              maxLength={280}
            />

            {isConnected ? (
              /* Send button */
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
            ) : (
              /* No connected wallet is not a dead end: the amount and message
                 above still apply, they just get paid somewhere else. Offering
                 only "Connect Wallet" here turned every zap into a settings
                 detour for anyone who keeps their sats in another app. */
              <View style={styles.connectSection}>
                <TouchableOpacity
                  style={[styles.zapBtn, (isCreatingInvoice || effectiveAmount <= 0) && styles.zapBtnDisabled]}
                  onPress={handleCreateInvoice}
                  disabled={isCreatingInvoice || effectiveAmount <= 0}
                >
                  {isCreatingInvoice ? (
                    <ActivityIndicator color="#000" size="small" />
                  ) : (
                    <Text style={styles.zapBtnText}>Pay with any wallet</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={() => { onClose(); onOpenWalletSettings?.(); }}
                >
                  <Text style={styles.secondaryBtnText}>Connect Wallet</Text>
                </TouchableOpacity>
                <Text style={styles.connectHint}>
                  Connect a wallet for one-tap zaps, or get a QR code to scan with the wallet you already use.
                </Text>
              </View>
            )}

            {error || invoiceError ? (
              <Text style={styles.errorText}>{error || invoiceError}</Text>
            ) : null}
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
    gap: 8,
  },
  connectHint: {
    fontSize: 11,
    color: '#b3b3b3',
    textAlign: 'center',
  },
  secondaryBtn: {
    padding: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#f2f2f2',
    fontSize: 15,
    fontWeight: '600',
  },

  qrHint: {
    fontSize: 12,
    color: '#b3b3b3',
    textAlign: 'center',
  },
  qrActions: {
    flexDirection: 'row',
    gap: 8,
  },
  qrAction: {
    flex: 1,
  },
  ghostBtn: {
    padding: 10,
    alignItems: 'center',
  },
  ghostBtnText: {
    color: '#b3b3b3',
    fontSize: 13,
    fontWeight: '500',
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
