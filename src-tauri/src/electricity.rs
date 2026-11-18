//! Osmund electricity data. The API key stays in the native app's private
//! SQLite database and is only sent to Osmund; the interface receives a
//! key-presence flag and the chosen location. Requests are limited to a fixed
//! set of read-only routes, built here from validated parameters.

use crate::database::{with_database, DatabaseState};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, State};

const API: &str = "https://api.osmundenergi.dk";
const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const RESPONSE_LENGTH_LIMIT: u64 = 2 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub(crate) struct StoredElectricity {
    pub(crate) api_key: Option<String>,
    pub(crate) location_id: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ElectricitySettings {
    has_api_key: bool,
    location_id: Option<String>,
}

impl StoredElectricity {
    fn public(&self) -> ElectricitySettings {
        ElectricitySettings {
            has_api_key: self.api_key.as_ref().is_some_and(|key| !key.is_empty()),
            location_id: self.location_id.clone(),
        }
    }

    fn key(&self) -> Result<&str> {
        self.api_key
            .as_deref()
            .filter(|key| !key.is_empty())
            .ok_or_else(|| "Add your Osmund API key in Settings to see your electricity.".into())
    }

    fn location(&self) -> Result<&str> {
        self.location_id
            .as_deref()
            .ok_or_else(|| "Choose your Osmund location in Settings.".into())
    }
}

/// The only Osmund routes Hjem may call. Location routes use the saved location.
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ElectricityRequest {
    Locations {},
    Prices {
        date: Option<String>,
        resolution: Option<String>,
    },
    Consumption {
        resolution: String,
        from: String,
        to: String,
    },
    Standby {},
    #[serde(rename_all = "camelCase")]
    RatedCost {
        month: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Invoices {
        page: Option<u32>,
        per_page: Option<u32>,
    },
}

fn digits(value: &str, pattern: &str) -> bool {
    value.len() == pattern.len()
        && value
            .chars()
            .zip(pattern.chars())
            .all(|(character, expected)| {
                if expected == '9' {
                    character.is_ascii_digit()
                } else {
                    character == expected
                }
            })
}
fn is_date(value: &str) -> bool {
    digits(value, "9999-99-99")
}
fn is_month(value: &str) -> bool {
    digits(value, "9999-99")
}

pub(crate) fn validate_key(key: &str) -> Result<&str> {
    let key = key.trim();
    if !key.starts_with("osm_")
        || key.len() > 512
        || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("Enter an Osmund API key from Min side. It starts with osm_.".into());
    }
    Ok(key)
}

pub(crate) fn validate_location(id: &str) -> Result<&str> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Choose one of your Osmund locations.".into());
    }
    Ok(id)
}

/// Build the request URL from fixed paths and validated parameters only.
pub(crate) fn request_url(
    request: &ElectricityRequest,
    location: Option<&str>,
) -> Result<reqwest::Url> {
    let invalid = || "Hjem asked Osmund for something it does not support.".to_string();
    let location_path = |suffix: &str| -> Result<String> {
        let id = validate_location(location.ok_or("Choose your Osmund location in Settings.")?)?;
        Ok(format!("/api/v1/locations/{id}/{suffix}"))
    };
    let mut query: Vec<(&str, String)> = Vec::new();
    let path = match request {
        ElectricityRequest::Locations {} => "/api/v1/locations".to_string(),
        ElectricityRequest::Prices { date, resolution } => {
            if let Some(date) = date {
                if !is_date(date) {
                    return Err(invalid());
                }
                query.push(("date", date.clone()));
            }
            if let Some(resolution) = resolution {
                if !matches!(resolution.as_str(), "PT15M" | "PT1H") {
                    return Err(invalid());
                }
                query.push(("resolution", resolution.clone()));
            }
            location_path("prices")?
        }
        ElectricityRequest::Consumption {
            resolution,
            from,
            to,
        } => {
            let valid = match resolution.as_str() {
                "PT1H" | "P1D" => is_date(from) && is_date(to),
                "P1M" => is_month(from) && is_month(to),
                _ => false,
            };
            if !valid || from > to {
                return Err(invalid());
            }
            query.push(("resolution", resolution.clone()));
            query.push(("from", from.clone()));
            query.push(("to", to.clone()));
            location_path("consumption")?
        }
        ElectricityRequest::Standby {} => location_path("standby")?,
        ElectricityRequest::RatedCost { month } => {
            if let Some(month) = month {
                if !is_month(month) {
                    return Err(invalid());
                }
                query.push(("month", month.clone()));
            }
            location_path("costs/rated")?
        }
        ElectricityRequest::Invoices { page, per_page } => {
            if let Some(page) = page {
                if *page == 0 {
                    return Err(invalid());
                }
                query.push(("page", page.to_string()));
            }
            if let Some(per_page) = per_page {
                if !(1..=100).contains(per_page) {
                    return Err(invalid());
                }
                query.push(("perPage", per_page.to_string()));
            }
            "/api/v1/invoices".to_string()
        }
    };
    let mut url = reqwest::Url::parse(&format!("{API}{path}")).map_err(|_| invalid())?;
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    Ok(url)
}

