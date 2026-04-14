import { useState, useCallback, useMemo, memo } from 'react'
import type { NostrEvent } from '@nostrify/nostrify'
import type { ThreadNode } from '@core/threadTree'
import { useAuthor } from '@/hooks/useAuthor'
import { useNostrPublish } from '@/hooks/useNostrPublish'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { SmartNoteContent } from '@/components/SmartNoteContent'
import { ClickableProfile } from '@/components/ProfileModal'
import { genUserName } from '@/lib/genUserName'
import { optimizeAvatarUrl } from '@/lib/imageUtils'
import { EmojiName } from '@/components/EmojiName'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CombinedEmojiPicker } from '@/components/compose/CombinedEmojiPicker'
import { getUserZapAmount, getUserReaction, recordUserReaction, CopyEventIdButton } from '@/components/NoteCard'
import { getRelayCache, FALLBACK_RELAYS } from '@/components/NostrProvider'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Reply, Quote, Repeat2, Zap, Pin, Smile } from 'lucide-react'

const COLLAPSE_THRESHOLD = 280

// ── Collapsible content ────────────────────────────────────────────────────
function CollapsibleContent({ event, onViewThread, className }: {
  event: NostrEvent
  onViewThread?: (eventId: string) => void
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const isLong = event.content.length > COLLAPSE_THRESHOLD

  return (
    <div className={className}>
      <div className={cn(!expanded && isLong && 'max-h-[4.5em] overflow-hidden')}>
        <SmartNoteContent event={event} onViewThread={onViewThread} inModalContext />
      </div>
      {isLong && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v) }}
          className="text-xs text-primary hover:underline mt-0.5"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

// ── Reactor avatar for tooltip ─────────────────────────────────────────────
function ReactorAvatar({ pubkey }: { pubkey: string }) {
  const { data: author } = useAuthor(pubkey)
  const name = author?.metadata?.display_name || author?.metadata?.name || genUserName(pubkey)
  const pic = optimizeAvatarUrl(author?.metadata?.picture)
  return (
    <div className="flex items-center gap-1.5">
      <Avatar className="h-4 w-4">
        {pic && <AvatarImage src={pic} />}
        <AvatarFallback className="text-[6px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="text-xs">{name}</span>
    </div>
  )
}

// ── Resolve reaction emoji ─────────────────────────────────────────────────
function resolveReactionEmoji(r: NostrEvent): { key: string; render: React.ReactNode } | null {
  const content = r.content || '❤️'
  if ([...content].length <= 2) {
    return { key: content, render: <span className="text-lg leading-none">{content}</span> }
  }
  const match = content.match(/^:([a-zA-Z0-9_-]+):$/)
  if (match) {
    const shortcode = match[1]
    const url = r.tags.find(t => t[0] === 'emoji' && t[1] === shortcode)?.[2]
    if (url) {
      return {
        key: `:${shortcode}:`,
        render: <img src={url} alt={`:${shortcode}:`} title={`:${shortcode}:`} className="inline-block h-6 w-6 object-contain align-middle" loading="lazy" referrerPolicy="no-referrer" />,
      }
    }
  }
  return null
}

// ── Reaction badges ────────────────────────────────────────────────────────
function ReactionBadges({ reactions }: { reactions: NostrEvent[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, { pubkeys: string[]; render: React.ReactNode }>()
    for (const r of reactions) {
      const resolved = resolveReactionEmoji(r)
      if (!resolved) continue
      const entry = map.get(resolved.key)
      if (entry) entry.pubkeys.push(r.pubkey)
      else map.set(resolved.key, { pubkeys: [r.pubkey], render: resolved.render })
    }
    return Array.from(map.entries())
  }, [reactions])

  if (groups.length === 0) return null

  return (
    <span className="inline-flex items-center gap-0.5">
      {groups.map(([key, { pubkeys, render }]) => (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <span className="inline-flex items-baseline cursor-default hover:scale-110 transition-transform">
              {render}
              {pubkeys.length > 1 && (
                <span className="text-[9px] text-muted-foreground font-medium -translate-y-1.5 ml-px">{pubkeys.length}</span>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="p-2 space-y-1 max-h-40 overflow-y-auto">
            {pubkeys.slice(0, 20).map(pk => <ReactorAvatar key={pk} pubkey={pk} />)}
            {pubkeys.length > 20 && <span className="text-xs text-muted-foreground">+{pubkeys.length - 20} more</span>}
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  )
}

// ── Main ThreadReplyRow ────────────────────────────────────────────────────
export interface ThreadReplyRowProps {
  node: ThreadNode
  depth: number
  isTarget: boolean
  isCollapsed: boolean
  onToggleCollapse: (eventId: string) => void
  onViewThread?: (eventId: string) => void
  onReply?: (event: NostrEvent) => void
  onQuote?: (event: NostrEvent) => void
  onRepost?: (event: NostrEvent) => void
  onZap?: (event: NostrEvent) => void
  onPinToBoard?: (event: NostrEvent) => void
  onReactionPublished?: (event: NostrEvent) => void
}

export const ThreadReplyRow = memo(function ThreadReplyRow({
  node, depth, isTarget, isCollapsed, onToggleCollapse,
  onViewThread, onReply, onQuote, onRepost, onZap, onPinToBoard, onReactionPublished,
}: ThreadReplyRowProps) {
  const { event, children: childNodes, reactions } = node
  const { data: author } = useAuthor(event.pubkey)
  const metadata = author?.metadata
  const displayName = metadata?.display_name || metadata?.name || genUserName(event.pubkey)
  const hasReplies = childNodes.length > 0
  const isReaction = event.kind === 7

  // Emoji reaction state
  const { mutate: publishReaction } = useNostrPublish()
  const { user } = useCurrentUser()
  const [reactionPopoverOpen, setReactionPopoverOpen] = useState(false)
  const [sentReaction, setSentReaction] = useState(() => getUserReaction(event.id) ?? null)

  const handleReact = useCallback((emoji: string, shortcode?: string, url?: string) => {
    if (!user) return
    const relayHint = getRelayCache(event.pubkey)?.[0] || FALLBACK_RELAYS[0] || ''
    const tags: string[][] = [['e', event.id, relayHint], ['p', event.pubkey]]
    const content = shortcode ? `:${shortcode}:` : emoji
    if (shortcode && url) tags.push(['emoji', shortcode, url])
    publishReaction(
      { kind: 7, content, tags },
      {
        onSuccess: (published) => {
          const reactionEmoji = shortcode ? `:${shortcode}:` : emoji
          recordUserReaction(event.id, reactionEmoji, url)
          setSentReaction({ emoji: reactionEmoji, url })
          setReactionPopoverOpen(false)
          onReactionPublished?.(published)
        },
      }
    )
  }, [user, event.id, event.pubkey, publishReaction, onReactionPublished])

  const formatTime = (timestamp: number) => {
    const diffMs = Date.now() - timestamp * 1000
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)
    if (diffMins < 1) return 'now'
    if (diffMins < 60) return `${diffMins}m`
    if (diffHours < 24) return `${diffHours}h`
    if (diffDays < 7) return `${diffDays}d`
    return new Date(timestamp * 1000).toLocaleDateString()
  }

  return (
    <div
      style={{ paddingLeft: depth > 0 ? `${depth * 12}px` : undefined }}
      data-thread-note-id={event.id}
    >
      <div className={cn(
        depth > 0 && 'border-l border-muted pl-3',
      )}>
        <div className={cn(
          'py-1.5 px-2 rounded transition-colors relative group',
          isTarget ? 'bg-primary/10 border border-primary/30' : 'hover:bg-muted/30',
        )}>
          {/* Header */}
          <div className="flex items-center gap-1.5 text-xs">
            <ClickableProfile pubkey={event.pubkey} className="flex items-center gap-1.5 hover:opacity-80 transition-opacity">
              <Avatar className={cn('h-4 w-4', isTarget && 'h-5 w-5')}>
                {metadata?.picture && <AvatarImage src={metadata.picture} />}
                <AvatarFallback className="text-[8px]">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <EmojiName name={displayName} event={author?.event} className="font-medium" />
            </ClickableProfile>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{formatTime(event.created_at)}</span>

            {hasReplies && (
              <button
                onClick={() => onToggleCollapse(event.id)}
                className="ml-auto flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
              >
                {isCollapsed ? (
                  <><ChevronRight className="h-3 w-3" /><span>{childNodes.length}</span></>
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </button>
            )}
          </div>

          {/* Content */}
          {!isReaction && (
            <div className="text-sm mt-0.5 pl-5">
              <CollapsibleContent event={event} onViewThread={onViewThread} />
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center mt-1 pl-5">
            <div className="flex items-center gap-1">
              {onReply && (
                <button type="button" onClick={(e) => { e.stopPropagation(); onReply(event) }} className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-primary hover:bg-primary/10 rounded transition-colors" title="Reply">
                  <Reply className="h-3 w-3" /><span>Reply</span>
                </button>
              )}
              {onQuote && (
                <button type="button" onClick={(e) => { e.stopPropagation(); onQuote(event) }} className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-purple-500 hover:bg-purple-500/10 rounded transition-colors" title="Quote">
                  <Quote className="h-3 w-3" /><span>Quote</span>
                </button>
              )}
              {onRepost && (
                <button type="button" onClick={(e) => { e.stopPropagation(); onRepost(event) }} className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-purple-500 hover:bg-purple-500/10 rounded transition-colors" title="Repost">
                  <Repeat2 className="h-3 w-3" /><span>Repost</span>
                </button>
              )}
              {onZap && (() => {
                const zapAmt = getUserZapAmount(event.id)
                return (
                  <button type="button" onClick={(e) => { e.stopPropagation(); onZap(event) }} className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors ${zapAmt ? 'text-amber-600 bg-amber-500/10' : 'text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10'}`} title={zapAmt ? `Zapped ${zapAmt} sats` : 'Zap'}>
                    <Zap className={`h-3 w-3 ${zapAmt ? 'fill-amber-500' : ''}`} />
                    <span>{zapAmt ? `${zapAmt >= 1000 ? `${(zapAmt / 1000).toFixed(zapAmt % 1000 === 0 ? 0 : 1)}k` : zapAmt} sats` : 'Zap'}</span>
                  </button>
                )
              })()}
              {onPinToBoard && (
                <button type="button" onClick={(e) => { e.stopPropagation(); onPinToBoard(event) }} className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-orange-500 hover:bg-orange-500/10 rounded transition-colors" title="Pin to corkboard">
                  <Pin className="h-3 w-3" /><span>Pin</span>
                </button>
              )}
              {user && (
                sentReaction ? (
                  <span className="inline-flex items-center px-2 py-0.5" title="You reacted">
                    {sentReaction.url ? (
                      <img src={sentReaction.url} alt={sentReaction.emoji} className="h-5 w-5 object-contain" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="text-lg leading-none">{sentReaction.emoji}</span>
                    )}
                  </span>
                ) : (
                  <Popover open={reactionPopoverOpen} onOpenChange={setReactionPopoverOpen}>
                    <PopoverTrigger asChild>
                      <button className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-pink-500 hover:bg-pink-500/10 rounded transition-colors" title="React" onClick={(e) => e.stopPropagation()}>
                        <Smile className="h-3 w-3" />
                      </button>
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
              <CopyEventIdButton eventId={event.id} size="small" />
            </div>
          </div>

          {/* Reactions */}
          {reactions.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-0.5 pl-5">
              <ReactionBadges reactions={reactions} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
