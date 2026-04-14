import { useCallback, useMemo, useEffect, useRef, useState } from 'react'
import { useLocalStorage } from './useLocalStorage'

const MAX_COLLAPSED_NOTES = 10000 // Keep memory bounded

/** Event dispatched when a note is saved/unsaved so bookmark sync can listen */
export const BOOKMARK_SYNC_EVENT = 'corkboard:bookmark-sync'
function notifyBookmarkSync(noteId: string, action: 'add' | 'remove') {
  window.dispatchEvent(new CustomEvent(BOOKMARK_SYNC_EVENT, { detail: { noteId, action } }))
}
const MAX_DISMISSED_NOTES = 10000  // Capped to keep Nostr backup manageable

// Module-level shared state for soft-dismissed notes (session-only, shared across all hook instances)
// Hydrate from sessionStorage so they survive mobile background tab kills
// Uses a Set for O(1) lookups and atomic snapshot reads via spread operator
const MAX_SOFT_DISMISSED = 5000
let _softDismissedSet: Set<string> = (() => {
  try { return new Set<string>(JSON.parse(sessionStorage.getItem('corkboard:soft-dismissed') || '[]').slice(-MAX_SOFT_DISMISSED)) }
  catch { /* empty */ return new Set<string>() }
})()
const SOFT_DISMISS_EVENT = 'soft-dismiss-sync'

function persistSoftDismissed() {
  try { sessionStorage.setItem('corkboard:soft-dismissed', JSON.stringify([..._softDismissedSet])) }
  catch { /* empty */ }
}

// Track dismissed notes independently for per-card undo (noteId → timestamp)
// Capped to prevent unbounded growth — entries expire after UNDO_WINDOW_MS anyway
const MAX_UNDO_MAP = 1000
const _dismissedUndoMap = new Map<string, number>()
const UNDO_WINDOW_MS = 20000 // 20 seconds to undo
const LAST_DISMISSED_EVENT = 'last-dismissed-sync'

function notifyLastDismissedChange() {
  window.dispatchEvent(new CustomEvent(LAST_DISMISSED_EVENT))
}

// Track which notes were collapsed DURING this session (not from restore/localStorage init)
// Hydrate from sessionStorage so they survive mobile background tab kills
const MAX_SESSION_COLLAPSED = 10000
let _sessionCollapsedIds: Set<string> = (() => {
  try {
    const arr: string[] = JSON.parse(sessionStorage.getItem('corkboard:session-collapsed') || '[]')
    return new Set<string>(arr.slice(-MAX_SESSION_COLLAPSED))
  }
  catch { /* empty */ return new Set<string>() }
})()

// Counter to trigger re-renders when session collapsed set changes
let _sessionCollapsedCounter = 0
const SESSION_COLLAPSED_EVENT = 'session-collapsed-sync'

function notifySessionCollapsedChange() {
  try { sessionStorage.setItem('corkboard:session-collapsed', JSON.stringify([..._sessionCollapsedIds])) }
  catch { /* empty */ }
  window.dispatchEvent(new CustomEvent(SESSION_COLLAPSED_EVENT))
}

function notifySoftDismissChange() {
  window.dispatchEvent(new CustomEvent(SOFT_DISMISS_EVENT))
}

/** Clear all module-level state (call on logout/wipe) */
export function clearCollapsedNotesModuleState(): void {
  _softDismissedSet = new Set()
  _dismissedUndoMap.clear()
  _sessionCollapsedIds = new Set()
  _sessionCollapsedCounter = 0
  try { sessionStorage.removeItem('corkboard:soft-dismissed') } catch { /* empty */ }
  try { sessionStorage.removeItem('corkboard:session-collapsed') } catch { /* empty */ }
}

/**
 * Hook to manage collapsed/minimized and dismissed note cards.
 * Collapsed = saved for later reading, still visible in feed above the fold
 * Soft-dismissed = visually blanked out (placeholder) but still in grid to prevent layout jump
 * Dismissed = removed from feed entirely on consolidate (saves DOM memory)
 *
 * Both states persist between sessions via localStorage.
 * Uses Sets for O(1) lookups.
 */
