#![forbid(unsafe_code)]

fn main() {
    println!("cargo:rerun-if-changed=migrations");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "qr_scanner_native",
            "storage_load",
            "storage_save_connection",
            "storage_clear_connection",
            "storage_set_theme",
            "storage_set_pinned_apps",
            "storage_set_favourites",
            "storage_set_selected_speaker",
            "storage_import_legacy",
            "concierge_get_settings",
            "concierge_save_settings",
            "concierge_clear_key",
            "concierge_test_key",
            "concierge_list_models",
            "concierge_request",
            "concierge_cancel",
        ]),
    ))
    .expect("Could not build Hjem's native command permissions")
}
