#![forbid(unsafe_code)]

mod concierge;
mod concierge_history;
mod database;
mod home_setup;
mod schema;

#[tauri::command]
fn qr_scanner_native() -> bool {
    cfg!(mobile)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_launcher::init())
        .setup(|_app| {
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            Ok(())
        })
        .manage(concierge::ConciergeState::default())
        .manage(database::DatabaseState::default())
        .invoke_handler(tauri::generate_handler![
            qr_scanner_native,
            home_setup::home_scene_config,
            database::calendar_add_feed,
            database::calendar_update_feed,
            database::calendar_remove_feed,
            database::calendar_fetch_feed,
            database::storage_load,
            database::storage_save_connection,
            database::storage_clear_connection,
            database::storage_set_theme,
            database::storage_set_pinned_apps,
            database::storage_set_app_hidden,
            database::storage_set_favourites,
            database::storage_set_selected_speaker,
            database::storage_import_legacy,
            concierge::concierge_get_settings,
            concierge::concierge_save_settings,
            concierge::concierge_clear_key,
            concierge::concierge_test_key,
            concierge::concierge_list_models,
            concierge::concierge_request,
            concierge::concierge_voice_request,
            concierge::concierge_cancel,
            concierge_history::concierge_list_chats,
            concierge_history::concierge_load_chat,
            concierge_history::concierge_save_chat,
        ])
        .run(tauri::generate_context!())
        .expect("Hjem could not start");
}
