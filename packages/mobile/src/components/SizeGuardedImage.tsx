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

// HEAD-based size cache
const sizeCache = new Map<string, number | null>();
const pendingChecks = new Map<string, Promise<number | null>>();

async function checkSize(url: string): Promise<number | null> {
  if (sizeCache.has(url)) return sizeCache.get(url)!;
  if (pendingChecks.has(url)) return pendingChecks.get(url)!;

  const promise = (async () => {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      const cl = res.headers.get('content-length');
      const size = cl ? parseInt(cl, 10) : null;
      sizeCache.set(url, size);
      return size;
    } catch {
      sizeCache.set(url, null);
      return null;
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
  const [status, setStatus] = useState<'checking' | 'allowed' | 'blocked' | 'override'>('checking');
  const [fileSize, setFileSize] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (limitBytes === 0) { setStatus('allowed'); return; }
    if (sizeCache.has(uri)) {
      const cached = sizeCache.get(uri)!;
      setFileSize(cached);
      setStatus(cached !== null && cached > limitBytes ? 'blocked' : 'allowed');
      return;
    }
    setStatus('checking');
    checkSize(uri).then(size => {
      if (!mountedRef.current) return;
      setFileSize(size);
      setStatus(size !== null && size > limitBytes ? 'blocked' : 'allowed');
    });
  }, [uri, limitBytes]);

  if (status === 'checking' || status === 'allowed' || status === 'override') {
    return <Image source={{ uri }} style={style} resizeMode={resizeMode} />;
  }

  // Blocked
  if (type === 'avatar') {
    return (
      <TouchableOpacity onPress={() => setStatus('override')}>
        <View style={[style as object, localStyles.avatarPlaceholder]}>
          <Text style={localStyles.avatarX}>X</Text>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity style={localStyles.blockedContainer} onPress={() => setStatus('override')}>
      <Text style={localStyles.blockedText}>
        Image too large ({fileSize ? formatBytes(fileSize) : '?'}) — tap to load
      </Text>
    </TouchableOpacity>
  );
}

const localStyles = StyleSheet.create({
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
