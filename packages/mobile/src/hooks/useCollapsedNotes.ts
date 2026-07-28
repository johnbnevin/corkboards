/**
 * useCollapsedNotes — manage collapsed/minimized and dismissed note cards.
 *
 * Port of packages/web/src/hooks/useCollapsedNotes.ts for mobile.
 * Uses MMKV instead of IDB/localStorage, and React Native event emitter
 * patterns instead of window.dispatchEvent/sessionStorage.
 *
 * Collapsed = saved for later reading, still visible in feed
 * Soft-dismissed = visually blanked out but still in grid
 * Dismissed = removed from feed entirely on consolidate
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { mobileStorage } from '../storage/MmkvStorage';
import { STORAGE_KEYS } from '../lib/storageKeys';

const MAX_COLLAPSED_NOTES = 10000;
const MAX_DISMISSED_NOTES = 10000;
const MAX_SOFT_DISMISSED = 5000;
const MAX_UNDO_MAP = 1000;
const UNDO_WINDOW_MS = 20000;
const MAX_DISMISSED_THREAD_ROOTS = 2000;

// Use the core constants, not string literals: the constants are what
// PER_USER_KEYS and BACKED_UP_KEYS are built from, so a key spelled inline here
// is silently excluded from per-account isolation and from backups.
const COLLAPSED_KEY = STORAGE_KEYS.COLLAPSED_NOTES;
const DISMISSED_KEY = STORAGE_KEYS.DISMISSED_NOTES;
// Thread roots the user dismissed via "dismiss all associated". Persisted so
// that notes belonging to the thread which arrive LATER (autofetch, load-more,
// navigation) are also hidden — not just the ones visible at dismiss time.
const DISMISSED_THREAD_ROOTS_KEY = STORAGE_KEYS.DISMISSED_THREAD_ROOTS;

// Module-level shared state (mirrors web's module-level approach)
let _softDismissedSet: Set<string> = new Set();
let _sessionCollapsedIds: Set<string> = new Set();
let _sessionCollapsedCounter = 0;
const _dismissedUndoMap = new Map<string, number>();
const listeners = new Set<() => void>();

function notifyListeners() {
  notifyNoteState();
  listeners.forEach(fn => fn());
}

function loadFromMmkv(key: string): string[] {
  try {
    const stored = mobileStorage.getSync(key);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveToMmkv(key: string, value: string[]): void {
  try {
    mobileStorage.setSync(key, JSON.stringify(value));
  } catch { /* ignore */ }
}

// ─── Per-note external store ────────────────────────────────────────────────
//
// Mirrors packages/web/src/hooks/useCollapsedNotes.ts — keep the two in step.
//
// A card only needs to know about ITS OWN note. Reading the whole hook made
// every mounted card re-render on every dismissal (and, on mobile, parse the
// full persisted id lists out of MMKV on mount, once per card). Cards subscribe
// here per note id instead; a dismissal only re-renders the cards whose own
// snapshot changed.

/** Module mirror of the persisted collapsed list, loaded once and kept in step
 *  by the setter below, so a card never parses MMKV itself. */
let _collapsedSet: Set<string> | null = null;
function collapsedSet(): Set<string> {
  if (!_collapsedSet) _collapsedSet = new Set(loadFromMmkv(COLLAPSED_KEY));
  return _collapsedSet;
}

let _noteStateVersion = 0;
const _noteStateListeners = new Set<() => void>();

export interface NoteCollapsedState {
  isCollapsed: boolean;
  isCollapsedThisSession: boolean;
  isSoftDismissed: boolean;
  canUndoDismiss: boolean;
}

/** Snapshots must be referentially stable between notifications, or React
 *  re-renders forever. Cached per note id against the store version. */
const _noteSnapshots = new Map<string, { version: number; state: NoteCollapsedState }>();
const MAX_NOTE_SNAPSHOTS = 4000;

