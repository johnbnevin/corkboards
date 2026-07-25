use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{timeout_at, Instant};
use tokio_tungstenite::{
    client_async, connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    WebSocketStream,
};

use crate::proxy;

/// Events per emit call — each app.emit() uses webkit_web_view_run_javascript,
/// so the payload per call stays small regardless of IPC protocol state.
const BATCH_SIZE: usize = 20;

/// Hard upper bound on per-query results when JS doesn't supply a `limit`.
/// Without this, a missing limit defaults to u64::MAX, which would let a
/// pathological relay flood memory before EOSE arrives.
const DEFAULT_LIMIT_CAP: usize = 1000;

#[derive(Debug, Serialize, Deserialize)]
pub struct RelayQueryResult {
    pub events: Vec<Value>,
    pub error: Option<String>,
}

/// Stream events from multiple relays to JS via Tauri app events.
///
/// Uses app.emit() rather than Channel<T> because Channel relies on the Tauri
/// IPC fetch mechanism which silently hangs when the custom protocol falls back
/// to postMessage on older WebKitGTK builds.
///
/// app.emit() calls webkit_web_view_run_javascript directly — a completely
/// separate path that always works.  JS registers a listen() handler before
/// calling this command, accumulates batches, and resolves when done=true.
///
/// AppHandle is injected by Tauri; sub_id/urls/filter/timeout_ms come from JS.
#[tauri::command]
pub async fn relay_subscribe(
    app: AppHandle,
    sub_id: String,
    urls: Vec<String>,
    filter: Value,
    timeout_ms: Option<u64>,
) -> Result<(), String> {
    let ms = timeout_ms.unwrap_or(5000);
    let deadline = Instant::now() + Duration::from_millis(ms);
    let limit = filter
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(DEFAULT_LIMIT_CAP)
        .min(DEFAULT_LIMIT_CAP * 5); // hard ceiling even if JS asks for more (caps `seen` growth)

    // Bounded channel — backpressure so a fast relay can't outrun the emit loop
    // and balloon memory before JS drains the queue. Capacity scales with limit
    // but stays modest to keep peak memory predictable.
    let channel_capacity = limit.saturating_mul(2).clamp(64, 2048);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Value>(channel_capacity);

    // Spawn one task per relay — all connect and query concurrently
    let handles: Vec<_> = urls
        .into_iter()
        .map(|url| {
            let f = filter.clone();
            let sender = tx.clone();
            let url_for_log = url.clone();
            tokio::spawn(async move {
                // do_query enforces the deadline internally and returns whatever
                // it received before it — a slow relay's events are kept rather
                // than thrown away with the cancelled future.
                let result = do_query(url, f, deadline).await;
                if let Some(err) = result.error {
                    eprintln!("[relay {url_for_log}] error: {err} (budget {ms}ms)");
                }
                for ev in result.events {
                    // send() awaits when the channel is full — applies backpressure
                    if sender.send(ev).await.is_err() {
                        break; // receiver dropped
                    }
                }
            })
        })
        .collect();
    drop(tx); // channel closes when all spawned senders finish

    // Deduplicate and stream to JS in small batches via app.emit()
    let event_name = format!("relay-{}", sub_id);
    let mut seen = std::collections::HashSet::new();
    let mut batch: Vec<Value> = Vec::new();
    let mut total = 0usize;

    while let Some(event) = rx.recv().await {
        if total >= limit {
            continue; // drain but discard once limit reached
        }
        if let Some(id) = event.get("id").and_then(|v| v.as_str()) {
            if seen.insert(id.to_string()) {
                total += 1;
                batch.push(event);
                if batch.len() >= BATCH_SIZE {
                    let _ = app.emit(
                        &event_name,
                        serde_json::json!({ "events": std::mem::take(&mut batch), "done": false }),
                    );
                }
            }
        }
    }

    // Join all spawned tasks; surface panics so a buggy do_query path doesn't
    // disappear silently. We continue draining other relays' results even if
    // one task panicked.
    for h in handles {
        if let Err(e) = h.await {
            if e.is_panic() {
                eprintln!("[relay_subscribe] relay task panicked: {e}");
            } else if e.is_cancelled() {
                eprintln!("[relay_subscribe] relay task cancelled");
            }
        }
    }

    // Final batch + completion signal
    let _ = app.emit(
        &event_name,
        serde_json::json!({ "events": batch, "done": true }),
    );

    Ok(())
}

