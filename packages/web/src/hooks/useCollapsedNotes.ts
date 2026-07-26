import { useCallback, useMemo, useEffect, useRef, useState, createContext, useContext, createElement, type ReactNode } from 'react'
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

// Track batch dismissals: trigger noteId → Set of all noteIds dismissed with it.
// Undoing the trigger undoes the entire batch; undoing a non-trigger undoes only that note.
const _dismissBatchMap = new Map<string, Set<string>>()
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
const MAX_DISMISSED_THREAD_ROOTS = 2000

function useCollapsedNotesState() {
  const [collapsedIds, setCollapsedIds] = useLocalStorage<string[]>('collapsed-notes', [])
  const [dismissedIds, setDismissedIds] = useLocalStorage<string[]>('dismissed-notes', [])
  // Thread roots the user dismissed via "dismiss all associated". Persisted so
  // that notes belonging to the thread which arrive LATER (autofetch, load-more,
  // navigation) are also hidden — not just the ones visible at dismiss time.
  const [dismissedThreadRoots, setDismissedThreadRoots] = useLocalStorage<string[]>('dismissed-thread-roots', [])
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
  const dismissedThreadRootSet = useMemo(() => new Set(dismissedThreadRoots), [dismissedThreadRoots])

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

  /** Undo a dismiss (within its 20 second window).
   *  If this note was the trigger of a batch dismiss, undo the entire batch. */
  const undoDismiss = useCallback((noteId: string) => {
    const dismissedAt = _dismissedUndoMap.get(noteId)
    if (!dismissedAt || Date.now() - dismissedAt > UNDO_WINDOW_MS) return

    // Check if this was the trigger of a batch — undo all in the batch
    const batch = _dismissBatchMap.get(noteId)
    const idsToUndo = batch ? Array.from(batch) : [noteId]

    const next = new Set(_softDismissedSet)
    for (const id of idsToUndo) {
      next.delete(id)
      _dismissedUndoMap.delete(id)
    }
    _softDismissedSet = next
    _setSoftDismissedIds([..._softDismissedSet])
    persistSoftDismissed()
    notifySoftDismissChange()
    _dismissBatchMap.delete(noteId)
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

  /** Check if undoing this note would undo an entire batch (it was the trigger) */
  const isBatchTrigger = useCallback((noteId: string) => {
    return _dismissBatchMap.has(noteId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoMapVersion])

  /** Consolidate: move soft-dismissed AND collapsed (saved-for-later) placeholder
   *  notes into the permanent dismissed list, removing all blank spaces from the grid.
   *  Collapsed notes remain in the collapsed list so they still appear above the fold.
   *  All soft-dismissed notes are consolidated, including those still in their undo window. */
  const consolidate = useCallback(() => {
    if (_softDismissedSet.size === 0 && collapsedIds.length === 0) return
    const allSoftDismissed = [..._softDismissedSet]
    setDismissedIds(prev => {
      const unique = [...new Set([...prev, ...allSoftDismissed, ...collapsedIds])]
      return unique.length > MAX_DISMISSED_NOTES ? unique.slice(-MAX_DISMISSED_NOTES) : unique
    })
    // Clear all soft-dismissed and undo state — consolidate is an explicit user action
    _softDismissedSet = new Set()
    _setSoftDismissedIds([])
    persistSoftDismissed()
    notifySoftDismissChange()
    _dismissedUndoMap.clear()
    setUndoMapVersion(v => v + 1)
    // Clear session collapsed tracking since consolidate removes the blank spaces
    _sessionCollapsedIds = new Set()
    _sessionCollapsedCounter++
    notifySessionCollapsedChange()
  }, [setDismissedIds, collapsedIds])

  /** Dismiss multiple notes at once.
   *  @param triggerId — the note the user clicked to dismiss. Undoing this note undoes all. */
  const dismissMultiple = useCallback((noteIds: string[], triggerId?: string) => {
    const idSet = new Set(noteIds)
    setCollapsedIds(prev => prev.filter(id => !idSet.has(id)))
    const next = new Set(_softDismissedSet)
    const now = Date.now()
    for (const id of noteIds) {
      next.add(id)
      _dismissedUndoMap.set(id, now)
    }
    _softDismissedSet = next
    _setSoftDismissedIds([..._softDismissedSet])
    persistSoftDismissed()
    notifySoftDismissChange()
    // Track the batch so undoing the trigger undoes all
    if (triggerId && noteIds.length > 1) {
      _dismissBatchMap.set(triggerId, new Set(noteIds))
    }
    setUndoMapVersion(v => v + 1)
    notifyLastDismissedChange()
  }, [setCollapsedIds])

  /** Record thread root ids as dismissed so future-loaded thread members are
   *  also hidden by the feed filter. Idempotent + bounded. */
  const dismissThreadRoots = useCallback((rootIds: string[]) => {
    if (rootIds.length === 0) return
    setDismissedThreadRoots(prev => {
      const merged = new Set(prev)
      for (const id of rootIds) merged.add(id)
      if (merged.size === prev.length) return prev
      const arr = [...merged]
      return arr.length > MAX_DISMISSED_THREAD_ROOTS ? arr.slice(-MAX_DISMISSED_THREAD_ROOTS) : arr
    })
  }, [setDismissedThreadRoots])

  const isDismissedThreadRoot = useCallback((id: string) => {
    return dismissedThreadRootSet.has(id)
  }, [dismissedThreadRootSet])

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
    setDismissedThreadRoots([])
    _softDismissedSet = new Set()
    _setSoftDismissedIds([])
    persistSoftDismissed()
    notifySoftDismissChange()
  }, [setDismissedIds, setDismissedThreadRoots])

  // Restore a specific subset of dismissed notes (e.g. only the user's own).
  const undismissMany = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    const remove = new Set(ids)
    setDismissedIds(prev => prev.filter(id => !remove.has(id)))
    // Also drop from the session soft-dismissed set if present.
    let changed = false
    for (const id of ids) { if (_softDismissedSet.delete(id)) changed = true }
    if (changed) {
      _setSoftDismissedIds([..._softDismissedSet])
      persistSoftDismissed()
      notifySoftDismissChange()
    }
  }, [setDismissedIds])

  // Memoized so the single provider below hands a stable value to every consumer
  // — it changes only when the underlying state does, not on every provider
  // re-render. All the fields below are either useCallback-stable or the state
  // arrays/sets themselves.
  return useMemo(() => ({
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
    isBatchTrigger,
    consolidate,
    dismissMultiple,
    dismissThreadRoots,
    isDismissedThreadRoot,
    dismissedThreadRootSet,
    dismissAllCollapsed,
    clearAll,
    clearDismissed,
    undismissMany,
    collapsedIds,
    dismissedIds,
    collapsedCount: collapsedIds.length,
    dismissedCount: dismissedIds.length,
    softDismissedCount: softDismissedIds.length,
  }), [
    isCollapsed, isCollapsedThisSession, isDismissed, isSoftDismissed, toggleCollapsed, collapse, expand,
    dismiss, undoDismiss, canUndoDismiss, isBatchTrigger, consolidate, dismissMultiple, dismissThreadRoots,
    isDismissedThreadRoot, dismissedThreadRootSet, dismissAllCollapsed, clearAll, clearDismissed, undismissMany,
    collapsedIds, dismissedIds, softDismissedIds,
  ])
}

export type CollapsedNotesValue = ReturnType<typeof useCollapsedNotesState>

const CollapsedNotesContext = createContext<CollapsedNotesValue | null>(null)

/**
 * Provides ONE shared collapsed/dismissed/saved-notes store for the whole app.
 *
 * Before this, every NoteCard (and each notification/saved card) called
 * useCollapsedNotes() directly — so each card parsed 3 persisted arrays, rebuilt
 * 4 Sets, and registered 6 window listeners. A feed of hundreds of cards did all
 * of that hundreds of times over on mount and again whenever the lists changed.
 * The heavy work now happens once here; cards read the result cheaply via
 * context. The soft-dismiss / undo / session-collapsed state was already
 * module-level and shared, so behavior is unchanged — only the per-card cost is
 * gone.
 */
export function CollapsedNotesProvider({ children }: { children: ReactNode }) {
  const value = useCollapsedNotesState()
  return createElement(CollapsedNotesContext.Provider, { value }, children)
}

export function useCollapsedNotes(): CollapsedNotesValue {
  const ctx = useContext(CollapsedNotesContext)
  if (!ctx) throw new Error('useCollapsedNotes must be used within a CollapsedNotesProvider')
  return ctx
}
