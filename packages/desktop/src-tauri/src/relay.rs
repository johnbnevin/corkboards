use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// Events per emit call — each app.emit() uses webkit_web_view_run_javascript,
/// so the payload per call stays small regardless of IPC protocol state.
const BATCH_SIZE: usize = 20;

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
        .unwrap_or(u64::MAX) as usize;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();

    // Spawn one task per relay — all connect and query concurrently
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
                                break; // receiver dropped
                            }
                        }
                    }
                    Err(_) => {} // timeout — sender dropped, channel eventually closes
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

    for h in handles {
        let _ = h.await;
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

/// Open one WebSocket, send REQ, collect all events until EOSE/CLOSED.
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
