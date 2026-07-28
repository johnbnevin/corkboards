/**
 * noteCategories — Pure note-category classification and hashtag extraction.
 *
 * Shared between web and mobile. No DOM, React, or relay dependencies.
 * This is the canonical classifier used for feed filter chips and the
 * per-corkboard note-kind statistics.
 */

import { type NostrEvent } from '@nostrify/nostrify'
import { getReactionTargetId } from './threadTree'
import { HASHTAG_RE } from './hashtagTags'

// Video URL patterns for content-based video detection
const VIDEO_URL_PATTERNS = [
  /youtube\.com\/watch/i,
  /youtu\.be\//i,
  /youtube\.com\/shorts\//i,
  /youtube\.com\/embed\//i,
  /youtube\.com\/live\//i,
  /rumble\.com\/v[\w-]/i,
  /rumble\.com\/embed\//i,
  /tiktok\.com\/.+\/video\//i,
  /vimeo\.com\/\d/i,
  /dailymotion\.com\/video\//i,
  /twitch\.tv\/videos\//i,
  /twitch\.tv\/\w+\/clip\//i,
  /clips\.twitch\.tv\//i,
  /odysee\.com\/@/i,
  /bitchute\.com\/video\//i,
  /video\.nostr\.build\//i,
  /\.mp4\b/i,     // .mp4 anywhere (before query, path segment, etc.)
  /\.mp3\b/i,     // audio (treat as media)
  /\.webm\b/i,
  /\.mov\b/i,
  /\.m4v\b/i,
  /\.m3u8\b/i,
];

// Definitive image file extensions
const IMAGE_EXT_PATTERN = /\.(jpg|jpeg|png|webp|svg|bmp|ico|gif)\b/i;

// CDN domains that host images — only match when URL has an image extension
// or when no video extension is present (ambiguous CDN URLs)
const IMAGE_CDN_PATTERNS = [
  /nostr\.build\/i\//i,
  /image\.nostr\.build\//i,
  /i\.nostr\.build\//i,
  /imgprxy\.stacker\.news\//i,
];

// Video file extension pattern — used to exclude video URLs from image CDN matching
const VIDEO_EXT_EXCLUDE = /\.(mp4|webm|mov|m4v|m3u8|mp3|ogg)\b/i;

// Generic media CDNs — match only if the URL has an image extension (not ambiguous)
const AMBIGUOUS_CDN_PATTERNS = [
  /blossom\.band\//i,
  /blossom\.yakihonne\.com\//i,
  /blossom\.f7z\.io\//i,
  /blossom\.ditto\.pub\//i,
  /blossom\.primal\.net\//i,
  /files\.primal\.net\//i,
  /cdn\.satellite\.earth\//i,
  /cdn\.sovbit\.host\//i,
  /void\.cat\//i,
  /media\.nostr\.band\//i,
];

/**
 * Shape-validate the JSON embedded in a kind-6/16 repost's `content`.
 *
 * NIP-18 says this is "the stringified JSON of the reposted note" — i.e. fully
 * attacker-controlled data that happens to arrive inside a signed envelope.
 * Parsing it with a bare `JSON.parse(...) as NostrEvent` is a lie to the type
 * system: `{"a":1}` parses fine and produces an object with no `tags`, and the
 * first `note.tags.some(...)` downstream throws a TypeError inside a render-path
 * `.filter()` callback with no error boundary between it and the feed — one
 * malformed repost blanks the whole column.
 *
 * Returns null unless every field a NostrEvent consumer may touch is present
 * and the right type. Signature verification is deliberately NOT done here
 * (core carries no crypto dependency); callers that RENDER the result as an
 * authored note must verify it — see the platform `verifyEmbeddedEvent`.
 */
export function parseEmbeddedRepost(content: string | undefined | null): NostrEvent | null {
  if (!content || content[0] !== '{') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const e = parsed as Partial<NostrEvent>;
  if (typeof e.id !== 'string' || typeof e.pubkey !== 'string' || typeof e.sig !== 'string') return null;
  if (typeof e.content !== 'string' || typeof e.kind !== 'number' || typeof e.created_at !== 'number') return null;
  if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t))) return null;
  return e as NostrEvent;
}

