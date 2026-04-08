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

$resolvedIps = gethostbynamel($host);
if (!$resolvedIps) {
    echo json_encode(['error' => 'Could not resolve hostname']);
    exit;
}

foreach ($resolvedIps as $ip) {
    // Block private ranges (RFC 1918), loopback, link-local, cloud metadata
    if (
        filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false ||
        str_starts_with($ip, '169.254.') ||    // link-local
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
        echo json_encode(['error' => 'URL resolves to a restricted address']);
        exit;
    }
}

if (!filter_var($url, FILTER_VALIDATE_URL)) {
    echo json_encode(['error' => 'Invalid URL format']);
    exit;
}

// ─── Fetch the feed (SSL verified, size-limited) ────────────────────────────

$ctx = stream_context_create([
    'http' => [
        'timeout' => 10,
        'max_redirects' => 3,
        'user_agent' => 'Mozilla/5.0 (compatible; CorkboardRSS/1.0)',
        'header' => "Accept: application/rss+xml, application/atom+xml, application/xml, text/xml\r\n",
    ],
    'ssl' => [
        'verify_peer' => true,
        'verify_peer_name' => true,
    ],
]);

$xml = @file_get_contents($url, false, $ctx, 0, 2 * 1024 * 1024); // 2MB cap
if (!$xml) {
    echo json_encode(['error' => 'Failed to fetch feed']);
    exit;
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
