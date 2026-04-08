/**
 * Normalize a relay URL to ensure consistent formatting
 * Uses the same algorithm as RelayListManager (URL constructor for proper normalization)
 * @param url The relay URL to normalize
 * @returns Normalized URL with trailing slash and lowercase hostname
 */
export function normalizeRelay(url: string): string {
  url = url.trim();
  try {
    return new URL(url).toString();
  } catch {
    try {
      return new URL(`wss://${url}`).toString();
    } catch {
      // Fallback: just ensure trailing slash
      return url.endsWith('/') ? url : url + '/';
    }
  }
}
