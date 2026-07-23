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
header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');

// Handle preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header('Access-Control-Allow-Methods: GET');
    header('Access-Control-Max-Age: 86400');
    exit;
}

// ─── Input validation ───────────────────────────────────────────────────────

$url = $_GET['url'] ?? '';
$max = min((int)($_GET['max'] ?? 20), 50);

if (!$url) {
    echo json_encode(['error' => 'Missing url parameter']);
    exit;
}

// HTTPS only — blocks file://, ftp://, gopher://, data://, etc.
$parsed = parse_url($url);
$scheme = strtolower($parsed['scheme'] ?? '');
if ($scheme !== 'https') {
    echo json_encode(['error' => 'Only HTTPS URLs are allowed']);
    exit;
}

$host = $parsed['host'] ?? '';
if (!$host) {
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
            ['192.168.0.0', 16],  // RFC 1918
            ['198.18.0.0', 15],   // benchmarking
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

    // NAT64 well-known prefix 64:ff9b::/96 — re-check the embedded IPv4
    if ($b[0] === 0x00 && $b[1] === 0x64 && $b[2] === 0xff && $b[3] === 0x9b) {
        $mid = true;
        for ($i = 4; $i < 12; $i++) { if ($b[$i] !== 0) { $mid = false; break; } }
        if ($mid) return isBlockedIp(implode('.', array_slice($b, 12, 4)));
    }

    if ($b[0] === 0xfe && ($b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if (($b[0] & 0xfe) === 0xfc) return true;                   // fc00::/7 unique local
    if ($b[0] === 0xff) return true;                            // ff00::/8 multicast

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
$iconHost = parse_url($finalUrl, PHP_URL_HOST) ?: $host;
[$iconErr, $iconBody, $iconType] = fetchValidated(
    'https://' . $iconHost . '/favicon.ico',
    64 * 1024,           // small cap — icons only
    'image/*,*/*;q=0.5',
    5                    // shorter timeout; icons are best-effort
);
if ($iconErr === null && $iconBody !== null && $iconBody !== '') {
    $iconMime = strtolower(trim(explode(';', $iconType)[0]));
    if (!preg_match('#^image/[a-z0-9.+-]+$#', $iconMime)) {
        $iconMime = 'image/x-icon';
    }
    $result['icon'] = 'data:' . $iconMime . ';base64,' . base64_encode($iconBody);
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
