import { useState, useEffect, useMemo, memo, useCallback } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { RSS_PUBKEY } from '@core/rss';
import { getParentId } from '@core/threadTree';
import { type NostrEvent } from '@nostrify/nostrify';
import { NoteCard } from '@/components/NoteCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Save, RotateCcw } from 'lucide-react';
import { useCollapsedNotes } from '@/hooks/useCollapsedNotes';
import { useBookmarks } from '@/hooks/useBookmarks';
import { useParentNotes } from '@/hooks/useParentNotes';
import { usePinnedNotes } from '@/hooks/usePinnedNotes';
import { getUserRelays, FALLBACK_RELAYS } from '@/components/NostrProvider';
import { useNostr } from '@nostrify/react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/useToast';
import { ZapDialog } from '@/components/ZapDialog';
import { queryRelay } from '@/lib/fetchEvent';
import { idbReady } from '@/lib/idb';

interface SavedForLaterCorkboardProps {
  onThreadClick: (eventId: string) => void;
  onOpenThread: (eventId: string) => void;
  columnCount?: number;
}

/**
 * Renders the "Saved for Later" tab.
 *
 * Self-contained: owns its own `useCollapsedNotes()` so that dismissing
 * a note only re-renders THIS component, not the entire MultiColumnClient.
 * Wrapped in React.memo so the parent's unrelated state changes don't
 * cause unnecessary re-renders here.
 */
