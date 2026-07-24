# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
