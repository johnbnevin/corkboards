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

  // ── Scroll anchoring ──────────────────────────────────────────────────────
  // The thread streams in progressively: the target loads first, then ancestors
  // (above it) and descendants (below). A one-shot scroll therefore fires before
  // the tree is stable, and later insertions above the target shift it — and its
  // inline composer — out of view. So instead of scrolling once, we KEEP the
  // relevant note pinned in the centre across row updates until the user scrolls.
  const keepCenteredRef = useRef(true)

  // Any manual scroll hands control back to the user — stop auto-centering so we
  // never yank them around.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const release = () => { keepCenteredRef.current = false }
    el.addEventListener('wheel', release, { passive: true })
    el.addEventListener('touchmove', release, { passive: true })
    el.addEventListener('keydown', release)
    return () => {
      el.removeEventListener('wheel', release)
      el.removeEventListener('touchmove', release)
      el.removeEventListener('keydown', release)
    }
  }, [])

  // Re-arm centering when we open a different thread, or when the composer opens
  // on a new note (so it comes into view and stays put as the thread finishes
  // loading). Computed during render so the effect below sees the fresh value.
  const prevTarget = useRef(targetId)
  if (targetId !== prevTarget.current) {
    prevTarget.current = targetId
    keepCenteredRef.current = true
  }
  const prevReplyId = useRef<string | null>(replyingTo?.id ?? null)
  const curReplyId = replyingTo?.id ?? null
  if (curReplyId && curReplyId !== prevReplyId.current) {
    keepCenteredRef.current = true
  }
  prevReplyId.current = curReplyId

  // Keep the note being replied to (or the target) centred as rows stream in.
  // Instant (not smooth) re-centres avoid animation thrash on rapid updates; the
  // double rAF waits for the composer's measured height to settle first.
  const anchorId = curReplyId ?? targetId
  useEffect(() => {
    if (!keepCenteredRef.current || !anchorId || rows.length === 0) return
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!keepCenteredRef.current) return
      const idx = rows.findIndex(r => r.node.event.id === anchorId)
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'auto' })
    }))
  }, [anchorId, rows, virtualizer])

  // Auto-scroll to a just-posted reply so the user sees it immediately. The new
  // reply becomes the focus, so stop pinning the old anchor.
  const lastScrolledReply = useRef<string | null>(null)
  useEffect(() => {
    if (!scrollToReplyId || scrollToReplyId === lastScrolledReply.current) return
    const idx = rows.findIndex(r => r.node.event.id === scrollToReplyId)
    if (idx >= 0) {
      lastScrolledReply.current = scrollToReplyId
      keepCenteredRef.current = false
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' })
      })
    }
  }, [scrollToReplyId, rows, virtualizer])

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
                onOpenEmojiSets={onOpenEmojiSets}
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