// Check if a note contains video content (by kind or URL).
// `tags` is defensively defaulted: these predicates are reachable from callers
// that hand them an event reconstructed from untrusted JSON.
export function hasVideoContent(note: NostrEvent): boolean {
  if (note.kind === 34235 || note.kind === 34236) return true;
  const content = note.content || '';
  // Also check imeta tags for video
  if ((note.tags ?? []).some(t => Array.isArray(t) && t[0] === 'imeta' && t.some(v => /video/i.test(v)))) return true;
  return VIDEO_URL_PATTERNS.some(pattern => pattern.test(content));
}

// Check if a note contains image content (by URL patterns in content or imeta tags).
// Checks each URL individually to avoid false negatives when a note contains both
// an image from an ambiguous CDN and a video URL from elsewhere.
export function hasImageContent(note: NostrEvent): boolean {
  const content = note.content || '';
  // Check imeta tags for images
  if ((note.tags ?? []).some(t => Array.isArray(t) && t[0] === 'imeta' && t.some(v => /image/i.test(v)))) return true;
  // Definitive image extension anywhere in content
  if (IMAGE_EXT_PATTERN.test(content)) return true;
  // Image-specific CDN paths (always images)
  if (IMAGE_CDN_PATTERNS.some(p => p.test(content))) return true;
  // Ambiguous CDNs: check each URL individually — only exclude if THAT URL has a video extension
  const urls = content.match(/https?:\/\/\S+/g);
  if (urls) {
    for (const url of urls) {
      if (AMBIGUOUS_CDN_PATTERNS.some(p => p.test(url)) && !VIDEO_EXT_EXCLUDE.test(url)) return true;
    }
  }
  return false;
}

/**
 * Per-event category cache.
 *
 * `getNoteCategories` is the hot path of the whole feed: it runs for every note
 * on every filter recompute, once more for the kind-count stats, and again for
 * the filter chips — and for a repost it JSON-parses the embedded event each
 * time. On a few thousand notes that is the difference between a feed that
 * responds to a click and one that stalls.
 *
 * A WeakMap keyed on the event object is safe because events are immutable and
 * are dropped from the map as soon as the feed releases them. The one input
 * that ISN'T the event is `lookup`, so an entry records whether the answer
 * depended on a target we couldn't resolve; those are recomputed next time in
 * case the target has since arrived.
 */
const categoryCache = new WeakMap<NostrEvent, { cats: Set<string>; resolved: boolean }>();

