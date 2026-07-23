/**
 * SizeGuardedImage — blocks images whose file size exceeds the user's limit.
 *
 * React Native version: does a HEAD request (cached) to check Content-Length.
 * Shows a placeholder when over the limit, with a tap-to-load option.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Image,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  type ImageStyle,
  type StyleProp,
} from 'react-native';
import { mobileStorage } from '../storage/MmkvStorage';
import { STORAGE_KEYS } from '../lib/storageKeys';
import { supportsCorsHead, learnCorsHost } from '../lib/mediaUtils';
import { applyImageProxy } from '@core/imageProxy';
import { shouldRejectUrl } from '@core/imageUtils';
import { resolveMediaSources } from '@core/blossom';

type SizeLimitOption = 'small' | 'default' | 'large' | 'none';

const AVATAR_LIMIT_BYTES: Record<SizeLimitOption, number> = {
  small: 250 * 1024,
  default: 750 * 1024,
  large: 1.5 * 1024 * 1024,
  none: 0,
};

const IMAGE_LIMIT_BYTES: Record<SizeLimitOption, number> = {
  small: 750 * 1024,
  default: 2.25 * 1024 * 1024,
  large: 4.5 * 1024 * 1024,
  none: 0,
};

function getLimitBytes(type: 'avatar' | 'image'): number {
  const key = type === 'avatar' ? STORAGE_KEYS.AVATAR_SIZE_LIMIT : STORAGE_KEYS.IMAGE_SIZE_LIMIT;
  const table = type === 'avatar' ? AVATAR_LIMIT_BYTES : IMAGE_LIMIT_BYTES;
  try {
    const stored = mobileStorage.getSync(key);
    const option = stored ? JSON.parse(stored) as SizeLimitOption : 'default';
    return table[option] ?? table.default;
  } catch {
    return table.default;
  }
}

// HEAD-based size cache (matches web's SizeGuardedImage cache structure)
interface SizeCheckResult { size: number | null; isVideo: boolean }
const MAX_SIZE_CACHE = 2000;
const sizeCache = new Map<string, SizeCheckResult>();
const pendingChecks = new Map<string, Promise<SizeCheckResult>>();
/** Hosts where HEAD requests fail — skip future checks for any URL on these hosts */
const corsBlockedHosts = new Set<string>();

/** Sentinel size value: host not whitelisted, size unknown */
const SIZE_UNKNOWN = -1;

