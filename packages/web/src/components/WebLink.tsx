import { Card, CardContent } from '@/components/ui/card'
import { ExternalLink, Copy, Check } from 'lucide-react'
import { useLinkCopy } from '@/hooks/useLinkCopy'
import { LinkCopyContextMenu } from './LinkCopyContextMenu'

function isSafeUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()
  return lower.startsWith('http://') || lower.startsWith('https://')
}

export function WebLink({ url }: { url: string }) {
  // Copies the cleaned URL by default; right-click offers the original when a
  // tracker was stripped (LinkCopyContextMenu).
  const { cleanUrl, hasTracker, copied, copyClean, copyOriginal } = useLinkCopy(url)

  let hostname = ''
  try {
    hostname = new URL(cleanUrl).hostname
  } catch {
    hostname = cleanUrl
  }

  if (!isSafeUrl(cleanUrl)) {
    return <span className="text-muted-foreground text-sm break-all">{url}</span>
  }

  const copy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    copyClean()
  }

  return (
    <LinkCopyContextMenu hasTracker={hasTracker} onCopyClean={copyClean} onCopyOriginal={copyOriginal}>
      {/* title shows the original URL on hover for inspection */}
      <a href={cleanUrl} target="_blank" rel="noopener noreferrer" title={url} className="block mb-2" onClick={(e) => e.stopPropagation()}>
        <Card className="hover:bg-accent transition-colors">
          <CardContent className="p-3 flex items-center gap-2">
            <ExternalLink className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm truncate">{hostname}</div>
              <div className="text-xs text-muted-foreground truncate">{cleanUrl}</div>
            </div>
            {/* Copy affordance; right-click the link for clean-vs-original choice. */}
            <button
              type="button"
              onClick={copy}
              title={copied ? 'Copied' : hasTracker ? 'Copy link (right-click for original)' : 'Copy link'}
              aria-label="Copy link"
              className="p-1.5 rounded hover:bg-muted flex-shrink-0"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
            </button>
          </CardContent>
        </Card>
      </a>
    </LinkCopyContextMenu>
  )
}
