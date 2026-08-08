# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.8.4] - 2026-08-08

### Fixed
- **Multi-account finally works end to end.** New logins actually become the
  active account (they were appended behind the current one, so adding an
  account looked like a failed login); the switcher waits for the login list
  to persist before reloading (switching could resurrect a logged-out
  account or come up as the wrong user); logging out decides
  "switch vs. wipe" from the credential list, never a still-loading profile
  query (a slow relay could nuclear-wipe a surviving account); the departing
  account's pending cloud backup is flushed before any switch.
- **Sign-in reliability (QR and Amber):** connect flows open fresh relay
  sockets per attempt (a dead cached socket silently ate every retry); the
  Amber deep-link fires only after a relay confirms our subscription is live
  (the ephemeral connect response could be published into the void while
  Android had the page frozen — the "hangs on opening Amber" bug); a second
  account presents a fresh NIP-46 client identity so Amber doesn't treat it
  as already connected; all waits are bounded with real error messages.
- **Desktop login roulette:** on a slow IndexedDB the app could mount before
  the encrypted signer keys were readable and dump a validly-logged-in user
  on the login screen; bunker signers now resolve their key on first use.
- **Consolidate sound:** the Bluetooth wake lead now also covers a sink that
  went idle while the audio context stayed hot (desktop only — browsers keep
  the old instant playback), and a quick second consolidate plays again.
- **Emoji strips:** the horizontal scrollbar is back — thin, in its own
  gutter below the icons instead of painted over them.
- **Dark mode:** tab-bar and status-bar buttons are white with dark text
  (hover included); the "hide posts with…" filter input is readable.

## [0.8.3] - 2026-08-07

### Fixed
- **Consolidate sound over Bluetooth:** bursts scheduled right after waking the
  audio context played into the sink's spin-up window (PipeWire live streams
  drop, not buffer) and were truncated or silent on Bluetooth outputs. Now a
  0.3 s wake lead + a 30 s idle grace keep the sink hot between sounds.
- **Nested reply-to notes:** manual retry escalates through the whole ladder —
  candidate thread authors' outbox relays (NIP-10 p-tags), then a parallel
  sweep of last-resort lookup relays (web + mobile).
- **Emoji pack strips:** native horizontal scrollbar no longer covers the pack
  icons; wheel/drag scrolling via a shared manualScroll helper.

### Included since the 0.8.2 deployment
- Nine-bug sweep: idle-return feed latch, unresolved parents, thread overlap,
  duplicate images, video errors, help modal, login copy, YouTube titles.
- Regression-audit fixes: EOSE-abort completion, mobile feed cap, legit-empty
  gate, focus recovery, strict pubkey hex, gated memlog.
- Memory-leak defenses after the silent desktop crash: RSS telemetry, sweep
  rotation + give-up, cache caps.
- Cross-device saved-note cleanup actually applies; new optimized logos.
- get.corkboards.me: "Older versions" modal (0.8.0/0.8.1/0.8.2), sha256
  checksums published as `linux-latest.sha256`.

## [0.8.2] - 2026-07-25

### Security & privacy (cross-platform)
- **Repost/quote impersonation (critical):** embedded kind-6/16 JSON is now signature-verified (id recompute + Schnorr) before it is rendered as an authored note. A forged embed falls back to fetching the real event through the verified transport instead of being attributed to whatever pubkey it claims.
- **SSRF/egress:** LNURL/zap fetches refuse redirects that would escape the host-safety check; profile banners, NIP-30 emoji, and markdown images now go through the shared SSRF gate + image proxy; media host matching is exact-or-subdomain (no more `evil-nostr.build` matching `nostr.build`).
- **Zap safety:** the returned invoice amount is verified against the approved amount before any NWC auto-pay; all zap-receipt totals use one NaN-safe BOLT-11 parser (the old ones disagreed by up to 1e8).
- **Crypto/keys:** mobile MMKV key is a proper 16-byte key, and a transient keychain read error no longer regenerates it and orphans encrypted data; self-encryption no longer silently downgrades NIP-44 → NIP-04.
- **Desktop:** native relay path fails closed on a corrupt proxy config; WebSocket message size is bounded; `sign_event` rejects out-of-range kinds and non-string tags; the activity log is 0600 with broader secret redaction; CSP allows `ws:` for `.onion` relays.
- **Data-loss:** removing your last bookmark now publishes the emptied list (no more resurrection); the nsec migration persists-then-blanks so a crash can't destroy the only copy; NWC is kept out of the unencrypted settings backup; mobile logout clears cached note bodies.

### Fixed (protocol)
- Reactions carry the NIP-25 `k` tag (and `a` for addressable targets) with relay hints on every platform.
- "Load newer" ignores future-dated events that used to freeze a tab's since-cursor.

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
