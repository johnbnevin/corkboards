/**
 * MediaLink — renders media (images/videos) with proper handling.
 *
 * Images use SizeGuardedImage, videos show a thumbnail/play button.
 * Supports link previews for special domains (zap.cooking, IMDB).
 *
 * Mobile equivalent of packages/web/src/components/MediaLink.tsx.
 */
import { useState, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Linking,
  Dimensions,
  StyleSheet,
  Modal,
  Image,
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { SizeGuardedImage } from './SizeGuardedImage';
import { resolveMediaSources } from '@core/blossom';
import { optimizeMediaUrl } from '@core/imageUtils';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const MEDIA_WIDTH = SCREEN_WIDTH - 56;

/**
 * InlineVideo — plays a video in-place with native controls (expo-video). Kept a
 * separate component so its useVideoPlayer hook stays out of MediaLink's
 * conditional render branches (Rules of Hooks). Does not autoplay.
 *
 * Accepts multiple sources (the canonical URL + Blossom mirrors) and tries the
 * next on error before declaring failure — so a dead mirror doesn't produce a
 * spurious "Failed to load video". Parity with web's VideoPlayer.
 */
function InlineVideo({ sources }: { sources: string[] }) {
  // Index into [canonical url, ...blossom mirror URLs]; advanced when the
  // current source errors so we retry the same hash on another Blossom server.
  const [srcIdx, setSrcIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const srcIdxRef = useRef(0);
  const sourcesRef = useRef(sources);
  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);
  // Reset the mirror cursor when the media itself changes — a stale high index
  // from the previous URL would make the new video's first error terminal.
  const primarySrc = sources[0] ?? '';
  // react-hooks/set-state-in-effect flags this, but an effect is the right tool:
  // the reset must also clear `srcIdxRef`, which the error listener below reads,
  // and the two must land together. Doing it during render would trade this
  // warning for a render-phase ref write, and the cascading render it warns
  // about is a single extra pass that only happens when the media URL actually
  // changes — i.e. when the component is re-rendering anyway.
  useEffect(() => {
    srcIdxRef.current = 0;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSrcIdx(0);
    setFailed(false);
  }, [primarySrc]);
  const src = sources[srcIdx] ?? sources[0] ?? '';
  const player = useVideoPlayer(src, (p) => {
    p.loop = false;
  });

  useEffect(() => {
    const sub = player.addListener('statusChange', ({ status }) => {
      if (status !== 'error') return;
      // Try the next mirror (same blob, different Blossom server) before giving
      // up — only show the error once every source has failed.
      if (srcIdxRef.current < sourcesRef.current.length - 1) {
        srcIdxRef.current += 1;
        setSrcIdx(srcIdxRef.current);
      } else {
        setFailed(true);
      }
    });
    return () => sub.remove();
  }, [player]);

  const retry = () => {
    // User-initiated retry: start over from the canonical URL. Transient
    // network/CDN failures (cold Blossom cache, flaky relay CDN) often
    // succeed on a second pass.
    setFailed(false);
    if (srcIdxRef.current === 0) {
      // Same source string won't recreate the player — force a reload.
      player.replaceAsync(sourcesRef.current[0] ?? '').catch(() => { /* error surfaces via statusChange */ });
    } else {
      srcIdxRef.current = 0;
      setSrcIdx(0);
    }
  };

  if (failed) {
    return (
      <View style={[styles.videoContainer, styles.videoErrorBox]}>
        <Text style={styles.videoErrorText}>Failed to load video</Text>
        <View style={styles.videoErrorActions}>
          <TouchableOpacity onPress={retry}>
            <Text style={styles.videoErrorAction}>Retry</Text>
          </TouchableOpacity>
          {/* Link the CANONICAL url (sources[0]), not the last failed mirror */}
          <TouchableOpacity onPress={() => Linking.openURL(sources[0] ?? src)}>
            <Text style={styles.videoErrorAction}>Open in browser</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.videoContainer}>
      <VideoView
        player={player}
        style={styles.videoPlayer}
        contentFit="contain"
        nativeControls
        allowsFullscreen
      />
    </View>
  );
}

// ─── URL detection helpers ───────────────────────────────────────────────────

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|avif)(\?[^\s]*)?$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?[^\s]*)?$/i;

