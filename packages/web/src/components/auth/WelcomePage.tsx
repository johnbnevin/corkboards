import { useState, useEffect, useRef, useCallback } from 'react';
import { Eye, EyeOff, Copy, Check, ChevronLeft, Link2, ShieldCheck, KeyRound, QrCode, Smartphone, HelpCircle, BookKey } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/hooks/useToast';
import { useLoginActions } from '@/hooks/useLoginActions';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { nip19 } from 'nostr-tools';
import { privateKeyFromSeedWords, validateWords, generateSeedWords } from 'nostr-tools/nip06';
import { SignerRecommendations, getSignerRecommendation, getTopSignerForPlatform } from '@/components/auth/SignerRecommendations';
import { SecurityInfoDialog } from '@/components/auth/SecurityInfoDialog';
import QRCode from 'qrcode';

type Step = 'name' | 'key-backup' | 'done';
type LoginView = 'main' | 'nsec' | 'mnemonic' | 'signer';

/** True when running inside Tauri desktop app (no browser extensions available) */
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

import { TIPS as LOGIN_TIPS } from '@/lib/tips';

interface WelcomePageProps {
  onClose?: () => void;
}

export function WelcomePage({ onClose }: WelcomePageProps = {}) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [nsec, setNsec] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [extensionLoading, setExtensionLoading] = useState(false);
  const [extensionError, setExtensionError] = useState<string | null>(null);
  const [loginView, setLoginView] = useState<LoginView>('main');
  const [bunkerUrl, setBunkerUrl] = useState('');
  const [bunkerLoading, setBunkerLoading] = useState(false);
  const [bunkerError, setBunkerError] = useState<string | null>(null);
  const [showSignerInfo, setShowSignerInfo] = useState(false);
  const [showWhyLong, setShowWhyLong] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonicCopied, setMnemonicCopied] = useState(false);

  // Nostrconnect QR code state
  const [connectUri, setConnectUri] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [connectWaiting, setConnectWaiting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectCopied, setConnectCopied] = useState(false);
  const connectAbortRef = useRef<AbortController | null>(null);
  const [loginNsec, setLoginNsec] = useState('');
  const [nsecLoginLoading, setNsecLoginLoading] = useState(false);
  const [nsecLoginError, setNsecLoginError] = useState<string | null>(null);
  const [seedPhrase, setSeedPhrase] = useState('');
  const [seedPassphrase, setSeedPassphrase] = useState('');
  const [showSeedPassphrase, setShowSeedPassphrase] = useState(false);
  const [seedLoginLoading, setSeedLoginLoading] = useState(false);
  const [seedLoginError, setSeedLoginError] = useState<string | null>(null);
  const loginFormRef = useRef<HTMLFormElement>(null);
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * LOGIN_TIPS.length));

  useEffect(() => {
    const timer = setInterval(() => {
      setTipIndex(prev => (prev + 1) % LOGIN_TIPS.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const login = useLoginActions();
  const { mutateAsync: publishEvent, isPending: isPublishing } = useNostrPublish();

  const isDialog = !!onClose;

  useEffect(() => {
    if (isDialog) {
      setStep('name');
      setName('');
      setNsec('');
      setShowKey(false);
      setCopied(false);
      setLoginView('main');
      setBunkerUrl('');
    }
  }, [isDialog]);

  const handleStart = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast({ title: 'Name required', description: 'Please enter a name to get started.', variant: 'destructive' });
      return;
    }
    const words = generateSeedWords();
    const sk = privateKeyFromSeedWords(words);
    setMnemonic(words);
    setNsec(nip19.nsecEncode(sk));
    setStep('key-backup');
  };


  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(nsec);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      // Clear clipboard after 30s to limit nsec exposure window
      setTimeout(() => { navigator.clipboard.writeText('').catch(() => {}); }, 30000);
    } catch {
      toast({ title: 'Copy failed', description: 'Could not copy to clipboard.', variant: 'destructive' });
    }
  };

  const handleSaved = async () => {
    setIsLoading(true);
    try {
      await login.nsec(nsec, { isNewUser: true });
      // New users have no contacts — start on discover tab, skip backup check
      sessionStorage.setItem('corkboard:active-tab', 'discover');
      sessionStorage.setItem('corkboard:new-user', 'true');
      try {
        if (name) await publishEvent({ kind: 0, content: JSON.stringify({ name: name.trim() }) });
      } catch { /* ignore profile creation failure */ }
      if (isDialog) {
        onClose?.();
      } else {
        // Show login tips, then reload to ensure clean app state
        setStep('done');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleExtensionLogin = async () => {
    setExtensionLoading(true);
    setExtensionError(null);
    try {
      if (!('nostr' in window)) {
        throw new Error(getSignerRecommendation());
      }
      await login.extension();
      onClose?.();
    } catch (e: unknown) {
      setExtensionError((e instanceof Error ? e.message : String(e)) || 'Extension login failed');
    } finally {
      setExtensionLoading(false);
    }
  };

  const handleBunkerLogin = async () => {
    const trimmedUrl = bunkerUrl.trim();
    if (!trimmedUrl) {
      setBunkerError('Please enter a bunker or nostrconnect URL');
      return;
    }

    setBunkerLoading(true);
    setBunkerError(null);
    try {
      if (!trimmedUrl.startsWith('bunker://') && !trimmedUrl.startsWith('nostrconnect://')) {
        throw new Error('Invalid bunker URL. It should start with bunker:// or nostrconnect://');
      }
      await login.bunker(trimmedUrl);
      onClose?.();
    } catch (e: unknown) {
      const errMsg = (e instanceof Error ? e.message : String(e)) || 'Bunker login failed';
      // Provide helpful message for common errors
      if (errMsg.toLowerCase().includes('already connected')) {
        setBunkerError('Already connected. Try clearing browser data/site settings and re-paste your bunker URL.');
      } else if (errMsg.toLowerCase().includes('invalid secret') || errMsg.toLowerCase().includes('invalid token')) {
        setBunkerError('This login link has expired. Please get a fresh bunker URL from your signer and try again.');
      } else if (errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('timed out')) {
        setBunkerError('Connection timed out. Check your internet and try again.');
      } else {
        setBunkerError(errMsg);
      }
    } finally {
      setBunkerLoading(false);
    }
  };

  // Generate nostrconnect:// QR code and wait for signer response
  const generateConnectQR = useCallback(async () => {
    connectAbortRef.current?.abort();
    const controller = new AbortController();
    connectAbortRef.current = controller;

    setConnectError(null);
    setConnectWaiting(true);
    setConnectUri('');
    setQrDataUrl('');

    try {
      await login.nostrconnect(controller.signal, async (uri) => {
        setConnectUri(uri);
        const dataUrl = await QRCode.toDataURL(uri, { width: 280, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
        if (!controller.signal.aborted) setQrDataUrl(dataUrl);
      });
      onClose?.();
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      const msg = (e instanceof Error ? e.message : String(e)) || 'Connection failed';
      if (!msg.includes('abort')) {
        setConnectError(msg);
      }
    } finally {
      if (!controller.signal.aborted) {
        setConnectWaiting(false);
      }
    }
  }, [login, onClose]);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => { connectAbortRef.current?.abort(); };
  }, []);

  const handleNsecDirectLogin = async () => {
    const trimmed = loginNsec.trim();
    if (!trimmed) {
      setNsecLoginError('Please enter your nsec key');
      return;
    }
    if (!trimmed.startsWith('nsec1')) {
      setNsecLoginError('Invalid key — must start with nsec1');
      return;
    }
    setNsecLoginLoading(true);
    setNsecLoginError(null);
    try {
      await login.nsec(trimmed);
      onClose?.();
    } catch (e: unknown) {
      setNsecLoginError((e instanceof Error ? e.message : String(e)) || 'Login failed');
    } finally {
      setNsecLoginLoading(false);
    }
  };

  const handleSeedLogin = async () => {
    const words = seedPhrase.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!words) {
      setSeedLoginError('Please enter your seed phrase');
      return;
    }
    if (!validateWords(words)) {
      setSeedLoginError('Invalid seed phrase — check the words and try again');
      return;
    }
    setSeedLoginLoading(true);
    setSeedLoginError(null);
    try {
      const privateKey = privateKeyFromSeedWords(words, seedPassphrase || undefined);
      await login.nsec(nip19.nsecEncode(privateKey));
      onClose?.();
    } catch (e: unknown) {
      setSeedLoginError((e instanceof Error ? e.message : String(e)) || 'Failed to derive key from seed phrase');
    } finally {
      setSeedLoginLoading(false);
      setSeedPhrase('');
      setSeedPassphrase('');
    }
  };

  const nameScreen = (
    <>
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
      <Button className="w-full h-11" onClick={handleStart} disabled={!name.trim()}>Start</Button>
    </>
  );

  const topSigner = getTopSignerForPlatform();

  const keyBackupContent = (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold">Save your password</h2>
        <p className="text-muted-foreground text-sm">
          This is your password.{' '}
          <button type="button" onClick={() => setShowWhyLong(true)} className="underline underline-offset-2 font-medium text-foreground hover:text-primary inline-flex items-center gap-0.5">
            Why is it so long<HelpCircle className="h-3 w-3 inline" />
          </button>
          {' '}Save it in your{' '}
          <button type="button" onClick={() => setShowSignerInfo(true)} className="underline underline-offset-2 font-medium text-foreground hover:text-primary inline-flex items-center gap-0.5">
            signer<HelpCircle className="h-3 w-3 inline" />
          </button>
          {' '}(safest) or where you save your other passwords (not recommended).
        </p>
      </div>
      <div className="relative">
        <Input type={showKey ? 'text' : 'password'} value={nsec} readOnly autoComplete="off" data-1p-ignore data-lpignore="true" className="pr-20 font-mono text-sm" />
        <div className="absolute right-0 top-0 h-full flex items-center gap-0.5 pr-1">
          <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-transparent" onClick={() => setShowKey(!showKey)}>
            {showKey ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-transparent" onClick={copyKey}>
            {copied ? <Check className="h-4 w-4 text-purple-500" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
          </Button>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          className="flex-1 gap-1.5"
          onClick={async () => {
            try {
              if ('credentials' in navigator && 'PasswordCredential' in window) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const PCred = (window as any).PasswordCredential;
                const cred = new PCred({
                  id: name || 'nostr-user',
                  password: nsec,
                  name: name || 'Nostr Account',
                });
                await navigator.credentials.store(cred);
                toast({ title: 'Saved to password manager' });
              } else {
                // Fallback: copy to clipboard
                await navigator.clipboard.writeText(nsec);
                toast({ title: 'Password manager not available — copied to clipboard instead' });
              }
            } catch {
              // Fallback: copy to clipboard
              try {
                await navigator.clipboard.writeText(nsec);
                toast({ title: 'Copied to clipboard' });
              } catch {
                toast({ title: 'Could not save', variant: 'destructive' });
              }
            }
          }}
        >
          <KeyRound className="h-4 w-4" />
          Save to password manager
        </Button>
        <Button className="flex-1" onClick={handleSaved} disabled={isLoading || isPublishing}>
          {isLoading || isPublishing ? 'Creating...' : "I've saved it"}
        </Button>
      </div>

      <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
        <p className="text-xs text-amber-900 dark:text-amber-300">
          <span className="font-semibold">Important:</span> There is no "forgot password" — if you lose it, no one can recover it.
        </p>
      </div>

      {/* 12-word mnemonic option */}
      <div className="space-y-2">
        <Button
          variant="outline"
          onClick={() => setShowMnemonic(!showMnemonic)}
          className="w-full gap-1.5"
        >
          <BookKey className="h-4 w-4" />Write down 12 words
        </Button>
        {showMnemonic && mnemonic && (
          <div className="p-3 rounded-lg border bg-muted/30 space-y-3">
            <p className="text-xs text-muted-foreground">
              These 12 words are another form of the same password. You can write them down and use them to log in later.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {mnemonic.split(' ').map((word, i) => (
                <div key={`${word}-${i}`} className="flex items-center gap-1.5 text-sm font-mono">
                  <span className="text-muted-foreground text-xs w-4 text-right">{i + 1}.</span>
                  <span>{word}</span>
                </div>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs gap-1"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(mnemonic);
                  setMnemonicCopied(true);
                  setTimeout(() => setMnemonicCopied(false), 2000);
                } catch {
                  toast({ title: 'Copy failed', variant: 'destructive' });
                }
              }}
            >
              {mnemonicCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {mnemonicCopied ? 'Copied' : 'Copy words'}
            </Button>
          </div>
        )}
      </div>

      {/* Signer info dialog */}
      <Dialog open={showSignerInfo} onOpenChange={setShowSignerInfo}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5" />
              What is a signer?
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 text-sm text-muted-foreground">
            <p>
              A <strong className="text-foreground">signer</strong> is a small app that holds your secret key and signs on your behalf.
              No website ever sees your key — they just ask the signer to approve actions.
            </p>

            <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <p className="text-xs text-amber-900 dark:text-amber-300">
                <span className="font-semibold">Why not a password manager?</span> Password managers store secrets in your browser's memory where any code on the page could access them.
                A signer keeps your key in a separate process or device — even if a website is compromised, your key stays safe.
              </p>
            </div>

            <div className="space-y-2">
              <h3 className="font-medium text-foreground">Recommended signers for your platform</h3>

              <div className="p-3 bg-green-50 dark:bg-green-950/20 rounded-lg border border-green-200 dark:border-green-800 space-y-2">
                <p className="text-xs font-semibold text-green-800 dark:text-green-300">
                  {topSigner.isMobile ? (
                    <>For {topSigner.platform}, we recommend{' '}
                      {topSigner.url ? (
                        <a href={topSigner.url} target="_blank" rel="noopener noreferrer" className="underline">{topSigner.name}</a>
                      ) : topSigner.name}
                    </>
                  ) : (
                    <>For {topSigner.platform}, we recommend{' '}
                      {topSigner.url ? (
                        <a href={topSigner.url} target="_blank" rel="noopener noreferrer" className="underline">{topSigner.name}</a>
                      ) : topSigner.name}
                    </>
                  )}
                </p>
              </div>

              <SignerRecommendations variant="full" />
            </div>

            <div className="space-y-1.5">
              <h3 className="font-medium text-foreground">How to use a signer</h3>
              <ol className="list-decimal list-inside space-y-1 text-xs">
                <li>Install a signer from the list above</li>
                <li>Import your secret key into the signer</li>
                <li>Next time you log in, use "Log in with browser extension" or scan a QR code — no need to paste your key</li>
              </ol>
            </div>

            <div className="space-y-1.5">
              <h3 className="font-medium text-foreground flex items-center gap-1">
                <Smartphone className="h-4 w-4" />Phone signer option
              </h3>
              <p className="text-xs">
                Install a signer on your phone (Amber for Android, Alby Go for iPhone), import your key,
                and next time you can log in by scanning a QR code from the login page — no key pasting needed.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Why is it so long? dialog */}
      <Dialog open={showWhyLong} onOpenChange={setShowWhyLong}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="w-5 h-5" />
              Why is the password so long?
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              This site is built on <strong className="text-foreground">Nostr</strong>, a decentralized protocol.
              There is no big tech company running a central server — no one can reset your password,
              but no one can stop you from posting, either.
            </p>
            <p>
              Your password is actually a cryptographic key. It needs to be long because
              it's the only thing that proves you are you — there's no email, phone number,
              or recovery flow behind it.
            </p>
            <p>
              If you'd prefer something easier to write down, tap{' '}
              <strong className="text-foreground">"Write down 12 words"</strong>{' '}
              on the previous screen. The 12 words are another form of the same key,
              designed to be human-friendly.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );

  if (step === 'key-backup') {
    if (isDialog) return <div className="w-full max-w-md mx-auto">{keyBackupContent}</div>;
    return <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900 p-4"><div className="w-full max-w-md">{keyBackupContent}</div></div>;
  }

  if (step === 'done') {
    const doneContent = (
      <div className="space-y-5 text-center">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">You're in!</h2>
          <p className="text-muted-foreground text-sm">
            Your account is ready. Next time you visit, use one of these to log in:
          </p>
        </div>

        <div className="space-y-2 text-left">
          <div className="p-3 rounded-lg border bg-muted/30 space-y-1.5">
            <p className="text-sm font-medium">Log in with nsec password</p>
            <p className="text-xs text-muted-foreground">Paste the nsec key you just saved.</p>
          </div>
          <div className="p-3 rounded-lg border bg-muted/30 space-y-1.5">
            <p className="text-sm font-medium">Log in with 12 word mnemonic</p>
            <p className="text-xs text-muted-foreground">Type the 12 words if you wrote them down.</p>
          </div>
          {!isTauri && (
          <div className="p-3 rounded-lg border bg-muted/30 space-y-1.5">
            <p className="text-sm font-medium">Log in with browser extension</p>
            <p className="text-xs text-muted-foreground">Import your key into a signer extension for the safest option.</p>
          </div>
          )}
        </div>

        <Button className="w-full h-11" onClick={() => onClose?.()}>
          Go to corkboards
        </Button>
      </div>
    );
    return <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900 p-4"><div className="w-full max-w-md">{doneContent}</div></div>;
  }

  if (isDialog) {
    return (
      <div className="w-full max-w-md mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold">Add another account</h2>
          <p className="text-muted-foreground">Create a new account.</p>
        </div>
        {nameScreen}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900 p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="text-3xl">📌</span>
            <h1 className="text-3xl font-bold text-purple-600 dark:text-purple-400">corkboards.me</h1>
          </div>
          <p className="text-muted-foreground">No email needed. Just pick a name and you're in.</p>
        </div>
        
        {loginView === 'main' && extensionError && !isTauri && (
          <div className="p-3 bg-red-50 dark:bg-red-950/20 rounded-lg border border-red-200 dark:border-red-800">
            <p className="text-sm text-red-600 dark:text-red-400">{extensionError}</p>
          </div>
        )}

        {loginView === 'main' && nameScreen}

        {/* Login options — main view */}
        {loginView === 'main' && (
          <div className="space-y-1">
            {!isTauri && (
            <button
              type="button"
              onClick={handleExtensionLogin}
              disabled={extensionLoading}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-2 disabled:opacity-50"
            >
              <ShieldCheck className="h-3 w-3 inline mr-1" />{extensionLoading ? 'Connecting...' : 'Log in with browser extension'}
            </button>
            )}
            <button
              type="button"
              onClick={() => { setLoginView('signer'); generateConnectQR(); }}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              <QrCode className="h-3 w-3 inline mr-1" />Log in with signer (QR code) or bunker
            </button>
            <button
              type="button"
              onClick={() => { setLoginView('mnemonic'); setSeedLoginError(null); }}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              <BookKey className="h-3 w-3 inline mr-1" />Log in with 12 word mnemonic
            </button>
            <button
              type="button"
              onClick={() => setLoginView('nsec')}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              <KeyRound className="h-3 w-3 inline mr-1" />Log in with nsec password
            </button>
          </div>
        )}

        {/* Signer (QR code / bunker) view */}
        {loginView === 'signer' && (
          <div className="space-y-4 pt-2 border-t">
            <button
              type="button"
              onClick={() => { connectAbortRef.current?.abort(); setConnectWaiting(false); setQrDataUrl(''); setConnectUri(''); setConnectError(null); setLoginView('main'); }}
              className="flex items-center justify-center w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              <ChevronLeft className="h-3 w-3 mr-1" />Back
            </button>

            <div className="space-y-2">
              {qrDataUrl && (
                <div className="flex flex-col items-center gap-2">
                  <p className="text-xs text-muted-foreground text-center">
                    Scan with your signer app (Amber, Alby Go, etc.)
                  </p>
                  <div className="bg-white p-2 rounded-lg">
                    <img src={qrDataUrl} alt="Scan with signer app" className="w-56 h-56" />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs gap-1"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(connectUri);
                        setConnectCopied(true);
                        setTimeout(() => setConnectCopied(false), 2000);
                      } catch {
                        toast({ title: 'Copy failed', variant: 'destructive' });
                      }
                    }}
                  >
                    {connectCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {connectCopied ? 'Copied' : 'Copy URI'}
                  </Button>
                </div>
              )}
              {connectWaiting && (
                <p className="text-xs text-center text-muted-foreground animate-pulse">
                  Waiting for signer to respond...
                </p>
              )}
              {connectError && (
                <p className="text-xs text-red-500 text-center">{connectError}</p>
              )}
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-gray-100 dark:bg-gray-900 px-2 text-muted-foreground">Or paste URI</span>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="bunker-input" className="text-xs font-medium flex items-center gap-1">
                <Link2 className="h-3 w-3" />Bunker / Remote Signer URI
              </label>
              <div className="flex gap-2">
                <Input
                  id="bunker-input"
                  value={bunkerUrl}
                  onChange={(e) => setBunkerUrl(e.target.value)}
                  placeholder="bunker://... or nostrconnect://..."
                  className="text-sm font-mono"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleBunkerLogin(); }}
                />
                <Button
                  onClick={handleBunkerLogin}
                  disabled={bunkerLoading}
                  size="sm"
                >
                  {bunkerLoading ? '...' : 'Go'}
                </Button>
              </div>
              {bunkerError && (
                <p className="text-xs text-red-500">{bunkerError}</p>
              )}
            </div>
          </div>
        )}

        {/* Mnemonic (NIP-06) view */}
        {loginView === 'mnemonic' && (
          <div className="space-y-4 pt-2 border-t">
            <button
              type="button"
              onClick={() => setLoginView('main')}
              className="flex items-center justify-center w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              <ChevronLeft className="h-3 w-3 mr-1" />Back
            </button>

            <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <p className="text-xs text-amber-900 dark:text-amber-300">
                <span className="font-semibold">Less secure:</span> Typing your seed phrase into a web page exposes it to any code running on this site.
                For better security, try using a browser extension or other external signer.
              </p>
            </div>

            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="seed-phrase-input" className="text-xs font-medium">Seed phrase (12 or 24 words)</Label>
                <textarea
                  id="seed-phrase-input"
                  value={seedPhrase}
                  onChange={(e) => setSeedPhrase(e.target.value)}
                  placeholder="word1 word2 word3 ..."
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="seed-passphrase-input" className="text-xs font-medium text-muted-foreground">
                  Passphrase <span className="font-normal">(optional, only if you set one)</span>
                </Label>
                <div className="relative">
                  <Input
                    id="seed-passphrase-input"
                    type={showSeedPassphrase ? 'text' : 'password'}
                    value={seedPassphrase}
                    onChange={(e) => setSeedPassphrase(e.target.value)}
                    placeholder="Leave blank if none"
                    autoComplete="off"
                    className="pr-9 text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full w-9 hover:bg-transparent"
                    onClick={() => setShowSeedPassphrase(!showSeedPassphrase)}
                  >
                    {showSeedPassphrase ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                  </Button>
                </div>
              </div>
              {seedLoginError && <p className="text-xs text-red-500">{seedLoginError}</p>}
              <Button className="w-full" onClick={handleSeedLogin} disabled={seedLoginLoading}>
                {seedLoginLoading ? 'Deriving key...' : 'Log in'}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Uses derivation path m/44'/1237'/0'/0/0 (NIP-06)
              </p>
            </div>
          </div>
        )}

        {/* Nsec password view */}
        {loginView === 'nsec' && (
          <div className="space-y-4 pt-2 border-t">
            <button
              type="button"
              onClick={() => setLoginView('main')}
              className="flex items-center justify-center w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              <ChevronLeft className="h-3 w-3 mr-1" />Back
            </button>

            <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <p className="text-xs text-amber-900 dark:text-amber-300">
                <span className="font-semibold">Less secure:</span> Pasting your key into a web page exposes it to any code running on this site.
                For better security, try using a browser extension or other external signer.
              </p>
            </div>

            <form ref={loginFormRef} onSubmit={(e) => { e.preventDefault(); handleNsecDirectLogin(); }} className="space-y-2" autoComplete="off">
              <Label htmlFor="nsec-login-input" className="text-xs font-medium">Secret key (nsec)</Label>
              <Input
                id="nsec-login-input"
                name="nsec-login"
                type="password"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                value={loginNsec}
                onChange={(e) => setLoginNsec(e.target.value)}
                placeholder="nsec1..."
                className="font-mono text-sm"
              />
              {nsecLoginError && (
                <p className="text-xs text-red-500">{nsecLoginError}</p>
              )}
              <Button type="submit" className="w-full" disabled={nsecLoginLoading}>
                {nsecLoginLoading ? 'Logging in...' : 'Log in'}
              </Button>
            </form>

          </div>
        )}

        {loginView === 'main' && (
          <div className="text-center text-xs text-muted-foreground/70 transition-opacity duration-500 px-2 min-h-[2.5rem] flex items-center justify-center">
            {LOGIN_TIPS[tipIndex]}
          </div>
        )}

        <div className="pt-4 border-t flex justify-center">
          <SecurityInfoDialog />
        </div>

      </div>
    </div>
  );
}
