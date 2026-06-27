/**
 * Re-export of the shared kind-3 contact-list safety helpers so existing
 * mobile imports (`../lib/contactList`) keep working. The real implementation —
 * shared verbatim with web — lives in @core/contactList.
 */
export {
  fetchAuthoritativeContactEvent,
  resolveContactBase,
  contactPubkeys,
  applyContactChange,
  type ContactBase,
  type ContactPool,
} from '@core/contactList';
