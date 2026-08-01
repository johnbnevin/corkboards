<?php
/**
 * RSS/Atom feed proxy for Corkboards.
 *
 * Exists because RSS feeds don't set CORS headers, so browsers block
 * direct fetch from the web app. This proxy fetches on behalf of the client.
 *
 * Security hardening:
 * - HTTPS-only URLs (no file://, ftp://, gopher://, etc.)
 * - Blocks private/internal IPs, IPv4 AND IPv6 (RFC 1918, link-local, loopback,
 *   unique-local, IPv4-mapped, cloud metadata)
 * - DNS pinning: fetches via cURL with CURLOPT_RESOLVE so the connection uses the
 *   exact IP that passed validation (no DNS-rebinding TOCTOU between check and fetch)
 * - Rate limiting per IP (60 requests/minute)
 * - Origin/Referer check (exact scheme+host+port match against allowlist)
 * - XXE protection (external entities disabled)
 * - SSL verification enabled
 * - Response size cap (2MB feed, 64KB favicon)
 * - Favicon fetched from the feed's own origin and inlined as a data: URI
 *   (no third-party favicon service sees the user's subscriptions)
 */

// ─── Rate limiting (file-based, no dependencies) ────────────────────────────

$rateLimitDir = sys_get_temp_dir() . '/corkboard-rss-ratelimit-' . md5(__FILE__);
if (!is_dir($rateLimitDir)) mkdir($rateLimitDir, 0700, true);

$clientIp = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
$rateLimitFile = $rateLimitDir . '/' . md5($clientIp);
$rateLimitWindow = 60; // seconds
$rateLimitMax = 60;    // requests per window

$now = time();

// Acquire exclusive lock before reading to prevent TOCTOU race
$fp = @fopen($rateLimitFile, 'c+');
if ($fp && flock($fp, LOCK_EX)) {
    $raw = stream_get_contents($fp);
    $requests = $raw ? (json_decode($raw, true) ?: []) : [];
    // Prune old entries
    $requests = array_values(array_filter($requests, fn($t) => $t > $now - $rateLimitWindow));

    if (count($requests) >= $rateLimitMax) {
        flock($fp, LOCK_UN);
        fclose($fp);
        http_response_code(429);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Rate limit exceeded. Try again in a minute.']);
        exit;
    }

    $requests[] = $now;
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($requests));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
} else {
    if ($fp) fclose($fp);
    // If we can't acquire the lock, allow the request through
}

// Periodically clean up old rate-limit files (1% chance per request)
if (mt_rand(1, 100) === 1) {
    foreach (glob($rateLimitDir . '/*') as $f) {
        if (is_file($f) && filemtime($f) < $now - 3600) @unlink($f);
    }
}

// ─── Origin check ───────────────────────────────────────────────────────────

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$referer = $_SERVER['HTTP_REFERER'] ?? '';
$allowedOrigins = [
    'https://corkboards.me',
    'https://www.corkboards.me',
    'https://stage.corkboards.me',
    'http://localhost:3000',
    'http://localhost:5173',
];

/**
 * Exact-origin comparison: parse the candidate URL (an Origin header value or a
 * full Referer URL) and compare scheme + host (+ effective port) exactly against
 * each allowlist entry. A prefix check would let https://corkboards.me.evil.com
 * (or https://corkboards.me.evil.com/x as Referer) through.
 */
function originMatches(string $candidate, array $allowedOrigins): bool {
    $p = parse_url($candidate);
    if ($p === false || empty($p['scheme']) || empty($p['host'])) return false;
    $scheme = strtolower($p['scheme']);
    $host = strtolower($p['host']);
    $port = $p['port'] ?? ($scheme === 'https' ? 443 : 80);
    foreach ($allowedOrigins as $allowed) {
        $a = parse_url($allowed);
        if ($a === false || empty($a['scheme']) || empty($a['host'])) continue;
        $aScheme = strtolower($a['scheme']);
        if ($scheme === $aScheme
            && $host === strtolower($a['host'])
            && $port === ($a['port'] ?? ($aScheme === 'https' ? 443 : 80))) {
            return true;
        }
    }
    return false;
}

