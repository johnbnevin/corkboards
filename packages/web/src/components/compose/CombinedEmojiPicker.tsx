/**
 * Combined emoji picker — standard emojis as the first tab, custom emoji sets as additional tabs.
 * Used in compose, inline reply, and note-level reaction.
 */
import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useCustomEmojiSets } from '@/hooks/useCustomEmojiSets';
import { isValidMediaUrl } from '@/lib/textareaUtils';
import { trackEmojiUse } from '@/components/EmojiSetEditor';
import { EMOJI_CATEGORIES } from '@core/emojiCategories';
import { CORKBOARDS_DEFAULT_EMOJIS } from '@core/defaultEmojiSet';
import { Settings } from 'lucide-react';

interface CombinedEmojiPickerProps {
  /** Standard emoji selected (unicode string) */
  onSelectEmoji: (emoji: string) => void;
  /** Custom emoji selected (shortcode + image URL) */
  onSelectCustomEmoji: (shortcode: string, url: string) => void;
  /** Open the emoji set builder/manager */
  onOpenSetBuilder?: () => void;
}

// Get favorites from localStorage
function getFavoriteEmojis(): string[] {
  try {
    const data = JSON.parse(localStorage.getItem('corkboard:emoji-favorites') || '{}');
    return Object.entries(data)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, 32)
      .map(([emoji]) => emoji);
  } catch { return []; }
}

type TabKind = { type: 'corkboards-default' } | { type: 'favorites' } | { type: 'category'; index: number } | { type: 'custom'; setIndex: number };

