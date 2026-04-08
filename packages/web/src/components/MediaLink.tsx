import { useEffect, useState, useRef } from 'react'
import { Iframe } from '@/components/ui/iframe'
import { LightboxTrigger } from '@/components/ui/lightbox'
import { SizeGuardedImage } from '@/components/SizeGuardedImage'
import { ExternalLink, UtensilsCrossed, Film, AlertCircle } from 'lucide-react'
import { optimizeMediaUrl } from '@/lib/imageUtils'

/** Video player with loading indicator */
function VideoPlayer({ src, poster }: { src: string; poster?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [buffered, setBuffered] = useState(0)
  const playIntentRef = useRef(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleLoadStart = () => {
      setLoadState('loading')
    }

    const handleProgress = () => {
      if (video.buffered.length > 0 && video.duration > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1)
        const percent = (bufferedEnd / video.duration) * 100
        setBuffered(percent)
        if (video.readyState >= 3) {
          setLoadState('ready')
        }
      }
    }

    const handleCanPlay = () => {
      setLoadState('ready')
      // Autoplay if user had clicked play while loading
      if (playIntentRef.current) {
        video.play().catch(() => {})
      }
    }

    const handleError = () => {
      setLoadState('error')
    }

    // Capture play intent - user clicked play but video might not be ready
    const handlePlay = () => {
      playIntentRef.current = true
    }

    video.addEventListener('loadstart', handleLoadStart)
    video.addEventListener('progress', handleProgress)
    video.addEventListener('canplay', handleCanPlay)
    video.addEventListener('error', handleError)
    video.addEventListener('play', handlePlay)

    return () => {
      video.removeEventListener('loadstart', handleLoadStart)
      video.removeEventListener('progress', handleProgress)
      video.removeEventListener('canplay', handleCanPlay)
      video.removeEventListener('error', handleError)
      video.removeEventListener('play', handlePlay)
    }
  }, [])

  return (
    <div className="my-2 rounded-lg overflow-hidden relative">
      {/* Small loading indicator in corner - doesn't block controls */}
      {loadState === 'loading' && buffered < 10 && (
        <div className="absolute top-2 right-2 bg-black/70 rounded px-2 py-1 z-10">
          <span className="text-white/70 text-xs">Loading...</span>
        </div>
      )}
      
      {/* Error state */}
      {loadState === 'error' && (
        <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-10 rounded-lg">
          <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
          <span className="text-white/70 text-sm">Failed to load video</span>
          <a 
            href={src} 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-blue-400 text-xs mt-2 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Open in new tab
          </a>
        </div>
      )}

      <video
        ref={videoRef}
        src={src}
        controls
        className="w-full max-h-[500px] rounded-lg"
        preload="metadata"
        poster={poster}
      />
    </div>
  )
}

interface EmbedInfo {
  url: string
  aspectRatio?: string // 'video' | 'audio' | 'square' | 'image'
  type?: 'embed' | 'image' | 'link-preview'
  title?: string
  description?: string
  icon?: 'recipe' | 'movie'
}

// Check if URL is a direct video
function isVideoUrl(url: string): boolean {
  if (/\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(url)) return true
  try {
    return new URL(url).hostname === 'video.nostr.build'
  } catch {
    return false
  }
}

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

function isSafeUrl(u: string): boolean {
  return /^https?:\/\//i.test(u.trim())
}

