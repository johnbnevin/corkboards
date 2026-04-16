import { useState, useEffect, useRef } from 'react';
import type { BackupStatus } from '@/hooks/useNostrBackup';
import { TIPS } from '@/lib/tips';

interface BackupSplashScreenProps {
  backupStatus: BackupStatus;
  message: string;
  logs?: string[];
  onDismiss: () => void;
}

export function BackupSplashScreen({
  backupStatus,
  onDismiss,
  logs = [],
}: BackupSplashScreenProps) {
  const logEndRef = useRef<HTMLDivElement>(null);

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
  const isRestoring = backupStatus === 'restoring';

  const visibleLogs = logs.slice(-12);

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center z-50">
      <div className="text-center space-y-4 max-w-md px-4 w-full">
        <div className={`text-5xl ${isDone ? '' : 'animate-bounce'}`}>📌</div>
        <h2 className="text-xl font-bold text-purple-600 dark:text-purple-400">
          corkboards.me
        </h2>

        {/* Checking / found / restoring — show spinner */}
        {!isDone && !isError && (
          <div className="flex items-center justify-center gap-2">
            <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        )}

        {isDone && <div className="text-green-500 text-2xl">✓</div>}
        {isError && <div className="text-red-500 text-2xl">✗</div>}

        {/* Scrolling verbose log */}
        {(isRestoring || isDone || isError || !isDone) && (
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
