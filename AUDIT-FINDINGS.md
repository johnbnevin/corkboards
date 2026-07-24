# corkboards deep audit — findings register (v0.8.3)

Generated from a 67-agent audit of core/web/mobile/desktop. **167 confirmed findings, 147 parity gaps.**

Items marked ✅ were fixed and committed in v0.8.3. Everything else is verified-but-open.
Each entry keeps the reproducing detail and the proposed fix so it can be picked up directly.

> Note: findings whose verdict is UNVERIFIED had their adversarial-verify agent
> cut short by a session limit. The five critical/high ones were re-verified by hand;
> the rest are the finder agent's unchallenged claims and should be confirmed before acting.

## CRITICAL (5)

### ✅ FIXED — Desktop (Tauri) relay bridge never filter-matches events — signed-but-unrequested events are accepted, enabling note substitution, relay-cache poisoning, and kind-3 follow-list takeover
- **area**: `error-handling-edge` · **platforms**: desktop, core, web · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/relay.rs:475`, `packages/desktop/src-tauri/src/relay.rs:508`, `packages/web/src/lib/tauri.ts:190`, `packages/web/src/lib/tauri.ts:326`, `packages/web/src/components/NostrProvider.tsx:927`, `packages/web/src/lib/fetchEvent.ts:90`
- **detail**: On web/mobile every relay message passes through `@nostrify` `NRelay1.req()`, which does BOTH checks: `if (!verifyEvent(msg[2])) break;` (node_modules/@nostrify/nostrify/NRelay1.ts:233) and `if (matchFilters(filters, msg[2]))` (same file:311). The desktop path replaces that transport entirely and only performs the first check.

Rust side, `run_query` (relay.rs:508-513):
```rust
Some("EVENT") if arr.len() >= 3 => {
    // Drop forged/unparseable events at the transport boundary.
    if !is_authentic_event(&arr[2]) { continue; }
    events.push(arr[2].clone());
```
`is_authentic_event` is `event.verify().is_ok()` (relay.rs:300-303) — a signature/id check only. The REQ filter (`filter: Value`, relay.rs:479) is sent to the relay and then never consulted again.

JS side, `tauriQuery` (tauri.ts:197) and `tauriRelayQuery` (tauri.ts:326-332) each re-run `verifyEvent` and nothing else. The doc comment at tauri.ts:306-310 claims this protects the relay-list discovery path, but a valid signature only proves "someone signed this", not "this is the event I asked for".

This is not a corner of the app: `NostrProvider.tsx:925-936` proxies **every** `nostr.query()` on desktop through `tauriQuery`, so the whole app's data plane loses filter enforcement. Three concrete sinks I traced:
1. `fetchEvent.ts:90-94` — `queryRelay` under `isTauri` returns whatever `tauriRelayQuery` gives back, and `_fetchEventWithOutboxImpl` caches it under the *requested* id: `setCachedEvent(eventId, result)` (line 216), not `result.id`. The relay hints it queries come from the note's own `e`-tags, i.e. attacker-chosen (`opts.hints`, line 181).
2. `fetchEvent.ts:121-159` — `fetchAuthorRelays` asks `{kinds:[10002], authors:[pubkey], limit:1}`, takes `events[0]`, and calls `updateRelayCache(pubkey, relays)`, which persists to IDB and broadcasts to other tabs (NostrProvider `updateRelayCache` → `saveRelayCache`).
3. `packages/core/src/contactList.ts:46-49` — `fetchAuthoritativeContactEvent` queries `{kinds:[3], authors:[myPubkey], limit:5}` and never re-checks `event.pubkey === myPubkey` or `event.kind === 3`; `resolveContactBase` returns `{tags: event.tags, content: event.content}` (line 87) and `useContactActions.ts:49` publishes those tags verbatim as the user's new kind 3.
- **failure**: A user on the desktop build clicks Follow on any profile. One relay in the query set (a fallback relay, or a relay the attacker got into the user's relay cache) answers the `{kinds:[3], authors:[<user>]}` REQ with its own validly-signed kind-3 containing 20 attacker-chosen p-tags. Rust accepts it (signature is genuine), JS accepts it (signature is genuine), `resolveContactBase` returns those tags, `applyContactChange` appends one p-tag, and `useContactActions` signs and publishes a kind 3 that replaces the user's entire follow list. Same primitive, other sinks: a malicious relay hint in an e-tag makes `fetchEventWithOutbox('abc…')` return and cache a completely different note under id `abc…`, so the quoted/parent note rendered in the thread is content the attacker chose; and a forged kind-10002 gets persisted by `updateRelayCache`, permanently routing every future query for that author to the attacker's relay.
- **fix**: Two boundaries, both needed.

(1) Rust — packages/desktop/src-tauri/src/relay.rs. `run_query` already owns `filter: Value`; parse it once before the loop and check each event after `is_authentic_event`. Minimum viable check covering what the app actually sends (`ids`, `kinds`, `authors`, `since`, `until`, `#e`, `#p`, `#d`, `#t`): event.id ∈ ids, event.kind ∈ kinds, event.pubkey ∈ authors, created_at within since/until, and for each `#X` key at least one tag `[X, v]` with v ∈ values. Drop on mismatch. Note `nostr::Filter` from the already-vendored `nostr` crate has `match_event`; prefer deserializing the incoming `Value` into it and calling that over hand-rolling.

(2) JS — packages/web/src/lib/tauri.ts. This is the authoritative layer (it survives a bypassed/patched Rust binary). Import `matchFilters` from 'nostr-tools' (the exact function NRelay1 uses) and add it beside the existing `verifyEvent` call: in `tauriQuery` the accept loop is lines 192-201 — but note the function currently takes a single `filter: Record<string, unknown>`, so match against `[filter]`; in `tauriRelayQuery` the `.filter()` at 326-332 likewise becomes `verifyEvent(ev) && matchFilters([filter], ev)`.

(3) Sink hardening, which must land regardless since these are the actual damage points and two of them are shared core:
  - fetchEvent.ts:216 → `if (result && result.id === eventId) { setCachedEvent(eventId, result); return result }` (the sibling call sites at 230/289/300 already key on `result.id`, so this is a one-line consistency fix).
  - fetchEvent.ts:139-141 → require `best.kind === 10002 && best.pubkey === pubkey` before `updateRelayCache`. Apply the identical guard to packages/mobile/src/lib/fetchEvent.ts:107 for parity even though mobile's transport currently filters — defense in depth, and CLAUDE.md forbids platform-only fixes.
  - packages/core/src/contactList.ts:48 → `const mine = events.filter(e => e.kind === 3 && e.pubkey === myPubkey); if (mine.length > 0) return mine.reduce(...)`. This is core, so web + mobile + desktop all get it from one edit.

### ☐ OPEN — Kind-6/16 repost embedded JSON is rendered as an authored note with zero signature/id verification (impersonation)
- **area**: `nostr-protocol` · **platforms**: web, mobile, desktop, core · **verdict**: UNVERIFIED
- **files**: `packages/web/src/components/NoteCard.tsx:730`, `packages/web/src/components/NoteCard.tsx:170`, `packages/mobile/src/components/NoteCard.tsx:116`, `packages/core/src/noteCategories.ts:113`
- **detail**: NIP-18 says the `content` of a kind-6 repost is "the stringified JSON of the reposted note" — attacker-controlled data that MUST be verified before it is trusted. Nothing in the JS codebase verifies it. `NoteCard.tsx:730-753`:

```js
const parsed = JSON.parse(content)
if (parsed.content === undefined || !parsed.pubkey) return null
...
return parsed as NostrEvent
```

The only checks are that `content` is defined and `pubkey` is truthy — no `id` recomputation, no `sig` check, no kind check. The result is then used as the display event: `useAuthor(displayEvent.pubkey)`, `genUserName(displayEvent.pubkey)`, avatar/display-name lookup. Mobile (`NoteCard.tsx:116-129`) is marginally stricter (requires `id`, `kind`, string `content`) but still never verifies the signature. `ExpandableContent` (`NoteCard.tsx:170-178`) does the same for any event whose content starts with `{`. `noteCategories.ts:113-114` also parses it and uses it for classification.

The only `verifyEvent` calls in the whole JS tree are in `packages/web/src/lib/tauri.ts:184,325` (native transport), and nostrify's `NRelay1` verifies only the *outer* event — never the JSON nested inside `content`.
- **failure**: Attacker (any pubkey, no follow relationship needed — reposts surface via `#e`/engagement queries and any corkboard containing them) publishes `{kind:6, tags:[["e","<real note id>"]], content:"{\"id\":\"00..00\",\"pubkey\":\"<jack's pubkey>\",\"kind\":1,\"created_at\":1770000000,\"tags\":[],\"content\":\"I'm giving away 1 BTC, send 100k sats to bc1q...\",\"sig\":\"deadbeef\"}"}`. corkboards renders a card with Jack's real avatar, real display name (fetched from his real kind-0) and the attacker's text. The user has no way to tell it apart from a genuine note.
- **fix**: Add a shared `@core` helper `verifyEmbeddedEvent(json): NostrEvent | null` that runs nostr-tools' `verifyEvent` (id hash + schnorr sig) and returns null on failure, then route every embedded-JSON parse through it: `NoteCard.tsx:730` (`parsedRepost`), `NoteCard.tsx:170` (`resolvedEvent`), mobile `NoteCard.tsx:116` (`displayEvent`), `noteCategories.ts:113`. On verification failure, fall back to the existing `repostTargetId` path (fetch the real event by the `e` tag) rather than rendering the unverified payload. Since `verifyEvent` is sync-but-CPU-bound, memoize per event id.

### ✅ FIXED — AbortSignal.timeout()/AbortSignal.any() do not exist in the React Native runtime — every network call in the mobile app throws TypeError
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/hooks/useFeed.ts:35`, `packages/mobile/src/hooks/useFeed.ts:48`, `packages/mobile/src/hooks/useFeed.ts:115`, `packages/mobile/src/hooks/useAuthor.ts:56`, `packages/mobile/src/hooks/useAuthor.ts:184`, `packages/mobile/src/lib/NostrProvider.tsx:579`
- **detail**: React Native 0.81.5 unconditionally REPLACES the global `AbortSignal` with the `abort-controller@3.0.0` shim. Verified by reading the runtime:

- `node_modules/react-native/src/private/setup/setUpDefaultReactNativeEnvironment.js` requires `Libraries/Core/setUpXHR`.
- `node_modules/react-native/Libraries/Core/setUpXHR.js:42-44`:
  ```js
  polyfillGlobal(
    'AbortSignal',
    () => require('abort-controller/dist/abort-controller').AbortSignal,
  );
  ```
- `polyfillGlobal` (Libraries/Utilities/PolyfillFunctions.js) always overwrites via `defineLazyObjectProperty`.
- `node_modules/abort-controller/dist/abort-controller.js` defines only `class AbortSignal extends EventTarget` + `Object.defineProperties(AbortSignal.prototype, …)`. `grep -c timeout` on that file returns **0**. There is no `static timeout` and no `static any`.

I grepped all of `node_modules/` and `packages/mobile/node_modules/` for anything assigning `AbortSignal.timeout` — no hits. `App.tsx:1` imports only `react-native-get-random-values` (which polyfills `crypto.getRandomValues` only), and `index.ts` adds no polyfill either.

There are **77** `AbortSignal.timeout(` call sites in `packages/mobile/src` and 10+ `AbortSignal.any(` call sites. Every one of them evaluates `AbortSignal.timeout(...)` → `TypeError: AbortSignal.timeout is not a function`.

Example, `useFeed.ts:48`:
```ts
const results = await nostr.query([filter], { signal: AbortSignal.timeout(10000) });
```
and `useAuthor.ts:56`:
```ts
const netSignal = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
```

This is mobile-only: web and the Tauri webview both have native `AbortSignal.timeout`/`any`.

A secondary consequence worth noting: `SizeGuardedImage.checkSize` (line 83) wraps the throw in a try/catch whose handler does `corsBlockedHosts.add(host)` — so on first sight of any image the host is permanently marked CORS-blocked for the process, and every subsequent image on that host skips size checking entirely.
- **failure**: Cold-launch the mobile app logged in. `useFeed`'s queryFn throws `TypeError: AbortSignal.timeout is not a function` on its first statement; React Query catches it, retries once, and marks the query errored — HomeScreen renders the `isError` branch "Could not load feed" (HomeScreen.tsx:495). Simultaneously `useAuthor.fetchAuthorFromNetwork` rejects for every pubkey, so after 3 retries every card falls back to `genUserName(pubkey)` and displays as `user_xxxx` — exactly the symptom the code comments at useAuthor.ts:64-66 and 129-131 are trying to fix. Notification polling, thread loads, quoted-note fetches, saved-note fetches and zaps all fail the same way.
- **fix**: Create packages/mobile/src/polyfills.ts and make it the FIRST line of packages/mobile/index.ts — above `import { registerRootComponent } from 'expo'` — because index.ts's `import App from './App'` is what triggers module-eval of NostrProvider.tsx (which runs `wrapPoolWithSessionAbort` and `loadRelayCache()` at module scope). ESM import side effects run in source order, so a polyfill placed at App.tsx:1 would work too, but index.ts is the true entrypoint and is the only place that also covers anything Expo evaluates.

```ts
// packages/mobile/src/polyfills.ts
// RN 0.81 replaces global AbortSignal with abort-controller@3 (see
// react-native/Libraries/Core/setUpXHR.js), which has no static timeout/any.
type AS = typeof AbortSignal & {
  timeout?: (ms: number) => AbortSignal;
  any?: (signals: Iterable<AbortSignal>) => AbortSignal;
};
const A = AbortSignal as AS;
if (typeof A.timeout !== 'function') {
  A.timeout = (ms: number) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    // don't hold the RN timer queue open once the caller is done
    c.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
    return c.signal;
  };
}
if (typeof A.any !== 'function') {
  A.any = (signals: Iterable<AbortSignal>) => {
    const c = new AbortController();
    for (const s of signals) {
      if (s.aborted) { c.abort(); return c.signal; }
      s.addEventListener('abort', () => c.abort(), { once: true });
    }
    return c.signal;
  };
}
```
Notes the original fix missed:
- Use `new AbortController().signal`; `new AbortSignal()` throws `TypeError: AbortSignal cannot be constructed directly` in the shim (abort-controller.js:21).
- The shim's `abort()` takes no reason and its signals expose no `.reason` / no `TimeoutError` DOMException. I grepped packages/mobile/src for `signal.reason` — zero app-level consumers, so this is tolerable, but any nostrify/NRelay1 code that branches on `reason?.name === 'TimeoutError'` will fall into the generic-abort branch.
- `clearTimeout` on abort matters here: without it, every composed `AbortSignal.any([sig, AbortSignal.timeout(8000)])` in `wrapPoolWithSessionAbort` leaves a live RN timer for the full window.
- Add a jest test (packages/mobile/src/__tests__/polyfills.test.ts) asserting `typeof AbortSignal.timeout === 'function' && typeof AbortSignal.any === 'function'` after importing the module, and that `AbortSignal.any` propagates an already-aborted input synchronously.

### ✅ FIXED — stashUserData reads through an IDB memCache that its own writes are evicting — account switch permanently deletes the departing user's stashed settings
- **area**: `race-conditions` · **platforms**: core, web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/core/src/storageKeys.ts:270`, `packages/core/src/storageKeys.ts:336`, `packages/web/src/lib/idb.ts:224`, `packages/web/src/lib/idb.ts:324`, `packages/web/src/lib/idb.ts:142`, `packages/web/src/lib/profileCache.ts:85`
- **detail**: `stashUserData` is a read-modify-write loop over ~90 `PER_USER_KEYS` that reads with `storage.getSync` and writes with `storage.setSync` in the SAME loop:

```js
for (const key of PER_USER_KEYS) {
  const value = storage.getSync(key);
  if (value !== null) storage.setSync(`user:${pubkey}:${key}`, value);
  else storage.removeSync(`user:${pubkey}:${key}`);   // <-- destructive
}
```

On web/desktop `getSync`/`setSync` are `idbGetSync`/`idbSetSync`. `idbSetSync` evicts on every NEW key when the cache is full:

```js
if (memCache.size >= MAX_MEM_CACHE && !memCache.has(key)) {
  memCache.delete(memCache.keys().next().value!);   // evicts FIRST-INSERTED key
}
```

`MAX_MEM_CACHE` is 2000, but two other paths let memCache exceed it without any cap: the init loop (`idb.ts:324-330` — `for (const [k,v] of all) memCache.set(k,v)` with no size check) and async `idbSet` (`idb.ts:142` — `memCache.set(key, value)` with no size check). `profileCache.setCachedProfile` writes one `profile-cache:<pubkey>` key per profile via `idbSet`, and `MultiColumnClient.tsx:1644` calls `setCachedProfiles(events)` for every follow batch, so any user with a few hundred follows blows past 2000 within days.

At startup memCache is populated in `idbGetAll()` order, which is IndexedDB ascending key order, so the first-inserted (= first-evicted) entries are the lexicographically smallest keys: `collapsed-notes`, then the whole `corkboard:*` block, then `dismissed-notes`, `filter-panel-collapsed`, `nostr-*`. Those are precisely the keys `stashUserData` is iterating.

`switchActiveUser` compounds it: after `stashUserData` it runs `removeSync(key)` for all 90 keys (clearing them from memCache) and then `setSync(key, value)` for all restored keys — every one of which is now a "new" key, triggering another ~90 evictions. ~180 of the alphabetically-earliest keys get evicted per switch.
- **failure**: User has 3 accounts and ~600 follows, so memCache holds >2000 entries (mostly `profile-cache:*`). They switch from account A to account B. `useAccountIsolation` calls `switchActiveUser(A, B)` → `stashUserData(A)`:
- i=0 stashes `nostr-custom-feeds`, its `setSync` evicts memCache's first key.
- i=1 reads `collapsed-notes` (still cached, OK), its `setSync` evicts `collapsed-notes` from memCache.
- i≈33 reaches `STORAGE_KEYS.BANNER_HEIGHT_PCT`; by then ~33 evictions have removed everything from `__idb_migrated_from_ls__` through `corkboard:blossom-*`, so `getSync('corkboard:banner-height-pct')` returns **null** even though the value is on disk → the else branch runs `removeSync('user:A:corkboard:banner-height-pct')`, which issues a real `idbRemove` and **deletes A's stashed value from disk**.
- Same for `corkboard:blossom-servers`, `corkboard:avatar-size-limit`, `corkboard:autofetch-interval-secs`, `corkboard:image-size-limit`, `corkboard:last-backup-ts`, `corkboard:remote-checkpoints`, `corkboard:restore-history`, and every other backed-up key that sorts before the ~90th alphabetical position.

When the user switches back to A, `restoreUserData(A)` finds those `user:A:*` keys absent and calls `removeSync(key)` on the live keys — A's Blossom server list, banner settings, backup timestamp and checkpoint history are gone with no recovery path (the checkpoint metadata that would let them roll back is itself one of the deleted keys).
- **fix**: Two changes, both needed:
1. In `packages/core/src/storageKeys.ts`, make `stashUserData`/`restoreUserData`/`switchActiveUser` async and read through `storage.get()` (real backing store) rather than `storage.getSync()`; or at minimum snapshot ALL values up front (before any write) the way `switchActiveUser` already does for `newUserData` at lines 326-329, and never derive a `removeSync` from a `getSync` miss — treat `null` from the sync cache as "unknown", not "absent".
2. In `packages/web/src/lib/idb.ts`, enforce `MAX_MEM_CACHE` in the init loop (line 324) and in async `idbSet` (line 142) so the cache can never be over capacity, and change eviction to skip keys in `PER_USER_KEYS`/`BACKED_UP_KEYS` (pin app-critical keys; only evict `profile-cache:*`/`custom-feed-metadata:*`-style ephemeral entries). Mobile MMKV is unaffected (no memCache) but the core function should be fixed for all platforms.

### ✅ FIXED — kind-3 follow list is wiped on a relay miss: resolveContactBase('add') returns an empty base when the cached contact list is also empty
- **area**: `race-conditions` · **platforms**: core, web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/core/src/contactList.ts:85`, `packages/core/src/contactList.ts:92`, `packages/web/src/hooks/useContactActions.ts:36`, `packages/web/src/pages/MultiColumnClient.tsx:1594`, `packages/mobile/src/hooks/useFeed.ts:164`, `packages/mobile/src/screens/ProfileScreen.tsx:165`
- **detail**: `resolveContactBase` is the whole safety net for kind-3 mutation, and the `add` path defeats it:

```js
const event = await fetchAuthoritativeContactEvent(nostr, myPubkey);
if (event) return { tags: event.tags, content: event.content ?? '' };
if (cached && cached.length > 0) return { tags: cached.map(pk => ['p', pk]), content: '' };
if (op === 'add') return { tags: [], content: '' }; // first follow, no list anywhere
return null;
```

The comment claims this is the "new user's first follow" case, but the code cannot distinguish it from a relay miss. `fetchAuthoritativeContactEvent` returns `null` on BOTH an empty result and a thrown/timed-out query (it swallows the exception at line 64-66). The `cached` argument is the React-Query `contacts` value, which is `[]` — not `undefined` — on a relay miss, by the callers' own admission:

- `MultiColumnClient.tsx:1598-1601`: `if (events.length === 0) { debugLog('[contacts] No kind-3 events returned — zero contacts or relay miss'); return []; }`
- `mobile/src/hooks/useFeed.ts:166`: `if (!event) return [];`

So `cached.length > 0` is false, `op === 'add'` is true, and the caller publishes a kind 3 whose tags are `[['p', <the one new pubkey>]]` and whose content is `''` — replacing the user's entire follow list and dropping the legacy relay-list JSON the module's own header comment says it exists to preserve.
- **failure**: User follows 500 people. On app start the contacts query hits a relay outage/timeout and resolves to `[]` (React Query caches this, `staleTime` 5 min on mobile; web retries 3× then also settles on `[]`). The user clicks "Follow" on someone from the Discover tab. `fetchAuthoritativeContactEvent` runs its own 8-second query, which also fails on the same degraded relays and returns `null`. `cached` is `[]`. `op` is `'add'` → base is `{tags: [], content: ''}`. `applyContactChange` produces `tags = [['p', newPubkey]]`. `useNostrPublish` signs and publishes kind 3 with a fresh `created_at`, which replaces the 500-entry event on every relay that accepts it. `queryClient.setQueryData(['contacts', pubkey], ['<newPubkey>'])` then makes the UI agree. 500 follows are gone.
- **fix**: Delete the `if (op === 'add') return { tags: [], content: '' }` escape hatch and return `null` for both ops when nothing is confirmable, then distinguish the genuine new-user case explicitly: have `fetchAuthoritativeContactEvent` return a discriminated result (`{ status: 'found', event } | { status: 'confirmed-empty' } | { status: 'unreachable' }`) — `confirmed-empty` only when at least one relay actually responded with an EOSE and zero events — and let callers pass an empty base only for `confirmed-empty`. Callers in `useContactActions.ts`, `ProfileScreen.tsx` and `ProfileModal.tsx` already handle `null` by showing "Could not load your current follow list", so no new UI is needed.

## HIGH (16)

### ☐ OPEN — Zap flow pays the LNURL server's bolt11 invoice without verifying its amount or destination
- **area**: `error-handling-edge` · **platforms**: web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useZap.ts:97`, `packages/web/src/hooks/useZap.ts:105`, `packages/web/src/hooks/useZap.ts:111`, `packages/mobile/src/hooks/useZap.ts:97`, `packages/mobile/src/hooks/useZap.ts:101`, `packages/mobile/src/hooks/useZap.ts:105`
- **detail**: The client asks the callback for an invoice of `amountMsats`, then hands whatever string comes back straight to the wallet:
```ts
const invoiceData = await invoiceResponse.json();
...
const bolt11 = invoiceData.pr;
if (!bolt11) throw new Error('No invoice returned from LNURL service');
...
await payInvoice(bolt11);
```
`payInvoice` (useNwc.tsx:133-149) does no inspection either — it just wraps the string: `JSON.stringify({ method: 'pay_invoice', params: { invoice: bolt11 } })`. I grepped the whole repo for bolt11 decoding: the only two parsers are display-only (`EngagementBar.tsx:118`, `NoteCard.tsx:1252`) and neither is on this path. So nothing anywhere checks that the invoice's amount equals the amount the user approved, and nothing checks the invoice's payee.

The `minSendable`/`maxSendable` checks at useZap.ts:53-58 constrain what the client *requests*; they say nothing about what the server *returns*. The endpoint host is attacker-controllable in the ordinary case — it comes from the target author's kind-0 `lud16`/`lud06` (`resolveZapEndpoint`, packages/core/src/zap.ts:119), i.e. any Nostr user can point it at a host they run.
- **failure**: Attacker publishes a kind-0 with `lud16: "pay@attacker.example"`. Their `/.well-known/lnurlp/pay` endpoint returns a valid `callback` (https, public host, so `isSafeZapUrl` passes). A user clicks Zap → 21 sats. The callback returns `{"pr": "lnbc5m1…"}` — an invoice for 500,000 sats payable to the attacker. The client pays it via NWC without a second prompt; the toast then says "Zap sent! 21 sats to <name>" (ZapDialog.tsx:43). Loss is bounded only by whatever budget the user's NWC connection happens to carry.
- **fix**: Add a bolt11 amount decoder to packages/core (new `bolt11.ts`, so web/mobile/desktop share one implementation) and gate the payment on it.

The amount lives in the BOLT-11 human-readable part, before the separator `1`: `ln` + currency prefix (`bc`/`tb`/`bcrt`/`sb`) + optional `<digits><multiplier>`. Multipliers: none = BTC, `m` = 1e-3, `u` = 1e-6, `n` = 1e-9, `p` = 1e-12 BTC. Convert to msat as `digits * 1e11 / divisor` (1 BTC = 1e11 msat), and per spec reject `p` amounts that are not a multiple of 10 (sub-msat precision). Return `null` for an amountless invoice.

Then in BOTH packages/web/src/hooks/useZap.ts (before :111) and packages/mobile/src/hooks/useZap.ts (before :105):

    const invoiceMsats = decodeBolt11Msats(bolt11);
    if (invoiceMsats === null) throw new Error('LNURL server returned an invoice with no amount — refusing to pay');
    if (invoiceMsats !== amountMsats) throw new Error(`Invoice is for ${Math.round(invoiceMsats/1000)} sats but you approved ${amountSats} — refusing to pay`);

Both branches must throw, not warn: the amountless case is the more dangerous one, because the wallet would then pick the amount itself.

While there, reuse the new decoder at EngagementBar.tsx:118 and NoteCard.tsx:1252, whose ad-hoc `/lnbc(\d+)([munp]?)/` regexes are both wrong for `lntb`/`lnbcrt` invoices and silently mis-scale — one implementation, three call sites.

### ✅ FIXED — A malformed kind-6/16 repost crashes the entire feed render — getNoteCategories dereferences `.tags` on an arbitrary JSON object
- **area**: `error-handling-edge` · **platforms**: core, web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/core/src/noteCategories.ts:113`, `packages/core/src/noteCategories.ts:118`, `packages/core/src/noteCategories.ts:71`, `packages/web/src/pages/MultiColumnClient.tsx:3037`, `packages/mobile/src/screens/HomeScreen.tsx:293`, `packages/core/src/noteCategories.ts:317`
- **detail**: `getNoteCategories` reconstructs a repost's target from the embedded JSON with an unchecked cast:
```ts
if (!targetEvent && (event.kind === 6 || event.kind === 16) && event.content?.startsWith('{')) {
  try { targetEvent = JSON.parse(event.content) as NostrEvent; } catch { /* not JSON */ }
}
```
The `try` only guards the *parse*. `{"a":1}` parses fine and yields an object with no `tags`. Two lines later:
```ts
if (event.kind === 21 || … || (targetEvent && hasVideoContent(targetEvent))) {
```
and `hasVideoContent` (line 71) does `note.tags.some(t => …)` — `undefined.some` → TypeError. `hasImageContent` (line 81) has the identical dereference on the next branch.

The call sites are inside render-path `.filter()` callbacks with no try/catch and no error boundary between them and the feed: `MultiColumnClient.tsx:3036-3037` (`filteredNotes = filteredNotes.filter(note => { const cats = getNoteCategories(note, eventLookup); … })`) and `HomeScreen.tsx:292-293`. `computeNoteKindStats` (noteCategories.ts:317) is a third unguarded caller.
- **failure**: Anyone publishes a kind-6 with `content` = `{"id":"deadbeef"}` (a shape several clients actually emit — id-only stub reposts — and trivially forgeable besides). The note reaches a corkboard whose kind filters are on (`kindFilters.size > 0`). `hasVideoContent({id:'deadbeef'})` throws inside the `useMemo`, React unwinds, and the whole multi-column client blanks out. Reload re-fetches the same note and blanks again — a persistent denial of service on that corkboard, reproducible against any user who follows the poster or views the relevant hashtag.
- **fix**: Two independent layers in packages/core/src/noteCategories.ts (core, so all three platforms get it from one edit):

(1) Validate before the cast at :113-115, matching the shape check NoteCard.tsx:173 already uses:

    try {
      const p: unknown = JSON.parse(event.content);
      if (p && typeof p === 'object' && Array.isArray((p as NostrEvent).tags) && typeof (p as NostrEvent).content === 'string') {
        targetEvent = p as NostrEvent;
      }
    } catch { /* not JSON */ }

(2) Make the two exported predicates total, since they take `NostrEvent` but are reachable from callers that may hand them a reconstructed object: :71 → `(note.tags ?? []).some(...)`, :82 → `(note.tags ?? []).some(...)`. (`note.content || ''` at :70 and :81 is already safe.)

Do NOT touch lines 188 or 256 as the original fix suggests — I read both; `getRepostHashtags` already guards with `Array.isArray(embedded.tags)` (:190) and `hashtagFeedVerdict` with `typeof embedded?.content === 'string'` (:258).

Regression test belongs in packages/mobile/src/__tests__/core-parity.test.ts, which already exercises computeNoteKindStats (:66): assert `computeNoteKindStats([{ kind: 6, content: '{"id":"deadbeef"}', tags: [], ... }])` returns stats instead of throwing.

### ✅ FIXED — memCache LRU eviction can silently drop a critical key, and idbGetSync has no disk fallback — serializeBackup then records it as null and a restore deletes it
- **area**: `error-handling-edge` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/lib/idb.ts:224`, `packages/web/src/lib/idb.ts:213`, `packages/web/src/hooks/useNostrBackup.ts:310`, `packages/web/src/hooks/useNostrBackup.ts:328`, `packages/web/src/lib/idb.ts:142`
- **detail**: `idbSetSync` evicts the oldest memCache entry when the map is full:
```ts
if (memCache.size >= MAX_MEM_CACHE && !memCache.has(key)) {
  memCache.delete(memCache.keys().next().value!);
}
```
The comment three lines above (idb.ts:219-222) explains precisely why this is dangerous — "A size threshold here would create a sync/IDB read mismatch — idbGetSync would return null for a value that exists on disk, silently breaking every reader" — and then the code does it anyway, one line later.

`idbGetSync` (line 213) is `memCache.get(key) ?? null` with no disk fallback, so an evicted key is indistinguishable from a deleted key. `memCache` exceeds `MAX_MEM_CACHE` (2000) easily: `profileCache.setCachedProfile` writes one `profile-cache:<pubkey>` entry per author through `idbSet`, which mirrors to memCache with no bound (line 142), and startup loads all of them back (line 322-330). Eviction order is Map insertion order, which after startup is IDB key order — and the critical keys (`collapsed-notes`, `corkboard:*`, `dismissed-notes`, `nostr-bookmark-ids`, `nostr-custom-feeds`) all sort *before* `profile-cache:*`, so they are the first things evicted.

The consequence is in the backup path:
```ts
function serializeBackup(): string {
  const data: Record<string, string | null> = {};
  for (const key of BACKED_UP_KEYS) data[key] = idbGetSync(key);
  return JSON.stringify(data);
}
```
and on the way back, `deserializeBackup` treats null as "delete": `if (value === null || value === undefined) { idbRemoveSync(key); continue; }` (line 328-330).
- **failure**: A user who has browsed enough to cache 2000+ profiles logs in on a second account. `idbSetSync('corkboard:backup-checked:<pubkey>', 'true')` is a new key, so the eviction branch fires and drops the lexicographically-first survivor — say `nostr-bookmark-ids`. Nothing in the auto-save regression guard covers bookmarks (see the separate finding), so the next auto-save runs, `serializeBackup()` records `"nostr-bookmark-ids": null`, and the cloud backup now says the user has no bookmarks. When that backup is later restored on any device, `deserializeBackup` calls `idbRemoveSync('nostr-bookmark-ids')` and the bookmark list is deleted from disk.
- **fix**: Three changes, in priority order.
(1) Make serializeBackup incapable of emitting a false null: convert it to `async function serializeBackup(): Promise<string>` and use `await idbGet(key)` (which reads disk — idb.ts:120-127) for each BACKED_UP_KEY. Both call sites (useNostrBackup.ts:833 and :631) are already inside async functions. This alone breaks the data-loss chain regardless of eviction.
(2) Delete the eviction blocks at idb.ts:223-227 and idb.ts:243-246 outright. The comment immediately above the first one (idb.ts:219-222) and the one at idb.ts:317-321 both state the invariant — memCache is the synchronous source of truth and must mirror disk — and neither block can honour it. Bound what actually grows instead: give profileCache.ts an LRU/TTL prune over `profile-cache:*` (getAllCachedProfilePubkeys + removeCachedProfile already exist at profileCache.ts:158-168) run on idbReady, plus the shouldSkipMemCache guard from the previous finding so feed blobs stop counting toward the size at all.
(3) Belt-and-braces for restore: in deserializeBackup (useNostrBackup.ts:327-330), do not treat a missing key as a delete instruction. Skip null values rather than calling idbRemoveSync — a key absent from a backup should mean 'unknown', not 'the user cleared it'. Deletion should only ever come from an explicit local user action.

### ☐ OPEN — Zap receipts (kind 9735) are displayed without any NIP-57 Appendix F validation — forged zaps, amounts and senders
- **area**: `nostr-protocol` · **platforms**: web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useNotifications.ts:93`, `packages/web/src/hooks/useNotifications.ts:106`, `packages/web/src/pages/MultiColumnClient.tsx:2794`, `packages/web/src/pages/MultiColumnClient.tsx:2932`, `packages/mobile/src/hooks/useNotifications.ts:92`, `packages/mobile/src/hooks/useNoteEngagement.ts:58`
- **detail**: NIP-57 Appendix F states zaps "MUST be validated": the receipt's `pubkey` MUST equal the recipient's lnurl provider's `nostrPubkey`, and the bolt11 `invoiceAmount` MUST equal the zap request's `amount` tag. None of that happens anywhere.

`getZapSenderPubkey` (useNotifications.ts:93-103) simply `JSON.parse`s the `description` tag and trusts `zapRequest.pubkey` — it never verifies the embedded kind-9734's signature, never checks the receipt author against the recipient's lnurl `nostrPubkey`, and never checks `SHA256(description)` against the bolt11 description hash.

`getZapAmountSats` (useNotifications.ts:106-132) *prefers* the receipt's own `amount` tag — which is not even a NIP-57 receipt field — over the zap request's amount, and never parses the bolt11 to cross-check.

The zap counts and totals in `MultiColumnClient.tsx:2794-2803 / 2932 / 2965` and mobile `useNoteEngagement.ts:58-88` come straight from a `{kinds:[9735], '#e':[...]}` filter with no author or content validation at all.
- **failure**: Attacker publishes `{kind:9735, tags:[["p","<victim>"],["e","<victim's note>"],["amount","100000000000"],["bolt11","lnbc1"],["description","{\"pubkey\":\"<a whale's pubkey>\",\"kind\":9734,\"tags\":[[\"amount\",\"100000000000\"]]}"]], content:""}` to nos.lol. The victim's notification panel shows "<Whale> zapped you 100,000,000 sats", and the note's zap badge inflates by the same amount. Repeat at zero cost to fabricate arbitrary social proof or grief the zap leaderboard.
- **fix**: Add `packages/core/src/zapReceipt.ts` with `validateZapReceipt(receipt, {expectedRecipient, lnurlNostrPubkey?})`: (1) `verifyEvent` the receipt; (2) parse the `description` tag, `verifyEvent` the embedded kind-9734 and require `kind===9734`; (3) require the 9734's `p` tag === the receipt's `p` tag; (4) decode the `bolt11` tag and require its amount === the 9734's `amount` tag and its description hash === `sha256(description)`; (5) when the recipient's lnurl `nostrPubkey` is known (cache it from `useZap` step 1 / a profile-keyed cache), require `receipt.pubkey === nostrPubkey`. Take the displayed amount and sender only from the validated 9734, never from the receipt's own `amount` tag. Drop receipts that fail. Wire it into `useNotifications`, `MultiColumnClient` zap aggregation and mobile `useNoteEngagement`.

### ☐ OPEN — Zap invoice amount is never checked against the requested amount before it is handed to NWC pay_invoice
- **area**: `nostr-protocol` · **platforms**: web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useZap.ts:97`, `packages/web/src/hooks/useZap.ts:105`, `packages/web/src/hooks/useNwc.tsx:133`
- **detail**: `useZap` computes `amountMsats = amountSats * 1000`, checks it against the server-supplied `minSendable`/`maxSendable` (useZap.ts:53-58) — values from the same untrusted JSON — then requests the invoice and pays whatever comes back:

```js
const bolt11 = invoiceData.pr;
if (!bolt11) throw new Error('No invoice returned from LNURL service');
await payInvoice(bolt11);
```

The bolt11 amount field is never decoded or compared to `amountMsats`. `useNwc.payInvoice` (useNwc.tsx:133-149) forwards it verbatim: `JSON.stringify({ method: 'pay_invoice', params: { invoice: bolt11 } })`. NWC `pay_invoice` on an amount-bearing invoice pays the invoice amount, not any client-side cap. The endpoint itself is derived from an attacker-controllable kind-0 `lud16`/`lud06` (the file's own SSRF comment acknowledges this untrust boundary), so the invoice issuer is not necessarily the user's counterparty of choice.
- **failure**: User taps "zap 21 sats" on a note whose author set `lud16: evil@attacker.tld`. `https://attacker.tld/.well-known/lnurlp/evil` returns `{allowsNostr:true, nostrPubkey:"…", callback:"https://attacker.tld/cb", minSendable:1, maxSendable:100000000000}`; the callback returns a bolt11 for 500,000 sats. corkboards passes it to NWC, the wallet pays 500,000 sats, and the UI reports "Payment complete!". No dialog ever showed a number other than 21.
- **fix**: Decode the bolt11 amount (the `lnbc<amount><multiplier>` HRP — a ~20-line pure decoder fits alongside the existing bech32 code in `packages/core/src/zap.ts`) and throw before paying unless `invoiceMsats === amountMsats`. Also reject zero-amount ('any') invoices in the zap path. Apply the same check in the mobile zap flow.

### ☐ OPEN — NIP-65 read/write markers are discarded — the outbox model routes reads and writes to the wrong relays
- **area**: `nostr-protocol` · **platforms**: web, mobile, desktop, core · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useNip65Relays.ts:62`, `packages/web/src/hooks/useNip65Relays.ts:99`, `packages/mobile/src/hooks/useNip65Relays.ts:44`, `packages/mobile/src/hooks/useNip65Relays.ts:66`, `packages/web/src/lib/fetchEvent.ts:143`, `packages/web/src/components/NostrProvider.tsx:419`
- **detail**: NIP-65: "When downloading events **from** a user, clients SHOULD use the **write** relays of that user. When downloading events **about** a user … use the user's **read** relays." Every read path here throws the marker away:

```js
// useNip65Relays.ts:62-65 (and :99-102, mobile :44-47 / :66-69)
const relays = event.tags
  .filter(([name, url]) => name === 'r' && isValidRelayUrl(url))   // t[2] marker ignored
  .map(([, url]) => url as string)
```

`fetchEvent.ts:143-146` does the same (`t[0] === 'r' && t[1]?.startsWith('wss://')`). The single flattened list is then fed to welshman as *both* inbox and outbox: `NostrProvider.tsx:419-424` — `getPubkeyRelays: (pubkey, _mode) => …` explicitly drops the mode with the comment "outbox NIP-65 lists are the union"; mobile `NostrProvider.tsx:389` doesn't even accept a mode parameter.

Note the app *publishes* the markers correctly (`RelayListManager.tsx:130-134` web, `:94-96` mobile), so this is a one-sided read bug, not a data-model gap.
- **failure**: Author Alice publishes `[["r","wss://alice-write.example","write"],["r","wss://inbox.example","read"]]`. `selectFeedRelays` counts `wss://inbox.example` as outbox coverage for Alice and may spend one of the 12 `MAX_FEED_RELAYS` slots on it, while a relay that actually holds Alice's notes is ranked out — her notes silently go missing from the follows feed. Symmetrically, `eventRouter` publishes a reply that p-tags Alice to her write-only relay, which she never reads, so she is never notified.
- **fix**: Return structured entries from the kind-10002 parser: `{url, read: t[2]!== 'write', write: t[2] !== 'read'}` (no marker ⇒ both). Store both lists in `relayCache` (bump the persisted IDB schema / version the key). In `Router.configure({getPubkeyRelays: (pubkey, mode) => …})` honor the mode: return write relays for `read`/outbox scenarios and read relays for `inbox`/`PublishEvent` recipient scenarios. Have `selectFeedRelays` rank only authors' **write** relays. Apply identically in `packages/mobile/src/lib/NostrProvider.tsx` and `packages/web/src/lib/fetchEvent.ts:143`.

### ✅ FIXED — idb init loads the entire key-value store into memCache with no size cap, while writes think the cap is 2000
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/lib/idb.ts:322`, `packages/web/src/lib/idb.ts:20`, `packages/web/src/lib/idb.ts:224`, `packages/web/src/lib/profileCache.ts:16`, `packages/web/src/lib/idb.ts:141`, `packages/web/src/lib/idb.ts:152`
- **detail**: ```ts
const all = await idbGetAll();          // idb.ts:322 — getAllKeys() + getAll() over the WHOLE store
for (const [k, v] of all) {
  if (k.startsWith('custom-feed-cache:')) continue;
  if (k === 'corkboard:last-backup-data') continue;
  memCache.set(k, v);                   // :329 — no MAX_MEM_CACHE check
}
```
`MAX_MEM_CACHE = 2000` (:20) is only enforced in `idbSetSync` (:224) and `idbPrimeCache` (:244). The store also holds one entry per cached profile — `profileCache.ts:16` writes keys prefixed `profile-cache:` into this same `corkboard`/`kv` store — so the boot-time read pulls every profile the user has ever seen into JS memory.
- **failure**: A user with 8,000 cached profiles: `idbGetAll()` structured-clones ~8,000 JSON strings (~2.5 MB) onto the main thread at boot before `idbReady` resolves, and `memCache` permanently holds 8,000+ entries. Later `idbSetSync` calls see `memCache.size >= 2000` and evict `memCache.keys().next().value` — the *first-inserted* key from the boot load, which is arbitrary and may be a hot key like `dismissed-notes`, causing `idbGetSync` to return null for a key that exists on disk.
- **fix**: 1) Remove the size-cap eviction from idbSetSync (idb.ts:224-227) and idbPrimeCache (idb.ts:245-249) — it can silently drop an on-disk key from memCache and corrupt the next backup. 2) Instead, keep memCache small by never admitting profile blobs: add `k.startsWith('profile-cache:')` to the skip list in the init loop (idb.ts:325-328) AND to the mirror in idbSet (idb.ts:141, :152) — safe, because profileCache.ts only reads via async `idbGet`/`idbKeys` (grep confirms no idbGetSync caller uses that prefix). 3) Harden the blast radius regardless: make serializeBackup async and fall back to `await idbGet(key)` when `idbGetSync(key)` returns null, and make deserializeBackup treat null as 'leave untouched' rather than `idbRemoveSync` unless the key was explicitly cleared.

### ✅ FIXED — useMuteList.mute() republishes a one-entry kind 10000 when the mute list can't be fetched, wiping every mute and the encrypted private section
- **area**: `race-conditions` · **platforms**: web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useMuteList.ts:92`, `packages/web/src/hooks/useMuteList.ts:79`, `packages/mobile/src/hooks/useMuteList.ts:90`
- **detail**: `unmute` correctly refuses to act on an unconfirmed list:

```js
const base = await resolveMuteBase();
if (!base) throw new Error('Could not confirm mute list; unmute aborted to avoid data loss');
```

`mute` does the opposite — it treats `null` as "empty list":

```js
const base = await resolveMuteBase();
const existing = base?.tags ?? muteEvent?.tags ?? [];
if (existing.some(t => t[0] === 'p' && t[1] === pubkey)) return;
await publishMuteList([...existing, ['p', pubkey]], base?.content);
```

`resolveMuteBase` returns `null` when the fresh 8s query throws AND `muteEvent` is nullish (its `catch` at line 69-71 explicitly falls through). `muteEvent` is nullish whenever the query hasn't run — on web it is gated by `useMuteList(profileFetchEnabled)` (`MultiColumnClient.tsx:214`), and `profileFetchEnabled` starts `false`. `publishMuteList` then signs `kind: 10000` with `content: base?.content ?? muteEvent?.content ?? ''`, i.e. `''`, so the NIP-51 encrypted private-mute blob is destroyed too. `queryClient.setQueryData(queryKey, event)` immediately makes the UI reflect the truncated list. This is byte-for-byte identical on mobile (`packages/mobile/src/hooks/useMuteList.ts:90-99`).
- **failure**: User has 80 muted pubkeys plus a private (encrypted) mute section. They open a profile while their relays are flaky. `resolveMuteBase`'s query times out after 8s; `muteEvent` is `undefined` because `profileFetchEnabled` was still false when the mount query was skipped. `base` is `null` → `existing = []` → `publishMuteList([['p', target]], undefined)` publishes a kind 10000 with one tag and empty content. All 80 public mutes and the entire encrypted private list are replaced on every relay.
- **fix**: Make `mute` symmetric with `unmute`: `const base = await resolveMuteBase(); if (!base) throw new Error('Could not confirm mute list; mute aborted to avoid data loss');` and build from `base.tags`/`base.content` only. Allow an empty base only when a relay actually responded with zero kind-10000 events (add a `confirmedEmpty` flag to `resolveMuteBase`, same fix shape as the kind-3 issue). Apply to web and mobile together.

### ☐ OPEN — loadCheckpoint never sets isRestoring, so a visibilitychange auto-save can upload a half-restored IDB state as the canonical cloud autosave
- **area**: `race-conditions` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useNostrBackup.ts:1637`, `packages/web/src/hooks/useNostrBackup.ts:1691`, `packages/web/src/hooks/useNostrBackup.ts:777`, `packages/web/src/hooks/useAutoSaveTrigger.ts:121`, `packages/web/src/hooks/useAutoSaveTrigger.ts:142`
- **detail**: `autoSaveBackup`'s only concurrency guard is `if (!user || isSaving.current || isRestoring.current) return 'skipped';` (line 777). `loadRemoteBackup` sets `isRestoring.current = true` (line 1349), but `loadCheckpointFn` — the function `useAutoRestoreGuard` and `useAutoRestoreCountdown` both call automatically, and the Checkpoints dialog calls manually (`MultiColumnClient.tsx:917`, `:971`, `:4806`) — never touches `isRestoring` anywhere in its 90-line body (1637-1728).

The only other gate is `useAutoSaveTrigger`'s `triggerIfReady`, which does check `backupStatus === 'restoring'` (line 64). But the two event handlers bypass `triggerIfReady` entirely and call `autoSaveBackup()` directly with no status check:

```js
const onVisibilityChange = () => {
  if (document.visibilityState === 'hidden') {
    if (hasUnsavedChanges() && pastCooldown) autoSaveBackup()...  // no backupStatus check
const onBeforeUnload = () => {
  if (hasUnsavedChanges() && ...) autoSaveBackup()...             // no backupStatus check
```

`hasUnsavedChanges()` is guaranteed true mid-restore: it hashes the live `SNAPSHOT_KEYS` against `corkboard:last-backup-hashes`, and `persistSnapshotAndHashes` is only called AFTER `deserializeBackup` returns (line 1695-1697). Mobile's `restoreBackup` does set `isRestoring` (`packages/mobile/src/hooks/useNostrBackup.ts:791`), so this is also a platform-parity gap.
- **failure**: On launch `useAutoRestoreGuard` fires `loadCheckpointFn(best)`. The Blossom download takes ~12s (15s timeout) and `deserializeBackup` then writes ~90 keys with awaited `idbSet` calls. At second 10 the user switches browser tabs → `visibilitychange: hidden` → `hasUnsavedChanges()` is true (hashes don't match yet), `pastCooldown` is true → `autoSaveBackup()` runs, sees `isSaving=false` and `isRestoring=false`, and calls `serializeBackup()`, which snapshots an IDB where `nostr-custom-feeds` has already been overwritten by the checkpoint but `collapsed-notes`/`dismissed-notes` have not. That Frankenstein blob is uploaded to Blossom, published as the `corkboard:backup:auto` manifest (now the newest event on every relay), and `persistSnapshotAndHashes` stamps it as the saved state. The next device to auto-restore pulls the corrupt mix.
- **fix**: In `loadCheckpointFn`, set `isRestoring.current = true` as the first statement and clear it in a `finally` block (mirroring `loadRemoteBackup` at lines 1349/1566). Additionally, in `useAutoSaveTrigger`, add the same `backupStatus === 'found' | 'restoring' | 'restored'` early-return to `onVisibilityChange` and `onBeforeUnload` that `triggerIfReady` has, so neither handler can fire during a restore.

### ☐ OPEN — useLocalStorage lost update: every NoteCard mounts its own useCollapsedNotes instance, and cross-instance sync only lands after the async IDB write resolves
- **area**: `race-conditions` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useLocalStorage.ts:73`, `packages/web/src/hooks/useLocalStorage.ts:89`, `packages/web/src/lib/idb.ts:232`, `packages/web/src/lib/idb.ts:344`, `packages/web/src/hooks/useCollapsedNotes.ts:90`, `packages/web/src/components/NoteCard.tsx:583`
- **detail**: `useLocalStorage.setValue` computes the next value from its own per-instance `stateRef.current` and writes the WHOLE array:

```js
const next = value instanceof Function ? value(stateRef.current) : value;
stateRef.current = next; setState(next); persistToIdb(serialize(next));
```

Other instances only learn about the write via the `idb-storage-sync` event, and `idbSetSync` dispatches that event **after** the async IDB round-trip completes:

```js
idbSet(key, value).then(() => dispatchSyncEvent(key, tryParse(value)), ...);
```

Between the write and the event, every other instance's `stateRef` is stale, and the sync handler does a full replace (`setState(next)`), never a merge. `useCollapsedNotes()` — which owns `collapsed-notes` and `dismissed-notes`, two of the most data-loss-sensitive keys — is instantiated **once per rendered NoteCard** (`NoteCard.tsx:583`), plus `NotificationCard.tsx:195`, `SavedForLaterCorkboard.tsx:38`, `NotificationsCorkboard.tsx`, and `MultiColumnClient.tsx:723`. The same hazard exists across browser tabs via the BroadcastChannel handler (`idb.ts:344-352`), which also replaces rather than merges.
- **failure**: A grid shows 60 NoteCards, all holding `collapsedIds = [A]`.
- t=0ms: user clicks save-for-later on card #5 → instance-5 `collapse('N5')` → `[A, N5]` → `idbSetSync` → memCache `[A,N5]`, IDB transaction starts.
- t=15ms: user clicks save-for-later on card #12 (or an autoscroll batch action fires). Instance-12's `stateRef` is still `[A]` because no sync event has landed → it writes `[A, N12]` → memCache `[A,N12]`, second transaction starts.
- t=25ms: transaction 1 commits → `dispatchSyncEvent('collapsed-notes', [A,N5])` → all 60 instances `setState([A,N5])`.
- t=35ms: transaction 2 commits → `dispatchSyncEvent([A,N12])` → all instances `setState([A,N12])`. Disk holds `[A,N12]`.

N5 is silently dropped from the saved-for-later list. In the two-tab variant the tabs additionally diverge permanently (tab A ends on `[A,N12]`, tab B on `[A,N5]`) and ping-pong-overwrite each other's corkboards, since `nostr-custom-feeds` (`MultiColumnClient.tsx:1130`) uses the same hook.
- **fix**: Give `useLocalStorage` a single source of truth per key instead of N independent React states: keep the authoritative value in a module-level registry keyed by storage key, have `setValue` apply the updater against the registry (not the per-instance `stateRef`) under a synchronous critical section, and have all instances subscribe via `useSyncExternalStore`. Dispatch `dispatchSyncEvent` synchronously from `idbSetSync` (before the async `idbSet` resolves) so in-tab instances converge immediately. For cross-tab, either add a set-merge for array-valued keys or serialize cross-tab writes with a per-key lock/lamport counter so the loser re-applies its delta instead of being replaced.

### ☐ OPEN — Concurrent follow/unfollow clicks are unserialized read-modify-writes on kind 3 — the second publish clobbers the first
- **area**: `race-conditions` · **platforms**: web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useContactActions.ts:30`, `packages/web/src/pages/MultiColumnClient.tsx:2296`, `packages/mobile/src/screens/ProfileScreen.tsx:158`, `packages/mobile/src/components/ProfileModal.tsx:186`, `packages/core/src/keyedMutex.ts:10`
- **detail**: `safeUpdateContacts` is `fetch authoritative kind-3 → mutate → publish` with an ~8-second network window in the middle and no mutual exclusion:

```js
const base = await resolveContactBase(nostr, user.pubkey, contacts, ...);  // up to 8s
const result = applyContactChange(base, op);
createEvent({ kind: 3, content: result.content, tags: result.tags });      // fire-and-forget mutate
queryClient.setQueryData(['contacts', user.pubkey], result.pubkeys);
```

Nothing prevents a second invocation from entering while the first is awaiting. `createEvent` is `mutate` (not `mutateAsync`), so the caller doesn't even await the publish. The repo already ships `withKeyedLock` in `packages/core/src/keyedMutex.ts` for exactly this hazard, but grep shows it is only used in `useCustomFeedNotesCache.ts` — never for kind 3, 10000, or 10001. Mobile has the identical unlocked pattern in `ProfileScreen.tsx:158` and `ProfileModal.tsx:186`, and the two files can even race each other (modal over screen).
- **failure**: User rapidly follows two accounts from the Discover grid (or clicks Follow on a profile card and then a second one ~1s later).
- Click 1 at t=0: `resolveContactBase` returns the authoritative list L (N entries) at t=800ms; publishes L+X with `created_at = T`.
- Click 2 at t=500: its own `resolveContactBase` query was issued before click 1's event reached the relays, so it also returns L; at t=1300 it publishes L+Y with `created_at = T` (same second) or T+1.

Both are kind 3, so relays keep exactly one. Per NIP-01 the higher `created_at` wins, or on a tie the lower id — either way one of X or Y is discarded. The UI shows both as followed because each call did `queryClient.setQueryData` with its own result, so the loss is invisible until the next reload. With unfollow the same interleaving resurrects a just-removed follow.
- **fix**: Wrap the whole fetch→apply→publish section in `withKeyedLock(`contacts:${pubkey}`, ...)` from `@core/keyedMutex`, and switch `createEvent` to `mutateAsync` so the lock is held until the publish settles (otherwise the next waiter re-fetches before the relay has the new event). Do the same for kind 10000 in `useMuteList` (key `mute:${pubkey}`) and kind 10001 in `usePinnedNotes` (key `pins:${pubkey}`). Apply identically in `packages/mobile/src/screens/ProfileScreen.tsx` and `packages/mobile/src/components/ProfileModal.tsx` so the two mobile entry points share one lock.

### ☐ OPEN — A key evicted from the IDB memCache is serialized into the backup as null, and restoring that backup deletes the key from disk
- **area**: `race-conditions` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useNostrBackup.ts:310`, `packages/web/src/hooks/useNostrBackup.ts:326`, `packages/web/src/hooks/useNostrBackup.ts:789`, `packages/web/src/lib/idb.ts:224`
- **detail**: `serializeBackup` reads every backed-up key through the synchronous memCache only:

```js
for (const key of BACKED_UP_KEYS) data[key] = idbGetSync(key);
```

`idbGetSync` returns `null` both for "absent on disk" and for "evicted from memCache" — there is no async fallback here (unlike `useLocalStorage.ts:47-52` and `useAutoRestoreGuard.ts:51-53`, which both explicitly guard against exactly this). `deserializeBackup` then treats `null` as a deletion instruction:

```js
if (value === null || value === undefined) { idbRemoveSync(key); continue; }
```

So an eviction at save time becomes a permanent delete at restore time. `autoSaveBackup`'s regression guards (lines 803-826) only cover three keys — `dismissed-notes`, `nostr-custom-feeds`, `collapsed-notes`. The other ~20 shared backed-up keys have no guard at all, including `corkboard:nwc` (the Nostr Wallet Connect string), `nostr-friends`, `nostr-rss-feeds`, `nostr-browse-relays`, `nostr-bookmark-ids`, `nostr-pinned-note-ids`, `corkboard:tab-filters`, and `saved-minimized-notes`.
- **failure**: memCache is over 2000 entries (see the profile-cache growth path in finding #1). During the session a handful of new keys are written via `idbSetSync` — `corkboard:backup-checked:<pubkey>`, `corkboard:device-id`, `nostr-bookmarks-migrated`, `dismissed-thread-roots` — each evicting the first-inserted entry. `nostr-rss-feeds` and `corkboard:nwc` fall out of memCache. 30 seconds later the auto-save poll fires: `hasMeaningfulData` passes (feeds/dismissed/collapsed are all intact), the three regression guards pass, and `serializeBackup()` emits `{"nostr-rss-feeds": null, "corkboard:nwc": null, ...}`. That blob is uploaded and becomes the newest `:auto` checkpoint. The user later restores it on a new device (or `useAutoRestoreGuard` auto-restores it) → `deserializeBackup` calls `idbRemoveSync('nostr-rss-feeds')` and `idbRemoveSync('corkboard:nwc')`, deleting the RSS feed list and the wallet connection.
- **fix**: Make `serializeBackup` async and read `idbGetSync(key) ?? await idbGet(key)` for every key, matching the defensive pattern already used in `useLocalStorage` and `useAutoRestoreGuard`. Separately, make `deserializeBackup` conservative: only honour an explicit deletion when the manifest's `keys` array proves the key was intentionally absent (`manifest.keys` is already computed at lines 640/853 as `BACKED_UP_KEYS.filter(k => idbGetSync(k) !== null)`); otherwise skip nulls instead of removing. Also enforce `MAX_MEM_CACHE` consistently in `idb.ts` (see finding #1).

### ☐ OPEN — Mobile useCollapsedNotes keeps collapsed/dismissed lists in per-instance useState with no cross-instance sync — concurrent card writes silently drop each other's entries from MMKV
- **area**: `react-correctness` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/hooks/useCollapsedNotes.ts:63`, `packages/mobile/src/hooks/useCollapsedNotes.ts:72`, `packages/mobile/src/hooks/useCollapsedNotes.ts:97`, `packages/mobile/src/components/NotificationCard.tsx:89`, `packages/mobile/src/screens/SavedScreen.tsx:39`, `packages/mobile/src/screens/SettingsScreen.tsx:93`
- **detail**: Mobile seeds the three persisted lists from MMKV once per hook instance:

```ts
const [collapsedIds, setCollapsedIdsState] = useState<string[]>(() => loadFromMmkv(COLLAPSED_KEY));
const [dismissedIds, setDismissedIdsState] = useState<string[]>(() => loadFromMmkv(DISMISSED_KEY));
const [dismissedThreadRoots, setDismissedThreadRootsState] = useState<string[]>(() => loadFromMmkv(DISMISSED_THREAD_ROOTS_KEY));
```

and writes them with a read-modify-write against that instance's own `prev`:

```ts
const setCollapsedIds = useCallback((updater) => {
  setCollapsedIdsState(prev => {
    const next = typeof updater === 'function' ? updater(prev) : updater;
    saveToMmkv(COLLAPSED_KEY, next);   // full-array overwrite
    return next;
  });
}, []);
```

The module-level `listeners` broadcast (line 36 `notifyListeners`, subscribed at line 97-105) only refreshes `_softDismissedSet`, `undoMapVersion` and `_sessionCollapsedCounter`. It never re-reads `COLLAPSED_KEY` / `DISMISSED_KEY` / `DISMISSED_THREAD_ROOTS_KEY`, so a second live instance keeps its stale snapshot forever. Web avoids this because it routes the same three lists through `useLocalStorage`, which re-reads on the `idb-storage-sync` event (packages/web/src/hooks/useCollapsedNotes.ts:90-95).

This is not theoretical: `NotificationCard` calls `useCollapsedNotes()` per card (line 89) and is rendered inside a FlatList (`packages/mobile/src/screens/NotificationsScreen.tsx:221`), so dozens of independent instances are mounted simultaneously, each holding its own copy of `collapsedIds`. `SavedScreen` and `SettingsScreen` hold two more.
- **failure**: User opens Notifications with 20 NotificationCards mounted; every card seeded `collapsedIds = ['a']`. User taps save on card #1 → its state becomes `['a','x']`, MMKV = `['a','x']`. User taps save on card #7, whose `prev` is still `['a']` → next = `['a','y']` → `saveToMmkv(COLLAPSED_KEY, ['a','y'])`. Note `x` is now gone from MMKV and from the Saved screen permanently. Same loss applies to `dismissed-notes` (dismiss progress) and to `SettingsScreen`'s `clearDismissed`/`undismissMany`, which write from a snapshot taken at screen mount.
- **fix**: Route `collapsed-notes`, `dismissed-notes` and `dismissed-thread-roots` through packages/mobile/src/hooks/useLocalStorage.ts, replacing the three `useState` + `saveToMmkv` pairs at useCollapsedNotes.ts:63-94. That hook already emits `DeviceEventEmitter.emit('mobile-storage-sync', {key, originId})` on write (useLocalStorage.ts:59) and re-reads MMKV in every other subscriber for the same key (:66-80), with self-echo suppression — the exact mechanism web relies on. Note the subtlety the finder missed: `useLocalStorage`'s `setValue` resolves the updater against `stateRef.current` (:47), not React state, so back-to-back calls within one instance are also correct. Do the same for packages/mobile/src/hooks/useBookmarks.ts:45-52/68-74 (see extraFiles) — there the stale write also propagates to the relay via `publishBookmarkList`, so it is strictly worse.

### ☐ OPEN — macOS: WebView proxy is silently ignored (mac-proxy feature not enabled), but the code marks it "proxied" and the UI tells a Tor user they are protected
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/lib.rs:38`, `packages/desktop/src-tauri/src/lib.rs:43`, `packages/desktop/src-tauri/src/lib.rs:59`, `packages/desktop/src-tauri/Cargo.toml:15`, `packages/web/src/components/AdvancedSettings.tsx:634`
- **detail**: `lib.rs` sets `webview_proxied = true` purely on the basis that `url::Url::parse` succeeded:

```rust
match url::Url::parse(&webview_proxy) {
    Ok(parsed) => {
        builder = builder.proxy_url(parsed);
        webview_proxied = true;
    }
```

It never checks whether the platform actually honours `proxy_url`. I traced the dependency chain in the vendored sources: `tauri::WebviewWindowBuilder::proxy_url` documents "**macOS**: Requires the `macos-proxy` feature flag" (tauri-2.10.3/src/webview/webview_window.rs:1062-1067), which maps to `tauri-runtime-wry/macos-proxy` -> `wry/mac-proxy` (tauri-2.10.3/Cargo.toml:109, tauri-runtime-wry-2.10.1/Cargo.toml:50). In wry-0.54.4/src/wkwebview/mod.rs:326 the entire proxy-application block is behind `#[cfg(feature = "mac-proxy")]`. This crate declares `tauri = { version = "2", features = [] }` — `macos-proxy` is NOT enabled — so on macOS the `ProxyConfig` is compiled out and dropped on the floor. It still compiles and runs; it just does nothing.

Consequence: `unprotected = proxy::proxy_required() && !webview_proxied` evaluates to `false` on macOS, `set_webview_unprotected(false)` is latched, and `proxy_webview_unprotected()` returns `false`. `AdvancedSettings.tsx` therefore suppresses the red "⚠ Proxy is REQUIRED but this session's window is NOT proxied" banner and instead shows the green "Active: socks5h://… (native relay sockets live; WebView traffic after restart)" line. The one platform where the warning is most needed is the one platform where it is guaranteed never to fire.
- **failure**: macOS user sets `socks5h://127.0.0.1:9050` and turns on "require proxy", restarts, and sees the green "Active" indicator and no warning. Every image, embed, `<iframe>`, favicon and JS-opened WebSocket in WKWebView goes out over the clearnet with their real IP. Loading any note containing an attacker-hosted image URL deanonymizes them instantly.
- **fix**: Two independent changes.
(1) packages/desktop/src-tauri/Cargo.toml:15 → `tauri = { version = "2", features = ["macos-proxy"] }`. Note this pulls in wry's `mac-proxy`, which uses `nw_proxy_config_create_socksv5` — macOS 14+ only — so it must be paired with (2), not used as a substitute for it.
(2) In lib.rs, stop deriving the boolean from parse success. Only Linux/Windows can be asserted at compile time; macOS needs a runtime version gate:
```rust
Ok(parsed) => {
    builder = builder.proxy_url(parsed);
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    { webview_proxied = true; }
    #[cfg(all(target_os = "macos", feature = "macos-proxy"))]
    { webview_proxied = macos_major_version() >= 14; }
    // any other target: leave false (fail closed)
}
```
Also soften AdvancedSettings.tsx:632: the green "Active" line should not claim "WebView traffic after restart" when `webviewUnprotected`/an unproxiable platform is in play — render the coverage clause only when the backend positively confirms WebView coverage. Consider exposing the capability itself (a `proxy_webview_capable` command) rather than only the derived warning, so the UI can state "native relay sockets only" instead of implying full coverage.

### ✅ FIXED — IPv4-mapped IPv6 hosts bypass every SSRF gate — `isPrivateIPv6` only recognises the dotted form that `new URL()` never produces
- **area**: `ssrf-network-egress` · **platforms**: core, web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/core/src/ipUtils.ts:104`, `packages/core/src/ipUtils.ts:115`, `packages/core/src/ipUtils.ts:161`, `packages/core/src/imageUtils.ts:109`, `packages/core/src/nostrUtils.ts:69`, `packages/core/src/zap.ts:82`
- **detail**: `isPrivateIPv6` detects v4-embedding forms purely lexically: `if (bare.includes('.')) { … prefix === '::ffff:' → isPrivateIPv4(embedded) }` (ipUtils.ts:104-113). Its own docstring says the input is "expected to be a `URL.hostname` value" — but the WHATWG URL parser ALWAYS re-serialises an IPv6 literal into compressed hex hextets, so the dotted form never survives parsing and that branch is dead code for every real call site:

  new URL('wss://[::ffff:127.0.0.1]/').hostname       === '[::ffff:7f00:1]'
  new URL('https://[::ffff:169.254.169.254]/').hostname === '[::ffff:a9fe:a9fe]'
  new URL('https://[::ffff:192.168.1.1]/').hostname   === '[::ffff:c0a8:101]'

The hex form then falls through: `firstHextet('::ffff:7f00:1')` returns 0 (the `startsWith('::')` shortcut at line 128), 0 matches none of the fe80/fc00/ff00 ranges, and `isAllZeroExceptLast` returns false because the first group is `ffff` → the function reports **not private**. Verified by running the real `packages/core/src/ipUtils.ts`:

  isUnsafeHost('[::ffff:7f00:1]')    → false
  isUnsafeHost('[::ffff:a9fe:a9fe]') → false   (169.254.169.254, cloud metadata)
  isUnsafeHost('[::ffff:c0a8:101]')  → false   (192.168.1.1)

and the three consumers that depend on it (also run for real):

  shouldRejectUrl('https://[::ffff:127.0.0.1]:8080/probe.png','media')      → false
  shouldRejectUrl('https://[::ffff:169.254.169.254]/latest/meta-data/','avatar') → false
  isSafeZapUrl('https://[::ffff:169.254.169.254]/…')                        → true
  isSecureRelay('wss://[::ffff:127.0.0.1]:4444/')                           → true
  isSecureRelay('wss://[::ffff:10.0.0.5]/')                                 → true

`::ffff:a.b.c.d` really does reach the v4 address — `curl http://[::ffff:127.0.0.1]:18099/` returned 200 from a loopback-bound server on this machine. The tests give false confidence because they feed the hand-written dotted string (`isUnsafeHost('[::ffff:127.0.0.1]')` → true, ipUtils.test.ts:137; `isPrivateIPv6('::ffff:127.0.0.1')` → true, :82) instead of a `new URL(...).hostname`. The same hole covers IPv4-compatible `::7f00:1` and NAT64 `64:ff9b::7f00:1`.
- **failure**: A hostile kind-10002 (NIP-65) relay list or an nprofile/nevent relay hint containing `wss://[::ffff:127.0.0.1]:8080/` passes `isSecureRelay`, so NostrProvider adds it to the routing set and the client opens a WebSocket to the viewer's own localhost (open/close timing = port scan). A note with `https://[::ffff:192.168.1.1]/x.png` passes `shouldRejectUrl`, so `optimizeMediaUrl` emits it and an `<img>` probes the LAN. A profile with `lud06` decoding to `https://[::ffff:169.254.169.254]/…`, or an LNURL server returning that as `callback`, passes `isSafeZapUrl` and the client GETs cloud metadata carrying a signed kind-9734.
- **fix**: The applied fix (packages/core/src/ipUtils.ts:95-202) is correct and goes beyond the proposal: it expands to 8 numeric hextets, fails closed on unparseable input, and covers ::/::1, ::ffff:0:0/96, ::a.b.c.d, 64:ff9b::/96, plus TWO cases the finding omitted — 6to4 2002::/16 (which embeds the v4 address in hextets 1-2, so `[2002:7f00:1::]` reaches 127.0.0.1 through a 6to4 relay) and 100::/64 + 2001:db8::/32. Two sharpenings worth keeping: (a) `expandIPv6` deliberately requires a CANONICAL dotted quad (no inet_aton hex/octal/short forms) inside an IPv6 literal — keep that, since accepting them would make this parser disagree with the resolver; (b) tests must go through `new URL(...).hostname` (packages/web/src/lib/ipUtils.test.ts:165-219 now does this) — the pre-existing tests at :80-82 fed hand-written dotted strings and are what hid the bug for a release cycle. Also mirror the 6to4 branch into the server-side gate (see extraFiles).

### ✅ FIXED — Desktop `validate_relay_url` misses IPv4-mapped/NAT64 IPv6 and allows plaintext `ws://` — native socket to localhost/LAN from an attacker-supplied relay hint
- **area**: `ssrf-network-egress` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/relay.rs:197`, `packages/desktop/src-tauri/src/relay.rs:176`, `packages/desktop/src-tauri/src/relay.rs:233`, `packages/core/src/ipUtils.ts — the JS half of the same predicate (finding 1); the two must be changed together or they drift again.`, `packages/web/rss-proxy.php — third copy of the same block list (`isBlockedIp`), missing 6to4 at HEAD.`
- **detail**: The IPv6 branch checks only `ip.is_loopback() || ip.is_multicast() || ip.is_unspecified()` plus `seg0` in fe80::/10 / fc00::/7 (relay.rs:197-206). Rust's `Ipv6Addr::is_loopback()` is true only for `::1`, so every v4-mapped address slips through. Verified by compiling against `url = "2"` (the crate version in Cargo.toml:24):

  ws://[::ffff:127.0.0.1]:9050/    -> Ipv6(::ffff:127.0.0.1)   loopback=false seg0=0
  wss://[::ffff:169.254.169.254]/  -> Ipv6(::ffff:169.254.169.254) loopback=false seg0=0
  ws://[::ffff:192.168.1.1]/       -> Ipv6(::ffff:192.168.1.1)  loopback=false seg0=0
  ws://[64:ff9b::127.0.0.1]/       -> Ipv6(64:ff9b::7f00:1)     loopback=false seg0=64

All four return `Ok(())` from `validate_relay_url`, so `do_query` (relay.rs:233) dials them from Rust — outside the WebView sandbox and outside the page CSP. And a connect to `::ffff:127.0.0.1` really lands on 127.0.0.1 (confirmed with curl on this box). The function's own doc comment (relay.rs:165-172) claims it "mirrors the JS-side `isSecureRelay`/`isUnsafeHost` gate" — both sides have the same hole (see the core finding), so there is no compensating layer. Separately, line 176 accepts `"ws"` as well as `"wss"`, while the JS gate requires `wss://` (nostrUtils.ts:61), making the native path strictly more permissive: a `ws://` URL that reaches the command sends the user's full Nostr filter (follow graph, hashtags) in cleartext.
- **failure**: Attacker publishes a kind-10002 for a pubkey the desktop user follows containing `wss://[::ffff:127.0.0.1]:6379/`. `getTauriRelaysForFilter` (NostrProvider.tsx:795/809) admits it because `isSecureRelay` returns true, `tauriQuery` forwards it to `relay_subscribe`, `validate_relay_url` accepts it, and Rust opens a TCP/TLS connection to the user's local Redis/admin port. Error strings differ for refused vs. open vs. TLS-mismatch, giving a remote port scan of the desktop user's machine and LAN.
- **fix**: The applied fix is right, with one improvement over the proposal worth preserving: the scheme narrowing keeps a `ws` exception for `.onion` hosts (`ws if is_onion`), because a hidden-service address authenticates and encrypts the endpoint itself and forcing `wss` there would break Tor relays that the desktop build is explicitly built to use — the finding's blanket 'drop ws' would have been a functional regression. Two items the finding missed in the same function: (1) the Domain arm at HEAD:211-214 lowercased but did not strip the root dot, so `wss://localhost./` parsed to the domain `localhost.` and matched neither `== "localhost"` nor `.ends_with(".localhost")` — the same trailing-dot gap as core's `isUnsafeHost`; the working tree adds `trim_end_matches('.')` at relay.rs:~296. (2) 6to4 `2002::/16` is missing from the finding's fix list. There are no Rust unit tests for `validate_relay_url`; add `#[cfg(test)]` cases for `wss://[::ffff:127.0.0.1]/`, `wss://[64:ff9b::7f00:1]/`, `wss://[2002:7f00:1::]/`, `wss://localhost./`, `ws://relay.example/` (reject) and `wss://relay.damus.io/`, `ws://xyz.onion/` (accept).

## MEDIUM (55)

### ☐ OPEN — idbSet unconditionally mirrors every value into memCache, defeating the skip-list that the multi-MB backup blob and per-feed note caches depend on
- **area**: `error-handling-edge` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/lib/idb.ts:142`, `packages/web/src/lib/idb.ts:222`, `packages/web/src/lib/idb.ts:232`, `packages/web/src/lib/idb.ts:242`, `packages/web/src/lib/idb.ts:326`, `packages/web/src/hooks/useNostrBackup.ts:466`
- **detail**: Three call sites deliberately exclude two key classes from the in-memory cache — `idbSetSync` (line 222), `idbPrimeCache` (line 242) and startup population (lines 326-328) all skip `custom-feed-cache:*` and `corkboard:last-backup-data`, with an explicit rationale at useNostrBackup.ts:430-433 ("The full LAST_BACKUP_DATA blob is excluded from memCache because it can grow to several MB").

But `idbSetSync` immediately delegates to `idbSet` (line 232), and `idbSet` has no skip-list at all:
```ts
await wrapRequest(tx(database, 'readwrite').put(value, key));
// Only mirror to memCache on confirmed disk success …
memCache.set(key, value);
```
So `idbSetSync('corkboard:last-backup-data', JSON.stringify(snapshot))` (useNostrBackup.ts:466) skips memCache on line 228 and then puts the exact same multi-megabyte string into memCache on line 142, one microtask later. Same for every `custom-feed-cache:` write that goes through the sync path. `idbSet` also bypasses the `MAX_MEM_CACHE` eviction that `idbSetSync`/`idbPrimeCache` apply, so nothing bounds the map on that path either.
- **failure**: A user with several corkboards triggers an auto-save. `persistSnapshotAndHashes` writes the full snapshot (commonly 2-8 MB of JSON) via `idbSetSync`; the exclusion appears to hold, then `idbSet` resolves and the entire blob is retained in the module-level `memCache` Map for the lifetime of the tab. Every subsequent auto-save replaces it with another multi-MB string. Combined with per-feed note caches taking the same path, the tab's JS heap grows by tens of megabytes that the code believes it has excluded — and on desktop (WebKitGTK) that is exactly the memory pressure the surrounding code elsewhere works hard to avoid.
- **fix**: Add `function shouldSkipMemCache(key: string): boolean { return key.startsWith('custom-feed-cache:') || key === 'corkboard:last-backup-data'; }` in idb.ts and make `idbSet` the single enforcement point: guard BOTH `memCache.set` calls (lines 142 and 147) with it, and delete the now-redundant skip branches in `idbSetSync` (219-228) and `idbPrimeCache` (242-247) so there is exactly one definition. Do NOT move MAX_MEM_CACHE eviction into idbSet — see the next finding; the correct move is to drop eviction entirely and bound `profile-cache:*` instead. Note that fixing this alone leaves `custom-feed-metadata:*` (useCustomFeedNotesCache.ts:370) in memCache, which is fine — those are small.

### ☐ OPEN — Every upload is mirrored to every known Blossom server, not to MIRROR_COPIES of them
- **area**: `error-handling-edge` · **platforms**: web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useUploadFile.ts:43`, `packages/web/src/hooks/useUploadFile.ts:143`, `packages/mobile/src/hooks/useUploadFile.ts:49`, `packages/mobile/src/hooks/useUploadFile.ts:144`
- **detail**: `MIRROR_COPIES = 3` is documented as "Total number of servers we try to land each blob on" (useUploadFile.ts:16-19), and the call site says "Mirror to the remaining servers, but only wait up to MIRROR_GRACE_MS". But `mirrorToServers` launches an upload to **all** of them:
```ts
const results = await Promise.allSettled(
  servers.map(async (server) => {
    const uploader = new BlossomUploader({ servers: [server], signer });
    await withTimeout(uploader.upload(file), UPLOAD_TIMEOUT_MS, server);
    return server;
  })
);
for (const result of results) {
  if (result.status === 'fulfilled') { if (landed >= count) continue; landed++; confirmed.push(result.value); }
}
```
`count` is applied only when tallying `confirmed` — after every upload has already been attempted. The caller passes `others = serverList.filter((_, idx) => idx !== i)`, i.e. the user's kind-10063 servers plus all six `KNOWN_BLOSSOM_SERVERS`. Both platforms are identical.

Each of those uploads is a NIP-98 request carrying an event signed by the user's key, so it is not merely bandwidth — it is an authenticated disclosure of "this pubkey uploaded this blob" to every server in the list.
- **failure**: A user attaches one 8 MB image to a post. The client uploads it 7-9 times (once for the primary landing plus one per remaining server), each with a fresh NIP-98 auth event signed by the user. On a metered mobile connection that is ~60 MB of upload for one attachment, and every Blossom operator in the default list — not just the 3 the code claims — receives the blob and a signed statement linking it to the user's pubkey.
- **fix**: Slice before the fan-out, in both files, and stop after enough land. Minimal correct version, replacing the body of mirrorToServers (web useUploadFile.ts:40-58, mobile useUploadFile.ts:44-62):

```ts
async function mirrorToServers(file: File, servers: string[], count: number, signer: NostrSigner): Promise<string[]> {
  const confirmed: string[] = [];
  for (const server of servers) {
    if (confirmed.length >= count) break;
    try {
      const uploader = new BlossomUploader({ servers: [server], signer });
      await withTimeout(uploader.upload(file), UPLOAD_TIMEOUT_MS, server);
      confirmed.push(server);
    } catch { /* try next */ }
  }
  return confirmed;
}
```

This mirrors uploadBlobWithRedundancy (useNostrBackup.ts:206-231) exactly. Note the interaction with the MIRROR_GRACE_MS race at :140-143: sequential mirroring with a 10s per-server timeout can exceed the 4s grace, and the losing promise keeps running — that is already true today and is fine, but if you want the grace window to be meaningful, bound it with `others.slice(0, MIRROR_COPIES - 1)` at the call site as well so at most 2 extra uploads are ever in flight. Fix the comment at useUploadFile.ts:35-38 ('IN PARALLEL … let the rest settle'), which currently documents the bug as if it were intended.

### ☐ OPEN — Mobile MMKV encryption key is 64 bytes — exceeds the 16-byte AES-128 limit, so at-rest encryption either never engages or has only 64 bits of entropy
- **area**: `key-management-crypto` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/storage/MmkvStorage.ts:75`, `packages/mobile/src/storage/MmkvStorage.ts:112`, `packages/mobile/src/storage/MmkvStorage.ts:122`, `packages/mobile/src/storage/MmkvStorage.ts:146`, `packages/mobile/src/storage/MmkvStorage.ts:53`, `packages/mobile/src/storage/MmkvStorage.ts:56`
- **detail**: `generateEncryptionKey()` returns `Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('')` — a **64-character** hex string (64 ASCII bytes, MmkvStorage.ts:75-79). That string is handed straight to MMKV with no `encryptionType`:

```ts
mmkv = createMMKV({ id: ENCRYPTED_INSTANCE_ID, encryptionKey: key });   // line 122
mmkvIsEncrypted = true;
```

react-native-mmkv v4's own spec documents the limit (`node_modules/react-native-mmkv/src/specs/MMKVFactory.nitro.ts:52`): "Encryption keys can have a maximum length of **16 bytes with AES-128** encryption and 32 bytes with AES-256", with `@default 'AES-128'` for `encryptionType`. The native binding enforces it (`node_modules/react-native-mmkv/cpp/HybridMMKV.cpp:53-58`):

```cpp
} else {
  // With AES-128, the max key length is 16 bytes.
  if (encryptionKey.size() > 16) [[unlikely]] {
    throw std::runtime_error("Failed to create MMKV instance! `encryptionKey` cannot be longer than 16 bytes with AES-128 encryption!");
```

So one of two things happens, both defects:
(a) `createMMKV` throws → the catch at line 146 sets `mmkvInitError`, `mmkvIsEncrypted = false`, and reopens the **plain, unencrypted** `LEGACY_INSTANCE_ID` instance. `_resolvedEncryptionKey` stays null, so `openEncryptedShard()` (line 53-59) also silently returns unencrypted shards, and the legacy→encrypted migration at line 127 never runs. Every MMKV write (relay routing, corkboards, saved/dismissed note ids, active-account pubkey, bunker metadata) sits in cleartext mmap files.
(b) MMKV core truncates instead of failing → only the first 16 ASCII hex characters are used = **64 bits** of effective key entropy, brute-forceable offline from a device image, while `mmkvIsEncrypted` reports `true`.

The module docblock (lines 8-13) promises "the active MMKV instance is *encrypted* with a 32-byte key... rooting/jailbreaking the device is required to extract it." Neither branch delivers that.
- **failure**: Fresh install on Android/iOS. `prepareSecureStorage()` generates a 64-char hex key and calls `createMMKV({id:'corkboards-encrypted', encryptionKey: <64 chars>})`. The native layer rejects the over-length key for the default AES-128, the catch swallows it, and the app runs the rest of its life on the unencrypted `corkboards-default` instance — the user only ever sees the generic banner from App.tsx:108 ("Storage is running in unencrypted mode"), which is dismissible via `warningAcked`. An attacker with a filesystem image (adb backup, forensic dump, stolen unlocked device) reads the whole store in cleartext.
- **fix**: Pick one encryption mode and make the key match it byte-for-byte:

Option A (preferred, strongest): pass `encryptionType: 'AES-256'` on BOTH `createMMKV` calls (MmkvStorage.ts:56 and :122) and shorten the key to <=32 bytes. Cleanest is to keep 32 random bytes but encode them as a 32-char string via `String.fromCharCode(...bytes.map(b => b & 0x7f))` — no; do NOT hand-roll that. Instead generate 24 random bytes and base64-encode them (32 ASCII chars, 192 bits): `btoa(String.fromCharCode(...bytes))`.
Option B (minimal diff): keep the default AES-128 and generate exactly 16 chars.

Whichever you pick:
- Update the length guard at line 112 (`key.length !== 64`) to the new length, otherwise every launch regenerates the key and orphans the store.
- Add a one-time recovery migration before writing a fresh key: try opening `ENCRYPTED_INSTANCE_ID` with `key.slice(0,16)` (the truncation branch) and, failing that, fall back to the plain `LEGACY_INSTANCE_ID`, copying keys forward — otherwise every existing install loses its corkboards on upgrade (the user's stated data-loss fear).
- Fix the docblock at lines 7-13 to state the actual key size and cipher.
- Add `if (__DEV__ && !mmkvIsEncrypted) console.error(...)` after bootstrap, or a unit test that asserts the generated key length is within the AES limit for the configured `encryptionType`, so this cannot regress silently.
- Delete `openEncryptedShard` (lines 47-59) or wire it up; as unused code it is just another place to get the key length wrong.

### ☐ OPEN — Raw nsec is rendered as cleartext UI text when bech32 decoding fails — @scure/base embeds the full input in the error message
- **area**: `key-management-crypto` · **platforms**: web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/auth/WelcomePage.tsx:273`, `packages/web/src/components/auth/WelcomePage.tsx:517`, `packages/mobile/src/components/AddAccountModal.tsx:151`, `packages/mobile/src/components/AddAccountModal.tsx:345`, `packages/mobile/src/components/auth/WelcomePage.tsx:130`, `packages/mobile/src/components/auth/LoginDialog.tsx:53`
- **detail**: Every nsec-paste login path renders the raw exception message into the UI:

```tsx
// web WelcomePage.tsx:270-274
await login.nsec(trimmed);
} catch (e: unknown) {
  setNsecLoginError((e instanceof Error ? e.message : String(e)) || 'Login failed');
// rendered at line 517:  <p className="text-xs text-red-500">{nsecLoginError}</p>
```

`login.nsec()` calls `NLogin.fromNsec(nsec)` (useLoginActions.ts:64) → `nip19.decode(nsec)` → `@scure/base` bech32 `decode`, which interpolates the **whole input string** into its errors (`node_modules/@scure/base/index.js`):

```js
line 593: throw new TypeError(`invalid string length: ${slen} (${str}). Expected (8..${limit})`);
line 608: throw new Error(`Invalid checksum in ${str}: expected "${sum}"`);
```

Mobile is identical and even more direct — `AddAccountModal.tsx:151` calls `nip19.decode(trimmed)` explicitly "to validate", then `setNsecError(e.message)` at line 155, rendered at line 345 in a plain `<Text style={styles.errorText}>`. Same in mobile `auth/WelcomePage.tsx:130` (rendered line 354) and `auth/LoginDialog.tsx:53` (rendered line 102).

This directly defeats the masking the same components take care to apply (`type="password"` on web line 516, `secureTextEntry` on mobile line 341): the key the user just typed into a masked field is re-printed one line below it in red, unmasked. On mobile it lands in screenshots, screen recordings, screen-share, and accessibility/TTS readout. Note `packages/mobile/src/screens/SettingsScreen.tsx:105-108` already gets this right (`catch { Alert.alert('Invalid key', 'Could not decode nsec'); }`), so the fix is already precedented in-repo.
- **failure**: User types their nsec with one wrong character (or a line-wrapped paste drops a char). bech32 checksum fails; `Invalid checksum in nsec1qqq...<the user's near-complete 63-char private key>...: expected "xyz"` is displayed verbatim on screen next to the masked input. A shoulder-surfer, a shared screen, or an automatic screenshot backup captures material within one character of the real key.
- **fix**: Replace the raw-message assignment with a fixed string in all four handlers — do not merely truncate, since the leak is the whole string:
- packages/web/src/components/auth/WelcomePage.tsx:273 → `setNsecLoginError('Could not read that key — check for typos and try again');`
- packages/mobile/src/components/AddAccountModal.tsx:155 → `setNsecError('Could not read that key — check for typos and try again');`
- packages/mobile/src/components/auth/WelcomePage.tsx:130 → same
- packages/mobile/src/components/auth/LoginDialog.tsx:53 → same
Match the wording already used at packages/mobile/src/screens/SettingsScreen.tsx:124.

Do NOT scrub-and-display: `packages/web/src/main.tsx`'s `nsec1[0-9a-z]{20,}` redaction is a last-ditch log filter, and relying on a regex to sanitize a string you already know contains a key is the wrong shape. If you want any diagnostic detail, log the scrubbed message to console (dev only) and show the user only the fixed string.

While in these files, note the adjacent seed-phrase handlers (web WelcomePage.tsx:290, mobile AddAccountModal.tsx:179, mobile WelcomePage.tsx:147) already do the right thing by construction — they re-encode a locally derived key, so `login.nsec()` cannot throw a decode error there. Leave them.

### ☐ OPEN — Android ships `allowBackup="true"` with no exclusion rules, and the keychain `accessible` flag that supposedly prevents cloud backup is iOS-only
- **area**: `key-management-crypto` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/android/app/src/main/AndroidManifest.xml:14`, `packages/mobile/src/lib/AuthContext.tsx:31`, `packages/mobile/src/lib/AuthContext.tsx:51`, `packages/mobile/src/storage/MmkvStorage.ts:117`, `packages/mobile/app.json`, `packages/mobile/src/storage/MmkvStorage.ts:114`
- **detail**: `AuthContext.tsx:34-40` states the rationale for `SECRET_STORAGE_OPTIONS`:

```
 *   - THIS_DEVICE_ONLY excludes the entry from iCloud Keychain sync and from
 *     encrypted iTunes/Finder and Android cloud backups. Without it the user's
 *     nsec leaves the device and lands on a third party's servers
```

The Android half of that claim is false. react-native-keychain types it explicitly (`node_modules/react-native-keychain/lib/typescript/types.d.ts:37-42`):

```ts
export type SetOptions = {
    /** Specifies when a keychain item is accessible.
     * @platform iOS, visionOS      <-- not Android
     * @default ACCESSIBLE.AFTER_FIRST_UNLOCK
     */
    accessible?: ACCESSIBLE;
```

On Android `accessible` is ignored entirely; the platform-relevant knobs are `securityLevel` / `storage` (both left unset at AuthContext.tsx:221, 269, 295 and MmkvStorage.ts:114-118) and, for backup exclusion, the manifest. The manifest declares the opposite of what the comment claims (`AndroidManifest.xml:14`):

```xml
<application ... android:allowBackup="true" ...>
```

with no `android:dataExtractionRules` and no `android:fullBackupContent`. Android Auto Backup therefore uploads the app's `filesDir` — which is where MMKV keeps its mmap files — to the user's Google Drive. Combined with finding #1 (storage very likely unencrypted), that means the user's corkboards, saved/dismissed note ids, relay routing, active-account pubkey and bunker metadata are copied to Google's servers, silently, with no UI anywhere in the app that reveals it. This is exactly the "no third-party leakage / private data never touches a server" rule the project treats as non-negotiable, and web/desktop have no equivalent exposure.
- **failure**: User installs the Android app, logs in, builds corkboards. Android Auto Backup runs on charge+idle+wifi and uploads `/data/data/me.corkboards.mobile/files/mmkv/*` to the user's Google Drive. Anyone with access to that Google account (or Google itself, or a subpoena) obtains the user's full Nostr social graph and reading history. If MMKV encryption is engaged the blobs are ciphertext, but the app currently has no reliable guarantee it is (see finding #1), and the code comment tells the developer this can't happen.
- **fix**: 1. packages/mobile/app.json — add `"allowBackup": false` inside `expo.android` (this is the source of truth; the manifest is generated).
2. packages/mobile/android/app/src/main/AndroidManifest.xml:14 — change `android:allowBackup="true"` to `"false"` so the checked-in manifest matches. If you want backups of non-sensitive prefs, use `android:dataExtractionRules` + `android:fullBackupContent` XML that `<exclude domain="file" path="mmkv/"/>` and `<exclude domain="sharedpref" path="."/>` instead of a blanket false.
3. packages/mobile/src/lib/AuthContext.tsx:37-41 — correct the docblock: `accessible` is iOS/visionOS-only; on Android the equivalent controls are `securityLevel`/`storage` plus the manifest backup rules.
4. Add the Android-relevant option to every secret write — AuthContext.tsx:293 (nsec), :295-ish (clientNsec) and MmkvStorage.ts:114 — e.g. `storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH`. Do NOT blanket-set `securityLevel: SECURE_HARDWARE` without a fallback: on devices with no StrongBox/TEE the write throws and, at MmkvStorage.ts:114, that lands in the catch at line 146 and silently drops the app to unencrypted storage.
5. iOS has the same shape of exposure and is not covered by this fix: MMKV writes under `$(Documents)/mmkv`, which iCloud Backup includes. Set `NSURLIsExcludedFromBackupKey` on that directory, or pass an explicit `path` under Library/Caches, if the intent is 'device-only'.

### ☐ OPEN — NIP-46 client secret keys are stored in plaintext localStorage on web and desktop while mobile puts them in the OS keychain
- **area**: `key-management-crypto` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useLoginActions.ts:219`, `packages/web/src/hooks/useLoginActions.ts:205`, `packages/web/src/hooks/useLoginActions.ts:329`, `packages/web/src/lib/webKeyStore.ts:239`, `packages/mobile/src/lib/AuthContext.tsx:295`, `packages/web/src/hooks/useLoginActions.ts:328`
- **detail**: Two distinct private keys are persisted in cleartext localStorage on web *and* on the Tauri desktop build, which shares the same web bundle:

1. `useLoginActions.ts:219-231` — the Amber client key is deliberately made persistent and written raw:
```ts
const AMBER_CLIENT_KEY = 'corkboard:amber-client-nsec';
...
try { localStorage.setItem(AMBER_CLIENT_KEY, nip19.nsecEncode(sk)); } catch { /* ignore */ }
```
2. Every bunker login puts `clientNsec` inside the `NLogin` data (lines 205-209 and 329-333), and `@nostrify/react` JSON-dumps the whole login array to localStorage on every state change (`node_modules/@nostrify/react/login/useNostrLoginReducer.ts:15-18`: `localStorage.setItem(storageKey, JSON.stringify(state))`, storageKey `corkboard:login` per App.tsx:52).

Mobile protects exactly this material in the OS keychain (`AuthContext.tsx:295`):
```ts
await Keychain.setGenericPassword('clientNsec', clientNsec, { service: clientNsecService(userPubkey), ...SECRET_STORAGE_OPTIONS });
```

The web/desktop hardening that does exist is scoped out of these keys by construction: `webKeyStore.prepareLoginStorage` only touches `entry.type !== 'nsec'` logins (line 239), so bunker `clientNsec` is never encrypted; and on desktop the OS keychain bridge is already wired and used for identity nsecs (`keychainStore('nsec:'+pubkey, nsec)`, useLoginActions.ts:79) but is not used for `clientNsec` or the Amber client key at all. Desktop is strictly weaker than mobile with the same OS facility available. These keys are lower-value than the identity key (revocable at the bunker), but they authorize `sign_event` on the user's behalf for the life of the grant — Amber's "always" grant in particular.
- **failure**: A user logs in with Amber on desktop. `corkboard:amber-client-nsec` and `corkboard:login[].data.clientNsec` sit in cleartext in the WebKit localStorage SQLite file under `~/.local/share/me.corkboards.desktop`. Any process running as that user, any backup tool, or any compromised npm dependency that can run in the origin reads them and can sign events as the user through the still-authorized NIP-46 channel — without ever touching the OS keychain the app went to the trouble of wiring up.
- **fix**: Desktop (highest value, smallest diff — the bridge already exists):
- In `bunker()` (useLoginActions.ts:205) and `nostrconnect()` (:328), after `addLogin(login)` succeeds, mirror the nsec pattern at lines 78-84: `if (isTauri) { const ok = await keychainStore(`clientnsec:${userPubkey}`, clientNsec); if (ok && login.data) (login.data as {clientNsec?: string}).clientNsec = ''; }` — blank only on a successful keychain write, so a keychain failure does not lock the user out.
- Rehydrate on session start where the `NConnectSigner` is rebuilt (search for where blanked bunker logins are consumed, same place `webNsecSigner` handles blanked nsec logins) via `keychainGet(`clientnsec:${pubkey}`)`.
- Add the matching `keychainDelete(`clientnsec:${pubkey}`)` to `logoutAccount` (line 347) alongside the existing `keychainDelete(`nsec:...`)`.

Plain web:
- Extend `webKeyStore.prepareLoginStorage` (webKeyStore.ts:239) to also handle `entry.type === 'bunker'`, encrypting `data.clientNsec` under the same non-extractable AES-GCM key in the `corkboard-keys` IDB store and blanking the localStorage copy — reusing `storeNsec`/`loadNsec` keyed as `clientnsec:<pubkey>`.
- Move `corkboard:amber-client-nsec` (line 219-231) into that same encrypted store rather than raw localStorage. Even though it is unreachable on Tauri, it IS reachable in every browser including mobile web, where CSP is the only defense.
- Delete it in `logoutAccount` (line 341-352); today only `nuclearWipe`'s `localStorage.clear()` removes it, so an account switch leaves a signing-capable key behind.

Also fix the stale docblock at useLoginActions.ts:38 — amberConnect no longer generates a fresh key per session.

### ☐ OPEN — A transient keychain read error silently regenerates the MMKV encryption key, permanently destroying all encrypted local data
- **area**: `key-management-crypto` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/storage/MmkvStorage.ts:96`, `packages/mobile/src/storage/MmkvStorage.ts:112`, `packages/mobile/src/lib/AuthContext.tsx:272 — same defect class, worse blast radius: when `buildSignerForAccount()` returns null for ANY reason (falsy creds, or a `nip19.decode` throw at line 183-186 caught by the bare `catch { return null; }`), lines 272-273 call `Keychain.resetGenericPassword()` on both `corkboards-nsec:<pk>` and `corkboards-clientnsec:<pk>` — irreversibly deleting the user's actual nsec, not just a storage key. Same fix: only reset on a confirmed-absent/definitively-invalid entry, never on an ambiguous null.`
- **detail**: `prepareSecureStorage()` cannot distinguish "no key stored yet" from "keychain read failed":

```ts
try {
  const creds = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
  if (creds && typeof creds !== 'boolean') { key = creds.password; }
} catch (e) {
  // If keychain read itself errors (rare — locked device, no biometry
  // available, etc.) we'll fall through to generate one.
  console.warn('[MmkvStorage] Keychain read failed, will generate fresh key:', e);
}

// 2) No key yet — generate and store.
if (!key || key.length !== 64) {
  key = generateEncryptionKey();
  await Keychain.setGenericPassword(KEYCHAIN_USERNAME, key, { ... });
}
```

The catch is not a soft failure — it falls straight into an **overwrite** of the existing keychain entry (line 114). The old key is gone forever, and any MMKV data encrypted under it is undecryptable. There is no read-back verification, no "did we already have an instance?" check, and no user prompt. The same trap fires on the `key.length !== 64` branch if the stored key was ever written in a different format (which is precisely what the fix for finding #1 will do).

This is the failure class the project's data-loss guards exist for: MMKV holds `nostr-custom-feeds` (the user's corkboards), `nostr-friends`, backup bookkeeping (`corkboard:last-backup-ts`, `corkboard:last-backup-hashes`), and the per-user stashes written by `stashUserData`.
- **failure**: App is cold-launched by the OS in the background, or the keychain is momentarily unavailable (device just rebooted and not yet unlocked, Keystore under load, biometry hardware hiccup). `getGenericPassword` throws; the catch logs a warning; a brand-new key is generated and written over the good one. On the next foreground launch the encrypted MMKV instance cannot be decrypted — every corkboard, follow-set edit and backup checkpoint the user had locally is gone, with no error beyond an empty app.
- **fix**: Do not treat a read *rejection* as 'no key'. (1) In the catch at 105-109, set a flag `readFailed = true`; if set, skip the generate/store branch entirely and fall through to the existing degraded path (line 150-153: open the plain legacy instance, set `mmkvInitError`) so the app launches without clobbering the key, and surface it in App.tsx's blocking banner. (2) Only generate+store when `getGenericPassword` *resolved* falsy (definite absence). (3) Add a non-secret sentinel — e.g. `legacy.set('__encrypted_instance_created__','1')` in the plain instance right after line 122 — and refuse to regenerate whenever that sentinel exists but no key was read; that is the only way to distinguish 'first run' from 'lost key' without decrypting. (4) After `setGenericPassword`, read the value back and require it to match before opening MMKV with it.

### ☐ OPEN — eventRouter caps publishes at 3 relays, overriding welshman's deliverability guard so mentioned users' inbox relays are dropped
- **area**: `nostr-protocol` · **platforms**: web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/components/NostrProvider.tsx:756`, `packages/web/src/components/NostrProvider.tsx:376`, `packages/mobile/src/lib/NostrProvider.tsx:539`, `packages/mobile/src/lib/NostrProvider.tsx:37`
- **detail**: welshman's `PublishEvent` scenario deliberately widens its own limit — `node_modules/@welshman/router/dist/index.js:102-103`: `// Override the limit to ensure deliverability even when lots of pubkeys are mentioned` / `return this.merge(scenarios).limit(30);`. Both providers immediately undo it:

```js
// NostrProvider.tsx:756-761
const scenario = Router.get()
  .PublishEvent(event as unknown as TrustedEvent)
  .policy(addMinimalFallbacks)
  .limit(MAX_TARGETED_RELAYS);   // = 3 (line 376)
```

`getUrls()` is `take(limit, sortBy(scoreRelay, …))` (welshman index.js:126-153) — a hard cap on the *total* URL set, not per-participant. NIP-65 requires sending the event to the author's write relays **and** all read relays of each tagged user; with 3 slots the author's own relays consume them and every recipient inbox is truncated away.
- **failure**: User replies in a thread whose `buildReplyTags` produced 5 p-tags (parent author + forwarded ancestors). welshman assembles author-write + 5 inboxes, scores them, and `take(3, …)` keeps the three highest-scoring — typically the author's own relays. None of the 5 mentioned users receive the reply on a relay they read, so the reply is invisible in their notifications even though it was "published successfully".
- **fix**: Drop the `.limit(MAX_TARGETED_RELAYS)` on the publish path in both providers and let welshman's built-in `.limit(30)` stand, or set an explicit publish-specific cap (e.g. `MAX_PUBLISH_RELAYS = 16`). `MAX_TARGETED_RELAYS` is a *read* fan-out budget and should not be reused for writes.

### ☐ OPEN — buildReplyTags ignores NIP-10 positional e-tags, re-rooting the thread at the parent
- **area**: `nostr-protocol` · **platforms**: core, web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/core/src/noteClassifier.ts:144`
- **detail**: NIP-10's deprecated-but-still-live positional scheme: with two or more unmarked `e` tags, the **first** is the root and the last is the reply parent. `buildReplyTags` only looks for a marker:

```js
const rootTag = replyTo.tags.find(t => t[0] === 'e' && t[3] === 'root');
const rootId = (rootTag?.[1] && isValidEventId(rootTag[1])) ? rootTag[1] : replyTo.id;
```

When the parent used positional tags, `rootTag` is undefined, so `rootId` falls back to `replyTo.id` and line 151 emits `['e', replyTo.id, hint, 'root']` — declaring the parent to be the thread root. Note `parseThreadTags` (`threadTree.ts:39-41`) and `classifyNote` (`noteClassifier.ts:58-61,68-71`) both *do* implement the positional fallback, so this is an inconsistency inside the same module, not an accepted design choice. All three platforms call it (`ComposeDialog.tsx:191`, `InlineReplyComposer.tsx:67` web / `:124` mobile, `ComposeScreen.tsx:180`).
- **failure**: User opens a thread and replies to a note whose tags are `[["e","<root>"],["e","<grandparent>"],["e","<parent>"]]` (no markers — still emitted by older clients and bridges). corkboards publishes `[["e","<parent>","hint","root"]]`. Every NIP-10-compliant client renders the reply as the start of a brand-new thread; it never appears under the original conversation, and the thread the user was reading is split.
- **fix**: Mirror `parseThreadTags`: when no `root`-marked e-tag exists, fall back to the positional convention — `eTags.length >= 2 ? eTags[0][1] : replyTo.id` (validated with `isValidEventId`) — and use `eTags[0][2]` as the forwarded root hint. Add a unit case to `packages/web/src/lib/buildReplyTags.test.ts` covering a positional parent with 3 e-tags.

### ☐ OPEN — Web feed uses the FIRST e-tag as the reaction/zap/repost target; NIP-25 specifies the LAST
- **area**: `nostr-protocol` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/pages/MultiColumnClient.tsx:2781`, `packages/web/src/pages/MultiColumnClient.tsx:2795`, `packages/web/src/pages/MultiColumnClient.tsx:2844`, `packages/web/src/pages/MultiColumnClient.tsx:2854`, `packages/web/src/pages/MultiColumnClient.tsx:2950`, `packages/web/src/pages/MultiColumnClient.tsx:3063`
- **detail**: NIP-25: "If a client decides to include other `e`, … the target event `id` should be last of the `e` tags." Nine sites in the web feed take the first instead:

```js
const targetId = note.tags.find(t => t[0] === 'e')?.[1];   // MultiColumnClient.tsx:2781, 2795, 2844, 2854, 2950, 3063, 3291
const eTag = note.tags.find(t => t[0] === 'e')             // NoteCard.tsx:688 (reactionTargetId)
```

This is a deviation from the codebase's own shared helper `getReactionTargetId` (`packages/core/src/threadTree.ts:51-56`, which prefers the marked `reply`/`root` tag then the last positional one) and from mobile, which gets it right: `useNoteEngagement.ts:68-69` — `const eTags = e.tags.filter(t => t[0] === 'e'); if (eTags[eTags.length - 1]?.[1] !== eventId) continue;`. `noteCategories.ts:106-107` also uses the shared helper. Only the web feed pipeline is wrong.
- **failure**: Amethyst/Damus publish reactions carrying the full NIP-10 tag set: `[["e","<thread root>","","root"],["e","<the note liked>","","reply"],["p",…]]`. On web the ❤️ is credited to the thread root, not the note that was actually liked: the liked reply shows 0 reactions while an unrelated root note accumulates phantom badges, and in collapse mode `getOrCreateEngagement(targetId)` files the reaction under the wrong stub so it may render as a standalone stub card.
- **fix**: Replace all eight lookups with the existing `getReactionTargetId` from `@core/threadTree` (already imported by `noteCategories.ts`). For kind 6/16 and 9735 use the same last-positional/marked rule. This also removes the divergence from mobile.

### ☐ OPEN — A repost's attacker-controlled embedded `id` suppresses matching notes from the feed (censorship primitive)
- **area**: `nostr-protocol` · **platforms**: web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/pages/MultiColumnClient.tsx:2762`, `packages/web/src/pages/MultiColumnClient.tsx:2810`, `packages/web/src/pages/MultiColumnClient.tsx:2864`, `packages/web/src/pages/MultiColumnClient.tsx:3297`, `packages/mobile/src/screens/HomeScreen.tsx:255`
- **detail**: The dedup pass derives the reposted note's id from the unverified `content` JSON *in preference to* the `e` tag:

```js
if (note.content && note.content.startsWith('{')) {
  try { origId = JSON.parse(note.content).id; } catch { /* ignore */ }
}
if (!origId) origId = note.tags.find(t => t[0] === 'e')?.[1];
```

That value then drives suppression: `referencedOriginalIds.add(origId)` (2765), `seenRepostedIds.add(originalId)` (2869) followed by `if (note.kind === 1 && seenRepostedIds.has(note.id)) return false;` (2871), and in collapse mode `if (eventLookup.has(originalId) || seen.has(originalId)) return false;`. Because nothing verifies that the embedded JSON's `id` matches the `e` tag or hashes to the JSON body, the id is fully attacker-chosen.
- **failure**: Attacker publishes `{kind:6, tags:[["e","<some junk note>"]], content:"{\"id\":\"<id of a note the attacker wants hidden>\",\"pubkey\":\"…\",\"content\":\"\"}"}` to a relay the victim reads. When both events land in the same feed batch, the targeted kind-1 note is filtered out at MultiColumnClient.tsx:2871 and never rendered. Repeat per target id to blackhole specific posts from a user's timeline.
- **fix**: Prefer the `e` tag as the authoritative repost target and use the embedded id only when it (a) matches the `e` tag, or (b) survives `verifyEvent` per the embedded-repost fix. Concretely, invert the precedence at each of the five sites: `let origId = note.tags.find(t => t[0] === 'e')?.[1]; if (!origId && verifiedEmbedded) origId = verifiedEmbedded.id;`

### ☐ OPEN — Optimistic pin-list cache write drops relayHints, so the next pin/unpin republishes kind 10001 with every relay hint stripped
- **area**: `nostr-protocol` · **platforms**: web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/usePinnedNotes.ts:288`, `packages/web/src/hooks/usePinnedNotes.ts:231`, `packages/web/src/hooks/usePinnedNotes.ts:160`, `packages/mobile/src/hooks/usePinnedNotes.ts:239`
- **detail**: The query at usePinnedNotes.ts:52 is typed `{ ids, status, relayHints }` and `publishPinList` depends on it to preserve NIP-51 e-tag relay hints — the code even documents this as a prior regression:

```js
// line 228-232: "rebuilding bare [\"e\", id] tags on every pin/unpin would strip them all. (H3)"
const hints = pinListResult?.relayHints ?? {};
const tags = newIds.map(id => (hints[id] ? ['e', id, hints[id]] : ['e', id]));
```

But `togglePin` overwrites that cache entry with a two-field object:

```js
// line 288-290
queryClient.setQueryData(['pinned-notes', user.pubkey],
  { ids: newIds, status: newIds.length > 0 ? 'found' as const : 'none' as const })
```

`relayHints` is gone. On the next render `pinListResult.relayHints` is `undefined`, so the following publish emits bare `['e', id]` tags. The read path is hit too: `getQueryData<{relayHints}>(['pinned-notes', …])` at line 160-163 (Fallback 1) now sees `{}` and can no longer locate notes pinned from other authors. Mobile is identical (`usePinnedNotes.ts:239-240` vs `:187`, `:133`). TypeScript does not catch it because `setQueryData` infers `TData` from the literal.
- **failure**: User has 8 pinned notes, 5 of them from other authors with relay hints recorded on the e-tags. They unpin one note, then pin another. The second publish writes a kind 10001 with 8 bare `['e', id]` tags. On next cold start the NPool `ids` query misses the 5 foreign notes, Fallback 1 has no hints left, and the Me tab shows "3/8 pinned notes resolved".
- **fix**: Include the hints in the optimistic write: `queryClient.setQueryData(['pinned-notes', user.pubkey], (prev) => ({ ids: newIds, status: newIds.length > 0 ? 'found' : 'none', relayHints: prev?.relayHints ?? {} }))`. Add an explicit type parameter to `setQueryData<PinListResult>` at both sites so a missing field becomes a compile error.

### ☐ OPEN — NIP-51 private (NIP-44 encrypted) list entries are never decrypted for mute lists and follow sets
- **area**: `nostr-protocol` · **platforms**: web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useMuteList.ts:38`, `packages/mobile/src/hooks/useMuteList.ts:38`, `packages/web/src/hooks/useFollowSets.ts:50`, `packages/web/src/hooks/useFollowSets.ts:53`
- **detail**: NIP-51: "Public items in a list are specified in the event `tags` array, while private items are specified in a JSON array … stringified and encrypted using the same scheme from NIP-44 … and stored in the `.content`." `useBookmarks` implements this correctly (encryptToSelf/decryptFromSelf, useBookmarks.ts:31-42, 168-178), but the mute list only reads public tags:

```js
// useMuteList.ts:38-43 (identical at mobile useMuteList.ts:38-43)
return new Set(muteEvent.tags.filter(t => t[0] === 'p').map(t => t[1]));
```

The encrypted `content` is preserved on republish (`publishMuteList`, line 84 — good, no data loss) but never decrypted, so private mutes have no effect. Same for follow sets: `useFollowSets.ts:50` reads only public `p` tags and line 53 then *drops the entire set* — `.filter(l => l.pubkeys.length > 0)` — so a set whose members are all private disappears from the UI entirely. Amethyst and several other clients write mutes to the encrypted section by default.
- **failure**: User privately mutes a harasser in Amethyst (entry goes into the NIP-44 `content` of kind 10000). They open corkboards; `mutedPubkeys` is empty, `isMuted()` returns false, and the harasser's notes appear throughout the feed and notifications. Similarly a private follow set built in another client renders as "no lists".
- **fix**: Add `packages/core/src/nip51.ts` exporting `readListEntries(event, signer, pubkey): Promise<string[][]>` that returns `event.tags` concatenated with the decrypted `JSON.parse(await signer.nip44.decrypt(pubkey, event.content))` (with the NIP-51 back-compat sniff: if the ciphertext contains `?iv=`, decrypt with nip04). Use it in `useMuteList` (both platforms) and `useFollowSets`, and preserve the split when republishing so private entries stay private. Remove the `pubkeys.length > 0` filter in useFollowSets once private members are visible.

### ☐ OPEN — A note that both replies and quotes is classified as "not a reply", losing its thread context
- **area**: `nostr-protocol` · **platforms**: core, web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/core/src/noteClassifier.ts:86`, `packages/web/src/components/NoteCard.tsx:660`
- **detail**: NIP-10 and NIP-18 treat `e` (threading) and `q` (citation) as orthogonal — NIP-18: "The `q` tag ensures quote reposts are not pulled and included as replies in threads", i.e. a `q` tag is not itself a reply, but it does not negate an `e` tag. `classifyNote` makes them mutually exclusive:

```js
const hasReplyETags = eTags.some(t => !t[3] || t[3] === 'reply' || t[3] === 'root');
const hasQTags = qTags.length > 0;
return {
  isReply: hasReplyETags && !hasQTags,
  ...
  parentEventId: hasReplyETags ? parentEventId : undefined,
```

So a reply that also cites a note gets `isReply: false`. `isDirectReplyTo` (line 98-101) then returns false for it. `NoteCard.tsx:658-666` duplicates the same rule inline (`if (hasQTags) return false`). Additionally, in collapse mode `MultiColumnClient.tsx:2823-2827` suppresses `kind===1 && has q-tag` from the feed outright — which now also swallows genuine replies.
- **failure**: Alice replies to Bob's note and quotes Carol's note in the same message (tags `[["e","<bob>","","root"],["q","<carol>"],["p","<bob>"]]`). corkboards renders it as a standalone quote card with no parent context and no "replying to Bob" header, `useParentNotes` is never asked for Bob's note, and with collapse-reactions on the reply is hidden from the feed entirely.
- **fix**: Make the flags independent: `isReply: hasReplyETags`, `isQuote: hasQTags`, `isOriginal: !hasReplyETags && !hasQTags`, and always populate `parentEventId`/`rootEventId` when `hasReplyETags`. Update `NoteCard.tsx:658-666` to match, and narrow the MultiColumnClient.tsx:2823 suppression to `hasQTags && !hasReplyETags`.

### ☐ OPEN — No created_at sanity bound — one future-dated event permanently breaks "load newer" for a tab
- **area**: `nostr-protocol` · **platforms**: web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useFeedPagination.ts:763`, `packages/web/src/hooks/useFeedPagination.ts:626`, `packages/web/src/hooks/useFeedPagination.ts:646`, `packages/core/src/feedAlgorithms.ts:57`
- **detail**: Nothing anywhere clamps or filters `created_at` against wall-clock time (verified by grepping every `created_at` comparison in core, feedUtils and MultiColumnClient). The leading-edge cursor is taken as an unbounded max:

```js
// useFeedPagination.ts:763-764
const newest = sortedNew.reduce((max, n) => n.created_at > max ? n.created_at : max, sortedNew[0].created_at);
setNewestTimestamp(newest);
```

and every subsequent load-newer / autofetch queries from it: `const sinceTs = newestTimestamp ?? (now - 7200)` (line 626) then `since: sinceTs + 1` (lines 646, 658, 673, 682, 690, 698, 733, and the autofetch path at 840/870). `deduplicateAndSort` (feedAlgorithms.ts:57) sorts purely by `created_at` descending, so the same event also pins to the top of the feed forever.
- **failure**: A followed author (or any author whose note lands in a corkboard) publishes with `created_at = 4102444800` (year 2100) — plenty of relays accept it. On the next fetch `newestTimestamp` for that tab becomes 4102444800; every later "Load newer" and every autofetch cycle issues `since: 4102444801`, which no relay can satisfy. The tab shows "No new notes found" forever until the user clears state, and the year-2100 note sits at the top of the column.
- **fix**: Clamp when setting the cursor: `setNewestTimestamp(Math.min(newest, Math.floor(Date.now()/1000)))`. Better, add a shared guard in `@core/feedAlgorithms` — `const MAX_CLOCK_SKEW = 15 * 60;` and drop events with `created_at > now + MAX_CLOCK_SKEW` inside `deduplicateAndSort`/`mergeEvents` so future-dated notes never enter the live set on any platform (also fixes the top-of-feed pinning).

### ☐ OPEN — Persisted NIP-65 relay cache is loaded from the pre-migration unencrypted MMKV instance and is therefore always empty
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/lib/NostrProvider.tsx:553`, `packages/mobile/src/lib/NostrProvider.tsx:47`, `packages/mobile/src/storage/MmkvStorage.ts:181`, `packages/mobile/src/storage/MmkvStorage.ts:122`, `packages/mobile/src/storage/MmkvStorage.ts:139`, `packages/mobile/App.tsx:8`
- **detail**: `MmkvStorage.ts:181-196` synchronously opens the **legacy, unencrypted** instance at module-eval time (`mmkv = createMMKV({ id: LEGACY_INSTANCE_ID })`) so that early reads don't crash, then kicks off `prepareSecureStorage()` (line 198) which awaits a Keychain round-trip before reassigning `mmkv` to the encrypted instance (line 122) and clearing the legacy store (`legacy.clearAll()`, line 139).

`NostrProvider.tsx:553` calls `loadRelayCache()` at module body scope:
```ts
// Initialize cache on load
loadRelayCache();
```
and `loadRelayCache` (line 47-57) does `mobileStorage.getSync(RELAY_CACHE_KEY)`, which reads the module-level `mmkv` **at call time**.

Import order in `App.tsx`: line 8 imports MmkvStorage (legacy handle assigned, keychain promise pending), line 10 imports NostrProvider → its module body runs `loadRelayCache()` synchronously, long before the awaited `Keychain.getGenericPassword()` resolves. So the read hits the legacy instance.

Writes go the other way: `saveRelayCache()` (line 61-71) is debounced 2 s, so by the time it fires `mmkv` is the encrypted instance. Data is written to encrypted and read from legacy. `loadRelayCache` is called exactly once (grep confirms line 553 is the only call site) and is never re-run after `mobileStorage.ready` settles.

The same module-eval-before-storage-ready pattern exists in `useCustomFeedNotesCache.ts:185-209` (the one-time prune IIFE), which is best-effort so the impact is only that pruning never runs.
- **failure**: User launches the app for the second time after the encrypted-storage migration. `relayCache` initializes empty. `selectFeedRelays()` (NostrProvider.tsx:431-439) finds no cached author relays, so `coverage` is empty and the follows feed is routed only to `FALLBACK_RELAYS + READ_ONLY_RELAYS` — the outbox model is silently disabled until `useNip65Relays` re-discovers relays over the network for up to 200 contacts (HomeScreen.tsx:367). Notes from authors who only write to their own relays are missing on every cold start, and the app burns a full NIP-65 discovery pass per launch.
- **fix**: Two changes, and the second one is the part the original fix got wrong:

1. Defer the read. At NostrProvider.tsx:553 replace `loadRelayCache();` with `mobileStorage.ready.then(loadRelayCache);` (`ready` already exists — MmkvStorage.ts:256). The `useState` initializer alternative also works, but the module-level `.then` keeps the single-call-site invariant that `updateRelayCache`/`saveRelayCache` assume.

2. MERGE, don't replace. `loadRelayCache` currently does `relayCache = new Map(Object.entries(parsed))`, which wholesale clobbers the map. Once the load is deferred, any `updateRelayCache()` calls that land between module eval and `ready` (NostrProvider's pool is constructed in `useState` at :594 and can start caching immediately) would be silently discarded. Change it to fill only missing keys:
```ts
for (const [pk, relays] of Object.entries(parsed) as [string, string[]][]) {
  if (!relayCache.has(pk)) relayCache.set(pk, relays);
}
```

3. Same deferral for useCustomFeedNotesCache.ts:185 — make the IIFE start with `await mobileStorage.ready;` before `await mobileStorage.keys()`.

4. Make the class of bug loud instead of silent: track a `let _ready = false` in MmkvStorage.ts set at the end of `prepareSecureStorage`, and in `getSync`/`keys` add `if (__DEV__ && !_ready) console.warn('[MmkvStorage] sync read before secure storage ready:', key)`. Do NOT throw — MmkvStorage.ts:173-180's comment shows the sync bootstrap is deliberate for crash-avoidance.

### ☐ OPEN — Notification polling keeps hitting relays while the app is backgrounded — TanStack focusManager always reports "focused" in React Native
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/hooks/useNotificationCount.ts:66`, `packages/mobile/App.tsx:34`, `packages/mobile/App.tsx:84`
- **detail**: `useNotificationCount` sets `refetchInterval: 60_000` (line 66) with no AppState gate. `refetchIntervalInBackground` defaults to false, but that check goes through `focusManager.isFocused()`, and in React Native that always returns true.

Verified in `node_modules/@tanstack/query-core/build/modern/focusManager.js`:
```js
this.#setup = (onFocus) => {
  if (typeof window !== "undefined" && window.addEventListener) { ... }
  return;   // ← RN: no window, no listener registered
};
...
isFocused() {
  if (typeof this.#focused === "boolean") return this.#focused;
  return globalThis.document?.visibilityState !== "hidden";  // undefined !== 'hidden' → true
}
```
So `#focused` stays `undefined`, `globalThis.document` is undefined on RN, and `isFocused()` is permanently `true`.

Grepping the whole mobile package for `focusManager` / `onlineManager` returns zero hits — the AppState→focusManager bridge that RN apps must wire manually is absent. `App.tsx:84-92` sets `refetchOnWindowFocus: false` globally but never wires focus at all.

`useNotificationCount()` is called at `App.tsx:34` inside `AppTabs`, i.e. it is mounted for the entire app lifetime regardless of which tab is visible.

This directly contradicts the app's own stated design — `useAutoFetch.ts:13-16` explicitly guards on `AppState.currentState === 'active'` because "a backgrounded phone app left running overnight would otherwise keep hammering relays on cellular". The notification query has no such guard.

Secondary: `onlineManager` is likewise unwired (no NetInfo integration), so queries never pause when the device loses connectivity — they just fail and burn retries.
- **failure**: User backgrounds the app on cellular and leaves the phone in a pocket. Android keeps the RN JS thread alive; every 60 s `useNotificationCount`'s queryFn opens WebSockets to the routed relays with `{kinds:[1,6,7,16,9735], '#p':[pubkey], limit:50}`. Overnight that is ~480 relay round-trips of pure background data and radio wake-ups the user never asked for.
- **fix**: Wire both managers once, at module scope in App.tsx above the `QueryClient` construction (line 84), so it is installed before any query mounts:
```ts
import { focusManager, onlineManager } from '@tanstack/react-query';
import { AppState } from 'react-native';

focusManager.setEventListener((handleFocus) => {
  const sub = AppState.addEventListener('change', (s) => handleFocus(s === 'active'));
  return () => sub.remove();
});
```
Note `setEventListener` must be called at module scope, not in a `useEffect` — `FocusManager.onSubscribe` installs the default no-op `#setup` on the first query subscription, and a later `setEventListener` call would run `#cleanup?.()` on a `undefined` cleanup. Module scope avoids the ordering question entirely.

Also seed the initial state: `focusManager.setFocused(AppState.currentState === 'active')` immediately after, since the listener only fires on the next transition.

Defense in depth for the specific query — useNotificationCount.ts:66 — add `refetchIntervalInBackground: false` explicitly rather than relying on the default, so the intent is legible next to the interval.

Do NOT gate on `AppState.currentState === 'active'` inside `enabled:` as the original fix suggests — `enabled` is not re-evaluated on AppState changes (there is no subscription), so it would only capture the value at mount and would additionally unmount/remount the query. The focusManager bridge is the correct and sufficient mechanism.

Separately, `onlineManager` is likewise unwired (zero grep hits), so offline periods burn retries instead of pausing. @react-native-community/netinfo is not currently a dependency (checked packages/mobile/package.json), so that half is a new dep — worth filing as its own item rather than bundling here.

### ☐ OPEN — useCollapsedNotes is mounted per notification row and JSON.parses up to three 10 000-entry ID arrays on every card mount
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/components/NotificationCard.tsx:89`, `packages/mobile/src/hooks/useCollapsedNotes.ts:63`, `packages/mobile/src/hooks/useCollapsedNotes.ts:64`, `packages/mobile/src/hooks/useCollapsedNotes.ts:65`, `packages/mobile/src/hooks/useCollapsedNotes.ts:107`, `packages/mobile/src/screens/NotificationsScreen.tsx:222`
- **detail**: `useCollapsedNotes()` keeps no shared instance for its persisted state. Every hook instance independently deserializes from MMKV in three `useState` initializers:
```ts
const [collapsedIds]        = useState<string[]>(() => loadFromMmkv(COLLAPSED_KEY));          // :63
const [dismissedIds]        = useState<string[]>(() => loadFromMmkv(DISMISSED_KEY));          // :64
const [dismissedThreadRoots]= useState<string[]>(() => loadFromMmkv(DISMISSED_THREAD_ROOTS_KEY)); // :65
```
and then builds four `Set`s from them (lines 107-110). `loadFromMmkv` is a synchronous `mobileStorage.getSync` + `JSON.parse` on the JS thread.

The caps are `MAX_COLLAPSED_NOTES = 10000` and `MAX_DISMISSED_NOTES = 10000` (lines 15-16). A 10 000-entry array of 64-hex-char note ids serializes to ~670 KB.

`NotificationCard.tsx:89` calls `useCollapsedNotes()` — and `NotificationCard` is the FlatList `renderItem` for the notifications feed (`NotificationsScreen.tsx:222-224`). Each rendered row therefore pays 3 × `JSON.parse` of up to 670 KB plus 4 `new Set(...)` constructions of up to 10 000 elements, all synchronously, all on the JS thread. Only the module-level `_softDismissedSet` is shared; the persisted arrays are not.

Note that `NotificationCard` only actually uses `isCollapsed`, `toggleCollapsed`, `dismiss`, `isSoftDismissed`, `canUndoDismiss`, `undoDismiss` — none of which need per-row copies of the arrays.
- **failure**: A long-time user who has dismissed several thousand notes opens the Activity tab. With `initialNumToRender` defaulting to 10 and the list scrolling, ~30 NotificationCards mount within a second, each parsing ~2 MB of JSON — roughly 60 MB of parsing and 120 000 Set insertions on the JS thread. The tab freezes for seconds on mount and stutters on every scroll batch, and memory spikes with 30 duplicate copies of the same three arrays.
- **fix**: Hoist the three persisted lists to module scope and drive re-renders through the existing `listeners` set — which fixes the staleness bug and the per-mount parse in one move:

1. At module scope alongside `_softDismissedSet` (useCollapsedNotes.ts:30-34), add lazily-initialized `_collapsedSet`, `_dismissedSet`, `_dismissedThreadRootSet` (Sets, not arrays — every consumer except SavedScreen/SettingsScreen wants membership tests) plus a `_version` counter. Initialize them behind `mobileStorage.ready` for the same reason as finding #2 (MmkvStorage swaps the instance after keychain resolves), or accept a one-shot re-read on ready.
2. Replace :63-68 with a single `useSyncExternalStore(subscribe, () => _version)` against the existing `listeners` set (:34) — `subscribe` is `fn => { listeners.add(fn); return () => listeners.delete(fn); }`. Delete the :107-110 `useMemo` Set constructions; the module Sets are already the Sets.
3. Every mutator (`toggleCollapsed`, `collapse`, `expand`, `dismiss`, `consolidate`, `dismissMultiple`, `dismissThreadRoots`, `dismissAllCollapsed`, `clearAll`, `clearDismissed`, `undismissMany`) mutates the module Sets, calls `saveToMmkv` with `[...set]`, bumps `_version`, and calls `notifyListeners()`.
4. Keep `collapsedIds`/`dismissedIds`/`collapsedCount`/`dismissedCount` in the return for SavedScreen.tsx:39 and SettingsScreen.tsx:93, but derive them as `useMemo(() => [..._collapsedSet], [version])` so only the two screens that actually read arrays pay the spread.
5. The mount-time cleanup effect at :114-125 must move to a module-level one-shot (it currently re-evaluates per instance and the `MAX_*` slice is already enforced in every mutator, so it is redundant work on every card mount).

Don't bother with a separate `useCollapsedNoteActions()` hook as originally suggested — once the state is module-level, the single hook is already cheap and a second hook doubles the surface to keep in parity across three platforms.

### ☐ OPEN — Feed FlatLists remount every separator and re-render every mounted NoteCard on each parent render (unmemoized NoteCard, inline ItemSeparatorComponent, per-frame scroll setState)
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/screens/HomeScreen.tsx:595`, `packages/mobile/src/screens/HomeScreen.tsx:588`, `packages/mobile/src/screens/HomeScreen.tsx:470`, `packages/mobile/src/components/FeedGrid.tsx:163`, `packages/mobile/src/components/NoteCard.tsx:99`, `packages/mobile/src/screens/DiscoverScreen.tsx:350 — same per-item onToggleBookmark closure feeding the unmemoized NoteCard`
- **detail**: Three compounding issues on the hottest render path:

1. `NoteCard` is a plain function component — `packages/mobile/src/components/NoteCard.tsx:99` is `export function NoteCard({...})` with no `React.memo`. Contrast `NotificationCard` (NotificationCard.tsx:84) and `FeedGrid` (FeedGrid.tsx:60), which are both memoized. So every HomeScreen render re-renders every mounted NoteCard, and each NoteCard renders `NoteContent` (a 800-line renderer), `NoteActions`, two `useAuthor` subscriptions and `SizeGuardedImage`.

2. `ItemSeparatorComponent` is an inline arrow, so its component *type* identity changes on every render:
   - `HomeScreen.tsx:595`: `ItemSeparatorComponent={() => <View style={{ height: 8 }} />}`
   - `FeedGrid.tsx:163`: `ItemSeparatorComponent={() => <View style={styles.separator} />}`
   React sees a new element type each render and unmounts + remounts every separator — a native view destroy/create per separator per render.

3. `HomeScreen.tsx:588` `onScroll={e => setScrolledFromTop(e.nativeEvent.contentOffset.y > 0)}` with `scrollEventThrottle={16}` fires a `setState` up to 60×/s. React bails out when the boolean is unchanged, but at the y=0 boundary it does change, triggering a full HomeScreen re-render (which, per #1 and #2, cascades into all mounted cards and separators) exactly while the user is flick-scrolling at the top of the list.

4. `renderNote` recreates a closure per item per render: `onToggleBookmark={() => toggleBookmark(item.id)}` (HomeScreen.tsx:470, FeedGrid.tsx:98), which defeats memoization even after fixing #1.
- **failure**: User pulls the feed to the very top and flick-scrolls. Crossing y=0 flips `scrolledFromTop`, re-rendering HomeScreen. All ~20 windowed NoteCards re-render (NoteContent re-executes its element tree) and all ~20 separator `View`s are destroyed and recreated natively — a visible frame drop, repeated every time the user bounces at the top of the list.
- **fix**: Fix in this order, all in mobile:
1. packages/mobile/src/components/NoteCard.tsx:99 — `export const NoteCard = React.memo(function NoteCard({ ... }));` matching web's NoteCard.tsx:544.
2. Make the props referentially stable or memo does nothing: change NoteCard's prop to `onToggleBookmark?: (noteId: string) => void` and have NoteCard call `onToggleBookmark?.(displayEvent.id)`, then pass the stable `toggleBookmark` directly at HomeScreen.tsx:470, DiscoverScreen.tsx:350 and SavedScreen.tsx:~144. Same for `isBookmarked` — pass the boolean is fine, it is already primitive.
3. Hoist the separator to module scope in HomeScreen.tsx: `const ItemSeparator = () => <View style={{ height: 8 }} />;` then `ItemSeparatorComponent={ItemSeparator}` at line 595.
4. HomeScreen.tsx:588 — guard the setState behind a ref so it only fires on an actual transition: `const atTop = useRef(true); onScroll={e => { const v = e.nativeEvent.contentOffset.y > 0; if (v !== atTop.current) { atTop.current = v; setScrolledFromTop(v); } }}`. Optionally drop scrollEventThrottle to 100 since the button is cosmetic.
5. Delete packages/mobile/src/components/FeedGrid.tsx entirely (unreferenced) rather than 'fixing' its separator — otherwise the next reader repeats the same audit.

### ☐ OPEN — DiscoverScreen calls useBulkAuthors() twice and never calls prefetchFromNotes — the Discover feed gets no batched profile prefetch
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/screens/DiscoverScreen.tsx:207`, `packages/mobile/src/screens/DiscoverScreen.tsx:343`, `packages/mobile/src/hooks/useAuthor.ts:151`, `packages/mobile/src/hooks/useAuthor.ts:155 — prefetchFromNotes is not wrapped in useCallback (web's packages/web/src/hooks/useBulkAuthors.ts:114 is); any effect depending on it re-runs every render`, `packages/mobile/src/screens/ThreadScreen.tsx — renders many distinct authors (useAuthor at line 38 per row, FlatList at line 295) with no bulk prefetch`, `packages/mobile/src/screens/NotificationsScreen.tsx:219 — FlatList of NotificationCard, each doing per-pubkey useAuthor (NotificationCard.tsx:93), no bulk prefetch; the finder missed this screen entirely`
- **detail**: `useBulkAuthors()` returns `{ prefetchFromNotes }` and has no effects of its own — calling it without using the return value does literally nothing. DiscoverScreen invokes it twice and discards the result both times:
```ts
  useBulkAuthors();            // DiscoverScreen.tsx:207
  ...
  // Batch-prefetch author profiles
  useBulkAuthors();            // DiscoverScreen.tsx:343  ← comment says it prefetches; it does not
```
A repo-wide grep for `prefetchFromNotes` finds exactly one call site: `HomeScreen.tsx:374`. Discover has none.

Consequence: on Discover, every `NoteCard` falls through to per-pubkey `useAuthor` (useAuthor.ts:127), which is serialized through `withConcurrencyLimit` at `MAX_CONCURRENT_AUTHOR_FETCHES = 6` (useAuthor.ts:14), each racing a pool query plus 4-5 individual relay queries. The batched path (`useAuthor.ts:182-185`) would resolve up to 100 pubkeys in one filter.
- **failure**: User opens Discover with 60 notes from ~50 distinct authors. Instead of one `{kinds:[0], authors:[…50]}` query, the app issues 50 separate profile lookups drained 6 at a time, each fanning out to the pool + PROFILE_INDEXER_RELAYS + 2 fallbacks. Names resolve slowly and many cards sit on `user_xxxx` for the whole session; relays see ~250 redundant kind-0 requests.
- **fix**: Delete the dead call at DiscoverScreen.tsx:207. At DiscoverScreen.tsx:343 destructure and wire the effect against the memoized `notes` (DiscoverScreen.tsx:300, the same array passed to FlatList at line 453):
```ts
const { prefetchFromNotes } = useBulkAuthors();
useEffect(() => {
  if (notes && notes.length > 0) prefetchFromNotes(notes);
}, [notes, prefetchFromNotes]);
```
Note `prefetchFromNotes` is a plain function redeclared every render (useAuthor.ts:155 is not wrapped in useCallback, unlike web's useBulkAuthors.ts:114), so that dep array re-fires the effect on every render — wrap it in useCallback in useAuthor.ts as part of this fix, or the prefetch will re-run continuously (it is guarded by inFlightPubkeys/queryClient checks, but it still does the set-building work each time).

### ☐ OPEN — Every saved-note bookmark toggle busts the React Query cache key and re-fetches all saved notes from all relays
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/screens/SavedScreen.tsx:53`, `packages/mobile/src/screens/SavedScreen.tsx:59`, `packages/mobile/src/screens/SavedScreen.tsx:95`, `packages/web/src/components/SavedForLaterCorkboard.tsx:69-70 — same uncapped `[...userRelays.write, ...userRelays.read, ...FALLBACK_RELAYS]` fan-out, and lines 113-120 refetch the entire set whenever `savedIds.length` changes (deps are `[savedIds.length]`), so removing one bookmark on web also re-downloads everything and flashes the skeleton grid at lines 186-195. Web's `setFailedIds` at line 98 has the same stale-on-remount problem.`
- **detail**: The query key embeds the full id list:
```ts
queryKey: ['saved-notes', savedIds.join(',')],   // SavedScreen.tsx:53
```
and `savedIds` (line 47-49) is the union of `collapsedIds` and `bookmarkIds`. Any bookmark add/remove or collapse/expand — from *anywhere* in the app, since `useCollapsedNotes`/`useBookmarks` broadcast — changes `savedIds`, changes the key, and forces a cold fetch of a brand-new cache entry.

That fetch is expensive: `relaysToQuery` is `user.write ∪ user.read ∪ FALLBACK_RELAYS` (line 59) with **no cap**, and the loop issues one query per relay per 50-id batch (lines 65-80).

Separately, `setFailedIds(missing)` at line 95 is a `setState` call executed inside the `queryFn`. React Query may run that function after the component unmounts (background refetch, retry), and the write is invisible to the query cache so a cache hit on a previously-fetched key leaves `failedIds` stale.
- **failure**: User with 120 saved notes and 8 configured relays taps "Remove" on one note in the Saved list. `savedIds` shrinks by one → new query key → full refetch: 3 batches × 8 relays = 24 relay queries re-downloading 119 notes that were already in memory a moment ago. On cellular this is several hundred KB per tap, and the list flashes its loading state each time.
- **fix**: Two independent fixes. (1) Stop keying on the id list: use `queryKey: ['saved-notes', pubkey]` and read `savedIds` from the closure, then render `sortedEvents.filter(e => savedIdSet.has(e.id))` so a Remove is instant and local with zero network. Trigger an actual fetch only for ids not already in the cache (or via explicit `refetch()`/`queryClient.setQueryData` splice). If you keep an id-derived key, at minimum add `placeholderData: keepPreviousData` so the list does not blank. (2) Cap the fan-out at SavedScreen.tsx:59 with the constant that already exists: `.slice(0, MAX_REFERENCE_RELAYS)` (export it from packages/mobile/src/lib/NostrProvider.tsx:38). Separately, move failed-id tracking out of component state into the query result — return `{ events, missing }` from the queryFn — so a cache hit still renders the failed banner instead of dropping it.

### ☐ OPEN — Ten <Modal> instances omit onRequestClose, so the Android hardware/gesture back button does nothing inside them
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/screens/HomeScreen.tsx:635`, `packages/mobile/src/screens/HomeScreen.tsx:643`, `packages/mobile/src/screens/HomeScreen.tsx:654`, `packages/mobile/src/screens/DiscoverScreen.tsx:375`, `packages/mobile/src/screens/DiscoverScreen.tsx:501`, `packages/mobile/src/screens/SettingsScreen.tsx:515`
- **detail**: React Native's `Modal` requires `onRequestClose` on Android — it is the only hook for the hardware back button and the predictive-back gesture. Of the 22 `<Modal>` usages in `packages/mobile/src`, 12 supply it (e.g. `MediaLink.tsx:363`, `AddAccountModal.tsx:188`, `EmojiSetsModalProvider.tsx:31`) and 10 do not.

The missing ones include all three of HomeScreen's full-screen modals:
```tsx
<Modal visible={composing} animationType="slide">          // HomeScreen.tsx:635
<Modal visible={!!viewingProfile} animationType="slide">  // HomeScreen.tsx:643
<Modal visible={!!viewingThread} animationType="slide">   // HomeScreen.tsx:654
```
There is also no `BackHandler` usage anywhere in the package (grep for `BackHandler` / `hardwareBackPress` returns nothing), and `app.json:31` sets `"predictiveBackGestureEnabled": false`, so there is no fallback path either.

Because the feed's compose / profile / thread views are Modals rather than navigator screens, the tab navigator's own back handling does not apply to them.
- **failure**: Android user taps a note to open the thread modal, then presses the system back button expecting to return to the feed. Nothing happens — the back press is swallowed by the un-closable modal. The user must find and tap the in-UI "< Back" control; pressing back repeatedly does nothing (or on some OEM shells backs out of the app entirely from underneath the modal). Same for the compose modal, where a back press is the natural "discard draft" gesture.
- **fix**: Add `onRequestClose` to all ten, wired to the identical handler as the in-UI dismiss so the two can never drift: HomeScreen.tsx:635 `onRequestClose={() => { setComposing(false); setReplyTarget(null); }}`, :643 `onRequestClose={() => setViewingProfile(null)}`, :654 `onRequestClose={() => { setViewingThread(null); setThreadAutoReply(null); }}`; DiscoverScreen.tsx:375 and :501 `onRequestClose={() => setViewingProfile(null)}`; SettingsScreen.tsx:515 `onRequestClose={() => setShowSignup(false)}`, :531 `onRequestClose={() => setShowEditProfile(false)}`, :544 `onRequestClose={() => setShowEmojiEditor(false)}`; NoteActions.tsx:292 `onRequestClose={() => setZapModalVisible(false)}`, :316 `onRequestClose={() => setQuoting(false)}`. For the two compose modals (HomeScreen:635, NoteActions:316) route back through the same discard-confirmation the in-UI close uses rather than dropping the draft silently. Then add a lint rule forbidding `<Modal>` without `onRequestClose` — the repo already ships custom rules in packages/web/eslint-rules/, and packages/mobile has its own eslint config to hang it off.

### ☐ OPEN — Every NoteCard mounts useCollapsedNotes(), fanning 3 full localStorage arrays + 4 Set rebuilds + 6 window listeners per card
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NoteCard.tsx:583`, `packages/web/src/hooks/useCollapsedNotes.ts:90`, `packages/web/src/hooks/useCollapsedNotes.ts:91`, `packages/web/src/hooks/useCollapsedNotes.ts:95`, `packages/web/src/hooks/useCollapsedNotes.ts:110`, `packages/web/src/hooks/useCollapsedNotes.ts:118`
- **detail**: `NoteCard` calls `const { isCollapsed, isCollapsedThisSession, isSoftDismissed, toggleCollapsed, dismiss, undoDismiss, canUndoDismiss, isBatchTrigger } = useCollapsedNotes()` (NoteCard.tsx:583) — once per rendered card. Each hook instance independently:

1. Runs three `useLocalStorage` calls that each do `JSON.parse` of a whole persisted id array on mount and again after `idbReady`:
```ts
const [collapsedIds, setCollapsedIds] = useLocalStorage<string[]>('collapsed-notes', [])        // MAX_COLLAPSED_NOTES = 10000
const [dismissedIds, setDismissedIds] = useLocalStorage<string[]>('dismissed-notes', [])        // MAX_DISMISSED_NOTES = 10000
const [dismissedThreadRoots, setDismissedThreadRoots] = useLocalStorage<string[]>('dismissed-thread-roots', [])
```
2. Registers 3 more window listeners (useCollapsedNotes.ts:110-113) on top of the 3 `idb-storage-sync` listeners added by the `useLocalStorage` calls.
3. Builds four Sets from those arrays (useCollapsedNotes.ts:118-121):
```ts
const collapsedSet = useMemo(() => new Set(collapsedIds), [collapsedIds])
const dismissedSet = useMemo(() => new Set(dismissedIds), [dismissedIds])
const softDismissedSet = useMemo(() => new Set(softDismissedIds), [softDismissedIds])
const dismissedThreadRootSet = useMemo(() => new Set(dismissedThreadRoots), [dismissedThreadRoots])
```

Any write to one of those keys goes through `idbSetSync` → `idbSet(...).then(() => dispatchSyncEvent(key, tryParse(value)))` (idb.ts:232-235), which dispatches a single `idb-storage-sync` CustomEvent that all listeners receive with the *same* freshly-parsed array reference. Every `useLocalStorage` instance for that key then `setState`s a new reference, so every mounted NoteCard re-renders and rebuilds its Sets — React.memo cannot stop this because it is internal state, not props.

FeedGrid renders up to `MAX_RENDER_PER_COL = 200` cards per column (FeedGrid.tsx:28) with column counts up to 9 (MultiColumnClient.tsx:1080 comment: "1-9").
- **failure**: Long-time user with 4,000 dismissed ids and 3 columns × 200 rendered notes = 600 mounted NoteCards. Mount cost: 600 × 3 = 1,800 `JSON.parse` calls over a ~260 KB id array each (plus 1,800 more from the `idbReady` re-read effect) — hundreds of ms of blocked main thread on tab switch. Steady state: ~3,600 window listeners and 600 × 4 = 2,400 live Sets holding ~9.6M entries. Clicking the red dismiss corner on one note fires `notifySoftDismissChange()` + a `collapsed-notes` write; all 600 cards re-render and each rebuilds four Sets — a single dismiss costs O(cards × ids) work, which is the rising idle/interaction CPU the NoteCard memo comparator comment already gestures at.
- **fix**: Hoist the three IDB-backed arrays out of the per-card hook. Create a `CollapsedNotesProvider` mounted once in `MultiColumnClient` that owns the `useLocalStorage('collapsed-notes'|'dismissed-notes'|'dismissed-thread-roots')` calls and the four Sets, and back membership queries with a module-level external store so cards can subscribe per note id via `useSyncExternalStore(subscribe, () => collapsedSet.has(note.id))` — a dismiss then re-renders one card instead of all of them. Keep `useCollapsedNotes()` as the public API (now a `useContext` read of a `useMemo`'d value with referentially stable callbacks) so the other 4 call sites need no change. Web `NotificationCard.tsx:195` is the same per-card pattern and gets fixed by the same provider.

### ☐ OPEN — FeedGrid's React.memo is defeated by three unconditional inline-arrow props, so the whole feed render body re-runs on every parent render
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/FeedGrid.tsx:170`, `packages/web/src/pages/MultiColumnClient.tsx:4439`, `packages/web/src/pages/MultiColumnClient.tsx:4441`, `packages/web/src/pages/MultiColumnClient.tsx:4442`, `packages/web/src/components/FeedGrid.tsx:272`, `packages/web/src/components/FeedGrid.tsx:281`
- **detail**: `export const FeedGrid = React.memo(function FeedGrid({...})` (FeedGrid.tsx:170) uses the default shallow prop compare, but `MultiColumnClient` passes three props that are new function objects on every single render:
```tsx
onOpenEmojiSets={() => setEmojiSetsOpen(true)}      // :4439
onZapClick={(note) => setZapTargetNote(note)}       // :4441
onRepost={(note) => openRepost(note)}               // :4442
```
So `React.memo` never bails out. Every `MultiColumnClient` render (and it re-renders often: `forceUpdate` in `useFeedPagination.ts:184/192/200`, the 1-second StatusBar countdown chain, autofetch, dismissals) re-executes the entire FeedGrid body: `columns.map(col => col.slice(...))` (`visibleColumns`, :272, not memoized), the `[visibleColumns]` effect at :281-300 (which therefore runs on *every* render because the array identity is new), and the full per-note loop at :429-470 that builds ~8 closures and several derived values per note.

The `noteCardPropsEqual` comparator (NoteCard.tsx:508) saves the *cards* from re-rendering, but nothing saves the FeedGrid render body itself.
- **failure**: 3 columns × 200 rendered notes. Autofetch tick (every 120 s by default) or any dismiss triggers a `MultiColumnClient` render → FeedGrid re-renders → 600 iterations of the note loop allocating ~4,800 closures and 600 React elements with ~30 props each, plus the two per-render column-fingerprint arrays, for zero visible change. On a corkboard with hashtags active this is compounded by finding #7 below.
- **fix**: Stabilize ALL unstable FeedGrid props, not just the three cited, or the memo still never bails: (1) `useCallback` the three inline arrows — `const handleOpenEmojiSets = useCallback(() => setEmojiSetsOpen(true), [])`, `const handleZapClick = useCallback((note: NostrEvent) => setZapTargetNote(note), [])`, `const handleRepostClick = useCallback((note: NostrEvent) => openRepost(note), [openRepost])`; (2) convert `openThread` (MultiColumnClient.tsx:486) from a plain function declaration to `useCallback([])` — it is passed twice, as `onThreadClick` and `onOpenThread`; (3) hoist the saved-tab no-ops to a module-level `const NOOP = () => {}` so `onLoadNewer`/`onLoadMore` stop reallocating; (4) memoize `activeHashtags` (MultiColumnClient.tsx:2077) with `useMemo(() => activeCustomFeed?.hashtags ?? EMPTY_ARR, [activeCustomFeed?.hashtags])`. Inside FeedGrid, memoize `visibleColumns` — `useMemo(() => columns.map(col => col.slice(0, Math.min(renderLimit, MAX_RENDER_PER_COL))), [columns, renderLimit])` — so the rearrange-lockout effect at :281 stops firing every render.

### ☐ OPEN — mergedEngagementByTarget mutates the memoized engagement entries in place, so NoteCard's reference-equality comparator never sees lazily-fetched engagement
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/pages/MultiColumnClient.tsx:2946`, `packages/web/src/pages/MultiColumnClient.tsx:2964`, `packages/web/src/components/NoteCard.tsx:511`, `packages/web/src/components/FeedGrid.tsx:464`
- **detail**: The merge clones the Map but not its values:
```ts
// Clone the map so we don't mutate the original
const merged = new Map(engagementByTarget);          // :2946 — shallow: values are shared refs
...
let entry = merged.get(targetId);
if (!entry) { entry = { reactions: [], reposts: [], zaps: [] }; merged.set(targetId, entry); }
...
if (ev.kind === 7) entry.reactions.push(ev);         // :2964 — mutates the Stage-1 memo's object
```
For any target that already had an in-feed engagement event, `entry` is the *same object* the Stage-1 `deduplicatedNotes` memo created. FeedGrid passes it straight through (`engagement={engagementByTarget?.get(note.id) || ...}`, FeedGrid.tsx:464) and `noteCardPropsEqual` compares it by identity (`prev.engagement === next.engagement`, NoteCard.tsx:511). Because the object reference is unchanged, the comparator returns true and the card is skipped.

The comment on :2945 ("Clone the map so we don't mutate the original") states an invariant the code does not uphold.
- **failure**: A note in the feed already has one reaction that arrived as its own kind-7 event, so `engagementByTarget` has an entry for it. The `['lazy-engagement', ...]` query then returns 40 more reactions and 3 zaps for that note. `entry.reactions`/`entry.zaps` grow in place, the Map value reference is unchanged, `noteCardPropsEqual` returns true, and the card keeps showing "1 reaction" until something unrelated forces it to re-render. Notes with *no* prior in-feed engagement get a brand-new entry object and update correctly — so the bug looks intermittent.
- **fix**: Deep-copy the entries when cloning so the Stage-1 memo stays pure and the identity change propagates through `noteCardPropsEqual`: replace `const merged = new Map(engagementByTarget)` (MultiColumnClient.tsx:2946) with `const merged = new Map<string, EngagementEntry>(); for (const [k, v] of engagementByTarget) merged.set(k, { reactions: [...v.reactions], reposts: [...v.reposts], zaps: [...v.zaps] });` and mutate only the copies. Copy-on-write (cloning only targets that actually receive a lazy event) is also correct and cheaper, but a plain per-entry clone is fine here since the map is bounded by the 100-id cap at :2921. Do NOT instead relax `noteCardPropsEqual` to a deep compare — the identity check is what keeps the O(cards) reconcile cheap.

### ☐ OPEN — lazy-engagement query key is a join of the top-100 note ids, so every feed shift fires a fresh 500-event relay query and leaks a new cache entry
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/pages/MultiColumnClient.tsx:2915`, `packages/web/src/pages/MultiColumnClient.tsx:2926`, `packages/web/src/pages/MultiColumnClient.tsx:2932`
- **detail**: ```ts
const lazyEngagementNoteIds = useMemo(() => {
  const ids = deduplicatedNotes.filter(n => n.kind === 1 || n.kind === 30023).slice(0, 100).map(n => n.id);
  return ids.join(',');
}, [canLoadNotes, deduplicatedNotes]);          // :2915-2923

const { data: lazyEngagement } = useQuery({
  queryKey: ['lazy-engagement', lazyEngagementNoteIds],   // :2926 — ~6.5 KB string
  queryFn: async () => nostr.query([{ kinds: [7, 9735, 6, 16], '#e': ids, limit: 500 }], ...),  // :2932
  staleTime: 5 * 60 * 1000, gcTime: 10 * 60 * 1000,
});
```
The key is derived from feed *contents*. `deduplicatedNotes` changes whenever `newerNotes` gets a single prepended note (autofetch), whenever a filter changes, or whenever the tab data updates — and each such change shifts the 100-id window, producing a different key and therefore a brand-new query, not a refetch. TanStack also re-hashes (JSON.stringify) that 6.5 KB key on every render of the component.
- **failure**: Autofetch is on at the 120 s default. Each tick prepends ≥1 new kind-1 note, shifting the top-100 window → new query key → a new `{kinds:[7,9735,6,16], '#e':[100 ids], limit:500}` request to every routed relay. Over one hour that is 30 distinct 500-event queries (up to 15,000 events transferred), with ~5 result sets simultaneously resident because `gcTime` is 10 min. On a fast-moving all-follows feed with several new notes per tick the effect is the same but the previous results are never reused, since no two keys overlap.
- **fix**: Stop deriving the key from feed order. Keep a `useRef<Set<string>>` of ids already covered by a completed lazy-engagement fetch; on each Stage-1 recompute, diff the current top-100 against it and only issue a query for the delta, keying on `['lazy-engagement', activeTab, deltaBucketIndex]` with the id list passed through the `queryFn` closure. If the delta approach is too invasive, the minimal change is to (a) sort the ids before joining so re-ordering alone cannot change the key, and (b) bucket them into fixed groups (e.g. hash each id's first byte into 4 buckets, one query per bucket) so a single prepend invalidates one bucket instead of all 100 ids. Either way drop `gcTime` to roughly `staleTime` so superseded result sets are not retained for 10 minutes.

### ☐ OPEN — No route-level or feature-level code splitting: the entire app ships as one 1.29 MB entry chunk plus 2 MB of eagerly-loaded JS
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/AppRouter.tsx:6`, `packages/web/src/pages/MultiColumnClient.tsx:42`, `packages/web/src/pages/MultiColumnClient.tsx:65`, `packages/web/src/pages/MultiColumnClient.tsx:83`, `packages/web/vite.config.ts:33`
- **detail**: `AppRouter.tsx` imports every route statically (`import { MultiColumnClient } from "./pages/MultiColumnClient"` etc., :5-7) — no `lazy()`, so the `<Suspense>` in `App.tsx:59` never has anything to defer. `MultiColumnClient` then statically imports every heavy modal: `ThreadPanel` (:42, pulls in `@tanstack/react-virtual` + react-markdown), `ZapDialog`, `WalletSettings`, `EditProfileForm`, `ProfileCacheSettings`, `ThroughputSettings`, `AdvancedSettings`, `EmojiSetEditor` (:83-89), `AccountSwitcher`, `WelcomePage`, `BackupSplashScreen`, `NotificationsCorkboard`.

The single `lazy()` (`ComposeDialog`, :65-72) is also eagerly fetched, because the dynamic import is executed at module scope:
```ts
const composeImport = import('@/components/ComposeDialog').catch(() => null);   // :65 — fires at app boot
```

Measured from the checked-in build in `packages/web/dist/assets/`: `index.js` 1,315,770 B, `vendor-nostr.js` 284,270 B, `vendor-radix.js` 272,662 B, `vendor-markdown.js` 160,429 B, `vendor-react.js` 21,572 B, `index.css` 99,990 B — ≈2.05 MB uncompressed JS + 100 KB CSS, all requested before first paint. `ComposeDialog.js` (8,775 B) is the only split chunk, and it too is fetched immediately.
- **failure**: A first-time visitor on a 3G-class connection downloads, parses and executes ~2 MB of JS before the feed skeleton appears, including the thread virtualizer, the emoji-set editor, the wallet/NWC UI and the advanced-settings panel — none of which are on the first-paint path. On low-end mobile the parse/compile alone is 1-2 s.
- **fix**: 1. Route-split `packages/web/src/AppRouter.tsx`: `const MultiColumnClient = lazy(() => import('./pages/MultiColumnClient'))` plus the same for NIP19Page/NotFound — the `<Suspense>` in App.tsx:59 already exists to catch it. 2. Convert the modal imports at MultiColumnClient.tsx:42 and :83-89 to `lazy()` behind their existing open-state guards; `ThreadPanel` and `EmojiSetEditor` are the highest-value two because they drag in the virtualizer and the emoji data. 3. Keep the ComposeDialog warm-up but move it off the boot critical path: `requestIdleCallback(() => import('@/components/ComposeDialog'))` inside an effect rather than at module scope (:65). 4. Independently, add an `<IfModule mod_deflate.c>` block to packages/web/.htaccess for js/css/json/svg — that is a one-line-per-type change that cuts transfer ~3x regardless of whether the splitting work happens.

### ☐ OPEN — useNotifications sets refetchOnWindowFocus on an infinite query, so every focus refetches all loaded pages
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useNotifications.ts:200`, `packages/web/src/hooks/useNotifications.ts:222`, `packages/web/src/hooks/useNotifications.ts:152`, `packages/mobile/src/hooks/useNotifications.ts:215`, `packages/mobile/src/screens/NotificationsScreen.tsx:219`
- **detail**: ```ts
refetchOnWindowFocus: true,   // :200 — overrides the global `refetchOnWindowFocus: false` in App.tsx:27
refetchOnReconnect: true,     // :201
```
on a `useInfiniteQuery` (:152). TanStack Query refetches *every* loaded page on an infinite-query refetch, sequentially. `loadNewer` compounds this — it is `useCallback(() => { refetch(); }, [refetch])` (:222), documented as "refetch from the top", but it actually re-pulls all pages.

Each page is `nostr.query([{kinds:[1,6,7,16,9735], '#p':[user.pubkey], limit:100, until}], {signal: AbortSignal.timeout(12000)})`.
- **failure**: User loads 6 pages of notifications (600 items) via "load more", then alt-tabs away and back. Focus fires a refetch of all 6 pages — 6 sequential relay round-trips with 12 s timeouts each, up to 600 duplicate events pulled. Every alt-tab repeats it. Clicking "Newer" in the StatusBar does the same thing instead of a single since-query.
- **fix**: Replace `loadNewer` with a true since-query instead of `refetch()`: query `[{kinds: NOTIF_KINDS, '#p': [user.pubkey], since: newestTimestamp + 1, limit: NOTIF_PAGE_SIZE}]` and merge the result into page 0 via `queryClient.setQueryData(['notifications', user.pubkey], old => ({...old, pages: [{...old.pages[0], items: mergedDeduped}, ...old.pages.slice(1)]}))`. That is also the correct fix for mobile's pull-to-refresh. For the focus/reconnect path, either add `maxPages: 1`-style semantics or drop `refetchOnWindowFocus: true` and instead run the same targeted since-query from a focus listener throttled to once per 60 s. Keep `retry`/`retryDelay` as-is — they were added deliberately (:194-199) and are not the problem. Apply the loadNewer change to packages/mobile/src/hooks/useNotifications.ts:215 in the same commit (desktop ships the web bundle, so it is covered by the web fix).

### ☐ OPEN — NotificationsCorkboard renders every loaded notification with no incremental-render cap or virtualization
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NotificationsCorkboard.tsx:275`, `packages/web/src/components/NotificationsCorkboard.tsx:144`, `packages/web/src/components/NotificationCard.tsx:195`, `packages/web/src/components/thread/ThreadTree.tsx:2`
- **detail**: The grid maps the full filtered list with no slice:
```tsx
{columns.map((col, ci) => (
  <div key={ci} className="space-y-3">
    {col.map(notification => <NotificationCard key={notification.event.id} ... />)}
```
(:277-285, columns built from the full `filtered` array at :144-148). There is no `INITIAL_RENDER_PER_COL`/`MAX_RENDER_PER_COL` equivalent to `FeedGrid.tsx:21-28`, and no virtualization — `@tanstack/react-virtual` is a dependency but is used in exactly one place, `thread/ThreadTree.tsx:2`, never in either feed.

Each `NotificationCard` calls `useCollapsedNotes()` (NotificationCard.tsx:195), so it inherits the full per-card cost described in the first finding.
- **failure**: Notifications page size is 100 (`NOTIF_PAGE_SIZE`, useNotifications.ts:134). After 8 "load more" clicks the user has 800 notifications, all mounted simultaneously: 800 NotificationCards × (3 localStorage array parses + 4 Set builds + 6 window listeners) at mount, and ~50k DOM nodes. The tab becomes unusable and any dismiss re-renders all 800.
- **fix**: Mirror FeedGrid's pattern in NotificationsCorkboard: add `const [renderLimit, setRenderLimit] = useState(8)`, slice each column (`col.slice(0, renderLimit)`) at :277, grow via an IntersectionObserver sentinel below the grid (+8 per trigger), cap at ~200/col, and reset renderLimit when `hiddenTypes` or `columnCount` change so filter toggles don't leave a stale window. Separately, hoist the useCollapsedNotes state out of the per-card hook — lift `isCollapsed`/`isSoftDismissed`/`isCollapsedThisSession` lookups into NotificationsCorkboard (which already calls useCollapsedNotes at :91) and pass booleans down as props, so the 6-listeners-plus-3-parses cost is paid once instead of once per card; also hoist the inline `[]` defaults in useCollapsedNotes to module constants so useLocalStorage's `[key, defaultValue]` effect stops re-registering its listener on every render.

### ☐ OPEN — Build emits unhashed asset filenames, forcing a 5-minute max-age and a revalidation round-trip per asset on every visit
- **area**: `perf-web` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/vite.config.ts:33`, `packages/web/vite.config.ts:34`, `packages/web/vite.config.ts:35`, `packages/web/.htaccess:32`
- **detail**: ```ts
entryFileNames: `assets/[name].js`,
chunkFileNames: `assets/[name].js`,
assetFileNames: `assets/[name].[ext]`,   // vite.config.ts:33-35 — no [hash]
```
Because the URLs are stable across deploys, the server config is forced to disable long-term caching:
```apache
# Bundles are emitted UNHASHED (assets/[name].js — see vite.config.ts
# entryFileNames/chunkFileNames), so they must NOT be cached as immutable.
<FilesMatch "\.(js|css)$">
  Header set Cache-Control "public, max-age=300, must-revalidate"   # .htaccess:33
</FilesMatch>
```
There are 9 emitted assets in `packages/web/dist/assets/`.
- **failure**: A returning user more than 5 minutes since their last visit issues 9 conditional GETs (index.js, index.css, 4 vendor chunks, runtime, core.js, event.js) before the app can start — 9 round-trips × RTT of dead time on a high-latency mobile link, every session, forever. With content hashing those would all be served from disk cache with zero network.
- **fix**: Change vite.config.ts:33-35 to `assets/[name]-[hash].js` / `assets/[name]-[hash].js` / `assets/[name]-[hash].[ext]`. Vite rewrites the index.html script/link tags automatically, so nothing hand-maintained breaks. Then: (a) .htaccess — replace the `<FilesMatch "\.(js|css)$">` block with a path-scoped `<FilesMatch "^assets/.*\.(js|css)$">` (or a `<Directory>`/`Location /assets>` rule) setting `public, max-age=31536000, immutable`, and delete the now-wrong "emitted UNHASHED" comment at :29-31; keep the index.html/404.html no-store block at :23-27 untouched. (b) public/sw.js — the .js/.css handler at :57-67 can and should become cache-first once names are content-hashed, and the 6-line rationale comment at :51-56 must be rewritten since its premise no longer holds. Note the finder's suggestion to "update sw.js if it precaches by filename" is moot: sw.js has no precache list — it caches opportunistically on fetch, and the activate handler (:15-21) already purges old caches per CACHE_VERSION.

### ☐ OPEN — Mobile logout never clears the notes cache — cached note bodies survive sign-out and leak across accounts (clearNotesCache has zero callers)
- **area**: `privacy-cypherpunk` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/lib/AuthContext.tsx:421-437`, `packages/mobile/src/lib/AuthContext.tsx:361-372`, `packages/mobile/src/lib/notesCache.ts:186`, `packages/mobile/src/lib/notesCache.ts:23-25`, `packages/web/src/hooks/useLoginActions.ts:358`, `packages/mobile/src/lib/userZapCache.ts:23`
- **detail**: Mobile's `logout()` (AuthContext.tsx:421-437) does: `bumpSessionEpoch()`, per-account `handleLogoutStorage(pk)`, `Keychain.resetGenericPassword(...)`, `setStoredActiveAccount(null)`, `clearRelayCache()`, `clearCollapsedNotesModuleState()`, `clearProfileCache()`. It never calls `clearNotesCache()`. Grepping the whole mobile package for `clearNotesCache` returns exactly one hit — its own `export` at notesCache.ts:186 — so the function has **zero callers**. The cache keys are `NOTES_PREFIX = 'notes-cache:'` + `event.id` (notesCache.ts:23-25): flat, NOT namespaced by pubkey. `switchAccount` (AuthContext.tsx:361-372) is the same story — it clears the relay cache, collapsed-notes state, and evicts one profile, but leaves `notes-cache:*` intact. Web does this correctly: `useLoginActions.ts:358` calls `await clearNotesCache()` inside `logoutAccount`, and again at line 429 inside `nuclearWipe`. This is a direct violation of the CLAUDE.md rule that platforms must not diverge, with a concrete privacy consequence.
- **failure**: Alice signs into the mobile app, reads her private curated corkboard (3000 note events land in `notes-cache:<id>` in MMKV), and signs out on a shared/家族 device. Bob signs in with his own npub. `loadNotesFromStorage` repopulates the L1 map from the same un-namespaced `notes-cache:` keys, so Alice's cached notes are seeded into Bob's feed and remain readable on disk indefinitely. Same result for a single user switching between a public and a pseudonymous account — the pseudonymous session is served the public account's cached content.
- **fix**: In packages/mobile/src/lib/AuthContext.tsx add `import { clearNotesCache } from './notesCache'` and `await clearNotesCache().catch(() => {})` in `logout()` (after line 437), in `removeAccount()` (after line 394), and in `switchAccount()` after `clearRelayCache()` at line 370 — matching packages/web/src/hooks/useLoginActions.ts:358. In the same three places also call `clearUserZapCache()` (packages/mobile/src/lib/userZapCache.ts:23, whose docstring already reads "Call on logout to avoid cross-user contamination" and has zero callers), `clearParentNoteCache()` (packages/mobile/src/hooks/useParentNotes.ts:203, zero callers), and `clearCache()` (packages/mobile/src/lib/cacheStore.ts:144, zero callers — the `PROFILE_PREFIX`/`NOTE_PREFIX` MMKV shards survive logout today). Then namespace the L2 keys as `notes-cache:<pubkey>:<id>` so a future missed clear degrades to wasted disk instead of cross-account disclosure, and reset the module-level `memCache`/`memCacheAccessTime`/`sortedCache` at notesCache.ts:32-35 in the same call.

### ☐ OPEN — Every emoji picker bypasses the image proxy, the SSRF host gate, and referrer policy — fans out to 9 third-party CDNs and loads attacker-chosen URLs
- **area**: `privacy-cypherpunk` · **platforms**: web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/compose/CombinedEmojiPicker.tsx:290-295`, `packages/web/src/components/compose/CombinedEmojiPicker.tsx:265-270`, `packages/web/src/components/compose/CombinedEmojiPicker.tsx:309-314`, `packages/web/src/components/EmojiSetEditor.tsx:559-565`, `packages/web/src/components/EmojiSetEditor.tsx:957-962`, `packages/mobile/src/components/EmojiPicker.tsx:252-256`
- **detail**: Every other image sink in the app routes through `optimizeMediaUrl()` (packages/core/src/imageUtils.ts:66-87), which runs `shouldRejectUrl()` (blocks private/loopback/credentialed hosts) and then `applyImageProxy()`. Compare NoteContent.tsx:381 (`const safeUrl = optimizeMediaUrl(part.value)`) and EngagementBar.tsx:53. The emoji pickers do not: CombinedEmojiPicker.tsx:290-295 renders `<img src={emoji.url} … loading="lazy" />` with no `optimizeMediaUrl`, no `applyImageProxy`, and no `referrerPolicy` — same at lines 265-270 (search results) and 309-314 (subscribed custom sets). EmojiSetEditor.tsx:559-565 (the "Browse" panel that renders kind-30030 sets discovered from relays) and :957-962 do the same. Mobile EmojiPicker.tsx:252-256 and :276-280 use `<Image source={{ uri: e.url }} />` raw. The only gate applied is `isValidMediaUrl` (textareaUtils.ts:20-27), which checks nothing but `u.protocol === 'https:' || u.protocol === 'http:'` — it permits plaintext http and any private/loopback/metadata host. Two consequences: (a) opening the default emoji tab issues ~200 requests to `cdn.jsdelivr.net`, `cdn.betterttv.net` (defaultEmojiSet.ts:93-95), `relay.nyves.nl`, `s.basspistol.org`, `i.nostr.build`, `image.nostr.build`, `blossom.primal.net`, `cdn.satellite.earth`, and `mibo.eu.nostria.app` — nine third parties, including Twitch-adjacent BTTV — even for a user who configured an image proxy; (b) a hostile kind-30030 set browsed in EmojiSetEditor can point at `http://192.168.1.1/probe.png` and the client will fetch it. The AdvancedSettings copy at line 681 promises "Route **every** avatar and inline image through an image-proxy so your IP and Referer aren't sent to each random host" — that promise is false in the pickers.
- **failure**: A privacy-conscious user sets the image proxy to their own instance and taps the emoji button to react to a note. Their real IP is handed directly to cdn.jsdelivr.net (Fastly) and cdn.betterttv.net, correlating the visit with any other site those CDNs serve them. Separately, an attacker publishes a kind-30030 emoji set with `url` = `http://192.168.1.1/cgi-bin/luci` and gets it listed in Browse; every user who opens the Browse panel makes their browser probe their own router, and load-success/failure timing is observable to the attacker via a follow-up set that encodes the result.
- **fix**: Route every emoji sink through the same helper NoteContent.tsx:66-67 already uses. Web: `src={optimizeMediaUrl(emoji.url)}` from '@/lib/imageUtils', skip the element when it returns '' , and add `referrerPolicy="no-referrer"` for parity with EmojiSetEditor.tsx:808. Mobile: `uri: optimizeMediaUrl(e.url)` from '@core/imageUtils'. Then delete the weak duplicate gates rather than leaving them as a false safety net — tighten packages/web/src/lib/textareaUtils.ts:20-27 to require `https:` and call `isUnsafeHost()` from '@core/ipUtils', and replace the copy-pasted `isValidMediaUrl` at packages/mobile/src/components/EmojiPicker.tsx:53 with an import of the shared version. Separately, self-host the 12 twemoji/BTTV assets under /assets/ or gate the Corkboards-Default tab behind an explicit load click — 80 emoji across 9 third parties on picker-open is the part users cannot avoid, and it contradicts "minimal external requests" regardless of whether a proxy is configured. Desktop needs no separate change: it runs the same web bundle.

### ☐ OPEN — RSS is silently dead on desktop — the relative proxy path resolves to the bundled PHP source inside the Tauri webview
- **area**: `privacy-cypherpunk` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/core/src/feedConstants.ts:19`, `packages/web/src/lib/feedUtils.ts:29-36`, `packages/desktop/src-tauri/tauri.conf.json:7`, `packages/web/public/rss-proxy.php`, `packages/web/src/pages/MultiColumnClient.tsx:1431-1432`, `packages/web/src/lib/feedUtils.ts:35`
- **detail**: `RSS_PROXY = '/rss-proxy.php'` (feedConstants.ts:19) is a relative path, and feedUtils.ts:29-30 does `fetch(`${RSS_PROXY}?url=…`)`. Tauri's `frontendDist` is `"../../web/dist"` (tauri.conf.json:7), and `rss-proxy.php` lives in `packages/web/public/`, so Vite copies it verbatim into `dist/` — confirmed: `ls packages/web/dist/` shows `rss-proxy.php` (20090 bytes). Inside the Tauri webview the app origin is `tauri://localhost`, so `/rss-proxy.php` resolves to that static asset and the webview receives the **raw PHP source**, not JSON. feedUtils.ts:35 then hits `try { data = JSON.parse(text) } catch { debugError('[rss] Non-JSON response for', feedUrl); return null; }` — `fetchRssFeed` returns `null` for every feed, every time, and the failure is only visible in the debug log. There is no desktop override: grepping `packages/desktop/` for `RSS_PROXY`/`rss-proxy` returns nothing. Users on desktop get silently empty RSS columns. As a side effect the desktop bundle also ships the full PHP proxy source (including the allowlisted origins) as a readable asset.
- **failure**: A desktop user adds an RSS column. `MultiColumnClient.tsx:1432` validates the URL via `fetch('/rss-proxy.php?url=…&max=1')`, gets 20KB of PHP text back, `JSON.parse` throws, the feed is reported as unreachable or silently empty. The user concludes the feed is broken. Repeat for every RSS feed, permanently.
- **fix**: Desktop needs a real RSS path, and the PHP file must stop shipping in the Tauri bundle. (1) Preferred: add an `rss_fetch` Tauri command in packages/desktop/src-tauri/src/ that goes through the existing SOCKS5 plumbing in proxy.rs so RSS honours the Tor kill-switch (packages/web/src/components/AdvancedSettings.tsx:655 promises native queries FAIL rather than fall back to clearnet — an unproxied RSS fetch would break that promise), porting the SSRF/redirect/private-IP checks from rss-proxy.php (see packages/core/src/ipUtils.ts:64 for the existing client-side gate). Then branch in packages/web/src/lib/feedUtils.ts on `isTauri` (from @/lib/tauri) to call it. (2) Fix BOTH call sites, not just fetchRssFeed — packages/web/src/pages/MultiColumnClient.tsx:1431-1432 duplicates the raw `fetch(`${RSS_PROXY}?url=…`)` and must route through the same helper; today it shows a false 'Could not reach feed' toast on desktop. (3) Move rss-proxy.php out of packages/web/public/ to packages/web/ and copy it into dist_stage/dist_deploy at deploy time (which is what CLAUDE.md's stage/deploy steps already describe), so it stops being embedded in the desktop binary. (4) Make fetchRssFeed's JSON.parse failure surface a user-visible error instead of a silent `return null` — the silence is why this shipped undetected.

### ☐ OPEN — Blossom uploads fan out to every known server, not MIRROR_COPIES — and the hard-coded defaults are always appended even when the user configured their own
- **area**: `privacy-cypherpunk` · **platforms**: web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useUploadFile.ts:39-57`, `packages/web/src/hooks/useUploadFile.ts:113-118`, `packages/web/src/hooks/useUploadFile.ts:144`, `packages/mobile/src/hooks/useUploadFile.ts:45-62`, `packages/core/src/blossom.ts:27-34`, `packages/mobile/src/hooks/useUploadFile.ts:45-62`
- **detail**: useUploadFile.ts:113-118 unconditionally appends all six `DEFAULT_BLOSSOM_SERVERS` (= `KNOWN_BLOSSOM_SERVERS`, blossom.ts:27-34: blossom.band, blossom.primal.net, blossom.yakihonne.com, blossom.f7z.io, blossom.ditto.pub, nostr.download) to the user's own kind-10063 list — there is no branch that honours "only my servers". Then line 144 calls `mirrorToServers(file, others, MIRROR_COPIES - 1, user.signer)` where `others` is *every* remaining server. Inside `mirrorToServers` (lines 39-57) the loop is `servers.map(async (server) => { … uploader.upload(file) … })` wrapped in `Promise.allSettled` — every server is uploaded to in parallel; `count` is only consulted afterwards, at line 51 (`if (landed >= count) continue`), to decide how many to *report* as confirmed. So `MIRROR_COPIES = 3` does not bound uploads at all: the outer comment at lines 120-122 ("then mirror the same blob to MIRROR_COPIES-1 more servers") is contradicted by the code. Each upload carries a Blossom/NIP-98 auth event signed by the user's key, so all six operators receive the blob bytes, the user's pubkey, and their IP. Mobile is byte-identical (useUploadFile.ts:45-62).
- **failure**: A user who self-hosts Blossom publishes their kind-10063 with only `https://blossom.mydomain.tld/`, expecting their media to stay there. They post a photo. The photo, plus a kind-24242 auth event signed with their nsec, is uploaded to blossom.band, blossom.primal.net, blossom.yakihonne.com, blossom.f7z.io, blossom.ditto.pub, and nostr.download — six operators they never chose now hold the file and a signed proof of who uploaded it and when, from their IP. A deleted/unposted draft image that the user cancels before publishing is already replicated six ways.
- **fix**: Both packages/web/src/hooks/useUploadFile.ts and packages/mobile/src/hooks/useUploadFile.ts, kept identical per CLAUDE.md. (1) Bound the fan-out inside mirrorToServers itself rather than at the call site, so no future caller can reintroduce it: `const targets = servers.slice(0, count);` then `Promise.allSettled(targets.map(...))`. Drop the now-meaningless `if (landed >= count) continue` at line 51 and just push every fulfilled result. (2) Honour user choice: `const servers = new Set(userBlossomServers?.length ? userBlossomServers : DEFAULT_BLOSSOM_SERVERS)` — only fall through to the defaults when the user has no kind-10063 list, or when every one of their own servers threw (i.e. move the default append into the catch path after the user-server loop exhausts). (3) Wire the existing AdvancedSettings 'Include fallbacks' switch (packages/web/src/components/AdvancedSettings.tsx:704, 750-753) to uploads, not just to the backup server list — today it is a control the upload path cannot see. (4) Rewrite the comment at useUploadFile.ts:120-122 (and mobile's equivalent at :23-25) to state the real policy, since it is currently the reason the bug is invisible on review.

### ☐ OPEN — Every bulk feed query is sent to five fixed relay operators regardless of the user's NIP-65 list, contradicting the documented "fallback only" contract
- **area**: `privacy-cypherpunk` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NostrProvider.tsx:594-600`, `packages/core/src/relayConstants.ts:13-31`, `packages/web/src/components/NostrProvider.tsx:425`, `packages/mobile/src/lib/NostrProvider.tsx:426-428`, `packages/mobile/src/lib/NostrProvider.tsx:510-512`, `packages/web/src/components/NostrProvider.tsx:708-712`
- **detail**: `selectFeedRelays()` (NostrProvider.tsx:594-600) starts with `userRelays.read.forEach(...)` and then unconditionally does `FALLBACK_RELAYS.forEach(r => selected.add(...)); READ_ONLY_RELAYS.forEach(r => selected.add(...));` — the comment on line 597 even calls it "Guaranteed". Those are `wss://nos.lol`, `wss://relay.nostr.net`, `wss://relay.ditto.pub`, `wss://antiprimal.net`, `wss://indexer.nostrarchives.com` (relayConstants.ts:18-31). This function handles the Tier-1 bulk path, i.e. the follows feed, so the filter sent to all five carries `authors: [...]` batched at 500 pubkeys — the user's complete follow graph — on every feed load and every autofetch cycle. The declared contract directly contradicts this: relayConstants.ts:13-17 says FALLBACK_RELAYS are "used **only** when a user has no relays configured and no author relays are cached," and NostrProvider's own header comment at line 643-644 repeats "Falls back to FALLBACK_RELAYS only when the user has no relays configured." A user who deliberately runs a single private relay still broadcasts their entire social graph and IP to five third-party operators, permanently, with no setting to stop it. (`Router.configure`'s `getDefaultRelays` at line 425 does the same for the Tier-2 path.)
- **failure**: A user sets their NIP-65 read list to only `wss://relay.mydomain.tld` for privacy. On every feed refresh (autofetch runs on a timer) the app opens sockets to nos.lol, relay.nostr.net, relay.ditto.pub, antiprimal.net and indexer.nostrarchives.com and sends `{"kinds":[1,6,7,…],"authors":[<500 hex pubkeys>]}`. Five operators can each reconstruct exactly who this IP follows and correlate the same author set across sessions and IP changes — the precise disclosure the user's relay choice was meant to prevent.
- **fix**: Either wire the existing toggle or delete it — a Switch that only changes text colour is worse than no Switch. (1) Persist `includeFallbacks` (packages/web/src/components/AdvancedSettings.tsx:289) to a real setting via useAppContext/STORAGE_KEYS instead of useState, default true. (2) Read it in packages/web/src/components/NostrProvider.tsx:596-600 and gate the FALLBACK_RELAYS/READ_ONLY_RELAYS adds on `includeFallbacks || userRelays.read.length === 0` (never let the set go empty — falling back to zero relays would break the app). Apply the same gate to Router.configure's getDefaultRelays at line 425 and to the Tier-2b block at lines 708-712, which has the identical unconditional add. (3) Mirror all of it in packages/mobile/src/lib/NostrProvider.tsx:426-428 and :510-512, which are line-for-line the same. (4) Fix the false comment at packages/core/src/relayConstants.ts:11-16 — say these are queried on every bulk feed load for coverage, not 'only when a user has no relays configured'. Leaving it as is misrepresents the app's network behaviour to anyone auditing it, which matters more than usual for a project whose stated values are no third-party leakage and minimal external requests.

### ☐ OPEN — Desktop writes a plaintext activity log to disk unconditionally — no opt-in, no toggle, and it captures RSS feed URLs plus 500 chars of feed content
- **area**: `privacy-cypherpunk` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/main.tsx:55-102`, `packages/web/src/lib/debug.ts:3`, `packages/web/src/lib/feedUtils.ts:32`, `packages/web/src/pages/MultiColumnClient.tsx:777`, `packages/desktop/src-tauri/src/logger.rs:72-90`, `packages/web/src/lib/tauri.ts:32-57 (the write_log/clear_log IPC wrappers — no gating of their own)`
- **detail**: main.tsx:55-99 monkey-patches `console.log/warn/error` whenever `isTauri` is true, forwarding every call to `tauriLog` → the `write_log` IPC command → `~/.local/share/me.corkboards.desktop/debug.log` as plaintext (logger.rs:72-90). Separately, `packages/web/src/lib/debug.ts:3` sets `const DEBUG = import.meta.env.DEV || import.meta.env.VITE_DEBUG === 'true' || isTauri`, so *every* `debugLog()` in the codebase is live in the shipped desktop build and lands in that file. There is no way to turn it off: grepping the web package for `clearTauriLog`/`write_log` finds only main.tsx and lib/tauri.ts — no settings UI, no env gate, no runtime flag. What lands there is not just counters: feedUtils.ts:32 logs `debugLog('[rss] Raw response for', feedUrl, '→', text.slice(0, 500))` — the user's feed URLs plus 500 characters of article text — and MultiColumnClient.tsx:777 logs the user's pubkey prefix together with their full read and write relay lists. The redaction in main.tsx:64-68 and logger.rs:26-33 covers only `nsec1`/`ncryptsec1`/`secret=`; reading history and relay topology are not secrets by that definition and pass through verbatim. The file is truncated at startup (`clearTauriLog()`, main.tsx:57), so it is a per-session record — but a per-session plaintext record of what you read is exactly what a privacy-first client should not create by default.
- **failure**: A journalist runs the desktop app and reads an RSS feed. `~/.local/share/me.corkboards.desktop/debug.log` now contains their pubkey prefix, their complete relay list, every feed URL they loaded, and the first 500 characters of each article — in cleartext, on disk, readable by any other process running as that user and captured by any filesystem backup or forensic image. They never enabled logging and cannot disable it.
- **fix**: Three separate changes, smallest first. (1) Stop logging feed bodies unconditionally: packages/web/src/lib/feedUtils.ts:33 → `debugLog('[rss] Response for', feedUrl, '→', text.length, 'chars')`. This is a one-line change that removes the article-content leak on every platform at once and matches the discipline already used at packages/web/src/hooks/useBookmarks.ts:170. (2) Make the file sink opt-in: introduce `DESKTOP_FILE_LOG_KEY = 'corkboard:desktop-file-log'` (default off, read synchronously from localStorage) and change the guard at packages/web/src/main.tsx:55 to `if (isTauri && fileLogEnabled && !('__tauriConsoleOverride' in window))`. Add a matching toggle plus 'Open log folder' / 'Clear log' actions in packages/web/src/components/AdvancedSettings.tsx (the AdvancedSettings component is already shared with the Tauri webview, so gate the row on `isTauri`). Keep `clearTauriLog()` firing on every desktop boot regardless of the toggle, so turning the setting off also wipes whatever the previous session wrote. (3) packages/web/src/lib/debug.ts:3 — drop `|| isTauri` and read the same setting, otherwise the entire debugLog corpus keeps running (and keeps costing CPU) in the shipped desktop build even with the file sink off. Do NOT weaken the existing redaction while doing this; it is defense-in-depth for stray statements, not the control being replaced.

### ☐ OPEN — useBookmarks never publishes the removal of the last bookmark, and silently drops any publish that arrives while one is in flight
- **area**: `race-conditions` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useBookmarks.ts:299`, `packages/web/src/hooks/useBookmarks.ts:200`, `packages/web/src/hooks/useBookmarks.ts:239`
- **detail**: Two independent lost-write bugs in the same publish pipeline.

(a) The publish scheduler refuses to run on an empty list:
```js
if (!needsPublish.current || bookmarkIds.length === 0) return;
needsPublish.current = false;
```
Removing the last bookmark sets `needsPublish.current = true` and produces `bookmarkIds === []`, so the effect returns before scheduling — the kind 10003 update is never published and `needsPublish` is left dangling true.

(b) `publishBookmarkList` drops rather than queues concurrent calls:
```js
if (publishingRef.current) { debugWarn('[bookmarks] Publish skipped — already publishing'); return; }
```
There is no retry, no pending-payload slot, and the caller (a 1500ms `setTimeout`) has already cleared its timer, so the change is lost from the relay's perspective while local state still shows it applied.

Both are made permanent by the union-only merge at line 240 (`[...new Set([...relayResult.ids, ...prev])]`), which resurrects anything the relay still has.
- **failure**: (a) User has exactly one saved note and unsaves it. Local state → `[]`, IDB → `[]`, but no kind 10003 is published. On next launch the relay query returns the old single-entry list, the merge unions it back in, and the note reappears as bookmarked. The user cannot ever delete their last bookmark.

(b) User rapidly unsaves five notes. First removal debounces 1500ms then starts `publishBookmarkList` (sign + `nostr.event` with an 8s timeout). Removals 2-5 each reschedule and fire their 1500ms timer at ~3s, ~4.5s, ~6s — all while `publishingRef.current` is still true — so all four are dropped. Only removal #1 reaches the relay. Reload → the four notes come back via the union merge.
- **fix**: (a) Change the guard to `if (!needsPublish.current) return;` and let an empty array publish (a kind 10003 with an empty encrypted payload is the correct representation of "no bookmarks"). (b) Replace the boolean `publishingRef` with a pending-payload slot: while publishing, store the latest `newIds` in `pendingRef` and, in the `finally`, re-invoke `publishBookmarkList(pendingRef.current)` if one is queued — or simply wrap the body in `withKeyedLock(`bookmarks:${pubkey}`, ...)` from `@core/keyedMutex` so calls serialize instead of vanish. Mirror in `packages/mobile/src/hooks/useBookmarks.ts`.

### ☐ OPEN — usePinnedNotes optimistic cache write omits relayHints, so every pin/unpin after the first strips all relay hints from the kind 10001 list
- **area**: `race-conditions` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/usePinnedNotes.ts:289`, `packages/web/src/hooks/usePinnedNotes.ts:231`, `packages/web/src/hooks/usePinnedNotes.ts:160`, `packages/web/src/hooks/usePinnedNotes.ts:52`
- **detail**: The query function's contract is `{ ids, status, relayHints }` (declared at line 52, returned at lines 94/106/107). `togglePin`'s optimistic write drops the third field:

```js
queryClient.setQueryData(['pinned-notes', user.pubkey],
  { ids: newIds, status: newIds.length > 0 ? 'found' as const : 'none' as const });
```

Two consumers then read `relayHints` off that same cache entry and get `undefined`:

```js
const hints = pinListResult?.relayHints ?? {};                 // line 231, publishPinList
const tags = newIds.map(id => (hints[id] ? ['e', id, hints[id]] : ['e', id]));
```
```js
const cached = queryClient.getQueryData<{relayHints: Record<string,string>}>(['pinned-notes', user?.pubkey]);
const hints = cached?.relayHints ?? {};                        // line 160, fallback fetch
```

The code comment at lines 228-230 states the hints must be preserved precisely because "the read path relies on these hints to locate notes pinned from other authors; rebuilding bare `['e', id]` tags on every pin/unpin would strip them all (H3)" — the optimistic write reintroduces exactly that bug one toggle later. `togglePin` also computes `newIds` from the `pinnedIds` closure with no in-flight guard, so two toggles issued before the first `await publishPinList` resolves both derive from the same base and the second clobbers the first.
- **failure**: User has 8 pinned notes, 6 of them from other authors with relay hints in the kind 10001 e-tags. First pin of the session: `publishPinList` still closes over the fresh query data, so hints survive. `setQueryData` then replaces the cache entry with `{ids, status}`. React re-renders; `pinListResult.relayHints` is now `undefined`. Second pin (or unpin): `hints = {}` → the published event is `[['e', id1], ['e', id2], ...]` with every hint stripped. On the next cold start the NPool can't route to the other authors' relays, fallback 1 finds no hints, and the pinned notes render as unresolvable placeholders on the "me" tab.
- **fix**: Include the hints in the optimistic write: `queryClient.setQueryData(['pinned-notes', user.pubkey], (prev) => ({ ...prev, ids: newIds, status: newIds.length > 0 ? 'found' : 'none', relayHints: prev?.relayHints ?? {} }))`. Additionally add an in-flight guard (or `withKeyedLock(`pins:${pubkey}`)`) around `togglePin` so a second toggle recomputes from the post-publish list rather than the stale `pinnedIds` closure.

### ☐ OPEN — cacheStore.cacheNotes calls put() without a key on an out-of-line object store — every bulk note cache write throws and is swallowed
- **area**: `race-conditions` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/lib/cacheStore.ts:237`, `packages/web/src/lib/cacheStore.ts:96`, `packages/web/src/lib/cacheStore.ts:231`
- **detail**: The `notes` store is created with no `keyPath` and no `autoIncrement` (line 96: `db.createObjectStore('notes')`), i.e. out-of-line keys with no generator. The single-note writer supplies the key correctly:

```js
await db.put('notes', note, event.id);   // line 231 — correct
```

The bulk writer does not:

```js
const tx = db.transaction('notes', 'readwrite');
await Promise.all([
  ...events.map(async (event) => { const note = {...}; await tx.store.put(note); }),   // line 249 — no key
  tx.done,
]);
```

Per the IndexedDB spec, `put(value)` on an out-of-line store with no key generator throws `DataError` synchronously. The rejection is caught by the outer `try/catch` and reduced to `debugWarn('[NoteCache] Failed to cache notes:', error)`, which is a no-op outside dev. The offline note cache therefore never receives a single bulk-written note.
- **failure**: Any call site that bulk-caches a fetched batch (feed load, thread load) calls `cacheNotes(events)`. Every invocation throws `DataError: The object store uses out-of-line keys and has no key generator and the key parameter was not provided`, is swallowed by the catch, and zero notes are persisted. `getCachedNotes(ids)` consequently always returns an empty map, so the documented "offline-first note lookup" path is dead: on a cold start with no network, previously-viewed threads render as unresolved placeholders instead of coming from cache. Because the failure is silent, cache-hit metrics and the `getCacheStats()` note count both read 0 forever.
- **fix**: Pass the key: `await tx.store.put(note, event.id);` — matching `cacheNote` at line 231. Alternatively create the store with `{ keyPath: 'id' }` in the `upgrade` handler and bump `DB_VERSION`, but that requires a migration; the one-line key argument is the safe fix. Add a regression test asserting `getCachedNotes` returns entries after `cacheNotes`.

### ☐ OPEN — Mobile idle auto-restore silently overwrites meaningful local data whenever the cloud checkpoint is newer — web's guard refuses in the same situation
- **area**: `race-conditions` · **platforms**: mobile · **verdict**: UNVERIFIED
- **files**: `packages/mobile/src/components/AutoSaveManager.tsx:128`, `packages/mobile/src/components/AutoSaveManager.tsx:139`, `packages/web/src/hooks/useAutoRestoreGuard.ts:55`
- **detail**: Web's `useAutoRestoreGuard` refuses unconditionally when local has content:

```js
const hasMeaningfulLocal = (feeds && feeds !== '[]' ...) || (filters && filters !== '{}' ...);
if (hasMeaningfulLocal) return;
```

Mobile only refuses in the narrow sub-case where the timestamp is also zero:

```js
if (hasMeaningfulLocal && (lastBackupTs ?? 0) === 0) { idleRestoreDone.current = true; return; }
if (newest.timestamp > (lastBackupTs ?? 0)) { restoreBackup(newest) }   // silent, no prompt
```

So a user with a normal, stamped `LAST_BACKUP_TS` and 20 live corkboards gets silently overwritten by any cloud checkpoint with a higher timestamp. `restoreBackup` → `deserializeBackup` also honours nulls as deletions (`packages/mobile/src/hooks/useNostrBackup.ts:275-285`). Web additionally routes the idle-return path through `useIdleAutoRestoreCheck` → `onSuggestRestore`, which only *proposes* a restore behind a visible 5-second countdown; mobile has no prompt at all.
- **failure**: User edits corkboards on their phone all morning; the last successful autosave stamps `lastBackupTs = T1`. They then use the desktop app, which autosaves an older/thinner state at `T2 > T1` (desktop had fewer feeds, e.g. it was restored from an old checkpoint). The user backgrounds the phone for 6 minutes and returns. `handleAppState` fires `checkForBackup()`, `checkpoints[0].timestamp = T2 > T1`, `hasMeaningfulLocal` is true but `lastBackupTs !== 0`, so the guard at line 139 doesn't trip → `restoreBackup(newest)` runs with no confirmation and rewrites all `BACKED_UP_KEYS` from the desktop blob. The morning's phone edits are gone, and any key absent from the desktop blob is `removeSync`'d.
- **fix**: Port web's guard verbatim: return early whenever `hasMeaningfulLocal` is true, regardless of `lastBackupTs`. For the case where the cloud genuinely is ahead, mirror web's `useIdleAutoRestoreCheck` + `useAutoRestoreCountdown` — surface a visible "Newer backup found (N more dismissed) — restoring in 5…" prompt with a cancel, and never apply silently.

### ☐ OPEN — useIdleAutoRestoreCheck resets its lastHidden timer on every render because getCheckpoints is a new function identity each time — the idle-return backup check never fires
- **area**: `race-conditions` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useIdleAutoRestoreCheck.ts:50`, `packages/web/src/hooks/useIdleAutoRestoreCheck.ts:86`, `packages/web/src/hooks/useNostrBackup.ts:1848`, `packages/web/src/pages/MultiColumnClient.tsx:958`
- **detail**: `lastHidden` is a plain `let` declared inside the effect body:

```js
useEffect(() => {
  if (!enabled) return;
  let lastHidden = 0;
  const onVisChange = () => { ... if (lastHidden === 0 || doneRef.current) return; ... };
  document.addEventListener('visibilitychange', onVisChange);
  return () => document.removeEventListener('visibilitychange', onVisChange);
}, [enabled, checkRemoteBackup, getCheckpoints, dismissedCount, onSuggestRestore, minDismissedDelta]);
```

Any dep change tears the effect down and rebuilds it with `lastHidden = 0`. `getCheckpoints` is an inline arrow recreated on every render of `useNostrBackup`:

```js
getCheckpoints: (): RemoteCheckpoint[] => getStoredCheckpoints(),   // line 1848
```

so the effect re-runs on **every render** of MultiColumnClient. `dismissedCount` also changes on every dismissal. `doneRef` survives (it's a ref) but `lastHidden` does not, and the handler bails on `lastHidden === 0`.
- **failure**: User backgrounds the tab. `visibilitychange: hidden` sets `lastHidden = Date.now()`. Thirty seconds later `useAutoSaveTrigger`'s poll runs `setBackupIndicator('unsaved')` (or an autosave completes and bumps `lastBackupTs`), MultiColumnClient re-renders, `getCheckpoints` gets a new identity, the effect tears down and re-mounts with `lastHidden = 0`. The user returns after 20 minutes: `onVisChange` runs, `lastHidden === 0` → early return. `checkRemoteBackup(true)` is never called, no checkpoints are re-read, and the entire idle-return cross-device sync feature is dead for any session where a single render happens while hidden — which is essentially all of them.
- **fix**: Hoist `lastHidden` into a `useRef(0)` alongside the existing `doneRef` so it survives effect re-subscription, and narrow the effect deps to `[enabled]` with the changing callbacks read from refs. Independently, memoize the returned callback in `useNostrBackup`: `const getCheckpoints = useCallback(() => getStoredCheckpoints(), []);` and return that stable reference instead of an inline arrow (line 1848) — several other consumers pass it as an effect dep.

### ☐ OPEN — useAccountIsolation reloads the page after awaiting only one of ~180 scheduled IndexedDB writes
- **area**: `race-conditions` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useAccountIsolation.ts:53`, `packages/web/src/hooks/useAccountIsolation.ts:67`, `packages/web/src/lib/idb.ts:218`, `packages/web/src/lib/idb.ts:371`, `packages/core/src/storageKeys.ts:312`
- **detail**: `switchActiveUser` is fully synchronous and only *schedules* its writes — every `storage.setSync` / `removeSync` maps to `idbSetSync` / `idbRemoveSync`, which fire-and-forget an async `idbSet`/`idbRemove`:

```js
export function idbSetSync(key, value) { ...; idbSet(key, value).then(...); }
```

`useAccountIsolation` awaits exactly one of them and then navigates:

```js
switchActiveUser(activePubkey, pubkey);      // schedules ~180 writes
...
try { await idbSet(ACTIVE_USER_KEY, pubkey); } catch {}
window.location.reload();
```

The inline comment even acknowledges the hazard for the marker ("switchActiveUser only schedules the write via setSync; reloading immediately would interrupt it") but applies the fix to only that one key. Making it worse, `idb.ts:371-380` registers a `beforeunload` handler that runs `db.close(); db = null; dbPromise = null;` — so any `idbSet` whose `await getDb()` hasn't resolved by unload will try to reopen a database during navigation and never complete.
- **failure**: User has two accounts and switches from A to B. `switchActiveUser` schedules ~90 stash writes (`user:A:*`), ~90 deletes of the live keys, and ~90 restores of `user:B:*`. The marker write is awaited (one IDB round-trip, ~5ms) and `window.location.reload()` fires. The remaining writes are at various stages: some transactions have been created, many are still parked on the `await getDb()` microtask. `beforeunload` closes the connection and nulls `db`/`dbPromise`, so those pending calls attempt `indexedDB.open()` mid-navigation and are dropped. After reload the active-user marker says B, but a partial set of A's stash keys was never written and a partial set of B's keys was never restored — the app comes up with A's leftovers under B's identity, and A's un-flushed stash entries are unrecoverable.
- **fix**: Give core an async variant of the swap (`switchActiveUserAsync`) that uses `storage.set`/`storage.remove` and returns a promise, the way `handleLogoutStorageAsync` (storageKeys.ts:375) already does for logout, and `await` it in `useAccountIsolation` before the reload. Also remove or defer the `db.close()` in the `beforeunload` handler (or gate it behind a flag the switch path can set) so in-flight transactions can drain.

### ☐ OPEN — Removing the last bookmark never publishes the emptied kind-10003 list, so the deleted bookmark resurrects from the relay on next session
- **area**: `react-correctness` · **platforms**: web, mobile · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useBookmarks.ts:300`, `packages/web/src/hooks/useBookmarks.ts:351`, `packages/mobile/src/hooks/useBookmarks.ts:189`, `packages/mobile/src/hooks/useBookmarks.ts:227`
- **detail**: The publish-scheduling effect is gated on a non-empty list:

```ts
// web:300 / mobile:189
if (!needsPublish.current || bookmarkIds.length === 0) return
needsPublish.current = false
```

`removeBookmark` sets `needsPublish.current = true` and returns `prev.filter(...)`. When that filter empties the array, the effect's `bookmarkIds.length === 0` branch fires first, so `publishBookmarkList([])` is never scheduled and — because the early `return` precedes `needsPublish.current = false` — the flag is left stuck at `true`.

Meanwhile the relay-sync effect unconditionally merges the relay list back into local state:

```ts
// web:239-248 / mobile:167-173
if (relayResult.found && relayResult.ids.length > 0) {
  setBookmarkIds(prev => [...new Set([...relayResult.ids, ...prev])] ...)
}
```

`republishBookmarks` has the identical guard (`web:351`, `mobile:227`), so the user cannot clear the remote list via the public/private toggle either.
- **failure**: User has exactly one bookmark, note `abc`. They un-bookmark it. Local state and IDB/MMKV become `[]`, the UI shows no bookmarks, but no kind-10003 is published — the relay still holds `['abc']`. On the next app start the bookmarks query returns `{ids:['abc'], found:true}` and the sync effect merges it back, so `abc` reappears as bookmarked. Secondary effect: `needsPublish.current` is still `true`, so that very merge (an entirely non-user-initiated change) schedules a publish of `['abc']`, permanently re-cementing the deleted bookmark.
- **fix**: Three edits per platform. (1) Reorder and drop the length test: `if (!needsPublish.current) return; needsPublish.current = false;` at web:300-301 and mobile:189-190 — clearing the flag before any early exit is what prevents the stuck-flag second-order bug. (2) Drop the `bookmarkIds.length > 0` condition at web:351 and mobile:227 so the public/private toggle can clear the remote list. (3) Guard against the empty-publish racing a not-yet-hydrated cache: the relay query can still be in flight when the effect fires, so gate the publish on the query having settled (`isLoading === false`) or the flag having been set by an explicit `addBookmark`/`removeBookmark` — otherwise a slow relay plus an early removal could publish `[]` over a list the client hasn't read yet. The existing `needsPublish` flag is only set from user actions (web:324/334, mobile:202/210), so it already covers this — just do not add any other setter of that flag.

### ☐ OPEN — useAuthor's background-refresh branch is unreachable dead code — cached profiles are never refreshed, they just expire
- **area**: `react-correctness` · **platforms**: web, mobile · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useAuthor.ts:113`, `packages/web/src/hooks/useAuthor.ts:117`, `packages/web/src/hooks/useAuthor.ts:124`, `packages/mobile/src/hooks/useAuthor.ts:101`, `packages/mobile/src/hooks/useAuthor.ts:104`, `packages/web/src/lib/cacheStore.ts:154`
- **detail**: Both platforms define `const CACHE_MAX_AGE = PROFILE_TTL_MS; const STALE_TIME = PROFILE_TTL_MS;` (web:48-49, mobile:48-49) — the same 48h value from `@core/cacheConfig`. The queryFn then does:

```ts
const cached = await getCachedProfile(pubkey, CACHE_MAX_AGE);
if (cached?.metadata) {
  const cacheAge = Date.now() - cached.cachedAt;
  if (cacheAge < STALE_TIME) { return {...cached}; }   // always taken
  // ── everything below is unreachable ──
  fetchAuthorFromNetwork(capturedPubkey, signal, nostr).then(...)
  return {...cached};
}
```

`getCachedProfile` already rejects anything older than the `maxAge` it is handed — web `cacheStore.ts:154` `if (age > maxAge) return null;` (and the mem path at :68), mobile `cacheStore.ts:45` `if (Date.now() - profile.cachedAt > maxAge) return null;`. So any non-null `cached` satisfies `cacheAge <= CACHE_MAX_AGE === STALE_TIME`, and the `cacheAge < STALE_TIME` guard returns before the refresh can ever run (only the exact-millisecond boundary escapes).

A secondary consequence hides behind it: that refresh call is also the one path not wrapped in `withConcurrencyLimit` (contrast web:146 / mobile:127), so if the guard is simply fixed, every stale-cached card would fan out `1 + PROFILE_INDEXER_RELAYS.length + 2` parallel relay queries unbounded — the exact WebKit >50-socket crash the limiter at web:14 exists to prevent.
- **failure**: A followed user changes their avatar and display name. The local cache entry is 10 hours old. Every render of every card for that author takes the `cacheAge < STALE_TIME` early return and shows the old avatar/name. No background refresh is ever issued, so the stale identity persists for the full 48h TTL; at 48h+1ms `getCachedProfile` returns null and the user instead gets a blocking network fetch (showing `user_xxxx` until it resolves). The documented 'return stale now, update when fresh arrives' behavior never happens on either platform.
- **fix**: Decouple the constants in @core/cacheConfig and both hooks: keep `CACHE_MAX_AGE = PROFILE_TTL_MS` (48h) as the disk-cache read horizon, and add a distinct `PROFILE_STALE_MS` (e.g. 2h) used for `cacheAge >= STALE_TIME`. Concretely at web:113 and mobile:101 keep passing `CACHE_MAX_AGE` to `getCachedProfile`, and change the guard at web:117 / mobile:104 to compare against the new shorter value. Two things the finder's fix must not omit: (a) wrap the refresh in the limiter — `withConcurrencyLimit(() => fetchAuthorFromNetwork(capturedPubkey, signal, nostr as NostrPool))` at web:128 and mobile:113; (b) the React Query `staleTime` at web:154 / mobile:132 is ALSO `STALE_TIME` for resolved profiles, so if you point it at the new 2h value you will additionally trigger a real refetch every 2h per mounted card — keep that one at `CACHE_MAX_AGE` so only the in-queryFn background refresh gets the shorter window. Mobile's refresh block also lacks web's `if (signal.aborted) return;` bail (web:132) before `setQueryData` — add it while you are there, or an account switch mid-flight writes another session's profile into the cache.

### ☐ OPEN — Idle-return cloud-backup check never fires: its `lastHidden` timestamp is an effect-local wiped on every render by an unstable `getCheckpoints` dependency
- **area**: `react-correctness` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useIdleAutoRestoreCheck.ts:52`, `packages/web/src/hooks/useIdleAutoRestoreCheck.ts:60`, `packages/web/src/hooks/useIdleAutoRestoreCheck.ts:86`, `packages/web/src/hooks/useNostrBackup.ts:1848`, `packages/web/src/pages/MultiColumnClient.tsx:961`
- **detail**: `useIdleAutoRestoreCheck` stores the hide-timestamp in a plain `let` inside the effect body:

```ts
useEffect(() => {
  if (!enabled) return;
  let lastHidden = 0;                       // :52
  const onVisChange = () => {
    if (document.visibilityState === 'hidden') { lastHidden = Date.now(); doneRef.current = false; return; }
    ...
    if (lastHidden === 0 || doneRef.current) return;   // :60
    ...
  };
  document.addEventListener('visibilitychange', onVisChange);
  return () => document.removeEventListener('visibilitychange', onVisChange);
}, [enabled, checkRemoteBackup, getCheckpoints, dismissedCount, onSuggestRestore, minDismissedDelta]);  // :86
```

Note that `doneRef` was correctly made a ref, but `lastHidden` was not. And `getCheckpoints` is in the dep array while `useNostrBackup` returns it as a fresh arrow on every render:

```ts
// useNostrBackup.ts:1848
getCheckpoints: (): RemoteCheckpoint[] => getStoredCheckpoints(),
```

The return object at :1832 is not memoized, so `getCheckpoints` has a new identity on every `useNostrBackup` render, i.e. every `MultiColumnClient` render (it is destructured at MultiColumnClient.tsx:768 and passed straight in at :961). `dismissedCount` in the same dep list adds a second churn source. Every re-render therefore tears down the listener and resets `lastHidden` to 0.
- **failure**: User backgrounds the tab (`lastHidden = <now>`), leaves for 20 minutes, and meanwhile a React Query refetch / backup-status transition / `dismissedCount` change re-renders MultiColumnClient even once. The effect is recreated with `lastHidden = 0`. On return, `onVisChange` hits `if (lastHidden === 0 ...) return;` and the `checkRemoteBackup(true)` round-trip never runs — the user is never offered the newer cloud checkpoint that has 40 more dismissed notes, which is precisely the data-loss guard this hook exists to provide.
- **fix**: Two changes, both needed — fixing only one leaves the bug. (1) In useIdleAutoRestoreCheck.ts, promote `lastHidden` from the `let` at :52 to `const lastHiddenRef = useRef(0)` next to `doneRef` at :48, so it survives effect recreation; update :55, :60, :61 accordingly. (2) Stabilize the deps so the listener stops churning: memoize the getter in useNostrBackup.ts:1848 as `const getCheckpoints = useCallback((): RemoteCheckpoint[] => getStoredCheckpoints(), [])` declared above the return, and read `dismissedCount` through a ref inside `onVisChange` rather than listing it at :86 (the closure at :68/:76 needs the value at fire time, not at subscribe time, so a ref is also more correct here, not just cheaper). Do not simply strip the deps and silence exhaustive-deps — `checkRemoteBackup` and `onSuggestRestore` legitimately need to be current.

### ☐ OPEN — Proxy kill-switch fails OPEN when proxy.json is corrupt or unreadable — relay.rs never consults LOAD_FAILED
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/proxy.rs:50`, `packages/desktop/src-tauri/src/proxy.rs:84`, `packages/desktop/src-tauri/src/proxy.rs:89`, `packages/desktop/src-tauri/src/relay.rs:266`, `packages/desktop/src-tauri/src/relay.rs:278`
- **detail**: `load_from_disk()` sets `LOAD_FAILED = true` and returns early on any read error or JSON parse error, leaving `PROXY_URL = None` and `PROXY_REQUIRED = false` (their static initializers). `proxy_required()` then returns `false`. `do_query()` in relay.rs branches:

```rust
match proxy::current_proxy() {
    Some(proxy_url) => ...,
    None => {
        if proxy::proxy_required() { return ...refusing direct connection... }
        match connect_async(url.as_str()).await { ... }   // <-- direct clearnet
```

Nothing anywhere reads `LOAD_FAILED` on the Rust side — it is only surfaced to JS via the `proxy_load_failed` command, which `AdvancedSettings.tsx` renders as a small red line that the user has to be sitting in the settings panel to see. Meanwhile every native relay query has already gone out direct.

This is made reachable by a second defect: `save_to_disk` (proxy.rs:89-96) is a non-atomic `fs::write` — truncate-then-write. A crash, power loss, or full disk mid-write leaves a truncated/empty `proxy.json`, which is exactly the corrupt-parse case above.
- **failure**: Tor-only user has `{"url":"socks5h://127.0.0.1:9050","required":true}` saved. The machine loses power while `set_proxy_required` is writing the file, leaving a 12-byte truncated JSON. Next launch: `serde_json::from_str` fails, `PROXY_REQUIRED` stays `false`, `PROXY_URL` stays `None`, and the very first feed load opens direct clearnet WebSockets to every configured relay, disclosing the user's IP together with their full follow-graph filter.
- **fix**: (1) Fail closed. Add `pub fn load_failed() -> bool { INIT.call_once(load_from_disk); *lock(&LOAD_FAILED) }` and gate the direct branch in relay.rs:341 on it: `if proxy::proxy_required() || proxy::load_failed() { return RelayQueryResult { events: vec![], error: Some("proxy config unreadable — refusing direct connection".into()) } }`. Cleanest variant: have `load_from_disk` set `*lock(&PROXY_REQUIRED) = true` on the two failure paths, so every existing consumer (including lib.rs:59, which then correctly latches `webview_unprotected = true`) inherits the safe default with no new call sites.
(2) Make `save_to_disk` atomic: write to `proxy.json.tmp` beside the target, `File::sync_all()`, then `fs::rename` over `proxy.json`.
(3) Fix the data-loss path: `set_proxy_required` must refuse to persist while `LOAD_FAILED` is set (or clear it the same way `set_proxy` does only after a successful full write), otherwise it overwrites the saved proxy URL with an empty string.

### ☐ OPEN — WEBVIEW_UNPROTECTED is latched only at window creation, so enabling "require proxy" at runtime leaves the leak warning permanently off
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/lib.rs:59`, `packages/desktop/src-tauri/src/proxy.rs:130`, `packages/desktop/src-tauri/src/proxy.rs:152`, `packages/desktop/src-tauri/src/proxy.rs:158`, `packages/web/src/components/AdvancedSettings.tsx:541`, `packages/web/src/components/AdvancedSettings.tsx:545`
- **detail**: `lib.rs:59` computes `let unprotected = proxy::proxy_required() && !webview_proxied;` exactly once, during `setup()`, and calls `proxy::set_webview_unprotected(unprotected)`. `set_proxy_required` (proxy.rs:130-135) flips `PROXY_REQUIRED` but never recomputes `WEBVIEW_UNPROTECTED`; neither does `set_proxy`. On the JS side, `AdvancedSettings.tsx` reads `tauriProxyWebviewUnprotected()` once inside a `useEffect` keyed on `[desktop]` (line 534-543) and `handleToggleRequired` (line 545) never re-reads it.

So the warning can only ever be true for a session that *started* with `required = true` and an unproxiable WebView. The overwhelmingly common flow — install app, open settings, type the proxy URL, flip "require proxy" on — always produces `webviewUnprotected === false` for the rest of that session, while the WebView is in fact completely unproxied (it was built with no proxy at all before the user configured one).
- **failure**: First run. User opens Advanced Settings, enters `socks5h://127.0.0.1:9050`, hits Save, toggles "require proxy" ON. Toast says native relay queries will now fail rather than go direct. `proxy_webview_unprotected()` still returns the startup-latched `false`, so no warning appears. The user believes they are covered and keeps browsing; every image, embed and WebKit-opened socket for the rest of that session goes out clearnet.
- **fix**: Latch the capability, derive the conclusion. In proxy.rs rename the static to `WEBVIEW_PROXIED: Mutex<bool>`, have lib.rs set it to the `webview_proxied` value it already computes, and make the command live:
```rust
#[tauri::command]
pub fn proxy_webview_unprotected() -> bool { proxy_required() && !*lock(&WEBVIEW_PROXIED) }
```
That single change also makes the banner correct for the reverse flow (turning "require proxy" back off must clear it). On the JS side, factor the four `tauri*` reads in AdvancedSettings.tsx:534-543 into a `refreshProxyState()` callback and await it at the end of `handleToggleRequired`, `handleSave` and `handleClear` — otherwise the banner is still one full panel-remount stale. Compose this with the macOS fix: `WEBVIEW_PROXIED` is the natural place to record the macOS-14+/feature-flag capability check.

### ☐ OPEN — Every keychain, signer and logger command is a synchronous #[tauri::command] executed on the main/UI thread — D-Bus keyring unlock can deadlock the GTK loop
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/signer.rs:27`, `packages/desktop/src-tauri/src/signer.rs:19`, `packages/desktop/src-tauri/src/keychain.rs:26`, `packages/desktop/src-tauri/src/keychain.rs:52`, `packages/desktop/src-tauri/src/logger.rs:71`, `packages/desktop/src-tauri/src/proxy.rs:110`
- **detail**: I confirmed the dispatch model in `tauri-macros-2.5.5/src/command/wrapper.rs`: `WrapperAttributes` defaults `execution_context: ExecutionContext::Blocking` (line ~48), and line 241-243 labels that path `"sync"` versus `"sync_threadpool"` for `#[tauri::command(async)]`. A plain `#[tauri::command] pub fn …` therefore runs inline on the thread servicing the wry IPC handler — the main event-loop thread.

Every one of these does real blocking I/O there:
- `sign_event`, `nip44_encrypt/decrypt`, `nip04_encrypt/decrypt` each call `keys_for()` -> `keychain::get_secret()` -> `keyring::Entry::get_password()`. On Linux that is a synchronous D-Bus round-trip to gnome-keyring/kwallet; on macOS a Security.framework call. Note `keys_for` re-reads the keychain on *every single call* — there is no caching.
- `keychain_store` / `keychain_delete`: same, plus a write.
- `write_log`: `fs::metadata` + `OpenOptions::open` + `writeln!` per call. `tauriLog` in tauri.ts flushes every 50 ms, and `main.tsx:87-99` overrides `console.log/warn/error` to feed it, so this fires continuously during normal use.
- `set_proxy` / `set_proxy_required`: `create_dir_all` + `fs::write`.

The worst case is a locked login keyring: `get_password()` blocks on a D-Bus call whose reply depends on the user dismissing a GNOME/KDE unlock prompt. That prompt is a separate process, but the app's own GTK main loop is blocked inside the IPC handler, so the app is frozen and cannot repaint, and on some compositors the modal ordering makes it unrecoverable without SIGKILL.
- **failure**: User logs in with an nsec on Linux, locks their screen (keyring auto-locks), returns, and posts a note. `sign_event` runs on the main thread, `get_password()` blocks on D-Bus waiting for the unlock dialog, and the entire Corkboards window goes white/unresponsive. Less dramatically: decrypting a list of 40 NIP-44 messages issues 40 sequential blocking keychain round-trips on the UI thread, freezing the app for seconds.
- **fix**: Mark the five signer commands and the two keychain commands `#[tauri::command(async)] pub async fn ...` and wrap the keyring call in `tokio::task::spawn_blocking` — note that plain `#[tauri::command(async)]` on a *sync* fn hands the body to `respond_async_serialized`, which runs it on a tokio worker, not on `spawn_blocking`; a multi-second D-Bus stall there still occupies a runtime worker. So: `pub async fn sign_event(...) { let keys = tokio::task::spawn_blocking(move || keys_for(&pubkey)).await.map_err(|e| e.to_string())??; ... }`. Separately, add a `static KEYS_CACHE: Mutex<HashMap<String, Keys>>` in signer.rs populated on first `keys_for` and invalidated by `keychain_delete`, so a session does one keychain read instead of one per signature. Leave `write_log`/`clear_log`/proxy getters as-is or convert opportunistically — they are local-FS-only and not worth the churn.

### ☐ OPEN — relay_subscribe never streams incrementally, and a per-relay timeout discards every event already collected from that relay
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/relay.rs:72`, `packages/desktop/src-tauri/src/relay.rs:412`, `packages/desktop/src-tauri/src/relay.rs:143`, `packages/web/src/lib/fetchEvent.ts:83`, `packages/web/src/lib/fetchEvent.ts:132`
- **detail**: The command's own doc comment says it "streams events … to JS via Tauri app events," but `run_query` accumulates into a local `Vec<Value>` and returns it only after EOSE/CLOSED, a socket error, or `MAX_EVENTS_PER_QUERY`. Nothing is sent while reading. The spawned task then does:

```rust
match tokio::time::timeout(dur, do_query(url, f)).await {
    Ok(result) => { for ev in result.events { sender.send(ev).await ... } }
    Err(_) => { eprintln!("[relay {url_for_log}] timeout after {ms}ms"); }
}
```

On timeout the future is dropped and its entire `Vec` is destroyed. A relay that delivered 400 events but had not yet sent EOSE at the 5000 ms mark contributes exactly zero. `relay_query` (line 143-156) has the identical shape: `Err(_) => RelayQueryResult { events: vec![], error: Some("timeout") }`.

This interacts badly with the SOCKS path. `fetchEvent.ts` calls `queryRelay` with `timeoutMs = 2500` (default) and `3000` (line 132), and that budget must cover SOCKS5 handshake + Tor circuit build + TLS handshake + REQ + EOSE. A fresh Tor circuit alone is routinely 1-3 s, so on desktop-over-Tor these calls time out and return empty essentially every time — silently, since the caller does `if (result && !result.error) return result.events; return []`.
- **failure**: Desktop user on Tor opens a thread. `fetchEventWithOutbox` -> `queryRelay(relay, {ids:[eventId]}, 2500)` -> `relay_query` -> SOCKS+TLS handshake consumes the whole 2500 ms -> `error: "timeout"` -> `[]`. The note renders as 'not found' even though the relay has it and would have answered at t=3.1s. Same on the feed path: a slow relay returns 400 events at t=5.2s and all 400 are dropped.
- **fix**: Two independent changes. (1) Make partial results survive the deadline: replace the whole-future `tokio::time::timeout(dur, do_query(...))` at relay.rs:73 with a deadline computed inside `run_query` — `let deadline = Instant::now() + dur;` then `match tokio::time::timeout_at(deadline, ws.next()).await { Err(_) => break, ... }` around line 489, so expiry breaks the loop and returns the `events` collected so far instead of dropping them. Apply the same to `relay_query` (relay.rs:149) so its timeout returns `RelayQueryResult { events, error: Some("timeout") }` with the partial set, and relax `fetchEvent.ts:88` to `if (result) return result.events` so a partial+timeout result is not discarded. Better still, thread the `mpsc::Sender<Value>` into `run_query` so events reach the emit loop as they are parsed. (2) Make the JS budget proxy-aware rather than raising it globally: have `queryRelay` read `tauriGetProxy()` once (cache it) and use ~8000 ms when a proxy is configured, keeping 2500 ms for direct connections.

### ☐ OPEN — No WebSocketConfig limits — tungstenite defaults allow 64 MiB messages, so MAX_EVENTS_PER_QUERY=5000 bounds count but not memory
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/relay.rs:284`, `packages/desktop/src-tauri/src/relay.rs:355`, `packages/desktop/src-tauri/src/relay.rs:250`, `packages/desktop/src-tauri/src/relay.rs:236`
- **detail**: Both connect paths use the config-less helpers: `connect_async(url.as_str())` (line 284) and `client_async(req, stream)` (line 355). Both delegate to `*_with_config(…, None)`, which means `WebSocketConfig::default()`. I checked the vendored source — tungstenite-0.24.0/src/protocol/mod.rs:82-83 sets `max_message_size: Some(64 << 20)` and `max_frame_size: Some(16 << 20)`. A Nostr EVENT frame should never exceed a few hundred KB.

The comment above `MAX_EVENTS_PER_QUERY` claims to have closed the unbounded-allocation hole ("every frame was being pushed into an unbounded Vec … Stop reading at the cap"), but the cap is on *count*, not bytes. Worst case per socket is 5000 × 64 MiB of frame payload, each of which is additionally parsed into a `serde_json::Value` (several times the byte size in heap) and then **cloned again** by `is_authentic_event(&arr[2])` (`serde_json::from_value::<nostr::Event>(value.clone())`) before being cloned a third time into `events`. And `relay_subscribe` puts no bound on `urls.len()`, so this runs concurrently across as many relays as JS names.
- **failure**: A hostile or compromised relay in the user's list answers a REQ with a stream of 8 MiB EVENT frames. Within the 5000 ms window the desktop app parses and triple-clones several hundred MB of JSON on the tokio workers, driving the process into swap or OOM-kill. The count cap never trips because the frames are large, not numerous.
- **fix**: Define `const WS_CONFIG: WebSocketConfig = WebSocketConfig { max_message_size: Some(512 * 1024), max_frame_size: Some(512 * 1024), ..WebSocketConfig::default() };` (needs `use tokio_tungstenite::tungstenite::protocol::WebSocketConfig`) and switch relay.rs:347 to `connect_async_with_config(url.as_str(), Some(WS_CONFIG), false)` and relay.rs:418 to `client_async_with_config(req, stream, Some(WS_CONFIG))`. Add a byte budget alongside the count cap in `run_query`: track `total_bytes += text.len()` and `break` past ~32 MiB, so 5000 small-but-not-tiny events also can't balloon. Kill the clone in `is_authentic_event` by parsing the frame into a `Vec<Value>` you own and doing `let ev = std::mem::take(&mut arr[2]);` then `serde_json::from_value::<nostr::Event>(ev.clone())` once — or verify from the raw text slice before ever building the intermediate `Value`. Finally, defensively cap the relay fan-out at the IPC boundary: `let urls: Vec<String> = urls.into_iter().take(16).collect();` at the top of `relay_subscribe`.

### ✅ FIXED — rss-proxy.php favicon path is an arbitrary-content read relay: the icon fetch follows redirects and returns the raw body base64-encoded
- **area**: `ssrf-network-egress` · **platforms**: web, mobile · **verdict**: CONFIRMED
- **files**: `packages/web/rss-proxy.php:438`, `packages/web/rss-proxy.php:445`, `packages/web/rss-proxy.php:369`
- **detail**: After parsing the feed, the proxy fetches `'https://' . $iconHost . '/favicon.ico'` through `fetchValidated(...)` (rss-proxy.php:439-444), which follows up to 3 redirects (`$maxHops = 3`, line 369) — each hop is SSRF-validated, but that only enforces "public https", not "same host" or "is actually an icon". Whatever body comes back is returned verbatim to the caller: `$result['icon'] = 'data:' . $iconMime . ';base64,' . base64_encode($iconBody)` (line 450). The MIME is normalised to `image/x-icon` when it doesn't match `^image/[a-z0-9.+-]+$` (447-449), but the *bytes* are never checked — an HTML or JSON body is returned just the same, up to the 64 KB cap. Combined with the fact that no Origin is required (see the separate finding), any internet client can use corkboards.me as an anonymising 64 KB reader for arbitrary public https URLs.
- **failure**: Attacker hosts `https://evil.example/feed.xml` (a valid minimal RSS document) and makes `https://evil.example/favicon.ico` return `302 Location: https://victim-api.example/internal-report?token=…`. `curl 'https://corkboards.me/rss-proxy.php?url=https://evil.example/feed.xml'` returns JSON whose `icon` field is `data:image/x-icon;base64,<first 64KB of victim-api.example's response>`, fetched from corkboards.me's IP with corkboards.me's egress reputation and no attribution to the attacker.
- **fix**: Applied fix is correct and slightly better than proposed: `$maxHops = 0` (no redirects at all — simpler and safer than re-checking host equality per hop), AND require both a real `image/*` content-type and magic bytes (PNG/JPEG/GIF/WebP/BMP/ICO/CUR) via `looksLikeImage()`, with `image/svg+xml` explicitly rejected since it is markup rather than a bitmap. One thing to double-check in the same hunk: the icon URL is now rebuilt as `'https://' . $iconAuthority . '/favicon.ico'` where an IPv6 literal host is re-bracketed — verify `parse_url($finalUrl, PHP_URL_HOST)` output (PHP returns IPv6 hosts WITH brackets, so the `$iconHost[0] !== '['` guard is what prevents double-bracketing; keep it).

### ✅ FIXED — Malicious bech32 mention in a note crashes the entire web app (root ErrorBoundary unmount)
- **area**: `xss-sanitization` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NoteContent.tsx:432`, `packages/web/src/components/NoteContent.tsx:560`, `packages/web/src/components/NoteContent.tsx:567`, `packages/web/src/components/ProfileLink.tsx:7`, `packages/web/src/components/ProfileModal.tsx:164`, `packages/web/src/AppRouter.tsx:15`
- **detail**: Web's mention parser never validates the bech32 payload. `const nostrPattern = /(nostr:)?(note1|npub1|nprofile1|nevent1|naddr1)[a-zA-Z0-9]+/g` (NoteContent.tsx:432) matches the full alphanumeric charset — not the bech32 charset `qpzry9x8gf2tvdw0s3jn54khce6mua7l` — and `parseContent` pushes the raw match straight through: `parts.push({ type: 'profile', value: fullMatch.replace('nostr:', '') })` (line 567). `renderPart` then does `<ProfileLink key={i} pubkey={part.value} />` (line 340).

`ProfileLink.getPubkeyFromIdentifier` swallows the decode failure and returns the *undecoded string*:
```ts
try { const decoded = nip19.decode(identifier) ... } catch { /* Fall through */ }
return identifier
```
(ProfileLink.tsx:7-19). That bogus "pubkey" is handed to `<ClickableProfile pubkey={resolvedPubkey}>`, whose click calls `openProfile(pubkey)`.

`ProfileModalDialog` then runs, unguarded, at render time:
```ts
if (!pubkey) return null
const metadata = author?.metadata
const displayName = ... genUserName(pubkey)
const npub = nip19.npubEncode(pubkey)   // ProfileModal.tsx:164 — THROWS
```
I verified against the bundled nostr-tools: `nip19.decode('npub1bbbbbbbb')` throws `Unknown letter: "b"`, and `nip19.npubEncode('npub1bbbbbbbb')` throws `hex string expected, got unpadded hex of length 13`.

`ProfileModalProvider` (and therefore `ProfileModalDialog`) is mounted in `AppRouter.tsx:15`, i.e. **outside** the keyed feed ErrorBoundary at `MultiColumnClient.tsx:4227` that is specifically there to stop feed crashes reaching the root. So the throw propagates to the root ErrorBoundary in `main.tsx:134` and unmounts the whole app.

Mobile does not have this bug — it validates before constructing a mention (`packages/mobile/src/components/NoteContent.tsx:388-405` calls `nip19.decode(bech32)` inside try/catch and falls back to `{type:'text'}`). Web is the outlier.
- **failure**: Attacker publishes a kind-1 note whose content is `hey npub1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`. It renders as a purple `@user_...` mention. Any user who clicks that mention gets `nip19.npubEncode` throwing inside `ProfileModalDialog`; React unwinds to the root ErrorBoundary and the entire corkboards UI is replaced by the error screen. One note in a followed feed = one-click full-client DoS for every viewer, repeatable on every page load.
- **fix**: Skip the regex change — `NIP19_IDENTIFIER_PATTERN` in packages/core/src/nostr.ts:35 is already strict bech32 with the `(?<![\w/:])` guard. Three real changes:
(1) packages/web/src/components/NoteContent.tsx `parseContent` (~line 560-575): before pushing `{type:'note'}` or `{type:'profile'}`, `try { nip19.decode(fullMatch.replace('nostr:','')) } catch { parts.push({type:'text', value: fullMatch}); lastIndex = ...; continue }` — mirroring packages/mobile/src/components/NoteContent.tsx:394-409.
(2) packages/web/src/components/ProfileLink.tsx:7-19: change the return type to `string | null` and `return null` on decode failure; when null, render `<span>{pubkey}</span>` instead of `<ClickableProfile>` (this also stops the bogus `useAuthor(resolvedPubkey)` REQ that currently goes out with a non-hex author filter).
(3) packages/web/src/components/ProfileModal.tsx:159: harden the entry point rather than only line 164 — change `if (!pubkey) return null` to `if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) return null`. Same one-line guard is worth adding to `openProfile` at ProfileModal.tsx:89 so no future caller can poison modal state.

### ☐ OPEN — EmojiName renders NIP-30 custom-emoji URLs with no SSRF gate and no image proxy, on both web and mobile
- **area**: `xss-sanitization` · **platforms**: web, mobile · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/EmojiName.tsx:60`, `packages/mobile/src/components/EmojiName.tsx:63`, `packages/web/src/components/NoteContent.tsx:67`, `packages/web/src/components/NoteContent.tsx:378`, `packages/mobile/src/components/NoteContent.tsx:666`, `packages/web/src/components/NoteCard.tsx:1029-1034 — the reaction-context overlay renders `<img src={customEmojiUrl}>` where `customEmojiUrl` comes from `note.tags.find(t => t[0]==='emoji' && t[1]===match[1])?.[2]` (line 963-965) on an arbitrary third-party kind-7 event; no `optimizeMediaUrl`, no `referrerPolicy`. Same defect, same attacker-controlled source, and it also fires on passive render`
- **detail**: NoteContent gates custom-emoji URLs on both platforms, with an explicit comment saying why:
```ts
// Gate emoji URLs like images: reject unsafe hosts (SSRF) and route
// through the user's image proxy — unsafe URLs fall back to plain text.
const safeUrl = optimizeMediaUrl(part.value)
if (!safeUrl) return <span …>{`:${part.alt}:`}</span>
```
(web NoteContent.tsx:376-381, mirrored at :67 and mobile NoteContent.tsx:663-670).

`EmojiName` — which renders the *same* NIP-30 emoji tags in display names — does none of it. Web (`EmojiName.tsx:60-68`):
```tsx
<img key={i} src={p.url} alt={`:${p.value}:`} title={`:${p.value}:`}
     className="inline-block h-5 w-5 …" loading="lazy" />
```
Mobile (`EmojiName.tsx:63-68`):
```tsx
<Image key={i} source={{ uri: p.url }} style={styles.emojiImage} resizeMode="contain" />
```
Neither calls `optimizeMediaUrl` / `shouldRejectUrl` (so `isUnsafeHost`, the credentials-in-URL check, and the executable-extension check are all skipped) nor `applyImageProxy` (so the user's explicitly configured privacy proxy is silently bypassed). `p.url` comes straight from `tag[2]` of any `['emoji', shortcode, url]` tag on the kind-0 profile event (EmojiName.tsx:25-29) — fully attacker-controlled.

EmojiName is on the hot path: `NoteCard.tsx:985, 1145, 1232, 1303, 1345, 1493`, `ProfileModal.tsx:241`, `thread/ThreadReplyRow.tsx:142` — i.e. every author name in the feed. Note the web CSP (`packages/web/index.html`, `img-src 'self' data: blob: https:`) blocks `http:` but explicitly allows any `https:` host, so `https://10.0.0.1/`-style internal probing is not mitigated; on mobile there is no CSP at all.
- **failure**: Attacker publishes kind 0 with `display_name: "alice :probe:"` and tag `["emoji","probe","https://192.168.1.1/cgi-bin/luci"]`. Every client that renders that author's name in a feed issues an authenticated-by-cookie-less GET to the victim's LAN router; `onerror`/`onload` timing differences reveal which internal hosts exist. Separately, a user who deliberately enabled the image proxy (`validateImageProxyTemplate` in `packages/core/src/imageProxy.ts`) still leaks their IP and a per-user-unique request to the attacker's host on every feed render, because EmojiName never calls `applyImageProxy`.
- **fix**: In packages/web/src/components/EmojiName.tsx, import `optimizeMediaUrl` from '@/lib/imageUtils' and compute `const safe = optimizeMediaUrl(p.url!)` at render; emit `<span key={i}>{`:${p.value}:`}</span>` when it is falsy, and render `<img src={safe} … referrerPolicy="no-referrer" />` otherwise. Note the extra detail the finding missed: the gated `<img>` at NoteContent.tsx:71 also sets `referrerPolicy="no-referrer"` and EmojiName does not — add it, or the emoji host still learns the referring page. Same change in packages/mobile/src/components/EmojiName.tsx using `optimizeMediaUrl` from '@core/imageUtils'. Cheapest correct version is to filter in the `useMemo` (drop the emoji part to text when `optimizeMediaUrl` returns '') so the existing `if (!result.some(p => p.type === 'emoji')) return null` early-out still behaves.

### ☐ OPEN — Markdown images bypass the SSRF host gate that every other web image path enforces
- **area**: `xss-sanitization` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NoteContent.tsx:40`, `packages/web/src/components/NoteContent.tsx:50`, `packages/web/src/components/NoteContent.tsx:156`, `packages/web/src/components/SizeGuardedImage.tsx:109`, `packages/web/src/components/EmojiName.tsx:62 — renders `p.url` taken straight from another user's kind-0 `emoji` tags (EmojiName.tsx:20-26) with no shouldRejectUrl, no optimizeMediaUrl, and not even referrerPolicy="no-referrer"`, `packages/web/src/components/NotificationCard.tsx:406 and :421 — `reactionCustomUrl` comes from a stranger's kind-7 `emoji` tag (NotificationCard.tsx:217-227), rendered raw`
- **detail**: `MarkdownImg` passes react-markdown's `src` straight through with no validation:
```tsx
function MarkdownImg({ src, alt }: { src?: string; alt?: string }) {
  …
  return (
    <SizeGuardedImage src={src} alt={alt || ''} className="…" loading="lazy" onError={() => setErrored(true)} />
  )
}
```
(NoteContent.tsx:40-51, wired in at :156 via `img: ({ src, alt }) => <MarkdownImg src={src} alt={alt} />`).

`SizeGuardedImage` only applies the proxy — `const src = applyImageProxy(rawSrc)` (SizeGuardedImage.tsx:109) — it never calls `shouldRejectUrl`. So unlike `MediaLink` (which uses `optimizeMediaUrl(currentImageUrl, true)`), the emoji paths, and `optimizeAvatarUrl`, a markdown image never goes through `isUnsafeHost` / the credentials-in-URL check / the executable-extension check in `packages/core/src/imageUtils.ts:93-118`.

react-markdown v10's `defaultUrlTransform` does block `javascript:`/`data:` (verified in `node_modules/react-markdown/lib/index.js:421-445`, `safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i`), so this is not XSS — but it leaves `https://<private-host>/` wide open, and the web CSP (`packages/web/index.html`) allows `img-src … https:` unconditionally. Reaching this path is trivial: any note whose text trips `MARKDOWN_INDICATORS_PATTERN` (`packages/web/src/lib/markdownDetect.ts:12`, which `!\[` alone satisfies) is routed to `MarkdownText`.
- **failure**: Attacker posts a kind-1 note containing `![](https://192.168.1.1/status.png)` (or `https://[::1]:8080/`, `https://169.254.169.254/latest/meta-data/`). Every viewer's browser fetches it — the note is rendered as markdown because `!\[` matches the markdown heuristic. Load/error timing distinguishes live internal hosts from dead ones, letting a single note port-scan the LAN of every reader. `MediaLink`-rendered images with the same URL are correctly dropped by `optimizeMediaUrl` returning `''`.
- **fix**: Push the gate down into the shared component rather than patching one caller: in `packages/web/src/components/SizeGuardedImage.tsx`, import `shouldRejectUrl` from `@core/imageUtils` and bail before line 109 — `const rejected = /^https?:/i.test(rawSrc) && shouldRejectUrl(rawSrc, compact ? 'avatar' : 'media'); if (rejected) return null;` — so the HEAD probe at line 48 is never issued either. That mirrors mobile's SizeGuardedImage.tsx:161/201/218 exactly and fixes MarkdownImg plus every future caller in one place. Then fix the other ungated sites listed in extraFiles by routing their URLs through `optimizeMediaUrl(url)` and falling back to text when it returns ''.

### ☐ OPEN — Web profile banners skip the SSRF gate (and, in ProfileModal, the image proxy) that avatars and the mobile banners both apply
- **area**: `xss-sanitization` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/ProfileCard.tsx:282`, `packages/web/src/components/ProfileCard.tsx:295`, `packages/web/src/components/ProfileModal.tsx:40`, `packages/web/src/components/ProfileModal.tsx:212`, `packages/mobile/src/components/ProfileCard.tsx:118`, `packages/mobile/src/components/ProfileModal.tsx:281`
- **detail**: The kind-0 `picture` field is consistently hardened (`optimizeAvatarUrl(metadata.picture)`, which calls `shouldRejectUrl(url,'avatar')` → https-only + `isUnsafeHost` + credentials check, then `applyImageProxy`). The `banner` field is not.

`packages/web/src/components/ProfileCard.tsx:282` and `:295`:
```tsx
<img src={applyImageProxy(metadata.banner)} alt="" … referrerPolicy="no-referrer" onLoad={…} />
```
— proxy applied, but no `shouldRejectUrl`, so `https://10.0.0.5/x.png` loads directly (CSP `img-src … https:` permits it) and the `onLoad` handler fires only for hosts that actually served an image, giving a readable oracle.

`packages/web/src/components/ProfileModal.tsx:212` is worse — neither gate nor proxy:
```tsx
{metadata?.banner && /^https?:\/\//.test(metadata.banner) ? (
  <div className="h-24 w-full bg-cover bg-center" style={{ backgroundImage: `url("${sanitizeBannerUrl(metadata.banner)}")` }} />
```
where `sanitizeBannerUrl` (ProfileModal.tsx:40-46) only checks `protocol !== 'https:' && protocol !== 'http:'` and escapes `"`. `applyImageProxy` is never called, so a user who explicitly enabled the image proxy still hands their IP to the banner host on every profile open.

Mobile does this correctly on both screens: `packages/mobile/src/components/ProfileCard.tsx:118` and `packages/mobile/src/components/ProfileModal.tsx:282` route the banner through `SizeGuardedImage`, whose `rejected = isRemote && shouldRejectUrl(rawUri, …)` check (mobile SizeGuardedImage.tsx) drops unsafe hosts before `<Image>` or the HEAD probe. Web is the outlier.
- **failure**: Attacker sets kind-0 `banner` to `https://192.168.0.1/router.png`. Any user who opens that profile issues a LAN request from their browser; on ProfileCard the `onLoad` callback (which sets `naturalBannerPct`) distinguishes a real image response from a failure. Independently, a privacy-conscious user with `imageProxyTemplate` configured still leaks their IP + a unique per-view request to the attacker whenever ProfileModal renders, because the CSS `backgroundImage` path never calls `applyImageProxy`.
- **fix**: ProfileCard.tsx:282 and :295 — replace `applyImageProxy(metadata.banner)` with a memoized `const safeBanner = metadata?.banner ? optimizeMediaUrl(metadata.banner, true) : ''` and switch the outer `{metadata?.banner ? ...}` test at line 278 to `{safeBanner ? ...}` so a rejected banner falls through to the existing `BannerPlaceholder` branch instead of rendering a broken `<img src="">`. ProfileModal.tsx — rewrite `sanitizeBannerUrl` (line 39) to `const safe = optimizeMediaUrl(url, true); return safe ? safe.replace(/"/g, '%22') : ''`, and change the condition at line 211 from `metadata?.banner && /^https?:\/\//.test(metadata.banner)` to a truthiness test on that computed value so the gradient placeholder is used on rejection. That closes both the SSRF gate and the missing-proxy leak.

## LOW (70)

### ☐ OPEN — clearRelayCache() is dead code on web/desktop — the departing user's relay/social-graph cache survives logout and account switch, in memory and in IndexedDB
- **area**: `architecture-techdebt` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NostrProvider.tsx:531`, `packages/web/src/components/NostrProvider.tsx:778`, `packages/web/src/components/NostrProvider.tsx:459`, `packages/web/src/hooks/useLoginActions.ts:354`, `packages/core/src/storageKeys.ts:231`, `packages/mobile/src/lib/AuthContext.tsx:370`
- **detail**: `packages/web/src/components/NostrProvider.tsx:531-535` defines:

```ts
/** Clear relay cache on account switch so stale relay data doesn't leak between users */
// eslint-disable-next-line react-refresh/only-export-components
export function clearRelayCache(): void {
  relayCache = new Map();
}
```

`grep -rn "clearRelayCache" packages/web/src` returns hits ONLY inside NostrProvider.tsx itself — zero callers in the whole web package (and desktop runs the same bundle). Mobile, by contrast, calls it in all three account-lifecycle paths: `AuthContext.tsx:370` (switchAccount), `:394` (removeAccount), `:435` (logout).

Web's logout choke point `useLoginActions.ts:340-370` clears `clearProfileMemCache()`, `clearCollapsedNotesModuleState()`, `clearNoteCardCache()`, `await clearNotesCache()` — but never the relay cache.

Even if it were called, the fix would be incomplete: `clearRelayCache()` only resets the in-memory Map. The persisted copy lives in IndexedDB under `RELAY_CACHE_KEY = 'corkboard:relay-cache'` (NostrProvider.tsx:23), written by the debounced `flushRelayCacheToIdb()` (line 459-463) and reloaded at boot by `idbReady.then(() => loadRelayCache())` (line 778). That key is absent from `STORAGE_KEYS`/`PER_USER_KEYS`/`BACKED_UP_KEYS` in `packages/core/src/storageKeys.ts:19-253`, so `handleLogoutStorage` / `clearActiveUserData` / `stashUserData` never touch it. Mobile's version DOES remove the persisted copy (`clearRelayCache` at `packages/mobile/src/lib/NostrProvider.tsx:103-115` calls `mobileStorage.removeSync(RELAY_CACHE_KEY)`).

The cached content is up to `MAX_RELAY_CACHE = 5000` pubkey -> NIP-65 relay-URL entries — a materialized slice of the departing user's follow graph.
- **failure**: Alice logs in on a shared/family laptop, browses her feed (relayCache fills with ~2000 of her follows' pubkeys and their relays, flushed to IDB after 2s), then logs out. Bob logs in on the same browser profile. `loadRelayCache()` at NostrProvider.tsx:778 restores Alice's 2000-entry pubkey->relay map, and Bob's outbox routing (`selectFeedRelays`, `Router.configure({getPubkeyRelays})`) is seeded from Alice's social graph. Separately, anyone with the device can read Alice's full follow-graph pubkey list out of IndexedDB key `corkboard:relay-cache` indefinitely — it survives logout, account removal, and app restart.
- **fix**: 1) Make clearRelayCache() actually clear persistence — cancel relayCacheSaveTimer and remove RELAY_CACHE_KEY from IDB, mirroring packages/mobile/src/lib/NostrProvider.tsx:103-113 — and call it from useLoginActions.logoutAccount (packages/web/src/hooks/useLoginActions.ts:~356, next to clearNoteCardCache()). 2) Add 'corkboard:relay-cache' to the per-user list in packages/core/src/storageKeys.ts:229-251 (per-user, NOT in SHARED_BACKED_UP_KEYS) so stash/restore isolates it across accounts. 3) Fix the ordering hazard in nuclearWipe: the beforeunload/visibilitychange flush at NostrProvider.tsx:894-905 writes the still-populated in-memory Map back to IDB if a 2s debounce timer was pending when the wipe ran, resurrecting the key after idbClear(); call clearRelayCache() before idbClear(). 4) Drop the stale 'account switch' wording in the doc comment — the switch path reloads the page, so the call matters for logout, not switch.

### ☐ OPEN — Mobile batchFetchByAuthors fires every author chunk in parallel; web deliberately serializes them with 500ms spacing to avoid relay connection storms
- **area**: `architecture-techdebt` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/lib/feedUtils.ts:133`, `packages/web/src/lib/feedUtils.ts:121`, `packages/mobile/src/hooks/useCustomFeed.ts:41-108 (the LIVE copy — same parallel chunks, ungated console.warn at :86 and :106, degenerate onProgress, inline dedupe duplicating @core/feedAlgorithms)`
- **detail**: `packages/web/src/lib/feedUtils.ts:121-144`:

```ts
// Query chunks sequentially with a pause between each to avoid flooding relays.
// Each chunk goes to 4-8 relays via NPool, so spacing prevents connection storms.
const allEvents: NostrEvent[][] = [];
for (let ci = 0; ci < chunks.length; ci++) {
  if (ci > 0) await new Promise(r => setTimeout(r, 500)); // 500ms between chunks
  ...
  onProgress?.(ci + 1, chunks.length);
}
```

`packages/mobile/src/lib/feedUtils.ts:133-150` is the pre-fix shape:

```ts
const allEvents = await Promise.all(
  chunks.map(chunk =>
    nostr.query([{ kinds, authors: chunk, limit, since: effectiveSince, ... }],
      { signal: AbortSignal.timeout(timeout) })
    .catch((err) => { console.warn('[batchFetch] Chunk query failed:', err); return [] as NostrEvent[]; })
  )
);
```

Three defects follow from the divergence:
1. All `ceil(authors/500)` chunks hit NPool simultaneously; each fans out to up to `MAX_FEED_RELAYS = 12` relays (`packages/mobile/src/lib/NostrProvider.tsx:36`), so a 2000-follow account opens ~48 WebSockets in one tick on a mobile radio.
2. `onProgress` degenerates to `(0,1)` then `(1,1)` (line 152) — the progress UI has no granularity, unlike web's per-chunk `onProgress?.(ci+1, chunks.length)`.
3. `console.warn` at lines 145 and 158 is NOT gated by `__DEV__`, unlike every other log in the file and unlike `packages/mobile/src/lib/debug.ts:2` (`const DEBUG = __DEV__`). Relay errors are printed in production builds.

Mobile also hardcodes `const RSS_PROXY = 'https://corkboards.me/rss-proxy.php'` (line 29) instead of importing `RSS_PROXY` from `@core/feedConstants:19` like web does — a fourth silent divergence point.
- **failure**: A mobile user with 2000+ follows pulls-to-refresh on cellular. 4 chunks x up to 12 relays = ~48 concurrent WebSocket handshakes in a single tick. Relays with per-IP connection limits (most public relays) drop or rate-limit the later connections, so those chunks return empty and the user silently loses ~75% of their feed — with no progress feedback to indicate anything happened, and the failures printed to a production console.
- **fix**: Fix the LIVE copy first: replace the Promise.all block in packages/mobile/src/hooks/useCustomFeed.ts:74-91 with web's sequential loop from packages/web/src/lib/feedUtils.ts:123-144 (500ms inter-chunk delay, per-chunk try/catch, onProgress(ci+1, chunks.length)), and have it import deduplicateAndSort from @core/feedAlgorithms instead of the inline dedupe at :96-104. Apply the same loop to packages/mobile/src/lib/feedUtils.ts:133-158. Gate the four console.warn calls (lib/feedUtils.ts:145,158 and useCustomFeed.ts:86,106) behind __DEV__ or route them through lib/debug.ts. Then collapse the three implementations into one: lift the body into @core/feedAlgorithms behind a `{ query }` port — the only platform-specific piece is nostr.query. Leave RSS_PROXY alone, or add an explicit RSS_PROXY_ABSOLUTE to @core/feedConstants if you want it centralized.

### ☐ OPEN — Mobile selectFeedRelays and Router.configure drop the URL normalization and blocked-relay filter that web applies, so backed-off relays stay in rotation and trailing-slash duplicates eat the relay budget
- **area**: `architecture-techdebt` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/lib/NostrProvider.tsx:424`, `packages/mobile/src/lib/NostrProvider.tsx:387`, `packages/mobile/src/lib/NostrProvider.tsx:126`, `packages/web/src/components/NostrProvider.tsx:594`, `packages/web/src/components/NostrProvider.tsx:414`, `packages/web/src/components/NostrProvider.tsx:790-801 (Tauri/desktop bulk path: builds the frequency map from getRelayCache(pk) with neither normalizeRelayUrl nor isRelayBlocked, unlike the T2 branch at :805-810 which normalizes — same defect on desktop)`
- **detail**: `packages/mobile/src/lib/NostrProvider.tsx:126-131` defines the helper and explicitly claims parity:

```ts
/** Normalize a relay URL for deduplication — strips trailing slashes.
 *  Mirrors web's normalizeRelayUrl() so both platforms compare relay identity
 *  the same way (`wss://a.example` and `wss://a.example/` are one relay). */
function normalizeRelayUrl(url: string): string { return url.replace(/\/+$/, ''); }
```

But `grep -n normalizeRelayUrl packages/mobile/src/lib/NostrProvider.tsx` shows it is used ONLY inside the NIP-42 auth allow-list (lines 266, 273, 275-281). It is never used in relay selection. Compare `selectFeedRelays`:

web (`NostrProvider.tsx:598-611`): `userRelays.read.forEach(r => selected.add(normalizeRelayUrl(r)))`, same for FALLBACK/READ_ONLY, and `const n = normalizeRelayUrl(r); if (selected.has(n) || isRelayBlocked(n)) continue;`

mobile (`NostrProvider.tsx:427-440`): `userRelays.read.forEach(r => selected.add(r))`, and `if (selected.has(r) || isRelayBlocked(r)) continue;` — raw URLs throughout.

Second divergence, `Router.configure({ getPubkeyRelays })`:

web (`:420-423`): `return (cached ?? []).map(normalizeRelayUrl).filter(u => !isRelayBlocked(u));`
mobile (`:390-393`): `return cached.filter(isSecureRelay);` — no normalization AND no `isRelayBlocked` filter.

Mobile's only defence is `getRelayQuality: url => isRelayBlocked(url) ? 0 : getRelayWeight(url)` (:395), which is a sort weight, not an exclusion — welshman can still return a 0-weight relay when it has nothing better. Web keeps the hard filter as well.

Third, mobile's `getPubkeyRelays` calls `getRelayCache(pubkey)` which mutates Map insertion order on every read (`:116-123`), inside the router hot path. Web's `selectFeedRelays` comments say the opposite is required: "Read the cache directly (not getRelayCache) to avoid LRU churn over many authors" (`:602-603`).
- **failure**: A user's NIP-65 list contains `wss://relay.example/` (trailing slash) and a follow's kind-10002 lists `wss://relay.example`. On mobile both enter `selected` as distinct entries, consuming 2 of the 12 `MAX_FEED_RELAYS` slots and opening 2 sockets to the same relay, which duplicates every event and starves 1 genuine outbox relay. Independently, when `wss://relay.example` starts timing out and `_relayBackoff` blocks it for 2 minutes, mobile's `getPubkeyRelays` still hands it to welshman for every targeted thread/profile query, so the relay is re-dialled throughout the backoff window instead of being skipped.
- **fix**: In packages/mobile/src/lib/NostrProvider.tsx: (1) apply normalizeRelayUrl at every insertion in selectFeedRelays :427-440 and before the isRelayBlocked/selected.has checks, mirroring web :598-611; (2) change getPubkeyRelays :387-390 to `const cached = relayCache.get(pubkey) ?? []; return cached.map(normalizeRelayUrl).filter(u => isSecureRelay(u) && !isRelayBlocked(u));` — note this also removes the LRU write from the router hot path; (3) normalize getDefaultRelays/getIndexerRelays :392-393; (4) fix the wrong comment at :74-79 which claims getRelayCache reads don't refresh insertion order. Also normalize on write in updateRelayCache (both platforms) so the cache never stores two spellings of one relay. Longer term, move the shared block (rate limiter, backoff, scoring, auth allow-list, relay-cache LRU, tiered selectFeedRelays) into @core/router behind a KVStorage + relay-factory port.

### ☐ OPEN — Mobile mergeCustomFeedNotes lost web's keyedMutex serialization — concurrent merges interleave at the await and silently drop cached notes
- **area**: `architecture-techdebt` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/hooks/useCustomFeedNotesCache.ts:66`, `packages/web/src/hooks/useCustomFeedNotesCache.ts:304`, `packages/core/src/keyedMutex.ts:1`, `packages/mobile/src/hooks/useCustomFeedNotesCache.ts:185 (startup prune IIFE — same unguarded read-modify-write, locked on web at packages/web/src/hooks/useCustomFeedNotesCache.ts:418)`
- **detail**: Web serializes every read-modify-write on a feed's cache blob (`packages/web/src/hooks/useCustomFeedNotesCache.ts:304-340`):

```ts
import { withKeyedLock } from '@core/keyedMutex';

export async function saveCustomFeedNotes(feedId, events) {
  // Serialize with mergeCustomFeedNotes/prune on the same feed so a concurrent
  // read-modify-write can't overwrite this blob (or vice-versa) and drop notes. (C3)
  return withKeyedLock(`custom-feed:${feedId}`, async () => { ... });
}
export async function mergeCustomFeedNotes(feedId, events) {
  return withKeyedLock(`custom-feed:${feedId}`, async () => { ... });
}
```

Mobile has no lock (`packages/mobile/src/hooks/useCustomFeedNotesCache.ts:66-82`):

```ts
export async function mergeCustomFeedNotes(feedId: string, events: NostrEvent[]): Promise<number> {
  const existing = await getCustomFeedNotes(feedId);   // <-- await = microtask yield
  const existingIds = new Set(existing.map(e => e.id));
  const newEvents = events.filter(e => !existingIds.has(e.id));
  if (newEvents.length > 0) {
    let merged = [...existing, ...newEvents].sort(...).slice(0, MAX_NOTES_PER_FEED);
    mobileStorage.setSync(key, JSON.stringify(merged));
    customFeedMemCache.set(feedId, merged);
  }
  return newEvents.length;
}
```

`getCustomFeedNotes` is declared `async` (line 84) even though MMKV is synchronous, so the `await` at line 67 always yields a microtask — the classic lost-update window. `saveCustomFeedNotes` (:57) has the same unguarded write. `grep -rn '@core/keyedMutex' packages/` confirms `withKeyedLock` is imported only by web, so the shared primitive already sitting in core is unused by mobile.

Call sites that can overlap: `:279` (`saveCustomFeedNotes` after initial fetch), `:326` (`mergeCustomFeedNotes` from loadOlder) and `:355` (`mergeCustomFeedNotes` from the newer-notes refresh).
- **failure**: User taps "load older" on a custom corkboard while the periodic newer-notes refresh is in flight. Both call `mergeCustomFeedNotes('feed-x', ...)`. Both `await getCustomFeedNotes` and resolve with the same 400-note `existing` array. Merge A writes 400+30 older notes; merge B, computed from the stale 400, then writes 400+12 newer notes — silently discarding A's 30 older notes from both MMKV and `customFeedMemCache`. The user's "load older" appears to do nothing, and the loss persists across app restarts.
- **fix**: Two options; the second is strictly better on mobile. (a) Import `withKeyedLock` from `@core/keyedMutex` and wrap the bodies of `saveCustomFeedNotes` (packages/mobile/src/hooks/useCustomFeedNotesCache.ts:57) and `mergeCustomFeedNotes` (:66) in `withKeyedLock(`custom-feed:${feedId}`, …)`, matching web :307/:319. (b) Preferred: delete the yield instead of guarding it — MMKV is synchronous, so drop `async` from `getCustomFeedNotes` (:84) and inline the read into `mergeCustomFeedNotes` so the whole read-modify-write runs in one synchronous block, exactly like the already-correct `mergeNotesToCache` in packages/mobile/src/hooks/useFollowNotesCache.ts:49. If (b) is chosen, keep the exported `Promise`-returning signatures (callers at :279, :326, :355 all `await`) to avoid a wider refactor. Note the finder's fix omits a third site: the startup prune IIFE at packages/mobile/src/hooks/useCustomFeedNotesCache.ts:185-209 does its own unguarded read-modify-write on the same blobs — web takes the lock there (:418) and mobile must too (or be made synchronous). Also note packages/mobile/src/hooks/useCustomFeedNotesCache.ts:165-175 (`getAllKeysSync`) unconditionally returns `[]`, so the mobile-side `getAllCustomFeedIds()` (:153) is permanently broken — worth fixing in the same commit.

### ☐ OPEN — Mobile fetchEvent is missing web's single-flight author-relay discovery (M5) and the hard fallback deadline (M4)
- **area**: `architecture-techdebt` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/lib/fetchEvent.ts:82`, `packages/mobile/src/lib/fetchEvent.ts:169`, `packages/mobile/src/lib/fetchEvent.ts:235`, `packages/web/src/lib/fetchEvent.ts:115`, `packages/web/src/lib/fetchEvent.ts:208`
- **detail**: Two web fixes were never ported.

(M5) `packages/web/src/lib/fetchEvent.ts:115-158` coalesces concurrent kind-10002 discovery per author:

```ts
// (M5) Single-flight cache: concurrent parent-note fetches for the same author
// would each re-discover kind-10002 across all fallback relays. Coalesce them
// into one in-flight promise per pubkey; the entry is cleared once it settles.
const _authorRelaysInFlight = new Map<string, Promise<string[]>>()
```

`packages/mobile/src/lib/fetchEvent.ts:82-107` has no such map — every call runs the full `Promise.all([...FALLBACK_RELAYS, ...READ_ONLY_RELAYS].map(...))` (5 relays per `packages/core/src/relayConstants.ts:18-31`) with a fresh 3s socket each.

(M4) `packages/web/src/lib/fetchEvent.ts:208-213` and `:281-286`:

```ts
// (M4) Hard-cap the fallback: Promise.all(racePromises) can otherwise block
// on the slowest relay long past the 4s race timeout.
const fallbackDeadline = new Promise<null>(resolve => setTimeout(() => resolve(null), 4000))
const all = await Promise.race([Promise.all(racePromises), fallbackDeadline])
```

Mobile still has the unbounded form at `:169` and `:235`: `const all = await Promise.all(racePromises);`

Mobile's concurrency gate is `MAX_CONCURRENT_OUTBOX_FETCHES = 4` (:22), so up to 4 in-flight fetches x 5 discovery relays = 20 sockets, of which up to 15 are pure duplicates when the parents share an author.
- **failure**: A mobile thread view loads 4 missing parent notes that are all replies by the same author. Each `fetchEventWithOutbox` misses phase 1 and independently runs `fetchAuthorRelays(pubkey)` against all 5 discovery relays: 20 WebSocket connections and 20 kind-10002 REQs where web opens 5. On a cellular link where one of those relays accepts the TCP connection but never sends EOSE, `await Promise.all(racePromises)` at :169 has no deadline, so the fetch hangs until `queryRelay`'s own `relay.close()` fires (or indefinitely if close doesn't terminate the async iterator), holding one of the 4 concurrency slots and stalling the remaining parent fetches.
- **fix**: Port `_authorRelaysInFlight` (packages/web/src/lib/fetchEvent.ts:116-159) into packages/mobile/src/lib/fetchEvent.ts:101 — this is the part that actually matters. Porting the M4 `fallbackDeadline` into mobile :169 and :235 is cosmetic parity only (each racePromise is already capped at ≤3s by `AbortSignal.timeout(3000)` and `queryRelay`'s 2500ms `relay.close()` timer) but is cheap and keeps the two files diff-clean. Do NOT accept the finder's 'move the whole state machine into @core/fetchEvent with injected ports' as part of this change — the two files also differ in `NostrLike`'s filter typing (web `unknown[]` at :163 vs mobile `NostrFilter[]` at :130) and in the `onRelayTried` option (web-only, :174/:240), so that refactor is a separate, larger piece of work and bundling it makes the parity fix unreviewable.

### ☐ OPEN — packages/core has zero tests; 12 of web's 19 test files actually exercise core modules, so `npm run test:core` cannot fail on a core regression
- **area**: `architecture-techdebt` · **platforms**: core · **verdict**: CONFIRMED
- **files**: `packages/core/package.json:12`, `package.json:19`, `packages/web/src/lib/sanitize.test.ts:1`, `packages/web/src/lib/ipUtils.test.ts:1`, `packages/web/src/test/blossom.test.ts:1`, `packages/mobile/src/__tests__/core-parity.test.ts:1`
- **detail**: `find packages/core -name '*.test.*'` returns 0 files. `packages/core/package.json` line 12: `"test": "tsc --noEmit && eslint && echo 'Core checks passed!'"` — type-check and lint only, no runtime assertions. Root `package.json:19` wires `test:core` to that script and runs it first "so a shared-code break is reported at its source", but it structurally cannot report one.

Meanwhile 12 of web's 19 test files import `@core/*` and are the de-facto core test suite:
`buildReplyTags.test.ts` (@core/noteClassifier), `hashtagFeedVerdict.test.ts` (@core/noteCategories), `sanitize.test.ts` + `canonicalMediaUrl.test.ts` + `test/stripTrackingParams.test.ts` (@core/sanitizeUtils), `paginationCore.test.ts`, `router.test.ts`, `ipUtils.test.ts` (@core/ipUtils, imageUtils, normalizeRelay, nostrUtils), `zap.test.ts`, `test/blossom.test.ts`, `test/feedAlgorithms.test.ts`, `test/parseListing.test.ts` (@core/nip99).

These run under web's vitest + jsdom + `fake-indexeddb` harness, so core's security-critical pure logic (`sanitizeUtils` XSS flattening, `ipUtils` SSRF guards, `zap` LNURL URL validation, `blossom` URL parsing, `storageKeys` user isolation) is only verified when someone runs the web package. Mobile's entire suite is 2 files (`packages/mobile/src/__tests__/core-imports.test.ts`, `core-parity.test.ts`) — meta-tests that core imports resolve — with zero coverage of its 48 hooks and 60+ components.

Core modules with NO test at all despite being shared by three platforms: `storageKeys.ts` (397 lines, drives user isolation and backup key sets), `contactList.ts` (123 lines, the kind-3 data-loss guard), `threadTree.ts` (7.8KB), `noteClassifier.ts` (160 lines).
- **failure**: A maintainer refactors `packages/core/src/storageKeys.ts` and inverts a condition in `switchActiveUser` so `PER_USER_KEYS` are cleared before `newUserData` is snapshotted. `npm run test:core` passes (tsc and eslint are both clean), so the break is only caught if someone separately runs `test:web` — and even then no test covers `switchActiveUser`, so it ships. Every account switch then wipes the incoming user's feeds/follows/bookmarks. The same blind spot covers `sanitizeUtils.htmlToPlainText` (mobile's only XSS defence, since RN has no DOMPurify) and `ipUtils`'s SSRF guards.
- **fix**: Narrow the fix to what pays. (1) Add vitest to `packages/core` (no DOM deps, so a bare node environment works) and change packages/core/package.json:14 to `"test": "tsc --noEmit && eslint && vitest run"`. (2) Write the three genuinely-missing suites, which is the actual value here: `storageKeys.test.ts` (stash/restore/`switchActiveUser` round-trip, `getAllBackupKeys` platform-variant expansion, `assertValidPubkey` rejection), `contactList.test.ts` (the re-verify-kind-3-before-republish path — the documented data-loss guard), `threadTree.test.ts`. (3) Do NOT mass-migrate the 12 existing web test files as the finder proposes — several run under web's jsdom + fake-indexeddb harness and would need rewriting, and moving them buys coverage that `npm run test` already executes today. Move only the pure-logic ones opportunistically. (4) Either fix or delete the `//test` comment at package.json:17, which currently documents a guarantee the script cannot honour.

### ☐ OPEN — ~3,700 LOC of unreachable code shipped and maintained in parallel across web and mobile, including a complete NIP-22 comments subsystem
- **area**: `architecture-techdebt` · **platforms**: core, web, mobile · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/comments/CommentsSection.tsx:1`, `packages/mobile/src/components/comments/CommentsSection.tsx:1`, `packages/web/src/hooks/useShakespeare.ts:1`, `packages/mobile/src/hooks/useShakespeare.ts:1`, `packages/web/src/lib/nostrIdentifierParser.tsx:13`, `packages/mobile/src/lib/nostrIdentifierParser.tsx:22`
- **detail**: Verified by grepping for every import/JSX reference across `packages/web/src`, `packages/mobile/src`, `packages/mobile/App.tsx`, `packages/web/index.html` and `packages/desktop`:

- NIP-22 comments subsystem, dead on BOTH platforms (~1,186 LOC): `components/comments/{CommentsSection,Comment,CommentForm}.tsx` x2 plus `hooks/{useComments,usePostComment}.ts` x2. `CommentsSection` is the only entry point and nothing mounts it — `grep -rn 'components/comments' | grep -v 'src/components/comments/'` is empty. The four hooks are alive only because the dead components import them.
- `useShakespeare.ts`: 372 LOC (web) + 250 LOC (mobile), zero importers, 188 diff lines between the two copies.
- `nostrIdentifierParser`: `web/src/lib/nostrIdentifierParser.tsx` (120) + `mobile/src/lib/nostrIdentifierParser.tsx` (142), zero importers of `parseNostrIdentifiers` / `extractNevents` / `hasNostrIdentifiers`, 96 diff lines between them.
- `packages/mobile/src/lib/notesCache.ts` (304): a full second follow-notes cache, zero importers (see the separate follow-notes finding).
- `CustomEmojiPicker.tsx` 129 + 257; `LoadingSplashScreen.tsx` 102 + 213; `web/src/components/auth/SignupDialog.tsx` 354; `mobile/src/components/BackupRestoreUI.tsx` 196; `web/src/pages/Index.tsx` 23 (AppRouter.tsx imports MultiColumnClient, NIP19Page, NotFound — never Index).
- `packages/core/src/index.ts` (43): the barrel has ZERO importers — `grep -rn "from '@corkboards/core'\|from '@core'"` is empty; every consumer uses the `@core/<file>` subpath alias. It is also stale, omitting 9 of 34 modules (`cacheConfig, hashCore, imageProxy, keyedMutex, nip99, noteCategories, paginationCore, router, threadTree`).
- `packages/core/src/cryptoUtils.ts` (29): `secureRandomInt` has zero importers monorepo-wide. Likewise `@core/nostrUtils`'s `getTag`/`getTagWhere` and `@core/nostr`'s `NIP19_PREFIXES`/`Nip19Prefix`/`createNip19IdentifierRegex`/`isValidNip19Identifier`/`getNip19PrefixType`.
- 19 orphan shadcn primitives (2,415 LOC): `accordion, aspect-ratio, breadcrumb, calendar, carousel, command, hover-card, input-otp, menubar, navigation-menu, pagination, progress, radio-group, resizable, select, sidebar, table, toggle-group, toggle`.

Total: ~3,720 LOC of dead app code + ~2,415 LOC of orphan UI.
- **failure**: Not a runtime failure — a maintenance-cost and audit-surface failure. CLAUDE.md mandates that every change hit web + mobile + desktop, so a maintainer touching (say) note rendering must read and update `components/comments/Comment.tsx` on two platforms and two copies of `nostrIdentifierParser`, none of which execute. It also poisons this kind of audit: a reviewer grepping for NIP-19 parsing finds three implementations and cannot tell which is live without exhaustively tracing imports — which is exactly how the divergent `NIP19_PREFIXES` (see the nsec-route finding) survived.
- **fix**: Delete in one commit, and stage it so the diff is reviewable: (1) dead app code — `components/comments/**` + `hooks/{useComments,usePostComment}.ts` on both web and mobile; `hooks/useShakespeare.ts` x2; `lib/nostrIdentifierParser.tsx` x2; `packages/mobile/src/lib/notesCache.ts`; `components/compose/CustomEmojiPicker.tsx` x2; `components/LoadingSplashScreen.tsx` x2; `packages/web/src/components/auth/SignupDialog.tsx`; `packages/mobile/src/components/BackupRestoreUI.tsx`; `packages/web/src/pages/Index.tsx`. (2) core cleanup — delete `packages/core/src/index.ts` AND remove all three stale package.json entries, not just one: `"main"` (packages/core/package.json:6), `"types"` (:7), and `exports["."]` (:9), keeping only `"./*"`; delete `packages/core/src/cryptoUtils.ts` and the dead exports in `core/src/nostr.ts`/`nostrUtils.ts`. (3) the 19 orphan `components/ui/*` files plus their now-unused `@radix-ui/*` dependencies. Verify each `@radix-ui` package really has no other importer before removing it from package.json. (4) Add `eslint-plugin-unused-imports` to the web config (mobile already has it) and a `knip` or `ts-prune` step to `npm run test` so this cannot regrow. Note that step 2 must not be squashed with 1 and 3 — a package.json `exports` change is the one part of this that can break resolution at build time.

### ☐ OPEN — Web's NIP19Page re-declares core's NIP19_PREFIXES and adds 'nsec1', so /nsec1... is a live route that decodes a private key from the URL path
- **area**: `architecture-techdebt` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/pages/NIP19Page.tsx:14`, `packages/web/src/pages/NIP19Page.tsx:20`, `packages/web/src/pages/NIP19Page.tsx:25`, `packages/web/src/AppRouter.tsx:22`, `packages/core/src/nostr.ts:12`, `packages/web/public/sw.js`
- **detail**: `packages/core/src/nostr.ts:12` deliberately excludes nsec:

```ts
export const NIP19_PREFIXES = ['npub1', 'note1', 'nprofile1', 'nevent1', 'naddr1'] as const;
```

That export has zero importers. `packages/web/src/pages/NIP19Page.tsx:14` re-declares it locally and adds the private-key prefix back:

```ts
// Valid NIP-19 prefixes
const NIP19_PREFIXES = ['npub1', 'note1', 'nprofile1', 'nevent1', 'naddr1', 'nsec1']
```

`AppRouter.tsx:22` mounts `<Route path="/:nip19" element={<NIP19Page />} />`, so `/nsec1...` passes `isValidPrefix` (line 20) and reaches `nip19.decode(identifier)` at line 25, putting the raw 32-byte secret key into `decoded.data` in JS memory. The switch at line 57 has no `nsec` case, so it renders the generic "Unsupported Type" alert showing `{decoded.type}` — the key itself is not painted, but the app has already treated an nsec URL as a recognised route rather than 404ing it.

This is the duplication defect made concrete: the shared constant exists in core precisely to encode the "never route on nsec" decision, and the local copy silently reverted it.
- **failure**: A user is phished or mis-pastes and loads `https://corkboards.me/nsec1qqq…`. The route resolves, `nip19.decode` runs on the secret key, and the nsec is written into browser history, the session's back/forward cache, any bookmark, and the desktop webview's navigation log — while the page renders a benign-looking "nsec identifiers are not currently supported" message that gives the user no reason to think the key was ever exposed. Under the project's cypherpunk values the correct behaviour is to 404 without decoding.
- **fix**: 1) packages/web/src/pages/NIP19Page.tsx:14 — delete the local array and `import { NIP19_PREFIXES } from '@core/nostr'`. nsec then fails isValidPrefix at :20 and hits the existing 404 branch at :32 before nip19.decode is ever reached. (Note the core constant is `as const`, so `NIP19_PREFIXES.some(p => identifier.startsWith(p))` still type-checks unchanged.)
2) Add an explicit early guard before the decode: if identifier.startsWith('nsec1') || identifier.startsWith('ncryptsec1'), call window.history.replaceState(null, '', '/') and render the 404. This is the only step that actually removes the key from the current history entry — the prefix-list fix alone does not.
3) packages/web/public/sw.js:37-43 — skip the navigate cache.put when /(nsec1|ncryptsec1)[0-9a-z]{20,}/i matches url.pathname, and skip the cache.match fallback for it too, so the key is never written to Cache Storage on disk. Do NOT skip only the put; the request object itself is the cache key.
4) Test: assert /nsec1... renders 'Page Not Found' and that nip19.decode is not called (vi.spyOn on nostr-tools' nip19).

### ☐ OPEN — Unused runtime dependencies shipped in packages/web: zustand, nostr-login, @welshman/lib, @welshman/net and four others have zero imports
- **area**: `architecture-techdebt` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/package.json:47`, `packages/web/package.json:52`, `packages/web/package.json:53`, `packages/web/package.json:87`, `packages/web/src/App.tsx:13`, `packages/mobile/package.json`
- **detail**: Grepping each declared `dependency` against `packages/web/src`, `index.html`, `vite.config.ts` and `tailwind.config.ts`:

- `zustand@^5.0.11` — 0 hits anywhere in the monorepo. This matters for the architecture question: the state layering is NOT "TanStack Query + zustand + context + storage". zustand is a phantom; the real layering is TanStack Query (server state) + 5 small React contexts (`contexts/{AppContext,deletedAuthors,hashtagAction}.ts`, `hooks/useNwc.tsx`, `components/ProfileModal.tsx`) + IDB-backed `useLocalStorage`, which is coherent.
- `nostr-login@^1.7.12` — 1 hit, and it is a prose mention in a comment (`packages/web/src/hooks/useSessionAbort.ts:15`). The actual provider comes from a different package: `App.tsx:13` is `import { NostrLoginProvider } from '@nostrify/react/login'`.
- `@welshman/lib` and `@welshman/net` — 0 hits. Only `@welshman/router` (2 hits) and `@welshman/util` (1 type-only hit) are used, both in `NostrProvider.tsx:7-8`.
- `react-intersection-observer@^9.16.0` — 0 hits.
- `@radix-ui/react-scroll-area@^1.1.0` — 0 hits (its `components/ui/scroll-area` consumer set is empty).
- `@fontsource-variable/inter@^5.2.6` — 0 hits in src, index.html or any CSS.
- Plus the ~10 `@radix-ui/*` packages backing the orphan `components/ui/*` files listed in the dead-code finding.

On the overlapping-libraries question this is actually the good news: `@nostrify/*` owns the pool/relay/signer layer and `@welshman/router` owns only relay *selection*, with the boundary documented at `NostrProvider.tsx:403-407`. There is no real overlap — just four dangling welshman/zustand/nostr-login entries implying one.
- **failure**: No runtime failure (unimported packages are tree-shaken out of the bundle). The cost is install weight, `npm audit` noise, and supply-chain surface: seven packages plus their transitive trees are fetched, executed at install time, and pinned in the lockfile for code that does not exist. `nostr-login` in particular reads as an auth dependency during any security review of a Nostr app and forces a reviewer to trace it before concluding it is inert.
- **fix**: npm uninstall -w @corkboards/web zustand nostr-login @welshman/lib @welshman/net react-intersection-observer @radix-ui/react-scroll-area @fontsource-variable/inter — correct locations are package.json:81, :64, :51, :52, :71, :35, :15. Do NOT delete src/components/ui/scroll-area.tsx: it has four live importers and is already Radix-free, so only the npm package goes. Reword useSessionAbort.ts:15 to say '@nostrify/react/login' so the name stops implying a dependency. If @fontsource-variable/inter is wanted, it needs `import '@fontsource-variable/inter'` in main.tsx plus a font-family rule in index.css — neither exists today. The @radix-ui/* packages behind orphan ui/* files should be removed in the same pass as those files, not before. Wire `npx depcheck` (ignoring tailwindcss-animate, autoprefixer, postcss, which are config-referenced) into the `test` script so this cannot recur.

### ☐ OPEN — MultiColumnClient reads a platform-specific setting from raw localStorage; the one-way IDB migration guarantees it is always null, so the saved column count is ignored on first paint
- **area**: `architecture-techdebt` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/pages/MultiColumnClient.tsx:335`, `packages/web/src/pages/MultiColumnClient.tsx:307`, `packages/web/src/lib/idb.ts:264`, `packages/core/src/storageKeys.ts:120`
- **detail**: `packages/web/src/pages/MultiColumnClient.tsx:334-338`:

```ts
const [columnCount, setColumnCount] = useState(() => {
  const savedDefault = localStorage.getItem('corkboard:default-column-count');
  const defaultCount = savedDefault ? parseInt(savedDefault, 10) : 3;
  return window.innerWidth < 768 ? 1 : defaultCount;
});
```

`'corkboard:default-column-count'` is `STORAGE_KEYS.DEFAULT_COLUMN_COUNT`, listed in `PLATFORM_SPECIFIC_KEYS` (`packages/core/src/storageKeys.ts:120`). Its only writer is `usePlatformStorage` -> `setPlatformSetting` -> `idbSetSync('web:corkboard:default-column-count', ...)` — IndexedDB, platform-PREFIXED. Nothing ever writes the unprefixed key to localStorage; `packages/web/src/lib/idb.ts:264-292` (`migrateFromLocalStorage`) copies localStorage -> IDB exactly once behind a flag and never writes back.

So the read returns `null` on every device that has completed migration, and the initializer silently falls back to the hardcoded `3` — while the correct value is already in scope two lines up at `:307`: `const [defaultColumnCount] = usePlatformStorage<number>(STORAGE_KEYS.DEFAULT_COLUMN_COUNT, 3)`. A later effect (`:1578-1581`, `setColumnCount(columnCountDerived)`) reconciles it, so the damage is bounded to the first render.

This is the clearest symptom of the storage-layer incoherence: the web package has four overlapping persistence APIs — raw `localStorage`, `idbGetSync/idbSetSync` (`lib/idb.ts`), `useLocalStorage` (named for localStorage but IDB-backed, `hooks/useLocalStorage.ts:2`), and `usePlatformStorage` (IDB + platform prefix) — plus four separate IndexedDB databases opened by three different mechanisms: `corkboard` (`lib/idb.ts:11`, raw `indexedDB.open`), `corkboard-cache` (`lib/cacheStore.ts:33`, via the `idb` npm package), `corkboard-notes` (`lib/notesCache.ts:12`, raw), `corkboard-keys` (`lib/webKeyStore.ts:28`, raw). Nothing in the type system stops a caller picking the wrong one.
- **failure**: A desktop user sets their default column count to 5. On every subsequent app start the grid mounts with 3 columns, lays out and fetches for 3 columns, then the `columnCountDerived` effect fires and re-lays-out to 5 — a visible flash plus a wasted layout/fetch pass. If the reconciling effect at :1578 is ever removed or its dependency array changes, the setting breaks outright with no error.
- **fix**: Replace MultiColumnClient.tsx:335-337 with `return window.innerWidth < 768 ? 1 : defaultColumnCount;` using the value already bound at :307 (it must stay below :307 in source order). Frame this as removing a dead/stale read, not as fixing the flash — the flash is inherent to useLocalStorage's cold memCache and only the effect at :1579-1582 resolves it. If the flash itself matters, await idbReady before the first grid render or seed memCache for PLATFORM_SPECIFIC_KEYS during idb init. Then close the hole structurally: web's lib/storageKeys.ts exports isPlatformSpecificKey() with zero callers — use it in a dev-only assertion inside idbGetSync/idbSetSync that warns when a PLATFORM_SPECIFIC_KEYS member is accessed unprefixed, and add an ESLint no-restricted-properties rule banning localStorage.getItem/setItem outside lib/idb.ts, lib/webKeyStore.ts, lib/imageProxySettings.ts, hooks/useNostrBackup.ts, hooks/useLoginActions.ts and the emoji-favorites trio. The 'collapse four IndexedDB databases' suggestion is a separate refactor, not part of this fix.

### ☐ OPEN — nostrEncrypt.ts and mediaUtils.ts are semantically identical pure modules duplicated in web and mobile — comment-only diffs today, guaranteed drift tomorrow
- **area**: `architecture-techdebt` · **platforms**: web, mobile, core · **verdict**: CONFIRMED
- **files**: `packages/web/src/lib/nostrEncrypt.ts:1`, `packages/mobile/src/lib/nostrEncrypt.ts:1`, `packages/web/src/lib/mediaUtils.ts:1`, `packages/mobile/src/lib/mediaUtils.ts:1`, `packages/web/src/lib/tips.ts`, `packages/mobile/src/lib/tips.ts`
- **detail**: `diff -u packages/web/src/lib/nostrEncrypt.ts packages/mobile/src/lib/nostrEncrypt.ts` yields 9 changed lines, ALL of them doc comments — the AES-256-GCM key generation, encrypt, decrypt, `rawKeyToHex` and `hexToRawKey` bodies are byte-identical. Same for `mediaUtils.ts`: 13 changed lines, all comment text (`CORS HEAD` wording, the `imageHosts` rationale); the `CORS_HEAD_HOSTS` set, `supportsCorsHead`, `learnCorsHost` and the extension regex are identical.

Both modules are 100% pure — `nostrEncrypt` uses only WebCrypto (available in Hermes via the `react-native-get-random-values` polyfill, per its own header) and `mediaUtils` uses only `URL` and regexes. Neither has a DOM or React dependency, so both meet `packages/core`'s stated contract ("Pure TypeScript modules with no DOM or React dependencies"). They are 124+119 and 78+77 lines respectively: ~400 LOC maintained twice for zero platform-specific reason.

This contrasts with the modules that HAVE been consolidated correctly — `storageKeys`, `relayConstants`, `imageUtils`, `contactList`, `sanitizeUtils`, `noteClassifier`, `formatTimeAgo`, `genUserName`, `textTruncation`, `failedNotes`, `normalizeRelay`, `defaultEmojiSet` are all thin `export * from '@core/…'` shims or properly DI'd adapters (storageKeys takes a `KVStorage`, which is the right pattern). The three-way split is drawn in the right place; these are stragglers, and each pair is one comment-edit away from a real semantic divergence.

Related straggler in the same class: web's `feedUtils.fetchByHashtags` (`packages/web/src/lib/feedUtils.ts:174-208`) applies the NIP-24 tag-stuffing filter `sorted.filter(note => tags.some(tag => hashtagFeedVerdict(note, tag) !== 'spam'))`; mobile has no `fetchByHashtags` and inlines the same predicate twice in `hooks/useCustomFeedNotes.ts:221` and `:320` — a third and fourth copy of one rule.
- **failure**: A future security fix to the AES envelope (say, switching the IV length or adding an AAD binding the ciphertext to the pubkey) is applied to `packages/web/src/lib/nostrEncrypt.ts` only. Web then writes Blossom backup blobs mobile cannot decrypt — and because both files already differ (comment noise), a reviewer diffing them sees changed lines and assumes the divergence is intentional. The identical risk exists for the hashtag spam filter: fixing `hashtagFeedVerdict`'s usage in web's `fetchByHashtags` leaves mobile's two inline copies unpatched.
- **fix**: Move packages/web/src/lib/nostrEncrypt.ts -> packages/core/src/nostrEncrypt.ts and packages/web/src/lib/mediaUtils.ts -> packages/core/src/mediaUtils.ts verbatim (keep web's fuller comments), then replace all four platform files with one-line `export * from '@core/nostrEncrypt'` / `'@core/mediaUtils'` shims, matching the existing imageUtils.ts / relayConstants.ts pattern. Keep the RN caveat as a comment in the core file: it depends on the btoa/atob and crypto globals, which RN supplies only via polyfill. Do the same for lib/tips.ts, which has already drifted — move to @core/tips and pick one wording for the Discover-card tip (verify against the current UI before choosing; web says 'button below their avatar', mobile says 'click their name'). Add packages/core/src/nostrEncrypt.test.ts with an encrypt->decrypt round trip and a wrong-key rejection, since core has no test for it. Drop the fetchByHashtags/@core/feedAlgorithms item or file it separately as a nit — hashtagFeedVerdict is already shared from @core/noteCategories.ts:248 and only a `!== 'spam'` predicate is repeated.

### ☐ OPEN — NaN from a malformed zap `amount` tag propagates into the UI and poisons the whole note's zap total
- **area**: `error-handling-edge` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/EngagementBar.tsx:112`, `packages/web/src/components/EngagementBar.tsx:148`, `packages/web/src/components/EngagementBar.tsx:135`
- **detail**: `getZapAmount` reads the amount out of the embedded zap-request JSON with no numeric validation:
```ts
const amountTag = zapRequest.tags?.find((t: string[]) => t[0] === 'amount')?.[1]
if (amountTag) return Math.floor(parseInt(amountTag, 10) / 1000) // millisats → sats
```
`parseInt('abc', 10)` is `NaN`; `Math.floor(NaN/1000)` is `NaN`; the function returns it. The surrounding `try` never fires because returning NaN is not an exception. The value then flows into
```ts
const totalZapSats = useMemo(() => zaps.reduce((sum, z) => sum + getZapAmount(z), 0), [zaps])
```
and `formatSats(NaN)` (line 132-136) falls through both `>=` comparisons to `String(NaN)` → the literal text `NaN`.

The sibling implementation gets this right — `useNotifications.ts:112-113` does `const msats = parseInt(amountTag[1], 10); if (!isNaN(msats) && msats > 0)`. Only the EngagementBar copy is unguarded.
- **failure**: Any relay serves a kind-9735 whose `description` tag is `{"tags":[["amount","1000 sats"]]}` (or `""`, or `"1e3"` → 1). `getZapAmount` returns NaN, the reduce turns the note's entire zap total into NaN, and the engagement bar renders `NaN` next to the zap icon — including for all the legitimate zaps on that note, whose amounts are now unrecoverable in the UI.
- **fix**: Delete the duplicate rather than patch it. `getZapAmountSats` in packages/web/src/hooks/useNotifications.ts:106 is already exported, already correct, and additionally reads the top-level `amount` tag that EngagementBar's copy ignores entirely. Export it from a shared module (or import it directly), drop EngagementBar.tsx:105-129, and change :148 to `sum + (getZapAmountSats(z) ?? 0)` — note it returns `number | null`, and it early-returns null for `event.kind !== 9735`, which is the correct behavior here anyway.

If the local copy is kept for any reason, the minimum is: parse into a local, `const msats = parseInt(amountTag, 10); if (Number.isFinite(msats) && msats > 0) return Math.floor(msats / 1000);` — falling THROUGH to the bolt11 fallback at :116 rather than returning, so a garbled description tag still recovers the real amount from the invoice. Keep the defensive reduce (`sum + (Number.isFinite(v) ? v : 0)`) regardless, so no single receipt can ever poison the aggregate.

While in that function, note the bolt11 fallback regex at :118 `/lnbc(\d+)([munp]?)/` is also wrong for testnet/regtest prefixes — fold it into the shared bolt11 decoder proposed for the zap-invoice finding.

### ☐ OPEN — Two contradictory bolt11 amount parsers disagree by a factor of 100 million on the same invoice
- **area**: `error-handling-edge` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NoteCard.tsx:1252`, `packages/web/src/components/NoteCard.tsx:1255`, `packages/web/src/components/EngagementBar.tsx:118`, `packages/web/src/components/EngagementBar.tsx:126`
- **detail**: Both sites use the same loose regex `/lnbc(\d+)([munp]?)/` and then apply *different* multipliers for the empty-unit case.

NoteCard.tsx:1255-1256:
```ts
const multipliers: Record<string, number> = { '': 1e8, 'm': 1e5, 'u': 100, 'n': 0.1, 'p': 0.001 };
const sats = Math.round(parseInt(num) * (multipliers[unit] || 1));
```
EngagementBar.tsx:122-126:
```ts
if (unit === 'm') return num * 100_000
if (unit === 'u') return num * 100
if (unit === 'n') return Math.floor(num / 10)
if (unit === 'p') return Math.floor(num / 10_000)
return num // assume sats if no unit
```
BOLT-11 says a bare amount with no multiplier is denominated in **BTC**, so NoteCard's `1e8` is right and EngagementBar's `return num` is wrong by 1e8. Separately, the regex is unanchored and does not respect the bolt11 grammar: the amount field ends at the `1` separator, so on an amountless invoice `lnbc1p<data>` the regex happily matches `num="1"` and whatever bech32 character follows as the unit. Note also `multipliers[unit] || 1` silently substitutes 1 for `n` when unit is absent from the map — dead here, but a trap if the map is edited.
- **failure**: A zap receipt carries an amountless invoice `lnbc1qrp…` (data part beginning with a non-`munp` character — legal bech32). NoteCard renders the badge as `100000k sats` (1 × 1e8), EngagementBar counts it as `1` sat, and the same note therefore displays two mutually contradictory zap figures at the same time. For a genuine no-multiplier invoice such as `lnbc2` (2 BTC), EngagementBar reports 2 sats.
- **fix**: Add one `parseBolt11Sats(invoice: string): number | null` to packages/core/src (next to zap.ts) and call it from NoteCard.tsx:1250 and EngagementBar.tsx:117. Anchor on the human-readable part so the bech32 separator terminates the amount and testnet/regtest are handled: `/^ln(bc|tb|bcrt)(\d+)?([munp])?1/i`. Return null when the amount group is absent so NoteCard renders 'Zapped' instead of '0 sats'. Multipliers relative to BTC: none = 1e8 sats, m = 1e5, u = 1e2, n = 1e-1, p = 1e-4 (compute in msat and floor, per BOLT-11's 'must round down'). Also give NoteCard the same description/`amount`-tag preference EngagementBar already has (EngagementBar.tsx:107-113) — the tag is authoritative and present on virtually every real zap receipt, which removes the bolt11 path from the common case entirely. Drop the `multipliers[unit] || 1` idiom while you are there; `|| 1` would silently mis-scale 'n' (0.1 is falsy-adjacent only by edit accident, but the map lookup should be exhaustive).

### ☐ OPEN — Media classification matches trusted CDN names as bare substrings, so a note can auto-load an image from any host it chooses
- **area**: `error-handling-edge` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NoteContent.tsx:452`, `packages/web/src/components/NoteContent.tsx:585`, `packages/web/src/components/NoteContent.tsx:344`, `packages/web/src/lib/mediaUtils.ts:65`, `packages/web/src/lib/mediaUtils.ts:76`, `packages/mobile/src/lib/mediaUtils.ts:65 — identical `u.hostname.includes(host)` substring test`
- **detail**: `mediaPattern` is built by joining host names into an alternation with no anchoring, no escaping of `.`, and no URL parsing:
```ts
const mediaPattern = new RegExp(`(${['youtube.com', … , 'nostr.build', 'void.cat', …].join('|')}|\\.(?:jpg|…)(?:[?#]|$))`, 'i')
```
and is then applied to the whole matched token: `} else if (mediaPattern.test(fullMatch)) { parts.push({ type: 'media', value: fullMatch }) }` (line 585). A `media` part renders as `<MediaLink url={part.value} …/>` (line 344), i.e. an `<img>`/`<video>` that fetches on render with no user interaction — whereas a `web` part renders as an inert `<WebLink>`.

So the substring only has to appear *somewhere* in the URL. `https://tracker.example.com/px?ref=nostr.build` matches. So does `https://evil.example/void.cat`. The unescaped dots widen it further (`nostrXbuild` matches).

`mediaUtils.ts` repeats the mistake with hostnames it does parse: `isImageUrl` uses `imageHosts.some(host => u.hostname.includes(host))` (line 65) and `isCdnHost` uses `h.includes(p)` (line 76), so `nostr.build.attacker.example` is treated as a trusted image CDN. The neighbouring `supportsCorsHead` (line 22) gets this right with `h.endsWith('.' + known)` — the two functions in the same file disagree.
- **failure**: An attacker posts a note containing `https://beacon.attacker.example/t.gif?x=nostr.build`. The URL has no image extension and is not on any CDN, but `mediaPattern` matches the substring, so it is classified `media` and `MediaLink` issues a GET the instant the note scrolls into view. The attacker's server logs the IP, User-Agent and timestamp of every user whose feed rendered that note — a read-receipt and IP-harvesting primitive against an app whose stated value is 'no third-party leakage'. The image proxy does not help: it is opt-in and off by default (imageProxy.ts:12-13).
- **fix**: Parse once, compare hostnames with the rule the same file already uses (`h === host || h.endsWith('.' + host)` — mediaUtils.ts:22, MediaLink.tsx:199-201):
- mediaUtils.ts:65 — replace `u.hostname.includes(host)` with `hostMatches(u.hostname, host)`; hoist `hostMatches` into mediaUtils so MediaLink and mediaUtils share it.
- mediaUtils.ts:76 — same; the `'blossom.'`/`'cdn.sovbit'`/`'files.primal'` prefixes there are not even whole hostnames, so rewrite that list as full hosts (`blossom.band`, `blossom.primal.net`, …) plus a `startsWith('blossom.')` case if the wildcard is intentional.
- NoteContent.tsx:452 — stop regexing the raw token. Do `try { const u = new URL(token) } catch { return false }`, then `MEDIA_HOSTS.some(h => hostMatches(u.hostname, h)) || IMAGE_EXT.test(u.pathname)`; testing `u.pathname` (not the whole URL) also stops `?x=….jpg` from promoting a link. Escape or drop the regex entirely.
Mirror all three on mobile. No behaviour change for legitimate CDN URLs; the only visible difference is that lookalike hosts fall through to `WebLink`/inert link, which is the correct outcome.

### ☐ OPEN — getBlockedRelays throws on corrupt storage — unguarded JSON.parse feeding a Set constructor
- **area**: `error-handling-edge` · **platforms**: web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useNostrBackup.ts:39`, `packages/mobile/src/hooks/useNostrBackup.ts:67`, `packages/mobile/src/hooks/useNostrBackup.ts:67-70 — identical unguarded `new Set(JSON.parse(stored))` (the finder listed this; confirmed verbatim)`
- **detail**: ```ts
export function getBlockedRelays(): Set<string> {
  const stored = idbGetSync(BLOCKED_RELAYS_KEY);
  return stored ? new Set(JSON.parse(stored)) : new Set();
}
```
No try/catch, and two distinct throw paths: `JSON.parse` on a truncated/corrupt value, and `new Set(x)` on any parsed non-iterable (`new Set(5)` → "number is not iterable"; `new Set({})` → "object is not iterable"). Both platforms are identical (mobile reads from `mobileStorage.getSync`). Every other reader of this key class in the same file is defensive — `parseIdArr` (line 385-391), `countArrayJson` (442-448), `jsonLen` (369-376) all wrap and validate `Array.isArray` — so this is an outlier, not a house style.

`isRelayBlocked` (line 45) calls it on every relay-selection decision, so the throw surfaces in the publish/backup path rather than at a boundary that can recover.
- **failure**: A partially-written IDB value (interrupted write, or a restore that writes `"true"` into the key) makes `getBlockedRelays()` throw. `isRelayBlocked` propagates it into whatever relay-selection code is running — during an auto-save this aborts the backup with an unhandled TypeError rather than the file's normal 'skipped' path.
- **fix**: Match the file's own parser style, in both twins:
```ts
export function getBlockedRelays(): Set<string> {
  const stored = idbGetSync(BLOCKED_RELAYS_KEY); // mobileStorage.getSync on mobile
  if (!stored) return new Set();
  try {
    const arr = JSON.parse(stored);
    return new Set(Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : []);
  } catch { return new Set(); }
}
```
Better still, since a corrupt value would otherwise be re-read forever, have the catch branch `idbRemoveSync(BLOCKED_RELAYS_KEY)` so the next `blockRelay` writes a clean array.

### ☐ OPEN — Auto-save regression guard computes a bookmark count it never checks
- **area**: `error-handling-edge` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useNostrBackup.ts:455`, `packages/web/src/hooks/useNostrBackup.ts:804`, `packages/mobile/src/hooks/useNostrBackup.ts:210-215 — mobile SNAPSHOT_KEYS also omits 'nostr-bookmark-ids', and mobile has NO counts-based regression guard whatsoever (only hasUnsavedChanges/saveSnapshot at :227-251), so mobile auto-save can overwrite a good cloud backup after any local wipe. Separate, larger parity gap than the web fix.`
- **detail**: `snapshotCounts` populates four fields (useNostrBackup.ts:450-457):
```ts
return {
  dismissed: countArrayJson(snapshot['dismissed-notes']),
  feeds: countArrayJson(snapshot['nostr-custom-feeds']),
  collapsed: countArrayJson(snapshot['collapsed-notes']),
  bookmarks: countArrayJson(snapshot['nostr-bookmark-ids']),
};
```
The guard that consumes them (lines 804-826) checks `prev.dismissed`, `prev.feeds` and `prev.collapsed` — and never reads `prev.bookmarks`. There is also a second gap in the same block: `snapshot['nostr-bookmark-ids']` is not in `SNAPSHOT_KEYS` (line 427), so `snapshotCounts` reads `undefined` from the snapshot and `countArrayJson(undefined)` returns 0 (line 443) — meaning `prev.bookmarks` is persisted as `0` on every save regardless of the real count, and would be useless even if the guard did read it.

The comment directly above says "Three real production data-loss incidents were caused by this guard being dead code; now it actually runs" — for three of the four tracked collections.
- **failure**: The user's `nostr-bookmark-ids` key is lost locally (evicted from memCache per the finding above, or cleared by browser storage cleanup). Auto-save runs: feeds, dismissed and collapsed are all intact so every guard passes, and the backup is overwritten with an empty bookmark list. The next restore on any device propagates the empty list. The regression guard was designed to catch exactly this and does not.
- **fix**: Web (packages/web/src/hooks/useNostrBackup.ts):
1. Add `'nostr-bookmark-ids'` to `SNAPSHOT_KEYS` (:427) so all four snapshot builders (:735, :898, :1543, :1695) actually capture it and `prev.bookmarks` stops being a hardcoded 0. Verify no consumer of `SNAPSHOT_KEYS` assumes the current membership — `persistSnapshotAndHashes` (:465-471) also hashes every SNAPSHOT_KEY into `last-backup-hashes`, so adding the key makes bookmark edits newly trigger 'unsaved changes', which is desirable but is a behaviour change worth noting in the commit.
2. Inside the existing `try` at :806-826, add the missing check next to the others:
```ts
const currBookmarks = countArrayJson(idbGetSync('nostr-bookmark-ids'));
if (prev.bookmarks > 5 && currBookmarks < prev.bookmarks * 0.5) {
  debugWarn('[backup]', `Auto-save blocked: bookmarks dropped from ${prev.bookmarks} to ${currBookmarks}`);
  return 'skipped';
}
```
Guard it with `typeof prev.bookmarks === 'number'` so counts written by the current build (always 0) can't be misread after the SNAPSHOT_KEYS change — a stored 0 simply never trips the `> 5` threshold, so no migration is needed.
3. Do NOT claim a mobile mirror in the same commit; file the mobile counts-guard port separately (mobile has no equivalent guard at all).

### ☐ OPEN — RSS items are HTML-escaped for a sink that renders plain text, so entities are visible in the feed
- **area**: `error-handling-edge` · **platforms**: core, web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/core/src/rss.ts:23`, `packages/core/src/rss.ts:64`
- **detail**: `rssItemsToEvents` builds the pseudo-event body as
```ts
content: `**${escapeHtml(item.title)}**\n\n${escapeHtml(item.description)}${item.link ? `\n\n${item.link}` : ''}`,
```
where `escapeHtml` (lines 23-30) converts `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`, `'`→`&#39;`. The stated purpose is "prevent injection via RSS feed content" — but this string is never used as HTML. It becomes `event.content`, which flows into `NoteContent`/`SmartNoteContent` and is rendered as React children or through react-markdown (which escapes HTML itself by default). The escaping is therefore not load-bearing for safety, and it is visible when the markdown path is not taken: `parseContent` only tags a segment as `markdown` when `renderMarkdown` is true (NoteContent.tsx:622), and the app offers a per-note "show original" toggle plus a global markdown-off setting that set it to false. In the raw path the entities are printed literally.
- **failure**: A user turns markdown rendering off (or hits "show original" on an RSS item). The headline "Tom & Jerry's <b>return</b>" renders as `Tom &amp; Jerry&#39;s &lt;b&gt;return&lt;/b&gt;` in the feed — every apostrophe, ampersand and quote in every RSS feed shows as an entity.
- **fix**: Drop `escapeHtml` from packages/core/src/rss.ts entirely (delete lines 22-30 and both call sites at line 64) and replace it with `htmlToPlainText` from './sanitizeUtils' (packages/core/src/sanitizeUtils.ts:111) — it is DOM-free (regex strip passes + `decodeHtmlEntities`), so it is safe in core for React Native, it preserves the markup-stripping intent for `title` (which rss-proxy.php:535/561 never strip_tags), and it decodes entities instead of introducing them. Result: `content: '**' + htmlToPlainText(item.title) + '**\n\n' + htmlToPlainText(item.description) + ...'`. Separately, mobile's lack of any markdown rendering means the `**` wrappers show raw there — a parity gap worth its own item.

### ☐ OPEN — Tauri `keychain_store` / `keychain_delete` accept arbitrary key names from the webview, letting JS overwrite or destroy any account's stored nsec
- **area**: `key-management-crypto` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/keychain.rs:26`, `packages/desktop/src-tauri/src/keychain.rs:52`, `packages/desktop/src-tauri/src/keychain.rs:11`, `packages/desktop/src-tauri/src/signer.rs:19`
- **detail**: `keychain.rs:35-39` carefully reasons about XSS for the *read* path and keeps `get_secret` out of `#[tauri::command]` for exactly that reason. The write and delete paths got no equivalent treatment. `validate_key` (lines 11-22) only checks emptiness, length ≤ 256, and an ASCII charset — it does not constrain the namespace:

```rust
if !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b':' || b == b'_' || b == b'.') {
```

and `keychain_store` accepts any `value` up to 64 KB with no validation that it is even an nsec, let alone one whose pubkey matches the key name. Both commands are registered in `lib.rs:72-73` and reachable from the webview via `invoke()`.

Meanwhile `signer.rs:19-23` resolves the signing key purely by name and then signs with whatever it finds:
```rust
fn keys_for(pubkey: &str) -> Result<Keys, String> {
    let nsec = keychain::get_secret(&format!("nsec:{pubkey}"))?...
```
`sign_event` (line 64) builds the event with `keys.public_key()` — the *stored* key's pubkey — while the JS layer still believes the session belongs to `login.pubkey`. So a swapped entry produces a silent identity substitution rather than an error.
- **failure**: Any JS execution in the desktop webview (a compromised npm dependency in the bundle, a supply-chain'd build) calls `invoke('keychain_store', { key: 'nsec:<victim pubkey>', value: '<attacker nsec>' })`. The victim's real key is overwritten and unrecoverable unless they backed it up. From then on every note, follow-list update and kind-30078 backup envelope the user publishes is signed by the attacker's key and attributed to the attacker's pubkey, while the UI keeps showing the victim's avatar and name (`useCurrentUser` still returns `login.pubkey`). A single `invoke('keychain_delete', {key: 'nsec:<pubkey>'})` per account is a one-call irreversible wipe of every identity on the machine.
- **fix**: In keychain.rs, add `fn validate_nsec_key(key: &str)` requiring `key.strip_prefix("nsec:").is_some_and(|pk| pk.len()==64 && pk.bytes().all(|b| b.is_ascii_hexdigit()))` and call it from both commands. In `keychain_store`, additionally `Keys::parse(&value)` and require `keys.public_key().to_hex() == pk` — this makes the overwrite attack unforgeable, since an attacker cannot produce an nsec for the victim's pubkey. Note the destroy half is NOT fixed by name validation (logout legitimately deletes `nsec:<own pubkey>`): to blunt that, require deletion to go through a command that first checks the pubkey is in the current login set, or simply accept it as residual. Independently, in signer.rs `keys_for` (line 19-23) add `if keys.public_key().to_hex() != pubkey { return Err("keychain entry does not match requested pubkey") }` so any mismatch surfaces as an error instead of a silent identity substitution across sign_event/nip44_*/nip04_*.

### ☐ OPEN — LoginDialog wipes the system clipboard on every unmount and WelcomePage schedules an uncancellable 30s wipe, destroying unrelated user clipboard content
- **area**: `key-management-crypto` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/auth/LoginDialog.tsx:46`, `packages/web/src/components/auth/WelcomePage.tsx:143`, `packages/mobile/src/components/auth/WelcomePage.tsx:86 — identical bare 30s `Clipboard.setStringAsync('')` timer, no ref, no cancel; unconditional clobber (no permission gate on RN).`, `packages/mobile/src/components/AddAccountModal.tsx:101 — same pattern at 15s.`, `packages/mobile/src/components/SignupFlow.tsx:59-62 — same pattern at 15s.`
- **detail**: `LoginDialog.tsx:46-52` clears the clipboard unconditionally on unmount, whether or not the user ever pressed Copy:

```tsx
useEffect(() => {
  return () => {
    clearTimeout(copiedTimerRef.current);
    clearTimeout(clipboardTimerRef.current);
    navigator.clipboard.writeText('').catch(() => {});   // always runs
  };
}, []);
```

`WelcomePage.copyKey` (lines 143-152) has a second variant of the problem — the 30-second wipe timer is a bare `setTimeout` with no ref, so unlike LoginDialog it can neither be cancelled on unmount nor superseded:
```ts
setTimeout(() => { navigator.clipboard.writeText('').catch(() => {}); }, 30000);
```
The timer fires blind 30 seconds later and overwrites whatever is on the clipboard at that moment.

The intent (shrink the exposure window for a copied nsec) is good; the implementation destroys data the app doesn't own. `WelcomePage` is the app's *login screen*, so the most likely thing on the clipboard 30 seconds later is something the user copied from a password manager.
- **failure**: User opens the login dialog, decides to log in with an extension instead, and closes it — the unmount cleanup silently erases the URL / password / text they had copied before opening the app. Or: user clicks Copy on their new nsec, pastes it into their password manager, then copies a TOTP code; 30 seconds after the nsec copy the orphan timer replaces the TOTP code with an empty string mid-paste.
- **fix**: Make the wipe conditional on still owning the clipboard, and make it cancellable. In WelcomePage: hold the timer in a `clipboardTimerRef`, `clearTimeout` it at the top of `copyKey` and in the unmount effect at lines 92-97; set a `didCopyRef.current = true` in `copyKey`, clear it on `window` blur/`visibilitychange` (the user switched away and almost certainly copied something else) and check it inside the timer before writing. Same treatment for the three mobile sites. For LoginDialog, delete the `navigator.clipboard.writeText('')` line from the unmount cleanup at line 50 outright — keep the `clearTimeout` calls — since it can fire without any copy ever having happened; or delete LoginDialog/LoginArea/comments entirely if the components are confirmed dead.

### ☐ OPEN — Startup key migration races a 3-second timeout; if the encrypted write then fails, the plaintext fallback is overwritten by the login provider and the account becomes unrecoverable
- **area**: `key-management-crypto` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/src/main.tsx:152`, `packages/web/src/lib/webKeyStore.ts:260`, `packages/web/src/lib/webNsecSigner.ts:29`
- **detail**: `main.tsx:152-157` bounds the migration with a timeout and renders regardless:

```ts
Promise.race([
  prepareLoginStorage('corkboard:login').catch(...),
  new Promise<void>((resolve) => setTimeout(resolve, 3000)),
]).then(renderApp);
```

The synchronous blanking phase (webKeyStore.ts:236-251) does run before this, so no plaintext survives the race — that part is sound. The problem is the *availability fallback* in the async phase (webKeyStore.ts:260-277): when `storeNsec` returns false it rewrites the plaintext nsec back into `localStorage['corkboard:login']`.

If the 3 s timeout has already fired, `renderApp()` has mounted `NostrLoginProvider`, whose reducer snapshotted the **blanked** state at mount and re-persists that snapshot on every subsequent dispatch (`node_modules/@nostrify/react/login/useNostrLoginReducer.ts:15-18`). The very next login-state change clobbers the restored plaintext with `nsec: ''`. Now neither store holds the key: IDB has no record (`storeNsec` failed) and localStorage has an empty string. On the next page load `loadNsec()` returns null and `createWebNsecSigner` throws for every operation (webNsecSigner.ts:30-32), permanently. The docblock at webKeyStore.ts:207-212 explicitly identifies this mount-ordering hazard but the 3 s escape hatch reopens it for the failure branch.
- **failure**: Safari private mode / a storage-pressure eviction / a quota error makes `crypto.subtle` or the IDB put fail, on a machine where IndexedDB open is slow enough to exceed 3 s. The user's session keeps working (`memNsec` was seeded at line 242) so nothing looks wrong. They close the tab. On return, the account has no key material anywhere and cannot sign — the identity is lost unless they still have their own nsec backup.
- **fix**: Two independent fixes, both cheap:

1. Reorder the sync phase so it is encrypt-then-blank, not blank-then-encrypt. Today webKeyStore.ts:250 removes the only durable copy before line 261 has produced a replacement — every failure mode in between (hung IDB, crypto error, tab killed) loses the key. Do the `storeNsec` for each captured nsec first, and blank + rewrite localStorage only for the pubkeys whose encrypted write actually succeeded. That deletes the need for the 262-275 fallback entirely and closes the hung-IDB variant the finder didn't cover.

2. Make the timeout not apply to the migration case. In main.tsx:152, only bound the race when there is nothing to migrate. Concretely, have `prepareLoginStorage` return early-synchronously with a flag (or expose a tiny `hasPlaintextLogins(storageKey)` sync probe) and use `Promise.race` with the 3 s timer only when it is false; when a legacy plaintext nsec is present, await the full promise (it is a one-time boot). Additionally bound `openDb` itself with a ~5 s timeout that rejects, so `storeNsec` can never hang forever and the false-return path is always reached.

If you keep the fallback at all, do not have it depend on the localStorage round-trip that the provider owns: hold the un-persisted nsecs in a module-scope `pendingUnpersisted` Map, retry `storeNsec` on the next successful IDB write, and surface a blocking 'your key could not be saved — copy it now' dialog. Silent success with `memNsec` only is the actual trap.

### ☐ OPEN — NIP-22 comments on URL roots use the URL scheme as the K/k value instead of NIP-73's "web"
- **area**: `nostr-protocol` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/usePostComment.ts:35`, `packages/web/src/hooks/usePostComment.ts:53`, `packages/web/src/hooks/usePostComment.ts:70`
- **detail**: NIP-73's URL row is `i` = normalized URL, `k` = the literal string `"web"`, and NIP-22's website example is `["I", "https://abc.com/articles/1"], ["K", "web"]`. The code emits the scheme:

```js
tags.push(['K', root.protocol.replace(/:$/, '')]); // NIP-73: URL kind = scheme, not hostname (H5)
```

for `https://example.com/post` this produces `["K", "https"]` / `["k", "https"]`. The inline comment shows the author corrected a hostname bug but landed on the wrong value — the spec table has exactly one legal value for URLs. Reachable via `CommentForm.tsx:28` → `usePostComment` whenever the root is a `URL`.
- **failure**: A user comments on an RSS/web item. corkboards publishes kind 1111 with `["K","https"]`. Any client aggregating web comments with `{kinds:[1111], "#K":["web"]}` (the spec-conformant filter) never sees it, and the comment is orphaned from the discussion on that URL.
- **fix**: Replace all three `root.protocol.replace(/:$/, '')` / `reply.protocol…` expressions with the constant `'web'`. If non-http external ids are ever supported, map them through a small NIP-73 table rather than deriving from the URL object.

### ☐ OPEN — Kind-7 reactions omit the NIP-25 `k` tag and the `a` tag for addressable targets; mobile also omits the relay hint
- **area**: `nostr-protocol` · **platforms**: web, mobile, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/components/NoteCard.tsx:612`, `packages/web/src/components/thread/ThreadReplyRow.tsx:90`, `packages/mobile/src/components/NoteActions.tsx:80`
- **detail**: NIP-25: "If the event being reacted to is an addressable event, an `a` SHOULD be included together with the `e` tag … The reaction event MAY include a `k` tag with the stringified kind number", and "The `e` tag SHOULD include a relay hint". Web builds:

```js
// NoteCard.tsx:612-616 and ThreadReplyRow.tsx:90-93
const relayHint = getRelayCache(note.pubkey)?.[0] || FALLBACK_RELAYS[0] || ''
const tags: string[][] = [['e', note.id, relayHint], ['p', note.pubkey]]
```

No `k`, no `a` — even though reactions are offered on kind 30023 long-form and kind 34235/34236 video cards (`isReaction` covers all feed kinds). Mobile is worse: `const tags: string[][] = [['e', event.id], ['p', event.pubkey]];` — no relay hint at all. (The relay hint web does use comes from the marker-less `getRelayCache`, so it can be a read-only relay — see the NIP-65 finding.)
- **failure**: User reacts ❤️ to a long-form article (kind 30023). The reaction carries only the `e` tag pointing at that specific revision. The author edits the article; the new revision has a different event id, so clients querying `{kinds:[7], "#a":["30023:<pk>:<d>"]}` — the standard way to count reactions on addressable events — find nothing and the reaction is lost.
- **fix**: In both web sites and mobile `NoteActions.tsx:80`, build tags as: `[['e', id, hint, targetPubkey], ['p', pubkey, hint], ['k', String(kind)]]`, plus `['a', `${kind}:${pubkey}:${dTag}`, hint]` when `NKinds.addressable(kind)`. Extract this into a shared `buildReactionTags(target, hint)` in `@core/noteClassifier` next to `buildReplyTags` so the three call sites cannot drift.

### ☐ OPEN — reqRouter's >500-author batching applies the union of all authors to every author-bearing filter
- **area**: `nostr-protocol` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/components/NostrProvider.tsx:686`
- **detail**: `extractAuthorsFromFilters` (line 554-562) collapses the authors of *all* filters into one Set. The batching loop then rewrites every author-bearing filter with slices of that union:

```js
for (let i = 0; i < authors.length; i += MAX_AUTHORS_PER_FILTER) {
  const batch = authors.slice(i, i + MAX_AUTHORS_PER_FILTER);
  for (const filter of filters) {
    if (filter.authors) batchedFilters.push({ ...filter, authors: batch });
    else if (i === 0) batchedFilters.push(filter);
  }
}
```

So a call like `nostr.query([{kinds:[1], authors:A}, {kinds:[7], authors:B}])` with `|A ∪ B| > 500` sends every relay `{kinds:[1], authors:<batch of A∪B>}` *and* `{kinds:[7], authors:<same batch>}`. Each filter also keeps its original `limit`, so the effective per-relay limit is multiplied by the number of batches. The `<= 500` path (line 684-685) is correct.
- **failure**: A user with 900 follows opens a corkboard that issues a two-filter query (notes for follows + reactions for a smaller author set). Each of the 12 feed relays receives 4 filters instead of 2, each carrying all 900 pubkeys, and returns up to 2× the intended `limit` — extra bandwidth and relay-side work for events the caller's second filter never wanted.
- **fix**: Batch per-filter rather than against the union: iterate `filters`, and for each filter with `authors.length > MAX_AUTHORS_PER_FILTER` split *its own* authors array; leave other filters untouched. Keep the union only for the tier decision at line 675.

### ☐ OPEN — Emoji-set `a`-coordinate parsing truncates d-tags containing ':' and can emit a filter with an undefined #d value
- **area**: `nostr-protocol` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useCustomEmojiSets.ts:78`
- **detail**: NIP-01 addressable coordinates are `<kind>:<pubkey>:<d-identifier>` where the d-identifier is arbitrary text and may itself contain colons. The parser splits unbounded and destructures three fields:

```js
const filters = followedSetAddresses.map(addr => {
  const [, pubkey, dTag] = addr.split(':');
  return { kinds: [30030 as number], authors: [pubkey], '#d': [dTag] };
});
```

For `30030:<pk>:my:emoji:set` this yields `dTag === 'my'`. For a malformed two-part coordinate it yields `dTag === undefined`, producing `{'#d': [undefined]}` which serializes to `["#d",[null]]` in the REQ — some relays reject the whole subscription, taking the sibling filters down with it. The addresses come from the user's kind-10030 `a` tags (line 61), so they are third-party data.
- **failure**: User favourites another author's emoji set whose `d` tag is `set:2024`. The kind-10030 `a` tag is `30030:<pk>:set:2024`; corkboards queries `#d: ['set']`, gets nothing back, and the set silently never loads in any emoji picker.
- **fix**: Parse with a bounded split: `const idx1 = addr.indexOf(':'), idx2 = addr.indexOf(':', idx1 + 1); const kind = addr.slice(0, idx1), pubkey = addr.slice(idx1 + 1, idx2), dTag = addr.slice(idx2 + 1);` and skip the entry when `idx1 < 0 || idx2 < 0` or `pubkey` isn't 64-hex. Consider a shared `parseAddressableCoordinate` in `@core` since `usePostComment`/`useComments` build the same shape.

### ☐ OPEN — NIP-10 e-tags omit the optional 5th `<pubkey>` element that the outbox model relies on
- **area**: `nostr-protocol` · **platforms**: core, web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/core/src/noteClassifier.ts:149`, `packages/core/src/noteClassifier.ts:151`, `packages/web/src/pages/MultiColumnClient.tsx:2884-2887 (consumer side: first-p-tag heuristic should prefer eTag[4])`, `packages/web/src/hooks/usePostComment.ts:32,50,67 (same defect class for NIP-22 kind 1111: emits bare ['E', root.id] and ['e', reply.id] with no relay hint and no pubkey, while NIP-22 defines ["E", id, relay-hint, root pubkey] / ["e", id, relay-hint, parent pubkey])`, `packages/mobile/src/hooks/usePostComment.ts:53,69 (identical NIP-22 omission on mobile)`
- **detail**: NIP-10 defines `["e", <event-id>, <relay-url>, <marker>, <pubkey>]` and states: "`<pubkey>` SHOULD be the pubkey of the author of the `e` tagged event, this is used in the outbox model to search for that event from the authors write relays where relay hints did not resolve the event." `buildReplyTags` stops at the marker:

```js
tags.push(['e', rootId, rootTag?.[2] || '', 'root']);
tags.push(['e', replyTo.id, replyRelayHint, replyTo.id === rootId ? 'root' : 'reply']);
```

This app is itself a consumer of that field — `fetchEventWithOutbox(id, nostr, {hints, authorPubkey})` (fetchEvent.ts:219-232) does exactly the author-relay discovery NIP-10 describes, and `NoteCard.tsx` currently has to guess `authorPubkey` from the reply's `p` tags (`repostHints`/`reactionHints`), which is only correct by accident.
- **failure**: A corkboards reply is opened in a thread by another client (or by corkboards itself after cache eviction). The relay hint has gone stale, and because the e-tag has no author pubkey there is nothing to drive outbox discovery — the parent renders as "note couldn't be loaded" even though it is sitting on the author's write relay.
- **fix**: In packages/core/src/noteClassifier.ts buildReplyTags: emit `['e', replyTo.id, replyRelayHint, replyTo.id === rootId ? 'root' : 'reply', replyTo.pubkey]`, and for the forwarded root tag use `['e', rootId, rootTag?.[2] || '', 'root', rootTag?.[4] || '']` (only forward a 5th element that is a valid 64-hex pubkey; never invent one from p-tags, since NIP-10 says p-tag order is unspecified). Note the two existing parity tests assert exact e-tag arrays and will need updating: packages/web/src/lib/buildReplyTags.test.ts:24,45,81 and packages/mobile/src/__tests__/core-parity.test.ts:128. On the consumer side, change packages/web/src/pages/MultiColumnClient.tsx:2884-2887 to prefer `replyETag[4]` when it is valid hex and fall back to the first p-tag only when absent (mobile has useParentNotes but no caller wiring it today, so nothing to change there yet).

### ☐ OPEN — Replaceable-event selection across relays lacks the NIP-01 lowest-id tie-break used elsewhere in the codebase
- **area**: `nostr-protocol` · **platforms**: web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useMuteList.ts:30`, `packages/web/src/hooks/useMuteList.ts:64`, `packages/web/src/hooks/useFollowSets.ts:42`, `packages/web/src/hooks/usePinnedNotes.ts:88`, `packages/web/src/hooks/useCustomEmojiSets.ts:99`, `packages/mobile/src/hooks/useMuteList.ts:30,64,66 (identical publish-base defect on mobile)`
- **detail**: `contactList.ts:59-62` and `feedAlgorithms.ts:49` both implement NIP-01's rule for replaceable events explicitly — newest `created_at` wins, and on a tie the lowest `id` wins — with a comment explaining exactly why ("Two kind-3s can share a timestamp when the user … edits from two devices; picking the 'wrong' one here means the NEXT publish is built from a stale base"). The list hooks use a bare `>` and therefore let relay response order decide ties:

```js
events.reduce((best, e) => (e.created_at > best.created_at ? e : best))   // useMuteList.ts:30, :64
if (!existing || ev.created_at > existing.created_at) byDTag.set(dTag, ev) // useFollowSets.ts:42, useCustomEmojiSets.ts:99
if (!best || ev.created_at > best.created_at) best = ev                    // usePinnedNotes.ts:88
```

The mute-list case matters most because `resolveMuteBase` feeds the chosen event straight into the next publish (useMuteList.ts:72-74 → `publishMuteList`), so a wrong tie-break silently discards whatever the other same-second revision added — the same data-loss shape the kind-3 helper was written to prevent.
- **failure**: User mutes two accounts in quick succession from two devices; both kind-10000 revisions land with the same `created_at`. Relay A returns revision X first, so `resolveMuteBase` picks X. The next unmute republishes from X's tags, dropping the pubkey that only revision Y contained — the account silently un-mutes itself.
- **fix**: Export one comparator from @core/feedAlgorithms next to replaceableCoordinate, e.g. `export function newerReplaceable(a: NostrEvent, b: NostrEvent) { if (a.created_at !== b.created_at) return a.created_at > b.created_at ? a : b; return a.id < b.id ? a : b; }`, refactor contactList.ts:59-62 and feedAlgorithms.ts:49 to use it (so there is one definition, not three), then apply it at all the sites below. Also fix the related asymmetry at useMuteList.ts:66 / mobile useMuteList.ts:66, where `newest.created_at >= authoritative.created_at` prefers the relay copy over the cached one on an exact tie without any id comparison — route that through the same comparator.

### ☐ OPEN — Header top padding is hardcoded to 60px across six screens while react-native-safe-area-context is installed and unused, with Android edge-to-edge enabled
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/screens/HomeScreen.tsx:678`, `packages/mobile/src/screens/DiscoverScreen.tsx:512`, `packages/mobile/src/screens/DiscoverScreen.tsx:366`, `packages/mobile/src/screens/SavedScreen.tsx:261`, `packages/mobile/src/screens/NotificationsScreen.tsx:265`, `packages/mobile/src/screens/ThreadScreen.tsx:346`
- **detail**: `react-native-safe-area-context@^5.7.0` is a declared dependency (package.json), but a repo-wide grep for `SafeArea`, `useSafeAreaInsets`, `SafeAreaView` or `StatusBar.currentHeight` across `packages/mobile/src` and `App.tsx` returns **zero** hits. (`@react-navigation/bottom-tabs` internally wraps in `SafeAreaProviderCompat` — BottomTabView.js:163 — so the context IS available; nothing consumes it.)

Instead each screen hardcodes a different magic number for the top inset:
- HomeScreen / DiscoverScreen / SavedScreen / NotificationsScreen / ThreadScreen / SettingsScreen: `paddingTop: 60`
- ComposeScreen: `paddingTop: 56`
- ProfileScreen back button: `top: 52` (absolute)
- EmojiSetsModalProvider: `paddingTop: 56`; AddAccountModal: `paddingTop: 60`; WelcomePage: `paddingTop: 80`

Meanwhile `app.json:30` sets `"edgeToEdgeEnabled": true`, so on Android 15+ content is drawn behind the status bar and the real inset must come from the system, and `App.tsx:79` uses `<StatusBar style="light" />` (translucent by default under edge-to-edge).

Real top insets range from 20pt (iPhone SE / iPad) through 44-47pt (notch) to 59pt (Dynamic Island), and on Android from 24dp to 48dp+ on punch-hole devices.
- **failure**: On an iPad or iPhone SE (20pt inset) every screen shows a 40px dead gap above the header. On a Pixel with a tall status bar under edge-to-edge, or on an Android device with a display cutout in landscape, the 60px constant is too small and the corkboards logo / "Notifications" title is clipped by the system bar. Nothing bottom-inset-aware exists either, so `paddingBottom: 80` on the feed lists (HomeScreen.tsx:727) is a guess at the tab bar + gesture bar height.
- **fix**: Wrap the tree in `<SafeAreaProvider>` in packages/mobile/App.tsx (it must be above NavigationContainer), then replace each hardcoded top constant with an inset-derived override at the usage site, since these live in StyleSheet.create objects: `const insets = useSafeAreaInsets()` and `style={[styles.header, { paddingTop: insets.top + 8 }]}`. Pick one shared design spacing value so the six screens stop disagreeing (60 vs 56 vs 52 vs 80). For list bottoms use `insets.bottom + useBottomTabBarHeight()` instead of the flat 80 at HomeScreen.tsx:727. Do not add `SafeAreaView` — with edge-to-edge on Android it does not cover the Android case; use the hook.

### ☐ OPEN — Media widths are captured from Dimensions.get('window') at module scope and never recompute on rotation, split-screen or fold
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/components/NoteContent.tsx:32`, `packages/mobile/src/components/NoteContent.tsx:763`, `packages/mobile/src/components/MediaLink.tsx:26`, `packages/mobile/src/components/MediaLink.tsx:477`, `packages/mobile/src/components/MediaLink.tsx:517`, `packages/mobile/src/components/ProfileCard.tsx:46`
- **detail**: Both media renderers freeze the screen width at module-evaluation time:
```ts
const { width: SCREEN_WIDTH } = Dimensions.get('window');   // NoteContent.tsx:32, MediaLink.tsx:26
const MEDIA_WIDTH = SCREEN_WIDTH - 56;
```
and bake it into `StyleSheet.create` values that can never change: `mediaImage: { width: MEDIA_WIDTH, height: MEDIA_WIDTH * 0.56 }` (NoteContent.tsx:763), `videoPlayer: { width: MEDIA_WIDTH, height: Math.round(MEDIA_WIDTH * 9 / 16) }` (MediaLink.tsx:517), `videoContainer`, `blurPlaceholder`.

`ProfileCard.tsx:46` has a milder variant — `Dimensions.get('window').width - 24` read during render, so it recomputes on re-render but not reactively on a dimension change.

`app.json` locks `"orientation": "portrait"` but also sets `"supportsTablet": true` for iOS (iPad ignores the portrait lock for multitasking/Slide Over) and `"edgeToEdgeEnabled": true` on Android (split-screen and foldables resize the window without any orientation change). RN's supported API for this is `useWindowDimensions()`.
- **failure**: An Android user enters split-screen and drags the divider, halving the app window from 411dp to ~205dp. Every inline image, video player and blur placeholder keeps its 355px width, so all media overflows the card horizontally and is clipped. Same on an unfolding foldable (narrow→wide: media stays narrow with a large empty gutter) and on iPad Slide Over.
- **fix**: Swap the module constants for `const { width } = useWindowDimensions();` inside the components that render media — NoteContent, its InlineImage/InlineVideo children, and MediaLink/InlineVideo — deriving `const mediaWidth = width - 56;` and applying it as an inline override on top of the static entry: `style={[styles.mediaImage, { width: mediaWidth, height: mediaWidth * 0.56 }]}`, `style={[styles.videoPlayer, { width: mediaWidth, height: Math.round(mediaWidth * 9 / 16) }]}`, and likewise for videoContainer/videoPlaceholder/videoErrorBox. Do NOT hoist the hook into a shared module constant — that reintroduces the freeze. ProfileCard.tsx:46 and EditProfileForm.tsx:150 only need the `Dimensions.get` swapped for `useWindowDimensions()` since they already compute during render. For the emoji grids, derive CELL_SIZE from the hook inside the component so the grid reflows instead of leaving a dead column.

### ☐ OPEN — Two sizeable cache modules are entirely unreferenced dead code, and getAllCustomFeedIds() can never return anything
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/lib/notesCache.ts:100`, `packages/mobile/src/hooks/useFollowNotesCache.ts:93`, `packages/mobile/src/hooks/useCustomFeedNotesCache.ts:153`, `packages/mobile/src/hooks/useCustomFeedNotesCache.ts:165`, `packages/mobile/src/storage/MmkvStorage.ts:223 (async keys() never awaits mobileStorage.ready, so every module-eval-time consumer reads the legacy unencrypted handle — same root cause, affects the live useCustomFeedNotesCache.ts:189 prune IIFE too)`, `packages/mobile/src/hooks/useCustomFeedNotesCache.ts:187-209 (live prune duplicates the key scan that getAllCustomFeedIds was supposed to provide; web/src/hooks/useCustomFeedNotesCache.ts:413-429 does it via the shared helper and additionally takes a per-feed lock with withKeyedLock, which mobile omits entirely)`
- **detail**: A repo-wide grep for `notesCache` and `useFollowNotesCache` across `packages/mobile/src` + `App.tsx` finds no importers of either module — the only matches are their own `console.log('[notesCache] …')` tags. So `src/lib/notesCache.ts` (305 lines, ported from web) and `src/hooks/useFollowNotesCache.ts` (307 lines, ported from web) are both dead.

That matters beyond dead weight: `notesCache.ts:100` kicks off `loadNotesFromStorage()` at module import, which would `await mobileStorage.keys()` and then `JSON.parse` up to `MAX_CACHED_NOTES = 3000` entries synchronously on the JS thread — and it would do so against the pre-encryption legacy MMKV instance (same race as the relay-cache finding above). If anyone ever imports it, they inherit a TTI stall plus a silently-empty cache.

Separately, `useCustomFeedNotesCache.ts:165-175` is a stub that always returns `[]`:
```ts
function getAllKeysSync(): string[] {
  try {
    // … for startup pruning we just skip it (lazy cleanup on next async call)
    return [];
  } catch { return []; }
}
```
so its only consumer `getAllCustomFeedIds()` (line 153) unconditionally returns an empty array. (It currently has no call sites, so this is latent too.)
- **failure**: A developer wires up `useFollowNotesCache` for offline-first follows (it looks complete and mirrors the web hook) and simultaneously pulls in `src/lib/notesCache.ts`. The import-time `loadNotesFromStorage()` reads the legacy MMKV handle, gets zero keys, logs "Loaded 0 cached notes", and the offline cache silently never works — with a 3000-entry JSON.parse stall waiting to appear once the storage race is fixed.
- **fix**: Pick one direction and make it explicit, because leaving these half-ported violates the cross-platform-parity rule either way. (a) If mobile has genuinely superseded them with the corkboard/custom-feed caches, delete `packages/mobile/src/lib/notesCache.ts` and `packages/mobile/src/hooks/useFollowNotesCache.ts`, and delete the orphaned `getAllCustomFeedIds` + `getAllKeysSync` at `useCustomFeedNotesCache.ts:153-175`. (b) If they are meant to be wired up for offline-first follows (matching web's `MultiColumnClient.tsx:19`), first fix the module-eval storage race — do not call `loadNotesFromStorage()` at import; gate it on `await mobileStorage.ready` (or better, make `MmkvStorage.ts:223` `keys()` await `_prepareDone` so every async KVStorage consumer is race-free) — and chunk the 3000-entry parse loop across frames. Do NOT implement `getAllKeysSync` via a second synchronous MMKV handle; the async `mobileStorage.keys()` already works and the sync path would reopen the legacy instance.

### ☐ OPEN — ProfileCard and ProfileModal use the deprecated core Clipboard while the rest of the app uses expo-clipboard; the copy-confirmation timer is never cleaned up
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/components/ProfileCard.tsx:13`, `packages/mobile/src/components/ProfileCard.tsx:76`, `packages/mobile/src/components/ProfileCard.tsx:78`, `packages/mobile/src/components/ProfileModal.tsx:16`, `packages/mobile/src/components/ProfileModal.tsx:168`
- **detail**: `expo-clipboard` is a declared dependency and is used by 6 files (`SignupFlow.tsx:16`, `TrackerWarningDialog.tsx:18`, `AddAccountModal.tsx:20`, `WelcomePage.tsx:19`, `ProfileScreen.tsx:16`). Two files instead import the deprecated core module:
```ts
import { ..., Clipboard } from 'react-native';   // ProfileCard.tsx:13, ProfileModal.tsx:16
Clipboard.setString(npub);                        // ProfileCard.tsx:76, ProfileModal.tsx:168
```
RN 0.81's `index.js:180-187` still exposes it but behind a runtime deprecation warning: "Clipboard has been extracted from react-native core and will be removed in a future release." It disappears on the next RN major.

Additionally `copyNpub` (ProfileCard.tsx:75-79) schedules `setTimeout(() => setCopied(false), 2000)` with no cleanup, so tapping the npub and immediately dismissing the profile fires a setState on an unmounted component.
- **failure**: On every app start where a ProfileCard renders, a yellow deprecation warning is emitted; after the next React Native upgrade `Clipboard` is `undefined` and tapping the npub throws `TypeError: Cannot read property 'setString' of undefined`. Separately, tapping the npub and closing the profile within 2 s produces a React state-update-on-unmounted-component warning.
- **fix**: In both files drop `Clipboard` from the `react-native` destructured import and add `import * as Clipboard from 'expo-clipboard'`, then make the handlers async and `await Clipboard.setStringAsync(npub)` — mirroring `src/screens/ProfileScreen.tsx:137`, which already copies an npub exactly this way. For the timer, hold the id in a `useRef<ReturnType<typeof setTimeout> | null>(null)`, `clearTimeout` the previous one at the top of `copyNpub` (fixes the double-tap race), and clear it in a `useEffect(() => () => clearTimeout(ref.current), [])`. Note ProfileModal's `copyNpub` (line 167) is a plain function, not `useCallback`, unlike ProfileCard's (line 75) — worth unifying while touching both.

### ☐ OPEN — Notifications and Saved pull-to-refresh spinners are hardcoded to refreshing={false}, and their FlatLists skip the windowing tuning the other feeds use
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/screens/NotificationsScreen.tsx:228`, `packages/mobile/src/screens/SavedScreen.tsx:235`, `packages/mobile/src/screens/NotificationsScreen.tsx:219`, `packages/mobile/src/screens/ProfileScreen.tsx:380`
- **detail**: Both screens wire a `RefreshControl` with a literal `refreshing={false}`:
```tsx
<RefreshControl refreshing={false} onRefresh={loadNewer} tintColor="#b3b3b3" />   // NotificationsScreen.tsx:226-231
<RefreshControl refreshing={false} onRefresh={refetch}  tintColor="#b3b3b3" />   // SavedScreen.tsx:234-238
```
The spinner snaps back immediately on release and never indicates that work is in flight — even though NotificationsScreen already computes the real state one screen up (`isFetchingNotifs`, line 109) and SavedScreen has `eventsLoading` from its own query (line 52).

Separately, NotificationsScreen's FlatList (line 219) and ProfileScreen's FlatList (line 380) omit `removeClippedSubviews` / `initialNumToRender` / `maxToRenderPerBatch` / `windowSize`, which HomeScreen, DiscoverScreen, SavedScreen and FeedGrid all set. Given NotificationCard's per-mount cost (see the useCollapsedNotes finding), the notifications list is the one that most needs `initialNumToRender` lowered.
- **failure**: User pulls to refresh on the Activity tab. The spinner disappears instantly while `loadNewer()` is still querying relays, so the user assumes nothing happened and pulls repeatedly, stacking concurrent relay queries. Meanwhile the untuned list renders its default 10-item batch of expensive NotificationCards with no `removeClippedSubviews`, keeping every scrolled-past card's native views alive.
- **fix**: NotificationsScreen.tsx:228 — do NOT simply reuse `loadingMore` (isFetchingNotifs && !isLoading), because that flag is already driving the footer 'Load more' spinner (line 245) and would make the pull-to-refresh spinner also spin when the user taps Load more. Return `isRefetching` and `isFetchingNextPage` from useNotifications (both are available on the useInfiniteQuery result at useNotifications.ts:154) and use `refreshing={isRefetching && !isFetchingNextPage}`. While there, compose the react-query signal into the relay query at useNotifications.ts:167 — `{ signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) }` with `queryFn: async ({ pageParam, signal })` — so repeated pulls cancel the previous relay round-trip instead of stacking (SavedScreen.tsx:74 already does this).

SavedScreen.tsx:235 — the finder's `eventsLoading && sortedEvents.length > 0` never fires (isLoading is false whenever cached data exists). Destructure `isFetching: eventsFetching` at line 52 and use `refreshing={eventsFetching && !eventsLoading}`, matching HomeScreen.tsx:598.

NotificationsScreen.tsx:219 — add `removeClippedSubviews={true}`, `initialNumToRender={6}`, `maxToRenderPerBatch={10}`, `windowSize={10}`, `updateCellsBatchingPeriod={50}` to match HomeScreen/FeedGrid, and hoist the inline renderItem at lines 222-224 into a `useCallback`. Also add `initialNumToRender`/`windowSize`/`updateCellsBatchingPeriod` to SavedScreen.tsx:231-232, which currently sets only two of the five.

ProfileScreen.tsx:380 — low value given `limit: 20` (ProfileScreen.tsx:50); apply the same props only for consistency, and hoist the inline renderItem at 384-398 into a `useCallback`. The more meaningful gap on that screen is that it has no RefreshControl at all.

### ☐ OPEN — useLocalStorage tears down and re-adds its window listener on every render because `defaultValue` is an unstable array literal
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useLocalStorage.ts:89`, `packages/web/src/hooks/useLocalStorage.ts:100`, `packages/web/src/hooks/useCollapsedNotes.ts:90`, `packages/web/src/pages/MultiColumnClient.tsx:1130`, `packages/mobile/src/hooks/useLocalStorage.ts:80`, `packages/web/src/pages/MultiColumnClient.tsx:1110`
- **detail**: The cross-tab sync effect depends on `defaultValue`:
```ts
useEffect(() => {
  const ac = new AbortController();
  const handleSync = ...;
  window.addEventListener('idb-storage-sync', handleSync as EventListener, { signal: ac.signal });
  return () => ac.abort();
}, [key, defaultValue]);   // useLocalStorage.ts:100
```
Every caller that passes an object/array default gives a brand-new reference each render, so the effect cleanup+setup runs on every render. Confirmed callers: `useCollapsedNotes.ts:90/91/95` (`[]` × 3, and that hook runs once per NoteCard), `SavedForLaterCorkboard.tsx:51`, `MultiColumnClient.tsx:1113/1116/1130` (`nostr-custom-feeds`, `nostr-browse-relays`, `nostr-rss-feeds`).
- **failure**: With 600 mounted NoteCards, each `MultiColumnClient`/FeedGrid render that reaches the cards performs 1,800 `AbortController` allocations + 1,800 `removeEventListener`/`addEventListener` pairs on `window`. Under React StrictMode in dev this doubles. Listener registration on `window` is O(listeners) in some engines, so the churn is superlinear as the card count grows.
- **fix**: Read the default through a ref and drop it from the deps: `const defaultRef = useRef(defaultValue); defaultRef.current = defaultValue;` then use `defaultRef.current` at line 93 and close the effect with `}, [key])`. The mobile hook has the SAME defect plus one more: `packages/mobile/src/hooks/useLocalStorage.ts:80` closes with `}, [key, defaultValue, deserialize])`, and `deserialize` (line 25, `serializer?.deserialize ?? JSON.parse`) is also a fresh reference on every render for any caller that passes an inline `serializer` object — apply the same ref treatment to both.

### ☐ OPEN — FeedGrid calls hashtagFeedVerdict up to 3× per note per hashtag per render, each doing a regex matchAll and a JSON.parse for reposts
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/FeedGrid.tsx:437`, `packages/web/src/components/FeedGrid.tsx:444`, `packages/core/src/noteCategories.ts:248`, `packages/mobile/src/screens/HomeScreen.tsx:458-463 — identical three-call pattern (`!some(=== 'match') && some(=== 'tagged-only')` then `find(=== 'tagged-only')`) inside the FlatList `renderNote` useCallback; lower impact because FlatList windows to visible rows, but the same one-pass fix applies`
- **detail**: Inside the per-note map at FeedGrid.tsx:429-470:
```tsx
const hashtagTaggedOnly = !!activeHashtags && activeHashtags.length > 0
  && !activeHashtags.some(tag => hashtagFeedVerdict(note, tag) === 'match')       // pass 1
  && activeHashtags.some(tag => hashtagFeedVerdict(note, tag) === 'tagged-only'); // pass 2
...
hashtagTaggedLabel={hashtagTaggedOnly ? activeHashtags.find(tag => hashtagFeedVerdict(note, tag) === 'tagged-only') : undefined}  // pass 3
```
`hashtagFeedVerdict` (noteCategories.ts:248-284) does, per call: a `JSON.parse(note.content)` for kind 6/16, a `content.matchAll(/#([a-zA-Z]\w*)/g)` scan of the whole note body, a linear scan of `note.tags`, and for reposts a `getRepostHashtags(note)` call. Nothing is memoized, and because FeedGrid's `React.memo` is defeated (see the inline-arrow finding) this runs on every parent render.
- **failure**: A hashtag corkboard with 2 active hashtags showing 3 columns × 200 notes = 600 notes. Each parent render performs up to 600 × 2 × 3 = 3,600 `hashtagFeedVerdict` calls, including up to 3,600 `JSON.parse` calls over full repost payloads and 3,600 full-content regex scans. With autofetch on, that fires at least every 120 s and on every dismiss.
- **fix**: Compute both the flag and the label in one pass, hoisted above the JSX: `const hashtagFlags = useMemo(() => { const m = new Map<string, string | undefined>(); if (!activeHashtags?.length) return m; for (const col of visibleColumns) for (const n of col) { let matched = false, taggedTag: string | undefined; for (const tag of activeHashtags) { const v = hashtagFeedVerdict(n, tag); if (v === 'match') { matched = true; break; } if (v === 'tagged-only' && !taggedTag) taggedTag = tag; } if (!matched && taggedTag) m.set(n.id, taggedTag); } return m; }, [visibleColumns, activeHashtags]);` then in the loop `const taggedLabel = hashtagFlags.get(note.id);` and pass `hashtagTaggedOnly={!!taggedLabel} hashtagTaggedLabel={taggedLabel}`. That is one verdict call per (note, tag) instead of two or three, and it survives the defeated React.memo because the memo is keyed on the sliced columns. Separately, memoizing the inline arrow props at MultiColumnClient.tsx:4433-4441 with useCallback restores the React.memo skip and eliminates the repeat entirely.

### ☐ OPEN — pinnedNoteIds.includes(note.id) runs O(notes × pins) inside the FeedGrid render loop
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/FeedGrid.tsx:446`, `packages/web/src/components/SavedForLaterCorkboard.tsx:124`, `packages/web/src/components/SavedForLaterCorkboard.tsx:125`, `packages/web/src/components/SavedForLaterCorkboard.tsx:244`, `packages/web/src/pages/MultiColumnClient.tsx:2000`, `packages/mobile/src/screens/SavedSreen.tsx — see corrected path below`
- **detail**: `FeedGrid.tsx:446` uses the raw array: `isPinned={pinnedNoteIds.includes(note.id)}`. The Stage-2 filter memo in `MultiColumnClient.tsx:3102-3107` already carries a comment explaining exactly why the Set must be used there ("Use the Set (O(1)) not pinnedIds.includes (O(n))") and `pinnedIdSet` exists at :2000 — but the Set is never passed to FeedGrid, which still gets `pinnedNoteIds={pinnedIds}` (:4415).

`SavedForLaterCorkboard` has three more instances (:124, :125, :244), two of which are back-to-back full-array filters.
- **failure**: A user who has pinned 300 notes, viewing 600 rendered notes: 180,000 string comparisons per FeedGrid render, repeated on every parent render (which, per the memo finding above, is every autofetch tick and every dismiss). SavedForLaterCorkboard with 400 saved notes and 300 pins is 240,000 comparisons on each of its renders.
- **fix**: Add `pinnedNoteIdSet: ReadonlySet<string>` to FeedGridProps (FeedGrid.tsx:71), pass the already-existing `pinnedIdSet` from MultiColumnClient.tsx:4415, and use `pinnedNoteIdSet.has(note.id)` at :446 — keep or drop the array prop depending on whether anything else needs order. In SavedForLaterCorkboard, add `const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);` and replace :124-125 with a single partition loop (`for (const n of notes) (pinnedSet.has(n.id) ? pinned : regular).push(n);`) plus `pinnedSet.has(note.id)` at :244.

### ☐ OPEN — profileCache.getCachedProfiles opens one IndexedDB transaction per pubkey
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/lib/profileCache.ts:112`, `packages/web/src/lib/profileCache.ts:49`, `packages/web/src/lib/idb.ts:121`, `packages/web/src/lib/cacheStore.ts:186`, `packages/web/src/lib/profileCache.ts:134`, `packages/web/src/lib/profileCache.ts:102`
- **detail**: ```ts
export async function getCachedProfiles(pubkeys: string[]): Promise<Map<string, CachedProfile>> {
  const profiles = await Promise.all(
    pubkeys.map(async (pubkey) => {
      const profile = await getCachedProfile(pubkey);   // :118
      return { pubkey, profile };
    })
  );
```
Each `getCachedProfile` (:49) calls `idbGet`, which does `const database = await getDb(); tx(database, 'readonly').get(key)` (idb.ts:121-127) — a *new transaction per key*, plus a `JSON.parse` per key.

The sibling cache does this correctly with one transaction: `cacheStore.ts:186-189` opens a single `db.transaction('profiles','readonly')` and issues `Promise.all(uncachedPubkeys.map(pk => store.get(pk)))` on it. The two files also duplicate the same profile data in two different databases (`corkboard`/kv vs `corkboard-cache`/profiles).
- **failure**: The follows-list query in `MultiColumnClient.tsx:1617-1690` calls `getCachedProfiles(authorBatch)`. For a user following 2,000 npubs, that is 2,000 separate IndexedDB readonly transactions plus 2,000 `JSON.parse` calls, serialized through the IDB task queue — hundreds of ms of jank while the follows picker opens.
- **fix**: Short term: rewrite profileCache.getCachedProfiles to open one readonly transaction over the kv store and `Promise.all(pubkeys.map(pk => store.get(getProfileCacheKey(pk))))` (mirroring cacheStore.ts:184-190), do the same for setCachedProfiles with a single readwrite transaction, and have `getProfilesNeedingRefresh` accept the already-fetched Map instead of re-reading (MultiColumnClient.tsx:1626-1627 currently pays for the same read twice). Also fold `markProfileRefreshed` into the setCachedProfiles write so it isn't a second read+write per event. Correct end state: delete profileCache.ts entirely and route MultiColumnClient's follows query through cacheStore.ts, which already batches, has a 200-entry mem cache (cacheStore.ts:53), and is what useAuthor/useBulkAuthors use — that also removes the third redundant on-disk copy of every profile and shrinks the kv store that feeds the memCache problem in the idb finding.

### ☐ OPEN — StatusBar schedules an unbounded number of hide-timers from an unthrottled document mousemove handler
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/StatusBar.tsx:121`, `packages/web/src/components/StatusBar.tsx:137`, `packages/web/src/components/StatusBar.tsx:153`
- **detail**: ```ts
} else if (!isNearBottom && isVisible && !isSticky) {
  // Hide after 1 second of not being near bottom (unless sticky)
  hoverTimeoutRef.current = setTimeout(() => {   // :139 — overwrites the ref WITHOUT clearing the old timer
    setIsVisible(false);
  }, 1000);
}
```
The previous timer is never cleared before the ref is reassigned, so each qualifying `mousemove` leaves an orphaned 1 s timer running. Only the last one is cleared on unmount (:150). The handler itself is attached to `document` with no throttle/rAF gate (:145), and the effect's dep list `[isVisible, isSticky]` (:153) means the listener is removed and re-added on every visibility toggle.
- **failure**: User moves the mouse across the page while the status bar is visible and not sticky. At ~120 mousemove events/second, ~120 orphaned `setTimeout`s accumulate in the 1 s window before the first fires; each then invokes `setIsVisible(false)`. React bails on the repeats, but the timers, closures, and handler work are pure waste — and the pattern grows linearly with pointer activity.
- **fix**: In the `!isNearBottom && isVisible && !isSticky` branch, clear first: `if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current); hoverTimeoutRef.current = setTimeout(() => setIsVisible(false), 1000);`. That single change removes the accumulation. Optionally also read isVisible/isSticky through refs so the effect deps can drop to `[]` and the document listener is attached exactly once instead of on every visibility toggle; a throttle is not needed once the timer is cleared, since the handler body is two property reads and a comparison.

### ☐ OPEN — Feed images render with no intrinsic dimensions and no decoding=async, so every load reflows the whole masonry column
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/MediaLink.tsx:526`, `packages/web/src/components/MediaLink.tsx:530`, `packages/core/src/blossom.ts:129`, `packages/web/src/components/NoteContent.tsx:51`, `packages/web/src/components/SizeGuardedImage.tsx:188 (the shared <img>; the real fix site for decoding="async")`, `packages/mobile/src/components/MediaLink.tsx:343-346 + styles.mediaImage at :477-479 — mobile DOES reserve space but with a hardcoded `height: MEDIA_WIDTH * 0.56`, so every non-16:9 image is letterboxed/cropped; a parsed `dim` would fix that too and is the parity payoff for touching core/blossom.ts`
- **detail**: The feed image is rendered as:
```tsx
<SizeGuardedImage
  key={currentImageUrl}
  src={optimizeMediaUrl(currentImageUrl, true)}
  alt=""
  className="max-w-full max-h-[500px] rounded-lg object-contain hover:opacity-90 transition-opacity"
  loading="lazy"          // MediaLink.tsx:530 — the only perf hint present
```
No `width`/`height`, no `aspect-ratio`, no `decoding="async"`. The same holds for `MarkdownImg` (NoteContent.tsx:51). NIP-92 carries the answer — the `dim` field — but `ImetaData` (blossom.ts:129-140) only extracts `url`, `sha256` (`x`), `mime` (`m`), `image`, and `fallbacks`; `dim` is never parsed, so the dimensions are discarded even when the author supplied them.
- **failure**: A 3-column feed where 40 of 600 visible cards contain images. Each image that finishes loading changes its card's height from ~0 to up to 500 px, forcing a re-layout of every card below it in that column and shifting the user's reading position. With `loading="lazy"` this keeps happening as the user scrolls, producing continuous cumulative layout shift rather than a one-time settle.
- **fix**: Fix in one place first: add `decoding="async"` to the `<img>` at packages/web/src/components/SizeGuardedImage.tsx:188 — that covers MediaLink.tsx:525 and NoteContent.tsx:51 together, and matches ui/avatar.tsx:150. For the reserved box: add `dim?: { w: number; h: number }` to `ImetaData` (packages/core/src/blossom.ts:128) and parse `entry.startsWith('dim ')` as `WxH` in `parseImetaTag` (guard with `/^\d{1,5}x\d{1,5}$/` so a malformed tag can't produce NaN/absurd aspect ratios). `getImetaData` (packages/web/src/components/NoteContent.tsx:182-212) already builds `imetaMeta: Map<string, ImetaData>` keyed by url and threads it to MediaLink, so the dim rides along for free — key the lookup by `canonicalMediaUrl(url)` since MediaLink is handed the possibly-proxied/canonicalized URL. Set `width`/`height` attributes plus `style={{ aspectRatio: w/h }}`; also apply the same aspect-ratio to the `status === 'checking'` placeholder div (SizeGuardedImage.tsx:148-152) or the jump just moves earlier. Neutral fallback when `dim` is absent is fine, but do not hardcode 4/3 on the loaded `<img>` — only on the placeholder — or correctly-sized images get letterboxed.

### ☐ OPEN — SmartNoteContent re-runs DOMPurify and four content regexes per render and hands NoteContent a new event object, busting its imeta memo
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/SmartNoteContent.tsx:143`, `packages/web/src/components/SmartNoteContent.tsx:168`, `packages/web/src/components/SmartNoteContent.tsx:193`, `packages/web/src/components/SmartNoteContent.tsx:212`, `packages/web/src/components/NoteContent.tsx:268`, `packages/mobile/src/components/SmartNoteContent.tsx:56 — mobile memoizes the derived values but is likewise not wrapped in React.memo, so apply that half there for parity`
- **detail**: `SmartNoteContent` is not memoized and computes everything inline on each render:
```ts
const visLen = visibleLength(text);                                    // :143
const hasImeta = event.tags.some(t => t[0] === 'imeta');               // :168
const hasMedia = hasImeta || /https?:\/\/\S+\.(jpg|...)/i.test(text)
  || /https?:\/\/[^\s]*(nostr\.build|blossom\.|...)/i.test(text);      // :169-170
const hasNostrRefs = /(nostr:)?(note1|npub1|...)[a-zA-Z0-9]+/.test(text);  // :171
const hasHtml = hasHtmlContent(text);                                  // :193
const safeEvent = hasHtml ? { ...event, content: sanitizeHtml(text) } : event;   // :194
const canToggleMarkdown = globalRenderMarkdown && contentHasAssumedMarkdown(safeEvent.content);  // :212
```
`sanitizeHtml` is `DOMPurify.sanitize(html, {ALLOWED_TAGS: [], KEEP_CONTENT: true})` (lib/sanitize.ts:28) — a full DOM parse. Worse, `safeEvent` is a fresh object each render, and `NoteContent` memoizes imeta parsing on the object identity: `useMemo(() => getImetaData(event), [event])` (NoteContent.tsx:268). So for any HTML-bearing note, `getImetaData` (a full tag scan + `parseImetaTag` + canonical-URL dedupe) recomputes every render even though the tags never changed.

Each instance also calls `useLocalStorage<boolean>('corkboard:render-markdown', true)` (:69), adding another `idb-storage-sync` window listener per note body (and NoteCard renders SmartNoteContent up to 2-3 times for reply/repost/reaction layouts).
- **failure**: A feed of long-form (kind 30023) notes that contain HTML: every re-render of a card runs DOMPurify over the full article body plus four regex scans plus a fresh imeta parse. When the card re-renders for an unrelated reason (a dismiss elsewhere, per the useCollapsedNotes finding), all of that repeats for every mounted card at once.
- **fix**: Two factual corrections to the finding before fixing: (a) `NoteCard` does NOT render SmartNoteContent 2-3 times per card — packages/web/src/components/NoteCard.tsx:1457 / :1497 / :1500 are mutually exclusive branches of one ternary chain (contentWarning / floated-avatar original / default), so it is one per card body, plus one more only when an embedded or quoted note renders via NoteCard.tsx:187; (b) the DOMPurify cost only applies to notes where `hasHtmlContent(text)` is true, not to the whole feed. The fix: mirror packages/mobile/src/components/SmartNoteContent.tsx:66-75 exactly — `const visLen = useMemo(() => visibleLength(text), [text])` and `const safeEvent = useMemo(() => hasHtmlContent(text) ? { ...event, content: sanitizeHtml(text) } : event, [event, text])`, plus a `useMemo` for the hasMedia/hasNostrRefs regex block keyed on `[text, event.tags]`. Note the hooks must be hoisted ABOVE the kind-1063/1068/30311/30402 early returns at :74-140 or you break the rules of hooks — mobile's comment at :66-67 flags precisely this. Then wrap the export in `React.memo`. Do NOT change NoteContent.tsx:268's dep to `[event.tags]` as 'belt-and-braces': `event.tags` is a fresh array whenever the caller spreads the event, so it is not more stable than `[event]` — stabilising `safeEvent` is the actual fix. Lifting `corkboard:render-markdown` to a provider is a separate, optional cleanup.

### ☐ OPEN — Custom-feed cache does JSON.parse of every stored feed blob at module import, and stringifies up to 1000 events per write
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useCustomFeedNotesCache.ts:413`, `packages/web/src/hooks/useCustomFeedNotesCache.ts:422`, `packages/web/src/hooks/useCustomFeedNotesCache.ts:313`, `packages/web/src/hooks/useCustomFeedNotesCache.ts:331`, `packages/mobile/src/hooks/useCustomFeedNotesCache.ts:184-208 — SAME defect and worse: the import-time IIFE uses `mobileStorage.getSync(key)` + `JSON.parse` (fully synchronous MMKV read on the JS thread, no await to yield) for every `custom-feed-cache:` key, with the same MAX_NOTES_PER_FEED=1000 cap at :38 making it a permanent no-op after first run`, `packages/mobile/src/hooks/useCustomFeedNotesCache.ts:59-74 — same full-blob JSON.stringify on every save/merge`
- **detail**: A module-scope IIFE runs at import time (i.e. at app boot, since `MultiColumnClient.tsx:20` imports this module) and parses every persisted corkboard cache:
```ts
(async () => {
  const feedIds = await getAllCustomFeedIds();
  for (const feedId of feedIds) {
    await withKeyedLock(`custom-feed:${feedId}`, async () => {
      const stored = await idbGet(key);
      if (!stored) return;
      const events: NostrEvent[] = JSON.parse(stored);   // :422 — main-thread parse of the whole blob
      if (events.length > MAX_NOTES_PER_FEED) { ...idbSet(key, JSON.stringify(pruned)) }
```
`MAX_NOTES_PER_FEED = 1000` (:285), and both `saveCustomFeedNotes` (:313) and `mergeCustomFeedNotes` (:331) serialize the full blob with `JSON.stringify` on every write.
- **failure**: A user with 10 corkboards, each at the 1000-event cap (~1 MB serialized), pays 10 sequential ~1 MB `JSON.parse` calls during app startup for a one-time migration that is a no-op after the first run — roughly 100-200 ms of main-thread blocking competing with first paint. Every subsequent "load older" on a full corkboard re-stringifies the entire 1 MB array.
- **fix**: Correct as written, with one sharpening and one caveat. Sharpening: the guard flag must be written INSIDE the same `withKeyedLock`/after the full loop completes, and the loop should `await` before setting it, otherwise a crash mid-loop leaves oversized feeds unpruned forever. Cheaper and equally effective without a schema change: skip the parse entirely for blobs that cannot exceed the cap — check `stored.length` against a byte threshold first, since a <200KB blob can never hold >1000 events. Caveat on the second half: migrating to a per-event object store is a real re-architecture of `getCustomFeedNotes`/`saveCustomFeedNotes`/`mergeCustomFeedNotes`/`clearCustomFeedNotes` and the `customFeedMemCache` at :299, and it interacts with the `withKeyedLock` C3 invariant documented at :304-306 — worth doing but it is not the same-size change as the flag, so land the flag first.

### ☐ OPEN — vendor-react chunk is nearly empty — react-dom's implementation landed in vendor-radix, so the manualChunks split does not do what it intends
- **area**: `perf-web` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/vite.config.ts:40`, `packages/web/vite.config.ts:41`
- **detail**: `vite.config.ts:40-41` intends to isolate the React runtime:
```ts
if (/\/node_modules\/(react|react-dom|react-router-dom)\//.test(id)) return 'vendor-react';
if (id.includes('/node_modules/@radix-ui/')) return 'vendor-radix';
```
But the emitted `packages/web/dist/assets/vendor-react.js` is only 21,572 bytes and its first line re-imports the renderer from the Radix chunk:
```js
import{r as e,t}from"./rolldown-runtime.js";import{a as n}from"./vendor-markdown.js";import{wt as r}from"./vendor-radix.js";
var i=t((e=>{var t=r();e.createRoot=t.createRoot,e.hydrateRoot=t.hydrateRoot}))
```
Meanwhile `vendor-radix.js` is 272,662 bytes — far larger than the Radix primitives alone, consistent with react-dom (~180 KB minified) being folded in. I did not trace the rolldown mechanism, only the emitted output.
- **failure**: Cache invalidation is coupled to the wrong axis: bumping a `@radix-ui/*` package invalidates the (much larger, much more stable) React runtime for every returning user, and vice versa. With unhashed filenames (see the caching finding) this is currently masked, but it will bite as soon as content hashing is enabled.
- **fix**: Do NOT reorder the branches (React is already first, at vite.config.ts:42, and the ids do match — reordering is a no-op) and do not reach for `experimentalMinChunkSize` (not a rolldown option). Replace the `manualChunks` function in packages/web/vite.config.ts:40-47 with rolldown's native `output.codeSplitting.groups`, which honors the split. I verified this build works and produces the intended graph:

```ts
build: {
  rollupOptions: {
    output: {
      entryFileNames: `assets/[name].js`,
      chunkFileNames: `assets/[name].js`,
      assetFileNames: `assets/[name].[ext]`,
      codeSplitting: {
        groups: [
          { name: 'vendor-react',    test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/, priority: 100 },
          { name: 'vendor-radix',    test: /node_modules[\\/]@radix-ui[\\/]/,                                              priority: 90 },
          { name: 'vendor-nostr',    test: /node_modules[\\/](@nostrify|nostr-tools)[\\/]/,                                priority: 90 },
          { name: 'vendor-markdown', test: /node_modules[\\/](react-markdown|remark-gfm|remark-breaks)[\\/]/,              priority: 90 },
        ],
      },
    },
  },
}
```

Measured result of that exact config vs. the current one: vendor-react.js 21,572 B -> 161,364 B (now actually contains react-dom: `suppressHydrationWarning` count 2), vendor-radix.js 272,662 B -> 139,756 B (`suppressHydrationWarning` count 0, i.e. pure Radix), vendor-markdown.js 160,422 -> 153,407 B. Note `react-router` (not just `react-router-dom`) and `scheduler` must be in the React group — both showed up as separate node_modules ids in the probe and neither was matched by the old regex. Verify after the change with `grep -c suppressHydrationWarning dist/assets/vendor-react.js` (expect >=1) and `grep -c suppressHydrationWarning dist/assets/vendor-radix.js` (expect 0). Also note rolldown deprecates `advancedChunks` in favor of `codeSplitting` (rolldown-build-BVD3dIdE.mjs:3061), so use `codeSplitting`.

### ☐ OPEN — Android manifest sets allowBackup="true" with no extraction rules — the whole app data dir is auto-uploaded to Google by default
- **area**: `privacy-cypherpunk` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/android/app/src/main/AndroidManifest.xml:14`, `packages/mobile/src/storage/MmkvStorage.ts:146-153`, `packages/core/src/storageKeys.ts:31`
- **detail**: `<application ... android:allowBackup="true" ...>` (line 14) is the only backup-related attribute in the manifest — there is no `android:dataExtractionRules`, no `android:fullBackupContent`, and no `res/xml/` backup config anywhere under `packages/mobile/android/app/src/main/` (verified: the directory has no xml/ folder). Android Auto Backup therefore uploads the entire app data dir — including the MMKV files at `corkboards-encrypted` and `corkboards-default` — to the user's Google Drive, plus D2D transfer, with no in-app opt-in and no user-visible disclosure. MmkvStorage.ts:146-153 documents an explicit fallback path: if the keychain read/write fails, `mmkv = createMMKV({ id: LEGACY_INSTANCE_ID })` with `mmkvIsEncrypted = false` — a *plaintext* store. That store holds every per-user key from `PER_USER_KEYS` (packages/core/src/storageKeys.ts:230-249), which includes `STORAGE_KEYS.NWC: 'corkboard:nwc'` (line 31) — a `nostr+walletconnect://…&secret=<hex>` string that is a spendable wallet credential — plus the follow list, RSS subscriptions, bookmark ids, and the 3000-entry `notes-cache:` shard. For a project whose stated values are "no third-party leakage" and "always encrypt private data", shipping every user's local state to Google by default is the single largest values violation in the repo.
- **failure**: User installs the APK on a device where react-native-keychain fails (locked device at first launch, non-Play-Services ROM, Keystore attestation failure). MmkvStorage falls back to the unencrypted `corkboards-default` instance and the app shows a warning the user dismisses. Android Auto Backup runs overnight and uploads `/data/data/me.corkboards.mobile/files/mmkv/corkboards-default` — containing the plaintext NWC connection string with its spend secret, the user's full follow list, and 3000 cached notes — to Google Drive. Anyone who compromises the Google account (or receives a lawful-access request response) drains the wallet and reconstructs the user's complete social graph.
- **fix**: Fix it where it survives a prebuild, not in the generated manifest: add `"allowBackup": false` under `expo.android` in /home/q4/corkboards/packages/mobile/app.json:24-32, and add a config plugin (or expo-build-properties) that writes `android:dataExtractionRules` + `android:fullBackupContent` pointing at rule files that `<exclude domain="file" path="."/>`, so a dependency flipping the default cannot silently re-enable it. Separately, delete the dead `STORAGE_KEYS.NWC` constant at packages/core/src/storageKeys.ts:30 and its BACKED_UP_KEYS entry at :170 — nothing reads or writes it, and leaving a key named for a wallet credential in the backup key list invites a future contributor to start persisting the URI. Do NOT implement the finder's "refuse to persist STORAGE_KEYS.NWC when mmkvIsEncrypted === false" guard; there is no such write path.

### ☐ OPEN — Mobile hard-codes the corkboards.me RSS proxy — every mobile user's full RSS subscription list plus IP is disclosed to the app operator, with no opt-out and no technical need
- **area**: `privacy-cypherpunk` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/lib/feedUtils.ts:20`, `packages/mobile/src/lib/feedUtils.ts:33-34`, `packages/core/src/feedConstants.ts:19`, `packages/mobile/src/hooks/useCustomFeed.ts:7`
- **detail**: `const RSS_PROXY = 'https://corkboards.me/rss-proxy.php';` (feedUtils.ts:20, commented "absolute URL so it works from the mobile app (no relative paths)"), then `fetch(`${RSS_PROXY}?url=${encodeURIComponent(feedUrl)}&max=${maxItems}`)` at :33-34. There is no setting, no override, and no way to disable it — grepping the mobile package for `RSS_PROXY` finds only this constant and its one use. The proxy exists *solely* to work around browser CORS: rss-proxy.php's own header comment says "Exists because RSS feeds don't set CORS headers, so browsers block direct fetch from the web app." React Native's `fetch` is not subject to CORS — the same `fetch()` at InlineReplyComposer.tsx:97 and ComposeScreen.tsx:119 reads arbitrary URIs directly. So on mobile the proxy buys nothing and costs everything: the corkboards.me server (and its host, and anyone on the path with the TLS SNI/IP) sees each mobile user's IP paired with every RSS feed URL they subscribe to, polled continuously. That is a centralized reading-history log built by the app's own operator, in an app whose stated value is "no telemetry, no tracking" and "cypherpunk sensibilities: no third-party leakage." Web is fine — `RSS_PROXY = '/rss-proxy.php'` (feedConstants.ts:19) is same-origin.
- **failure**: A user in a hostile jurisdiction subscribes to a dissident RSS feed on the mobile app. Every autofetch cycle sends `GET https://corkboards.me/rss-proxy.php?url=https%3A%2F%2Fdissident.example%2Ffeed.xml` from their residential IP. The corkboards.me access log (and the PHP rate-limit files under `sys_get_temp_dir()`, keyed by `md5($clientIp)`) now constitute a subpoena-able record linking that IP to that feed. Nothing in the app told the user this would happen.
- **fix**: Do not switch mobile to direct fetch — that would drop the SSRF gate and favicon inlining the PHP provides and would leak the user's IP to every feed publisher instead of one host. Instead make the endpoint a first-class setting: move `RSS_PROXY` out of packages/mobile/src/lib/feedUtils.ts:20 into a persisted, user-editable value in mobile Settings alongside the existing image-proxy field (packages/web/src/components/AdvancedSettings.tsx:675-690 is the pattern), defaulting to https://corkboards.me/rss-proxy.php so self-hosters can point it at their own deployment. Disclose the trade-off in that settings row — that the configured proxy sees each feed URL and the device IP — since nothing currently tells the user. Validate the entered URL with `isUnsafeHost()` from '@core/ipUtils' before use. Also add the same field on web so `RSS_PROXY` at packages/core/src/feedConstants.ts:19 is overridable rather than a hardcoded relative path (which additionally 404s under the Tauri asset protocol on desktop).

### ☐ OPEN — The persistent relay blocklist is dead code — blockRelay/getBlockedRelays have zero callers and NostrProvider's same-named function checks a different map
- **area**: `privacy-cypherpunk` · **platforms**: web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useNostrBackup.ts:37-54`, `packages/mobile/src/hooks/useNostrBackup.ts:65-81`, `packages/web/src/components/NostrProvider.tsx:135-140`, `packages/core/src/storageKeys.ts:36`, `packages/core/src/storageKeys.ts:176`, `packages/mobile/src/hooks/useNostrBackup.ts:65-81`
- **detail**: useNostrBackup.ts:37-54 defines a persisted relay blacklist: `BLOCKED_RELAYS_KEY = 'corkboard:blocked-relays'`, `getBlockedRelays()`, `blockRelay(url)`, `isRelayBlocked(url)`. Grepping both packages for these three symbols returns only their own definitions and internal uses — `blockRelay` is never called, and there is no UI (searching AdvancedSettings.tsx and MultiColumnClient.tsx for relay-blocking controls finds nothing). Meanwhile `NostrProvider.tsx:135-140` exports an *unrelated* function with the identical name `isRelayBlocked(url)` whose body is `const entry = _relayBackoff.get(...)` — it checks the transient exponential-backoff map only and never consults `corkboard:blocked-relays`. So the routing layer (selectFeedRelays:610, Router.configure:423, createRelay:159) is enforcing connection health, not user intent. The key is nonetheless wired into persistence as a real setting: it is in `SHARED_BACKED_UP_KEYS` (storageKeys.ts:176) and therefore in `PER_USER_KEYS` and `getAllBackupKeys()`, so it is encrypted, uploaded to Blossom, and restored on other devices — a privacy preference that round-trips through backup and is then silently ignored.
- **failure**: A user restores a backup that contains `corkboard:blocked-relays: ["wss://relay.nostr.band/"]` (written by an older build, or by any future UI). The app restores the value, shows nothing, and continues to query relay.nostr.band on every feed load because NostrProvider's `isRelayBlocked` only looks at `_relayBackoff`. The user believes a relay they distrust is excluded; it is not. Any developer who adds a "block this relay" button by calling `blockRelay()` will ship a control that does nothing, because the two same-named functions make the bug invisible at the call site.
- **fix**: Pick one and do it on all three platforms. Cheapest correct option: delete blockRelay/getBlockedRelays/isRelayBlocked from packages/web/src/hooks/useNostrBackup.ts:36-54 and packages/mobile/src/hooks/useNostrBackup.ts:65-81, drop the `!isRelayBlocked(url)` filter at useNostrBackup.ts:964, and remove STORAGE_KEYS.BLOCKED_RELAYS from SHARED_BACKED_UP_KEYS (storageKeys.ts:176) so a phantom preference stops round-tripping through the encrypted Blossom backup. If instead you wire it up: first rename NostrProvider's health check to `isRelayInBackoff` in packages/web/src/components/NostrProvider.tsx:135 and packages/mobile/src/lib/NostrProvider.tsx:213 (updating all five/six call sites in each) to kill the collision, then have selectFeedRelays *drop* user-blocked relays rather than deprioritise them — note that lines 621-623 currently append blocked relays to the tail instead of removing them, which is right for backoff and wrong for user intent, so the two concepts need separate handling at that exact spot (same at mobile :447-448). Add the block toggle to the RelaySection in AdvancedSettings.tsx and the mobile equivalent. Do not ship the wiring on web only.

### ☐ OPEN — Dead third-party AI client (ai.shakespeare.diy) that signs NIP-98 auth with the user's key is still in the tree on web and mobile
- **area**: `privacy-cypherpunk` · **platforms**: web, mobile · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useShakespeare.ts:62`, `packages/web/src/hooks/useShakespeare.ts:64-97`, `packages/mobile/src/hooks/useShakespeare.ts:66`, `AGENTS.md:41`, `AGENTS.md:111`, `docs/AI_CHAT.md (entire file, 334 lines)`
- **detail**: `SHAKESPEARE_API_URL = 'https://ai.shakespeare.diy/v1'` with three `fetch()` sites (useShakespeare.ts:179, 242, 328) and a `createNIP98Token` helper (lines 64-97) that calls `user.signer.signEvent({ kind: 27235, … })` and base64s the signed event into an Authorization header — i.e. it hands the user's pubkey and a signed proof-of-identity to a third-party AI endpoint, along with whatever prompt content is passed. Grepping both packages for `useShakespeare`/`shakespeare` outside the hook files returns zero consumers, and `grep -c shakespeare packages/web/dist/assets/*.js` returns 0 across every chunk — so it is genuinely tree-shaken out of the current build. It is nonetheless one `import` away from shipping, and it is duplicated on mobile where Metro's dependency-graph bundling gives the same one-import exposure. For a project whose values are "no third-party leakage" and "pubkey correlation" avoidance, a fully-wired third-party identity-attaching API client sitting unused in the source is a landmine.
- **failure**: A future contributor adds an AI-assist button and imports `useShakespeare`. On first use the app signs a kind-27235 event with the user's key and POSTs it plus the user's draft note text to ai.shakespeare.diy — leaking both the user's nostr identity and their unpublished content to a third party, with no consent dialog, because the hook was already 'in the codebase' and looked sanctioned.
- **fix**: Delete packages/web/src/hooks/useShakespeare.ts and packages/mobile/src/hooks/useShakespeare.ts, and in the same commit remove what points at them: the `useShakespeare` bullet at AGENTS.md:41, the docs/AI_CHAT.md reference at AGENTS.md:111, docs/AI_CHAT.md itself, and .claude/skills/ai-chat/. Leaving the docs and the installed skill behind is the actual hazard — they are what tells the next contributor (human or agent) that this integration is sanctioned. If AI assist is genuinely wanted later, re-land it with a user-configurable endpoint (same pattern as IMAGE_PROXY_TEMPLATE_KEY, blank by default) and an explicit consent dialog naming the host and stating that a signed kind-27235 event discloses the user's pubkey — never a hardcoded third-party URL with automatic NIP-98 identity attachment.

### ☐ OPEN — Web logout wipes the image-proxy setting, silently reverting the user's IP-hiding control to off
- **area**: `privacy-cypherpunk` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/lib/imageProxySettings.ts:8`, `packages/web/src/lib/imageProxySettings.ts:23-25`, `packages/web/src/hooks/useLoginActions.ts:401`, `packages/web/src/hooks/useLoginActions.ts:469`, `packages/web/src/main.tsx:47-51`
- **detail**: The image-proxy template is persisted in `localStorage` under `IMAGE_PROXY_TEMPLATE_KEY = 'corkboard:image-proxy-template'` (imageProxySettings.ts:8, written at :23-25). `nuclearWipe()` — which `logout()` calls before a hard reload (useLoginActions.ts:476-484) — does a blanket `localStorage.clear()` at line 401 and again at line 469. On the next boot, main.tsx:47-51 reads `localStorage.getItem(IMAGE_PROXY_TEMPLATE_KEY)` → `null` → `setImageProxyTemplate(null)` → `applyImageProxy` becomes a pass-through and every avatar and inline image goes direct. The setting is a *device* privacy preference, not account data — it is deliberately not in `PER_USER_KEYS` or `BACKED_UP_KEYS` (storageKeys.ts) — so it is not restored from backup either. Mobile does not have this problem: its `logout()` (AuthContext.tsx:421) never clears MMKV, so `corkboard:image-proxy-template` survives.
- **failure**: A user configures an image proxy, browses for a week, signs out, and signs back in. The proxy is gone, the settings field is blank, and nothing announced the change. From then on every avatar and note image is fetched directly from arbitrary Nostr media hosts with their real IP — the exact leak they had configured against — until they happen to revisit Advanced Settings.
- **fix**: Replace the blanket clears with a device-preference allowlist rather than a save/restore dance around one key. In packages/web/src/hooks/useLoginActions.ts add `const DEVICE_PREFS = [IMAGE_PROXY_TEMPLATE_KEY] as const;` and a helper `clearLocalStorageExceptDevicePrefs()` that snapshots those keys, calls `localStorage.clear()`, then rewrites them — and use it at BOTH :401 and :469 (restoring only around :401 is the obvious bug, since the sweep at :469 wipes it again). Do not also re-call setImageProxyTemplate: logout ends in `window.location.replace('/')` (:483) and main.tsx:47-51 re-reads the key on the next boot, so preserving the storage value is sufficient. Keep the allowlist to genuinely account-independent privacy prefs — today that is only the image-proxy template; anything added later (link-shield policy, media-blur default) belongs on the same list. If the intent really is total erasure, then say so in the logout confirmation UI in packages/web/src/pages/MultiColumnClient.tsx rather than leaving it silent.

### ☐ OPEN — Android manifest requests SYSTEM_ALERT_WINDOW and legacy external-storage permissions the app never uses; CAMERA is merged in although only the photo library is opened
- **area**: `privacy-cypherpunk` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/android/app/src/main/AndroidManifest.xml:3`, `packages/mobile/android/app/src/main/AndroidManifest.xml:4`, `packages/mobile/android/app/src/main/AndroidManifest.xml:6`, `packages/mobile/src/screens/ComposeScreen.tsx:111`, `packages/mobile/src/components/thread/InlineReplyComposer.tsx:89`, `packages/mobile/app.json (lines 24-32 — the `expo.android` block is the only durable place this can be fixed; the finder never names it as an edit target)`
- **detail**: The hand-written manifest declares `SYSTEM_ALERT_WINDOW` (line 4), `READ_EXTERNAL_STORAGE` (line 3), and `WRITE_EXTERNAL_STORAGE` (line 6). None are used: grepping `packages/mobile/src` for overlay APIs finds only React Native in-app `styles.overlay` / `modalOverlay` views (ProfileModal.tsx:560, EmojiPicker.tsx:359, NoteActions.tsx:356) which need no permission, and file access goes exclusively through `expo-image-picker`. SYSTEM_ALERT_WINDOW is the "draw over other apps" permission — the canonical Android overlay-attack/tapjacking capability, flagged by Play Store review and visible to users as a scary grant. The merged release manifest (`build/intermediates/merged_manifest/release/.../AndroidManifest.xml`) additionally contains `android.permission.CAMERA`, contributed transitively by expo-image-picker, yet the app only ever calls `ImagePicker.launchImageLibraryAsync` (ComposeScreen.tsx:111, InlineReplyComposer.tsx:89) — `launchCameraAsync` appears nowhere outside the type stub at src/types/expo-image-picker.d.ts:29. A privacy-first app asking for camera + overlay + full external storage undermines its own claim, and each unused permission is standing attack surface if the app is ever compromised.
- **failure**: A privacy-conscious user inspects the app's permission list before installing and sees Camera, Draw-over-other-apps, and full storage read/write on an app that only reads a Nostr feed. They reasonably conclude the app is untrustworthy and do not install it. Worse, if any RN bridge or dependency is later compromised, SYSTEM_ALERT_WINDOW gives the attacker a ready-made overlay primitive for phishing the user's nsec.
- **fix**: Fix it in the tracked config, not the generated file. In /home/q4/corkboards/packages/mobile/app.json add to the `expo.android` block (lines 24-32):

  "blockedPermissions": [
    "android.permission.CAMERA",
    "android.permission.SYSTEM_ALERT_WINDOW",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE"
  ]

This is the supported mechanism — `node_modules/@expo/prebuild-config/build/plugins/withAndroidBaseMods.js:66-67` reads `config.android.blockedPermissions` and applies `tools:node="remove"`, which strips both the template-contributed SYSTEM_ALERT_WINDOW and the expo-image-picker-contributed CAMERA/storage pair at merge time. Then run `npx expo prebuild --clean` (the local android/ tree is stale — generated Apr 8, see below) and re-check the merged release manifest; the target set is INTERNET + VIBRATE + USE_BIOMETRIC/USE_FINGERPRINT + the DYNAMIC_RECEIVER app-private permission.

One caveat to test rather than assume: blocking READ_EXTERNAL_STORAGE is safe on API 33+ (ignored anyway; the system photo picker grants a per-URI read), but verify gallery selection still works on an API<=32 device before shipping, since expo-image-picker's own manifest requests it for a reason. If it regresses there, keep READ_EXTERNAL_STORAGE with `android:maxSdkVersion="32"` and block only CAMERA, WRITE_EXTERNAL_STORAGE and SYSTEM_ALERT_WINDOW.

### ☐ OPEN — custom-feed in-memory cache is never invalidated cross-tab and withKeyedLock is per-tab, so a second tab's merge writes a blob missing the first tab's notes
- **area**: `race-conditions` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useCustomFeedNotesCache.ts:298`, `packages/web/src/hooks/useCustomFeedNotesCache.ts:319`, `packages/web/src/hooks/useCustomFeedNotesCache.ts:341`, `packages/web/src/hooks/useCustomFeedNotesCache.ts:387`, `packages/core/src/keyedMutex.ts:8`
- **detail**: `mergeCustomFeedNotes` is a read-modify-write on a single IDB blob, correctly serialized in-tab by `withKeyedLock(`custom-feed:${feedId}`)`. But `chains` in `keyedMutex.ts:8` is a module-level `Map` — it has no cross-tab scope. Meanwhile `getCustomFeedNotes` short-circuits on an in-memory copy that is populated once and never invalidated:

```js
if (customFeedMemCache.has(feedId)) return customFeedMemCache.get(feedId) ?? [];
```

The `custom-feed-cache:` prefix is explicitly excluded from `idb.ts`'s memCache and from the `idb-storage-sync` path (`idb.ts:222`, `:326`), and `customFeedMemCache` has no `BroadcastChannel` listener, so a write from tab A is invisible to tab B forever. Separately, `clearCustomFeedCache` (line 387) does not take the per-feed lock, so it can interleave with an in-flight `saveCustomFeedNotes`.
- **failure**: Two tabs are open on the same corkboard (a normal usage pattern for a multi-column reader). Tab A loads older notes → `mergeCustomFeedNotes(feedId, batch1)` → reads its `customFeedMemCache` copy (200 notes), merges to 300, writes the 300-note blob to IDB. Tab B, whose `customFeedMemCache` still holds the original 200, later merges its own batch → reads 200 from its stale in-memory copy, merges to 280, and overwrites the IDB key with 280 notes. Tab A's 100 newly-cached notes are gone from disk. Nothing errors; the lock did its job within each tab and had no visibility of the other. On next cold start the feed shows a smaller cached window and has to re-fetch from relays.
- **fix**: Drop `customFeedMemCache`'s unconditional short-circuit inside the locked critical section — have `mergeCustomFeedNotes`/`saveCustomFeedNotes` always re-read from IDB (`await idbGet(key)`) while holding the lock, using the mem cache only for unlocked render-path reads. Add a `BroadcastChannel` message (or reuse `corkboard-idb`) that invalidates `customFeedMemCache.delete(feedId)` in sibling tabs on write, and take `withKeyedLock` in `clearCustomFeedCache` too. Cross-tab exclusion needs a real primitive (Web Locks API `navigator.locks.request`) rather than the in-process `keyedMutex`.

### ☐ OPEN — deserializeBackup double-writes every restored key and never uses the purpose-built idbPrimeCache helper
- **area**: `race-conditions` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/hooks/useNostrBackup.ts:326`, `packages/web/src/lib/idb.ts:238`, `packages/web/src/lib/idb.ts:232`
- **detail**: The restore loop writes each key twice:

```js
idbSetSync(key, value);          // internally calls idbSet(key, value) unawaited
writes.push(idbSet(key, value)); // second, awaited write of the identical value
```

`idb.ts:241-250` defines `idbPrimeCache` specifically for this call site — its docstring reads "For bulk restore, which awaits its own single idbSet per key and needs to surface persistence failures instead of firing a second, unawaited write" — but grep shows it has zero callers. The same redundancy was already recognised and removed in `setBlossomServers` (line 117-119: "idbSetSync already schedules the async IDB persist internally — no need to also call idbSet"). Beyond the wasted work, the unawaited `idbSetSync` copy also dispatches a duplicate `idb-storage-sync` event on completion, on top of the explicit event loop at lines 341-349 — so every `useLocalStorage` consumer receives the same value twice per restored key.
- **failure**: Restoring a backup with ~90 keys opens ~180 IndexedDB readwrite transactions instead of 90 and fires ~180 `idb-storage-sync` events instead of 90, causing a double `setState` storm across every mounted `useLocalStorage` (which, with one `useCollapsedNotes` per NoteCard, is dozens of instances). On a slow device this visibly stalls the restore. It also means a failure in the unawaited copy is reported only via `console.warn` inside `idbSetSync`, while the awaited copy may have succeeded — the two paths can disagree about whether the key persisted.
- **fix**: Replace `idbSetSync(key, value)` with `idbPrimeCache(key, value)` in the loop at line 334, keeping the awaited `writes.push(idbSet(key, value))` as the single real write. Then delete the redundant manual `window.dispatchEvent` loop at lines 341-349, since `idbPrimeCache` already dispatches the sync event.

### ☐ OPEN — notesCache.getNotesDb has a non-atomic singleton check — concurrent callers open duplicate IndexedDB connections
- **area**: `race-conditions` · **platforms**: web, desktop · **verdict**: UNVERIFIED
- **files**: `packages/web/src/lib/notesCache.ts:55`, `packages/web/src/lib/idb.ts:89`
- **detail**: ```js
async function getNotesDb(): Promise<IDBDatabase> {
  if (!notesDb) notesDb = await openNotesDb();
  return notesDb;
}
```

The check and the assignment are separated by an `await`, so N concurrent callers all observe `notesDb === null` and each issue their own `indexedDB.open()`. The last one to resolve wins the module variable; the others leak open connections that nobody closes. `idb.ts:89-103` gets this right by caching the *promise* (`dbPromise`) rather than the resolved handle — `notesCache.ts` should use the same pattern. The leaked connections also block `indexedDB.deleteDatabase()`, which `clearNotesCache` (line 224-226) tries to make possible by closing `notesDb` — it only closes the one handle it happens to hold.
- **failure**: On startup `initNotesCache()` calls `loadNotesFromCache()` while a feed hook concurrently calls `saveNotesToCache()` and `getCacheMetadata()`. All three hit `getNotesDb()` before any `openNotesDb()` resolves, so three connections to `corkboard-notes` are opened. Two become unreferenced but stay open for the page's lifetime. Later, logout calls `clearNotesCache()` → `db.close()` closes only the current handle; a subsequent `deleteDatabase('corkboard-notes')` fires `onblocked` and hangs, leaving the previous user's cached notes on disk after a "nuclear wipe".
- **fix**: Cache the promise, not the handle, exactly as `idb.ts` does:
```js
let notesDbPromise: Promise<IDBDatabase> | null = null;
async function getNotesDb() {
  if (!notesDbPromise) notesDbPromise = openNotesDb().catch(e => { notesDbPromise = null; throw e; });
  return notesDbPromise;
}
```
and null out `notesDbPromise` (not just `notesDb`) in `clearNotesCache` and the `beforeunload` handler.

### ☐ OPEN — Per-column ErrorBoundary in FeedGrid is keyed by array index and has no reset path, so one column error is permanent for the tab and bleeds onto unrelated content
- **area**: `react-correctness` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/FeedGrid.tsx:420`, `packages/web/src/components/FeedGrid.tsx:421`, `packages/web/src/components/ErrorBoundary.tsx:27`, `packages/web/src/components/ErrorBoundary.tsx:34`
- **detail**: `ErrorBoundary` has `getDerivedStateFromError` + `componentDidCatch` + `render` and nothing else — no `componentDidUpdate`, no `getDerivedStateFromProps`, no `resetKeys`. `hasError` is only cleared by (a) the default 'Try again' button, or (b) the `NotFoundError`/`removeChild` auto-recover timeout:

```ts
// ErrorBoundary.tsx:27-30
const isDomError = error.name === 'NotFoundError' || error.message?.includes('removeChild')
if (isDomError) { setTimeout(() => this.setState({ hasError: false, error: null }), 100) }
```

But when a `fallback` prop is supplied, `render()` returns it and **neither** escape exists (`:34-37` returns `this.props.fallback` before ever reaching the built-in button). FeedGrid supplies exactly that, with an index key:

```tsx
{visibleColumns.map((columnNotes, colIndex) => (
  <ErrorBoundary
    key={`col-${colIndex}`}
    fallback={<div ...>This column encountered an error. Other columns are unaffected.</div>}
  >
```

Contrast MultiColumnClient.tsx:4230, which does it right: `<ErrorBoundary key={activeTab} fallback={...}>` — remounting on tab change is what makes its 'Switch to another tab and back to refresh' advice true. `col-${colIndex}` never changes for a given tab, so the boundary instance and its `hasError:true` survive every feed refresh, autofetch tick, dismissal, and — because `columnCount` is a prop (`FeedGrid.tsx:65,172,418`) — even a column-count change, at which point `col-1` is holding error state for an entirely different set of notes.
- **failure**: A single malformed note in column 2 throws during render (e.g. a NoteContent parse edge case). Column 2 turns into 'This column encountered an error.' forever: autofetch brings 50 new notes, the user dismisses everything, the user changes column count from 3 to 2 — the second column still shows the error box, now suppressing notes that had nothing to do with the original throw. The only recovery is a tab switch (which remounts the outer keyed boundary) or a page reload; the fallback text gives the user no hint of either.
- **fix**: Do NOT key on note content — `key={`col-${...}-${columnNotes[0]?.id}`}` remounts the whole column subtree every time the top note changes, throwing away every NoteCard's local state (expanded/blurred media, in-flight image loads) on each autofetch tick. Fix the boundary instead: (1) add an optional `resetKeys?: unknown[]` prop to packages/web/src/components/ErrorBoundary.tsx plus a `componentDidUpdate(prev)` that calls `this.setState({hasError:false,error:null})` when any resetKey changes; (2) widen `fallback` to `React.ReactNode | ((reset: () => void) => React.ReactNode)` so the custom-fallback branch at :35-37 can render a retry control instead of being a dead end; (3) in FeedGrid.tsx:420 pass `resetKeys={[activeTab, columnCount]}` and render 'Try again' inside the column fallback text at :423-425. That clears the stale-after-column-count-change case and gives in-place recovery without remounting healthy cards.

### ☐ OPEN — useAutoSaveTrigger stores its change-detection accumulator and poll interval inside the effect closure, so any dependency change restarts both
- **area**: `react-correctness` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useAutoSaveTrigger.ts:60`, `packages/web/src/hooks/useAutoSaveTrigger.ts:148`, `packages/web/src/hooks/useAutoSaveTrigger.ts:151`, `packages/web/src/hooks/useAutoSaveTrigger.ts:158`, `packages/mobile/src/components/AutoSaveManager.tsx`
- **detail**: The whole orchestration lives in one effect whose deps include the churny `backupStatus` and `lastBackupTs`:

```ts
useEffect(() => {
  if (!enabled) return;
  let changeDetectedAt: number | null = null;        // :60 — effect-local
  ...
  const pollInterval = setInterval(() => triggerIfReady('poll-30s'), POLL_INTERVAL_MS);  // :148
  triggerIfReady('mount');                                                               // :151
  return () => { clearInterval(pollInterval); ... };
}, [enabled, backupStatus, autoSaveBackup, hasUnsavedChanges, lastBackupTs, toast, setBackupIndicator, cooldownMs]);  // :158
```

`changeDetectedAt` is the 30-second debounce accumulator (`:83-93`) and `pollInterval` is the only ambient trigger. Both are destroyed and recreated whenever `backupStatus` transitions (idle→saving→saved→idle, including the `setTimeout(() => setStatus('idle'), 3000)` at useNostrBackup.ts:1557/1721) or `lastBackupTs` updates. On each recreation `triggerIfReady('mount')` re-arms `changeDetectedAt = Date.now()` from scratch and the 30s poll clock restarts from zero.
- **failure**: Backup status cycles saving→saved→(3s later) idle. Each transition tears the effect down: the 30s poll never accumulates 30 uninterrupted seconds during that window, and if the user has unsaved changes when it re-runs, `changeDetectedAt` is reset to now — so the 'wait 30s after change detection' gate restarts. If any dep were to churn faster than 30s (e.g. a future change that puts an unmemoized callback in this list), the poll path would be starved indefinitely and auto-save would only ever happen via the visibilitychange/beforeunload force paths, which bypass the debounce entirely.
- **fix**: Hoist the accumulator to `const changeDetectedAtRef = useRef<number | null>(null)` (mirroring packages/mobile/src/components/AutoSaveManager.tsx:42) and keep the churny inputs in refs updated by a one-line sync effect: `statusRef.current = backupStatus` and `lastTsRef.current = lastBackupTs`, read inside triggerIfReady at :64 and :73. The orchestration effect's dep list then collapses to [enabled, autoSaveBackup, hasUnsavedChanges, cooldownMs], so the interval at :148 and the listeners at :149-150 are installed once per sign-in and both the poll clock and the debounce stay monotonic across status transitions. Mobile needs the smaller half of the same fix: AutoSaveManager.tsx:62 makes triggerIfReady depend on lastBackupTs, which is in the deps of the interval effect at :121, so the mobile 30s poll clock also restarts after every save (its accumulator is already safe in the ref).

### ☐ OPEN — app.emit failures are discarded and tauriQuery has no client-side backstop, so a dropped completion event hangs the query promise forever
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/relay.rs:109`, `packages/desktop/src-tauri/src/relay.rs:132`, `packages/web/src/lib/tauri.ts:172`, `packages/web/src/lib/tauri.ts:202`, `packages/web/src/components/NostrProvider.tsx:934`
- **detail**: Rust discards both emit results:

```rust
let _ = app.emit(&event_name, serde_json::json!({ "events": batch, "done": true }));
```

`Emitter::emit` returns `tauri::Result<()>` and can fail (webview torn down, event-name validation, serialization, eval dispatch). On the JS side `tauriQuery` returns `new Promise<unknown[]>((resolve) => …)` whose only `resolve` calls are inside the `if (done)` branch of the listener and the `.catch` on `tauriInvoke`. There is no `setTimeout` backstop. If the terminal `done: true` emit is lost, the promise stays pending forever and `unlistenFn` is never called, so the listener leaks too.

`NostrProvider.tsx:930-936` wraps these in `Promise.all`, so one lost emit wedges the whole `nostr.query()`. The `AbortSignal` race at line 940-949 only rejects the outer promise when a caller supplied a signal; the inner `tauriQuery` promise and its listener remain pending regardless.
- **failure**: User navigates away from a column while a `relay_subscribe` is in flight; the webview label the emit targets is being reconstructed and `app.emit` returns `Err`, which is swallowed. The JS `Promise.all` for that feed never settles, the TanStack Query stays in `isLoading` indefinitely, and the column shows a permanent spinner until reload.
- **fix**: The client backstop is the fix that actually closes the hole, and it should key off the same budget Rust uses. In `tauri.ts:186`, hoist the listener teardown into a single `cleanup()` that also clears a guard timer, and arm it once the listener is registered: `const guard = setTimeout(() => { console.warn('[tauri] relay-' + subId + ' never completed'); cleanup(); resolve(allEvents); }, timeoutMs + 3000);` with `clearTimeout(guard)` inside `cleanup()`. `timeoutMs + 3000` (not +2000) is the right slack because Rust's per-relay `dur` starts only after the command is dispatched and the emit loop still has to drain the bounded channel. Also add `.then(() => { /* command returned; if no done event arrives within ~1s, settle */ })` on the `tauriInvoke` call so the normal completion path settles even faster than the guard. On the Rust side, replace `let _ = app.emit(...)` at relay.rs:132 with `if let Err(e) = app.emit(...) { eprintln!("[relay_subscribe] terminal emit failed for {event_name}: {e}"); }` so the condition is at least diagnosable in debug.log — retrying is not worth it, since the only realistic failure is a torn-down webview where a retry would fail identically.

### ☐ OPEN — SOCKS5 proxy credentials are accepted by validate() then silently discarded on both the native and WebView paths
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/proxy.rs:98`, `packages/desktop/src-tauri/src/relay.rs:322`, `packages/desktop/src-tauri/src/relay.rs:332`, `packages/desktop/src-tauri/src/lib.rs:42`, `packages/desktop/src-tauri/src/proxy.rs:65`, `packages/web/src/components/AdvancedSettings.tsx:608`
- **detail**: `validate()` only checks scheme ∈ {socks5, socks5h} and that host+port are present; `socks5h://alice:hunter2@127.0.0.1:9050` is accepted and stored verbatim. `connect_via_proxy` then rebuilds the address from host and port only:

```rust
let proxy_addr = format!("{}:{}", proxy_parsed.host_str()…, proxy_parsed.port()…);
let socks_stream = tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), format!("{host}:{port}")).await
```

`Socks5Stream::connect` performs a no-auth SOCKS5 handshake — tokio-socks-0.5.2 has a separate `connect_with_password` (src/tcp/socks5.rs:85) that is never used. The WebView path is no better: wry's `parse_proxy_url` (tauri-runtime-wry-2.10.1/src/lib.rs:4301-4311) builds `ProxyEndpoint { host, port }` and webkitgtk/mod.rs:270 reformats it as `format!("socks5://{}:{}", host, port)`, dropping userinfo as well.

The failure is silent from the user's perspective — no validation error at save time, just every relay query returning `"proxy connect: socks5: …"`. Note this does not fall back to clearnet (do_query returns the error), so it is a correctness/UX defect rather than a leak.
- **failure**: A user behind a corporate or self-hosted authenticated SOCKS5 gateway enters `socks5h://user:pass@10.0.0.5:1080`. The settings panel accepts it and shows a green "Active" line. Every relay query then fails with an opaque `socks5: general SOCKS server failure`, and the user has no way to tell that their credentials were thrown away.
- **fix**: Reject credentials at the boundary rather than supporting them, because the WebView path (lib.rs:42 → wry) physically cannot carry them: in `validate()` (proxy.rs:98) add `if !parsed.username().is_empty() || parsed.password().is_some() { return Err("authenticated SOCKS5 proxies are not supported".into()); }`. Route `load_from_disk` (proxy.rs:65) through the same `validate()` so a stale/hand-edited proxy.json can neither smuggle credentials past the check nor wedge startup via an unparseable-by-wry scheme — on validation failure set `LOAD_FAILED` and leave `PROXY_URL` as `None`. If auth support is genuinely wanted later, it must be native-only (`Socks5Stream::connect_with_password`, tokio-socks 0.5.2 src/tcp/socks5.rs:85) with an explicit UI warning that WebView traffic will go through the same proxy unauthenticated and therefore fail.

### ☐ OPEN — debug.log captures all console output and is written with default (world-readable) permissions, always on, no opt-out
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/logger.rs:83`, `packages/desktop/src-tauri/src/logger.rs:15`, `packages/desktop/src-tauri/src/proxy.rs:89`, `packages/web/src/main.tsx:55`, `packages/web/src/main.tsx:87`, `packages/desktop/src-tauri/src/logger.rs:79`
- **detail**: `main.tsx:55` unconditionally replaces `console.log/warn/error` whenever `isTauri` is true, routing every message into `tauriLog` -> `write_log`. There is no setting to disable it. The Rust writer uses `OpenOptions::new().create(true).append(true).open(&path)` with no `.mode()`, so on Linux/macOS the file is created 0666 & ~umask = **0644** — readable by every local account. `ensure_dir` uses `create_dir_all` (0755). `proxy.rs:95` writes `proxy.json` with `fs::write`, same 0644.

The contents are not innocuous for this project's threat model: relay URLs queried, pubkeys and event ids seen, the NIP-46 handshake trace from `useLoginActions.ts:132-190`, the full `navigator.userAgent`, and whatever any component happens to log. For a user whose entire reason for configuring Tor is that their reading habits are sensitive, `~/.local/share/me.corkboards.desktop/debug.log` is a plaintext, world-readable record of exactly that, and `proxy.json` advertises that they use Tor at all.
- **failure**: Shared workstation or a multi-user Linux box. Another local user runs `cat /home/victim/.local/share/me.corkboards.desktop/debug.log` and reconstructs which relays the victim queries, which npubs they read, and — from proxy.json — that they route through Tor. No privilege escalation required.
- **fix**: In logger.rs, gate on unix and set modes explicitly: `#[cfg(unix)] use std::os::unix::fs::{OpenOptionsExt, DirBuilderExt};`, add `.mode(0o600)` to the `OpenOptions` chain at logger.rs:83, and replace `create_dir_all` at logger.rs:17 with `std::fs::DirBuilder::new().recursive(true).mode(0o700)`. Note the two `std::fs::write` calls in the same file (logger.rs:79 truncation, logger.rs:95 clear_log) will re-create the file with default perms if it was deleted between calls, so they need the same OpenOptions treatment rather than `fs::write`. Do the same for proxy.rs:95 (`fs::write` → OpenOptions with `.mode(0o600)`) and proxy.rs:92 (`create_dir_all` → mode 0o700). Windows inherits the per-user AppData ACL, so `#[cfg(unix)]` is sufficient. Separately, replace the `isTauri` condition at main.tsx:55 with an explicit persisted opt-in (default OFF) surfaced in AdvancedSettings next to the existing proxy controls, so the plaintext record of relays/pubkeys/NIP-46 traces is something the user chose.

### ☐ OPEN — Every relay query opens a fresh TCP+TLS(+SOCKS) connection — no pooling, so a feed load is dozens of full handshakes
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/relay.rs:258`, `packages/desktop/src-tauri/src/relay.rs:308`, `packages/desktop/src-tauri/src/relay.rs:460`, `packages/web/src/components/NostrProvider.tsx:930`
- **detail**: `do_query` unconditionally dials: `connect_via_proxy(&url, &proxy_url)` or `connect_async(url.as_str())`, and `run_query` ends with `let _ = ws.close(None).await;`. There is no connection cache anywhere in relay.rs. Meanwhile `NostrProvider.tsx:929-936` issues one `tauriQuery` per filter, and each `tauriQuery` spawns one task per relay — so a single `nostr.query()` with 3 filters across 4 relays performs 12 independent TCP + TLS handshakes, and repeats them on the next query.

This is a regression against the very thing the native bridge replaces: nostrify's `NRelay1` keeps one long-lived socket per relay and multiplexes REQs over it. Over SOCKS the cost is far worse, because each connection also pays a fresh Tor circuit build (1-3 s) — which then interacts with the fixed 2500-5000 ms timeouts described in the streaming finding.
- **failure**: Desktop user with 6 relays scrolls a 4-column corkboard. Each scroll page triggers ~4 queries × 6 relays = 24 new TLS handshakes. Over Tor, each needs a new circuit; most exceed the 5000 ms budget and return nothing, so the feed appears empty while the machine churns through dozens of circuits.
- **fix**: Don't start with a process-wide pool plus REQ multiplexing — that requires replacing the hardcoded sub id at relay.rs:479, adding idle eviction and ping/pong keepalive, and reworking the per-relay task model at relay.rs:66-91, which is a large change for a throughput win. Take the cheap step first: hoist the per-filter fan-out out of JS by letting `relay_subscribe` accept `filters: Vec<Value>` instead of a single `filter` (relay.rs:47) and send one REQ per filter with distinct sub ids over the one socket it already opens, then collapse NostrProvider.tsx:932-937 to a single `tauriQuery(relays, filters, 5000)`. That alone divides the handshake count by the filter count with no new lifecycle to manage. Measure before adding a pool; if you do add one, key it on the normalized relay URL and make eviction respect `proxy::current_proxy()` changing at runtime, since relay.rs:320 documents that the proxy is re-read per query and a cached socket would silently pin the old proxy setting.

### ☐ OPEN — redact_secret_param only matches `secret=`, so JSON-serialized secrets reach the plaintext log unredacted
- **area**: `rust-tauri` · **platforms**: desktop, web · **verdict**: UNVERIFIED
- **files**: `packages/desktop/src-tauri/src/logger.rs:53`, `packages/desktop/src-tauri/src/logger.rs:26`, `packages/web/src/main.tsx:64`, `packages/web/src/main.tsx:76`
- **detail**: Both redaction layers key on the literal `secret=` (Rust `const needle = "secret="` at logger.rs:54; JS `/(secret=)[^&\s"']+/gi` at main.tsx:67). But `fmt` in main.tsx:76-81 does `JSON.stringify(a)` for every non-string argument, producing `{"secret":"…"}` — colon-and-quote form, which neither pattern matches. A NIP-46 bunker config, an NWC connection object, or any settings blob logged as an object therefore lands in `debug.log` verbatim.

The Rust side has the same gap for `"nsec"` used as a JSON key with a hex value, and neither side covers `privkey`, `sk`, `Authorization`, or `token`. The bech32 handling itself is correct — I checked `redact_bech32`'s byte-index slicing (`rest.find(prefix)` and `after.find(|c: char| !c.is_ascii_alphanumeric())` both return byte offsets on char boundaries), and the ncryptsec-before-nsec ordering does not double-match.
- **failure**: `console.log('[nwc] config', cfg)` where `cfg = {relay:'…', secret:'a3f…64hex'}` serializes to `[LOG] … [nwc] config {"relay":"…","secret":"a3f…"}`. Neither redactor fires and the wallet-connect secret is appended to a 0644 file on disk.
- **fix**: Broaden both patterns to the JSON form and to more key names. JS: `/((?:"|')?(?:secret|privkey|private_key|sk|token|password)(?:"|')?\s*[:=]\s*(?:"|')?)[^,&\s"'}\]]+/gi -> '$1[REDACTED]'`. Mirror the same key list and `[:=]` separator handling in `redact_secret_param`, stopping the value scan at `,`, `}`, `]` in addition to the current terminators.

### ☐ OPEN — capabilities/default.json grants five core permission sets when the app only ever uses invoke + event listen
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: UNVERIFIED
- **files**: `packages/desktop/src-tauri/capabilities/default.json:6`, `packages/web/src/lib/tauri.ts:19`, `packages/web/src/lib/tauri.ts:166`
- **detail**: Grepping the entire web source for `@tauri-apps/api` returns exactly two imports, both in `lib/tauri.ts`: `@tauri-apps/api/core` (invoke) and `@tauri-apps/api/event` (listen). Nothing imports the window, webview, app, or path modules. Yet the capability grants `core:window:default`, `core:webview:default`, `core:app:default`, and `core:path:default`. From `gen/schemas/acl-manifests.json` those expand to 26 window commands, 4 webview commands (including `allow-internal-toggle-devtools`), 7 app commands, and 8 path commands — none of which the frontend calls.

`core:event:default` also includes `allow-emit` and `allow-emit-to`, but the app only listens. That specific grant lets any script in the webview forge a `relay-<subId>` payload into the listener; the JS-side `verifyEvent` in `tauriQuery` blunts the impact, but there is no reason to hand out emit at all.

Devtools are not compiled into release builds (Cargo.toml declares `tauri = { version = "2", features = [] }`, no `devtools` feature), so `allow-internal-toggle-devtools` is inert in production — but it is live in any debug build.
- **failure**: An XSS in note rendering calls `window.__TAURI__.event.emit('relay-abc-1', {events:[…], done:true})` to inject a synthetic completion into an in-flight query, or `window.__TAURI__.webview.getCurrentWebview().internalToggleDevtools()` in a debug build. Neither is possible if the permissions are scoped to what the app uses.
- **fix**: Reduce the permission list to `["core:event:allow-listen", "core:event:allow-unlisten"]`. The five custom commands are registered via `generate_handler!` and do not require an ACL entry. If a window or path API is needed later, add the single `allow-*` permission rather than the whole `:default` set.

### ☐ OPEN — No updater, no update signature pinning, and no bundle code-signing configuration
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: UNVERIFIED
- **files**: `packages/desktop/src-tauri/tauri.conf.json:18`, `packages/desktop/src-tauri/Cargo.toml:14`
- **detail**: `tauri.conf.json` has no `plugins.updater` block, no `bundle.createUpdaterArtifacts`, and `Cargo.toml` has no `tauri-plugin-updater` dependency — so there is no in-app update path at all. `bundle` is `{ active: true, targets: "all", icon: [...] }` with no `macOS.signingIdentity`/`hardenedRuntime`, no `windows.certificateThumbprint`/`digestAlgorithm`, and no `linux.appimage` signing.

Combined with the fact that this app holds the user's nsec in the OS keychain and signs with it, every security fix in this repo — including the ones above — reaches users only if they happen to notice a release and manually download an unsigned artifact over HTTPS. The memory note about AppImage naming confirms manual distribution is the actual channel.
- **failure**: A relay-parsing bug is fixed in 0.8.3. Users running 0.8.0 have no notification and no upgrade path; they keep running the vulnerable build indefinitely. Separately, an unsigned AppImage/MSI gives a user no way to distinguish the real build from a substituted one on a mirror.
- **fix**: Add `tauri-plugin-updater`, configure `plugins.updater` with `"pubkey"` set to the public half of a `tauri signer generate` keypair (Tauri verifies the minisign signature before applying, which is the pinning you want) and `"endpoints"` over HTTPS. Set `bundle.createUpdaterArtifacts: true`. Populate `bundle.macOS.signingIdentity` + `hardenedRuntime: true` and `bundle.windows.certificateThumbprint` in CI so the shipped artifacts are signed.

### ☐ OPEN — CSP omits `ws:` from connect-src while setting upgrade-insecure-requests, blocking plain-ws .onion relays in the WebView that the native path allows
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: UNVERIFIED
- **files**: `packages/desktop/src-tauri/tauri.conf.json:15`, `packages/desktop/src-tauri/src/relay.rs:176`, `packages/desktop/src-tauri/src/relay.rs:320`
- **detail**: The CSP's `connect-src` is `'self' ipc: http://ipc.localhost wss: https:` — `ws:` is absent — and the policy ends with `upgrade-insecure-requests`, which per spec rewrites a-priori-insecure `ws://` requests to `wss://`. Meanwhile the Rust path explicitly supports plain ws: `validate_relay_url` accepts `"ws" | "wss"` and `connect_via_proxy` has a dedicated `ProxiedStream::Plain` arm for `is_wss == false`.

Tor hidden-service relays are conventionally `ws://<56chars>.onion` with no TLS, because the .onion address itself authenticates the endpoint — exactly the mitigation the TLS note at relay.rs:295-304 and the settings copy both recommend. So the app recommends onion relays, supports them natively, and blocks them in the WebView.

The rest of the CSP is sound: `script-src 'self' 'wasm-unsafe-eval'` with no `unsafe-inline`/`unsafe-eval`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, and no `dangerousDisableAssetCspModification` anywhere in the config.
- **failure**: User adds `ws://abcdef…onion/` as a relay. Native `relay_query` reaches it over SOCKS; any WebView-side connection (nostr-login's NIP-46 handshake, welshman's own sockets) is upgraded to `wss://abcdef…onion/`, the TLS handshake fails, and the relay appears half-broken with no explanation.
- **fix**: Add `ws:` to `connect-src` and drop `upgrade-insecure-requests` (it provides nothing here — `default-src 'self'` and the explicit per-directive schemes already control what can be loaded, and the app never uses `http:` sub-resources). If you want to keep the upgrade behaviour for images/media, scope it by removing the directive and instead constraining `img-src`/`media-src` to `https: data: blob:` as they already are.

### ☐ OPEN — relay_subscribe places no bound on urls.len(), and limit:0 causes every event to be silently discarded
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: UNVERIFIED
- **files**: `packages/desktop/src-tauri/src/relay.rs:66`, `packages/desktop/src-tauri/src/relay.rs:52`, `packages/desktop/src-tauri/src/relay.rs:100`
- **detail**: Two issues in the same command.

(1) `urls.into_iter().map(|url| … tokio::spawn(…))` spawns one task, one socket, one TLS handshake and one 5000 ms timer per element with no cap. `urls` comes straight from the webview over IPC. Nothing rate-limits concurrent `relay_subscribe` invocations either, so N in-flight calls × M urls sockets are all live at once.

(2) The limit derivation is `filter.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(DEFAULT_LIMIT_CAP).min(DEFAULT_LIMIT_CAP * 5)`. A NIP-01-legal `"limit": 0` (meaning "no stored events") yields `limit = 0`, and the drain loop's first check is `if total >= limit { continue; }` — 0 >= 0 is true for every event, so all results are discarded and the command emits `{events: [], done: true}`. Also `v as usize` truncates on a 32-bit target: `limit: 4294967296` becomes 0, same outcome.
- **failure**: An XSS (or a bug in `getTauriRelaysForFilter`) invokes `relay_subscribe` with 500 relay URLs; the app opens 500 concurrent sockets and 500 Tor circuits, exhausting file descriptors and wedging the Tor daemon. Independently, any caller that passes `limit: 0` gets an empty result set with no error.
- **fix**: Cap the fan-out — `let urls: Vec<_> = urls.into_iter().take(MAX_RELAYS_PER_QUERY).collect();` with `MAX_RELAYS_PER_QUERY = 16` — and dedupe by normalized URL. Use `usize::try_from(v).unwrap_or(DEFAULT_LIMIT_CAP)` instead of `as usize`, and `.max(1)` (or handle 0 as "live-only, emit done immediately") so a zero limit is not silently equivalent to dropping everything.

### ☐ OPEN — The nsec String read from the keychain is never zeroized
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: UNVERIFIED
- **files**: `packages/desktop/src-tauri/src/keychain.rs:40`, `packages/desktop/src-tauri/src/signer.rs:19`, `packages/desktop/src-tauri/Cargo.toml:14`
- **detail**: `get_secret` returns a plain `String`, and `keys_for` does `Keys::parse(&nsec)` and lets `nsec` drop normally. `nostr::SecretKey` does implement `Drop` (nostr-0.44.3/src/key/secret_key.rs:162), so the parsed key material is wiped — but the bech32 `String` that produced it is not, and neither is the intermediate `format!("nsec:{pubkey}")`-keyed buffer returned by the keyring crate. There is no `zeroize` dependency in Cargo.toml at all.

Because `keys_for` runs on *every* sign/encrypt/decrypt call (see the main-thread finding), this leaves a fresh unzeroized copy of the nsec in freed heap on every signature. Given the project's stated "private keys never touch a server / always encrypt private data" posture, a core dump, hibernation image, or swap page is an inconsistency worth closing.
- **failure**: The app panics and the OS writes a core dump, or the laptop hibernates to an unencrypted swap partition. `strings` over the dump/swap recovers `nsec1…` from one of the many freed copies left by repeated `keys_for` calls.
- **fix**: Add `zeroize = { version = "1", features = ["derive"] }`, change `get_secret` to return `zeroize::Zeroizing<String>`, and let `keys_for` consume it so the buffer is wiped on drop. Combine with the per-session `Keys` cache suggested in the main-thread finding so there is one copy for the session rather than one per operation.

### ☐ OPEN — Transitive dependencies with open RUSTSEC advisories (glib unsoundness, unmaintained gtk-rs/proc-macro-error/instant)
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: UNVERIFIED
- **files**: `packages/desktop/src-tauri/Cargo.lock:1303`, `packages/desktop/src-tauri/Cargo.lock:1367`, `packages/desktop/src-tauri/Cargo.lock:2832`, `packages/desktop/src-tauri/Cargo.lock:1770`
- **detail**: `cargo-audit` is not installed in this environment, so I checked Cargo.lock against advisories I can name. Present:
- `glib 0.18.5` — RUSTSEC-2024-0429, unsoundness in `VariantStrIter::impl_get`; affected range is `>= 0.15.0, < 0.20.0`.
- `gtk 0.18.2` / `gdk 0.18.2` — the gtk-rs GTK3 bindings, marked unmaintained (RUSTSEC-2024-0411 series).
- `proc-macro-error 1.0.4` — RUSTSEC-2024-0370, unmaintained (build-time only).
- `instant 0.1.13` — RUSTSEC-2024-0384, unmaintained.

All four are transitive through `tauri 2.10.3` -> `tauri-runtime-wry 2.10.1` -> `wry 0.54.4` / `tao 0.34.8` and cannot be bumped from this manifest. Direct dependencies are all current and clean: `openssl 0.10.78` (post RUSTSEC-2025-0022), `idna 1.1.0` (post RUSTSEC-2024-0421), `url 2.5.8`, `tokio 1.50.0`, `native-tls 0.2.18`, `nostr 0.44.3`, `keyring 3.6.3`. There is also a duplicated `dirs` (5.0.1 direct + 6.0.0 transitive) that is harmless but avoidable.
- **failure**: No directly exploitable path — the glib issue requires calling `VariantStrIter` APIs this code does not touch, and the unmaintained crates are build-time or shim dependencies. The concrete risk is that with no `cargo audit` in the pipeline, a *future* advisory against a direct dependency (openssl, tokio, url, nostr) would go unnoticed.
- **fix**: Add `cargo install cargo-audit` and a `cargo audit --deny warnings` step to the desktop build, with an `audit.toml` whose `[advisories] ignore` list names the four transitive IDs above plus a comment pointing at the upstream tauri/wry issue, so the four known-and-unfixable ones do not mask a new finding. Bump the direct `dirs = "5"` to `"6"` to collapse the duplicate.

### ☐ OPEN — rss-proxy.php accepts requests with no Origin header, making it an unauthenticated open fetch relay
- **area**: `ssrf-network-egress` · **platforms**: web, mobile · **verdict**: CONFIRMED
- **files**: `packages/web/rss-proxy.php:113`, `packages/web/rss-proxy.php:36`, `packages/web/rss-proxy.php:59`
- **detail**: The origin gate is `if ($origin && !$originAllowed) { 403 }` (line 113) — it only fires when an `Origin` header is present. Any non-browser client (curl, a script, another server) simply omits `Origin` and `Referer` and is served. The comment at 111-112 says this is for "direct browser requests… for testing", but it is what makes the endpoint world-usable. The only remaining control is the file-based per-IP limiter (60 req/60 s, lines 28-62), which also **fails open**: if `fopen`/`flock` fails the request is let through with no accounting (lines 59-62), and `$clientIp = $_SERVER['REMOTE_ADDR']` collapses to a single bucket for every user behind a CDN/reverse proxy. Note the mobile app is exactly such a client (`packages/mobile/src/lib/feedUtils.ts:20` posts to `https://corkboards.me/rss-proxy.php` with no Origin), so simply requiring Origin would break mobile.
- **failure**: An attacker runs `for i in $(seq 60); do curl 'https://corkboards.me/rss-proxy.php?url=https://target.example/big.xml'; done` from a pool of IPs: target.example sees sustained traffic sourced from corkboards.me, and (with the favicon redirect trick above) the attacker reads arbitrary public URLs without ever revealing their own IP. corkboards.me absorbs the abuse report.
- **fix**: Do NOT add a shared client token (extractable from the mobile bundle; provides no real authorisation). Instead: (a) keep Origin optional but treat Origin-less traffic as untrusted — give it a much smaller budget than allowlisted-Origin traffic (e.g. 10/min vs 60/min) and reject when `Sec-Fetch-Site` is present and is `cross-site` (browsers always send it; the mobile RN client does not, so it stays served); (b) fail CLOSED on the limiter — replace the `else { /* allow through */ }` at rss-proxy.php:59-62 with `http_response_code(503)` + exit, since a failed `fopen`/`flock` on the temp dir means accounting is broken for every caller, not just this one; (c) add a coarse global counter file alongside the per-IP one so a distributed IP pool cannot bypass the per-IP bucket; (d) if the deployment ever sits behind a CDN/reverse proxy, key the bucket on a trusted forwarded-for value (only when the immediate peer is the known proxy) — as written every user behind one shared CDN egress IP collapses into a single 60/min bucket, which is a self-DoS as much as a bypass.

### ☐ OPEN — LNURL/zap fetches follow HTTP redirects, so `isSafeZapUrl` is bypassable by the attacker-controlled LNURL host
- **area**: `ssrf-network-egress` · **platforms**: web, mobile · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useZap.ts:40`, `packages/web/src/hooks/useZap.ts:97`, `packages/mobile/src/hooks/useZap.ts:43`, `packages/mobile/src/hooks/useZap.ts:95`
- **detail**: Both zap hooks validate the URL and then use a plain `fetch(url, { signal })`, which defaults to `redirect: 'follow'`. The endpoint is derived from an untrusted kind-0 (`lud16`/`lud06`) and the second URL is built from the server-supplied `callback`; the code comments at useZap.ts:62-67 (web) and :65-70 (mobile) explicitly claim the `isSafeZapUrl` check prevents fetching or POSTing a signed zap request to a private/metadata host — but the check is applied only to the pre-redirect URL. A 302 from the (attacker-owned, validly-public-https) LNURL host redirects the request anywhere, and nothing re-validates the new target. On React Native there is no CORS and no mixed-content blocking, so the redirect can be plain `http://` to a LAN/metadata address and the response body is fully read (`await lnurlResponse.text()` / `.json()`).
- **failure**: Hostile profile sets `lud16: pay@evil.example`. Client GETs `https://evil.example/.well-known/lnurlp/pay` (passes the gate), which answers `302 Location: http://192.168.1.1/setup.cgi?cmd=…`. The mobile client follows it, issuing an authenticated-by-network-position request against the user's router. In step 3 the same trick sends the URL containing the signed kind-9734 (`&nostr=…`) to an arbitrary host of the attacker's choosing.
- **fix**: Client-side you cannot prevent the redirected request from being issued; you can only refuse to trust its result. In both hooks, after each fetch validate the FINAL url and fail closed: `if (!isSafeZapUrl(lnurlResponse.url || zapEndpoint)) throw new Error('LNURL server redirected to an unsafe host')` after useZap.ts:40 (web) / :43 (mobile), and the same on `invoiceResponse.url` after :97 / :95 — `Response.url` reflects the post-redirect URL on both the browser and RN. Additionally cross-check that the final host's registrable domain still matches the pre-redirect host, so a redirect off the lightning-address domain is rejected rather than merely host-checked. Do NOT use `redirect:'manual'`/`'error'` (opaqueredirect on web hides Location; RN ignores the option). If the project wants true prevention, the only option is routing zap fetches through the same DNS-pinned, per-hop-validated server path that rss-proxy.php's fetchValidated() implements — which conflicts with the no-server-sees-your-data value, so accepting a validated-final-URL check is the pragmatic fix.

### ☐ OPEN — Markdown-rendered images bypass the media SSRF/extension gate entirely
- **area**: `ssrf-network-egress` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NoteContent.tsx:40`, `packages/web/src/components/NoteContent.tsx:156`
- **detail**: `MarkdownImg` renders whatever `src` react-markdown hands it: `<SizeGuardedImage src={src} …>` (NoteContent.tsx:50), wired in at line 156 as `img: ({ src, alt }) => <MarkdownImg src={src} alt={alt} />`. Unlike every sibling path — inline emoji go through `optimizeMediaUrl(url)` (NoteContent.tsx:667 mobile / :68 web `replaceEmojis`), MediaLink goes through `resolveMediaSources` + `shouldRejectUrl` (MediaLink.tsx:17,240) — this one never calls `shouldRejectUrl`/`optimizeMediaUrl`. react-markdown's default `urlTransform` only strips dangerous *protocols*; it knows nothing about private hosts. `SizeGuardedImage` then does a real `fetch(url, { method:'HEAD' })` (SizeGuardedImage.tsx:48) for whitelisted hosts and always renders the `<img>`. The page CSP (`img-src 'self' data: blob: https:`, index.html:15) blocks `http://` but not `https://` private hosts. Mobile's NoteContent has no markdown-image renderer at all, so this is also a platform-parity gap.
- **failure**: A kind-1 note with markdown indicators (or a kind-30023 long-form) containing `![](https://192.168.1.1/status.png)` and `![](https://[::ffff:7f00:1]:8443/x.png)` renders in the feed; the viewer's browser issues both requests. Load/error timing distinguishes an open port with TLS from a closed one, giving the note author a LAN/loopback scan of every reader. The suspicious-extension check (`.exe`, `.dmg`, …) in shouldRejectUrl is likewise skipped.
- **fix**: In MarkdownImg (packages/web/src/components/NoteContent.tsx:41-53) resolve the src to an absolute URL against the page origin BEFORE gating (this is what makes the protocol-relative case exploitable), then run it through the shared gate: `const abs = src ? (() => { try { return new URL(src, window.location.href).href } catch { return '' } })() : ''; const safe = abs ? optimizeMediaUrl(abs, true) : ''` and render the plain-text/anchor fallback when `safe` is empty — mirroring replaceEmojis at :67-69. Gating the raw `src` alone would still let `//host/x` through, since `new URL('//host/x')` throws inside shouldRejectUrl and it returns true only by accident of the catch — so make the absolute-resolution explicit. Separately, delete or fix the dead image branch at :548 (`content[mdLink.start] === '!'` can never be true because MD_LINK_PATTERN starts at `[`), which is why markdown images currently render as links; whichever way that is resolved, the gate above must be in place first. Mobile parity (adding a markdown image renderer to packages/mobile/src/components/NoteContent.tsx) is a separate feature request, not part of this fix.

### ☐ OPEN — RSS favicons the proxy goes out of its way to inline are always discarded by the client's avatar gate
- **area**: `ssrf-network-egress` · **platforms**: web, core · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NoteCard.tsx:598`, `packages/core/src/imageUtils.ts:103`, `packages/core/src/imageProxy.ts:15`, `packages/web/rss-proxy.php:439`
- **detail**: rss-proxy.php performs a second SSRF-validated HTTP fetch per feed request purely to inline `/favicon.ico` as a `data:` URI (lines 434-451). The client reads it into the `feed_icon` tag (NoteCard.tsx:591) and passes it to `optimizeAvatarUrl` (NoteCard.tsx:598) → `shouldRejectUrl(url,'avatar')`, whose second test is `if (type === 'avatar' && u.protocol !== 'https:') return true` (imageUtils.ts:103). A `data:` URL has protocol `data:`, so it is rejected. Verified against the real core module:

  shouldRejectUrl('data:image/x-icon;base64,…','avatar') → true
  shouldRejectUrl('data:image/x-icon;base64,…','media')  → true
  optimizeAvatarUrl('data:image/x-icon;base64,…')        → undefined
  optimizeMediaUrl('data:image/x-icon;base64,…')         → ''

So no RSS feed ever shows a favicon, and the extra outbound fetch (a real SSRF surface, see the favicon-relay finding) buys nothing. The same rejection contradicts imageProxy.ts:15-16 ("data:, blob:, and anything else is returned as-is so we don't break QR codes or generated avatars") and would silently blank any `getPlaceholderAvatar()` output routed through these helpers. Mobile never reads `feed_icon` at all — a further parity gap.
- **failure**: User adds any RSS column. The proxy spends an extra round-trip fetching the site's favicon and returns ~a few KB of base64 in every response; NoteCard passes it to optimizeAvatarUrl, which returns undefined, and the card renders the generic fallback. Net effect: extra latency, extra egress, extra attack surface, zero UI change.
- **fix**: In packages/core/src/imageUtils.ts, short-circuit inert bitmap data URLs at the top of shouldRejectUrl before the protocol test: `if (/^data:image\/(png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);base64,/i.test(url)) return false;` — deliberately excluding image/svg+xml, matching the same exclusion rss-proxy.php:513 already enforces. applyImageProxy (imageProxy.ts:67) already passes non-http(s) URLs through untouched, so no change is needed there. Then either render feed_icon in mobile's NoteCard for parity, or drop the favicon fetch from rss-proxy.php:487-517 entirely — keeping the fetch while discarding the result is the only outcome that is strictly worse than both.

### ☐ OPEN — Blossom server, NWC relay and backup-manifest URLs are scheme-checked only — no private-host gate
- **area**: `ssrf-network-egress` · **platforms**: web, mobile · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useUploadFile.ts:87`, `packages/mobile/src/hooks/useUploadFile.ts:90`, `packages/web/src/hooks/useNwc.tsx:33`, `packages/web/src/components/AdvancedSettings.tsx:726`, `packages/web/src/hooks/useNostrBackup.ts:1398`, `packages/web/src/hooks/useNostrBackup.ts:1672`
- **detail**: Every other outbound-URL class in this codebase runs through `isUnsafeHost`; these don't. (1) kind-10063 Blossom server lists are filtered with `try { return new URL(url).protocol === 'https:'; }` only (useUploadFile.ts:87-89 web, :90-92 mobile) — no `isUnsafeHost`, no credential check, and `BlossomUploader` then sends a *signed* kind-24242 auth event to that origin. (2) `parseNwcUri` accepts any `relay.startsWith('wss://')` (useNwc.tsx:33) instead of the app's own `isSecureRelay`, so `wss://127.0.0.1:4444` is a valid wallet relay. (3) The settings 'add server' handler only prefixes `https://` and calls `new URL()` for well-formedness (AdvancedSettings.tsx:723-731), then `testServer` HEADs it (line 777). (4) Restore fetches `m.blossomUrl` / `cp.blossomUrl` straight from a stored manifest with no validation at all (useNostrBackup.ts:1398, 1672). These are all self-authored or self-entered data, which is why this is low — but they are the paths where a signed event or an encrypted backup blob leaves the device.
- **failure**: A user restores a backup manifest (or has a kind-10063) whose server entry is `https://192.168.1.50/` — perhaps copied from a LAN test rig, perhaps planted while the user's key was briefly exposed. Every subsequent upload sends a signed NIP-98/BUD-01 auth event plus the blob there, and the restore path fetches the encrypted backup from it, with no warning and no gate.
- **fix**: Split by trust source rather than gating all four identically. (a) Untrusted-by-convention sources — gate hard: add `const u = new URL(url); return u.protocol === 'https:' && !isUnsafeHost(u.hostname) && !u.username && !u.password;` to the kind-10063 filter in both useUploadFile files, and validate `m.blossomUrl` / `cp.blossomUrl` plus every `${server}/${hash}` fallback in useNostrBackup (web 1390-1398 / 1663-1672, mobile 799-803, 749-755) with the same helper before `fetch`. (b) parseNwcUri: replace `relay.startsWith('wss://')` with `isSecureRelay(normalizeRelay(relay))` in web useNwc.tsx:32 and mobile useNwc.tsx:38 — this also picks up the credential and length checks, and must go BEFORE mobile's new `registerAuthRelay(parsed.relay)` call. (c) AdvancedSettings `handleAdd` is user-typed, so a hard block would break a legitimately self-hosted LAN Blossom server over https; make it a confirm-then-add warning ("this is a private/loopback address — uploads and encrypted backups will be sent there") instead of a rejection, in both web and mobile. Factor the shared predicate into packages/core/src/blossom.ts (e.g. `isSafeBlossomUrl`) so all five call sites use one implementation.

### ☐ OPEN — hasHtmlContent tag list omits ~15 real HTML tags, letting the user's "Hide HTML" filter and the strip step miss them
- **area**: `xss-sanitization` · **platforms**: core, web, mobile · **verdict**: CONFIRMED
- **files**: `packages/core/src/sanitizeUtils.ts:11`, `packages/core/src/sanitizeUtils.ts:12`, `packages/web/src/pages/MultiColumnClient.tsx:133`, `packages/web/src/pages/MultiColumnClient.tsx:3092`
- **detail**: `HTML_TAG_NAMES` (`packages/core/src/sanitizeUtils.ts:11`) is a hand-maintained alternation feeding `HTML_DETECT_RE = new RegExp('<(' + HTML_TAG_NAMES + ')(\\s|>|/>)', 'i')`. Reading the list, it is missing at minimum: `td`, `th`, `tr`, `q`, `s`, `abbr`, `bdi`, `rp`, `rt`, `samp`, `math`, `marquee`, `blink`, `xmp`, `plaintext`, `listing`, `frame`, `frameset`, `applet`, `keygen`, `image`, `bgsound`, `noembed`, `noframes`. (`tbody`/`thead`/`tfoot`/`colgroup` are present but `tr`/`td`/`th` are not, which is the giveaway that this was assembled by hand.)

Consequences: (a) `SmartNoteContent.tsx:193-194` and `mobile/NoteContent.tsx:583` skip the strip step for those tags, so they render as literal visible text instead of being removed; (b) the separate content filter uses a *different* regex — `const FILTER_HTML_PATTERN = /<\/?[a-z][\s\S]*?>/i` (MultiColumnClient.tsx:133), applied at :3092 — so "Hide HTML" and "strip HTML" disagree about what HTML is. Two regexes, two answers, for the same question.
- **failure**: A spammer posts `<marquee>BUY NOW</marquee>` or a table fragment `<tr><td>…</td></tr>`. `hasHtmlContent` returns false, so no stripping happens and the raw tags are shown to the reader as text. Conversely a note containing only `<td>` is *hidden* by the "Hide HTML" filter (FILTER_HTML_PATTERN matches any `<[a-z]…>`) but *not* stripped when the filter is off — the two code paths classify the same note differently.
- **fix**: Collapse to one predicate in packages/core/src/sanitizeUtils.ts: replace the hand-written alternation with `const HTML_DETECT_RE = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/i`, which still requires a closing `>` (so `<3`, `<Bitcoin` and `<insert name` without a `>` stay safe) but no longer depends on a curated tag list. Export it as `HTML_DETECT_RE` and have packages/web/src/pages/MultiColumnClient.tsx:3092 call the exported `hasHtmlContent` instead of the local `FILTER_HTML_PATTERN` (delete line 133). Note the `<insert name>` false positive is already accepted today by FILTER_HTML_PATTERN, so this only makes the two paths agree rather than introducing new noise.

### ☐ OPEN — RSS feed favicons are always discarded on web — optimizeAvatarUrl rejects the data: URIs the proxy went to trouble to inline
- **area**: `xss-sanitization` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NoteCard.tsx:591`, `packages/web/src/components/NoteCard.tsx:598`, `packages/core/src/imageUtils.ts:103`, `packages/web/rss-proxy.php:451`, `packages/mobile/src/components/NoteCard.tsx`, `packages/mobile/src/hooks/useRssFeed.ts`
- **detail**: `rss-proxy.php` deliberately fetches each feed's `/favicon.ico` server-side and inlines it as a data URI specifically to avoid leaking subscriptions to Google's favicon service:
```php
$result['icon'] = 'data:' . $iconMime . ';base64,' . base64_encode($iconBody);
```
(rss-proxy.php:451). That value is carried into a `feed_icon` tag by `rssItemsToEvents` (`packages/core/src/rss.ts:62`) and read back at `NoteCard.tsx:591`.

But `NoteCard.tsx:598` routes it through the avatar gate:
```ts
const avatarUrl = isDeletedAuthor ? undefined : optimizeAvatarUrl(isRss ? rssFeedIcon : metadata?.picture)
```
and `optimizeAvatarUrl` starts with `if (shouldRejectUrl(url, 'avatar')) return undefined`, whose avatar branch is `if (type === 'avatar' && u.protocol !== 'https:') return true;` (`packages/core/src/imageUtils.ts:103-105`). `new URL('data:image/x-icon;base64,…').protocol` is `'data:'`, so **every** RSS favicon is rejected and `avatarUrl` is always `undefined`. The web CSP already allows `img-src … data:`, so the block serves no purpose here.
- **failure**: User subscribes to any RSS feed. The proxy successfully fetches and base64-inlines the site's favicon (a network round-trip per feed, per fetch). The client throws every one of them away and renders the letter-fallback avatar instead. The privacy feature the proxy implements is dead code on web.
- **fix**: Prefer the narrow fix at packages/web/src/components/NoteCard.tsx:598 — `const avatarUrl = isDeletedAuthor ? undefined : (isRss ? rssFeedIcon : optimizeAvatarUrl(metadata?.picture))` — because rssFeedIcon is produced by our own proxy (MIME-checked, magic-byte-sniffed, SVG-excluded, 64KB-capped) rather than by an untrusted kind-0 author. If you instead relax packages/core/src/imageUtils.ts:100, do NOT blanket-allow `data:`: it would also let any kind-0 `picture` be an arbitrary multi-megabyte data URI that bypasses the image proxy. Gate it as `if (type === 'avatar' && u.protocol !== 'https:' && !/^data:image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|bmp);base64,/i.test(url)) return true;` plus a length cap.

### ☐ OPEN — Markdown link labels can impersonate a different URL with no visible warning
- **area**: `xss-sanitization` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NoteContent.tsx:106`, `packages/web/src/components/InlineLink.tsx:37`, `packages/mobile/src/components/NoteContent.tsx:374`, `packages/web/src/components/NoteContent.tsx`
- **detail**: Web renders markdown links with the label as the only visible text:
```tsx
a: ({ href, children }) => {
  let safe = false
  if (href) { try { safe = ['http:','https:'].includes(new URL(href.trim()).protocol) } catch {} }
  if (!safe) return <span>{ec(children)}</span>
  return <InlineLink url={href!.trim()}>{ec(children)}</InlineLink>
}
```
(NoteContent.tsx:106-115). `InlineLink` renders `<a href={url} target="_blank" rel="noopener noreferrer" title={url}>{children}</a>` (InlineLink.tsx:37-44). The scheme check and `rel` are both correct — the gap is that the real destination appears only in the `title` tooltip (unavailable on touch), and the shield icon next to it renders as a neutral gray `ShieldCheck` when the URL merely has no *tracking parameters*, which reads as "this link is fine".

Mobile deliberately does not do this — `packages/mobile/src/components/NoteContent.tsx:374` emits `{ type: 'text', value: `${mdLink.text} (${mdLink.url})` }`, showing label *and* destination. Since kind-1 notes are plain text by protocol and markdown rendering here is a heuristic guess (`MARKDOWN_INDICATORS_PATTERN`), web is voluntarily creating a link-spoofing surface that the protocol did not require.
- **failure**: Attacker posts `Check your balance at [https://wallet.example.com/login](https://wa11et-example.com/login)`. The note trips the markdown heuristic (the `\[[^\]]+\]\(https?:` indicator), and web renders a purple underlined `https://wallet.example.com/login` that navigates to the attacker's domain. A touch user has no hover tooltip and the shield next to it is the gray "no trackers detected" variant. The same note on mobile displays `https://wallet.example.com/login (https://wa11et-example.com/login)`.
- **fix**: In packages/web/src/components/InlineLink.tsx, compute a label/href host mismatch and surface it in both channels: (1) when the rendered children flatten to a string that parses as a URL (or contains a bare hostname) whose host !== new URL(url).hostname, render the amber ShieldAlert variant with title `Link text does not match destination: <hostname>` instead of the gray 'No known trackers' ShieldCheck; (2) append the true hostname in muted text after the label, mirroring packages/mobile/src/components/NoteContent.tsx:380. Reuse the same helper for the MarkdownImg fallback anchor at packages/web/src/components/NoteContent.tsx:44-48 — better still, route that fallback through InlineLink so it gets the shield/dialog affordance the rest of the links have.

## NIT (21)

### ☐ OPEN — fetchEvent's timestamp map is never trimmed while its event map is LRU-capped — unbounded growth over a session
- **area**: `error-handling-edge` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/lib/fetchEvent.ts:48`, `packages/web/src/lib/fetchEvent.ts:67`, `packages/web/src/lib/fetchEvent.ts:50`, `packages/mobile/src/lib/fetchEvent.ts:41,44-48,59-62 — byte-identical structure: `eventCacheTimestamps` set unconditionally in `setCachedEvent` while `lruSet` bounds only `eventCache`. Same leak, and the finder missed it entirely (they listed only web/desktop, but desktop just runs the web bundle, so mobile is the actual second platform).`
- **detail**: ```ts
const eventCache = new Map<string, NostrEvent>()
const eventCacheTimestamps = new Map<string, number>()
...
export function setCachedEvent(id: string, event: NostrEvent): void {
  lruSet(eventCache, id, event, MAX_EVENT_CACHE)   // capped at 750
  eventCacheTimestamps.set(id, Date.now())          // no cap
}
```
`lruSet` (line 50-54) bounds `eventCache` only. `eventCacheTimestamps` is pruned in exactly one place — `getCachedEvent` (line 57-62), and only for an id that is looked up *after* its TTL expired. An id evicted from `eventCache` by the LRU is never looked up again, so its timestamp entry is permanent.
- **failure**: A long desktop session scrolls through 50,000 notes; each parent/quoted-note fetch calls `setCachedEvent`. `eventCache` stays at 750 entries as designed, while `eventCacheTimestamps` accumulates 50,000 string→number pairs (~4 MB of retained keys) that nothing will ever read or free short of `clearEventCache()`.
- **fix**: Collapse the two maps into one so they cannot diverge — this also removes the `lruSet` generic's implicit assumption that a caller has only one map to bound:
```ts
const eventCache = new Map<string, { event: NostrEvent; ts: number }>()

export function getCachedEvent(id: string): NostrEvent | undefined {
  const hit = eventCache.get(id)
  if (!hit) return undefined
  if (Date.now() - hit.ts > CACHE_TTL_MS) { eventCache.delete(id); return undefined }
  return hit.event
}

export function setCachedEvent(id: string, event: NostrEvent): void {
  lruSet(eventCache, id, { event, ts: Date.now() }, MAX_EVENT_CACHE)
}
```
`clearEventCache` (:71-79) then loses its second `.delete`/`.clear`. If you prefer the minimal change instead, make `lruSet` return the evicted key and have `setCachedEvent` delete it from the timestamp map — but the single-map version is strictly less to keep in sync. Apply the same edit to mobile.

### ☐ OPEN — Custom zap amount is unbounded — large values lose msat precision and serialize to exponential notation in the NIP-57 amount tag
- **area**: `error-handling-edge` · **platforms**: web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/ZapDialog.tsx:36`, `packages/web/src/hooks/useZap.ts:37`, `packages/web/src/hooks/useZap.ts:81`, `packages/mobile/src/components/ZapDialog.tsx:46`, `packages/mobile/src/hooks/useZap.ts:40`, `packages/mobile/src/hooks/useZap.ts:72`
- **detail**: `const effectiveAmount = useCustom ? parseInt(customAmount) || 0 : amount;` (ZapDialog.tsx:36) — the only validation downstream is `if (effectiveAmount <= 0) return;` (line 39). The web input is `type="number"` with no `max` (line 116) and the mobile one is a plain text field, so any magnitude is accepted.

In `useZap`, `const amountMsats = amountSats * 1000;` (line 37) then reaches two string sinks:
```ts
['amount', amountMsats.toString()],
...
let invoiceUrl = `${callback}${separator}amount=${amountMsats}`;
```
Above 9,007,199,254,740 sats the msat value exceeds `Number.MAX_SAFE_INTEGER` and is silently rounded; above 1e18 sats (1e21 msats) `Number.prototype.toString` switches to exponential form, so the tag becomes `['amount','1e+21']` and the query string `amount=1e+21`. The `maxSendable` check at line 56 only fires when the server chooses to advertise that field.
- **failure**: A user fat-fingers a long digit string into the custom-amount box against an LNURL endpoint that omits `maxSendable`. The client signs and publishes a kind-9734 zap request whose `amount` tag is the literal string `1e+21` — invalid per NIP-57, so the receipt is unparseable by every client including this one — and sends `?amount=1e+21` to the callback, which most implementations reject with an opaque error the user cannot act on.
- **fix**: Put one clamp in shared code rather than three copies in UI. Add to packages/core/src/zap.ts: `export const MAX_ZAP_SATS = 100_000_000; export function normalizeZapSats(raw: string | number): number | null { const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10); return Number.isSafeInteger(n) && n > 0 && n <= MAX_ZAP_SATS ? n : null; }`. Use it at all three input sites (web ZapDialog.tsx:36, mobile ZapDialog.tsx:46, mobile NoteActions.tsx:208) and add `max={MAX_ZAP_SATS}` to the web Input at ZapDialog.tsx:121. Then make it unbypassable in both useZap hooks (web useZap.ts:37, mobile useZap.ts:40): `if (!Number.isSafeInteger(amountSats) || amountSats <= 0 || amountSats > MAX_ZAP_SATS) throw new Error('Invalid zap amount');` before computing msats. Separately worth noting while in this code: neither platform confirms before `payInvoice(bolt11)` (web useZap.ts:111), so a fat-fingered extra zero pays for real — a confirm step above some threshold is the higher-value change here.

### ☐ OPEN — NIP-99 image ordering uses a comparator that returns NaN for non-numeric order fields
- **area**: `error-handling-edge` · **platforms**: core, web, mobile, desktop · **verdict**: CONFIRMED
- **files**: `packages/core/src/nip99.ts:73`
- **detail**: ```ts
const imageTags = event.tags.filter(t => t[0] === 'image' && typeof t[1] === 'string' && t[1]);
imageTags.sort((a, b) => (parseInt(a[3] || '0', 10)) - (parseInt(b[3] || '0', 10)));
```
The `order` field is a free-form string from an untrusted kind-30402. `parseInt('first', 10)` is NaN, and `NaN - 0` is NaN — a comparator returning NaN violates the total-order contract, so V8's TimSort produces an implementation-defined permutation (not merely 'unsorted': the result depends on array length and initial order). Note the adjacent `stock` field (line 63) does validate — `/^\d+$/.test(stockStr) ? parseInt(...) : undefined` — so the file already has the right pattern one line up.
- **failure**: A merchant (or an attacker publishing a listing under any pubkey) emits `['image', url1, '', 'a']` and `['image', url2, '', 'b']`. Every comparison yields NaN, the sort scrambles the gallery, and the listing's images render in an arbitrary order that can differ between the storefront view and the detail view for the same event.
- **fix**: Match the `stock` validation pattern already in the same function: `const ord = (t: string[]) => (/^\d+$/.test(t[3] ?? '') ? parseInt(t[3], 10) : Number.MAX_SAFE_INTEGER); imageTags.sort((a, b) => ord(a) - ord(b));`. Note the `|| '0'` in the current code means an *absent* order currently sorts first; sending unordered images to the end is the better behaviour but is a deliberate change — add a case to packages/web/src/test/parseListing.test.ts covering mixed numeric/non-numeric/absent order fields so the chosen semantics are pinned.

### ☐ OPEN — `useCurrentUser`'s module-scoped NUser cache is never cleared and its comment claims otherwise, keeping live signers with raw secret-key bytes after key deletion
- **area**: `key-management-crypto` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useCurrentUser.ts:26`, `packages/web/src/hooks/useCurrentUser.ts:68`, `packages/web/src/hooks/useLoggedInAccounts.ts:58`, `packages/web/src/components/auth/AccountSwitcher.tsx:87`, `packages/web/src/components/NostrProvider.tsx:13`
- **detail**: `useCurrentUser.ts:26` documents the cache as "Cleared on full logout via the size cap" — a size cap is an LRU eviction, not a clear, and there is no exported clear function and no logout hook that touches `_userCache`:

```ts
const _userCache = new Map<string, NUser>();
const USER_CACHE_MAX = 32;
...
if (_userCache.size >= USER_CACHE_MAX) { /* evict oldest */ }
```

Each cached entry for an nsec login holds a signer whose `signerPromise` resolves to an `NSecSigner` constructed from the decoded secret-key bytes (webNsecSigner.ts:37), so the raw key material stays reachable even after `deleteNsec()` has purged both `memNsec` and the IDB record.

In practice every current logout/switch path reloads the page (MultiColumnClient.tsx:806/816, useLoggedInAccounts.ts:81), which is what actually saves this. But `useLoggedInAccounts.removeLogin` (line 58-65) is an exported, documented direct-call path that deletes the key material and does **not** reload — its own comment says "The AccountSwitcher logout fallback calls this directly, bypassing useLoginActions.logoutAccount". The moment anything uses that path (or a future logout drops the reload), a fully signing-capable object for a supposedly-deleted account survives in module scope.
- **failure**: A caller uses `useLoggedInAccounts.removeLogin(id)` instead of `useLoginActions.logoutAccount(pubkey)` — exactly the fallback the comment describes. The IDB record and `memNsec` entry are deleted, the login disappears from the UI, but `_userCache.get('nsec:<pubkey>:<id>')` still returns an NUser whose signer can sign events with the removed account's key for the rest of the page session.
- **fix**: Do the two cheap things and skip the speculative one:

1. Delete the false sentence at useCurrentUser.ts:26 ('Cleared on full logout via the size cap') — it is the actual hazard, because it tells the next reader the cache self-clears on logout when it only LRU-evicts at 32.
2. Export `clearUserCache()` from useCurrentUser.ts and call it from useLoginActions.logoutAccount (right after the `deleteNsec`/`keychainDelete` at useLoginActions.ts:349-350), from nuclearWipe (alongside `clearProfileMemCache()`/`clearNoteCardCache()` at ~:417-420, which are the existing precedent for this exact cleanup), and from useLoggedInAccounts.removeLogin (:58-65).

The finder's third suggestion — a `dispose()` on the web nsec signer that nulls `signerPromise` — is worth doing but note it does NOT zero the key: `NSecSigner` copies the bytes and nothing in @nostrify exposes a wipe, so dropping the reference only makes it GC-eligible. Don't write a comment claiming the key is erased. Also fix AccountSwitcher.tsx:87 to require `onLogout` (make the prop non-optional) so the bypassing fallback path stops existing instead of being patched.

### ☐ OPEN — `STORAGE_KEYS.NWC` is a backed-up key that would export a wallet private key to a plaintext JSON file on disk, and the backup UI copy tells users it does
- **area**: `key-management-crypto` · **platforms**: core, web, mobile · **verdict**: CONFIRMED
- **files**: `packages/core/src/storageKeys.ts:30`, `packages/core/src/storageKeys.ts:170`, `packages/web/src/lib/downloadBackup.ts:83`, `packages/web/src/lib/downloadBackup.ts:109`, `packages/mobile/src/lib/downloadBackup.ts:118`, `packages/web/src/components/BackupDownloadPrompt.tsx:48`
- **detail**: `STORAGE_KEYS.NWC = 'corkboard:nwc'` (storageKeys.ts:30) is listed in `SHARED_BACKED_UP_KEYS` (line 170), so it is in `BACKED_UP_KEYS`, so `serializeSettings()` (downloadBackup.ts:83-92) copies it verbatim into the file written by `downloadSettingsBackup()` — a **plaintext** `corkboards-backup-YYYY-MM-DD.json` on the user's disk. An NWC URI is `nostr+walletconnect://<walletpk>?relay=...&secret=<64-hex>`, and that `secret` is a private key with spend authority, as `useNwc.tsx:29-36` makes explicit (`const secret = hexToBytes(secretHex); const clientPubkey = getPublicKey(secret);`).

Today this is latent rather than live: both `useNwc` implementations keep the URI in React state only (`packages/web/src/hooks/useNwc.tsx:82-83` "NWC URI is kept in React state only — never persisted to localStorage/IDB"; `packages/mobile/src/hooks/useNwc.tsx:5`), and grepping the repo shows nothing writes `corkboard:nwc`. But the key is still in the backup manifest, so any legacy value left in a user's IDB/MMKV from an older build, or any future code that persists the URI, is exported to disk in cleartext with zero further review. The user-facing `info` string in the same file (line 109) already advertises it: "This file contains all your corkboards.me settings: custom feeds, filters, dismissed notes, RSS feeds, **wallet connection**, and display preferences."
- **failure**: A user who connected a wallet on an older build (or on a future build that adds persistence) clicks "Download backup", gets a JSON file containing `"corkboard:nwc": "nostr+walletconnect://...&secret=<spend key>"`, and stores it in Dropbox / emails it to themselves / attaches it to a support request — as the file's own `info` text invites. Anyone who reads that file can drain the connected wallet.
- **fix**: Delete `STORAGE_KEYS.NWC` from SHARED_BACKED_UP_KEYS (packages/core/src/storageKeys.ts:170) — and, since nothing reads or writes it anywhere in the tree or in git history, delete the `NWC: 'corkboard:nwc'` constant at :30 outright rather than leaving an unused key that invites future persistence. Add a short comment where NWC used to live saying the URI is deliberately session-only (mirroring the existing REMOTE_CHECKPOINTS 'intentionally NOT backed up' note at :180-182), so the removal isn't reverted as an oversight.

Drop 'wallet connection' from all four user-facing strings (web and mobile info text + both BackupDownloadPrompt bodies) — that copy is wrong right now regardless of the key.

Skip the finder's suggested startup cleanup for stale `corkboard:nwc` values: git history proves no build ever wrote one. Do keep the deny-list idea, but put it in `serializeSettings()`/`serializeBackup()` as a value-shaped guard (drop any value matching /^nostr\+walletconnect:\/\//i or /(^|[?&])secret=/i, log once in DEV) — that is the part that actually prevents a future key from reintroducing the class of bug.

### ☐ OPEN — useLocalStorage's DeviceEventEmitter subscription is torn down and re-added on every render when the default value is an inline literal
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/hooks/useLocalStorage.ts:66`, `packages/mobile/src/hooks/useLocalStorage.ts:78`, `packages/mobile/src/screens/HomeScreen.tsx:108`, `packages/mobile/src/components/ProfileModal.tsx:138`, `packages/web/src/hooks/useLocalStorage.ts:~97 — identical `}, [key, defaultValue]);` on the 'idb-storage-sync' listener effect (the finder missed the web copy entirely, and CLAUDE.md requires parity)`, `packages/web/src/pages/MultiColumnClient.tsx:1113,1116,1130 — inline `[]` defaults driving that web effect`
- **detail**: `useLocalStorage`'s cross-component sync effect lists `defaultValue` in its dependency array:
```ts
useEffect(() => {
  const sub = DeviceEventEmitter.addListener(SYNC_EVENT, (e) => { ... });
  return () => sub.remove();
}, [key, defaultValue, deserialize]);   // useLocalStorage.ts:78
```
Two call sites pass a freshly-allocated array literal, so `defaultValue` has a new identity on every render:
- `HomeScreen.tsx:108`: `useLocalStorage<CustomFeed[]>('nostr-custom-feeds', [])`
- `ProfileModal.tsx:138`: `useLocalStorage<Array<{...}>>('nostr-custom-feeds', [])`

HomeScreen re-renders very frequently (feed query updates, autofetch ticks, scroll state, filter changes), and each render pays a `sub.remove()` + `DeviceEventEmitter.addListener()` pair. Worse, there is a window between removal and re-add during which a `mobile-storage-sync` emit for `nostr-custom-feeds` is dropped — which is the exact scenario this mechanism exists to handle (ProfileModal creating a corkboard while HomeScreen is mounted).
- **failure**: User opens ProfileModal and taps "Open in new corkboard", which calls `setCustomFeeds` and emits `mobile-storage-sync` for `nostr-custom-feeds`. If HomeScreen happens to be mid-render (it re-renders continuously while its feed query settles), its listener is unsubscribed at that instant and the emit is lost — the new corkboard tab does not appear until something else forces HomeScreen to re-read MMKV.
- **fix**: packages/mobile/src/hooks/useLocalStorage.ts: keep `defaultValue`/`deserialize` in refs and narrow the effect to `}, [key]);`:
```ts
const defaultRef = useRef(defaultValue); defaultRef.current = defaultValue;
const deserializeRef = useRef(deserialize); deserializeRef.current = deserialize;
// inside listener: const next = raw ? deserializeRef.current(raw) : defaultRef.current;
```
Optionally hoist the two `[]` literals to module constants at HomeScreen.tsx:108 and ProfileModal.tsx:138. Do NOT justify this as a fix for dropped sync events — no event can be dropped; justify it as removing per-render subscription churn and a stale-deps hazard. Apply the identical narrowing to the web copy for parity.

### ☐ OPEN — usePlatformStorage performs two synchronous MMKV reads plus a JSON.parse on every render
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/src/hooks/usePlatformStorage.ts:16`, `packages/mobile/src/screens/HomeScreen.tsx:223`, `packages/mobile/src/screens/HomeScreen.tsx:224`, `packages/web/src/hooks/usePlatformStorage.ts:25-41 — byte-for-byte the same IIFE-in-render pattern with idbGetSync instead of mobileStorage.getSync; the finder audited only mobile`, `packages/mobile/src/hooks/useFeedLimit.ts:8 and packages/mobile/src/screens/SettingsScreen.tsx:65,71 — additional consumers paying the same per-render cost`
- **detail**: The legacy-key migration in `usePlatformStorage` is an IIFE evaluated in the render body, not a `useMemo` / `useState` initializer:
```ts
const migratedDefault = (() => {
  const existing = mobileStorage.getSync(prefixedKey);   // read 1, every render
  if (existing !== null) return defaultValue;
  const legacy = mobileStorage.getSync(baseKey);         // read 2, every render
  if (legacy !== null) { ... deserialize(legacy) ... }   // JSON.parse, every render
  return defaultValue;
})();
```
It only ever matters on the very first mount (once the prefixed key exists, the result is always `defaultValue`), yet it runs on every single render of every consumer.

HomeScreen instantiates it twice (lines 223-224) and re-renders on every feed query settle, autofetch tick, scroll-state flip and filter change. Combined with the finding above, `migratedDefault` is also the value passed as `useLocalStorage`'s `defaultValue`, so for any non-primitive `T` it would additionally churn the sync subscription.
- **failure**: During an active feed session HomeScreen renders dozens of times per second while notes stream in; each render performs 4 extra synchronous MMKV `getString` calls (2 hooks × 2 reads) that can never change their answer. On the JS thread during scroll this is pure added frame cost for zero benefit.
- **fix**: Prefer `useMemo` over `useState` here — `useState(() => ...)` would silently pin the value if `baseKey` ever varies for a given mount:
```ts
const migratedDefault = useMemo(() => { /* same body */ }, [prefixedKey, baseKey, defaultValue]);
```
If `defaultValue` is an inline literal at any call site, keep it out of the dep array and read it from a ref, otherwise the memo never hits. Apply the same change to the web copy.

### ☐ OPEN — Jest mock for react-native-mmkv exports a class that no longer matches the v4 API the code imports
- **area**: `perf-mobile-rn` · **platforms**: mobile · **verdict**: CONFIRMED
- **files**: `packages/mobile/__mocks__/react-native-mmkv.ts:2`, `packages/mobile/src/storage/MmkvStorage.ts:27`, `packages/mobile/jest.config.js:5`
- **detail**: `MmkvStorage.ts:27` imports the v4 factory API:
```ts
import { createMMKV, type MMKV } from 'react-native-mmkv';
```
(confirmed against `node_modules/react-native-mmkv/src/index.ts:6` — `export { createMMKV } from './createMMKV/createMMKV'`, package version 4.3.0).

But `packages/mobile/__mocks__/react-native-mmkv.ts` only exports the pre-v4 class:
```ts
export class MMKV {
  getString(key) {...}
  set(key, value) {...}
  delete(key) {...}      // ← also wrong: MmkvStorage calls mmkv.remove(), not .delete()
  clearAll() {...}
  getAllKeys() {...}
}
```
There is no `createMMKV` export, so any test that transitively imports `MmkvStorage` gets `createMMKV is not a function` at module-eval time — which would also swallow the module-eval fallback path at MmkvStorage.ts:181-196. The mock's `delete` vs the code's `remove` is a second mismatch.

Today this is latent: the only two test files are `src/__tests__/core-imports.test.ts` and `src/__tests__/core-parity.test.ts`, and neither touches MmkvStorage. But `npm test` in packages/mobile runs `jest`, so the first storage test anyone writes fails for an unrelated reason.
- **failure**: A developer adds `src/storage/MmkvStorage.test.ts` (or any component test that renders a screen). Jest auto-uses the `__mocks__` folder for the node_modules package, `createMMKV` resolves to `undefined`, and the module body throws `TypeError: (0 , _reactNativeMmkv.createMMKV) is not a function` before any assertion runs.
- **fix**: Rewrite `packages/mobile/__mocks__/react-native-mmkv.ts` to export `createMMKV(config: { id: string; encryptionKey?: string })` returning a per-`config.id` object with `getString`/`set`/`remove`/`clearAll`/`getAllKeys` (keying the backing Map by `config.id` so the encrypted vs legacy instances are distinguishable and the legacy->encrypted migration is testable), keep `export type MMKV` for the `import type` site, and add `existsMMKV`/`deleteMMKV` no-ops since react-native-mmkv v4 also exports those. Note the failure mode is silent, not loud: `MmkvStorage.ts:180-196` swallows the TypeError and installs an in-memory Map, so a naive storage test would green up without touching the mock at all — assert on `mmkvInitFailed === false` in any such test.

### ☐ OPEN — contacts.includes() used as a per-note membership test in the discover path — O(notes × contacts)
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/NoteCard.tsx:814`, `packages/web/src/components/NoteCard.tsx:1126`, `packages/web/src/pages/MultiColumnClient.tsx:1924`, `packages/web/src/pages/MultiColumnClient.tsx:1926`, `packages/web/src/pages/MultiColumnClient.tsx:1930`, `packages/web/src/components/ProfileModal.tsx:379`
- **detail**: `NoteCard` does a linear scan of the whole contact list twice per render in discover mode:
```ts
const isFollowedActivityInDiscover = discoverMode && (isRepost || isReaction)
  && profileModalState.contacts.includes(note.pubkey);            // :814
...
{!profileModalState.contacts.includes(discoverFeaturedPubkey) && (   // :1126 — the Follow button
```
The `stableDiscoverNotes` append effect does up to three scans per candidate note:
```ts
if ((n.kind === 6 || n.kind === 16) && contacts?.includes(n.pubkey)) { ... }   // :1924
} else if ((n.kind === 7 || n.kind === 9735) && contacts?.includes(n.pubkey)) { ... }  // :1926
if (contacts?.includes(featuredPubkey)) continue;                              // :1930
```
`profileModalState.contacts` is a plain array (see the assignment in MultiColumnClient), never a Set.
- **failure**: A user following 1,500 npubs on the discover tab with 300 rendered discover cards: 300 × 2 × 1,500 = 900,000 string comparisons per discover-feed render just for the follow-state checks, plus up to 500 × 3 × 1,500 = 2.25M comparisons each time `discoveredNotes` changes and the append effect re-runs.
- **fix**: Two parts. Perf (nit): in MultiColumnClient hoist `const contactsSet = useMemo(() => new Set(contacts ?? []), [contacts])` above the effect at :1917 and use `.has()` at :1924/:1926/:1930 — note the effect's dep array is `[isDiscoverTab, isOnboarding ? mergedDiscoverNotes : discoveredNotes]` with an eslint-disable, so adding contactsSet there needs care (it is intentionally excluded to avoid reprocessing). Correctness (the part worth shipping): stop reading `profileModalState.contacts` during NoteCard render. Pass the follow-set down as a prop (or a small context holding `Set<string>`) so following someone in discover immediately re-renders the card, and use `.has()` there. Same singleton read exists in ProfileModal.tsx:379.

### ☐ OPEN — useAuthor sets gcTime to 48 hours, so the React-Query cache retains every profile ever fetched for the whole session
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useAuthor.ts:155`, `packages/web/src/hooks/useAuthor.ts:48`, `packages/web/src/App.tsx:29`, `packages/mobile/src/hooks/useAuthor.ts:133`
- **detail**: ```ts
staleTime: (query) => (query.state.data?.metadata ? STALE_TIME : 120_000),
gcTime: CACHE_MAX_AGE,     // useAuthor.ts:155 — CACHE_MAX_AGE = PROFILE_TTL_MS = 48h (:48)
```
This overrides the app-wide `gcTime: 10 * 60 * 1000` set in `App.tsx:29` with a value that, in practice, means "never collect". `useBulkAuthors.prefetchAuthors` additionally writes `queryClient.setQueryData(['author', pubkey], {metadata, event})` for up to `MAX_PREFETCH = 500` pubkeys per call (useBulkAuthors.ts:17, :60, :91), and `extractPubkeys` adds every `p`-tagged pubkey, not just note authors (useBulkAuthors.ts:24-35).

The stored value includes the full kind-0 `event` (content + tags + sig).
- **failure**: A browsing session that spans the all-follows tab (2,000 authors prefetched), several corkboards, discover, and a few threads accumulates 8,000+ `['author', pk]` entries, each holding a kind-0 event (~600 B–2 KB with a long `about`). That is 5-15 MB of query cache that is never released for 48 h, on top of the IndexedDB copy in `cacheStore` and the third copy in `profileCache`. On a memory-constrained mobile browser or a Tauri webview this is a straightforward path to eviction/OOM after a long session.
- **fix**: If you want the retention cut, do it knowingly: set `gcTime` to ~30 min (matching useFollowNotesCache.ts:140) rather than PROFILE_TTL_MS, and accept that a collected entry re-runs useAuthor's queryFn, which hits cacheStore.getCachedProfile — an ASYNC IDB read whose 200-entry mem cache (cacheStore.ts:53) will usually miss on scroll-back, so the card renders `genUserName(pubkey)` for a frame before the name/avatar pop in. That flicker is exactly what the tuning comment at useAuthor.ts:148-153 was fighting. Cheaper mitigation with no UX cost: raise cacheStore's MEM_CACHE_MAX_SIZE so re-hydration is synchronous-ish, and apply whatever gcTime you pick to BOTH packages/web/src/hooks/useAuthor.ts:155 and packages/mobile/src/hooks/useAuthor.ts:133 so the platforms stay identical. Do not strip `event` from the query value.

### ☐ OPEN — StatusBar receives a freshly-allocated stats object computed by an O(n) inline IIFE on every MultiColumnClient render
- **area**: `perf-web` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/pages/MultiColumnClient.tsx:4479`, `packages/web/src/components/StatusBar.tsx:53`
- **detail**: ```tsx
indexedDbStats={isNotificationsTab ? notifStats : (() => {
  const visible = notes.length;
  const dismissed = deduplicatedNotes.filter(n => isDismissed(n.id)).length;   // :4481 — O(n) scan
  const filtered = hasActiveFilters ? Math.max(0, deduplicatedNotes.length - notes.length - dismissed) : 0;
  const total = visible + dismissed + filtered;
  return { total, visible, dismissed, filtered };
})()}
```
`StatusBar` is a plain function component (`export function StatusBar(...)`, StatusBar.tsx:53) with no memo, so the fresh object would not have helped anyway — but the O(n) `filter` runs unconditionally on every parent render, including the ones driven by StatusBar's own 1-second autofetch countdown interval (StatusBar.tsx:113) via `lastAutofetchTime`.
- **failure**: With 3,000 notes in `deduplicatedNotes` and autofetch on, the `isDismissed` scan runs on every parent render — and `isDismissed` is itself a `useCallback` whose identity changes with the dismissed Set, so nothing caches it. Each dismiss triggers a re-render that re-scans all 3,000 notes.
- **fix**: Keep the mechanical fix, drop the justification. Hoist to `useMemo(() => { ... }, [deduplicatedNotes, notes.length, isDismissed, hasActiveFilters])` — worth it mostly for readability and so the object identity is stable enough for a future `React.memo(StatusBar)` to bail. Note that memoizing the object alone buys nothing today: StatusBar also receives fresh inline arrows at MultiColumnClient.tsx:4493-4500 (`onToggleAutofetch`, `onToggleAutoConsolidate`, `onToggleAutoScrollTop`, `onToggleLoadAllMedia`) and :4472-4473 (`onSave`, `onRestore`), so `React.memo` would never bail until all of those become `useCallback`s — do the whole set or none. Better still: the dismissed count is already derivable inside the existing memo at :2973-3136 that walks `deduplicatedNotes` with `isDismissed`; return it from there instead of adding a second pass.

### ☐ OPEN — useCustomFeed.ts is dead code — nothing imports it
- **area**: `perf-web` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useCustomFeed.ts:28`, `packages/mobile/src/hooks/useCustomFeed.ts:112`
- **detail**: `export function useCustomFeed(...)` (useCustomFeed.ts:28) has no callers anywhere in `packages/web/src` — the feed path uses `useCustomFeedNotesCache` (imported at `MultiColumnClient.tsx:20`). The dead hook also embeds a pattern worth not resurrecting: its query key spreads whole arrays (`feed?.pubkeys`, `feed?.relays`, `feed?.rssUrls` at :43-45), which TanStack must JSON-hash on every render — for a 500-npub corkboard that is a ~32 KB stringify per render.
- **failure**: No runtime impact today (rollup tree-shakes an unimported module), but the file is 125 lines of maintained-looking code that will mislead the next person and would reintroduce the per-render key-hash cost if wired up.
- **fix**: Delete packages/web/src/hooks/useCustomFeed.ts outright — all three of its exports (useCustomFeed, CustomFeedDef, UseCustomFeedOptions) are unreferenced, so nothing needs to be salvaged or folded anywhere. Then apply the cross-platform half: packages/mobile/src/hooks/useCustomFeed.ts has the identical dead `useCustomFeed` hook (:112) with the identical array-spreading query key (:127-131, `feed?.pubkeys`/`feed?.relays`/`feed?.rssUrls`) and it too has no callers — but that file CANNOT be deleted, because it re-exports `batchFetchByAuthors` at :221, which useCustomFeedNotesCache.ts:10 and useCustomFeedNotes.ts:15 both import. So on mobile, delete only the `useCustomFeed` function and the now-orphaned `UseCustomFeedOptions` interface and keep the module as the `batchFetchByAuthors` host (or better, move `batchFetchByAuthors` into a `feedUtils` module mirroring web's @/lib/feedUtils and delete useCustomFeed.ts there too, closing the naming divergence between the platforms). Desktop needs no change — it runs the same web bundle. If a lint gate is wanted to prevent recurrence, the eslint config in packages/web/eslint.config.js is the place for an unused-export rule.

### ☐ OPEN — Cross-tab storage sync bypasses the caller's custom deserializer and has no try/catch, so AppProvider's Zod validation is skipped for values arriving via BroadcastChannel
- **area**: `react-correctness` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useLocalStorage.ts:91`, `packages/web/src/hooks/useLocalStorage.ts:93`, `packages/web/src/lib/idb.ts:233`, `packages/web/src/lib/idb.ts:348`, `packages/web/src/components/AppProvider.tsx:44`, `packages/web/src/components/AppProvider.tsx:83`
- **detail**: `idb.ts` always parses with plain `JSON.parse` before dispatching:

```ts
// idb.ts:259-261
function tryParse(value: string): unknown { try { return JSON.parse(value) } catch { return value } }
// idb.ts:233 (own write) and :348 (cross-tab BroadcastChannel 'set')
dispatchSyncEvent(key, tryParse(value));
```

and `useLocalStorage`'s handler assigns that raw value straight to state, ignoring the `deserialize` the caller supplied and with no error handling:

```ts
// useLocalStorage.ts:91-96
const handleSync = (e: CustomEvent<{ key: string; value: unknown }>) => {
  if (e.detail.key !== key) return;
  const next = (e.detail.value === null ? defaultValue : e.detail.value) as T;
  stateRef.current = next;
  setState(next);
};
```

The only caller with a non-default deserializer is AppProvider, whose deserializer is the app-config validator:

```ts
// AppProvider.tsx:44-47
deserialize: (value: string) => { const parsed = JSON.parse(value); return AppConfigSchema.partial().parse(parsed); }
```

So the mount path and the `idbReady` re-read path (useLocalStorage.ts:54) are Zod-validated, but the cross-tab path is not — the two ways into the same state have different trust levels. The downstream `useApplyTheme` does `root.classList.add(theme)` with whatever string arrives (AppProvider.tsx:85).
- **failure**: A second same-origin tab running an older build (or any script that calls `idbSetSync('corkboard:app-config', ...)`) writes `{"theme":"neon"}`. The BroadcastChannel handler at idb.ts:348 dispatches it; the live tab's `handleSync` sets `config.theme = 'neon'` without validation; `useApplyTheme` removes both `light` and `dark` classes and adds `neon`, leaving the app rendered with no theme class at all until reload. A malformed non-object value would likewise land in state and crash the `{...defaultConfig, ...rawConfig}` spread consumers rather than being caught, because unlike the mount path there is no surrounding try/catch.
- **fix**: Carry the raw serialized string on the sync event instead of a pre-parsed value: change dispatchSyncEvent (idb.ts:49) to take `string | null` and drop tryParse at :233, :249 and :348. Then in useLocalStorage.ts:91-96: `try { const next = raw === null ? defaultValue : deserialize(raw); stateRef.current = next; setState(next); } catch (e) { console.warn(`Ignoring invalid synced ${key}`, e); }` — so mount, idbReady, own-write echo and cross-tab all funnel through one validator. If idb.ts must stay untouched, the minimal version is `deserialize(JSON.stringify(e.detail.value))` inside the same try/catch.

### ☐ OPEN — ErrorBoundary's DOM-error auto-recovery setTimeout is never cleared, causing setState on an unmounted boundary
- **area**: `react-correctness` · **platforms**: web, desktop · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/ErrorBoundary.tsx:23`, `packages/web/src/components/ErrorBoundary.tsx:29`
- **detail**: ```ts
componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
  console.error('ErrorBoundary caught error:', error, errorInfo)
  const isDomError = error.name === 'NotFoundError' || error.message?.includes('removeChild')
  if (isDomError) {
    setTimeout(() => this.setState({ hasError: false, error: null }), 100)   // :29
  }
}
```

The timer handle is not stored and there is no `componentWillUnmount`. The very errors it targets — Radix portal cleanup races producing `NotFoundError`/`removeChild` — typically occur while the subtree is being torn down, which is exactly when the boundary itself is most likely to unmount within the 100 ms window (e.g. the `key={activeTab}` boundary at MultiColumnClient.tsx:4230 during a tab switch, or the conditionally-mounted compose boundary at :4571 which unmounts on `closeCompose`).
- **failure**: A Radix dialog unmount throws `NotFoundError`; the compose ErrorBoundary at MultiColumnClient.tsx:4571 catches it and schedules the 100 ms recovery. The user closes the dialog within that window, so `(isComposeOpen || !!composeRepostEvent)` goes false and the boundary unmounts. The timer still fires `this.setState` on the detached instance — a no-op in React 18 but a leaked timer per occurrence, and a latent bug if the recovery logic is ever extended to touch external state.
- **fix**: Store the handle and clear it on unmount, and bound the retries so a persistent NotFoundError cannot spin at 10 Hz:

  private recoveryTimer?: ReturnType<typeof setTimeout>
  private recoveryAttempts = 0

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo)
    const isDomError = error.name === 'NotFoundError' || error.message?.includes('removeChild')
    if (isDomError && this.recoveryAttempts < 3) {
      this.recoveryAttempts++
      this.recoveryTimer = setTimeout(() => this.setState({ hasError: false, error: null }), 100)
    }
  }

  componentWillUnmount() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
  }

Also reset this.recoveryAttempts = 0 in the manual 'Try again' onClick at :44 so a user-initiated retry is never blocked by the cap. No mobile change needed (its ErrorBoundary has no timer); desktop inherits the web fix.

### ☐ OPEN — sign_event truncates kind with `as u16` and silently drops non-string tag elements, signing an event that differs from what was requested
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: CONFIRMED
- **files**: `packages/desktop/src-tauri/src/signer.rs:31`, `packages/desktop/src-tauri/src/signer.rs:41`, `packages/desktop/src-tauri/src/signer.rs:59`
- **detail**: Three unchecked conversions in the signing path:

1. `let kind = unsigned.get("kind").and_then(|v| v.as_u64()).ok_or("missing kind")? as u16;` — an out-of-range kind wraps silently. 65536 -> 0 (profile metadata), 70000 -> 4464.
2. Tag parsing uses `inner.iter().filter_map(|x| x.as_str().map(str::to_string))`, which *removes* non-string elements rather than rejecting them. A tag `[1, "e", "<id>"]` becomes `["e", "<id>"]` — a valid but completely different tag. `["expiration", 1700000000]` (number) becomes `["expiration"]`, silently stripping the expiry.
3. `Timestamp::from_secs(secs)` accepts any `u64` with no sanity bound.

The key property being violated is that the user (or a caller) asks for one event and gets a signed, published, non-repudiable *different* event under their identity. Today `tauriSigner.ts` always passes `string[][]` and in-range kinds, so this is defence-in-depth — but it is the one command that produces an artifact the user cannot retract.
- **failure**: Any future caller (or a bug in event-template construction) passes `kind: 65536`. Rust signs and returns a kind-0 event; the app publishes it and the user's profile metadata is overwritten with the content of whatever they were trying to post. No error is raised anywhere.
- **fix**: signer.rs:31 — `let kind = u16::try_from(unsigned.get("kind").and_then(|v| v.as_u64()).ok_or("missing kind")?).map_err(|_| "kind out of range")?;`. signer.rs:46 — fail closed instead of filtering: `let parts: Vec<String> = inner.iter().map(|x| x.as_str().map(str::to_string).ok_or("tag elements must be strings")).collect::<Result<_, _>>()?;`, and turn the `if !parts.is_empty()` guard at signer.rs:53 into an explicit `return Err("empty tag")` so a fully-dropped tag can't pass silently. Do NOT add the created_at bound — created_at is legitimately caller-controlled and a 15-minute future clamp is an invented policy with no protocol basis; leave signer.rs:59-62 alone.

### ☐ OPEN — Every event is Schnorr-verified twice (Rust then JS) and cloned three times on the way through
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: UNVERIFIED
- **files**: `packages/desktop/src-tauri/src/relay.rs:236`, `packages/desktop/src-tauri/src/relay.rs:447`, `packages/web/src/lib/tauri.ts:181`, `packages/web/src/lib/tauri.ts:322`
- **detail**: `is_authentic_event` does `serde_json::from_value::<nostr::Event>(value.clone())` then `event.verify()` — which I confirmed checks both the id hash and the signature (nostr-0.44.3/src/event/mod.rs:160-180). The same event is then serialized to JSON, sent over IPC, and verified a second time in JS by `verifyEvent` from `nostr-tools/pure` (tauri.ts:181 in `tauriQuery`, tauri.ts:322 in `tauriRelayQuery`).

Per event that is two secp256k1 verifications (~60-100 µs each) plus three copies of the payload: `value.clone()` into `from_value`, `arr[2].clone()` into `events`, and the JSON re-serialization for the emit. For a 1000-event feed page that is ~200 ms of pure redundant signature math on the tokio workers plus the main thread. Both checks were added deliberately (the comments explain each), so this is a note about the cost, not an argument to remove either.
- **failure**: Loading a 1000-event page costs roughly double the necessary verification time; on a low-power laptop this is a visible delay before the column paints, and the Rust half runs unyielded on a tokio worker so other relay tasks are starved during it.
- **fix**: Keep the Rust verification (it is the transport-layer boundary) and drop the JS re-verification for events that arrive over the Tauri bridge, since they cannot reach JS without passing `is_authentic_event`. Avoid the clone by parsing into an owned value: iterate the array with `into_iter()` on an owned `Vec<Value>` so `arr[2]` can be moved rather than cloned. If both verifications are kept for defence-in-depth, at least add a `tokio::task::yield_now().await` every N events in `run_query` so the worker is not monopolized.

### ☐ OPEN — run_query never sends a NIP-01 CLOSE before tearing down the socket
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: UNVERIFIED
- **files**: `packages/desktop/src-tauri/src/relay.rs:416`, `packages/desktop/src-tauri/src/relay.rs:460`
- **detail**: `run_query` sends `["REQ", "q", filter]` and, on exit from the read loop (EOSE, CLOSED, cap, or error), goes straight to `let _ = ws.close(None).await;`. NIP-01 says a client that is done with a subscription should send `["CLOSE", "q"]`. Dropping the TCP connection works in practice, but relays that track subscription lifetimes see an abandoned REQ rather than a clean teardown, and some log it as a client error. It also means the relay may continue matching and buffering for that subscription until it notices the socket is gone.

Related: the hardcoded subscription id `"q"` means this connection can only ever carry one REQ — which is fine today only because there is no connection reuse (see the pooling finding). Any future pooling work needs unique ids anyway.
- **failure**: Cosmetic on the client side; on the relay side each query leaves a briefly-orphaned subscription. On a relay that enforces a per-connection subscription limit, rapid reconnects from the same IP can trip rate limiting sooner than they should.
- **fix**: Before `ws.close(None)`, send `let _ = ws.send(Message::Text(serde_json::json!(["CLOSE", "q"]).to_string())).await;`. When adding connection pooling, replace `"q"` with a per-request unique id and route incoming frames by that id.

### ☐ OPEN — lib.rs run() ends in .expect(), turning any runtime-init failure into a panic with no user-visible diagnostic
- **area**: `rust-tauri` · **platforms**: desktop · **verdict**: UNVERIFIED
- **files**: `packages/desktop/src-tauri/src/lib.rs:90`, `packages/desktop/src-tauri/src/lib.rs:68`
- **detail**: `.run(tauri::generate_context!()).expect("error while running tauri application")` — this is the Tauri scaffold default and is the only panic site in the crate (I grepped: the sole other `unwrap`/`expect` is `lock()`'s deliberate `unwrap_or_else(|e| e.into_inner())` poison recovery in proxy.rs:47, which is correct). Because `main.rs:1` sets `windows_subsystem = "windows"` in release, there is no console attached on Windows, so the panic message goes nowhere and the user sees the process vanish with no window and no error.

Same class of issue at line 68: `builder.build()?` propagates out of `setup()`, which Tauri turns into a failed startup — again silent on Windows.
- **failure**: On Windows, a WebView2 runtime that is missing or too old makes `build()`/`run()` return an error. The user double-clicks Corkboards.exe, nothing happens, and there is no log file yet (write_log is only reachable once the webview is up) and no message box.
- **fix**: Replace `.expect(...)` with an explicit `if let Err(e) = … { eprintln!("{e}"); /* and on Windows, MessageBoxW or tauri::api::dialog::blocking::message */ std::process::exit(1); }`. Have the same handler catch the `setup()` error so both startup failure modes surface something the user can act on.

### ☐ OPEN — Zap callback URL concatenation ignores a fragment, silently dropping the amount
- **area**: `ssrf-network-egress` · **platforms**: web, mobile · **verdict**: CONFIRMED
- **files**: `packages/web/src/hooks/useZap.ts:68`, `packages/mobile/src/hooks/useZap.ts:71`
- **detail**: `const separator = callback.includes('?') ? '&' : '?'; let invoiceUrl = `${callback}${separator}amount=${amountMsats}`;` — string concatenation with no URL parsing. If the LNURL server's `callback` carries a fragment (`https://host/cb#x`), the result is `https://host/cb#x?amount=…&nostr=…`, where everything after `#` is the fragment and is never transmitted. The server sees a bare `/cb` with no amount and no zap request. The same code also can't spot a callback that already contains `amount=`.
- **failure**: An LNURL provider returns `callback: "https://pay.example/lnurlp/alice#v2"`. The client builds a URL whose query string is entirely inside the fragment, the provider returns an error or an amount-less invoice, and the user sees 'No invoice returned from LNURL service' with no way to diagnose it.
- **fix**: Parse once and mutate, in both hooks identically: `const u = new URL(callback); u.hash = ''; u.searchParams.set('amount', String(amountMsats));` then, in the NIP-57 branch, `u.searchParams.set('nostr', JSON.stringify(zapRequest));` and in the comment branch `u.searchParams.set('comment', comment.slice(0, commentAllowed));`, finishing with `const invoiceUrl = u.toString();`. Clearing `u.hash` (rather than preserving it) is deliberate — LUD-06 has no use for a fragment and it can never reach the server anyway. Using `set` also fixes the second half of the finding: a callback that already carries `amount=` is overwritten instead of duplicated. Note `invoiceUrl` must become a `const`/rebuilt value; the current `let` + `+=` pattern disappears.

### ✅ FIXED — Web and mobile sanitizers disagree: DOMPurify silently deletes text content of forbidden containers that mobile's regex keeps
- **area**: `xss-sanitization` · **platforms**: web, mobile · **verdict**: CONFIRMED
- **files**: `packages/web/src/lib/sanitize.ts:14`, `packages/mobile/src/lib/sanitize.ts:8`, `packages/web/src/components/SmartNoteContent.tsx:194`, `packages/mobile/src/components/SmartNoteContent.tsx:68`, `packages/mobile/src/components/NoteContent.tsx:583`, `packages/web/src/components/ProfileAbout.tsx:22`
- **detail**: There are three different "strip HTML" implementations for the same untrusted data:
1. `packages/web/src/lib/sanitize.ts:14` — `DOMPurify.sanitize(html, { ALLOWED_TAGS: [], KEEP_CONTENT: true })`. Used only by `SmartNoteContent.tsx:194`.
2. `packages/mobile/src/lib/sanitize.ts:8` — a regex `.replace(/<[^>]*>/g, '')` plus manual entity decoding.
3. Ad-hoc inline `about.replace(/<[^>]*>/g, '')` in `packages/web/src/components/ProfileAbout.tsx:22`, `packages/mobile/src/components/ProfileAbout.tsx:28`, and `packages/mobile/src/components/NoteContent.tsx:584`.

DOMPurify's `DEFAULT_FORBID_CONTENTS` (verified at `node_modules/dompurify/dist/purify.cjs.js:578`) is `['annotation-xml','audio','colgroup','desc','foreignobject','head','iframe','math','mi','mn','mo','ms','mtext','noembed','noframes','noscript','plaintext','script','style','svg','template','thead','title','video','xmp']`, and `KEEP_CONTENT` is only honoured for tags *not* in that set (`purify.cjs.js:1059`: `if (KEEP_CONTENT && !FORBID_CONTENTS[tagName])`). So on web the inner text of those elements is destroyed, while mobile's regex keeps it. DOMPurify additionally decodes HTML entities as a side effect of DOM parsing, so `&lt;b&gt;` becomes `<b>` on web but stays `&lt;b&gt;`→`<b>` (via the manual replace) on mobile with different handling of e.g. `&#39;`.

No XSS today — nothing on either platform renders the result as markup (react-markdown converts `raw` hast nodes to text at `node_modules/react-markdown/lib/index.js:360-367` since `rehype-raw` is not installed) — but this is a real content-loss bug on web and squarely violates the cross-platform-parity rule in CLAUDE.md.
- **failure**: A user posts `<template>Here is my whole announcement about the meetup</template>` or `<video>watch the clip below</video>` or `<thead>Q3 numbers</thead>`. `hasHtmlContent` fires (all three tags are in HTML_TAG_NAMES), web routes through DOMPurify, and the entire body text is deleted — the note renders as an empty card. The identical note on mobile renders the full text. Same divergence for `<style>`, `<title>`, `<xmp>`, `<plaintext>`, `<math>`, `<svg>`.
- **fix**: Add `FORBID_CONTENTS: []` is NOT the right fix — that would make web KEEP `<script>alert(1)</script>` body text, contradicting the documented contract in packages/web/src/lib/sanitize.ts:19 ('script/style bodies are dropped rather than kept as text'). Instead align the two drop-lists: pass `FORBID_CONTENTS` explicitly set to core's `VOID_CONTENT_ELEMENTS.split('|')` so DOMPurify drops exactly the same 9 elements' contents that `htmlToPlainText` does, and export that array from packages/core/src/sanitizeUtils.ts as the single source of truth. Add a shared test table asserting web `sanitizeHtml` and core `htmlToPlainText` return identical strings for a fixed input set.

### ✅ FIXED — Web ProfileCard renders the raw `about` field instead of the ProfileAbout component used everywhere else
- **area**: `xss-sanitization` · **platforms**: web · **verdict**: CONFIRMED
- **files**: `packages/web/src/components/ProfileCard.tsx:344`, `packages/web/src/components/ProfileModal.tsx:264`, `packages/mobile/src/screens/ProfileScreen.tsx:268`, `packages/mobile/src/components/ProfileModal.tsx:341`, `packages/mobile/src/components/ProfileCard.tsx`, `packages/web/src/components/NoteCard.tsx`
- **detail**: `ProfileAbout` exists precisely to normalize the untrusted kind-0 `about` field — it strips HTML and linkifies nostr identifiers and hashtags (`packages/web/src/components/ProfileAbout.tsx:22-91`). Three of the four profile surfaces use it: web `ProfileModal.tsx:264`, mobile `ProfileModal.tsx:341`, mobile `ProfileScreen.tsx:268`.

`packages/web/src/components/ProfileCard.tsx:342-346` does not:
```tsx
{metadata?.about && !compact && (
  <p className="text-sm text-muted-foreground mb-3 leading-relaxed whitespace-pre-wrap line-clamp-4">
    {metadata.about}
  </p>
)}
```
Not an injection risk (React escapes the string), but the same profile renders differently depending on which surface you view it from: HTML tags show as literal `<b>` text, and `npub1…`/`#hashtag` in the bio are dead text instead of links.
- **failure**: A user whose bio is `Building <b>stuff</b> — follow npub1abc… #bitcoin` sees, in the ProfileCard on the "me" tab, the literal text `Building <b>stuff</b> — follow npub1abc… #bitcoin` with nothing clickable. Clicking their own avatar to open ProfileModal shows the same bio with the tags stripped and the npub and hashtag rendered as working links.
- **fix**: Web: replace packages/web/src/components/ProfileCard.tsx:342-346 with `<ProfileAbout about={metadata.about} pubkey={pubkey} className="text-sm text-muted-foreground mb-3 leading-relaxed line-clamp-4 whitespace-pre-wrap" />` — keep whitespace-pre-wrap, which the original had and ProfileAbout's default `<p>` class does not supply. Mobile (per the cross-platform rule): replace packages/mobile/src/components/ProfileCard.tsx:164-166 with `<ProfileAbout about={metadata.about} pubkey={pubkey} style={styles.about} />`; note mobile's ProfileAbout has no numberOfLines prop, so either add one or accept the untruncated bio. The one-line preview surfaces (web NoteCard.tsx:1155, web OnboardSearchWidget.tsx:188, mobile OnboardSearchWidget.tsx:212) only need the HTML strip, not linkification — run them through hasHtmlContent/sanitizeHtml rather than the full component so tags don't show up literally in search results.


# Cross-platform parity gaps (147)

### "Me" tab — your own corkboard with pinned notes, own-note stats and pin filters
- mobile: **missing** · desktop: **present** · effort: large
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:4250-4279 (ProfileCard for activeTab==='me'), 3104-3129 (pinned/unpinned partition + showPinned/showUnpinned filters), 2525-2632 (own-note + pinned-note fetching); packages/web/src/components/ProfileCard.tsx:66-125, 196-204`
- impact: Mobile users have no view of their own corkboard: they can't see their own posts as a feed, can't see notes they pinned to their board, and can't filter pinned vs unpinned. Pins made on web are invisible on mobile except inside Saved.
- detail: Mobile's tab navigator (packages/mobile/App.tsx:44-77) is Feed / Discover / Saved / Notifications / Settings — there is no "Me". packages/mobile/src/screens/ProfileScreen.tsx is only reachable by tapping someone else's avatar and hard-codes `kinds: [1], limit: 20` (ProfileScreen.tsx:48-51) with no pagination and no kind filters. `usePinnedNotes` on mobile is consumed only by SavedScreen (packages/mobile/src/screens/SavedScreen.tsx:38).
- plan: Add a 'Me' entry to the mobile tab strip (or a 6th bottom tab) rendering ProfileScreen for `myPubkey` with the pinned-note query (usePinnedNotes → batch id fetch), a pinned-first sort, and showPinned/showUnpinned toggles mirroring MultiColumnClient.tsx:3104-3129. Widen useProfileNotes to the same kind set web uses and add load-more.

### App update delivery
- mobile: **present** · desktop: **missing** · effort: large
- web impl: `n/a — web updates on deploy; the SW CACHE_VERSION rewrite in /home/q4/corkboards/packages/web/package.json:8 forces a fresh bundle every release`
- impact: Desktop users stay on whatever build they installed indefinitely — including builds with the security fixes from the v0.8.2 audit missing — with no in-app notice.
- detail: No tauri-plugin-updater in packages/desktop/src-tauri/Cargo.toml, no `plugins.updater` section and no `bundle.createUpdaterArtifacts` in tauri.conf.json, and no version-check UI anywhere in packages/web/src. Web users get every fix on the next page load and mobile gets store updates; desktop users have no signal at all that 0.8.0 is stale.
- plan: Minimum viable: add a lightweight version check that runs only when isTauri — fetch a signed JSON manifest (or a kind-30078 event published by the project's own npub, which keeps it on Nostr and avoids a new third-party dependency) and show a non-blocking 'A newer desktop version is available' banner with a link handled by the new openExternal helper. Full solution: add tauri-plugin-updater, set `bundle.createUpdaterArtifacts: true`, generate a signing keypair, and publish latest.json alongside the release artifacts.

### Backup checkpoint management: rename, delete, scan for older states, download-as-file
- mobile: **missing** · desktop: **present** · effort: large
- web impl: `packages/web/src/hooks/useNostrBackup.ts:1587 (refreshCheckpoints), :1595 (renameCheckpointFn), :1604 (deleteCheckpointFn), :1637 (loadCheckpointFn), :1755 (downloadBackupAsFile), :1766 (scanOlderStates)`
- impact: A mobile user cannot name a checkpoint before a risky change, cannot delete a bad one, and — most importantly — cannot run scanOlderStates to discover older cloud checkpoints after a data-loss event. Recovery that works on web/desktop is impossible from the phone.
- detail: packages/mobile/src/hooks/useNostrBackup.ts:860-874 returns only `{status,message,logs,checkpoints,lastBackupTs,lastBackupAgo,saveBackup,autoSaveBackup,hasUnsavedChanges,checkForBackup,restoreBackup}`. Absent: renameCheckpoint, deleteCheckpoint, getCheckpoints, scanOlderStates, downloadBackupAsFile, remoteBackup/loadRemoteBackup/dismissRemoteBackup, backupCheckSettled. Note mobile DOES have file-level checkpoint helpers in packages/mobile/src/lib/downloadBackup.ts:166-231 (getCheckpoints/saveCheckpoint/renameCheckpoint/deleteCheckpoint/restoreFromCheckpoint) — but those are the local-file checkpoint list, not the relay/Blossom checkpoints the hook manages.
- plan: Port the six callbacks. scanOlderStates needs mobile's `queryAll` equivalent: generalise checkForBackup's per-relay loop (useNostrBackup.ts:706-724) into a `queryAll(filter, label, …)` helper first, then port web :1766-1856 including the 20-newest-manifest cap and the 3 s decrypt timeout. downloadBackupAsFile → `createBackup()` from lib/downloadBackup.ts + expo-sharing (BackupDownloadPrompt already does this).

### Corkboard builder — create/edit a corkboard from npubs, #hashtags, relay URLs, RSS URLs
- mobile: **missing** · desktop: **present** · effort: large
- web impl: `packages/web/src/components/TabBar.tsx:196-395 (newCorkboardDialog, ResizableDialog); packages/web/src/pages/MultiColumnClient.tsx:4147-4205 (addFeedSource/parseFeedSource/handleCreateOrUpdateFeed wiring)`
- impact: On mobile a user cannot build a corkboard — the app's headline feature. They can only consume boards synced from web/desktop, or the two degenerate one-source boards. They cannot combine 3 npubs + #bitcoin + an RSS feed the way they can on web.
- detail: Mobile has no corkboard builder UI at all. `setCustomFeeds` is called in exactly two places: packages/mobile/src/components/ProfileModal.tsx:442 (create a single-author board from a profile) and packages/mobile/src/screens/HomeScreen.tsx:133 (create a single-hashtag board from the hashtag prompt). There is no input for npub/hashtag/relay/RSS, no multi-source board, no title field. packages/mobile/src/screens/HomeScreen.tsx:504-511 only *lists* boards that already exist in MMKV. The underlying fetch layer already supports every source type (packages/mobile/src/hooks/useCustomFeedNotes.ts:71-103, 226-256 handles pubkeys, hashtags, relays and rssUrls), so only the UI is missing.
- plan: Port TabBar's newCorkboardDialog to a React Native full-screen Modal (e.g. packages/mobile/src/screens/CorkboardEditorScreen.tsx): title TextInput, a source TextInput running the same parseFeedSource/addFeedSource logic (move both out of MultiColumnClient into @core/feedSources so web and mobile share one parser), removable source chips for pubkeys/hashtags/relays/rss, a checkbox list of follows, and Create/Save buttons writing the same `nostr-custom-feeds` MMKV key. Open it from a "+ New" pill appended to the HomeScreen tab strip.

### Feed pagination: load-older-by-hours, load-newer, bounded gap-fill, fresh-note highlighting, per-tab anchors
- mobile: **partial** · desktop: **present** · effort: large
- web impl: `packages/web/src/hooks/useFeedPagination.ts:339-551 (loadMoreNotes), :558-618 (fillGaps), :622-796 (loadNewerNotes), :804-1012 (loadMoreByCount)`
- impact: Mobile feeds develop permanent holes: after the app is offline/backgrounded for hours, the notes in that window are unreachable because nothing backfills gaps and nothing anchors a `since` cursor. "Include my notes" and the new-notes highlight simply don't exist on mobile.
- detail: Mobile ships only the count-based half: packages/mobile/src/hooks/useFeed.ts:97-147 `useFeedLoadMore` reuses @core/paginationCore's dedupBatch/initialUntilCursor/PAGINATION_MAX_ITERATIONS loop, matching web's loadMoreByCount core. Everything else is absent — no hours-based loadMoreNotes with the double-fetch-when-cold and rollback-on-failure logic (web :385-393, :535-540), no loadNewerNotes with the 10-minute gap detection + backfill (web :716-752), no fillGaps second pass (web :558-618, MAX_GAPS_PER_FILL 3 / GAP_FILL_THRESHOLD 30 min), no freshNoteIds highlighting, no scrollTargetNoteId, no batchProgress, no per-tab newestTimestamp/lastFetchTime/hoursLoaded maps, and no `fetchAndMergeUserNotes` for "include my notes" (web :279-335).
- plan: Port useFeedPagination.ts into packages/mobile/src/hooks/. It is already almost RN-safe: swap `createRelayFresh` from @/components/NostrProvider for ../lib/NostrProvider's, keep the @core/paginationCore and @core/feedConstants imports, drop the RSS/relay-tab branches mobile has no UI for. Wire the returned scrollTargetNoteId to `flatListRef.scrollToIndex` (HomeScreen.tsx already holds flatListRef, line 438) instead of a DOM scroll.

### Light / system theme actually applied
- mobile: **missing** · desktop: **present** · effort: large
- web impl: `packages/web/src/components/AppProvider.tsx + packages/web/src/hooks/useTheme.ts (toggled at packages/web/src/pages/MultiColumnClient.tsx:3577-3579 and 3758-3766)`
- impact: The mobile Theme picker (dark/light/system) is a no-op — selecting Light changes nothing. A daylight user has no readable mode, and the preference doesn't even match what web stores.
- detail: packages/mobile/src/lib/AppContext.tsx:111-120 computes `resolvedTheme` and packages/mobile/src/hooks/useTheme.ts wraps it — but grep shows `resolvedTheme` is referenced only inside AppContext.tsx and useTheme.ts, and useTheme is imported by nothing. Separately, packages/mobile/src/screens/SettingsScreen.tsx:44,87-89,112-115 uses its own local `corkboard:theme` MMKV key and StateSetter that no renderer reads. Every mobile StyleSheet hard-codes dark values (#1f1f1f, #2a2a2a, #f2f2f2 …).
- plan: Either implement a real theme: replace the hard-coded StyleSheet colours with a token object selected by `useTheme().resolvedTheme` (a `useColors()` hook returning the palette, plus StyleSheet factories), and have SettingsScreen call `useTheme().setTheme` so it writes AppContext's key instead of its own. Or, as a stopgap, hide the Theme section until it works — a dead setting is worse than none.

### Mobile-only feed hooks with no web twin (useFeed / useCustomFeedNotes)
- mobile: **present** · desktop: **n/a** · effort: large
- web impl: `packages/web/src/hooks/useFollowNotesCache.ts + useFeedPagination.ts + the hashtag/RSS query blocks inside packages/web/src/pages/MultiColumnClient.tsx`
- impact: None directly. The risk is structural: mobile's single hook is the cleaner design and web's four-way split is where hashtag/RSS corkboard bugs have to be fixed four times.
- detail: packages/mobile/src/hooks/useCustomFeedNotes.ts:135-220 unifies all four corkboard sources (authors, hashtags with @core/noteCategories hashtagFeedVerdict spam filtering at line 22, custom relays, RSS) behind one hook and one query key. Web splits that same behaviour across MultiColumnClient's inline hashtag query, useCustomFeed, useCustomFeedNotesCache and useRssFeed. These are architectural twins rather than feature gaps — the behaviour exists on both — but the two shapes make cross-platform fixes cost double.
- plan: Treat mobile's useCustomFeedNotes as the target shape. Extract its source-fan-out (authors → hashtags → relays → RSS, dedupe, hashtagFeedVerdict filter) into a pure `@core/customFeedSources.ts` taking a `{query}` pool, then have both useCustomFeedNotes (mobile) and a new useCustomFeedNotes (web) call it. Do this before adding more corkboard source types (e.g. the planned store corkboard).

### NIP-46 signer login coverage: bunker:// URI, nostrconnect QR, multi-relay race, persisted Amber client key
- mobile: **partial** · desktop: **present** · effort: large
- web impl: `packages/web/src/hooks/useLoginActions.ts:105-108 (bunker), :117-211 (nostrconnect QR over NOSTRCONNECT_RELAYS), :214-231 (persisted `corkboard:amber-client-nsec`), :238 (race NSEC_APP_RELAY + NOSTRCONNECT_RELAYS), :314-325 (reuse the relay that actually answered)`
- impact: Mobile users of nsecBunker/nsec.app cannot log in at all. Amber users are re-prompted to grant permission on every single login. If relay.nsec.app is unreachable the mobile login hangs indefinitely (there is no timeout on the connect promise at line 78).
- detail: packages/mobile/src/hooks/useSignerConnect.ts covers Amber deep-link only. Verified missing on mobile (grep for `bunker://`/`fromBunker` in packages/mobile/src returns nothing): no paste-a-bunker-URI login, no QR/nostrconnect flow. Line 43 appends exactly one relay — `params.append('relay', NSEC_APP_RELAY)` — and line 69 opens only that relay, versus web racing four; line 34 generates a fresh `generateSecretKey()` every connect, where web deliberately reuses a persisted client key (its comment: "generating a fresh key every login made Amber treat each connection as a new app and re-prompt every time").
- plan: (a) Add `loginWithBunkerUri(uri)` to AuthContext parsing bunker:// per NIP-46 (pubkey, ?relay=, ?secret=) and reuse buildSignerForAccount. (b) Persist the client nsec: read/write `corkboard:amber-client-nsec` via Keychain (not MMKV — it is key material) before generateSecretKey at useSignerConnect.ts:34. (c) Append all of `[NSEC_APP_RELAY, ...NOSTRCONNECT_RELAYS]` as relay params and open a subscription on each, racing them exactly as web does, then construct NConnectSigner against the relay that answered. (d) Add an overall AbortSignal.timeout to the connect promise.

### React 18 (web/desktop) vs React 19 (mobile), papered over by a Metro resolver hack
- mobile: **present** · desktop: **missing** · effort: large
- web impl: `/home/q4/corkboards/packages/web/package.json (react/react-dom ^18.3.1, @types/react ^18.3.1) vs /home/q4/corkboards/packages/mobile/package.json (react 19.1.0, @types/react ~19.1.0)`
- impact: Any hook or component pattern written against React 19 on mobile must be rewritten for 18 on web/desktop, and vice versa — a permanent tax on the "identical platforms" goal. The Metro hack is load-bearing: any change to hoisting (a fresh `npm install`, a lockfile regeneration) can reintroduce the null-useEffect crash.
- detail: Installed: root react 18.3.1 + @types/react 18.3.28; packages/mobile/node_modules react 19.1.0 + @types/react 19.1.17. `packages/mobile/metro.config.js` carries an explicit `resolver.extraNodeModules` override forcing react/react-native/react/jsx-runtime to mobile's copies, with a comment documenting the exact crash the skew caused: "hoisted deps like @tanstack/react-query import React 18 from root, causing the 'Cannot read property useEffect of null' crash." So the skew is real, known, and currently contained by one config file. Note this also means React 19 semantics that mobile code may rely on — the `use()` hook, ref-as-prop, automatic ref cleanup, the stricter StrictMode double-invoke — are unavailable when the same logic is ported to web.
- plan: Move web and desktop to React 19 (`react`/`react-dom` ^19.1.0, `@types/react`/`@types/react-dom` ^19). The main migration cost is `@types/react` 19's removal of the implicit `children` prop and the `ReactNode` narrowing — mechanical across the shadcn components. Verify `@nostrify/react@^0.2.20`, `vaul@^0.9.3`, `react-day-picker@^8.10.1` and `react-resizable-panels@^2.1.3` declare React 19 peers before starting; those four are the likeliest blockers. Once aligned, delete the `extraNodeModules` block from metro.config.js and confirm the app still boots — that deletion is the proof the skew is gone.

### tsconfig strictness is inconsistent across the three TS packages
- mobile: **present** · desktop: **n/a** · effort: large
- web impl: `/home/q4/corkboards/packages/web/tsconfig.json vs /home/q4/corkboards/packages/core/tsconfig.json vs /home/q4/corkboards/packages/mobile/tsconfig.json`
- impact: Web (and therefore desktop) is the largest surface — 251 files — and the least type-checked. An implicit `any` or an unhandled null in a web hook compiles clean; the same code ported to mobile fails, which is why ports arrive with type patches bolted on.
- detail: Verified by reading all three and by `tsc --showConfig -p packages/mobile/tsconfig.json`. Web: `strict: false`, `noImplicitAny: false`, `noUnusedLocals: false`, `noUnusedParameters: false`, `noFallthroughCasesInSwitch: false` (only `strictNullChecks: true` survives). Core: `strict: true`, `noImplicitAny: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `noFallthroughCasesInSwitch: true`. Mobile (via expo/tsconfig.base): `strict: true`, `noImplicitAny: true`, all the strict-family flags on, but `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch` unset (false). **None** of the three enables `noUncheckedIndexedAccess`. Web's `include: ["src", "../core/src"]` means every core file is additionally checked under web's loose settings — harmless, since core's own strict pass is the binding one (correctly reasoned in the `//` comment at the top of packages/core/tsconfig.json).
- plan: Converge upward in stages, each landable independently. Stage 1: set `noFallthroughCasesInSwitch: true` in web and mobile (near-zero diff). Stage 2: web `noImplicitAny: true` — fix the fallout, this is the single highest-value flag. Stage 3: web `strict: true`, which mainly means `strictFunctionTypes`/`strictPropertyInitialization`/`useUnknownInCatchVariables`; the `catch (e: unknown)` churn is mechanical. Stage 4: `noUnusedLocals`/`noUnusedParameters: true` in web and mobile to match core (ESLint already flags most of these on web, so the diff is small). Consider `noUncheckedIndexedAccess: true` in core ONLY — core is where `tags[0]`/`tags[1]` indexing over untrusted relay events happens, and it is the smallest package to fix.

### "Collapse Reactions" setting — group reactions/reposts/zaps as badges on the original note instead of separate cards
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:644 (setting), 2739-2749 (shouldCollapse), 4446-4447 (engagementByTarget / stubNoteIds); toggle at packages/web/src/components/AdvancedSettings.tsx:219-225; rendering in packages/web/src/components/EngagementBar.tsx`
- impact: Mobile users can't turn engagement-collapsing on or off, and reactions to notes not in the feed vanish entirely instead of appearing as a stub card the way web shows them.
- detail: grep for 'collapseReactions' / 'corkboard:collapse-reactions' in packages/mobile/src returns zero hits. packages/mobile/src/components/AdvancedSettings.tsx has no such row (its rows are Relays, Blossom, Network Privacy, Bring-back-dismissed, Profile Cache, Client Tag, Public Bookmarks, Restart Onboarding, Delete Account). Mobile does a partial equivalent implicitly in HomeScreen.tsx:243-268 (suppresses a kind-7/9735 card when its target is already in the feed) and shows per-note reaction chips via packages/mobile/src/components/NoteActions.tsx:219-233, but there is no user setting and no engagement-stub card for a reaction whose target is missing.
- plan: Add a 'corkboard:collapse-reactions' toggle row to packages/mobile/src/components/AdvancedSettings.tsx and honour it in HomeScreen's dedupe memo, building an engagementByTarget map + stub events the way MultiColumnClient.tsx:2739-2749 does, then feed the aggregate into NoteActions' chip row.

### @corkboards/core is consumed only through path aliases, so its package manifest is fiction
- mobile: **partial** · desktop: **partial** · effort: medium
- web impl: `/home/q4/corkboards/packages/core/package.json (main/types/exports/peerDependencies) vs how web, mobile and desktop actually resolve @core/*`
- impact: No runtime impact today (verified: root `npm run typecheck` and all three test suites pass). The cost is that the five alias declarations are a silent drift surface, and core's declared peer range provides no protection against the exact nostrify skew that is currently causing a real behavioural difference.
- detail: Nothing imports `@corkboards/core` by name — grep across packages/web/src, packages/mobile/src and packages/core/src finds the string only inside doc comments (core/src/index.ts:2, core/src/zap.ts:13). Resolution happens through four independent alias mechanisms that must be kept in sync by hand: `packages/web/vite.config.ts` resolve.alias, `packages/web/tsconfig.json` paths, `packages/mobile/babel.config.js` module-resolver, `packages/mobile/tsconfig.json` paths, and `packages/mobile/jest.config.js` moduleNameMapper. Consequences: core's `exports` map (`".": "./src/index.ts"`, `"./*": "./src/*"` — the latter would not even resolve, since it omits the `.ts` extension) is dead config; its `peerDependencies: { "@nostrify/nostrify": ">=0.48.0" }` is never enforced by npm, which is precisely why the 0.50.5/0.51.0 skew above went unnoticed. Also `packages/core/src/index.ts` re-exports only 22 of the 33 modules — missing cacheConfig, hashCore, imageProxy, keyedMutex, nip99, noteCategories, paginationCore, router, threadTree and storage's value exports — so the advertised entry point is incomplete too.
- plan: Either commit to the alias approach and delete the misleading manifest fields (`main`, `types`, `exports`, `peerDependencies`) with a comment explaining that consumers use `@core/*` path aliases — plus a vitest that reads all five alias configs and asserts they point at the same directory. Or commit to the workspace-package approach: add `"@corkboards/core": "*"` to web's and mobile's dependencies, fix the `exports` map to `"./*": "./src/*.ts"`, and let npm enforce the peer range. The first is less work and matches current practice; the second is what makes the peerDependency actually protect you.

### Account-isolation reconciliation on launch (marker vs active pubkey)
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/hooks/useAccountIsolation.ts:24-73`
- impact: Cross-account data bleed on mobile: the wrong account's corkboards, dismissed list and follows can appear under a different npub, with no self-healing.
- detail: Web reconciles on every mount: if `getActiveUserPubkey()` (the ACTIVE_USER_KEY marker written by core switchActiveUser, packages/core/src/storageKeys.ts:345) disagrees with the logged-in pubkey, it bumps the session epoch, runs switchActiveUser, wipes session-scoped keys, and reloads — with a per-tab loop-breaker. Mobile has NO equivalent: packages/mobile/src/lib/AuthContext.tsx only calls switchActiveUser inside loginWithNsec/loginWithBunker/switchAccount (lines 306/337/369), and the session-restore path on mount (lines 221-284) reads `corkboard:active-account` and never compares it to ACTIVE_USER_KEY. If the process is killed between `switchActiveUser` and `setStoredActiveAccount`, or after an MMKV restore from a foreign backup, the two markers diverge permanently and account B renders account A's stashed data.
- plan: Add packages/mobile/src/hooks/useAccountIsolation.ts. Mount it in App.tsx under AuthProvider. `await mobileStorage.ready` replaces `await idbReady`; there is no reload primitive, so instead of `window.location.reload()` call `bumpSessionEpoch()` + `queryClient.clear()` + `clearCollapsedNotesModuleState()` + `clearRelayCache()` + `clearProfileCache()` and force a remount via a key on the navigator. Use a module-level `Set<string>` in place of sessionStorage for the once-per-launch loop-breaker.

### Backup-checked flag (skip the relay check once per user) + in-flight dedupe + kind-10002 relay discovery before checking
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/hooks/useNostrBackup.ts:56 (BACKUP_CHECKED_KEY), :62-66 (markBackupCheckedSync / localStorage mirror), the `_checkInFlight` promise + `idbReady` gate and the kind-10002 discovery step in checkRemoteBackup (~:1040-1150), :1858-1873 (clearBackupChecked / clearAllBackupChecked)`
- impact: Mobile can miss a backup that lives only on the user's own write relays, and two concurrent callers (AutoSaveManager idle-return + Settings button) both fan out. Once the launch-time check is added (see the first gap), the missing flag would make it re-run on every cold start.
- detail: grep for `backup-checked|BACKUP_CHECKED` in packages/mobile/src returns nothing. packages/mobile/src/hooks/useNostrBackup.ts:691-724 checkForBackup has no per-pubkey "already checked" flag, no concurrent-call dedupe, and no step-0 kind-10002 write-relay discovery — it goes straight to `getPublishRelays(pubkey)`, so a user whose write relays aren't already in relayCache is checked against fallbacks only.
- plan: Port BACKUP_CHECKED_KEY + markBackupCheckedSync/clearBackupChecked/clearAllBackupChecked using `mobileStorage` and `mobileStorage.keys()` for the prefix sweep. Add a module-level `_checkInFlight: {pubkey, promise} | null` registered before the first await. Port the kind-10002 discovery block into checkForBackup before the 30078 query. Call clearBackupChecked from AuthContext.removeAccount and clearAllBackupChecked from logout.

### CSP drift between the web meta tag and the Tauri config, with nothing locking them together
- mobile: **n/a** · desktop: **partial** · effort: medium
- web impl: `/home/q4/corkboards/packages/web/index.html (http-equiv content-security-policy) vs /home/q4/corkboards/packages/desktop/src-tauri/tauri.conf.json (app.security.csp)`
- impact: A media or connection type that works on desktop silently fails on web, or vice versa, and adding one embed provider requires two edits — miss one and the feature is broken on exactly one platform. `default-src 'none'` vs `'self'` also means desktop has a materially weaker fallback for any directive neither file names.
- detail: Same bundle, two hand-maintained CSPs that have already diverged. Web: `default-src 'none'`; Tauri: `default-src 'self'` (weaker fallback). Web `media-src 'self' https:`; Tauri `media-src 'self' https: blob:` — desktop permits blob: media, web does not. Web `connect-src 'self' blob: https: wss:`; Tauri `connect-src 'self' ipc: http://ipc.localhost wss: https:` — desktop drops `blob:`. Web `font-src 'self'`; Tauri `font-src 'self' data:`. The long `frame-src` allowlists (youtube/spotify/soundcloud/vimeo/twitch/bandcamp/rumble/odysee/tidal/apple) are duplicated verbatim in both files and must be edited twice by hand. `packages/web/.htaccess` deliberately sets no CSP header (documented), so the meta tag is the only web CSP.
- plan: Make one file the source of truth. Create `packages/core/src/cspDirectives.ts` exporting the shared directive map (the frame-src allowlist especially), then generate both: a small `packages/web/scripts/build-csp.mjs` that stamps the meta tag into `index.html` at build time, and the same module read by a prebuild step that writes `app.security.csp` into `tauri.conf.json`. Cheaper interim fix: add a vitest in `packages/web/src/test/` that parses both files, normalises each into a directive→sources map, and asserts the frame-src lists are identical and that Tauri's `default-src` is not weaker than web's.

### Consolidate blank spaces (+ consolidate sound, auto-consolidate)
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/components/StatusBar.tsx:377-387 / 617-627 (Consolidate button with blankSpaceCount), 334-347 (auto-consolidate toggle); packages/web/src/pages/MultiColumnClient.tsx:3320-3360 (consolidateSound / soundAccelerate playback), 3586-3609 & 3778-3801 (Sound submenu)`
- impact: Mobile has no way to sweep dismissed placeholders out of the board, and none of the audio feedback that makes the web consolidate action feel like clearing a solitaire tableau.
- detail: packages/mobile/src/hooks/useCollapsedNotes.ts:215-224 implements `consolidate()` but no mobile component calls it (grep for 'consolidate' in packages/mobile/src/**/*.tsx returns zero call sites). There is no blank-space concept on mobile because there is no dismiss placeholder. Sound is entirely web-only: grep for 'consolidateSound' / 'soundAccelerate' in packages/mobile/src returns nothing.
- plan: After adding dismiss placeholders, add a Consolidate control (a header button or a StatusBar-equivalent bar) calling useCollapsedNotes().consolidate(), plus an auto-consolidate preference reading the same STORAGE_KEYS.AUTO_CONSOLIDATE key. Port the sound with expo-av, reading 'corkboard:consolidate-sound' and 'corkboard:sound-accelerate' so the setting round-trips through backup.

### Content filters — hide by min chars / emoji-only / media-only / links-only / markdown / exact text, with always-show exceptions (PV, GM, GN, 👀, 💯)
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/components/ContentFilters.tsx; filter logic at packages/web/src/pages/MultiColumnClient.tsx:1254-1257, 3088-3136; surfaced via ProfileCard/FeedInfoCard (MultiColumnClient.tsx:4273-4275, 4368-4369)`
- impact: Mobile users can't suppress the "gm"/"👀"/link-only noise that the web content filters exist to remove, and a filter configured on web has no effect on mobile even though the setting is in the synced backup.
- detail: packages/mobile/src/components/ContentFilters.tsx is a complete port but is imported by nothing (verified across packages/mobile/src and App.tsx). More importantly the *logic* is absent: grep for 'hideMinChars' in packages/mobile/src matches only ContentFilters.tsx itself, so packages/mobile/src/screens/HomeScreen.tsx:286-343 applies kind + hashtag + dismissed filters only.
- plan: Port the per-tab filter-settings slice (MultiColumnClient.tsx:1082-1290) into a mobile hook reading the same 'corkboard:tab-filters' key, apply the predicate from MultiColumnClient.tsx:3088-3136 inside HomeScreen's filteredEvents memo, and mount the existing ContentFilters component inside FeedFilters.

### Corkboard edit / delete / reorder
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/components/TabBar.tsx:469-481 (mobile per-tab dropdown Edit/Delete), 628-707 (draggable reorder of feeds, relays, rss); packages/web/src/pages/MultiColumnClient.tsx:3898-3927 (delete confirm dialog), 4192-4203 (onEditFeed/onDeleteFeed)`
- impact: A corkboard created on mobile (or synced from web) can never be renamed, re-sourced, deleted, or reordered on mobile. Accidental boards accumulate forever and the tab strip order is fixed.
- detail: packages/mobile/src/screens/HomeScreen.tsx:543-557 renders tabs as plain TouchableOpacity with no long-press menu, no edit, no delete, no drag reorder. Nothing in packages/mobile/src removes an entry from `nostr-custom-feeds` (verified: `setCustomFeeds` appears only at ProfileModal.tsx:442/464 and HomeScreen.tsx:133).
- plan: Add a long-press handler on each mobile tab pill opening an ActionSheet/Alert with Edit (opens the new corkboard editor), Delete (Alert.alert confirm mirroring MultiColumnClient.tsx:3898-3927, then reset activeTab to 'following'), and Move left/right buttons that splice the customFeeds array. Set the backup 'unsaved' indicator on change as web does at MultiColumnClient.tsx:3919.

### Deep-link / URL-scheme registration for the desktop app
- mobile: **present** · desktop: **missing** · effort: medium
- web impl: `packages/web/src/AppRouter.tsx:19-22 (`/t/:hashtag`, `/:nip19` routes handled by packages/web/src/pages/NIP19Page.tsx)`
- impact: Clicking a `nostr:` URI or a corkboards.me/npub… link on the desktop does not open the installed app — it goes to the browser or nowhere. Mobile handles both.
- detail: packages/desktop/src-tauri/tauri.conf.json has no `plugins` section and no deep-link/protocol configuration; packages/desktop/src-tauri/Cargo.toml:14-29 lists no tauri-plugin-deep-link; packages/desktop/src-tauri/src/lib.rs:71-89 registers no URL-open handler. The webview loads WebviewUrl::App("index.html") (lib.rs:26), so react-router's /:nip19 route is only reachable by in-app navigation. Mobile registers `"scheme": "corkboards"` in packages/mobile/app.json:6 and handles it in packages/mobile/src/components/DeepLinkHandler.tsx.
- plan: Add tauri-plugin-deep-link, register the `corkboards://` and `nostr:` schemes in tauri.conf.json, and on an incoming URL emit an event the web bundle listens for (a small isTauri branch beside packages/web/src/lib/tauri.ts) that navigates react-router to the NIP-19 route.

### Desktop Rust backend has zero tests and is excluded from the default test run
- mobile: **n/a** · desktop: **missing** · effort: medium
- web impl: `root /home/q4/corkboards/package.json — `test` = `test:core && test:web && test:mobile`; `test:desktop` exists but is never invoked`
- impact: The only code path that touches the raw private key on desktop — the whole reason the Rust signer exists — has no test and no CI gate. A regression in `signer.rs` or `keychain.rs` reaches users unverified.
- detail: `grep -rn '#\[test\]|mod tests' packages/desktop/src-tauri/src/` returns **0** across all seven Rust files (main.rs, lib.rs, keychain.rs, signer.rs, relay.rs, proxy.rs, logger.rs). `npm run test:desktop` runs `cargo clippy --all-targets -- -D warnings && cargo test`, so the clippy half is real but `cargo test` executes nothing. The root `test` script deliberately omits it (documented in the `//test:desktop` comment as needing a Rust toolchain), and `.gitlab-ci.yml` only runs `npm run test` — so clippy never runs in CI either. `signer.rs` is where the nsec is read from the OS keychain and used for NIP-04/44 encryption and event signing; `proxy.rs` and `relay.rs` are the SSRF/relay boundary.
- plan: Add `#[cfg(test)] mod tests` to `signer.rs` (sign a known event, assert the id/sig against a nostr-tools-generated fixture; NIP-04 and NIP-44 round-trips), `relay.rs` (URL scheme/host validation rejects ws://, private IPs, IPv6 literals), and `proxy.rs` (same SSRF matrix as `packages/core/src/ipUtils.ts` — reuse the exact vectors from packages/mobile/src/__tests__/core-parity.test.ts so Rust and TS provably agree). Then add `test:desktop` as its own CI job (not to root `test`, keeping the no-Rust contributor flow intact) and add `packages/desktop/src-tauri/rust-toolchain.toml` pinning the channel so clippy lint sets are reproducible.

### Discover-mode note cards (profile-forward layout with inline follow)
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:4452 (discoverMode → FeedGrid); packages/web/src/components/NoteCard.tsx:246-247, 820-826, 956 (discoverMode branch: large profile block, followed-activity attribution)`
- impact: Mobile Discover shows the same compact cards as the home feed, without the enlarged author block and "followed by X" attribution that make Discover useful for deciding whom to follow, and with no inline follow button.
- detail: packages/mobile/src/screens/DiscoverScreen.tsx:345-354 renders a stock `<NoteCard event={item} …/>` with no discoverMode prop; packages/mobile/src/components/NoteCard.tsx has no discoverMode concept at all.
- plan: Add a `discoverMode` prop to mobile NoteCard rendering the author avatar/name/about prominently plus a Follow button (reusing ProfileModal's follow mutation), and pass it from DiscoverScreen.

### Dismiss a note from the feed (red corner), undo-dismiss placeholder, dismiss-thread
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/components/NoteCard.tsx:927-943 (red dismiss corner), 830-852 (soft-dismissed undo placeholder), 1661 ("Dismiss this and all associated notes"); packages/web/src/pages/MultiColumnClient.tsx:4448 (onDismissThread)`
- impact: Dismissing is the core corkboard interaction ("clear the board"). On mobile the feed is read-only: a user cannot remove a note, cannot undo a dismissal, and cannot dismiss a whole thread. Their board state can only be curated from a desktop/browser.
- detail: packages/mobile/src/components/NoteCard.tsx:155-229 renders no dismiss control of any kind — only NoteActions (reply/repost/like/bookmark/zap). The only `dismiss(` call site in packages/mobile/src is packages/mobile/src/components/NotificationCard.tsx:164. packages/mobile/src/hooks/useCollapsedNotes.ts:293-318 exports dismiss, undoDismiss, canUndoDismiss, dismissMultiple, dismissThreadRoots, consolidate — all unreachable from the feed. HomeScreen.tsx:327-340 *filters out* dismissed notes, so the mobile feed honours dismissals made on web but can never create one.
- plan: Add red (dismiss) and green (save-for-later/collapse) corner buttons to packages/mobile/src/components/NoteCard.tsx as absolutely-positioned triangles matching NoteCard.tsx:900-943, wired to useCollapsedNotes().dismiss / toggleCollapsed. Render the soft-dismissed undo placeholder (tap to undoDismiss) at the captured card height. Add "Dismiss all associated" to a long-press menu calling dismissThreadRoots.

### Downloading a backup / key file to disk
- mobile: **n/a** · desktop: **partial** · effort: medium
- web impl: `/home/q4/corkboards/packages/web/src/lib/triggerDownload.ts:2-13; /home/q4/corkboards/packages/web/src/lib/downloadBackup.ts:121-124; /home/q4/corkboards/packages/web/src/hooks/useNostrBackup.ts:1755-1762; /home/q4/corkboards/packages/web/src/components/auth/SignupDialog.tsx:47-58; /home/q4/corkboards/packages/web/src/components/auth/LoginDialog.tsx:70-79`
- impact: On macOS desktop, 'Download backup', the emergency plaintext JSON export, and the new-account key-file download all do NOTHING — no file, no error, no toast. Given the user's stated fear of losing follows/backups, this is a silent data-loss path. On Linux the file lands somewhere unspecified with no feedback.
- detail: triggerDownload creates `<a download href=blob:>` and clicks it. packages/desktop/src-tauri/src/lib.rs never calls `.on_download(...)`, so `download_started_handler` is None. On macOS that is fatal: wry-0.54.4 src/wkwebview/navigation.rs:69-74 calls `WKNavigationActionPolicy::Cancel` when `has_download_handler` is false, and navigation.rs:96-101 does the same for the response policy — the click is silently cancelled. On Linux wry only connects `decide-destination` when a handler exists (wry src/webkitgtk/web_context.rs:307-320), so the destination is whatever WebKitGTK defaults to with no save dialog and no in-app confirmation; on Windows WebView2's own default download UI takes over. Separately, downloadBackup.ts:124 and useNostrBackup.ts:1762 call `URL.revokeObjectURL(url)` on the very next synchronous line, which races the download start in WebKit.
- plan: Two-part fix. (1) In packages/desktop/src-tauri/src/lib.rs add `.on_download(|_wv, ev| { … true })` on the WebviewWindowBuilder so the download is at least allowed on macOS. (2) Preferred: add `tauri-plugin-dialog` + `tauri-plugin-fs` to Cargo.toml (or a small custom `save_file(name, contents)` command using `dirs::download_dir()`), then make triggerDownload branch on `isTauri`: convert the blob to text/bytes and invoke the Rust save path, showing a toast with the resulting absolute path. Also defer `URL.revokeObjectURL` with `setTimeout(..., 60_000)` in downloadBackup.ts:124 and useNostrBackup.ts:1762 for all platforms.

### Feed info card per tab (source summary, remove relay/RSS, edit/delete board, own-notes toggle, load-more, saved-board embed)
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/components/FeedInfoCard.tsx (577 lines); wired at packages/web/src/pages/MultiColumnClient.tsx:4327-4400`
- impact: Mobile users can't see what a corkboard is actually built from, can't toggle their own notes in/out of a board, and have no per-tab controls at all.
- detail: packages/mobile/src/components/FeedInfoCard.tsx (391 lines) exists but is imported by nothing (verified). HomeScreen shows only a one-line label (HomeScreen.tsx:387-397, 525) and the FeedFilters block. So the mobile feed has no source summary, no "show own notes" toggle (grep for showOwnNotes in packages/mobile/src returns nothing), no per-tab remove/edit actions, and no batch-progress display.
- plan: Mount the existing packages/mobile/src/components/FeedInfoCard.tsx above FeedFilters in HomeScreen, passing the active corkboard/relay/rss descriptor, stats, and callbacks for edit/delete/remove-source and show-own-notes (adding the showOwnNotes predicate to the filteredEvents memo).

### Flush-on-exit for autosave, relay cache and IndexedDB connections
- mobile: **present** · desktop: **missing** · effort: medium
- web impl: `/home/q4/corkboards/packages/web/src/hooks/useAutoSaveTrigger.ts:149-156; /home/q4/corkboards/packages/web/src/components/NostrProvider.tsx:892-916; /home/q4/corkboards/packages/web/src/lib/idb.ts:369-372; /home/q4/corkboards/packages/web/src/lib/notesCache.ts:335-338; /home/q4/corkboards/packages/web/src/lib/webKeyStore.ts:282-288`
- impact: Quitting the desktop app loses the last debounce window of settings/corkboard edits (they were never flushed to the Blossom backup) and discards freshly discovered NIP-65 relay-cache entries, so the next launch re-does outbox discovery from scratch. Directly contradicts the project's data-loss guard requirement.
- detail: All exit-time persistence hangs off `beforeunload` and `visibilitychange:hidden`. Neither fires when a Tauri window is closed: lib.rs registers no close-requested handler, Tauri destroys the webview directly, and WebKitGTK only runs beforeunload handlers via `webkit_web_view_try_close()`, which Tauri does not call. `visibilitychange` never goes hidden on a desktop window close either. So clicking the window's X skips useAutoSaveTrigger's immediate backup save and NostrProvider's `flushRelayCacheToIdb()`.
- plan: Add `core:window:allow-destroy` to /home/q4/corkboards/packages/desktop/src-tauri/capabilities/default.json (note: `core:window:default` does NOT include it — verified in gen/schemas/acl-manifests.json). Then in a small `useTauriCloseGuard()` mounted from MultiColumnClient: `if (!isTauri) return; const w = getCurrentWindow(); const un = await w.onCloseRequested(async (e) => { e.preventDefault(); await flushAll(); await w.destroy(); });` where flushAll() awaits autoSaveBackup() (when hasUnsavedChanges()) and flushRelayCacheToIdb(), bounded by a ~5s timeout so a hung relay can't wedge the quit. Also refactor the beforeunload listeners in idb.ts/notesCache.ts/webKeyStore.ts into a shared `onAppTeardown()` registry that the Tauri path can drive.

### GitLab CI is the only CI and it cannot pass
- mobile: **missing** · desktop: **missing** · effort: medium
- web impl: `/home/q4/corkboards/.gitlab-ci.yml (13 lines, the only CI file in the repo)`
- impact: Nothing is verified on push. The PR template's `npm run test` checkbox is enforced entirely on the honour system, which is how the rss-proxy/.htaccess drift and the devDependency misclassification survived.
- detail: Three independent, verified breakages. (1) No install step: neither the `test` nor the `pages` job has a `before_script`, `cache`, or `npm ci`, so `npm run test` runs against a checkout with no node_modules and dies on the first `tsc`. (2) `default: timeout: 1 minute` applies to every job, but I measured `npm run test:web` alone at **1m1.4s** wall (tsc + eslint + 210 vitest tests at 25s + `vite build`); adding `test:core` and `test:mobile` puts the full `npm run test` near 100s. The job would be killed even if install worked. (3) The `pages` job runs `npm run build && rm -rf public && mv dist public`, but root `build` delegates to `-w @corkboards/web`, which writes to **packages/web/dist** — there is no `dist` at repo root in a clean checkout (the local one is gitignored build residue from Jul 23). `mv` fails. Additionally `.github/` contains only issue/PR templates — `git ls-files` confirms zero workflow files — so GitHub sees no CI at all.
- plan: Rewrite `.gitlab-ci.yml`: add `before_script: [npm ci]` plus a `cache: { key: '$CI_COMMIT_REF_SLUG', paths: ['node_modules/', 'packages/*/node_modules/'] }`, raise `default.timeout` to `20 minutes`, and fix pages to `mv packages/web/dist public && cp packages/web/rss-proxy.php packages/web/.htaccess public/`. Then add `.github/workflows/ci.yml` with a matrix of four jobs — `test:core`, `test:web`, `test:mobile`, `test:desktop` (the last on `dtolnay/rust-toolchain@stable` with `components: clippy`) — plus a fifth job running `npm ci --omit=dev && npm run build -w @corkboards/web` to catch dependency misclassification.

### Launch-time cloud-backup check + auto-restore guard (useAutoRestoreGuard / BackupSplashScreen)
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/hooks/useAutoRestoreGuard.ts:35-77; packages/web/src/hooks/useNostrBackup.ts checkRemoteBackup (~line 1040-1200) + `backupCheckSettled``
- impact: Install corkboards on a new phone, log in with an existing nsec → the app shows an empty feed with zero corkboards and never offers to restore the cloud backup. The user must know to open Settings → Backup and press a button. On web/desktop the restore is proposed automatically at launch.
- detail: Web runs a one-shot launch flow: checkRemoteBackup() → setCheckSettled(true) → useAutoRestoreGuard fires when status==='found', reads `nostr-custom-feeds` and `corkboard:tab-filters` (sync then async fallback), and ONLY restores when local is empty. Mobile's useNostrBackup returns no `backupCheckSettled` (packages/mobile/src/hooks/useNostrBackup.ts:860-874) and nothing calls checkForBackup at launch — grep shows the only callers are AutoSaveManager.tsx:106 (idle-return only), BackupRestoreUI.tsx:101 and SettingsScreen.tsx:415 (manual buttons). packages/mobile/src/components/BackupSplashScreen.tsx exists but is imported by nothing.
- plan: Add `checkSettled` state to mobile useNostrBackup (set true in every terminal branch of checkForBackup, incl. the no-backup path). Port useAutoRestoreGuard.ts verbatim swapping `idbGetSync/idbGet` → `mobileStorage.getSync` (MMKV is sync so drop the async fallback). Mount BackupSplashScreen in App.tsx between AuthProvider and AppTabs, gated on `status==='checking'||'found'`, and call checkForBackup() once per pubkey on login.

### Local file backup — download settings JSON and restore from a file (with fewer-items preflight warning)
- mobile: **missing** · desktop: **partial** · effort: medium
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:4086-4104 (Local File Backup dialog), 4812 (hidden file input), 372-399 (handleSettingsRestore + preflightRestore), 4763-4781 (Restore Warning dialog); packages/web/src/lib/downloadBackup.ts:123 + packages/web/src/lib/triggerDownload.ts`
- impact: Given this project's explicit data-loss fear: on mobile there is no way to get a local copy of corkboards/filters/dismissed state off the device, and no way to restore one; on desktop "Local File Backup → Download File" and "Download & Logout" (MultiColumnClient.tsx:4126) very likely produce no file at all, so the user thinks they saved and did not.
- detail: Mobile: packages/mobile/src/lib/downloadBackup.ts implements createBackup / preflightRestore / restoreBackup, and packages/mobile/src/components/BackupDownloadPrompt.tsx:29-49 does the expo-sharing export — but BackupDownloadPrompt is imported by nothing (verified across packages/mobile/src and App.tsx), and packages/mobile/src/screens/SettingsScreen.tsx has no local-file section at all. There is no file-picker restore path. Desktop: packages/web/src/lib/triggerDownload.ts creates an `<a download>` and clicks it; packages/desktop/src-tauri/src/lib.rs:18-70 registers no download handler and Cargo.toml (lines 14-29) pulls in no tauri-plugin-fs/dialog, so the WebKitGTK/WKWebView webview has nowhere to put the file.
- plan: Mobile: add a Local Backup section to SettingsScreen mounting BackupDownloadPrompt's export path (expo-file-system + expo-sharing) plus an expo-document-picker import that runs preflightRestore → warning Alert → restoreBackup. Desktop: detect isTauri in triggerDownload and route through a `save_file` Rust command (or tauri-plugin-dialog save + tauri-plugin-fs write) instead of the anchor click, and verify the result before reporting success.

### Login-time backup check splash / restore gate
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:3550-3563 (showLoginSplash → BackupSplashScreen); packages/web/src/components/BackupSplashScreen.tsx`
- impact: On a fresh mobile install/login the app opens an empty board and starts autosaving that empty state before any cloud backup is pulled — precisely the overwrite-a-good-backup scenario web guards against with a blocking splash plus the AUTO_SAVE_COOLDOWN_MS window (MultiColumnClient.tsx:135).
- detail: packages/mobile/src/components/BackupSplashScreen.tsx is a complete 375-line port (it even accepts `scanOlderStates` at BackupSplashScreen.tsx:30,151) but is imported by nothing. packages/mobile/App.tsx mounts NostrSync + AutoSaveManager and goes straight to the tab navigator; packages/mobile/src/components/AutoSaveManager.tsx:102-112 only does the *idle-return* check, never a login-time one.
- plan: Gate the mobile tab navigator on a first-run `checkForBackup()` from useNostrBackup, rendering the existing BackupSplashScreen while status is checking/found/restoring, with a Dismiss that latches for the session — mirroring MultiColumnClient.tsx:3548-3563. Also add web's post-load autosave cooldown so mobile can't upload an empty state immediately after launch.

### Markdown rendering + "Render Markdown" setting + per-note "show original"
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/components/NoteContent.tsx:9,18,83-85,374,611-619 (react-markdown + GFM, markdown-indicator heuristic); packages/web/src/components/SmartNoteContent.tsx:66-70 (global setting + showOriginal); toggle at packages/web/src/components/AdvancedSettings.tsx:227-233`
- impact: Long-form articles and markdown-formatted notes render as raw `## Heading`, `**bold**`, `- item`, `> quote` text on mobile — visibly broken next to the same note on web.
- detail: packages/mobile/src/components/NoteContent.tsx handles markdown only to the extent of extracting `[text](url)` link/image targets (NoteContent.tsx:333-371). There is no markdown renderer, no 'corkboard:render-markdown' setting, and no per-note 'show original'. Long-form kind-30023 articles fall through to the plain-text branch (NoteContent.tsx:620-628).
- plan: Add a react-native markdown renderer (react-native-markdown-display or a small custom renderer over the same MARKDOWN_INDICATORS_PATTERN) behind a 'corkboard:render-markdown' setting row in mobile AdvancedSettings, plus a per-note 'show original' toggle mirroring SmartNoteContent.tsx:66-70. Move MARKDOWN_INDICATORS_PATTERN from packages/web/src/lib/markdownDetect.ts into @core so both sides use one heuristic.

### Mobile has no component/hook test harness — jest-expo and @testing-library/react-native are installed but unused
- mobile: **missing** · desktop: **n/a** · effort: medium
- web impl: `/home/q4/corkboards/packages/web/src/test/setup.ts + /home/q4/corkboards/packages/web/src/test/TestApp.tsx (full provider wrapper)`
- impact: Mobile backup/restore, key storage and MMKV persistence — the paths where a bug loses the user's nsec or their follow list — ship with no automated verification at all, while the identical web paths are covered.
- detail: `packages/mobile/jest.config.js` uses `preset: 'react-native'` even though `jest-expo@55.0.11` is a declared devDependency (and the correct preset for an Expo app). It has no `setupFiles` and no `setupFilesAfterEach`. `@testing-library/react-native@^13.3.3` is declared in devDependencies with **0 references** anywhere under `packages/mobile`. There is no mobile equivalent of `packages/web/src/test/TestApp.tsx`. Consequence: mobile's only two test files import pure `@core` functions; not one of the 143 files in `packages/mobile/src` is exercised — including `src/lib/downloadBackup.ts` (326-line MMKV port of the web backup system), `src/lib/NostrProvider.tsx` (outbox routing + NIP-42), `src/storage/MmkvStorage.ts`, `src/lib/notesCache.ts`, `src/lib/cacheStore.ts`. Web, by contrast, does test its equivalents: `packages/web/src/lib/downloadBackup.test.ts` and `packages/web/src/lib/webKeyStore.test.ts`.
- plan: Switch `packages/mobile/jest.config.js` to `preset: 'jest-expo'` (keep the existing `moduleNameMapper` for `@core/*` and the `moduleDirectories` root-hoist entry; jest-expo supplies a superset of the current `transformIgnorePatterns`). Add `packages/mobile/src/test/setup.ts` mirroring `packages/web/src/test/setup.ts`, wire it as `setupFilesAfterEach`, and add `packages/mobile/src/test/TestApp.tsx` wrapping AppContext/AuthContext/NostrProvider/QueryClientProvider. First tests to write, mirroring web 1:1: `downloadBackup` round-trip (createBackup → preflightRestore → restoreBackup), MMKV key isolation across accounts, and keychain store/read.

### Multi-column masonry layout with 1–9 column stepper
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/components/FeedGrid.tsx (columns/columnCount); packages/web/src/components/StatusBar.tsx:388-394 / 516-522 (column stepper); MultiColumnClient.tsx:4410-4412, 307 (DEFAULT_COLUMN_COUNT)`
- impact: On a tablet or a landscape phone the mobile app wastes most of the screen on one narrow column, and the corkboard's defining multi-column look is absent.
- detail: packages/mobile/src/components/FeedGrid.tsx exists but is imported by nothing (verified), and its own header comment says "Single column layout using FlatList" — it has no columnCount prop. HomeScreen renders a plain single-column FlatList. Grep for 'columnCount' in packages/mobile/src returns zero hits.
- plan: Either add `numColumns` support to the HomeScreen FlatList driven by a persisted column count (STORAGE_KEYS.DEFAULT_COLUMN_COUNT), or port the round-robin column distribution from web FeedGrid into the currently-dead packages/mobile/src/components/FeedGrid.tsx and mount it. Expose a +/- stepper in the new StatusBar.

### NIP-46 bunker client key at rest
- mobile: **present** · desktop: **missing** · effort: medium
- web impl: `/home/q4/corkboards/packages/web/src/hooks/useLoginActions.ts:205-210,328-334 (clientNsec stored in the NLogin, persisted to localStorage['corkboard:login']); :219-231 (`corkboard:amber-client-nsec` in localStorage)`
- impact: On desktop and web, the key that authorizes the NIP-46 channel sits in cleartext in localStorage and in the IndexedDB kv mirror, while mobile keeps the same key in the platform keystore. An attacker who reads those files can sign as the user through the bunker until the grant is revoked.
- detail: Mobile puts the bunker client nsec in the OS keychain — /home/q4/corkboards/packages/mobile/src/lib/AuthContext.tsx:161 reads it from `clientNsecService(pubkey)` and :272-273 resets it on logout. Desktop has a working OS keychain (keychain_store/keychain_delete in packages/desktop/src-tauri/src/keychain.rs) but only ever uses it for `nsec:<pubkey>`; the clientNsec rides along inside the login object into localStorage, and idb.ts:264-294 then copies that localStorage blob into IndexedDB. webKeyStore.ts's prepareLoginStorage only blanks `type === 'nsec'` entries (line 239), so the bunker clientNsec is never encrypted on web either.
- plan: Desktop: in useLoginActions bunker/nostrconnect/amberConnect, after building the NLogin, `await keychainStore('client:'+userPubkey, clientNsec)` and blank `login.data.clientNsec`; add a `keychain:client` branch to useCurrentUser so NUser.fromBunkerLogin gets a signer that resolves the client key through Rust (a `bunker_client_sign` command, or reuse sign_event with the client key entry). Delete it in useLoggedInAccounts.ts:61 and useLoginActions.ts:349 alongside the nsec entry. Web: route clientNsec through the existing webKeyStore AES-GCM store the same way nsec logins already are, and extend prepareLoginStorage's scrub (webKeyStore.ts:238-248) to cover `type === 'bunker'` entries and `corkboard:amber-client-nsec`.

### Native relay routing coverage (reads vs writes vs single-relay queries)
- mobile: **n/a** · desktop: **partial** · effort: medium
- web impl: `/home/q4/corkboards/packages/web/src/components/NostrProvider.tsx:919-965 (Proxy intercepts only `query`); /home/q4/corkboards/packages/web/src/hooks/useNostrPublish.ts:49-57; /home/q4/corkboards/packages/web/src/hooks/useAuthor.ts:77-82; /home/q4/corkboards/packages/web/src/hooks/useNip65Relays.ts:45-55; /home/q4/corkboards/packages/web/src/hooks/useBookmarks.ts:144,221; /home/q4/corkboards/packages/web/src/pages/MultiColumnClient.tsx:447,1007-1012`
- impact: Reads take the hardened native path while writes take the path the native path exists to avoid — and a failed publish still shows a success toast, so a desktop user can believe a note/reaction/profile edit was published when no relay ever accepted it. Profile resolution via purplepag.es also depends on the same unreliable transport, so 'user_xxxx' placeholder names can persist on desktop.
- detail: The Tauri Proxy in NostrProvider.tsx:924 only traps `prop === 'query'`; everything else goes through `Reflect.get`. So on desktop `nostr.event()` (publishing — useNostrPublish.ts:51, MultiColumnClient.tsx:447, useBookmarks.ts:221) and `nostr.relay(url).query()` (profile-indexer lookups in useAuthor.ts:78, NIP-65 discovery in useNip65Relays.ts:47, MultiColumnClient.tsx:1008, useBookmarks.ts:144) still run over the WebKitGTK WebSocket stack that NostrProvider.tsx:923 says 'never processes WebSocket frames'. There is no `relay_publish` command in packages/desktop/src-tauri/src/lib.rs:71-89. Compounding it, useNostrPublish.ts:52-56 swallows every relay error and still resolves the mutation successfully.
- plan: Add a `relay_publish(urls, event, timeout_ms) -> Vec<{url, ok, message}>` command in packages/desktop/src-tauri/src/relay.rs reusing do_query's connect/proxy/validate_relay_url plumbing (send `["EVENT", ev]`, collect `OK` frames), expose `tauriPublish()` in packages/web/src/lib/tauri.ts, and extend the NostrProvider Proxy to trap `event` and `relay` (returning a shim whose `.query()` calls `tauriRelayQuery(url, …)`). Independently, change useNostrPublish.ts:52-56 to surface a warning toast when zero relays accepted the event — that is a bug on all three platforms.

### Notes cache: single shared store vs two divergent stores (one of them dead)
- mobile: **partial** · desktop: **present** · effort: medium
- web impl: `packages/web/src/lib/notesCache.ts (getNotesFromMemory/saveNotesToCache/mergeNotesToCache, MAX 5000, LRU+TTL) consumed by useFollowNotesCache.ts:15-21 and useFeedPagination.ts:611,856,976`
- impact: On mobile every "load older" result is lost on app restart, the feed always snaps back to the last hour; on web/desktop paged-in notes survive a reload. Plus a whole-blob re-serialise on every merge (2000 notes ≈ MBs) on the UI thread.
- detail: packages/mobile/src/lib/notesCache.ts is a faithful MMKV port but exports DIFFERENT names (`getCachedNotes`/`setCachedNotes`/`mergeNotes`) and grep shows ZERO importers anywhere in packages/mobile/src — it is dead code that still runs a full key scan at import. Meanwhile packages/mobile/src/hooks/useFollowNotesCache.ts:15-79 reimplements its own cache as one JSON blob under `follow-notes-cache:events`, capped at 2000, re-serialised on every merge, with no LRU and no TTL. Consequence: mobile's pagination results are never persisted at all — packages/mobile/src/hooks/useFeed.ts:130-139 writes only to the React Query cache, whereas web's useFeedPagination calls mergeNotesToCache on every load-more/load-newer/gap-fill.
- plan: Rename mobile notesCache exports to match web (`getNotesFromMemory`, `saveNotesToCache`, `mergeNotesToCache`, `setCacheMetadata`, `isCacheLoaded`), delete the inline cache in useFollowNotesCache.ts:15-79 and import from lib/notesCache instead, and call `mergeNotesToCache(allTrulyNew)` in useFeed.ts:130 and useCustomFeedNotes's load paths. Also return a copy from `getCachedNotes` (web returns `[...sortedCache]`, notesCache.ts:106; mobile returns the live array at line 121).

### Nuclear wipe / "delete all local data"
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/hooks/useLoginActions.ts:371-473 (nuclearWipe) and :476-484 (logout → wipe + reload)`
- impact: There is no way to fully erase corkboards data from a phone short of uninstalling. A user handing over or selling a device cannot guarantee their dismissed-note history, corkboard names and cached profiles are gone — a direct miss against the cypherpunk/user-sovereignty values web honours.
- detail: grep for `nuclearWipe` in packages/mobile/src returns nothing. Mobile's AuthContext.logout (packages/mobile/src/lib/AuthContext.tsx:421-439) stashes each account's data with handleLogoutStorage, deletes keychain entries, and clears the relay/collapsed/profile caches — but it deliberately KEEPS every `user:<pubkey>:…` namespaced blob in MMKV, never calls `mmkv.clearAll()`, and never sweeps the notes-cache/note-cache/profile-cache prefixes.
- plan: Add `nuclearWipe(onProgress)` to packages/mobile/src/lib/AuthContext.tsx: enumerate `Keychain.getAllGenericPasswordServices()` and resetGenericPassword for every corkboards-* service (including `me.corkboards.mmkv`, so the encryption key itself is destroyed), then `mobileStorage.clear()` (mmkv.clearAll), `queryClient.clear()`, clearNotesCache(), clearCache(), clearCollapsedNotesModuleState(), clearUserZapCache(). Expose it in SettingsScreen behind a type-to-confirm dialog matching web's.

### Opening external links from notes (window.open / target=_blank)
- mobile: **present** · desktop: **missing** · effort: medium
- web impl: `/home/q4/corkboards/packages/web/src/components/WebLink.tsx:39-53; /home/q4/corkboards/packages/web/src/components/InlineLink.tsx:24-38; /home/q4/corkboards/packages/web/src/components/TrackerWarningDialog.tsx:26; /home/q4/corkboards/packages/web/src/components/MediaLink.tsx:137,489,507,556; /home/q4/corkboards/packages/web/src/components/ui/lightbox.tsx:123,206; /home/q4/corkboards/packages/web/src/components/ui/link.tsx:18; ProfileModal.tsx:275; ProfileCard.tsx:364; AdvancedSettings.tsx:662; WalletSettings.tsx:77; auth/SecurityInfoDialog.tsx:103-116; auth/SignerRecommendations.tsx:111; auth/WelcomePage.tsx:648`
- impact: On desktop, clicking ANY link in a note, the link-shield 'Open clean / Open original' buttons, the lightbox 'open original' link, profile website links, the Tor Project link in Advanced Settings, the coinos.io wallet link, and every signer-recommendation link do absolutely nothing. No error, no feedback — the app looks broken.
- detail: Nothing in packages/desktop/src-tauri wires link opening. Cargo.toml has no tauri-plugin-opener/tauri-plugin-shell, and lib.rs never calls `.on_new_window(...)`, so `pending.new_window_handler` stays None (tauri-2.10.3 src/webview/mod.rs:354/433 default). wry only connects the GTK `create` signal when that handler exists (wry-0.54.4 src/webkitgtk/mod.rs:487) — so on Linux both `window.open(url,'_blank')` and `<a target="_blank">` are complete no-ops. On macOS WKWebView `createWebViewWithConfiguration` likewise returns nil. Even if it were wired, wry's default is to open a chromeless in-app GTK window (mod.rs:498-530), not the system browser. Mobile has a proper guarded helper: /home/q4/corkboards/packages/mobile/src/lib/openExternal.ts.
- plan: Add `tauri-plugin-opener` to packages/desktop/src-tauri/Cargo.toml, register it in lib.rs, and grant `opener:allow-open-url` (scoped to https/http) in capabilities/default.json. Then create /home/q4/corkboards/packages/web/src/lib/openExternal.ts mirroring the mobile helper: reject non-http(s) via `isSafeExternalUrl` from @core/sanitizeUtils, and when `isTauri` call `await openUrl(url)` from @tauri-apps/plugin-opener, otherwise `window.open(url,'_blank','noopener,noreferrer')`. Replace every `window.open(...)` call site and add `onClick={(e)=>{ if(isTauri){e.preventDefault(); openExternal(href);} }}` to every `target="_blank"` anchor (or centralize them all through components/ui/link.tsx). Add an eslint rule banning bare `window.open` the same way mobile bans bare `Linking.openURL`.

### Per-note engagement fetch (reactions/reposts/zaps for notes outside the feed window)
- mobile: **present** · desktop: **missing** · effort: medium
- web impl: `none — web derives counts from kinds 6/7/9735 already present in FEED_KINDS results and passes them to EngagementBar as props`
- impact: On web/desktop, opening a permalink or scrolling into an old thread shows 0 likes / 0 reposts / 0 zaps even when the note has many, because no kind 6/7/9735 events were fetched for it.
- detail: packages/mobile/src/hooks/useNoteEngagement.ts:47-95 is a mobile-only hook that queries `{kinds:[6,7,9735], '#e':[eventId], limit:500}` per note, correctly resolving the LAST e-tag per NIP-25/NIP-18 (line 69-70) and grouping emoji reactions. Web has no equivalent, so any note web renders outside a feed fetch — a deep-linked note, an old thread ancestor, a quoted note — shows zero engagement.
- plan: Port useNoteEngagement.ts to packages/web/src/hooks/ (it has no RN dependency beyond useAuth → swap for useCurrentUser). Use it in NoteCard/ThreadView only when the note id is absent from the feed's engagement map, so the common path stays free. Keep the shared `normalizeReaction` and last-e-tag logic — ideally move both into packages/core so the two platforms can't drift.

### Pin a note to my corkboard (with optional comment)
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:139-200 (PinToBoardDialog), 4443 (onPinToBoard), 4601-4608 (dialog mount), 4440 (onPinClick); packages/web/src/hooks/usePinnedNotes.ts`
- impact: Mobile users cannot pin someone else's note to their own board — and with no 'Me' tab they couldn't see the result anyway. The "pin with a comment" flow (which publishes a quote note and pins it) is entirely absent.
- detail: packages/mobile/src/hooks/usePinnedNotes.ts exists but its only consumer is packages/mobile/src/screens/SavedScreen.tsx:38,148-152 (pin/unpin within Saved). packages/mobile/src/components/NoteCard.tsx and NoteActions.tsx expose no pin action, and packages/mobile/src/screens/ThreadScreen.tsx never passes an onPinToBoard.
- plan: Add a Pin action to the mobile note long-press menu and to ThreadReplyRow, opening an Alert-based confirm with 'Pin' / 'Pin with comment' (the latter opening ComposeScreen with quotedEvent set and pinning the published event), calling usePinnedNotes().togglePin.

### Release distribution: code signing, notarization, and Linux runtime dependencies
- mobile: **present** · desktop: **missing** · effort: medium
- web impl: `n/a — web is served over TLS from corkboards.me; mobile is signed by the store/EAS pipeline`
- impact: macOS Gatekeeper refuses to open the unsigned .app without a right-click override, Windows SmartScreen warns on every install, and on a clean Debian/Ubuntu the .deb installs but inline videos in notes fail to play with no explanation. Desktop is the only platform whose artifacts a user cannot trust by default.
- detail: /home/q4/corkboards/packages/desktop/src-tauri/tauri.conf.json's `bundle` block (lines 18-28) contains only `active`, `targets: "all"` and `icon`. There is no `macOS` section (no `signingIdentity`, no `entitlements`, no notarization), no `windows` section (no certificate/timestamp config), and no `linux.deb.depends`. Tauri's default deb dependencies cover libwebkit2gtk/libgtk only, so the GStreamer plugins WebKitGTK needs for H.264/AAC playback are not declared even though the app is media-heavy (MediaLink.tsx renders inline video/audio).
- plan: Add `bundle.macOS.signingIdentity` + `bundle.macOS.entitlements` and the notarization env vars to the release flow; add `bundle.windows.certificateThumbprint` + `timestampUrl`. Add `"linux": { "deb": { "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0", "gstreamer1.0-plugins-base", "gstreamer1.0-plugins-good", "gstreamer1.0-plugins-bad", "gstreamer1.0-libav"] } }` to the bundle block so media actually plays. Keep the versioned AppImage naming already in use (corkboards-linux-0.8.0.AppImage).

### Remote-signer login (NIP-46 bunker:// / nostrconnect:// QR)
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/components/auth/WelcomePage.tsx:55-63, 208-262 (bunker + nostrconnect handlers), 602-604 ("Log in with signer (QR code / bunker)"), 662-669 (QR view)`
- impact: A mobile user whose key lives in a remote bunker (nsec.app, Alby, a self-hosted nsecbunker) cannot log in on mobile at all unless they also use Amber. Web and desktop both support it.
- detail: packages/mobile/src/components/AddAccountModal.tsx:27 defines `LoginView = 'main' | 'nsec' | 'mnemonic' | 'create-backup' | 'amber'` and its own header comment (AddAccountModal.tsx:5) states "Browser extension and QR code / bunker flows are not available on mobile." packages/mobile/src/hooks/useSignerConnect.ts exists but AddAccountModal never routes to it.
- plan: Add a 'signer' view to AddAccountModal driving useSignerConnect: render the nostrconnect:// URI as a QR (react-native-qrcode-svg) plus a paste field accepting bunker:// URLs, with the same error messages as WelcomePage.tsx:218-229.

### Scroll-position persistence across tab switches, restarts and backgrounding
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/hooks/useScrollPersistence.ts:38-151`
- impact: On mobile, switching tabs or returning after the OS evicts the app always dumps the user at the top of the feed, losing their place. Web restores it with rAF bursts plus a 5s content-arrival poll.
- detail: No mobile counterpart, and grep for `corkboard:scroll-positions` in packages/mobile/src returns nothing. packages/mobile/src/screens/HomeScreen.tsx:588 uses onScroll only to set a `scrolledFromTop` boolean for the back-to-top button (line 627); no offset is ever saved or restored.
- plan: Add packages/mobile/src/hooks/useScrollPersistence.ts keyed the same way. `window.scrollY` → FlatList `onScroll` `e.nativeEvent.contentOffset.y` (throttle 16); `window.scrollTo` → `flatListRef.current.scrollToOffset({offset, animated:false})`; the rAF retry burst → `requestAnimationFrame` (available in RN) plus `onContentSizeChange` as the content-arrival signal, which is strictly better than web's scrollHeight poll; `document.visibilitychange` → `AppState` 'active'; sessionStorage → MMKV under `corkboard:scroll-positions` cleared on cold launch.

### Shakespeare AI streaming responses
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/hooks/useShakespeare.ts:214-~330 (sendStreamingMessage) and :368 (exported in the return object)`
- impact: AI replies appear all-at-once after the full round-trip on mobile, versus token-by-token on web/desktop — a several-second perceived hang.
- detail: packages/mobile/src/hooks/useShakespeare.ts declares `stream?: boolean` in its request type at line 25 but has no sendStreamingMessage — grep confirms the only `stream` hit is that type field. The mobile hook exposes only the blocking sendMessage.
- plan: Port sendStreamingMessage. RN's fetch does not expose `response.body` as a ReadableStream under Hermes, so use `react-native-fetch-api`/XHR with `onprogress` and parse SSE `data:` frames incrementally, or install `expo/fetch` (which does support streaming) — feed each delta to the same `onChunk` callback signature web uses so the UI layer is shared.

### Silent idle-return auto-restore (mobile) vs suggest-with-countdown (web)
- mobile: **partial** · desktop: **present** · effort: medium
- web impl: `packages/web/src/hooks/useIdleAutoRestoreCheck.ts:50-87 + packages/web/src/hooks/useAutoRestoreCountdown.ts:27-62`
- impact: Backgrounding the phone for 5+ minutes can silently overwrite local corkboards/dismissed state with an older-device checkpoint, with no notice and no undo. This is the exact data-loss class the web hook's comments say caused three production incidents.
- detail: Web NEVER silently restores on idle return: useIdleAutoRestoreCheck only calls `onSuggestRestore` when the remote checkpoint has >5 more dismissed notes than local (line 76), and useAutoRestoreCountdown then runs a visible 5s countdown the user can cancel. Mobile AutoSaveManager.tsx:128-153 calls `restoreBackup(newest)` directly with no user prompt, no countdown, no cancel, and a much weaker guard: it only skips when `hasMeaningfulLocal && lastBackupTs === 0` (line 139) — so a user WITH local data AND a nonzero lastBackupTs gets clobbered by any newer checkpoint. Mobile also hardcodes `5 * 60 * 1000` (line 102) instead of importing IDLE_AUTO_RESTORE_THRESHOLD_MS from @core/cacheConfig:29.
- plan: Port useIdleAutoRestoreCheck (AppState 'change' replaces visibilitychange; `lastHidden` bookkeeping already exists in AutoSaveManager) and useAutoRestoreCountdown into packages/mobile/src/hooks/. Replace AutoSaveManager.tsx:128-153 with `onSuggestRestore` → a Modal showing "Restoring in 5…" + Cancel. Import IDLE_AUTO_RESTORE_THRESHOLD_MS from @core/cacheConfig instead of the literal.

### Standalone relay-browse tab (paste wss:// and browse everything on that relay)
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/components/TabBar.tsx:486-491 / 654-679 (browseRelays tabs, draggable); packages/web/src/hooks/useRelayFeed.ts; packages/web/src/components/FeedInfoCard.tsx (onRemoveRelay via MultiColumnClient.tsx:4372)`
- impact: Mobile users cannot browse an arbitrary relay's firehose. A relay tab created on web is invisible on mobile even though it is in the synced backup.
- detail: packages/mobile/src/hooks/useRelayFeed.ts is implemented but imported nowhere (only its own file and a comment in packages/mobile/src/lib/NostrProvider.tsx:230 mention it). There is no `browseRelays` state on mobile at all — grep for 'browseRelays' in packages/mobile/src returns zero hits.
- plan: Add a `nostr-browse-relays` MMKV-backed list (same storage key web uses) rendered as extra pills in HomeScreen's tab strip; when active, drive the FlatList from `useRelayFeed({ relayUrl })` instead of `useFeed`. Add a remove action to the tab long-press menu.

### StatusBar feed controls: +25/+100, "Newer", autofetch toggle + countdown, auto-scroll-top, all-media toggle, column stepper, visible/dismissed/filtered/total stats
- mobile: **missing** · desktop: **present** · effort: medium
- web impl: `packages/web/src/components/StatusBar.tsx (whole file, 637 lines); wired at packages/web/src/pages/MultiColumnClient.tsx:4469-4510`
- impact: Mobile users can't pull an explicit batch of 25/100 older notes, can't force a "load everything newer", can't see the autofetch countdown, can't flip autofetch from the feed, and get no dismissed/filtered accounting.
- detail: There is no StatusBar equivalent in packages/mobile/src. HomeScreen offers only pull-to-refresh (HomeScreen.tsx:596-602) and onEndReached infinite scroll (HomeScreen.tsx:604-614). Autofetch is read-only on the feed (HomeScreen.tsx:223-231 reads STORAGE_KEYS.AUTOFETCH_SMALL) and can only be toggled by digging into Settings → Bandwidth & Performance (packages/mobile/src/screens/SettingsScreen.tsx:439-450). There is no countdown, no auto-scroll-top, no all-media toggle, and no visible/dismissed/filtered/total counter (HomeScreen.tsx:387-397 shows a shorter label).
- plan: Add a collapsible bottom bar component (packages/mobile/src/components/StatusBar.tsx) with +25/+100 (calling loadMoreByCount / customLoadMore), a Newer button calling refetch, an autofetch pill with the same countdown math as StatusBar.tsx:104-115, auto-scroll-top and all-media toggles bound to the shared STORAGE_KEYS, and the stats line from StatusBar.tsx:199-201.

### nostr: / web+nostr: protocol handling (opening a nostr link from outside the app)
- mobile: **partial** · desktop: **missing** · effort: medium
- web impl: `/home/q4/corkboards/packages/web/src/AppRouter.tsx:22 (`/:nip19` route → NIP19Page); no registerProtocolHandler anywhere; /home/q4/corkboards/packages/web/public/manifest.webmanifest has no protocol_handlers`
- impact: Clicking a `nostr:npub1…` or `nostr:nevent1…` link anywhere on the desktop OS never opens Corkboards. Web at least resolves corkboards.me/<nip19> URLs; desktop cannot be registered as a handler at all.
- detail: Mobile has a real handler — /home/q4/corkboards/packages/mobile/src/components/DeepLinkHandler.tsx:24-70 parses `corkboards://`, `nostr:` and `https://corkboards.me/<token>` on cold start and at runtime (though app.json only declares `scheme: "corkboards"`, so the OS-level `nostr:` association is not registered either). Desktop has nothing: tauri.conf.json declares no `plugins.deep-link` / `bundle.deepLinkProtocols`, Cargo.toml has no tauri-plugin-deep-link, and no single-instance plugin exists to forward a second-launch URL to the running window.
- plan: Add tauri-plugin-deep-link + tauri-plugin-single-instance to packages/desktop/src-tauri, declare `"deep-link": { "desktop": { "schemes": ["nostr", "web+nostr", "corkboards"] } }` in tauri.conf.json's plugins section, grant `deep-link:default` in capabilities/default.json, and mount a web-side DeepLinkHandler that mirrors the mobile one: `onOpenUrl(urls => navigate('/'+extractNip19Token(urls[0])))` under `if (isTauri)`. Reuse mobile's `extractNip19Token` by promoting it to packages/core so all three platforms parse identically, and add `protocol_handlers` for `web+nostr` to manifest.webmanifest for the PWA.

### packages/core has zero unit tests, and a test placed there would be run by NOBODY
- mobile: **partial** · desktop: **missing** · effort: medium
- web impl: `19 test files / 210 tests under /home/q4/corkboards/packages/web/src (verified by running `npx vitest run`)`
- impact: The one package every platform shares is the least tested. A regression in `contactList.ts` silently wipes a follow list on all three platforms at once — precisely the data-loss class the project treats as non-negotiable — and no suite would catch it. Adding a test next to the code you changed appears to work locally (the file is written) but is never executed by `npm test`.
- detail: Verified counts: web 19 test files / 210 tests; mobile 2 files / 16 tests (`packages/mobile/src/__tests__/core-imports.test.ts`, `core-parity.test.ts`); **core 0 test files** across 33 source modules. `packages/core/package.json` `"test": "tsc --noEmit && eslint && echo 'Core checks passed!'"` — there is no test runner at all. Worse, a `*.test.ts` added under `packages/core/src` would be executed by no runner: web's vitest root is `packages/web` (vite.config.ts has no `test.include` override, so the default glob is relative to that root) and mobile's jest `rootDir` is `packages/mobile` (jest.config.js testMatch `**/__tests__/**` resolves under rootDir). Core logic is covered only incidentally, via web tests that deep-import it (paginationCore, ipUtils, imageUtils, nostrUtils, normalizeRelay, router, zap, feedAlgorithms, blossom, sanitizeUtils, noteClassifier, nip99, noteCategories). Core modules with ZERO coverage anywhere: `contactList.ts` (123 lines — the kind-3 republish safety helpers), `cryptoUtils.ts`, `hashCore.ts`, `keyedMutex.ts`, `threadTree.ts`, `storageKeys.ts` (397 lines — user-isolation key derivation), `textTruncation.ts`, `rss.ts`, `failedNotes.ts`, `paginationCore` partially, `cacheConfig.ts`, `imageProxy.ts`, `formatTimeAgo.ts`, `defaultEmojiSet.ts`, `emojiCategories.ts`.
- plan: Add vitest to core as its own runner: create `packages/core/vitest.config.ts` with `test: { environment: 'node', include: ['src/**/*.test.ts'] }` and `resolve.alias { '@core': path.resolve(__dirname, './src') }`; change `packages/core/package.json` `test` to `tsc --noEmit && eslint && vitest run --reporter=dot`. Add `vitest` to core's devDependencies. Then MOVE the pure-core tests out of web into core (`paginationCore.test.ts`, `ipUtils.test.ts`, `router.test.ts`, `zap.test.ts`, `feedAlgorithms.test.ts`, `blossom.test.ts`, `parseListing.test.ts`, `stripTrackingParams.test.ts`, `canonicalMediaUrl.test.ts`, `buildReplyTags.test.ts`, `hashtagFeedVerdict.test.ts`) so they run once, at the source, for all three platforms. Backfill `contactList`, `storageKeys`, `threadTree`, `keyedMutex`, `cryptoUtils`, `hashCore` first.

### useCollapsedNotes persistence + cross-instance sync (save/dismiss/consolidate)
- mobile: **partial** · desktop: **present** · effort: medium
- web impl: `packages/web/src/hooks/useCollapsedNotes.ts:1-60 (module state + sessionStorage), and useLocalStorage-backed collapsedIds/dismissedIds`
- impact: On mobile: saving a note in the thread view doesn't update the badge/count in the feed; soft-dismissed notes all reappear after the OS kills the backgrounded app; and undoing a thread-wide dismiss only brings back one note.
- detail: Three concrete divergences, all verified by reading both files. (1) Web backs collapsedIds/dismissedIds/dismissedThreadRoots with `useLocalStorage`, so every mount and every other component reading those keys stays in sync via the `idb-storage-sync` event. Mobile uses plain `useState` + direct `saveToMmkv` (packages/mobile/src/hooks/useCollapsedNotes.ts:setCollapsedIds/setDismissedIds) and its module-level `listeners` set only re-broadcasts soft-dismissed / undo / session counters — never the collapsed or dismissed arrays. Two mounted instances therefore diverge. (2) Web hydrates `_softDismissedSet` and `_sessionCollapsedIds` from sessionStorage (web lines 15-19, 35-40) and re-persists on every change (`persistSoftDismissed`, `notifySessionCollapsedChange`); mobile initialises both to `new Set()` and never persists. (3) Web has `_dismissBatchMap` + `isBatchTrigger` so undoing the note you clicked undoes the whole "dismiss all associated" batch; mobile's undoDismiss removes exactly one id and `isBatchTrigger` is absent from the return object.
- plan: Swap mobile's three `useState`+saveToMmkv setters for `useLocalStorage('collapsed-notes', [])` etc. (it already emits DeviceEventEmitter sync). Persist `_softDismissedSet`/`_sessionCollapsedIds` to MMKV under `corkboard:soft-dismissed`/`corkboard:session-collapsed` and clear them in App.tsx when `AppState` transitions from a cold start (there is no sessionStorage, so gate on a launch nonce). Port `_dismissBatchMap` + `isBatchTrigger` verbatim from web lines 42-45 and the dismissMultiple/undoDismiss bodies.

### Account-previously-deleted detection screen
- mobile: **missing** · desktop: **present** · effort: small
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:403-420 (kind-5 self-deletion probe), 3518-3546 (Account Deleted screen with nuclearWipe logout)`
- impact: A user who deleted their account and logs back in on mobile sees a normal but broken app (profile/contacts gone from relays) with no explanation and no guided path to start fresh.
- detail: No equivalent kind-5 probe exists in packages/mobile/src. packages/mobile/src/screens/SettingsScreen.tsx:183-205 can *publish* a vanish request but the app never detects one on next login.
- plan: Add the same kind-5 probe on login in the mobile auth bootstrap and render a full-screen notice with a wipe-and-logout button mirroring MultiColumnClient.tsx:3518-3546.

### Auto-restore countdown banner with Cancel
- mobile: **missing** · desktop: **present** · effort: small
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:4512-4521 (autoRestoreTarget + autoRestoreCountdown banner); packages/web/src/hooks/useAutoRestoreCountdown.ts, useAutoRestoreGuard.ts, useIdleAutoRestoreCheck.ts`
- impact: On mobile, returning after 5+ minutes can replace local state with a cloud checkpoint with no warning and no way to stop it — the highest-risk data-loss path on the platform.
- detail: packages/mobile/src/components/AutoSaveManager.tsx:127-153 restores the newest checkpoint immediately and silently (guarded only by the hasMeaningfulLocal check at AutoSaveManager.tsx:134-145). There is no countdown, no banner, and no cancel. None of useAutoRestoreCountdown / useAutoRestoreGuard / useIdleAutoRestoreCheck have mobile ports.
- plan: Port useAutoRestoreCountdown to mobile and render a top banner ("restoring in Ns — Cancel") before calling restoreBackup in AutoSaveManager.tsx:146-152.

### Auto-save orchestration gates (page-load cooldown, restore-in-flight gate, failure toasts, saved/unsaved indicator)
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/hooks/useAutoSaveTrigger.ts:62-119`
- impact: Silent backup failures on mobile — the user believes their corkboards are backed up when no server accepted them. Plus a real corruption window: restore and auto-save can run concurrently.
- detail: Web's triggerIfReady has four gates; mobile's (packages/mobile/src/components/AutoSaveManager.tsx:44-62) has one. Missing on mobile: (1) the page-load cooldown `msSinceLoad < cooldownMs` (web line 69) — mobile can auto-save seconds after cold start; (2) the restore gate `backupStatus === 'found'|'restoring'|'restored'` (web line 64) — mobile can fire an auto-save WHILE restoreBackup is mid-flight and upload half-restored state; (3) `setBackupIndicator('unsaved'/'saved')` — mobile has no indicator at all; (4) the AutoSaveResult handling at web lines 96-118 — mobile does `autoSaveBackup().catch(...)` (line 59) and discards the returned 'no-servers'/'error' value, so a user whose every Blossom server rejects the blob gets zero feedback. Mobile also lacks the beforeunload analogue for process kill (only AppState background).
- plan: Add `cooldownMs` + a `pageLoadTime` ref to AutoSaveManager and return early inside triggerIfReady (mirror useAutoSaveTrigger.ts:64-78). Pass `status` from useNostrBackup into the same early-return. Consume the AutoSaveResult union (mobile already returns it from useNostrBackup.ts:181) and surface 'no-servers'/'error' via the existing useToast (`variant: 'destructive'`). Add a `backupIndicator` state + a small dot in the header.

### Backup & Restore dialog — checkpoint history with stats, corkboard names, explicit Save-checkpoint, and "Search for more" relay scan
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:3982-4083 (dialog: current state, autosave history with per-checkpoint corkboard/saved/dismissed counts, Save button, scanOlderStates), 4783-4809 (checkpoint restore confirm)`
- impact: A mobile user restoring a backup is choosing blind — no indication of how many corkboards/saved/dismissed items each checkpoint contains, and no way to search relays for older states when the recent five are all bad.
- detail: packages/mobile/src/screens/SettingsScreen.tsx:381-433 shows Back-up-now, Check-for-backup, and a bare list of up to 5 checkpoints rendered as `formatTimeAgo(cp.timestamp)` + Restore. No current-state summary, no per-checkpoint stats/corkboard names, and no scanOlderStates button (the mobile BackupSplashScreen has a scanOlderStates prop at BackupSplashScreen.tsx:30 but that component is never mounted).
- plan: Extend the mobile backup section to render cp.stats + cp.corkboardNames like MultiColumnClient.tsx:4045-4050, show a current-state summary, and add a "Search for more" button calling the same scan routine useNostrBackup exposes.

### Bookmarks: migration from collapsed-notes and external-write resync
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/hooks/useBookmarks.ts:66-69 (`nostr-bookmarks-migrated` flag), :80-113 (idb-storage-sync listener + idbReady re-read), :267-269 (one-time seed from collapsed-notes when the relay list is found but empty)`
- impact: An existing mobile user's saved-for-later notes are never promoted into their kind-10003 bookmark list, so bookmarks look empty on mobile until they re-save; and a cloud restore that rewrites `nostr-bookmark-ids` doesn't refresh a mounted bookmarks view.
- detail: Verified by grep: packages/mobile/src/hooks/useBookmarks.ts contains no `migrat`, no sync-event listener and no storage-ready re-read. It only persists to MMKV on state change (its useEffect at line ~68). NIP-44 encrypt/decrypt and the public-tag mirror ARE at parity.
- plan: Port the migration block (web :267-269) using a `nostr-bookmarks-migrated` MMKV flag seeded from `collapsed-notes`. Once the storage-layer sync event from the earlier item exists, subscribe to it for `nostr-bookmark-ids` and re-read, mirroring web :80-113.

### Bulk author prefetch coverage: p-tag pubkeys, batching past 100, MAX_PREFETCH
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/hooks/useBulkAuthors.ts:24-35 (extractPubkeys incl. `p` tags), :46-48 (MAX_PREFETCH 500), :74-107 (chunks of BATCH_SIZE 100, Promise.allSettled)`
- impact: On mobile, mentioned users (`@name` inside a note) render as `user_xxxx`/npub until each card individually fetches them; and on a feed with >100 distinct authors the tail of the list never gets prefetched at all.
- detail: packages/mobile/src/hooks/useAuthor.ts:156-159 collects only `note.pubkey` — it never walks `note.tags` for `p` entries the way web's extractPubkeys does. And line 183 issues a SINGLE query with `authors: toFetch.slice(0, 100)` while passing `limit: toFetch.length`: everything past the first 100 pubkeys is silently discarded rather than batched into further queries.
- plan: Copy `extractPubkeys` from web useBulkAuthors.ts:24-35 into mobile useAuthor.ts and use it in prefetchFromNotes. Replace the single query at line 182-185 with the web chunking loop (BATCH_SIZE 100, MAX_PREFETCH 500, `Promise.allSettled`), and set each filter's `limit` to `batch.length`, not `toFetch.length`.

### Dead-code cleanup / drift risk: mobile components that were ported but never mounted
- mobile: **partial** · desktop: **n/a** · effort: small
- web impl: `n/a — this is a mobile-side hygiene item covering the gaps above`
- impact: Indirect but important: these files make the codebase *look* at parity while the features are unreachable, which is why several gaps above went unnoticed. They also drift out of sync with their web counterparts with no test or type error to catch it.
- detail: Verified unreferenced in packages/mobile/src (imported by nothing outside their own file): BackupRestoreUI.tsx (duplicate of the inline SettingsScreen backup section), BackupSplashScreen.tsx, BackupDownloadPrompt.tsx, LoadingSplashScreen.tsx, FeedGrid.tsx, ContentFilters.tsx, FeedInfoCard.tsx, NoteLink.tsx, ProfileLink.tsx, EmojiName.tsx, WebLink.tsx; plus hooks useCustomFeed (only its `batchFetchByAuthors` export is used), useFollowNotesCache, useFollowSets, useLoggedInAccounts, useOnboardDiscover, useOnboardFollowActivity, useParentNotes, useRelayFeed, useRelayHealth, useRetryFailedNotes, useRssFeed, useShakespeare, useTheme.
- plan: Mount each one as part of the fixes above (FeedInfoCard, ContentFilters, NoteLink, ProfileLink, EmojiName, BackupSplashScreen, BackupDownloadPrompt, useParentNotes, useFollowSets, useRelayFeed, useRssFeed, useOnboard*, useRetryFailedNotes, useRelayHealth, useTheme) and delete the genuinely redundant ones (BackupRestoreUI, LoadingSplashScreen, and either FeedGrid or HomeScreen's inline FlatList). Add a lint rule or a mobile parity test that fails when a component under src/components has no importer.

### Debug logging / on-disk activity log
- mobile: **present** · desktop: **partial** · effort: small
- web impl: `/home/q4/corkboards/packages/web/src/lib/debug.ts:3; /home/q4/corkboards/packages/web/src/main.tsx:55-102; /home/q4/corkboards/packages/desktop/src-tauri/src/logger.rs:71-89`
- impact: The desktop app keeps a cleartext, world-readable record of everything the user reads and every relay they talk to for the whole session. For a cypherpunk-positioned app whose selling point is 'no telemetry, no tracking, no third-party leakage', an unrequested local activity log is a meaningful privacy regression versus web and mobile.
- detail: debug.ts:3 sets `DEBUG = import.meta.env.DEV || VITE_DEBUG || isTauri` — verbose logging is unconditionally ON in production desktop builds, and main.tsx:88-99 pipes console.log/warn/error into `write_log`, which appends to a plaintext ~/.local/share/me.corkboards.desktop/debug.log. What lands there includes raw RSS response bodies (feedUtils.ts:33 logs `text.slice(0,500)`), every relay URL and filter, note ids, NIP-46 protocol traces (useLoginActions.ts:163-190) and logout progress. logger.rs:83-87 opens the file with default 0644 permissions (no `.mode()`), so it is world-readable on a shared Linux box. There is no settings toggle to disable it and no 'delete log' action. Mobile is the opposite: /home/q4/corkboards/packages/mobile/src/lib/debug.ts:2 is `__DEV__` only.
- plan: Drop `|| isTauri` from packages/web/src/lib/debug.ts:3 and instead read an opt-in flag (e.g. a `corkboard:desktop-debug-log` platform setting) so the file log is off by default. Add a 'Desktop diagnostics' block in AdvancedSettings.tsx with an on/off switch, an 'Open log folder' action and a 'Delete log now' button wired to `clear_log`. In logger.rs, create the file with 0600 via `std::os::unix::fs::OpenOptionsExt::mode(0o600)` (and do the same for proxy.rs's proxy.json).

### Delete your own note (NIP-09 kind 5) from the note card
- mobile: **missing** · desktop: **present** · effort: small
- web impl: `packages/web/src/components/NoteCard.tsx:124-153 (DeleteNoteButton with inline confirm); wired at packages/web/src/pages/MultiColumnClient.tsx:4444 (onDeleteNote)`
- impact: A user who posts something wrong from their phone cannot request its deletion from their phone — they must open web or desktop.
- detail: packages/mobile/src/components/NoteCard.tsx / NoteActions.tsx have no delete affordance. Mobile publishes kind 5 only for whole-account deletion (packages/mobile/src/screens/SettingsScreen.tsx:183-205).
- plan: Show a Delete action on the mobile note long-press menu when `event.pubkey === myPubkey`, with a two-tap confirm mirroring NoteCard.tsx:127-142, publishing `{ kind: 5, tags: [['e', event.id]] }` via useNostrPublish.

### Delete-account confirmation flow
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:4710-4760 (two-step dialog listing every kind that gets a deletion request), 426-463 (handleVanish)`
- impact: Irreversible account deletion is one tap further along on mobile than on web, and mobile leaves local MMKV data behind after the vanish.
- detail: packages/mobile/src/screens/SettingsScreen.tsx:183-205 publishes the identical six deletion targets, but the confirmation is whatever packages/mobile/src/components/AdvancedSettings.tsx shows for the 'delete' action — a single Alert. There is no two-step confirm and no enumeration of kinds 0/3/10002/30078/35571/35572. Mobile also does not run loginActions.nuclearWipe()-equivalent local data wipe (SettingsScreen.tsx:204 just calls logout()).
- plan: Make mobile's delete flow two-step with the same kind list, and wipe local storage after publishing (mirroring nuclearWipe) so the vanished identity leaves nothing on-device.

### Deploy artifacts are hand-assembled — .htaccess in dist_deploy has already drifted
- mobile: **n/a** · desktop: **n/a** · effort: small
- web impl: `/home/q4/corkboards/packages/web/.htaccess (2674 bytes) vs /home/q4/corkboards/dist_deploy/.htaccess (1894 bytes)`
- impact: An embedded third-party frame (YouTube/Spotify/Twitch are allowed by `frame-src`) can prompt for camera/mic/geolocation under the corkboards.me origin, and the site is not opted out of FLoC/Topics cohort targeting — directly contradicting the project's no-third-party-leakage value.
- detail: `packages/web/.htaccess` is not in `public/`, so nothing in `npm run build` copies it. CLAUDE.md tells the operator to copy it by hand into `dist_stage`/`dist_deploy`. Diffing source against the deployed copy shows the deployed one is missing the entire `Permissions-Policy` block (`accelerometer=(), camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=(), interest-cohort=() ...`) and the Cross-Origin-Opener-Policy rationale comment — i.e. dist_deploy is a pre-v0.8 .htaccess. Same class of failure as the rss-proxy drift, same root cause: no script assembles the deploy artifact.
- plan: Add to `packages/web/package.json`: `"postbuild": "cp rss-proxy.php .htaccess dist/"` (or fold into the existing `build` chain after the sw.js rewrite). Then reduce the CLAUDE.md `stage`/`deploy` steps to `rm -rf dist_deploy && cp -a packages/web/dist/. dist_deploy/` with no per-file copy list, so drift becomes structurally impossible.

### ESLint 9 (web/core) vs ESLint 10 (mobile) with a shared typescript-eslint
- mobile: **present** · desktop: **n/a** · effort: small
- web impl: `/home/q4/corkboards/packages/web/package.json (eslint ^9.9.0, @eslint/js ^9.9.0, globals ^15.9.0) vs /home/q4/corkboards/packages/mobile/package.json (eslint ^10.4.0, @eslint/js ^10.0.1, globals ^17.6.0)`
- impact: The three packages are linted by two different engines with two different recommended baselines, so "lint is green" means something different per package. A typescript-eslint or ESLint patch release can break mobile's lint alone, with no repo change.
- detail: Installed: root eslint 9.39.4 / @eslint/js 9.39.4 / globals 15.15.0; packages/mobile/node_modules eslint 10.4.0 / @eslint/js 10.0.1 / globals 17.6.0. `typescript-eslint` 8.59.3 is hoisted at root and shared by all three configs — including mobile's ESLint 10, which is outside the range typescript-eslint 8.x was published against. It works today (verified: `npm run test:mobile` passes) but it is unpinned goodwill. `js.configs.recommended` also differs between @eslint/js 9 and 10, so the two trees inherit different base rule sets before any project rule is applied.
- plan: Pick one ESLint major for the whole monorepo — 9 is the safer choice today given typescript-eslint 8.x's supported range. Set `eslint`, `@eslint/js`, `globals` and `typescript-eslint` to identical versions in all three package.jsons and hoist them to root `devDependencies` so there is one copy. If you prefer ESLint 10, bump typescript-eslint to a release that declares an ESLint 10 peer first, and move all three together in the same commit.

### Embedded note preview for nostr:note1…/nevent1… mentions
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/components/NoteContent.tsx:5,331-341 (NoteLink / ProfileLink); packages/web/src/components/NoteLink.tsx (full quoted-note card, incl. ListingCard at NoteLink.tsx:132)`
- impact: Quote-posts on mobile show a truncated hex id instead of the quoted note — directly contrary to the project rule "show avatars + human-readable nicknames, not raw/truncated npubs". Profile mentions show the right name but tapping them does nothing.
- detail: packages/mobile/src/components/NoteContent.tsx:76-85 renders an embedded note as the literal text `note:1a2b3c4d…`. The rich preview component packages/mobile/src/components/NoteLink.tsx (267 lines, with skeleton, not-found + retry, and an InlineNoteLinkContent card) exists but is imported by nothing. Likewise packages/mobile/src/components/ProfileLink.tsx (110 lines) is unused; NoteContent.tsx:70-74 ProfileMention resolves the display name but renders as non-tappable <Text>.
- plan: Replace NoteMention with the existing packages/mobile/src/components/NoteLink.tsx and ProfileMention with packages/mobile/src/components/ProfileLink.tsx. Because both render View-level cards they must be hoisted out of the enclosing <Text> in NoteContent.tsx:656-683 — split inlineParts so a note embed becomes a block-level part alongside mediaParts.

### Expo SDK 54 runtime paired with SDK-55 packages
- mobile: **partial** · desktop: **n/a** · effort: small
- web impl: `n/a — mobile-only defect in /home/q4/corkboards/packages/mobile/package.json`
- impact: Native builds (EAS / `expo run:android`) autolink native modules compiled against a different SDK's Expo modules core — the classic symptom is a runtime crash on first call into Clipboard or the dev-client, or a Gradle/CocoaPods resolution failure that only appears in a release build, never in Metro dev. `babel-preset-expo` 55 also transforms with SDK-55 assumptions against SDK-54 runtime shims.
- detail: `expo@54.0.33` is installed (packages/mobile/node_modules/expo). Its own `bundledNativeModules.json` declares the versions SDK 54 is built against: expo-clipboard `~8.0.8`, expo-dev-client `~6.0.20`, expo-image-picker `~17.0.10`, expo-video `~3.0.15`, expo-status-bar `~3.0.9`, react-native `0.81.5`. Installed instead: expo-clipboard **55.0.9**, expo-dev-client **55.0.19** (both a whole SDK generation AHEAD), expo-image-picker **16.1.4** (a major BEHIND), plus `jest-expo@55.0.11` and `babel-preset-expo@55.0.13` — SDK-55 tooling driving an SDK-54 runtime. Only expo-video, expo-status-bar and react-native match.
- plan: Decide one SDK and hold it. Fastest path: `cd packages/mobile && npx expo install --check` then `npx expo install --fix`, which rewrites every `expo-*` to the version in `bundledNativeModules.json`, and manually pin `jest-expo`/`babel-preset-expo` to the SDK-54 line. If you actually want SDK 55, bump `expo` itself to `~55` first and re-run `expo install --fix`. Then wire `npx expo-doctor` into `packages/mobile` `test` so this can never silently regress: `"test": "tsc --noEmit && eslint && npx expo-doctor && jest --silent"`.

### Markdown-detection heuristic (single source of truth)
- mobile: **missing** · desktop: **present** · effort: small
- web impl: `packages/web/src/lib/markdownDetect.ts (MARKDOWN_INDICATORS_PATTERN + contentHasAssumedMarkdown, 10k-char ReDoS guard)`
- impact: A note hidden by the "hide markdown" filter on web can still appear on mobile (and vice-versa) for the same user with the same synced settings.
- detail: No mobile equivalent. packages/mobile/src/components/NoteContent.tsx:333-371 does its own ad-hoc `[text](url)` link extraction and packages/mobile/src/components/ContentFilters.tsx:3 mentions a markdown filter, but neither uses a shared pattern. Note the `corkboard:hide-markdown` filter rule is a SHARED backed-up key (packages/core/src/storageKeys.ts:59), so the same rule is evaluated by two different heuristics on the two platforms.
- plan: Move markdownDetect.ts into packages/core/src/ (it is pure regex, no DOM), re-export from packages/web/src/lib/markdownDetect.ts for existing imports, and use `contentHasAssumedMarkdown` in the mobile ContentFilters markdown rule and in SmartNoteContent's show-original toggle.

### Mobile ESLint severity is materially weaker than web/core
- mobile: **partial** · desktop: **n/a** · effort: small
- web impl: `/home/q4/corkboards/packages/web/eslint.config.js vs /home/q4/corkboards/packages/mobile/eslint.config.mjs`
- impact: `any` and dead variables are hard failures on web and core but pass silently on mobile, so ported code degrades in type safety as it crosses platforms — the opposite of the stated "all platforms as identical as possible" goal.
- detail: `eslint --print-config` output, side by side. Web/core: `@typescript-eslint/no-explicit-any: [2]` (error), `@typescript-eslint/no-unused-vars: [2, {argsIgnorePattern:'^_', varsIgnorePattern:'^_', ignoreRestSiblings:true}]` (error). Mobile: `@typescript-eslint/no-explicit-any: [1]` (warn), `@typescript-eslint/no-unused-vars: [0]` (OFF), replaced by `unused-imports/no-unused-vars: [1]` (warn) — only `unused-imports/no-unused-imports` is an error. The comment in `packages/mobile/eslint.config.mjs` justifies the `any` downgrade as "RN allows `any` for native bridge types more often than web", which is defensible at the bridge but is applied to the whole 143-file tree including the ported `@core` consumers.
- plan: Raise `unused-imports/no-unused-vars` to `'error'` in `packages/mobile/eslint.config.mjs` (it already has the `^_` escape hatches, so it will match web's behaviour). For `no-explicit-any`, either raise to `'error'` globally and add a narrow override block `{ files: ['src/types/**', 'src/lib/*Native*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } }`, or leave it at warn but add `--max-warnings=0` to mobile's lint invocation so the count cannot grow.

### Mobile never verifies that the app bundles
- mobile: **missing** · desktop: **missing** · effort: small
- web impl: `/home/q4/corkboards/packages/web/package.json `test` ends with `vite build -l error` — a real bundle check`
- impact: A shared-core change that resolves fine under tsc/vitest but breaks Metro — a new transitive dep with no RN build, a package.json `exports` condition Metro cannot follow, an import Hermes rejects — passes `npm run test` green and only fails when someone runs the app.
- detail: `packages/mobile/package.json` `test` = `tsc --noEmit && eslint && jest --silent`. There is no `expo export`, no Metro bundle, no `expo-doctor`. Verified by reading the scripts block — the only scripts are start/android/ios/typecheck/lint/test/test:unit. Metro resolution is configured independently of TypeScript in three separate places that can each drift: `packages/mobile/babel.config.js` (module-resolver alias `'@core': '../core/src'`), `packages/mobile/metro.config.js` (watchFolders + `extraNodeModules` forcing mobile's React 19 over the hoisted React 18), and `packages/mobile/jest.config.js` (moduleNameMapper). tsc validates none of them. Desktop likewise has no `test` script at all — `packages/desktop/package.json` has only `dev` and `build`.
- plan: Append a bundle check to `packages/mobile` `test`: `npx expo export --platform android --output-dir /tmp/expo-export-check` (or `npx expo export:embed --dev false --platform android` for a faster Metro-only pass). Add `packages/mobile/.gitignore` entry for the output dir. Also give `packages/desktop` a `test` script that at minimum runs `cargo clippy`, so `npm run lint`/`typecheck` at root can be extended to all four packages symmetrically.

### Mobile-only: "Global" feed tab
- mobile: **present** · desktop: **missing** · effort: small
- web impl: `no web equivalent — web's closest analogue is a per-relay browse tab (packages/web/src/components/TabBar.tsx:654-679)`
- impact: A mobile user can browse a global firehose; a web/desktop user must add a specific relay tab to approximate it.
- detail: packages/mobile/src/screens/HomeScreen.tsx:72,152-155,510 defines a `global` tab that runs useFeed with an empty author list (unrestricted query). Web has no unrestricted global tab.
- plan: Decide deliberately. Given the product is a *curated* board builder, the web relay tab is arguably the better model — either add a 'Global' tab to web's TabBar for symmetry, or drop it from mobile once mobile gains relay tabs. Do not leave it asymmetric.

### NIP-51 follow-set (kind 30000) quick-fill when building a corkboard
- mobile: **missing** · desktop: **present** · effort: small
- web impl: `packages/web/src/components/TabBar.tsx:303-332 (followSets buttons); packages/web/src/pages/MultiColumnClient.tsx:215 (useFollowSets)`
- impact: Mobile users cannot seed a corkboard from the people-lists they built in Amethyst/Coracle/etc., so they must re-add every npub by hand (which they also can't do — see the builder gap).
- detail: packages/mobile/src/hooks/useFollowSets.ts exists and is fully implemented, but is imported by nothing (verified by grep across packages/mobile/src and App.tsx). With no corkboard builder there is nowhere to surface it.
- plan: Once the mobile corkboard editor exists, render `useFollowSets()` results as a horizontal chip row that unions `list.pubkeys` into the board's pubkey set, exactly as TabBar.tsx:310-327 does.

### No formatter, no editorconfig, no Node version pin
- mobile: **missing** · desktop: **missing** · effort: small
- web impl: `repo root — no .prettierrc, no .editorconfig, no .nvmrc, no `engines` field in any of the five package.json files`
- impact: Formatting noise inflates diffs across platform-parity commits — the very commits that need to be readable side by side to confirm three platforms got the same change. A contributor on Node 20 or 24 hits errors CI never sees.
- detail: Confirmed by listing the repo root and reading all five package.jsons. Formatting is therefore whatever each contributor's editor does — visible already in the codebase: `packages/web/tailwind.config.ts` is tab-indented while every other TS file is 2-space, and `packages/web/eslint.config.js` uses double quotes while `packages/core/eslint.config.js` and `packages/mobile/eslint.config.mjs` use single. Node is pinned only implicitly: `.gitlab-ci.yml` says `image: node:22` and the local toolchain is v22.22.0, but nothing declares it. Rust has no `rust-toolchain.toml` either.
- plan: Add a root `.editorconfig` (2-space, LF, final newline, UTF-8) and a root `.nvmrc` containing `22`. Add `"engines": { "node": ">=22 <23" }` to the root package.json. If you want a formatter, prefer `@stylistic/eslint-plugin` rules in the three existing flat configs over adding Prettier — that keeps one tool and one command (`npm run lint`) rather than introducing a second.

### Notification → open thread
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/components/NotificationsCorkboard.tsx:280-284 (`onViewThread` passed to every NotificationCard); MultiColumnClient.tsx:4243`
- impact: Tapping any notification on mobile does nothing. A user cannot get from "someone replied to you" to the reply — the Activity tab is a dead end.
- detail: packages/mobile/src/components/NotificationCard.tsx:81 declares `onViewThread?: (eventId: string) => void` and uses it at NotificationCard.tsx:151 (`onPress={() => onViewThread?.(threadTargetId)}`), but packages/mobile/src/screens/NotificationsScreen.tsx:222-224 renders `<NotificationCard notification={item} />` with no onViewThread. NotificationsScreen also mounts no ThreadScreen modal.
- plan: Add `const [viewingThread, setViewingThread] = useState<string|null>(null)` to NotificationsScreen, pass `onViewThread={setViewingThread}` into NotificationCard, and mount the same `<Modal><ThreadScreen …/></Modal>` block HomeScreen uses at HomeScreen.tsx:654-663. Wrap in ProfileModalProvider so avatar taps work too.

### Onboarding "find more for me" activity expansion
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:16-17 (useOnboardDiscover, useOnboardFollowActivity), 4460-4461 (onFindMoreForMe / isFindingMore into FeedGrid)`
- impact: A new mobile user who exhausts the initial suggestions has no way to pull more candidates and stalls below the 10-follow onboarding target.
- detail: packages/mobile/src/hooks/useOnboardDiscover.ts and useOnboardFollowActivity.ts are both implemented but imported by nothing (verified). packages/mobile/src/screens/DiscoverScreen.tsx:393-399 mounts OnboardSearchWidget only; there is no "Find more for me" button feeding extra candidate profiles.
- plan: Wire useOnboardFollowActivity into DiscoverScreen with a "Find more for me" button shown while `isOnboarding`, matching MultiColumnClient.tsx:4459-4461.

### Profile cache: L1 in-memory tier, bulk read, and TTL-honouring sync read
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/lib/cacheStore.ts:52-76 (LRU memProfileCache, 200), :165-202 (getCachedProfiles bulk), :204-213 (getCachedProfileSync honours maxAge — the (M3) fix)`
- impact: Mobile can display a display-name/avatar that changed months ago and never refresh it via the sync path; and profile reads cost a JSON.parse per card per render during scroll.
- detail: Three concrete deltas in packages/mobile/src/lib/cacheStore.ts. (1) `getCachedProfileSync(pubkey)` at line 52-61 takes NO maxAge parameter and never compares `cachedAt` — it returns arbitrarily stale metadata, which is the exact bug web's (M3) comment records fixing. (2) There is no L1 map: every getCachedProfile is an MMKV read + JSON.parse on the render path. (3) There is no `getCachedProfiles` bulk API, which is why mobile's prefetch (useAuthor.ts:167) loops single reads.
- plan: Add `maxAge = 24*60*60*1000` to mobile getCachedProfileSync and return null when `Date.now() - profile.cachedAt > maxAge` (mirror web lines 208-213). Add an LRU `Map<string, CachedProfile>` capped at 200 with the delete-then-reinsert pattern from web lines 55-76. Add `getCachedProfiles(pubkeys, maxAge)` returning a Map and use it in useAuthor's prefetchFromNotes.

### RSS proxy endpoint is hardcoded to corkboards.me on mobile
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/core/src/feedConstants.ts RSS_PROXY = '/rss-proxy.php' (relative, re-exported by packages/web/src/lib/feedUtils.ts:16)`
- impact: Every RSS fetch from the mobile app is routed through corkboards.me, disclosing which feeds a user reads to that server — directly counter to the "no third-party leakage / minimal external requests" value. A self-hoster's mobile build cannot use their own proxy.
- detail: packages/mobile/src/lib/feedUtils.ts declares its own `const RSS_PROXY = 'https://corkboards.me/rss-proxy.php'` instead of importing the core constant. Web's relative path deliberately follows whatever host the bundle is served from (self-hosted, stage, prod).
- plan: Add a configurable base to core (e.g. `getRssProxyBase()` with a setter) or a `corkboard:rss-proxy-base` MMKV setting surfaced in AdvancedSettings, defaulting to the current URL. Import RSS_PROXY from @core/feedConstants in packages/mobile/src/lib/feedUtils.ts and prefix it with the configured base.

### Runtime debug-log enablement
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/lib/debug.ts (DEBUG = import.meta.env.DEV || VITE_DEBUG === 'true' || isTauri)`
- impact: When a user reports a mobile bug there is no diagnostic path — web/desktop can be asked to enable debug and paste logs (the CLAUDE.md corkboards-console-log.txt workflow).
- detail: packages/mobile/src/lib/debug.ts sets `const DEBUG = __DEV__` only. There is no way to turn logging on in a release build, and mobile code frequently bypasses the helper entirely with inline `if (__DEV__) console.log(...)` (dozens of sites in useNostrBackup.ts, useFollowNotesCache.ts, AutoSaveManager.tsx).
- plan: Make mobile DEBUG read `__DEV__ || mobileStorage.getSync('corkboard:debug') === 'true'` with a toggle in AdvancedSettings, and replace the inline `if (__DEV__) console.*` sites with debugLog/debugWarn/debugError so the toggle actually reaches them.

### Safe kind-3 contact-list mutation hook (useContactActions)
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/hooks/useContactActions.ts:21-55`
- impact: Two copies of the most data-loss-sensitive code path in the app (follow-list rewrite). A fix applied to one screen silently misses the other; e.g. the destructive-toast on `base === null` must be verified twice.
- detail: The pure core (resolveContactBase/applyContactChange from @core/contactList) IS shared, and mobile re-exports it via packages/mobile/src/lib/contactList.ts. But the hook wrapper is not: the identical follow/unfollow flow is copy-pasted twice on mobile — packages/mobile/src/components/ProfileModal.tsx:193-234 and packages/mobile/src/screens/ProfileScreen.tsx:165-204 — each re-implementing the base===null bail, the publish, and the optimistic `queryClient.setQueryData(['contacts', pubkey], …)`.
- plan: Create packages/mobile/src/hooks/useContactActions.ts mirroring the web signature, using useAuth() for pubkey and useNostrPublish() for the mutation, and replace both inlined blocks with `const safeUpdateContacts = useContactActions(user, contacts)`.

### Save-for-later collapse placeholder + minimize/expand on the Saved board
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/components/NoteCard.tsx:854-872 (collapsed placeholder), 900-923 (green corner / minimize toggle); packages/web/src/components/SavedForLaterCorkboard.tsx:248-251 (isMinimized/onMinimize/onExpand/onDismiss)`
- impact: On web, saving a note leaves a labelled blank card in place so the board layout is preserved and you can pop it back open; on mobile the note just stays. On the Saved screen, long notes can't be minimised, so a board of 40 saved articles is an endless scroll.
- detail: Mobile saves via the bookmark star in packages/mobile/src/components/NoteActions.tsx:265-272 (kind-10003 bookmark) but never sets the `collapsed` state, so no blank placeholder is left behind in the feed. packages/mobile/src/screens/SavedScreen.tsx:136-169 renders full cards with Pin/Zap/Remove buttons — there is no minimize/expand and no per-note dismiss, and no `saved-minimized-notes` equivalent.
- plan: Wire the green corner (see previous item) to `toggleCollapsed(note.id)` and render the 'saved for later' placeholder. In SavedScreen, add a per-card minimize toggle persisted to the same `saved-minimized-notes` key web uses, plus a red dismiss button.

### Single-instance enforcement / cross-instance state sync
- mobile: **n/a** · desktop: **missing** · effort: small
- web impl: `/home/q4/corkboards/packages/web/src/lib/idb.ts:23-44,342; /home/q4/corkboards/packages/web/src/components/NostrProvider.tsx:380-390,858-890; /home/q4/corkboards/packages/web/src/hooks/useLocalStorage.ts:88`
- impact: Two open desktop windows silently clobber each other's corkboard settings, follows and dismissed-note state — the last writer wins with no invalidation event. Exactly the 'lost my follows' failure mode the project guards against elsewhere.
- detail: packages/desktop/src-tauri/Cargo.toml has no tauri-plugin-single-instance and lib.rs installs no guard, so launching Corkboards twice starts two processes. Tauri forces both to the same webview data directory (tauri-2.10.3 src/manager/webview.rs:505-517 resolves LocalData/<identifier> on Linux and Windows), so both instances share one localStorage/IndexedDB. The app's cross-context invalidation is built on BroadcastChannel (idb.ts:30, NostrProvider.tsx:387, useLocalStorage.ts:88), which is same-origin-and-same-agent-cluster only and does not span two separate WebKit processes.
- plan: Add `tauri-plugin-single-instance` to packages/desktop/src-tauri/Cargo.toml and `.plugin(tauri_plugin_single_instance::init(|app,_,_| { let _ = app.get_webview_window("main").map(|w| { w.unminimize(); w.set_focus() }); }))` in lib.rs before `.setup(...)`. Requires `core:window:allow-set-focus`/`allow-unminimize` only if driven from JS; done in Rust no ACL change is needed.

### Standalone RSS feed tab
- mobile: **missing** · desktop: **partial** · effort: small
- web impl: `packages/web/src/components/TabBar.tsx:493-501 / 682-707 (rssFeeds tabs); packages/web/src/hooks/useRssFeed.ts; MultiColumnClient.tsx:4373 (onRemoveRss)`
- impact: RSS-only corkboards and RSS tabs silently return zero items on the desktop app, and RSS tabs don't exist at all on mobile. A user whose main board is a blog roll sees an empty feed on desktop with no error.
- detail: Mobile: packages/mobile/src/hooks/useRssFeed.ts is implemented but imported nowhere; no `rssFeeds` state exists in packages/mobile/src (only packages/mobile/src/lib/downloadBackup.ts:45/59 counts the key for backup stats). Desktop: the RSS fetch goes through a relative proxy path — packages/core/src/feedConstants.ts:19 `export const RSS_PROXY = '/rss-proxy.php'` used by packages/web/src/lib/feedUtils.ts:29-30. Inside Tauri the document origin is tauri://localhost (packages/desktop/src-tauri/src/lib.rs:26 loads WebviewUrl::App("index.html")), so that fetch resolves to the bundled asset protocol and 404s — there is no PHP server. Mobile's copy hardcodes the absolute URL (packages/mobile/src/lib/feedUtils.ts:20).
- plan: Desktop: make RSS_PROXY absolute when running in Tauri — e.g. `export const RSS_PROXY = (typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)) ? 'https://corkboards.me/rss-proxy.php' : '/rss-proxy.php'` in packages/core/src/feedConstants.ts, and have packages/mobile/src/lib/feedUtils.ts import that constant instead of redefining it. Mobile: add `nostr-rss-feeds` pills wired to useRssFeed, same shape as the relay tabs.

### Startup migration of legacy plaintext nsec out of localStorage / IndexedDB
- mobile: **present** · desktop: **missing** · effort: small
- web impl: `/home/q4/corkboards/packages/web/src/main.tsx:149-158; /home/q4/corkboards/packages/web/src/lib/webKeyStore.ts:198-280 (prepareLoginStorage, steps 1 MIGRATE / 2 SCRUB / 3 RESTORE); /home/q4/corkboards/packages/web/src/lib/idb.ts:264-294 (migrateFromLocalStorage)`
- impact: Violates the project's first rule ('never store private keys in plaintext'). A desktop user who upgraded across versions can have their nsec sitting in cleartext in two places on disk, readable by any process running as them, with no UI indication. Those stale logins are also unusable because the Tauri signer only reads the keychain.
- detail: main.tsx:149 branches `if (isTauri) renderApp();` — prepareLoginStorage is skipped entirely on desktop. Two consequences. (a) MIGRATION: any desktop install that predates the keychain path (or whose keychain write failed, see useLoginActions.ts:79-84) still has a plaintext `data.nsec` inside localStorage['corkboard:login'] and it is never blanked or encrypted. (b) SCRUB: idb.ts:264-294 `migrateFromLocalStorage` copies EVERY localStorage key — including `corkboard:login` and `corkboard:amber-client-nsec` — verbatim into the `corkboard` IndexedDB kv store on first run. webKeyStore.ts:255-258 exists solely to `idbRemove(storageKey)` that plaintext snapshot, and that scrub never runs on desktop. So a plaintext nsec can sit in the desktop app's IndexedDB (~/.local/share/me.corkboards.desktop) forever.
- plan: Run the scrub on desktop too. In /home/q4/corkboards/packages/web/src/main.tsx:149 replace the isTauri short-circuit with a Tauri-specific `prepareTauriLoginStorage()` that: reads localStorage['corkboard:login']; for each `type:'nsec'` entry with a non-empty `data.nsec`, calls `keychainStore('nsec:'+pubkey, nsec)` and only blanks on success; always calls `idbRemove('corkboard:login')` and `idbRemove('corkboard:amber-client-nsec')`; then renders. Keep the same 3s Promise.race timeout so a hung keychain can't block boot.

### Storage-write change notification (idbSetSync always dispatches; mobileStorage.setSync never does)
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/lib/idb.ts:218-236 (dispatchSyncEvent on every write) + :341-356 (cross-tab BroadcastChannel)`
- impact: After restoring a cloud backup on mobile the UI still shows the old corkboards/filters until the user force-quits and relaunches.
- detail: On web the notification lives in the STORAGE LAYER, so any writer — backup restore, storageKeys stash/restore, cacheStore, a settings screen — automatically wakes every useLocalStorage subscriber. On mobile the notification lives in the HOOK (packages/mobile/src/hooks/useLocalStorage.ts:59 emits `mobile-storage-sync` only from setValue), so the many direct `mobileStorage.setSync` callers are invisible. The clearest symptom is in the restore path: packages/mobile/src/hooks/useNostrBackup.ts deserializeBackup (line 275-285) writes every key with `mobileStorage.setSync`, and the hook then has to tell the user "Backup restored! Restart the app to apply all settings." — web live-updates.
- plan: Move the emit into packages/mobile/src/storage/MmkvStorage.ts: have `setSync`/`removeSync`/`set`/`remove` call `DeviceEventEmitter.emit('mobile-storage-sync', { key, originId: null })` after a successful write. Keep the originId echo-suppression in useLocalStorage. Then drop the "Restart the app" message.

### Textarea/composer cursor-insert helper
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/lib/textareaUtils.ts (insertAtCursor, isValidMediaUrl)`
- impact: Inserting a custom emoji mid-sentence in the mobile composer appends it to the end instead of at the cursor.
- detail: `isValidMediaUrl` is copy-pasted twice on mobile — packages/mobile/src/components/EmojiPicker.tsx:53 and packages/mobile/src/components/compose/CustomEmojiPicker.tsx:22 — and a local `insertAtCursor` is defined inside packages/mobile/src/components/thread/InlineReplyComposer.tsx:63. ComposeScreen has no cursor-aware insert at all, so emoji append at the end of the text rather than at the caret.
- plan: Add packages/mobile/src/lib/textareaUtils.ts exporting `isValidMediaUrl` (identical) plus an RN `insertAtCursor(selection, text, setContent)` driven by TextInput's `onSelectionChange` `{start,end}`. De-duplicate the three call sites. Better: move `isValidMediaUrl` into @core/sanitizeUtils since it is pure.

### Thread panel: Repost action, real Quote action, Pin-to-board
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/components/thread/ThreadPanel.tsx:12-16 (onQuote/onRepost/onZap/onPinToBoard); wired at packages/web/src/pages/MultiColumnClient.tsx:4549-4567`
- impact: In a mobile thread, Repost is invisible and Quote silently posts a reply instead — the note the user meant to quote is never embedded and no `q` tag is published, so other clients show it as an ordinary reply.
- detail: packages/mobile/src/components/thread/ThreadReplyRow.tsx:26-28 accepts onQuote/onRepost/onZap, but packages/mobile/src/screens/ThreadScreen.tsx:231-241 passes only onQuote and onZap — onRepost is never supplied so the Repost button (ThreadReplyRow.tsx:121-125) never renders. Worse, ThreadScreen.tsx:149-152 `handleQuote` just calls `setReplyTarget(event)` with the comment "For now, start a reply with a quote tag" — packages/mobile/src/components/thread/InlineReplyComposer.tsx:29-32 accepts only `replyTo`, so tapping "Quote" in a thread publishes a plain NIP-10 reply, not a NIP-18 quote. onPinToBoard has no mobile equivalent.
- plan: In ThreadScreen, make handleQuote open the ComposeScreen modal with `quotedEvent` set (ComposeScreen already handles quotes at ComposeScreen.tsx:165-187), and add an onRepost handler reusing the kind-6/16 publish from packages/mobile/src/components/NoteActions.tsx:115-149. Add onPinToBoard once mobile pinning lands.

### Tor hidden-service (.onion) relays
- mobile: **n/a** · desktop: **partial** · effort: small
- web impl: `/home/q4/corkboards/packages/core/src/nostrUtils.ts:61-73 (`isSecureRelay` requires wss://); relay selection at /home/q4/corkboards/packages/web/src/components/NostrProvider.tsx:785-822`
- impact: The one relay configuration the app's own privacy documentation recommends to Tor users cannot actually be used. Users who add a `ws://xyz.onion` relay see it accepted in settings but it silently never returns notes.
- detail: packages/desktop/src-tauri/src/relay.rs:244-258 deliberately allows `ws://…​.onion` ('the .onion address itself authenticates and encrypts the endpoint'), and the Advanced Settings copy tells Tor users to prefer an .onion relay ('use a Tor .onion relay where the address itself authenticates the endpoint' — AdvancedSettings.tsx:637-639). But every JS path filters relays through `isSecureRelay`, which hard-rejects anything that is not `wss://` (nostrUtils.ts:62), and getTauriRelaysForFilter applies it at NostrProvider.tsx:795 and :809. A `ws://…onion` relay is therefore stripped before it ever reaches Rust, so the Rust exception is unreachable from the feed path.
- plan: Extend `isSecureRelay` in /home/q4/corkboards/packages/core/src/nostrUtils.ts:61 to mirror relay.rs:252-258: allow `ws://` when the host (after lowercasing and trimming a trailing dot) ends in `.onion`, keeping the wss-only rule for every other host. That single change fixes web, mobile and desktop at once and makes the Rust and JS gates agree — the stated design goal in the relay.rs comment block. Add a test in packages/web/src/lib/router.test.ts or a new core test covering `ws://abc.onion` accept / `ws://evil.com` reject.

### Two copies of zod in the web bundle (v3 app-side, v4 inside @nostrify)
- mobile: **n/a** · desktop: **partial** · effort: small
- web impl: `/home/q4/corkboards/packages/web/package.json ("zod": "^3.25.71") + @nostrify/nostrify's own nested zod`
- impact: Dead weight in a 2.1MB bundle for a single schema in AppProvider, and a latent footgun: a v3 schema object handed to any nostrify API that expects a v4 schema fails an `instanceof` check at runtime rather than at compile time.
- detail: Installed: root zod 3.25.76; `node_modules/@nostrify/nostrify/node_modules/zod` 4.3.6 (nostrify declares `zod: ^4.3.6`). Web imports v3 directly at `packages/web/src/components/AppProvider.tsx:2` (`import { z } from 'zod'`) and imports nostrify's v4-backed schemas as `NSchema as n` in at least five files (useLoggedInAccounts.ts:5, useBulkAuthors.ts:13, useOnboardDiscover.ts:2, useAuthor.ts:1, EditProfileForm.tsx:21). Verified both land in the shipped bundle: `invalid_union_discriminator` (a v3-only string) appears in `packages/web/dist/assets/index.js`, and `$ZodError` (a v4-only symbol) appears in `packages/web/dist/assets/vendor-nostr.js`. Mobile is clean here — it has only zod 4.3.6, since it declares no direct zod dependency.
- plan: Migrate `packages/web/src/components/AppProvider.tsx` to zod v4 and bump `packages/web/package.json` to `"zod": "^4.3.6"`, so npm dedupes to nostrify's copy and only one zod ships. The AppProvider schema is small; the v3→v4 changes that matter are `z.string().url()` → `z.url()` and the error-map shape. Verify afterwards by re-grepping the built assets for `invalid_union_discriminator` — it should be gone.

### Version numbers are two releases behind the commit history and the changelog is unordered
- mobile: **partial** · desktop: **partial** · effort: small
- web impl: `all package.json files at 0.8.0 + /home/q4/corkboards/CHANGELOG.md`
- impact: A user reporting a bug against "0.8.0" could be on any of three different builds, and the in-app/AppImage/APK version cannot distinguish them. The v0.8.2 SSRF hardening is invisible in the changelog, so nobody knows whether their deployment has it.
- detail: git log shows `7d95f45 v0.8.2 audit: SSRF/URL hardening…` and `6658fd9 v0.8.1 docs: …`, but every version string is still **0.8.0**: root package.json, packages/core, packages/web, packages/desktop package.json, packages/desktop/src-tauri/Cargo.toml, packages/desktop/src-tauri/tauri.conf.json. Mobile is 0.8.0 in package.json and `0.8.0b` in app.json. `CHANGELOG.md` has no 0.8.1 or 0.8.2 entry at all, and its `## [Unreleased]` section sits BELOW `## [0.8.0]` (Keep a Changelog puts it on top) while listing items that already shipped before 0.8.0 — CONTRIBUTING.md, relayConstants.ts, the calendar-code removal. Separately, `packages/mobile/android/app/build.gradle:95-96` carries `versionCode 1` / `versionName "0.0.0"`; that directory is gitignored (`/android` in packages/mobile/.gitignore, 0 files tracked) so EAS regenerates it, but a local `expo run:android` produces an APK labelled 0.0.0.
- plan: Bump all six version strings to 0.8.2 now (mobile app.json to `0.8.2b`), add `## [0.8.2]` and `## [0.8.1]` sections to CHANGELOG.md from the commit bodies, and move `## [Unreleased]` above `## [0.8.0]` after folding its already-shipped entries into 0.8.0. Then add a `scripts/version.mjs` invoked as root `npm version` that rewrites all six files at once, and a vitest that asserts they agree — the six-file manual bump is exactly the kind of step that gets half-done.

### Vite manualChunks does not produce the chunks it names
- mobile: **n/a** · desktop: **n/a** · effort: small
- web impl: `/home/q4/corkboards/packages/web/vite.config.ts build.rollupOptions.output.manualChunks`
- impact: The chunk names are misleading for anyone debugging bundle size, and the intended caching split does not exist. Muted by the fact that filenames are deliberately unhashed with a 300s `.htaccess` TTL, so the split buys little — but the 1.3MB single chunk is a real first-paint cost on mobile web.
- detail: Inspected the actual output of `npm run test:web`. `vendor-react.js` is only 21,572 bytes — far too small for react + react-dom + react-router-dom. Probing for react-dom's internal marker `__reactContainer` finds it in **vendor-radix.js** (272,662 bytes), not vendor-react.js. Meanwhile `index.js` is 1,317,476 bytes — 63% of the 2.1MB assets directory — entirely unsplit. The `manualChunks` function returns `undefined` for everything outside its four regexes, and under Rolldown (Vite 8's default, per the config's own comment about the object form being dropped) modules shared across preferred chunks get merged into whichever chunk claims them first. `scheduler` is not matched by the react regex at all.
- plan: Either drop `manualChunks` entirely and let Rolldown chunk automatically (honest output, likely similar sizes), or fix it: add `scheduler` to the react regex, and verify each intended chunk after building by grepping for a marker unique to its expected contents. Given the unhashed-filename strategy, the higher-value change is route-level `React.lazy()` splitting of the heavy pages rather than vendor splitting.

### Window size/position persistence across restarts
- mobile: **n/a** · desktop: **missing** · effort: small
- web impl: `n/a (native shell concern); geometry for in-app dialogs is persisted via STORAGE_KEYS.THREAD_DIALOG_GEOMETRY / COMPOSE_DIALOG_GEOMETRY in /home/q4/corkboards/packages/core/src/storageKeys.ts:117-120`
- impact: The desktop window resets to 1280x800 at the default position on every launch, undoing any resize/maximize/monitor placement — noticeable in a multi-column reader where users size the window to fit N columns.
- detail: packages/desktop/src-tauri/src/lib.rs:26-31 hardcodes `.inner_size(1280.0, 800.0)` on every launch and there is no tauri-plugin-window-state in Cargo.toml. The app already persists per-platform layout preferences (column count, dialog geometry) under the 'desktop' platform key, so the window itself is the only unremembered piece.
- plan: Add `tauri-plugin-window-state` to packages/desktop/src-tauri/Cargo.toml and `.plugin(tauri_plugin_window_state::Builder::default().build())` in lib.rs. Because the window is built manually in `setup`, call `window.restore_state(StateFlags::all())` after `builder.build()?` (lib.rs:68).

### XSS blast radius of the Tauri IPC surface
- mobile: **n/a** · desktop: **partial** · effort: small
- web impl: `/home/q4/corkboards/packages/desktop/src-tauri/tauri.conf.json:13 (`withGlobalTauri: true`); /home/q4/corkboards/packages/web/src/lib/tauri.ts:11-20; /home/q4/corkboards/packages/desktop/src-tauri/src/signer.rs:27-105`
- impact: On desktop, an XSS (or a malicious note that defeats the sanitizer) escalates from 'read the page' to 'publish as you' and 'decrypt your backups' — strictly worse than the web build, where the same XSS at least has to find the key material.
- detail: tauri.ts:19 already uses a dynamic `import('@tauri-apps/api/core')`, so the app does not need the injected global at all — yet `withGlobalTauri: true` exposes `window.__TAURI__.core.invoke` to any script executing in the page. The keychain read command was removed precisely because 'it could exfiltrate the nsec via XSS' (tauri.ts:73-75), but `sign_event`, `nip44_encrypt/decrypt` and `nip04_encrypt/decrypt` are still reachable from that global. An attacker with script execution cannot steal the key, but can sign arbitrary events as the user (including a replacement kind-3 follow list or a kind-5 deletion) and can decrypt every NIP-44 payload the user owns, including the cloud backup blobs.
- plan: Set `"withGlobalTauri": false` in /home/q4/corkboards/packages/desktop/src-tauri/tauri.conf.json:13 (nothing in packages/web/src depends on the global except the two `__TAURI__`-only checks below), and change the `isTauri` probe in packages/web/src/lib/tauri.ts:11-13 to rely on `__TAURI_INTERNALS__`. Consider requiring an explicit user confirmation in Rust for `sign_event` on high-risk kinds (3, 5, 10002) — the same 'never republish kind-3 without re-verifying' guard the project already wants elsewhere.

### batchFetchByAuthors relay pacing (500 ms between author chunks)
- mobile: **partial** · desktop: **present** · effort: small
- web impl: `packages/web/src/lib/feedUtils.ts (sequential chunk loop with `await new Promise(r => setTimeout(r, 500))` between chunks)`
- impact: Relay rate-limit rejections and dropped batches for users with large follow lists on mobile — the exact failure web's pacing was added to prevent. Two implementations means any future pacing fix lands on only one.
- detail: packages/mobile/src/lib/feedUtils.ts:133-149 fires every chunk simultaneously via `Promise.all(chunks.map(...))`. With >500 follows this opens all chunk queries at once on a cellular connection. Worse, mobile has a SECOND, differently-behaved copy of the same function inlined in packages/mobile/src/hooks/useCustomFeed.ts (also Promise.all, MAX_AUTHORS_PER_QUERY 500), and packages/mobile/src/hooks/useCustomFeedNotesCache.ts imports batchFetchByAuthors from useCustomFeed rather than from lib/feedUtils.
- plan: Port the sequential loop + 500 ms gap into packages/mobile/src/lib/feedUtils.ts:133-149, delete the inline copy in useCustomFeed.ts, and repoint useCustomFeedNotesCache.ts to import from ../lib/feedUtils. Long term, lift batchFetchByAuthors into packages/core (it only needs a `{query}` pool interface).

### eslint-plugin-react-hooks major skew — web is on v5, mobile on v7
- mobile: **present** · desktop: **missing** · effort: small
- web impl: `/home/q4/corkboards/packages/web/package.json ("eslint-plugin-react-hooks": "^5.1.0-rc.0" → installed 5.2.0) vs /home/q4/corkboards/packages/mobile/package.json ("^7.1.1" → installed 7.1.1)`
- impact: `setState` during render, non-static component definitions and hook-purity violations are caught in the mobile tree and invisible in the 251-file web tree — which is also the desktop tree. These are the exact bugs that manifest as infinite re-render loops and dropped feed state, the sort of thing the changelog's "thread scroll-race" entries describe.
- detail: `eslint --print-config` confirms web resolves only two hook rules: `react-hooks/rules-of-hooks: [2]`, `react-hooks/exhaustive-deps: [1]`. Mobile resolves 19, including six that are ERRORS on mobile and do not exist at all on web: `react-hooks/set-state-in-render: [2]`, `react-hooks/static-components: [2]`, `react-hooks/use-memo: [2]`, `react-hooks/globals: [2]`, `react-hooks/config: [2]`, `react-hooks/gating: [2]` — plus warn-level `purity`, `refs`, `immutability`, `preserve-manual-memoization`, `set-state-in-effect`, `error-boundaries`, `incompatible-library`, `unsupported-syntax`.
- plan: Bump `packages/web/package.json` to `"eslint-plugin-react-hooks": "^7.1.1"`, matching mobile. Expect a first-run flood: copy mobile's approach verbatim — keep `rules-of-hooks` and the v7 hard errors at `error`, downgrade `set-state-in-effect`, `refs`, `purity`, `error-boundaries`, `preserve-manual-memoization`, `immutability` to `warn` with the same "fix when touching the file, do not bulk-silence" comment mobile already carries. That gets the two configs to literal parity.

### naddr (addressable event) deep link / view
- mobile: **missing** · desktop: **present** · effort: small
- web impl: `packages/web/src/pages/NIP19Page.tsx:68-70 (AddressableSection), route at packages/web/src/AppRouter.tsx:22`
- impact: Opening a link to a long-form article or a NIP-99 listing (both naddr-addressed) on mobile does nothing at all — the app opens on the feed with no feedback.
- detail: packages/mobile/src/components/DeepLinkHandler.tsx:60 explicitly comments "naddr (addressable) has no dedicated mobile view yet — ignore" and the switch at DeepLinkHandler.tsx:47-61 handles only npub/nprofile/note/nevent.
- plan: Resolve the naddr to its event (kind+pubkey+d filter) and open it in ThreadScreen, mirroring NIP19Page.tsx's AddressableSection. At minimum, show a toast rather than silently swallowing the link.

### packages/desktop has no typecheck, lint, or test script and is absent from every root aggregate
- mobile: **present** · desktop: **missing** · effort: small
- web impl: `root /home/q4/corkboards/package.json — `typecheck` and `lint` each run core, mobile, web; desktop appears in neither`
- impact: Desktop-specific configuration — the Tauri capability allowlist, the CSP, the bundle targets — can regress with no signal from any command a contributor runs.
- detail: `packages/desktop/package.json` contains exactly two scripts: `dev` and `build`. Root `typecheck` = `-w @corkboards/core && -w @corkboards/mobile && tsc -p packages/web/tsconfig.json`. Root `lint` = core && mobile && web. `test` = core && web && mobile. So the fourth workspace package participates in no aggregate check; only the manually-invoked `test:desktop` touches it. Its `capabilities/default.json` (event/window/webview/app/path permissions) and `tauri.conf.json` are likewise unvalidated by anything in the repo.
- plan: Add to `packages/desktop/package.json`: `"lint": "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings"`, `"test": "npm run lint && cargo test --manifest-path src-tauri/Cargo.toml"`, and `"typecheck": "cargo check --manifest-path src-tauri/Cargo.toml"`. Add root `lint:desktop`/`typecheck:desktop` aliases. Keep them out of the default `test` (the existing `//test:desktop` rationale about the no-Rust contributor flow is sound) but wire them as their own CI job.

### @nostrify/nostrify version skew — NIP-42 auth-required retry exists only on mobile
- mobile: **present** · desktop: **missing** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/package.json ("@nostrify/nostrify": "0.50.5", exact pin) vs /home/q4/corkboards/packages/mobile/package.json ("^0.51.0")`
- impact: On any auth-gated relay (paid relays, private relays, NIP-42 inbox relays), mobile fetches and publishes successfully while web and desktop silently return nothing / silently fail to publish. Same account, same relay list, different results per platform — and the failure is silent, so the user reads it as "my notes vanished".
- detail: Installed tree confirms the skew: root `node_modules/@nostrify/nostrify` = 0.50.5 (used by web AND desktop, since desktop runs the web bundle), `packages/mobile/node_modules/@nostrify/nostrify` = 0.51.0. `diff -rq` over the two dist trees shows exactly one behavioural file differs: `NRelay1.js`. 0.51.0 adds `authPromise`, `authRetriedSubs`, `authRetriedEvents`, `pendingEvents`, `doAuth()`, `retrySubAfterAuth()`, `retryEventAfterAuth()` — on a `CLOSED ... auth-required:` it re-sends the REQ after AUTH completes, and on an `OK false auth-required:` it re-sends the EVENT. 0.50.5 fires the AUTH and never retries, so the original REQ/EVENT is simply lost. Both platforms actually hit this path: web wires `auth` at packages/web/src/components/NostrProvider.tsx:305-307 (`RateLimitedRelay` constructor) and mobile at packages/mobile/src/lib/NostrProvider.tsx:312-314 (`withAuth`).
- plan: Bump `packages/web/package.json` to `"@nostrify/nostrify": "0.51.0"` (keep the exact pin — pinning is the right call, it just needs to be the same pin) and pin mobile to `"0.51.0"` too, dropping the caret so the two cannot drift again. Re-run `npm install`, then `npm run test`. Note 0.51.0's `pendingEvents` Map is only cleared on OK, so it grows on relays that never OK — cap it or clear on socket close if you see memory growth.

### @tauri-apps/cli is not a declared dependency — desktop builds fetch a floating version at run time
- mobile: **n/a** · desktop: **missing** · effort: trivial
- web impl: `/home/q4/corkboards/packages/desktop/package.json — both scripts call `npx @tauri-apps/cli``
- impact: Desktop builds are not reproducible and fail entirely offline. A breaking @tauri-apps/cli 2.x release changes the AppImage/msi/dmg output with no repo change — the AppImage naming convention you rely on is at the mercy of an unpinned tool.
- detail: `ls node_modules/@tauri-apps/` shows only `api` — the CLI is installed nowhere in the workspace, and no package.json declares it. `packages/desktop/package.json` `dev` and `build` both invoke `npx @tauri-apps/cli`, which resolves the latest published 2.x from the network on every invocation. `packages/web/package.json` does declare `"@tauri-apps/api": "^2.10.1"` as a runtime dep, so the JS side is pinned while the CLI that produces the binary is not. There is also no `rust-toolchain.toml` and no `[profile.release]` section in `packages/desktop/src-tauri/Cargo.toml`, so release builds use whatever cargo defaults are active (no lto, no strip, no panic=abort).
- plan: Add `"devDependencies": { "@tauri-apps/cli": "^2.10.1" }` to `packages/desktop/package.json` (match the api version's major/minor) and change both scripts from `npx @tauri-apps/cli` to `tauri` (npm puts the workspace bin on PATH). Add `packages/desktop/src-tauri/rust-toolchain.toml` with `[toolchain] channel = "1.94"`. Add `[profile.release] lto = true, codegen-units = 1, strip = true, panic = "abort"` to Cargo.toml for a smaller binary. Also fix the broken `dev` script while you are there — see the next finding.

### @welshman dependency declarations do not match actual imports on either platform
- mobile: **partial** · desktop: **partial** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/package.json declares @welshman/lib, @welshman/net, @welshman/router, @welshman/util`
- impact: Two unused packages are installed and audited on web. On mobile, removing @welshman/util from web's package.json — a reasonable cleanup, since web only uses it for types — would break mobile's type-check with no obvious connection to the change.
- detail: Exhaustive grep of every `@welshman/` import site. Web has exactly three, all in one file: `packages/web/src/components/NostrProvider.tsx:7` (`Router, getFilterSelections, addMinimalFallbacks` from @welshman/router) and `:8` (type-only `TrustedEvent, Filter` from @welshman/util). So **@welshman/lib and @welshman/net are declared with zero imports**. Mobile has the mirror-image problem: `packages/mobile/src/lib/NostrProvider.tsx:9-10` imports from BOTH @welshman/router and @welshman/util, but `packages/mobile/package.json` declares only `"@welshman/router": "^0.8.15"` — @welshman/util is a phantom dependency resolved purely through hoisting from web's declaration.
- plan: Remove `"@welshman/lib"` and `"@welshman/net"` from packages/web/package.json. Add `"@welshman/util": "^0.8.15"` to packages/mobile/package.json. Both files import the identical symbol set from the identical two packages, so after this the two declarations match the two import sites exactly.

### Account-switch marker (`corkboard:account-switch`) via switchActiveUser onSwitch hook
- mobile: **missing** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/lib/storageKeys.ts:102-108 (passes onSwitch, writes sessionStorage flag)`
- impact: Any mobile code that needs to distinguish an account switch from a fresh session (onboarding suppression, backup-check skipping, splash behaviour) cannot, so it treats every switch as a cold start.
- detail: core's switchActiveUser accepts an `onSwitch` callback (packages/core/src/storageKeys.ts:319, 348) so the platform can record "this was an account switch, not a new session". Web supplies it. packages/mobile/src/lib/storageKeys.ts:72-74 calls `_switchActiveUser(storage, oldPubkey, newPubkey)` with the third argument omitted, so mobile never records the flag.
- plan: In packages/mobile/src/lib/storageKeys.ts:72-74 pass a fourth-arg callback that does `mobileStorage.setSync('corkboard:account-switch', '1')`, and clear it once consumed at launch. Since MMKV has no session scope, stamp it with `Date.now()` and treat entries older than ~30s as stale.

### Bulk author prefetch (debounce, fingerprint gate, eager all-follows pass)
- mobile: **missing** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/hooks/useBulkAuthorPrefetch.ts:36-75`
- impact: On mobile a fast-scrolling / autofetching feed re-issues the same batch kind-0 query repeatedly whenever the array identity changes, wasting cellular data and relay budget.
- detail: No mobile file. packages/mobile/src/screens/HomeScreen.tsx:371-376 calls `prefetchFromNotes(filteredEvents)` from a bare useEffect on every `filteredEvents` identity change — no 50 ms debounce, no `feedLimit` slice, no note-id fingerprint, and no background all-follows pass.
- plan: Port useBulkAuthorPrefetch.ts to packages/mobile/src/hooks/ unchanged (it has no DOM dependency), take `limit` from useFeedLimit, and replace the HomeScreen effect at lines 371-376 with the hook.

### Copy note ID (nip19 note1…) from a note
- mobile: **missing** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/components/NoteCard.tsx:91-122 (CopyEventIdButton)`
- impact: Mobile users can't grab a shareable note1… reference for a post, so they can't share a note out of the app or paste it into another client.
- detail: No clipboard write for an event id exists in packages/mobile/src — expo-clipboard is imported only in packages/mobile/src/screens/ProfileScreen.tsx:16 (copy npub) and packages/mobile/src/components/AddAccountModal.tsx (copy nsec/mnemonic).
- plan: Add a small copy button (or a long-press menu item) on the mobile NoteCard header calling `Clipboard.setStringAsync(nip19.noteEncode(event.id))` with the same 1.5s ✓ feedback as NoteCard.tsx:100-107.

### Custom emoji in display names
- mobile: **missing** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/components/EmojiName.tsx; used at packages/web/src/components/NoteCard.tsx:985 and elsewhere`
- impact: Users whose display name contains a NIP-30 custom emoji render as e.g. "alice :zap:" on mobile instead of the image.
- detail: packages/mobile/src/components/EmojiName.tsx (82 lines, a working port) is imported by nothing. packages/mobile/src/components/NoteCard.tsx:193 renders `<Text style={styles.displayName}>{displayName}</Text>` and packages/mobile/src/components/NoteContent.tsx:70-74 ProfileMention renders `@{name}` — both plain strings, so a `:shortcode:` in someone's kind-0 name shows as literal text.
- plan: Replace the plain display-name Text nodes in mobile NoteCard, NotificationCard, ProfileCard/ProfileScreen and ProfileMention with the existing EmojiName component (it takes `name` + the kind-0 `event`).

### Default corkboards emoji set auto-inclusion
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/hooks/useCustomEmojiSets.ts:50-54 (pushes DEFAULT_EMOJI_SET_ADDR when the user has zero kind-30030 sets)`
- impact: A mobile user with no emoji sets sees only the bundled emoji constant, never the live corkboards default set (and any updates to it), and "Manage Sets" shows an empty list where web pre-seeds one.
- detail: Mobile's hook is otherwise a line-for-line port but omits that block entirely; packages/mobile/src/hooks/useCustomEmojiSets.ts goes straight from `addrs` to the fetch. Mobile pickers fall back to the hardcoded CORKBOARDS_DEFAULT_EMOJIS list (packages/mobile/src/components/EmojiPicker.tsx:124) rather than resolving the published set.
- plan: Move DEFAULT_EMOJI_SET_ADDR into @core/defaultEmojiSet (it currently lives in packages/web/src/components/EmojiSetEditor.tsx), import it in both platforms, and add web's 5-line fallback block to packages/mobile/src/hooks/useCustomEmojiSets.ts.

### Desktop `dev` script starts Vite on the wrong port with the wrong config
- mobile: **n/a** · desktop: **missing** · effort: trivial
- web impl: `/home/q4/corkboards/packages/desktop/package.json `dev` vs /home/q4/corkboards/packages/desktop/src-tauri/tauri.conf.json `devUrl``
- impact: `npm run dev -w @corkboards/desktop` produces a Tauri window pointed at a dead localhost:3000 while a misconfigured Vite serves nothing useful on 8080. Every desktop dev session requires knowing the undocumented workaround.
- detail: `"dev": "cd ../.. && npx vite --port 8080 & npx @tauri-apps/cli dev --config src-tauri/tauri.conf.json"`. Two confirmed problems: it `cd`s to the repo ROOT before launching Vite, but the only `vite.config.ts` is at `packages/web/vite.config.ts` — at root there is no config, so no `@`/`@core` aliases, no React plugin, no proxy. And it binds port **8080** while `tauri.conf.json` sets `"devUrl": "http://localhost:3000"`. CLAUDE.md documents the actual working flow as "requires web dev server on port 3000", i.e. the script is known-broken and worked around manually.
- plan: Replace with `"dev": "npm run dev -w @corkboards/web & tauri dev --config src-tauri/tauri.conf.json"` (web's `dev` already pins `--port 3000 --strictPort`, matching `devUrl`). Better still, delete the `&` entirely and set `"beforeDevCommand": "npm run dev -w @corkboards/web"` in `tauri.conf.json` — it is currently an empty string — so Tauri owns the lifecycle and kills the dev server on exit.

### Desktop dev workflow
- mobile: **n/a** · desktop: **partial** · effort: trivial
- web impl: `/home/q4/corkboards/package.json:7 (`dev` → vite on 3000 in packages/web)`
- impact: `npm run dev -w @corkboards/desktop` opens a Tauri window pointed at a port nothing is listening on — a blank window. Anyone picking up desktop work has to reverse-engineer the correct incantation.
- detail: /home/q4/corkboards/packages/desktop/package.json:5 runs `cd ../.. && npx vite --port 8080 & npx @tauri-apps/cli dev --config src-tauri/tauri.conf.json`, but tauri.conf.json:8 sets `devUrl: http://localhost:3000`, and the repo root has no vite.config.* (verified — only packages/web/vite.config.ts exists), so the backgrounded vite either fails or serves the wrong root. The `--config src-tauri/tauri.conf.json` path is also relative to packages/desktop, which only works if npm sets that cwd.
- plan: Change the script to `"dev": "npm run dev -w @corkboards/web & npx @tauri-apps/cli dev --config src-tauri/tauri.conf.json"`, or better, set `beforeDevCommand` in tauri.conf.json:9 to `npm run dev -w @corkboards/web` and reduce the script to just the tauri CLI call so the port is defined in exactly one place.

### Drag-to-reorder corkboard / relay / RSS tabs
- mobile: **n/a** · desktop: **partial** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/src/components/TabBar.tsx:633-700 (HTML5 draggable + dataTransfer)`
- impact: On Windows desktop, tabs cannot be reordered — the drag starts but no drop event ever reaches React, so the corkboard/relay/RSS ordering UI is inert. Works on Linux/macOS.
- detail: Tauri's OS-level file drag-drop handler is enabled by default (`drag_drop_handler_enabled: true` — tauri-runtime-2.10.1 src/webview.rs:488; `drag_drop_enabled: true` — tauri-utils-2.8.3 src/config.rs:1992) and packages/desktop/src-tauri/src/lib.rs never calls `.disable_drag_drop_handler()`. On Windows wry installs an OLE IDropTarget on the HWND (wry-0.54.4 src/webview2/mod.rs:150-157) which intercepts drag operations before the DOM sees them, breaking HTML5 drag-and-drop — the long-documented Tauri/Windows caveat. TabBar.tsx relies entirely on `e.dataTransfer.setData/getData`.
- plan: Call `.disable_drag_drop_handler()` on the WebviewWindowBuilder in /home/q4/corkboards/packages/desktop/src-tauri/src/lib.rs:26-31 (the app never uses OS file-drop). If OS file-drop is wanted later for image upload, instead keep it enabled and replace TabBar's HTML5 DnD with pointer-event based reordering.

### Emoji set editor / custom NIP-30 reactions / "Manage Sets"
- mobile: **present** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/components/EmojiSetEditor.tsx; packages/web/src/components/compose/CombinedEmojiPicker.tsx:338-344 (Manage Sets); mounted at packages/web/src/pages/MultiColumnClient.tsx:4699-4708`
- impact: None — no action needed. Listed so the matrix is complete.
- detail: Verified at parity: packages/mobile/src/components/EmojiSetEditor.tsx (789 lines) is mounted from packages/mobile/src/screens/SettingsScreen.tsx:544-553; packages/mobile/src/components/EmojiPicker.tsx:307-310 and packages/mobile/src/components/compose/CombinedEmojiPicker.tsx:41-47 both surface "Manage Sets" via packages/mobile/src/components/EmojiSetsModalProvider.tsx (mounted in packages/mobile/App.tsx). Custom-emoji reactions publish with the NIP-30 emoji tag at packages/mobile/src/components/NoteActions.tsx:328.
- plan: No change. (Note packages/mobile/src/components/EmojiName.tsx is dead code — web uses EmojiName in NoteCard.tsx:985 for emoji-in-display-name; mobile's ProfileMention/NoteCard render plain names. If custom emoji in display names matters, wire EmojiName into mobile NoteCard's displayName render.)

### Fresh-note highlight for newly arrived notes
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:4417 (freshNoteIds → FeedGrid); packages/web/src/components/NoteCard.tsx:877 (isFresh purple border/background)`
- impact: After an autofetch or refresh on mobile there is no visual cue for which notes are new, so the user re-reads the whole board.
- detail: packages/mobile/src/components/NoteCard.tsx:104,157 supports `isFresh` and styles.freshCard, but no mobile screen ever computes or passes it (HomeScreen.tsx:465-476 omits it; the unused packages/mobile/src/components/FeedGrid.tsx:45 declares a freshNoteIds prop nobody supplies).
- plan: Track the previous id set in HomeScreen across refetches, diff it into a `freshNoteIds` Set, and pass `isFresh={freshNoteIds.has(item.id)}` in renderNote.

### Image-proxy persistence helper
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/lib/imageProxySettings.ts (IMAGE_PROXY_TEMPLATE_KEY, getImageProxyTemplate, saveImageProxyTemplate → setImageProxyTemplate)`
- impact: None today, but the key is duplicated in three places across two platforms with the validation applied on only one — a rename or a validation fix will land unevenly.
- detail: The feature works on mobile but the module doesn't exist: the key string `'corkboard:image-proxy-template'` is re-declared in packages/mobile/src/components/AdvancedSettings.tsx:25 and again as a bare literal in App.tsx:113, with the save/activate logic inlined at AdvancedSettings.tsx:38. Mobile additionally calls `validateImageProxyTemplate` from @core/imageProxy which the web helper does not.
- plan: Add packages/mobile/src/lib/imageProxySettings.ts mirroring web's API over mobileStorage, use it from AdvancedSettings.tsx and App.tsx, and pull `validateImageProxyTemplate` into web's saveImageProxyTemplate too.

### Link copy / tracker-strip hook (useLinkCopy)
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/hooks/useLinkCopy.ts:24-42`
- impact: No "copied ✓" feedback on mobile link copy, and the tracker-strip computation runs on every render of every note containing a link.
- detail: The core helpers (stripTrackingParams/getTrackingParams from @core/sanitizeUtils) are shared, but the hook is duplicated inline on mobile: packages/mobile/src/components/WebLink.tsx:33-34 and packages/mobile/src/components/NoteContent.tsx:105-106 each recompute cleanUrl/trackingParams per render (web memoises), and neither implements the 1.5 s `copied` feedback flag — copy state lives in packages/mobile/src/components/TrackerWarningDialog.tsx:38 separately.
- plan: Add packages/mobile/src/hooks/useLinkCopy.ts with the same shape; `navigator.clipboard.writeText` → `Clipboard.setStringAsync` from expo-clipboard (already a dependency, used in 6 files). Consume it from WebLink.tsx, NoteContent.tsx and TrackerWarningDialog.tsx.

### Link right-click/long-press menu: open clean vs as-is, copy clean vs as-is
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/components/LinkCopyContextMenu.tsx; packages/web/src/hooks/useLinkCopy.ts; used by packages/web/src/components/WebLink.tsx:44,100`
- impact: Mobile long-press does surface the tracker prompt, but the standalone link card with hostname + safety gate is dead code, so bare URLs render as truncated inline text rather than the labelled card.
- detail: Mobile's active link renderer is the local WebLink inside packages/mobile/src/components/NoteContent.tsx:101-127; long-press opens packages/mobile/src/components/TrackerWarningDialog.tsx. The richer card-style packages/mobile/src/components/WebLink.tsx (which also gates on isSafeExternalUrl at WebLink.tsx:44-46) is imported by nothing. Whether all four web options (open clean / open as-is / copy clean / copy as-is) are offered depends on TrackerWarningDialog's buttons.
- plan: Confirm packages/mobile/src/components/TrackerWarningDialog.tsx offers all four actions (open clean, open original, copy clean, copy original) to match LinkCopyContextMenu.tsx:44-49; then either delete the unused packages/mobile/src/components/WebLink.tsx or use it for standalone-URL parts so mobile matches web's link card.

### Main mobile feed queries only kinds 1 and 6
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/core/src/feedConstants.ts FEED_KINDS = [1,5,6,7,16,20,21,22,1063,1068,1111,30023,34235,34236,9735,9802]; used by packages/web/src/lib/feedUtils.ts:90 and useFeedPagination.ts`
- impact: The main mobile feed shows no long-form articles (30023), no picture posts (20), no NIP-71 video (21/22/34235/34236), no highlights (9802), no polls (1068), no NIP-22 comments (1111), and no reaction/zap events for engagement counts — a materially different feed from web/desktop for the same follow list.
- detail: packages/mobile/src/hooks/useFeed.ts:20 and :110 both do `FEED_KINDS.filter(k => k === 1 || k === 6)`. useFeed is the hook backing the primary Feed tab (packages/mobile/src/screens/HomeScreen.tsx:20,157,161). Mobile's other paths (lib/feedUtils.ts:99, useCustomFeedNotes) correctly use the full set minus kind 5, so this is specific to the home feed.
- plan: Replace both `FEED_KINDS.filter(k => k === 1 || k === 6)` expressions with `[...FEED_KINDS].filter(k => k !== 5)`, matching packages/mobile/src/lib/feedUtils.ts:99 and web feedUtils.ts:90. Verify NoteCard/SmartNoteContent render each kind (they already handle 30023 and imeta media).

### Mobile ESLint does not enforce web's custom rules or the todo/fixme ban
- mobile: **missing** · desktop: **n/a** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/eslint.config.js (custom/no-placeholder-comments: error, no-warning-comments: error) — mirrored in /home/q4/corkboards/packages/core/eslint.config.js`
- impact: Placeholder implementations and TODO debt can accumulate in the mobile tree while web and core reject them at lint time — exactly the mechanism by which the platforms drift apart.
- detail: Verified with `eslint --print-config`. Web (`src/App.tsx`) and core (`src/nostr.ts`) both resolve to `custom/no-placeholder-comments: [2]` and `no-warning-comments: [2, {location:'start', terms:['fixme','todo']}]`. Mobile (`src/screens/HomeScreen.tsx`) resolves to NEITHER — `packages/mobile/eslint.config.mjs` never imports `../web/eslint-rules/index.js` and never sets `no-warning-comments`. Core already proves the cross-package import works (packages/core/eslint.config.js line: `import customRules from '../web/eslint-rules/index.js'`). Mobile is currently clean by luck: 0 todo/fixme comments and 0 "in a real" comments found under packages/mobile/src.
- plan: In `packages/mobile/eslint.config.mjs` add `import customRules from '../web/eslint-rules/index.js';`, register `plugins: { ..., custom: customRules }`, and add `'custom/no-placeholder-comments': 'error'`, `'custom/no-inline-script': 'error'` (cheap insurance) and `'no-warning-comments': ['error', { terms: ['fixme','todo'] }]`. Longer term, extract the three shared rule entries into `packages/web/eslint-rules/shared-rules.js` and spread it into all three configs so there is one source of truth.

### Mobile-only: session zap cache for optimistic zap state
- mobile: **present** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/components/NoteCard.tsx:82-88 (module-level userZaps/userReactions Sets cleared by clearNoteCardCache)`
- impact: None.
- detail: packages/mobile/src/lib/userZapCache.ts is used by packages/mobile/src/components/NoteActions.tsx:15,40,166. Web has the equivalent as module-level state inside NoteCard rather than a separate module. Functionally at parity; the difference is only structural.
- plan: Optional cleanup: hoist both into a shared @core/sessionEngagementCache so the clear-on-logout semantics (web's clearNoteCardCache) are guaranteed identical — mobile currently has no visible clear-on-logout for userZapCache, which could leak a previous account's zap state across an account switch.

### Mute-list publish bypasses the shared publish path
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/hooks/useMuteList.ts (uses `const { mutateAsync: createEvent } = useNostrPublish()`)`
- impact: Kind-10000 mute-list events published from mobile ignore the user's client-tag preference and have no publish timeout — a stalled relay can hang the mute action indefinitely.
- detail: packages/mobile/src/hooks/useMuteList.ts:59-66 signs with `signer.signEvent({...})` and publishes with `await nostr.event(event)` directly, skipping useNostrPublish entirely. useNostrPublish is where the `publishClientTag` privacy setting is enforced (packages/mobile/src/hooks/useNostrPublish.ts:35-38) and where the 8 s publish timeout lives.
- plan: Replace packages/mobile/src/hooks/useMuteList.ts:59-66 with `const { mutateAsync: createEvent } = useNostrPublish()` and `await createEvent({ kind: 10000, content, tags })`, matching web.

### NIP-22 comment parent resolution (`a` and `i` tags)
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/hooks/useComments.ts (parentId = getTagValue(comment,'e') ?? getTagValue(comment,'a') ?? getTagValue(comment,'i'))`
- impact: Comment threads under long-form articles and storefront listings collapse to a flat list (or drop replies entirely) on mobile, while nesting correctly on web/desktop.
- detail: packages/mobile/src/hooks/useComments.ts:44 reads `const parentId = getTagValue(comment, 'e');` only. NIP-22 comments on addressable events (kind 30023 long-form, kind 30402 NIP-99 listings) carry an `a` tag, and comments on external identities carry `i` — neither resolves on mobile.
- plan: Change packages/mobile/src/hooks/useComments.ts:44 to `getTagValue(comment,'e') ?? getTagValue(comment,'a') ?? getTagValue(comment,'i')`, matching web exactly.

### NIP-65 relay-list fetch cancellation
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/hooks/useNip65Relays.ts:17-26 (`externalSignal` param → `AbortSignal.any([externalSignal, AbortSignal.timeout(5000)])`)`
- impact: Relay-list discovery for the departing account's follows keeps running for up to 5 s past an account switch on mobile, and its results write into the shared relayCache used by the new account's queries.
- detail: packages/mobile/src/hooks/useNip65Relays.ts:11 declares `fetchRelaysForPubkey(pubkey: string)` with no signal parameter and line 15-17 uses a bare `AbortSignal.timeout(5000)`. Mobile has a session-abort system (packages/mobile/src/hooks/useSessionAbort.ts, at full parity) that nothing here consumes.
- plan: Add the optional `externalSignal` parameter and the `AbortSignal.any` combination at packages/mobile/src/hooks/useNip65Relays.ts:11-17, and have `fetchRelaysForMultiple` callers (HomeScreen.tsx:366) pass `getSessionSignal()`.

### NIP-99 listing card — spec key/value chips and multi-image indicator
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/components/ListingCard.tsx:41-46 ("+N" images badge), 68-76 (specs chips), 33-48 (Sold/Out-of-stock overlay on the image)`
- impact: Storefront listings lose their attribute table (size, condition, shipping…) and give no hint that more photos exist — relevant to the planned store-corkboard work.
- detail: packages/mobile/src/components/NoteContent.tsx:491-512 ListingPreview covers title, price, summary, location, stock, pre-order, sold/out-of-stock — but drops `specs` (parseListing returns it; mobile destructures without it at NoteContent.tsx:493) and shows no "+N more images" badge, and renders SOLD as a text line rather than an overlay.
- plan: Destructure `specs` in ListingPreview and render the first six as chips, and add a `+{images.length - 1}` badge over the hero image, matching ListingCard.tsx:41-46 and 68-76.

### Notifications pagination controls: +25/+100 and "Load newer"
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/components/StatusBar.tsx:250-283 (notification-tab branch); wired at MultiColumnClient.tsx:4505-4509 via NotificationsCorkboard.tsx:87-90 onLoadMoreReady`
- impact: Minor: mobile can only page in the hook's default increment and gets no indication of how stale the notification list is.
- detail: packages/mobile/src/screens/NotificationsScreen.tsx:238-254 has one "Load more notifications" footer button and pull-to-refresh calling loadNewer (NotificationsScreen.tsx:226-232). There is no explicit batch size choice and no "Newer" button with the time-gap label web shows (StatusBar.tsx:271-283, formatNewerTime at StatusBar.tsx:45-53).
- plan: Add +25/+100 buttons calling `loadMore(n)` and a Newer button with the formatNewerTime label (move that helper into @core so both platforms share it).

### Nuclear wipe completeness in a webview
- mobile: **n/a** · desktop: **partial** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/src/hooks/useLoginActions.ts:449-472; compare the guarded usage in /home/q4/corkboards/packages/web/src/main.tsx:121-126`
- impact: 'Erase everything' can silently stop two-thirds of the way through on desktop, leaving the safety-net sweep unrun and the user's SOCKS/Tor proxy configuration on disk after a supposedly total wipe.
- detail: nuclearWipe accesses `navigator.serviceWorker.getRegistrations()` (line 450) and `caches.keys()` (line 458) with no feature guard, while main.tsx:121-126 guards the identical calls with `navigator.serviceWorker?.getRegistrations?.()` and `'caches' in window`. In a webview where either API is absent, line 450 throws a synchronous TypeError before any promise exists, so `.catch(() => {})` never applies; the throw escapes to the caller (MultiColumnClient.tsx:816/880), which logs 'Wipe error' and reloads. Everything after line 449 — the Cache API purge, the final localStorage/sessionStorage clear and the second deleteAllDbs() sweep — is skipped. Desktop also never wipes packages/desktop/src-tauri's proxy.json.
- plan: In /home/q4/corkboards/packages/web/src/hooks/useLoginActions.ts:449-466 mirror main.tsx's guards: `const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? []` and `if ('caches' in window) { … }`. Add a Rust `wipe_desktop_state()` command that deletes proxy.json and debug.log, and call it from nuclearWipe under `if (isTauri)`.

### Offline app-shell service worker
- mobile: **n/a** · desktop: **partial** · effort: trivial
- web impl: `packages/web/public/sw.js registered at packages/web/src/main.tsx:159-175 (plus the stale-chunk self-heal at main.tsx:110-129)`
- impact: Low: desktop loses nothing functional (its assets are bundled), but the self-heal path that recovers a blank app after a bad chunk silently does nothing there, and a failed registration is logged as noise in the Tauri log console (main.tsx:55-101 pipes console output to the file logger).
- detail: main.tsx:159 runs `navigator.serviceWorker.register('/sw.js')` unconditionally — it is NOT guarded by the isTauri flag that guards the login-storage branch three lines earlier (main.tsx:149-158). Inside the Tauri custom-protocol origin the registration fails and is swallowed by `.catch(() => {})`, so the offline shell, the controllerchange reload, and the bundle-recovery cache purge (main.tsx:126-129, which calls navigator.serviceWorker.getRegistrations) are all inert on desktop.
- plan: Wrap the service-worker registration block in `if (!isTauri)` in packages/web/src/main.tsx:159, and short-circuit the bundle-recovery handler's SW/cache cleanup on Tauri so it just reloads.

### Periodic "save a local backup" reminder prompt
- mobile: **missing** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/components/BackupDownloadPrompt.tsx; mounted at packages/web/src/pages/MultiColumnClient.tsx:4107 (showDownloadPrompt)`
- impact: Mobile users are never nudged to take a local backup, so a mobile-only user can go indefinitely with no off-device copy.
- detail: packages/mobile/src/components/BackupDownloadPrompt.tsx exists (167 lines) and packages/mobile/src/lib/downloadBackup.ts:138 exports `shouldPromptBackupDownload()`, but neither is referenced anywhere in packages/mobile/src or App.tsx.
- plan: Mount BackupDownloadPrompt in the mobile tab shell, opened when `shouldPromptBackupDownload()` returns true, exactly as MultiColumnClient.tsx:4107 does.

### Periodic relay-health auto-check
- mobile: **present** · desktop: **missing** · effort: trivial
- web impl: `none`
- impact: The relay-health panel on web/desktop shows whatever the state was when it was last manually refreshed, so a relay that went down mid-session still reads as healthy.
- detail: packages/mobile/src/hooks/useRelayHealth.ts exports `useRelayHealthAuto()` (confirmed by the export-symbol diff) which re-runs checkAllRelays on a `HEALTH_CHECK_INTERVAL = 120000` timer. packages/web/src/hooks/useRelayHealth.ts exports only `useRelayHealth` — web's readout is stale until the user manually presses check.
- plan: Copy useRelayHealthAuto into packages/web/src/hooks/useRelayHealth.ts verbatim (no RN APIs involved) and use it in the relay settings panel; gate the interval on document.visibilityState so a background tab doesn't poll.

### RSS feed columns (fetch via rss-proxy.php)
- mobile: **present** · desktop: **missing** · effort: trivial
- web impl: `/home/q4/corkboards/packages/core/src/feedConstants.ts:19 (`RSS_PROXY = '/rss-proxy.php'`); /home/q4/corkboards/packages/web/src/lib/feedUtils.ts:29; /home/q4/corkboards/packages/web/src/pages/MultiColumnClient.tsx:1431-1441; server file /home/q4/corkboards/packages/web/rss-proxy.php`
- impact: Every RSS column and every 'add RSS feed' validation silently fails on desktop. Adding a feed always shows the red 'RSS warning — could not reach feed' toast, and RSS tabs stay permanently empty. RSS is completely unusable in the desktop app.
- detail: RSS_PROXY is a ROOT-RELATIVE path. In the Tauri build the document origin is `tauri://localhost` (Linux/macOS) or `http://tauri.localhost` (Windows) and the asset protocol only serves files from packages/web/dist — there is no PHP runtime. `fetch('/rss-proxy.php?url=…')` therefore resolves to `tauri://localhost/rss-proxy.php`, which the Tauri asset handler resolves via its index.html fallback (tauri-2.10.3 src/manager/mod.rs:415) and returns HTML. feedUtils.ts:35 then hits the `JSON.parse` catch and returns null; MultiColumnClient.tsx:1435 `r.json()` rejects and toasts 'Could not reach feed'. Mobile already solved this: /home/q4/corkboards/packages/mobile/src/lib/feedUtils.ts:20 hardcodes the absolute `https://corkboards.me/rss-proxy.php`.
- plan: Make the proxy base absolute when not served over http(s). In packages/core/src/feedConstants.ts export `RSS_PROXY_FALLBACK = 'https://corkboards.me/rss-proxy.php'` and add a `resolveRssProxy()` that returns the relative path when `location.protocol` is http:/https: and the absolute URL otherwise; call it from packages/web/src/lib/feedUtils.ts:29 and MultiColumnClient.tsx:1432. Better long-term: add a Rust `rss_fetch` command in packages/desktop/src-tauri (reusing relay.rs's SOCKS/proxy plumbing and the same isBlockedIpv4/isBlockedIpv6 SSRF gate) so desktop fetches feeds natively, gets Tor coverage, and never depends on corkboards.me being up.

### Refetch notifications on app foreground
- mobile: **missing** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/hooks/useNotificationCount.ts:64 and packages/web/src/hooks/useNotifications.ts (`refetchOnWindowFocus: true`)`
- impact: Returning to the mobile app shows a stale notification badge and stale Activity list for up to 60 s.
- detail: Both mobile hooks omit it: packages/mobile/src/hooks/useNotificationCount.ts:64-67 sets only `enabled`/`staleTime`/`refetchInterval`, and the diff of useNotifications shows `refetchOnWindowFocus: true` present on web with no mobile counterpart. The mobile QueryClient in App.tsx explicitly sets `refetchOnWindowFocus: false` globally.
- plan: Install `@tanstack/react-query`'s RN focus manager once in App.tsx — `AppState.addEventListener('change', s => focusManager.setFocused(s === 'active'))` — then set `refetchOnWindowFocus: true` on those two queries specifically.

### Relay health check coverage and background refresh
- mobile: **partial** · desktop: **partial** · effort: trivial
- web impl: `packages/web/src/hooks/useRelayHealth.ts (adds READ_ONLY_RELAYS to the checked set; batches of 6)`
- impact: Mobile's relay-health panel silently omits the read-only relays the app actually queries; web/desktop never auto-refresh their health readout.
- detail: packages/mobile/src/hooks/useRelayHealth.ts omits the `READ_ONLY_RELAYS.forEach(r => all.add(normalizeRelay(r)))` line web has, so those relays are never health-checked on mobile. Conversely mobile is AHEAD in one respect: it exports `useRelayHealthAuto()` with a `HEALTH_CHECK_INTERVAL = 120000` periodic re-check that web has no equivalent of. Mobile reads user relays from `getUserRelays()` while web parses them out of the `corkboard:app-config` blob (getUserRelaysFromIdb) — same data, two code paths.
- plan: Add the READ_ONLY_RELAYS line to mobile's relay set. Port `useRelayHealthAuto` to web (it is DOM-free). Replace web's getUserRelaysFromIdb with the exported `getUserRelays()` from NostrProvider so both platforms read relays the same way.

### Reply parent context in the feed ("Replying to …" card)
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:14 (useParentNotes), 4414 (parentNotes passed to FeedGrid); packages/web/src/components/NoteCard.tsx:269-279 (ParentContext)`
- impact: Replies in the mobile feed appear with no context — you see "yes, exactly" with no idea what it answers. Web shows the parent note inline above it.
- detail: packages/mobile/src/components/NoteCard.tsx:38-72 implements ParentContext and NoteCard accepts a `parentNote` prop (NoteCard.tsx:84-85), but packages/mobile/src/screens/HomeScreen.tsx:465-476 never passes it, and packages/mobile/src/hooks/useParentNotes.ts is imported by nothing (verified). Same in DiscoverScreen.tsx:345-354 and SavedScreen.tsx:142-146.
- plan: Call `useParentNotes(filteredEvents)` in HomeScreen and pass `parentNote={parentNotes[item.id]}` in renderNote; do the same in DiscoverScreen and SavedScreen.

### Root package is publishable and would publish the entire monorepo
- mobile: **n/a** · desktop: **n/a** · effort: trivial
- web impl: `/home/q4/corkboards/package.json — `"private": false` with `workspaces: ["packages/*"]` and no `files` field`
- impact: Low probability, high blast radius — an accidental publish would put internal audit notes and server configuration on the public npm registry, contrary to the project's own privacy posture.
- detail: All four workspace packages correctly set `"private": true`. The root sets `"private": false` and declares no `files` allowlist and no `.npmignore`. An accidental `npm publish` at root would upload a package named `corkboards` containing everything not covered by `.gitignore` — which includes `packages/web/rss-proxy.php`, `.htaccess`, `AGENTS.md`, `SECURITY_IMPLEMENTATION.md`, and any stray files. The root also has no `main`/`exports`, so the published artifact would be unusable as a library anyway.
- plan: Set `"private": true` on the root package.json. It is a workspace root, not a publishable artifact — nothing in the repo publishes it, and the `repository`/`license`/`description` fields serve their documentation purpose regardless.

### Rust backend command coverage (dead-code check)
- mobile: **n/a** · desktop: **present** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/src/lib/tauri.ts (all wrappers); /home/q4/corkboards/packages/web/src/lib/fetchEvent.ts:90; /home/q4/corkboards/packages/web/src/components/NostrProvider.tsx:934; /home/q4/corkboards/packages/web/src/components/AdvancedSettings.tsx:534-537; /home/q4/corkboards/packages/web/src/hooks/useLoginActions.ts:79,349,388; /home/q4/corkboards/packages/web/src/main.tsx:57,90`
- impact: None — recorded so this can be ruled out rather than re-audited.
- detail: Verified every one of the 17 commands in packages/desktop/src-tauri/src/lib.rs:71-89 has a live JS caller: keychain_store (useLoginActions.ts:79), keychain_delete (useLoginActions.ts:349,389 + useLoggedInAccounts.ts:61), write_log/clear_log (main.tsx:90,57), relay_query (fetchEvent.ts:90 via tauriRelayQuery), relay_subscribe (NostrProvider.tsx:934 via tauriQuery), the six proxy commands (AdvancedSettings.tsx:534-537,549,561), and sign_event/nip44_*/nip04_* (tauriSigner.ts:25-39). relay.rs and proxy.rs are NOT dead code. Signature verification is correctly doubled (relay.rs:299-304 at the transport boundary, tauri.ts:197 and :326-332 in JS). The one unreachable branch is relay.rs:252-257's `.onion` allowance, blocked upstream by isSecureRelay — tracked as its own row.
- plan: No action. Keep it that way by adding a CI step that greps for each `#[tauri::command]` name in packages/web/src, failing on any command with no JS caller. `npm run test:desktop` already runs clippy with `-D warnings`; wire it into the release checklist since it is intentionally excluded from `npm test`.

### Service worker / offline app-shell caching
- mobile: **n/a** · desktop: **partial** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/src/main.tsx:160-174; /home/q4/corkboards/packages/web/public/sw.js:23-85`
- impact: Dead code and wasted registration attempts on Linux/macOS; on Windows a real risk that the app boots blank after the SW activates, recoverable only by the bundle-recovery handler at main.tsx:110-130 (which itself depends on the failing SW APIs).
- detail: main.tsx:161-162 registers `/sw.js` with no platform guard. In the Tauri build the app shell is already local (frontendDist ../../web/dist), so the SW provides zero benefit and only adds risk. On Linux/macOS the origin is the custom scheme `tauri://localhost`, which wry registers as secure (wry-0.54.4 src/webkitgtk/web_context.rs:136-142) but WebKit does not allow ServiceWorkerContainer on custom schemes, so registration rejects and is swallowed by `.catch(() => {})`. On Windows the origin is `http://tauri.localhost` — a secure context where WebView2 DOES support service workers, but WebView2's WebResourceRequested interception (which is how Tauri serves the bundle) does not apply to service-worker-initiated fetches, so sw.js:57-68's network-first `fetch(request)` for `/assets/*.js` would leave the custom-protocol handler and fail. main.tsx:167-173's controllerchange reload then fires on top of that.
- plan: Gate registration: `if (!isTauri && 'serviceWorker' in navigator) { … }` in /home/q4/corkboards/packages/web/src/main.tsx:161, and also gate the controllerchange listener. Optionally, in the same guard, proactively unregister any SW that a previous desktop build left behind.

### Session-zap optimistic state: amount tracking and logout clearing
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/components/NoteCard.tsx:71 (`recordUserZap(noteId, amount)`), called from packages/web/src/components/ZapDialog.tsx:42; cleared via clearNoteCardCache() in useLoginActions.ts:356`
- impact: After switching accounts on the same phone, notes account A zapped still render as zapped for account B. And the mobile zap badge can't show the pending amount.
- detail: packages/mobile/src/lib/userZapCache.ts:13 stores a boolean only (`recordUserZap(noteId)`) — no amount — so mobile cannot show the optimistic sat total web shows. It also exports `clearUserZapCache()` (line 23) with the docstring "Call on logout to avoid cross-user contamination", but grep shows it is called from nowhere: packages/mobile/src/lib/AuthContext.tsx logout (line 421-439) and removeAccount (line 379-419) never invoke it.
- plan: Change the module to `Map<string, number>` and take an `amount` argument, matching web's signature. Call `clearUserZapCache()` from AuthContext.logout, removeAccount and switchAccount alongside the existing clearCollapsedNotesModuleState()/clearProfileCache() calls.

### Tablet/mobile platform detection is orientation-dependent
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/lib/storageKeys.ts:41-47 (detectPlatform: Tauri vs web; CURRENT_PLATFORM cached at module load, stable)`
- impact: Launching the phone in landscape reads and writes platform settings under `tablet:` — column count, feed multiplier, autofetch, load-all-media, filters-open all silently reset to defaults, and edits made in that session are invisible in the next portrait launch. These keys are in PLATFORM_SPECIFIC_KEYS (packages/core/src/storageKeys.ts:117-130) so they round-trip through backups too.
- detail: packages/mobile/src/lib/storageKeys.ts:38-48: `const { width } = Dimensions.get('window'); return width >= 768 ? 'tablet' : 'mobile';`, memoised into `_cachedPlatform` on first call. A modern phone in landscape reports width ≈ 850-930, so whether the app is 'mobile' or 'tablet' depends on the device orientation at the moment the first platform-scoped setting is read — and that decision sticks for the whole process.
- plan: Use the smaller dimension, which is orientation-invariant: `const {width,height} = Dimensions.get('window'); return Math.min(width,height) >= 600 ? 'tablet' : 'mobile';` (600dp is the standard Android sw600dp tablet breakpoint). Add a one-time migration that copies any existing `tablet:`-prefixed keys to `mobile:` when the device resolves to mobile.

### Tauri IPC transport (all invoke() calls: keychain, signing, native relay, proxy settings, file log)
- mobile: **n/a** · desktop: **partial** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/index.html:15 (meta CSP); /home/q4/corkboards/packages/desktop/src-tauri/tauri.conf.json:15 (header CSP); /home/q4/corkboards/packages/web/src/lib/tauri.ts:16-21,158-223`
- impact: Every desktop session starts with a CSP violation and a console warning, then runs all IPC over the slower string-based postMessage path. Channel<T> is unusable, so the native relay bridge needs a bespoke emit/listen protocol. Any future plugin that uses Channel (streamed downloads, upload progress, log streaming) will hang silently.
- detail: Tauri sends its tauri.conf.json CSP as an HTTP `Content-Security-Policy` header (tauri-2.10.3 src/protocol/tauri.rs:217) and does NOT strip the app's own `<meta http-equiv="content-security-policy">`. Two policies are enforced as an intersection. The header allows `connect-src … ipc: http://ipc.localhost`, but index.html:15 declares `connect-src 'self' blob: https: wss:` with `default-src 'none'` — neither `ipc:` nor `http://ipc.localhost` is present. Tauri's IPC does `fetch(convertFileSrc(cmd,'ipc'))` → `ipc://localhost/<cmd>` (tauri-2.10.3 scripts/core.js:13-20, scripts/ipc-protocol.js), so that fetch is CSP-blocked on the very first invoke, the catch fires, and Tauri permanently latches `customProtocolIpcFailed = true` and falls back to `window.ipc.postMessage`. This is exactly the failure documented in packages/web/src/lib/tauri.ts:160-164 ('Channel<T> hangs silently when the Tauri IPC custom protocol falls back to postMessage'), which forced the whole app.emit()+listen() relay workaround.
- plan: Add `ipc: http://ipc.localhost` to the connect-src of the meta CSP in /home/q4/corkboards/packages/web/index.html:15 (harmless on plain web — those schemes are never requested there). While there, align the two policies so the intersection is intentional: the header has `media-src … blob:` and `font-src 'self' data:` that the meta lacks, and the meta has `connect-src blob:` that the header lacks. Then re-test whether Channel<T> works and consider dropping the app.emit workaround in tauri.ts.

### Tauri runtime detection (platform-scoped settings + login-method gating)
- mobile: **n/a** · desktop: **partial** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/src/lib/tauri.ts:11-13 (checks both globals); /home/q4/corkboards/packages/web/src/lib/storageKeys.ts:42; /home/q4/corkboards/packages/web/src/components/auth/WelcomePage.tsx:19`
- impact: Latent: a one-line config change silently corrupts desktop layout preferences and resurrects two login buttons that are guaranteed to fail in a webview.
- detail: tauri.ts:11-13 correctly checks `'__TAURI__' in window || '__TAURI_INTERNALS__' in window`, but storageKeys.ts:42 (`detectPlatform`) and WelcomePage.tsx:19 each re-implement the check as `'__TAURI__' in window` only. Those two only work because tauri.conf.json:13 sets `withGlobalTauri: true` — which is itself the thing that should be turned off (see the XSS finding). Flipping that flag would silently make desktop report `platform: 'web'` (so DEFAULT_COLUMN_COUNT, FEED_LIMIT_MULTIPLIER, AUTOFETCH, dialog geometry etc. from PLATFORM_SPECIFIC_KEYS would collide with the web profile) and would re-show the NIP-07 extension and Amber buttons on desktop where neither can work.
- plan: Delete both local re-implementations and import the single source of truth: `import { isTauri } from '@/lib/tauri'` in /home/q4/corkboards/packages/web/src/lib/storageKeys.ts:42 and /home/q4/corkboards/packages/web/src/components/auth/WelcomePage.tsx:19. Add an eslint no-restricted-syntax rule banning bare `'__TAURI__' in window` outside lib/tauri.ts.

### Video upload in the composer
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/components/ComposeDialog.tsx:441-447 (`accept="image/*,video/*"`, multiple)`
- impact: Mobile users — the ones most likely to be shooting video — cannot attach a video to a post, and must tap the attach button once per image.
- detail: packages/mobile/src/screens/ComposeScreen.tsx:111-115 calls `ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], ... })` — images only, and one asset per invocation (`result.assets[0]` at ComposeScreen.tsx:116-118). Web allows multiple files and video in one picker.
- plan: Change mediaTypes to ['images','videos'], set `allowsMultipleSelection: true`, and loop over `result.assets` building one UploadedMedia descriptor each (the imeta emission at ComposeScreen.tsx:214-222 already handles an array).

### Web ESLint never lints its own .js files, including the custom rules
- mobile: **n/a** · desktop: **n/a** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/eslint.config.js — config blocks cover only `**/*.{ts,tsx}` and `**/*.html``
- impact: The lint tooling that guards the whole web codebase is itself unguarded, and is using APIs that a future ESLint major will drop — which would silently disable the custom rules rather than error.
- detail: Neither `files` pattern matches `.js`, so `packages/web/eslint-rules/index.js`, `no-inline-script.js`, `no-placeholder-comments.js`, `require-webmanifest.js`, `packages/web/postcss.config.js` and `packages/web/eslint.config.js` itself are all unlinted. This is not academic: `require-webmanifest.js` and `no-placeholder-comments.js` both call `context.getSourceCode()` and `context.getFilename()`, deprecated in ESLint 9 and slated for removal — a lint pass over these files would have surfaced that. Mobile is in the same position for its `.mjs`/`.js` configs, though mobile's tsconfig does at least type-check `eslint.config.mjs` (it appears in `tsc --showConfig` output, since mobile's tsconfig sets no `include` and expo's base enables `allowJs`).
- plan: Add `"js"` to the first block's files pattern in `packages/web/eslint.config.js` (`files: ["**/*.{js,ts,tsx}"]`) with `{ ignores: ["dist", "eslint-rules/**/*.test.js"] }` as needed. Then modernise the three rules: `context.getSourceCode()` → `context.sourceCode`, `context.getFilename()` → `context.filename`. Mirror the same files-pattern widening in packages/core and packages/mobile configs.

### Web-only chrome with no mobile analogue: Future Features modal, "Adding Sources" help dialog, tab-bar stick/hide corner buttons, brand logo header
- mobile: **missing** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/pages/MultiColumnClient.tsx:4527-4546 (Future Features), 4137-4224 (stick/hide tab bar corners); packages/web/src/components/TabBar.tsx:518-550 / 716-753 (sources help); packages/web/src/components/BrandIcon.tsx, BrandLogo.tsx`
- impact: Cosmetic/informational only — but the sources help dialog matters once mobile gets a corkboard builder, since it is the only place the npub/#hashtag/relay/RSS input syntax is explained. And the About version string misreports the app version.
- detail: Mobile shows a static logo image (packages/mobile/src/screens/HomeScreen.tsx:524, assets/corky-logo.png) and no help/about/roadmap surface beyond SettingsScreen.tsx:507-512 ("Corkboards v2.0.0-beta"). Note that mobile's About string is also stale versus the repo version 0.8.0 in packages/desktop/src-tauri/tauri.conf.json:4.
- plan: Ship the sources help text alongside the mobile corkboard editor (share the copy from TabBar.tsx:523-548 via a @core constant so it can't drift), and fix packages/mobile/src/screens/SettingsScreen.tsx:510 to read the real version from app.json.

### Web-only lib modules that are correctly platform-specific or already shared via @core
- mobile: **n/a** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/lib/{idb,polyfills,triggerDownload,webKeyStore,webNsecSigner,tauriSigner,tauri}.ts and the one-line re-exports {failedNotes,formatTimeAgo,genUserName,nostr,noteClassifier,normalizeRelay,textTruncation,imageUtils,relayConstants,defaultEmojiSet}.ts`
- impact: None.
- detail: Verified each: failedNotes.ts, formatTimeAgo.ts, genUserName.ts, nostr.ts, noteClassifier.ts, normalizeRelay.ts, textTruncation.ts are literally `export * from '@core/…'`; imageUtils.ts, relayConstants.ts and defaultEmojiSet.ts are named re-exports of core. Mobile imports the same core modules directly (e.g. useRetryFailedNotes.ts imports getFailedNoteIds from '@core/failedNotes'). idb.ts/polyfills.ts/triggerDownload.ts are browser-only and answered by MmkvStorage.ts / react-native-get-random-values / expo-sharing. webKeyStore/webNsecSigner/tauriSigner are answered by react-native-keychain in AuthContext.tsx. NOT a gap — recorded so these are not chased.
- plan: No action, with two caveats: (1) packages/web/src/lib/profileCache.ts is a genuinely web-only SECOND profile cache (used by MultiColumnClient.tsx:105 and ProfileCacheSettings.tsx:15) that writes the same `profile-cache:` prefix as mobile's cacheStore but with a different record shape (name/picture/cached_at vs metadata/event/cachedAt) — consolidate it into cacheStore.ts and delete it rather than porting it. (2) packages/web/src/lib/idb.ts:241-250 `idbPrimeCache` (update cache + notify without scheduling a write) has no MMKV analogue; add one when the storage-layer sync event lands so bulk restore doesn't double-write.

### `npm run test` leaves packages/web/dist in a non-deployable state
- mobile: **n/a** · desktop: **n/a** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/package.json — `build` rewrites sw.js CACHE_VERSION, `test` does not`
- impact: If a deploy is ever cut from a `test`-produced dist rather than a `build`-produced one, every user keeps a permanently-named service worker cache across deploys — reviving the documented double-mount bug where a stale `index.js` runs alongside the fresh one. The silent catch means the same thing happens with no error if the rewrite breaks.
- detail: `build` = `vite build -l error && node -e "...replace('corkboards-CACHE_VERSION','corkboards-'+Date.now())..." && cp dist/index.html dist/404.html`. `test` = `... && vite build -l error && cp dist/index.html dist/404.html` — same build, no sw.js rewrite. Verified live: after I ran `npm run test:web`, `packages/web/dist/sw.js:11` reads `const CACHE_NAME = 'corkboards-CACHE_VERSION'` (the literal placeholder), while `dist_deploy/sw.js:11` from a real build reads `'corkboards-1784900629839'`. Separately, the rewrite step is wrapped in `try{...}catch(e){}` — if it ever throws (a path change, a `type: module` interaction with `node -e`), the build succeeds silently with the placeholder intact.
- plan: Extract the sw.js rewrite into `packages/web/scripts/stamp-sw.mjs`, call it from both `build` and `test`, and make it FAIL LOUDLY: `if (!sw.includes('corkboards-CACHE_VERSION')) { console.error('sw.js placeholder not found'); process.exit(1); }` instead of swallowing. Add a vitest asserting `dist/sw.js` contains no literal `CACHE_VERSION` token after a build.

### custom/no-inline-script is a completely dead ESLint rule
- mobile: **n/a** · desktop: **n/a** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/eslint-rules/no-inline-script.js + its registration in /home/q4/corkboards/packages/web/eslint.config.js`
- impact: The one lint rule guarding the project's XSS boundary ("all HTML rendering must go through the DOMPurify sanitize() wrapper") enforces nothing. A `dangerouslySetInnerHTML` added anywhere in the 251-file web tree passes `npm run test` clean.
- detail: The rule's `create()` returns only a `JSXAttribute(node)` visitor that reports `dangerouslySetInnerHTML`. But in `packages/web/eslint.config.js` it is enabled ONLY inside the second config block, `files: ["**/*.html"]`, which is parsed by `@html-eslint/parser` — an HTML AST that never emits `JSXAttribute`. The `**/*.{ts,tsx}` block does not enable it. Verified empirically: piping `export function X(){ return <div dangerouslySetInnerHTML={{__html:"<b>hi</b>"}} />; }` through `eslint --stdin --stdin-filename src/__scratch__.tsx` reports 0 problems, and piping an HTML document containing `<script>alert(1)</script>` through `--stdin-filename __scratch__.html` also reports 0 problems. (Control: the same HTML with the manifest link removed correctly fires `custom/require-webmanifest`, so the HTML block itself is live.) `packages/web/eslint-rules/README.md` still documents it as an HTML inline-script rule — the implementation was rewritten to a JSX rule on Apr 7 and its config entry was never moved.
- plan: Move `"custom/no-inline-script": "error"` from the `**/*.html` block into the `**/*.{ts,tsx}` block of `packages/web/eslint.config.js` (and mirror it into `packages/core/eslint.config.js` — harmless there, and it hardens against a future core .tsx). Rewrite `packages/web/eslint-rules/README.md`'s no-inline-script section to describe what the rule actually does. If you still want HTML inline-script coverage, add `@html-eslint/no-inline-script` or a second visitor keyed on the html-eslint `ScriptTag` node.

### fetchEvent author-relay discovery in-flight dedupe
- mobile: **missing** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/lib/fetchEvent.ts:119-157 (`_authorRelaysInFlight` Map<pubkey, Promise<string[]>>)`
- impact: A thread with several notes by one author opens a multiple of the necessary WebSocket queries on mobile.
- detail: Web coalesces concurrent NIP-65 discovery for the same pubkey into one promise. packages/mobile/src/lib/fetchEvent.ts has no such map — grep for `_authorRelaysInFlight` in packages/mobile/src returns nothing — so N simultaneous note-resolution attempts for the same author each fan out across `[...FALLBACK_RELAYS, ...READ_ONLY_RELAYS]`.
- plan: Copy the `_authorRelaysInFlight` map + try/finally wrapper from packages/web/src/lib/fetchEvent.ts:119-157 into the mobile file's author-relay function.

### fetchEvent hard deadline on the fallback relay fan-out
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/lib/fetchEvent.ts:208-212 and :281-285 (`Promise.race([Promise.all(racePromises), fallbackDeadline(4000)])`)`
- impact: Quoted/referenced notes on mobile can spin for the full per-relay timeout budget instead of resolving or giving up at 4 s — the "note won't load" symptom.
- detail: Both web sites carry an explicit `(M4)` comment: Promise.all can otherwise block on the slowest relay. packages/mobile/src/lib/fetchEvent.ts:169 and :235 use a bare `await Promise.all(racePromises)` with no deadline.
- plan: At packages/mobile/src/lib/fetchEvent.ts:169 and :235, wrap with `Promise.race([Promise.all(racePromises), new Promise<null>(r => setTimeout(() => r(null), 4000))])` and keep the `all?.find(...)` optional-chain form web uses.

### lucide-react is a runtime dependency declared in devDependencies
- mobile: **n/a** · desktop: **partial** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/package.json — "lucide-react": "^0.562.0" sits in devDependencies`
- impact: Any production-style install — `npm ci --omit=dev`, a Docker build stage, Netlify/Vercel/GitLab-Pages with NODE_ENV=production — fails the Vite build with 68 unresolved-import errors. The desktop `build` script runs the web build too, so `packages/desktop` inherits the same breakage.
- detail: 68 files under `packages/web/src` import from 'lucide-react' (e.g. packages/web/src/components/SmartNoteContent.tsx:10, ProfileModal.tsx:36, NotificationCard.tsx:32). It is nonetheless listed in `devDependencies`, not `dependencies`. Everything works locally because a plain `npm install` installs devDeps too. Also in devDependencies and genuinely unused: `@tailwindcss/typography` (0 refs in src, and `tailwind.config.ts` `plugins: [tailwindcssAnimate]` does not load it).
- plan: Move `"lucide-react": "^0.562.0"` from devDependencies to dependencies in `packages/web/package.json`. Drop `@tailwindcss/typography` (or add it to `tailwind.config.ts` plugins if the prose classes were intended for long-form NIP-23 rendering). Then add a CI job that runs `npm ci --omit=dev && npm run build -w @corkboards/web` so misclassification is caught mechanically.

### nostr-tools and @tanstack/react-query declared with divergent floors
- mobile: **present** · desktop: **partial** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/package.json (nostr-tools ^2.13.0, @tanstack/react-query ^5.56.2) vs /home/q4/corkboards/packages/mobile/package.json (^2.23.3, ^5.96.1)`
- impact: None today. The risk is a future silent divergence in NIP-19/nip44/nip04 helpers or in react-query's cache-invalidation semantics, appearing as a platform-specific bug with no corresponding code change to blame.
- detail: I checked the installed tree before calling this a hazard, and today it is NOT one: both packages resolve to a single hoisted copy — nostr-tools 2.23.3 and @tanstack/react-query 5.96.1 at root, with no nested copy under packages/mobile (`ls packages/mobile/node_modules/@tanstack/` is empty). So the running behaviour is identical on all platforms right now. The gap is purely declarative: web's floors are 10 minor versions (nostr-tools) and 40 minor versions (react-query) below mobile's. A lockfile regeneration or a fresh `npm install` in a different order can legally give web nostr-tools 2.13.x while mobile gets 2.23.x, and nothing would flag it.
- plan: Raise web's floors to match mobile's actual resolution — `"nostr-tools": "^2.23.3"` and `"@tanstack/react-query": "^5.96.1"` in packages/web/package.json — then `npm install` and confirm package-lock.json shows no new nested copies. Going further, adopt the pattern already used for @nostrify: exact pins for the protocol-critical libraries (nostr-tools, @nostrify/nostrify, @welshman/*) in every package, carets only for leaf UI deps.

### nsec login fallback when secure key storage fails
- mobile: **n/a** · desktop: **missing** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/src/hooks/useCurrentUser.ts:31-58; /home/q4/corkboards/packages/web/src/hooks/useLoginActions.ts:78-100`
- impact: If the OS keychain is unavailable (headless Linux with no Secret Service / gnome-keyring, locked KWallet, sandboxed Flatpak without the secrets portal), desktop login appears to succeed but every publish, reaction, zap and backup save fails with 'no key in keychain for this pubkey'. The documented availability fallback is dead code.
- detail: useLoginActions.ts:79-84 deliberately keeps the nsec inside `login.data` when `keychainStore` returns false ('so a keychain failure doesn't lock the user out ... fall back to the in-login key'). But useCurrentUser.ts:37-43 returns `createTauriNsecSigner(login.pubkey)` UNCONDITIONALLY whenever `isTauri && login.type === 'nsec'` — it never inspects `login.data.nsec`. createTauriNsecSigner → tauriSignEvent → signer.rs `keys_for()` (packages/desktop/src-tauri/src/signer.rs:19-23) errors with 'no key in keychain for this pubkey'. The web branch immediately below (useCurrentUser.ts:49-57) DOES implement the fallback (`if (!nsecData?.nsec) … else NUser.fromNsecLogin(login)`).
- plan: In /home/q4/corkboards/packages/web/src/hooks/useCurrentUser.ts:37 mirror the web branch: `const nsecData = (login.data ?? null) as { nsec?: string } | null; if (isTauri) { if (!nsecData?.nsec) return { method:'nsec', pubkey: login.pubkey, signer: createTauriNsecSigner(login.pubkey) } as unknown as NUser; return NUser.fromNsecLogin(login); }`. Also surface the keychain failure to the user — useLoginActions.ts:81 only does console.error; add a destructive toast so the user knows their key is being held less securely.

### rss-proxy.php — two divergent copies, the STALE one is what ships
- mobile: **n/a** · desktop: **n/a** · effort: trivial
- web impl: `/home/q4/corkboards/packages/web/rss-proxy.php (574 lines, hardened) vs /home/q4/corkboards/packages/web/public/rss-proxy.php (507 lines, stale)`
- impact: corkboards.me is serving an RSS proxy without the v0.8.2 SSRF fixes: `::127.0.0.1` / `2002:7f00:1::` encodings reach internal hosts, an SVG can be inlined as a favicon data: URI (script-carrying markup), the ACAO response is cacheable across origins, and `?max=-1` returns an empty feed instead of an error.
- detail: Two copies of the same server file exist. `packages/web/rss-proxy.php` (23697 bytes, mtime Jul 24 14:47) contains the v0.8.2 SSRF hardening; `packages/web/public/rss-proxy.php` (20090 bytes, mtime Jul 23 11:38) does not. Diffing them shows the public/ copy is missing: `Vary: Origin` + `Cache-Control: no-store`, the `max(1, min(...))` clamp on `?max=` (negative max silently returns `items: []`), the IPv4-compatible `::a.b.c.d` block, the 6to4 `2002::/16` block, `100::/64` discard and `2001:db8::/32` documentation blocks, the `looksLikeImage()` favicon magic-byte sniff (SVG rejection), the IPv6-literal bracket rebuild for the icon authority, the no-redirect icon fetch, and the 400/500/502 `http_response_code()` calls. Vite copies `public/*` into `dist/`, so the build output gets the STALE proxy. Verified: `dist_deploy/rss-proxy.php` is 20090 bytes — byte-identical to the stale public/ copy, NOT to the hardened source. Production is currently running the un-hardened proxy.
- plan: Delete `packages/web/public/rss-proxy.php` outright — it is a duplicate that silently wins. Then add a postbuild step in `packages/web/package.json` `build`: `cp rss-proxy.php .htaccess dist/`. That makes the single hardened source the only copy and removes the manual copy step from the CLAUDE.md `stage`/`deploy` shorthand. Also add a vitest assertion that `packages/web/public/` contains no `.php` file, so the duplicate cannot be reintroduced.

### useAuthor background-refresh abort check
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/hooks/useAuthor.ts:128-135 (`if (signal.aborted) return;` before setQueryData)`
- impact: Cross-account profile leakage on mobile account switch — the departing account's profile data can render under the arriving account.
- detail: Web explicitly bails before writing a background-refresh result: "don't write a now-stale entry into a cache that may belong to a different session." packages/mobile/src/hooks/useAuthor.ts:113-119 has the identical block WITHOUT the aborted check, so a refresh started under account A can land in the ['author', pk] cache after bumpSessionEpoch() has switched to account B.
- plan: Insert `if (signal.aborted) return;` at packages/mobile/src/hooks/useAuthor.ts:114, immediately inside the `.then((result) => {` callback, matching web line 132.

### useAuthor fallback-relay load spreading (avoid relays busy with backup)
- mobile: **missing** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/hooks/useAuthor.ts:58-62 (getBackupRelaysUsed() → sort FALLBACK_RELAYS, take 2)`
- impact: On mobile, profile fetches contend with backup traffic on the same two relays right after login — the window where profiles most often stick as `user_xxxx`.
- detail: Web deprioritises fallback relays recently used by the backup system. packages/mobile/src/hooks/useAuthor.ts:69 uses `FALLBACK_RELAYS.slice(0, 2)` unconditionally, and mobile's useNostrBackup exports no `getBackupRelaysUsed` (compare web useNostrBackup.ts:487).
- plan: Add a module-level `_backupRelaysUsed: Set<string>` + `export function getBackupRelaysUsed()` to packages/mobile/src/hooks/useNostrBackup.ts (populate it in getPublishRelays/checkForBackup), then apply web's sort at packages/mobile/src/hooks/useAuthor.ts:69.

### useFeedLimit fetchMoreCount formula
- mobile: **partial** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/hooks/useFeedLimit.ts (`fetchMoreCount = Math.round(FEED_LOAD_MORE_COUNT * multiplier)`, FEED_LOAD_MORE_COUNT = 60)`
- impact: "Load more" fetches 13 notes on mobile vs 60 on web at the same multiplier setting — the user has to tap ~5× as often for the same amount of feed.
- detail: packages/mobile/src/hooks/useFeedLimit.ts computes `Math.round(Math.ceil(baseLimit / 2) * multiplier)` = ceil(25/2)=13 at 1x, ignoring FEED_LOAD_MORE_COUNT entirely even though it is exported from @core/feedConstants. Mobile also drops the `isMobile`/`baseLimit` fields web returns.
- plan: Import FEED_LOAD_MORE_COUNT from @core/feedConstants and use `Math.round(FEED_LOAD_MORE_COUNT * multiplier)`. If a smaller mobile page is intentional, add a `FEED_LOAD_MORE_COUNT_MOBILE` constant to core so the number is declared in one place rather than derived from an unrelated one.

### useLocalStorage re-read after storage bootstrap
- mobile: **missing** · desktop: **present** · effort: trivial
- web impl: `packages/web/src/hooks/useLocalStorage.ts:41-63 (`idbReady.then` → re-read, with async idbGet fallback for memCache misses)`
- impact: Latent: a future hook or a module-level MMKV read that runs before the splash clears silently sees empty storage and can then persist a default over real data.
- detail: Web deliberately re-reads each key once idbReady resolves, because the sync memCache is empty before that. Mobile's useLocalStorage has no equivalent `mobileStorage.ready.then(...)` effect. MmkvStorage.ts:181-198 opens a *temporary legacy unencrypted* instance synchronously and only swaps in the encrypted instance when prepareSecureStorage() resolves, so any read before that returns the wrong store. App.tsx does gate the render tree on prepareSecureStorage, which covers hooks — but module-eval-time readers are not covered (see packages/mobile/src/lib/notesCache.ts:100, which calls loadNotesFromStorage() at import time against the legacy instance).
- plan: Add the mirror effect to packages/mobile/src/hooks/useLocalStorage.ts: `useEffect(() => { let c=false; mobileStorage.ready.then(() => { if(c) return; const raw = mobileStorage.getSync(key); ... setState }); return () => {c=true}; }, [key])`. Also make notesCache.ts await `mobileStorage.ready` before loadNotesFromStorage().
