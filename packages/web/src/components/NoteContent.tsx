import React, { useMemo, memo, useState } from 'react'
import { type NostrEvent } from '@nostrify/nostrify'
import { cn } from '@/lib/utils'
import { Link } from '@/components/ui/link'
import { NoteLink } from './NoteLink'
import { ProfileLink } from './ProfileLink'
import { MediaLink } from './MediaLink'
import { isImageUrl } from '@/lib/mediaUtils'
import { WebLink } from './WebLink'
import { SizeGuardedImage } from './SizeGuardedImage'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

interface NoteContentProps {
  event: NostrEvent
  className?: string
  /** When true, embedded note links expand in-place instead of navigating (for use in modals) */
  inModalContext?: boolean
  /** Callback for when user wants to view full thread (only used when inModalContext is true) */
  onViewThread?: (eventId: string) => void
  /** When true, media is blurred until clicked (saves memory for off-screen notes) */
  blurMedia?: boolean
  /** Recursion depth for embedded NoteLinks — stops at MAX_EMBED_DEPTH to prevent circular references */
  depth?: number
}

const MAX_EMBED_DEPTH = 3

function MarkdownImg({ src, alt }: { src?: string; alt?: string }) {
  const [errored, setErrored] = useState(false)
  if (errored || !src) {
    return src ? (
      <a href={src} target="_blank" rel="noopener noreferrer" className="text-primary underline break-all text-sm">
        {alt || src}
      </a>
    ) : null
  }
  return (
    <SizeGuardedImage src={src} alt={alt || ''} className="max-w-full max-h-[500px] rounded-lg object-contain my-2" loading="lazy" onError={() => setErrored(true)} />
  )
}

/** Replace :shortcode: patterns with img elements, preserving surrounding text */
function replaceEmojis(text: string, emojiMap: Map<string, string>): React.ReactNode {
  if (emojiMap.size === 0) return text
  const segments = text.split(/:([a-zA-Z0-9_-]+):/g)
  if (segments.length === 1) return text
  const parts: React.ReactNode[] = []
  for (let j = 0; j < segments.length; j++) {
    if (j % 2 === 0) {
      if (segments[j]) parts.push(segments[j])
    } else {
      const url = emojiMap.get(segments[j])
      if (url) {
        const isAnimated = url.endsWith('.gif') || url.includes('.gif?')
        parts.push(
          <img key={`e${j}`} src={url} alt={segments[j]} title={`:${segments[j]}:`}
            className={`inline-block align-middle ${isAnimated ? 'h-20 w-20' : 'h-6 w-6'}`} loading="lazy" />
        )
      } else {
        parts.push(`:${segments[j]}:`)
      }
    }
  }
  return <>{parts}</>
}