$originAllowed = ($origin !== '' && originMatches($origin, $allowedOrigins))
    || ($referer !== '' && originMatches($referer, $allowedOrigins));

// Allow direct browser requests (no origin header) for testing,
// but block cross-origin JS from other sites
if ($origin && !$originAllowed) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Forbidden']);
    exit;
}

// Set CORS header to requesting origin (not wildcard)
$corsOrigin = $originAllowed && $origin ? $origin : 'https://corkboards.me';
header("Access-Control-Allow-Origin: $corsOrigin");
// The ACAO value varies with the request's Origin, so any shared cache in front
// of this must key on it — otherwise one origin's response gets replayed to
// another. Responses are also per-URL and not worth caching.
header('Vary: Origin');
header('Cache-Control: no-store');
header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');

// Handle preflight (POST is used by oembed mode — the lookup travels in the
// request body so it never appears in web-server access logs)
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header('Access-Control-Allow-Methods: GET, POST');
    header('Access-Control-Max-Age: 86400');
    exit;
}

// ─── oEmbed mode (?oembed=1) ────────────────────────────────────────────────
//
// Fetches a YouTube video title via the official oEmbed endpoint, so clients
// can show titles without the user's IP ever reaching Google. Deliberately
// narrow — this is NOT a general fetch proxy (see the content-laundering note
// on the favicon fetch below): the only origin ever contacted is
// www.youtube.com/oembed, and the URL is REBUILT server-side from the inner
// video URL, discarding everything else the client sent.
//
// The rate limiter and Origin allowlist above have already run.
if (($_GET['oembed'] ?? '') === '1') {
    // PREFER the POST body (raw text: the oEmbed URL). Query strings land in
    // the web server's access logs — which the hosting provider keeps for
    // ~7 days and we do not control — while request bodies never do. The GET
    // form still works for generic {url}-template proxies and curl testing,
    // with that caveat.
    $oembedUrl = '';
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $oembedUrl = trim((string)file_get_contents('php://input', false, null, 0, 4096));
    }
    if ($oembedUrl === '') {
        $oembedUrl = $_GET['url'] ?? '';
    }
    $p = parse_url($oembedUrl);
    $oHost = strtolower($p['host'] ?? '');
    if (strtolower($p['scheme'] ?? '') !== 'https'
        || !in_array($oHost, ['www.youtube.com', 'youtube.com'], true)
        || ($p['path'] ?? '') !== '/oembed') {
        http_response_code(400);
        echo json_encode(['error' => 'oembed mode only accepts https://www.youtube.com/oembed URLs']);
        exit;
    }
    parse_str($p['query'] ?? '', $q);
    $videoUrl = $q['url'] ?? '';
    $v = parse_url($videoUrl);
    $vHost = strtolower($v['host'] ?? '');
    $vScheme = strtolower($v['scheme'] ?? '');
    $isYt = ($vScheme === 'https' || $vScheme === 'http') && (
        $vHost === 'youtu.be'
        || $vHost === 'youtube.com' || str_ends_with($vHost, '.youtube.com')
        || $vHost === 'youtube-nocookie.com' || str_ends_with($vHost, '.youtube-nocookie.com')
    );
    if (!$isYt) {
        http_response_code(400);
        echo json_encode(['error' => 'Not a YouTube video URL']);
        exit;
    }

    [$oErr, $oBody] = fetchValidated(
        'https://www.youtube.com/oembed?url=' . rawurlencode($videoUrl) . '&format=json',
        64 * 1024,           // titles are tiny; 64KB is generous
        'application/json',
        5,                   // 5s — a title is not worth a long stall
        1                    // at most one redirect hop
    );
    if ($oErr !== null) {
        http_response_code(502);
        echo json_encode(['error' => 'Failed to fetch title']);
        exit;
    }
    $j = json_decode($oBody, true);
    if (!is_array($j) || !isset($j['title']) || !is_string($j['title'])) {
        http_response_code(502);
        echo json_encode(['error' => 'Failed to fetch title']);
        exit;
    }
    // Titles are static — cacheable, unlike the per-user RSS responses.
    // Vary: Origin is already set above, so the varying ACAO stays cache-safe.
    header('Cache-Control: public, max-age=86400');
    echo json_encode([
        'title' => mb_substr($j['title'], 0, 300),
        'author_name' => mb_substr(is_string($j['author_name'] ?? null) ? $j['author_name'] : '', 0, 200),
    ]);
    exit;
}

