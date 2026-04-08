import { formatTimeAgo } from '@core/formatTimeAgo';
import { FEED_KINDS, NOTES_MOBILE } from '@core/feedConstants';
import { getConversationPartner } from '@core/dmUtils';

describe('core imports', () => {
  it('formatTimeAgo returns a string for recent timestamps', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(typeof formatTimeAgo(now)).toBe('string');
  });

  it('feedConstants are defined', () => {
    expect(FEED_KINDS).toBeDefined();
    expect(FEED_KINDS.length).toBeGreaterThan(0);
    expect(NOTES_MOBILE).toBeGreaterThan(0);
  });

  it('getConversationPartner returns partner pubkey', () => {
    const userPubkey = 'a'.repeat(64);
    const partnerPubkey = 'b'.repeat(64);
    const event = {
      id: '1',
      kind: 4,
      pubkey: userPubkey,
      content: 'test',
      created_at: 0,
      tags: [['p', partnerPubkey]],
      sig: '',
    };
    expect(getConversationPartner(event, userPubkey)).toBe(partnerPubkey);
  });
});
