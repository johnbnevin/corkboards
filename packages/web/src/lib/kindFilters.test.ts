/**
 * Note-kind filter evaluation.
 *
 * The reported bug: "Replies and reactions filters work, but not the others."
 * Cause — in loose mode every kind-1 note also carries the generic `shortNotes`
 * or `replies` category, so hiding `images` left that generic category un-hidden
 * and the note stayed on screen. Only reactions and replies, the two kinds with
 * no second category, ever disappeared.
 */
import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import {
  getNoteCategories,
  noteMatchesKindFilters,
  noteDisplayText,
} from '@core/noteCategories';

const CATEGORY_TO_FILTER: Record<string, string> = {
  shortNotes: 'posts', replies: 'replies', longForm: 'articles',
  videos: 'videos', images: 'images', reposts: 'reposts', reactions: 'reactions',
  highlights: 'highlights', recipes: 'recipes', other: 'posts',
};

const keep = (cats: string[], hidden: string[], mode: 'any' | 'strict' = 'any') =>
  noteMatchesKindFilters(new Set(cats), new Set(hidden), CATEGORY_TO_FILTER, mode);

describe('noteMatchesKindFilters — loose mode', () => {
  it('hides an image post when images are hidden, despite it also being a short note', () => {
    expect(keep(['images', 'shortNotes'], ['images'])).toBe(false);
  });

  it('hides a video reply when videos are hidden', () => {
    expect(keep(['videos', 'replies'], ['videos'])).toBe(false);
  });

  it('still hides plain replies and reactions — the cases that already worked', () => {
    expect(keep(['replies'], ['replies'])).toBe(false);
    expect(keep(['reactions'], ['reactions'])).toBe(false);
  });

  it('hides a plain short note when posts are hidden', () => {
    expect(keep(['shortNotes'], ['posts'])).toBe(false);
    expect(keep(['other'], ['posts'])).toBe(false);
  });

  it('keeps a reaction to a video when only reactions are hidden — the point of loose mode', () => {
    expect(keep(['reactions', 'videos'], ['reactions'])).toBe(true);
  });

  it('keeps an image post when only posts are hidden — it is an image post, not a plain one', () => {
    expect(keep(['images', 'shortNotes'], ['posts'])).toBe(true);
  });

  it('hides a note only when every specific category it has is hidden', () => {
    expect(keep(['images', 'videos'], ['images'])).toBe(true);
    expect(keep(['images', 'videos'], ['images', 'videos'])).toBe(false);
  });

  it('keeps everything when nothing is hidden', () => {
    expect(keep(['images', 'shortNotes'], [])).toBe(true);
  });
});

describe('noteMatchesKindFilters — strict mode', () => {
  it('hides a note if any of its categories is hidden', () => {
    expect(keep(['reactions', 'videos'], ['videos'], 'strict')).toBe(false);
    expect(keep(['images', 'shortNotes'], ['posts'], 'strict')).toBe(false);
  });

  it('keeps a note when none of its categories is hidden', () => {
    expect(keep(['images', 'shortNotes'], ['videos'], 'strict')).toBe(true);
  });
});

// ─── End-to-end against the real classifier ──────────────────────────────────

function ev(partial: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'f'.repeat(64), pubkey: '1'.repeat(64), created_at: 0,
    kind: 1, content: '', sig: '', tags: [], ...partial,
  } as NostrEvent;
}

describe('hiding images actually removes image posts from a feed', () => {
  it('drops a kind-1 note whose body is an image URL', () => {
    const note = ev({ content: 'look at this https://i.nostr.build/abc.jpg' });
    expect(getNoteCategories(note).has('images')).toBe(true);
    expect(keep([...getNoteCategories(note)], ['images'])).toBe(false);
  });

  it('drops a kind-1 note carrying an image in an imeta tag', () => {
    const note = ev({ content: 'caption', tags: [['imeta', 'url https://x.example/a.png', 'm image/png']] });
    expect(keep([...getNoteCategories(note)], ['images'])).toBe(false);
  });

  it('leaves a plain text note alone when only images are hidden', () => {
    const note = ev({ content: 'just words' });
    expect(keep([...getNoteCategories(note)], ['images'])).toBe(true);
  });
});

// ─── Text filter ─────────────────────────────────────────────────────────────

describe('noteDisplayText', () => {
  it('returns the content of an ordinary note', () => {
    expect(noteDisplayText(ev({ content: 'hello world' }))).toBe('hello world');
  });

  it('reads a repost through to the embedded note, not its JSON wrapper', () => {
    const embedded = ev({ content: 'the original text' });
    const repost = ev({ kind: 6, content: JSON.stringify(embedded) });
    expect(noteDisplayText(repost)).toBe('the original text');
    // The JSON field names must not leak into the searchable text.
    expect(noteDisplayText(repost)).not.toContain('pubkey');
  });

  it('returns empty for a repost with an unparseable body', () => {
    expect(noteDisplayText(ev({ kind: 6, content: 'not json' }))).toBe('');
  });

  it('falls back to the resolver for a repost that embeds nothing', () => {
    const original = ev({ id: 'a'.repeat(64), content: 'the original text' });
    const repost = ev({ kind: 6, content: '', tags: [['e', original.id]] });
    expect(noteDisplayText(repost, id => (id === original.id ? original : undefined)))
      .toBe('the original text');
    // No resolver, nothing embedded — the repost displays nothing of its own.
    expect(noteDisplayText(repost)).toBe('');
  });

  it('prefers the embedded note over the resolver', () => {
    const embedded = ev({ id: 'a'.repeat(64), content: 'embedded text' });
    const repost = ev({ kind: 6, content: JSON.stringify(embedded), tags: [['e', embedded.id]] });
    expect(noteDisplayText(repost, () => ev({ content: 'stale copy' }))).toBe('embedded text');
  });

  it('carries the article title through a repost', () => {
    const article = ev({
      id: 'a'.repeat(64), kind: 30023, content: 'body text',
      tags: [['title', 'My Headline']],
    });
    const repost = ev({ kind: 6, content: '', tags: [['e', article.id]] });
    expect(noteDisplayText(repost, () => article)).toContain('My Headline');
  });

  it('includes an article title and summary alongside the body', () => {
    const article = ev({
      kind: 30023,
      content: 'body text',
      tags: [['title', 'My Headline'], ['summary', 'A blurb']],
    });
    const text = noteDisplayText(article);
    expect(text).toContain('My Headline');
    expect(text).toContain('A blurb');
    expect(text).toContain('body text');
  });
});
