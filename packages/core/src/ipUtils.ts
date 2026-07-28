/**
 * Host-safety checks shared by image-URL and relay-URL validation.
 *
 * Defends against SSRF / private-range probing where an attacker-supplied URL
 * encodes a loopback / link-local / private address in a non-obvious form —
 * a decimal integer (`http://2130706433`), hex (`http://0x7f000001`), octal
 * (`http://0177.0.0.1`), or a short dotted notation (`http://127.1`) — all of
 * which `new URL()` and `fetch()` / `<img>` will still resolve to the real
 * address even though a naive dotted-quad regex misses them.
 *
 * NOTE: this is a *lexical* check only. It cannot catch a hostname whose DNS A
 * record points at a private address (DNS rebinding). Server-side fetchers
 * (e.g. the RSS proxy) must additionally enforce private-range blocking after
 * DNS resolution.
 */

/**
 * Parse an IPv4 address in any inet_aton-accepted encoding to a uint32, or
 * return null when `host` is not an IPv4 literal (i.e. it is a real hostname).
 *
 * Supports 1–4 dot-separated parts, each decimal, hex (`0x`), or octal (`0…`),
 * matching the C `inet_aton` semantics that browsers and the OS resolver use.
 */
export function ipv4ToInt(host: string): number | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;

  const vals: number[] = [];
  for (const p of parts) {
    if (p.length === 0) return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) {
      n = parseInt(p, 16);
    } else if (/^0[0-7]+$/.test(p)) {
      // leading zero ⇒ octal (digits 8/9 are invalid octal and already excluded)
      n = parseInt(p, 8);
    } else if (/^(0|[1-9]\d*)$/.test(p)) {
      n = parseInt(p, 10);
    } else {
      return null; // contains a non-numeric character ⇒ it's a hostname
    }
    if (!Number.isFinite(n) || n < 0) return null;
    vals.push(n);
  }

  // inet_aton: the final part absorbs all remaining low-order bytes.
  const lead = vals.slice(0, -1);
  const last = vals[vals.length - 1];
  for (const v of lead) if (v > 255) return null;
  if (last >= Math.pow(256, 4 - lead.length)) return null;

  let result = last;
  for (let i = 0; i < lead.length; i++) {
    result += lead[i] * Math.pow(256, 3 - i);
  }
  return result >>> 0;
}

/**
 * True when the uint32 IPv4 address is anything other than a public unicast
 * address — private, loopback, link-local, shared/CGNAT, reserved, or multicast.
 *
 * The block list is kept deliberately in step with `isBlockedIp()` in
 * `packages/web/rss-proxy.php`: the PHP proxy and this client-side gate defend
 * the same class of attack (an attacker-supplied URL steering a fetch at an
 * address the user didn't intend), and a range blocked on one side but not the
 * other is exactly the kind of drift that reopens a hole. If you add a range
 * here, add it there in the same change.
 */
export function isPrivateIPv4(n: number): boolean {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  if (a === 0) return true;                                       // 0.0.0.0/8 "this network"
  if (a === 10) return true;                                      // RFC1918 10/8
  if (a === 127) return true;                                     // loopback 127/8
  if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT 100.64/10
  if (a === 169 && b === 254) return true;                        // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;               // RFC1918 172.16/12
  const c = (n >>> 8) & 0xff;
  if (a === 192 && b === 0) return true;                          // IETF protocol assignments 192.0.0/24 (+ TEST-NET-1 192.0.2/24)
  if (a === 192 && b === 88 && c === 99) return true;             // deprecated 6to4 relay anycast 192.88.99/24
  if (a === 192 && b === 168) return true;                        // RFC1918 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true;           // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true;            // TEST-NET-2 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return true;             // TEST-NET-3 203.0.113/24
  if (a >= 224) return true;                                      // multicast 224/4 + reserved/broadcast 240/4 (incl. 255.255.255.255)
  return false;
}

/**
 * True when an IPv6 literal (without brackets) is anything other than a public
 * unicast address: unspecified, loopback, link-local, unique-local, multicast,
 * or a v4-embedding form whose embedded IPv4 must itself be re-checked.
 *
 * Parsing is done on the first hextet rather than by string prefix, because a
 * prefix test misses most of the range it claims to cover: `fe80::/10` spans
 * `fe80`–`febf`, so `startsWith('fe80')` lets `fe90::`/`feb0::` through.
 * Any address we cannot parse is treated as unsafe (fail closed).
 */
