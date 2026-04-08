import { useState, useEffect, useMemo, memo, useCallback } from 'react';
import { type NostrEvent } from '@nostrify/nostrify';
import { NoteCard } from '@/components/NoteCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Save, RotateCcw } from 'lucide-react';
import { useCollapsedNotes } from '@/hooks/useCollapsedNotes';
import { useBookmarks } from '@/hooks/useBookmarks';
import { usePinnedNotes } from '@/hooks/usePinnedNotes';
import { getUserRelays, FALLBACK_RELAYS } from '@/components/NostrProvider';
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

  // Fetch notes by their IDs
  const fetchNotes = useCallback(async () => {
    if (savedIds.length === 0) {
      setNotes([]);
      return;
    }

    setIsLoading(true);
    setFailedIds([]);

    try {
      // Query write relays + read relays + fallbacks directly,
      // because NPool's reqRouter can't route ids-only filters (no authors to look up)
      const userRelays = getUserRelays();
      const relaysToQuery = [...new Set([...userRelays.write, ...userRelays.read, ...FALLBACK_RELAYS])];

      // Split into batches of 100 to avoid query limits
      const batchSize = 100;
      const allEvents: NostrEvent[] = [];
      const foundIds = new Set<string>();

      for (let i = 0; i < savedIds.length; i += batchSize) {
        const batch = savedIds.slice(i, i + batchSize);
        // Query all relays in parallel using NRelay1 (via queryRelay), dedupe results
        const results = await Promise.allSettled(
          relaysToQuery.map(url =>
            queryRelay(url, { ids: batch }, 8000)
          )
        );
        for (const result of results) {
          if (result.status === 'fulfilled') {
            for (const event of result.value) {
              if (!foundIds.has(event.id)) {
                foundIds.add(event.id);
                allEvents.push(event);
              }
            }
          }
        }
      }

      // Find which IDs failed to fetch
      const missing = savedIds.filter(id => !foundIds.has(id));
      setFailedIds(missing);

      // Sort by created_at descending
      const sortedNotes = allEvents.sort((a, b) => b.created_at - a.created_at);
      setNotes(sortedNotes);
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
  }, [savedIds.length]);

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

  const handleRemoveFailed = useCallback(() => {
    failedIds.forEach(id => expand(id));
    toast({ 
      title: `Removed ${failedIds.length} unavailable notes`,
      description: 'These notes could not be found on your relays.'
    });
    setFailedIds([]);
  }, [failedIds, expand, toast]);

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
                  <strong>{failedIds.length} note(s)</strong> could not be found on your relays. 
                  They may have been deleted or your relays may not have them.
                </p>
                <Button 
                  variant="link" 
                  size="sm" 
                  className="text-amber-600 p-0 h-auto mt-1"
                  onClick={handleRemoveFailed}
                >
                  Remove unavailable notes from saved list
                </Button>
              </div>
            )}
            
            <div className="grid gap-4" style={gridStyle}>
              {displayNotes.map((note) => (
                <div key={note.id} className="relative group">
                  <NoteCard
                    note={note}
                    onThreadClick={() => onThreadClick(note.id)}
                    onOpenThread={onOpenThread}
                    onZapClick={note.pubkey !== 'rss-feed' ? () => setZapTargetNote(note) : undefined}
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
