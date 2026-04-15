/**
 * FeedGrid — renders the note columns and loading skeleton.
 *
 * Feed actions (load newer, load more, consolidate) are now in StatusBar.
 * Extracted from MultiColumnClient.tsx to keep that file manageable.
 */

import React, { useState, useEffect, useRef } from 'react';
import { type NostrEvent } from '@nostrify/nostrify';
import { type NoteClassification } from '@/lib/noteClassifier';
import { NoteCard } from '@/components/NoteCard';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Brief pointer-events lockout after notes rearrange to prevent misclicks from layout shift */
const REARRANGE_LOCKOUT_MS = 700;
/** How many notes per column to render initially */
const INITIAL_RENDER_PER_COL = 8;
/** How many notes per column to add when scrolling near the bottom */
const RENDER_INCREMENT_PER_COL = 8;

// ─── Discover loading experience ─────────────────────────────────────────────

const DISCOVER_STEPS = [
  'Finding interesting notes for you…',
  'Finding notes your follows replied to or reposted…',
  'Discovering people outside your network…',
  'Ranking by engagement from people you trust…',
  'Assembling your discover feed…',
];


function DiscoverLoadingState() {
  const [stepIndex, setStepIndex] = useState(0);

  // Cycle through progress steps — slow enough for users to read each one
  useEffect(() => {
    const timer = setInterval(() => {
      setStepIndex(prev => Math.min(prev + 1, DISCOVER_STEPS.length - 1));
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8">
      <div className="flex items-center gap-2 text-sm text-purple-600 dark:text-purple-400">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
        <span>{DISCOVER_STEPS[stepIndex]}</span>
      </div>
    </div>
  );
}

interface FeedGridProps {
  /** Round-robin columns — each is an array of notes for that column */
  columns: NostrEvent[][];
  /** Number of logical columns */
  columnCount: number;
  /** Map from note id → classification metadata */
  noteClassifications: Map<string, NoteClassification>;
  /** Resolved parent notes keyed by their id (null if not found) */
  parentNotes: Record<string, NostrEvent | null> | undefined;
  /** IDs of pinned notes (NIP-51 kind 10001) */
  pinnedNoteIds: string[];
  /** Active tab identifier — used to decide whether to show pin button */
  activeTab: string;
  /** IDs of freshly-loaded notes (highlighted briefly) */
  freshNoteIds: Set<string>;
  /** Currently showing the "Saved" tab — some actions are hidden on that tab */
  isSavedTab: boolean;
  /** True while the initial data query is in-flight */
  isLoading: boolean;
  /** Status of pinned notes fetch for "me" tab */
  pinnedNotesStatus?: 'loading' | 'found' | 'none' | 'no-list';
  /** Whether to show unpinned notes on "me" tab */
  showOwnNotes?: boolean;
  /** Batch-fetch progress indicator (e.g. "3 of 8 groups") */
  batchProgress: { loaded: number; total: number } | null;
  /** Number of authors/npub being queried */
  authorCount?: number;
  /** Whether there are older notes still available */
  hasMore: boolean;
  /** True while "load older" is in-flight */
  isLoadingMore: boolean;
  /** Hours loaded via load more */
  hoursLoaded: number;
  /** Feed limit multiplier (1x, 2x, 3x) */
  multiplier?: number;
  /** True while looking further back for sparse feeds */
  isLookingFurther?: boolean;
  /** True while "load newer" is in-flight */
  isLoadingNewer: boolean;
  /** Number of blank/collapsed placeholders in the current view */
  blankSpaceCount: number;
  /** Called when "Load newer posts" is clicked */
  onLoadNewer: () => void;
  /** Called when "Load more posts" is clicked with specific hours */
  onLoadMore: (hours: number) => void;
  /** Called when "Consolidate" is clicked */
  onConsolidate: () => void;
  /** Called when a note's thread is opened */
  onThreadClick: (eventId: string) => void;
  /** Called to open thread and auto-reply to a note */
  onComment?: (note: NostrEvent) => void;
  /** Same as onThreadClick — some NoteCard slots use a different prop name */
  onOpenThread: (eventId: string) => void;
  /** Called to pin/unpin a note */
  onPinClick: (noteId: string) => void;
  /** Called to open the zap dialog for a note */
  onZapClick?: (note: NostrEvent) => void;
  /** Called to repost a note */
  onRepost?: (note: NostrEvent) => void;
  /** Called to pin a note to the user's board (repost + pin) */
  onPinToBoard?: (note: NostrEvent) => void;
  /** Logged-in user's pubkey — used to highlight own notes on other corkboards */
  userPubkey?: string;
  /** When true, load all media (images/videos) instead of only top row */
  loadAllMedia?: boolean;
  /** When true, show expanded profile info and "more notes" on each card (discover tab) */
  discoverMode?: boolean;
  /** True when notes existed but the user dismissed/consolidated them all */
  allDismissed?: boolean;
  /** True while auto-loading older notes to find undismissed ones */
  findingUndismissed?: boolean;
  /** Number of dismissed notes in the current fetch window */
  dismissedCount?: number;
  /** Load more discover notes (next 100 npubs) */
  onLoadMoreDiscover?: () => void;
  /** Whether more discover notes are available */
  hasMoreDiscover?: boolean;
  /** Total discover notes available (all ranked) */
  totalDiscoverCount?: number;
  /** Called when the user deletes their own note (kind 5 deletion request) */
  onDeleteNote?: (note: NostrEvent) => void;
  /** When true, a media-only filter is active — auto-expand notes and unblur media */
  mediaFilterActive?: boolean;
  /** Called when user publishes a reaction — for optimistic feed insertion */
  onReactionPublished?: (event: NostrEvent) => void;
  /** When true, the discover tab is in onboarding mode */
  isOnboarding?: boolean;
  /** Called when the user clicks "Find more for me" during onboarding */
  onFindMoreForMe?: () => void;
  /** True while the onboarding follow-activity fetch is in progress */
  isFindingMore?: boolean;
}

export const FeedGrid = React.memo(function FeedGrid({
  columns,
  columnCount,
  noteClassifications,
  parentNotes,
  pinnedNoteIds,
  activeTab,
  freshNoteIds,
  isSavedTab,
  isLoading,
  pinnedNotesStatus,
  showOwnNotes,
  batchProgress,
  authorCount,
  hasMore: _hasMore,
  isLoadingMore: _isLoadingMore,
  hoursLoaded,
  multiplier,
  isLookingFurther,
  isLoadingNewer: _isLoadingNewer,
  blankSpaceCount: _blankSpaceCount,
  onLoadNewer: _onLoadNewer,
  onLoadMore: _onLoadMore,
  onConsolidate: _onConsolidate,
  onThreadClick,
  onComment,
  onOpenThread,
  onPinClick,
  onZapClick,
  onRepost,
  onPinToBoard,
  userPubkey,
  loadAllMedia = false,
  discoverMode = false,
  allDismissed = false,
  findingUndismissed = false,
  dismissedCount = 0,
  onLoadMoreDiscover,
  hasMoreDiscover = false,
  totalDiscoverCount = 0,
  onDeleteNote,
  mediaFilterActive = false,
  onReactionPublished,
  isOnboarding = false,
  onFindMoreForMe,
  isFindingMore = false,
}: FeedGridProps) {
  // ── Incremental rendering: render a small batch first, add more on scroll ──
  const maxColLength = Math.max(...columns.map(c => c.length), 0);
  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER_PER_COL);

  // Reset render limit when the underlying data changes (tab switch, new data)
  const columnsFingerprint = columns.map(col => col[0]?.id ?? '').join(',');
  const prevColumnsFingerprint = useRef(columnsFingerprint);
  useEffect(() => {
    if (columnsFingerprint !== prevColumnsFingerprint.current) {
      prevColumnsFingerprint.current = columnsFingerprint;
      setRenderLimit(INITIAL_RENDER_PER_COL);
    }
  }, [columnsFingerprint]);

  // Expand render window when user scrolls near the bottom
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (renderLimit >= maxColLength) return; // already showing everything
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setRenderLimit(prev => Math.min(prev + RENDER_INCREMENT_PER_COL, maxColLength));
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [renderLimit, maxColLength]);

  // Slice columns to only render up to renderLimit per column
  const visibleColumns = columns.map(col => col.slice(0, renderLimit));

  // Detect when notes rearrange (new notes prepended / order changes) and briefly
  // suppress pointer events so the user doesn't misclick during layout shift.
  const gridRef = useRef<HTMLDivElement>(null);
  const prevFirstIds = useRef<string>('');
  const lockoutTimer = useRef<ReturnType<typeof setTimeout>>();

  // Build a fingerprint from the first note ID in each column
  const firstIdsFingerprint = visibleColumns.map(col => col[0]?.id ?? '').join(',');

  useEffect(() => {
    // Skip the initial render and empty states
    if (!firstIdsFingerprint || !prevFirstIds.current) {
      prevFirstIds.current = firstIdsFingerprint;
      return;
    }
    if (firstIdsFingerprint !== prevFirstIds.current) {
      prevFirstIds.current = firstIdsFingerprint;
      if (gridRef.current) {
        gridRef.current.style.pointerEvents = 'none';
        clearTimeout(lockoutTimer.current);
        lockoutTimer.current = setTimeout(() => {
          if (gridRef.current) gridRef.current.style.pointerEvents = '';
        }, REARRANGE_LOCKOUT_MS);
      }
    }
  }, [firstIdsFingerprint]);

  // Cleanup on unmount
  useEffect(() => () => clearTimeout(lockoutTimer.current), []);

  if (isSavedTab) {
    return null;
  }

  return (
    <>
      {/* Content Columns */}
      {isLoading ? (
        <div className="mt-4 space-y-4">
          {activeTab === 'discover' ? (
            <DiscoverLoadingState />
          ) : isLookingFurther ? (
            <div className="flex items-center justify-center gap-2 py-2 text-sm text-amber-600 dark:text-amber-400">
              <span>No notes in the past {Math.max(hoursLoaded || 0, multiplier ?? 1)} hour{Math.max(hoursLoaded || 0, multiplier ?? 1) > 1 ? 's' : ''}. Looking further...</span>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 py-2 text-sm text-purple-600 dark:text-purple-400">
              {activeTab === 'me' && pinnedNotesStatus === 'loading' ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
                  <span>Searching for your pinned notes...</span>
                </>
              ) : activeTab === 'me' && pinnedNotesStatus === 'none' && showOwnNotes ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
                  <span>No pinned notes found. Loading your notes...</span>
                </>
              ) : activeTab === 'me' && pinnedNotesStatus === 'none' ? (
                <span>No pinned notes found.</span>
              ) : activeTab === 'me' && showOwnNotes ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
                  <span>Loading your notes...</span>
                </>
              ) : activeTab === 'me' ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
                  <span>Loading pinned notes...</span>
                </>
              ) : (authorCount || batchProgress) ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
                  <span>
                    Loading notes ({hoursLoaded > 0 ? hoursLoaded : multiplier ?? 1} hours back from {authorCount ?? batchProgress!.total * 50} npubs)...
                  </span>
                </>
              ) : (
                <span>Loading...</span>
              )}
            </div>
          )}
          <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
            {Array.from({ length: columnCount }).map((_, colIndex) => (
              <div key={colIndex} className="space-y-4">
                {Array.from({ length: 3 }).map((_, rowIndex) => (
                  <Card key={rowIndex}>
                    <CardHeader className="flex flex-row items-center space-x-4 pb-2">
                      <Skeleton className="h-10 w-10 rounded-full" />
                      <div className="space-y-1 flex-1">
                        <Skeleton className="h-4 w-1/4" />
                        <Skeleton className="h-3 w-1/6" />
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-3/4" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : columns.every(col => col.length === 0) ? (
        <div className="flex flex-col items-center justify-center py-12 text-sm text-muted-foreground gap-2">
          {allDismissed ? (
            findingUndismissed ? (
              <>
                <span>All {dismissedCount} fetched notes were previously dismissed.</span>
                <span className="flex items-center gap-2 text-purple-600 dark:text-purple-400">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-purple-500 border-t-transparent inline-block" />
                  Finding first undismissed notes…
                </span>
              </>
            ) : (
              <span>All caught up — no unread notes.</span>
            )
          ) : activeTab === 'me' ? (
            (!showOwnNotes && (pinnedNotesStatus === 'none' || pinnedNotesStatus === 'no-list')) ? (
              <>
                <span>No pinned notes found on your profile.</span>
                <span className="text-xs opacity-70">Pin notes from your feed to see them here.</span>
              </>
            ) : (
              <span>No notes found in past {Math.max(hoursLoaded || 0, multiplier ?? 1)} hour{Math.max(hoursLoaded || 0, multiplier ?? 1) > 1 ? 's' : ''} from your profile.</span>
            )
          ) : activeTab === 'all-follows' ? (
            <span>No notes found in past {Math.max(hoursLoaded || 0, multiplier ?? 1)} hour{Math.max(hoursLoaded || 0, multiplier ?? 1) > 1 ? 's' : ''} from npubs in All Follows.</span>
          ) : activeTab.startsWith('feed:') ? (
            <span>No notes found in past {Math.max(hoursLoaded || 0, multiplier ?? 1)} hour{Math.max(hoursLoaded || 0, multiplier ?? 1) > 1 ? 's' : ''} from npubs on this corkboard.</span>
          ) : activeTab.startsWith('wss://') || activeTab.startsWith('ws://') ? (
            <span>No notes found on this relay.</span>
          ) : activeTab === 'discover' ? (
            <DiscoverLoadingState />
          ) : (
            <span>No notes found in past {Math.max(hoursLoaded || 0, multiplier ?? 1)} hour{Math.max(hoursLoaded || 0, multiplier ?? 1) > 1 ? 's' : ''} from this npub.</span>
          )}
        </div>
      ) : (
        <>
          {/* Main grid — each column wrapped in its own ErrorBoundary */}
          <div ref={gridRef} className="grid gap-4 mt-4 pb-32 sm:pb-12" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
            {visibleColumns.map((columnNotes, colIndex) => (
              <ErrorBoundary
                key={`col-${colIndex}`}
                fallback={
                  <div className="rounded-lg border border-red-200 dark:border-red-800 p-4 text-sm text-red-600 dark:text-red-400">
                    This column encountered an error. Other columns are unaffected.
                  </div>
                }
              >
                <div className="space-y-4">
                  {columnNotes.map((note, noteIndex) => {
                    const classification = noteClassifications.get(note.id);
                    const parentNote = classification?.parentEventId
                      ? parentNotes?.[classification.parentEventId]
                      : null;
                    return (
                      <NoteCard
                        key={note.id}
                        note={note}
                        isPinned={pinnedNoteIds.includes(note.id)}
                        showPinButton={activeTab === 'me'}
                        onPinClick={() => onPinClick(note.id)}
                        onThreadClick={() => onThreadClick(note.id)}
                        onComment={onComment ? () => onComment(note) : undefined}
                        onOpenThread={onOpenThread}
                        onZapClick={note.pubkey !== 'rss-feed' && onZapClick ? () => onZapClick(note) : undefined}
                        onRepost={note.pubkey !== 'rss-feed' && onRepost ? () => onRepost(note) : undefined}
                        onPinToBoard={note.pubkey !== 'rss-feed' && onPinToBoard ? () => onPinToBoard(note) : undefined}
                        parentNote={parentNote}
                        isFresh={freshNoteIds.has(note.id)}
                        isOwnNote={activeTab !== 'me' && !!userPubkey && note.pubkey === userPubkey}
                        isMeTab={activeTab === 'me'}
                        blurMedia={!loadAllMedia && !mediaFilterActive && noteIndex > 0}
                        mediaFilterActive={mediaFilterActive}
                        discoverMode={discoverMode}
                        onDelete={onDeleteNote && userPubkey && note.pubkey === userPubkey ? () => onDeleteNote(note) : undefined}
                        onReactionPublished={onReactionPublished}
                      />
                    );
                  })}
                </div>
              </ErrorBoundary>
            ))}
          </div>
          {/* Sentinel for incremental rendering — triggers loading more notes on scroll */}
          {renderLimit < maxColLength && <div ref={sentinelRef} style={{ height: 1 }} />}
          {/* Discover "load more" link — regular discover only */}
          {activeTab === 'discover' && !isOnboarding && hasMoreDiscover && (
            <div className="flex justify-center py-8">
              <button
                onClick={onLoadMoreDiscover}
                className="text-sm text-purple-600 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300 underline underline-offset-2 transition-colors"
              >
                Didn't find anyone interesting? Load {Math.min(100, totalDiscoverCount - columns.reduce((s, c) => s + c.length, 0))} more
              </button>
            </div>
          )}
          {/* Onboarding "Find more for me" button — fetches reactions/reposts from follows */}
          {activeTab === 'discover' && isOnboarding && onFindMoreForMe && (
            <div className="flex justify-center py-10">
              <button
                onClick={onFindMoreForMe}
                disabled={isFindingMore}
                className="flex items-center gap-2 px-6 py-3 rounded-full bg-orange-500 hover:bg-orange-400 disabled:bg-orange-300 text-white font-semibold text-sm shadow-lg transition-colors"
              >
                {isFindingMore ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Finding more…
                  </>
                ) : (
                  'Find more for me'
                )}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
});
