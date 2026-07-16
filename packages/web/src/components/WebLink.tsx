import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { ExternalLink, Copy, Check } from 'lucide-react'
import { stripTrackingParams } from '@core/sanitizeUtils'

function isSafeUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()
  return lower.startsWith('http://') || lower.startsWith('https://')
}

export function WebLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  // Strip tracking params before rendering so links look clean and don't leak
  // referral fingerprints when opened.
  const cleanUrl = stripTrackingParams(url)

  let hostname = ''
  try {
    hostname = new URL(cleanUrl).hostname
  } catch {
    hostname = cleanUrl
  }

  if (!isSafeUrl(cleanUrl)) {
    return <span className="text-muted-foreground text-sm break-all">{url}</span>
  }

  const copy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(cleanUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <a href={cleanUrl} target="_blank" rel="noopener noreferrer" className="block mb-2" onClick={(e) => e.stopPropagation()}>
      <Card className="hover:bg-accent transition-colors">
        <CardContent className="p-3 flex items-center gap-2">
          <ExternalLink className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm truncate">{hostname}</div>
            <div className="text-xs text-muted-foreground truncate">{cleanUrl}</div>
          </div>
          {/* Copy affordance so users can grab the link to inspect/edit it. */}
          <button
            type="button"
            onClick={copy}
            title={copied ? 'Copied' : 'Copy link'}
            aria-label="Copy link"
            className="p-1.5 rounded hover:bg-muted flex-shrink-0"
          >
            {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
          </button>
        </CardContent>
      </Card>
    </a>
  )
}
