/**
 * Settings backup, restore, and checkpoint system for mobile.
 *
 * Port of packages/web/src/lib/downloadBackup.ts.
 * Platform differences:
 *   - Uses MMKV (synchronous) instead of IndexedDB
 *   - No browser download (Blob/URL.createObjectURL) — returns backup data
 *     as a string so the UI layer can share/save via React Native Share API
 *   - crypto.subtle for SHA-256 checksums (available in React Native Hermes)
 *
 * Exports: createBackup, restoreBackup, getBackupCheckpoints, preflightRestore
 */
import { mobileStorage } from '../storage/MmkvStorage';
import { BACKED_UP_KEYS, STORAGE_KEYS } from '../lib/storageKeys';

const LAST_LOCAL_DOWNLOAD_KEY = 'corkboard:last-local-download-ts';

// --- Helpers ----------------------------------------------------------------

function countArr(json: string | null | undefined): number {
  if (!json) return 0;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

function corkboardNames(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.map((f: { title?: string }) => f.title || 'Untitled').filter(Boolean);
  } catch {
    return [];
  }
}

export interface BackupStats {
  corkboards: number;
  savedForLater: number;
  dismissed: number;
  rssFeeds: number;
  filterRules: number;
}

function computeStats(data: Record<string, string | null>): BackupStats {
  // savedForLater = union of collapsed-notes + nostr-bookmark-ids
  const collapsedIds = parseIds(data['collapsed-notes']);
  const bookmarkIds = parseIds(data['nostr-bookmark-ids']);
  const savedUnion = new Set([...collapsedIds, ...bookmarkIds]);

  return {
    corkboards: countArr(data['nostr-custom-feeds']),
    savedForLater: savedUnion.size,
    dismissed: countArr(data['dismissed-notes']),
    rssFeeds: countArr(data['nostr-rss-feeds']),
    filterRules: countArr(data['corkboard:hide-exact-text']),
  };
}

function parseIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [];
  } catch { return []; }
}

/** Get current stats from MMKV. */
export function getCurrentStats(): BackupStats {
  const data: Record<string, string | null> = {};
  for (const key of BACKED_UP_KEYS) {
    data[key] = mobileStorage.getSync(key);
  }
  return computeStats(data);
}

// --- Serialize --------------------------------------------------------------

/** Serialize all backed-up settings into a JSON object (same keys as Blossom backup). */
export function serializeSettings(): Record<string, string> {
  const data: Record<string, string> = {};
  for (const key of BACKED_UP_KEYS) {
    const value = mobileStorage.getSync(key);
    if (value !== null) {
      data[key] = value;
    }
  }
  return data;
}

// --- Create backup ----------------------------------------------------------

/**
 * Create a backup and return it as a JSON string.
 *
 * Unlike web (which triggers a browser download), this returns the serialized
 * backup so the UI layer can share/save via React Native's Share API or
 * file system (expo-file-system, expo-sharing, etc.).
 *
 * Also returns a suggested filename for convenience.
 */
export async function createBackup(): Promise<{ json: string; filename: string; stats: BackupStats }> {
  const settings = serializeSettings();
  const stats = computeStats(settings);
  const names = corkboardNames(settings['nostr-custom-feeds']);

  const backup: Record<string, unknown> = {
    version: 4,
    site: 'corkboards.me',
    createdAt: new Date().toISOString(),
    createdAtUnix: Math.floor(Date.now() / 1000),
    stats,
    corkboardNames: names,
    info: "This file contains all your corkboards.me settings: custom feeds, filters, dismissed notes, RSS feeds, wallet connection, and display preferences. If you ever lose access to your account, importing this file will restore everything on this site except your follower list. It won't help on other Nostr apps — it's specific to corkboards.me.",
    settings,
  };

  // Add a SHA-256 checksum for self-verification on restore
  const settingsJson = JSON.stringify(backup.settings);
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(settingsJson));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  backup.checksum = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const json = JSON.stringify(backup, null, 2);

  // Record last download timestamp
  mobileStorage.setSync(LAST_LOCAL_DOWNLOAD_KEY, String(Date.now()));

  const date = new Date().toISOString().slice(0, 10);
  return { json, filename: `corkboards-backup-${date}.json`, stats };
}

/** Check if the user should be prompted to download a backup (>30 days since last). */
export function shouldPromptBackupDownload(): boolean {
  const lastTs = mobileStorage.getSync(LAST_LOCAL_DOWNLOAD_KEY);
  if (!lastTs) {
    mobileStorage.setSync(LAST_LOCAL_DOWNLOAD_KEY, String(Date.now()));
    return false;
  }
  const elapsed = Date.now() - parseInt(lastTs, 10);
  return elapsed > 30 * 24 * 60 * 60 * 1000;
}

/** Dismiss the prompt without downloading (resets the 30-day timer). */
export function dismissBackupPrompt(): void {
  mobileStorage.setSync(LAST_LOCAL_DOWNLOAD_KEY, String(Date.now()));
}

// --- Checkpoints (restore history) ------------------------------------------

export interface Checkpoint {
  timestamp: number;
  source: 'file' | 'nostr';
  version: number;
  stats: BackupStats;
  corkboardNames: string[];
  data: Record<string, string>;
  name?: string;
}

