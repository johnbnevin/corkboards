# Contributing to Corkboards

## Philosophy

Corkboards is built with cypherpunk sensibilities:

- **Privacy first** — no central server, no analytics, no telemetry. Data stays on the user's device.
- **Nostr-native** — the Nostr protocol is the backbone. Features should leverage existing NIPs where possible before inventing new patterns.
- **No central authority** — users control their keys, their data, and their relay choices.
- **Ship working code** — we value pragmatic solutions over theoretical perfection.

## Getting Started

Prerequisites: Node.js 22+, npm 10+

```bash
git clone https://github.com/nickkdev/corkboards.git
cd corkboards
npm install
npm run dev    # Web dev server on port 3000
```

## Monorepo Structure

| Package | Path | Role |
|---------|------|------|
| **core** | `packages/core/` | Shared pure TypeScript — Nostr protocol, feed algorithms, storage interface, text utilities. No DOM or React dependencies. |
| **web** | `packages/web/` | React web app (Vite + Tailwind + shadcn/ui). Primary client. |
| **desktop** | `packages/desktop/` | Tauri 2 desktop app — Rust backend with OS keychain, web frontend in webview. |
| **mobile** | `packages/mobile/` | React Native / Expo mobile app with MMKV storage and OS keychain. |

## Key Architecture Decisions

### Storage: IndexedDB, not localStorage

The web package uses IndexedDB (via `packages/web/src/lib/idb.ts`) with a synchronous in-memory cache layer. This gives us:
- Larger storage quota than localStorage
- Per-user data isolation via namespaced keys
- Cross-tab sync via BroadcastChannel
- Atomic backup/restore

**Rule: Never use `localStorage` directly in new code.** Use `idbGetSync`/`idbSetSync` from `@/lib/idb`.

### Relay URLs: Centralized constants

All hardcoded relay URLs live in `packages/web/src/lib/relayConstants.ts`. This makes it trivial for forks to swap relays. **Never hardcode `wss://` URLs directly in components or hooks.**

### Outbox Model

`NostrProvider.tsx` implements NIP-65 outbox routing: queries go to the author's declared relays, publishes go to the user's write relays. See the comment block above `createPool()` for full details.

### Per-Tab State in useFeedPagination

`useFeedPagination` uses `useRef<Map>` + `forceUpdate()` instead of `useState` to preserve state for N tabs simultaneously without stale-closure bugs. See the comment block in the file for the full rationale. Do not convert to `useState` without reading all async paths.

## Running Tests

```bash
npm run test                           # Full suite from repo root
cd packages/web && npx vitest run      # Tests only
cd packages/web && npx tsc --noEmit    # Type-check only
```

## Nostr Protocol Reference

Corkboards implements these NIPs: 01, 02, 04, 05, 10, 17, 18, 19, 23, 25, 46, 50, 51, 57, 65, 71, 78, 94.

When adding Nostr features, check the [NIP index](https://github.com/nostr-protocol/nips) first. Prefer existing NIPs over custom solutions.

## Pull Request Checklist

Before submitting a PR:

- [ ] `npm run test` passes (types, lint, tests, build)
- [ ] No new hardcoded relay URLs — use `relayConstants.ts`
- [ ] No direct `localStorage` usage — use the IDB abstraction
- [ ] JSDoc added for any new public functions or hooks
- [ ] CHANGELOG.md updated with a summary of changes
- [ ] Cross-platform: if the change affects UI/features, apply it to all relevant packages (web, mobile, desktop)

## Code Style

- TypeScript strict mode
- Tailwind CSS for styling (no CSS modules or styled-components)
- shadcn/ui for UI primitives (Radix + Tailwind)
- TanStack Query for server/relay state
- Console logging gated with `import.meta.env.DEV` (tree-shaken in production)
