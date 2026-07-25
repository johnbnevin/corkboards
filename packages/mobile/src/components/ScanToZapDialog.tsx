/**
 * ScanToZapDialog -- pay a Lightning invoice, LNURL or address scanned from a
 * QR code, using the connected NWC wallet.
 *
 * Port of packages/web/src/components/ScanToZapDialog.tsx, sharing the same
 * `parseLightningTarget` guard and `@core/lnurlPay` request sequence so the two
 * platforms can't diverge on what they'll accept or where they'll send money.
 *
 * LIVE CAMERA CAPTURE IS NOT WIRED UP HERE. The web build decodes camera frames
 * with jsQR over a canvas; React Native has neither, so scanning through the
 * lens needs a native module (`expo-camera`, whose CameraView does barcode
 * detection itself) and therefore a dev-client rebuild. Until that dependency
 * is added, this screen covers the paths that work with the current build:
 * paste the code, or take it from the clipboard after scanning with the OS
 * camera app — which is how most phones surface a Lightning QR anyway.
 *
 * Like the web version this is a plain Lightning payment, not a NIP-57 zap: a
 * scanned code isn't attached to a note or an author, so there's no receipt to
 * publish.
 */
import { useCallback, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  parseLightningTarget,
  describeLightningTarget,
  type LightningTarget,
} from '@core/lightningTarget';
import { resolveLnurlInvoice } from '@core/lnurlPay';
import { useNwc } from '../hooks/useNwc';
import { useToast } from '../hooks/useToast';

const PRESETS = [21, 100, 500, 1000, 5000];

interface ScanToZapDialogProps {
  visible: boolean;
  onClose: () => void;
  onOpenWalletSettings?: () => void;
}

