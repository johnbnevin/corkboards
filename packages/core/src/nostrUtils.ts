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
  if (!url.startsWith('wss://') || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:' || parsed.hostname.length === 0) return false;
    // Block private/localhost IPs to prevent SSRF-like data leaks
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost') return false;
    // IPv6 private ranges: loopback, link-local, unique local, IPv4-mapped
    if (host.startsWith('[')) {
      const ipv6 = host.slice(1, -1).toLowerCase(); // strip brackets, normalize
      if (ipv6 === '::1') return false;                             // loopback
      // Expanded zero forms: 0:0:0:0:0:0:0:1 and similar
      if (/^(0:){7}1$/.test(ipv6) || /^0{0,4}(::)0{0,4}1$/.test(ipv6)) return false;
      if (ipv6.startsWith('fe80')) return false;                    // link-local (fe80::/10)
      if (ipv6.startsWith('fc') || ipv6.startsWith('fd')) return false; // unique local (fc00::/7)
      if (ipv6.startsWith('::ffff:')) return false;                 // IPv4-mapped IPv6
      // Block IPv4-compatible (deprecated but still routable to localhost)
      if (ipv6.startsWith('::') && ipv6.includes('.')) return false;
      return true;
    }
    // IPv4 private ranges: 0.x.x.x, 10.x.x.x, 127.x.x.x, 169.254.x.x, 172.16-31.x.x, 192.168.x.x, 255.x.x.x
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [, a, b, c, d] = ipv4Match.map(Number);
      if (a > 255 || b > 255 || c > 255 || d > 255) return false;
      if (a === 0 || a === 10 || a === 127 || a === 255) return false;
      if (a === 192 && b === 168) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 169 && b === 254) return false;
    }
    return true;
  } catch { return false; }
}
