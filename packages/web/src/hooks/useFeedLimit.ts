/**
 * useFeedLimit
 *
 * Returns the note limit based on viewport size and user settings.
 * Desktop: 60 notes, Mobile: 25 notes per column, multiplied by user's setting.
 *
 * The multiplier is platform-specific — user can have 3x on desktop, 1x on phone.
 */
import { usePlatformStorage } from './usePlatformStorage';
import { useIsMobile } from './useIsMobile';
import { NOTES_DESKTOP, NOTES_MOBILE, FETCH_MORE_COUNT } from '@/lib/feedUtils';
import { STORAGE_KEYS } from '@/lib/storageKeys';

export type FeedLimitMultiplier = 1 | 2 | 3;

export function useFeedLimit() {
  const isMobile = useIsMobile();
  const [multiplier, setMultiplier] = usePlatformStorage<FeedLimitMultiplier>(
    STORAGE_KEYS.FEED_LIMIT_MULTIPLIER,
    1
  );

  const baseLimit = isMobile ? NOTES_MOBILE : NOTES_DESKTOP;
  const limit = Math.round(baseLimit * multiplier);
  const fetchMoreCount = Math.round(FETCH_MORE_COUNT * multiplier);

  return {
    limit,
    fetchMoreCount,
    multiplier,
    setMultiplier,
    isMobile,
    baseLimit,
  };
}
