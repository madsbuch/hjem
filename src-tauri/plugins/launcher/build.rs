#![forbid(unsafe_code)]

const COMMANDS: &[&str] = &[
    "get_status",
    "list_apps",
    "launch_app",
    "uninstall_app",
    "open_app_info",
    "open_home_settings",
    "save_document",
    "open_document",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
