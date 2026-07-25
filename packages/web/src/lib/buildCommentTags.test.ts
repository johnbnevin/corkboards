/**
 * NIP-22 comment (kind 1111) scope tags.
 *
 * The uppercase set describes the thread root, the lowercase set the item
 * actually being replied to; a top-level comment repeats the root as its own
 * parent. What regresses easily — and what leaves other clients unable to
 * resolve the parent — is the relay hint and the author pubkey on E/e, so both
 * are pinned here.
 */
import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { buildCommentTags } from '@core/noteClassifier';

const ID_ROOT = 'a'.repeat(64);
const ID_REPLY = 'b'.repeat(64);
const PK_ROOT = '1'.repeat(64);
const PK_REPLY = '2'.repeat(64);

function ev(partial: Partial<NostrEvent> & Pick<NostrEvent, 'id' | 'pubkey' | 'kind'>): NostrEvent {
  return { created_at: 0, content: '', sig: '', tags: [], ...partial } as NostrEvent;
}

const hints: Record<string, string> = {
  [PK_ROOT]: 'wss://root.example',
  [PK_REPLY]: 'wss://reply.example',
};
const hintFor = (pk: string) => hints[pk];

describe('buildCommentTags (NIP-22)', () => {
  it('repeats the root as its own parent for a top-level comment', () => {
    const root = ev({ id: ID_ROOT, pubkey: PK_ROOT, kind: 1 });
    expect(buildCommentTags(root, undefined, hintFor)).toEqual([
      ['E', ID_ROOT, 'wss://root.example', PK_ROOT],
      ['K', '1'],
      ['P', PK_ROOT, 'wss://root.example'],
      ['e', ID_ROOT, 'wss://root.example', PK_ROOT],
      ['k', '1'],
      ['p', PK_ROOT, 'wss://root.example'],
    ]);
  });

  it('scopes a nested comment to the root but points the parent at the reply', () => {
    const root = ev({ id: ID_ROOT, pubkey: PK_ROOT, kind: 1 });
    const reply = ev({ id: ID_REPLY, pubkey: PK_REPLY, kind: 1111 });
    expect(buildCommentTags(root, reply, hintFor)).toEqual([
      ['E', ID_ROOT, 'wss://root.example', PK_ROOT],
      ['K', '1'],
      ['P', PK_ROOT, 'wss://root.example'],
      ['e', ID_REPLY, 'wss://reply.example', PK_REPLY],
      ['k', '1111'],
      ['p', PK_REPLY, 'wss://reply.example'],
    ]);
  });

  it('uses an A-tag with the d identifier for addressable roots', () => {
    const root = ev({ id: ID_ROOT, pubkey: PK_ROOT, kind: 30023, tags: [['d', 'my-article']] });
    const tags = buildCommentTags(root, undefined, hintFor);
    expect(tags[0]).toEqual(['A', `30023:${PK_ROOT}:my-article`, 'wss://root.example']);
    expect(tags[3]).toEqual(['a', `30023:${PK_ROOT}:my-article`, 'wss://root.example']);
  });

  it('uses a d-less A-tag for plain replaceable roots', () => {
    const root = ev({ id: ID_ROOT, pubkey: PK_ROOT, kind: 10002 });
    expect(buildCommentTags(root, undefined, hintFor)[0]).toEqual([
      'A', `10002:${PK_ROOT}:`, 'wss://root.example',
    ]);
  });

  it('keys an external URL root by scheme, per NIP-73', () => {
    const root = new URL('https://example.com/post');
    expect(buildCommentTags(root)).toEqual([
      ['I', 'https://example.com/post'],
      ['K', 'https'],
      ['i', 'https://example.com/post'],
      ['k', 'https'],
    ]);
  });

  it('omits unknown or malformed hints rather than emitting empty ones', () => {
    const root = ev({ id: ID_ROOT, pubkey: PK_ROOT, kind: 1 });
    // No resolver at all, and a resolver returning junk, must behave the same.
    for (const resolver of [undefined, () => 'http://not-a-relay']) {
      const tags = buildCommentTags(root, undefined, resolver);
      expect(tags).toEqual([
        ['E', ID_ROOT, '', PK_ROOT],
        ['K', '1'],
        ['P', PK_ROOT],
        ['e', ID_ROOT, '', PK_ROOT],
        ['k', '1'],
        ['p', PK_ROOT],
      ]);
    }
  });
});
