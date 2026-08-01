# Security Policy

## Supported Versions

Only the current `main` branch is supported with security fixes.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Report vulnerabilities via encrypted Nostr DM to the maintainer:
- npub: `npub1v89nr2zax8ef0ceyu9te0sjyqv3newa3e82m0rd4kye3ekeyhv2sqf30cc`

Or via email if you prefer. Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

We follow a 90-day disclosure timeline. You will receive acknowledgment within 48 hours and a fix timeline within 7 days.

## Privacy Model

Corkboards is designed with privacy as a core value:

- **No central server** — the app is a static PWA. All user data is stored locally in IndexedDB (web), MMKV (mobile), or OS keychain (desktop). There is no backend, no database, no analytics, no telemetry.
- **External communication** — the only network traffic is Nostr relay WebSocket connections (`wss://`). The app enforces WSS-only (no plaintext `ws://`).
- **Relay operators** can see event metadata (timestamps, pubkeys, event IDs, relay URLs) and the content of standard posts (kind 1). They **cannot** see:
  - NIP-17 sealed DM content (gift-wrapped, end-to-end encrypted)
  - Encrypted backup content (AES-256-GCM)
- **Content sanitization** — all rendered HTML is processed through DOMPurify with a strict allowlist. Script tags, event handlers, iframes, and inline styles are blocked.

## Known Limitations

These are inherent to the protocols used, not bugs:

- **NIP-04 DMs** — content is encrypted, but metadata (who is messaging whom, timestamps) is visible to relay operators. NIP-17 sealed DMs solve this, but NIP-04 is still supported for backwards compatibility.
- **Browser extensions** with access to `window.nostr` can read the user's pubkey and sign events on their behalf. This is by design (NIP-07) but means you should only install trusted Nostr signing extensions.
- **RSS proxy** — if you self-host `rss-proxy.php`, the proxy server can see which RSS feed URLs are being fetched. The proxy does not log by default — its only persisted state is a rate-limit counter keyed by an MD5 of the client IP, pruned within about an hour — but the web server *in front of* it (Apache/nginx at the hosting provider) keeps standard access logs. Those logs record the client IP and the full request line including query strings, and typical retention is days (DreamHost, corkboards.me's host, retains them ~7 days). RSS fetches use GET, so the feed URL appears there.
- **YouTube title proxy (`youtube-proxy.php`)** — lookups are sent in the POST request body, which standard access logs never record: the host's logs show only that an IP called the endpoint, never which video. The proxy code itself logs and stores nothing about lookups. YouTube/Google sees the proxy server's IP, never the user's.
- **Relay metadata** — your IP address is visible to relay operators via the WebSocket connection. Use a VPN or Tor if IP privacy is important to you.

### Deliberate fail-open trade-offs (audited 2026-08)

An audit for Coldcard-style flaws (failures silently choosing a weaker fallback) closed several fail-opens — the desktop proxy kill-switch now covers every publish path and treats an unreadable proxy config as "assume required"; key-at-rest failures warn loudly instead of logging to the console; auto-restore integrity checks are symmetric — and left these as documented, deliberate trade-offs:

- **rss-proxy.php rate limiter fails open** when its lock file can't be taken: the request proceeds unmetered. Availability-only — no privacy consequence for clients.
- **Requests with no `Origin` header are allowed** on rss-proxy.php / youtube-proxy.php — required, because the mobile and desktop apps send no browser Origin. Cross-site browser abuse is still blocked (exact-match allowlist), and the SSRF gate bounds what the endpoint will fetch.
- **`open_external` (desktop) hands URLs to the system browser**, which is outside any configured proxy. With "Require proxy" on, clicking an external link deanonymizes via the browser — the settings copy says so; there is no way to proxy another application's traffic from inside this one.
- **Web `localStorage`/IndexedDB are unencrypted at rest** by platform nature. The nsec itself is additionally encrypted (non-extractable AES-GCM CryptoKey); when that encryption is unavailable the app now warns loudly rather than failing silently.
- **`keychainHasKey` reports "present" on an IPC error** — this suppresses a scary "your signing key is gone" warning on transient hiccups; the failure mode is a visible signing error, not a security downgrade.
- **Dev builds under remote JS debugging have a `Math.random()`-backed RNG** (React Native platform behavior). The app refuses to generate identity keys in that state; release builds are unaffected.

## Security Implementation

For details on the HTML sanitization strategy, content security policy, and XSS prevention, see [SECURITY_IMPLEMENTATION.md](./SECURITY_IMPLEMENTATION.md).
