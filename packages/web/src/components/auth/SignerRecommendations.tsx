/**
 * Platform-specific signer/extension recommendations for Nostr login.
 * Single source of truth used across all login and security info flows.
 */

interface SignerRec {
  name: string;
  note: string;
  url?: string;
}

const MOBILE_SIGNERS: Record<string, SignerRec[]> = {
  iPhone: [
    { name: 'Alby Go', note: 'Nostr signer and Lightning wallet', url: 'https://apps.apple.com/us/app/alby-go/id6471335774' },
    { name: 'Nostur', note: 'Full Nostr client with built-in key management', url: 'https://apps.apple.com/us/app/nostur-nostr-client/id1672780508' },
  ],
  Android: [
    { name: 'Amber', note: 'Dedicated signer app — keys never leave the device (recommended)', url: 'https://play.google.com/store/apps/details?id=com.greenart7c3.nostrsigner' },
    { name: 'Amethyst', note: 'Full Nostr client with built-in key management', url: 'https://play.google.com/store/apps/details?id=com.vitorpamplona.amethyst' },
  ],
};

const BROWSER_SIGNERS: Record<string, SignerRec[]> = {
  Chrome: [
    { name: 'Soapbox Signer', note: 'Simple, fast NIP-07 signer', url: 'https://chromewebstore.google.com/detail/soapbox-signer/bcoopbammbdnfkbalnfaljhdhhmajnoo' },
    { name: 'nostr-keyx', note: 'Uses OS keychain or YubiKey', url: 'https://github.com/nicol-ograve/nicol-ograve.github.io/releases/tag/nostr-keyx-v1.0.4' },
  ],
  Firefox: [
    { name: 'Soapbox Signer', note: 'Simple, fast NIP-07 signer', url: 'https://addons.mozilla.org/en-US/firefox/addon/soapbox-signer/' },
  ],
  Brave: [
    { name: 'Soapbox Signer', note: 'Chrome extensions work in Brave', url: 'https://chromewebstore.google.com/detail/soapbox-signer/bcoopbammbdnfkbalnfaljhdhhmajnoo' },
    { name: 'nostr-keyx', note: 'Uses OS keychain or YubiKey', url: 'https://github.com/nicol-ograve/nicol-ograve.github.io/releases/tag/nostr-keyx-v1.0.4' },
  ],
  Edge: [
    { name: 'nostr-keyx', note: 'Uses OS keychain or YubiKey', url: 'https://github.com/nicol-ograve/nicol-ograve.github.io/releases/tag/nostr-keyx-v1.0.4' },
  ],
  Opera: [
    { name: 'nostr-keyx', note: 'Uses OS keychain or YubiKey', url: 'https://github.com/nicol-ograve/nicol-ograve.github.io/releases/tag/nostr-keyx-v1.0.4' },
  ],
  Safari: [
    { name: 'Alby Go', note: 'Nostr signer and Lightning wallet', url: 'https://apps.apple.com/us/app/alby-go/id6471335774' },
  ],
};

function detectPlatform(): { isMobile: boolean; platform: string } {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return { isMobile: true, platform: 'iPhone' };
  if (/Android/.test(ua)) return { isMobile: true, platform: 'Android' };
  if (/Firefox/.test(ua)) return { isMobile: false, platform: 'Firefox' };
  if (/Edg\//.test(ua)) return { isMobile: false, platform: 'Edge' };
  if (/OPR\//.test(ua)) return { isMobile: false, platform: 'Opera' };
  if (/Brave/.test(ua)) return { isMobile: false, platform: 'Brave' };
  if (/Safari/.test(ua) && !/Chrome/.test(ua)) return { isMobile: false, platform: 'Safari' };
  if (/Chrome/.test(ua)) return { isMobile: false, platform: 'Chrome' };
  return { isMobile: false, platform: 'Chrome' };
}

// eslint-disable-next-line react-refresh/only-export-components
export { detectPlatform };

/** Get a short platform-aware recommendation string for error messages. */
// eslint-disable-next-line react-refresh/only-export-components
export function getSignerRecommendation(): string {
  const { isMobile, platform } = detectPlatform();
  if (isMobile) {
    const signers = MOBILE_SIGNERS[platform];
    if (signers) {
      return `No Nostr signer found. On ${platform}, try ${signers.map(s => s.name).join(' or ')}.`;
    }
  }
  const signers = BROWSER_SIGNERS[platform];
  if (signers) {
    return `No Nostr extension found. For ${platform}, install ${signers.map(s => s.name).join(' or ')}.`;
  }
  return 'No Nostr extension found. Install a NIP-07 browser extension like Soapbox Signer.';
}

/** Get the top signer recommendation for the current platform with install link. */
// eslint-disable-next-line react-refresh/only-export-components
export function getTopSignerForPlatform(): { name: string; url?: string; isMobile: boolean; platform: string } {
  const { isMobile, platform } = detectPlatform();
  if (isMobile) {
    const signers = MOBILE_SIGNERS[platform];
    if (signers?.[0]) return { ...signers[0], isMobile, platform };
  }
  const signers = BROWSER_SIGNERS[platform];
  if (signers?.[0]) return { ...signers[0], isMobile, platform };
  return { name: 'Soapbox Signer', url: 'https://chromewebstore.google.com/detail/soapbox-signer/bcoopbammbdnfkbalnfaljhdhhmajnoo', isMobile, platform };
}

/**
 * Inline component showing platform-specific signer recommendations.
 * Highlights the user's detected platform.
 */
export function SignerRecommendations({ variant: _variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const { isMobile, platform } = detectPlatform();

  const Section = ({ title, items, highlight }: { title: string; items: Record<string, SignerRec[]>; highlight?: string }) => (
    <div className="space-y-1">
      <p className="font-medium text-foreground text-xs">{title}</p>
      <div className="space-y-0.5">
        {Object.entries(items).map(([plat, signers]) => (
          <div key={plat} className={plat === highlight ? 'font-medium' : 'text-muted-foreground'}>
            <span className="text-xs">
              {plat === highlight && '\u2192 '}<strong>{plat}:</strong>{' '}
              {signers.map((s, i) => (
                <span key={s.name}>
                  {i > 0 && ', '}
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">{s.name}</a>
                  ) : s.name}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-2 text-xs">
      <Section title="Mobile" items={MOBILE_SIGNERS} highlight={isMobile ? platform : undefined} />
      <Section title="Desktop browsers" items={BROWSER_SIGNERS} highlight={!isMobile ? platform : undefined} />
    </div>
  );
}