/// Query a single relay via native tokio-tungstenite (no WebKitGTK WebSocket).
/// Used by fetchEventWithOutbox for individual event lookups — small payloads only.
#[tauri::command]
pub async fn relay_query(
    url: String,
    filter: Value,
    timeout_ms: Option<u64>,
) -> RelayQueryResult {
    let ms = timeout_ms.unwrap_or(8000);
    // Deadline passed down rather than wrapped around: on expiry we want the
    // events this relay already sent, not an empty result.
    do_query(url, filter, Instant::now() + Duration::from_millis(ms)).await
}

/// True when an IPv4 address is anything other than public unicast.
/// Kept in step with `isPrivateIPv4` in `packages/core/src/ipUtils.ts`.
fn is_blocked_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        // 100.64.0.0/10 CGNAT and 198.18.0.0/15 benchmarking have no
        // stable std predicate; check them by octet.
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        || (o[0] == 198 && (18..=19).contains(&o[1]))
        || o[0] >= 240
}

/// True when an IPv6 address is anything other than public unicast.
///
/// The v4-embedding forms matter as much as the native ranges: `Ipv6Addr`'s own
/// `is_loopback()` is true only for `::1`, so `::ffff:127.0.0.1` — which the OS
/// resolves straight to loopback — passed every check here. Unwrap the embedded
/// IPv4 and re-run the v4 predicate on it, mirroring `isPrivateIPv6` in
/// `packages/core/src/ipUtils.ts`.
fn is_blocked_ipv6(ip: std::net::Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_multicast() || ip.is_unspecified() {
        return true;
    }
    let s = ip.segments();

    // IPv4-mapped ::ffff:a.b.c.d
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_blocked_ipv4(v4);
    }
    // IPv4-compatible ::a.b.c.d (deprecated but still routable by some stacks)
    if s[0..6] == [0, 0, 0, 0, 0, 0] {
        return is_blocked_ipv4(std::net::Ipv4Addr::new(
            (s[6] >> 8) as u8,
            (s[6] & 0xff) as u8,
            (s[7] >> 8) as u8,
            (s[7] & 0xff) as u8,
        ));
    }
    // NAT64 well-known prefix 64:ff9b::/96
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
        return is_blocked_ipv4(std::net::Ipv4Addr::new(
            (s[6] >> 8) as u8,
            (s[6] & 0xff) as u8,
            (s[7] >> 8) as u8,
            (s[7] & 0xff) as u8,
        ));
    }
    // 6to4 2002::/16 embeds the v4 address in segments 1–2.
    if s[0] == 0x2002 {
        return is_blocked_ipv4(std::net::Ipv4Addr::new(
            (s[1] >> 8) as u8,
            (s[1] & 0xff) as u8,
            (s[2] >> 8) as u8,
            (s[2] & 0xff) as u8,
        ));
    }

    // fe80::/10 link-local, fc00::/7 unique-local, 100::/64 discard,
    // 2001:db8::/32 documentation.
    (0xfe80..=0xfebf).contains(&s[0])
        || (0xfc00..=0xfdff).contains(&s[0])
        || (s[0] == 0x0100 && s[1] == 0)
        || (s[0] == 0x2001 && s[1] == 0x0db8)
}

