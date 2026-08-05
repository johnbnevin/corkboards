import { useState } from 'react'
import { ShieldAlert, ShieldCheck, Copy, Check, ExternalLink } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { openExternal } from '@/lib/openExternal'

interface TrackerWarningDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The URL exactly as it appeared in the note (with trackers). */
  rawUrl: string
  /** The tracker-stripped URL. */
  cleanUrl: string
  /** Names of the tracking params detected (utm_source, fbclid, …). Empty when clean. */
  trackingParams: string[]
  /** Human title for the link target (e.g. the YouTube video title), when known. */
  linkTitle?: string
}

function openInNewTab(url: string) {
  openExternal(url)
}

/**
 * Link options sheet — the same actions on EVERY link, reachable on touch where
 * there's no right-click. When the link carries known tracking parameters it
 * doubles as a warning (amber shield, params listed) and the primary action is
 * the clean form (cypherpunk default). On a clean link (no trackers) clean ===
 * original, so it just offers open/copy. We never rewrite the note — the link
 * renders exactly as the author wrote it.
 */
export function TrackerWarningDialog({ open, onOpenChange, rawUrl, cleanUrl, trackingParams, linkTitle }: TrackerWarningDialogProps) {
  const [copiedWhich, setCopiedWhich] = useState<'clean' | 'original' | null>(null)
  const hasTracker = cleanUrl !== rawUrl

  const copy = (text: string, which: 'clean' | 'original') => {
    try {
      void navigator.clipboard.writeText(text)
      setCopiedWhich(which)
      setTimeout(() => setCopiedWhich(null), 1500)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {hasTracker ? (
              <>
                <ShieldAlert className="h-5 w-5 text-amber-500" />
                This link contains trackers
              </>
            ) : (
              <>
                <ShieldCheck className="h-5 w-5 text-muted-foreground" />
                Link options
              </>
            )}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              {linkTitle && (
                <p className="font-medium text-foreground">{linkTitle}</p>
              )}
              {hasTracker && (
                <p>
                  Tracking parameter{trackingParams.length === 1 ? '' : 's'} detected:{' '}
                  <span className="font-mono text-xs">{trackingParams.join(', ')}</span>
                </p>
              )}
              <p className="break-all rounded bg-muted p-2 font-mono text-xs text-muted-foreground">{cleanUrl}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          <Button
            className="w-full"
            onClick={() => { openInNewTab(cleanUrl); onOpenChange(false) }}
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            {hasTracker ? 'Open without trackers' : 'Open link'}
          </Button>
          {hasTracker && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => { openInNewTab(rawUrl); onOpenChange(false) }}
            >
              View full link (with trackers)
            </Button>
          )}
          <div className="flex w-full gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => copy(cleanUrl, 'clean')}>
              {copiedWhich === 'clean' ? <Check className="mr-2 h-4 w-4 text-green-500" /> : <Copy className="mr-2 h-4 w-4" />}
              {hasTracker ? 'Copy clean' : 'Copy link'}
            </Button>
            {hasTracker && (
              <Button variant="secondary" className="flex-1" onClick={() => copy(rawUrl, 'original')}>
                {copiedWhich === 'original' ? <Check className="mr-2 h-4 w-4 text-green-500" /> : <Copy className="mr-2 h-4 w-4" />}
                Copy as-is
              </Button>
            )}
          </div>
          <AlertDialogCancel className="w-full mt-0">Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