function notifyNoteState(): void {
  _noteStateVersion++;
  for (const listener of _noteStateListeners) listener();
}

/**
 * Nudge subscribers once the undo window closes. The affordance is time-based,
 * so nothing in the store changes when it expires — it has to announce itself
 * now that cards re-render on their own state alone.
 */
let _undoExpiryTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleUndoExpiry(): void {
  if (_undoExpiryTimer) clearTimeout(_undoExpiryTimer);
  _undoExpiryTimer = setTimeout(() => {
    _undoExpiryTimer = undefined;
    notifyNoteState();
  }, UNDO_WINDOW_MS + 100);
}

function getNoteSnapshot(noteId: string): NoteCollapsedState {
  const cached = _noteSnapshots.get(noteId);
  if (cached && cached.version === _noteStateVersion) return cached.state;
  const dismissedAt = _dismissedUndoMap.get(noteId);
  const state: NoteCollapsedState = {
    isCollapsed: collapsedSet().has(noteId),
    isCollapsedThisSession: _sessionCollapsedIds.has(noteId),
    isSoftDismissed: _softDismissedSet.has(noteId),
    canUndoDismiss: dismissedAt !== undefined && Date.now() - dismissedAt <= UNDO_WINDOW_MS,
  };
  // Cards unmount but their snapshots don't; drop the lot rather than track
  // liveness — rebuilding one is a handful of Set lookups.
  if (_noteSnapshots.size >= MAX_NOTE_SNAPSHOTS) _noteSnapshots.clear();
  _noteSnapshots.set(noteId, { version: _noteStateVersion, state });
  return state;
}

/**
 * Subscribe a single card to its own collapsed/dismissed state.
 *
 * Use this in anything rendered once per note. `useCollapsedNotes()` remains
 * the right call for screen-level consumers that need the lists and counts.
 */
