/**
 * FeedInfoCard — collapsible info + filter cards below the tab bar.
 *
 * Each tab type (Relay, Custom, All-Follows, RSS, Discover) gets a unique
 * info card, but all share the unified <FeedFilters> component for filtering.
 * The "Me" and "Friend" profile tabs use <ProfileCard> instead.
 *
 * Extracted from MultiColumnClient.tsx to keep that file manageable.
 */

import React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuthor } from '@/hooks/useAuthor';
import { genUserName } from '@/lib/genUserName';
import { nip19 } from 'nostr-tools';
import {
  Layers, Radio, Rss, Compass, Users,
  Trash2Icon, Pencil, UserPlus, UserCheck,
} from 'lucide-react';
import { SavedForLaterCorkboard } from '@/components/SavedForLaterCorkboard';
import { FeedFilters } from '@/components/FeedFilters';
import type { KindFilter, NoteKindStats, ContentFilterConfig, ContentFilterKey } from '@/components/FeedFilters';

// ─── Types ───────────────────────────────────────────────────────────────────

export type { NoteKindStats };

export interface CustomFeedDef {
  id: string;
  title: string;
  pubkeys: string[];
  relays: string[];
  rssUrls: string[];
  columnCount?: number;
}

interface FeedInfoCardProps {
  activeTab: string;
  isInfoCollapsed: boolean;
  onToggleInfoCollapsed: () => void;
  isFiltersCollapsed: boolean;
  onToggleFiltersCollapsed: () => void;

  // Tab-type flags
  isRelayTab: boolean;
  isCustomFeedTab: boolean;
  isAllFollowsTab: boolean;
  isRssTab: boolean;
  isDiscoverTab: boolean;
  isSavedTab: boolean;
  isFriendTab: boolean;

  activeCustomFeed: CustomFeedDef | null;
  activeRssFeed: string | null;
  contacts: string[] | undefined;

  // Stats / counts
  stats?: NoteKindStats;
  notesCount: number;
  hasFilteredNotes?: boolean;
  batchProgress: { loaded: number; total: number } | null;
  isLoadingAllFollows: boolean;
  isLoadingDiscover: boolean;
  isLoadingRss: boolean;
  isLoadingMore: boolean;
  isLoadingCustomFeed?: boolean;
  hasMore: boolean;
  hasActiveFilters: boolean;
  hasActiveContentFilters: boolean;

  // Own notes toggle
  showOwnNotes?: boolean;
  onToggleOwnNotes?: () => void;

  // RSS-only feed (no pagination support)
  isRssOnlyFeed?: boolean;

  // Filters
  kindFilters: Set<KindFilter>;
  hashtagFilters: Set<string>;
  filteredHashtags: { tag: string; count: number }[];
  onFilterByKind: (kind: KindFilter | 'all' | 'none') => void;
  filterMode: 'any' | 'strict';
  onToggleFilterMode: () => void;
  onFilterByHashtag: (tag: string) => void;
  onClearFilters: () => void;
  contentFilterConfig: ContentFilterConfig;
  onContentFilterChange: (key: ContentFilterKey, value: number | boolean | string) => void;

  // Actions
  onLoadMore: (hours: number) => void;
  onRefreshDiscover: () => void;
  onRemoveRelay: (url: string) => void;
  onRemoveRss: (url: string) => void;
  onEditFeed: (feedId: string) => void;
  onDeleteFeed: (feedId: string) => void;
  isFollowed?: boolean;
  onToggleFollow?: () => void;

  // Saved tab
  onThreadClick: (eventId: string) => void;
  onOpenThread: (eventId: string) => void;
  columnCount: number;
}

// ─── Shared info-card collapse button helpers ────────────────────────────────

function CollapseButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="absolute top-0 right-0">
      <button type="button" onClick={onClick} className="w-0 h-0 border-l-[24px] border-l-transparent border-t-[24px] border-t-red-600/70 hover:border-t-red-500/70 transition-colors" title="Hide info" />
    </div>
  );
}

function ExpandButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="absolute bottom-0 right-0">
      <button type="button" onClick={onClick} className="w-0 h-0 border-l-[24px] border-l-transparent border-b-[24px] border-b-green-600/70 hover:border-b-green-500/70 transition-colors" title="Show info" />
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export const FeedInfoCard = React.memo(function FeedInfoCard(props: FeedInfoCardProps) {
  const {
    activeTab, isInfoCollapsed, onToggleInfoCollapsed,
    isFiltersCollapsed, onToggleFiltersCollapsed,
    isRelayTab, isCustomFeedTab, isAllFollowsTab, isRssTab, isDiscoverTab, isSavedTab,
    activeCustomFeed, activeRssFeed, contacts,
    stats, notesCount, hasFilteredNotes, batchProgress,
    isLoadingAllFollows, isLoadingDiscover, isLoadingRss, isLoadingMore,
    hasMore, hasActiveFilters, hasActiveContentFilters,
    showOwnNotes, onToggleOwnNotes,
    kindFilters, hashtagFilters, filteredHashtags,
    onFilterByKind, filterMode, onToggleFilterMode, onFilterByHashtag, onClearFilters,
    contentFilterConfig, onContentFilterChange,
    onLoadMore: _onLoadMore, onRefreshDiscover, onRemoveRelay, onRemoveRss, onEditFeed, onDeleteFeed,
    isFollowed, onToggleFollow,
    onThreadClick, onOpenThread, columnCount,
  } = props;

  // Shared filter card props — assembled once, used by every tab
  const filterProps = {
    collapsed: isFiltersCollapsed,
    onToggleCollapsed: onToggleFiltersCollapsed,
    showOwnNotes,
    onToggleOwnNotes,
    kindFilters,
    onFilterByKind,
    filterMode,
    onToggleFilterMode,
    hashtagFilters,
    onFilterByHashtag,
    hashtags: filteredHashtags,
    contentFilterConfig,
    onContentFilterChange,
    hasActiveContentFilters,
    hasActiveFilters,
    onClearFilters,
  };

  // Hook must be called unconditionally (Rules of Hooks).
  const singleCustomFeedPubkey = isCustomFeedTab && activeCustomFeed?.pubkeys.length === 1
    ? activeCustomFeed.pubkeys[0] : '';
  const { data: customFeedAuthor } = useAuthor(singleCustomFeedPubkey);

  // ── Relay tab ──────────────────────────────────────────────────────────────
  if (isRelayTab) {
    let shortName: string;
    try { shortName = new URL(activeTab).hostname; } catch { shortName = activeTab; }
    return (
      <div className="space-y-2">
        <Card className="bg-card dark:bg-card border dark:border-border relative">
          {isInfoCollapsed ? (
            <div className="relative">
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 transition-colors rounded-lg"
                onClick={onToggleInfoCollapsed}
                title="Expand"
              >
                <Radio className="h-4 w-4 text-purple-500 shrink-0" />
                <span className="text-xs text-muted-foreground truncate flex-1 text-left">{shortName}</span>
                <span className="text-xs text-muted-foreground shrink-0">Info</span>
              </button>
              <ExpandButton onClick={onToggleInfoCollapsed} />
            </div>
          ) : (
            <div className="relative">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <Radio className="h-8 w-8 text-purple-500" />
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold">{shortName}</h3>
                    <p className="text-sm text-muted-foreground">{activeTab}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  <span className="text-muted-foreground">
                    <span className="font-medium text-foreground">{notesCount}</span> notes loaded
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-2 text-xs text-red-500 hover:text-red-700"
                    onClick={() => onRemoveRelay(activeTab)}
                  >
                    Remove relay
                  </Button>
                </div>
              </CardContent>
              <CollapseButton onClick={onToggleInfoCollapsed} />
            </div>
          )}
        </Card>

        <FeedFilters {...filterProps} stats={undefined} />
      </div>
    );
  }

  // ── Custom corkboard tab ───────────────────────────────────────────────────
  if (isCustomFeedTab && activeCustomFeed) {
    const isSingleAuthor = activeCustomFeed.pubkeys.length === 1;
    const singlePubkey = isSingleAuthor ? activeCustomFeed.pubkeys[0] : null;
    const metadata = customFeedAuthor?.metadata;
    const displayName = metadata?.display_name || metadata?.name || (singlePubkey ? genUserName(singlePubkey) : '');
    const npub = singlePubkey ? nip19.npubEncode(singlePubkey) : '';
    const shortNpub = npub ? `${npub.slice(0, 8)}...${npub.slice(-4)}` : '';

    return (
      <div className="space-y-2">
        <Card className="bg-gradient-to-br from-purple-50 to-violet-50 dark:from-card dark:to-card border-purple-200 dark:border-border">
          {isInfoCollapsed ? (
            <div className="relative">
              <div className="flex items-center gap-1 px-3 py-1.5">
                <button
                  className="flex items-center gap-2 flex-1 min-w-0 hover:bg-accent/50 transition-colors rounded-lg text-left"
                  onClick={onToggleInfoCollapsed}
                  title="Expand"
                >
                  {isSingleAuthor ? (
                    <Avatar className="h-6 w-6 shrink-0">
                      <AvatarImage src={metadata?.picture} />
                      <AvatarFallback className="text-xs">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                  ) : (
                    <Layers className="h-4 w-4 text-purple-500 shrink-0" />
                  )}
                  <span className="text-xs text-muted-foreground truncate flex-1">{activeCustomFeed.title}</span>
                </button>
                {onToggleFollow && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`h-6 w-6 p-0 shrink-0 ${isFollowed ? 'text-green-500 hover:text-green-600' : 'text-muted-foreground hover:text-purple-600'}`}
                    onClick={(e) => { e.stopPropagation(); onToggleFollow(); }}
                    title={isFollowed ? 'Unfollow' : 'Follow'}
                  >
                    {isFollowed ? <UserCheck className="h-3 w-3" /> : <UserPlus className="h-3 w-3" />}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 shrink-0"
                  onClick={(e) => { e.stopPropagation(); onEditFeed(activeCustomFeed.id); }}
                  title="Edit corkboard"
                >
                  <Pencil className="h-3 w-3 text-muted-foreground" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 shrink-0 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                  onClick={(e) => { e.stopPropagation(); onDeleteFeed(activeCustomFeed.id); }}
                  title="Remove corkboard"
                >
                  <Trash2Icon className="h-3 w-3" />
                </Button>
              </div>
              <ExpandButton onClick={onToggleInfoCollapsed} />
            </div>
          ) : (
            <div className="relative">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  {isSingleAuthor ? (
                    <>
                      <Avatar className="h-12 w-12">
                        <AvatarImage src={metadata?.picture} />
                        <AvatarFallback className="text-lg">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold">{displayName}</h3>
                        <p className="text-sm text-muted-foreground truncate">{shortNpub}</p>
                        {metadata?.nip05 && <p className="text-xs text-muted-foreground truncate">{metadata.nip05}</p>}
                      </div>
                    </>
                  ) : (
                    <>
                      <Layers className="h-8 w-8 text-purple-500" />
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold">{activeCustomFeed.title}</h3>
                        <p className="text-sm text-muted-foreground">
                          {activeCustomFeed.pubkeys.length} friends
                          {activeCustomFeed.relays.length > 0 && ` • ${activeCustomFeed.relays.length} relays`}
                          {activeCustomFeed.rssUrls?.length > 0 && ` • ${activeCustomFeed.rssUrls.length} RSS`}
                        </p>
                      </div>
                    </>
                  )}
                </div>
                <div className="mt-3 pt-2 border-t flex items-center gap-2 text-xs text-muted-foreground">
                  {hasFilteredNotes ? (
                    <span className="text-orange-600 dark:text-orange-400">Notes found but filtered by settings.</span>
                  ) : (
                    <span><span className="font-medium text-foreground">{notesCount}</span> notes loaded</span>
                  )}
                  <span className="flex-1" />
                  {onToggleFollow && (
                    <Button
                      variant="outline"
                      size="sm"
                      className={`h-7 px-3 text-xs gap-1.5 ${isFollowed ? 'border-green-300 text-green-600 hover:text-green-700 hover:bg-green-50 dark:border-green-700 dark:hover:bg-green-950' : 'border-purple-300 text-purple-600 hover:text-purple-700 hover:bg-purple-50 dark:border-purple-700 dark:hover:bg-purple-950'}`}
                      onClick={() => onToggleFollow()}
                    >
                      {isFollowed ? <UserCheck className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
                      {isFollowed ? 'Following' : 'Follow'}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-3 text-xs gap-1.5"
                    onClick={() => onEditFeed(activeCustomFeed.id)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-3 text-xs gap-1.5 border-red-300 text-red-500 hover:text-red-700 hover:bg-red-50 dark:border-red-700 dark:hover:bg-red-950"
                    onClick={() => onDeleteFeed(activeCustomFeed.id)}
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                    Remove
                  </Button>
                </div>
              </CardContent>
              <CollapseButton onClick={onToggleInfoCollapsed} />
            </div>
          )}
        </Card>

        <FeedFilters {...filterProps} stats={stats}>
          {isLoadingRss && (
            <div className="mt-2 px-2 text-xs text-orange-600 dark:text-orange-400 flex items-center gap-1">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
              Filling in RSS feed cards in a moment...
            </div>
          )}
        </FeedFilters>
      </div>
    );
  }

  // ── All-follows tab ────────────────────────────────────────────────────────
  if (isAllFollowsTab) {
    return (
      <div className="space-y-2">
        <Card className="bg-card dark:bg-card border dark:border-border">
          {isInfoCollapsed ? (
            <div className="relative">
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 transition-colors rounded-lg"
                onClick={onToggleInfoCollapsed}
                title="Expand"
              >
                <Users className="h-4 w-4 text-purple-500 shrink-0" />
                <span className="text-xs text-muted-foreground truncate flex-1 text-left">All Follows</span>
                <span className="text-xs text-muted-foreground shrink-0">Info</span>
              </button>
              <ExpandButton onClick={onToggleInfoCollapsed} />
            </div>
          ) : (
            <div className="relative">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <Users className="h-8 w-8 text-purple-500" />
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold">All Follows</h3>
                    <p className="text-sm text-muted-foreground">Recent notes from everyone you follow</p>
                  </div>
                </div>
                <div className="mt-3 pt-2 border-t flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                  <span><span className="font-medium text-foreground">{contacts?.length || 0}</span> accounts followed</span>
                  <span><span className="font-medium text-foreground">{notesCount}</span> notes loaded</span>
                  {isLoadingAllFollows && (
                    <span className="text-purple-600 dark:text-purple-400 flex items-center gap-1">
                      <div className="h-3 w-3 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
                      {batchProgress
                        ? `Loading ${batchProgress.loaded}/${batchProgress.total} groups...`
                        : 'Loading...'}
                    </span>
                  )}
                  {hasMore && !hasActiveFilters && (
                    <div className="flex gap-1 hidden">
                      <Button variant="ghost" size="sm" className="h-5 px-2 text-xs" onClick={() => _onLoadMore(1)} disabled={isLoadingMore}>
                        {isLoadingMore ? '...' : '+1h'}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-5 px-2 text-xs" onClick={() => _onLoadMore(2)} disabled={isLoadingMore}>
                        {isLoadingMore ? '...' : '+2h'}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-5 px-2 text-xs" onClick={() => _onLoadMore(4)} disabled={isLoadingMore}>
                        {isLoadingMore ? '...' : '+4h'}
                      </Button>
                    </div>
                  )}
                </div>
              </CardContent>
              <CollapseButton onClick={onToggleInfoCollapsed} />
            </div>
          )}
        </Card>

        <FeedFilters {...filterProps} stats={stats} />
      </div>
    );
  }

  // ── RSS tab ────────────────────────────────────────────────────────────────
  if (isRssTab && activeRssFeed) {
    return (
      <div className="space-y-2">
        <Card className="bg-gradient-to-br from-orange-50 to-red-50 dark:from-card dark:to-card border-orange-200 dark:border-border">
          {isInfoCollapsed ? (
            <div className="relative">
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 transition-colors rounded-lg"
                onClick={onToggleInfoCollapsed}
                title="Expand"
              >
                <Rss className="h-4 w-4 text-orange-500 shrink-0" />
                <span className="text-xs text-muted-foreground truncate flex-1 text-left">RSS Feed</span>
                <span className="text-xs text-muted-foreground shrink-0">Info</span>
              </button>
              <ExpandButton onClick={onToggleInfoCollapsed} />
            </div>
          ) : (
            <div className="relative">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <Rss className="h-8 w-8 text-orange-500" />
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold">RSS Feed</h3>
                    <p className="text-sm text-muted-foreground truncate">{activeRssFeed}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-500 hover:text-red-700 hover:bg-red-100"
                    onClick={() => onRemoveRss(activeRssFeed)}
                  >
                    <Trash2Icon className="h-4 w-4" />
                  </Button>
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  <span className="text-muted-foreground">
                    <span className="font-medium text-foreground">{notesCount}</span> items loaded
                  </span>
                  {isLoadingRss && (
                    <span className="text-orange-600 dark:text-orange-400 flex items-center gap-1">
                      <div className="h-3 w-3 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
                      Filling in RSS feed cards in a moment...
                    </span>
                  )}
                </div>
              </CardContent>
              <CollapseButton onClick={onToggleInfoCollapsed} />
            </div>
          )}
        </Card>

        {/* RSS feeds only have content filters (no kind toggles or hashtags) */}
        <FeedFilters
          {...filterProps}
          stats={undefined}
          onToggleOwnNotes={undefined}
          hashtags={[]}
        />
      </div>
    );
  }

  // ── Discover tab ───────────────────────────────────────────────────────────
  if (isDiscoverTab) {
    return (
      <div className="space-y-2">
        <Card className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-card dark:to-card border-amber-200 dark:border-border">
          {isInfoCollapsed ? (
            <div className="relative">
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 transition-colors rounded-lg"
                onClick={onToggleInfoCollapsed}
                title="Expand"
              >
                <Compass className="h-4 w-4 text-amber-500 shrink-0" />
                <span className="text-xs text-muted-foreground truncate flex-1 text-left">Discover</span>
                <span className="text-xs text-muted-foreground shrink-0">Info</span>
              </button>
              <ExpandButton onClick={onToggleInfoCollapsed} />
            </div>
          ) : (
            <div className="relative">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <Compass className="h-8 w-8 text-amber-500" />
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold">Discover</h3>
                    <p className="text-sm text-muted-foreground">
                      Content your friends engaged with from people you don't follow
                    </p>
                  </div>
                </div>
                <div className="mt-3 pt-2 border-t flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                  <span><span className="font-medium text-foreground">{notesCount}</span> notes discovered</span>
                  {isLoadingDiscover && (
                    <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <div className="h-3 w-3 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
                      Searching...
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-2 text-xs text-amber-600 hover:text-amber-700"
                    onClick={onRefreshDiscover}
                    disabled={isLoadingDiscover}
                  >
                    Refresh
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing notes that your friends replied to, reposted, or quoted — from accounts outside your follow list.
                </p>
              </CardContent>
              <CollapseButton onClick={onToggleInfoCollapsed} />
            </div>
          )}
        </Card>

        <FeedFilters {...filterProps} stats={stats} />
      </div>
    );
  }

  // ── Saved tab ──────────────────────────────────────────────────────────────
  if (isSavedTab) {
    return (
      <SavedForLaterCorkboard
        onThreadClick={onThreadClick}
        onOpenThread={onOpenThread}
        columnCount={columnCount}
      />
    );
  }

  // Me / Friend profile tabs are handled by ProfileCard in MultiColumnClient
  return null;
});
