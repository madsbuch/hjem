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

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("launcher")
        .invoke_handler(tauri::generate_handler![
            get_status,
            list_apps,
            launch_app,
            uninstall_app,
            open_app_info,
            open_home_settings
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
    use super::validate_package_name;

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
