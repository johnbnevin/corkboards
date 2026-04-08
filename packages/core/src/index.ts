/**
 * @corkboards/core
 *
 * Shared pure TypeScript logic for Nostr protocol, feed algorithms,
 * and utilities. No DOM or React dependencies.
 */

// Storage interface
export type { KVStorage } from './storage';

// Nostr protocol
export * from './nostr';
export * from './noteClassifier';
export * from './dmUtils';
export * from './dmConstants';
export * from './normalizeRelay';

// Feed
export * from './feedConstants';
export * from './rss';

// Text & formatting
export * from './formatTimeAgo';
export * from './textTruncation';
export * from './genUserName';
export * from './sanitizeUtils';

// Storage keys & user isolation
export * from './storageKeys';

// Utilities
export * from './failedNotes';
export * from './nostrUtils';
export * from './cryptoUtils';

// Emoji data (shared by web and mobile)
export * from './emojiCategories';
export * from './defaultEmojiSet';
