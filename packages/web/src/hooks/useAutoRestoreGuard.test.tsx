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

  it('calls loadCheckpoint with the newest checkpoint when local is empty', async () => {
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
    expect(loadCheckpoint).toHaveBeenCalledWith(checkpointB); // newest timestamp
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
