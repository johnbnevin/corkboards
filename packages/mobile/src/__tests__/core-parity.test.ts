/**
 * Parity guards for the @core logic mobile shares with web.
 *
 * Mobile used to carry its own copies of the note classifier and hashtag
 * helpers in HomeScreen; they drifted (missing video patterns, no NIP-25
 * reaction targeting) so the same note landed in different filter chips on
 * each platform. Those copies are gone and mobile imports @core directly — this
 * file locks that in, and runs the assertions under mobile's own jest/Hermes
 * transform rather than only under web's vitest.
 */
import type { NostrEvent } from '@nostrify/nostrify';
import {
  getNoteCategories,
  computeNoteKindStats,
  computeHashtagCounts,
  noteMatchesHashtags,
} from '@core/noteCategories';
import { isUnsafeHost, isPrivateIPv6 } from '@core/ipUtils';
import { isSecureRelay } from '@core/nostrUtils';
import { normalizeRelay } from '@core/normalizeRelay';
import { buildReplyTags } from '@core/noteClassifier';

function ev(partial: Partial<NostrEvent> & Pick<NostrEvent, 'kind'>): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 0,
    tags: [],
    content: '',
    sig: '',
    ...partial,
  } as NostrEvent;
}

describe('note classification (shared with web)', () => {
  it('classifies a plain short note', () => {
    expect([...getNoteCategories(ev({ kind: 1, content: 'hello' }))]).toEqual(['shortNotes']);
  });

  it('classifies a kind-1 with an e-tag as a reply', () => {
    const note = ev({ kind: 1, content: 'hi', tags: [['e', 'c'.repeat(64)]] });
    expect(getNoteCategories(note).has('replies')).toBe(true);
    expect(getNoteCategories(note).has('shortNotes')).toBe(false);
  });

  it('detects video URLs the old mobile-local copy missed', () => {
    // These patterns existed only in @core; the deleted mobile copy would have
    // filed each of these under "shortNotes".
    for (const url of [
      'https://twitch.tv/videos/123',
      'https://odysee.com/@someone',
      'https://example.com/clip.m4v',
      'https://example.com/stream.m3u8',
    ]) {
      expect(getNoteCategories(ev({ kind: 1, content: url })).has('videos')).toBe(true);
    }
  });

  it('detects images on ambiguous blossom CDNs without a file extension mismatch', () => {
    expect(getNoteCategories(ev({ kind: 1, content: 'https://blossom.band/abc.png' })).has('images')).toBe(true);
    // …but a video blob on the same CDN is not an image.
    expect(getNoteCategories(ev({ kind: 1, content: 'https://blossom.band/abc.mp4' })).has('images')).toBe(false);
  });

  it('counts a note in every applicable category', () => {
    const stats = computeNoteKindStats([
      ev({ kind: 1, content: 'plain' }),
      ev({ kind: 1, id: 'd'.repeat(64), content: 'https://youtu.be/xyz' }),
      ev({ kind: 6, id: 'e'.repeat(64) }),
    ]);
    expect(stats?.total).toBe(3);
    expect(stats?.shortNotes).toBe(2);
    expect(stats?.videos).toBe(1);
    expect(stats?.reposts).toBe(1);
  });

  it('extracts hashtags from both t-tags and inline text', () => {
    const counts = computeHashtagCounts([
      ev({ kind: 1, content: 'about #bitcoin', tags: [['t', 'nostr']] }),
    ]);
    expect(counts.get('bitcoin')).toBe(1);
    expect(counts.get('nostr')).toBe(1);
  });

  it('matches hashtags case-insensitively', () => {
    const note = ev({ kind: 1, content: 'hi #Nostr' });
    expect(noteMatchesHashtags(note, new Set(['nostr']))).toBe(true);
    expect(noteMatchesHashtags(note, new Set(['bitcoin']))).toBe(false);
  });
});

describe('host safety gates (shared with web)', () => {
  it('rejects private hosts in every IPv4 encoding', () => {
    for (const h of ['localhost', '127.0.0.1', '2130706433', '0x7f000001', '127.1', '169.254.169.254']) {
      expect(isUnsafeHost(h)).toBe(true);
    }
  });

  it('rejects the full fe80::/10 link-local range, not just the fe80 prefix', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('feb0::1')).toBe(true);
  });

  it('allows real public hosts', () => {
    expect(isUnsafeHost('relay.nostr.net')).toBe(false);
    expect(isUnsafeHost('1.1.1.1')).toBe(false);
  });

  it('only accepts wss relays on public hosts', () => {
    expect(isSecureRelay('wss://nos.lol')).toBe(true);
    expect(isSecureRelay('ws://nos.lol')).toBe(false);
    expect(isSecureRelay('wss://127.0.0.1')).toBe(false);
  });

  it('normalizes relay input to a canonical wss URL', () => {
    expect(normalizeRelay('nos.lol')).toBe('wss://nos.lol/');
    expect(normalizeRelay('nos.lol:7777')).toBe('wss://nos.lol:7777/');
    expect(normalizeRelay('ws://nos.lol')).toBe('wss://nos.lol/');
  });
});

describe('NIP-10 reply tags (shared with web)', () => {
  const ID_ROOT = 'a'.repeat(64);
  const ID_PARENT = 'b'.repeat(64);
  const PK_PARENT = '1'.repeat(64);
  const PK_ROOT = '2'.repeat(64);

  it('roots a reply to a top-level note at that note, with hint and author', () => {
    const parent = ev({ kind: 1, id: ID_PARENT, pubkey: PK_PARENT });
    expect(buildReplyTags(parent, 'wss://hint.example').filter(t => t[0] === 'e')).toEqual([
      ['e', ID_PARENT, 'wss://hint.example', 'root', PK_PARENT],
    ]);
  });

  it('forwards the ancestor p-tag chain without duplicating the parent author', () => {
    const parent = ev({
      kind: 1,
      id: ID_PARENT,
      pubkey: PK_PARENT,
      tags: [['e', ID_ROOT, '', 'root'], ['p', PK_ROOT], ['p', PK_PARENT]],
    });
    expect(buildReplyTags(parent).filter(t => t[0] === 'p')).toEqual([
      ['p', PK_PARENT],
      ['p', PK_ROOT],
    ]);
  });
});
