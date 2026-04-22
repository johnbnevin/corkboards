mod keychain;
mod logger;
mod relay;

use keychain::{keychain_store, keychain_get, keychain_delete};
use logger::{write_log, clear_log};
use relay::relay_query;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            keychain_store,
            keychain_get,
            keychain_delete,
            write_log,
            clear_log,
            relay_query,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
