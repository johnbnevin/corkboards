import { describe, it, expect } from 'vitest';
import { isImageUrl, isCdnHost } from '@/lib/mediaUtils';

describe('media host matching — exact-or-subdomain, never substring', () => {
  it('accepts known hosts and their subdomains', () => {
    expect(isImageUrl('https://nostr.build/abc')).toBe(true);
    expect(isImageUrl('https://i.nostr.build/abc')).toBe(true);
    expect(isCdnHost('https://cdn.satellite.earth/x')).toBe(true);
    expect(isCdnHost('https://files.primal.net/x')).toBe(true);
  });

  it('rejects look-alike hosts that merely contain a trusted name', () => {
    // These all *contain* "nostr.build" / "void.cat" as a substring but are
    // attacker-controlled hosts — the old .includes() check auto-loaded them.
    expect(isImageUrl('https://evil-nostr.build/x')).toBe(false);
    expect(isImageUrl('https://nostr.build.attacker.net/x')).toBe(false);
    expect(isCdnHost('https://void.cat.attacker.net/x')).toBe(false);
    expect(isCdnHost('https://notblossom.evil.com/x')).toBe(false);
  });

  it('still classifies by extension regardless of host', () => {
    expect(isImageUrl('https://whatever.example/pic.jpg')).toBe(true);
    expect(isImageUrl('https://whatever.example/clip.mp4')).toBe(false);
  });
});
