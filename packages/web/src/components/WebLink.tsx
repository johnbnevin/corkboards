import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { ExternalLink, Copy, Check, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useLinkCopy } from '@/hooks/useLinkCopy'
import { LinkCopyContextMenu } from './LinkCopyContextMenu'
import { TrackerWarningDialog } from './TrackerWarningDialog'
import { isSafeExternalUrl } from '@core/sanitizeUtils'
import { openExternal } from '@/lib/openExternal'

// Shared with mobile via @core/sanitizeUtils — see isSafeExternalUrl.
const isSafeUrl = isSafeExternalUrl

/**
 * Bare-URL link card. The URL renders exactly as the note's author wrote it —
 * we never rewrite notes. When known tracking params are detected, a shield
 * icon warns the user and clicking opens a dialog offering: open clean, open
 * original, copy either, or cancel.
 */
export function WebLink({ url }: { url: string }) {
  const { cleanUrl, hasTracker, trackingParams, copied, copyClean, copyOriginal } = useLinkCopy(url)
  const [warningOpen, setWarningOpen] = useState(false)

  let hostname = ''
  try {
    hostname = new URL(url).hostname
  } catch {
    hostname = url
  }

  if (!isSafeUrl(url)) {
    return <span className="text-muted-foreground text-sm break-all">{url}</span>
  }

  const copy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    copyClean()
  }

  const openClean = () => openExternal(cleanUrl)
  const openOriginal = () => openExternal(url)

  return (
    <>
    <LinkCopyContextMenu
      hasTracker={hasTracker}
      onCopyClean={copyClean}
      onCopyOriginal={copyOriginal}
      onOpenClean={openClean}
      onOpenOriginal={openOriginal}
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={url}
        className="block mb-2"
        onClick={(e) => {
          e.stopPropagation()
          if (hasTracker) {
            e.preventDefault()
            setWarningOpen(true)
          }
        }}
      >
        <Card className="hover:bg-accent transition-colors">
          <CardContent className="p-3 flex items-center gap-2">
            <ExternalLink className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm truncate flex items-center gap-1.5">
                {hostname}
                {/* Shield opens the link-options sheet on every link (touch has
                    no right-click). Amber when trackers are present, gray when clean. */}
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setWarningOpen(true) }}
                  title={hasTracker ? `Contains tracking parameters: ${trackingParams.join(', ')}` : 'No known trackers — link options'}
                  aria-label={hasTracker ? 'Link contains trackers' : 'Link options'}
                  className="inline-flex items-center"
                >
                  {hasTracker
                    ? <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
                    : <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />}
                </button>
              </div>
              <div className="text-xs text-muted-foreground truncate">{url}</div>
            </div>
            {/* Copy affordance; copies the clean form. Right-click for choices. */}
            <button
              type="button"
              onClick={copy}
              title={copied ? 'Copied' : hasTracker ? 'Copy link without trackers' : 'Copy link'}
              aria-label="Copy link"
              className="p-1.5 rounded hover:bg-muted flex-shrink-0"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
            </button>
          </CardContent>
        </Card>
      </a>
    </LinkCopyContextMenu>
    <TrackerWarningDialog
      open={warningOpen}
      onOpenChange={setWarningOpen}
      rawUrl={url}
      cleanUrl={cleanUrl}
      trackingParams={trackingParams}
    />
    </>
  )
}
