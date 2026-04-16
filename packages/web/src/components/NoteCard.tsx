import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react'
import { toast } from '@/hooks/useToast'
import { type NostrEvent } from '@nostrify/nostrify'
import { EngagementBar } from '@/components/EngagementBar'
import { useNostr } from '@nostrify/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthor } from '@/hooks/useAuthor'
import { useCollapsedNotes } from '@/hooks/useCollapsedNotes'
import { fetchEventWithOutbox } from '@/lib/fetchEvent'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SmartNoteContent } from '@/components/SmartNoteContent'
import { NoteContent } from '@/components/NoteContent'
import { visibleLength, findVisibleCutoff } from '@/lib/textTruncation'
import { ClickableProfile, profileModalState, PROFILE_ACTION_FOLLOW } from '@/components/ProfileModal'
import { genUserName } from '@/lib/genUserName'
import { formatTimeAgoCompact } from '@/lib/formatTimeAgo'
import { optimizeAvatarUrl } from '@/lib/imageUtils'
import { nip19 } from 'nostr-tools'
import { PinIcon, MessageSquare, Reply, Repeat2, Zap, Rss, Heart, Copy, Check, Pin, RotateCw, Globe, BadgeCheck, ChevronDown, Trash2, Highlighter, UserPlus, Smile } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CombinedEmojiPicker } from '@/components/compose/CombinedEmojiPicker'
import { useNostrPublish } from '@/hooks/useNostrPublish'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { getRelayCache, FALLBACK_RELAYS } from '@/components/NostrProvider'
import { useToast } from '@/hooks/useToast'
import { EmojiName } from '@/components/EmojiName'

// Preserve dismissed/collapsed note heights across tab switches (survives unmount/remount)
const MAX_CAPTURED_HEIGHTS = 10000;
const capturedHeights = new Map<string, number>();
// eslint-disable-next-line react-refresh/only-export-components
export function setCapturedHeight(noteId: string, height: number): void {
  if (capturedHeights.size >= MAX_CAPTURED_HEIGHTS && !capturedHeights.has(noteId)) {
    capturedHeights.delete(capturedHeights.keys().next().value!);
  }
  capturedHeights.set(noteId, height);
}

// Track user's reactions so they persist across re-renders/remounts
const MAX_TRACKED_NOTES = 10000;
const userReactions = new Map<string, { emoji: string; url?: string }>(); // noteId → reaction
// eslint-disable-next-line react-refresh/only-export-components
export function recordUserReaction(noteId: string, emoji: string, url?: string): void {
  if (userReactions.size >= MAX_TRACKED_NOTES && !userReactions.has(noteId)) {
    userReactions.delete(userReactions.keys().next().value!);
  }
  userReactions.set(noteId, { emoji, url });
}
// eslint-disable-next-line react-refresh/only-export-components
export function getUserReaction(noteId: string): { emoji: string; url?: string } | undefined {
  return userReactions.get(noteId);
}

// Track user's zaps so they show immediately in the UI
const userZaps = new Map<string, number>(); // noteId → amount in sats
// eslint-disable-next-line react-refresh/only-export-components
export function recordUserZap(noteId: string, amount: number): void {
  if (userZaps.size >= MAX_TRACKED_NOTES && !userZaps.has(noteId)) {
    userZaps.delete(userZaps.keys().next().value!);
  }
  userZaps.set(noteId, (userZaps.get(noteId) || 0) + amount);
}
// eslint-disable-next-line react-refresh/only-export-components
export function getUserZapAmount(noteId: string): number {
  return userZaps.get(noteId) || 0;
}

/** Clear all per-session reaction/zap/height state. Call on logout to prevent cross-user contamination. */
// eslint-disable-next-line react-refresh/only-export-components
export function clearNoteCardCache(): void {
  capturedHeights.clear();
  userReactions.clear();
  userZaps.clear();
}

/** Reusable copy-event-ID button with brief checkmark feedback */
export function CopyEventIdButton({ eventId, size = 'normal' }: { eventId: string; size?: 'normal' | 'small' }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, []);
  const isSmall = size === 'small';
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        const noteId = nip19.noteEncode(eventId);
        navigator.clipboard.writeText(noteId).then(() => {
          setCopied(true);
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
          copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
        }).catch(() => {
          toast({ title: 'Copy failed', description: 'Could not copy to clipboard.', variant: 'destructive' });
        });
      }}
      className={`inline-flex items-center justify-center rounded transition-colors ${
        isSmall
          ? 'h-5 w-5 p-0 hover:bg-muted/50'
          : 'h-8 w-8 p-0 hover:bg-accent hover:text-accent-foreground'
      }`}
      title={copied ? 'Copied!' : 'Copy note ID'}
      aria-label={copied ? 'Copied!' : 'Copy note ID'}
    >
      {copied
        ? <Check className={`${isSmall ? 'h-2.5 w-2.5' : 'h-4 w-4'} text-green-500`} />
        : <Copy className={`${isSmall ? 'h-2.5 w-2.5' : 'h-4 w-4'} text-gray-400`} />}
    </button>
  );
}

/** Delete note button with inline confirmation */
function DeleteNoteButton({ onDelete }: { onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <span className="inline-flex items-center gap-1 text-[10px]">
      <span className="text-red-500 font-medium">Send deletion request to relays?</span>
      <button
        className="px-1.5 py-0.5 rounded bg-red-500 text-white hover:bg-red-600 font-medium"
        onClick={(e) => { e.stopPropagation(); onDelete(); setConfirming(false); }}
      >
        Delete
      </button>
      <button
        className="px-1.5 py-0.5 rounded bg-muted hover:bg-muted/80 text-muted-foreground font-medium"
        onClick={(e) => { e.stopPropagation(); setConfirming(false); }}
      >
        Cancel
      </button>
    </span>
  ) : (
    <button
      className="inline-flex items-center justify-center h-5 w-5 p-0 rounded transition-colors hover:bg-muted/50 text-gray-400 hover:text-red-500"
      onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
      title="Request deletion from relays (to just hide from your corkboard, use the dismiss button instead)"
      aria-label="Request deletion from relays"
    >
      <Trash2 className="h-2.5 w-2.5" />
    </button>
  );
}

// visibleLength and findVisibleCutoff imported from @/lib/textTruncation

/** Expandable nested content: shows 125 visible chars with "show more" spoiler */
// Module-level set of expanded event IDs — survives component unmount/remount
// so autofetch and consolidation don't collapse notes the user is reading.
const expandedEventIds = new Set<string>();

