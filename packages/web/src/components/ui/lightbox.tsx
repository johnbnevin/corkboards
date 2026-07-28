import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { applyImageProxy } from '@core/imageProxy'
import { shouldRejectUrl } from '@core/imageUtils'

// ── Global lightbox state ────────────────────────────────────────────────────
// Lifted out of individual LightboxTrigger components so that re-renders
// (e.g. from autofetch updating the notes list) don't reset the open state.

type LightboxState = {
  /** Display URL as rendered in the feed — resized for a preview, already proxied. */
  src: string
  alt: string
  /** Raw canonical URL the note actually pointed at, before resizing/proxying. */
  originalSrc?: string
} | null
type Listener = (state: LightboxState) => void

const listeners = new Set<Listener>()
let currentState: LightboxState = null

function setGlobalLightbox(state: LightboxState) {
  currentState = state
  for (const fn of listeners) fn(state)
}

/** Returns true when the lightbox is open (used to suppress autofetch). */
// eslint-disable-next-line react-refresh/only-export-components
export function isLightboxOpen(): boolean {
  return currentState !== null
}

/**
 * Full-resolution source for the lightbox itself. The feed renders a
 * preview-sized variant; blowing that up looks soft, so re-derive from the
 * canonical URL — skipping the host resize param but keeping the SSRF gate and
 * the user's image proxy, so opening a photo never leaks their IP either.
 */
function fullSizeSrc(state: NonNullable<LightboxState>): string {
  const { originalSrc, src } = state
  if (!originalSrc || shouldRejectUrl(originalSrc, 'media')) return src
  return applyImageProxy(originalSrc)
}

function useGlobalLightbox() {
  const [state, setState] = React.useState<LightboxState>(currentState)
  React.useEffect(() => {
    listeners.add(setState)
    return () => { listeners.delete(setState) }
  }, [])
  return state
}

// ── Global Lightbox renderer (mount once near app root) ──────────────────────

export function GlobalLightbox() {
  const state = useGlobalLightbox()

  React.useEffect(() => {
    if (!state) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGlobalLightbox(null)
    }

    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [state])

  if (!state) return null

  const lightboxContent = (
    <div
      // pointer-events-auto is REQUIRED: this portal mounts on document.body, and
      // when the photo is opened from inside a Radix modal (thread/compose/profile),
      // Radix sets body { pointer-events: none } — without this the lightbox is
      // visible but dead (X/backdrop clicks never fire, and clicks/scroll fall
      // through to the UI behind).
      className="fixed inset-0 z-[9999] pointer-events-auto"
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        setGlobalLightbox(null)
      }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          setGlobalLightbox(null)
        }}
      />

      {/* Modal content — clicking outside the image closes the lightbox */}
      <div
        className="absolute inset-0 flex items-center justify-center p-4"
        onClick={(e) => {
          e.stopPropagation()
          setGlobalLightbox(null)
        }}
      >
        {/* Close button + hint */}
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
          <span className="hidden sm:block text-xs text-white/60">esc to exit</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setGlobalLightbox(null)
            }}
            className="p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
            aria-label="Close lightbox"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Image container — clicks on the image itself don't close */}
        <div
          className="relative w-full max-w-7xl mx-auto"
          onClick={(e) => {
            e.stopPropagation()
          }}
        >
          <img
            src={fullSizeSrc(state)}
            alt={state.alt}
            className="w-full h-auto max-h-[85vh] object-contain rounded-lg shadow-2xl"
            referrerPolicy="no-referrer"
          />
        </div>

        {/* Open in new tab link — the canonical URL the note pointed at, not our
            resized/proxied render of it. "Open original" that opens a 400px
            proxy thumbnail is a lie about what the user is getting. */}
        <a
          href={state.originalSrc ?? state.src}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/50 hover:bg-black/70 text-white text-sm transition-colors"
          onClick={(e) => {
            e.stopPropagation()
          }}
        >
          Open original
        </a>
      </div>
    </div>
  )

  return createPortal(lightboxContent, document.body)
}

// ── LightboxTrigger (click target — no longer owns open state) ───────────────

interface LightboxTriggerProps {
  /** The URL as displayed in the feed (preview-sized, proxied). */
  src: string
  /** Raw canonical URL, used for "Open original" and the full-size render. */
  originalSrc?: string
  alt?: string
  className?: string
  children: React.ReactNode
}

export function LightboxTrigger({ src, originalSrc, alt, className, children }: LightboxTriggerProps) {
  return (
    <div
      className={cn('cursor-zoom-in', className)}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.nativeEvent.stopImmediatePropagation()
        setGlobalLightbox({ src, originalSrc, alt: alt ?? '' })
      }}
    >
      {children}
    </div>
  )
}
