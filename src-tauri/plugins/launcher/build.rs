#![forbid(unsafe_code)]

const COMMANDS: &[&str] = &[
    "get_status",
    "list_apps",
    "launch_app",
    "open_home_settings",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