// Classify a note into ALL applicable categories (a note can be in multiple).
// E.g. a reaction to a video counts as both a reaction and a video.
export function getNoteCategories(event: NostrEvent, lookup?: Map<string, NostrEvent>): Set<string> {
  const cached = categoryCache.get(event);
  if (cached && cached.resolved) return cached.cats;

  const cats = new Set<string>();
  const repostedKind = event.kind === 16 ? parseInt(event.tags.find(t => t[0] === 'k')?.[1] || '0', 10) : 0;

  // For reactions/reposts, check the TARGET note's content too.
  // Reactions (kind 7) use NIP-25 marked/last-positional e-tag semantics via
  // the shared getReactionTargetId helper (same logic as thread-tree reactions).
  const targetId = event.kind === 7
    ? getReactionTargetId(event)
    : (event.kind === 9735 || event.kind === 6 || event.kind === 16)
      ? event.tags.find(t => t[0] === 'e')?.[1]
      : null;
  let targetEvent = targetId && lookup ? lookup.get(targetId) : null;
  // For kind 6 reposts, the embedded JSON in content IS the target
  if (!targetEvent && (event.kind === 6 || event.kind === 16)) {
    targetEvent = parseEmbeddedRepost(event.content);
  }

  // Video: kind 21/22 (NIP-71), 34235/34236, video URLs, repost of video, or reaction to video
  if (event.kind === 21 || event.kind === 22 || hasVideoContent(event) || repostedKind === 34235 || repostedKind === 34236 || repostedKind === 21 || repostedKind === 22 || (targetEvent && hasVideoContent(targetEvent))) {
    cats.add('videos');
  }

  // Image: kind 20 (NIP-68 picture), image URLs in content, or reaction/repost targeting an image
  if (event.kind === 20 || hasImageContent(event) || (targetEvent && hasImageContent(targetEvent))) {
    cats.add('images');
  }

  // Recipe: kind 30023 with recipe tag
  if (event.kind === 30023 && event.tags.some(t =>
    (t[0] === 'r' && t[1]?.includes('zap.cooking')) || (t[0] === 't' && t[1] === 'recipe')
  )) {
    cats.add('recipes');
  }

  // Repost (kind 6 or 16)
  if (event.kind === 6 || event.kind === 16) cats.add('reposts');

  // Reaction (kind 7) or zap receipt (kind 9735)
  if (event.kind === 7 || event.kind === 9735) cats.add('reactions');

  // Highlight
  if (event.kind === 9802) cats.add('highlights');

  // Article (kind 30023, not already a recipe)
  if (event.kind === 30023 && !cats.has('recipes')) cats.add('longForm');

  // Short note or reply (kind 1)
  if (event.kind === 1) {
    const hasETags = event.tags.some(t => t[0] === 'e');
    cats.add(hasETags ? 'replies' : 'shortNotes');
  }

  // NIP-22 comment (kind 1111) is always a reply to something
  if (event.kind === 1111) cats.add('replies');

  // NIP-94 file metadata (kind 1063) — image or video by mime type.
  // The mime prefix must be checked in BOTH directions: "not video/" is not the
  // same as "image/", and treating it that way filed every audio file, PDF and
  // zip under `images`, where the card then tries to render it as one.
  if (event.kind === 1063) {
    const mime = event.tags.find(t => t[0] === 'm')?.[1] ?? '';
    if (mime.startsWith('video/')) cats.add('videos');
    else if (mime.startsWith('image/')) cats.add('images');
    // Anything else (audio/*, application/*, a missing `m` tag) falls through to
    // the `other` bucket below.
  }

  // NIP-88 poll (kind 1068) — grouped with short notes
  if (event.kind === 1068) cats.add('shortNotes');

  if (cats.size === 0) cats.add('other');
  // "Resolved" means nothing about this answer is still waiting on data: either
  // the note referenced no other event, or we found the one it referenced.
  categoryCache.set(event, { cats, resolved: !targetId || !!targetEvent });
  return cats;
}

// ─── Text-filter helpers ─────────────────────────────────────────────────────

/**
 * Resolve an event id to the event, for callers that can see more events than
 * the one being tested — the feed's own note map, a fetch cache, etc.
 */
export type EventResolver = (id: string) => NostrEvent | null | undefined;

const REPOST_KINDS = new Set([6, 16]);
/** Nested reposts (16 → 6 → 1) happen; a chain longer than this is pathological. */
const MAX_REPOST_UNWRAP = 3;

/**
 * The text a note actually shows the reader, for text-matching filters.
 *
 * A repost's own `content` is a JSON blob, and long-form posts carry a title in
 * their tags that reads as part of the note. Matching against the raw `content`
 * field alone meant the "hide notes containing this text" filter silently did
 * nothing for either — and, because reposts are JSON, it could match on
 * incidental substrings like `"kind"` or a pubkey.
 *
 * A repost displays the note it carries, so that's what the text filter has to
 * see. NIP-18 only says the reposted event SHOULD be embedded in `content`, and
 * plenty of clients publish a bare envelope with just an `e` tag — for those the
 * embedded JSON is absent and the reposted text can only come from `resolve`.
 * Without it those reposts were invisible to the filter: the phrase was plainly
 * on screen and the note stayed. Unwrapping is recursive, so a repost of an
 * article matches on its title and a repost-of-a-repost matches on the innermost
 * note.
 *
 * @param resolve - Optional id → event lookup. When a repost can't be resolved
 *   through it (target not fetched yet), the repost displays nothing of its own
 *   and is left alone rather than hidden on a guess.
 */
