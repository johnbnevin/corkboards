use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::timeout;
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
    let dur = Duration::from_millis(ms);
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
                match tokio::time::timeout(dur, do_query(url, f)).await {
                    Ok(result) => {
                        if let Some(err) = result.error {
                            eprintln!("[relay {url_for_log}] error: {err}");
                        }
                        for ev in result.events {
                            // send() awaits when the channel is full — applies backpressure
                            if sender.send(ev).await.is_err() {
                                break; // receiver dropped
                            }
                        }
                    }
                    Err(_) => {
                        eprintln!("[relay {url_for_log}] timeout after {ms}ms");
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
    match timeout(Duration::from_millis(ms), do_query(url, filter)).await {
        Ok(result) => result,
        Err(_) => RelayQueryResult {
            events: vec![],
            error: Some("timeout".to_string()),
        },
    }
}

/// Reject a relay URL that this process must not dial.
///
/// Two checks, both of which matter because the URL arrives over the IPC
/// boundary from the webview and is therefore only as trustworthy as the page:
///
///  1. Scheme must be ws/wss. Anything else could coerce the proxy path into a
///     raw SOCKS/TCP connect to an arbitrary internal host:port.
///  2. Host must not be loopback/private/link-local. This mirrors the JS-side
///     `isSecureRelay` / `isUnsafeHost` gate (see `packages/core/src/ipUtils.ts`);
///     without it the native path was strictly more permissive than the web path
///     it exists to replace, so `ws://127.0.0.1:9050` or
///     `ws://169.254.169.254/` would happily be dialled from Rust. Hostnames are
///     not resolved here — this is the same lexical check the clients do, and
///     DNS-level rebinding is out of scope for a relay socket that speaks only
///     the Nostr wire protocol.
fn validate_relay_url(url: &str) -> Result<(), String> {
    let parsed =
        url::Url::parse(url).map_err(|_| "invalid relay URL".to_string())?;
    if !matches!(parsed.scheme(), "ws" | "wss") {
        return Err("unsupported relay scheme (ws/wss only)".to_string());
    }
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) => {
            if ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_multicast()
                || ip.is_documentation()
                // 100.64.0.0/10 CGNAT and 198.18.0.0/15 benchmarking have no
                // stable std predicate; check them by octet.
                || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                || (ip.octets()[0] == 198 && (18..=19).contains(&ip.octets()[1]))
                || ip.octets()[0] >= 240
            {
                return Err("refusing to connect to a private/reserved address".to_string());
            }
        }
        Some(url::Host::Ipv6(ip)) => {
            if ip.is_loopback() || ip.is_multicast() || ip.is_unspecified() {
                return Err("refusing to connect to a private/reserved address".to_string());
            }
            let seg0 = ip.segments()[0];
            // fe80::/10 link-local and fc00::/7 unique-local.
            if (0xfe80..=0xfebf).contains(&seg0) || (0xfc00..=0xfdff).contains(&seg0) {
                return Err("refusing to connect to a private/reserved address".to_string());
            }
        }
        Some(url::Host::Domain(d)) => {
            let d = d.to_ascii_lowercase();
            if d == "localhost" || d.ends_with(".localhost") || d.is_empty() {
                return Err("refusing to connect to a private/reserved address".to_string());
            }
        }
        None => return Err("relay URL missing host".to_string()),
    }
    Ok(())
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
async fn do_query(url: String, filter: Value) -> RelayQueryResult {
    if let Err(e) = validate_relay_url(&url) {
        return RelayQueryResult {
            events: vec![],
            error: Some(e),
        };
    }

    match proxy::current_proxy() {
        Some(proxy_url) => match connect_via_proxy(&url, &proxy_url).await {
            Ok(ws) => run_query(ws, filter).await,
            Err(e) => RelayQueryResult {
                events: vec![],
                error: Some(format!("proxy connect: {e}")),
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
            match connect_async(url.as_str()).await {
                Ok((ws, _)) => run_query(ws, filter).await,
                Err(e) => RelayQueryResult {
                    events: vec![],
                    error: Some(format!("connect: {e}")),
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

async fn run_query<S>(mut ws: WebSocketStream<S>, filter: Value) -> RelayQueryResult
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let req = serde_json::json!(["REQ", "q", filter]);
    if ws.send(Message::Text(req.to_string())).await.is_err() {
        return RelayQueryResult {
            events: vec![],
            error: Some("send failed".to_string()),
        };
    }

    let mut events: Vec<Value> = vec![];

    while let Some(msg_result) = ws.next().await {
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
