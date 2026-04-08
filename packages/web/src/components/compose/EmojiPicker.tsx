import { useState, useMemo, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trackEmojiUse } from '@/components/EmojiSetEditor';
import { EMOJI_CATEGORIES } from '@core/emojiCategories';

// Re-export as CATEGORIES for callers within web
export { EMOJI_CATEGORIES as CATEGORIES };

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

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
}

export function EmojiPicker({ onSelect }: EmojiPickerProps) {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState(-1); // -1 = favorites

  const favorites = useMemo(() => getFavoriteEmojis(), []);

  const filtered = useMemo(() => {
    if (!search) return null;
    const q = search.toLowerCase();
    const results: string[] = [];
    for (const cat of EMOJI_CATEGORIES) {
      if (cat.name.toLowerCase().includes(q)) {
        results.push(...cat.emojis);
      }
    }
    return results.length > 0 ? results : undefined;
  }, [search]);

  const handleSelect = useCallback((emoji: string) => {
    trackEmojiUse(emoji);
    onSelect(emoji);
  }, [onSelect]);

  const displayEmojis = filtered
    ?? (activeCategory === -1
      ? (favorites.length > 0 ? favorites : EMOJI_CATEGORIES[0]?.emojis ?? [])
      : EMOJI_CATEGORIES[activeCategory]?.emojis ?? []);

  return (
    <div className="flex flex-col h-[300px]">
      <div className="p-2 border-b">
        <Input
          placeholder="Search emoji..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 text-xs"
        />
      </div>
      {!search && (
        <div className="flex border-b px-1 py-1 gap-0.5 overflow-x-auto">
          {favorites.length > 0 && (
            <button
              onClick={() => setActiveCategory(-1)}
              className={`text-lg px-1 rounded hover:bg-muted transition-colors ${activeCategory === -1 ? 'bg-muted' : ''}`}
              title="Favorites"
            >
              ⭐
            </button>
          )}
          {EMOJI_CATEGORIES.map((cat, i) => (
            <button
              key={cat.name}
              onClick={() => setActiveCategory(i)}
              className={`text-lg px-1 rounded hover:bg-muted transition-colors ${activeCategory === i ? 'bg-muted' : ''}`}
              title={cat.name}
            >
              {cat.icon}
            </button>
          ))}
        </div>
      )}
      <ScrollArea className="flex-1">
        <div className="grid grid-cols-8 gap-0.5 p-2">
          {displayEmojis.map((emoji, i) => (
            <button
              key={`${emoji}-${i}`}
              onClick={() => handleSelect(emoji)}
              className="text-xl h-8 w-8 flex items-center justify-center rounded hover:bg-muted transition-colors"
            >
              {emoji}
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