/// Reject a relay URL that this process must not dial.
///
/// Two checks, both of which matter because the URL arrives over the IPC
/// boundary from the webview and is therefore only as trustworthy as the page:
///
/// 1. Scheme must be `wss` (or `ws` for a `.onion`, where the hidden-service
///    address authenticates and encrypts the endpoint by itself). Anything else
///    could coerce the proxy path into a raw SOCKS/TCP connect to an arbitrary
///    internal host:port, and plaintext `ws` to a clearnet host would expose the
///    user's filters — follow graph, hashtags — to anyone on the path.
/// 2. Host must not be loopback/private/link-local, in ANY encoding including
///    the IPv4-in-IPv6 forms. This mirrors the JS-side `isSecureRelay` /
///    `isUnsafeHost` gate (see `packages/core/src/ipUtils.ts`); without it the
///    native path is strictly more permissive than the web path it exists to
///    replace, so `ws://127.0.0.1:9050` or `wss://[::ffff:169.254.169.254]/`
///    would happily be dialled from Rust. Hostnames are not resolved here —
///    this is the same lexical check the clients do, and DNS-level rebinding is
///    out of scope for a relay socket that speaks only the Nostr wire protocol.
fn validate_relay_url(url: &str) -> Result<(), String> {
    let parsed =
        url::Url::parse(url).map_err(|_| "invalid relay URL".to_string())?;
    // `wss` only, matching the JS `isSecureRelay` gate — plaintext `ws://`
    // exposes the user's filters (follow graph, hashtags, DM-recipient pubkeys)
    // to anyone on the path. The one exception is a Tor hidden service, where
    // the .onion address itself authenticates and encrypts the endpoint and TLS
    // adds nothing; those are only reachable through the SOCKS proxy anyway.
    let is_onion = matches!(parsed.host(), Some(url::Host::Domain(d))
        if d.to_ascii_lowercase().trim_end_matches('.').ends_with(".onion"));
    match parsed.scheme() {
        "wss" => {}
        "ws" if is_onion => {}
        _ => return Err("unsupported relay scheme (wss only; ws allowed for .onion)".to_string()),
    }
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) => {
            if is_blocked_ipv4(ip) {
                return Err("refusing to connect to a private/reserved address".to_string());
            }
        }
        Some(url::Host::Ipv6(ip)) => {
            if is_blocked_ipv6(ip) {
                return Err("refusing to connect to a private/reserved address".to_string());
            }
        }
        Some(url::Host::Domain(d)) => {
            // Strip the trailing root dot before matching: `ws://localhost./`
            // parses to the domain `localhost.`, which resolves to loopback but
            // matches neither arm below unless the dot is removed. Mirrors the
            // same normalization in `isUnsafeHost` (packages/core/src/ipUtils.ts).
            let d = d.to_ascii_lowercase();
            let d = d.trim_end_matches('.');
            if d == "localhost" || d.ends_with(".localhost") || d.is_empty() {
                return Err("refusing to connect to a private/reserved address".to_string());
            }
        }
        None => return Err("relay URL missing host".to_string()),
    }
    Ok(())
}

/// Verify an event's id-hash and Schnorr signature before it leaves this
/// process.
///
/// The JS side verifies too (`tauriQuery` / `tauriRelayQuery` in
/// `packages/web/src/lib/tauri.ts`), but relying on that alone made the native
/// bridge the ONLY transport in the app that hands unvalidated relay JSON to the
/// renderer — the web and mobile builds get `verifyEvent` for free inside
/// nostrify's `NRelay1`. Verifying here restores parity at the transport layer,
/// so a forged event is dropped before it is ever emitted, batched, counted
/// against `limit`, or inserted into the `seen` dedup set.
///
/// A malformed value that won't deserialize into an `Event` is treated as
/// unverifiable and dropped — fail closed.
fn authentic_event(value: &Value) -> Option<nostr::Event> {
    let event = serde_json::from_value::<nostr::Event>(value.clone()).ok()?;
    event.verify().ok()?;
    Some(event)
}

