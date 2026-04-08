import { memo } from 'react';
import { Badge } from '@/components/ui/badge';

interface HashtagData {
  tag: string;
  count: number;
}

interface HashtagBadgesProps {
  hashtags: HashtagData[];
  hashtagFilters: Set<string>;
  onFilterByHashtag: (tag: string) => void;
  maxDisplay?: number;
  className?: string;
}

/**
 * Clickable hashtag badges with counts.
 * Selected hashtags are highlighted; clicking toggles the filter.
 */
export const HashtagBadges = memo(function HashtagBadges({
  hashtags,
  hashtagFilters,
  onFilterByHashtag,
  maxDisplay = 10,
  className = '',
}: HashtagBadgesProps) {
  if (hashtags.length === 0) return null;

  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {hashtags.slice(0, maxDisplay).map(({ tag, count }) => {
        const normalizedTag = tag.toLowerCase();
        const isActive = hashtagFilters.has(normalizedTag);
        return (
          <Badge
            key={normalizedTag}
            variant="outline"
            className={`text-xs px-1.5 py-0 h-5 cursor-pointer transition-colors ${
              isActive
                ? 'bg-primary text-primary-foreground ring-2 ring-primary/50'
                : 'hover:bg-accent'
            }`}
            onClick={() => onFilterByHashtag(tag)}
          >
            #{tag}
            <span className="ml-1 text-muted-foreground">{count}</span>
          </Badge>
        );
      })}
    </div>
  );
});
