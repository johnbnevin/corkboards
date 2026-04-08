# corkboards.me

A private, uncensorable social feed reader and builder — built on Nostr.

Build social feeds by arranging posts from friends or news sources like notecards on a personalized corkboard. No central server, no algorithm you can't control, no ads, no tracking.

## Features

- **Feed builder** — create corkboards from one friend's posts, a group of friends, or combine news sources into a newspaper-style board
- **Notecards** — posts displayed as tackable notecards on a corkboard
- **Tacking** — tack notecards to keep them pinned at the top of a board
- **Collapsible cards** — collapse notecards to scan feeds faster
- **Multi-column layout** — 1 to 5 columns, responsive across screen sizes
- **Dark and light mode** — automatic system detection or manual toggle
- **Encrypted messaging** — private direct messages (NIP-04 legacy + NIP-17 sealed sender)
- **Lightning zaps** — send payments via Nostr Wallet Connect (NIP-57)
- **Encrypted cloud backup** — AES-256-GCM encrypted settings backup to Blossom servers
- **Multi-account** — switch between accounts with per-user data isolation
- **Cross-platform** — web PWA, desktop (Tauri), mobile (Expo)
- **Uncensorable** — built on Nostr, no central authority

## Architecture

Monorepo with four packages:

| Package | Stack | Role |
|---------|-------|------|
| `packages/core` | Pure TypeScript | Shared Nostr protocol, feed algorithms, storage interface, text utilities. No DOM or React. |
| `packages/web` | React 18 + Vite + Tailwind + shadcn/ui | Web PWA — the primary client |
| `packages/desktop` | Tauri 2 (Rust) + web frontend | Native desktop app with OS keychain for nsec storage |
| `packages/mobile` | React Native + Expo | iOS/Android app with MMKV storage and OS keychain |

### Relay Routing (Outbox Model)

Corkboards implements the NIP-65 outbox model for relay discovery:

```
User → query author's declared relays (NIP-65) + user's own relays → Nostr relays
     → publish to user's write relays + author's cached relays
```

Relay mappings are cached in an LRU map (5000 entries), persisted to IndexedDB, and synced across browser tabs via BroadcastChannel.

### Data Flow

All data is stored locally in IndexedDB (web) or MMKV (mobile). The only external communication is Nostr relay WebSocket connections. There is no central server, no analytics, no telemetry.

## Nostr Protocol Support

| NIP | Description |
|-----|-------------|
| 01 | Basic protocol (events, signatures, relay communication) |
| 02 | Contact list / follows |
| 04 | Encrypted direct messages (legacy) |
| 05 | DNS-based identity verification |
| 10 | Reply threading conventions |
| 17 | Sealed sender direct messages (gift-wrapped) |
| 18 | Reposts |
| 19 | Bech32-encoded entities (npub, note, nevent, nprofile, naddr) |
| 23 | Long-form content (articles) |
| 25 | Reactions |
| 46 | Remote signing / Nostr Connect (QR code login, Amber) |
| 50 | Full-text search (profile discovery) |
| 51 | Lists (bookmarks, mute list) |
| 57 | Lightning zaps |
| 65 | Relay list metadata (outbox model) |
| 71 | Video events |
| 78 | App-specific data (backup metadata) |
| 94 | File metadata (Blossom uploads) |

## Setup

Prerequisites: Node.js 22+, npm 10+

```bash
git clone https://github.com/nickkdev/corkboards.git
cd corkboards
npm install
```

### Web

```bash
npm run dev      # Dev server on port 3000
npm run test     # Full suite: tsc + eslint + vitest + build
npm run build    # Production build
```

### Desktop (Tauri)

Requires Rust toolchain. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
cd packages/desktop/src-tauri
npx @tauri-apps/cli dev      # Dev mode (needs web dev server on port 3000)
npx @tauri-apps/cli build    # Production build
```

### Mobile (Expo)

```bash
cd packages/mobile
npx expo start               # Expo dev client
npx expo run:ios              # iOS simulator
npx expo run:android          # Android emulator
```

## Self-Hosting

The web app is a static PWA — deploy `packages/web/dist/` to any static host. The optional `rss-proxy.php` file proxies RSS feeds to avoid CORS restrictions; deploy it alongside the static files on a PHP-capable server if you want RSS feed support.

All relay URLs are centralized in `packages/web/src/lib/relayConstants.ts` — fork and swap them to point at your preferred relays.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, architecture decisions, and PR guidelines.

## Security

See [SECURITY.md](./SECURITY.md) for the privacy model and vulnerability reporting.

## License

[MIT](./LICENSE)
