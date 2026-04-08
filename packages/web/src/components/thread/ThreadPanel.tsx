import type { NostrEvent } from '@nostrify/nostrify'
import { useIsMobile } from '@/hooks/useIsMobile'
import { ResizableDialog, ResizableDialogContent } from '@/components/ui/resizable-dialog'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { STORAGE_KEYS, CURRENT_PLATFORM, platformKey } from '@/lib/storageKeys'
import { ThreadContent } from './ThreadContent'

interface ThreadPanelProps {
  eventId: string | null
  isOpen: boolean
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

export function ThreadPanel({
  eventId, isOpen, onClose, onQuote, onRepost, onZap,
  onPinToBoard, onReactionPublished, onReplyPublished, autoReplyTo, onOpenEmojiSets, onNavigateThread,
}: ThreadPanelProps) {
  const isMobile = useIsMobile()

  const content = (
    <ThreadContent
      eventId={eventId}
      onClose={onClose}
      onQuote={onQuote}
      onRepost={onRepost}
      onZap={onZap}
      onPinToBoard={onPinToBoard}
      onReactionPublished={onReactionPublished}
      onReplyPublished={onReplyPublished}
      autoReplyTo={autoReplyTo}
      onOpenEmojiSets={onOpenEmojiSets}
      onNavigateThread={onNavigateThread}
    />
  )

  if (isMobile) {
    return (
      <Drawer open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
        <DrawerContent className="h-[95dvh] max-h-[95dvh]">
          <span className="sr-only"><DrawerTitle>Thread</DrawerTitle></span>
          {content}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <ResizableDialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <ResizableDialogContent
        defaultWidth={700}
        defaultHeight={Math.round(window.innerHeight * 0.85)}
        minWidth={400}
        minHeight={300}
        dialogTitle="Thread"
        storageKey={platformKey(CURRENT_PLATFORM, STORAGE_KEYS.THREAD_DIALOG_GEOMETRY)}
      >
        {content}
      </ResizableDialogContent>
    </ResizableDialog>
  )
}
