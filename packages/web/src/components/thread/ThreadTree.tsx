import { useRef, useEffect, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { NostrEvent } from '@nostrify/nostrify'
import type { FlatThreadRow } from '@core/threadTree'
import { ThreadReplyRow } from './ThreadReplyRow'
import { InlineReplyComposer } from './InlineReplyComposer'

interface ThreadTreeProps {
  rows: FlatThreadRow[]
  targetId: string | null
  /** ID of a just-posted reply — auto-scrolls to it once */
  scrollToReplyId?: string | null
  collapsedIds: Set<string>
  onToggleCollapse: (eventId: string) => void
  onViewThread?: (eventId: string) => void
  onReply?: (event: NostrEvent) => void
  onQuote?: (event: NostrEvent) => void
  onRepost?: (event: NostrEvent) => void
  onZap?: (event: NostrEvent) => void
  onPinToBoard?: (event: NostrEvent) => void
  onReactionPublished?: (event: NostrEvent) => void
  /** Note currently being replied to — its composer renders inline beneath its
   *  row when that note is present in the tree. */
  replyingTo?: NostrEvent | null
  onReplyCancel?: () => void
  onReplyPublished?: (event: NostrEvent) => void
  onOpenEmojiSets?: () => void
}

export function ThreadTree({
  rows, targetId, scrollToReplyId, collapsedIds, onToggleCollapse,
  onViewThread, onReply, onQuote, onRepost, onZap, onPinToBoard, onReactionPublished,
  replyingTo, onReplyCancel, onReplyPublished, onOpenEmojiSets,
}: ThreadTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 5,
  })

  // Scroll to target on mount
  const hasScrolled = useRef(false)
  useEffect(() => {
    if (hasScrolled.current || !targetId || rows.length === 0) return
    const idx = rows.findIndex(r => r.node.event.id === targetId)
    if (idx >= 0) {
      hasScrolled.current = true
      // Delay to let virtualizer settle
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' })
      })
    }
  }, [rows, targetId, virtualizer])

  // Reset scroll flag when target changes
  const prevTarget = useRef(targetId)
  if (targetId !== prevTarget.current) {
    prevTarget.current = targetId
    hasScrolled.current = false
  }

  // Auto-scroll to a just-posted reply so the user sees it immediately
  const lastScrolledReply = useRef<string | null>(null)
  useEffect(() => {
    if (!scrollToReplyId || scrollToReplyId === lastScrolledReply.current) return
    const idx = rows.findIndex(r => r.node.event.id === scrollToReplyId)
    if (idx >= 0) {
      lastScrolledReply.current = scrollToReplyId
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' })
      })
    }
  }, [scrollToReplyId, rows, virtualizer])

  // When the inline composer opens (or moves to another note), scroll its row
  // into view so the freshly-focused input is visible. Runs after the row grows
  // to include the composer (measureElement reflow), hence the rAF.
  const lastComposerTarget = useRef<string | null>(null)
  useEffect(() => {
    const id = replyingTo?.id ?? null
    if (id === lastComposerTarget.current) return
    lastComposerTarget.current = id
    if (!id) return
    const idx = rows.findIndex(r => r.node.event.id === id)
    if (idx >= 0) {
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' })
      })
    }
  }, [replyingTo, rows, virtualizer])

  const handleReply = useCallback((event: NostrEvent) => onReply?.(event), [onReply])

  return (
    // pb-24 gives the last reply room to scroll clear of the bottom edge (and
    // above the inline reply composer when it's open) instead of being clipped.
    <div ref={scrollRef} className="flex-1 overflow-y-auto pb-24">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index]
          return (
            <div
              key={row.node.event.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
            >
              <ThreadReplyRow
                node={row.node}
                depth={row.depth}
                isTarget={row.isTarget}
                isCollapsed={collapsedIds.has(row.node.event.id)}
                onToggleCollapse={onToggleCollapse}
                onViewThread={onViewThread}
                onReply={handleReply}
                onQuote={onQuote}
                onRepost={onRepost}
                onZap={onZap}
                onPinToBoard={onPinToBoard}
                onReactionPublished={onReactionPublished}
              />
              {/* Reply composer anchored directly beneath the note being
                  replied to — indented to line up under its row. */}
              {replyingTo && replyingTo.id === row.node.event.id && (
                <div style={{ paddingLeft: `${Math.min(row.depth, 8) * 12}px` }}>
                  <InlineReplyComposer
                    replyTo={replyingTo}
                    onCancel={() => onReplyCancel?.()}
                    onPublished={(e) => onReplyPublished?.(e)}
                    onOpenEmojiSets={onOpenEmojiSets}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