export function noteDisplayText(note: NostrEvent, resolve?: EventResolver): string {
  let current = note;
  // Depth-capped rather than cycle-tracked: a repost that points at itself just
  // runs out the counter and reports nothing, which is the same answer.
  for (let depth = 0; depth < MAX_REPOST_UNWRAP && REPOST_KINDS.has(current.kind); depth++) {
    // Embedded JSON first: it needs no lookup and is what the card renders.
    const targetId = (current.tags ?? []).find(t => t[0] === 'e')?.[1];
    const target = parseEmbeddedRepost(current.content)
      ?? (targetId && resolve ? resolve(targetId) : null);
    if (!target) return '';
    current = target;
  }
  // Still a repost after the unwrap limit — nothing displayable was reached.
  if (REPOST_KINDS.has(current.kind)) return '';
  const tags = current.tags ?? [];
  const title = tags.find(t => t[0] === 'title')?.[1];
  const summary = tags.find(t => t[0] === 'summary')?.[1];
  return [title, summary, current.content].filter(Boolean).join('\n');
}

/**
 * Unwrap a repost's embedded JSON to the innermost authored event, verifying
 * each envelope's signature along the way.
 *
 * NIP-18 puts "the stringified JSON of the reposted note" in a kind-6/16
 * `content`, and some clients embed a quoted note as JSON the same way. That
 * payload is fully attacker-controlled: nothing stops a hostile relay handing
 * you a signed kind-6 whose embedded JSON claims `pubkey` = someone famous.
 * `parseEmbeddedRepost` only shape-checks it, so a caller that renders the
 * result as an authored note (avatar, display name, profile link) is trusting
 * an unsigned blob — an impersonation primitive.
 *
 * This is the gate every render path must go through. Core carries no crypto
 * dependency by design, so the signature check is injected: web and mobile pass
 * nostr-tools' `verifyEvent` (id-recompute + Schnorr). Any level that is
 * malformed OR fails verification collapses the whole thing to null, and the
 * caller falls back to fetching the real event by id through the verified
 * transport. `verify` is wrapped so a throwing verifier is treated as "invalid"
 * rather than crashing the feed render.
 */
export function unwrapVerifiedRepost(
  content: string | undefined | null,
  verify: (event: NostrEvent) => boolean,
  maxDepth: number = MAX_REPOST_UNWRAP,
): NostrEvent | null {
  let current = content;
  for (let depth = 0; depth < maxDepth; depth++) {
    const parsed = parseEmbeddedRepost(current);
    if (!parsed) return null;
    let ok = false;
    try {
      ok = verify(parsed);
    } catch {
      ok = false;
    }
    if (!ok) return null;
    if (parsed.kind === 6 || parsed.kind === 16) {
      current = parsed.content;
      continue;
    }
    return parsed;
  }
  return null;
}

// ─── Kind-filter evaluation ──────────────────────────────────────────────────

/**
 * Categories that describe the *envelope* rather than the content: every kind-1
 * note is one of `shortNotes`/`replies`, and `other` is the fallback bucket.
 *
 * They matter for the loose-mode rule below. Because they're near-universal
 * they were rescuing almost everything: an image post is categorized as BOTH
 * `images` and `shortNotes`, so hiding "images" left `shortNotes` un-hidden and
 * the note stayed on screen. Only reactions and replies — the two kinds that
 * carry *no* other category — ever actually disappeared, which is precisely the
 * "only replies and reactions work" behaviour that was reported.
 */
const GENERIC_CATEGORIES = new Set(['shortNotes', 'replies', 'other']);

export type KindFilterMode = 'any' | 'strict';

/**
 * Decide whether a note survives the note-kind toggles.
 *
 * @param cats - The note's categories, from {@link getNoteCategories}.
 * @param hidden - Filter names the user has toggled OFF (i.e. wants hidden).
 * @param categoryToFilter - Maps a category name to the filter name that governs it.
 * @param mode - `'strict'` hides a note if ANY of its categories is hidden.
 *   `'any'` (loose, the default) keeps a note when something specific about it
 *   is still wanted — e.g. a reaction to a video stays when reactions are hidden
 *   but videos aren't. Generic categories can't provide that rescue; they only
 *   speak for a note that has nothing more specific to say about itself.
 * @returns true to keep the note.
 */
