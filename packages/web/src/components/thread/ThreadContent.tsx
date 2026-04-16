import { useState, useCallback, useRef, useEffect } from 'react'
import type { NostrEvent } from '@nostrify/nostrify'
import { useThreadQuery } from '@/hooks/useThreadQuery'
import { ThreadTree } from './ThreadTree'
import { InlineReplyComposer } from './InlineReplyComposer'
import { Skeleton } from '@/components/ui/skeleton'
import { MessageSquare, RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ThreadContentProps {
  eventId: string | null
  onClose: () => void
  onQuote?: (event: NostrEvent, refreshThread: (newEvent?: NostrEvent) => void) => void
  onRepost?: (event: NostrEvent, refreshThread: (newEvent?: NostrEvent) => void) => void
  onZap?: (event: NostrEvent) => void
  onPinToBoard?: (event: NostrEvent) => void
  onReactionPublished?: (event: NostrEvent) => void
  onReplyPublished?: (event: NostrEvent) => void
  autoReplyTo?: NostrEvent | null
  onOpenEmojiSets?: () => void
  onNavigateThread?: (eventId: string) => void
}

export function ThreadContent({
  eventId, onClose: _onClose, onQuote, onRepost, onZap, onPinToBoard,
  onReactionPublished, onReplyPublished, autoReplyTo, onOpenEmojiSets, onNavigateThread,
}: ThreadContentProps) {
  const {
    tree, rows, isLoading, error,
    refetch, injectReply, collapsedIds, toggleCollapse,
  } = useThreadQuery(eventId)

  const [replyingTo, setReplyingTo] = useState<NostrEvent | null>(null)
  const [scrollToReplyId, setScrollToReplyId] = useState<string | null>(null)

  // Auto-reply: open composer when autoReplyTo is set and thread is loaded
  const autoReplyFiredRef = useRef<string | null>(null)
  useEffect(() => {
    if (autoReplyTo && tree && autoReplyFiredRef.current !== autoReplyTo.id) {
      autoReplyFiredRef.current = autoReplyTo.id
      setReplyingTo(autoReplyTo)
    }
  }, [autoReplyTo, tree])

  // Reset reply state when eventId changes
  useEffect(() => { setReplyingTo(null); setScrollToReplyId(null) }, [eventId])

  const handleReplyPublished = useCallback((newEvent: NostrEvent) => {
    injectReply(newEvent)
    setReplyingTo(null)
    setScrollToReplyId(newEvent.id)
    onReplyPublished?.(newEvent)
  }, [injectReply, onReplyPublished])

  const refreshThread = useCallback((newEvent?: NostrEvent) => {
    if (newEvent) injectReply(newEvent)
    else refetch()
  }, [injectReply, refetch])

  const handleQuote = useCallback((event: NostrEvent) => {
    onQuote?.(event, refreshThread)
  }, [onQuote, refreshThread])

  const handleRepost = useCallback((event: NostrEvent) => {
    onRepost?.(event, refreshThread)
  }, [onRepost, refreshThread])

  const totalReplies = rows.length > 0 ? rows.length - 1 : 0

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pr-12 py-2 border-b shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <MessageSquare className="h-4 w-4" />
          <span>Thread</span>
          {!isLoading && totalReplies > 0 && (
            <span className="text-xs text-muted-foreground">({totalReplies} {totalReplies === 1 ? 'reply' : 'replies'})</span>
          )}
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={refetch} title="Refresh">
          {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Content area */}
      {isLoading && !tree ? (
        <div className="flex-1 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-5 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <div className="mt-6 space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex items-center gap-2 pl-4">
                <Skeleton className="h-4 w-4 rounded-full" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-sm text-muted-foreground">
            <p className="mb-2">{error}</p>
            <Button variant="outline" size="sm" onClick={refetch}>Try again</Button>
          </div>
        </div>
      ) : rows.length > 0 ? (
        <ThreadTree
          rows={rows}
          targetId={eventId}
          scrollToReplyId={scrollToReplyId}
          collapsedIds={collapsedIds}
          onToggleCollapse={toggleCollapse}
          onViewThread={onNavigateThread}
          onReply={setReplyingTo}
          onQuote={handleQuote}
          onRepost={handleRepost}
          onZap={onZap}
          onPinToBoard={onPinToBoard}
          onReactionPublished={onReactionPublished}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          No thread data found.
        </div>
      )}

      {/* Inline reply composer */}
      {replyingTo && (
        <InlineReplyComposer
          replyTo={replyingTo}
          onCancel={() => setReplyingTo(null)}
          onPublished={handleReplyPublished}
          onOpenEmojiSets={onOpenEmojiSets}
        />
      )}
    </div>
  )
}
