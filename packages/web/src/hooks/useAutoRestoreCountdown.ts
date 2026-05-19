/**
 * useAutoRestoreCountdown — runs a 5-second visible countdown then auto-fires
 * a load action. Used when the idle-return check finds a substantially newer
 * cloud checkpoint and proposes restoring it.
 *
 * The countdown is observable so the UI can show "Restoring in 5… 4… 3…".
 * Cancelling clears the target and the countdown both.
 */
import { useEffect, useState } from 'react';

export interface UseAutoRestoreCountdownOptions<T> {
  /** When non-null, start the countdown. When null, cancel. */
  target: T | null;
  /** Seconds in the countdown. Defaults to 5. */
  durationSecs?: number;
  /** Called when the countdown hits 0 and target is still set. */
  onElapsed: (target: T) => void;
  /** Setter for the target — called with null after onElapsed fires. */
  clearTarget: () => void;
}

export interface UseAutoRestoreCountdownResult {
  /** Current countdown seconds remaining (null when not running). */
  countdown: number | null;
}

export function useAutoRestoreCountdown<T>({
  target,
  durationSecs = 5,
  onElapsed,
  clearTarget,
}: UseAutoRestoreCountdownOptions<T>): UseAutoRestoreCountdownResult {
  const [countdown, setCountdown] = useState<number | null>(null);

  // Reset countdown whenever the target changes.
  useEffect(() => {
    if (!target) {
      setCountdown(null);
      return;
    }
    setCountdown(durationSecs);
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev === null || prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [target, durationSecs]);

  // Fire when the countdown completes.
  useEffect(() => {
    if (countdown !== 0 || !target) return;
    onElapsed(target);
    clearTarget();
  }, [countdown, target, onElapsed, clearTarget]);

  return { countdown };
}
