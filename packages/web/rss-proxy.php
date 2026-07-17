<?php
/**
 * RSS/Atom feed proxy for Corkboards.
 *
 * Exists because RSS feeds don't set CORS headers, so browsers block
 * direct fetch from the web app. This proxy fetches on behalf of the client.
 *
 * Security hardening:
 * - HTTPS-only URLs (no file://, ftp://, gopher://, etc.)
 * - Blocks private/internal IPs (RFC 1918, link-local, loopback, cloud metadata)
 * - Rate limiting per IP (60 requests/minute)
 * - Origin/Referer check (only corkboards.me or localhost)
 * - XXE protection (external entities disabled)
 * - SSL verification enabled
 * - Response size cap (2MB)
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

$originAllowed = false;
foreach ($allowedOrigins as $allowed) {
    if ($origin === $allowed || str_starts_with($referer, $allowed)) {
        $originAllowed = true;
        break;
    }
}

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
 * Validate a URL against the SSRF policy: must be a well-formed https URL whose
 * host resolves ONLY to public IP addresses. Returns an error string on failure,
 * or null when the URL is safe to fetch. Applied to the initial URL AND re-run on
 * every redirect hop so a feed can't 302 to a private/metadata address (or use
 * DNS rebinding between hops).
 */
function ssrfValidateUrl(string $url): ?string {
    $parsed = parse_url($url);
    if ($parsed === false) {
        return 'Invalid URL';
    }

    $scheme = strtolower($parsed['scheme'] ?? '');
    if ($scheme !== 'https') {
        return 'Only HTTPS URLs are allowed';
    }

    $host = $parsed['host'] ?? '';
    if (!$host) {
        return 'Invalid URL';
    }

    if (!filter_var($url, FILTER_VALIDATE_URL)) {
        return 'Invalid URL format';
    }

    $resolvedIps = gethostbynamel($host);
    if (!$resolvedIps) {
        return 'Could not resolve hostname';
    }

    foreach ($resolvedIps as $ip) {
        // Block private ranges (RFC 1918), loopback, link-local, cloud metadata
        if (
            filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false ||
            str_starts_with($ip, '169.254.') ||    // link-local (incl. cloud metadata 169.254.169.254)
            str_starts_with($ip, '100.64.') ||     // CGNAT
            $ip === '0.0.0.0' ||
            $ip === '127.0.0.1' ||
            $ip === '::1' ||                       // IPv6 loopback
            str_starts_with($ip, '::ffff:127.') || // IPv4-mapped IPv6 loopback
            str_starts_with($ip, '::ffff:10.') ||  // IPv4-mapped private
            str_starts_with($ip, '::ffff:192.168.') || // IPv4-mapped private
            str_starts_with($ip, 'fe80:') ||       // IPv6 link-local
            str_starts_with($ip, 'fc00:') ||       // IPv6 unique local
            str_starts_with($ip, 'fd')             // IPv6 unique local
        ) {
            return 'URL resolves to a restricted address';
        }
    }

    return null;
}

if (($err = ssrfValidateUrl($url)) !== null) {
    echo json_encode(['error' => $err]);
    exit;
}

// ─── Fetch the feed (SSL verified, size-limited, per-hop SSRF-checked) ───────
//
// max_redirects => 0: do NOT let PHP auto-follow redirects. Instead we follow
// them manually (max 3 hops) so each hop's URL is re-validated against the SSRF
// policy above BEFORE it is fetched. Auto-following would let a malicious feed
// 302 to http://169.254.169.254/ or an internal host, bypassing the pre-fetch
// check (also mitigates DNS rebinding across hops).

$makeContext = function () {
    return stream_context_create([
        'http' => [
            'timeout' => 10,
            'max_redirects' => 0,          // manual redirect handling below
            'ignore_errors' => true,       // still read body/headers on 3xx/4xx
            'follow_location' => 0,
            'user_agent' => 'Mozilla/5.0 (compatible; CorkboardRSS/1.0)',
            'header' => "Accept: application/rss+xml, application/atom+xml, application/xml, text/xml\r\n",
        ],
        'ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true,
        ],
    ]);
};

/**
 * Parse the HTTP status code and Location header out of the $http_response_header
 * array that PHP populates after a stream fetch.
 */
function parseHttpResponse(array $headers): array {
    $status = 0;
    $location = null;
    foreach ($headers as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            // Reset on each status line (handles proxied/continued responses)
            $status = (int)$m[1];
            $location = null;
        } elseif (stripos($h, 'Location:') === 0) {
            $location = trim(substr($h, strlen('Location:')));
        }
    }
    return [$status, $location];
}

