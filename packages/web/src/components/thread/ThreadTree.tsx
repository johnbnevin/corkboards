import { useRef, useEffect, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { NostrEvent } from '@nostrify/nostrify'
import type { FlatThreadRow } from '@core/threadTree'
import { ThreadReplyRow } from './ThreadReplyRow'

interface ThreadTreeProps {
  rows: FlatThreadRow[]
  targetId: string | null
  collapsedIds: Set<string>
  onToggleCollapse: (eventId: string) => void
  onViewThread?: (eventId: string) => void
  onReply?: (event: NostrEvent) => void
  onQuote?: (event: NostrEvent) => void
  onRepost?: (event: NostrEvent) => void
  onZap?: (event: NostrEvent) => void
  onPinToBoard?: (event: NostrEvent) => void
  onReactionPublished?: (event: NostrEvent) => void
}

export function ThreadTree({
  rows, targetId, collapsedIds, onToggleCollapse,
  onViewThread, onReply, onQuote, onRepost, onZap, onPinToBoard, onReactionPublished,
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

  const handleReply = useCallback((event: NostrEvent) => onReply?.(event), [onReply])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
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
            </div>
          )
        })}
      </div>
    </div>
  )
}
