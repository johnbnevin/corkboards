/**
 * Format a timestamp as a relative time string (e.g., "5 min ago", "2 hours ago")
 * @param timestamp Unix timestamp in seconds
 * @returns Human-readable relative time string
 */
export function formatTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  
  if (diff < 60) return 'just now';
  if (diff < 3600) {
    const mins = Math.floor(diff / 60);
    return `${mins} min ago`;
  }
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    const mins = Math.floor((diff % 3600) / 60);
    if (mins > 0) return `${hours}h ${mins}m ago`;
    return `${hours} hours ago`;
  }
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (hours > 0 && mins > 0) return `${days}d ${hours}h ${mins}m ago`;
  if (hours > 0) return `${days}d ${hours}h ago`;
  return `${days} days ago`;
}

/**
 * Format a timestamp as a compact relative time string (e.g., "5m ago", "2h ago")
 * @param createdAt Unix timestamp in seconds
 * @returns Compact human-readable relative time string
 */
export function formatTimeAgoCompact(createdAt: number): string {
  const seconds = Math.floor(Date.now() / 1000) - createdAt;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(seconds / 3600);
  const days = Math.floor(seconds / 86400);
  
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  if (days < 3) {
    const mins = Math.floor((seconds % 3600) / 60);
    if (mins > 0) return `${hours}h${mins}m ago`;
    return `${hours}h ago`;
  }
  const remainHours = Math.floor((seconds % 86400) / 3600);
  const remainMins = Math.floor((seconds % 3600) / 60);
  if (remainHours > 0 && remainMins > 0) return `${days}d${remainHours}h${remainMins}m ago`;
  if (remainHours > 0) return `${days}d${remainHours}h ago`;
  return `${days}d ago`;
}
