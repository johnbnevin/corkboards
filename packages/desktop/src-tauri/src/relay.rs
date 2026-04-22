use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// How many events to bundle per Channel send.
/// Each send is one postMessage call — keep it small to avoid WebKit buffer limits.
const BATCH_SIZE: usize = 20;

#[derive(Debug, Serialize, Deserialize)]
pub struct RelayQueryResult {
    pub events: Vec<Value>,
    pub error: Option<String>,
}

/// Stream events from multiple relays to JS via a Tauri Channel.
///
/// Queries all relays concurrently via tokio-tungstenite (no WebKitGTK WebSocket).
/// Events are deduplicated by ID and streamed back in batches of BATCH_SIZE so
/// each postMessage call is small even when the IPC custom protocol has fallen back.
///
/// The JS side receives `{ events: [...], done: false }` batches and a final
/// `{ events: [...], done: true }` when all relays have returned EOSE.
#[tauri::command]
pub async fn relay_subscribe(
    urls: Vec<String>,
    filter: Value,
    timeout_ms: Option<u64>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let ms = timeout_ms.unwrap_or(5000);
    let dur = Duration::from_millis(ms);
    let limit = filter
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(u64::MAX) as usize;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();

    // Spawn one task per relay — all connect concurrently via Rust async
    let handles: Vec<_> = urls
        .into_iter()
        .map(|url| {
            let f = filter.clone();
            let sender = tx.clone();
            tokio::spawn(async move {
                match tokio::time::timeout(dur, do_query(url, f)).await {
                    Ok(result) => {
                        for ev in result.events {
                            if sender.send(ev).is_err() {
                                break; // receiver closed
                            }
                        }
                    }
                    Err(_) => {} // timed out — channel sender dropped, that's fine
                }
            })
        })
        .collect();
    drop(tx); // channel closes when all spawned tasks drop their senders

    // Collect, deduplicate, and stream to JS
    let mut seen = std::collections::HashSet::new();
    let mut batch: Vec<Value> = Vec::new();
    let mut total = 0usize;

    while let Some(event) = rx.recv().await {
        if total >= limit {
            continue; // drain but discard — relay sent more than requested
        }
        if let Some(id) = event.get("id").and_then(|v| v.as_str()) {
            if seen.insert(id.to_string()) {
                total += 1;
                batch.push(event);
                if batch.len() >= BATCH_SIZE {
                    if on_event
                        .send(serde_json::json!({
                            "events": std::mem::take(&mut batch),
                            "done": false
                        }))
                        .is_err()
                    {
                        // JS closed the channel (AbortSignal or unmount) — drain and exit cleanly
                        drop(rx);
                        for h in handles {
                            let _ = h.await;
                        }
                        return Ok(());
                    }
                }
            }
        }
    }

    // All relay tasks have finished
    for h in handles {
        let _ = h.await;
    }

    // Final batch + completion signal
    let _ = on_event.send(serde_json::json!({
        "events": batch,
        "done": true
    }));

    Ok(())
}

/// Query a single relay via native tokio-tungstenite.
/// Used by fetchEventWithOutbox for individual event lookups (small payloads, safe).
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

/// Open a WebSocket to one relay, send REQ, collect all events until EOSE/CLOSED.
async fn do_query(url: String, filter: Value) -> RelayQueryResult {
    let (mut ws, _) = match connect_async(url.as_str()).await {
        Ok(pair) => pair,
        Err(e) => {
            return RelayQueryResult {
                events: vec![],
                error: Some(format!("connect: {e}")),
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
            }
            Some("EOSE") | Some("CLOSED") => break,
            _ => {}
        }
    }

    let _ = ws.close(None).await;
    RelayQueryResult { events, error: None }
}