export function noteMatchesKindFilters(
  cats: Set<string>,
  hidden: ReadonlySet<string>,
  categoryToFilter: Readonly<Record<string, string>>,
  mode: KindFilterMode,
): boolean {
  if (hidden.size === 0) return true;

  if (mode === 'strict') {
    for (const cat of cats) {
      const filter = categoryToFilter[cat];
      if (filter && hidden.has(filter)) return false;
    }
    return true;
  }

  let hasSpecific = false;
  let specificWanted = false;
  let genericWanted = false;
  for (const cat of cats) {
    const filter = categoryToFilter[cat];
    const wanted = !filter || !hidden.has(filter);
    if (GENERIC_CATEGORIES.has(cat)) {
      if (wanted) genericWanted = true;
    } else {
      hasSpecific = true;
      if (wanted) specificWanted = true;
    }
  }
  // A note that is only "a post" or "a reply" is judged on that; anything with a
  // real content category is judged on those categories alone.
  return hasSpecific ? specificWanted : genericWanted;
}

// ─── Hashtag extraction helpers ──────────────────────────────────────────────
// Used by both hashtag filtering and hashtag count computation.

/**
 * Per-event hashtag caches. Both extractors scan the note's tags and run a
 * regex over its full content; between hashtag filtering, the chip counts and
 * the spam verdict they run several times per note per feed recompute, and
 * neither depends on anything but the (immutable) event.
 */
const hashtagCache = new WeakMap<NostrEvent, Set<string>>();
const repostHashtagCache = new WeakMap<NostrEvent, Set<string>>();

// Inline `#hashtag` matching lives in ./hashtagTags so the composers write
// exactly what these readers parse — the two used to keep private copies with a
// "keep in sync" comment, which is how they got out of sync.

/** Extract hashtags from a note's tags and content. */
export function getNoteHashtags(note: NostrEvent): Set<string> {
  const cached = hashtagCache.get(note);
  if (cached) return cached;

  const tags = new Set<string>();
  for (const t of note.tags) {
    if (t[0] === 't' && t[1]) tags.add(t[1].toLowerCase());
  }
  for (const match of note.content.matchAll(HASHTAG_RE)) {
    tags.add(match[1].toLowerCase());
  }
  hashtagCache.set(note, tags);
  return tags;
}

/** Extract hashtags from a repost's embedded JSON content. */
export function getRepostHashtags(note: NostrEvent): Set<string> {
  if ((note.kind !== 6 && note.kind !== 16) || !note.content) return new Set();
  const cached = repostHashtagCache.get(note);
  if (cached) return cached;
  try {
    const embedded = JSON.parse(note.content);
    const tags = new Set<string>();
    if (Array.isArray(embedded.tags)) {
      for (const t of embedded.tags) {
        if (Array.isArray(t) && t[0] === 't' && typeof t[1] === 'string') {
          tags.add(t[1].toLowerCase());
        }
      }
    }
    if (typeof embedded.content === 'string') {
      for (const match of embedded.content.matchAll(HASHTAG_RE)) {
        tags.add(match[1].toLowerCase());
      }
    }
    repostHashtagCache.set(note, tags);
    return tags;
  } catch {
    // Cache the empty answer too — an unparseable body won't become parseable,
    // and without this every pass re-attempts the JSON.parse.
    const empty = new Set<string>();
    repostHashtagCache.set(note, empty);
    return empty;
  }
}

/** Check if a note matches any of the selected hashtag filters. */
export function noteMatchesHashtags(note: NostrEvent, selectedHashtags: Set<string>): boolean {
  const hashtags = (note.kind === 6 || note.kind === 16)
    ? getRepostHashtags(note)
    : getNoteHashtags(note);
  for (const tag of hashtags) {
    if (selectedHashtags.has(tag)) return true;
  }
  return false;
}

// ─── Hashtag-feed spam classification ────────────────────────────────────────

