import { useState, useCallback, useMemo } from 'react'
import { stripTrackingParams } from '@core/sanitizeUtils'

export interface UseLinkCopyResult {
  /** Tracker-stripped URL (what we render/open/copy by default). */
  cleanUrl: string
  /** True when stripping actually removed something (clean !== raw). */
  hasTracker: boolean
  /** Brief "copied" flag (1.5s) for icon feedback. */
  copied: boolean
  /** Copy the cleaned URL to the clipboard. */
  copyClean: () => void
  /** Copy the original URL (with trackers) to the clipboard. */
  copyOriginal: () => void
}

/**
 * Shared clipboard logic for rendered links. Copies the cleaned URL by default;
 * when a tracker was stripped, callers can also offer the original via a
 * right-click menu (see LinkCopyContextMenu).
 */
export function useLinkCopy(rawUrl: string): UseLinkCopyResult {
  const [copied, setCopied] = useState(false)
  const cleanUrl = useMemo(() => stripTrackingParams(rawUrl), [rawUrl])
  const hasTracker = cleanUrl !== rawUrl

  const copy = useCallback((text: string) => {
    try {
      void navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }, [])

  const copyClean = useCallback(() => copy(cleanUrl), [copy, cleanUrl])
  const copyOriginal = useCallback(() => copy(rawUrl), [copy, rawUrl])

  return { cleanUrl, hasTracker, copied, copyClean, copyOriginal }
}