// ─── Input validation ───────────────────────────────────────────────────────

$url = $_GET['url'] ?? '';
// Clamp BOTH ends: `?max=-5` previously made every `$i < $max` loop below false
// on the first iteration, so the proxy returned `items: []` and the client
// turned that into a silent "feed has no items" instead of an error.
$max = max(1, min((int)($_GET['max'] ?? 20), 50));

if (!$url) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing url parameter']);
    exit;
}

// HTTPS only — blocks file://, ftp://, gopher://, data://, etc.
$parsed = parse_url($url);
$scheme = strtolower($parsed['scheme'] ?? '');
if ($scheme !== 'https') {
    http_response_code(400);
    echo json_encode(['error' => 'Only HTTPS URLs are allowed']);
    exit;
}

$host = $parsed['host'] ?? '';
if (!$host) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid URL']);
    exit;
}

// ─── SSRF protection: block private/internal IPs ────────────────────────────

/**
 * True when an IP (v4 or v6, dotted/colon text form) is private, reserved,
 * loopback, link-local, multicast, or otherwise not a public unicast address.
 * IPv4-mapped/NAT64 IPv6 addresses are unwrapped and their embedded IPv4
 * re-checked, so ::ffff:169.254.169.254 is blocked like 169.254.169.254.
 */
