import { useState, useMemo } from 'react'
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
import { ExternalLink, RotateCw } from 'lucide-react'

import { NoteContent } from '@/components/NoteContent'
import { visibleLength, findVisibleCutoff } from '@/lib/textTruncation'
import { fetchEventWithOutbox, fetchNaddrWithOutbox } from '@/lib/fetchEvent'
import { registerFailedNote } from '@/lib/failedNotes'
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

// visibleLength and findVisibleCutoff imported from @/lib/textTruncation

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
  const avatar = author?.metadata?.picture

  // Measure visible text length (excludes nostr refs but keeps URLs)
  const visLen = useMemo(() => visibleLength(event.content), [event.content])
  const isLongContent = visLen > 125

  // When media is fully enabled, always show full content so media URLs aren't truncated away
  const effectiveExpanded = !blurMedia || isExpanded

  const handleToggle = () => setIsExpanded(!isExpanded)

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
        {effectiveExpanded ? (
          <>
            <NoteContent event={event} className="text-sm" blurMedia={blurMedia} inModalContext onViewThread={onViewThread} depth={depth} />
            {isExpanded && (
              <button
                className="text-xs text-primary mt-1 hover:underline relative z-10"
                onClick={handleToggle}
              >
                Show less
              </button>
            )}
          </>
        ) : (
          <>
            <NoteContent
              event={visLen > 125
                ? { ...event, content: event.content.slice(0, findVisibleCutoff(event.content, 125)).trimEnd() + '…' }
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

  if (isLoading) {
    return <NoteLinkSkeleton />
  }

  if (!event) {
    registerFailedNote(noteId)
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
