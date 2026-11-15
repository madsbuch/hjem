//! All durable app state lives in this private SQLite database. Credentials are
//! protected by the app sandbox/file permissions, not by database encryption.

use crate::concierge::{apply_settings, StoredSettings};
use crate::schema::*;
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sqlite::{Sqlite, SqliteConnection};
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");
const NATIVE_IMPORT: &str = "concierge-json-v1";
const WEB_IMPORT: &str = "web-preferences-v1";
const LEGACY_LIMIT: u64 = 16 * 1024;
const LEGACY_BYTES: usize = 16 * 1024;
const MAX_SCOPES: usize = 128;
type Result<T> = std::result::Result<T, StorageError>;

#[derive(Debug)]
pub(crate) struct StorageError(String);

impl std::fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for StorageError {}
impl From<diesel::result::Error> for StorageError {
    fn from(_: diesel::result::Error) -> Self {
        Self("Hjem could not read or save its database. Your saved data has not been reset. Please retry.".into())
    }
}
fn error(message: &str) -> StorageError {
    StorageError(message.to_owned())
}

// Store enum values as constrained SQL text, preserving the same type at the IPC
// boundary and in Diesel queries. Unknown persisted values are errors.
macro_rules! text_enum {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, diesel::expression::AsExpression, diesel::deserialize::FromSqlRow)]
        #[serde(rename_all = "lowercase")]
        #[diesel(sql_type = diesel::sql_types::Text)]
        pub enum $name { $($variant),+ }
        impl diesel::serialize::ToSql<diesel::sql_types::Text, Sqlite> for $name {
            fn to_sql<'b>(&'b self, output: &mut diesel::serialize::Output<'b, '_, Sqlite>) -> diesel::serialize::Result {
                output.set_value(match self { $(Self::$variant => $value),+ });
                Ok(diesel::serialize::IsNull::No)
            }
        }
        impl diesel::deserialize::FromSql<diesel::sql_types::Text, Sqlite> for $name {
            fn from_sql(value: diesel::sqlite::SqliteValue<'_, '_, '_>) -> diesel::deserialize::Result<Self> {
                let text: String = diesel::deserialize::FromSql::<diesel::sql_types::Text, Sqlite>::from_sql(value)?;
                match text.as_str() { $($value => Ok(Self::$variant),)+ _ => Err("Invalid stored preference.".into()) }
            }
        }
    };
}
text_enum!(Theme { System => "system", Light => "light", Dark => "dark" });
text_enum!(AppScope { Demo => "demo", Android => "android" });

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedConnection {
    server_url: String,
    token: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedApps {
    scope: AppScope,
    package_names: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Favourites {
    scope: String,
    entity_ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedSpeaker {
    scope: String,
    entity_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSnapshot {
    server_url: String,
    connection: Option<SavedConnection>,
    theme: Theme,
    pinned_apps: Vec<PinnedApps>,
    favourites: Vec<Favourites>,
    selected_speakers: Vec<SelectedSpeaker>,
    legacy_import_complete: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyPreferences {
    server_url: Option<String>,
    theme: Option<Theme>,
    #[serde(default)]
    pinned_apps: Vec<PinnedApps>,
    #[serde(default)]
    favourites: Vec<Favourites>,
    #[serde(default)]
    selected_speakers: Vec<SelectedSpeaker>,
    concierge_model: Option<String>,
}

#[derive(Default)]
pub struct DatabaseState(Mutex<Option<Database>>);

pub(crate) fn with_database<T>(
    app: &AppHandle,
    state: &DatabaseState,
    operation: impl FnOnce(&mut Database) -> Result<T>,
) -> std::result::Result<T, String> {
    let mut database = state
        .0
        .lock()
        .map_err(|_| "Hjem's database is unavailable. Restart Hjem to try again.")?;
    if database.is_none() {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|_| "Hjem's private data folder could not be located.")?;
        let config = app
            .path()
            .app_config_dir()
            .map_err(|_| "Hjem's previous settings folder could not be located.")?;
        // Failed initialization remains retryable, including a failed legacy
        // cleanup after a successful migration. Never replace an unreadable DB.
        *database = Some(
            Database::open(
                &directory.join("hjem.sqlite3"),
                &config.join("concierge.json"),
            )
            .map_err(|failure| failure.to_string())?,
        );
    }
    operation(database.as_mut().ok_or("Hjem's database is unavailable.")?)
        .map_err(|failure| failure.to_string())
}

pub(crate) struct Database {
    connection: SqliteConnection,
}

impl Database {
    fn open(path: &Path, legacy: &Path) -> Result<Self> {
        let directory = path
            .parent()
            .ok_or_else(|| error("Hjem's private data folder could not be located."))?;
        fs::create_dir_all(directory)
            .map_err(|_| error("Hjem's private data folder could not be created."))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| error("Hjem's private data folder could not be secured."))?;
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(path) {
            Ok(file) => file
                .sync_all()
                .map_err(|_| error("Hjem's database could not be created."))?,
            Err(failure) if failure.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(error("Hjem's database could not be created.")),
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|_| error("Hjem's database could not be secured."))?;
        }
        let location = path
            .to_str()
            .ok_or_else(|| error("Hjem's database path is unsupported."))?;
        let mut connection = SqliteConnection::establish(location).map_err(|_| error("Hjem's database could not be opened. Your saved data has not been reset. Please retry."))?;
        connection.batch_execute("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;")?;
        connection.run_pending_migrations(MIGRATIONS).map_err(|_| error("Hjem's database could not be upgraded. Your saved data has not been reset. Please retry."))?;
        let mut database = Self { connection };
        database.migrate_concierge_json(legacy)?;
        Ok(database)
    }

    fn migrate_concierge_json(&mut self, path: &Path) -> Result<()> {
        let imported = import_complete(&mut self.connection, NATIVE_IMPORT)?;
        if !imported {
            let settings = match File::open(path) {
                Ok(file) => {
                    let mut bytes = Vec::new();
                    file.take(LEGACY_LIMIT + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|_| {
                            error("Previous concierge settings could not be read. Please retry.")
                        })?;
                    if bytes.len() > LEGACY_BYTES {
                        return Err(error("Previous concierge settings are unreadable. They have not been removed."));
                    }
                    let previous: StoredSettings = serde_json::from_slice(&bytes).map_err(|_| error("Previous concierge settings are unreadable. They have not been removed."))?;
                    let mut validated = StoredSettings::default();
                    apply_settings(&mut validated, previous.api_key, previous.model)
                        .map_err(error_owned)?;
                    Some(validated)
                }
                Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => {
                    return Err(error(
                        "Previous concierge settings could not be read. Please retry.",
                    ))
                }
            };
            self.connection.transaction(|connection| {
                if let Some(settings) = settings {
                    write_concierge(connection, &settings)?;
                }
                mark_imported(connection, NATIVE_IMPORT)
            })?;
        }
        // This happens only after the SQL transaction commits. A cleanup error
        // is visible and retried without importing stale credentials again.
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(error("Settings were migrated, but the previous settings file could not be removed. Please retry.")),
        }
    }

    pub(crate) fn concierge_settings(&mut self) -> Result<StoredSettings> {
        read_concierge(&mut self.connection)
    }

    pub(crate) fn update_concierge(
        &mut self,
        update: impl FnOnce(&mut StoredSettings) -> std::result::Result<(), String>,
    ) -> Result<StoredSettings> {
        self.connection.transaction(|connection| {
            let mut settings = read_concierge(connection)?;
            update(&mut settings).map_err(error_owned)?;
            write_concierge(connection, &settings)?;
            Ok(settings)
        })
    }

    fn snapshot(&mut self) -> Result<StorageSnapshot> {
        self.connection.transaction(read_snapshot)
    }

    fn save_connection(&mut self, connection: SavedConnection) -> Result<()> {
        let server = normalize_server(&connection.server_url)?;
        validate_token(&connection.token)?;
        diesel::update(saved_connection::table.find(1))
            .set((
                saved_connection::server_url.eq(server),
                saved_connection::token.eq(Some(connection.token)),
            ))
            .execute(&mut self.connection)?;
        Ok(())
    }

    fn clear_connection(&mut self) -> Result<()> {
        diesel::update(saved_connection::table.find(1))
            .set((
                saved_connection::server_url.eq(""),
                saved_connection::token.eq(None::<String>),
            ))
            .execute(&mut self.connection)?;
        Ok(())
    }

    fn import_legacy(&mut self, legacy: LegacyPreferences) -> Result<StorageSnapshot> {
        self.connection.transaction(|connection| {
            if import_complete(connection, WEB_IMPORT)? {
                return read_snapshot(connection);
            }
            if legacy.pinned_apps.len() > 2
                || legacy.favourites.len() > MAX_SCOPES
                || legacy.selected_speakers.len() > MAX_SCOPES
            {
                return Err(error("Too many previous preferences were supplied."));
            }
            if let Some(server) = legacy.server_url.filter(|value| !value.is_empty()) {
                let server = normalize_server(&server)?;
                // Import old draft addresses without erasing a newer saved token.
                diesel::update(saved_connection::table.filter(saved_connection::server_url.eq("")))
                    .set(saved_connection::server_url.eq(server))
                    .execute(connection)?;
            }
            if let Some(theme) = legacy.theme {
                set_theme(connection, theme)?;
            }
            for pins in legacy.pinned_apps {
                set_pins(connection, pins.scope, pins.package_names)?;
            }
            for favourites in legacy.favourites {
                set_favourites(connection, favourites.scope, favourites.entity_ids)?;
            }
            for speaker in legacy.selected_speakers {
                set_speaker(connection, speaker.scope, speaker.entity_id)?;
            }
            if let Some(model) = legacy.concierge_model {
                let mut settings = read_concierge(connection)?;
                if settings.model.is_empty() {
                    apply_settings(&mut settings, None, model).map_err(error_owned)?;
                    write_concierge(connection, &settings)?;
                }
            }
            mark_imported(connection, WEB_IMPORT)?;
            read_snapshot(connection)
        })
    }
}

fn error_owned(message: String) -> StorageError {
    StorageError(message)
}

fn import_complete(connection: &mut SqliteConnection, name: &str) -> Result<bool> {
    Ok(import_status::table
        .find(name)
        .select(import_status::migration)
        .first::<String>(connection)
        .optional()?
        .is_some())
}
fn mark_imported(connection: &mut SqliteConnection, name: &str) -> Result<()> {
    diesel::insert_into(import_status::table)
        .values(import_status::migration.eq(name))
        .execute(connection)?;
    Ok(())
}
fn read_concierge(connection: &mut SqliteConnection) -> Result<StoredSettings> {
    let (api_key, model) = concierge_settings::table
        .find(1)
        .select((concierge_settings::api_key, concierge_settings::model))
        .first::<(Option<String>, String)>(connection)?;
    Ok(StoredSettings { api_key, model })
}
fn write_concierge(connection: &mut SqliteConnection, settings: &StoredSettings) -> Result<()> {
    diesel::update(concierge_settings::table.find(1))
        .set((
            concierge_settings::api_key.eq(&settings.api_key),
            concierge_settings::model.eq(&settings.model),
        ))
        .execute(connection)?;
    Ok(())
}
fn read_snapshot(connection: &mut SqliteConnection) -> Result<StorageSnapshot> {
    let (server_url, token) = saved_connection::table
        .find(1)
        .select((saved_connection::server_url, saved_connection::token))
        .first::<(String, Option<String>)>(connection)?;
    let saved = token.map(|token| SavedConnection {
        server_url: server_url.clone(),
        token,
    });
    let theme = app_preferences::table
        .find(1)
        .select(app_preferences::theme)
        .first::<Theme>(connection)?;
    let mut pinned = Vec::new();
    for scope in pin_scopes::table
        .order(pin_scopes::scope)
        .select(pin_scopes::scope)
        .load::<AppScope>(connection)?
    {
        let package_names = pinned_apps::table
            .filter(pinned_apps::scope.eq(scope))
            .order(pinned_apps::position)
            .select(pinned_apps::package_name)
            .load(connection)?;
        pinned.push(PinnedApps {
            scope,
            package_names,
        });
    }
    let mut favourite_lists = Vec::new();
    for scope in favourite_scopes::table
        .order(favourite_scopes::scope)
        .select(favourite_scopes::scope)
        .load::<String>(connection)?
    {
        let entity_ids = favourites::table
            .filter(favourites::scope.eq(&scope))
            .order(favourites::position)
            .select(favourites::entity_id)
            .load(connection)?;
        favourite_lists.push(Favourites { scope, entity_ids });
    }
    let speakers = selected_speakers::table
        .order(selected_speakers::scope)
        .select((selected_speakers::scope, selected_speakers::entity_id))
        .load::<(String, Option<String>)>(connection)?
        .into_iter()
        .map(|(scope, entity_id)| SelectedSpeaker { scope, entity_id })
        .collect();
    Ok(StorageSnapshot {
        server_url,
        connection: saved,
        theme,
        pinned_apps: pinned,
        favourites: favourite_lists,
        selected_speakers: speakers,
        legacy_import_complete: import_complete(connection, WEB_IMPORT)?,
    })
}

fn normalize_server(input: &str) -> Result<String> {
    let input = input.trim();
    if input.is_empty() || input.len() > 2048 || input.chars().any(char::is_control) {
        return Err(error("Enter a valid Home Assistant server address."));
    }
    let address = if input.contains("://") {
        input.to_owned()
    } else {
        format!("http://{input}")
    };
    let mut url = reqwest::Url::parse(&address)
        .map_err(|_| error("Enter a valid Home Assistant server address."))?;
    let scheme = match url.scheme() {
        "http" | "ws" => "http",
        "https" | "wss" => "https",
        _ => return Err(error("Use an http:// or https:// Home Assistant address.")),
    };
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(error(
            "Use only a server address without credentials, query parameters, or a fragment.",
        ));
    }
    url.set_scheme(scheme)
        .map_err(|_| error("Enter a valid Home Assistant server address."))?;
    let path = url
        .path()
        .trim_end_matches('/')
        .strip_suffix("/api/websocket")
        .unwrap_or(url.path().trim_end_matches('/'))
        .trim_end_matches('/')
        .to_owned();
    url.set_path(&path);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
fn validate_scope(scope: String) -> Result<String> {
    if scope == "demo" {
        Ok(scope)
    } else {
        normalize_server(&scope)
    }
}
fn validate_token(token: &str) -> Result<()> {
    if token.is_empty()
        || token.len() > 16384
        || token
            .chars()
            .any(|value| value.is_whitespace() || value.is_control())
    {
        Err(error("Enter a valid Home Assistant access token."))
    } else {
        Ok(())
    }
}
fn validate_entities(values: &[String]) -> Result<()> {
    validate_list(
        values,
        2000,
        |value| {
            value.len() <= 256
                && value
                    .split_once('.')
                    .is_some_and(|(domain, name)| !domain.is_empty() && !name.is_empty())
                && value.bytes().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, b'_' | b'.')
                })
        },
        "The saved Home Assistant entity list is invalid.",
    )
}
fn validate_list(
    values: &[String],
    limit: usize,
    valid: impl Fn(&str) -> bool,
    message: &str,
) -> Result<()> {
    let mut unique = HashSet::new();
    if values.len() > limit
        || values
            .iter()
            .any(|value| !valid(value) || !unique.insert(value))
    {
        Err(error(message))
    } else {
        Ok(())
    }
}
fn set_theme(connection: &mut SqliteConnection, theme: Theme) -> Result<()> {
    diesel::update(app_preferences::table.find(1))
        .set(app_preferences::theme.eq(theme))
        .execute(connection)?;
    Ok(())
}
fn set_pins(connection: &mut SqliteConnection, scope: AppScope, names: Vec<String>) -> Result<()> {
    validate_list(
        &names,
        256,
        |name| {
            !name.is_empty()
                && name.len() <= 255
                && name.bytes().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, b'.' | b'_' | b'-')
                })
        },
        "The pinned app list is invalid.",
    )?;
    diesel::insert_into(pin_scopes::table)
        .values(pin_scopes::scope.eq(scope))
        .on_conflict_do_nothing()
        .execute(connection)?;
    diesel::delete(pinned_apps::table.filter(pinned_apps::scope.eq(scope))).execute(connection)?;
    for (position, name) in names.into_iter().enumerate() {
        let position = i32::try_from(position).map_err(|_| error("Too many pinned apps."))?;
        diesel::insert_into(pinned_apps::table)
            .values((
                pinned_apps::scope.eq(scope),
                pinned_apps::package_name.eq(name),
                pinned_apps::position.eq(position),
            ))
            .execute(connection)?;
    }
    Ok(())
}
fn set_favourites(
    connection: &mut SqliteConnection,
    scope: String,
    entities: Vec<String>,
) -> Result<()> {
    let scope = validate_scope(scope)?;
    validate_entities(&entities)?;
    diesel::insert_into(favourite_scopes::table)
        .values(favourite_scopes::scope.eq(&scope))
        .on_conflict_do_nothing()
        .execute(connection)?;
    diesel::delete(favourites::table.filter(favourites::scope.eq(&scope))).execute(connection)?;
    for (position, entity) in entities.into_iter().enumerate() {
        let position =
            i32::try_from(position).map_err(|_| error("Too many favourite entities."))?;
        diesel::insert_into(favourites::table)
            .values((
                favourites::scope.eq(&scope),
                favourites::entity_id.eq(entity),
                favourites::position.eq(position),
            ))
            .execute(connection)?;
    }
    Ok(())
}
fn set_speaker(
    connection: &mut SqliteConnection,
    scope: String,
    entity: Option<String>,
) -> Result<()> {
    let scope = validate_scope(scope)?;
    if let Some(entity) = &entity {
        validate_entities(std::slice::from_ref(entity))?;
        if !entity.starts_with("media_player.") {
            return Err(error("Choose a valid media player."));
        }
    }
    diesel::insert_into(selected_speakers::table)
        .values((
            selected_speakers::scope.eq(&scope),
            selected_speakers::entity_id.eq(&entity),
        ))
        .on_conflict(selected_speakers::scope)
        .do_update()
        .set(selected_speakers::entity_id.eq(&entity))
        .execute(connection)?;
    Ok(())
}

