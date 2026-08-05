mod keychain;
mod logger;
mod memlog;
mod opener;
mod proxy;
mod relay;
mod settings;
mod signer;

use keychain::{keychain_store, keychain_delete, keychain_has};
use logger::{write_log, clear_log};
use opener::{open_external, open_lightning};
use proxy::{
    get_proxy, set_proxy, get_proxy_required, set_proxy_required, proxy_load_failed,
    proxy_webview_unprotected,
};
use settings::{
    get_content_protected, set_content_protected, get_file_logging, set_file_logging,
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
                    // Excluding the window from screen capture defends against a
                    // shoulder-surfing/screen-scraping threat model, but it also
                    // blocks the user's OWN screenshots and screen sharing — so it
                    // is a default, not a lock. Read from settings each launch.
                    .content_protected(settings::content_protected());

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
                        // macOS: WKWebView proxying is best-effort and cannot be
                        // verified post-build — reporting it as protected there
                        // suppressed the red warning AND disarmed the publish
                        // gate on exactly the platform where the proxy most
                        // likely didn't apply. Claim protection only where the
                        // engine honors it (Linux/Windows).
                        webview_proxied = !cfg!(target_os = "macos");
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
            proxy::set_webview_proxied(webview_proxied);
            // proxy_webview_unprotected() includes load_failed: an unreadable
            // proxy.json is treated as "assume required" (the file that failed
            // to parse may have said required=true) — matching relay.rs's
            // kill-switch instead of silently disarming everything.
            if proxy::proxy_webview_unprotected() {
                eprintln!(
                    "[setup] WARNING: proxy is required (or its config failed to load) but the \
                     WebView could not be proxied — non-relay traffic (images, embeds, JS relay \
                     sockets) would go out directly this session; publishes are blocked."
                );
            }

            builder.build()?;

            // Reap idle pooled relay sockets. Checkout/checkin only evict
            // entries for the relay being queried, so without this an app that
            // goes idle holds every pooled FD until the next query for that
            // exact relay. Half the idle timeout keeps the worst-case overstay
            // small; this is a cleanup cadence, not network traffic — no relay
            // sees anything except a close frame for an already-dead socket.
            tauri::async_runtime::spawn(async {
                let mut tick = tokio::time::interval(relay::POOL_IDLE_TIMEOUT / 2);
                tick.tick().await; // first tick fires immediately — nothing to reap yet
                loop {
                    tick.tick().await;
                    relay::pool_reap().await;
                }
            });

            // Memory telemetry: RSS of the app + WebKit process tree into
            // debug.log every 5 minutes (see memlog.rs for why). Honors the
            // file-logging opt-in via logger::write_log.
            memlog::spawn_sampler();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keychain_store,
            keychain_delete,
            keychain_has,
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
            open_external,
            open_lightning,
            get_file_logging,
            set_file_logging,
            get_content_protected,
            set_content_protected,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
