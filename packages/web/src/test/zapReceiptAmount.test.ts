import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { getZapReceiptAmountSats } from '@core/lightningTarget';

function receipt(tags: string[][]): NostrEvent {
  return { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: 0, kind: 9735, tags, content: '', sig: '' };
}

describe('getZapReceiptAmountSats', () => {
  it('reads the millisat amount tag', () => {
    expect(getZapReceiptAmountSats(receipt([['amount', '21000']]))).toBe(21);
  });

  it('reads the amount from the embedded zap request description', () => {
    const desc = JSON.stringify({ kind: 9734, tags: [['amount', '5000']] });
    expect(getZapReceiptAmountSats(receipt([['description', desc]]))).toBe(5);
  });

  it('falls back to the bolt11 invoice amount (100 sats = 1u)', () => {
    // lnbc1u… encodes 1 microBTC = 100 sats.
    expect(getZapReceiptAmountSats(receipt([['bolt11', 'lnbc1u1pabcdef']]))).toBe(100);
  });

  it('returns null (never NaN) for a malformed amount tag', () => {
    const out = getZapReceiptAmountSats(receipt([['amount', 'not-a-number']]));
    expect(out).toBeNull();
  });

  it('returns null for a non-receipt kind', () => {
    expect(getZapReceiptAmountSats({ ...receipt([['amount', '1000']]), kind: 1 })).toBeNull();
  });

  it('does not trust a forged whole-BTC-looking bolt11 as tiny (no 1e8 drop)', () => {
    // lnbc1m… = 1 milliBTC = 100_000 sats — the old EngagementBar parser returned
    // this correctly but its no-unit branch returned the raw number (÷1e8 error).
    expect(getZapReceiptAmountSats(receipt([['bolt11', 'lnbc1m1pxyz']]))).toBe(100_000);
  });
});
