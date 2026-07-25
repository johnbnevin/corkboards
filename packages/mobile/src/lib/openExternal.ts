/**
 * Guarded wrapper around React Native's `Linking.openURL`.
 *
 * `Linking.openURL` hands the string to the OS, which will launch ANY scheme it
 * has a handler for. Note content and kind-0 profile fields are attacker-
 * controlled, so an unguarded call lets a note fire `intent://` (arbitrary
 * Android activity), `market://`, `tel:`/`sms:`, `file:`, or a private scheme
 * belonging to another installed app — from a tap on something that renders as
 * an ordinary link. The web build has always scheme-checked its link sinks;
 * most of the mobile call sites did not.
 *
 * Use this for anything derived from a note, a profile, or a relay. Hardcoded
 * app URLs (help pages, the download site) don't need it, but calling it costs
 * nothing and keeps the rule simple: no bare `Linking.openURL` on this codebase.
 */
import { Linking } from 'react-native';
import { isSafeExternalUrl } from '@core/sanitizeUtils';
import { toLightningUri } from '@core/lightningTarget';
import { debugWarn } from './debug';

/**
 * Open `url` externally when it is http(s). Returns true when the open was
 * attempted. Silently refuses anything else — a blocked link should look inert,
 * not pop an error the note's author controls the text of.
 */
export function openExternal(url: string | null | undefined): boolean {
  if (!isSafeExternalUrl(url)) {
    debugWarn('[openExternal] refused non-http(s) URL:', url);
    return false;
  }
  Linking.openURL(url!.trim()).catch((err) => {
    debugWarn('[openExternal] failed to open:', err);
  });
  return true;
}

/**
 * Hand a BOLT-11 invoice to whichever wallet app the OS has registered for
 * `lightning:`. Returns true when the open was attempted.
 *
 * The one deliberate exception to the http(s)-only rule above, and narrow on
 * purpose: `toLightningUri` returns null for anything that isn't a real
 * invoice, so this can't be turned into a generic scheme launcher by feeding it
 * note content. Invoices reaching it are ones this app just requested from an
 * already-SSRF-checked LNURL endpoint.
 */
export function openLightningInvoice(invoice: string | null | undefined): boolean {
  const uri = toLightningUri(invoice);
  if (!uri) {
    debugWarn('[openLightningInvoice] refused non-invoice payload');
    return false;
  }
  Linking.openURL(uri).catch((err) => {
    // No wallet app installed is the common case here, not an error worth a
    // dialog — the QR code beside the button is the fallback.
    debugWarn('[openLightningInvoice] no handler:', err);
  });
  return true;
}
