/**
 * NotificationsCorkboard — self-contained notifications tab.
 *
 * Fetches and displays Nostr notifications for the logged-in user:
 * reactions, replies, mentions, reposts, and zaps.
 *
 * Includes filter toggles matching the style of other corkboard filter UIs.
 */

import React, { useState, useMemo, memo, useEffect } from 'react';
import { useNotifications, type NotificationType } from '@/hooks/useNotifications';
import { useCollapsedNotes } from '@/hooks/useCollapsedNotes';
import { NotificationCard } from '@/components/NotificationCard';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Bell, Heart, MessageSquare, Repeat2, Zap, AtSign } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface NotificationsCorkboardProps {
  onViewThread: (eventId: string) => void;
  columnCount?: number;
  /** Reports the number of blank (dismissed/collapsed) notification cards to the parent */
  onBlankSpaceCount?: (count: number) => void;
  /** Reports stats (total, visible, dismissed) to parent for StatusBar */
  onStatsUpdate?: (stats: { total: number; visible: number; dismissed: number; filtered: number }) => void;
  /** Reports loadMore callback, hasMore, loadNewer, and newestTimestamp to parent (for StatusBar) */
  onLoadMoreReady?: (loadMore: (count: number) => void, hasMore: boolean, loadNewer: () => void, newestTimestamp: number | null) => void;
}

type NotifFilter = NotificationType;

// ─── Filter toggle bar ────────────────────────────────────────────────────────

const FILTER_DEFS: { kind: NotifFilter; icon: React.ReactNode; label: string }[] = [
  { kind: 'reaction',  icon: <Heart        className="h-3 w-3" />, label: 'Reactions' },
  { kind: 'reply',     icon: <MessageSquare className="h-3 w-3" />, label: 'Replies' },
  { kind: 'mention',   icon: <AtSign       className="h-3 w-3" />, label: 'Mentions' },
  { kind: 'repost',    icon: <Repeat2      className="h-3 w-3" />, label: 'Reposts' },
  { kind: 'zap',       icon: <Zap          className="h-3 w-3" />, label: 'Zaps' },
];