/// Osmund's documented error codes, explained without echoing remote text.
pub(crate) fn error_message(status: u16, body: Option<&Value>) -> String {
    let code = body
        .and_then(|body| body.get("code"))
        .and_then(Value::as_str);
    let retry = body
        .and_then(|body| body.get("retryAfter"))
        .and_then(Value::as_f64)
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .map(|seconds| format!(" Try again in {} seconds.", seconds.ceil()))
        .unwrap_or_default();
    match (code, status) {
        (Some("unauthorized"), _) | (None, 401) => {
            "Osmund did not accept the API key. It may have expired or been revoked; create a new one on Min side.".into()
        }
        (Some("scope_required"), _) => {
            "This Osmund API key is not allowed to read that. Create a key with all scopes on Min side.".into()
        }
        (Some("api_access_not_included"), _) => {
            "API access is not included for this Osmund location. It is part of Osmund Pro.".into()
        }
        (Some("not_found"), _) | (None, 404) => {
            "Osmund no longer has this location. Choose your location again in Settings.".into()
        }
        (Some("rate_limited"), _) | (None, 429) => format!("Osmund is limiting requests right now.{retry}"),
        (Some("temporarily_unavailable"), _) | (None, 503) => {
            format!("Osmund is temporarily unavailable.{retry}")
        }
        (Some("invalid_request"), _) | (None, 400) => {
            "Osmund could not answer this request. Prices for tomorrow may not be ready yet.".into()
        }
        _ => "Osmund could not answer right now. Please try again later.".into(),
    }
}

fn client() -> Result<reqwest::Client> {
    static CLIENT: OnceLock<Result<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .user_agent(concat!("Hjem/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|_| "The Osmund connection could not be prepared.".into())
        })
        .clone()
}

