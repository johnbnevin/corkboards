/**
 * Rich note content renderer — mirrors the web version's parsing logic.
 * Handles nostr: links, hashtags, URLs, images, and video embeds.
 */
import { useMemo, useState } from 'react';
import {
  Text,
  Image,
  View,
  Linking,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import { nip19 } from 'nostr-tools';
import { stripTrackingParams, getTrackingParams } from '@core/sanitizeUtils';
import { parseListing } from '@core/nip99';
import { useHashtagAction } from '../contexts/hashtagAction';
import type { NostrEvent } from '@nostrify/nostrify';
import { useQuery } from '@tanstack/react-query';
import { hasHtmlContent } from '@core/sanitizeUtils';
import { genUserName } from '@core/genUserName';
import { useAuthor } from '../hooks/useAuthor';
import { useNostr } from '../lib/NostrProvider';
import { SizeGuardedImage } from './SizeGuardedImage';
import { optimizeMediaUrl } from '@core/imageUtils';
import { parseImetaTag, resolveMediaSources, type ImetaData } from '@core/blossom';
import { MediaLink } from './MediaLink';
import { TrackerWarningDialog } from './TrackerWarningDialog';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const MEDIA_WIDTH = SCREEN_WIDTH - 56; // card padding

// ============================================================================
// Patterns
// ============================================================================

// `nostr:` prefix is OPTIONAL (bare npub1…/note1… mentions are valid) and the
// bech32 body is matched case-insensitively. A leading boundary stops it from
// matching an identifier embedded in a URL path or word. Parity with web. (B1)
const NOSTR_URI = /(?<![\w/:])(?:nostr:)?(npub1|note1|nprofile1|nevent1|naddr1)[a-zA-Z0-9]+/gi;
const HASHTAG = /(?<!\w)#(\w{1,64})(?!\w)/g;
const URL_PATTERN = /https?:\/\/[^\s<>)\]]+/gi;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|avif)(\?[^\s]*)?$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m3u8)(\?[^\s]*)?$/i;

// Image hosting domains — URLs from these hosts render as inline images even without a file extension.
// Keep in sync with web's mediaPattern in packages/web/src/components/NoteContent.tsx.
const IMAGE_DOMAINS = /nostr\.build|blossom\.band|blossom\.yakihonne\.com|blossom\.f7z\.io|blossom\.ditto\.pub|cdn\.sovbit\.host|blossom\.primal\.net|files\.primal\.net|cdn\.satellite\.earth|void\.cat|imgprxy\.stacker\.news|image\.nostr\.build|media\.nostr\.band|zap\.cooking|wav\.school/i;

// YouTube links render as media (tap-to-load embed via MediaLink) — parity with
// web's mediaPattern including 'youtube.com'/'youtu.be'. MediaLink does the
// strict hostname + video-id validation.
const YOUTUBE_URL = /(^|\.|\/\/)(youtube\.com|youtu\.be)\//i;

// Split pattern for custom emoji shortcodes (:name:). No /g flag — split() ignores it.
const CUSTOM_EMOJI_SPLIT = /:([a-zA-Z0-9_-]+):/;

// ============================================================================
// Inline components
// ============================================================================

function ProfileMention({ pubkey }: { pubkey: string }) {
  const { data } = useAuthor(pubkey);
  const name = data?.metadata?.display_name || data?.metadata?.name || genUserName(pubkey);
  return <Text style={styles.mention}>@{name}</Text>;
}

function NoteMention({ id, onViewThread }: { id: string; onViewThread?: (eventId: string) => void }) {
  if (onViewThread) {
    return (
      <Text style={styles.mention} onPress={() => onViewThread(id)}>
        note:{id.slice(0, 8)}…
      </Text>
    );
  }
  return <Text style={styles.mention}>note:{id.slice(0, 8)}…</Text>;
}

function HashtagLink({ tag }: { tag: string }) {
  const action = useHashtagAction();
  if (action) {
    return <Text style={styles.hashtag} onPress={() => action.onHashtagClick(tag)}>#{tag}</Text>;
  }
  return <Text style={styles.hashtag}>#{tag}</Text>;
}

