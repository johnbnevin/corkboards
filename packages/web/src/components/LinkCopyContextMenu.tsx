import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'

interface LinkCopyContextMenuProps {
  /** Whether known tracking params were detected (drives the header + which copy is "clean"). */
  hasTracker: boolean
  onCopyClean: () => void
  onCopyOriginal: () => void
  onOpenClean: () => void
  onOpenOriginal: () => void
  children: React.ReactNode
}

/**
 * Wraps a rendered link so right-click (desktop) offers the same options on
 * EVERY link — open/copy clean vs. as-is — regardless of whether a tracker was
 * found. The header just reflects the tracker state (amber when detected, muted
 * when clean). We never rewrite the note; "clean" only strips known tracking
 * params, and on a clean link clean === as-is.
 */
export function LinkCopyContextMenu({
  hasTracker,
  onCopyClean,
  onCopyOriginal,
  onOpenClean,
  onOpenOriginal,
  children,
}: LinkCopyContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel
          className={hasTracker ? 'text-amber-600 dark:text-amber-500 text-xs' : 'text-muted-foreground text-xs'}
        >
          {hasTracker ? 'Tracking parameters detected' : 'No known trackers'}
        </ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onOpenClean}>Open clean link</ContextMenuItem>
        <ContextMenuItem onSelect={onOpenOriginal}>View full link (as-is)</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCopyClean}>Copy clean link</ContextMenuItem>
        <ContextMenuItem onSelect={onCopyOriginal}>Copy link as-is</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
