/**
 * Tests for useAutoRestoreGuard — the safety hook that prevents auto-restore
 * from clobbering live local data.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { idbClear, idbSet, idbReady } from '@/lib/idb';
import { useAutoRestoreGuard } from './useAutoRestoreGuard';

const checkpointA = {
  timestamp: 1000,
  stats: { corkboards: 5, savedForLater: 0, dismissed: 0 },
};
// Newer by clock, but has NO corkboards — the case the richest-pick exists
// for. A clock-skewed device (or a save that raced a richer one) must not
// win just because its timestamp is bigger.
const checkpointB = {
  timestamp: 2000,
  stats: { corkboards: 0, savedForLater: 10, dismissed: 0 },
};

describe('useAutoRestoreGuard', () => {
  beforeEach(async () => {
    await idbReady;
    await idbClear();
  });

  it('does NOT call loadCheckpoint when meaningful local data exists', async () => {
    await idbSet('nostr-custom-feeds', JSON.stringify([{ id: '1', title: 'Bitcoin' }]));
    const loadCheckpoint = vi.fn();
    renderHook(() => useAutoRestoreGuard({
      backupCheckSettled: true,
      backupStatus: 'found',
      checkpoints: [checkpointA, checkpointB],
      lastBackupTs: 0,
      loadCheckpoint,
    }));
    // microtask + read
    await new Promise(r => setTimeout(r, 50));
    expect(loadCheckpoint).not.toHaveBeenCalled();
  });

  it('picks the RICHEST checkpoint when local is empty, not merely the newest by clock', async () => {
    // checkpointB has the bigger timestamp but zero corkboards; checkpointA
    // has fewer saved/dismissed but 5 corkboards. This is the exact bug: a
    // clock-skewed or merely-later save must not permanently outrank a far
    // more complete backup on the one read with nothing local to check it
    // against.
    const loadCheckpoint = vi.fn();
    renderHook(() => useAutoRestoreGuard({
      backupCheckSettled: true,
      backupStatus: 'found',
      checkpoints: [checkpointA, checkpointB],
      lastBackupTs: 0,
      loadCheckpoint,
    }));
    await new Promise(r => setTimeout(r, 50));
    expect(loadCheckpoint).toHaveBeenCalledTimes(1);
    expect(loadCheckpoint).toHaveBeenCalledWith(checkpointA);
  });

  it('falls back to the newest by timestamp when corkboard counts tie', async () => {
    const tieA = { timestamp: 1000, stats: { corkboards: 3, savedForLater: 5, dismissed: 5 } };
    const tieB = { timestamp: 2000, stats: { corkboards: 3, savedForLater: 5, dismissed: 5 } };
    const loadCheckpoint = vi.fn();
    renderHook(() => useAutoRestoreGuard({
      backupCheckSettled: true,
      backupStatus: 'found',
      checkpoints: [tieA, tieB],
      lastBackupTs: 0,
      loadCheckpoint,
    }));
    await new Promise(r => setTimeout(r, 50));
    expect(loadCheckpoint).toHaveBeenCalledWith(tieB);
  });

  it('does NOT trigger when backupStatus is not "found"', async () => {
    const loadCheckpoint = vi.fn();
    renderHook(() => useAutoRestoreGuard({
      backupCheckSettled: true,
      backupStatus: 'idle',
      checkpoints: [checkpointA],
      lastBackupTs: 0,
      loadCheckpoint,
    }));
    await new Promise(r => setTimeout(r, 50));
    expect(loadCheckpoint).not.toHaveBeenCalled();
  });

  it('does NOT trigger when checkpoints array is empty', async () => {
    const loadCheckpoint = vi.fn();
    renderHook(() => useAutoRestoreGuard({
      backupCheckSettled: true,
      backupStatus: 'found',
      checkpoints: [],
      lastBackupTs: 0,
      loadCheckpoint,
    }));
    await new Promise(r => setTimeout(r, 50));
    expect(loadCheckpoint).not.toHaveBeenCalled();
  });

  it('skips restore when lastBackupTs is ahead of the best checkpoint', async () => {
    const loadCheckpoint = vi.fn();
    renderHook(() => useAutoRestoreGuard({
      backupCheckSettled: true,
      backupStatus: 'found',
      checkpoints: [checkpointA, checkpointB],
      lastBackupTs: 9999,
      loadCheckpoint,
    }));
    await new Promise(r => setTimeout(r, 50));
    expect(loadCheckpoint).not.toHaveBeenCalled();
  });

  it('only fires once even if re-rendered', async () => {
    const loadCheckpoint = vi.fn();
    const { rerender } = renderHook(
      (props: Parameters<typeof useAutoRestoreGuard>[0]) => useAutoRestoreGuard(props),
      {
        initialProps: {
          backupCheckSettled: true,
          backupStatus: 'found',
          checkpoints: [checkpointA],
          lastBackupTs: 0,
          loadCheckpoint,
        },
      },
    );
    await new Promise(r => setTimeout(r, 30));
    rerender({
      backupCheckSettled: true,
      backupStatus: 'found',
      checkpoints: [checkpointA, checkpointB],
      lastBackupTs: 0,
      loadCheckpoint,
    });
    await new Promise(r => setTimeout(r, 30));
    expect(loadCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('treats empty-array feeds ("[]") as no local data', async () => {
    await idbSet('nostr-custom-feeds', '[]');
    const loadCheckpoint = vi.fn();
    renderHook(() => useAutoRestoreGuard({
      backupCheckSettled: true,
      backupStatus: 'found',
      checkpoints: [checkpointA],
      lastBackupTs: 0,
      loadCheckpoint,
    }));
    await new Promise(r => setTimeout(r, 50));
    expect(loadCheckpoint).toHaveBeenCalledWith(checkpointA);
  });
});