interface TrackerPromptInfo {
  url: string;
  cleanUrl: string;
  params: string[];
}

function WebLink({ url, onTrackerPress }: { url: string; onTrackerPress: (info: TrackerPromptInfo) => void }) {
  // Render the URL exactly as the author wrote it — never rewrite the note.
  // When known tracking params are detected, show an amber warning glyph and
  // intercept the tap so the user chooses clean vs original (parity with web).
  const clean = stripTrackingParams(url);
  const trackingParams = getTrackingParams(url);
  const hasTracker = clean !== url;
  const display = url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 50);
  const showPrompt = () => onTrackerPress({ url, cleanUrl: clean, params: trackingParams });
  const onPress = () => {
    if (hasTracker) showPrompt();
    else Linking.openURL(url);
  };
  // Long-press opens the options sheet on every link (same options everywhere).
  const onLongPress = () => showPrompt();
  return (
    <Text style={styles.link} onPress={onPress} onLongPress={onLongPress}>
      {display}{url.length > 50 ? '…' : ''}
      {/* Shield opens the link-options sheet. Amber when trackers are present,
          gray when clean. */}
      <Text
        style={hasTracker ? styles.trackerShield : styles.cleanShield}
        onPress={showPrompt}
      > {hasTracker ? '⚠' : '🛡'}</Text>
    </Text>
  );
}

function InlineImage({ url, sha256, fallbacks }: { url: string; sha256?: string; fallbacks?: string[] }) {
  // Ordered, deduped, SSRF-gated candidate list: primary URL, author-declared
  // NIP-92 fallbacks, then the same blob rebuilt on every known Blossom server
  // from its sha256. Advance the index on load error so a pruned/dead primary
  // falls back to a peer server. Parity with MediaLink's image branch + web.
  const sources = useMemo(
    () => resolveMediaSources({ url, sha256, fallbacks }),
    [url, sha256, fallbacks],
  );
  const [srcIndex, setSrcIndex] = useState(0);
  const [prevUrl, setPrevUrl] = useState(url);
  if (url !== prevUrl) {
    setPrevUrl(url);
    setSrcIndex(0);
  }
  const currentUrl = sources[srcIndex] ?? sources[0] ?? url;
  return (
    <TouchableOpacity activeOpacity={0.9} onPress={() => Linking.openURL(currentUrl)}>
      <SizeGuardedImage
        key={currentUrl}
        uri={currentUrl}
        style={styles.mediaImage}
        type="image"
        resizeMode="cover"
        onError={() => {
          // The blob might still exist on another Blossom server — retry the
          // same hash there before giving up.
          if (srcIndex < sources.length - 1) setSrcIndex(i => i + 1);
        }}
      />
    </TouchableOpacity>
  );
}

