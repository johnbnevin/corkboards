/**
 * Nostr tag utilities.
 *
 * Safe helpers for accessing Nostr event tag arrays, which can have
 * variable length and non-string values in practice.
 */

export type NostrTag = string[];

/**
 * Get a value from an event's tag array by tag name.
 *
 * @param tags - The event's tags array
 * @param name - Tag name to look for (e.g. 'e', 'p', 'r')
 * @param valueIndex - Index of the value within the matched tag (default 1)
 * @returns The string value at that index, or undefined if not found / not a string
 *
 * @example
 *   getTag(event.tags, 'e')        // → root/reply event ID or undefined
 *   getTag(event.tags, 'p')        // → recipient pubkey or undefined
 *   getTag(event.tags, 'e', 3)     // → marker ('root'/'reply') or undefined
 */
export function getTag(
  tags: NostrTag[],
  name: string,
  valueIndex = 1
): string | undefined {
  const tag = tags.find(t => t[0] === name);
  if (!tag) return undefined;
  const val = tag[valueIndex];
  return typeof val === 'string' ? val : undefined;
}

/**
 * Get all tags matching a given name.
 *
 * @param tags - The event's tags array
 * @param name - Tag name to look for
 * @returns Array of matching tags (may be empty)
 */
export function getAllTags(tags: NostrTag[], name: string): NostrTag[] {
  return tags.filter(t => t[0] === name);
}

/**
 * Get a value from a specific tag match by both name AND a predicate on the tag array.
 *
 * @param tags - The event's tags array
 * @param name - Tag name to look for
 * @param predicate - Additional filter on the matched tag
 * @param valueIndex - Index of the value within the matched tag (default 1)
 * @returns The string value at that index, or undefined
 *
 * @example
 *   // Get the root e-tag marker
 *   getTagWhere(event.tags, 'e', t => t[3] === 'root')
 */
export function getTagWhere(
  tags: NostrTag[],
  name: string,
  predicate: (tag: NostrTag) => boolean,
  valueIndex = 1
): string | undefined {
  const tag = tags.find(t => t[0] === name && predicate(t));
  if (!tag) return undefined;
  const val = tag[valueIndex];
  return typeof val === 'string' ? val : undefined;
}

export function isSecureRelay(url: string): boolean {
  if (!url.startsWith('wss://') || url.length > 256) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'wss:' && parsed.hostname.length > 0;
  } catch { return false; }
}