export function MediaLink({ url, blurMedia = false, poster, isVideo: forceVideo }: { url: string; blurMedia?: boolean; poster?: string; isVideo?: boolean }) {
  const [embed, setEmbed] = useState<EmbedInfo | null>(null)
  const [imageError, setImageError] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [twitchRevealed, setTwitchRevealed] = useState(false)

  useEffect(() => {
    setImageError(false)

    const getEmbedInfo = (): EmbedInfo | null => {
      try {
        // Forced video (from imeta mime type) — bypass extension detection
        if (forceVideo) {
          return { url, type: 'embed', aspectRatio: 'video' }
        }

        // Direct video URLs (check before image — video.nostr.build would otherwise match nostr.build image host)
        if (isVideoUrl(url)) {
          return { url, type: 'embed', aspectRatio: 'video' }
        }

        // Direct image URLs
        if (isImageUrl(url)) {
          return { url, type: 'image', aspectRatio: 'image' }
        }

        const u = new URL(url)

        // Rumble
        if (u.hostname.includes('rumble.com')) {
          // Rumble URLs: rumble.com/v{id}-title.html or rumble.com/embed/{id}/
          const pathParts = u.pathname.split('/')
          let videoId: string | null = null

          if (u.pathname.includes('/embed/')) {
            const embedIdx = pathParts.indexOf('embed')
            videoId = embedIdx >= 0 && embedIdx + 1 < pathParts.length ? pathParts[embedIdx + 1] || null : null
          } else {
            // Extract from /v{id}-title.html format
            const vMatch = u.pathname.match(/\/v([a-z0-9]+)/i)
            if (vMatch) {
              videoId = vMatch[1]
            }
          }

          if (videoId) {
            return { url: `https://rumble.com/embed/${videoId}/`, aspectRatio: 'video' }
          }
        }

        // Odysee
        if (u.hostname.includes('odysee.com')) {
          // Odysee URLs: odysee.com/@channel/video-name or odysee.com/$/embed/video-name/claimId
          if (u.pathname.includes('/$/embed/')) {
            return { url, aspectRatio: 'video' }
          }
          // Convert regular URL to embed
          // Format: /@channel:id/video:id -> /$/embed/video/id
          const match = u.pathname.match(/@[^/]+\/([^/:]+):?([^/]*)/)
          if (match) {
            const [, videoName, claimId] = match
            if (claimId) {
              return { url: `https://odysee.com/$/embed/${videoName}/${claimId}`, aspectRatio: 'video' }
            }
            return { url: `https://odysee.com/$/embed/${videoName}`, aspectRatio: 'video' }
          }
        }

        // zap.cooking - recipe embeds
        if (u.hostname.includes('zap.cooking')) {
          // Extract recipe slug from URL like zap.cooking/recipe/naddr1...
          const recipeMatch = u.pathname.match(/\/recipe\/([^/]+)/)
          if (recipeMatch) {
            return {
              url,
              type: 'link-preview',
              title: 'Recipe on zap.cooking',
              description: decodeURIComponent(recipeMatch[1]).slice(0, 50),
              icon: 'recipe',
              aspectRatio: 'square'
            }
          }
        }

        // IMDB - movie/show links
        if (u.hostname.includes('imdb.com')) {
          // Extract title ID from URL like imdb.com/title/tt1234567/
          const titleMatch = u.pathname.match(/\/title\/(tt\d+)/)
          if (titleMatch) {
            return {
              url,
              type: 'link-preview',
              title: 'IMDB',
              description: titleMatch[1],
              icon: 'movie',
              aspectRatio: 'square'
            }
          }
        }

        // Tidal (tracks, albums, playlists)
        if (u.hostname.includes('tidal.com')) {
          const pathParts = u.pathname.split('/')
          if (pathParts.length < 2) return null
          const type = pathParts[pathParts.length - 2]
          const id = pathParts[pathParts.length - 1]
          if (!type || !id) return null

          if (type === 'track' || type === 'tracks') {
            return { url: `https://embed.tidal.com/tracks/${id}?layout=gridify`, aspectRatio: 'audio' }
          } else if (type === 'album' || type === 'albums') {
            return { url: `https://embed.tidal.com/albums/${id}?layout=gridify`, aspectRatio: 'square' }
          } else if (type === 'playlist' || type === 'playlists') {
            return { url: `https://embed.tidal.com/playlists/${id}?layout=gridify`, aspectRatio: 'square' }
          }
          // Fallback for other Tidal URLs
          return { url: `https://embed.tidal.com/tracks/${id}?layout=gridify`, aspectRatio: 'audio' }
        }

        // Spotify (tracks, albums, playlists, artists, episodes)
        if (u.hostname.includes('spotify.com')) {
          const pathParts = u.pathname.split('/').filter(Boolean)
          if (pathParts.length >= 2) {
            const type = pathParts[0]
            const id = pathParts[1]
            const aspectRatio = type === 'track' ? 'audio' : 'square'
            return { url: `https://open.spotify.com/embed/${type}/${id}`, aspectRatio }
          }
        }

        // SoundCloud
        if (u.hostname.includes('soundcloud.com')) {
          return {
            url: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%23ff5500&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false`,
            aspectRatio: 'audio'
          }
        }

        // Vimeo
        if (u.hostname.includes('vimeo.com')) {
          const videoId = u.pathname.split('/').filter(Boolean).pop()
          if (videoId) {
            return { url: `https://player.vimeo.com/video/${videoId}`, aspectRatio: 'video' }
          }
        }

        // Twitch (clips, videos, channels)
        if (u.hostname.includes('twitch.tv')) {
          const pathParts = u.pathname.split('/').filter(Boolean)

          if (u.hostname.includes('clips.twitch.tv')) {
            // clips.twitch.tv/ClipSlug
            const clipSlug = pathParts[0]
            return { url: `https://clips.twitch.tv/embed?clip=${clipSlug}&parent=${window.location.hostname}`, aspectRatio: 'video' }
          } else if (pathParts.includes('clip')) {
            // twitch.tv/channel/clip/ClipSlug
            const clipIndex = pathParts.indexOf('clip')
            const clipSlug = clipIndex >= 0 && clipIndex + 1 < pathParts.length ? pathParts[clipIndex + 1] : null
            if (!clipSlug) return null
            return { url: `https://clips.twitch.tv/embed?clip=${clipSlug}&parent=${window.location.hostname}`, aspectRatio: 'video' }
          } else if (pathParts.includes('videos')) {
            // twitch.tv/videos/123456
            const vidIdx = pathParts.indexOf('videos')
            const videoId = (vidIdx >= 0 && vidIdx + 1 < pathParts.length ? pathParts[vidIdx + 1] : null) || pathParts[1]
            return { url: `https://player.twitch.tv/?video=${videoId}&parent=${window.location.hostname}`, aspectRatio: 'video' }
          } else if (pathParts.length === 1) {
            // twitch.tv/channel (live stream)
            const channel = pathParts[0]
            return { url: `https://player.twitch.tv/?channel=${channel}&parent=${window.location.hostname}`, aspectRatio: 'video' }
          }
        }

        // Apple Music
        if (u.hostname.includes('music.apple.com')) {
          // Convert music.apple.com URL to embed URL
          // Example: music.apple.com/us/album/album-name/123456?i=789
          return { url: `https://embed.music.apple.com${u.pathname}${u.search}`, aspectRatio: 'audio' }
        }

        // Bandcamp
        if (u.hostname.includes('bandcamp.com')) {
          // Bandcamp requires oEmbed, but we can try iframe embed
          return {
            url: `https://bandcamp.com/EmbeddedPlayer/${u.pathname.includes('/album/') ? 'album' : 'track'}=${u.pathname.split('/').pop()}/size=large/bgcol=333333/linkcol=0f91ff/tracklist=false/transparent=true/`,
            aspectRatio: 'square'
          }
        }

        return null
      } catch {
        return null
      }
    }

    setEmbed(getEmbedInfo())
  }, [url, forceVideo])

  if (!embed) {
    if (!isSafeUrl(url)) return <span className="text-muted-foreground text-sm break-all">{url}</span>
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline" onClick={(e) => e.stopPropagation()}>
        {url}
      </a>
    )
  }

  // Render image in lightbox
  if (embed.type === 'image') {
    if (imageError) {
      if (!isSafeUrl(url)) return <span className="text-muted-foreground text-sm break-all">{url}</span>
      return (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline" onClick={(e) => e.stopPropagation()}>
          {url}
        </a>
      )
    }
    const shouldBlur = blurMedia && !revealed
    if (shouldBlur) {
      return (
        <div
          className="w-full h-9 flex items-center justify-center cursor-pointer bg-muted/60 hover:bg-muted border-b border-border/30 transition-colors"
          onClick={(e) => { e.stopPropagation(); setRevealed(true); }}
        >
          <span className="text-xs text-muted-foreground">Click to load image</span>
        </div>
      )
    }
    return (
      <LightboxTrigger src={embed.url} className="inline-block my-2">
        <SizeGuardedImage
          src={optimizeMediaUrl(embed.url, true)}
          alt=""
          className="max-w-full max-h-[500px] rounded-lg object-contain hover:opacity-90 transition-opacity"
          loading="lazy"
          onError={() => setImageError(true)}
        />
      </LightboxTrigger>
    )
  }

  // Render link preview (zap.cooking, IMDB)
  if (embed.type === 'link-preview') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="my-2 flex items-center gap-3 p-3 bg-muted/50 hover:bg-muted rounded-lg border transition-colors"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          {embed.icon === 'recipe' ? (
            <UtensilsCrossed className="w-5 h-5 text-orange-500" />
          ) : embed.icon === 'movie' ? (
            <Film className="w-5 h-5 text-orange-500" />
          ) : (
            <ExternalLink className="w-5 h-5 text-primary" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{embed.title}</div>
          {embed.description && (
            <div className="text-xs text-muted-foreground truncate">{embed.description}</div>
          )}
        </div>
        <ExternalLink className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      </a>
    )
  }

  // Unconditional click-to-load for Twitch (prevents parent hostname being sent on load)
  const isTwitchEmbed = embed?.url?.includes('twitch.tv')
  if (isTwitchEmbed && !twitchRevealed) {
    return (
      <div
        className="w-full h-9 flex items-center justify-center cursor-pointer bg-muted/60 hover:bg-muted border-b border-border/30 transition-colors"
        onClick={(e) => { e.stopPropagation(); setTwitchRevealed(true); }}
      >
        <span className="text-xs text-muted-foreground">Click to load Twitch video</span>
      </div>
    )
  }

  // Compact placeholder for iframe embeds (YouTube, Rumble, etc.) — keep blur for these
  const shouldBlurEmbed = blurMedia && !revealed && !isVideoUrl(url)
  if (shouldBlurEmbed) {
    return (
      <div
        className="w-full h-9 flex items-center justify-center cursor-pointer bg-muted/60 hover:bg-muted border-b border-border/30 transition-colors"
        onClick={(e) => { e.stopPropagation(); setRevealed(true); }}
      >
        <span className="text-xs text-muted-foreground">
          Click to load embed
        </span>
      </div>
    )
  }

  // Render direct video with loading indicator
  if (isVideoUrl(url)) {
    return <VideoPlayer src={embed.url} poster={poster} />
  }

  // Render iframe embed
  const aspectClass = embed.aspectRatio === 'audio'
    ? 'h-[152px]'
    : embed.aspectRatio === 'square'
      ? 'aspect-square max-w-[400px]'
      : 'aspect-video'

  return (
    <div className="my-2 rounded-lg overflow-hidden">
      <Iframe
        src={embed.url}
        className={`w-full ${aspectClass}`}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        sandbox="allow-scripts allow-presentation allow-fullscreen allow-same-origin"
      />
    </div>
  )
}
