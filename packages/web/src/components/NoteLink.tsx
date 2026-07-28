import { useState, useMemo, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { nip19 } from 'nostr-tools'
import { useNostr } from '@/hooks/useNostr'
import { useAuthor } from '@/hooks/useAuthor'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ClickableProfile } from '@/components/ProfileModal'
import { genUserName } from '@/lib/genUserName'
import { optimizeAvatarUrl } from '@/lib/imageUtils'
import { ExternalLink, RotateCw } from 'lucide-react'

import { NoteContent } from '@/components/NoteContent'
import { ListingCard } from '@/components/ListingCard'
import { visibleLength, truncateForPreview } from '@/lib/textTruncation'
import { fetchEventWithOutbox, fetchNaddrWithOutbox, getCachedEvent, setCachedEvent } from '@/lib/fetchEvent'
import { registerUnresolved, clearUnresolved } from '@/lib/failedNotes'
import { CopyEventIdButton } from '@/components/NoteCard'
import type { NostrEvent } from '@nostrify/nostrify'

interface NoteLinkProps {
  noteId: string
  /** When true, clicking expands/collapses in-place instead of navigating */
  inlineMode?: boolean
  /** Callback for when user wants to view full thread (only used in inlineMode) */
  onViewThread?: (eventId: string) => void
  /** When true, media is blurred until clicked */
  blurMedia?: boolean
  /** Recursion depth for circular reference prevention */
  depth?: number
}

function getEventIdFromIdentifier(identifier: string): { id?: string; kind?: number; pubkey?: string; identifier?: string; relays?: string[] } {
  try {
    const decoded = nip19.decode(identifier)
    if (decoded.type === 'note') {
      return { id: decoded.data }
    }
    if (decoded.type === 'nevent') {
      return {
        id: decoded.data.id,
        kind: decoded.data.kind,
        relays: decoded.data.relays,
        pubkey: decoded.data.author
      }
    }
    if (decoded.type === 'naddr') {
      return {
        kind: decoded.data.kind,
        pubkey: decoded.data.pubkey,
        identifier: decoded.data.identifier,
        relays: decoded.data.relays
      }
    }
  } catch {
    // Fall through
  }
  return {}
}

// visibleLength and truncateForPreview imported from @/lib/textTruncation

