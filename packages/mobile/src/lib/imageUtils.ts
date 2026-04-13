/**
 * Image URL optimization utilities.
 * Adds size parameters to known image hosts for faster loading.
 */

const THUMBNAIL_SIZE = 64;
const PREVIEW_SIZE = 400;

const KNOWN_THUMBNAIL_HOSTS: Record<string, (url: string, size: number) => string> = {
  'nostr.build': (url, size) => {
    try {
      const u = new URL(url);
      u.searchParams.set('size', String(size));
      return u.toString();
    } catch {
      return url;
    }
  },
  'damus.app': (url, size) => {
    try {
      const u = new URL(url);
      u.searchParams.set('s', String(size));
      return u.toString();
    } catch {
      return url;
    }
  },
  'image.nostr.build': (url, size) => {
    try {
      const u = new URL(url);
      u.searchParams.set('size', String(size));
      return u.toString();
    } catch {
      return url;
    }
  },
  'i.nostr.build': (url, size) => {
    try {
      const u = new URL(url);
      u.searchParams.set('size', String(size));
      return u.toString();
    } catch {
      return url;
    }
  },
};

const GOOGLE_FAVICON_HOSTS = ['www.google.com', 'google.com'];

export function optimizeAvatarUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Reject non-HTTPS avatar URLs and suspicious file extensions
  if (shouldRejectUrl(url, 'avatar')) return undefined;

  try {
    const u = new URL(url);

    for (const [host, optimizer] of Object.entries(KNOWN_THUMBNAIL_HOSTS)) {
      if (u.hostname.endsWith(host)) {
        return optimizer(url, THUMBNAIL_SIZE);
      }
    }

    if (GOOGLE_FAVICON_HOSTS.includes(u.hostname) && u.pathname.includes('/favicons')) {
      u.searchParams.set('sz', String(THUMBNAIL_SIZE));
      return u.toString();
    }

    return url;
  } catch {
    return url;
  }
}

export function optimizeMediaUrl(url: string, isPreview: boolean = false): string {
  const size = isPreview ? PREVIEW_SIZE : THUMBNAIL_SIZE;

  try {
    const u = new URL(url);

    for (const [host, optimizer] of Object.entries(KNOWN_THUMBNAIL_HOSTS)) {
      if (u.hostname.endsWith(host)) {
        return optimizer(url, size);
      }
    }

    return url;
  } catch {
    return url;
  }
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

    return false;
  } catch {
    return true;
  }
}

export function getPlaceholderAvatar(pubkey: string): string {
  const hue = (parseInt(pubkey.slice(0, 8), 16) % 360);
  return `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect fill="hsl(${hue}, 70%, 60%)" width="64" height="64"/>
      <text x="32" y="40" font-family="sans-serif" font-size="24" fill="white" text-anchor="middle">
        ${pubkey.slice(0, 2).toUpperCase()}
      </text>
    </svg>
  `)}`;
}