export function useNoteCollapsedState(noteId: string): NoteCollapsedState {
  const subscribe = useCallback((onChange: () => void) => {
    _noteStateListeners.add(onChange);
    return () => { _noteStateListeners.delete(onChange); };
  }, []);
  const getSnapshot = useCallback(() => getNoteSnapshot(noteId), [noteId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function clearCollapsedNotesModuleState(): void {
  _softDismissedSet = new Set();
  _dismissedUndoMap.clear();
  _sessionCollapsedIds = new Set();
  _sessionCollapsedCounter = 0;
  _collapsedSet = new Set();
  _noteSnapshots.clear();
  notifyNoteState();
}

export interface CollapsedNotesActions {
  toggleCollapsed: (noteId: string) => void;
  collapse: (noteId: string) => void;
  expand: (noteId: string) => void;
  dismiss: (noteId: string) => void;
  undoDismiss: (noteId: string) => void;
  dismissMultiple: (noteIds: string[]) => void;
  dismissThreadRoots: (rootIds: string[]) => void;
}

// The live implementations, republished by every mounted `useCollapsedNotes()`
// on each render. Cards call through this so they get the verbs with a STABLE
// identity, without subscribing to the lists — see `useCollapsedNotesActions`.
// All mutation lands in module state + MMKV, so which instance publishes them
// makes no difference.
let _liveActions: CollapsedNotesActions | null = null;

const _stableActions: CollapsedNotesActions = {
  toggleCollapsed: (noteId) => _liveActions?.toggleCollapsed(noteId),
  collapse: (noteId) => _liveActions?.collapse(noteId),
  expand: (noteId) => _liveActions?.expand(noteId),
  dismiss: (noteId) => _liveActions?.dismiss(noteId),
  undoDismiss: (noteId) => _liveActions?.undoDismiss(noteId),
  dismissMultiple: (noteIds) => _liveActions?.dismissMultiple(noteIds),
  dismissThreadRoots: (rootIds) => _liveActions?.dismissThreadRoots(rootIds),
};

/**
 * Actions only, with an identity that never changes.
 *
 * Requires a `useCollapsedNotes()` somewhere up the tree — every screen that
 * renders cards has one. Pair with `useNoteCollapsedState`.
 */
export function useCollapsedNotesActions(): CollapsedNotesActions {
  return _stableActions;
}

export function useCollapsedNotes() {
  const [collapsedIds, setCollapsedIdsState] = useState<string[]>(() => loadFromMmkv(COLLAPSED_KEY));
  const [dismissedIds, setDismissedIdsState] = useState<string[]>(() => loadFromMmkv(DISMISSED_KEY));
  const [dismissedThreadRoots, setDismissedThreadRootsState] = useState<string[]>(() => loadFromMmkv(DISMISSED_THREAD_ROOTS_KEY));
  const [softDismissedIds, _setSoftDismissedIds] = useState<string[]>(() => [..._softDismissedSet]);
  const [undoMapVersion, setUndoMapVersion] = useState(0);
  const [sessionCollapsedCounter, setSessionCollapsedCounter] = useState(_sessionCollapsedCounter);
  const hasCleanedUp = useRef(false);

  // Persist collapsed/dismissed to MMKV on change
  const setCollapsedIds = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    setCollapsedIdsState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveToMmkv(COLLAPSED_KEY, next);
      // Keep the module mirror in step so per-note subscribers see it.
      _collapsedSet = new Set(next);
      notifyNoteState();
      return next;
    });
  }, []);

  const setDismissedIds = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    setDismissedIdsState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveToMmkv(DISMISSED_KEY, next);
      return next;
    });
  }, []);

  const setDismissedThreadRoots = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    setDismissedThreadRootsState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveToMmkv(DISMISSED_THREAD_ROOTS_KEY, next);
      return next;
    });
  }, []);

  // Listen for changes from other hook instances
  useEffect(() => {
    const fn = () => {
      _setSoftDismissedIds([..._softDismissedSet]);
      setUndoMapVersion(v => v + 1);
      setSessionCollapsedCounter(_sessionCollapsedCounter);
    };
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const collapsedSet = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const dismissedSet = useMemo(() => new Set(dismissedIds), [dismissedIds]);
  const softDismissedSet = useMemo(() => new Set(softDismissedIds), [softDismissedIds]);
  const dismissedThreadRootSet = useMemo(() => new Set(dismissedThreadRoots), [dismissedThreadRoots]);

  // Repair lists damaged by the old consolidate: a note cannot be both
  // saved-for-later and dismissed, so anything in both is a saved note that
  // consolidate wrongly dismissed. Un-dismiss it. No-op once the cause is
  // fixed, and `dismiss()` un-saves first, so a deliberate dismissal of a saved
  // note never lands here either. Mirrors web.
  useEffect(() => {
    if (collapsedIds.length === 0 || dismissedIds.length === 0) return;
    const saved = new Set(collapsedIds);
    const wronglyDismissed = dismissedIds.filter(id => saved.has(id));
    if (wronglyDismissed.length === 0) return;
    if (__DEV__) console.log(`[collapsedNotes] restoring ${wronglyDismissed.length} saved notes consolidate had dismissed`);
    const remove = new Set(wronglyDismissed);
    setDismissedIds(prev => prev.filter(id => !remove.has(id)));
  }, [collapsedIds, dismissedIds, setDismissedIds]);

  // Auto-cleanup on mount — one-shot via hasCleanedUp.current, so the v7
  // set-state-in-effect warning here is a false positive (no cascade possible).
  useEffect(() => {
    if (!hasCleanedUp.current) {
      hasCleanedUp.current = true;
      if (collapsedIds.length > MAX_COLLAPSED_NOTES) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setCollapsedIds(collapsedIds.slice(-MAX_COLLAPSED_NOTES));
      }
      if (dismissedIds.length > MAX_DISMISSED_NOTES) {
        setDismissedIds(dismissedIds.slice(-MAX_DISMISSED_NOTES));
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isCollapsed = useCallback((noteId: string) => collapsedSet.has(noteId), [collapsedSet]);
  const isDismissed = useCallback((noteId: string) => dismissedSet.has(noteId), [dismissedSet]);
  const isSoftDismissed = useCallback((noteId: string) => softDismissedSet.has(noteId), [softDismissedSet]);

  const isCollapsedThisSession = useCallback((noteId: string) => {
    return _sessionCollapsedIds.has(noteId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCollapsedCounter]);

  const updateSessionCollapsed = useCallback((noteId: string, action: 'add' | 'delete') => {
    const next = new Set(_sessionCollapsedIds);
    next[action](noteId);
    _sessionCollapsedIds = next;
    _sessionCollapsedCounter++;
    notifyListeners();
  }, []);

  const toggleCollapsed = useCallback((noteId: string) => {
    setCollapsedIds(prev => {
      if (prev.includes(noteId)) {
        updateSessionCollapsed(noteId, 'delete');
        return prev.filter(id => id !== noteId);
      } else {
        updateSessionCollapsed(noteId, 'add');
        const newList = [...prev, noteId];
        return newList.length > MAX_COLLAPSED_NOTES ? newList.slice(-MAX_COLLAPSED_NOTES) : newList;
      }
    });
  }, [setCollapsedIds, updateSessionCollapsed]);

  const collapse = useCallback((noteId: string) => {
    updateSessionCollapsed(noteId, 'add');
    setCollapsedIds(prev => {
      if (prev.includes(noteId)) return prev;
      const newList = [...prev, noteId];
      return newList.length > MAX_COLLAPSED_NOTES ? newList.slice(-MAX_COLLAPSED_NOTES) : newList;
    });
  }, [setCollapsedIds, updateSessionCollapsed]);

  const expand = useCallback((noteId: string) => {
    updateSessionCollapsed(noteId, 'delete');
    setCollapsedIds(prev => prev.filter(id => id !== noteId));
  }, [setCollapsedIds, updateSessionCollapsed]);

  const dismiss = useCallback((noteId: string) => {
    setCollapsedIds(prev => prev.filter(id => id !== noteId));
    if (!_softDismissedSet.has(noteId)) {
      const next = new Set(_softDismissedSet);
      next.add(noteId);
      if (next.size > MAX_SOFT_DISMISSED) {
        const first = next.values().next().value!;
        next.delete(first);
      }
      _softDismissedSet = next;
      _setSoftDismissedIds([..._softDismissedSet]);
      notifyListeners();
    }
    _dismissedUndoMap.set(noteId, Date.now());
    scheduleUndoExpiry();
    if (_dismissedUndoMap.size > MAX_UNDO_MAP) {
      const now = Date.now();
      for (const [id, ts] of _dismissedUndoMap) {
        if (now - ts > UNDO_WINDOW_MS) _dismissedUndoMap.delete(id);
      }
    }
    setUndoMapVersion(v => v + 1);
    notifyListeners();
  }, [setCollapsedIds]);

  const undoDismiss = useCallback((noteId: string) => {
    const dismissedAt = _dismissedUndoMap.get(noteId);
    if (!dismissedAt || Date.now() - dismissedAt > UNDO_WINDOW_MS) return;

    const next = new Set(_softDismissedSet);
    next.delete(noteId);
    _softDismissedSet = next;
    _setSoftDismissedIds([..._softDismissedSet]);
    _dismissedUndoMap.delete(noteId);
    setUndoMapVersion(v => v + 1);
    notifyListeners();
  }, []);

  const canUndoDismiss = useCallback((noteId: string) => {
    const dismissedAt = _dismissedUndoMap.get(noteId);
    if (!dismissedAt) return false;
    return Date.now() - dismissedAt <= UNDO_WINDOW_MS;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoMapVersion]);

  const consolidate = useCallback(() => {
    if (_softDismissedSet.size === 0 && collapsedIds.length === 0) return;
    const softSnapshot = [..._softDismissedSet];
    // Saved-for-later notes are NOT dismissed. This used to spread
    // `...collapsedIds` in as well, so every consolidate marked the entire
    // saved list as dismissed — notes the user deliberately kept, removed from
    // the feed permanently. Clearing _sessionCollapsedIds below already removes
    // their blank placeholders, which was the actual goal. Mirrors web.
    setDismissedIds(prev => {
      const unique = [...new Set([...prev, ...softSnapshot])];
      return unique.length > MAX_DISMISSED_NOTES ? unique.slice(-MAX_DISMISSED_NOTES) : unique;
    });
    _softDismissedSet = new Set();
    _setSoftDismissedIds([]);
    // Clear undo state — consolidate is an explicit user action
    _dismissedUndoMap.clear();
    setUndoMapVersion(v => v + 1);
    _sessionCollapsedIds = new Set();
    _sessionCollapsedCounter++;
    notifyListeners();
  }, [setDismissedIds, collapsedIds]);

  const dismissMultiple = useCallback((noteIds: string[]) => {
    const idSet = new Set(noteIds);
    setCollapsedIds(prev => prev.filter(id => !idSet.has(id)));
    const next = new Set(_softDismissedSet);
    for (const id of noteIds) next.add(id);
    _softDismissedSet = next;
    _setSoftDismissedIds([..._softDismissedSet]);
    notifyListeners();
  }, [setCollapsedIds]);

  /** Record thread root ids as dismissed so future-loaded thread members are
   *  also hidden by the feed filter. Idempotent + bounded. */
  const dismissThreadRoots = useCallback((rootIds: string[]) => {
    if (rootIds.length === 0) return;
    setDismissedThreadRoots(prev => {
      const merged = new Set(prev);
      for (const id of rootIds) merged.add(id);
      if (merged.size === prev.length) return prev;
      const arr = [...merged];
      return arr.length > MAX_DISMISSED_THREAD_ROOTS ? arr.slice(-MAX_DISMISSED_THREAD_ROOTS) : arr;
    });
  }, [setDismissedThreadRoots]);

  const isDismissedThreadRoot = useCallback((id: string) => {
    return dismissedThreadRootSet.has(id);
  }, [dismissedThreadRootSet]);

  const dismissAllCollapsed = useCallback(() => {
    const next = new Set(_softDismissedSet);
    for (const id of collapsedIds) next.add(id);
    _softDismissedSet = next;
    _setSoftDismissedIds([..._softDismissedSet]);
    notifyListeners();
    setCollapsedIds([]);
  }, [collapsedIds, setCollapsedIds]);

  const clearAll = useCallback(() => {
    setCollapsedIds([]);
  }, [setCollapsedIds]);

  const clearDismissed = useCallback(() => {
    setDismissedIds([]);
    setDismissedThreadRoots([]);
    _softDismissedSet = new Set();
    _setSoftDismissedIds([]);
    notifyListeners();
  }, [setDismissedIds, setDismissedThreadRoots]);

  // Restore a specific subset of dismissed notes (e.g. only the user's own).
  const undismissMany = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const remove = new Set(ids);
    setDismissedIds(prev => prev.filter(id => !remove.has(id)));
    let changed = false;
    for (const id of ids) { if (_softDismissedSet.delete(id)) changed = true; }
    if (changed) {
      _setSoftDismissedIds([..._softDismissedSet]);
      notifyListeners();
    }
  }, [setDismissedIds]);

  // Republish this instance's callbacks for `useCollapsedNotesActions`. Plain
  // assignment during render is safe here: it's idempotent, and every instance
  // drives the same module-level state.
  _liveActions = {
    toggleCollapsed, collapse, expand, dismiss, undoDismiss, dismissMultiple, dismissThreadRoots,
  };

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
  };
}
