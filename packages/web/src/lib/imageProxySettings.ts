/**
 * Web persistence for the user-configured image proxy template.
 * The active value is set on the core `setImageProxyTemplate` so all
 * `optimizeMediaUrl`/`optimizeAvatarUrl` callers see the rewrite.
 */
import { setImageProxyTemplate } from '@core/imageProxy';
import { idbSetSync, idbRemoveSync } from '@/lib/idb';

export const IMAGE_PROXY_TEMPLATE_KEY = 'corkboard:image-proxy-template';

export function getImageProxyTemplate(): string {
  try {
    return localStorage.getItem(IMAGE_PROXY_TEMPLATE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Persist `template` and activate it for subsequent image renders.
 *
 * Dual-write: localStorage is the fast boot source (read in main.tsx before
 * the idb cache is loaded); the idb mirror is what the encrypted backup
 * snapshot reads, so the preference follows the account to other devices.
 */
export function saveImageProxyTemplate(template: string): void {
  const trimmed = template.trim();
  try {
    if (trimmed.length === 0) {
      localStorage.removeItem(IMAGE_PROXY_TEMPLATE_KEY);
    } else {
      localStorage.setItem(IMAGE_PROXY_TEMPLATE_KEY, trimmed);
    }
  } catch {
    /* ignore storage failures — runtime state still updates below */
  }
  try {
    if (trimmed.length === 0) idbRemoveSync(IMAGE_PROXY_TEMPLATE_KEY);
    else idbSetSync(IMAGE_PROXY_TEMPLATE_KEY, trimmed);
  } catch { /* backup mirror is best-effort */ }
  setImageProxyTemplate(trimmed || null);
}
