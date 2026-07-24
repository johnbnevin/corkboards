import { formatTimeAgo } from '@core/formatTimeAgo';
import { FEED_KINDS, FEED_PAGE_SIZE_MOBILE } from '@core/feedConstants';

describe('core imports', () => {
  it('formatTimeAgo returns a string for recent timestamps', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(typeof formatTimeAgo(now)).toBe('string');
  });

  it('feedConstants are defined', () => {
    expect(FEED_KINDS).toBeDefined();
    expect(FEED_KINDS.length).toBeGreaterThan(0);
    expect(FEED_PAGE_SIZE_MOBILE).toBeGreaterThan(0);
  });
});
