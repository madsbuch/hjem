//! All durable app state lives in this private SQLite database. Credentials are
//! protected by the app sandbox/file permissions, not by database encryption.

use crate::concierge::{apply_settings, StoredSettings};
use crate::concierge_history::{ChatRecord, ChatSummary};
use crate::electricity::StoredElectricity;
use crate::schema::*;
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sqlite::{Sqlite, SqliteConnection};
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");
const NATIVE_IMPORT: &str = "concierge-json-v1";
const WEB_IMPORT: &str = "web-preferences-v1";
const LEGACY_LIMIT: u64 = 16 * 1024;
const LEGACY_BYTES: usize = 16 * 1024;
const MAX_SCOPES: usize = 128;
const MAX_CALENDAR_FEEDS: i64 = 64;
const CALENDAR_BYTES: usize = 2 * 1024 * 1024;
const CALENDAR_LENGTH: u64 = 2 * 1024 * 1024;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenApps {
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

#[derive(Serialize, Queryable, Selectable)]
#[serde(rename_all = "camelCase")]
#[diesel(table_name = calendar_feeds)]
#[diesel(check_for_backend(Sqlite))]
pub struct CalendarFeed {
    id: i32,
    name: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSnapshot {
    server_url: String,
    connection: Option<SavedConnection>,
    theme: Theme,
    pinned_apps: Vec<PinnedApps>,
    hidden_apps: Vec<HiddenApps>,
    favourites: Vec<Favourites>,
    selected_speakers: Vec<SelectedSpeaker>,
    calendar_feeds: Vec<CalendarFeed>,
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

    pub(crate) fn list_concierge_chats(&mut self) -> Result<Vec<ChatSummary>> {
        let summaries = concierge_chats::table
            .order((
                concierge_chats::updated_at.desc(),
                concierge_chats::id.asc(),
            ))
            .select(ChatSummary::as_select())
            .load::<ChatSummary>(&mut self.connection)?;
        for summary in &summaries {
            summary.validate().map_err(error_owned)?;
        }
        Ok(summaries)
    }

    pub(crate) fn load_concierge_chat(&mut self, id: &str) -> Result<Option<ChatRecord>> {
        read_concierge_chat(&mut self.connection, id)
    }

    pub(crate) fn save_concierge_chat(&mut self, chat: &ChatRecord) -> Result<()> {
        chat.validate().map_err(error_owned)?;
        let messages_json = serde_json::to_string(&chat.messages)
            .map_err(|_| error(crate::concierge_history::UNREADABLE))?;
        let count = i32::try_from(chat.messages.len())
            .map_err(|_| error(crate::concierge_history::UNREADABLE))?;
        self.connection.transaction(|connection| {
            if let Some(previous) = read_concierge_chat(connection, &chat.id)? {
                if !previous.accepts_update(chat).map_err(error_owned)? {
                    return Ok(());
                }
            }
            diesel::insert_into(concierge_chats::table)
                .values((
                    concierge_chats::id.eq(&chat.id),
                    concierge_chats::title.eq(&chat.title),
                    concierge_chats::created_at.eq(chat.created_at),
                    concierge_chats::updated_at.eq(chat.updated_at),
                    concierge_chats::model.eq(&chat.model),
                    concierge_chats::home_key.eq(&chat.home_key),
                    concierge_chats::message_count.eq(count),
                    concierge_chats::messages_json.eq(&messages_json),
                ))
                .on_conflict(concierge_chats::id)
                .do_update()
                .set((
                    concierge_chats::title.eq(&chat.title),
                    concierge_chats::updated_at.eq(chat.updated_at),
                    concierge_chats::model.eq(&chat.model),
                    concierge_chats::message_count.eq(count),
                    concierge_chats::messages_json.eq(&messages_json),
                ))
                .execute(connection)?;
            Ok(())
        })
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

    pub(crate) fn electricity_settings(&mut self) -> Result<StoredElectricity> {
        read_electricity(&mut self.connection)
    }

    pub(crate) fn update_electricity(
        &mut self,
        update: impl FnOnce(&mut StoredElectricity) -> std::result::Result<(), String>,
    ) -> Result<StoredElectricity> {
        self.connection.transaction(|connection| {
            let mut settings = read_electricity(connection)?;
            update(&mut settings).map_err(error_owned)?;
            diesel::update(electricity_settings::table.find(1))
                .set((
                    electricity_settings::api_key.eq(&settings.api_key),
                    electricity_settings::location_id.eq(&settings.location_id),
                ))
                .execute(connection)?;
            Ok(settings)
        })
    }

    fn snapshot(&mut self) -> Result<StorageSnapshot> {
        self.connection.transaction(read_snapshot)
    }

    pub(crate) fn scene_connection(&mut self, expected_server: &str) -> Result<(String, String)> {
        let (server, token) = saved_connection::table
            .find(1)
            .select((saved_connection::server_url, saved_connection::token))
            .first::<(String, Option<String>)>(&mut self.connection)?;
        if server != expected_server || normalize_server(&server)? != server {
            return Err(error(
                "The saved home connection changed. Reconnect before managing moods.",
            ));
        }
        let token = token
            .filter(|value| !value.is_empty())
            .ok_or_else(|| error("Connect Home Assistant in Settings before managing moods."))?;
        Ok((server, token))
    }

    fn set_app_hidden(
        &mut self,
        scope: AppScope,
        package_name: String,
        hidden: bool,
    ) -> Result<()> {
        if !valid_package_name(&package_name) {
            return Err(error("Choose a valid app package name."));
        }
        self.connection.transaction(|connection| {
            if hidden {
                diesel::insert_into(hidden_apps::table)
                    .values((
                        hidden_apps::scope.eq(scope),
                        hidden_apps::package_name.eq(&package_name),
                    ))
                    .on_conflict_do_nothing()
                    .execute(connection)?;
            } else {
                diesel::delete(hidden_apps::table.find((scope, &package_name)))
                    .execute(connection)?;
            }
            // Visibility is independent of installed-app discovery and pins.
            // Restoring an app therefore also restores its existing pin.
            Ok(())
        })
    }

    fn add_calendar_feed(&mut self, name: String, url: String) -> Result<CalendarFeed> {
        let name = validate_calendar_name(&name)?;
        let url = normalize_calendar_url(&url)?;
        self.connection.transaction(|connection| {
            let count = calendar_feeds::table
                .count()
                .get_result::<i64>(connection)?;
            if count >= MAX_CALENDAR_FEEDS {
                return Err(error(
                    "You can subscribe to up to 64 calendars. Remove one before adding another.",
                ));
            }
            if calendar_feeds::table
                .filter(calendar_feeds::url.eq(&url))
                .select(calendar_feeds::id)
                .first::<i32>(connection)
                .optional()?
                .is_some()
            {
                return Err(error("This calendar link is already subscribed."));
            }
            diesel::insert_into(calendar_feeds::table)
                .values((calendar_feeds::name.eq(name), calendar_feeds::url.eq(&url)))
                .execute(connection)?;
            Ok(calendar_feeds::table
                .filter(calendar_feeds::url.eq(&url))
                .select(CalendarFeed::as_select())
                .first(connection)?)
        })
    }

    fn update_calendar_feed(&mut self, id: i32, name: String, url: String) -> Result<CalendarFeed> {
        validate_calendar_id(id)?;
        let name = validate_calendar_name(&name)?;
        let url = normalize_calendar_url(&url)?;
        self.connection.transaction(|connection| {
            if calendar_feeds::table
                .find(id)
                .select(calendar_feeds::id)
                .first::<i32>(connection)
                .optional()?
                .is_none()
            {
                return Err(error("This calendar subscription no longer exists."));
            }
            if calendar_feeds::table
                .filter(calendar_feeds::url.eq(&url))
                .filter(calendar_feeds::id.ne(id))
                .select(calendar_feeds::id)
                .first::<i32>(connection)
                .optional()?
                .is_some()
            {
                return Err(error("This calendar link is already subscribed."));
            }
            diesel::update(calendar_feeds::table.find(id))
                .set((calendar_feeds::name.eq(name), calendar_feeds::url.eq(&url)))
                .execute(connection)?;
            Ok(calendar_feeds::table
                .find(id)
                .select(CalendarFeed::as_select())
                .first(connection)?)
        })
    }

    fn remove_calendar_feed(&mut self, id: i32) -> Result<()> {
        validate_calendar_id(id)?;
        diesel::delete(calendar_feeds::table.find(id)).execute(&mut self.connection)?;
        Ok(())
    }

    fn calendar_url(&mut self, id: i32) -> Result<String> {
        validate_calendar_id(id)?;
        calendar_feeds::table
            .find(id)
            .select(calendar_feeds::url)
            .first::<String>(&mut self.connection)
            .optional()?
            .ok_or_else(|| error("This calendar subscription no longer exists."))
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

fn read_concierge_chat(connection: &mut SqliteConnection, id: &str) -> Result<Option<ChatRecord>> {
    let row = concierge_chats::table
        .find(id)
        .select((ChatSummary::as_select(), concierge_chats::messages_json))
        .first::<(ChatSummary, String)>(connection)
        .optional()?;
    let Some((summary, messages_json)) = row else {
        return Ok(None);
    };
    if messages_json.len() > crate::concierge_history::MAX_BYTES {
        return Err(error(crate::concierge_history::UNREADABLE));
    }
    let messages = serde_json::from_str(&messages_json)
        .map_err(|_| error(crate::concierge_history::UNREADABLE))?;
    let chat = ChatRecord {
        id: summary.id,
        title: summary.title,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
        model: summary.model,
        home_key: summary.home_key,
        messages,
    };
    chat.validate().map_err(error_owned)?;
    if usize::try_from(summary.message_count).ok() != Some(chat.messages.len()) {
        return Err(error(crate::concierge_history::UNREADABLE));
    }
    Ok(Some(chat))
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
fn read_electricity(connection: &mut SqliteConnection) -> Result<StoredElectricity> {
    let (api_key, location_id) = electricity_settings::table
        .find(1)
        .select((
            electricity_settings::api_key,
            electricity_settings::location_id,
        ))
        .first::<(Option<String>, Option<String>)>(connection)?;
    Ok(StoredElectricity {
        api_key,
        location_id,
    })
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
    let mut hidden = Vec::new();
    for scope in hidden_apps::table
        .select(hidden_apps::scope)
        .distinct()
        .order(hidden_apps::scope)
        .load::<AppScope>(connection)?
    {
        let package_names = hidden_apps::table
            .filter(hidden_apps::scope.eq(scope))
            .order(hidden_apps::package_name)
            .select(hidden_apps::package_name)
            .load(connection)?;
        hidden.push(HiddenApps {
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
        hidden_apps: hidden,
        favourites: favourite_lists,
        selected_speakers: speakers,
        calendar_feeds: calendar_feeds::table
            .order(calendar_feeds::id)
            .select(CalendarFeed::as_select())
            .load(connection)?,
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
fn valid_package_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name.bytes().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, b'.' | b'_' | b'-')
        })
}
fn set_pins(connection: &mut SqliteConnection, scope: AppScope, names: Vec<String>) -> Result<()> {
    validate_list(
        &names,
        256,
        valid_package_name,
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
pub fn storage_set_app_hidden(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    scope: AppScope,
    package_name: String,
    hidden: bool,
) -> std::result::Result<(), String> {
    with_database(&app, &state, |database| {
        database.set_app_hidden(scope, package_name, hidden)
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

fn validate_calendar_id(id: i32) -> Result<()> {
    if id <= 0 {
        Err(error("Choose a valid calendar subscription."))
    } else {
        Ok(())
    }
}

fn validate_calendar_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
        return Err(error("Give this calendar a name of 1–120 characters."));
    }
    Ok(name)
}

fn calendar_url_allowed(url: &reqwest::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn normalize_calendar_url(input: &str) -> Result<String> {
    let input = input.trim();
    if input.is_empty() || input.len() > 8192 || input.chars().any(char::is_control) {
        return Err(error("Enter a valid calendar subscription link."));
    }
    let address = match input.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("webcal") => format!("https://{rest}"),
        _ => input.to_owned(),
    };
    let url = reqwest::Url::parse(&address)
        .map_err(|_| error("Enter a complete http://, https://, or webcal:// calendar link."))?;
    if !calendar_url_allowed(&url) {
        return Err(error("Use an http://, https://, or webcal:// calendar link without a username, password, or fragment."));
    }
    Ok(url.into())
}

fn calendar_client() -> std::result::Result<reqwest::Client, String> {
    static CLIENT: OnceLock<std::result::Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .referer(false)
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    let downgrade = attempt.previous().last().is_some_and(|previous| {
                        previous.scheme() == "https" && attempt.url().scheme() == "http"
                    });
                    if attempt.previous().len() >= 5
                        || !calendar_url_allowed(attempt.url())
                        || downgrade
                    {
                        attempt.error("This calendar redirect is unsupported.")
                    } else {
                        attempt.follow()
                    }
                }))
                .user_agent(concat!("Hjem/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|_| "The calendar connection could not be prepared.".into())
        })
        .clone()
}

#[tauri::command]
pub fn calendar_add_feed(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    name: String,
    url: String,
) -> std::result::Result<CalendarFeed, String> {
    with_database(&app, &state, |database| {
        database.add_calendar_feed(name, url)
    })
}

#[tauri::command]
pub fn calendar_update_feed(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    id: i32,
    name: String,
    url: String,
) -> std::result::Result<CalendarFeed, String> {
    with_database(&app, &state, |database| {
        database.update_calendar_feed(id, name, url)
    })
}

#[tauri::command]
pub fn calendar_remove_feed(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    id: i32,
) -> std::result::Result<(), String> {
    with_database(&app, &state, |database| database.remove_calendar_feed(id))
}

#[tauri::command]
pub async fn calendar_fetch_feed(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    id: i32,
) -> std::result::Result<String, String> {
    let url = with_database(&app, &state, |database| database.calendar_url(id))?;
    fetch_calendar(&url).await
}

async fn fetch_calendar(url: &str) -> std::result::Result<String, String> {
    // Revalidate persisted URLs before every fetch. Never echo provider errors
    // or private subscription links, which often contain access tokens.
    let url = normalize_calendar_url(url).map_err(|failure| failure.to_string())?;
    let response = calendar_client()?
        .get(url.as_str())
        .header(
            reqwest::header::ACCEPT,
            "text/calendar, text/plain;q=0.9, */*;q=0.1",
        )
        .send()
        .await
        .map_err(|failure| {
            if failure.is_timeout() {
                "This calendar took too long to respond. Please retry."
            } else {
                "This calendar could not be reached. Check the link and your connection."
            }
            .to_owned()
        })?;
    if !response.status().is_success() {
        return Err(calendar_status_error(response.status().as_u16(), &url));
    }
    if response
        .content_length()
        .is_some_and(|length| length > CALENDAR_LENGTH)
    {
        return Err("This calendar is larger than the 2 MiB limit.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "This calendar download was interrupted. Please retry.")?;
        if bytes.len().saturating_add(chunk.len()) > CALENDAR_BYTES {
            return Err("This calendar is larger than the 2 MiB limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "This calendar is not valid UTF-8 text.".into())
}

fn calendar_status_error(status: u16, address: &str) -> String {
    let google_public = reqwest::Url::parse(address).is_ok_and(|url| {
        url.host_str() == Some("calendar.google.com")
            && url.path().starts_with("/calendar/ical/")
            && url.path().contains("/public/")
            && url.path().ends_with(".ics")
    });
    if matches!(status, 401 | 403 | 404 | 410) && google_public {
        return "This Google Calendar public link is not accessible. The calendar may not be shared publicly, or the address may be incorrect. In Google Calendar → Settings → select the calendar → Integrate calendar, copy “Secret address in iCal format” instead.".into();
    }
    match status {
        401 | 403 => "This calendar link is not authorized. Use the calendar’s private iCal/ICS subscription address.".into(),
        404 | 410 => format!("This calendar link is unavailable (HTTP {status}). Check its iCal/ICS subscription address and sharing settings."),
        429 => "This calendar is temporarily rate limited. Please try again shortly.".into(),
        _ => "The calendar provider could not supply this calendar. Please try again shortly.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::concierge_history::{ChatMessage, ChatRole};
    use diesel::migration::MigrationSource;
    use serde_json::json;

    fn chat_record(id: &str, updated_at: i64) -> ChatRecord {
        ChatRecord {
            id: id.into(),
            title: "Which lights are on?".into(),
            created_at: 100,
            updated_at,
            model: "provider/model".into(),
            home_key: "demo".into(),
            messages: vec![
                ChatMessage {
                    id: "user-1".into(),
                    role: ChatRole::User,
                    text: "Which lights are on?".into(),
                },
                ChatMessage {
                    id: "activity-1".into(),
                    role: ChatRole::Activity,
                    text: "Checking your home · done".into(),
                },
                ChatMessage {
                    id: "assistant-1".into(),
                    role: ChatRole::Assistant,
                    text: "**Kitchen** and living room.".into(),
                },
            ],
        }
    }

    #[test]
    fn concierge_transcripts_survive_restart_and_list_every_home_without_a_cap() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hjem.sqlite3");
        let legacy = directory.path().join("missing.json");
        let mut database = Database::open(&path, &legacy).unwrap();
        let original = chat_record("chat-0", 200);
        database.save_concierge_chat(&original).unwrap();
        for index in 1..150 {
            let mut chat = chat_record(&format!("chat-{index}"), 200 + index);
            chat.home_key = format!("home-{}", index % 3);
            database.save_concierge_chat(&chat).unwrap();
        }
        drop(database);
        let mut reopened = Database::open(&path, &legacy).unwrap();
        let summaries = reopened.list_concierge_chats().unwrap();
        assert_eq!(summaries.len(), 150);
        assert_eq!(summaries.first().unwrap().id, "chat-149");
        assert_eq!(summaries.last().unwrap().id, "chat-0");
        assert!(summaries.iter().all(|item| item.message_count == 3));
        let loaded = reopened.load_concierge_chat("chat-0").unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&loaded).unwrap(),
            serde_json::to_value(&original).unwrap()
        );
        assert!(reopened.load_concierge_chat("missing").unwrap().is_none());
    }

    #[test]
    fn concierge_updates_preserve_identity_and_reject_lost_history() {
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(
            &directory.path().join("hjem.sqlite3"),
            &directory.path().join("missing.json"),
        )
        .unwrap();
        let original = chat_record("chat-1", 200);
        database.save_concierge_chat(&original).unwrap();
        let mut updated = original.clone();
        updated.updated_at = 300;
        updated.messages.push(ChatMessage {
            id: "user-2".into(),
            role: ChatRole::User,
            text: "Turn off the kitchen light".into(),
        });
        database.save_concierge_chat(&updated).unwrap();
        // A delayed save cannot replace the newer, longer transcript.
        database.save_concierge_chat(&original).unwrap();
        for changed in ["home", "creation", "messages"] {
            let mut invalid = updated.clone();
            invalid.updated_at = 400;
            match changed {
                "home" => invalid.home_key = "another-home".into(),
                "creation" => invalid.created_at = 101,
                _ => {
                    invalid.messages.pop();
                }
            }
            assert!(database.save_concierge_chat(&invalid).is_err());
        }
        assert_eq!(database.list_concierge_chats().unwrap().len(), 1);
        let loaded = database.load_concierge_chat("chat-1").unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(loaded).unwrap(),
            serde_json::to_value(updated).unwrap()
        );
    }

    #[test]
    fn concierge_corrupt_transcripts_fail_without_resetting_saved_chats() {
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(
            &directory.path().join("hjem.sqlite3"),
            &directory.path().join("missing.json"),
        )
        .unwrap();
        database
            .save_concierge_chat(&chat_record("chat-1", 200))
            .unwrap();
        diesel::update(concierge_chats::table.find("chat-1"))
            .set(concierge_chats::messages_json.eq("{unreadable transcript"))
            .execute(&mut database.connection)
            .unwrap();
        let error = database
            .load_concierge_chat("chat-1")
            .unwrap_err()
            .to_string();
        assert!(error.contains("saved chats have not been changed"));
        assert!(!error.contains("unreadable transcript"));
        assert_eq!(database.list_concierge_chats().unwrap().len(), 1);
        assert!(database
            .save_concierge_chat(&chat_record("chat-1", 300))
            .is_err());
        let stored = concierge_chats::table
            .find("chat-1")
            .select(concierge_chats::messages_json)
            .first::<String>(&mut database.connection)
            .unwrap();
        assert_eq!(stored, "{unreadable transcript");
    }

    #[test]
    fn concierge_concurrent_branches_cannot_replace_a_saved_transcript() {
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(
            &directory.path().join("hjem.sqlite3"),
            &directory.path().join("missing.json"),
        )
        .unwrap();
        let original = chat_record("chat-1", 200);
        database.save_concierge_chat(&original).unwrap();
        let mut latest = original.clone();
        latest.updated_at = 300;
        latest.messages.push(ChatMessage {
            id: "user-2".into(),
            role: ChatRole::User,
            text: "What about upstairs?".into(),
        });
        latest.messages.push(ChatMessage {
            id: "error-1".into(),
            role: ChatRole::Error,
            text: "The home could not be reached.".into(),
        });
        database.save_concierge_chat(&latest).unwrap();
        for timestamp in [299, 300, 301] {
            for changed in ["id", "role", "user", "assistant", "error"] {
                let mut branch = latest.clone();
                branch.updated_at = timestamp;
                match changed {
                    "id" => branch.messages[3].id = "other-user-2".into(),
                    "role" => branch.messages[3].role = ChatRole::Assistant,
                    "user" => branch.messages[0].text = "A different question".into(),
                    "assistant" => branch.messages[2].text = "A different answer".into(),
                    _ => branch.messages[4].text = "A different error".into(),
                }
                let error = database
                    .save_concierge_chat(&branch)
                    .unwrap_err()
                    .to_string();
                assert!(error.contains("newer version"));
                let loaded = database.load_concierge_chat("chat-1").unwrap().unwrap();
                assert_eq!(
                    serde_json::to_value(loaded).unwrap(),
                    serde_json::to_value(&latest).unwrap()
                );
            }
        }
        // An actual earlier snapshot is harmless, and lifecycle updates to an
        // existing activity remain valid even when timestamps are equal.
        database.save_concierge_chat(&original).unwrap();
        latest.messages[1].text = "Checking your home · interrupted".into();
        database.save_concierge_chat(&latest).unwrap();
        let loaded = database.load_concierge_chat("chat-1").unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(loaded).unwrap(),
            serde_json::to_value(latest).unwrap()
        );
    }

    #[test]
    fn concierge_migration_preserves_existing_home_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hjem.sqlite3");
        let mut connection = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        assert!(connection.applied_migrations().unwrap().is_empty());
        let migrations = MIGRATIONS.migrations().unwrap();
        for migration in migrations.iter().take(migrations.len() - 1) {
            connection.run_migration(migration.as_ref()).unwrap();
        }
        set_theme(&mut connection, Theme::Dark).unwrap();
        drop(connection);
        let mut database = Database::open(&path, &directory.path().join("missing.json")).unwrap();
        assert_eq!(database.snapshot().unwrap().theme, Theme::Dark);
        assert!(database.list_concierge_chats().unwrap().is_empty());
        database
            .save_concierge_chat(&chat_record("first", 200))
            .unwrap();
        assert_eq!(database.list_concierge_chats().unwrap().len(), 1);
    }

    #[test]
    fn calendar_http_errors_explain_public_google_access_without_exposing_links() {
        let public = "https://calendar.google.com/calendar/ical/fixture%40group.calendar.google.com/public/basic.ics";
        for status in [401, 403, 404, 410] {
            let message = calendar_status_error(status, public);
            assert!(message.contains("may not be shared publicly"));
            assert!(message.contains("Secret address in iCal format"));
            assert!(!message.contains("fixture"));
        }
        let missing = calendar_status_error(
            404,
            "https://calendar.example/private-fixture-token/basic.ics",
        );
        assert!(missing.contains("unavailable (HTTP 404)"));
        assert!(!missing.contains("no longer exists"));
        assert!(!missing.contains("private-fixture-token"));
        let spoofed = calendar_status_error(
            404,
            "https://calendar.google.com.example/calendar/ical/fixture/public/basic.ics",
        );
        assert!(!spoofed.contains("Google"));
        assert!(calendar_status_error(429, public).contains("rate limited"));
        assert!(calendar_status_error(500, public).contains("provider could not supply"));
    }

    #[test]
    fn scene_transport_only_uses_the_current_saved_home() {
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(
            &directory.path().join("hjem.sqlite3"),
            &directory.path().join("missing.json"),
        )
        .unwrap();
        database
            .save_connection(SavedConnection {
                server_url: "https://home.example".into(),
                token: "fixture-secret".into(),
            })
            .unwrap();
        assert_eq!(
            database.scene_connection("https://home.example").unwrap(),
            ("https://home.example".into(), "fixture-secret".into())
        );
        let error = database
            .scene_connection("https://different.example")
            .unwrap_err()
            .to_string();
        assert!(error.contains("connection changed"));
        assert!(!error.contains("fixture-secret"));
        database.clear_connection().unwrap();
        assert!(database.scene_connection("https://home.example").is_err());
    }

    #[test]
    fn hidden_apps_survive_restart_without_changing_pins_or_requiring_installation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hjem.sqlite3");
        let legacy = directory.path().join("missing.json");
        let mut database = Database::open(&path, &legacy).unwrap();
        let pins = vec![
            "org.example.music".to_owned(),
            "org.example.clock".to_owned(),
        ];
        set_pins(&mut database.connection, AppScope::Android, pins.clone()).unwrap();
        database
            .set_app_hidden(AppScope::Android, "org.example.music".into(), true)
            .unwrap();
        database
            .set_app_hidden(AppScope::Android, "org.example.uninstalled".into(), true)
            .unwrap();
        drop(database);
        let mut reopened = Database::open(&path, &legacy).unwrap();
        let snapshot = serde_json::to_value(reopened.snapshot().unwrap()).unwrap();
        assert_eq!(
            snapshot["hiddenApps"],
            json!([{"scope":"android","packageNames":["org.example.music","org.example.uninstalled"]}])
        );
        assert_eq!(
            snapshot["pinnedApps"],
            json!([{"scope":"android","packageNames":pins}])
        );
        reopened
            .set_app_hidden(AppScope::Android, "org.example.music".into(), false)
            .unwrap();
        drop(reopened);
        let snapshot =
            serde_json::to_value(Database::open(&path, &legacy).unwrap().snapshot().unwrap())
                .unwrap();
        assert_eq!(
            snapshot["hiddenApps"],
            json!([{"scope":"android","packageNames":["org.example.uninstalled"]}])
        );
        assert_eq!(
            snapshot["pinnedApps"],
            json!([{"scope":"android","packageNames":pins}])
        );
    }

    #[test]
    fn hidden_app_updates_are_idempotent_and_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(
            &directory.path().join("hjem.sqlite3"),
            &directory.path().join("missing.json"),
        )
        .unwrap();
        for scope in [AppScope::Android, AppScope::Demo] {
            database
                .set_app_hidden(scope, "org.example.clock".into(), true)
                .unwrap();
            database
                .set_app_hidden(scope, "org.example.clock".into(), true)
                .unwrap();
        }
        assert_eq!(
            hidden_apps::table
                .count()
                .get_result::<i64>(&mut database.connection)
                .unwrap(),
            2
        );
        database
            .set_app_hidden(AppScope::Demo, "org.example.clock".into(), false)
            .unwrap();
        database
            .set_app_hidden(AppScope::Demo, "org.example.clock".into(), false)
            .unwrap();
        let snapshot = serde_json::to_value(database.snapshot().unwrap()).unwrap();
        assert_eq!(
            snapshot["hiddenApps"],
            json!([{"scope":"android","packageNames":["org.example.clock"]}])
        );
        assert_eq!(snapshot["pinnedApps"], json!([]));
        database
            .set_app_hidden(AppScope::Android, "org.example.clock".into(), false)
            .unwrap();
        assert!(database.snapshot().unwrap().hidden_apps.is_empty());
    }

    #[test]
    fn hidden_app_migration_preserves_existing_version_two_data() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hjem.sqlite3");
        let mut connection = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        assert!(connection.applied_migrations().unwrap().is_empty());
        for migration in MIGRATIONS.migrations().unwrap().iter().take(2) {
            connection.run_migration(migration.as_ref()).unwrap();
        }
        set_theme(&mut connection, Theme::Dark).unwrap();
        set_pins(&mut connection, AppScope::Demo, vec!["demo.clock".into()]).unwrap();
        set_favourites(&mut connection, "demo".into(), vec!["light.kitchen".into()]).unwrap();
        let mut previous = Database { connection };
        previous
            .save_connection(SavedConnection {
                server_url: "https://home.example".into(),
                token: "synthetic-token".into(),
            })
            .unwrap();
        previous
            .add_calendar_feed("Family".into(), "https://calendar.example/feed.ics".into())
            .unwrap();
        drop(previous);
        let mut upgraded = Database::open(&path, &directory.path().join("missing.json")).unwrap();
        let snapshot = serde_json::to_value(upgraded.snapshot().unwrap()).unwrap();
        assert_eq!(snapshot["hiddenApps"], json!([]));
        assert_eq!(snapshot["theme"], "dark");
        assert_eq!(
            snapshot["pinnedApps"],
            json!([{"scope":"demo","packageNames":["demo.clock"]}])
        );
        assert_eq!(
            snapshot["favourites"],
            json!([{"scope":"demo","entityIds":["light.kitchen"]}])
        );
        assert_eq!(snapshot["connection"]["token"], "synthetic-token");
        assert_eq!(snapshot["calendarFeeds"][0]["name"], "Family");
        upgraded
            .set_app_hidden(AppScope::Demo, "demo.clock".into(), true)
            .unwrap();
        assert_eq!(upgraded.snapshot().unwrap().hidden_apps.len(), 1);
    }

    #[test]
    fn invalid_hidden_app_updates_leave_existing_choices_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(
            &directory.path().join("hjem.sqlite3"),
            &directory.path().join("missing.json"),
        )
        .unwrap();
        database
            .set_app_hidden(AppScope::Android, "org.example.clock".into(), true)
            .unwrap();
        for name in [
            "",
            "org.example clock",
            "org/example",
            "org.example\nclock",
            "org.example.ø",
        ] {
            for hidden in [true, false] {
                assert!(database
                    .set_app_hidden(AppScope::Android, name.into(), hidden)
                    .is_err());
            }
        }
        assert!(database
            .set_app_hidden(AppScope::Android, "a".repeat(256), true)
            .is_err());
        assert!(serde_json::from_value::<AppScope>(json!("other")).is_err());
        let snapshot = serde_json::to_value(database.snapshot().unwrap()).unwrap();
        assert_eq!(
            snapshot["hiddenApps"],
            json!([{"scope":"android","packageNames":["org.example.clock"]}])
        );
    }

    #[test]
    fn calendar_subscriptions_survive_restart_and_removal_does_not_reuse_ids() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hjem.sqlite3");
        let legacy = directory.path().join("missing.json");
        let mut database = Database::open(&path, &legacy).unwrap();
        let first = database
            .add_calendar_feed(
                " Family ".into(),
                "webcal://calendar.example/private.ics?token=synthetic-secret".into(),
            )
            .unwrap();
        assert_eq!(first.name, "Family");
        assert_eq!(
            first.url,
            "https://calendar.example/private.ics?token=synthetic-secret"
        );
        assert!(database
            .add_calendar_feed("Duplicate".into(), first.url.clone())
            .is_err());
        let id = first.id;
        drop(database);
        let mut reopened = Database::open(&path, &legacy).unwrap();
        let feeds = reopened.snapshot().unwrap().calendar_feeds;
        assert_eq!(feeds.len(), 1);
        assert_eq!(feeds[0].id, id);
        assert_eq!(feeds[0].name, "Family");
        assert_eq!(reopened.calendar_url(id).unwrap(), first.url);
        reopened.remove_calendar_feed(id).unwrap();
        assert!(reopened.calendar_url(id).is_err());
        let next = reopened
            .add_calendar_feed("Work".into(), "https://calendar.example/work.ics".into())
            .unwrap();
        assert!(next.id > id);
        reopened.remove_calendar_feed(next.id).unwrap();
        drop(reopened);
        assert!(Database::open(&path, &legacy)
            .unwrap()
            .snapshot()
            .unwrap()
            .calendar_feeds
            .is_empty());
    }

    #[test]
    fn calendar_migration_upgrades_existing_database_without_resetting_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hjem.sqlite3");
        let mut connection = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        assert!(connection.applied_migrations().unwrap().is_empty());
        let migrations = MIGRATIONS.migrations().unwrap();
        connection.run_migration(migrations[0].as_ref()).unwrap();
        set_theme(&mut connection, Theme::Dark).unwrap();
        drop(connection);
        let mut database = Database::open(&path, &directory.path().join("missing.json")).unwrap();
        assert_eq!(database.snapshot().unwrap().theme, Theme::Dark);
        assert!(database.snapshot().unwrap().calendar_feeds.is_empty());
        database
            .add_calendar_feed(
                "Upgraded".into(),
                "https://calendar.example/feed.ics".into(),
            )
            .unwrap();
        assert_eq!(database.snapshot().unwrap().calendar_feeds.len(), 1);
    }

    #[test]
    fn calendar_edit_preserves_identity_and_survives_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hjem.sqlite3");
        let legacy = directory.path().join("missing.json");
        let mut database = Database::open(&path, &legacy).unwrap();
        let feed = database
            .add_calendar_feed(
                "Family".into(),
                "https://calendar.example/original.ics".into(),
            )
            .unwrap();
        let updated = database
            .update_calendar_feed(
                feed.id,
                " Family plans ".into(),
                "webcal://calendar.example/replacement.ics".into(),
            )
            .unwrap();
        assert_eq!(updated.id, feed.id);
        assert_eq!(updated.name, "Family plans");
        assert_eq!(updated.url, "https://calendar.example/replacement.ics");
        // Keeping an existing URL while renaming is allowed.
        database
            .update_calendar_feed(feed.id, "Family schedule".into(), updated.url.clone())
            .unwrap();
        drop(database);
        let mut reopened = Database::open(&path, &legacy).unwrap();
        let feeds = reopened.snapshot().unwrap().calendar_feeds;
        assert_eq!(feeds.len(), 1);
        assert_eq!(feeds[0].id, feed.id);
        assert_eq!(feeds[0].name, "Family schedule");
        assert_eq!(feeds[0].url, updated.url);
    }

    #[test]
    fn failed_calendar_edits_leave_the_original_subscription_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(
            &directory.path().join("hjem.sqlite3"),
            &directory.path().join("missing.json"),
        )
        .unwrap();
        let original = database
            .add_calendar_feed(
                "Family".into(),
                "https://calendar.example/family.ics".into(),
            )
            .unwrap();
        let other = database
            .add_calendar_feed("Work".into(), "https://calendar.example/work.ics".into())
            .unwrap();
        assert!(database
            .update_calendar_feed(original.id, "Updated".into(), other.url)
            .is_err());
        assert!(database
            .update_calendar_feed(
                original.id,
                " ".into(),
                "https://calendar.example/changed.ics".into()
            )
            .is_err());
        assert!(database
            .update_calendar_feed(original.id, "Updated".into(), "file:///invalid.ics".into())
            .is_err());
        assert!(database
            .update_calendar_feed(
                999,
                "Unknown".into(),
                "https://calendar.example/unknown.ics".into()
            )
            .err()
            .unwrap()
            .to_string()
            .contains("no longer exists"));
        let feeds = database.snapshot().unwrap().calendar_feeds;
        assert_eq!(feeds.len(), 2);
        let unchanged = feeds.iter().find(|feed| feed.id == original.id).unwrap();
        assert_eq!(unchanged.name, original.name);
        assert_eq!(unchanged.url, original.url);
    }

    #[test]
    fn calendar_links_validate_schemes_credentials_fragments_and_bounds() {
        assert_eq!(
            normalize_calendar_url(" WEBCAL://calendar.example/calendar.ics?key=private%2Ftoken ")
                .unwrap(),
            "https://calendar.example/calendar.ics?key=private%2Ftoken"
        );
        assert_eq!(
            normalize_calendar_url("http://homeassistant.local:8123/calendar.ics?key=test")
                .unwrap(),
            "http://homeassistant.local:8123/calendar.ics?key=test"
        );
        for address in [
            "file:///private-calendar",
            "javascript:alert(1)",
            "https://user:secret@calendar.example/feed.ics",
            "https://calendar.example/feed.ics#secret",
            "calendar.example/feed.ics",
            "https://calendar.example/feed.ics\nsecret",
        ] {
            let failure = normalize_calendar_url(address).unwrap_err().to_string();
            assert!(!failure.contains("secret"));
        }
        assert!(
            normalize_calendar_url(&format!("https://calendar.example/{}", "a".repeat(8192)))
                .is_err()
        );
        assert!(validate_calendar_id(0).is_err());
        assert!(validate_calendar_id(-1).is_err());
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(
            &directory.path().join("hjem.sqlite3"),
            &directory.path().join("missing.json"),
        )
        .unwrap();
        assert!(database
            .add_calendar_feed(" ".into(), "https://calendar.example/feed.ics".into())
            .is_err());
        assert!(database
            .add_calendar_feed(
                "Calendar\nName".into(),
                "https://calendar.example/feed.ics".into()
            )
            .is_err());
        assert!(database.snapshot().unwrap().calendar_feeds.is_empty());
    }

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
    fn electricity_settings_survive_restart_and_clear_completely() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hjem.sqlite3");
        let legacy = directory.path().join("concierge.json");
        let mut database = Database::open(&path, &legacy).unwrap();
        let empty = database.electricity_settings().unwrap();
        assert!(empty.api_key.is_none() && empty.location_id.is_none());
        database
            .update_electricity(|settings| {
                settings.api_key = Some("osm_synthetic".into());
                settings.location_id = Some("location-1".into());
                Ok(())
            })
            .unwrap();
        assert!(database
            .update_electricity(|_| Err("rejected".into()))
            .is_err());
        drop(database);
        let mut reopened = Database::open(&path, &legacy).unwrap();
        let saved = reopened.electricity_settings().unwrap();
        assert_eq!(saved.api_key.as_deref(), Some("osm_synthetic"));
        assert_eq!(saved.location_id.as_deref(), Some("location-1"));
        reopened
            .update_electricity(|settings| {
                *settings = crate::electricity::StoredElectricity::default();
                Ok(())
            })
            .unwrap();
        assert!(reopened.electricity_settings().unwrap().api_key.is_none());
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
