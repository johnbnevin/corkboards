import { useState, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useCustomEmojiSets } from '@/hooks/useCustomEmojiSets';
import { isValidMediaUrl } from '@/lib/textareaUtils';
import { Settings } from 'lucide-react';

interface CustomEmojiPickerProps {
  /** Called when a custom emoji is selected — shortcode for inline, url for the tag */
  onSelect: (shortcode: string, url: string) => void;
  /** When true, show emoji larger (sticker mode) */
  stickerMode?: boolean;
  /** Open the emoji set builder/manager */
  onOpenSetBuilder?: () => void;
}

export function CustomEmojiPicker({ onSelect, stickerMode = false, onOpenSetBuilder }: CustomEmojiPickerProps) {
  const { sets, isLoading } = useCustomEmojiSets();
  const [search, setSearch] = useState('');
  const [activeSet, setActiveSet] = useState(0);

  const filtered = useMemo(() => {
    if (!search) return null;
    const q = search.toLowerCase();
    const results: { shortcode: string; url: string }[] = [];
    for (const s of sets) {
      for (const e of s.emojis) {
        if (e.shortcode.toLowerCase().includes(q) && isValidMediaUrl(e.url)) {
          results.push(e);
        }
      }
    }
    return results;
  }, [search, sets]);

  const displayEmojis = filtered ?? (sets[activeSet]?.emojis.filter(e => isValidMediaUrl(e.url)) ?? []);
  const getImgSize = (url: string) => {
    if (stickerMode) return 'h-16 w-16';
    const isAnimated = url.endsWith('.gif') || url.includes('.gif?');
    return isAnimated ? 'h-16 w-16' : 'h-8 w-8';
  };

  if (isLoading) {
    return (
      <div className="p-4 space-y-2">
        <Skeleton className="h-4 w-32" />
        <div className="grid grid-cols-6 gap-2">
          {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-8 w-8 rounded" />)}
        </div>
      </div>
    );
  }

  if (sets.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground space-y-2">
        <p>No custom emoji sets found.</p>
        {onOpenSetBuilder ? (
          <button
            onClick={onOpenSetBuilder}
            className="text-xs text-purple-500 hover:text-purple-400 font-medium"
          >
            Create Emoji Set
          </button>
        ) : (
          <p className="text-xs">Create emoji sets in Settings, or follow someone who shares theirs.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[300px]">
      <div className="p-2 border-b">
        <Input
          placeholder="Search custom emoji..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 text-xs"
        />
      </div>
      {!search && sets.length > 1 && (
        <div className="flex border-b px-1 py-1 gap-1 overflow-x-auto">
          {sets.map((s, i) => (
            <button
              key={s.dTag}
              onClick={() => setActiveSet(i)}
              className={`text-xs px-2 py-0.5 rounded whitespace-nowrap transition-colors ${activeSet === i ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300' : 'hover:bg-muted'}`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <ScrollArea className="flex-1">
        <div className={`grid ${stickerMode ? 'grid-cols-4' : 'grid-cols-6'} gap-1 p-2`}>
          {displayEmojis.map((emoji) => (
            <button
              key={emoji.shortcode}
              onClick={() => onSelect(emoji.shortcode, emoji.url)}
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
        {displayEmojis.length === 0 && (
          <p className="text-center text-xs text-muted-foreground p-4">No matches</p>
        )}
      </ScrollArea>
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
