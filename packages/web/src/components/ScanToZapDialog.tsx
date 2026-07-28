/**
 * ScanToZapDialog — point the camera at a Lightning QR code and pay it.
 *
 * Three ways in, because a camera isn't always the right (or available) answer:
 * scan a live code, paste one, or pick a screenshot. All three funnel through
 * the same `parseLightningTarget` guard, then a confirmation step — a scanned
 * code is a stranger's instruction to move money, so nothing is paid without
 * the user seeing what and how much first.
 *
 * Payment goes through the connected NWC wallet, the same one the note-zap flow
 * uses. This is a plain Lightning payment, not a NIP-57 zap: a scanned code
 * isn't attached to a note or an author, so there's no zap receipt to publish.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseLightningTarget,
  describeLightningTarget,
  type LightningTarget,
} from '@core/lightningTarget';
import { resolveLnurlInvoice } from '@core/lnurlPay';
import { useNwc } from '@/hooks/useNwc';
import { useToast } from '@/hooks/useToast';
import { useQrScanner, cameraAvailable } from '@/hooks/useQrScanner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Zap, Loader2, Camera, Image as ImageIcon, Wallet } from 'lucide-react';

const PRESETS = [21, 100, 500, 1000, 5000];

interface ScanToZapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenWalletSettings: () => void;
}

export function ScanToZapDialog({ open, onOpenChange, onOpenWalletSettings }: ScanToZapDialogProps) {
  const { payInvoice, isConnected } = useNwc();
  const { toast } = useToast();

  const [target, setTarget] = useState<LightningTarget | null>(null);
  const [manual, setManual] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [amount, setAmount] = useState(21);
  const [comment, setComment] = useState('');
  const [isPaying, setIsPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleDecoded = useCallback((text: string) => {
    const parsed = parseLightningTarget(text);
    if (!parsed) {
      setParseError("That code isn't a Lightning invoice or address.");
      return;
    }
    setParseError(null);
    setTarget(parsed);
  }, []);

  const { videoRef, status, error: cameraError, start, stop, scanImageFile } = useQrScanner(handleDecoded);

  // Start the camera when the dialog opens with nothing scanned yet; always
  // release it on close so the camera indicator doesn't linger.
  useEffect(() => {
    if (open && isConnected && !target && cameraAvailable()) start();
    if (!open) stop();
    // Unmounting while open (route change, parent teardown) never ran the
    // `!open` branch, leaving the camera — and the OS recording indicator —
    // live with no UI attached. Release it on teardown too.
    return () => { stop(); };
  }, [open, isConnected, target, start, stop]);

  const reset = useCallback(() => {
    setTarget(null);
    setManual('');
    setParseError(null);
    setPayError(null);
    setComment('');
    setAmount(21);
  }, []);

  const close = useCallback(() => {
    stop();
    reset();
    onOpenChange(false);
  }, [stop, reset, onOpenChange]);

  const handlePickImage = async (file: File | undefined) => {
    if (!file) return;
    const decoded = await scanImageFile(file);
    if (decoded) handleDecoded(decoded);
    else setParseError('No QR code found in that image.');
  };

  // An invoice with its own amount is paid exactly as written; anything else
  // needs the user to choose how much.
  const fixedAmount = target?.kind === 'invoice' ? target.amountSats : null;
  const needsAmount = target !== null && fixedAmount === null;
  const effectiveAmount = fixedAmount ?? amount;

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
    <Dialog open={open} onOpenChange={next => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-[95vw] sm:max-w-[380px] p-4 sm:p-6 overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-500" />
            Scan to zap
          </DialogTitle>
          <DialogDescription>
            {target ? 'Check the details before paying.' : 'Point the camera at a Lightning QR code.'}
          </DialogDescription>
        </DialogHeader>

        {!isConnected ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">Connect a wallet to send payments.</p>
            <Button onClick={() => { close(); onOpenWalletSettings(); }} className="w-full gap-2">
              <Wallet className="h-4 w-4" />
              Connect Wallet
            </Button>
          </div>
        ) : !target ? (
          <div className="space-y-3">
            {/* Live camera preview */}
            <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-muted">
              <video
                ref={videoRef}
                className="h-full w-full object-cover"
                playsInline
                muted
                aria-label="Camera preview"
              />
              {status !== 'scanning' && (
                <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
                  {status === 'starting' ? (
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {cameraError ?? 'Camera off — paste a code or pick an image below.'}
                    </p>
                  )}
                </div>
              )}
              {status === 'scanning' && (
                // Framing guide; purely decorative, so hidden from assistive tech.
                <div aria-hidden className="pointer-events-none absolute inset-8 rounded-lg border-2 border-amber-400/70" />
              )}
            </div>

            {status !== 'scanning' && cameraAvailable() && (
              <Button variant="outline" size="sm" onClick={start} className="w-full gap-2">
                <Camera className="h-4 w-4" />
                Retry camera
              </Button>
            )}

            {/* Paste / pick fallbacks */}
            <div className="flex items-center gap-2">
              <Input
                placeholder="…or paste an invoice or address"
                value={manual}
                onChange={e => { setManual(e.target.value); setParseError(null); }}
                onKeyDown={e => { if (e.key === 'Enter' && manual.trim()) handleDecoded(manual); }}
                className="flex-1"
              />
              <Button size="sm" disabled={!manual.trim()} onClick={() => handleDecoded(manual)}>
                Use
              </Button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => { void handlePickImage(e.target.files?.[0]); e.target.value = ''; }}
            />
            <Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()} className="w-full gap-2">
              <ImageIcon className="h-4 w-4" />
              Scan an image instead
            </Button>

            {parseError && <p className="text-xs text-destructive text-center">{parseError}</p>}
          </div>
        ) : (
          <div className="space-y-4">
            {/* What was scanned */}
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Paying</p>
              <p className="text-sm font-medium break-all">{describeLightningTarget(target)}</p>
            </div>

            {needsAmount ? (
              <>
                <div className="flex flex-wrap gap-1.5 sm:gap-2">
                  {PRESETS.map(preset => (
                    <Button
                      key={preset}
                      variant={amount === preset ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setAmount(preset)}
                      className="gap-0.5 px-2 sm:px-3 text-xs sm:text-sm flex-1 min-w-0"
                    >
                      <Zap className="h-3 w-3 shrink-0" />
                      {preset >= 1000 ? `${preset / 1000}k` : preset}
                    </Button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    placeholder="Custom amount"
                    value={amount || ''}
                    onChange={e => setAmount(Math.max(0, parseInt(e.target.value) || 0))}
                    min={1}
                    className="flex-1"
                  />
                  <span className="text-sm text-muted-foreground whitespace-nowrap">sats</span>
                </div>
                <Input
                  placeholder="Add a message (optional)"
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  maxLength={280}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                This invoice sets its own amount.
              </p>
            )}

            <div className="flex gap-2">
              <Button variant="outline" onClick={reset} disabled={isPaying} className="flex-1">
                Scan again
              </Button>
              <Button onClick={handlePay} disabled={isPaying || effectiveAmount <= 0} className="flex-1 gap-2">
                {isPaying ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Paying…
                  </>
                ) : (
                  <>
                    <Zap className="h-4 w-4" />
                    Pay {effectiveAmount > 0 ? `${effectiveAmount.toLocaleString()} sats` : ''}
                  </>
                )}
              </Button>
            </div>

            {payError && <p className="text-xs text-destructive text-center">{payError}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
