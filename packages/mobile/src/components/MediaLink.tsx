/**
 * MediaLink — renders media (images/videos) with proper handling.
 *
 * Images use SizeGuardedImage, videos show a thumbnail/play button.
 * Supports link previews for special domains (zap.cooking, IMDB).
 *
 * Mobile equivalent of packages/web/src/components/MediaLink.tsx.
 */
import { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Linking,
  Dimensions,
  StyleSheet,
} from 'react-native';
import { SizeGuardedImage } from './SizeGuardedImage';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const MEDIA_WIDTH = SCREEN_WIDTH - 56;

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

// ─── Embed info ──────────────────────────────────────────────────────────────

interface EmbedInfo {
  url: string;
  type?: 'image' | 'video' | 'link-preview' | 'embed';
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

    // YouTube — show as link preview on mobile (no iframe)
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
      return { url, type: 'link-preview', title: 'YouTube Video' };
    }

    // Spotify
    if (u.hostname.includes('spotify.com')) {
      return { url, type: 'link-preview', title: 'Spotify' };
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
}

export function MediaLink({ url, blurMedia = false, poster, isVideo: forceVideo }: MediaLinkProps) {
  const [revealed, setRevealed] = useState(false);

  const embed = useMemo(() => getEmbedInfo(url, forceVideo), [url, forceVideo]);

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
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={() => Linking.openURL(embed.url)}
        style={styles.mediaContainer}
      >
        <SizeGuardedImage
          uri={embed.url}
          style={styles.mediaImage}
          type="image"
          resizeMode="cover"
        />
      </TouchableOpacity>
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
    return (
      <TouchableOpacity
        style={styles.videoPlaceholder}
        onPress={() => Linking.openURL(embed.url)}
      >
        <Text style={styles.videoIcon}>{'>'}</Text>
        <Text style={styles.videoLabel}>Play video</Text>
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
  videoPlaceholder: {
    width: MEDIA_WIDTH,
    height: 80,
    backgroundColor: '#333',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginVertical: 6,
  },
  videoIcon: { color: '#b3b3b3', fontSize: 20 },
  videoLabel: { color: '#999', fontSize: 13 },
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