export function useCollapsedNotes() {
  const [collapsedIds, setCollapsedIds] = useLocalStorage<string[]>('collapsed-notes', [])
  const [dismissedIds, setDismissedIds] = useLocalStorage<string[]>('dismissed-notes', [])
  const hasCleanedUp = useRef(false)

  // Soft-dismissed: shared module state, synced via custom event
  const [softDismissedIds, _setSoftDismissedIds] = useState<string[]>(() => [..._softDismissedSet])

  // Track dismissed notes for per-card undo — counter triggers re-renders
  const [undoMapVersion, setUndoMapVersion] = useState(0)

  // Session-collapsed counter: triggers re-render when notes are collapsed this session
  const [sessionCollapsedCounter, setSessionCollapsedCounter] = useState(_sessionCollapsedCounter)

  // Listen for changes from other hook instances using AbortController
  // to prevent listener accumulation in StrictMode
  useEffect(() => {
    const ac = new AbortController()
    window.addEventListener(SOFT_DISMISS_EVENT, () => _setSoftDismissedIds([..._softDismissedSet]), { signal: ac.signal })
    window.addEventListener(LAST_DISMISSED_EVENT, () => setUndoMapVersion(v => v + 1), { signal: ac.signal })
    window.addEventListener(SESSION_COLLAPSED_EVENT, () => setSessionCollapsedCounter(() => _sessionCollapsedCounter), { signal: ac.signal })
    return () => ac.abort()
  }, [])

  // Convert to Sets for O(1) lookups
  const collapsedSet = useMemo(() => new Set(collapsedIds), [collapsedIds])
  const dismissedSet = useMemo(() => new Set(dismissedIds), [dismissedIds])
  const softDismissedSet = useMemo(() => new Set(softDismissedIds), [softDismissedIds])

  // Auto-cleanup on mount if over limits
  useEffect(() => {
    if (!hasCleanedUp.current) {
      hasCleanedUp.current = true
      if (collapsedIds.length > MAX_COLLAPSED_NOTES) {
        setCollapsedIds(collapsedIds.slice(-MAX_COLLAPSED_NOTES))
      }
      if (dismissedIds.length > MAX_DISMISSED_NOTES) {
        setDismissedIds(dismissedIds.slice(-MAX_DISMISSED_NOTES))
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const isCollapsed = useCallback((noteId: string) => {
    return collapsedSet.has(noteId)
  }, [collapsedSet])

  const isDismissed = useCallback((noteId: string) => {
    return dismissedSet.has(noteId)
  }, [dismissedSet])

  const isSoftDismissed = useCallback((noteId: string) => {
    return softDismissedSet.has(noteId)
  }, [softDismissedSet])

  const isCollapsedThisSession = useCallback((noteId: string) => {
    return _sessionCollapsedIds.has(noteId)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionCollapsedCounter is an intentional re-run trigger to invalidate downstream useMemos
  }, [sessionCollapsedCounter])

  const updateSessionCollapsed = useCallback((noteId: string, action: 'add' | 'delete') => {
    const next = new Set(_sessionCollapsedIds)
    next[action](noteId)
    _sessionCollapsedIds = next
    _sessionCollapsedCounter++
    notifySessionCollapsedChange()
    notifyBookmarkSync(noteId, action === 'add' ? 'add' : 'remove')
  }, [])

  const toggleCollapsed = useCallback((noteId: string) => {
    setCollapsedIds(prev => {
      if (prev.includes(noteId)) {
        updateSessionCollapsed(noteId, 'delete')
        return prev.filter(id => id !== noteId)
      } else {
        updateSessionCollapsed(noteId, 'add')
        const newList = [...prev, noteId]
        return newList.length > MAX_COLLAPSED_NOTES
          ? newList.slice(-MAX_COLLAPSED_NOTES)
          : newList
      }
    })
  }, [setCollapsedIds, updateSessionCollapsed])

  const collapse = useCallback((noteId: string) => {
    updateSessionCollapsed(noteId, 'add')
    setCollapsedIds(prev => {
      if (prev.includes(noteId)) return prev
      const newList = [...prev, noteId]
      return newList.length > MAX_COLLAPSED_NOTES
        ? newList.slice(-MAX_COLLAPSED_NOTES)
        : newList
    })
  }, [setCollapsedIds, updateSessionCollapsed])

  const expand = useCallback((noteId: string) => {
    updateSessionCollapsed(noteId, 'delete')
    setCollapsedIds(prev => prev.filter(id => id !== noteId))
  }, [setCollapsedIds, updateSessionCollapsed])

  /** Soft-dismiss a note — blanks it out visually but preserves grid space.
   *  Actual removal happens on consolidate. */
  const dismiss = useCallback((noteId: string) => {
    // Remove from collapsed
    setCollapsedIds(prev => prev.filter(id => id !== noteId))
    // Add to soft-dismissed (shared session state) — atomic Set replacement
    if (!_softDismissedSet.has(noteId)) {
      const next = new Set(_softDismissedSet)
      next.add(noteId)
      if (next.size > MAX_SOFT_DISMISSED) {
        const first = next.values().next().value!
        next.delete(first)
      }
      _softDismissedSet = next
      _setSoftDismissedIds([..._softDismissedSet])
      persistSoftDismissed()
      notifySoftDismissChange()
    }
    // Track for per-card undo (each card gets its own 20s window)
    _dismissedUndoMap.set(noteId, Date.now())
    // Prune expired entries to keep map bounded
    if (_dismissedUndoMap.size > MAX_UNDO_MAP) {
      const now = Date.now()
      for (const [id, ts] of _dismissedUndoMap) {
        if (now - ts > UNDO_WINDOW_MS) _dismissedUndoMap.delete(id)
      }
    }
    setUndoMapVersion(v => v + 1)
    notifyLastDismissedChange()
  }, [setCollapsedIds])

  /** Undo a dismiss (within its 20 second window) */
  const undoDismiss = useCallback((noteId: string) => {
    const dismissedAt = _dismissedUndoMap.get(noteId)
    if (!dismissedAt || Date.now() - dismissedAt > UNDO_WINDOW_MS) return

    // Remove from soft-dismissed — atomic Set replacement
    const next = new Set(_softDismissedSet)
    next.delete(noteId)
    _softDismissedSet = next
    _setSoftDismissedIds([..._softDismissedSet])
    persistSoftDismissed()
    notifySoftDismissChange()
    _dismissedUndoMap.delete(noteId)
    setUndoMapVersion(v => v + 1)
    notifyLastDismissedChange()
  }, [])

  /** Check if a note can be undone (was dismissed within its 20 second window) */
  const canUndoDismiss = useCallback((noteId: string) => {
    const dismissedAt = _dismissedUndoMap.get(noteId)
    if (!dismissedAt) return false
    return Date.now() - dismissedAt <= UNDO_WINDOW_MS
  // eslint-disable-next-line react-hooks/exhaustive-deps -- undoMapVersion is an intentional re-run trigger to invalidate downstream useMemos
  }, [undoMapVersion])

  /** Consolidate: move soft-dismissed AND collapsed (saved-for-later) placeholder
   *  notes into the permanent dismissed list, removing all blank spaces from the grid.
   *  Collapsed notes remain in the collapsed list so they still appear above the fold. */
  const consolidate = useCallback(() => {
    if (_softDismissedSet.size === 0 && collapsedIds.length === 0) return
    // Partition soft-dismissed: skip notes still within their undo window
    const now = Date.now()
    const readyToConsolidate: string[] = []
    const stillUndoable: string[] = []
    for (const id of _softDismissedSet) {
      const dismissedAt = _dismissedUndoMap.get(id)
      if (dismissedAt && now - dismissedAt <= UNDO_WINDOW_MS) {
        stillUndoable.push(id)
      } else {
        readyToConsolidate.push(id)
      }
    }
    setDismissedIds(prev => {
      const unique = [...new Set([...prev, ...readyToConsolidate, ...collapsedIds])]
      return unique.length > MAX_DISMISSED_NOTES ? unique.slice(-MAX_DISMISSED_NOTES) : unique
    })
    // Keep undoable notes as soft-dismissed so their undo buttons still work
    _softDismissedSet = new Set(stillUndoable)
    _setSoftDismissedIds(stillUndoable)
    persistSoftDismissed()
    notifySoftDismissChange()
    // Clear session collapsed tracking since consolidate removes the blank spaces
    _sessionCollapsedIds = new Set()
    _sessionCollapsedCounter++
    notifySessionCollapsedChange()
  }, [setDismissedIds, collapsedIds])

  /** Dismiss multiple notes at once — efficient for bulk operations */
  const dismissMultiple = useCallback((noteIds: string[]) => {
    const idSet = new Set(noteIds)
    setCollapsedIds(prev => prev.filter(id => !idSet.has(id)))
    // Atomic Set replacement
    const next = new Set(_softDismissedSet)
    for (const id of noteIds) next.add(id)
    _softDismissedSet = next
    _setSoftDismissedIds([..._softDismissedSet])
    persistSoftDismissed()
    notifySoftDismissChange()
  }, [setCollapsedIds])

  /** Dismiss all currently collapsed notes at once */
  const dismissAllCollapsed = useCallback(() => {
    const next = new Set(_softDismissedSet)
    for (const id of collapsedIds) next.add(id)
    _softDismissedSet = next
    _setSoftDismissedIds([..._softDismissedSet])
    persistSoftDismissed()
    notifySoftDismissChange()
    setCollapsedIds([])
  }, [collapsedIds, setCollapsedIds])

  // Clear all collapsed notes (expand them)
  const clearAll = useCallback(() => {
    setCollapsedIds([])
  }, [setCollapsedIds])

  // Clear all dismissed notes (they'll reappear)
  const clearDismissed = useCallback(() => {
    setDismissedIds([])
    _softDismissedSet = new Set()
    _setSoftDismissedIds([])
    persistSoftDismissed()
    notifySoftDismissChange()
  }, [setDismissedIds])

  return {
    isCollapsed,
    isCollapsedThisSession,
    isDismissed,
    isSoftDismissed,
    toggleCollapsed,
    collapse,
    expand,
    dismiss,
    undoDismiss,
    canUndoDismiss,
    consolidate,
    dismissMultiple,
    dismissAllCollapsed,
    clearAll,
    clearDismissed,
    collapsedIds,
    collapsedCount: collapsedIds.length,
    dismissedCount: dismissedIds.length,
    softDismissedCount: softDismissedIds.length,
  }
}
