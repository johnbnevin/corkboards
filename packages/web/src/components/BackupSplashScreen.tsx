import { useState, useEffect, useRef } from 'react';
import type { BackupStatus, RemoteCheckpoint } from '@/hooks/useNostrBackup';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { TIPS } from '@/lib/tips';

interface BackupSplashScreenProps {
  backupStatus: BackupStatus;
  message: string;
  remoteBackup: {
    stats?: { corkboards: number; savedForLater: number; dismissed: number };
    corkboardNames?: string[];
    timestamp: number;
    keys: string[];
  } | null;
  onRestore: () => void;
  onDismiss: () => void;
  scanOlderStates: () => Promise<void>;
  isScanning: boolean;
  checkpoints: RemoteCheckpoint[];
  loadCheckpoint: (cp: RemoteCheckpoint) => Promise<void>;
  logs?: string[];
}

export function BackupSplashScreen({
  backupStatus,
  remoteBackup,
  onRestore,
  onDismiss,
  scanOlderStates,
  isScanning,
  checkpoints,
  loadCheckpoint,
  logs = [],
}: BackupSplashScreenProps) {
  const logEndRef = useRef<HTMLDivElement>(null);
  // Track which checkpoint we're showing after user clicked "No"
  const [showingCheckpoint] = useState<RemoteCheckpoint | null>(null);
  // True once the user clicks "No, let me choose another one"
  const [showList, setShowList] = useState(false);

  // Cycling tips
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => {
    const timer = setInterval(() => {
      setTipIndex(prev => (prev + 1) % TIPS.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  // Auto-dismiss after restore
  useEffect(() => {
    if (backupStatus === 'restored') {
      const t = setTimeout(onDismiss, 2500);
      return () => clearTimeout(t);
    }
  }, [backupStatus, onDismiss]);

  const isDone = backupStatus === 'restored';
  const isError = backupStatus === 'restore-error' || backupStatus === 'no-backup';
  const isFound = backupStatus === 'found';
  const isRestoring = backupStatus === 'restoring';

  const visibleLogs = logs.slice(-12);

  // What to display: checkpoint from scan, or the initial remoteBackup
  const cp = showingCheckpoint;
  const displayStats = cp?.stats || remoteBackup?.stats;
  const displayNames = cp?.corkboardNames || remoteBackup?.corkboardNames;
  const displayTs = cp?.timestamp || remoteBackup?.timestamp;
  const dateStr = displayTs ? new Date(displayTs * 1000).toLocaleString() : null;

  const handleNo = () => {
    // Show the checkpoints we already have from the initial query immediately
    setShowList(true);
  };

  const handleRestore = () => {
    if (cp) {
      loadCheckpoint(cp);
    } else {
      onRestore();
    }
  };

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center z-50">
      <div className="text-center space-y-4 max-w-md px-4 w-full">
        <div className={`text-5xl ${isDone ? '' : isFound ? '' : 'animate-bounce'}`}>📌</div>
        <h2 className="text-xl font-bold text-purple-600 dark:text-purple-400">
          corkboards.me
        </h2>

        {/* Found a restore point — show details and let user choose */}
        {isFound && !showList && (remoteBackup || cp) && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Found restore point</p>
            {dateStr && (
              <p className="text-sm font-medium">{dateStr}</p>
            )}
            {displayStats && (
              <div className="text-sm text-muted-foreground space-y-0.5">
                <p>{displayStats.corkboards} corkboard{displayStats.corkboards !== 1 ? 's' : ''}{displayNames?.length ? `: ${displayNames.join(', ')}` : ''}</p>
                <p>{displayStats.savedForLater} saved, {displayStats.dismissed} dismissed</p>
              </div>
            )}
            <div className="flex flex-col gap-2 pt-2">
              <Button onClick={handleRestore} className="w-full">
                Restore
              </Button>
              <Button variant="outline" onClick={handleNo} className="w-full text-xs">
                No, let me choose another one.
              </Button>
            </div>
          </div>
        )}

        {/* List of checkpoints — shown immediately from already-fetched data */}
        {isFound && showList && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {checkpoints.length} restore point{checkpoints.length !== 1 ? 's' : ''}
            </p>
            <div className="max-h-[50vh] overflow-y-auto space-y-2 text-left">
              {checkpoints.map((c, i) => (
                <div key={c.eventId} className={`rounded-lg border p-3 space-y-1.5 ${i === 0 ? 'border-green-300 dark:border-green-700' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-xs">{new Date(c.timestamp * 1000).toLocaleString()}</span>
                    {i === 0 && <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">newest</span>}
                  </div>
                  {c.stats && (
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p>{c.stats.corkboards} corkboard{c.stats.corkboards !== 1 ? 's' : ''}{c.corkboardNames?.length ? `: ${c.corkboardNames.join(', ')}` : ''}</p>
                      <p>{c.stats.savedForLater} saved, {c.stats.dismissed} dismissed</p>
                    </div>
                  )}
                  <Button
                    size="sm"
                    className="h-6 text-xs mt-1"
                    onClick={() => loadCheckpoint(c)}
                  >
                    Restore
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={scanOlderStates}
                disabled={isScanning}
                className="w-full text-xs"
              >
                {isScanning ? (
                  <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Searching relays...</>
                ) : (
                  'Search for more'
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={onDismiss} className="w-full text-xs text-muted-foreground">
                Skip restore
              </Button>
            </div>
          </div>
        )}

        {/* Checking / restoring — show spinner + logs */}
        {!isFound && !isDone && !isError && (
          <div className="flex items-center justify-center gap-2">
            <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        )}

        {isDone && <div className="text-green-500 text-2xl">✓</div>}
        {isError && <div className="text-red-500 text-2xl">✗</div>}

        {/* Scrolling verbose log */}
        {(isRestoring || isDone || isError || (!isFound && !isDone)) && (
          <div className="text-left space-y-0.5 min-h-[140px] max-h-[200px] overflow-hidden flex flex-col justify-end px-2">
            {visibleLogs.map((entry, i) => {
              const age = visibleLogs.length - 1 - i;
              const opacity = age === 0 ? 1 : age < 3 ? 0.7 : age < 6 ? 0.4 : age < 9 ? 0.2 : 0.1;
              return (
                <p
                  key={`${logs.length - visibleLogs.length + i}`}
                  className="text-[11px] font-mono text-muted-foreground transition-opacity duration-300 leading-tight"
                  style={{ opacity }}
                >
                  {entry}
                </p>
              );
            })}
            <div ref={logEndRef} />
          </div>
        )}

        <p className="text-xs text-muted-foreground italic pt-6 transition-opacity duration-500">
          {TIPS[tipIndex]}
        </p>
      </div>
    </div>
  );
}
