mod concierge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_launcher::init())
        .manage(concierge::ConciergeState::default())
        .invoke_handler(tauri::generate_handler![
            concierge::concierge_get_settings,
            concierge::concierge_save_settings,
            concierge::concierge_clear_key,
            concierge::concierge_test_key,
            concierge::concierge_list_models,
            concierge::concierge_request,
            concierge::concierge_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("Hjem could not start");
}
