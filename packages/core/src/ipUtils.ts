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

/** True when the uint32 IPv4 address falls in a private / loopback / reserved range. */
export function isPrivateIPv4(n: number): boolean {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  if (a === 0 || a === 10 || a === 127 || a === 255) return true; // this-host, RFC1918, loopback, broadcast
  if (a === 192 && b === 168) return true;                        // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;               // RFC1918
  if (a === 169 && b === 254) return true;                        // link-local incl. cloud metadata 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT 100.64/10
  return false;
}

/** True when an IPv6 literal (without brackets) is loopback / link-local / unique-local / mapped. */
export function isPrivateIPv6(ipv6: string): boolean {
  const ip = ipv6.toLowerCase();
  if (ip === '::1') return true;                              // loopback
  if (/^(0:){7}1$/.test(ip)) return true;                     // fully-expanded loopback
  if (/^0*(:0*){0,6}:0*1$/.test(ip)) return true;             // other zero-compressed loopback forms
  if (ip.startsWith('fe80')) return true;                     // link-local fe80::/10
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique-local fc00::/7
  if (ip.startsWith('::ffff:')) return true;                  // IPv4-mapped (covers embedded private v4)
  if (ip.startsWith('::') && ip.includes('.')) return true;   // IPv4-compatible
  return false;
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