function isBlockedIp(string $ip): bool {
    $bin = @inet_pton($ip);
    if ($bin === false) return true; // not a parseable IP → refuse

    // Belt-and-braces: PHP's own private/reserved range filters (kept from the
    // pre-cURL implementation; covers v4 RFC1918/reserved and v6 fc00::/7 etc.)
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
        return true;
    }

    if (strlen($bin) === 4) {
        // IPv4 — explicit CIDR checks
        $long = unpack('N', $bin)[1];
        $blocked4 = [
            ['0.0.0.0', 8],       // "this network" (incl. 0.0.0.0)
            ['10.0.0.0', 8],      // RFC 1918
            ['100.64.0.0', 10],   // CGNAT
            ['127.0.0.0', 8],     // loopback
            ['169.254.0.0', 16],  // link-local (incl. cloud metadata 169.254.169.254)
            ['172.16.0.0', 12],   // RFC 1918
            ['192.0.0.0', 24],    // IETF protocol assignments
            ['192.0.2.0', 24],    // TEST-NET-1
            ['192.88.99.0', 24],  // 6to4 relay anycast (deprecated)
            ['192.168.0.0', 16],  // RFC 1918
            ['198.18.0.0', 15],   // benchmarking
            ['198.51.100.0', 24], // TEST-NET-2
            ['203.0.113.0', 24],  // TEST-NET-3
            ['224.0.0.0', 4],     // multicast
            ['240.0.0.0', 4],     // reserved + broadcast
        ];
        foreach ($blocked4 as [$net, $bits]) {
            $netLong = unpack('N', inet_pton($net))[1];
            $mask = (~0 << (32 - $bits)) & 0xFFFFFFFF;
            if (($long & $mask) === ($netLong & $mask)) return true;
        }
        return false;
    }

    // IPv6 (16 bytes)
    $b = array_values(unpack('C16', $bin));

    // :: (unspecified) and ::1 (loopback)
    $zeroTo15 = true;
    for ($i = 0; $i < 15; $i++) { if ($b[$i] !== 0) { $zeroTo15 = false; break; } }
    if ($zeroTo15 && ($b[15] === 0 || $b[15] === 1)) return true;

    // IPv4-mapped ::ffff:a.b.c.d — re-check the embedded IPv4
    $zeroTo9 = true;
    for ($i = 0; $i < 10; $i++) { if ($b[$i] !== 0) { $zeroTo9 = false; break; } }
    if ($zeroTo9 && $b[10] === 0xff && $b[11] === 0xff) {
        return isBlockedIp(implode('.', array_slice($b, 12, 4)));
    }

    // SIIT IPv4-translated ::ffff:0:a.b.c.d (RFC 6052) — bytes 8-9 hold 0xffff
    // and 10-11 are zero, so the IPv4-mapped branch above (which wants 0xffff in
    // bytes 10-11) does NOT catch it, and neither does the all-zero-prefix branch
    // below. Re-check the embedded IPv4 rather than letting it through.
    $zeroTo7 = true;
    for ($i = 0; $i < 8; $i++) { if ($b[$i] !== 0) { $zeroTo7 = false; break; } }
    if ($zeroTo7 && $b[8] === 0xff && $b[9] === 0xff && $b[10] === 0 && $b[11] === 0) {
        return isBlockedIp(implode('.', array_slice($b, 12, 4)));
    }

    // IPv4-compatible ::a.b.c.d (deprecated, still routable by some stacks).
    // Previously this was caught only incidentally by the filter_var() check
    // above, which matches on the address STRING rather than the parsed bytes —
    // too indirect to rely on. Mirrors the same branch in isPrivateIPv6()
    // (packages/core/src/ipUtils.ts).
    $zeroTo11 = true;
    for ($i = 0; $i < 12; $i++) { if ($b[$i] !== 0) { $zeroTo11 = false; break; } }
    if ($zeroTo11) {
        return isBlockedIp(implode('.', array_slice($b, 12, 4)));
    }

    // NAT64 well-known prefix 64:ff9b::/96 — re-check the embedded IPv4
    if ($b[0] === 0x00 && $b[1] === 0x64 && $b[2] === 0xff && $b[3] === 0x9b) {
        $mid = true;
        for ($i = 4; $i < 12; $i++) { if ($b[$i] !== 0) { $mid = false; break; } }
        if ($mid) return isBlockedIp(implode('.', array_slice($b, 12, 4)));
    }

    // 6to4 2002::/16 embeds the v4 address in bytes 2-5.
    if ($b[0] === 0x20 && $b[1] === 0x02) {
        return isBlockedIp(implode('.', array_slice($b, 2, 4)));
    }

    if ($b[0] === 0xfe && ($b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if (($b[0] & 0xfe) === 0xfc) return true;                   // fc00::/7 unique local
    if ($b[0] === 0xff) return true;                            // ff00::/8 multicast
    // 100::/64 discard-only
    $discard = ($b[0] === 0x01 && $b[1] === 0x00);
    if ($discard) { for ($i = 2; $i < 8; $i++) { if ($b[$i] !== 0) { $discard = false; break; } } }
    if ($discard) return true;
    // 2001:db8::/32 documentation
    if ($b[0] === 0x20 && $b[1] === 0x01 && $b[2] === 0x0d && $b[3] === 0xb8) return true;

    return false;
}

/**
 * Validate a URL against the SSRF policy: must be a well-formed https URL whose
 * host resolves ONLY to public IP addresses — both A (IPv4) and AAAA (IPv6)
 * records are resolved and every address checked. Returns [errorString, ips]:
 * on success $error is null and $ips holds the validated addresses, which the
 * caller MUST pin the actual connection to (CURLOPT_RESOLVE) — re-resolving at
 * fetch time would reopen the DNS-rebinding TOCTOU window. Applied to the
 * initial URL AND re-run on every redirect hop so a feed can't 302 to a
 * private/metadata address.
 */
function ssrfValidateUrl(string $url): array {
    $parsed = parse_url($url);
    if ($parsed === false) {
        return ['Invalid URL', []];
    }

    $scheme = strtolower($parsed['scheme'] ?? '');
    if ($scheme !== 'https') {
        return ['Only HTTPS URLs are allowed', []];
    }

    $host = $parsed['host'] ?? '';
    if (!$host) {
        return ['Invalid URL', []];
    }

    if (!filter_var($url, FILTER_VALIDATE_URL)) {
        return ['Invalid URL format', []];
    }

    // parse_url keeps brackets on IPv6 literals ("[2001:db8::1]")
    $bareHost = trim($host, '[]');

    // Literal IP in the URL — no DNS involved, validate directly
    if (filter_var($bareHost, FILTER_VALIDATE_IP)) {
        if (isBlockedIp($bareHost)) {
            return ['URL resolves to a restricted address', []];
        }
        return [null, [$bareHost]];
    }

    $ips = [];
    $v4 = @gethostbynamel($bareHost);
    if (is_array($v4)) {
        $ips = array_merge($ips, $v4);
    }
    $aaaa = @dns_get_record($bareHost, DNS_AAAA);
    if (is_array($aaaa)) {
        foreach ($aaaa as $rec) {
            if (!empty($rec['ipv6'])) $ips[] = $rec['ipv6'];
        }
    }
    $ips = array_values(array_unique($ips));

    if (!$ips) {
        return ['Could not resolve hostname', []];
    }

    foreach ($ips as $ip) {
        if (isBlockedIp($ip)) {
            return ['URL resolves to a restricted address', []];
        }
    }

    return [null, $ips];
}

// ─── Fetch (cURL, DNS-pinned, SSL verified, size-limited, per-hop checked) ───
//
// Redirects are NOT auto-followed. We follow them manually (max 3 hops) so each
// hop's URL is re-validated against the SSRF policy above BEFORE it is fetched,
// and each hop's connection is pinned (CURLOPT_RESOLVE) to the exact IPs that
// passed validation. Auto-following would let a malicious feed 302 to
// http://169.254.169.254/ or an internal host; re-resolving DNS at fetch time
// (as file_get_contents did) would allow rebinding between check and connect.

// DNS pinning requires the cURL extension — fail clean JSON rather than a fatal.
if (!function_exists('curl_init')) {
    http_response_code(500);
    echo json_encode(['error' => 'Server misconfiguration: PHP cURL extension is required']);
    exit;
}

/**
 * Fetch a single URL over HTTPS with cURL, pinning the connection to the
 * pre-validated IPs. Never follows redirects. Returns
 * [status, redirectUrl, body, contentType]; $body is null on transport failure
 * and truncated at $maxBytes otherwise (matching the old file_get_contents
 * maxlen behavior of keeping the first N bytes).
 */
function curlFetchPinned(string $url, array $pinnedIps, int $maxBytes, string $accept, int $timeout = 10): array {
    $parsed = parse_url($url);
    $host = trim($parsed['host'] ?? '', '[]');
    $port = (int)($parsed['port'] ?? 443);

    $body = '';
    $truncated = false;

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        // Pin DNS: connect only to the addresses that passed ssrfValidateUrl().
        CURLOPT_RESOLVE        => [$host . ':' . $port . ':' . implode(',', $pinnedIps)],
        CURLOPT_FOLLOWLOCATION => false,   // manual redirect handling by caller
        CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS,
        CURLOPT_CONNECTTIMEOUT => $timeout,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (compatible; CorkboardRSS/1.0)',
        CURLOPT_HTTPHEADER     => ['Accept: ' . $accept],
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_WRITEFUNCTION  => function ($ch, $data) use (&$body, &$truncated, $maxBytes) {
            $room = $maxBytes - strlen($body);
            if ($room > 0) $body .= substr($data, 0, $room);
            if (strlen($data) >= $room) {
                $truncated = true;
                return -1; // abort transfer; we keep the truncated body
            }
            return strlen($data);
        },
    ]);

    $ok = curl_exec($ch);
    $errno = curl_errno($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $redirect = curl_getinfo($ch, CURLINFO_REDIRECT_URL) ?: null; // absolute, pre-resolved
    $ctype = (string)(curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: '');
    curl_close($ch);

    // Aborting from the write callback surfaces as CURLE_WRITE_ERROR (23);
    // when we did it for the size cap, treat the truncated body as a success.
    if ($ok === false && !($truncated && $errno === CURLE_WRITE_ERROR)) {
        return [0, null, null, ''];
    }
    return [$status, $redirect, $body, $ctype];
}

