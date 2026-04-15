/**
 * SizeGuardedImage — blocks images whose file size exceeds the user's limit.
 *
 * React Native version: does a HEAD request (cached) to check Content-Length.
 * Shows a placeholder when over the limit, with a tap-to-load option.
 */

import { useState, useEffect, useRef } from 'react';
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
}

export function SizeGuardedImage({ uri, style, type = 'image', resizeMode = 'cover' }: SizeGuardedImageProps) {
  const limitBytes = getLimitBytes(type);
  const [status, setStatus] = useState<'checking' | 'allowed' | 'blocked' | 'unknown' | 'override'>('checking');
  const [fileSize, setFileSize] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const resolveStatus = (result: SizeCheckResult) => {
    if (result.size === SIZE_UNKNOWN) return 'unknown' as const;
    if (!result.isVideo && result.size !== null && result.size > limitBytes) return 'blocked' as const;
    return 'allowed' as const;
  };

  useEffect(() => {
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

  if (status === 'checking') {
    // Show placeholder while HEAD request checks size — don't render <Image>
    // because React Native would start downloading the full image immediately.
    return <View style={[style as object, localStyles.checkingPlaceholder]} />;
  }

  if (status === 'allowed' || status === 'override') {
    return <Image source={{ uri }} style={style} resizeMode={resizeMode} />;
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
