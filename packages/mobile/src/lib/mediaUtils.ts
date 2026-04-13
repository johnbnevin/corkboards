// Check if URL is a direct image
export function isImageUrl(url: string): boolean {
  // Don't classify as image if it has a video extension
  if (/\.(mp4|webm|mov|m4v|m3u8)(\?.*)?$/i.test(url)) return false

  const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i
  if (imageExtensions.test(url)) return true

  // Known image hosts
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
