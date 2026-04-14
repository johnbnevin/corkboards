# corkboards.me

A private, uncensorable social feed reader and builder — built on Nostr.

Build social feeds by arranging posts from friends or news sources like notecards on a personalized corkboard. No central server, no algorithm you can't control, no ads, no tracking.

## Install

### Use the web app (easiest)

Go to [corkboards.me](https://corkboards.me) in any modern browser. That's it — nothing to install.

### <a id="desktop"></a>Build the desktop app (Windows, macOS, or Linux)

The desktop app gives you a native window with OS keychain storage for your keys. You build it from source — it takes about 5 minutes the first time.

**Step 1 — Install the prerequisites**

You need two things installed on your computer: **Node.js** and **Rust**. If you already have them, skip to Step 2.

- **Node.js 22+** — Download from [nodejs.org](https://nodejs.org/). Pick the LTS version. The installer does everything for you. When it's done, open a terminal and type `node -v` to confirm it worked.
- **Rust** — Follow the instructions for your OS at [tauri.app/start/prerequisites](https://v2.tauri.app/start/prerequisites/). This page walks you through installing Rust and the system libraries Tauri needs. On macOS you'll need Xcode command line tools. On Windows you'll need Visual Studio Build Tools. On Linux you'll need a few packages via apt.

**Step 2 — Download the source code**

Open a terminal (Terminal on macOS/Linux, PowerShell on Windows) and run:

```bash
git clone https://github.com/johnbnevin/corkboards.git
cd corkboards
npm install
```

If you don't have `git`, you can also download the source as a zip from [the GitHub page](https://github.com/johnbnevin/corkboards) — click the green "Code" button, then "Download ZIP". Unzip it, open a terminal in that folder, and run `npm install`.

**Step 3 — Build it**

```bash
cd packages/desktop/src-tauri
npx @tauri-apps/cli build
```

This takes a few minutes the first time (Rust compiles everything from scratch). When it's done, you'll have a native installer in the `target/release/bundle/` folder:

- **Windows** — `.msi` installer and `.exe` in `target/release/bundle/msi/`
- **macOS** — `.dmg` disk image in `target/release/bundle/dmg/`
- **Linux** — `.AppImage` and `.deb` in `target/release/bundle/appimage/` and `target/release/bundle/deb/`

Double-click the installer to install it like any other app.

### Build the mobile app (Android)

The mobile app is in testing. You'll need the [Expo](https://expo.dev/) development environment set up.

```bash
cd packages/mobile
npm install
npx expo run:android
```

## Features

- **Feed builder** — create corkboards from one friend's posts, a group of friends, or combine news sources into a newspaper-style board
- **Notecards** — posts displayed as tackable notecards on a corkboard
- **Tacking** — tack notecards to keep them pinned at the top of a board
- **Collapsible cards** — collapse notecards to scan feeds faster
- **Multi-column layout** — 1 to 5 columns, responsive across screen sizes
- **Dark and light mode** — automatic system detection or manual toggle
- **Lightning zaps** — send payments via Nostr Wallet Connect (NIP-57)
- **Encrypted blossom backup** — AES-256-GCM encrypted settings backup to Blossom servers
- **Multi-account** — switch between accounts with per-user data isolation
- **Cross-platform** — web PWA, desktop (Tauri), mobile (Expo)
- **Censorship resistant** — built on Nostr, no central authority

## Development

### Running locally

```bash
npm run dev      # Web dev server on port 3000
npm run test     # Full suite: tsc + eslint + vitest + build
npm run build    # Production build
```

Desktop dev mode (run the web dev server first, then in another terminal):

```bash
cd packages/desktop/src-tauri
npx @tauri-apps/cli dev
```

### Architecture

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
| 05 | DNS-based identity verification |
| 10 | Reply threading conventions |
| 17 | Sealed sender direct messages (gift-wrapped) | Not implemented
| 18 | Reposts |
| 19 | Bech32-encoded entities (npub, note, nevent, nprofile, naddr) |
| 23 | Long-form content (articles) |
| 25 | Reactions |
| 46 | Remote signing / Nostr Connect (QR code login, Amber) |
| 50 | Full-text search (profile discovery) | Not implemented
| 51 | Lists (bookmarks, mute list) | Importable into private custom corkboards
| 57 | Lightning zaps |
| 65 | Relay list metadata (outbox model) |
| 71 | Video events |
| 78 | App-specific data (backup metadata) |
| 94 | File metadata (Blossom uploads) |

## RSS Protocol Support

Optional hostable RSS proxy allows feeds to include RSS sources chronologically with Nostr notes.

## Self-Hosting

The web app is a static PWA — deploy `packages/web/dist/` to any static host. The optional `rss-proxy.php` file proxies RSS feeds to avoid CORS restrictions; deploy it alongside the static files on a PHP-capable server if you want RSS feed support.

All relay URLs are centralized in `packages/web/src/lib/relayConstants.ts` — fork and swap them to point at your preferred relays.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, architecture decisions, and PR guidelines.

## Security

See [SECURITY.md](./SECURITY.md) for the privacy model and vulnerability reporting.

## License

[MIT](./LICENSE)
