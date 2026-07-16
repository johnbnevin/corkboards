import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

/**
 * Inline external link (used for markdown links inside note text) with a small
 * copy affordance. Bare URLs render as WebLink cards which have their own copy
 * button; this covers `[text](url)` style links that render inline. The href is
 * expected to be already tracker-stripped by the caller.
 */
export function InlineLink({ href, children }: { href: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)

  const copy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <span className="inline-flex items-baseline gap-0.5">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-purple-500 hover:text-purple-600 underline"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </a>
      <button
        type="button"
        onClick={copy}
        title={copied ? 'Copied' : 'Copy link'}
        aria-label="Copy link"
        className="inline-flex items-center align-middle text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  )
}
