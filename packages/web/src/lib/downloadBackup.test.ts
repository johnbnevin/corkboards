/**
 * Backup round-trip safety test.
 *
 * Given the production data-loss incidents that motivated the recent
 * auto-restore guards, a regression test for the serialize → restore
 * cycle is the cheapest safety net we can write. If anyone breaks the
 * format or the IDB write path, this fires immediately.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { idbSet, idbGet, idbClear, idbReady, idbGetSync, idbSetSync } from './idb';
import { serializeSettings } from './downloadBackup';
import { restoreFromBackupFile } from './downloadBackup';
import { BACKED_UP_KEYS } from '@/lib/storageKeys';

const SAMPLE = {
  'nostr-custom-feeds': JSON.stringify([
    { id: '1', title: 'Bitcoin', pubkeys: ['abc'.repeat(21).slice(0, 64)], relays: [], rssUrls: [] },
    { id: '2', title: 'Nostr Devs', pubkeys: [], relays: [], rssUrls: ['https://example.com/feed.xml'] },
  ]),
  'dismissed-notes': JSON.stringify(['noteid1', 'noteid2', 'noteid3']),
  'collapsed-notes': JSON.stringify(['saved1']),
  'nostr-bookmark-ids': JSON.stringify(['bookmark1', 'bookmark2']),
  'corkboard:tab-filters': JSON.stringify({ feed1: { hashtags: ['nostr'] } }),
  'corkboard:show-own-notes': 'true',
} as const;

async function seed(): Promise<void> {
  for (const [k, v] of Object.entries(SAMPLE)) {
    idbSetSync(k, v);
    await idbSet(k, v);
  }
}

describe('backup round-trip', () => {
  beforeEach(async () => {
    await idbReady;
    await idbClear();
  });

  it('preserves every backed-up key through serialize → restore', async () => {
    await seed();
    const settings = serializeSettings();
    // Wrap in v4 format the way downloadSettingsBackup does (without checksum
    // so we don't depend on subtle.crypto in jsdom).
    const json = JSON.stringify({ version: 4, settings });

    // Wipe storage to simulate a fresh install
    await idbClear();
    for (const k of Object.keys(SAMPLE)) {
      expect(idbGetSync(k)).toBeNull();
    }

    const count = await restoreFromBackupFile(json);
    expect(count).toBe(Object.keys(SAMPLE).length);

    // Verify every sample key matches exactly
    for (const [k, v] of Object.entries(SAMPLE)) {
      expect(idbGetSync(k)).toBe(v);
      // Also verify the persistent layer (not just memCache)
      expect(await idbGet(k)).toBe(v);
    }
  });

  it('restoreFromBackupFile rejects non-JSON input', async () => {
    await expect(restoreFromBackupFile('not json')).rejects.toThrow(/JSON/);
  });

  it('restoreFromBackupFile rejects unknown keys silently (does not crash)', async () => {
    const json = JSON.stringify({
      version: 4,
      settings: {
        'nostr-custom-feeds': '[]',
        'evil-attacker-key': 'evil-value',
      },
    });
    const count = await restoreFromBackupFile(json);
    // Only the known key is counted
    expect(count).toBe(1);
    expect(idbGetSync('evil-attacker-key')).toBeNull();
  });

  it('serializeSettings produces only known BACKED_UP_KEYS', async () => {
    await seed();
    // Inject something not in the backed-up set
    idbSetSync('some-other-key', 'should-not-appear');
    const settings = serializeSettings();
    const validKeys = new Set(BACKED_UP_KEYS as readonly string[]);
    for (const k of Object.keys(settings)) {
      expect(validKeys.has(k)).toBe(true);
    }
    expect(settings['some-other-key']).toBeUndefined();
  });

  it('accepts flat (legacy) format alongside v4 wrapper', async () => {
    await seed();
    const settings = serializeSettings();
    // Flat format: keys at the top level, no `settings` wrapper
    const flatJson = JSON.stringify(settings);
    await idbClear();
    const count = await restoreFromBackupFile(flatJson);
    expect(count).toBeGreaterThan(0);
    expect(idbGetSync('nostr-custom-feeds')).toBe(SAMPLE['nostr-custom-feeds']);
  });
});
