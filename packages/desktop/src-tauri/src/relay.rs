use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Serialize, Deserialize)]
pub struct RelayQueryResult {
    pub events: Vec<Value>,
    pub error: Option<String>,
}

/// Query multiple relays in parallel, deduplicate results by event ID.
/// All relay connections use tokio-tungstenite — no WebKitGTK WebSocket involved.
/// Called by the JS TauriNostrProxy to replace NPool queries in Tauri.
#[tauri::command]
pub async fn pool_query(
    urls: Vec<String>,
    filter: Value,
    timeout_ms: Option<u64>,
) -> RelayQueryResult {
    let ms = timeout_ms.unwrap_or(5000);
    let dur = Duration::from_millis(ms);

    let handles: Vec<_> = urls
        .into_iter()
        .map(|url| {
            let f = filter.clone();
            tokio::spawn(async move {
                match tokio::time::timeout(dur, do_query(url, f)).await {
                    Ok(r) => r.events,
                    Err(_) => vec![],
                }
            })
        })
        .collect();

    let mut seen = std::collections::HashSet::new();
    let mut events = Vec::new();
    for handle in handles {
        if let Ok(relay_events) = handle.await {
            for ev in relay_events {
                if let Some(id) = ev.get("id").and_then(|v| v.as_str()) {
                    if seen.insert(id.to_string()) {
                        events.push(ev);
                    }
                }
            }
        }
    }
    RelayQueryResult { events, error: None }
}

/// Query a single relay via native tokio-tungstenite WebSocket.
/// Bypasses WebKitGTK's WebSocket implementation entirely — avoids the crash
/// that occurs when too many concurrent WS connections saturate WebKitGTK on Linux.
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

    let sub_id = "corkboards-query";
    let req = serde_json::json!(["REQ", sub_id, filter]);
    let req_str = req.to_string();
    if ws.send(Message::Text(req_str)).await.is_err() {
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