export function isPrivateIPv6(ipv6: string): boolean {
  const ip = ipv6.toLowerCase().trim();
  if (ip.length === 0) return true;
  // Strip a zone index ("fe80::1%eth0") before parsing.
  const bare = ip.split('%')[0];

  const h = expandIPv6(bare);
  if (h === null) return true; // unparseable → fail closed

  // Unspecified (::) and loopback (::1).
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 &&
      h[4] === 0 && h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) {
    return true;
  }

  // v4-embedding forms — re-check the embedded IPv4 so ::ffff:169.254.169.254
  // is blocked exactly like 169.254.169.254 is. These are matched on the PARSED
  // hextets, not on the text: `new URL()` re-serialises `[::ffff:127.0.0.1]`
  // to `[::ffff:7f00:1]`, so a check for a literal dot (which is how this
  // function used to detect them) never fires on a URL.hostname value and every
  // v4-mapped loopback/metadata/RFC1918 address sailed straight through.
  const embeddedV4 = ((h[6] << 16) >>> 0) + h[7];

  // IPv4-mapped ::ffff:0:0/96
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isPrivateIPv4(embeddedV4);
  }
  // IPv4-translated ::ffff:0:0:0/96 (SIIT, RFC 2765) — the same embedded v4 as
  // the mapped form above but shifted one hextet left, which is exactly why it
  // slipped through: the h[5] === 0xffff test can't see it.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0xffff && h[5] === 0) {
    return isPrivateIPv4(embeddedV4);
  }
  // IPv4-compatible ::a.b.c.d (deprecated, still routable by some stacks)
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return isPrivateIPv4(embeddedV4);
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return isPrivateIPv4(embeddedV4);
  }
  // 6to4 2002::/16 embeds the v4 address in hextets 1–2.
  if (h[0] === 0x2002) {
    return isPrivateIPv4((((h[1] << 16) >>> 0) + h[2]) >>> 0);
  }

  if (h[0] >= 0xfe80 && h[0] <= 0xfebf) return true; // link-local fe80::/10
  if (h[0] >= 0xfc00 && h[0] <= 0xfdff) return true; // unique-local fc00::/7
  if (h[0] >= 0xff00) return true;                   // multicast ff00::/8
  if (h[0] === 0x0100 && h[1] === 0) return true;    // discard-only 100::/64
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation 2001:db8::/32

  return false;
}

/**
 * Expand an IPv6 literal (no brackets, no zone) to its 8 numeric hextets, or
 * null when it can't be parsed. Handles `::` zero-compression and a trailing
 * dotted-quad (`::ffff:1.2.3.4`), folding the quad into the last two hextets.
 *
 * Working on numbers rather than on the text is the whole point: the same
 * address has many spellings, and only the numeric form makes range checks
 * reliable.
 */
export function expandIPv6(input: string): number[] | null {
  let s = input;
  if (s.length === 0 || s.length > 45) return null;

  // Rewrite a trailing dotted-quad as the two hextets it encodes, in place, so
  // the rest of this function only ever deals with hex groups. Slicing the quad
  // off instead would eat one colon of an adjacent `::` and break compression.
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.')) {
    if (lastColon === -1) return null;
    const quad = s.slice(lastColon + 1);
    // Require a canonical dotted quad here — inet_aton short/hex/octal forms are
    // not valid inside an IPv6 literal, and accepting them would let a
    // non-canonical spelling parse differently here than in the resolver.
    if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(quad)) return null;
    const octets = quad.split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0]);
  if (head === null) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const rest = parseGroups(halves[1]);
  if (rest === null) return null;
  const known = head.length + rest.length;
  // `::` must stand for at least one zero group, so a fully-specified address
  // written with a `::` in it is malformed.
  if (known >= 8) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest];
}

/**
 * True when a URL hostname is unsafe to fetch from a client: localhost, a
 * private/loopback/link-local IP in any encoding, or a non-canonical numeric
 * IPv4 encoding (hex / octal / integer / short form), which legitimate hosts
 * never use and which is a hallmark of SSRF-filter evasion.
 *
 * `hostname` is expected to be a `URL.hostname` value (IPv6 retains brackets).
 */
export function isUnsafeHost(hostname: string): boolean {
  // A fully-qualified name may carry a trailing root dot ("localhost."), which
  // the WHATWG URL parser preserves for domains (it only strips it for IPv4
  // literals). `new URL('http://localhost./').hostname` is therefore
  // `localhost.` — which resolves to loopback but matched none of the checks
  // below before the dot was stripped here. Same for `.localhost.` subdomains.
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host.length === 0) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  if (host.startsWith('[')) {
    return isPrivateIPv6(host.slice(1, -1));
  }

  const ipInt = ipv4ToInt(host);
  if (ipInt !== null) {
    if (isPrivateIPv4(ipInt)) return true;
    // Reject any numeric IPv4 that isn't a canonical 4-octet decimal literal —
    // hex/octal/integer/short forms are evasion vectors, not real image hosts.
    const canonical = /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(host);
    if (!canonical) return true;
  }
  return false;
}