function ExpandableContent({ event, className, blurMedia, inModalContext, onViewThread }: {
  event: NostrEvent; className?: string; blurMedia?: boolean;
  inModalContext?: boolean; onViewThread?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(() => expandedEventIds.has(event.id))

  // Resolve JSON-embedded events (some clients embed quoted posts as JSON in content)
  // so we never truncate or display raw JSON strings
  const resolvedEvent = useMemo(() => {
    if (!event.content.startsWith('{')) return event
    try {
      const parsed = JSON.parse(event.content)
      if (typeof parsed.content === 'string' && typeof parsed.pubkey === 'string' && typeof parsed.kind === 'number') {
        return parsed as NostrEvent
      }
    } catch { /* not JSON */ }
    return event
  }, [event])

  const visLen = visibleLength(resolvedEvent.content)
  const canExpand = visLen > 125

  if (expanded) {
    return (
      <div>
        <SmartNoteContent event={resolvedEvent} className={className} blurMedia={blurMedia} inModalContext={inModalContext} onViewThread={onViewThread} />
        <button type="button" className="text-xs text-primary mt-1 hover:underline" onClick={(e) => { e.stopPropagation(); expandedEventIds.delete(event.id); setExpanded(false) }}>Show less</button>
      </div>
    )
  }

  return (
    <div>
      <NoteContent
        event={visLen > 125
          ? { ...resolvedEvent, content: resolvedEvent.content.slice(0, findVisibleCutoff(resolvedEvent.content, 125)).trimEnd() + '…' }
          : resolvedEvent}
        className={className}
        blurMedia={blurMedia}
      />
      {canExpand && (
        <button type="button" className="text-xs text-primary mt-1 hover:underline" onClick={(e) => { e.stopPropagation(); expandedEventIds.add(event.id); setExpanded(true) }}>Show more</button>
      )}
    </div>
  )
}

interface NoteCardProps {
  note: NostrEvent
  isPinned?: boolean;
  showPinButton?: boolean;
  onPinClick?: () => void;
  onThreadClick?: () => void;
  /** Open thread modal and auto-reply to this note */
  onComment?: () => void;
  /** Open thread modal for a specific event ID (used for embedded note links) */
  onOpenThread?: (eventId: string) => void;
  onZapClick?: () => void;
  /** Called when the user clicks Repost */
  onRepost?: () => void;
  /** Called when the user clicks "Pin to my corkboard" — opens confirmation dialog */
  onPinToBoard?: () => void;
  /** Parent note for replies (the note being replied to) */
  parentNote?: NostrEvent | null;
  /** Whether this note was recently added (for highlighting) */
  isFresh?: boolean;
  /** When true, media is blurred until clicked (saves memory for off-screen notes) */
  blurMedia?: boolean;
  /** When true, skip collapsed/dismissed placeholder rendering (used in saved-for-later section) */
  forceExpanded?: boolean;
  /** When true, shows green/red corner buttons for saved-for-later page (green = minimize, red = dismiss) */
  isOnSavedForLaterPage?: boolean;
  /** When true, note is minimized on saved-for-later page */
  isMinimized?: boolean;
  /** Callback to minimize note on saved-for-later page */
  onMinimize?: () => void;
  /** Callback to expand note on saved-for-later page */
  onExpand?: () => void;
  /** Callback to dismiss note on saved-for-later page */
  onDismiss?: () => void;
  /** When true, highlight as the logged-in user's own note on another corkboard */
  isOwnNote?: boolean;
  /** When true, this is the user's "me" tab — hide own avatar/profile */
  isMeTab?: boolean;
  /** When true, show expanded profile info and "more notes" hover area (discover tab) */
  discoverMode?: boolean;
  /** Called when the user deletes their own note (kind 5) */
  onDelete?: () => void;
  /** When true, a media filter is active — auto-expand content and unblur media */
  mediaFilterActive?: boolean;
  /** Called when a reaction (kind 7) is successfully published — used for optimistic feed insertion */
  onReactionPublished?: (event: NostrEvent) => void;
  /** Aggregated engagement data (reactions, reposts, zaps) for this note */
  engagement?: { reactions: NostrEvent[]; reposts: NostrEvent[]; zaps: NostrEvent[] };
  /** When true, this is an engagement stub (reaction/repost standing in for a missing original) */
  isEngagementStub?: boolean;
  /** Dismiss this note and all associated notes (replies, parent, reactions) */
  onDismissThread?: () => void;
}

/** Compact display of the parent note for replies */
function ParentContext({
  parentNote,
  onViewThread,
  nestedAvatarClass = 'h-4 w-4',
}: {
  parentNote: NostrEvent
  onViewThread?: () => void
  nestedAvatarClass?: string
}) {
  const { data: author, isFetching: isParentAuthorFetching } = useAuthor(parentNote.pubkey)
  const parentProfileLoading = isParentAuthorFetching && !author?.metadata
  const displayName = author?.metadata?.display_name || author?.metadata?.name || (parentProfileLoading ? '' : genUserName(parentNote.pubkey))
  const avatar = optimizeAvatarUrl(author?.metadata?.picture)

  return (
    <div
      className="mb-3 p-2.5 bg-muted/40 rounded-lg border-l-2 border-muted-foreground/30 cursor-pointer hover:bg-muted/60 transition-colors"
      onClick={(e) => {
        e.stopPropagation()
        onViewThread?.()
      }}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <Reply className="h-3 w-3" />
        <span>Replying to</span>
        {parentProfileLoading ? (
          <span className="flex items-center gap-1">
            <Skeleton className={`${nestedAvatarClass} rounded-lg`} />
            <Skeleton className="h-3 w-16" />
          </span>
        ) : (
        <ClickableProfile pubkey={parentNote.pubkey} className="flex items-center gap-1 hover:opacity-80 transition-opacity">
          <Avatar className={nestedAvatarClass}>
            {avatar && <AvatarImage src={avatar} alt={displayName} />}
            <AvatarFallback className="text-[8px]">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="font-medium text-foreground">{displayName}</span>
        </ClickableProfile>
        )}
      </div>
      <ExpandableContent event={parentNote} className="text-xs text-muted-foreground" blurMedia />
    </div>
  )
}

/** Reply header — "npubX replied to npubY:" with small inline avatars + date */
function ReplyContext({
  note,
  parentNote,
  displayName,
  avatarUrl,
  profileLoading,
  formattedDate: _formattedDate,
  clientTag: _clientTag,
  smallAvatarClass,
  isPinned,
  isMeTab,
}: {
  note: NostrEvent
  parentNote: NostrEvent
  displayName: string
  avatarUrl: string | undefined
  profileLoading: boolean
  formattedDate: string
  clientTag: string | null
  smallAvatarClass: string
  isMeTab: boolean
  isPinned: boolean
}) {
  const { data: parentAuthor, isFetching } = useAuthor(parentNote.pubkey)
  const parentLoading = isFetching && !parentAuthor?.metadata
  const parentName = parentAuthor?.metadata?.display_name || parentAuthor?.metadata?.name || (parentLoading ? '' : genUserName(parentNote.pubkey))
  const parentAvatar = optimizeAvatarUrl(parentAuthor?.metadata?.picture)

  return (
    <>
      <div className="flex items-center flex-wrap gap-1.5 text-xs text-muted-foreground">
        {!(isMeTab && isPinned) && (
          profileLoading ? (
            <span className="flex items-center gap-1">
              <Skeleton className={`${smallAvatarClass} rounded-lg`} />
              <Skeleton className="h-3 w-16" />
            </span>
          ) : (
            <ClickableProfile pubkey={note.pubkey} className="flex items-center gap-1 hover:opacity-80 transition-opacity">
              <Avatar className={smallAvatarClass}>
                {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                <AvatarFallback className="text-[8px]">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="font-medium text-foreground">{displayName}</span>
            </ClickableProfile>
          )
        )}
        <Reply className="h-3 w-3" />
        <span>replied to</span>
        {parentLoading ? (
          <span className="flex items-center gap-1">
            <Skeleton className={`${smallAvatarClass} rounded-lg`} />
            <Skeleton className="h-3 w-16" />
          </span>
        ) : (
          <ClickableProfile pubkey={parentNote.pubkey} className="flex items-center gap-1 hover:opacity-80 transition-opacity">
            <Avatar className={smallAvatarClass}>
              {parentAvatar && <AvatarImage src={parentAvatar} alt={parentName} />}
              <AvatarFallback className="text-[8px]">{parentName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="font-medium text-foreground">{parentName}</span>
          </ClickableProfile>
        )}
      </div>
    </>
  )
}

/** Nested parent content shown below the reply — avatar on left, no name */
function ReplyParentContent({
  parentNote,
  onViewThread,
  avatarClass,
  blurMedia,
  onOpenThread,
}: {
  parentNote: NostrEvent
  onViewThread?: () => void
  avatarClass: string
  blurMedia: boolean
  onOpenThread?: (eventId: string) => void
}) {
  const { data: author, isFetching } = useAuthor(parentNote.pubkey)
  const loading = isFetching && !author?.metadata
  const name = author?.metadata?.display_name || author?.metadata?.name || (loading ? '' : genUserName(parentNote.pubkey))
  const avatar = optimizeAvatarUrl(author?.metadata?.picture)

  // For non-text kinds (reactions, reposts), show a descriptive label instead of raw content
  const isReaction = parentNote.kind === 7 || parentNote.kind === 9735
  const isRepostKind = parentNote.kind === 6 || parentNote.kind === 16
  const isTextKind = parentNote.kind === 1 || parentNote.kind === 30023

  return (
    <div
      className="mx-4 mb-2 p-2.5 bg-muted/40 rounded-lg border-l-2 border-muted-foreground/30 cursor-pointer hover:bg-muted/60 transition-colors overflow-hidden"
      onClick={(e) => { e.stopPropagation(); onViewThread?.(); }}
    >
      <div className="float-left mr-2.5 mb-1">
        {loading ? (
          <Skeleton className={`${avatarClass} rounded-lg`} />
        ) : (
          <ClickableProfile pubkey={parentNote.pubkey} className="hover:opacity-80 transition-opacity">
            <Avatar className={avatarClass}>
              {avatar && <AvatarImage src={avatar} alt={name} />}
              <AvatarFallback className="text-[8px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
          </ClickableProfile>
        )}
      </div>
      {isReaction ? (
        <span className="text-2xl leading-none select-none">{parentNote.content === '+' ? '❤️' : parentNote.content === '-' ? '👎' : parentNote.content || '❤️'}</span>
      ) : isRepostKind ? (
        <span className="text-xs text-muted-foreground italic">repost</span>
      ) : isTextKind ? (
        <ExpandableContent event={parentNote} className="text-base" blurMedia={blurMedia} inModalContext={!!onOpenThread} onViewThread={onOpenThread} />
      ) : (
        <ExpandableContent event={parentNote} className="text-base" blurMedia={blurMedia} inModalContext={!!onOpenThread} onViewThread={onOpenThread} />
      )}
    </div>
  )
}

/** Hover-to-reveal panel showing 5 recent notes from an author (discover tab) */
function DiscoverMoreNotes({ pubkey, currentNoteId, onOpenThread }: { pubkey: string; currentNoteId: string; onOpenThread?: (eventId: string) => void }) {
  const [isHovered, setIsHovered] = useState(false)
  const [wasOpened, setWasOpened] = useState(false)
  const { nostr } = useNostr()

  const { data: moreNotes, isLoading } = useQuery<NostrEvent[]>({
    queryKey: ['discover-more', pubkey],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1], authors: [pubkey], limit: 6 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) }
      )
      return events
        .filter((e: NostrEvent) => e.id !== currentNoteId)
        .sort((a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at)
        .slice(0, 5)
    },
    enabled: wasOpened,
    staleTime: 5 * 60 * 1000,
  })

  return (
    <div
      className="mt-1.5"
      onMouseEnter={() => { setIsHovered(true); setWasOpened(true) }}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={(e) => { e.stopPropagation(); setIsHovered(!isHovered); setWasOpened(true) }}
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${isHovered ? 'rotate-180' : ''}`} />
        More from this author
      </button>
      {isHovered && (
        <div className="mt-1.5 space-y-1.5 border-l-2 border-purple-200 dark:border-purple-800 pl-2.5">
          {isLoading ? (
            <div className="text-xs text-muted-foreground py-1">Loading…</div>
          ) : moreNotes && moreNotes.length > 0 ? (
            moreNotes.map(n => (
              <button
                key={n.id}
                className="block w-full text-left text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5 leading-relaxed"
                onClick={(e) => { e.stopPropagation(); onOpenThread?.(n.id) }}
              >
                <span className="text-muted-foreground/60 mr-1.5">{formatTimeAgoCompact(n.created_at)}</span>
                <span className="line-clamp-2">{n.content.slice(0, 140)}{n.content.length > 140 ? '…' : ''}</span>
              </button>
            ))
          ) : (
            <div className="text-xs text-muted-foreground py-1">No other recent notes</div>
          )}
        </div>
      )}
    </div>
  )
}

export const NoteCard = React.memo(function NoteCard({
  note,
  isPinned,
  showPinButton,
  onPinClick,
  onThreadClick,
  onComment,
  onOpenThread,
  onZapClick,
  onRepost,
  onPinToBoard,
  parentNote,
  isFresh,
  blurMedia = false,
  forceExpanded = false,
  isOnSavedForLaterPage = false,
  isMinimized = false,
  isOwnNote = false,
  isMeTab = false,
  discoverMode = false,
  onMinimize,
  onExpand,
  onDismiss,
  onDelete,
  mediaFilterActive = false,
  onReactionPublished,
  engagement,
  isEngagementStub,
  onDismissThread,
}: NoteCardProps) {
  // When a media filter is active, override blurMedia to show all media
  const effectiveBlurMedia = mediaFilterActive ? false : blurMedia;
  const isRss = note.pubkey === 'rss-feed'
  const { data: author, isFetching: isAuthorFetching } = useAuthor(isRss ? undefined : note.pubkey)
  const { isCollapsed, isCollapsedThisSession, isSoftDismissed, toggleCollapsed, dismiss, undoDismiss, canUndoDismiss, isBatchTrigger } = useCollapsedNotes()
  const queryClient = useQueryClient()
  const metadata = author?.metadata
  const profileLoading = !isRss && isAuthorFetching && !metadata
  const formattedDate = useMemo(() => new Date(note.created_at * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), [note.created_at])

  // For RSS items, read feed_name and feed_icon from tags
  const rssFeedName = isRss ? note.tags.find(t => t[0] === 'feed_name')?.[1] : undefined
  const rssFeedIcon = isRss ? note.tags.find(t => t[0] === 'feed_icon')?.[1] : undefined
  const displayName = isRss
    ? (rssFeedName || 'RSS Feed')
    : (metadata?.display_name || metadata?.name || (profileLoading ? '' : genUserName(note.pubkey)))
  const avatarUrl = optimizeAvatarUrl(isRss ? rssFeedIcon : metadata?.picture)
  const collapsed = isCollapsed(note.id)
  const softDismissed = isSoftDismissed(note.id)

  // Reaction publishing (for emoji reaction button on notes)
  const { mutate: publishReaction } = useNostrPublish()
  const { user } = useCurrentUser()
  const { toast: toastReaction } = useToast()
  const [reactionPopoverOpen, setReactionPopoverOpen] = useState(false)
  // Read persisted reaction (survives unmount/remount)
  const [sentReaction, setSentReaction] = useState(() => getUserReaction(note.id) ?? null)

  const handleReact = useCallback((emoji: string, shortcode?: string, url?: string) => {
    if (!user) return
    const relayHint = getRelayCache(note.pubkey)?.[0] || FALLBACK_RELAYS[0] || ''
    const tags: string[][] = [
      ['e', note.id, relayHint],
      ['p', note.pubkey],
    ]
    const content = shortcode ? `:${shortcode}:` : emoji
    if (shortcode && url) {
      tags.push(['emoji', shortcode, url])
    }
    publishReaction(
      { kind: 7, content, tags },
      {
        onSuccess: (event) => {
          const reactionEmoji = shortcode ? `:${shortcode}:` : emoji
          recordUserReaction(note.id, reactionEmoji, url)
          setSentReaction({ emoji: reactionEmoji, url })
          setReactionPopoverOpen(false)
          onReactionPublished?.(event)
        },
        onError: () => toastReaction({ title: 'Reaction failed', variant: 'destructive' }),
      }
    )
  }, [user, note.id, note.pubkey, publishReaction, toastReaction, onReactionPublished])

  // NIP-36 content warning — blur content behind a click-to-reveal gate
  const contentWarning = useMemo(() => note.tags.find(t => t[0] === 'content-warning')?.[1], [note.tags])
  const [cwRevealed, setCwRevealed] = useState(false)

  // Measure card height while expanded so placeholders match exactly
  // Module-level map survives component unmount/remount across tab switches
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!collapsed && !softDismissed && cardRef.current) {
      setCapturedHeight(note.id, cardRef.current.offsetHeight)
    }
  }, [collapsed, softDismissed, note.id])

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Capture height right before dismissing
    if (cardRef.current) setCapturedHeight(note.id, cardRef.current.offsetHeight)
    dismiss(note.id)
  }

  // Detect reply from the note's own tags — don't depend on parentNote being loaded yet
  // Extract client tag for display
  const clientTag = useMemo(() => note.tags.find(t => t[0] === 'client')?.[1] || null, [note.tags])

  const isReply = useMemo(() => {
    if (note.kind !== 1) return false
    const hasQTags = note.tags.some(t => t[0] === 'q')
    if (hasQTags) return false
    // Only e-tags without a marker or with "reply"/"root" markers count as replies.
    // e-tags with "mention" marker are inline references, not reply threading.
    const hasReplyETags = note.tags.some(t => t[0] === 'e' && (!t[3] || t[3] === 'reply' || t[3] === 'root'))
    return hasReplyETags
  }, [note.kind, note.tags])
  const isRepost = note.kind === 6 || note.kind === 16
  const isReaction = note.kind === 7 || note.kind === 9735
  const isZap = note.kind === 9735
  const isHighlight = note.kind === 9802

  // Avatar sizes — 3 tiers: small (reactions), medium (reply/repost), large (original/corner)
  // Me tab pinned: uniform medium for any avatar shown; Discover: unchanged
  const isMePinned = isMeTab && isPinned;
  const smallAvatarClass = isMePinned ? 'h-8 w-8' : discoverMode ? 'h-4 w-4' : 'h-6 w-6';
  const mediumAvatarClass = isMePinned ? 'h-8 w-8' : discoverMode ? 'h-10 w-10' : 'h-[62px] w-[62px]';
  const _repostAvatarClass = isMePinned ? 'h-8 w-8' : discoverMode ? 'h-10 w-10' : 'h-9 w-9';
  const _nestedAvatarClass = isMePinned ? 'h-8 w-8' : discoverMode ? 'h-4 w-4' : 'h-8 w-8';

  const { nostr } = useNostr()

  // For reactions, get the event ID being reacted to
  const reactionTargetId = useMemo(() => {
    if (!isReaction) return null
    const eTag = note.tags.find(t => t[0] === 'e')
    return eTag?.[1] || null
  }, [isReaction, note.tags])

  // Extract relay hints and author pubkey from the reaction's p/e tags
  const reactionHints = useMemo(() => {
    if (!isReaction) return { hints: [] as string[], authorPubkey: undefined as string | undefined }
    const hints = note.tags.filter(t => t[0] === 'e' && t[2]).map(t => t[2]).filter(Boolean)
    const authorPubkey = note.tags.find(t => t[0] === 'p')?.[1]
    return { hints, authorPubkey }
  }, [isReaction, note.tags])

  // Fetch the event being reacted to using outbox model
  const { data: reactedToEvent, isError: reactedToError, isFetching: reactedToFetching } = useQuery({
    queryKey: ['reaction-target-outbox', reactionTargetId],
    queryFn: async () => {
      if (!reactionTargetId) throw new Error('no target')
      const event = await fetchEventWithOutbox(reactionTargetId, nostr, {
        hints: reactionHints.hints,
        authorPubkey: reactionHints.authorPubkey,
      })
      if (!event) throw new Error('event not found')
      return event
    },
    enabled: !!reactionTargetId,
    staleTime: 5 * 60 * 1000, // retry after 5 min if previously not found
    retry: 5,
    retryDelay: (attempt) => [2000, 5000, 15000, 30000, 60000][attempt] ?? 60000,
  })

  // Fetch the full ancestor chain above the reacted-to event (so we show the whole thread context)
  // Get the author of the reacted-to note
  const { data: reactedToAuthor, isFetching: isReactedToAuthorFetching } = useAuthor(reactedToEvent?.pubkey || '')
  const reactedToProfileLoading = isReactedToAuthorFetching && !reactedToAuthor?.metadata
  const reactedToDisplayName = reactedToAuthor?.metadata?.display_name ||
    reactedToAuthor?.metadata?.name ||
    (reactedToProfileLoading ? '' : (reactedToEvent?.pubkey ? genUserName(reactedToEvent.pubkey) : ''))

  // For reposts, try to parse the embedded event from content.
  // Unwrap nested reposts (kind 16 → kind 6 → kind 1) to find the original note.
  const parsedRepost = useMemo(() => {
    if (!isRepost) return null
    let content = note.content
    for (let depth = 0; depth < 3; depth++) {
      if (!content || !content.startsWith('{')) return null
      try {
        const parsed = JSON.parse(content)
        if (parsed.content === undefined || !parsed.pubkey) return null
        // If the parsed event is itself a repost, unwrap one more level
        if (parsed.kind === 6 || parsed.kind === 16) {
          content = parsed.content
          continue
        }
        return parsed as NostrEvent
      } catch {
        return null
      }
    }
    return null
  }, [isRepost, note.content])

  // If content didn't contain the event, fetch it via the e tag.
  // Also check if content is a nostr: identifier (some clients like Ditto use this format).
  const repostTargetId = useMemo(() => {
    if (!isRepost || parsedRepost) return null
    // Check e-tag first (standard NIP-18)
    const eTag = note.tags.find(t => t[0] === 'e')
    if (eTag?.[1]) return eTag[1]
    // Fallback: extract event ID from nostr: identifier in content
    const nostrMatch = note.content?.match(/(?:nostr:)?(note1|nevent1)[a-zA-Z0-9]+/)
    if (nostrMatch) {
      try {
        const decoded = nip19.decode(nostrMatch[0].replace('nostr:', ''))
        if (decoded.type === 'note') return decoded.data as string
        if (decoded.type === 'nevent') return (decoded.data as { id: string }).id
      } catch { /* ignore decode errors */ }
    }
    return null
  }, [isRepost, parsedRepost, note.content, note.tags])

  const repostHints = useMemo(() => {
    if (!isRepost) return { hints: [] as string[], authorPubkey: undefined as string | undefined }
    const hints = note.tags.filter(t => t[0] === 'e' && t[2]).map(t => t[2]).filter(Boolean)
    const authorPubkey = note.tags.find(t => t[0] === 'p')?.[1]
    return { hints, authorPubkey }
  }, [isRepost, note.tags])

  const { data: fetchedRepost, isFetching: repostFetching } = useQuery({
    queryKey: ['repost-event', repostTargetId],
    queryFn: async () => {
      if (!repostTargetId) throw new Error('no target')
      const event = await fetchEventWithOutbox(repostTargetId, nostr, {
        hints: repostHints.hints,
        authorPubkey: repostHints.authorPubkey,
      })
      if (!event) throw new Error('event not found')
      return event
    },
    enabled: !!repostTargetId,
    staleTime: 5 * 60 * 1000,
    retry: 5,
    retryDelay: (attempt) => [2000, 5000, 15000, 30000, 60000][attempt] ?? 60000,
  })

  const repostedEvent = parsedRepost || fetchedRepost || null

  // Get the original author for reposts
  const { data: repostedAuthor, isFetching: isRepostedAuthorFetching } = useAuthor(repostedEvent?.pubkey || '')
  const repostedProfileLoading = isRepostedAuthorFetching && !repostedAuthor?.metadata
  const repostedDisplayName = repostedAuthor?.metadata?.display_name ||
    repostedAuthor?.metadata?.name ||
    (repostedProfileLoading ? '' : (repostedEvent?.pubkey ? genUserName(repostedEvent.pubkey) : ''))

  // For reactions/reposts, open the thread of the original note, not the wrapper
  const threadTargetId = isReaction ? (reactedToEvent?.id || note.id)
    : isRepost ? (repostedEvent?.id || note.id)
    : note.id

  // In discover mode, when the note was posted by a user the viewer already follows
  // AND it is a repost or reaction, feature the *original* author in the large profile
  // section so the viewer can discover new people — not the one they already follow.
  const isFollowedActivityInDiscover =
    discoverMode &&
    (isRepost || isReaction) &&
    profileModalState.contacts.includes(note.pubkey)
  const discoverFeaturedPubkey = isFollowedActivityInDiscover
    ? (repostedEvent?.pubkey ?? reactedToEvent?.pubkey ?? note.pubkey)
    : note.pubkey
  const discoverFeaturedMeta = isFollowedActivityInDiscover
    ? (isRepost ? repostedAuthor?.metadata : reactedToAuthor?.metadata) ?? null
    : metadata ?? null
  const discoverFeaturedDisplayName = isFollowedActivityInDiscover
    ? (isRepost ? repostedDisplayName : reactedToDisplayName) || discoverFeaturedPubkey.slice(0, 8)
    : displayName
  const discoverFeaturedAvatarUrl = isFollowedActivityInDiscover
    ? optimizeAvatarUrl(discoverFeaturedMeta?.picture)
    : avatarUrl

  const placeholderStyle = capturedHeights.has(note.id) ? { height: capturedHeights.get(note.id) } : { minHeight: 40 }

  // Soft-dismissed placeholder — blank card at exact original height
  if (softDismissed && !forceExpanded) {
    const canUndo = canUndoDismiss(note.id)
    const isTrigger = isBatchTrigger(note.id)
    const undoLabel = canUndo ? (isTrigger ? 'undo all' : 'undo') : 'dismissed'
    return (
      <Card
        className={`border-dashed border-muted-foreground/15 bg-transparent flex items-center justify-center ${canUndo ? 'cursor-pointer hover:bg-accent/20 transition-colors' : ''}`}
        style={placeholderStyle}
        onClick={canUndo ? () => undoDismiss(note.id) : undefined}
      >
        <span className="text-[11px] text-muted-foreground/30 select-none">{undoLabel}</span>
      </Card>
    )
  }

  // Collapsed placeholder — blank card at exact original height (saved for later)
  // Only show placeholder if the note was collapsed during THIS session (not from restore).
  // Restored collapsed notes render normally so they don't create phantom blank spots.
  if (collapsed && !forceExpanded && isCollapsedThisSession(note.id)) {
    return (
      <Card className="border-dashed border-muted-foreground/15 bg-transparent flex items-center justify-center cursor-pointer hover:bg-accent/20 transition-colors" style={placeholderStyle} onClick={() => toggleCollapsed(note.id)} title="Click to expand">
        <span className="text-[11px] text-muted-foreground/30 select-none">saved for later</span>
      </Card>
    )
  }

  return (
    <div ref={cardRef} data-note-id={note.id} style={{ containerType: 'inline-size' }}>
    <Card
      className={`relative cursor-pointer hover:bg-accent/50 transition-colors group/card overflow-hidden ${isPinned ? 'border-orange-500 dark:border-orange-400' : ''} ${isOwnNote ? 'border-2 border-orange-500 dark:border-orange-400' : ''} ${isFresh ? 'border-purple-500 dark:border-purple-400 bg-purple-50/50 dark:bg-purple-950/30' : ''}`}
      onClick={(e) => {
        // Don't open thread modal when clicking links or interactive elements inside the card
        const target = e.target as HTMLElement
        if (target.closest('a, button, iframe, video, input')) return
        // If user selected text (drag-to-copy), don't open thread
        const selection = window.getSelection()
        if (selection && selection.toString().trim().length > 0) return
        // On saved-for-later page, clicking minimized note should expand it instead of opening thread
        if (isOnSavedForLaterPage && isMinimized) {
          onExpand?.()
          return
        }
        // For reactions/reposts, open thread of the original note
        if (onOpenThread) { onOpenThread(threadTargetId) } else { onThreadClick?.() }
      }}
    >
      {/* Save for later / Minimize — green corner, top-left */}
      {/* Show on normal cards (not forceExpanded) OR on saved-for-later page */}
      {(!forceExpanded || isOnSavedForLaterPage) && (
        <button
          className={`absolute top-0 left-0 w-11 h-11 transition-opacity z-20 ${isOnSavedForLaterPage ? 'opacity-100' : 'opacity-40 group-hover/card:opacity-100'}`}
          onClick={(e) => {
            e.stopPropagation()
            if (isOnSavedForLaterPage) {
              if (isMinimized) {
                onExpand?.()
              } else {
                onMinimize?.()
              }
            } else {
              if (cardRef.current) setCapturedHeight(note.id, cardRef.current.offsetHeight)
              toggleCollapsed(note.id)
            }
          }}
          title={isOnSavedForLaterPage ? (isMinimized ? "Expand note" : "Minimize note") : "Save for later"}
          aria-label={isOnSavedForLaterPage ? (isMinimized ? "Expand note" : "Minimize note") : "Save for later"}
        >
          <div className="w-0 h-0 border-t-[44px] border-r-[44px] border-t-green-500 border-r-transparent active:border-t-green-400 md:hover:border-t-green-400 transition-colors" />
        </button>
      )}

      {/* Dismiss — red corner, top-right */}
      {/* Show on normal cards (not forceExpanded) OR on saved-for-later page */}
      {(!forceExpanded || isOnSavedForLaterPage) && (
        <button
          className={`absolute top-0 right-0 w-11 h-11 transition-opacity z-20 ${isOnSavedForLaterPage ? 'opacity-100' : 'opacity-40 group-hover/card:opacity-100'}`}
          onClick={(e) => {
            e.stopPropagation()
            if (isOnSavedForLaterPage) {
              onDismiss?.()
            } else {
              handleDismiss(e)
            }
          }}
          title="Dismiss note"
          aria-label="Dismiss note"
        >
          <div className="w-0 h-0 border-t-[44px] border-l-[44px] border-t-red-500 border-l-transparent active:border-t-red-400 md:hover:border-t-red-400 transition-colors" />
        </button>
      )}

      {isPinned && (
        <Badge
          variant="secondary"
          className="absolute top-2 right-14 z-10 bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200 border-orange-500 dark:border-orange-400"
        >
          <PinIcon className="h-3 w-3 mr-1" />
          Pinned
        </Badge>
      )}

      {!isMinimized && (
      <CardHeader className={`flex flex-col gap-2 pb-2 ${discoverMode ? 'p-0' : 'pt-8'}`}>
        {/* Reaction context — small avatars, date, then nested content with emoji overlay */}
        {/* In discover mode, reactions are handled by the large profile section instead */}
        {!discoverMode && isReaction && reactedToEvent && (() => {
          const reaction = note.content || '❤️';
          // NIP-30 custom emoji: content is :shortcode:, look up URL from emoji tag
          const customEmojiMatch = reaction.match(/^:([^:]+):$/);
          const customEmojiUrl = customEmojiMatch
            ? note.tags.find(t => t[0] === 'emoji' && t[1] === customEmojiMatch[1])?.[2]
            : undefined;
          // Displayable as icon: standard emoji, +/-, or custom emoji with URL
          const isStandardEmoji = reaction === '+' || reaction === '-' || reaction === '❤️'
            || (/^\p{Emoji_Presentation}(\u{FE0F}|\u{200D}\p{Emoji_Presentation})*$/u.test(reaction) && [...reaction].length <= 4);
          const isDisplayableIcon = isStandardEmoji || !!customEmojiUrl;
          return (
          <>
            <div className="flex items-center flex-wrap gap-1.5 text-xs text-muted-foreground">
              {!isMeTab && (
                profileLoading ? (
                  <span className="flex items-center gap-1">
                    <Skeleton className={`${smallAvatarClass} rounded-lg`} />
                    <Skeleton className="h-3 w-16" />
                  </span>
                ) : (
                  <ClickableProfile pubkey={note.pubkey} className="flex items-center gap-1 hover:opacity-80 transition-opacity">
                    <Avatar className={smallAvatarClass}>
                      {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                      <AvatarFallback className="text-[8px]">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <EmojiName name={displayName} event={author?.event} className="font-medium text-foreground" />
                  </ClickableProfile>
                )
              )}
              <Heart className="h-3 w-3 text-pink-500" />
              <span>reacted{!isDisplayableIcon ? ` ${reaction}` : ''} to</span>
              {reactedToProfileLoading ? (
                <span className="flex items-center gap-1">
                  <Skeleton className={`${smallAvatarClass} rounded-lg`} />
                  <Skeleton className="h-3 w-16" />
                </span>
              ) : (
                <ClickableProfile pubkey={reactedToEvent.pubkey} className="flex items-center gap-1 hover:opacity-80 transition-opacity">
                  <Avatar className={smallAvatarClass}>
                    {reactedToAuthor?.metadata?.picture && <AvatarImage src={optimizeAvatarUrl(reactedToAuthor.metadata.picture) || ''} alt={reactedToDisplayName} />}
                    <AvatarFallback className="text-[8px]">{reactedToDisplayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="font-medium text-foreground">{reactedToDisplayName}</span>
                </ClickableProfile>
              )}
            </div>
            <div className="relative mt-1">
              <div className={`p-2.5 bg-muted/40 rounded-lg border-l-2 border-pink-400/50 overflow-hidden ${isDisplayableIcon ? 'pr-12' : ''}`}>
                <div className="float-left mr-2.5 mb-1">
                  {reactedToProfileLoading ? (
                    <Skeleton className={`${mediumAvatarClass} rounded-lg`} />
                  ) : (
                    <ClickableProfile pubkey={reactedToEvent.pubkey} className="hover:opacity-80 transition-opacity">
                      <Avatar className={mediumAvatarClass}>
                        {reactedToAuthor?.metadata?.picture && <AvatarImage src={optimizeAvatarUrl(reactedToAuthor.metadata.picture) || ''} alt={reactedToDisplayName} />}
                        <AvatarFallback className="text-xs">{reactedToDisplayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                    </ClickableProfile>
                  )}
                </div>
                <div className="text-sm">
                  {reactedToEvent.content ? (
                    <ExpandableContent event={reactedToEvent} className="text-base" blurMedia={effectiveBlurMedia} inModalContext={!!onOpenThread} onViewThread={onOpenThread} />
                  ) : (
                    <span className="text-muted-foreground italic">no content</span>
                  )}
                </div>
              </div>
              {isDisplayableIcon && (
                customEmojiUrl ? (
                  <img
                    src={customEmojiUrl}
                    alt={reaction}
                    className="absolute -top-4 -right-2 h-10 w-10 drop-shadow-md select-none object-contain"
                  />
                ) : (
                  <span className="absolute -top-4 -right-2 text-4xl drop-shadow-md select-none">
                    {reaction === '+' ? '👍' : reaction === '-' ? '👎' : reaction}
                  </span>
                )
              )}
            </div>
          </>
          );
        })()}
        {/* Fallback when reaction target not found or no e tag */}
        {!discoverMode && isReaction && !reactedToEvent && (
          <div className="mb-3 p-2.5 bg-muted/40 rounded-lg border-l-2 border-pink-400/50">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="text-base">{note.content || '❤️'}</span>
              <Heart className="h-3 w-3 text-pink-500" />
              {reactionTargetId ? (
                <>
                  <span className="italic">{reactedToFetching ? 'Retrying…' : reactedToError ? 'Note not found' : 'Loading reacted note...'}</span>
                  {reactionHints.hints.length > 0 && reactedToError && (
                    <span className="text-[10px] text-muted-foreground/40 font-mono">{reactionHints.hints.map(r => r.replace(/^wss?:\/\//, '')).join(', ')}</span>
                  )}
                  <button type="button" onClick={(e) => { e.stopPropagation(); queryClient.invalidateQueries({ queryKey: ['reaction-target-outbox', reactionTargetId] }) }} className="p-0.5 hover:text-foreground transition-colors" title="Retry"><RotateCw className={`h-3 w-3${reactedToFetching ? ' animate-spin' : ''}`} /></button>
                </>
              ) : (
                <span className="italic">Reaction (no target)</span>
              )}
            </div>
          </div>
        )}

        {/* Reply context — "npubX replied to npubY:" with small avatars, date below */}
        {!discoverMode && isReply && parentNote && (
          <ReplyContext
            note={note}
            parentNote={parentNote}
            displayName={displayName}
            avatarUrl={avatarUrl}
            profileLoading={profileLoading}
            formattedDate={formattedDate}
            clientTag={clientTag}
            smallAvatarClass={smallAvatarClass}
            isMeTab={isMeTab}
            isPinned={!!isPinned}
          />
        )}
        {/* Loading skeleton when we know it's a reply but parent data hasn't arrived yet */}
        {!discoverMode && isReply && !parentNote && (
          <div className="mb-3 p-2.5 bg-muted/40 rounded-lg border-l-2 border-muted-foreground/30">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Reply className="h-3 w-3" />
              <span>Replying to</span>
              <Skeleton className="h-4 w-4 rounded-lg" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-3 w-3/4 mt-1" />
          </div>
        )}

        {/* Main note header */}
        {discoverMode && !isRss ? (
          <>
            {/* Discover layout: large square avatar flush top-left, info beside it */}
            {/* When the note is a repost/reaction from a followed user, feature the original author */}
            {isFollowedActivityInDiscover && (
              <div className="flex items-center gap-1.5 px-3 pt-2 text-xs text-muted-foreground">
                <ClickableProfile pubkey={note.pubkey} className="flex items-center gap-1 hover:opacity-80 transition-opacity">
                  <Avatar className="h-4 w-4">
                    {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                    <AvatarFallback className="text-[8px]">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="font-medium text-foreground">{displayName}</span>
                </ClickableProfile>
                <span>{isRepost ? 'reposted' : 'reacted'}</span>
              </div>
            )}
            <div className="flex items-stretch">
              <div className="relative shrink-0 group/avatar">
                <ClickableProfile pubkey={discoverFeaturedPubkey} className="hover:opacity-80 transition-opacity">
                  <div className="h-40 w-40 overflow-hidden rounded-tl-lg">
                    {profileLoading ? (
                      <Skeleton className="h-full w-full" />
                    ) : discoverFeaturedAvatarUrl ? (
                      <img src={discoverFeaturedAvatarUrl} alt={discoverFeaturedDisplayName} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="h-full w-full bg-muted flex items-center justify-center text-2xl font-bold text-muted-foreground">
                        {discoverFeaturedDisplayName.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                  </div>
                </ClickableProfile>
                {!profileModalState.contacts.includes(discoverFeaturedPubkey) && (
                  <button
                    className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-1 py-1.5 bg-purple-600/90 hover:bg-purple-500 text-white text-xs font-semibold transition-all sm:opacity-0 sm:group-hover/avatar:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      window.dispatchEvent(new CustomEvent(PROFILE_ACTION_FOLLOW, { detail: { pubkey: discoverFeaturedPubkey } }));
                    }}
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    Follow
                  </button>
                )}
              </div>
              <div className="flex-1 min-w-0 p-3 pt-2 flex flex-col justify-between">
                <div>
                  {profileLoading ? (
                    <Skeleton className="h-5 w-32 mb-1" />
                  ) : (
                  <ClickableProfile pubkey={discoverFeaturedPubkey} className="hover:opacity-80 transition-opacity">
                    <h3 className="font-semibold text-base"><EmojiName name={discoverFeaturedDisplayName} event={isFollowedActivityInDiscover ? undefined : author?.event} /></h3>
                  </ClickableProfile>
                  )}
                  {discoverFeaturedMeta?.nip05 && (
                    <div className="flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 mt-0.5">
                      <BadgeCheck className="h-3 w-3 shrink-0" />
                      <span className="truncate">{discoverFeaturedMeta.nip05}</span>
                    </div>
                  )}
                  {discoverFeaturedMeta?.about && (
                    <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed mt-1">{discoverFeaturedMeta.about}</p>
                  )}
                  {discoverFeaturedMeta?.website && (
                    <div className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 mt-0.5">
                      <Globe className="h-3 w-3 shrink-0" />
                      <span className="truncate">{discoverFeaturedMeta.website.replace(/^https?:\/\//, '')}</span>
                    </div>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground/60 mt-1">
                  {formattedDate} | {formatTimeAgoCompact(note.created_at)}
                  {clientTag && <span> · {clientTag}</span>}
                </p>
              </div>
            </div>
            {/* Reply parent context nested under profile info in discover mode */}
            {isReply && parentNote && (
              <div className="px-4 pt-2">
                <ParentContext
                  parentNote={parentNote}
                  onViewThread={onThreadClick}
                />
              </div>
            )}
            {isReply && !parentNote && (
              <div className="px-4 pt-2">
                <div className="mb-3 p-2.5 bg-muted/40 rounded-lg border-l-2 border-muted-foreground/30">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <Reply className="h-3 w-3" />
                    <span>Replying to</span>
                    <Skeleton className="h-4 w-4 rounded-full" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                  <Skeleton className="h-3 w-3/4 mt-1" />
                </div>
              </div>
            )}
            {/* More from this author — uses featured pubkey so we show the original author */}
            <div className="px-4">
              <DiscoverMoreNotes pubkey={discoverFeaturedPubkey} currentNoteId={note.id} onOpenThread={onOpenThread} />
            </div>
            <hr className="border-border/50" />
          </>
        ) : (
          <>
        {/* Standard note header — avatar + name + metadata (skip for types that render their own header) */}
        {!(!discoverMode && (isReaction || isRepost || (isReply && parentNote))) && (() => {
          const hideAvatar = (isMeTab && isPinned) || isReaction || isRepost || (isReply && !discoverMode);
          const isOriginal = !isReply && !isRepost && !isReaction && !hideAvatar && !discoverMode;
          return (
        <>
          {/* Non-original: inline avatar + name row */}
          {!isOriginal && !hideAvatar && (
            <div className="flex flex-row items-start space-x-3">
              {isRss ? (
                <Avatar className={`${isRepost ? smallAvatarClass : mediumAvatarClass} shrink-0`}>
                  {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                  <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
              ) : profileLoading ? (
                <Skeleton className={`${isRepost ? smallAvatarClass : mediumAvatarClass} rounded-lg shrink-0`} />
              ) : (
                <ClickableProfile pubkey={note.pubkey} className="hover:opacity-80 transition-opacity shrink-0">
                  <Avatar className={isRepost ? smallAvatarClass : mediumAvatarClass}>
                    {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                    <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                </ClickableProfile>
              )}
              <div className="flex-1">
                <div className="flex items-center space-x-2">
                  {isRss ? (
                    <h3 className="font-semibold">{displayName}</h3>
                  ) : profileLoading ? (
                    <Skeleton className="h-4 w-24" />
                  ) : (
                    <ClickableProfile pubkey={note.pubkey} className="hover:opacity-80 transition-opacity">
                      <h3 className={isRepost ? 'text-xs font-medium text-muted-foreground' : 'font-semibold'}><EmojiName name={displayName} event={author?.event} /></h3>
                    </ClickableProfile>
                  )}
              {isRss && (
                <Badge variant="outline" className="text-xs gap-1 text-orange-600 dark:text-orange-400 border-orange-300 dark:border-orange-700">
                  <Rss className="h-3 w-3" />
                  RSS
                </Badge>
              )}
              {note.kind === 30023 && (
                <Badge variant="secondary" className="text-xs">
                  Long-form
                </Badge>
              )}
              {isZap && (
                <Badge variant="outline" className="text-xs gap-1 text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-700">
                  <Zap className="h-3 w-3" />
                  {(() => {
                    const bolt11 = note.tags.find(t => t[0] === 'bolt11')?.[1];
                    if (bolt11) {
                      const amountMatch = bolt11.match(/lnbc(\d+)([munp]?)/i);
                      if (amountMatch) {
                        const [, num, unit] = amountMatch;
                        const multipliers: Record<string, number> = { '': 1e8, 'm': 1e5, 'u': 100, 'n': 0.1, 'p': 0.001 };
                        const sats = Math.round(parseInt(num) * (multipliers[unit] || 1));
                        return sats >= 1000 ? `${(sats / 1000).toFixed(sats % 1000 === 0 ? 0 : 1)}k sats` : `${sats} sats`;
                      }
                    }
                    return 'Zapped';
                  })()}
                </Badge>
              )}
              {isHighlight && (
                <Badge variant="outline" className="text-xs gap-1 text-yellow-600 dark:text-yellow-400 border-yellow-300 dark:border-yellow-700">
                  <Highlighter className="h-3 w-3" />
                  Highlight
                </Badge>
              )}
            </div>
          </div>
          <div />
        </div>
          )}
        </>
          );
        })()}
          </>
        )}

        {/* Repost context — suppressed in discover mode (discover profile section handles it) */}
        {!discoverMode && isRepost && repostedEvent && (isMeTab ? (
          /* Me tab reposts: pinned → show content only (badge says "Pinned"); unpinned → "repost from" header */
          isPinned ? (
            /* Pinned repost on me tab: show original author profile + content (no "repost from" framing) */
            <>
              <div className="flex flex-row items-start space-x-3 mb-1">
                {repostedProfileLoading ? (
                  <Skeleton className={`${mediumAvatarClass} rounded-lg shrink-0`} />
                ) : (
                  <ClickableProfile pubkey={repostedEvent.pubkey} className="hover:opacity-80 transition-opacity shrink-0">
                    <Avatar className={mediumAvatarClass}>
                      {repostedAuthor?.metadata?.picture && <AvatarImage src={optimizeAvatarUrl(repostedAuthor.metadata.picture) || ''} alt={repostedDisplayName} />}
                      <AvatarFallback>{repostedDisplayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                  </ClickableProfile>
                )}
                <div className="flex-1">
                  {repostedProfileLoading ? (
                    <Skeleton className="h-4 w-24" />
                  ) : (
                    <ClickableProfile pubkey={repostedEvent.pubkey} className="hover:opacity-80 transition-opacity">
                      <h3 className="font-semibold"><EmojiName name={repostedDisplayName} event={repostedAuthor?.event} /></h3>
                    </ClickableProfile>
                  )}
                </div>
              </div>
              <ExpandableContent event={repostedEvent} className="text-base" blurMedia={effectiveBlurMedia} inModalContext={!!onOpenThread} onViewThread={onOpenThread} />
            </>
          ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Repeat2 className="h-3 w-3" />
              <span>Repost from</span>
              {repostedProfileLoading ? (
                <Skeleton className="h-3 w-20" />
              ) : (
                <ClickableProfile pubkey={repostedEvent.pubkey} className="flex items-center gap-1.5 hover:opacity-80 transition-opacity">
                  <Avatar className="h-6 w-6">
                    {repostedAuthor?.metadata?.picture && <AvatarImage src={optimizeAvatarUrl(repostedAuthor.metadata.picture) || ''} alt={repostedDisplayName} />}
                    <AvatarFallback className="text-[8px]">{repostedDisplayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="font-medium text-foreground">{repostedDisplayName}</span>
                </ClickableProfile>
              )}
            </div>
            <ExpandableContent event={repostedEvent} className="text-base" blurMedia={effectiveBlurMedia} inModalContext={!!onOpenThread} onViewThread={onOpenThread} />
          </>
          )
        ) : (
          /* Other tabs: "xnpub reposted" header then card-style embedded content */
          <>
            <div className="flex items-center flex-wrap gap-1.5 text-xs text-muted-foreground">
              {profileLoading ? (
                <span className="flex items-center gap-1">
                  <Skeleton className={`${smallAvatarClass} rounded-lg`} />
                  <Skeleton className="h-3 w-16" />
                </span>
              ) : (
                <ClickableProfile pubkey={note.pubkey} className="flex items-center gap-1 hover:opacity-80 transition-opacity">
                  <Avatar className={smallAvatarClass}>
                    {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                    <AvatarFallback className="text-[8px]">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <EmojiName name={displayName} event={author?.event} className="font-medium text-foreground" />
                </ClickableProfile>
              )}
              <Repeat2 className="h-3 w-3" />
              <span>reposted</span>
            </div>
            <Card className="mt-1">
              <CardHeader className="pb-2 flex flex-row items-center gap-3">
                {repostedProfileLoading ? (
                  <span className="flex items-center gap-3">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <div className="flex flex-col gap-1">
                      <Skeleton className="h-4 w-[100px]" />
                      <Skeleton className="h-3 w-[60px]" />
                    </div>
                  </span>
                ) : (
                  <ClickableProfile pubkey={repostedEvent.pubkey} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                    <Avatar className="h-8 w-8">
                      {repostedAuthor?.metadata?.picture && <AvatarImage src={optimizeAvatarUrl(repostedAuthor.metadata.picture) || ''} alt={repostedDisplayName} />}
                      <AvatarFallback>{repostedDisplayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      <span className="font-medium text-sm">{repostedDisplayName}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(repostedEvent.created_at * 1000).toLocaleDateString()}
                      </span>
                    </div>
                  </ClickableProfile>
                )}
              </CardHeader>
              <CardContent className="pt-0">
                <ExpandableContent event={repostedEvent} className="text-sm" blurMedia={effectiveBlurMedia} inModalContext={!!onOpenThread} onViewThread={onOpenThread} />
              </CardContent>
            </Card>
          </>
        ))}
      </CardHeader>
      )}

      {/* Parent note content for replies — shown above the reply */}
      {!isMinimized && !discoverMode && isReply && parentNote && (
        <ReplyParentContent
          parentNote={parentNote}
          onViewThread={onThreadClick}
          avatarClass={mediumAvatarClass}
          blurMedia={effectiveBlurMedia}
          onOpenThread={onOpenThread}
        />
      )}

      {/* CardContent: only for non-repost/non-reaction notes (repost/reaction content is shown nested above) */}
      {isMinimized ? (
        <CardContent className="py-2 px-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-medium truncate max-w-[100px]">{displayName}</span>
            <span className="text-xs text-muted-foreground truncate flex-1">{note.content.slice(0, 60)}{note.content.length > 60 ? '...' : ''}</span>
          </div>
        </CardContent>
      ) : isRepost ? (
        !repostedEvent ? (
          <CardContent className="pb-2">
            <div className="p-2.5 bg-muted/40 rounded-lg border-l-2 border-muted-foreground/30 flex items-center gap-2">
              <span className="text-xs text-muted-foreground italic">
                {repostTargetId ? (repostFetching ? 'Retrying…' : 'Reposted note not found') : 'Reposted note unavailable'}
              </span>
              {repostTargetId && repostHints.hints.length > 0 && !repostFetching && (
                <span className="text-[10px] text-muted-foreground/40 font-mono">{repostHints.hints.map(r => r.replace(/^wss?:\/\//, '')).join(', ')}</span>
              )}
              {repostTargetId && (
                <button type="button" onClick={(e) => { e.stopPropagation(); queryClient.invalidateQueries({ queryKey: ['repost-event', repostTargetId] }) }} className="p-0.5 text-muted-foreground hover:text-foreground transition-colors" title="Retry"><RotateCw className={`h-3 w-3${repostFetching ? ' animate-spin' : ''}`} /></button>
              )}
            </div>
          </CardContent>
        ) : discoverMode ? (
          /* In discover mode the repost context block is suppressed — show content here */
          <CardContent className="pb-2">
            <ExpandableContent event={repostedEvent} className="text-base" blurMedia={effectiveBlurMedia} inModalContext={!!onOpenThread} onViewThread={onOpenThread} />
          </CardContent>
        ) : null
      ) : isReaction && reactedToEvent ? (
        /* In discover mode the reaction context block is suppressed — show content here instead */
        discoverMode ? (
          <CardContent className="pb-2">
            <ExpandableContent event={reactedToEvent} className="text-base" blurMedia={effectiveBlurMedia} inModalContext={!!onOpenThread} onViewThread={onOpenThread} />
          </CardContent>
        ) : null
      ) : (
        <CardContent className="pb-2">
          {isReply && !discoverMode ? (
            <div className="overflow-hidden">
              <div className="float-left mr-2.5 mb-1">
                {profileLoading ? (
                  <Skeleton className={`${mediumAvatarClass} rounded-lg`} />
                ) : (
                  <ClickableProfile pubkey={note.pubkey} className="hover:opacity-80 transition-opacity">
                    <Avatar className={mediumAvatarClass}>
                      {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                      <AvatarFallback className="text-xs">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                  </ClickableProfile>
                )}
              </div>
              {contentWarning && !cwRevealed ? (
                <button
                  onClick={(e) => { e.stopPropagation(); setCwRevealed(true); }}
                  className="w-full text-left p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
                >
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Content warning{contentWarning ? `: ${contentWarning}` : ''}</p>
                  <p className="text-[10px] text-amber-600/60 dark:text-amber-500/60 mt-0.5">Click to reveal</p>
                </button>
              ) : (
                <SmartNoteContent event={note} className="text-base" blurMedia={effectiveBlurMedia} inModalContext={!!onOpenThread} onViewThread={onOpenThread} forceExpand={mediaFilterActive} />
              )}
            </div>
          ) : contentWarning && !cwRevealed ? (
            <button
              onClick={(e) => { e.stopPropagation(); setCwRevealed(true); }}
              className="w-full text-left p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
            >
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Content warning{contentWarning ? `: ${contentWarning}` : ''}</p>
              <p className="text-[10px] text-amber-600/60 dark:text-amber-500/60 mt-0.5">Click to reveal</p>
            </button>
          ) : !isReply && !discoverMode && !isMeTab ? (
            /* Original content: avatar floated top-left with name beside it, text wraps */
            <div className="overflow-hidden">
              {!isRss && (
                <div className="float-left mr-3 mb-1">
                  {profileLoading ? (
                    <Skeleton className="h-[120px] w-[120px] rounded-tl-lg" />
                  ) : (
                    <ClickableProfile pubkey={note.pubkey} className="hover:opacity-80 transition-opacity">
                      <Avatar className="h-[120px] w-[120px]">
                        {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                        <AvatarFallback className="text-2xl">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                    </ClickableProfile>
                  )}
                </div>
              )}
              {/* Author name — flows to the right of the floated avatar */}
              <div className="mb-1">
                {isRss ? (
                  <h3 className="font-semibold">{displayName}</h3>
                ) : profileLoading ? (
                  <Skeleton className="h-4 w-24" />
                ) : (
                  <ClickableProfile pubkey={note.pubkey} className="hover:opacity-80 transition-opacity">
                    <h3 className="font-semibold"><EmojiName name={displayName} event={author?.event} /></h3>
                  </ClickableProfile>
                )}
              </div>
              <SmartNoteContent event={note} className="text-base" blurMedia={effectiveBlurMedia} inModalContext={!!onOpenThread} onViewThread={onOpenThread} forceExpand={mediaFilterActive} />
            </div>
          ) : (
            <SmartNoteContent event={note} className="text-base" blurMedia={effectiveBlurMedia} inModalContext={!!onOpenThread} onViewThread={onOpenThread} forceExpand={mediaFilterActive} />
          )}
        </CardContent>
      )}


      {/* Date row — visible only when card is too narrow for inline date */}
      {!isMinimized && !discoverMode && (
        <div className="note-date-overflow flex justify-end px-6 pt-1">
          <span className="text-[10px] text-muted-foreground/50">
            {formattedDate} | {formatTimeAgoCompact(note.created_at).replace(/ ago$/, '')}
            {clientTag && <span> · {clientTag}</span>}
          </span>
        </div>
      )}
      {/* Engagement badges (aggregated reactions, reposts, zaps) */}
      {engagement && (engagement.reactions.length > 0 || engagement.reposts.length > 0 || engagement.zaps.length > 0) && !isMinimized && (
        <div className="px-6 pt-1">
          <EngagementBar reactions={engagement.reactions} reposts={engagement.reposts} zaps={engagement.zaps} />
        </div>
      )}
      {/* Action buttons row */}
      {!isMinimized && (
        <div className="flex items-center gap-1 px-6 pb-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1 text-xs text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation()
              if (onComment) { onComment() } else if (onOpenThread) { onOpenThread(threadTargetId) } else { onThreadClick?.() }
            }}
            title="Comment"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
          {!isMeTab && user && (
            sentReaction ? (
              // Show the emoji we reacted with, in place of the picker
              <span
                className="inline-flex items-center justify-center h-7 px-1"
                title="You reacted"
                onClick={(e) => e.stopPropagation()}
              >
                {sentReaction.url ? (
                  <img src={sentReaction.url} alt={sentReaction.emoji} className="h-5 w-5 object-contain" referrerPolicy="no-referrer" />
                ) : (
                  <span className="text-base leading-none">{sentReaction.emoji}</span>
                )}
              </span>
            ) : (
              <Popover open={reactionPopoverOpen} onOpenChange={setReactionPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground"
                    onClick={(e) => e.stopPropagation()}
                    title="React"
                  >
                    <Smile className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-0" align="start" side="top" onClick={(e) => e.stopPropagation()}>
                  <CombinedEmojiPicker
                    onSelectEmoji={(emoji) => handleReact(emoji)}
                    onSelectCustomEmoji={(shortcode, url) => handleReact(`:${shortcode}:`, shortcode, url)}
                  />
                </PopoverContent>
              </Popover>
            )
          )}
          {onZapClick && (() => {
            const zapAmount = userZaps.get(note.id);
            return (
              <Button
                variant="ghost"
                size="sm"
                className={`h-7 px-2 gap-1 text-xs ${zapAmount ? 'text-amber-600' : 'text-muted-foreground'}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onZapClick()
                }}
                title={zapAmount ? `Zapped ${zapAmount} sats` : 'Zap'}
              >
                <Zap className={`h-3.5 w-3.5 ${zapAmount ? 'text-amber-500 fill-amber-500' : ''}`} />
                {zapAmount && <span className="font-medium">{zapAmount >= 1000 ? `${(zapAmount / 1000).toFixed(zapAmount % 1000 === 0 ? 0 : 1)}k` : zapAmount}</span>}
              </Button>
            );
          })()}
          {onRepost && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1 text-xs text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onRepost()
              }}
              title="Repost"
            >
              <Repeat2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {onPinToBoard && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1 text-xs text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onPinToBoard()
              }}
              title={isPinned ? "Re-pin to my corkboard" : "Pin to my corkboard"}
            >
              <Pin className={`h-3.5 w-3.5 ${isPinned ? 'text-orange-500' : ''}`} />
              <span>{isPinned ? 'Re-pin' : 'Pin to board'}</span>
            </Button>
          )}
          {showPinButton && (!onPinToBoard || isPinned) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1 text-xs text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onPinClick?.()
              }}
              title={isPinned ? 'Unpin' : 'Pin'}
            >
              <PinIcon
                className={`h-3.5 w-3.5 ${isPinned ? 'text-orange-500 fill-orange-500' : ''}`}
              />
            </Button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {!discoverMode && (
              <span className="note-date-inline text-[10px] text-muted-foreground/50">
                {formattedDate} | {formatTimeAgoCompact(note.created_at).replace(/ ago$/, '')}
                {clientTag && <span> · {clientTag}</span>}
              </span>
            )}
            <CopyEventIdButton eventId={note.id} size="small" />
            {onDelete && <DeleteNoteButton onDelete={onDelete} />}
          </div>
        </div>
      )}
      {onDismissThread && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDismissThread(); }}
          title="Dismiss this and all associated notes"
          className="absolute bottom-0 right-0 overflow-hidden transition-opacity opacity-40 hover:opacity-90"
          style={{ width: 28, height: 28 }}
        >
          <svg width="28" height="28" viewBox="0 0 28 28">
            <defs>
              <pattern id={`ds-${note.id.slice(0, 8)}`} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(-45)">
                <rect width="2.5" height="5" fill="white" />
                <rect x="2.5" width="2.5" height="5" fill="#ef4444" />
              </pattern>
            </defs>
            <polygon points="0,28 28,0 28,28" fill={`url(#ds-${note.id.slice(0, 8)})`} />
          </svg>
        </button>
      )}
    </Card>
    </div>
  )
})
