import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu'

interface LinkCopyContextMenuProps {
  /** Whether a tracker was stripped — only then do we offer the choice menu. */
  hasTracker: boolean
  onCopyClean: () => void
  onCopyOriginal: () => void
  children: React.ReactNode
}

/**
 * Wraps a rendered link so right-click (desktop) offers "Copy clean link" vs
 * "Copy original (with trackers)" — but ONLY when a tracker was actually
 * stripped. Otherwise children render unwrapped so the native browser context
 * menu is preserved and there's no Radix overhead for the common case.
 */
export function LinkCopyContextMenu({ hasTracker, onCopyClean, onCopyOriginal, children }: LinkCopyContextMenuProps) {
  if (!hasTracker) return <>{children}</>

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onCopyClean}>Copy clean link</ContextMenuItem>
        <ContextMenuItem onSelect={onCopyOriginal}>Copy original (with trackers)</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
