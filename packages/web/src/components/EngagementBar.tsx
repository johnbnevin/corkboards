/**
 * EngagementBar — shared engagement display components.
 *
 * Used by both the thread panel (ThreadReplyRow) and the main feed (NoteCard)
 * to show aggregated reactions, reposts, and zaps on notes.
 */
import { useMemo } from 'react'
import type { NostrEvent } from '@nostrify/nostrify'
import { useAuthor } from '@/hooks/useAuthor'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { genUserName } from '@/lib/genUserName'
import { optimizeAvatarUrl } from '@/lib/imageUtils'
import { Repeat2, Zap } from 'lucide-react'

// ── Reactor avatar (used in tooltips) ─────────────────────────────────────

export function ReactorAvatar({ pubkey }: { pubkey: string }) {
  const { data: author } = useAuthor(pubkey)
  const name = author?.metadata?.display_name || author?.metadata?.name || genUserName(pubkey)
  const pic = optimizeAvatarUrl(author?.metadata?.picture)
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <Avatar className="h-4 w-4 shrink-0">
        {pic && <AvatarImage src={pic} />}
        <AvatarFallback className="text-[6px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="text-xs truncate">{name}</span>
    </div>
  )
}

// ── Resolve reaction emoji ────────────────────────────────────────────────

export function resolveReactionEmoji(r: NostrEvent): { key: string; render: React.ReactNode } | null {
  const content = r.content || '+'
  if (content === '+') return { key: '❤️', render: <span className="text-sm leading-none">❤️</span> }
  if (content === '-') return { key: '👎', render: <span className="text-sm leading-none">👎</span> }
  if ([...content].length <= 2) {
    return { key: content, render: <span className="text-sm leading-none">{content}</span> }
  }
  const match = content.match(/^:([a-zA-Z0-9_-]+):$/)
  if (match) {
    const shortcode = match[1]
    const url = r.tags.find(t => t[0] === 'emoji' && t[1] === shortcode)?.[2]
    if (url) {
      return {
        key: `:${shortcode}:`,
        render: <img src={url} alt={`:${shortcode}:`} title={`:${shortcode}:`} className="inline-block h-5 w-5 object-contain align-middle" loading="lazy" referrerPolicy="no-referrer" />,
      }
    }
    return { key: content, render: <span className="text-xs text-muted-foreground px-0.5">:{shortcode}:</span> }
  }
  if (content.length <= 20) {
    return { key: content, render: <span className="text-xs text-muted-foreground px-0.5">{content}</span> }
  }
  return null
}

// ── Reaction badges (grouped by emoji) ────────────────────────────────────

export function ReactionBadges({ reactions, compact }: { reactions: NostrEvent[]; compact?: boolean }) {
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
            <span className={`inline-flex items-baseline cursor-default hover:scale-110 transition-transform ${compact ? 'gap-px' : ''}`}>
              {render}
              {pubkeys.length > 1 && (
                <span className={`text-muted-foreground font-medium -translate-y-1.5 ml-px ${compact ? 'text-[8px]' : 'text-[9px]'}`}>{pubkeys.length}</span>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" align="center" avoidCollisions collisionPadding={8} className="p-2 space-y-1 max-h-40 overflow-y-auto max-w-[200px]">
            {pubkeys.slice(0, 20).map(pk => <ReactorAvatar key={pk} pubkey={pk} />)}
            {pubkeys.length > 20 && <span className="text-xs text-muted-foreground">+{pubkeys.length - 20} more</span>}
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  )
}

// ── Zap amount extraction ─────────────────────────────────────────────────

function getZapAmount(zap: NostrEvent): number {
  // Try to get amount from the zap request embedded in the description tag
  const descTag = zap.tags.find(t => t[0] === 'description')?.[1]
  if (descTag) {
    try {
      const zapRequest = JSON.parse(descTag)
      const amountTag = zapRequest.tags?.find((t: string[]) => t[0] === 'amount')?.[1]
      if (amountTag) return Math.floor(parseInt(amountTag, 10) / 1000) // millisats → sats
    } catch { /* ignore */ }
  }
  // Fallback: check bolt11 for amount (rough parse)
  const bolt11 = zap.tags.find(t => t[0] === 'bolt11')?.[1]
  if (bolt11) {
    const match = bolt11.match(/lnbc(\d+)([munp]?)/)
    if (match) {
      const num = parseInt(match[1], 10)
      const unit = match[2]
      if (unit === 'm') return num * 100_000 // mBTC → sats
      if (unit === 'u') return num * 100      // μBTC → sats
      if (unit === 'n') return Math.floor(num / 10) // nBTC → sats
      if (unit === 'p') return Math.floor(num / 10_000) // pBTC → sats
      return num // assume sats if no unit
    }
  }
  return 0
}

function formatSats(sats: number): string {
  if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(1)}M`
  if (sats >= 1_000) return `${(sats / 1_000).toFixed(sats % 1000 === 0 ? 0 : 1)}k`
  return String(sats)
}

// ── Engagement bar (full row: reactions + reposts + zaps) ─────────────────

export interface EngagementData {
  reactions: NostrEvent[]
  reposts: NostrEvent[]
  zaps: NostrEvent[]
}

export function EngagementBar({ reactions, reposts, zaps }: EngagementData) {
  const totalZapSats = useMemo(() => {
    return zaps.reduce((sum, z) => sum + getZapAmount(z), 0)
  }, [zaps])

  const hasReactions = reactions.length > 0
  const hasReposts = reposts.length > 0
  const hasZaps = zaps.length > 0

  if (!hasReactions && !hasReposts && !hasZaps) return null

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      {hasReactions && <ReactionBadges reactions={reactions} compact />}

      {hasReposts && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-0.5 text-muted-foreground cursor-default hover:text-purple-500 transition-colors">
              <Repeat2 className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium">{reposts.length}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" align="center" avoidCollisions collisionPadding={8} className="p-2 space-y-1 max-h-40 overflow-y-auto max-w-[200px]">
            {reposts.slice(0, 20).map(r => <ReactorAvatar key={r.id} pubkey={r.pubkey} />)}
            {reposts.length > 20 && <span className="text-xs text-muted-foreground">+{reposts.length - 20} more</span>}
          </TooltipContent>
        </Tooltip>
      )}

      {hasZaps && totalZapSats > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-0.5 text-amber-500 cursor-default hover:text-amber-400 transition-colors">
              <Zap className="h-3.5 w-3.5 fill-amber-500" />
              <span className="text-[10px] font-medium">{formatSats(totalZapSats)}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" align="center" avoidCollisions collisionPadding={8} className="p-2 space-y-1 max-h-40 overflow-y-auto max-w-[200px]">
            {zaps.slice(0, 20).map(z => <ReactorAvatar key={z.id} pubkey={z.pubkey} />)}
            {zaps.length > 20 && <span className="text-xs text-muted-foreground">+{zaps.length - 20} more</span>}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
