/**
 * Pure content detection utilities.
 * The actual sanitizeHtml function stays platform-specific (needs DOMPurify / DOM).
 */

/**
 * Checks if content contains HTML tags
 */
export function hasHtmlContent(content: string): boolean {
  return /<[a-z][\s\S]*>/i.test(content);
}

/**
 * Checks if content is from the logged-in user
 */
export function isContentFromUser(contentPubkey: string, userPubkey?: string): boolean {
  return !!userPubkey && contentPubkey === userPubkey;
}
