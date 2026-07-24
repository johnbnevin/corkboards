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
 * other is exactly the kind of drift that reopens a hole.
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
  if (a === 192 && b === 0) return true;                          // IETF protocol assignments 192.0.0/24 (+ TEST-NET-1 192.0.2/24)
  if (a === 192 && b === 168) return true;                        // RFC1918 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true;           // benchmarking 198.18/15
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

  // v4-embedding forms: ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), and the
  // NAT64 well-known prefix 64:ff9b::/96. Re-check the embedded IPv4 so
  // ::ffff:169.254.169.254 is blocked exactly like 169.254.169.254 is.
  if (bare.includes('.')) {
    const embedded = bare.slice(bare.lastIndexOf(':') + 1);
    const asInt = ipv4ToInt(embedded);
    if (asInt === null) return true; // malformed → fail closed
    const prefix = bare.slice(0, bare.lastIndexOf(':') + 1);
    if (prefix === '::' || prefix === '::ffff:' || prefix.startsWith('64:ff9b:')) {
      return isPrivateIPv4(asInt);
    }
    return true; // some other v4-in-v6 shape we don't model → fail closed
  }

  const first = firstHextet(bare);
  if (first === null) return true;                    // unparseable → fail closed
  if (first >= 0xfe80 && first <= 0xfebf) return true; // link-local fe80::/10
  if (first >= 0xfc00 && first <= 0xfdff) return true; // unique-local fc00::/7
  if (first >= 0xff00) return true;                    // multicast ff00::/8

  // Unspecified (::) and loopback (::1) — every hextet zero except a trailing 1.
  if (isAllZeroExceptLast(bare)) return true;
  return false;
}

/** Value of the leading hextet of an IPv6 literal, or null if unparseable. */
function firstHextet(ip: string): number | null {
  if (ip.startsWith('::')) return 0;
  const head = ip.split(':', 1)[0];
  if (!/^[0-9a-f]{1,4}$/.test(head)) return null;
  return parseInt(head, 16);
}

/** True for `::` and `::1` in any zero-compressed or fully-expanded spelling. */
function isAllZeroExceptLast(ip: string): boolean {
  if (!/^[0-9a-f:]+$/.test(ip)) return false;
  const parts = ip.split('::');
  if (parts.length > 2) return false;
  const groups = [...parts[0].split(':'), ...(parts[1] ?? '').split(':')].filter(Boolean);
  if (groups.length === 0) return true; // "::" itself
  for (let i = 0; i < groups.length - 1; i++) {
    if (parseInt(groups[i], 16) !== 0) return false;
  }
  const last = parseInt(groups[groups.length - 1], 16);
  return last === 0 || last === 1;
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
  const host = hostname.toLowerCase();
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