/** Renders a markdown text part using react-markdown with GFM support */
const MarkdownText = memo(function MarkdownText({ text, emojiMap }: { text: string; emojiMap?: Map<string, string> }) {
  // Process React children to replace :shortcode: in string nodes with emoji images
  const processChildren = (children: React.ReactNode): React.ReactNode => {
    if (!emojiMap || emojiMap.size === 0) return children
    return React.Children.map(children, (child) => {
      if (typeof child === 'string') return replaceEmojis(child, emojiMap)
      return child
    })
  }
  const ec = processChildren // shorthand

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={{
        // Headings
        h1: ({ children }) => <span className="block font-bold text-xl mt-3 mb-1">{ec(children)}</span>,
        h2: ({ children }) => <span className="block font-bold text-lg mt-3 mb-1">{ec(children)}</span>,
        h3: ({ children }) => <span className="block font-bold text-base mt-3 mb-1">{ec(children)}</span>,
        h4: ({ children }) => <span className="block font-bold text-base mt-3 mb-1">{ec(children)}</span>,
        h5: ({ children }) => <span className="block font-bold text-sm mt-3 mb-1">{ec(children)}</span>,
        h6: ({ children }) => <span className="block font-bold text-sm mt-3 mb-1">{ec(children)}</span>,
        // Paragraphs — no extra margin, preserve inline flow
        p: ({ children }) => <span className="block my-1">{ec(children)}</span>,
        // Links — purple to match our palette, block unsafe protocols
        a: ({ href, children }) => {
          let safe = false
          if (href) {
            try { safe = ['http:', 'https:'].includes(new URL(href.trim()).protocol) } catch { /* empty */ }
          }
          if (!safe) return <span>{ec(children)}</span>
          return (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-purple-500 hover:text-purple-600 underline" onClick={(e) => e.stopPropagation()}>
              {ec(children)}
            </a>
          )
        },
        // Code blocks
        pre: ({ children }) => (
          <pre className="block my-2 p-3 bg-muted rounded-lg overflow-x-auto text-sm font-mono whitespace-pre">{children}</pre>
        ),
        code: ({ className, children }) => {
          // If it has a className (language), it's inside a <pre> (fenced block)
          if (className) {
            return <code className="font-mono">{children}</code>
          }
          // Inline code — don't replace emojis inside code
          return <code className="px-1.5 py-0.5 bg-muted rounded text-sm font-mono">{children}</code>
        },
        // Blockquotes
        blockquote: ({ children }) => (
          <blockquote className="block border-l-3 border-muted-foreground/40 pl-3 my-2 text-muted-foreground italic">{children}</blockquote>
        ),
        // Lists
        ul: ({ children }) => <ul className="block list-disc pl-6 my-1 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="block list-decimal pl-6 my-1 space-y-0.5">{children}</ol>,
        li: ({ children, className }) => {
          // Task list items get a className from remark-gfm
          if (className?.includes('task-list-item')) {
            return <li className="list-none -ml-6 flex items-start gap-2">{ec(children)}</li>
          }
          return <li>{ec(children)}</li>
        },
        // Horizontal rules
        hr: () => <hr className="my-3 border-border" />,
        // Tables
        table: ({ children }) => (
          <div className="block my-2 overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
        th: ({ children }) => <th className="border border-border px-3 py-1.5 text-left font-medium">{ec(children)}</th>,
        td: ({ children }) => <td className="border border-border px-3 py-1.5">{ec(children)}</td>,
        // Strikethrough
        del: ({ children }) => <del className="line-through text-muted-foreground">{ec(children)}</del>,
        // Images
        img: ({ src, alt }) => <MarkdownImg src={src} alt={alt} />,
        // Checkboxes for task lists
        input: ({ checked, type }) => {
          if (type === 'checkbox') {
            return <input type="checkbox" checked={checked} readOnly className="mt-1 accent-purple-500" />
          }
          return <input type={type} />
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
});

// Extract video URLs and poster URLs from imeta tags (NIP-71 video events)
function getImetaData(event: NostrEvent): { posters: Map<string, string>; videoUrls: string[] } {
  const posters = new Map<string, string>()
  const videoUrls: string[] = []
  for (const tag of event.tags) {
    if (tag[0] !== 'imeta') continue
    let url = ''
    let image = ''
    let mime = ''
    for (let i = 1; i < tag.length; i++) {
      const entry = tag[i]
      if (typeof entry !== 'string') continue
      if (entry.startsWith('url ')) url = entry.slice(4)
      else if (entry.startsWith('image ') && !image) image = entry.slice(6)
      else if (entry.startsWith('m ')) mime = entry.slice(2)
    }
    if (url && image) posters.set(url, image)
    if (url && (mime.startsWith('video/') || /\.(mp4|webm|mov|m3u8)(\?|$)/i.test(url))) {
      videoUrls.push(url)
    }
  }
  return { posters, videoUrls }
}

export function NoteContent({ event, className, inModalContext = false, onViewThread, blurMedia = false, depth = 0 }: NoteContentProps) {
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

  const content = useMemo(() => {
    const parts = parseContent(event.content);
    if (emojiMap.size === 0) return parts;
    // Replace :shortcode: in text parts with emoji parts.
    // Markdown parts are left intact — MarkdownText handles emoji rendering
    // internally so markdown formatting (bold, italic, etc.) isn't broken.
    const expanded: ContentPart[] = [];
    for (const part of parts) {
      if (part.type !== 'text') { expanded.push(part); continue; }
      const segments = part.value.split(/:([a-zA-Z0-9_-]+):/g);
      if (segments.length === 1) { expanded.push(part); continue; }
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
  }, [event.content, emojiMap])

  // Build poster map and video URL set from imeta tags (NIP-71)
  const { posters: imetaPosters, videoUrls: imetaVideoUrls } = useMemo(() => getImetaData(event), [event])
  const imetaVideoUrlSet = useMemo(() => new Set(imetaVideoUrls), [imetaVideoUrls])

  // Group consecutive image media parts for horizontal layout
  const groupedContent = useMemo(() => {
    const groups: { type: 'single'; index: number; part: ContentPart }[] | { type: 'image-row'; indices: number[]; parts: ContentPart[] }[] = []
    let i = 0
    while (i < content.length) {
      const part = content[i]
      if (part.type === 'media' && !imetaVideoUrlSet.has(part.value) && isImageUrl(part.value)) {
        // Collect consecutive image media parts
        const imageParts: { index: number; part: ContentPart }[] = [{ index: i, part }]
        let j = i + 1
        while (j < content.length) {
          const next = content[j]
          // Skip whitespace-only text between consecutive images
          if (next.type === 'text' && !next.value.trim()) { j++; continue }
          if (next.type === 'media' && !imetaVideoUrlSet.has(next.value) && isImageUrl(next.value)) {
            imageParts.push({ index: j, part: next })
            j++
          } else break
        }
        if (imageParts.length >= 2) {
          (groups as { type: 'image-row'; indices: number[]; parts: ContentPart[] }[]).push({
            type: 'image-row',
            indices: imageParts.map(ip => ip.index),
            parts: imageParts.map(ip => ip.part),
          })
        } else {
          (groups as { type: 'single'; index: number; part: ContentPart }[]).push({ type: 'single', index: i, part })
        }
        i = j
      } else {
        (groups as { type: 'single'; index: number; part: ContentPart }[]).push({ type: 'single', index: i, part })
        i++
      }
    }
    return groups as ({ type: 'single'; index: number; part: ContentPart } | { type: 'image-row'; indices: number[]; parts: ContentPart[] })[]
  }, [content, imetaVideoUrlSet])

  const renderPart = (part: ContentPart, i: number) => {
    switch (part.type) {
      case 'note':
        if (depth >= MAX_EMBED_DEPTH) {
          return <span key={i} className="text-purple-500 text-sm italic">nostr:{part.value.slice(0, 12)}…</span>
        }
        return (
          <NoteLink
            key={i}
            noteId={part.value}
            inlineMode={inModalContext}
            onViewThread={onViewThread}
            blurMedia={blurMedia}
            depth={depth + 1}
          />
        )
      case 'profile':
        return <ProfileLink key={i} pubkey={part.value} />
      case 'media':
        return <MediaLink key={i} url={part.value} blurMedia={blurMedia} poster={imetaPosters.get(part.value)} isVideo={imetaVideoUrlSet.has(part.value)} />
      case 'web':
        return <WebLink key={i} url={part.value} />
      case 'hashtag':
        return (
          <Link
            key={i}
            href={`/t/${part.value.slice(1)}`}
            className="text-purple-500 hover:text-purple-600 font-medium"
          >
            {part.value}
          </Link>
        )
      case 'markdown':
        return <MarkdownText key={i} text={part.value} emojiMap={emojiMap} />
      case 'emoji': {
        const isAnimated = part.value.endsWith('.gif') || part.value.includes('.gif?')
        return <img key={i} src={part.value} alt={part.alt ?? 'emoji'} title={`:${part.alt}:`} className={`inline-block align-middle ${isAnimated ? 'h-20 w-20' : 'h-6 w-6'}`} loading="lazy" />
      }
      default:
        return <span className="whitespace-pre-wrap" key={i}>{part.value}</span>
    }
  }

  return (
    <div className={cn('break-words', className)}>
      {groupedContent.map((group) => {
        if (group.type === 'image-row') {
          return (
            <div key={`row-${group.indices[0]}`} className="flex gap-1 my-2 overflow-x-auto">
              {group.parts.map((part, j) => (
                <div key={group.indices[j]} className="flex-shrink-0 max-w-[50%] min-w-0">
                  <MediaLink url={part.value} blurMedia={blurMedia} poster={imetaPosters.get(part.value)} />
                </div>
              ))}
            </div>
          )
        }
        return renderPart(group.part, group.index)
      })}
      {/* Render imeta videos not already in content (kind 34235/34236 video events) */}
      {(event.kind === 34235 || event.kind === 34236) && (() => {
        const contentUrls = new Set(content.filter(p => p.type === 'media').map(p => p.value))
        const missingVideos = imetaVideoUrls.filter(url => !contentUrls.has(url))
        return missingVideos.map(videoUrl => (
          <MediaLink key={videoUrl} url={videoUrl} blurMedia={blurMedia} poster={imetaPosters.get(videoUrl)} isVideo />
        ))
      })()}
    </div>
  )
}

interface ContentPart {
  type: 'text' | 'note' | 'profile' | 'media' | 'web' | 'hashtag' | 'markdown' | 'emoji'
  value: string
  alt?: string
}

const nostrPattern = /(nostr:)?(note1|npub1|nprofile1|nevent1|naddr1)[a-zA-Z0-9]+/g
const urlPattern = /(https?:\/\/[^\s]+)/g
const hashtagPattern = /(?<!#)#([a-zA-Z]\w*)/g
const mediaPattern = new RegExp(
  `(${[
    // Video platforms
    'rumble.com',
    'odysee.com',
    'vimeo.com',
    'twitch.tv',
    'clips.twitch.tv',
    // Music platforms
    'tidal.com',
    'spotify.com',
    'soundcloud.com',
    'music.apple.com',
    'bandcamp.com',
    // Image hosting
    'nostr.build',
    'blossom.band',
    'blossom.yakihonne.com',
    'blossom.f7z.io',
    'blossom.ditto.pub',
    'cdn.sovbit.host',
    'blossom.primal.net',
    'files.primal.net',
    'cdn.satellite.earth',
    'void.cat',
    'imgprxy.stacker.news',
    'image.nostr.build',
    'media.nostr.band',
    // Recipes & content
    'zap.cooking',
    // Movies
    'imdb.com',
    // Other
    'wav.school'
  ].join('|')}|\\.(?:jpg|jpeg|png|gif|webp|mp4|webm|mov)(?:[?#]|$))`,
  'i'
)

// Regex patterns for parsing — instantiated fresh per call to avoid stateful /g issues
const MD_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
const MARKDOWN_INDICATORS_PATTERN = /(?:^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^\s*>|`|^\s*---\s*$|^\s*\*\*\*\s*$|\*\*|__|\*[^*\s]|_[^_\s]|~~|\|.+\||!\[|^\s*- \[[ x]\])/m

function parseContent(content: string): ContentPart[] {
  const parts: ContentPart[] = []
  let lastIndex = 0

  // Pre-process markdown links [text](url) to extract just the URL for media detection
  // Store markdown link info: {start, end, text, url}
  const markdownLinks: Array<{start: number; end: number; text: string; url: string}> = []
  let mdMatch
  const mdLinkRegex = new RegExp(MD_LINK_PATTERN.source, 'g')
  while ((mdMatch = mdLinkRegex.exec(content)) !== null) {
    markdownLinks.push({
      start: mdMatch.index,
      end: mdMatch.index + mdMatch[0].length,
      text: mdMatch[1],
      url: mdMatch[2]
    })
  }

  // Combined regex to find Nostr entities, URLs, and hashtags
  const combinedRegex = new RegExp(
    `(${nostrPattern.source}|${urlPattern.source}|${hashtagPattern.source})`,
    'g'
  )

  let match
  while ((match = combinedRegex.exec(content)) !== null) {
    const [fullMatch] = match
    const index = match.index

    // Check if this match is inside a markdown link [text](url)
    const mdLink = markdownLinks.find(md => index >= md.start && index < md.end)
    if (mdLink) {
      // Add text before the markdown link if any
      if (mdLink.start > lastIndex) {
        parts.push({
          type: 'text',
          value: content.slice(lastIndex, mdLink.start)
        })
      }
      // For markdown links, use the clean URL (without trailing paren)
      if (mediaPattern.test(mdLink.url)) {
        parts.push({ type: 'media', value: mdLink.url })
      } else {
        parts.push({ type: 'web', value: mdLink.url })
      }
      lastIndex = mdLink.end
      combinedRegex.lastIndex = mdLink.end
      continue
    }

    // Add preceding text
    if (index > lastIndex) {
      parts.push({
        type: 'text',
        value: content.slice(lastIndex, index)
      })
    }

    // Classify the match
    if (
      fullMatch.startsWith('note1') ||
      fullMatch.startsWith('nostr:note1') ||
      fullMatch.startsWith('nevent1') ||
      fullMatch.startsWith('nostr:nevent1') ||
      fullMatch.startsWith('naddr1') ||
      fullMatch.startsWith('nostr:naddr1')
    ) {
      parts.push({ type: 'note', value: fullMatch.replace('nostr:', '') })
    } else if (
      fullMatch.startsWith('npub1') ||
      fullMatch.startsWith('nprofile1') ||
      fullMatch.startsWith('nostr:npub1') ||
      fullMatch.startsWith('nostr:nprofile1')
    ) {
      parts.push({ type: 'profile', value: fullMatch.replace('nostr:', '') })
    } else if (mediaPattern.test(fullMatch)) {
      parts.push({ type: 'media', value: fullMatch })
    } else if (fullMatch.startsWith('http')) {
      parts.push({ type: 'web', value: fullMatch })
    } else if (fullMatch.startsWith('#')) {
      parts.push({ type: 'hashtag', value: fullMatch })
    } else {
      parts.push({ type: 'text', value: fullMatch })
    }

    lastIndex = index + fullMatch.length
  }

  // Add remaining text
  if (lastIndex < content.length) {
    parts.push({
      type: 'text',
      value: content.slice(lastIndex)
    })
  }

  // Post-process: detect markdown in text parts and tag them for react-markdown rendering
  const final: ContentPart[] = []
  for (const part of parts) {
    if (part.type !== 'text') {
      final.push(part)
      continue
    }
    // Test for markdown indicators — fresh regex per test to avoid stateful /g issues
    // Guard: skip regex on very long segments to prevent ReDoS
    if (part.value.length <= 10_000 && MARKDOWN_INDICATORS_PATTERN.test(part.value)) {
      final.push({ type: 'markdown', value: part.value })
    } else {
      final.push(part)
    }
  }

  return final
}