export function CombinedEmojiPicker({ onSelectEmoji, onSelectCustomEmoji, onOpenSetBuilder }: CombinedEmojiPickerProps) {
  const { sets, isLoading } = useCustomEmojiSets();
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<TabKind>({ type: 'favorites' });

  // Drive the emoji list's scroll manually. When the picker is mounted inside a
  // Popover that sits within a scroll-locked Dialog (the thread modal) and/or a
  // virtualized/transformed container, ancestor scroll-lockers (react-remove-
  // scroll) intermittently swallow the scroll gesture and the list won't move.
  // Handling wheel (desktop) AND touch (mobile) here — adjusting scrollTop
  // ourselves and stopping the event — makes it scroll reliably regardless of
  // the surrounding scroll context.
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollBodyRef.current;
    if (!el) return;

    // Apply a vertical delta; returns true if we consumed it (so we can stop the
    // event and keep ancestor scroll-lockers from hijacking the gesture).
    const applyDelta = (dy: number): boolean => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight <= clientHeight) return false; // nothing to scroll
      const atTop = scrollTop <= 0 && dy < 0;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 1 && dy > 0;
      if (atTop || atBottom) return false; // let the edge pass through
      el.scrollTop += dy;
      return true;
    };

    const onWheel = (e: WheelEvent) => {
      if (applyDelta(e.deltaY)) { e.preventDefault(); e.stopPropagation(); }
    };

    // Touch: track finger delta between moves and drive scrollTop directly.
    let lastY = 0;
    const onTouchStart = (e: TouchEvent) => { lastY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? lastY;
      const dy = lastY - y; // finger up → scroll down
      lastY = y;
      if (applyDelta(dy)) { e.preventDefault(); e.stopPropagation(); }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  const favorites = useMemo(() => getFavoriteEmojis(), []);

  const handleSelectEmoji = useCallback((emoji: string) => {
    trackEmojiUse(emoji);
    onSelectEmoji(emoji);
  }, [onSelectEmoji]);

  // Search across everything
  const searchResults = useMemo(() => {
    if (!search) return null;
    const q = search.toLowerCase();

    // Standard emoji: match by category name
    const standardMatches: string[] = [];
    for (const cat of EMOJI_CATEGORIES) {
      if (cat.name.toLowerCase().includes(q)) {
        standardMatches.push(...cat.emojis);
      }
    }

    // Custom emoji: match by shortcode
    const customMatches: { shortcode: string; url: string }[] = [];
    for (const s of sets) {
      for (const e of s.emojis) {
        if (e.shortcode.toLowerCase().includes(q) && isValidMediaUrl(e.url)) {
          customMatches.push(e);
        }
      }
    }

    return { standardMatches, customMatches };
  }, [search, sets]);

  // Determine what to display
  const getImgSize = (url: string) => {
    const isAnimated = url.endsWith('.gif') || url.includes('.gif?') || url.endsWith('.webp') || url.includes('.webp?');
    return isAnimated ? 'h-12 w-12' : 'h-8 w-8';
  };

  if (isLoading) {
    return (
      <div className="p-4 space-y-2">
        <Skeleton className="h-7 w-full" />
        <div className="grid grid-cols-8 gap-1">
          {Array.from({ length: 16 }).map((_, i) => <Skeleton key={i} className="h-8 w-8 rounded" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[300px]">
      {/* Search */}
      <div className="p-2 border-b">
        <Input
          placeholder="Search emoji..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 text-xs"
        />
      </div>

      {/* Tabs: Corkboards Default | Favorites | Emoji categories | Custom sets */}
      {!search && (
        <div className="flex border-b px-1 py-1 gap-0.5 overflow-x-auto shrink-0">
          {/* Favorites */}
          {favorites.length > 0 && (
            <button
              onClick={() => setActiveTab({ type: 'favorites' })}
              className={`text-lg px-1 rounded hover:bg-muted transition-colors shrink-0 ${activeTab.type === 'favorites' ? 'bg-muted' : ''}`}
              title="Favorites"
            >
              ⭐
            </button>
          )}
          {/* Corkboards Default — pin emoji tab */}
          <button
            onClick={() => setActiveTab({ type: 'corkboards-default' })}
            className={`flex flex-col items-center px-1.5 rounded hover:bg-muted transition-colors shrink-0 leading-tight ${activeTab.type === 'corkboards-default' ? 'bg-muted' : ''}`}
            title="Corkboards Default"
          >
            <span className="text-base leading-none">📌</span>
            <span className="text-[7px] text-muted-foreground leading-tight">default</span>
          </button>
          {/* Standard emoji categories */}
          {EMOJI_CATEGORIES.map((cat, i) => (
            <button
              key={cat.name}
              onClick={() => setActiveTab({ type: 'category', index: i })}
              className={`text-lg px-1 rounded hover:bg-muted transition-colors shrink-0 ${activeTab.type === 'category' && activeTab.index === i ? 'bg-muted' : ''}`}
              title={cat.name}
            >
              {cat.icon}
            </button>
          ))}
          {/* Separator */}
          {sets.length > 0 && (
            <div className="w-px bg-border mx-0.5 my-1 shrink-0" />
          )}
          {/* Custom emoji set tabs */}
          {sets.map((s, i) => (
            <button
              key={`${s.dTag}-${i}`}
              onClick={() => setActiveTab({ type: 'custom', setIndex: i })}
              className={`text-xs px-2 py-0.5 rounded whitespace-nowrap transition-colors shrink-0 ${activeTab.type === 'custom' && activeTab.setIndex === i ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300' : 'hover:bg-muted'}`}
              title={s.name}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* Content — NATIVE scroll (not Radix ScrollArea): the picker is often
          mounted inside a Popover that itself sits in a transformed/virtualized
          container (the thread panel), where Radix's synthetic scrollbar
          intermittently swallows wheel/touch and refuses to scroll. min-h-0 is
          REQUIRED for a flex child to scroll — without it the content's default
          min-height:auto lets it grow past the container. touch-action + overscroll
          keep the gesture inside the picker. */}
      <div ref={scrollBodyRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain [touch-action:pan-y]">
        {search && searchResults ? (
          <div className="p-2 space-y-2">
            {/* Standard results */}
            {searchResults.standardMatches.length > 0 && (
              <div className="grid grid-cols-8 gap-0.5">
                {searchResults.standardMatches.map((emoji, i) => (
                  <button
                    key={`${emoji}-${i}`}
                    onClick={() => handleSelectEmoji(emoji)}
                    className="text-xl h-8 w-8 flex items-center justify-center rounded hover:bg-muted transition-colors"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
            {/* Custom results */}
            {searchResults.customMatches.length > 0 && (
              <>
                {searchResults.standardMatches.length > 0 && <div className="border-t my-1" />}
                <div className="grid grid-cols-6 gap-1">
                  {searchResults.customMatches.map((emoji) => (
                    <button
                      key={emoji.shortcode}
                      onClick={() => onSelectCustomEmoji(emoji.shortcode, emoji.url)}
                      className="flex items-center justify-center rounded hover:bg-muted transition-colors p-1"
                      title={`:${emoji.shortcode}:`}
                    >
                      <img
                        src={emoji.url}
                        alt={`:${emoji.shortcode}:`}
                        className={`${getImgSize(emoji.url)} object-contain`}
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              </>
            )}
            {searchResults.standardMatches.length === 0 && searchResults.customMatches.length === 0 && (
              <p className="text-center text-xs text-muted-foreground p-4">No matches</p>
            )}
          </div>
        ) : activeTab.type === 'corkboards-default' ? (
          // Corkboards Default emoji set
          <div className="grid grid-cols-6 gap-1 p-2">
            {CORKBOARDS_DEFAULT_EMOJIS.filter(e => isValidMediaUrl(e.url)).map((emoji) => (
              <button
                key={emoji.shortcode}
                onClick={() => onSelectCustomEmoji(emoji.shortcode, emoji.url)}
                className="flex items-center justify-center rounded hover:bg-muted transition-colors p-1"
                title={`:${emoji.shortcode}:`}
              >
                <img
                  src={emoji.url}
                  alt={`:${emoji.shortcode}:`}
                  className={`${getImgSize(emoji.url)} object-contain`}
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        ) : activeTab.type === 'custom' ? (
          // Custom emoji set
          <div className="grid grid-cols-6 gap-1 p-2">
            {(sets[activeTab.setIndex]?.emojis ?? []).filter(e => isValidMediaUrl(e.url)).map((emoji) => (
              <button
                key={emoji.shortcode}
                onClick={() => onSelectCustomEmoji(emoji.shortcode, emoji.url)}
                className="flex items-center justify-center rounded hover:bg-muted transition-colors p-1"
                title={`:${emoji.shortcode}:`}
              >
                <img
                  src={emoji.url}
                  alt={`:${emoji.shortcode}:`}
                  className={`${getImgSize(emoji.url)} object-contain`}
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        ) : (
          // Standard emoji (favorites or category)
          <div className="grid grid-cols-8 gap-0.5 p-2">
            {(activeTab.type === 'favorites'
              ? (favorites.length > 0 ? favorites : EMOJI_CATEGORIES[0]?.emojis ?? [])
              : EMOJI_CATEGORIES[activeTab.index]?.emojis ?? []
            ).map((emoji, i) => (
              <button
                key={`${emoji}-${i}`}
                onClick={() => handleSelectEmoji(emoji)}
                className="text-xl h-8 w-8 flex items-center justify-center rounded hover:bg-muted transition-colors"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      {onOpenSetBuilder && (
        <button
          onClick={onOpenSetBuilder}
          className="flex items-center justify-center gap-1 py-1.5 border-t text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <Settings className="h-3 w-3" />
          Manage Sets
        </button>
      )}
    </div>
  );
}
