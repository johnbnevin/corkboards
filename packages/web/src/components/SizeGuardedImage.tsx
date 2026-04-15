/**
 * SizeGuardedImage — blocks images whose file size exceeds the user's limit.
 *
 * Does a HEAD request (cached) to get Content-Length. If over the limit,
 * shows a placeholder with the file size and a "Load anyway" button.
 * If the server doesn't return Content-Length, the image loads normally.
 */

import React, { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useImageSizeLimit } from '@/hooks/useImageSizeLimit';
import { supportsCorsHead, learnCorsHost } from '@/lib/mediaUtils';
import { ImageOff } from 'lucide-react';

// ─── HEAD-based size cache ──────────────────────────────────────────────────

interface SizeCheckResult { size: number | null; isVideo: boolean }
const MAX_SIZE_CACHE = 2000;
const sizeCache = new Map<string, SizeCheckResult>();
const pendingChecks = new Map<string, Promise<SizeCheckResult>>();
/** Hosts where HEAD requests fail (CORS) — skip future checks for any URL on these hosts */
const corsBlockedHosts = new Set<string>();

function getHost(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/** Sentinel size value: host not whitelisted, size unknown */
const SIZE_UNKNOWN = -1;

async function checkImageSize(url: string): Promise<SizeCheckResult> {
  if (sizeCache.has(url)) return sizeCache.get(url)!;

  // Skip HEAD for hosts not on the CORS whitelist
  if (!supportsCorsHead(url)) {
    const result: SizeCheckResult = { size: SIZE_UNKNOWN, isVideo: false };
    sizeCache.set(url, result);
    return result;
  }

  if (pendingChecks.has(url)) return pendingChecks.get(url)!;

  const host = getHost(url);
  const promise = (async () => {
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
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
      // Learn: this host supports CORS HEAD
      if (host) learnCorsHost(host);
      return result;
    } catch {
      // Remember this host blocks CORS so we don't flood it with failed requests
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

// ─── Component ──────────────────────────────────────────────────────────────

interface SizeGuardedImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  /** The image URL to check */
  src: string;
  /** Compact mode for avatars (smaller placeholder) */
  compact?: boolean;
}

export function SizeGuardedImage({ src, compact = false, className, alt, ...imgProps }: SizeGuardedImageProps) {
  const limitBytes = useImageSizeLimit();
  const [status, setStatus] = useState<'checking' | 'allowed' | 'blocked' | 'unknown' | 'override'>('checking');
  const [fileSize, setFileSize] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const resolve = (result: SizeCheckResult) => {
      if (result.size === SIZE_UNKNOWN) return 'unknown' as const;
      if (!result.isVideo && result.size !== null && result.size > limitBytes) return 'blocked' as const;
      return 'allowed' as const;
    };

    if (limitBytes === 0) {
      setStatus('allowed');
      return;
    }

    // Check cache first (sync)
    if (sizeCache.has(src)) {
      const cached = sizeCache.get(src)!;
      setFileSize(cached.size === SIZE_UNKNOWN ? null : cached.size);
      setStatus(resolve(cached));
      return;
    }

    setStatus('checking');
    checkImageSize(src).then(result => {
      if (!mountedRef.current) return;
      setFileSize(result.size === SIZE_UNKNOWN ? null : result.size);
      setStatus(resolve(result));
    });
  }, [src, limitBytes]);

  if (status === 'checking') {
    // Show placeholder while HEAD request checks size — do NOT render <img>
    // because the browser would start downloading the full image immediately.
    return (
      <div className={cn('bg-muted/20 rounded animate-pulse', className)} style={{ minHeight: 48 }} />
    );
  }

  if (status === 'blocked' || status === 'unknown') {
    const label = status === 'unknown' ? 'Unknown size' : `Image too large (${fileSize ? formatBytes(fileSize) : '?'})`;
    if (compact) {
      return (
        <span
          className="inline-flex items-center justify-center bg-muted/50 rounded text-muted-foreground cursor-pointer hover:bg-muted/80 transition-colors"
          style={{ width: imgProps.width || 32, height: imgProps.height || 32 }}
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); setStatus('override') }}
          title={`${label} (click to load)`}
          role="button"
          aria-label={`Load image (${label})`}
        >
          <ImageOff className="h-3 w-3" />
        </span>
      );
    }

    return (
      <div className="flex items-center gap-2 p-3 bg-muted/30 rounded-lg border border-dashed border-muted-foreground/20 my-1 text-xs text-muted-foreground">
        <ImageOff className="h-4 w-4 shrink-0" />
        <span>{label}</span>
        <button
          className="text-primary hover:underline shrink-0"
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); setStatus('override') }}
        >
          Load anyway
        </button>
      </div>
    );
  }

  // allowed or override
  return <img src={src} alt={alt} className={className} referrerPolicy="no-referrer" {...imgProps} />;
}
