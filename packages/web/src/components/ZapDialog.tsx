import { useState } from 'react';
import { type NostrEvent } from '@nostrify/nostrify';
import { useAuthor } from '@/hooks/useAuthor';
import { useZap } from '@/hooks/useZap';
import { useToast } from '@/hooks/useToast';
import { genUserName } from '@/lib/genUserName';
import { recordUserZap } from '@/components/NoteCard';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Zap, Loader2, Wallet } from 'lucide-react';

const PRESETS = [21, 100, 500, 1000, 5000];

interface ZapDialogProps {
  note: NostrEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenWalletSettings: () => void;
}

export function ZapDialog({ note, open, onOpenChange, onOpenWalletSettings }: ZapDialogProps) {
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
      if (note) recordUserZap(note.id, effectiveAmount);
      toast({ title: 'Zap sent!', description: `${effectiveAmount} sats to ${displayName}` });
      onOpenChange(false);
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
            {metadata?.picture && <AvatarImage src={metadata.picture} alt={displayName} />}
            <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="font-medium text-sm truncate">{displayName}</p>
            {lud16 && (
              <p className="text-xs text-muted-foreground truncate">{lud16}</p>
            )}
          </div>
        </div>

        {noLud16 ? (
          <p className="text-sm text-muted-foreground py-2">
            This author hasn't set a lightning address — they can't receive zaps yet.
          </p>
        ) : !isConnected ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">Connect a wallet to send zaps.</p>
            <Button onClick={() => { onOpenChange(false); onOpenWalletSettings(); }} className="w-full gap-2">
              <Wallet className="h-4 w-4" />
              Connect Wallet
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
                  onClick={() => { setAmount(preset); setUseCustom(false); }}
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
                onChange={(e) => { setCustomAmount(e.target.value); setUseCustom(true); }}
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
              onChange={(e) => setComment(e.target.value)}
              maxLength={280}
            />

            {/* Zap button */}
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

            {error && (
              <p className="text-xs text-destructive text-center">{error}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
