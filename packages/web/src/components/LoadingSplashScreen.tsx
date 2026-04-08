import { useEffect, useState } from 'react';

interface RelayInfo {
  url: string;
  status: 'healthy' | 'slow' | 'error' | 'unknown';
  latency: number | null;
  hostname: string;
}

interface LoadingSplashScreenProps {
  message?: string;
  status?: string;
  detail?: string;
  relays?: RelayInfo[];
}

export function LoadingSplashScreen({ message, status, detail, relays }: LoadingSplashScreenProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const displayMessage = message ?? status ?? 'Loading notes...';

  const healthyCount = relays?.filter(r => r.status === 'healthy').length ?? 0;
  const slowCount = relays?.filter(r => r.status === 'slow').length ?? 0;
  const errorCount = relays?.filter(r => r.status === 'error').length ?? 0;
  const totalRelays = relays?.length ?? 0;

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center z-50">
      <div className="text-center space-y-4 max-w-md w-full px-6">
        <div className="text-5xl">📌</div>
        <h2 className="text-xl font-bold text-purple-600 dark:text-purple-400">
          corkboards.me
        </h2>

        <div className="flex items-center justify-center gap-2">
          <div className="animate-spin h-4 w-4 border-2 border-purple-500 border-t-transparent rounded-full shrink-0" />
          <span className="text-sm text-foreground font-medium">{displayMessage}</span>
        </div>

        {detail && (
          <div className="text-xs text-muted-foreground font-mono bg-muted/30 rounded p-3 text-left max-h-32 overflow-y-auto">
            <pre className="whitespace-pre-wrap">{detail}</pre>
          </div>
        )}

        {relays && relays.length > 0 && (
          <div className="text-xs text-muted-foreground space-y-2">
            <p className="font-medium">
              Searching {totalRelays} relay{totalRelays !== 1 ? 's' : ''} for notes from follows...
            </p>
            <div className="bg-muted/30 rounded p-2 text-left max-h-40 overflow-y-auto space-y-1">
              {relays.map((relay) => (
                <div key={relay.url} className="flex items-center gap-2 font-mono">
                  {relay.status === 'healthy' && (
                    <span className="text-green-500">✓</span>
                  )}
                  {relay.status === 'slow' && (
                    <span className="text-yellow-500">⚠</span>
                  )}
                  {relay.status === 'error' && (
                    <span className="text-red-500">✗</span>
                  )}
                  {relay.status === 'unknown' && (
                    <span className="text-muted-foreground">○</span>
                  )}
                  <span className="truncate flex-1">{relay.hostname}</span>
                  {relay.latency !== null && (
                    <span className="text-muted-foreground shrink-0">{relay.latency}ms</span>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-3 justify-center text-[10px] pt-1">
              {healthyCount > 0 && <span className="text-green-500">{healthyCount} healthy</span>}
              {slowCount > 0 && <span className="text-yellow-500">{slowCount} slow</span>}
              {errorCount > 0 && <span className="text-red-500">{errorCount} error</span>}
            </div>
          </div>
        )}

        {elapsed >= 3 && (!relays || relays.length === 0) && (
          <p className="text-xs text-muted-foreground/60">
            {elapsed}s elapsed — fetching from relays...
          </p>
        )}
        {elapsed >= 15 && (
          <p className="text-xs text-muted-foreground/50">
            Still loading... {30 - elapsed}s until continue
          </p>
        )}
      </div>
    </div>
  );
}
