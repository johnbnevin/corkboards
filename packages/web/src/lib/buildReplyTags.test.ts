/**
 * NIP-10 reply-tag construction.
 *
 * Locks in the things that are easy to regress: the `root` marker landing on
 * the thread's actual root, the p-tag ancestor chain (parent → grandparent → …
 * → root author, never siblings) built by forwarding the parent's own p-tags,
 * relay-hint placement on both e- and p-tags, and the author pubkey in NIP-10's
 * optional 5th e-tag element.
 */
import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { buildReplyTags } from '@core/noteClassifier';

const ID_ROOT = 'a'.repeat(64);
const ID_PARENT = 'b'.repeat(64);
const ID_GRANDPARENT = 'c'.repeat(64);

// Pubkeys must be real 64-char hex — buildReplyTags drops anything else rather
// than publishing a malformed p-tag.
const PK_PARENT = '1'.repeat(64);
const PK_ROOT = '2'.repeat(64);
const PK_GRANDPARENT = '3'.repeat(64);

function ev(partial: Partial<NostrEvent> & Pick<NostrEvent, 'id' | 'pubkey'>): NostrEvent {
  return { created_at: 0, kind: 1, content: '', sig: '', tags: [], ...partial } as NostrEvent;
}

describe('buildReplyTags (NIP-10)', () => {
  it('marks a direct reply to a top-level note as root', () => {
    const parent = ev({ id: ID_PARENT, pubkey: PK_PARENT });
    const tags = buildReplyTags(parent, 'wss://hint.example');

    expect(tags.filter(t => t[0] === 'e')).toEqual([
      ['e', ID_PARENT, 'wss://hint.example', 'root', PK_PARENT],
    ]);
    // Only the parent author is a participant on a top-level reply, and they
    // carry the hint we just resolved for them.
    expect(tags.filter(t => t[0] === 'p')).toEqual([['p', PK_PARENT, 'wss://hint.example']]);
  });

  it('keeps root as root and marks the immediate parent as reply, deeper in a thread', () => {
    const parent = ev({
      id: ID_PARENT,
      pubkey: PK_PARENT,
      // Parent already carries the full ancestor chain it forwarded.
      tags: [
        ['e', ID_ROOT, 'wss://root.example', 'root', PK_ROOT],
        ['e', ID_GRANDPARENT, '', 'reply'],
        ['p', PK_ROOT],
        ['p', PK_GRANDPARENT, 'wss://gp.example'],
      ],
    });
    const tags = buildReplyTags(parent, 'wss://parent.example');

    // root marker on the real root (hint + author forwarded from the parent's
    // root tag), reply marker on the immediate parent.
    expect(tags.filter(t => t[0] === 'e')).toEqual([
      ['e', ID_ROOT, 'wss://root.example', 'root', PK_ROOT],
      ['e', ID_PARENT, 'wss://parent.example', 'reply', PK_PARENT],
    ]);
    // Ancestor chain: parent author first, then its forwarded participants —
    // deduped, in order, each keeping whatever hint we know for them.
    expect(tags.filter(t => t[0] === 'p')).toEqual([
      ['p', PK_PARENT, 'wss://parent.example'],
      ['p', PK_ROOT],
      ['p', PK_GRANDPARENT, 'wss://gp.example'],
    ]);
  });

  it('does not duplicate the parent author already present in forwarded p-tags', () => {
    const parent = ev({
      id: ID_PARENT,
      pubkey: PK_PARENT,
      tags: [
        ['e', ID_ROOT, '', 'root'],
        ['p', PK_ROOT],
        ['p', PK_PARENT], // self-reference already forwarded
      ],
    });
    const pTags = buildReplyTags(parent).filter(t => t[0] === 'p');
    expect(pTags).toEqual([['p', PK_PARENT], ['p', PK_ROOT]]);
  });

  it('ignores an invalid inherited root id and roots at the parent instead', () => {
    const parent = ev({
      id: ID_PARENT,
      pubkey: PK_PARENT,
      tags: [['e', 'not-a-valid-id', '', 'root']],
    });
    const eTags = buildReplyTags(parent).filter(t => t[0] === 'e');
    expect(eTags).toEqual([['e', ID_PARENT, '', 'root', PK_PARENT]]);
  });

  it('drops malformed relay hints and pubkeys instead of forwarding them', () => {
    const parent = ev({
      id: ID_PARENT,
      pubkey: PK_PARENT,
      tags: [
        ['e', ID_ROOT, 'not-a-relay', 'root', 'not-a-pubkey'],
        ['p', 'nope'],
        ['p', PK_ROOT, 'http://relay.example'], // wrong scheme for a relay
      ],
    });
    const tags = buildReplyTags(parent, 'ftp://bad');
    expect(tags.filter(t => t[0] === 'e')).toEqual([
      ['e', ID_ROOT, '', 'root'],
      ['e', ID_PARENT, '', 'reply', PK_PARENT],
    ]);
    expect(tags.filter(t => t[0] === 'p')).toEqual([['p', PK_PARENT], ['p', PK_ROOT]]);
  });
});
