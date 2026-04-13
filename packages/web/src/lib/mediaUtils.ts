// Check if URL is a direct image
export function isImageUrl(url: string): boolean {
  // Don't classify as image if it has a video extension
  if (/\.(mp4|webm|mov|m4v|m3u8)(\?.*)?$/i.test(url)) return false

  const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i
  if (imageExtensions.test(url)) return true

  // Known CDN hosts — only classify extensionless URLs as images if they're
  // on a host we know. Extensionless Blossom URLs (SHA256 hashes) might be
  // videos; MediaLink handles the fallback detection for those.
  const imageHosts = [
    'nostr.build',
    'image.nostr.build',
    'i.nostr.build',
    'blossom.band',
    'blossom.yakihonne.com',
    'blossom.f7z.io',
    'blossom.ditto.pub',
    'cdn.sovbit.host',
    'blossom.primal.net',
    'files.primal.net',
    'cdn.satellite.earth',
    'void.cat',
    'imgprxy.stacker.news',
    'media.nostr.band',
  ]

  try {
    const u = new URL(url)
    // video.nostr.build hosts videos, not images
    if (u.hostname === 'video.nostr.build') return false
    return imageHosts.some(host => u.hostname.includes(host))
  } catch {
    return false
  }
}

/** True when the URL is on a CDN host that may serve either images or videos
 *  (used by MediaLink to try video fallback on image error) */
export function isCdnHost(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return ['blossom.', 'nostr.build', 'cdn.sovbit', 'files.primal', 'cdn.satellite', 'void.cat', 'media.nostr.band'].some(p => h.includes(p))
  } catch { return false }
}
