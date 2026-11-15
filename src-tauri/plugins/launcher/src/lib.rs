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
            .run_mobile_plugin::<serde_json::Value>(
                "launchApp",
                serde_json::json!({ "packageName": package_name }),
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = package_name;
        Err("Installed apps can only be opened in Hjem for Android.".into())
    }
}

#[tauri::command]
async fn open_home_settings<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        _app.state::<Native<R>>()
            .0
            .run_mobile_plugin::<serde_json::Value>("openHomeSettings", serde_json::json!({}))
            .map(|_| ())
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