/// True when `event` actually satisfies the REQ filter we sent.
///
/// A valid signature proves only that SOMEONE signed the event — not that it is
/// the event we asked for. `NRelay1` on web and mobile runs `matchFilters` in
/// addition to `verifyEvent` (node_modules/@nostrify/nostrify/NRelay1.ts), and
/// the native bridge replaces that transport wholesale, so without this check
/// desktop accepts any correctly-signed event a relay feels like sending.
///
/// That gap is reachable from the app's whole data plane: `fetchEvent.ts`
/// caches a returned event under the id it REQUESTED, so a relay answering an
/// `ids` lookup with a different (validly signed) note substitutes content; the
/// same path feeds kind-10002 relay lists into `updateRelayCache`, which
/// persists them.
///
/// NIP-50 `search` matching is deliberately disabled: relays implement search
/// fuzzily, and the crate's `search_match` is a literal substring test that
/// would discard legitimate results.
fn matches_filter(filter: &nostr::Filter, event: &nostr::Event) -> bool {
    let opts = nostr::filter::MatchEventOptions::new().nip50(false);
    filter.match_event(event, opts)
}

/// Hard cap on events accumulated from a single relay connection.
///
/// `run_query` reads until EOSE/CLOSED or the caller's timeout. A hostile or
/// broken relay can stream EVENT frames indefinitely without ever sending EOSE,
/// and every frame was being pushed into an unbounded `Vec` — the whole timeout
/// window's worth of traffic held in memory at once. Stop reading at the cap and
/// return what we have; a truncated page is strictly better than an OOM.
const MAX_EVENTS_PER_QUERY: usize = 5000;

/// Open one WebSocket, send REQ, collect events until EOSE/CLOSED or the cap.
///
/// Routes through SOCKS5 (`proxy::current_proxy()`) if configured; otherwise
/// uses `tokio_tungstenite::connect_async` directly. The proxy check happens
/// per query so toggling the setting takes effect on the next connection
/// without an app restart.
async fn do_query(url: String, filter: Value, deadline: Instant) -> RelayQueryResult {
    if let Err(e) = validate_relay_url(&url) {
        return RelayQueryResult {
            events: vec![],
            error: Some(e),
        };
    }

    // The handshake gets the same deadline as the read loop. A relay that never
    // completes its TLS/WebSocket upgrade must not consume the whole budget and
    // leave nothing for the callers waiting behind it.
    match proxy::current_proxy() {
        Some(proxy_url) => match timeout_at(deadline, connect_via_proxy(&url, &proxy_url)).await {
            Ok(Ok(ws)) => run_query(ws, filter, deadline).await,
            Ok(Err(e)) => RelayQueryResult {
                events: vec![],
                error: Some(format!("proxy connect: {e}")),
            },
            Err(_) => RelayQueryResult {
                events: vec![],
                error: Some("proxy connect: timeout".to_string()),
            },
        },
        None => {
            // Kill-switch: when the user requires the proxy, never silently fall
            // back to a direct clearnet connection — that would leak their IP and
            // full Nostr filter. Fail the query instead.
            if proxy::proxy_required() {
                return RelayQueryResult {
                    events: vec![],
                    error: Some("proxy required but not configured — refusing direct connection".to_string()),
                };
            }
            match timeout_at(deadline, connect_async(url.as_str())).await {
                Ok(Ok((ws, _))) => run_query(ws, filter, deadline).await,
                Ok(Err(e)) => RelayQueryResult {
                    events: vec![],
                    error: Some(format!("connect: {e}")),
                },
                Err(_) => RelayQueryResult {
                    events: vec![],
                    error: Some("connect: timeout".to_string()),
                },
            }
        }
    }
}

// TLS note (applies to both connect paths below): relay `wss://` connections are
// validated against the OS system trust store with hostname verification (via
// native-tls). Certificate PINNING is intentionally NOT implemented:
//   1. Relays use auto-rotating certs (Let's Encrypt, ~60–90 days), so pinning a
//      fingerprint would break connectivity on every rotation.
//   2. It would only cover this native Rust path — WebView relay sockets use the
//      webview/OS TLS stack and can't be pinned here anyway.
// Residual risk: a hostile or compromised CA could MITM relay metadata. Users who
// need protection from that should route through Tor (proxy settings) onto a
// hidden-service relay, where the .onion address itself authenticates the endpoint.