export const SavedForLaterCorkboard = memo(function SavedForLaterCorkboard({
  onThreadClick,
  onOpenThread,
  columnCount = 3,
}: SavedForLaterCorkboardProps) {
  // Own the collapsed state here — dismiss/expand only re-renders this component
  const { collapsedIds, expand, dismissFromSaved, isPendingSavedDismissal } = useCollapsedNotes();
  const { nostr } = useNostr();
  const { bookmarkIds } = useBookmarks();
  const { pinnedIds, togglePin } = usePinnedNotes();

  // Merge collapsed IDs with bookmark IDs (union) for backward compat
  const savedIds = useMemo(() => {
    return [...new Set([...collapsedIds, ...bookmarkIds])];
  }, [collapsedIds, bookmarkIds]);
  const { toast } = useToast();
  // The saved-id list lives in IndexedDB and is read through a synchronous
  // memory cache that is EMPTY until idbReady resolves. Rendering before then
  // shows a partial list as though it were the whole thing — "137 saved" one
  // moment and "70 saved" the next, which reads as data loss and, across two
  // devices, as a sync failure. Wait for hydration before showing any count.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    idbReady.then(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, []);
  const [zapTargetNote, setZapTargetNote] = useState<NostrEvent | null>(null);
  const [minimizedNoteIds, setMinimizedNoteIds] = useLocalStorage<string[]>('saved-minimized-notes', []);

  const gridStyle = { gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` };

  // Key the fetch on the ids' CONTENT, not their count. Keyed on
  // `savedIds.length`, a restore that swapped ids without changing the count
  // never refetched, and every single dismiss re-keyed and blanked the grid.
  const savedIdSet = useMemo(() => new Set(savedIds), [savedIds]);
  const savedIdsKey = useMemo(() => [...savedIds].sort().join(','), [savedIds]);

  // Fetch notes by their IDs.
  //
  // Goes through the POOL first. The old version opened a fresh WebSocket to
  // every write+read+fallback relay simultaneously, per 100-id batch — on a
  // phone that is far past what the browser will keep open, so a large saved
  // list resolved only partially and the tab rendered (say) 58 of 130 notes as
  // though the rest were gone. The pool routes id-only filters through its
  // wide "unroutable lookup" tier (read relays + fallbacks + indexers), reuses
  // existing connections, obeys the query governor, and on desktop runs over
  // the native socket bridge. Direct relay queries stay as a SECOND pass for
  // whatever the pool couldn't find.
  //
  // React Query owns the lifecycle: `keepPreviousData` keeps the current grid
  // rendered while a re-keyed fetch runs (a dismiss no longer flashes the
  // whole page to skeletons), and `signal` cancels a superseded run instead of
  // letting two full passes race each other's setState.
  const savedQuery = useQuery({
    queryKey: ['saved-notes', savedIdsKey],
    enabled: hydrated && savedIds.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }): Promise<{ events: NostrEvent[]; missingIds: string[] }> => {
      const ids = savedIdsKey.split(',');
      const found = new Map<string, NostrEvent>();
      const batchSize = 50;
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += batchSize) {
        batches.push(ids.slice(i, i + batchSize));
      }

      // Pass 1 — pool, batches sequential so we never burst sockets.
      for (const batch of batches) {
        if (signal.aborted) break;
        try {
          const events = await nostr.query(
            [{ ids: batch }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) },
          );
          for (const ev of events) if (!found.has(ev.id)) found.set(ev.id, ev);
        } catch {
          // Batch failed entirely — its ids fall through to pass 2.
        }
      }

      // Pass 2 — direct relay queries for the stragglers only, a few relays at
      // a time. Missing ids are usually on a relay the pool didn't pick, not
      // genuinely gone.
      let missing = ids.filter(id => !found.has(id));
      if (missing.length > 0) {
        const userRelays = getUserRelays();
        const relays = [...new Set([...userRelays.write, ...userRelays.read, ...FALLBACK_RELAYS])];
        const RELAY_CHUNK = 3;
        for (let i = 0; i < relays.length && missing.length > 0; i += RELAY_CHUNK) {
          if (signal.aborted) break;
          const chunk = relays.slice(i, i + RELAY_CHUNK);
          const results = await Promise.allSettled(
            chunk.map(url => queryRelay(url, { ids: missing.slice(0, 100) }, 8000)),
          );
          for (const r of results) {
            if (r.status !== 'fulfilled') continue;
            for (const ev of r.value) if (!found.has(ev.id)) found.set(ev.id, ev);
          }
          missing = ids.filter(id => !found.has(id));
        }
      }

      // Only now is an id "not found" — after the pool AND every relay missed
      // it. This matters because the failed list drives a destructive action.
      return {
        events: [...found.values()].sort((a, b) => b.created_at - a.created_at),
        missingIds: missing,
      };
    },
  });
  const isLoading = savedQuery.isLoading;

  useEffect(() => {
    if (savedQuery.isError) {
      toast({
        title: 'Failed to load saved notes',
        description: 'Some notes may not be available on your relays.',
        variant: 'destructive',
      });
    }
  }, [savedQuery.isError, toast]);

  // Derived, never set: ids removed externally (a dismiss on this device, a
  // restore, another tab) disappear instantly without waiting for a refetch,
  // and stale events can't outlive their ids. A just-dismissed note stays in
  // the grid while its undo window runs — NoteCard renders it as the in-place
  // undo placeholder — then leaves when the dismissal commits.
  const notes = useMemo(
    () => (savedQuery.data?.events ?? []).filter(n => savedIdSet.has(n.id) || isPendingSavedDismissal(n.id)),
    [savedQuery.data, savedIdSet, isPendingSavedDismissal],
  );
  const failedIds = useMemo(
    () => (savedQuery.data?.missingIds ?? []).filter(id => savedIdSet.has(id)),
    [savedQuery.data, savedIdSet],
  );

  // Reply parents. NoteCard only receives `parentNote` as a prop — without
  // this query every saved reply rendered the unresolved-parent placeholder
  // forever, and its "Retry now" invalidated a query key nothing here
  // observed, so even a successful retry changed nothing on screen. Mounting
  // the shared batch query completes that circuit and registers still-missing
  // parents with the background retry sweep.
  const parentRequests = useMemo(() => {
    const requests = new Map<string, { eventId: string; hints: string[]; authorPubkey?: string }>();
    for (const note of notes) {
      if (note.kind !== 1 && note.kind !== 1111) continue;
      if (note.kind === 1 && note.tags.some(t => t[0] === 'q')) continue;
      const parentId = getParentId(note);
      if (!parentId || requests.has(parentId)) continue;
      const replyETag = note.tags.find(t => t[0] === 'e' && t[1] === parentId);
      const hints = replyETag?.[2] ? [replyETag[2]] : [];
      const authorPubkey = note.tags.find(t => t[0] === 'p')?.[1];
      requests.set(parentId, { eventId: parentId, hints, authorPubkey });
    }
    return Array.from(requests.values());
  }, [notes]);
  const { data: parentNotes } = useParentNotes(parentRequests);

  // Separate pinned and regular notes
  const { pinnedNotesList, regularNotes } = useMemo(() => {
    const pinned = notes.filter(n => pinnedIds.includes(n.id));
    const regular = notes.filter(n => !pinnedIds.includes(n.id));
    return { pinnedNotesList: pinned, regularNotes: regular };
  }, [notes, pinnedIds]);

  const handlePinNote = useCallback((noteId: string) => {
    togglePin(noteId);
  }, [togglePin]);

  // Two-step, because this is not a local tidy-up: removing a saved note
  // records a tombstone that syncs, so it deletes those notes from every
  // device permanently. A relay hiccup that hid 72 of 130 notes was one click
  // away from destroying all 72 everywhere.
  const [confirmRemoveFailed, setConfirmRemoveFailed] = useState(false);
  const handleRemoveFailed = useCallback(() => {
    if (!confirmRemoveFailed) {
      setConfirmRemoveFailed(true);
      return;
    }
    failedIds.forEach(id => expand(id));
    toast({
      title: `Removed ${failedIds.length} unavailable notes`,
      description: 'They are removed on your other devices too.',
    });
    setConfirmRemoveFailed(false);
  }, [confirmRemoveFailed, failedIds, expand, toast]);

  // A fresh fetch invalidates a pending confirmation.
  useEffect(() => { setConfirmRemoveFailed(false); }, [failedIds]);

  const handleMinimizeNote = useCallback((noteId: string) => {
    setMinimizedNoteIds(prev => {
      if (prev.includes(noteId)) return prev;
      return [...prev, noteId];
    });
  }, [setMinimizedNoteIds]);

  const handleExpandNote = useCallback((noteId: string) => {
    setMinimizedNoteIds(prev => prev.filter(id => id !== noteId));
  }, [setMinimizedNoteIds]);

  const handleDismissNote = useCallback((noteId: string) => {
    // Un-save AND hide from feeds, with a 20s in-place undo. The card turns
    // into the undo placeholder immediately; counts drop immediately too,
    // because both the collapsed store and the bookmark store shrink.
    dismissFromSaved(noteId);
  }, [dismissFromSaved]);

  const displayNotes = useMemo(
    () => [...pinnedNotesList, ...regularNotes],
    [pinnedNotesList, regularNotes]
  );

  return (
    <Card className="bg-gradient-to-br from-green-50 to-emerald-50 dark:from-card dark:to-card border-green-200 dark:border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-green-100 dark:bg-green-900/30">
            <Save className="h-6 w-6 text-green-600 dark:text-green-400" />
          </div>
          <div>
            <CardTitle className="text-lg">Saved for Later</CardTitle>
            <p className="text-sm text-muted-foreground">
              {/* Show BOTH numbers. The list renders what it could fetch from
                  relays, which is not always everything you have saved — and
                  when those differ silently it reads as data loss (and as a
                  sync failure when comparing devices) rather than as a relay
                  that didn't answer. */}
              {savedIds.length} note{savedIds.length !== 1 ? 's' : ''} saved across all corkboards
              {!isLoading && notes.length < savedIds.length && (
                <span className="text-amber-600 dark:text-amber-500">
                  {' '}· {notes.length} loaded right now
                </span>
              )}
            </p>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {!hydrated || isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: Math.min(savedIds.length, 6) }).map((_, i) => (
              <Card key={i} className="p-4">
                <Skeleton className="h-4 w-3/4 mb-2" />
                <Skeleton className="h-4 w-full mb-2" />
                <Skeleton className="h-4 w-1/2" />
              </Card>
            ))}
          </div>
        ) : savedIds.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Save className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p className="text-lg font-medium mb-1">No saved notes</p>
            <p className="text-sm max-w-md mx-auto">
              Click the minimize button (↗) on any note to save it for later. 
              Saved notes appear here and persist across all your corkboards.
            </p>
          </div>
        ) : displayNotes.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <RotateCcw className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p className="text-lg font-medium mb-1">Notes not found</p>
            <p className="text-sm max-w-md mx-auto mb-4">
              None of your {savedIds.length} saved notes could be found on your current relays.
            </p>
            <Button onClick={() => savedQuery.refetch()} variant="outline">
              <RotateCcw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {failedIds.length > 0 && (
              <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-sm">
                <p className="text-amber-800 dark:text-amber-200">
                  <strong>{failedIds.length} of your {savedIds.length} saved notes</strong> could not be
                  loaded from your relays right now. They are still saved — a relay that was slow or
                  unreachable is the usual cause. Try again before removing anything.
                </p>
                <div className="flex items-center gap-3 mt-1">
                  <Button
                    variant="link"
                    size="sm"
                    className="text-amber-700 p-0 h-auto"
                    onClick={() => savedQuery.refetch()}
                    disabled={savedQuery.isFetching}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    {savedQuery.isFetching ? 'Retrying…' : 'Try again'}
                  </Button>
                  <Button
                    variant="link"
                    size="sm"
                    className="text-amber-600 p-0 h-auto"
                    onClick={handleRemoveFailed}
                  >
                    {confirmRemoveFailed
                      ? `Yes — permanently remove ${failedIds.length} from all devices`
                      : 'Remove them from my saved list'}
                  </Button>
                </div>
              </div>
            )}
            
            <div className="grid gap-4" style={gridStyle}>
              {displayNotes.map((note) => (
                <div key={note.id} className="relative group">
                  <NoteCard
                    note={note}
                    onThreadClick={() => onThreadClick(note.id)}
                    onOpenThread={onOpenThread}
                    onZapClick={note.pubkey !== RSS_PUBKEY ? () => setZapTargetNote(note) : undefined}
                    parentNote={parentNotes?.[getParentId(note) ?? ''] ?? undefined}
                    isPinned={pinnedIds.includes(note.id)}
                    showPinButton
                    onPinClick={() => handlePinNote(note.id)}
                    isOnSavedForLaterPage
                    isMinimized={minimizedNoteIds.includes(note.id)}
                    onMinimize={() => handleMinimizeNote(note.id)}
                    onExpand={() => handleExpandNote(note.id)}
                    onDismiss={() => handleDismissNote(note.id)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      {/* Zap Dialog */}
      {zapTargetNote && (
        <ZapDialog
          note={zapTargetNote}
          open={!!zapTargetNote}
          onOpenChange={(open) => !open && setZapTargetNote(null)}
          onOpenWalletSettings={() => {}}
        />
      )}
    </Card>
  );
});
