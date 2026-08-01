/**
 * Web persistence for the user-configured YouTube title proxy template.
 * The active value is set on the core `setTitleProxyTemplate`; blank means
 * titles are off and no request is ever made (see @core/titleProxy).
 */
import { setTitleProxyTemplate } from '@core/titleProxy';
import { idbSetSync, idbRemoveSync } from '@/lib/idb';

export const TITLE_PROXY_TEMPLATE_KEY = 'corkboard:title-proxy-template';

export function getStoredTitleProxyTemplate(): string {
  try {
    return localStorage.getItem(TITLE_PROXY_TEMPLATE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Persist `template` and activate it for subsequent title lookups.
 *
 * Dual-write: localStorage is the fast boot source (read in main.tsx before
 * the idb cache is loaded); the idb mirror is what the encrypted backup
 * snapshot reads, so the preference follows the account to other devices.
 */
export function saveTitleProxyTemplate(template: string): void {
  const trimmed = template.trim();
  try {
    if (trimmed.length === 0) {
      localStorage.removeItem(TITLE_PROXY_TEMPLATE_KEY);
    } else {
      localStorage.setItem(TITLE_PROXY_TEMPLATE_KEY, trimmed);
    }
  } catch {
    /* ignore storage failures — runtime state still updates below */
  }
  try {
    if (trimmed.length === 0) idbRemoveSync(TITLE_PROXY_TEMPLATE_KEY);
    else idbSetSync(TITLE_PROXY_TEMPLATE_KEY, trimmed);
  } catch { /* backup mirror is best-effort */ }
  setTitleProxyTemplate(trimmed || null);
}
