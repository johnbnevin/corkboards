import { useState, useEffect, useMemo, memo, useCallback } from 'react';
import { RSS_PUBKEY } from '@core/rss';
import { type NostrEvent } from '@nostrify/nostrify';
import { NoteCard } from '@/components/NoteCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Save, RotateCcw } from 'lucide-react';
import { useCollapsedNotes } from '@/hooks/useCollapsedNotes';
import { useBookmarks } from '@/hooks/useBookmarks';
import { usePinnedNotes } from '@/hooks/usePinnedNotes';
import { getUserRelays, FALLBACK_RELAYS } from '@/components/NostrProvider';
import { useNostr } from '@nostrify/react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/useToast';
import { ZapDialog } from '@/components/ZapDialog';
import { queryRelay } from '@/lib/fetchEvent';

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
  const { collapsedIds, expand } = useCollapsedNotes();
  const { nostr } = useNostr();
  const { bookmarkIds } = useBookmarks();
  const { pinnedIds, togglePin } = usePinnedNotes();

  // Merge collapsed IDs with bookmark IDs (union) for backward compat
  const savedIds = useMemo(() => {
    return [...new Set([...collapsedIds, ...bookmarkIds])];
  }, [collapsedIds, bookmarkIds]);
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [notes, setNotes] = useState<NostrEvent[]>([]);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [zapTargetNote, setZapTargetNote] = useState<NostrEvent | null>(null);
  const [minimizedNoteIds, setMinimizedNoteIds] = useLocalStorage<string[]>('saved-minimized-notes', []);
  const [locallyDismissedIds, setLocallyDismissedIds] = useState<Set<string>>(new Set());

  const gridStyle = { gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` };

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
  const fetchNotes = useCallback(async () => {
    if (savedIds.length === 0) {
      setNotes([]);
      setFailedIds([]);
      return;
    }

    setIsLoading(true);

    try {
      const found = new Map<string, NostrEvent>();
      const batchSize = 50;
      const batches: string[][] = [];
      for (let i = 0; i < savedIds.length; i += batchSize) {
        batches.push(savedIds.slice(i, i + batchSize));
      }

      // Pass 1 — pool, batches sequential so we never burst sockets.
      for (const batch of batches) {
        try {
          const events = await nostr.query(
            [{ ids: batch }],
            { signal: AbortSignal.timeout(10000) },
          );
          for (const ev of events) if (!found.has(ev.id)) found.set(ev.id, ev);
        } catch {
          // Batch failed entirely — its ids fall through to pass 2.
        }
      }

      // Pass 2 — direct relay queries for the stragglers only, a few relays at
      // a time. Missing ids are usually on a relay the pool didn't pick, not
      // genuinely gone.
      let missing = savedIds.filter(id => !found.has(id));
      if (missing.length > 0) {
        const userRelays = getUserRelays();
        const relays = [...new Set([...userRelays.write, ...userRelays.read, ...FALLBACK_RELAYS])];
        const RELAY_CHUNK = 3;
        for (let i = 0; i < relays.length && missing.length > 0; i += RELAY_CHUNK) {
          const chunk = relays.slice(i, i + RELAY_CHUNK);
          const results = await Promise.allSettled(
            chunk.map(url => queryRelay(url, { ids: missing.slice(0, 100) }, 8000)),
          );
          for (const r of results) {
            if (r.status !== 'fulfilled') continue;
            for (const ev of r.value) if (!found.has(ev.id)) found.set(ev.id, ev);
          }
          missing = savedIds.filter(id => !found.has(id));
        }
      }

      // Only now is an id "not found" — after the pool AND every relay missed
      // it. This matters because the failed list drives a destructive action.
      setFailedIds(missing);
      setNotes([...found.values()].sort((a, b) => b.created_at - a.created_at));
    } catch (error) {
      console.error('Failed to fetch saved notes:', error);
      toast({
        title: 'Failed to load saved notes',
        description: 'Some notes may not be available on your relays.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedIds.length, nostr]);

  // Refetch when the count changes (new note added or removed)
  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

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
    setFailedIds([]);
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
    // Remove from saved list (persists, updates badge count in parent)
    expand(noteId);
    // Hide locally immediately — no wait for re-fetch
    setLocallyDismissedIds(prev => {
      const newSet = new Set(prev);
      newSet.add(noteId);
      return newSet;
    });
  }, [expand]);

  const displayNotes = useMemo(
    () => [...pinnedNotesList, ...regularNotes].filter(n => !locallyDismissedIds.has(n.id)),
    [pinnedNotesList, regularNotes, locallyDismissedIds]
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
              {savedIds.length} note{savedIds.length !== 1 ? 's' : ''} saved across all corkboards
            </p>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {isLoading ? (
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
            <Button onClick={fetchNotes} variant="outline">
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
                    onClick={fetchNotes}
                    disabled={isLoading}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    {isLoading ? 'Retrying…' : 'Try again'}
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