/**
 * Fetch a URL following up to $maxHops redirects; EVERY hop (including the
 * first) is SSRF-validated and DNS-pinned before it is contacted.
 * Returns [errorString|null, body, contentType, finalUrl].
 */
/**
 * Magic-byte sniff for the bitmap formats a favicon can legitimately be.
 * Deliberately excludes SVG: it is markup, can carry script, and there is no
 * reason for a favicon we inline as a data: URI to be one.
 */
function looksLikeImage(string $bytes): bool {
    if (strlen($bytes) < 4) return false;
    if (substr($bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return true;         // PNG
    if (substr($bytes, 0, 3) === "\xff\xd8\xff") return true;              // JPEG
    if (substr($bytes, 0, 6) === 'GIF87a' || substr($bytes, 0, 6) === 'GIF89a') return true; // GIF
    if (substr($bytes, 0, 4) === 'RIFF' && substr($bytes, 8, 4) === 'WEBP') return true;     // WebP
    if (substr($bytes, 0, 2) === 'BM') return true;                        // BMP
    if (substr($bytes, 0, 4) === "\x00\x00\x01\x00") return true;          // ICO
    if (substr($bytes, 0, 4) === "\x00\x00\x02\x00") return true;          // CUR
    return false;
}

function fetchValidated(string $url, int $maxBytes, string $accept, int $timeout = 10, int $maxHops = 3): array {
    $fetchUrl = $url;
    for ($hop = 0; ; $hop++) {
        [$err, $ips] = ssrfValidateUrl($fetchUrl);
        if ($err !== null) {
            return [$err, null, '', $fetchUrl];
        }

        [$status, $redirect, $body, $ctype] = curlFetchPinned($fetchUrl, $ips, $maxBytes, $accept, $timeout);

        if ($status >= 300 && $status < 400 && $redirect !== null && $redirect !== '') {
            if ($hop >= $maxHops) {
                return ['Too many redirects', null, '', $fetchUrl];
            }
            $fetchUrl = $redirect; // re-validated + re-pinned on next iteration
            continue;
        }

        // Non-redirect: require a successful fetch with a body.
        if ($body === null || $body === '' || $status === 0 || $status >= 400) {
            return ['Failed to fetch feed', null, '', $fetchUrl];
        }
        return [null, $body, $ctype, $fetchUrl];
    }
}

[$fetchErr, $xml, , $finalUrl] = fetchValidated(
    $url,
    2 * 1024 * 1024, // 2MB cap (unchanged)
    'application/rss+xml, application/atom+xml, application/xml, text/xml'
);
if ($fetchErr !== null) {
    http_response_code(502);
    echo json_encode(['error' => $fetchErr]);
    exit;
}

// ─── Parse XML (XXE-safe) ───────────────────────────────────────────────────

libxml_use_internal_errors(true);
$doc = new DOMDocument();
// LIBXML_NONET blocks external network fetches (XXE mitigation).
// LIBXML_NOENT is intentionally omitted — it substitutes entities, which is the opposite of safe.
$loaded = $doc->loadXML($xml, LIBXML_NONET | LIBXML_NOCDATA);

// Only reject on real parse errors. Many valid feeds trigger libxml WARNINGS
// (undeclared namespaces etc.); treating those as fatal breaks working feeds.
$xmlFatal = !$loaded;
foreach (libxml_get_errors() as $xmlError) {
    if ($xmlError->level === LIBXML_ERR_ERROR || $xmlError->level === LIBXML_ERR_FATAL) {
        $xmlFatal = true;
        break;
    }
}
libxml_clear_errors();

if ($xmlFatal) {
    http_response_code(502);
    echo json_encode(['error' => 'Invalid XML']);
    exit;
}

$result = ['title' => '', 'icon' => '', 'items' => []];

// Feed domain, used as a title fallback below
$domain = preg_replace('/^www\./', '', $host);

// Favicon: fetch the feed origin's own /favicon.ico through the same
// SSRF-validated, DNS-pinned fetch path and inline it as a data: URI.
// (Previously this pointed clients at Google's favicon service, which leaked
// every subscribed feed's domain to a third party.) No icon on failure.
// An IPv6 literal host must keep its brackets when rebuilt into a URL.
$iconHost = parse_url($finalUrl, PHP_URL_HOST) ?: $host;
$iconAuthority = (strpos($iconHost, ':') !== false && $iconHost[0] !== '[')
    ? '[' . $iconHost . ']'
    : $iconHost;
// maxHops = 0: do NOT follow redirects for the icon. Each hop is still
// SSRF-validated, but "public https" is not the same as "this feed's own
// origin" — a feed could 302 its favicon to any third-party https URL and have
// us fetch it and hand the bytes back base64-encoded, turning the proxy into a
// content-laundering relay that also attributes the request to our server.
[$iconErr, $iconBody, $iconType] = fetchValidated(
    'https://' . $iconAuthority . '/favicon.ico',
    64 * 1024,           // small cap — icons only
    'image/*,*/*;q=0.5',
    5,                   // shorter timeout; icons are best-effort
    0                    // no redirects
);
// Require a real image content-type AND image magic bytes before inlining.
// Without both, any body the origin chooses to return gets embedded in a
// `data:` URI that the client then renders.
if ($iconErr === null && $iconBody !== null && $iconBody !== '') {
    $iconMime = strtolower(trim(explode(';', $iconType)[0]));
    if (preg_match('#^image/[a-z0-9.+-]+$#', $iconMime)
        && $iconMime !== 'image/svg+xml'   // SVG is script-capable markup, not a bitmap
        && looksLikeImage($iconBody)) {
        $result['icon'] = 'data:' . $iconMime . ';base64,' . base64_encode($iconBody);
    }
}

// Try RSS 2.0
$channels = $doc->getElementsByTagName('channel');
if ($channels->length > 0) {
    $ch = $channels->item(0);
    $titleEl = $ch->getElementsByTagName('title')->item(0);
    $result['title'] = $titleEl ? mb_substr($titleEl->textContent, 0, 200) : $domain;

    $items = $doc->getElementsByTagName('item');
    for ($i = 0; $i < $items->length && $i < $max; $i++) {
        $item = $items->item($i);
        if ($item === null) continue;
        // Null-safe (?->) throughout: item(0) is null when a tag is missing, and
        // a bare ->textContent on null would emit a PHP warning that corrupts
        // the JSON response when display_errors is on.
        $result['items'][] = [
            'title' => mb_substr($item->getElementsByTagName('title')->item(0)?->textContent ?? '', 0, 300),
            'description' => strip_tags(mb_substr($item->getElementsByTagName('description')->item(0)?->textContent ?? '', 0, 500)),
            'link' => mb_substr($item->getElementsByTagName('link')->item(0)?->textContent ?? '', 0, 2000),
            'pubDate' => mb_substr($item->getElementsByTagName('pubDate')->item(0)?->textContent ?? '', 0, 100),
        ];
    }
}

// Try Atom if no RSS items
if (empty($result['items'])) {
    $feeds = $doc->getElementsByTagName('feed');
    if ($feeds->length > 0) {
        $feed = $feeds->item(0);
        $titleEl = $feed->getElementsByTagName('title')->item(0);
        $result['title'] = $titleEl ? mb_substr($titleEl->textContent, 0, 200) : $domain;
    }

    $entries = $doc->getElementsByTagName('entry');
    for ($i = 0; $i < $entries->length && $i < $max; $i++) {
        $entry = $entries->item($i);
        if ($entry === null) continue;
        $link = $entry->getElementsByTagName('link')->item(0)?->getAttribute('href') ?? '';
        $desc = $entry->getElementsByTagName('summary')->item(0)?->textContent
            ?? $entry->getElementsByTagName('content')->item(0)?->textContent
            ?? '';
        $result['items'][] = [
            'title' => mb_substr($entry->getElementsByTagName('title')->item(0)?->textContent ?? '', 0, 300),
            'description' => strip_tags(mb_substr($desc, 0, 500)),
            'link' => mb_substr($link, 0, 2000),
            'pubDate' => mb_substr(
                $entry->getElementsByTagName('published')->item(0)?->textContent
                    ?? $entry->getElementsByTagName('updated')->item(0)?->textContent
                    ?? '',
                0, 100
            ),
        ];
    }
}

echo json_encode($result);