function FilterBar({
  counts,
  hiddenTypes,
  onToggle,
}: {
  counts: Record<NotifFilter, number>;
  hiddenTypes: Set<NotifFilter>;
  onToggle: (kind: NotifFilter) => void;
}) {
  return (
    <div className="flex items-center flex-wrap gap-x-3 gap-y-1 px-2 py-2">
      {FILTER_DEFS.map(({ kind, icon, label }, i) => (
        <React.Fragment key={kind}>
          {i > 0 && <span className="text-muted-foreground/30 text-xs">|</span>}
          <div className="flex items-center gap-1.5">
            <Switch
              checked={!hiddenTypes.has(kind)}
              onCheckedChange={() => onToggle(kind)}
              className="scale-75"
            />
            <span className={`inline-flex items-center gap-1 text-xs ${hiddenTypes.has(kind) ? 'text-muted-foreground/40' : 'text-muted-foreground'}`}>
              {icon}
              {counts[kind]} {label}
            </span>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export const NotificationsCorkboard = memo(function NotificationsCorkboard({
  onViewThread,
  columnCount = 3,
  onBlankSpaceCount,
  onStatsUpdate,
  onLoadMoreReady,
}: NotificationsCorkboardProps) {
  const { notifications, isLoading, loadMore, loadNewer, hasMore, newestTimestamp } = useNotifications(true);

  // Report loadMore/hasMore/loadNewer/newestTimestamp to parent for StatusBar integration
  useEffect(() => {
    onLoadMoreReady?.(loadMore, hasMore, loadNewer, newestTimestamp);
  }, [loadMore, hasMore, loadNewer, newestTimestamp, onLoadMoreReady]);
  const { isDismissed, isCollapsedThisSession, isSoftDismissed } = useCollapsedNotes();
  const [hiddenTypes, setHiddenTypes] = useState<Set<NotifFilter>>(new Set());
  const [isFilterCollapsed, setIsFilterCollapsed] = useState(false);

  const toggleFilter = (kind: NotifFilter) => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  // Count by type (before filtering)
  const counts = useMemo((): Record<NotifFilter, number> => {
    const c: Record<NotifFilter, number> = {
      reaction: 0, reply: 0, mention: 0, repost: 0, zap: 0,
    };
    for (const n of notifications) c[n.type]++;
    return c;
  }, [notifications]);

  // Apply type filters and dismissed status
  const filtered = useMemo(
    () => notifications.filter(n => !hiddenTypes.has(n.type) && !isDismissed(n.event.id)),
    [notifications, hiddenTypes, isDismissed],
  );

  // Count dismissed notifications (fully removed from feed)
  const notifDismissedCount = useMemo(
    () => notifications.filter(n => isDismissed(n.event.id)).length,
    [notifications, isDismissed],
  );

  // Count blank spaces (collapsed/soft-dismissed but still in grid)
  const notifBlankCount = useMemo(
    () => notifications.filter(n => isCollapsedThisSession(n.event.id) || isSoftDismissed(n.event.id)).length,
    [notifications, isCollapsedThisSession, isSoftDismissed],
  );
  useEffect(() => { onBlankSpaceCount?.(notifBlankCount); }, [notifBlankCount, onBlankSpaceCount]);

  // Report stats to parent for StatusBar
  const hiddenByType = notifications.length - filtered.length - notifDismissedCount;
  useEffect(() => {
    onStatsUpdate?.({
      total: notifications.length,
      visible: filtered.length,
      dismissed: notifDismissedCount,
      filtered: Math.max(0, hiddenByType),
    });
  }, [notifications.length, filtered.length, notifDismissedCount, hiddenByType, onStatsUpdate]);

  // Distribute into columns (round-robin)
  const columns = useMemo(() => {
    const cols: (typeof filtered)[] = Array.from({ length: columnCount }, () => []);
    filtered.forEach((n, i) => cols[i % columnCount].push(n));
    return cols;
  }, [filtered, columnCount]);

  const gridStyle = { gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` };

  return (
    <div className="space-y-3">
      {/* Header + filter card */}
      <Card className="bg-card border relative overflow-hidden">
        {/* Green corner — expand (shown when collapsed) */}
        {isFilterCollapsed && (
          <button
            className="absolute bottom-0 right-0 w-8 h-8 z-10"
            onClick={() => setIsFilterCollapsed(false)}
            title="Expand filters"
          >
            <div className="w-0 h-0 border-b-[32px] border-l-[32px] border-b-green-500 border-l-transparent hover:border-b-green-400 transition-colors absolute bottom-0 right-0" />
          </button>
        )}

        {/* Red corner — collapse (shown when expanded) */}
        {!isFilterCollapsed && (
          <button
            className="absolute top-0 right-0 w-8 h-8 z-10"
            onClick={() => setIsFilterCollapsed(true)}
            title="Collapse filters"
          >
            <div className="w-0 h-0 border-t-[32px] border-l-[32px] border-t-red-500/70 border-l-transparent hover:border-t-red-400/70 transition-colors" />
          </button>
        )}

        {isFilterCollapsed ? (
          /* Collapsed: single line with icon, name, count */
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 transition-colors rounded-lg"
            onClick={() => setIsFilterCollapsed(false)}
          >
            <Bell className="h-4 w-4 text-purple-500 shrink-0" />
            <span className="text-xs text-muted-foreground truncate flex-1 text-left">
              Notifications
              {notifications.length > 0 && ` (${notifications.length})`}
              {hiddenTypes.size > 0 && ` · ${hiddenTypes.size} type${hiddenTypes.size > 1 ? 's' : ''} hidden`}
            </span>
          </button>
        ) : (
          <CardContent className="py-2 px-3">
            <div className="flex items-center gap-2 mb-1">
              <Bell className="h-4 w-4 text-purple-500" />
              <span className="text-sm font-medium">Notifications</span>
              {notifications.length > 0 && (
                <span className="text-xs text-muted-foreground">({notifications.length})</span>
              )}
            </div>

            {/* Type filter toggles */}
            {notifications.length > 0 && (
              <FilterBar counts={counts} hiddenTypes={hiddenTypes} onToggle={toggleFilter} />
            )}

            {/* Active filter summary */}
            {hiddenTypes.size > 0 && (
              <div className="mt-1 px-2">
                <button
                  onClick={() => setHiddenTypes(new Set())}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                >
                  ✕ Show all types
                </button>
              </div>
            )}

            {/* Stats line — matches ProfileCard/FeedInfoCard pattern */}
            {notifications.length > 0 && (
              <div className="mt-2 pt-2 border-t flex items-center gap-2 text-xs text-muted-foreground px-2">
                <span><span className="font-medium text-foreground">{filtered.length}</span> showing{filtered.length < notifications.length ? ` (${notifications.length} loaded)` : ''}</span>
                {notifDismissedCount > 0 && (
                  <span>· {notifDismissedCount} dismissed</span>
                )}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Loading skeletons */}
      {isLoading && notifications.length === 0 && (
        <div className="grid gap-3" style={gridStyle}>
          {Array.from({ length: Math.min(columnCount * 2, 6) }).map((_, i) => (
            <Card key={i} className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-6 w-6 rounded-full" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-16 ml-auto" />
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </Card>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && notifications.length === 0 && (
        <Card className="p-8 text-center">
          <Bell className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No notifications yet</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Reactions, replies, mentions, reposts, and zaps will appear here
          </p>
        </Card>
      )}

      {/* Empty filtered state */}
      {!isLoading && notifications.length > 0 && filtered.length === 0 && (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted-foreground">All notification types are hidden</p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 text-xs"
            onClick={() => setHiddenTypes(new Set())}
          >
            Show all
          </Button>
        </Card>
      )}

      {/* Notification grid */}
      {filtered.length > 0 && (
        <div className="grid gap-3 items-start" style={gridStyle}>
          {columns.map((col, ci) => (
            <div key={ci} className="space-y-3">
              {col.map(notification => (
                <NotificationCard
                  key={notification.event.id}
                  notification={notification}
                  onViewThread={onViewThread}
                />
              ))}
            </div>
          ))}
        </div>
      )}

    </div>
  );
});
