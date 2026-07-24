/**
 * Image URL optimization utilities.
 * Adds size parameters to known image hosts for faster loading.
 *
 * After host-specific resizing, the URL is run through `applyImageProxy()`
 * (see ./imageProxy.ts) — when the user has configured an image proxy,
 * every avatar and inline image is rewritten to fetch via that proxy,
 * hiding the user's IP from the original host.
 */

import { applyImageProxy } from './imageProxy';
import { isUnsafeHost } from './ipUtils';

const THUMBNAIL_SIZE = 64;
const PREVIEW_SIZE = 400;

/** Returns `url` with `param=size` set, or `url` unchanged if it won't parse. */
function withSizeParam(param: string) {
  return (url: string, size: number): string => {
    try {
      const u = new URL(url);
      u.searchParams.set(param, String(size));
      return u.toString();
    } catch {
      return url;
    }
  };
}

/**
 * Hosts that accept a resize query param, keyed by registrable host. Lookup
 * matches the host itself OR any subdomain of it (see the `.endsWith` below),
 * so `nostr.build` already covers `i.nostr.build` / `image.nostr.build` —
 * listing those separately was dead weight that could drift out of sync.
 */
const KNOWN_THUMBNAIL_HOSTS: Record<string, (url: string, size: number) => string> = {
  'nostr.build': withSizeParam('size'),
  'damus.app': withSizeParam('s'),
};

const GOOGLE_FAVICON_HOSTS = ['www.google.com', 'google.com'];

export function optimizeAvatarUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Reject non-HTTPS avatar URLs and suspicious file extensions
  if (shouldRejectUrl(url, 'avatar')) return undefined;

  let optimized = url;
  try {
    const u = new URL(url);

    for (const [host, optimizer] of Object.entries(KNOWN_THUMBNAIL_HOSTS)) {
      if (u.hostname === host || u.hostname.endsWith('.' + host)) {
        optimized = optimizer(url, THUMBNAIL_SIZE);
        break;
      }
    }

    if (optimized === url && GOOGLE_FAVICON_HOSTS.includes(u.hostname) && u.pathname.includes('/favicons')) {
      u.searchParams.set('sz', String(THUMBNAIL_SIZE));
      optimized = u.toString();
    }
  } catch {
    /* fall through to passthrough */
  }
  return applyImageProxy(optimized);
}

export function optimizeMediaUrl(url: string, isPreview: boolean = false): string {
  const size = isPreview ? PREVIEW_SIZE : THUMBNAIL_SIZE;

  // Reject private/loopback/SSRF-encoded hosts before they reach an <img>/fetch.
  // Without an image proxy configured the raw URL is otherwise loaded directly,
  // letting a malicious note probe internal addresses from the user's browser.
  if (shouldRejectUrl(url, 'media')) return '';

  let optimized = url;
  try {
    const u = new URL(url);

    for (const [host, optimizer] of Object.entries(KNOWN_THUMBNAIL_HOSTS)) {
      if (u.hostname === host || u.hostname.endsWith('.' + host)) {
        optimized = optimizer(url, size);
        break;
      }
    }
  } catch {
    /* fall through to passthrough */
  }
  return applyImageProxy(optimized);
}

export function shouldRejectUrl(url: string, type: 'avatar' | 'media'): boolean {
  try {
    const u = new URL(url);

    const suspiciousExtensions = ['.exe', '.dmg', '.app', '.deb', '.rpm', '.msi'];
    const ext = u.pathname.toLowerCase();
    if (suspiciousExtensions.some(e => ext.endsWith(e))) {
      return true;
    }

    if (type === 'avatar' && u.protocol !== 'https:') {
      return true;
    }

    // Block private/localhost/loopback/link-local hosts (in any IP encoding)
    // to prevent SSRF probing via attacker-supplied image URLs.
    if (isUnsafeHost(u.hostname)) return true;

    // Block credentials in URL
    if (u.username || u.password) return true;

    return false;
  } catch {
    return true;
  }
}

export function getPlaceholderAvatar(pubkey: string): string {
  // Sanitize to hex so a non-hex input can never inject markup into the inline SVG.
  const hex = (pubkey || '').replace(/[^0-9a-fA-F]/g, '');
  const hue = hex.length >= 8 ? parseInt(hex.slice(0, 8), 16) % 360 : 0;
  const initials = (hex.slice(0, 2) || '??').toUpperCase();
  return `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect fill="hsl(${hue}, 70%, 60%)" width="64" height="64"/>
      <text x="32" y="40" font-family="sans-serif" font-size="24" fill="white" text-anchor="middle">
        ${initials}
      </text>
    </svg>
  `)}`;
}
