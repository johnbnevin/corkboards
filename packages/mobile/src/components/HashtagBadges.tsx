/**
 * HashtagBadges — row of tappable hashtag badges with counts.
 *
 * Selected hashtags are highlighted; tapping toggles the filter.
 *
 * Mobile equivalent of packages/web/src/components/HashtagBadges.tsx.
 */
import { memo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
} from 'react-native';

interface HashtagData {
  tag: string;
  count: number;
}

interface HashtagBadgesProps {
  hashtags: HashtagData[];
  hashtagFilters: Set<string>;
  onFilterByHashtag: (tag: string) => void;
  maxDisplay?: number;
}

export const HashtagBadges = memo(function HashtagBadges({
  hashtags,
  hashtagFilters,
  onFilterByHashtag,
  maxDisplay = 10,
}: HashtagBadgesProps) {
  if (hashtags.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.container}
    >
      {hashtags.slice(0, maxDisplay).map(({ tag, count }) => {
        const normalizedTag = tag.toLowerCase();
        const isActive = hashtagFilters.has(normalizedTag);
        return (
          <TouchableOpacity
            key={normalizedTag}
            style={[styles.badge, isActive && styles.badgeActive]}
            onPress={() => onFilterByHashtag(tag)}
            activeOpacity={0.7}
          >
            <Text style={[styles.badgeText, isActive && styles.badgeTextActive]}>
              #{tag}
            </Text>
            <Text style={styles.badgeCount}>{count}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 4,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#555',
    backgroundColor: 'transparent',
  },
  badgeActive: {
    backgroundColor: '#a855f7',
    borderColor: '#a855f7',
  },
  badgeText: {
    color: '#ccc',
    fontSize: 12,
  },
  badgeTextActive: {
    color: '#fff',
    fontWeight: '500',
  },
  badgeCount: {
    color: '#999',
    fontSize: 10,
  },
});