const IMAGE_DOMAINS = /nostr\.build|blossom\.band|blossom\.yakihonne\.com|blossom\.f7z\.io|blossom\.ditto\.pub|cdn\.sovbit\.host|blossom\.primal\.net|files\.primal\.net|cdn\.satellite\.earth|void\.cat|imgprxy\.stacker\.news|image\.nostr\.build|media\.nostr\.band|zap\.cooking|wav\.school/i;

function isImageUrl(url: string): boolean {
  if (IMAGE_EXT.test(url)) return true;
  try {
    return IMAGE_DOMAINS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isVideoUrl(url: string): boolean {
  if (VIDEO_EXT.test(url)) return true;
  try {
    return new URL(url).hostname === 'video.nostr.build';
  } catch {
    return false;
  }
}

function isSafeUrl(u: string): boolean {
  return /^https?:\/\//i.test(u.trim());
}

// IDs pulled from user-supplied URLs are interpolated into embed URLs.
// Validate each against a strict charset before use so a crafted URL can't
// inject query params or path segments. Parity with web's safeId (M3).
const EMBED_ID_RE = /^[A-Za-z0-9_-]+$/;
function safeId(id: string | null | undefined): string | null {
  if (!id) return null;
  return EMBED_ID_RE.test(id) ? id : null;
}

// ─── Embed info ──────────────────────────────────────────────────────────────

interface EmbedInfo {
  url: string;
  type?: 'image' | 'video' | 'link-preview' | 'embed' | 'youtube';
  title?: string;
  description?: string;
  icon?: 'recipe' | 'movie';
}

function getEmbedInfo(url: string, forceVideo?: boolean): EmbedInfo | null {
  try {
    if (forceVideo) {
      return { url, type: 'video' };
    }
    if (isVideoUrl(url)) {
      return { url, type: 'video' };
    }
    if (isImageUrl(url)) {
      return { url, type: 'image' };
    }

    const u = new URL(url);

    // zap.cooking
    if (u.hostname.includes('zap.cooking')) {
      const match = u.pathname.match(/\/recipe\/([^/]+)/);
      if (match) {
        return {
          url,
          type: 'link-preview',
          title: 'Recipe on zap.cooking',
          description: decodeURIComponent(match[1]).slice(0, 50),
          icon: 'recipe',
        };
      }
    }

    // IMDB
    if (u.hostname.includes('imdb.com')) {
      const match = u.pathname.match(/\/title\/(tt\d+)/);
      if (match) {
        return {
          url,
          type: 'link-preview',
          title: 'IMDB',
          description: match[1],
          icon: 'movie',
        };
      }
    }

    // YouTube (youtube.com, music.youtube.com, m.youtube.com, youtu.be) —
    // resolved to a youtube-nocookie.com embed URL and gated behind
    // tap-to-load so no request reaches Google until the user opts in.
    if (/(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === 'youtu.be') {
      let videoId: string | null = null;
      if (u.hostname === 'youtu.be') {
        videoId = u.pathname.split('/').filter(Boolean)[0] || null;
      } else if (u.pathname === '/watch') {
        videoId = u.searchParams.get('v');
      } else {
        // /shorts/<id>, /live/<id>, /embed/<id>
        const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/);
        if (m) videoId = m[1];
      }
      const safeVideoId = safeId(videoId);
      if (safeVideoId) {
        return { url: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(safeVideoId)}`, type: 'youtube' };
      }
      // Playlist-only links (music.youtube.com/playlist?list=…)
      const listId = safeId(u.searchParams.get('list'));
      if (listId) {
        return { url: `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(listId)}`, type: 'youtube' };
      }
      // Unparseable YouTube link — keep the old preview card behavior.
      return { url, type: 'link-preview', title: 'YouTube Video' };
    }

    // Spotify
    if (u.hostname.includes('spotify.com')) {
      return { url, type: 'link-preview', title: 'Spotify' };
    }

    // Tidal — tap opens the original tidal.com link, which deep-links into the
    // Tidal app where the user is logged in. The web embed is unreliable without
    // a browser login, so on mobile we go straight to the app.
    if (u.hostname.includes('tidal.com')) {
      return { url, type: 'link-preview', title: 'Tidal' };
    }

    // Apple Music
    if (u.hostname.includes('music.apple.com')) {
      return { url, type: 'link-preview', title: 'Apple Music' };
    }

    // Rumble
    if (u.hostname.includes('rumble.com')) {
      return { url, type: 'link-preview', title: 'Rumble Video' };
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

interface MediaLinkProps {
  url: string;
  blurMedia?: boolean;
  poster?: string;
  isVideo?: boolean;
  /** sha256 of the blob (NIP-92 `x`) — enables cross-server fallback. */
  sha256?: string;
  /** Author-declared NIP-92 `fallback` URLs for the same blob. */
  fallbacks?: string[];
}

export function MediaLink({ url, blurMedia = false, poster: _poster, isVideo: forceVideo, sha256, fallbacks }: MediaLinkProps) {
  const [revealed, setRevealed] = useState(false);
  // Whether the in-app fullscreen image viewer is open.
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // Index into [url, ...blossom mirror URLs]; advanced when the current source
  // fails to load so we retry the same hash on another Blossom server.
  const [srcIndex, setSrcIndex] = useState(0);
  // Reset the fallback index when the url prop changes — done in render (the
  // React-recommended "adjust state on prop change" pattern) rather than an
  // effect, which would cause an extra render + a lint warning.
  const [prevUrl, setPrevUrl] = useState(url);
  if (url !== prevUrl) {
    setPrevUrl(url);
    setSrcIndex(0);
  }

  const embed = useMemo(() => getEmbedInfo(url, forceVideo), [url, forceVideo]);
  // Ordered, deduped, SSRF-gated candidates: primary URL, author fallbacks, then
  // the blob rebuilt on every known Blossom server from its sha256. Single source
  // of truth shared with web + avatars.
  const imageSources = useMemo(
    () => resolveMediaSources({ url, sha256, fallbacks }),
    [url, sha256, fallbacks],
  );
  const currentImageUrl = imageSources[srcIndex] ?? url;

  if (!embed) {
    if (!isSafeUrl(url)) {
      return <Text style={styles.unsafeUrl}>{url}</Text>;
    }
    return (
      <TouchableOpacity onPress={() => Linking.openURL(url)}>
        <Text style={styles.link}>{url}</Text>
      </TouchableOpacity>
    );
  }

  // Render image
  if (embed.type === 'image') {
    const shouldBlur = blurMedia && !revealed;
    if (shouldBlur) {
      return (
        <TouchableOpacity
          style={styles.blurPlaceholder}
          onPress={() => setRevealed(true)}
        >
          <Text style={styles.blurText}>Tap to load image</Text>
        </TouchableOpacity>
      );
    }
    return (
      <>
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => setLightboxOpen(true)}
          onLongPress={() => Linking.openURL(currentImageUrl)}
          style={styles.mediaContainer}
        >
          <SizeGuardedImage
            key={currentImageUrl}
            uri={currentImageUrl}
            style={styles.mediaImage}
            type="image"
            resizeMode="cover"
            onError={() => {
              // The blob might still exist on another Blossom server — retry the
              // same hash there before giving up.
              if (srcIndex < imageSources.length - 1) setSrcIndex(i => i + 1);
            }}
          />
        </TouchableOpacity>

        {/* In-app fullscreen viewer — tap image/backdrop or the close button to
            dismiss. Long-press the thumbnail still opens the browser. */}
        <Modal
          visible={lightboxOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setLightboxOpen(false)}
          statusBarTranslucent
        >
          <TouchableOpacity
            style={styles.lightboxBackdrop}
            activeOpacity={1}
            onPress={() => setLightboxOpen(false)}
          >
            <Image
              source={{ uri: optimizeMediaUrl(currentImageUrl, true) }}
              style={styles.lightboxImage}
              resizeMode="contain"
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.lightboxClose}
            onPress={() => setLightboxOpen(false)}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityLabel="Close image viewer"
          >
            <Text style={styles.lightboxCloseText}>X</Text>
          </TouchableOpacity>
        </Modal>
      </>
    );
  }

  // Render video
  if (embed.type === 'video') {
    const shouldBlur = blurMedia && !revealed;
    if (shouldBlur) {
      return (
        <TouchableOpacity
          style={styles.blurPlaceholder}
          onPress={() => setRevealed(true)}
        >
          <Text style={styles.blurText}>Tap to load video</Text>
        </TouchableOpacity>
      );
    }
    // Inline player (native controls) instead of kicking out to the browser.
    // Pass the canonical URL + author fallbacks + Blossom mirrors so a dead
    // mirror doesn't produce a spurious "Failed to load video". resolveMediaSources
    // already SSRF-gates every candidate (drops private/localhost/credentialed
    // URLs) before they reach the <VideoView>. Nothing safe left → render nothing.
    const videoSources = resolveMediaSources({ url: embed.url, sha256, fallbacks });
    if (videoSources.length === 0) return null;
    return <InlineVideo sources={videoSources} />;
  }

  // YouTube — always gated behind tap-to-load so no request reaches Google
  // until the user opts in. Mobile has no WebView dependency for inline
  // iframes, so the opt-in tap opens the privacy-friendly youtube-nocookie
  // embed in the browser instead.
  if (embed.type === 'youtube') {
    return (
      <TouchableOpacity
        style={styles.blurPlaceholder}
        onPress={() => Linking.openURL(embed.url)}
      >
        <Text style={styles.blurText}>Tap to load YouTube video</Text>
      </TouchableOpacity>
    );
  }

  // Render link preview
  if (embed.type === 'link-preview') {
    return (
      <TouchableOpacity
        style={styles.linkPreview}
        onPress={() => Linking.openURL(url)}
      >
        <View style={styles.linkPreviewIcon}>
          <Text style={styles.linkPreviewEmoji}>
            {embed.icon === 'recipe' ? 'C' : embed.icon === 'movie' ? 'M' : 'L'}
          </Text>
        </View>
        <View style={styles.linkPreviewInfo}>
          <Text style={styles.linkPreviewTitle} numberOfLines={1}>{embed.title}</Text>
          {embed.description && (
            <Text style={styles.linkPreviewDesc} numberOfLines={1}>{embed.description}</Text>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  // Fallback: open in browser
  return (
    <TouchableOpacity onPress={() => Linking.openURL(url)}>
      <Text style={styles.link}>{url}</Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  unsafeUrl: {
    color: '#666',
    fontSize: 12,
  },
  link: {
    color: '#a855f7',
    textDecorationLine: 'underline',
    fontSize: 14,
  },
  mediaContainer: {
    marginVertical: 6,
    borderRadius: 10,
    overflow: 'hidden',
  },
  mediaImage: {
    width: MEDIA_WIDTH,
    height: MEDIA_WIDTH * 0.56,
    borderRadius: 10,
  },
  lightboxBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightboxImage: {
    width: '100%',
    height: '100%',
  },
  lightboxClose: {
    position: 'absolute',
    top: 48,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightboxCloseText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  videoContainer: {
    width: MEDIA_WIDTH,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#000',
    marginVertical: 6,
  },
  videoPlayer: {
    width: MEDIA_WIDTH,
    height: Math.round((MEDIA_WIDTH * 9) / 16),
    backgroundColor: '#000',
  },
  videoErrorBox: {
    height: Math.round((MEDIA_WIDTH * 9) / 16),
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  videoErrorText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
  },
  videoErrorActions: {
    flexDirection: 'row',
    gap: 16,
  },
  videoErrorAction: {
    color: '#60a5fa',
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  blurPlaceholder: {
    width: MEDIA_WIDTH,
    height: 36,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 4,
  },
  blurText: {
    color: '#666',
    fontSize: 12,
  },
  linkPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#404040',
    marginVertical: 6,
  },
  linkPreviewIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: 'rgba(168,85,247,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkPreviewEmoji: {
    fontSize: 16,
    color: '#f97316',
    fontWeight: '600',
  },
  linkPreviewInfo: {
    flex: 1,
  },
  linkPreviewTitle: {
    color: '#f2f2f2',
    fontSize: 13,
    fontWeight: '500',
  },
  linkPreviewDesc: {
    color: '#999',
    fontSize: 11,
    marginTop: 2,
  },
});
