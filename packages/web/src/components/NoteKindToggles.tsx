import { useState, useEffect, useTransition, memo } from 'react';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  FileText, MessageSquare, Repeat2, Heart, Video, Image, Highlighter, UtensilsCrossed,
} from 'lucide-react';

// ─── Shared types ─────────────────────────────────────────────────────────────

export type KindFilter =
  | 'posts' | 'replies' | 'articles' | 'videos' | 'images'
  | 'reposts' | 'reactions' | 'highlights' | 'recipes';

export const ALL_NOTE_KIND_FILTERS: readonly KindFilter[] = [
  'posts', 'replies', 'articles', 'videos', 'images',
  'reposts', 'reactions', 'highlights', 'recipes',
] as const;

export interface NoteKindStats {
  total: number;
  shortNotes: number;
  replies: number;
  longForm: number;
  reposts: number;
  reactions: number;
  videos: number;
  images: number;
  highlights: number;
  recipes: number;
  other: number;
}

// ─── Toggle config ────────────────────────────────────────────────────────────

type StatsKey = keyof Omit<NoteKindStats, 'total' | 'other'>;

const TOGGLE_CONFIG: ReadonlyArray<{
  kind: KindFilter;
  icon: typeof FileText;
  label: string;
  countKey: StatsKey;
}> = [
  { kind: 'posts',      icon: FileText,          label: 'posts',      countKey: 'shortNotes' },
  { kind: 'replies',    icon: MessageSquare,     label: 'replies',    countKey: 'replies'    },
  { kind: 'articles',   icon: FileText,          label: 'articles',   countKey: 'longForm'   },
  { kind: 'videos',     icon: Video,             label: 'videos',     countKey: 'videos'     },
  { kind: 'images',     icon: Image,             label: 'images',     countKey: 'images'     },
  { kind: 'reposts',    icon: Repeat2,           label: 'reposts',    countKey: 'reposts'    },
  { kind: 'reactions',  icon: Heart,             label: 'reactions',  countKey: 'reactions'  },
  { kind: 'highlights', icon: Highlighter,       label: 'highlights', countKey: 'highlights' },
  { kind: 'recipes',    icon: UtensilsCrossed,   label: 'recipes',    countKey: 'recipes'    },
];

// ─── Component ────────────────────────────────────────────────────────────────

interface NoteKindTogglesProps {
  kindFilters: Set<KindFilter>;
  onFilterByKind: (kind: KindFilter | 'all' | 'none') => void;
  filterMode?: 'any' | 'strict';
  onToggleFilterMode?: () => void;
  stats?: NoteKindStats;
  className?: string;
}

/**
 * Note kind filter toggles with optimistic local state.
 *
 * Local state mirrors the parent for instant visual feedback.
 * The parent update is deferred via useTransition so the expensive
 * re-filter runs without blocking the UI.
 */
export const NoteKindToggles = memo(function NoteKindToggles({
  kindFilters,
  onFilterByKind,
  filterMode = 'any',
  onToggleFilterMode,
  stats,
  className = '',
}: NoteKindTogglesProps) {
  const [localFilters, setLocalFilters] = useState(kindFilters);
  const [, startTransition] = useTransition();

  // Re-sync when the parent commits a new value
  useEffect(() => { setLocalFilters(kindFilters); }, [kindFilters]);

  const allShowing = localFilters.size === 0;

  const handleAllNone = () => {
    const next = allShowing ? new Set(ALL_NOTE_KIND_FILTERS) : new Set<KindFilter>();
    setLocalFilters(next);
    startTransition(() => onFilterByKind(allShowing ? 'none' : 'all'));
  };

  const handleToggle = (kind: KindFilter) => {
    setLocalFilters(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
    startTransition(() => onFilterByKind(kind));
  };

  return (
    <div className={`flex items-center flex-wrap gap-1 ${className}`}>
      {/* Master all/none toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5">
            <Switch
              checked={allShowing}
              onCheckedChange={handleAllNone}
              className="scale-75"
            />
            <span className="text-xs font-medium text-muted-foreground">
              {allShowing ? 'All' : 'None'}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[200px] text-xs">
          {allShowing
            ? 'Showing all types. Click to hide everything, then toggle individual types.'
            : 'Hiding all types. Click to show everything.'}
        </TooltipContent>
      </Tooltip>

      {/* Filter mode: loose vs strict */}
      {onToggleFilterMode && localFilters.size > 0 && (
        <>
          <span className="text-muted-foreground mx-1">|</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onToggleFilterMode}
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors ${
                  filterMode === 'strict'
                    ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {filterMode === 'strict' ? 'Strict' : 'Loose'}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[220px] text-xs">
              {filterMode === 'strict'
                ? 'Strict: hides notes if ANY type is toggled off.'
                : 'Loose: shows notes if ANY type is toggled on.'}
            </TooltipContent>
          </Tooltip>
        </>
      )}

      <span className="text-muted-foreground mx-1">|</span>

      {/* Individual kind toggles */}
      {TOGGLE_CONFIG.map(({ kind, icon: Icon, label, countKey }, i) => (
        <div key={kind} className="flex items-center">
          {i > 0 && <span className="text-muted-foreground mx-1">|</span>}
          <div className="flex items-center gap-1.5">
            <Switch
              checked={!localFilters.has(kind)}
              onCheckedChange={() => handleToggle(kind)}
              className="scale-75"
            />
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Icon className="h-3 w-3" />
              {stats?.[countKey] ?? 0} {label}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
});