function InlineVideo({ url }: { url: string }) {
  // RN doesn't have a built-in video player; show a thumbnail link
  return (
    <TouchableOpacity style={styles.videoPlaceholder} onPress={() => Linking.openURL(url)}>
      <Text style={styles.videoIcon}>▶</Text>
      <Text style={styles.videoLabel}>Play video</Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// QuotedNote — inline preview for q-tag referenced notes
// ============================================================================

function QuotedNote({ noteId, onViewThread }: { noteId: string; onViewThread?: (eventId: string) => void }) {
  const { nostr } = useNostr();

  const { data: event, isLoading } = useQuery<NostrEvent | null>({
    queryKey: ['quoted-note', noteId],
    queryFn: async () => {
      try {
        const [ev] = await nostr.query(
          [{ ids: [noteId], limit: 1 }],
          { signal: AbortSignal.timeout(5000) },
        );
        return ev ?? null;
      } catch {
        return null;
      }
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const { data: authorData } = useAuthor(event?.pubkey);

  if (isLoading) {
    return (
      <View style={styles.quotedCard}>
        <Text style={styles.quotedPlaceholder}>Loading quoted note…</Text>
      </View>
    );
  }

  if (!event) {
    if (onViewThread) {
      return (
        <TouchableOpacity style={styles.quotedCard} onPress={() => onViewThread(noteId)} activeOpacity={0.7}>
          <Text style={styles.quotedPlaceholder}>note:{noteId.slice(0, 12)}…</Text>
        </TouchableOpacity>
      );
    }
    return (
      <View style={styles.quotedCard}>
        <Text style={styles.quotedPlaceholder}>note:{noteId.slice(0, 12)}…</Text>
      </View>
    );
  }

  const displayName = authorData?.metadata?.display_name || authorData?.metadata?.name || genUserName(event.pubkey);
  const avatar = authorData?.metadata?.picture;

  // Picture/video posts (kinds 20/21/22/34235/34236) keep media in imeta with an
  // empty or caption-only content field, and NIP-99 listings (30402) keep their
  // title/image in tags. Show a thumbnail + a sensible title so quoted media and
  // listings aren't blank cards.
  const listingTitle = event.kind === 30402 ? event.tags.find(t => t[0] === 'title')?.[1] : undefined;
  const imageTag = event.tags.find(t => t[0] === 'image')?.[1];
  const { imageUrls: quotedImages } = getImetaMedia(event);
  const previewImage = imageTag || quotedImages[0];
  const bodyText = listingTitle
    || event.content.replace(/<[^>]*>/g, '').trim()
    || event.tags.find(t => t[0] === 'alt')?.[1]
    || '';

  const cardBody = (
    <>
      <View style={styles.quotedHeader}>
        {avatar ? (
          <SizeGuardedImage uri={avatar} style={styles.quotedAvatar} type="avatar" />
        ) : (
          <View style={[styles.quotedAvatar, styles.quotedAvatarPlaceholder]}>
            <Text style={styles.quotedAvatarLetter}>{displayName[0]?.toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.quotedName} numberOfLines={1}>{displayName}</Text>
      </View>
      {bodyText.length > 0 && (
        <Text style={styles.quotedContent} numberOfLines={3}>
          {bodyText.slice(0, 300)}
        </Text>
      )}
      {previewImage && (
        <View style={styles.mediaContainer}>
          <InlineImage url={previewImage} />
        </View>
      )}
    </>
  );

  // Tapping a quoted note re-targets the thread (mirror web onViewThread).
  if (onViewThread) {
    return (
      <TouchableOpacity style={styles.quotedCard} onPress={() => onViewThread(event.id)} activeOpacity={0.7}>
        {cardBody}
      </TouchableOpacity>
    );
  }
  return <View style={styles.quotedCard}>{cardBody}</View>;
}

// Extract media URLs from imeta tags (NIP-92). Picture events (kind 20) and
// video events (kinds 21/22/34235/34236) carry their media here rather than in
// the content field. Keep in sync with web's getImetaData.
const IMAGE_EXT_IMETA = /\.(jpg|jpeg|png|gif|webp|avif)(\?|$)/i;
function getImetaMedia(event: import('@nostrify/nostrify').NostrEvent): { videoUrls: string[]; imageUrls: string[]; imetaMeta: Map<string, ImetaData> } {
  const videoUrls: string[] = [];
  const imageUrls: string[] = [];
  // Parsed imeta keyed by url — threads sha256 + author fallbacks into the media
  // renderers so a pruned primary can be recovered from a peer Blossom server.
  const imetaMeta = new Map<string, ImetaData>();
  for (const tag of event.tags) {
    if (tag[0] !== 'imeta') continue;
    const parsed = parseImetaTag(tag);
    if (parsed && !imetaMeta.has(parsed.url)) imetaMeta.set(parsed.url, parsed);
    let url = '';
    let mime = '';
    for (let i = 1; i < tag.length; i++) {
      const entry = tag[i];
      if (typeof entry !== 'string') continue;
      if (entry.startsWith('url ')) url = entry.slice(4);
      else if (entry.startsWith('m ')) mime = entry.slice(2);
    }
    if (!url) continue;
    if (mime.startsWith('video/') || VIDEO_EXT.test(url)) videoUrls.push(url);
    else if (mime.startsWith('image/') || IMAGE_EXT_IMETA.test(url)) imageUrls.push(url);
  }
  return { videoUrls, imageUrls, imetaMeta };
}

// ============================================================================
// Parser
// ============================================================================

interface ContentPart {
  type: 'text' | 'profile' | 'note' | 'hashtag' | 'url' | 'image' | 'video' | 'youtube' | 'emoji';
  value: string;
  pubkey?: string;
  noteId?: string;
  alt?: string;
}

function parseContent(content: string): ContentPart[] {
  // Pre-process markdown links [text](url) to extract just the URL for media detection.
  // Keep in sync with web's parseContent in packages/web/src/components/NoteContent.tsx.
  const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const markdownLinks: Array<{ start: number; end: number; text: string; url: string }> = [];
  let mdMatch;
  while ((mdMatch = MD_LINK_RE.exec(content)) !== null) {
    markdownLinks.push({
      start: mdMatch.index,
      end: mdMatch.index + mdMatch[0].length,
      text: mdMatch[1],
      url: mdMatch[2],
    });
  }

  // Build a combined regex to split on all special patterns
  const combined = new RegExp(
    `(${NOSTR_URI.source}|${HASHTAG.source}|${URL_PATTERN.source})`,
    'gi',
  );

  const parts: ContentPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset lastIndex
  combined.lastIndex = 0;

  while ((match = combined.exec(content)) !== null) {
    const token = match[0];
    const index = match.index;

    // Check if this match is inside a markdown link [text](url)
    const mdLink = markdownLinks.find(md => index >= md.start && index < md.end);
    if (mdLink) {
      // Add text before the markdown link if any
      if (mdLink.start > lastIndex) {
        parts.push({ type: 'text', value: content.slice(lastIndex, mdLink.start) });
      }
      // For image markdown ![alt](media-url), extract as inline media
      if (content[mdLink.start] === '!' && (IMAGE_EXT.test(mdLink.url) || IMAGE_DOMAINS.test(mdLink.url))) {
        parts.push({ type: 'image', value: mdLink.url });
      } else if (content[mdLink.start] === '!' && VIDEO_EXT.test(mdLink.url)) {
        parts.push({ type: 'video', value: mdLink.url });
      } else if (content[mdLink.start] === '!' && YOUTUBE_URL.test(mdLink.url)) {
        parts.push({ type: 'youtube', value: mdLink.url });
      } else {
        // Keep full [text](url) as text — preserves the descriptive link text
        // instead of dropping it and showing only the bare URL
        parts.push({ type: 'text', value: `${mdLink.text} (${mdLink.url})` });
      }
      lastIndex = mdLink.end;
      combined.lastIndex = mdLink.end;
      continue;
    }

    // Push preceding text
    if (index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, index) });
    }

    const bech32Token = token.startsWith('nostr:') ? token.slice(6) : token;
    const isNostrEntity = /^(npub1|note1|nprofile1|nevent1|naddr1)/i.test(bech32Token);
    if (isNostrEntity) {
      try {
        const bech32 = bech32Token;
        const decoded = nip19.decode(bech32);
        if (decoded.type === 'npub') {
          parts.push({ type: 'profile', value: token, pubkey: decoded.data as string });
        } else if (decoded.type === 'nprofile') {
          parts.push({ type: 'profile', value: token, pubkey: (decoded.data as { pubkey: string }).pubkey });
        } else if (decoded.type === 'note') {
          parts.push({ type: 'note', value: token, noteId: decoded.data as string });
        } else if (decoded.type === 'nevent') {
          parts.push({ type: 'note', value: token, noteId: (decoded.data as { id: string }).id });
        } else {
          parts.push({ type: 'text', value: token });
        }
      } catch {
        parts.push({ type: 'text', value: token });
      }
    } else if (token.startsWith('#')) {
      parts.push({ type: 'hashtag', value: token.slice(1) });
    } else if (YOUTUBE_URL.test(token)) {
      // YouTube links are media (tap-to-load embed) — parity with web. Strip
      // trailing punctuation like the plain-url branch.
      const cleaned = token.replace(/[),.;:!]+$/, '');
      parts.push({ type: 'youtube', value: cleaned });
      if (cleaned.length < token.length) {
        parts.push({ type: 'text', value: token.slice(cleaned.length) });
      }
    } else if (VIDEO_EXT.test(token)) {
      parts.push({ type: 'video', value: token });
    } else if (IMAGE_EXT.test(token) || IMAGE_DOMAINS.test(token)) {
      parts.push({ type: 'image', value: token });
    } else {
      // Strip trailing punctuation the greedy URL regex grabbed (e.g. "url).")
      // and re-emit it as text so links aren't broken. Parity with web. (B1)
      const cleaned = token.replace(/[),.;:!]+$/, '');
      parts.push({ type: 'url', value: cleaned });
      if (cleaned.length < token.length) {
        parts.push({ type: 'text', value: token.slice(cleaned.length) });
      }
    }

    lastIndex = index + token.length;
  }

  // Trailing text
  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  }

  return parts;
}

// ============================================================================
// Main component
// ============================================================================

interface NoteContentProps {
  event: NostrEvent;
  numberOfLines?: number;
  /** When set, embedded note mentions and quoted notes become tappable and
   *  navigate the thread to focus the referenced note (mirror web onViewThread). */
  onViewThread?: (eventId: string) => void;
}

/** Pure long-form sub-component — keeps the parent's hook order stable. */
function LongFormPreview({ event, numberOfLines }: NoteContentProps) {
  const title = event.tags.find(t => t[0] === 'title')?.[1];
  const dTag = event.tags.find(t => t[0] === 'd')?.[1];
  let readMoreUrl: string | null = null;
  if (dTag && event.pubkey) {
    try {
      readMoreUrl = 'https://njump.me/' + nip19.naddrEncode({
        kind: 30023,
        pubkey: event.pubkey,
        identifier: dTag,
      });
    } catch { /* ignore */ }
  }
  const preview = event.content.replace(/<[^>]*>/g, '').replace(/#+\s/g, '').trim().slice(0, 300);
  return (
    <View>
      <View style={styles.longFormBadge}>
        <Text style={styles.longFormBadgeText}>Long-form</Text>
        {title ? <Text style={styles.longFormTitle} numberOfLines={2}>{title}</Text> : null}
      </View>
      {preview ? <Text style={styles.content} numberOfLines={numberOfLines ?? 5}>{preview}</Text> : null}
      {readMoreUrl ? (
        <TouchableOpacity onPress={() => Linking.openURL(readMoreUrl!)}>
          <Text style={styles.readMore}>Read more →</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/** NIP-99 classified listing (kind 30402) preview — Gamma Markets fields. */
function ListingPreview({ event, numberOfLines }: NoteContentProps) {
  const { title, summary, price, images, location, status, visibility, stock } = parseListing(event);
  const image = images[0];
  const desc = event.content.replace(/<[^>]*>/g, '').trim().slice(0, 300);
  const outOfStock = stock === 0;
  return (
    <View>
      {image ? <View style={styles.mediaContainer}><InlineImage url={image} /></View> : null}
      <View style={styles.listingHeader}>
        <Text style={styles.listingTitle} numberOfLines={2}>{title}</Text>
        {price ? <Text style={styles.listingPrice}>{price}</Text> : null}
      </View>
      {visibility === 'pre-order' ? <Text style={styles.listingMeta}>Pre-order</Text> : null}
      {typeof stock === 'number' && stock > 0 ? <Text style={styles.listingMeta}>{stock} in stock</Text> : null}
      {location ? <Text style={styles.listingMeta}>📍 {location}</Text> : null}
      {summary ? <Text style={styles.content} numberOfLines={2}>{summary}</Text> : null}
      {desc ? <Text style={styles.content} numberOfLines={numberOfLines ?? 5}>{desc}</Text> : null}
      {status === 'sold' ? <Text style={styles.listingSold}>SOLD</Text> : outOfStock ? <Text style={styles.listingSold}>OUT OF STOCK</Text> : null}
    </View>
  );
}

/** NIP-94 file metadata (kind 1063) — the file lives in the `url` tag, not the
 *  content field; content is an optional caption/description. */
function FileMetadataPreview({ event, numberOfLines }: NoteContentProps) {
  const fileUrl = event.tags.find(t => t[0] === 'url')?.[1];
  const mime = event.tags.find(t => t[0] === 'm')?.[1] ?? '';
  const caption = event.content.replace(/<[^>]*>/g, '').trim();
  return (
    <View>
      {fileUrl ? <MediaLink url={fileUrl} isVideo={mime.startsWith('video/')} /> : null}
      {caption ? <Text style={styles.content} numberOfLines={numberOfLines}>{caption}</Text> : null}
    </View>
  );
}

/** NIP-88 poll (kind 1068) — content is the question, options live in tags. */
function PollPreview({ event, numberOfLines }: NoteContentProps) {
  const options = event.tags.filter(t => t[0] === 'option' && t[1] && t[2]);
  const question = event.content.replace(/<[^>]*>/g, '').trim();
  return (
    <View>
      <Text style={styles.kindHeader}>Poll</Text>
      {question ? <Text style={styles.content} numberOfLines={numberOfLines}>{question}</Text> : null}
      <View style={styles.pollOptions}>
        {options.map(([, id, label]) => (
          <View key={id} style={styles.pollOption}>
            <Text style={styles.pollOptionText}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** NIP-53 live event (kind 30311) — structured stream info lives in tags. */
function LiveEventPreview({ event }: NoteContentProps) {
  const title = event.tags.find(t => t[0] === 'title')?.[1];
  const summary = event.tags.find(t => t[0] === 'summary')?.[1];
  const status = event.tags.find(t => t[0] === 'status')?.[1];
  const streaming = event.tags.find(t => t[0] === 'streaming')?.[1];
  const image = event.tags.find(t => t[0] === 'image')?.[1];
  return (
    <View>
      <Text style={[styles.kindHeader, status === 'live' && styles.liveHeader]}>
        {status === 'live' ? 'Live now' : status === 'ended' ? 'Stream ended' : 'Live event'}
      </Text>
      {title ? <Text style={styles.streamTitle}>{title}</Text> : null}
      {summary ? <Text style={styles.streamSummary}>{summary}</Text> : null}
      {image ? <MediaLink url={image} /> : null}
      {streaming && status === 'live' ? <MediaLink url={streaming} isVideo /> : null}
    </View>
  );
}

export function NoteContent({ event, numberOfLines, onViewThread }: NoteContentProps) {
  // Hooks must run unconditionally on every render (rules-of-hooks). The
  // kind-specific branches (30023 / 30402 / 1063 / 1068 / 30311) are taken
  // AFTER all hooks have been called.

  // Tracker-warning dialog state lives here (not inside WebLink) because
  // WebLink renders inside a <Text> where a Modal child isn't valid.
  const [trackerPrompt, setTrackerPrompt] = useState<TrackerPromptInfo | null>(null);

  // NIP-30 custom emoji map: shortcode → image URL
  const emojiMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const tag of event.tags) {
      if (tag[0] === 'emoji' && tag[1] && tag[2]) {
        map.set(tag[1], tag[2]);
      }
    }
    return map;
  }, [event.tags]);

  const parts = useMemo(() => {
    // Strip HTML tags from content (parity with web SmartNoteContent DOMPurify path).
    // React Native doesn't render HTML, but stripped tags would show as ugly raw text.
    const content = hasHtmlContent(event.content)
      ? event.content.replace(/<[^>]*>/g, '')
      : event.content;
    const raw = parseContent(content);
    if (emojiMap.size === 0) return raw;
    // Replace :shortcode: in text parts with emoji parts
    const expanded: ContentPart[] = [];
    for (const part of raw) {
      if (part.type !== 'text') { expanded.push(part); continue; }
      const segments = part.value.split(CUSTOM_EMOJI_SPLIT);
      for (let j = 0; j < segments.length; j++) {
        if (j % 2 === 0) {
          if (segments[j]) expanded.push({ type: 'text', value: segments[j] });
        } else {
          const url = emojiMap.get(segments[j]);
          if (url) {
            expanded.push({ type: 'emoji', value: url, alt: segments[j] });
          } else {
            expanded.push({ type: 'text', value: `:${segments[j]}:` });
          }
        }
      }
    }
    return expanded;
  }, [event.content, emojiMap]);

  // Extract imeta media (NIP-92) for all kinds — picture (20) and video
  // (21/22/34235/34236) events carry media here with empty/caption content.
  const { videoUrls: imetaVideoUrls, imageUrls: imetaImageUrls, imetaMeta } = useMemo(() => getImetaMedia(event), [event]);

  // Long-form (kind 30023) / listing (kind 30402) — branch AFTER all hooks.
  if (event.kind === 30023) {
    return <LongFormPreview event={event} numberOfLines={numberOfLines} />;
  }
  if (event.kind === 30402) {
    return <ListingPreview event={event} numberOfLines={numberOfLines} />;
  }
  // NIP-94 file metadata (kind 1063) — only when a url tag exists; otherwise
  // fall through to generic rendering (parity with web SmartNoteContent).
  if (event.kind === 1063 && event.tags.some(t => t[0] === 'url' && t[1])) {
    return <FileMetadataPreview event={event} numberOfLines={numberOfLines} />;
  }
  // NIP-88 poll (kind 1068)
  if (event.kind === 1068) {
    return <PollPreview event={event} numberOfLines={numberOfLines} />;
  }
  // NIP-53 live event (kind 30311)
  if (event.kind === 30311) {
    return <LiveEventPreview event={event} />;
  }

  // Separate inline parts from block-level media
  const inlineParts: ContentPart[] = [];
  const mediaParts: ContentPart[] = [];

  for (const part of parts) {
    if (part.type === 'image' || part.type === 'video' || part.type === 'youtube') {
      mediaParts.push(part);
    } else {
      inlineParts.push(part);
    }
  }

  return (
    <View>
      {/* Text content with inline mentions, hashtags, links */}
      <Text style={styles.content} numberOfLines={numberOfLines}>
        {inlineParts.map((part, i) => {
          switch (part.type) {
            case 'text':
              return <Text key={i}>{part.value}</Text>;
            case 'profile':
              return <ProfileMention key={i} pubkey={part.pubkey!} />;
            case 'note':
              return <NoteMention key={i} id={part.noteId!} onViewThread={onViewThread} />;
            case 'hashtag':
              return <HashtagLink key={i} tag={part.value} />;
            case 'url':
              return <WebLink key={i} url={part.value} onTrackerPress={setTrackerPrompt} />;
            case 'emoji': {
              // Gate custom-emoji (NIP-30) URLs like images: reject unsafe hosts
              // (SSRF) and route through the user's image proxy. Unsafe host →
              // fall back to plain :shortcode: text. Parity with web.
              const safeUrl = optimizeMediaUrl(part.value);
              if (!safeUrl) return <Text key={i}>:{part.alt}:</Text>;
              const isAnimated = part.value.endsWith('.gif') || part.value.includes('.gif?');
              const size = isAnimated ? 64 : 20;
              return <Image key={i} source={{ uri: safeUrl }} style={{ width: size, height: size }} resizeMode="contain" />;
            }
            default:
              return <Text key={i}>{part.value}</Text>;
          }
        })}
      </Text>

      {/* Block-level media (images, videos, YouTube embeds) */}
      {mediaParts.map((part, i) => {
        const m = imetaMeta.get(part.value);
        return (
          <View key={`media-${i}`} style={styles.mediaContainer}>
            {part.type === 'image' ? (
              <InlineImage url={part.value} sha256={m?.sha256} fallbacks={m?.fallbacks} />
            ) : part.type === 'youtube' ? (
              <MediaLink url={part.value} sha256={m?.sha256} fallbacks={m?.fallbacks} />
            ) : (
              <InlineVideo url={part.value} />
            )}
          </View>
        );
      })}

      {/* Render imeta media (NIP-92) not already shown inline. Picture (kind 20)
          and video (kinds 21/22/34235/34236) events keep media in imeta with an
          empty/caption content field, so without this they'd render blank. */}
      {(imetaVideoUrls.length > 0 || imetaImageUrls.length > 0) && (() => {
        const contentUrls = new Set(mediaParts.map(p => p.value));
        return (
          <>
            {imetaImageUrls.filter(url => !contentUrls.has(url)).map(url => {
              const m = imetaMeta.get(url);
              return (
                <View key={`imeta-img-${url}`} style={styles.mediaContainer}>
                  <InlineImage url={url} sha256={m?.sha256} fallbacks={m?.fallbacks} />
                </View>
              );
            })}
            {imetaVideoUrls.filter(url => !contentUrls.has(url)).map(url => (
              <View key={`imeta-vid-${url}`} style={styles.mediaContainer}>
                <InlineVideo url={url} />
              </View>
            ))}
          </>
        );
      })()}

      {/* Quote posts — render inline preview for q-tagged events */}
      {event.tags
        .filter(t => t[0] === 'q' && t[1])
        .map(t => (
          <View key={`quote-${t[1]}`} style={styles.mediaContainer}>
            <QuotedNote noteId={t[1]} onViewThread={onViewThread} />
          </View>
        ))}

      {/* Tracker-warning dialog for links carrying known tracking params */}
      {trackerPrompt && (
        <TrackerWarningDialog
          visible
          onClose={() => setTrackerPrompt(null)}
          rawUrl={trackerPrompt.url}
          cleanUrl={trackerPrompt.cleanUrl}
          trackingParams={trackerPrompt.params}
        />
      )}
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  content: { fontSize: 14, color: '#b3b3b3', lineHeight: 20 },
  mention: { color: '#a855f7', fontWeight: '500' },
  hashtag: { color: '#a855f7' },
  link: { color: '#a855f7', textDecorationLine: 'underline' },
  trackerShield: { color: '#f59e0b', fontSize: 12 },
  cleanShield: { color: '#999', fontSize: 12 },
  mediaContainer: { marginTop: 10, borderRadius: 10, overflow: 'hidden' },
  mediaImage: { width: MEDIA_WIDTH, height: MEDIA_WIDTH * 0.56, borderRadius: 10 },
  videoPlaceholder: {
    width: MEDIA_WIDTH,
    height: 80,
    backgroundColor: '#333',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  videoIcon: { color: '#b3b3b3', fontSize: 20 },
  videoLabel: { color: '#999', fontSize: 13 },
  // Long-form (kind 30023)
  longFormBadge: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
  longFormBadgeText: { backgroundColor: '#333', color: '#a855f7', fontSize: 11, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  longFormTitle: { fontSize: 15, fontWeight: '600', color: '#f2f2f2', flex: 1 },
  readMore: { color: '#a855f7', fontSize: 13, marginTop: 6, textDecorationLine: 'underline' },
  // Listing (NIP-99 kind 30402)
  listingHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginTop: 4 },
  listingTitle: { fontSize: 15, fontWeight: '600', color: '#f2f2f2', flex: 1 },
  listingPrice: { fontSize: 13, fontWeight: '700', color: '#22c55e' },
  listingMeta: { fontSize: 12, color: '#8a8a8a', marginTop: 2 },
  listingSold: { fontSize: 12, fontWeight: '700', color: '#ef4444', marginTop: 4 },
  // Kind headers (poll / live event)
  kindHeader: { fontSize: 11, color: '#999', marginBottom: 4 },
  liveHeader: { color: '#ef4444', fontWeight: '600' },
  // NIP-88 poll (kind 1068)
  pollOptions: { marginTop: 8, gap: 4 },
  pollOption: {
    borderWidth: 1,
    borderColor: '#404040',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pollOptionText: { color: '#f2f2f2', fontSize: 13 },
  // NIP-53 live event (kind 30311)
  streamTitle: { fontSize: 15, fontWeight: '600', color: '#f2f2f2' },
  streamSummary: { fontSize: 13, color: '#999', marginTop: 2 },
  // Quoted notes
  quotedCard: { borderWidth: 1, borderColor: '#404040', borderRadius: 10, padding: 10, backgroundColor: '#1f1f1f' },
  quotedHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  quotedAvatar: { width: 20, height: 20, borderRadius: 10 },
  quotedAvatarPlaceholder: { backgroundColor: '#333', alignItems: 'center', justifyContent: 'center' },
  quotedAvatarLetter: { color: '#a855f7', fontSize: 10, fontWeight: '600' },
  quotedName: { color: '#999', fontSize: 12, fontWeight: '500', flex: 1 },
  quotedContent: { fontSize: 13, color: '#999', lineHeight: 18 },
  quotedPlaceholder: { color: '#666', fontSize: 12, fontFamily: 'monospace' },
});