$fetchUrl = $url;
$maxHops = 3;
$xml = false;

for ($hop = 0; ; $hop++) {
    $body = @file_get_contents($fetchUrl, false, $makeContext(), 0, 2 * 1024 * 1024); // 2MB cap
    $respHeaders = $http_response_header ?? [];
    [$status, $location] = parseHttpResponse($respHeaders);

    // Redirect?
    if ($status >= 300 && $status < 400 && $location !== null && $location !== '') {
        if ($hop >= $maxHops) {
            echo json_encode(['error' => 'Too many redirects']);
            exit;
        }
        // Resolve relative Location against the current URL, then re-validate.
        $next = $location;
        if (!parse_url($next, PHP_URL_SCHEME)) {
            $base = parse_url($fetchUrl);
            if (isset($base['scheme'], $base['host'])) {
                if (str_starts_with($next, '/')) {
                    $next = $base['scheme'] . '://' . $base['host'] . $next;
                } else {
                    $path = $base['path'] ?? '/';
                    $dir = substr($path, 0, strrpos($path, '/') + 1);
                    $next = $base['scheme'] . '://' . $base['host'] . $dir . $next;
                }
            }
        }
        if (($err = ssrfValidateUrl($next)) !== null) {
            echo json_encode(['error' => $err]);
            exit;
        }
        $fetchUrl = $next;
        continue;
    }

    // Non-redirect: require a successful fetch with a body.
    if ($body === false || $body === '' || $status >= 400) {
        echo json_encode(['error' => 'Failed to fetch feed']);
        exit;
    }
    $xml = $body;
    break;
}

// ─── Parse XML (XXE-safe) ───────────────────────────────────────────────────

libxml_use_internal_errors(true);
$doc = new DOMDocument();
// LIBXML_NONET blocks external network fetches (XXE mitigation).
// LIBXML_NOENT is intentionally omitted — it substitutes entities, which is the opposite of safe.
$doc->loadXML($xml, LIBXML_NONET | LIBXML_NOCDATA);

if (libxml_get_errors()) {
    libxml_clear_errors();
    echo json_encode(['error' => 'Invalid XML']);
    exit;
}

$result = ['title' => '', 'icon' => '', 'items' => []];

// Extract feed domain for favicon
$domain = preg_replace('/^www\./', '', $host);
$result['icon'] = "https://www.google.com/s2/favicons?sz=64&domain=" . urlencode($domain);

// Try RSS 2.0
$channels = $doc->getElementsByTagName('channel');
if ($channels->length > 0) {
    $ch = $channels->item(0);
    $titleEl = $ch->getElementsByTagName('title')->item(0);
    $result['title'] = $titleEl ? mb_substr($titleEl->textContent, 0, 200) : $domain;

    $items = $doc->getElementsByTagName('item');
    for ($i = 0; $i < $items->length && $i < $max; $i++) {
        $item = $items->item($i);
        $result['items'][] = [
            'title' => mb_substr(($item->getElementsByTagName('title')->item(0))->textContent ?? '', 0, 300),
            'description' => strip_tags(mb_substr(($item->getElementsByTagName('description')->item(0))->textContent ?? '', 0, 500)),
            'link' => mb_substr(($item->getElementsByTagName('link')->item(0))->textContent ?? '', 0, 2000),
            'pubDate' => mb_substr(($item->getElementsByTagName('pubDate')->item(0))->textContent ?? '', 0, 100),
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
        $link = '';
        $links = $entry->getElementsByTagName('link');
        if ($links->length > 0) {
            $link = $links->item(0)->getAttribute('href');
        }
        $desc = ($entry->getElementsByTagName('summary')->item(0))->textContent
            ?? ($entry->getElementsByTagName('content')->item(0))->textContent
            ?? '';
        $result['items'][] = [
            'title' => mb_substr(($entry->getElementsByTagName('title')->item(0))->textContent ?? '', 0, 300),
            'description' => strip_tags(mb_substr($desc, 0, 500)),
            'link' => mb_substr($link, 0, 2000),
            'pubDate' => mb_substr(
                ($entry->getElementsByTagName('published')->item(0))->textContent
                    ?? ($entry->getElementsByTagName('updated')->item(0))->textContent
                    ?? '',
                0, 100
            ),
        ];
    }
}

echo json_encode($result);