/// SOCKS5-proxied WebSocket handshake. For `wss://`, wraps the SOCKS stream
/// with native-tls; for `ws://`, uses the SOCKS stream directly.
async fn connect_via_proxy(
    target: &str,
    proxy_url: &str,
) -> Result<WebSocketStream<ProxiedStream>, String> {
    let target_url = url::Url::parse(target).map_err(|e| format!("bad target: {e}"))?;
    let host = target_url
        .host_str()
        .ok_or_else(|| "target missing host".to_string())?
        .to_string();
    let port = target_url
        .port_or_known_default()
        .ok_or_else(|| "target missing port".to_string())?;
    let is_wss = target_url.scheme() == "wss";

    let proxy_parsed = url::Url::parse(proxy_url).map_err(|e| format!("bad proxy: {e}"))?;
    let proxy_addr = format!(
        "{}:{}",
        proxy_parsed.host_str().ok_or_else(|| "proxy missing host".to_string())?,
        proxy_parsed.port().ok_or_else(|| "proxy missing port".to_string())?,
    );

    // SOCKS5 handshake. `socks5h://` semantics (remote DNS) are achieved by
    // passing the hostname rather than a resolved IP — tokio-socks forwards
    // the literal target string to the proxy.
    let socks_stream = tokio_socks::tcp::Socks5Stream::connect(
        proxy_addr.as_str(),
        format!("{host}:{port}"),
    )
    .await
    .map_err(|e| format!("socks5: {e}"))?;

    let req = target
        .into_client_request()
        .map_err(|e| format!("request: {e}"))?;

    let stream: ProxiedStream = if is_wss {
        let native = native_tls::TlsConnector::new().map_err(|e| format!("tls init: {e}"))?;
        let connector = tokio_native_tls::TlsConnector::from(native);
        let tls = connector
            .connect(&host, socks_stream)
            .await
            .map_err(|e| format!("tls handshake: {e}"))?;
        ProxiedStream::Tls(Box::new(tls))
    } else {
        ProxiedStream::Plain(Box::new(socks_stream))
    };

    let (ws, _) = client_async(req, stream)
        .await
        .map_err(|e| format!("ws handshake: {e}"))?;
    Ok(ws)
}

/// Unified stream type so the same `run_query` body handles both proxied
/// `wss://` (TLS over SOCKS) and proxied `ws://` (plain over SOCKS).
enum ProxiedStream {
    Tls(Box<tokio_native_tls::TlsStream<tokio_socks::tcp::Socks5Stream<tokio::net::TcpStream>>>),
    Plain(Box<tokio_socks::tcp::Socks5Stream<tokio::net::TcpStream>>),
}

impl AsyncRead for ProxiedStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ProxiedStream::Tls(s) => std::pin::Pin::new(s.as_mut()).poll_read(cx, buf),
            ProxiedStream::Plain(s) => std::pin::Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for ProxiedStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            ProxiedStream::Tls(s) => std::pin::Pin::new(s.as_mut()).poll_write(cx, buf),
            ProxiedStream::Plain(s) => std::pin::Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ProxiedStream::Tls(s) => std::pin::Pin::new(s.as_mut()).poll_flush(cx),
            ProxiedStream::Plain(s) => std::pin::Pin::new(s.as_mut()).poll_flush(cx),
        }
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ProxiedStream::Tls(s) => std::pin::Pin::new(s.as_mut()).poll_shutdown(cx),
            ProxiedStream::Plain(s) => std::pin::Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

