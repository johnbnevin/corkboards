import { useState } from 'react'
import { ShieldAlert, Copy, Check, ExternalLink } from 'lucide-react'
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

interface TrackerWarningDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The URL exactly as it appeared in the note (with trackers). */
  rawUrl: string
  /** The tracker-stripped URL. */
  cleanUrl: string
  /** Names of the tracking params detected (utm_source, fbclid, …). */
  trackingParams: string[]
}

function openInNewTab(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Shown when the user clicks a link that carries known tracking parameters.
 * We never rewrite the note — the link renders exactly as the author wrote it —
 * but before following it the user chooses: open it clean, open the original,
 * or just copy either form. Cypherpunk default: the primary action is clean.
 */
export function TrackerWarningDialog({ open, onOpenChange, rawUrl, cleanUrl, trackingParams }: TrackerWarningDialogProps) {
  const [copiedWhich, setCopiedWhich] = useState<'clean' | 'original' | null>(null)

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
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            This link contains trackers
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                Tracking parameter{trackingParams.length === 1 ? '' : 's'} detected:{' '}
                <span className="font-mono text-xs">{trackingParams.join(', ')}</span>
              </p>
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
            Open without trackers
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => { openInNewTab(rawUrl); onOpenChange(false) }}
          >
            Open original (with trackers)
          </Button>
          <div className="flex w-full gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => copy(cleanUrl, 'clean')}>
              {copiedWhich === 'clean' ? <Check className="mr-2 h-4 w-4 text-green-500" /> : <Copy className="mr-2 h-4 w-4" />}
              Copy clean
            </Button>
            <Button variant="secondary" className="flex-1" onClick={() => copy(rawUrl, 'original')}>
              {copiedWhich === 'original' ? <Check className="mr-2 h-4 w-4 text-green-500" /> : <Copy className="mr-2 h-4 w-4" />}
              Copy original
            </Button>
          </div>
          <AlertDialogCancel className="w-full mt-0">Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