function getHost(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

async function checkSize(url: string): Promise<SizeCheckResult> {
  if (sizeCache.has(url)) return sizeCache.get(url)!;

  // Skip HEAD for hosts that previously failed or aren't on the whitelist
  if (corsBlockedHosts.has(getHost(url)) || !supportsCorsHead(url)) {
    const result: SizeCheckResult = { size: SIZE_UNKNOWN, isVideo: false };
    sizeCache.set(url, result);
    return result;
  }

  if (pendingChecks.has(url)) return pendingChecks.get(url)!;

  const host = getHost(url);
  const promise = (async () => {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      const cl = res.headers.get('content-length');
      const ct = res.headers.get('content-type') || '';
      const result: SizeCheckResult = {
        size: cl ? parseInt(cl, 10) : null,
        isVideo: ct.startsWith('video/'),
      };
      if (sizeCache.size >= MAX_SIZE_CACHE) {
        const oldest = sizeCache.keys().next().value;
        if (oldest !== undefined) sizeCache.delete(oldest);
      }
      sizeCache.set(url, result);
      if (host) learnCorsHost(host);
      return result;
    } catch {
      // Remember this host blocks HEAD so we don't flood it with failed requests
      if (host) corsBlockedHosts.add(host);
      const result: SizeCheckResult = { size: null, isVideo: false };
      if (sizeCache.size >= MAX_SIZE_CACHE) {
        const oldest = sizeCache.keys().next().value;
        if (oldest !== undefined) sizeCache.delete(oldest);
      }
      sizeCache.set(url, result);
      return result;
    } finally {
      pendingChecks.delete(url);
    }
  })();
  pendingChecks.set(url, promise);
  return promise;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SizeGuardedImageProps {
  uri: string;
  style?: StyleProp<ImageStyle>;
  type?: 'avatar' | 'image';
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'center';
  /** Called when the underlying <Image> fails to load (e.g. 404). Lets callers
   *  retry the same blob on another Blossom server. */
  onError?: () => void;
}

export function SizeGuardedImage({ uri: propUri, style, type = 'image', resizeMode = 'cover', onError }: SizeGuardedImageProps) {
  // Avatars get transparent cross-server fallback here (one place → all ~10
  // avatar call sites benefit): the same blob rebuilt on every known Blossom
  // server from a flat/hash URL, SSRF-gated. Content images (type='image') get
  // their fallback via MediaLink/InlineImage, so leave that path single-source.
  const avatarSources = useMemo(
    () => (type === 'avatar' ? resolveMediaSources({ url: propUri, rejectType: 'avatar' }) : []),
    [propUri, type],
  );
  // Index into avatarSources; reset (in render) when the incoming uri changes.
  const [srcIndex, setSrcIndex] = useState(0);
  // Set once every avatar candidate has failed to load → show the placeholder.
  const [avatarErrored, setAvatarErrored] = useState(false);
  const [prevPropUri, setPrevPropUri] = useState(propUri);
  if (propUri !== prevPropUri) {
    setPrevPropUri(propUri);
    setSrcIndex(0);
    setAvatarErrored(false);
  }
  // The candidate we're currently attempting. For non-avatars this is just the
  // incoming uri; for avatars it walks the fallback list on load errors.
  const rawUri = type === 'avatar' ? (avatarSources[srcIndex] ?? propUri) : propUri;
  const avatarExhausted = type === 'avatar' && srcIndex >= avatarSources.length - 1;

  // SSRF gate: reject private/loopback/link-local/credentialed hosts (in any IP
  // encoding), non-https avatars, and executable extensions before the URL ever
  // reaches <Image> or the HEAD probe — mirrors web's optimizeAvatarUrl /
  // optimizeMediaUrl. Only remote http(s) URLs are gated; local file:/content:/
  // data: URIs are the user's own picks and pass through.
  const isRemote = /^https?:\/\//i.test(rawUri);
  const rejected = isRemote && shouldRejectUrl(rawUri, type === 'avatar' ? 'avatar' : 'media');
  // Apply the user's image proxy here so HEAD probe + final render both hit
  // the proxied URL. Non-http(s) URLs (data:, blob:) pass through unchanged.
  const uri = applyImageProxy(rawUri);
  const limitBytes = getLimitBytes(type);
  const [status, setStatus] = useState<'checking' | 'allowed' | 'blocked' | 'unknown' | 'override'>('checking');
  const [fileSize, setFileSize] = useState<number | null>(null);
  const mountedRef = useRef(true);

  // Advance to the next avatar candidate on load error; when the list is
  // exhausted, fall through to the neutral avatar placeholder below.
  const handleImageError = () => {
    if (type === 'avatar') {
      if (!avatarExhausted) {
        setSrcIndex(i => i + 1);
      } else {
        setAvatarErrored(true);
      }
      return;
    }
    onError?.();
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const resolveStatus = (result: SizeCheckResult) => {
    if (result.size === SIZE_UNKNOWN) return 'unknown' as const;
    if (!result.isVideo && result.size !== null && result.size > limitBytes) return 'blocked' as const;
    return 'allowed' as const;
  };

  // Hydrate fileSize/status from cache or async HEAD probe. Both branches
  // intentionally set state — this is the documented async-hydration pattern,
  // not a reactive cascade. resolveStatus is a pure helper closed over current
  // props; including it would force a useCallback for no benefit.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    if (rejected) return; // unsafe host — never probe or load it
    if (limitBytes === 0) { setStatus('allowed'); return; }
    if (sizeCache.has(uri)) {
      const cached = sizeCache.get(uri)!;
      setFileSize(cached.size === SIZE_UNKNOWN ? null : cached.size);
      setStatus(resolveStatus(cached));
      return;
    }
    setStatus('checking');
    checkSize(uri).then(result => {
      if (!mountedRef.current) return;
      setFileSize(result.size === SIZE_UNKNOWN ? null : result.size);
      setStatus(resolveStatus(result));
    });
  }, [uri, limitBytes]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  if (rejected || avatarErrored) {
    // Unsafe/blocked host, or every avatar candidate failed to load: render a
    // neutral placeholder for avatars, nothing for inline media. Never expose a
    // tap-to-load override for these.
    if (type === 'avatar') {
      return <View style={[style as object, localStyles.avatarPlaceholder]} />;
    }
    return null;
  }

  if (status === 'checking') {
    // Show placeholder while HEAD request checks size — don't render <Image>
    // because React Native would start downloading the full image immediately.
    return <View style={[style as object, localStyles.checkingPlaceholder]} />;
  }

  if (status === 'allowed' || status === 'override') {
    return <Image key={uri} source={{ uri }} style={style} resizeMode={resizeMode} onError={handleImageError} />;
  }

  // Blocked or unknown
  const label = status === 'unknown' ? 'Unknown size' : `Image too large (${fileSize ? formatBytes(fileSize) : '?'})`;

  if (type === 'avatar') {
    return (
      <TouchableOpacity onPress={() => setStatus('override')}>
        <View style={[style as object, localStyles.avatarPlaceholder]}>
          <Text style={localStyles.avatarX}>{status === 'unknown' ? '?' : 'X'}</Text>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity style={localStyles.blockedContainer} onPress={() => setStatus('override')}>
      <Text style={localStyles.blockedText}>
        {label} — tap to load
      </Text>
    </TouchableOpacity>
  );
}

const localStyles = StyleSheet.create({
  checkingPlaceholder: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    minHeight: 48,
  },
  avatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarX: { color: '#666', fontSize: 10, fontWeight: '600' },
  blockedContainer: {
    padding: 12,
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#404040',
    borderStyle: 'dashed',
    marginVertical: 4,
  },
  blockedText: { color: '#999', fontSize: 12, textAlign: 'center' },
});
