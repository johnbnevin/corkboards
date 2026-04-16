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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mobileStorage } from '../storage/MmkvStorage';

const MAX_COLLAPSED_NOTES = 10000;
const MAX_DISMISSED_NOTES = 10000;
const MAX_SOFT_DISMISSED = 5000;
const MAX_UNDO_MAP = 1000;
const UNDO_WINDOW_MS = 20000;

const COLLAPSED_KEY = 'collapsed-notes';
const DISMISSED_KEY = 'dismissed-notes';

// Module-level shared state (mirrors web's module-level approach)
let _softDismissedSet: Set<string> = new Set();
let _sessionCollapsedIds: Set<string> = new Set();
let _sessionCollapsedCounter = 0;
const _dismissedUndoMap = new Map<string, number>();
const listeners = new Set<() => void>();

function notifyListeners() {
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

export function clearCollapsedNotesModuleState(): void {
  _softDismissedSet = new Set();
  _dismissedUndoMap.clear();
  _sessionCollapsedIds = new Set();
  _sessionCollapsedCounter = 0;
}

export function useCollapsedNotes() {
  const [collapsedIds, setCollapsedIdsState] = useState<string[]>(() => loadFromMmkv(COLLAPSED_KEY));
  const [dismissedIds, setDismissedIdsState] = useState<string[]>(() => loadFromMmkv(DISMISSED_KEY));
  const [softDismissedIds, _setSoftDismissedIds] = useState<string[]>(() => [..._softDismissedSet]);
  const [undoMapVersion, setUndoMapVersion] = useState(0);
  const [sessionCollapsedCounter, setSessionCollapsedCounter] = useState(_sessionCollapsedCounter);
  const hasCleanedUp = useRef(false);

  // Persist collapsed/dismissed to MMKV on change
  const setCollapsedIds = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    setCollapsedIdsState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveToMmkv(COLLAPSED_KEY, next);
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

  // Auto-cleanup on mount
  useEffect(() => {
    if (!hasCleanedUp.current) {
      hasCleanedUp.current = true;
      if (collapsedIds.length > MAX_COLLAPSED_NOTES) {
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
    setDismissedIds(prev => {
      const unique = [...new Set([...prev, ...softSnapshot, ...collapsedIds])];
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
    _softDismissedSet = new Set();
    _setSoftDismissedIds([]);
    notifyListeners();
  }, [setDismissedIds]);

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
  };
}
