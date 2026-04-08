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
- **RSS proxy** — if you self-host `rss-proxy.php`, the proxy server can see which RSS feed URLs are being fetched. The proxy does not log by default.
- **Relay metadata** — your IP address is visible to relay operators via the WebSocket connection. Use a VPN or Tor if IP privacy is important to you.

## Security Implementation

For details on the HTML sanitization strategy, content security policy, and XSS prevention, see [SECURITY_IMPLEMENTATION.md](./SECURITY_IMPLEMENTATION.md).
