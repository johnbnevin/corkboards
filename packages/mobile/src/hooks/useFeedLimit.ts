import { usePlatformStorage } from './usePlatformStorage';
import { FEED_PAGE_SIZE_MOBILE } from '@core/feedConstants';
import { STORAGE_KEYS } from '@core/storageKeys';

export type FeedLimitMultiplier = 1 | 2 | 3;

export function useFeedLimit() {
  const [multiplier, setMultiplier] = usePlatformStorage<FeedLimitMultiplier>(
    STORAGE_KEYS.FEED_LIMIT_MULTIPLIER,
    1
  );

  const baseLimit = FEED_PAGE_SIZE_MOBILE;
  const limit = Math.round(baseLimit * multiplier);
  // Fetch more = half the base limit, scaled by multiplier
  const fetchMoreCount = Math.round(Math.ceil(baseLimit / 2) * multiplier);

  return { limit, fetchMoreCount, multiplier, setMultiplier };
}