/**
 * How many `t` (topic) tags a note may carry and still be trusted in a
 * single-hashtag feed when it does NOT mention that hashtag inline. Above this,
 * an unmentioned match reads as tag-stuffing spam — one note tagged with several
 * unrelated topics to inject itself into every topic feed.
 *
 * Per NIP-24 the `t` tag is the canonical hashtag mechanism, so a genuinely
 * on-topic note may legitimately tag a single topic without writing it in the
 * body. We trust only that single-tag case; any note carrying more than one
 * topic tag while not mentioning this one is treated as stuffed.
 */
export const MAX_TTAGS_WITHOUT_CONTENT_MATCH = 1;

export type HashtagFeedVerdict = 'match' | 'tagged-only' | 'spam' | 'unrelated';

/**
 * Classify a note against a single hashtag. `hashtag` may include a leading '#'
 * and any case; it is normalized here.
 * - `'match'`       — the note's content actually mentions the `#hashtag` inline.
 * - `'tagged-only'` — carries this hashtag as a `t` tag but doesn't mention it
 *                     inline, and isn't tag-stuffed (≤ {@link MAX_TTAGS_WITHOUT_CONTENT_MATCH}
 *                     topic tags). Show it, but callers may flag it as
 *                     "tagged, not mentioned".
 * - `'spam'`        — carries this hashtag as a `t` tag, doesn't mention it, AND
 *                     is stuffed with many `t` tags. Hide.
 * - `'unrelated'`   — neither mentions the hashtag nor carries its `t` tag (e.g.
 *                     an author note that landed in a mixed corkboard for other
 *                     reasons). Not a hashtag match at all.
 */
export function hashtagFeedVerdict(note: NostrEvent, hashtag: string): HashtagFeedVerdict {
  const norm = hashtag.replace(/^#/, '').toLowerCase();
  const isRepost = note.kind === 6 || note.kind === 16;

  // Content mention wins — clearly on-topic. Scan embedded content for reposts.
  let content = note.content;
  if (isRepost) {
    try {
      const embedded = JSON.parse(note.content);
      if (typeof embedded?.content === 'string') content = embedded.content;
    } catch { /* fall back to raw content */ }
  }
  for (const match of content.matchAll(HASHTAG_RE)) {
    if (match[1].toLowerCase() === norm) return 'match';
  }

  // Count topic tags and check whether THIS hashtag is among them.
  let tTagCount = 0;
  let hasThisTag = false;
  for (const t of note.tags) {
    if (t[0] === 't' && t[1]) {
      tTagCount++;
      if (t[1].toLowerCase() === norm) hasThisTag = true;
    }
  }
  // Reposts carry topic tags on the embedded event, not the wrapper.
  if (isRepost && !hasThisTag) {
    const embeddedTags = getRepostHashtags(note);
    if (embeddedTags.has(norm)) {
      hasThisTag = true;
      tTagCount = Math.max(tTagCount, embeddedTags.size);
    }
  }

  if (!hasThisTag) return 'unrelated';
  return tTagCount > MAX_TTAGS_WITHOUT_CONTENT_MATCH ? 'spam' : 'tagged-only';
}

/** Compute hashtag counts from a set of notes. */
export function computeHashtagCounts(notes: NostrEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const tags = (note.kind === 6 || note.kind === 16)
      ? getRepostHashtags(note)
      : getNoteHashtags(note);
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return counts;
}

/** Per-category note counts for a set of events. */
export interface NoteKindStats {
  total: number; shortNotes: number; replies: number; longForm: number;
  reposts: number; reactions: number; videos: number; images: number;
  highlights: number; recipes: number; other: number;
}

// Compute note kind statistics — notes count in ALL applicable categories.
export function computeNoteKindStats(events: NostrEvent[] | undefined, lookup?: Map<string, NostrEvent>): NoteKindStats | undefined {
  if (!events || events.length === 0) return undefined;

  const stats: NoteKindStats = {
    total: events.length, shortNotes: 0, replies: 0, longForm: 0,
    reposts: 0, reactions: 0, videos: 0, images: 0, highlights: 0, recipes: 0, other: 0
  };

  for (const event of events) {
    const cats = getNoteCategories(event, lookup);
    for (const cat of cats) {
      (stats as unknown as Record<string, number>)[cat]++;
    }
  }

  return stats;
}
