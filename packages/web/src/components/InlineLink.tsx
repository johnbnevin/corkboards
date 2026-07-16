import { Copy, Check } from 'lucide-react'
import { useLinkCopy } from '@/hooks/useLinkCopy'
import { LinkCopyContextMenu } from './LinkCopyContextMenu'

/**
 * Inline external link (markdown `[text](url)` inside note text) with a small
 * copy affordance. Bare URLs render as WebLink cards with their own copy button;
 * this covers inline links. Receives the RAW url and strips trackers internally
 * so it can also offer the original via right-click (LinkCopyContextMenu).
 */
export function InlineLink({ url, children }: { url: string; children: React.ReactNode }) {
  const { cleanUrl, hasTracker, copied, copyClean, copyOriginal } = useLinkCopy(url)

  const copy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    copyClean()
  }

  return (
    <LinkCopyContextMenu hasTracker={hasTracker} onCopyClean={copyClean} onCopyOriginal={copyOriginal}>
      <span className="inline-flex items-baseline gap-0.5">
        <a
          href={cleanUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={url}
          className="text-purple-500 hover:text-purple-600 underline"
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </a>
        <button
          type="button"
          onClick={copy}
          title={copied ? 'Copied' : hasTracker ? 'Copy link (right-click for original)' : 'Copy link'}
          aria-label="Copy link"
          className="inline-flex items-center align-middle text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </span>
    </LinkCopyContextMenu>
  )
}
