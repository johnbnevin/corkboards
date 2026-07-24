/**
 * Normalize a user-entered relay address into a canonical `wss://host[:port]/`
 * URL (lowercased host, trailing slash), the form used as the identity key for
 * relays throughout the app.
 *
 * Naively handing the raw input to `new URL()` is wrong in two ways that both
 * show up with real input:
 *
 *  - `new URL('nos.lol:443')` does NOT throw. `nos.lol` is a syntactically valid
 *    URL scheme, so it parses as scheme `nos.lol:` with path `443` and round-trips
 *    to the string `nos.lol:443` — a relay entry that can never connect. Only a
 *    bare host with no colon (`nos.lol`) fell through to the `wss://` fallback.
 *  - Any absolute URL was passed through verbatim, so `http://…` (and even
 *    `javascript:…`) survived normalization. Nostr relays speak WebSocket only;
 *    anything else is either a typo to correct or input to reject.
 *
 * So: recognize `wss://` as already-canonical, upgrade `ws://` and `http(s)://`
 * to it, and treat everything else — including bare `host` and `host:port` — as
 * an authority to prefix with `wss://`. Input that still can't be parsed is
 * returned trimmed with a trailing slash so the caller's own validation (see
 * `isSecureRelay`) reports it rather than this function inventing a URL.
 *
 * @param url The relay URL or bare host to normalize
 * @returns Normalized `wss://` URL with lowercase host and trailing slash
 */
export function normalizeRelay(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';

  const lower = trimmed.toLowerCase();
  let withScheme: string;
  if (lower.startsWith('wss://')) {
    withScheme = trimmed;
  } else if (lower.startsWith('ws://')) {
    // ws:// and http(s):// are near-certainly a typo for the secure form;
    // upgrading beats silently persisting a plaintext relay that leaks the
    // user's filters (follow graph, hashtags) to anyone on the path.
    withScheme = `wss://${trimmed.slice(5)}`;
  } else if (lower.startsWith('https://')) {
    withScheme = `wss://${trimmed.slice(8)}`;
  } else if (lower.startsWith('http://')) {
    withScheme = `wss://${trimmed.slice(7)}`;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // Some other explicit scheme (file://, ftp://, …). Do NOT rewrite it into a
    // wss:// URL: stripping `file://` from `file:///etc/passwd` would yield the
    // plausible-looking `wss://etc/passwd`, manufacturing a relay entry out of a
    // path. Hand it back unchanged so `isSecureRelay` rejects it.
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  } else {
    // Bare host or host:port. Prefixing wss:// is what makes the parser read the
    // whole string as an authority rather than treating `nos.lol` as a scheme.
    withScheme = `wss://${trimmed}`;
  }

  try {
    return new URL(withScheme).toString();
  } catch {
    // Fallback: preserve the input so the caller's validation can reject it.
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  }
}
