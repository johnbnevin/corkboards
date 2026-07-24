/**
 * NIP-10 reply-tag construction.
 *
 * Locks in the two things that are easy to regress: the `root` marker landing
 * on the thread's actual root, and the p-tag ancestor chain (parent →
 * grandparent → … → root author, never siblings) built by forwarding the
 * parent's own p-tags. Also covers relay-hint placement.
 */
import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { buildReplyTags } from '@core/noteClassifier';

const ID_ROOT = 'a'.repeat(64);
const ID_PARENT = 'b'.repeat(64);
const ID_GRANDPARENT = 'c'.repeat(64);

function ev(partial: Partial<NostrEvent> & Pick<NostrEvent, 'id' | 'pubkey'>): NostrEvent {
  return { created_at: 0, kind: 1, content: '', sig: '', tags: [], ...partial } as NostrEvent;
}

describe('buildReplyTags (NIP-10)', () => {
  it('marks a direct reply to a top-level note as root', () => {
    const parent = ev({ id: ID_PARENT, pubkey: 'pk_parent' });
    const tags = buildReplyTags(parent, 'wss://hint.example');

    expect(tags.filter(t => t[0] === 'e')).toEqual([
      ['e', ID_PARENT, 'wss://hint.example', 'root'],
    ]);
    // Only the parent author is a participant on a top-level reply.
    expect(tags.filter(t => t[0] === 'p')).toEqual([['p', 'pk_parent']]);
  });

  it('keeps root as root and marks the immediate parent as reply, deeper in a thread', () => {
    const parent = ev({
      id: ID_PARENT,
      pubkey: 'pk_parent',
      // Parent already carries the full ancestor chain it forwarded.
      tags: [
        ['e', ID_ROOT, 'wss://root.example', 'root'],
        ['e', ID_GRANDPARENT, '', 'reply'],
        ['p', 'pk_root'],
        ['p', 'pk_grandparent'],
      ],
    });
    const tags = buildReplyTags(parent, 'wss://parent.example');

    // root marker on the real root (hint forwarded from the parent's root tag),
    // reply marker on the immediate parent (with the caller-supplied hint).
    expect(tags.filter(t => t[0] === 'e')).toEqual([
      ['e', ID_ROOT, 'wss://root.example', 'root'],
      ['e', ID_PARENT, 'wss://parent.example', 'reply'],
    ]);
    // Ancestor chain: parent author first, then its forwarded participants — deduped, in order.
    expect(tags.filter(t => t[0] === 'p')).toEqual([
      ['p', 'pk_parent'],
      ['p', 'pk_root'],
      ['p', 'pk_grandparent'],
    ]);
  });

  it('does not duplicate the parent author already present in forwarded p-tags', () => {
    const parent = ev({
      id: ID_PARENT,
      pubkey: 'pk_parent',
      tags: [
        ['e', ID_ROOT, '', 'root'],
        ['p', 'pk_root'],
        ['p', 'pk_parent'], // self-reference already forwarded
      ],
    });
    const pTags = buildReplyTags(parent).filter(t => t[0] === 'p');
    expect(pTags).toEqual([['p', 'pk_parent'], ['p', 'pk_root']]);
  });

  it('ignores an invalid inherited root id and roots at the parent instead', () => {
    const parent = ev({
      id: ID_PARENT,
      pubkey: 'pk_parent',
      tags: [['e', 'not-a-valid-id', '', 'root']],
    });
    const eTags = buildReplyTags(parent).filter(t => t[0] === 'e');
    expect(eTags).toEqual([['e', ID_PARENT, '', 'root']]);
  });
});