async fn get_json(url: reqwest::Url, key: &str) -> Result<Value> {
    let response = client()?
        .get(url)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "Osmund took too long to answer. Please try again.".to_string()
            } else {
                "Could not reach Osmund. Check the network connection.".to_string()
            }
        })?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > RESPONSE_LENGTH_LIMIT)
    {
        return Err("Osmund returned a response that is too large.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The answer from Osmund was interrupted.".to_string())?;
        if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
            return Err("Osmund returned a response that is too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = serde_json::from_slice::<Value>(&bytes).ok();
    if !(200..300).contains(&status) {
        return Err(error_message(status, body.as_ref()));
    }
    body.ok_or_else(|| "Osmund returned an unreadable answer.".into())
}

fn snapshot(app: &AppHandle, database: &DatabaseState) -> Result<StoredElectricity> {
    with_database(app, database, |database| database.electricity_settings())
}

#[tauri::command]
pub fn electricity_get_settings(
    app: AppHandle,
    database: State<'_, DatabaseState>,
) -> Result<ElectricitySettings> {
    Ok(snapshot(&app, &database)?.public())
}

/// Check a key with Osmund before saving it. A new key starts without a location.
#[tauri::command]
pub async fn electricity_save_key(
    app: AppHandle,
    database: State<'_, DatabaseState>,
    api_key: String,
) -> Result<ElectricitySettings> {
    let key = validate_key(&api_key)?.to_owned();
    get_json(
        reqwest::Url::parse(&format!("{API}/api/v1/me")).map_err(|_| "Invalid Osmund address.")?,
        &key,
    )
    .await?;
    let settings = with_database(&app, &database, |database| {
        database.update_electricity(|settings| {
            settings.api_key = Some(key);
            settings.location_id = None;
            Ok(())
        })
    })?;
    Ok(settings.public())
}

#[tauri::command]
pub fn electricity_set_location(
    app: AppHandle,
    database: State<'_, DatabaseState>,
    location_id: String,
) -> Result<ElectricitySettings> {
    let id = validate_location(&location_id)?.to_owned();
    let settings = with_database(&app, &database, |database| {
        database.update_electricity(|settings| {
            if settings.api_key.is_none() {
                return Err("Add your Osmund API key first.".into());
            }
            settings.location_id = Some(id);
            Ok(())
        })
    })?;
    Ok(settings.public())
}

#[tauri::command]
pub fn electricity_clear(
    app: AppHandle,
    database: State<'_, DatabaseState>,
) -> Result<ElectricitySettings> {
    let settings = with_database(&app, &database, |database| {
        database.update_electricity(|settings| {
            *settings = StoredElectricity::default();
            Ok(())
        })
    })?;
    Ok(settings.public())
}

#[tauri::command]
pub async fn electricity_fetch(
    app: AppHandle,
    database: State<'_, DatabaseState>,
    request: ElectricityRequest,
) -> Result<Value> {
    let settings = snapshot(&app, &database)?;
    let key = settings.key()?.to_owned();
    let location = match request {
        ElectricityRequest::Locations {} | ElectricityRequest::Invoices { .. } => None,
        _ => Some(settings.location()?.to_owned()),
    };
    get_json(request_url(&request, location.as_deref())?, &key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value) -> ElectricityRequest {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn builds_only_fixed_routes_with_validated_parameters() {
        let location = Some("0192f3a1-7c2e-7b1a-9d3e-2f6a8c1e4b10");
        let url = |value: Value| request_url(&parse(value), location).map(|url| url.to_string());
        assert_eq!(
            url(json!({"kind":"locations"})).unwrap(),
            "https://api.osmundenergi.dk/api/v1/locations"
        );
        assert_eq!(
            url(json!({"kind":"prices","date":"2026-11-18","resolution":"PT1H"})).unwrap(),
            "https://api.osmundenergi.dk/api/v1/locations/0192f3a1-7c2e-7b1a-9d3e-2f6a8c1e4b10/prices?date=2026-11-18&resolution=PT1H"
        );
        assert_eq!(
            url(json!({"kind":"consumption","resolution":"P1M","from":"2026-01","to":"2026-11"})).unwrap(),
            "https://api.osmundenergi.dk/api/v1/locations/0192f3a1-7c2e-7b1a-9d3e-2f6a8c1e4b10/consumption?resolution=P1M&from=2026-01&to=2026-11"
        );
        assert!(url(json!({"kind":"ratedCost","month":"2026-11"}))
            .unwrap()
            .ends_with("/costs/rated?month=2026-11"));
        assert!(url(json!({"kind":"invoices","page":1,"perPage":1}))
            .unwrap()
            .ends_with("/api/v1/invoices?page=1&perPage=1"));
        assert!(url(json!({"kind":"standby"}))
            .unwrap()
            .ends_with("/standby"));

        for bad in [
            json!({"kind":"prices","date":"2026-11-18&x=1"}),
            json!({"kind":"prices","resolution":"P1D"}),
            json!({"kind":"consumption","resolution":"P1D","from":"2026-11","to":"2026-11"}),
            json!({"kind":"consumption","resolution":"P1D","from":"2026-11-20","to":"2026-11-01"}),
            json!({"kind":"ratedCost","month":"../x"}),
            json!({"kind":"invoices","perPage":101}),
            json!({"kind":"invoices","page":0}),
        ] {
            assert!(url(bad.clone()).is_err(), "{bad}");
        }
        assert!(serde_json::from_value::<ElectricityRequest>(json!({"kind":"me"})).is_err());
        assert!(serde_json::from_value::<ElectricityRequest>(
            json!({"kind":"locations","path":"/x"})
        )
        .is_err());
        assert!(request_url(&parse(json!({"kind":"standby"})), Some("../../me")).is_err());
        assert!(request_url(&parse(json!({"kind":"standby"})), None).is_err());
    }

    #[test]
    fn explains_osmund_errors_without_remote_text() {
        let message = |status, body: Value| error_message(status, Some(&body));
        assert!(
            message(401, json!({"code":"unauthorized","message":"<script>"}))
                .contains("did not accept")
        );
        assert!(message(403, json!({"code":"api_access_not_included"})).contains("Osmund Pro"));
        assert_eq!(
            message(429, json!({"code":"rate_limited","retryAfter":41.2})),
            "Osmund is limiting requests right now. Try again in 42 seconds."
        );
        assert!(error_message(503, None).contains("temporarily unavailable"));
        assert!(!message(
            500,
            json!({"code":"internal_error","message":"secret detail"})
        )
        .contains("secret"));
    }

    #[test]
    fn keys_and_locations_are_validated_and_never_exposed() {
        assert_eq!(validate_key("  osm_4f9Kx2Qa  ").unwrap(), "osm_4f9Kx2Qa");
        for key in ["", "sk-or-1", "osm_with space", "osm_\nline"] {
            assert!(validate_key(key).is_err(), "{key:?}");
        }
        assert!(validate_location("0192f3a1-7c2e").is_ok());
        assert!(validate_location("a/b").is_err());
        let settings = StoredElectricity {
            api_key: Some("osm_secret".into()),
            location_id: Some("loc".into()),
        };
        let public = serde_json::to_string(&settings.public()).unwrap();
        assert_eq!(public, r#"{"hasApiKey":true,"locationId":"loc"}"#);
    }
}
