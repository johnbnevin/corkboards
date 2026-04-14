/**
 * Feed constants shared across all platforms.
 */

export const FEED_PAGE_SIZE_DESKTOP = 60;       // notes per query on desktop
export const FEED_PAGE_SIZE_MOBILE = 25;        // notes per column on mobile
export const FEED_LOAD_MORE_COUNT = 60;    // notes to fetch on "load older"
export const AUTHOR_BATCH_SIZE = 500;  // max authors per relay query (single query)
export const MAX_PARALLEL_BATCHES = 1;
/** RSS proxy URL — relative by default so it works on any deployment (self-hosted, stage, prod) */
export const RSS_PROXY = '/rss-proxy.php';

/**
 * Standard event kinds queried for all feeds.
 * 1=notes, 5=deletions, 6=repost(note), 7=reaction, 16=repost(generic),
 * 30023=long-form, 34235=video, 34236=short video,
 * 9735=zap receipt, 9802=highlight, 30023+zap.cooking=recipes
 */
export const FEED_KINDS = [1, 5, 6, 7, 16, 30023, 34235, 34236, 9735, 9802] as const;