/** Get all saved checkpoints (most recent first). */
export function getCheckpoints(): Checkpoint[] {
  const raw = mobileStorage.getSync(STORAGE_KEYS.RESTORE_HISTORY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/** Alias for getCheckpoints — matches the exported API name in the spec. */
export const getBackupCheckpoints = getCheckpoints;

/** Save a checkpoint of the current settings. */
export function saveCheckpoint(source: 'file' | 'nostr', name?: string): void {
  const data = serializeSettings();
  const stats = computeStats(data);
  const names = corkboardNames(data['nostr-custom-feeds']);

  const checkpoint: Checkpoint = {
    timestamp: Date.now(),
    source,
    version: 4,
    stats,
    corkboardNames: names,
    data,
    name,
  };

  const existing = getCheckpoints();
  mobileStorage.setSync(STORAGE_KEYS.RESTORE_HISTORY, JSON.stringify([checkpoint, ...existing]));
}

/** Rename a checkpoint by index. */
export function renameCheckpoint(index: number, name: string): void {
  const checkpoints = getCheckpoints();
  if (index >= 0 && index < checkpoints.length) {
    checkpoints[index].name = name;
    mobileStorage.setSync(STORAGE_KEYS.RESTORE_HISTORY, JSON.stringify(checkpoints));
  }
}

/** Delete a checkpoint by index. */
export function deleteCheckpoint(index: number): void {
  const checkpoints = getCheckpoints();
  if (index >= 0 && index < checkpoints.length) {
    checkpoints.splice(index, 1);
    mobileStorage.setSync(STORAGE_KEYS.RESTORE_HISTORY, JSON.stringify(checkpoints));
  }
}

/** Restore from a specific checkpoint. Returns number of keys restored. */
export function restoreFromCheckpoint(checkpoint: Checkpoint): number {
  let count = 0;
  const validKeys = new Set(BACKED_UP_KEYS as readonly string[]);
  for (const [key, value] of Object.entries(checkpoint.data)) {
    if (validKeys.has(key) && typeof value === 'string') {
      mobileStorage.setSync(key, value);
      count++;
    }
  }
  return count;
}

// --- Preflight (restore warnings) -------------------------------------------

export interface RestoreWarning {
  field: string;
  current: number;
  incoming: number;
}

export interface PreflightResult {
  warnings: RestoreWarning[];
  incomingStats: BackupStats;
  currentStats: BackupStats;
  incomingVersion: number;
  incomingTimestamp: number;
  incomingCorkboardNames: string[];
}

/** Analyze incoming backup data and compare against current state.
 *  Supports both v4 format ({version, settings: {...}}) and flat format ({key: value, ...}). */
export function preflightRestore(json: string): PreflightResult {
  const backup = JSON.parse(json);
  const settings = (backup.settings && typeof backup.settings === 'object') ? backup.settings : backup;
  const incomingStats = computeStats(settings);
  const currentStats = getCurrentStats();
  const incomingVersion = backup.version || 1;
  const incomingTimestamp = backup.createdAtUnix || backup.timestamp || 0;
  const incomingCorkboardNames = corkboardNames(settings['nostr-custom-feeds']);

  const warnings: RestoreWarning[] = [];

  if (incomingStats.corkboards < currentStats.corkboards && currentStats.corkboards > 0) {
    warnings.push({ field: 'Corkboards', current: currentStats.corkboards, incoming: incomingStats.corkboards });
  }
  if (incomingStats.savedForLater < currentStats.savedForLater && currentStats.savedForLater > 0) {
    warnings.push({ field: 'Saved-for-later notes', current: currentStats.savedForLater, incoming: incomingStats.savedForLater });
  }
  if (incomingStats.dismissed < currentStats.dismissed && currentStats.dismissed > 0) {
    warnings.push({ field: 'Dismissed notes', current: currentStats.dismissed, incoming: incomingStats.dismissed });
  }
  if (incomingStats.rssFeeds < currentStats.rssFeeds && currentStats.rssFeeds > 0) {
    warnings.push({ field: 'RSS feeds', current: currentStats.rssFeeds, incoming: incomingStats.rssFeeds });
  }

  return { warnings, incomingStats, currentStats, incomingVersion, incomingTimestamp, incomingCorkboardNames };
}

// --- Restore from file ------------------------------------------------------

/** Restore settings from a backup JSON string. Returns number of keys restored.
 *  All writes go to MMKV (synchronous, no async persistence needed).
 *  Supports both v4 format ({version, settings: {...}}) and flat format ({key: value, ...}). */
export async function restoreBackup(json: string): Promise<number> {
  let backup: Record<string, unknown>;
  try {
    backup = JSON.parse(json);
  } catch {
    throw new Error('Backup file is not valid JSON');
  }
  if (!backup || typeof backup !== 'object') {
    throw new Error('Invalid backup file');
  }

  // Detect format: v4 has a `settings` object wrapper; flat format has keys directly
  const settings: Record<string, unknown> = (backup.settings && typeof backup.settings === 'object')
    ? backup.settings as Record<string, unknown>
    : backup;

  // Verify checksum if present (v4+ backups)
  if (backup.checksum) {
    const settingsJson = JSON.stringify(settings);
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(settingsJson));
    const computed = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (computed !== backup.checksum) {
      throw new Error('Backup checksum mismatch — file may be corrupted or tampered with');
    }
  }

  let count = 0;
  const validKeys = new Set(BACKED_UP_KEYS as readonly string[]);
  for (const [key, value] of Object.entries(settings)) {
    if (validKeys.has(key) && typeof value === 'string') {
      mobileStorage.setSync(key, value);
      count++;
    }
  }
  return count;
}
