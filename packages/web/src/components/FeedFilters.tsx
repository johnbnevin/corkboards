/**
 * FeedFilters — unified collapsible filter card used by all feed types.
 *
 * Renders kind toggles, hashtag badges, content filters, own-notes toggle,
 * and a clear-all button inside a collapsible Card. The parent controls
 * collapsed/expanded state; this component handles the presentation.
 */
import React, { memo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Filter } from 'lucide-react';
import { NoteKindToggles } from '@/components/NoteKindToggles';
import type { KindFilter, NoteKindStats } from '@/components/NoteKindToggles';
import { HashtagBadges } from '@/components/HashtagBadges';
import { ContentFilters } from '@/components/ContentFilters';
import type { ContentFilterConfig, ContentFilterKey } from '@/components/ContentFilters';

// Re-export for convenience
export type { KindFilter, NoteKindStats, ContentFilterConfig, ContentFilterKey };

// ─── Props ────────────────────────────────────────────────────────────────────

export interface FeedFiltersProps {
  // Collapse state (controlled by parent)
  collapsed: boolean;
  onToggleCollapsed: () => void;

  // Own notes toggle (shown when callback provided)
  showOwnNotes?: boolean;
  onToggleOwnNotes?: () => void;

  // Pin visibility toggles (me tab only, shown when callbacks provided)
  showPinned?: boolean;
  onToggleShowPinned?: () => void;
  showUnpinned?: boolean;
  onToggleShowUnpinned?: () => void;

  // Kind filters (kind toggles shown when stats provided)
  kindFilters: Set<KindFilter>;
  onFilterByKind: (kind: KindFilter | 'all' | 'none') => void;
  filterMode: 'any' | 'strict';
  onToggleFilterMode: () => void;
  stats?: NoteKindStats;

  // Hashtag filters (shown when hashtags non-empty)
  hashtagFilters: Set<string>;
  onFilterByHashtag: (tag: string) => void;
  hashtags: { tag: string; count: number }[];

  // Content filters
  contentFilterConfig: ContentFilterConfig;
  onContentFilterChange: (key: ContentFilterKey, value: number | boolean | string) => void;
  hasActiveContentFilters: boolean;

  // Clear all
  hasActiveFilters: boolean;
  onClearFilters: () => void;

  // Optional slot for tab-specific content (e.g. RSS loading indicator)
  children?: React.ReactNode;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const FeedFilters = memo(function FeedFilters({
  collapsed,
  onToggleCollapsed,
  showOwnNotes,
  onToggleOwnNotes,
  showPinned,
  onToggleShowPinned,
  showUnpinned,
  onToggleShowUnpinned,
  kindFilters,
  onFilterByKind,
  filterMode,
  onToggleFilterMode,
  stats,
  hashtagFilters,
  onFilterByHashtag,
  hashtags,
  contentFilterConfig,
  onContentFilterChange,
  hasActiveContentFilters,
  hasActiveFilters,
  onClearFilters,
  children,
}: FeedFiltersProps) {
  if (collapsed) {
    return (
      <Card className="bg-card dark:bg-card border dark:border-border">
        <div className="relative">
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 transition-colors rounded-lg"
            onClick={onToggleCollapsed}
            title="Expand filters"
          >
            <Filter className="h-4 w-4 text-purple-500 shrink-0" />
            <span className="text-xs text-muted-foreground truncate flex-1 text-left">Filters</span>
            {hasActiveFilters && (
              <span className="h-2 w-2 rounded-full bg-purple-500 shrink-0" />
            )}
          </button>
          <div className="absolute bottom-0 right-0">
            <button
              onClick={onToggleCollapsed}
              className="w-0 h-0 border-l-[24px] border-l-transparent border-b-[24px] border-b-green-600/70 hover:border-b-green-500/70 transition-colors"
              title="Show filters"
            />
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="bg-card dark:bg-card border dark:border-border">
      <div className="relative">
        <CardContent className="p-4">
          {/* Header */}
          <div className="flex items-center gap-3 mb-3">
            <Filter className="h-5 w-5 text-purple-500" />
            <span className="font-medium text-sm">Filters</span>
          </div>

          {/* Own notes toggle */}
          {onToggleOwnNotes && (
            <div className="flex items-center gap-1.5">
              <Switch
                checked={showOwnNotes ?? false}
                onCheckedChange={onToggleOwnNotes}
                className="scale-75"
              />
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                Include my notes
              </span>
            </div>
          )}

          {/* Pin visibility toggles (me tab) */}
          {onToggleShowPinned && (
            <div className="flex items-center gap-3 mt-1">
              <div className="flex items-center gap-1.5">
                <Switch
                  checked={showPinned ?? true}
                  onCheckedChange={onToggleShowPinned}
                  className="scale-75"
                />
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  Pinned
                </span>
              </div>
              {onToggleShowUnpinned && (
                <div className="flex items-center gap-1.5">
                  <Switch
                    checked={showUnpinned ?? true}
                    onCheckedChange={onToggleShowUnpinned}
                    className="scale-75"
                  />
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    Unpinned
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Kind toggles — always shown so filters are accessible before notes load */}
          {(
            <div className="mt-3 flex items-center flex-wrap gap-1 px-2">
              <NoteKindToggles
                kindFilters={kindFilters}
                onFilterByKind={onFilterByKind}
                filterMode={filterMode}
                onToggleFilterMode={onToggleFilterMode}
                stats={stats}
              />
            </div>
          )}

          {/* Tab-specific slot (e.g. RSS loading indicator) */}
          {children}

          {/* Hashtag badges */}
          {hashtags.length > 0 && (
            <div className="mt-2 px-2">
              <HashtagBadges
                hashtags={hashtags}
                hashtagFilters={hashtagFilters}
                onFilterByHashtag={onFilterByHashtag}
              />
            </div>
          )}

          {/* Content filters */}
          <ContentFilters
            config={contentFilterConfig}
            onChange={onContentFilterChange}
            hasActiveFilters={hasActiveContentFilters}
          />

          {/* Clear all */}
          {hasActiveFilters && (
            <div className="mt-2 px-2">
              <button
                onClick={onClearFilters}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
              >
                ✕ Clear all filters
              </button>
            </div>
          )}
        </CardContent>

        {/* Collapse button */}
        <div className="absolute top-0 right-0">
          <button
            onClick={onToggleCollapsed}
            className="w-0 h-0 border-l-[24px] border-l-transparent border-t-[24px] border-t-red-600/70 hover:border-t-red-500/70 transition-colors"
            title="Hide filters"
          />
        </div>
      </div>
    </Card>
  );
});
