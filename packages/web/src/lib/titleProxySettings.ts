/**
 * Web persistence for the user-configured YouTube title proxy template.
 * The active value is set on the core `setTitleProxyTemplate`; blank means
 * titles are off and no request is ever made (see @core/titleProxy).
 */
import { setTitleProxyTemplate } from '@core/titleProxy';

export const TITLE_PROXY_TEMPLATE_KEY = 'corkboard:title-proxy-template';

export function getStoredTitleProxyTemplate(): string {
  try {
    return localStorage.getItem(TITLE_PROXY_TEMPLATE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Persist `template` and activate it for subsequent title lookups. */
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
  setTitleProxyTemplate(trimmed || null);
}
