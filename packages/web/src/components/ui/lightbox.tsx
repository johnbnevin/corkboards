import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Global lightbox state ────────────────────────────────────────────────────
// Lifted out of individual LightboxTrigger components so that re-renders
// (e.g. from autofetch updating the notes list) don't reset the open state.

type LightboxState = { src: string; alt: string } | null
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
      className="fixed inset-0 z-[9999]"
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
            src={state.src}
            alt={state.alt}
            className="w-full h-auto max-h-[85vh] object-contain rounded-lg shadow-2xl"
          />
        </div>

        {/* Open in new tab link */}
        <a
          href={state.src}
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
  src: string
  alt?: string
  className?: string
  children: React.ReactNode
}

export function LightboxTrigger({ src, alt, className, children }: LightboxTriggerProps) {
  return (
    <div
      className={cn('cursor-zoom-in', className)}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.nativeEvent.stopImmediatePropagation()
        setGlobalLightbox({ src, alt: alt ?? '' })
      }}
    >
      {children}
    </div>
  )
}

// ── Legacy Lightbox component (kept for any direct usage) ────────────────────

interface LightboxProps {
  src: string
  alt?: string
  isOpen: boolean
  onClose: () => void
}

export function Lightbox({ src, alt = '', isOpen, onClose }: LightboxProps) {
  React.useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const lightboxContent = (
    <div
      className="fixed inset-0 z-[9999]"
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClose() }}
    >
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClose() }} />
      <div className="absolute inset-0 flex items-center justify-center p-4" onClick={(e) => { e.stopPropagation(); onClose() }}>
        <button onClick={(e) => { e.stopPropagation(); onClose() }} className="absolute top-4 right-4 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors z-10" aria-label="Close lightbox">
          <X className="h-6 w-6" />
        </button>
        <div className="relative w-full max-w-7xl mx-auto" onClick={(e) => { e.stopPropagation() }}>
          <img src={src} alt={alt} className="w-full h-auto max-h-[85vh] object-contain rounded-lg shadow-2xl" referrerPolicy="no-referrer" />
        </div>
        <a href={src} target="_blank" rel="noopener noreferrer" className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/50 hover:bg-black/70 text-white text-sm transition-colors" onClick={(e) => { e.stopPropagation() }}>
          Open original
        </a>
      </div>
    </div>
  )

  return createPortal(lightboxContent, document.body)
}
