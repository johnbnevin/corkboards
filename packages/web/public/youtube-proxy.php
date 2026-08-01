<?php
// Dedicated entry point for YouTube title lookups (oEmbed). All logic — rate
// limiting, Origin allowlist, SSRF-gated fetch — lives in rss-proxy.php; this
// file just selects its oembed mode so users configuring a title proxy see a
// URL that says what it does. Lookups are accepted in the POST body so the
// video URL never appears in web-server access logs.
$_GET['oembed'] = '1';
require __DIR__ . '/rss-proxy.php';