export function ScanToZapDialog({ visible, onClose, onOpenWalletSettings }: ScanToZapDialogProps) {
  const { payInvoice, isConnected } = useNwc();
  const { toast } = useToast();

  const [target, setTarget] = useState<LightningTarget | null>(null);
  const [manual, setManual] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [amount, setAmount] = useState(21);
  const [customAmount, setCustomAmount] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [comment, setComment] = useState('');
  const [isPaying, setIsPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const accept = useCallback((text: string) => {
    const parsed = parseLightningTarget(text);
    if (!parsed) {
      setParseError("That isn't a Lightning invoice or address.");
      return;
    }
    setParseError(null);
    setTarget(parsed);
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    if (!text?.trim()) {
      setParseError('Clipboard is empty.');
      return;
    }
    setManual(text.trim());
    accept(text);
  }, [accept]);

  const reset = useCallback(() => {
    setTarget(null);
    setManual('');
    setParseError(null);
    setPayError(null);
    setComment('');
    setCustomAmount('');
    setUseCustom(false);
    setAmount(21);
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // An invoice with its own amount is paid exactly as written; anything else
  // needs the user to choose how much.
  const fixedAmount = target?.kind === 'invoice' ? target.amountSats : null;
  const chosenAmount = useCustom ? parseInt(customAmount) || 0 : amount;
  const effectiveAmount = fixedAmount ?? chosenAmount;

  const handlePay = async () => {
    if (!target || effectiveAmount <= 0) return;
    setIsPaying(true);
    setPayError(null);
    try {
      const invoice = target.kind === 'invoice'
        ? target.invoice
        : await resolveLnurlInvoice(target.url, effectiveAmount, comment || undefined);
      await payInvoice(invoice);
      toast({ title: 'Payment sent', description: `${effectiveAmount.toLocaleString()} sats` });
      close();
    } catch (err) {
      setPayError(err instanceof Error ? err.message : 'Payment failed');
    } finally {
      setIsPaying(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{'⚡'} Scan to zap</Text>

          {!isConnected ? (
            <View style={styles.section}>
              <Text style={styles.muted}>Connect a wallet to send payments.</Text>
              {onOpenWalletSettings && (
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={() => { close(); onOpenWalletSettings(); }}
                >
                  <Text style={styles.primaryButtonText}>Connect Wallet</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : !target ? (
            <View style={styles.section}>
              <Text style={styles.muted}>
                Scan the code with your camera app, then paste it here.
              </Text>
              <TextInput
                style={styles.input}
                placeholder="lnbc… , lnurl… or name@domain"
                placeholderTextColor="#666"
                value={manual}
                onChangeText={v => { setManual(v); setParseError(null); }}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={() => manual.trim() && accept(manual)}
                returnKeyType="done"
              />
              <View style={styles.buttonRow}>
                <TouchableOpacity style={styles.secondaryButton} onPress={pasteFromClipboard}>
                  <Text style={styles.secondaryButtonText}>Paste</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryButton, styles.flex, !manual.trim() && styles.disabled]}
                  onPress={() => accept(manual)}
                  disabled={!manual.trim()}
                >
                  <Text style={styles.primaryButtonText}>Continue</Text>
                </TouchableOpacity>
              </View>
              {parseError ? <Text style={styles.errorText}>{parseError}</Text> : null}
            </View>
          ) : (
            <View style={styles.section}>
              <View style={styles.targetBox}>
                <Text style={styles.mutedSmall}>Paying</Text>
                <Text style={styles.targetText}>{describeLightningTarget(target)}</Text>
              </View>

              {fixedAmount === null ? (
                <>
                  <View style={styles.presetRow}>
                    {PRESETS.map(preset => (
                      <TouchableOpacity
                        key={preset}
                        style={[
                          styles.presetButton,
                          !useCustom && amount === preset && styles.presetButtonActive,
                        ]}
                        onPress={() => { setAmount(preset); setUseCustom(false); }}
                      >
                        <Text style={styles.presetText}>
                          {preset >= 1000 ? `${preset / 1000}k` : preset}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput
                    style={styles.input}
                    placeholder="Custom amount (sats)"
                    placeholderTextColor="#666"
                    value={customAmount}
                    onChangeText={v => { setCustomAmount(v); setUseCustom(true); }}
                    keyboardType="number-pad"
                  />
                  <TextInput
                    style={styles.input}
                    placeholder="Add a message (optional)"
                    placeholderTextColor="#666"
                    value={comment}
                    onChangeText={setComment}
                    maxLength={280}
                  />
                </>
              ) : (
                <Text style={styles.muted}>This invoice sets its own amount.</Text>
              )}

              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={[styles.secondaryButton, isPaying && styles.disabled]}
                  onPress={reset}
                  disabled={isPaying}
                >
                  <Text style={styles.secondaryButtonText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryButton, styles.flex, (isPaying || effectiveAmount <= 0) && styles.disabled]}
                  onPress={handlePay}
                  disabled={isPaying || effectiveAmount <= 0}
                >
                  {isPaying ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.primaryButtonText}>
                      Pay {effectiveAmount > 0 ? `${effectiveAmount.toLocaleString()} sats` : ''}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
              {payError ? <Text style={styles.errorText}>{payError}</Text> : null}
            </View>
          )}

          <TouchableOpacity style={styles.closeButton} onPress={close}>
            <Text style={styles.closeButtonText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: '#1e1e1e',
    borderRadius: 12,
    padding: 20,
    gap: 16,
  },
  title: {
    color: '#f2f2f2',
    fontSize: 18,
    fontWeight: '600',
  },
  section: { gap: 12 },
  muted: { color: '#b3b3b3', fontSize: 13 },
  mutedSmall: { color: '#888', fontSize: 11 },
  targetBox: {
    borderWidth: 1,
    borderColor: '#404040',
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  targetText: { color: '#f2f2f2', fontSize: 14, fontWeight: '500' },
  input: {
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#404040',
    borderRadius: 8,
    padding: 12,
    color: '#f2f2f2',
    fontSize: 13,
  },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  presetButton: {
    flex: 1,
    minWidth: 52,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
    alignItems: 'center',
  },
  presetButtonActive: { backgroundColor: '#a855f7', borderColor: '#a855f7' },
  presetText: { color: '#f2f2f2', fontSize: 13 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
  primaryButton: {
    backgroundColor: '#f97316',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  secondaryButton: {
    backgroundColor: '#2a2a2a',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { color: '#f2f2f2', fontSize: 14 },
  disabled: { opacity: 0.5 },
  errorText: { color: '#ef4444', fontSize: 12 },
  closeButton: { alignItems: 'center', paddingVertical: 4 },
  closeButtonText: { color: '#888', fontSize: 13 },
});
