fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
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
