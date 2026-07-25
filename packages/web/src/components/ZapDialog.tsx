import { useState } from 'react';
import { type NostrEvent } from '@nostrify/nostrify';
import { useAuthor } from '@/hooks/useAuthor';
import { useZap } from '@/hooks/useZap';
import { useToast } from '@/hooks/useToast';
import { genUserName } from '@/lib/genUserName';
import { optimizeAvatarUrl } from '@/lib/imageUtils';
import { openLightningInvoice } from '@/lib/openExternal';
import { recordUserZap } from '@/components/NoteCard';
import { QrCode } from '@/components/QrCode';
import { toLightningUri } from '@core/lightningTarget';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Zap, Loader2, Wallet, QrCode as QrCodeIcon, Copy, Check, ArrowLeft, ExternalLink } from 'lucide-react';

const PRESETS = [21, 100, 500, 1000, 5000];

interface ZapDialogProps {
  note: NostrEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenWalletSettings: () => void;
}

export function ZapDialog({ note, open, onOpenChange, onOpenWalletSettings }: ZapDialogProps) {
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

  const resetForm = () => {
    setComment('');
    setCustomAmount('');
    setUseCustom(false);
    setAmount(21);
    discardInvoice();
  };

  const handleZap = async () => {
    if (effectiveAmount <= 0) return;
    try {
      await zap(effectiveAmount, comment || undefined);
      if (note) recordUserZap(note.id, effectiveAmount);
      toast({ title: 'Zap sent!', description: `${effectiveAmount} sats to ${displayName}` });
      onOpenChange(false);
      resetForm();
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
    try {
      await navigator.clipboard.writeText(invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: 'Copy failed', description: 'Select the invoice and copy it manually.', variant: 'destructive' });
    }
  };

  // "Can't receive zaps" only when neither lud16 nor lud06 resolves an endpoint.
  const noZapAddress = !canZap && note;
  const qrPayload = toLightningUri(invoice, true) ?? '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-[380px] p-4 sm:p-6 overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-500" />
            Zap
          </DialogTitle>
          <DialogDescription>Send sats to {displayName}</DialogDescription>
        </DialogHeader>

        {/* Recipient */}
        <div className="flex items-center gap-3 py-2">
          <Avatar className="h-10 w-10">
            {metadata?.picture && <AvatarImage src={optimizeAvatarUrl(metadata.picture) || ''} alt={displayName} />}
            <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="font-medium text-sm truncate">{displayName}</p>
            {lud16 && (
              <p className="text-xs text-muted-foreground truncate">{lud16}</p>
            )}
          </div>
        </div>

        {noZapAddress ? (
          <p className="text-sm text-muted-foreground py-2">
            This author hasn't set a lightning address — they can't receive zaps yet.
          </p>
        ) : invoice ? (
          /* External wallet: the invoice is already made, so all that's left is
             getting it into a wallet this app has no connection to. */
          <div className="space-y-3">
            <QrCode value={qrPayload} label={`Lightning invoice for ${effectiveAmount} sats`} />
            <p className="text-xs text-muted-foreground text-center">
              Scan with any Lightning wallet to send {effectiveAmount.toLocaleString()} sats.
              The zap shows up on the note once your wallet pays it.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleCopyInvoice} className="flex-1 gap-2 min-w-0">
                {copied ? <Check className="h-4 w-4 shrink-0" /> : <Copy className="h-4 w-4 shrink-0" />}
                {copied ? 'Copied' : 'Copy invoice'}
              </Button>
              <Button onClick={() => openLightningInvoice(invoice)} className="flex-1 gap-2 min-w-0">
                <ExternalLink className="h-4 w-4 shrink-0" />
                Open wallet
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={discardInvoice} className="w-full gap-2">
              <ArrowLeft className="h-4 w-4" />
              Change amount
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Amount presets */}
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {PRESETS.map((preset) => (
                <Button
                  key={preset}
                  variant={!useCustom && amount === preset ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => { setAmount(preset); setUseCustom(false); discardInvoice(); }}
                  className="gap-0.5 px-2 sm:px-3 text-xs sm:text-sm flex-1 min-w-0"
                >
                  <Zap className="h-3 w-3 shrink-0" />
                  {preset >= 1000 ? `${preset / 1000}k` : preset}
                </Button>
              ))}
            </div>

            {/* Custom amount */}
            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="Custom amount"
                value={customAmount}
                onChange={(e) => { setCustomAmount(e.target.value); setUseCustom(true); discardInvoice(); }}
                onFocus={() => setUseCustom(true)}
                min={1}
                className="flex-1"
              />
              <span className="text-sm text-muted-foreground whitespace-nowrap">sats</span>
            </div>

            {/* Comment */}
            <Input
              placeholder="Add a message (optional)"
              value={comment}
              onChange={(e) => { setComment(e.target.value); discardInvoice(); }}
              maxLength={280}
            />

            {isConnected ? (
              /* Zap button */
              <Button
                onClick={handleZap}
                disabled={isZapping || effectiveAmount <= 0}
                className="w-full gap-2"
              >
                {isZapping ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Zap className="h-4 w-4" />
                    Zap {effectiveAmount > 0 ? `${effectiveAmount} sats` : ''}
                  </>
                )}
              </Button>
            ) : (
              /* No connected wallet is not a dead end: the amount and message
                 above still apply, they just get paid somewhere else. Offering
                 only "Connect Wallet" here turned every zap into a settings
                 detour for anyone who keeps their sats in a phone wallet. */
              <div className="space-y-2">
                <Button
                  onClick={handleCreateInvoice}
                  disabled={isCreatingInvoice || effectiveAmount <= 0}
                  className="w-full gap-2"
                >
                  {isCreatingInvoice ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Making invoice...
                    </>
                  ) : (
                    <>
                      <QrCodeIcon className="h-4 w-4" />
                      Pay with any wallet
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { onOpenChange(false); onOpenWalletSettings(); }}
                  className="w-full gap-2"
                >
                  <Wallet className="h-4 w-4" />
                  Connect Wallet
                </Button>
                <p className="text-[11px] text-muted-foreground text-center">
                  Connect a wallet for one-tap zaps, or get a QR code to scan with the wallet you already use.
                </p>
              </div>
            )}

            {(error || invoiceError) && (
              <p className="text-xs text-destructive text-center">{error || invoiceError}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
