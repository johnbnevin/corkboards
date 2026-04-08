# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
