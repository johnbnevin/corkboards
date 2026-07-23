import { useState } from 'react'
import { Copy, Check, ShieldAlert } from 'lucide-react'
import { useLinkCopy } from '@/hooks/useLinkCopy'
import { LinkCopyContextMenu } from './LinkCopyContextMenu'
import { TrackerWarningDialog } from './TrackerWarningDialog'

/**
 * Inline external link (markdown `[text](url)` inside note text) with a small
 * copy affordance. The note is rendered exactly as authored — we never rewrite
 * the URL. When known tracking params are detected, a shield icon warns the
 * user and clicking the link opens a dialog offering: open clean, open
 * original, copy either, or cancel.
 */
export function InlineLink({ url, children }: { url: string; children: React.ReactNode }) {
  const { cleanUrl, hasTracker, trackingParams, copied, copyClean, copyOriginal } = useLinkCopy(url)
  const [warningOpen, setWarningOpen] = useState(false)

  const copy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    copyClean()
  }

  return (
    <LinkCopyContextMenu hasTracker={hasTracker} onCopyClean={copyClean} onCopyOriginal={copyOriginal}>
      <span className="inline-flex items-baseline gap-0.5">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={url}
          className="text-purple-500 hover:text-purple-600 underline"
          onClick={(e) => {
            e.stopPropagation()
            if (hasTracker) {
              // Intercept: let the user decide clean vs original before leaving.
              e.preventDefault()
              setWarningOpen(true)
            }
          }}
        >
          {children}
        </a>
        {hasTracker && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setWarningOpen(true) }}
            title={`Contains tracking parameters: ${trackingParams.join(', ')}`}
            aria-label="Link contains trackers"
            className="inline-flex items-center align-middle text-amber-500 hover:text-amber-600"
          >
            <ShieldAlert className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          title={copied ? 'Copied' : hasTracker ? 'Copy link without trackers' : 'Copy link'}
          aria-label="Copy link"
          className="inline-flex items-center align-middle text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
        {hasTracker && (
          <TrackerWarningDialog
            open={warningOpen}
            onOpenChange={setWarningOpen}
            rawUrl={url}
            cleanUrl={cleanUrl}
            trackingParams={trackingParams}
          />
        )}
      </span>
    </LinkCopyContextMenu>
  )
}
