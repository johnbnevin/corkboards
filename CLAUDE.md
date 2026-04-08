# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Cross-Platform Changes

**NEVER make changes to only one platform without making equivalent changes to all platforms.** When making any change — bug fix, feature, refactor, security hardening, protocol compliance — apply it to **all relevant codebases** (web, mobile, desktop) by default. Don't ask which platform; implement everywhere unless the user says otherwise. All platforms should be as identical to each other as they can practically be.

## Repository Structure

This is a monorepo with four packages:

```
packages/
├── core/       — shared pure TS (Nostr protocol, feed algorithms, types)
├── web/        — React web app (Vite + Tailwind + shadcn)
├── desktop/    — Tauri v2 desktop app (Rust backend + web frontend in webview)
└── mobile/     — React Native / Expo mobile app
```

## Commands

All commands run from the repo root:

```bash
npm run dev      # Start web dev server (port 3000)
npm run test     # Run full web test suite (tsc + eslint + vitest + build)
npm run build    # Production build (web)
```

Or run directly in the web package:

```bash
cd packages/web
npx vite --port 3000         # Dev server
npx vitest run               # Tests only
npx tsc --noEmit             # Type-check only
```

Desktop (Tauri):
```bash
cd packages/desktop/src-tauri
npx @tauri-apps/cli dev      # Dev mode (requires web dev server on port 3000)
npx @tauri-apps/cli build    # Production build
```

- The user may paste console logs into `corkboards-console-log.txt` for debugging — check that file when relevant.

To run a single test file:
```bash
cd packages/web && npx vitest run src/components/NoteContent.test.tsx
```

## Architecture

**corkboards.me** is a private social feed reader and builder, built with React, TypeScript, and Vite. It uses the Nostr protocol for decentralized data.

### Provider Hierarchy

The app wraps components in this order (see `packages/web/src/App.tsx`):
1. `UnheadProvider` - SEO meta management
2. `AppProvider` - App config (theme, relays) with localStorage persistence
3. `QueryClientProvider` - TanStack Query for data fetching
4. `NostrLoginProvider` - Authentication state from @nostrify/react
5. `NostrProvider` - NPool connection with outbox model routing
6. `TooltipProvider` / `Toaster` - UI utilities

### Shared Core (`packages/core/`)

Pure TypeScript modules with no DOM or React dependencies. Used by web, desktop, and mobile.

- **Protocol**: `nostr.ts`, `noteClassifier.ts`, `dmUtils.ts`, `dmConstants.ts`
- **Feed**: `feedConstants.ts`, `rss.ts`
- **Storage**: `storage.ts` (KVStorage interface), `storageKeys.ts` (user isolation with DI)
- **Text**: `formatTimeAgo.ts`, `textTruncation.ts`, `genUserName.ts`, `sanitizeUtils.ts`
- **Path alias**: `@core/*` maps to `packages/core/src/*`

### Nostr Integration

- **@nostrify/nostrify** and **@nostrify/react** handle all Nostr operations
- `NostrProvider` (`packages/web/src/components/NostrProvider.tsx`) creates an NPool with custom routing:
  - `reqRouter`: Routes queries to author-specific relays (outbox model) plus hardcoded fallbacks
  - `eventRouter`: Publishes to hardcoded write relays
  - Global `relayCache` Map stores pubkey → relay mappings
- Use `useNostr()` hook to access the pool, `useNostrPublish()` to publish events
- NIP-65 relay discovery via `useNip65Relays()` hook

### Key Patterns

- **Path alias**: `@/*` maps to `packages/web/src/*`
- **UI components**: shadcn/ui in `packages/web/src/components/ui/` (Radix primitives + Tailwind)
- **State**: TanStack Query for server state, `useLocalStorage` for persistence
- **Testing**: Wrap components in `TestApp` (`packages/web/src/test/TestApp.tsx`) to provide all required providers

### Custom ESLint Rules

Located in `packages/web/eslint-rules/`:
- `no-placeholder-comments`: Blocks "// In a real..." comments
- `no-inline-script`: Prevents inline scripts in HTML
- `require-webmanifest`: Ensures manifest.json link exists

### Nostr Event Kinds Used

- Kind 0: Profile metadata (NIP-01)
- Kind 1: Short text notes (NIP-10)
- Kind 3: Contact list / follows (NIP-02)
- Kind 6: Repost (NIP-18)
- Kind 7: Reaction (NIP-25)
- Kind 10002: Relay list (NIP-65)
- Kind 30023: Long-form content (NIP-23)
- Kind 34235: Video events (NIP-71)
- Kind 9734: Zap request (NIP-57)
- Kind 9735: Zap receipt (NIP-57)

## Shorthand Commands

If the user's prompt is only **`bu`**, it means: run both `stage` and `deploy` (see below), then create a backup zip and clear context:
1. Run the `stage` steps
2. Run the `deploy` steps
3. Create a source-only backup zip (see **Backup** section below)
4. Clear context (use `/clear`)

If the user's prompt is only **`stage`**, it means:
1. Commit all changes to git (stage modified/new files, write a concise commit message)
2. Build the project (`cd packages/web && npm run build`)
3. Recreate `/home/q4/corkboards/dist_stage` — delete its contents, copy `packages/web/dist/*` into it, then copy ALL non-build server files from `packages/web/`: `rss-proxy.php`, `.htaccess`, and any other standalone server files. **Note:** The user manually uploads `dist_stage` to stage.corkboards.me.

If the user asks to **backup** or a shorthand includes backup, create a **small source-only zip** (~500KB). Only include authored source files — no `node_modules`, `.git`, `dist*`, build artifacts, Rust `target/`, or binary blobs:
```bash
cd /home/q4/corkboards && zip -r /home/q4/corkboard-backup.zip \
  packages/core/src/ \
  packages/web/src/ packages/web/public/ packages/web/index.html \
  packages/web/vite.config.ts packages/web/tsconfig*.json \
  packages/web/tailwind.config.ts packages/web/postcss.config.js \
  packages/web/eslint-rules/ packages/web/eslint.config.js \
  packages/web/rss-proxy.php packages/web/.htaccess \
  packages/desktop/src-tauri/src/ packages/desktop/src-tauri/Cargo.toml \
  packages/desktop/src-tauri/tauri.conf.json \
  packages/mobile/src/ packages/mobile/app.json packages/mobile/package.json \
  package.json CLAUDE.md
```

If the user's prompt is only **`deploy`**, it means:
1. Commit all changes to git (if any uncommitted changes exist)
2. Build the project (`cd packages/web && npm run build`)
3. Recreate `/home/q4/corkboards/dist_deploy` — delete its contents, copy `packages/web/dist/*` into it, then copy ALL non-build server files from `packages/web/`: `rss-proxy.php`, `.htaccess`, and any other standalone server files. **Note:** The user manually uploads `dist_deploy` to corkboards.me production.
