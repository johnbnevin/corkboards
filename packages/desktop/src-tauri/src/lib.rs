mod keychain;
mod logger;
mod proxy;
mod relay;
mod signer;

use keychain::{keychain_store, keychain_delete};
use logger::{write_log, clear_log};
use proxy::{
    get_proxy, set_proxy, get_proxy_required, set_proxy_required, proxy_load_failed,
    proxy_webview_unprotected,
};
use relay::{relay_query, relay_subscribe};
use signer::{sign_event, nip44_encrypt, nip44_decrypt, nip04_encrypt, nip04_decrypt};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::{WebviewUrl, WebviewWindowBuilder};

            // The main window is created here (not in tauri.conf.json) so we can
            // route the WebView through the user's SOCKS/Tor proxy at startup.
            // Window props mirror the former tauri.conf.json `windows` entry.
            let mut builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Corkboards")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(800.0, 600.0)
                    .resizable(true)
                    .content_protected(true);

            // Apply the saved proxy to ALL WebView network requests (relay sockets,
            // images, embeds) — closing the gap where only native Rust relay queries
            // were proxied. Linux/Windows reliable; macOS best-effort (WKWebView).
            // Changing the proxy requires an app restart to affect the WebView;
            // native relay queries already pick it up live.
            let mut webview_proxied = false;
            if let Some(proxy_url) = proxy::current_proxy() {
                // proxy_url() accepts only http:// or socks5:// — normalize the
                // recommended socks5h:// (remote-DNS) form used for native sockets.
                let webview_proxy = proxy_url.replacen("socks5h://", "socks5://", 1);
                match url::Url::parse(&webview_proxy) {
                    Ok(parsed) => {
                        builder = builder.proxy_url(parsed);
                        webview_proxied = true;
                    }
                    Err(e) => eprintln!("[setup] invalid proxy URL for webview: {e}"),
                }
            }

            // The relay.rs kill-switch only protects NATIVE relay sockets. If the
            // user requires a proxy but we couldn't route the WebView through one,
            // images/embeds/JS relay sockets go out directly — exactly the leak the
            // kill-switch exists to prevent, just on the other transport. Latch it
            // so the settings UI can warn instead of the user silently going
            // unprotected. (We still open the window: refusing to start would leave
            // them no way to fix the setting.)
            let unprotected = proxy::proxy_required() && !webview_proxied;
            proxy::set_webview_unprotected(unprotected);
            if unprotected {
                eprintln!(
                    "[setup] WARNING: proxy is REQUIRED but the WebView could not be proxied — \
                     non-relay traffic (images, embeds) will go out directly this session."
                );
            }

            builder.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keychain_store,
            keychain_delete,
            write_log,
            clear_log,
            relay_query,
            relay_subscribe,
            get_proxy,
            set_proxy,
            get_proxy_required,
            set_proxy_required,
            proxy_load_failed,
            proxy_webview_unprotected,
            sign_event,
            nip44_encrypt,
            nip44_decrypt,
            nip04_encrypt,
            nip04_decrypt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
