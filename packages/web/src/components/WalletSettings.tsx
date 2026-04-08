import { useState } from 'react';
import { useNwc } from '@/hooks/useNwc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Wallet, Unplug } from 'lucide-react';

export function WalletSettings() {
  const { setNwcUri, isConnected, walletRelay, disconnect } = useNwc();
  const [inputUri, setInputUri] = useState('');
  const [error, setError] = useState('');

  const handleConnect = () => {
    const trimmed = inputUri.trim();
    if (!trimmed.startsWith('nostr+walletconnect://')) return;
    try {
      setNwcUri(trimmed);
      setInputUri('');
      setError('');
    } catch {
      setError('Invalid NWC URI — check the format and try again');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Wallet className="h-5 w-5" />
        <h3 className="font-semibold">Wallet Connection</h3>
        {isConnected && (
          <span className="flex items-center gap-1.5 text-xs text-purple-600 dark:text-purple-400">
            <span className="h-2 w-2 rounded-full bg-purple-500" />
            Connected
          </span>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Connect a bitcoin Lightning wallet via Nostr Wallet Connect (NWC) to send zaps.
      </p>

      {isConnected ? (
        <div className="space-y-3">
          {walletRelay && (
            <p className="text-xs text-muted-foreground">
              Relay: <span className="font-mono">{walletRelay.replace('wss://', '')}</span>
            </p>
          )}
          <Button variant="outline" size="sm" onClick={disconnect} className="gap-2">
            <Unplug className="h-4 w-4" />
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Input
            placeholder="nostr+walletconnect://..."
            value={inputUri}
            onChange={(e) => { setInputUri(e.target.value); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            className="font-mono text-xs"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button
            onClick={handleConnect}
            disabled={!inputUri.trim().startsWith('nostr+walletconnect://')}
            size="sm"
            className="gap-2"
          >
            <Wallet className="h-4 w-4" />
            Connect
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Need a wallet?{' '}
        <a href="https://coinos.io" target="_blank" rel="noopener noreferrer" className="text-purple-500 hover:underline">
          coinos.io
        </a>
        {' '}&mdash; no signup required.
      </p>
    </div>
  );
}