/** Inline expandable content */
function InlineNoteLinkContent({
  event,
  onViewThread,
  blurMedia = true,
  depth = 0,
}: {
  event: NostrEvent
  onViewThread?: (eventId: string) => void
  blurMedia?: boolean
  depth?: number
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const { data: author } = useAuthor(event.pubkey)
  const displayName = author?.metadata?.display_name || author?.metadata?.name || genUserName(event.pubkey)
  const avatar = optimizeAvatarUrl(author?.metadata?.picture)

  // Measure visible text length (excludes nostr refs but keeps URLs)
  const visLen = useMemo(() => visibleLength(event.content), [event.content])
  const isLongContent = visLen > 125

  // When media is fully enabled, render the FULL content rather than a
  // character-truncated copy, so media URLs aren't cut away before MediaLink
  // ever sees them.
  const effectiveExpanded = !blurMedia || isExpanded

  // ...but full content is not the same as unbounded content. A long reply
  // quoted inside another note was rendering at its full height with no spoiler
  // at all, because this branch conflated "show the whole string" with "the
  // user asked to expand it". Only a real expand (`isExpanded`) should remove
  // the height cap; otherwise the content is clipped with a Show more, exactly
  // like SmartNoteContent does for top-level notes.
  const needsSpoiler = effectiveExpanded && !isExpanded && isLongContent

  // stopPropagation: the whole card opens the thread on click, so without it
  // "Show more"/"Show less" expanded the note AND navigated away from it.
  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsExpanded(v => !v)
  }

  const handleViewThread = (e: React.MouseEvent) => {
    e.stopPropagation()
    onViewThread?.(event.id)
  }

  return (
    <Card
      className="mb-2 cursor-pointer hover:bg-accent/30 transition-colors"
      onClick={handleViewThread}
    >
      <CardHeader className="pb-2 flex flex-row items-center gap-3">
        <ClickableProfile pubkey={event.pubkey} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
          <Avatar className="h-8 w-8">
            {avatar && <AvatarImage src={avatar} alt={displayName} />}
            <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span className="font-medium text-sm">{displayName}</span>
            <span className="text-xs text-muted-foreground">
              {new Date(event.created_at * 1000).toLocaleDateString()}
            </span>
          </div>
        </ClickableProfile>
        <div className="flex items-center gap-1 ml-auto">
          <CopyEventIdButton eventId={event.id} size="small" />
          {onViewThread && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={handleViewThread}
              title="View full thread"
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {event.kind === 30402 ? (
          <ListingCard event={event} bare blurMedia={blurMedia} inModalContext onViewThread={onViewThread} />
        ) : effectiveExpanded ? (
          <>
            <div className={needsSpoiler ? 'relative max-h-48 overflow-hidden' : undefined}>
              <NoteContent event={event} className="text-sm" blurMedia={blurMedia} inModalContext onViewThread={onViewThread} depth={depth} />
              {needsSpoiler && (
                <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-card to-transparent pointer-events-none" />
              )}
            </div>
            {(isExpanded || needsSpoiler) && (
              <button
                className="text-xs text-primary mt-1 hover:underline relative z-10"
                onClick={handleToggle}
              >
                {isExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </>
        ) : (
          <>
            <NoteContent
              event={visLen > 125
                ? { ...event, content: truncateForPreview(event.content, 125) }
                : event}
              className="text-sm text-muted-foreground"
              blurMedia={blurMedia}
              depth={depth}
            />
            {isLongContent && (
              <button
                className="text-xs text-primary mt-1 hover:underline relative z-10"
                onClick={handleToggle}
              >
                Show more
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function NoteLinkSkeleton() {
  return (
    <Card className="mb-2">
      <CardHeader className="pb-2 flex flex-row items-center gap-3">
        <Skeleton className="h-8 w-8 rounded-full" />
        <div className="flex flex-col gap-1">
          <Skeleton className="h-4 w-[100px]" />
          <Skeleton className="h-3 w-[60px]" />
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <Skeleton className="h-4 w-full mb-2" />
        <Skeleton className="h-4 w-3/4" />
      </CardContent>
    </Card>
  )
}

function NoteLinkNotFound({ onRetry, isFetching, debugInfo, fullDebugInfo }: { onRetry?: () => void; isFetching?: boolean; debugInfo?: string; fullDebugInfo?: string }) {
  const [showModal, setShowModal] = useState(false)
  return (
    <>
      <Card className="mb-2 bg-muted/50 border-dashed">
        <CardContent className="p-4 flex items-center justify-between">
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <span className="text-muted-foreground text-sm">{isFetching ? 'Retrying…' : 'Referenced note not found'}</span>
            {debugInfo && (
              <button
                className="text-[10px] text-muted-foreground/50 font-mono text-left hover:text-muted-foreground/80 truncate transition-colors"
                onClick={() => setShowModal(true)}
                title="Click to see full debug info"
              >
                {debugInfo}
              </button>
            )}
          </div>
          {onRetry && (
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0 ml-2" onClick={onRetry} title="Retry">
              <RotateCw className={`h-3 w-3${isFetching ? ' animate-spin' : ''}`} />
            </Button>
          )}
        </CardContent>
      </Card>
      {showModal && (
        <Dialog open onOpenChange={() => setShowModal(false)}>
          <DialogContent className="max-w-sm" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle className="text-sm">Referenced note not found</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <pre className="text-[10px] font-mono bg-muted p-3 rounded break-all whitespace-pre-wrap">
                {fullDebugInfo || debugInfo}
              </pre>
              {onRetry && (
                <Button size="sm" variant="outline" className="w-full gap-1" onClick={() => { setShowModal(false); onRetry(); }}>
                  <RotateCw className={`h-3 w-3${isFetching ? ' animate-spin' : ''}`} />
                  Retry
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

export function NoteLink({ noteId, inlineMode: _inlineMode = false, onViewThread, blurMedia, depth = 0 }: NoteLinkProps) {
  const { nostr } = useNostr()
  const queryClient = useQueryClient()
  const eventInfo = getEventIdFromIdentifier(noteId)

  const { data: event, isLoading, isFetching } = useQuery({
    queryKey: ['note', noteId],
    queryFn: async () => {
      // Handle note1 and nevent1 (by event ID)
      if (eventInfo.id) {
        // Anything already resolved by another path (most often the thread
        // view, which fetches the same event and caches it) is the answer.
        const cached = getCachedEvent(eventInfo.id)
        if (cached) return cached

        // NPool FIRST, then fetchEventWithOutbox — the same order the thread
        // view uses. That order is not cosmetic: opening the thread on a note
        // whose quoted parent shows "not found" in the feed reliably resolves
        // it, because NPool's reqRouter fans out across author relays plus the
        // fallbacks, and fetchEventWithOutbox alone does not reach the same
        // set. The feed was strictly weaker than the thread at finding exactly
        // the events the feed is asking about.
        const [viaPool] = await nostr.query(
          [{ ids: [eventInfo.id], limit: 1 }],
          { signal: AbortSignal.timeout(6000) },
        ).catch(() => [])
        if (viaPool) {
          setCachedEvent(viaPool.id, viaPool)
          return viaPool
        }

        return fetchEventWithOutbox(eventInfo.id, nostr, {
          hints: eventInfo.relays,
          authorPubkey: eventInfo.pubkey,
        })
      }

      // Handle naddr1 (by kind, pubkey, and d-tag)
      if (eventInfo.kind && eventInfo.pubkey && eventInfo.identifier) {
        return fetchNaddrWithOutbox(
          eventInfo.kind, eventInfo.pubkey, eventInfo.identifier,
          nostr, eventInfo.relays,
        )
      }

      return null
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
    retryDelay: 4000,
  })

  // The unresolved registry mutates a module-level set — a side effect, so it
  // belongs in an effect, not the render body. Under StrictMode/concurrent
  // rendering a render can be thrown away and re-run, which double-registered
  // the note.
  //
  // Registration is now symmetric: clear on resolve AND on unmount, so the
  // registry counts what is unresolved ON SCREEN. The retry sweep's "2 or more"
  // threshold is only meaningful if references that scrolled away or resolved
  // stop being counted.
  useEffect(() => {
    if (isLoading) return
    if (event) {
      clearUnresolved(noteId)
      return
    }
    registerUnresolved(noteId)
    return () => clearUnresolved(noteId)
  }, [isLoading, event, noteId])

  if (isLoading) {
    return <NoteLinkSkeleton />
  }

  if (!event) {
    // Build truncated debug string for inline display
    const shortParts: string[] = []
    if (eventInfo.id) shortParts.push(`id:${eventInfo.id.slice(0, 8)}…`)
    if (eventInfo.kind) shortParts.push(`kind:${eventInfo.kind}`)
    if (eventInfo.identifier) shortParts.push(`d:${eventInfo.identifier.slice(0, 20)}${eventInfo.identifier.length > 20 ? '…' : ''}`)
    if (eventInfo.pubkey) shortParts.push(`author:${eventInfo.pubkey.slice(0, 8)}…`)
    if (eventInfo.relays?.length) shortParts.push(`relays: ${eventInfo.relays.map(r => r.replace(/^wss?:\/\//, '')).join(', ')}`)
    const debugInfo = shortParts.length > 0 ? shortParts.join(' · ') : undefined
    // Build full debug string (untruncated) for modal
    const fullParts: string[] = []
    if (eventInfo.id) fullParts.push(`id: ${eventInfo.id}`)
    if (eventInfo.kind) fullParts.push(`kind: ${eventInfo.kind}`)
    if (eventInfo.identifier) fullParts.push(`d-tag: ${eventInfo.identifier}`)
    if (eventInfo.pubkey) fullParts.push(`author: ${eventInfo.pubkey}`)
    if (eventInfo.relays?.length) fullParts.push(`relays:\n${eventInfo.relays.join('\n')}`)
    fullParts.push(`noteId: ${noteId}`)
    const fullDebugInfo = fullParts.join('\n')
    return <NoteLinkNotFound onRetry={() => queryClient.invalidateQueries({ queryKey: ['note', noteId] })} isFetching={isFetching} debugInfo={debugInfo} fullDebugInfo={fullDebugInfo} />
  }

  // Always use inline expand/collapse — no page navigation
  return <InlineNoteLinkContent event={event} onViewThread={onViewThread} blurMedia={blurMedia} depth={depth} />
}