#[tauri::command]
pub fn storage_load(
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> std::result::Result<StorageSnapshot, String> {
    with_database(&app, &state, Database::snapshot)
}
#[tauri::command]
pub fn storage_save_connection(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    connection: SavedConnection,
) -> std::result::Result<(), String> {
    with_database(&app, &state, |database| {
        database.save_connection(connection)
    })
}
#[tauri::command]
pub fn storage_clear_connection(
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> std::result::Result<(), String> {
    with_database(&app, &state, Database::clear_connection)
}
#[tauri::command]
pub fn storage_set_theme(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    theme: Theme,
) -> std::result::Result<(), String> {
    with_database(&app, &state, |database| {
        set_theme(&mut database.connection, theme)
    })
}
#[tauri::command]
pub fn storage_set_pinned_apps(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    scope: AppScope,
    package_names: Vec<String>,
) -> std::result::Result<(), String> {
    with_database(&app, &state, |database| {
        database
            .connection
            .transaction(|connection| set_pins(connection, scope, package_names))
    })
}
#[tauri::command]
pub fn storage_set_favourites(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    scope: String,
    entity_ids: Vec<String>,
) -> std::result::Result<(), String> {
    with_database(&app, &state, |database| {
        database
            .connection
            .transaction(|connection| set_favourites(connection, scope, entity_ids))
    })
}
#[tauri::command]
pub fn storage_set_selected_speaker(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    scope: String,
    entity_id: Option<String>,
) -> std::result::Result<(), String> {
    with_database(&app, &state, |database| {
        set_speaker(&mut database.connection, scope, entity_id)
    })
}
#[tauri::command]
pub fn storage_import_legacy(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    legacy: LegacyPreferences,
) -> std::result::Result<StorageSnapshot, String> {
    with_database(&app, &state, |database| database.import_legacy(legacy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn database_restart_preserves_credentials_preferences_order_and_empty_scopes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private/hjem.sqlite3");
        let legacy = directory.path().join("concierge.json");
        let mut database = Database::open(&path, &legacy).unwrap();
        database
            .save_connection(SavedConnection {
                server_url: "https://home.example/assistant/".into(),
                token: "synthetic-ha-token".into(),
            })
            .unwrap();
        database.import_legacy(serde_json::from_value(json!({
            "serverUrl":"http://old.example:8123",
            "theme":"dark",
            "pinnedApps":[{"scope":"android","packageNames":["org.example.clock","org.example.music"]},{"scope":"demo","packageNames":[]}],
            "favourites":[{"scope":"https://home.example/assistant","entityIds":["light.kitchen","switch.office"]},{"scope":"demo","entityIds":[]}],
            "selectedSpeakers":[{"scope":"https://home.example/assistant","entityId":"media_player.sonos"},{"scope":"demo","entityId":null}],
            "conciergeModel":"provider/model"
        })).unwrap()).unwrap();
        database
            .update_concierge(|settings| {
                apply_settings(
                    settings,
                    Some("synthetic-api-key".into()),
                    "provider/new".into(),
                )
            })
            .unwrap();
        drop(database);
        let mut reopened = Database::open(&path, &legacy).unwrap();
        let snapshot = serde_json::to_value(reopened.snapshot().unwrap()).unwrap();
        assert_eq!(snapshot["serverUrl"], "https://home.example/assistant");
        assert_eq!(
            snapshot["connection"],
            json!({"serverUrl":"https://home.example/assistant","token":"synthetic-ha-token"})
        );
        assert_eq!(snapshot["theme"], "dark");
        assert_eq!(
            snapshot["pinnedApps"],
            json!([{"scope":"android","packageNames":["org.example.clock","org.example.music"]},{"scope":"demo","packageNames":[]}])
        );
        assert_eq!(
            snapshot["favourites"][0],
            json!({"scope":"demo","entityIds":[]})
        );
        assert_eq!(
            snapshot["favourites"][1]["entityIds"],
            json!(["light.kitchen", "switch.office"])
        );
        assert_eq!(
            snapshot["selectedSpeakers"][1]["entityId"],
            "media_player.sonos"
        );
        assert_eq!(snapshot["legacyImportComplete"], true);
        let settings = reopened.concierge_settings().unwrap();
        assert_eq!(settings.api_key.as_deref(), Some("synthetic-api-key"));
        assert_eq!(settings.model, "provider/new");
        assert!(fs::read(&path).unwrap().starts_with(b"SQLite format 3\0"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        reopened.clear_connection().unwrap();
        reopened
            .update_concierge(|settings| {
                settings.api_key = None;
                Ok(())
            })
            .unwrap();
        drop(reopened);
        let mut reopened = Database::open(&path, &legacy).unwrap();
        assert!(reopened.snapshot().unwrap().connection.is_none());
        assert!(reopened.snapshot().unwrap().server_url.is_empty());
        assert!(reopened.concierge_settings().unwrap().api_key.is_none());
    }

    #[test]
    fn native_json_migration_commits_before_removal_and_never_replays_old_keys() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hjem.sqlite3");
        let legacy = directory.path().join("concierge.json");
        let previous = json!({"apiKey":"synthetic-old-key","model":"provider/old"});
        fs::write(&legacy, previous.to_string()).unwrap();
        let mut database = Database::open(&path, &legacy).unwrap();
        assert!(!legacy.exists());
        assert_eq!(
            database.concierge_settings().unwrap().api_key.as_deref(),
            Some("synthetic-old-key")
        );
        database
            .update_concierge(|settings| {
                apply_settings(
                    settings,
                    Some("synthetic-new-key".into()),
                    "provider/new".into(),
                )
            })
            .unwrap();
        drop(database);
        // Simulate a stale file surviving cleanup on a previous launch.
        fs::write(&legacy, previous.to_string()).unwrap();
        let mut reopened = Database::open(&path, &legacy).unwrap();
        assert!(!legacy.exists());
        assert_eq!(
            reopened.concierge_settings().unwrap().api_key.as_deref(),
            Some("synthetic-new-key")
        );
        assert_eq!(reopened.concierge_settings().unwrap().model, "provider/new");
    }

    #[test]
    fn malformed_legacy_file_is_preserved_and_can_be_retried() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hjem.sqlite3");
        let legacy = directory.path().join("concierge.json");
        fs::write(&legacy, "{bad json").unwrap();
        assert!(Database::open(&path, &legacy).is_err());
        assert_eq!(fs::read_to_string(&legacy).unwrap(), "{bad json");
        fs::write(
            &legacy,
            json!({"apiKey":null,"model":"provider/recovered"}).to_string(),
        )
        .unwrap();
        let mut database = Database::open(&path, &legacy).unwrap();
        assert_eq!(
            database.concierge_settings().unwrap().model,
            "provider/recovered"
        );
        assert!(!legacy.exists());
    }

    #[test]
    fn web_import_is_atomic_and_once_only_and_draft_address_has_no_connection() {
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(
            &directory.path().join("hjem.sqlite3"),
            &directory.path().join("missing.json"),
        )
        .unwrap();
        let invalid = serde_json::from_value(json!({"theme":"dark","pinnedApps":[{"scope":"demo","packageNames":["clock"]}],"favourites":[{"scope":"demo","entityIds":["not-an-entity"]}]})).unwrap();
        assert!(database.import_legacy(invalid).is_err());
        let snapshot = database.snapshot().unwrap();
        assert_eq!(snapshot.theme, Theme::System);
        assert!(snapshot.pinned_apps.is_empty());
        assert!(!snapshot.legacy_import_complete);
        let valid =
            serde_json::from_value(json!({"serverUrl":"homeassistant.local:8123/","theme":"dark"}))
                .unwrap();
        let snapshot = database.import_legacy(valid).unwrap();
        assert_eq!(snapshot.server_url, "http://homeassistant.local:8123");
        assert!(snapshot.connection.is_none());
        assert!(snapshot.legacy_import_complete);
        let replay = serde_json::from_value(json!({"theme":"light"})).unwrap();
        assert_eq!(database.import_legacy(replay).unwrap().theme, Theme::Dark);
    }

    #[test]
    fn unreadable_database_is_not_reset_and_invalid_input_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hjem.sqlite3");
        fs::write(&path, "not a database").unwrap();
        assert!(Database::open(&path, &directory.path().join("missing.json")).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "not a database");
        for address in [
            "file:///tmp/example",
            "https://user:secret@home.example",
            "https://home.example?token=secret",
            "https://home.example/#token",
        ] {
            assert!(normalize_server(address).is_err());
        }
        assert!(validate_token("").is_err());
        assert!(validate_token("secret with spaces").is_err());
        assert!(serde_json::from_value::<Theme>(json!("invalid")).is_err());
        assert!(serde_json::from_value::<SavedConnection>(
            json!({"serverUrl":"https://home.example","token":"synthetic","extra":true})
        )
        .is_err());
    }
}
