# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.8.1] - 2026-07-24

### Changed
- Version aligned to **0.8.1** across all packages (core, web, desktop, mobile), Tauri, and Cargo. Mobile keeps its `b` suffix (`0.8.1b`). Release numbers track deployments, not commit labels: 0.8.0 was the last deployment, so this — the first deployment since — is 0.8.1. The `v0.8.1`–`v0.8.5` prefixes in intervening commit messages were development markers and were never shipped.

### Included since 0.8.0
- Zap without a wallet via QR; word filter now reads inside reposts.
- Scan-to-zap; shared content-filter and LNURL core modules; cross-platform parity pass.
- Security audit: 5 critical/high data-loss and forgery fixes across all platforms; audit findings register (167 confirmed findings, 147 parity gaps).
- SSRF/URL hardening, desktop relay guards, mobile autofetch fixes, core dedupe.
- README refresh: features + NIP table (custom emoji, Blossom redundancy, link shields, NIP-99 storefronts; removed DMs).
- get.corkboards.me: direct Linux download links for AppImage/.deb/.rpm.

## [0.8.0] - 2026-07-24

### Changed
- Version aligned to **0.8.0** across all packages (core, web, desktop, mobile), Tauri, and Cargo. Mobile keeps its `b` suffix (`0.8.0b`).

### Notable since 0.7.x
- Emoji pickers: touch side-scroll fixes, "Manage Sets" available in all pickers (including reactions), reaction button on all notes, mobile Manage Sets.
- Thread scroll-race and inline-reply anchoring fixes, media dedup, login relay/blossom refresh.
- Blossom media redundancy — verified mirroring + cross-server render fallback (all platforms).
- DM subsystem removed entirely across web, mobile, desktop, and core.

## [Unreleased]

### Added
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` — open source community files
- `.github/` issue templates and PR template
- `packages/web/src/lib/relayConstants.ts` — centralized relay URL constants
- Architecture documentation: JSDoc on NostrProvider (outbox model), useFeedPagination (per-tab state), useNostrBackup (encrypted backup), DMProvider (dual-protocol DMs)
- Module documentation on core utilities: failedNotes, genUserName, nostr, textTruncation

### Changed
- README.md rewritten for open source release (architecture overview, NIP support list, setup guides)
- Nostr identifier regex consolidated: single pattern string in `@core/nostr`, consumed everywhere via `new RegExp()` (fixes stateful /g flag bug)
- Relay URLs centralized from 5 scattered locations into `relayConstants.ts`
- Production console.log calls in useFeedPagination gated behind `import.meta.env.DEV`

### Removed
- Dead calendar code (11 files + page + route) — belonged to a separate project
- Exported `NOSTR_IDENTIFIER_REGEX` module-level /g singleton from core/nostr.ts (replaced by `NOSTR_IDENTIFIER_PATTERN` string + `createNostrIdentifierRegex()`)
