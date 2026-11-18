#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
struct Native<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherStatus {
    supported: bool,
    is_default_home: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherApp {
    package_name: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
}

#[tauri::command]
async fn get_status<R: Runtime>(_app: AppHandle<R>) -> Result<LauncherStatus, String> {
    #[cfg(target_os = "android")]
    {
        _app.state::<Native<R>>()
            .0
            .run_mobile_plugin("getStatus", serde_json::json!({}))
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(LauncherStatus {
            supported: false,
            is_default_home: false,
        })
    }
}

#[tauri::command]
async fn list_apps<R: Runtime>(_app: AppHandle<R>) -> Result<Vec<LauncherApp>, String> {
    #[cfg(target_os = "android")]
    {
        _app.state::<Native<R>>()
            .0
            .run_mobile_plugin("listApps", serde_json::json!({}))
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
async fn launch_app<R: Runtime>(_app: AppHandle<R>, package_name: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        _app.state::<Native<R>>()
            .0
            .run_mobile_plugin::<()>(
                "launchApp",
                serde_json::json!({ "packageName": package_name }),
            )
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = package_name;
        Err("Installed apps can only be opened in Hjem for Android.".into())
    }
}

fn validate_package_name(package_name: &str) -> Result<(), String> {
    if package_name.is_empty()
        || package_name.len() > 255
        || !package_name.split('.').all(|segment| {
            let mut characters = segment.chars();
            matches!(characters.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
                && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
        })
    {
        return Err("Choose an installed app to manage.".into());
    }
    Ok(())
}

#[tauri::command]
async fn uninstall_app<R: Runtime>(_app: AppHandle<R>, package_name: String) -> Result<(), String> {
    validate_package_name(&package_name)?;
    #[cfg(target_os = "android")]
    {
        // Resolves when Android opens its confirmation UI, not when an app is removed.
        _app.state::<Native<R>>()
            .0
            .run_mobile_plugin::<()>(
                "uninstallApp",
                serde_json::json!({ "packageName": package_name }),
            )
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("Uninstalling apps is available in Hjem for Android.".into())
    }
}

#[tauri::command]
async fn open_app_info<R: Runtime>(_app: AppHandle<R>, package_name: String) -> Result<(), String> {
    validate_package_name(&package_name)?;
    #[cfg(target_os = "android")]
    {
        _app.state::<Native<R>>()
            .0
            .run_mobile_plugin::<()>(
                "openAppInfo",
                serde_json::json!({ "packageName": package_name }),
            )
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("App info is available in Hjem for Android.".into())
    }
}

#[tauri::command]
async fn open_home_settings<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        _app.state::<Native<R>>()
            .0
            .run_mobile_plugin::<()>("openHomeSettings", serde_json::json!({}))
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("Choosing Hjem as your home screen is available on Android.".into())
    }
}

/// Matches the limit the Android side enforces when reading a chosen file.
const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct SavedDocument {
    saved: bool,
}

#[derive(Serialize, Deserialize)]
struct OpenedDocument {
    #[serde(default)]
    text: Option<String>,
}

fn validate_document(file_name: &str, text: &str) -> Result<(), String> {
    if file_name.is_empty()
        || file_name.len() > 100
        || !file_name.ends_with(".json")
        || file_name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
    {
        return Err("Choose a file name ending in .json.".into());
    }
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err("This configuration is too large to save.".into());
    }
    Ok(())
}

/// Opens Android's save dialog. Resolves to false when the person cancels.
#[tauri::command]
async fn save_document<R: Runtime>(
    _app: AppHandle<R>,
    file_name: String,
    text: String,
) -> Result<bool, String> {
    validate_document(&file_name, &text)?;
    #[cfg(target_os = "android")]
    {
        _app.state::<Native<R>>()
            .0
            .run_mobile_plugin::<SavedDocument>(
                "saveDocument",
                serde_json::json!({ "fileName": file_name, "text": text }),
            )
            .map(|result| result.saved)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("Saving through the system file picker is available on Android.".into())
    }
}

/// Opens Android's file picker. Resolves to None when the person cancels.
#[tauri::command]
async fn open_document<R: Runtime>(_app: AppHandle<R>) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        _app.state::<Native<R>>()
            .0
            .run_mobile_plugin::<OpenedDocument>("openDocument", serde_json::json!({}))
            .map(|result| result.text)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("Opening through the system file picker is available on Android.".into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("launcher")
        .invoke_handler(tauri::generate_handler![
            get_status,
            list_apps,
            launch_app,
            uninstall_app,
            open_app_info,
            open_home_settings,
            save_document,
            open_document
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    _api.register_android_plugin("dk.madsbuch.hjem.launcher", "LauncherPlugin")?;
                _app.manage(Native(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{validate_document, validate_package_name, MAX_DOCUMENT_BYTES};

    #[test]
    fn documents_are_named_json_files_within_the_size_limit() {
        assert!(validate_document("hjem-configuration-2026-11-18.json", "{}").is_ok());
        for name in [
            "",
            "notes.txt",
            "../escape.json",
            "dir/file.json",
            "a:b.json",
            "line\nbreak.json",
        ] {
            assert!(validate_document(name, "{}").is_err(), "{name:?}");
        }
        assert!(validate_document(&format!("{}.json", "a".repeat(100)), "{}").is_err());
        assert!(validate_document("big.json", &"x".repeat(MAX_DOCUMENT_BYTES + 1)).is_err());
    }

    #[test]
    fn accepts_android_package_identifiers() {
        for package in [
            "com.android.settings",
            "com.sonos.acr2",
            "org.example.app_2",
            "android",
        ] {
            assert!(validate_package_name(package).is_ok(), "{package}");
        }
    }

    #[test]
    fn rejects_nonpackage_targets_before_dispatch() {
        for package in [
            "",
            " ",
            "package:com.example.app",
            "com.example/app",
            "com.example?user=10",
            "com.example#fragment",
            ".com.example",
            "com..example",
            "com.example.",
            "com.2example",
            "com.example\n",
            "com.æpp",
        ] {
            assert!(validate_package_name(package).is_err(), "{package:?}");
        }
        assert!(validate_package_name(&"a".repeat(256)).is_err());
    }
}
