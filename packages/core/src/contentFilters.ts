/**
 * contentFilters — the "Hide notes with:" predicate.
 *
 * Shared by web and mobile so the two can't drift. Mobile shipped the filter UI
 * (`components/ContentFilters.tsx`) but nothing ever consumed its output, so the
 * controls were inert there; web had the logic inlined in the feed component,
 * where the text filter only ever compared a note's WHOLE content for equality
 * and only looked at kinds 1 and 7.
 *
 * Two different things live under one panel, and they're evaluated differently:
 *
 *   * The **text filter** matches what a note DISPLAYS, for every kind — an
 *     article or a repost carrying the phrase should be hidden too.
 *   * The **shape filters** (emoji-only, media-only, links-only, markdown, HTML,
 *     short) only describe short notes and reactions; applying them to an
 *     article or a video event would be meaningless, so those kinds skip them.
 *
 * The always-show exceptions (GM, GN, PV, …) rescue a note from the shape
 * filters but deliberately NOT from the text filter: if you asked to hide notes
 * containing a phrase, a 🌅 in them shouldn't override that.
 */

import { type NostrEvent } from '@nostrify/nostrify';
import { noteDisplayText, type EventResolver } from './noteCategories';
import { hasHtmlContent } from './sanitizeUtils';

// Emoji-presentation codepoints plus the joiners/variation selectors that glue
// them together — a note made only of these is "just emoji".
const EMOJI_ONLY = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s️‍]+$/u;
const URL_ONLY = /^\s*(https?:\/\/\S+\s*)+$/i;
const MEDIA_URL = /\.(jpg|jpeg|png|gif|webp|mp4|webm|mov|ogg|svg)\b/i;
// HTML detection is delegated to `hasHtmlContent` (sanitizeUtils), which anchors
// on a KNOWN tag name. The pattern that used to live here — `/<\/?[a-z].*?>/i` —
// matched any angle-bracketed word, so ordinary notes saying `<Bitcoin>` or
// `<insert name here>` were silently hidden by the "hide HTML" filter.
const MD_PATTERN = /(\[.+?\]\(.+?\)|^#{1,6}\s|^\*{1,3}.+?\*{1,3}$|^[-*+]\s|!\[|^>\s|```)/m;

/* eslint-disable no-misleading-character-class */
const ALLOW_PATTERNS = {
  allowPV: /^[💜🟣]+$/u,
  allowGM: /^[☀️🌅🌄🌞🔆☕]+$/u,
  allowGN: /^[🌙🌃🌌🌛🌜✨💤😴🛌]+$/u,
  allowEyes: /^[👀]+$/u,
  allow100: /^[💯🔥]+$/u,
} as const;
/* eslint-enable no-misleading-character-class */

export interface ContentFilterConfig {
  /** Hide notes whose trimmed content is this many characters or fewer. 0 = off. */
  hideMinChars: number;
  hideOnlyEmoji: boolean;
  hideOnlyMedia: boolean;
  hideOnlyLinks: boolean;
  hideMarkdown: boolean;
  /** Web-only control today; optional so mobile's config type still fits. */
  hideHtml?: boolean;
  /** Hide notes whose displayed text contains this (case-insensitive). '' = off. */
  hideExactText: string;
  allowPV: boolean;
  allowGM: boolean;
  allowGN: boolean;
  allowEyes: boolean;
  allow100: boolean;
}

export type ContentFilterKey = keyof ContentFilterConfig;

/** True when any control in the panel is doing something. */
export function hasActiveContentFilters(c: ContentFilterConfig): boolean {
  return c.hideMinChars > 0
    || c.hideOnlyEmoji
    || c.hideOnlyMedia
    || c.hideOnlyLinks
    || !!c.hideHtml
    || c.hideMarkdown
    || c.hideExactText.trim().length > 0;
}

/**
 * Decide whether a note survives the content filters.
 *
 * @param textLower - `config.hideExactText` pre-trimmed and lowercased. Passed
 *   in rather than derived because this runs once per note in the feed's hot
 *   path and the caller already has it hoisted out of the loop.
 * @param resolve - Optional id → event lookup, used to see inside a repost whose
 *   `content` doesn't embed the reposted note. Without it such reposts show a
 *   phrase the filter can't match.
 * @returns true to keep the note.
 */
export function noteMatchesContentFilters(
  note: NostrEvent,
  config: ContentFilterConfig,
  textLower: string,
  resolve?: EventResolver,
): boolean {
  // Text filter: applies to every kind, and no exception overrides it. For a
  // repost this reads the reposted note — that's the text on screen.
  if (textLower && noteDisplayText(note, resolve).toLowerCase().includes(textLower)) return false;

  // Shape filters only describe short notes and reactions.
  if (note.kind !== 1 && note.kind !== 7) return true;

  const trimmed = note.content.trim();

  // Always-show exceptions: a GM/GN/PV/👀/💯 note is kept regardless of shape.
  if (EMOJI_ONLY.test(trimmed)) {
    const stripped = trimmed.replace(/[\s️‍]/gu, '');
    for (const key of Object.keys(ALLOW_PATTERNS) as Array<keyof typeof ALLOW_PATTERNS>) {
      if (config[key] && ALLOW_PATTERNS[key].test(stripped)) return true;
    }
  }

  // A zero-length note isn't "short", it's empty — those are governed by the
  // other filters, not by the character threshold.
  if (config.hideMinChars > 0 && trimmed.length > 0 && trimmed.length <= config.hideMinChars) return false;
  if (config.hideOnlyEmoji && EMOJI_ONLY.test(trimmed)) return false;
  if (config.hideOnlyMedia && MEDIA_URL.test(trimmed) && trimmed.replace(/https?:\/\/\S+/g, '').trim().length === 0) return false;
  if (config.hideOnlyLinks && URL_ONLY.test(trimmed)) return false;
  if (config.hideHtml && hasHtmlContent(trimmed)) return false;
  if (config.hideMarkdown && MD_PATTERN.test(trimmed)) return false;
  return true;
}
