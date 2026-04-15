import React, { useState, useEffect, useRef } from 'react';
import { Download, Eye, EyeOff, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from '@/hooks/useToast';
import { useLoginActions } from '@/hooks/useLoginActions';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { triggerDownload } from '@/lib/triggerDownload';

interface LoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: () => void;
}

type Step = 'name' | 'key-backup';

const LoginDialog: React.FC<LoginDialogProps> = ({ isOpen, onClose, onLogin }) => {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [nsec, setNsec] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const login = useLoginActions();
  const { mutateAsync: publishEvent, isPending: isPublishing } = useNostrPublish();

  useEffect(() => {
    if (!isOpen) {
      setStep('name');
      setName('');
      setNsec('');
      setShowKey(false);
      setCopied(false);
    }
    // Also clear nsec from state on unmount
    return () => { setNsec(''); };
  }, [isOpen]);

  // Clear pending timers on unmount to avoid setState on unmounted component
  // and to ensure the clipboard is wiped promptly.
  useEffect(() => {
    return () => {
      clearTimeout(copiedTimerRef.current);
      clearTimeout(clipboardTimerRef.current);
      navigator.clipboard.writeText('').catch(() => {});
    };
  }, []);

  const handleStart = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast({ title: 'Name required', description: 'Please enter a name to get started.', variant: 'destructive' });
      return;
    }

    const sk = generateSecretKey();
    const generatedNsec = nip19.nsecEncode(sk);
    setNsec(generatedNsec);
    setStep('key-backup');
  };

  const downloadKey = () => {
    try {
      const blob = new Blob([nsec], { type: 'text/plain; charset=utf-8' });
      const url = globalThis.URL.createObjectURL(blob);

      const decoded = nip19.decode(nsec);
      if (decoded.type !== 'nsec') throw new Error('Invalid nsec key');

      const pubkey = getPublicKey(decoded.data);
      const npub = nip19.npubEncode(pubkey);
      const filename = `nostr-${location.hostname.replaceAll(/\./g, '-')}-${npub.slice(5, 9)}.nsec.txt`;

      triggerDownload(url, filename);
      globalThis.URL.revokeObjectURL(url);
    } catch {
      toast({ title: 'Download failed', description: 'Could not download the key file.', variant: 'destructive' });
    }
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(nsec);
      setCopied(true);
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
      // Clear clipboard after 30s to reduce exposure window
      clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = setTimeout(() => { navigator.clipboard.writeText('').catch(() => {}); }, 30000);
    } catch {
      toast({ title: 'Copy failed', description: 'Could not copy to clipboard.', variant: 'destructive' });
    }
  };

  const handleSaved = async () => {
    setIsLoading(true);
    try {
      await login.nsec(nsec, { isNewUser: true });

      try {
        const metadata: Record<string, string> = {};
        if (name) metadata.name = name.trim();

        await publishEvent({
          kind: 0,
          content: JSON.stringify(metadata),
        });
      } catch {
        // Profile publish is optional - don't alarm new users
      }

      onLogin();
      onClose();
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] sm:max-w-sm p-0 gap-0 overflow-hidden rounded-2xl" aria-describedby={undefined}>
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="text-xl font-semibold text-center">
            {step === 'name' ? 'Create your account' : 'Save your password'}
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-4">
          {step === 'name' && (
            <>
              <div className="text-center mb-4">
                <p className="text-sm text-muted-foreground">
                  No email needed. Just pick a name and you're in.
                </p>
              </div>
              <div className="space-y-2">
                <label htmlFor="name-input" className="text-sm font-medium">Name</label>
                <Input
                  id="name-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="What should we call you?"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleStart(); }}
                  autoFocus
                />
              </div>
              <Button 
                className="w-full h-11" 
                onClick={handleStart} 
                disabled={!name.trim()}
              >
                Continue
              </Button>
            </>
          )}

          {step === 'key-backup' && (
            <>
              <div className="text-center space-y-2">
                <p className="text-sm text-muted-foreground">
                  This is your password. Save it where you save your other passwords.
                </p>
              </div>

              <div className="relative">
                <Input
                  type={showKey ? 'text' : 'password'}
                  value={nsec}
                  readOnly
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  className="pr-20 font-mono text-sm"
                />
                <div className="absolute right-0 top-0 h-full flex items-center gap-0.5 pr-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 hover:bg-transparent"
                    onClick={() => setShowKey(!showKey)}
                    title={showKey ? 'Hide key' : 'Show key'}
                    aria-label={showKey ? 'Hide key' : 'Show key'}
                  >
                    {showKey ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 hover:bg-transparent"
                    onClick={copyKey}
                    title="Copy key"
                    aria-label="Copy key"
                  >
                    {copied ? <Check className="h-4 w-4 text-purple-500" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
                  </Button>
                </div>
              </div>

              <div className="flex gap-3">
                <Button 
                  variant="outline" 
                  className="flex-1" 
                  onClick={downloadKey}
                  disabled={isLoading}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download
                </Button>
                <Button 
                  className="flex-1" 
                  onClick={handleSaved}
                  disabled={isLoading || isPublishing}
                >
                  {isLoading || isPublishing ? 'Creating...' : "I've saved it"}
                </Button>
              </div>

              <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
                <p className="text-xs text-amber-900 dark:text-amber-300">
                  <span className="font-semibold">Important:</span> This password is the only way to access your account. There is no "forgot password" — if you lose it, no one can recover it.
                </p>
              </div>
            </>
          )}

          <p className="text-center text-xs text-muted-foreground/50">v0.5.1</p>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default LoginDialog;
