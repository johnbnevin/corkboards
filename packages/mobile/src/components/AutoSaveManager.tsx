/**
 * AutoSaveManager — headless component that orchestrates automatic cloud backup.
 *
 * Mirrors the web's auto-save logic in MultiColumnClient.tsx:
 *   - 30-second poll interval to detect and save changes
 *   - Immediate save when app goes to background
 *   - Auto-restore check when returning from 5+ minutes in background
 *
 * Mount alongside NostrSync in App.tsx — renders nothing.
 */
import { useEffect, useRef, useCallback } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useAuth } from '../lib/AuthContext';
import { useNostrBackup } from '../hooks/useNostrBackup';
import { mobileStorage } from '../storage/MmkvStorage';

const MIN_SAVE_INTERVAL_MS = 30_000;

export function AutoSaveManager() {
  const { pubkey, signer } = useAuth();
  const {
    autoSaveBackup,
    hasUnsavedChanges,
    checkForBackup,
    restoreBackup,
    checkpoints,
    lastBackupTs,
  } = useNostrBackup(pubkey, signer);

  const lastHiddenRef = useRef(0);
  const idleCheckDoneRef = useRef(false);

  // Trigger auto-save if conditions are met (mirrors web's triggerBlossomIfReady).
  const changeDetectedAtRef = useRef<number | null>(null);

  const triggerIfReady = useCallback((source: string) => {
    const lastUploadMs = (lastBackupTs ?? 0) * 1000;
    if (Date.now() - lastUploadMs < MIN_SAVE_INTERVAL_MS) return;
    if (!hasUnsavedChanges()) {
      changeDetectedAtRef.current = null;
      return;
    }
    if (changeDetectedAtRef.current === null) {
      changeDetectedAtRef.current = Date.now();
      if (__DEV__) console.log(`[AutoSave] changes detected (${source}), will save in 30s`);
      return;
    }
    if (Date.now() - changeDetectedAtRef.current < MIN_SAVE_INTERVAL_MS) return;
    if (__DEV__) console.log(`[AutoSave] triggering (${source})`);
    changeDetectedAtRef.current = null;
    autoSaveBackup().catch(e => {
      if (__DEV__) console.warn('[AutoSave] failed:', e);
    });
  }, [autoSaveBackup, hasUnsavedChanges, lastBackupTs]);

  // 30-second polling + AppState listener
  useEffect(() => {
    if (!pubkey || !signer) return;

    const pollInterval = setInterval(() => triggerIfReady('poll-30s'), 30_000);
    // Initial check on mount
    triggerIfReady('mount');

    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        // Force immediate save on background — bypass interval check
        lastHiddenRef.current = Date.now();
        idleCheckDoneRef.current = false;
        if (hasUnsavedChanges()) {
          if (__DEV__) console.log('[AutoSave] forcing save on background');
          autoSaveBackup().catch(e => {
            if (__DEV__) console.warn('[AutoSave] bg save failed:', e);
          });
        }
      } else if (nextState === 'active' && lastHiddenRef.current > 0 && !idleCheckDoneRef.current) {
        const awayMs = Date.now() - lastHiddenRef.current;
        if (awayMs >= 5 * 60 * 1000) {
          idleCheckDoneRef.current = true;
          // Auto-restore check after 5+ min in background
          if (__DEV__) console.log(`[AutoSave] back from ${Math.round(awayMs / 60000)}min idle, checking for newer backup`);
          checkForBackup().then(() => {
            // If checkpoints were found, auto-restore the best one
            // (checkpoints state will update on next render)
          }).catch(e => {
            if (__DEV__) console.warn('[AutoSave] idle restore check failed:', e);
          });
        }
      }
    };

    const subscription = AppState.addEventListener('change', handleAppState);
    return () => {
      clearInterval(pollInterval);
      subscription.remove();
    };
  }, [pubkey, signer, triggerIfReady, autoSaveBackup, hasUnsavedChanges, checkForBackup]);

  // Auto-restore best checkpoint when checkForBackup finds newer ones after idle return.
  // Critical guard: never silently restore over existing local data. lastBackupTs starts
  // at 0 until the first successful save/restore, so naively comparing "newest > 0" would
  // wipe a power-user with real local data who has never explicitly clicked Save Now.
  const idleRestoreDone = useRef(false);
  useEffect(() => {
    if (idleRestoreDone.current || !idleCheckDoneRef.current) return;
    if (!checkpoints.length) return;
    const newest = checkpoints[0];
    if (!newest) return;
    // If local already has meaningful data, never silently clobber it.
    const feeds = mobileStorage.getSync('nostr-custom-feeds');
    const filters = mobileStorage.getSync('corkboard:tab-filters');
    const hasMeaningfulLocal =
      (feeds && feeds !== '[]' && feeds !== 'null') ||
      (filters && filters !== '{}' && filters !== 'null');
    if (hasMeaningfulLocal && (lastBackupTs ?? 0) === 0) {
      // User has data but never stamped LAST_BACKUP_TS. Skip silent restore;
      // user can open Backup & Restore manually if they want to pull from cloud.
      idleRestoreDone.current = true;
      if (__DEV__) console.log('[AutoSave] skipping silent restore — local data present without timestamp');
      return;
    }
    if (newest.timestamp > (lastBackupTs ?? 0)) {
      idleRestoreDone.current = true;
      if (__DEV__) console.log('[AutoSave] auto-restoring newer checkpoint from idle return');
      restoreBackup(newest).catch(e => {
        if (__DEV__) console.warn('[AutoSave] idle auto-restore failed:', e);
      });
    }
  }, [checkpoints, lastBackupTs, restoreBackup]);

  return null;
}