/// Read a relay's response until EOSE/CLOSED, the event cap, or `deadline`.
///
/// The deadline lives HERE, around the read loop, rather than around the whole
/// query. Wrapping the outer future meant that when a slow relay hadn't sent
/// EOSE in time, the future was dropped and every event it HAD already
/// delivered went with it — the relay contributed nothing at all. The web build
/// never behaved that way: NRelay1 streams events as they arrive and its
/// timeout only closes the socket, so whatever arrived is kept. That asymmetry
/// is the biggest reason desktop showed "failed to load event" and unresolved
/// grey placeholders far more often than web for events that were, in fact,
/// delivered. On expiry we now stop reading and return the partial page.
async fn run_query<S>(mut ws: WebSocketStream<S>, filter: Value, deadline: Instant) -> RelayQueryResult
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // Parse the filter up front so every returned event can be checked against
    // it. Fail CLOSED on a filter we can't model: the app builds these itself,
    // so a parse failure is our bug, and the alternative — accepting whatever
    // the relay sends — is exactly the hole this check exists to close.
    let parsed_filter: nostr::Filter = match serde_json::from_value(filter.clone()) {
        Ok(f) => f,
        Err(e) => {
            return RelayQueryResult {
                events: vec![],
                error: Some(format!("unsupported filter: {e}")),
            };
        }
    };

    let req = serde_json::json!(["REQ", "q", filter]);
    if ws.send(Message::Text(req.to_string())).await.is_err() {
        return RelayQueryResult {
            events: vec![],
            error: Some("send failed".to_string()),
        };
    }

    let mut events: Vec<Value> = vec![];

    loop {
        // `next()` alone would block past the deadline on a relay that has gone
        // quiet without closing.
        let msg_result = match timeout_at(deadline, ws.next()).await {
            Ok(Some(m)) => m,
            // Stream ended, or the deadline passed — either way, return what we
            // collected rather than discarding it.
            Ok(None) | Err(_) => break,
        };
        let msg = match msg_result {
            Ok(m) => m,
            Err(_) => break,
        };
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let parsed: Value = match serde_json::from_str(text.as_str()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let arr = match parsed.as_array() {
            Some(a) => a,
            None => continue,
        };
        match arr.first().and_then(|v| v.as_str()) {
            Some("EVENT") if arr.len() >= 3 => {
                // Two checks, mirroring what NRelay1 does on web/mobile: the
                // event must be authentic AND must be one we actually asked for.
                let Some(event) = authentic_event(&arr[2]) else { continue };
                if !matches_filter(&parsed_filter, &event) {
                    continue;
                }
                events.push(arr[2].clone());
                if events.len() >= MAX_EVENTS_PER_QUERY {
                    break; // hostile/broken relay streaming without EOSE
                }
            }
            Some("EOSE") | Some("CLOSED") => break,
            _ => {}
        }
    }

    let _ = ws.close(None).await;
    RelayQueryResult { events, error: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every one of these must be refused. The IPv4-in-IPv6 spellings are the
    /// ones that used to get through: `Ipv6Addr::is_loopback()` is true only for
    /// `::1`, so `::ffff:127.0.0.1` — which the OS resolves straight to loopback
    /// — passed the old check and let the webview open a native socket to a
    /// local service. Kept in step with the `isUnsafeHost` cases in
    /// packages/web/src/lib/ipUtils.test.ts.
    #[test]
    fn rejects_private_and_reserved_hosts() {
        let blocked = [
            "wss://127.0.0.1",
            "wss://10.0.0.1",
            "wss://192.168.1.1",
            "wss://172.16.0.1",
            "wss://169.254.169.254",
            "wss://100.64.0.1",
            "wss://198.18.0.1",
            "wss://0.0.0.0",
            "wss://255.255.255.255",
            "wss://localhost",
            "wss://localhost.",
            "wss://sub.localhost",
            "wss://[::1]",
            "wss://[fe80::1]",
            "wss://[febf::1]",
            "wss://[fc00::1]",
            "wss://[fd12:3456::1]",
            "wss://[ff02::1]",
            "wss://[2001:db8::1]",
            "wss://[100::1]",
            // IPv4-embedding forms
            "wss://[::ffff:127.0.0.1]",
            "wss://[::ffff:169.254.169.254]",
            "wss://[::ffff:10.0.0.1]",
            "wss://[::127.0.0.1]",
            "wss://[64:ff9b::127.0.0.1]",
            "wss://[2002:7f00:1::]",
        ];
        for url in blocked {
            assert!(
                validate_relay_url(url).is_err(),
                "expected {url} to be rejected",
            );
        }
    }

    #[test]
    fn accepts_public_relays() {
        for url in [
            "wss://relay.damus.io",
            "wss://nos.lol",
            "wss://relay.nostr.net/",
            "wss://[2606:4700:4700::1111]",
            "wss://1.1.1.1",
        ] {
            assert!(
                validate_relay_url(url).is_ok(),
                "expected {url} to be accepted",
            );
        }
    }

    /// Plaintext `ws://` leaks the user's filters (follow graph, hashtags) to
    /// anyone on the path, so it is refused for clearnet — matching the JS
    /// `isSecureRelay` gate. A `.onion` is the documented exception: the hidden
    /// service address authenticates and encrypts the endpoint by itself.
    #[test]
    fn enforces_wss_except_for_onion() {
        assert!(validate_relay_url("ws://relay.damus.io").is_err());
        assert!(validate_relay_url("wss://relay.damus.io").is_ok());
        assert!(validate_relay_url("ws://abcdefghij234567.onion").is_ok());
        assert!(validate_relay_url("wss://abcdefghij234567.onion").is_ok());
        // The onion exemption must not extend to a lookalike domain.
        assert!(validate_relay_url("ws://notreally-onion.example").is_err());
    }

    #[test]
    fn rejects_non_websocket_schemes() {
        for url in [
            "http://relay.damus.io",
            "https://relay.damus.io",
            "file:///etc/passwd",
            "socks5://127.0.0.1:9050",
            "not a url",
            "",
        ] {
            assert!(
                validate_relay_url(url).is_err(),
                "expected {url} to be rejected",
            );
        }
    }

    /// The native bridge is the only transport in the app that does not get
    /// nostrify's `verifyEvent` for free, so a forged event must be dropped
    /// here rather than emitted to the renderer.
    #[test]
    fn rejects_unauthentic_events() {
        // Structurally valid shape, but the signature is not over this content.
        let forged = serde_json::json!({
            "id": "0".repeat(64),
            "pubkey": "1".repeat(64),
            "created_at": 1_700_000_000u64,
            "kind": 1,
            "tags": [],
            "content": "forged",
            "sig": "2".repeat(128),
        });
        assert!(authentic_event(&forged).is_none());

        // Anything that will not even deserialize as an Event fails closed.
        assert!(authentic_event(&serde_json::json!({})).is_none());
        assert!(authentic_event(&serde_json::json!("not an object")).is_none());
        assert!(authentic_event(&serde_json::json!({ "id": "short" })).is_none());
    }

    /// A valid signature proves authorship, NOT that the event is the one we
    /// asked for. Without filter matching a relay can answer an `ids` lookup
    /// with any correctly-signed note it likes — and `fetchEvent.ts` caches the
    /// reply under the id it REQUESTED, so the substitution sticks.
    #[test]
    fn rejects_signed_but_unrequested_events() {
        use nostr::prelude::*;
        let keys = Keys::generate();
        let event = EventBuilder::text_note("real note")
            .sign_with_keys(&keys)
            .expect("sign");

        // Asked for a DIFFERENT event id.
        let other_id = EventId::all_zeros();
        let by_id: nostr::Filter = serde_json::from_value(serde_json::json!({
            "ids": [other_id.to_hex()],
        }))
        .expect("filter");
        assert!(!matches_filter(&by_id, &event));

        // Asked for a different author.
        let by_author: nostr::Filter = serde_json::from_value(serde_json::json!({
            "authors": [Keys::generate().public_key().to_hex()],
        }))
        .expect("filter");
        assert!(!matches_filter(&by_author, &event));

        // Asked for a different kind — this is the relay-list poisoning shape:
        // request kind 10002, get handed a signed kind 1.
        let by_kind: nostr::Filter =
            serde_json::from_value(serde_json::json!({ "kinds": [10002] })).expect("filter");
        assert!(!matches_filter(&by_kind, &event));
    }

    /// …and the matching must not be so strict that real queries return nothing.
    #[test]
    fn accepts_requested_events() {
        use nostr::prelude::*;
        let keys = Keys::generate();
        let event = EventBuilder::text_note("real note")
            .sign_with_keys(&keys)
            .expect("sign");

        for filter_json in [
            serde_json::json!({ "ids": [event.id.to_hex()] }),
            serde_json::json!({ "authors": [keys.public_key().to_hex()] }),
            serde_json::json!({ "kinds": [1] }),
            serde_json::json!({ "kinds": [1], "authors": [keys.public_key().to_hex()], "limit": 20 }),
            serde_json::json!({}),
        ] {
            let f: nostr::Filter = serde_json::from_value(filter_json.clone()).expect("filter");
            assert!(
                matches_filter(&f, &event),
                "expected {filter_json} to match the event",
            );
        }
    }

    // ── Deadline handling ───────────────────────────────────────────────────

    /// Build a client-side `WebSocketStream` over an in-memory duplex, plus the
    /// raw server end so a test can script exactly what the "relay" sends.
    async fn ws_pair() -> (
        WebSocketStream<tokio::io::DuplexStream>,
        WebSocketStream<tokio::io::DuplexStream>,
    ) {
        use tokio_tungstenite::tungstenite::protocol::Role;
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let client = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        let server = WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;
        (client, server)
    }

    fn signed_note(keys: &nostr::Keys, text: &str) -> Value {
        use nostr::prelude::*;
        let event = EventBuilder::text_note(text)
            .sign_with_keys(keys)
            .expect("sign");
        serde_json::from_str(&event.as_json()).expect("serialize")
    }

    /// The regression that made desktop look so much worse than web: a relay
    /// that delivers events but is slow to send EOSE. The deadline used to wrap
    /// the whole query future, so when it fired the future was dropped and every
    /// event already received went with it — the relay contributed nothing.
    #[tokio::test]
    async fn keeps_events_from_a_relay_that_never_sends_eose() {
        use nostr::prelude::*;
        let keys = Keys::generate();
        let (client, mut server) = ws_pair().await;

        // Relay sends three matching events, then goes quiet forever.
        for text in ["one", "two", "three"] {
            let frame = serde_json::json!(["EVENT", "q", signed_note(&keys, text)]);
            server
                .send(Message::Text(frame.to_string()))
                .await
                .expect("send");
        }

        let filter = serde_json::json!({ "kinds": [1], "authors": [keys.public_key().to_hex()] });
        let result = run_query(client, filter, tokio::time::Instant::now() + Duration::from_millis(300)).await;

        assert_eq!(result.events.len(), 3, "partial results must survive the deadline");
        assert!(result.error.is_none());
        drop(server);
    }

    /// EOSE still ends the read immediately rather than waiting out the budget.
    #[tokio::test]
    async fn returns_as_soon_as_eose_arrives() {
        use nostr::prelude::*;
        let keys = Keys::generate();
        let (client, mut server) = ws_pair().await;

        let frame = serde_json::json!(["EVENT", "q", signed_note(&keys, "only")]);
        server.send(Message::Text(frame.to_string())).await.expect("send");
        server
            .send(Message::Text(serde_json::json!(["EOSE", "q"]).to_string()))
            .await
            .expect("send");

        let started = std::time::SystemTime::now();
        let filter = serde_json::json!({ "kinds": [1] });
        let result = run_query(client, filter, tokio::time::Instant::now() + Duration::from_secs(30)).await;

        assert_eq!(result.events.len(), 1);
        assert!(
            started.elapsed().expect("clock") < Duration::from_secs(5),
            "EOSE should end the read, not the 30s budget",
        );
        drop(server);
    }

    /// A deadline that has already passed yields nothing, but must not hang.
    #[tokio::test]
    async fn an_expired_deadline_returns_immediately() {
        let (client, server) = ws_pair().await;
        let filter = serde_json::json!({ "kinds": [1] });
        let result = run_query(client, filter, tokio::time::Instant::now() - Duration::from_secs(1)).await;
        assert!(result.events.is_empty());
        drop(server);
    }

    /// A genuinely signed event must survive verification, or the check would
    /// silently drop every real event and the test above would pass vacuously.
    #[test]
    fn accepts_authentic_event() {
        use nostr::prelude::*;
        let keys = Keys::generate();
        let event = EventBuilder::text_note("hello")
            .sign_with_keys(&keys)
            .expect("sign");
        let value: Value = serde_json::from_str(&event.as_json()).expect("serialize");
        assert!(authentic_event(&value).is_some());
    }
}
