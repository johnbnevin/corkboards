import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import type { NostrEvent } from '@nostrify/nostrify';
import { parseEmbeddedRepost, unwrapVerifiedRepost } from '@core/noteCategories';
import { verifyEmbeddedEvent } from '@/lib/embeddedEvent';

function signedNote(content: string, kind = 1): NostrEvent {
  const sk = generateSecretKey();
  return finalizeEvent({ kind, created_at: 1_700_000_000, tags: [], content }, sk) as NostrEvent;
}

describe('parseEmbeddedRepost — shape validation', () => {
  it('rejects non-object / missing fields', () => {
    expect(parseEmbeddedRepost(undefined)).toBeNull();
    expect(parseEmbeddedRepost('not json')).toBeNull();
    expect(parseEmbeddedRepost('{"a":1}')).toBeNull();
    expect(parseEmbeddedRepost('[1,2,3]')).toBeNull();
  });

  it('accepts a fully-formed event shape (without verifying the signature)', () => {
    const ev = signedNote('hello');
    const parsed = parseEmbeddedRepost(JSON.stringify(ev));
    expect(parsed?.id).toBe(ev.id);
  });
});

describe('unwrapVerifiedRepost / verifyEmbeddedEvent — signature enforcement', () => {
  it('returns a genuinely-signed embedded note', () => {
    const inner = signedNote('a real reposted note');
    const out = verifyEmbeddedEvent(JSON.stringify(inner));
    expect(out?.id).toBe(inner.id);
    expect(out?.content).toBe('a real reposted note');
  });

  it('rejects a tampered event whose signature no longer matches (impersonation)', () => {
    const inner = signedNote('original');
    // Keep the valid signature but swap the author + content — the classic forge.
    const forged = { ...inner, pubkey: 'f'.repeat(64), content: 'I did not write this' };
    expect(verifyEmbeddedEvent(JSON.stringify(forged))).toBeNull();
  });

  it('rejects a well-shaped event with a bogus signature', () => {
    const inner = signedNote('original');
    const forged = { ...inner, sig: '0'.repeat(128) };
    expect(verifyEmbeddedEvent(JSON.stringify(forged))).toBeNull();
  });

  it('unwraps a nested repost to the innermost verified note', () => {
    const inner = signedNote('innermost');
    const middle = signedNote(JSON.stringify(inner), 6);
    const outer = signedNote(JSON.stringify(middle), 16);
    const out = verifyEmbeddedEvent(outer.content);
    expect(out?.id).toBe(inner.id);
  });

  it('collapses to null when a nested level is forged', () => {
    const inner = signedNote('innermost');
    const forgedInner = { ...inner, pubkey: 'f'.repeat(64) };
    const middle = signedNote(JSON.stringify(forgedInner), 6);
    expect(verifyEmbeddedEvent(middle.content)).toBeNull();
  });

  it('treats a throwing verifier as "invalid" rather than crashing', () => {
    const inner = signedNote('x');
    const out = unwrapVerifiedRepost(JSON.stringify(inner), () => { throw new Error('boom'); });
    expect(out).toBeNull();
  });
});
