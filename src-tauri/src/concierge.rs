//! OpenRouter credentials stay in the native app's private SQLite database.
//! This is private file storage, not OS keychain encryption. Only a key-presence
//! flag crosses IPC. API errors deliberately omit remote text and credentials.

use crate::database::{with_database, DatabaseState};
use futures_util::future::{AbortHandle, AbortRegistration, Abortable};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

const API: &str = "https://openrouter.ai/api/v1";
const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const REQUEST_LIMIT: usize = 1024 * 1024;
const RESPONSE_LENGTH_LIMIT: u64 = 4 * 1024 * 1024;
const STOPPED: &str = "Stopped.";
type Result<T> = std::result::Result<T, String>;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredSettings {
    pub(crate) api_key: Option<String>,
    #[serde(default)]
    pub(crate) model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConciergeSettings {
    has_api_key: bool,
    model: String,
}

impl StoredSettings {
    fn public(&self) -> ConciergeSettings {
        ConciergeSettings {
            has_api_key: self.api_key.as_ref().is_some_and(|key| !key.is_empty()),
            model: self.model.clone(),
        }
    }

    fn key(&self) -> Result<&str> {
        self.api_key
            .as_deref()
            .filter(|key| !key.is_empty())
            .ok_or_else(|| "Add your OpenRouter API key in Settings to use the concierge.".into())
    }
}

enum Pending {
    Running(AbortHandle),
    // A Stop can arrive just before its corresponding async request is polled.
    Cancelled(Instant),
}

#[derive(Default)]
pub struct ConciergeState {
    pending: Arc<Mutex<HashMap<String, Pending>>>,
}

struct RequestGuard {
    request_id: String,
    pending: Arc<Mutex<HashMap<String, Pending>>>,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.request_id);
        }
    }
}

impl ConciergeState {
    fn begin(&self, request_id: String) -> Result<(RequestGuard, AbortRegistration)> {
        validate_request_id(&request_id)?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "The concierge is unavailable.")?;
        pending.retain(|_, entry| !matches!(entry, Pending::Cancelled(at) if at.elapsed() > Duration::from_secs(120)));
        match pending.get(&request_id) {
            Some(Pending::Cancelled(_)) => {
                pending.remove(&request_id);
                return Err(STOPPED.into());
            }
            Some(Pending::Running(_)) => return Err("This request is already running.".into()),
            None => {}
        }
        if pending
            .values()
            .filter(|entry| matches!(entry, Pending::Running(_)))
            .count()
            >= 8
        {
            return Err("Too many concierge requests are running. Stop one and try again.".into());
        }
        let (handle, registration) = AbortHandle::new_pair();
        pending.insert(request_id.clone(), Pending::Running(handle));
        Ok((
            RequestGuard {
                request_id,
                pending: self.pending.clone(),
            },
            registration,
        ))
    }

    fn cancel(&self, request_id: String) -> Result<()> {
        validate_request_id(&request_id)?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "The concierge is unavailable.")?;
        if let Some(Pending::Running(handle)) = pending.get(&request_id) {
            handle.abort();
        } else {
            pending.retain(|_, entry| !matches!(entry, Pending::Cancelled(at) if at.elapsed() > Duration::from_secs(120)));
            if pending.len() < 256 {
                pending.insert(request_id, Pending::Cancelled(Instant::now()));
            }
        }
        Ok(())
    }
}

fn validate_request_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err("Invalid concierge request ID.".into());
    }
    Ok(())
}

pub(crate) fn apply_settings(
    settings: &mut StoredSettings,
    api_key: Option<String>,
    model: String,
) -> Result<()> {
    let model = model.trim();
    if model.len() > 200 || model.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Choose a valid model ID from OpenRouter.".into());
    }
    if let Some(key) = api_key {
        let key = key.trim();
        if key.is_empty()
            || key.len() > 8192
            || key.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err("Enter a valid OpenRouter API key.".into());
        }
        settings.api_key = Some(key.to_owned());
    }
    settings.model = model.to_owned();
    Ok(())
}

fn snapshot(app: &AppHandle, database: &DatabaseState) -> Result<StoredSettings> {
    with_database(app, database, |database| database.concierge_settings())
}

#[tauri::command]
pub fn concierge_get_settings(
    app: AppHandle,
    database: State<'_, DatabaseState>,
) -> Result<ConciergeSettings> {
    Ok(snapshot(&app, &database)?.public())
}

#[tauri::command]
pub fn concierge_save_settings(
    app: AppHandle,
    database: State<'_, DatabaseState>,
    api_key: Option<String>,
    model: String,
) -> Result<ConciergeSettings> {
    let settings = with_database(&app, &database, |database| {
        database.update_concierge(|settings| apply_settings(settings, api_key, model))
    })?;
    Ok(settings.public())
}

#[tauri::command]
pub fn concierge_clear_key(
    app: AppHandle,
    database: State<'_, DatabaseState>,
    state: State<'_, ConciergeState>,
) -> Result<ConciergeSettings> {
    let settings = with_database(&app, &database, |database| {
        database.update_concierge(|settings| {
            settings.api_key = None;
            Ok(())
        })
    })?;
    if let Ok(pending) = state.pending.lock() {
        for entry in pending.values() {
            if let Pending::Running(handle) = entry {
                handle.abort();
            }
        }
    }
    Ok(settings.public())
}

fn client() -> Result<reqwest::Client> {
    static CLIENT: OnceLock<Result<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(90))
                .user_agent(concat!("Hjem/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|_| "The OpenRouter connection could not be prepared.".into())
        })
        .clone()
}

fn transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The model took too long to reply. Please try again.".into()
    } else {
        "Could not reach OpenRouter. Check your connection and try again.".into()
    }
}

fn status_error(status: u16) -> String {
    match status {
        401 | 403 => "OpenRouter did not accept the API key. Check it in Settings.".into(),
        402 => "Your OpenRouter account needs credits before the concierge can reply.".into(),
        429 => "OpenRouter is rate limiting requests. Please try again shortly.".into(),
        500..=599 => "OpenRouter or the selected model is temporarily unavailable. Please try again.".into(),
        _ => format!("OpenRouter could not complete the request ({status}). Check the selected model in Settings."),
    }
}

async fn response_json(request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request.send().await.map_err(transport_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > RESPONSE_LENGTH_LIMIT)
    {
        return Err("OpenRouter returned a response that is too large.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(transport_error)?;
        if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
            return Err("OpenRouter returned a response that is too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "OpenRouter returned an unreadable response.")?;
    if body.get("error").is_some_and(|error| !error.is_null()) {
        let code = body
            .pointer("/error/code")
            .and_then(|code| code.as_u64().or_else(|| code.as_str()?.parse().ok()));
        return Err(code.and_then(|n| u16::try_from(n).ok()).map(status_error)
            .unwrap_or_else(|| "The selected model could not complete this request. Please try again or choose another model.".into()));
    }
    Ok(body)
}

#[tauri::command]
pub async fn concierge_test_key(app: AppHandle, database: State<'_, DatabaseState>) -> Result<()> {
    let settings = snapshot(&app, &database)?;
    response_json(
        client()?
            .get(format!("{API}/key"))
            .bearer_auth(settings.key()?),
    )
    .await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConciergeModel {
    id: String,
    name: String,
}

fn models_from_response(body: Value) -> Result<Vec<ConciergeModel>> {
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or("OpenRouter returned an unreadable model list.")?;
    let mut models: Vec<_> = data
        .iter()
        .filter_map(|model| {
            let id = model.get("id")?.as_str()?;
            let tools = model
                .get("supported_parameters")?
                .as_array()?
                .iter()
                .any(|parameter| parameter == "tools");
            let text = model
                .pointer("/architecture/output_modalities")?
                .as_array()?
                .iter()
                .any(|modality| modality == "text");
            if !tools || !text || id.is_empty() || id.len() > 200 {
                return None;
            }
            Some(ConciergeModel {
                id: id.to_owned(),
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_owned(),
            })
        })
        .collect();
    models.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(models)
}

#[tauri::command]
pub async fn concierge_list_models() -> Result<Vec<ConciergeModel>> {
    models_from_response(response_json(client()?.get(format!("{API}/models"))).await?)
}

fn request_body(mut body: Value, model: &str) -> Result<Value> {
    if model.is_empty() {
        return Err("Choose a concierge model in Settings first.".into());
    }
    let object = body
        .as_object_mut()
        .ok_or("The concierge request is unreadable.")?;
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("The concierge needs a conversation to send.")?;
    if messages.is_empty() || messages.len() > 200 {
        return Err("This conversation is too long. Start a new conversation.".into());
    }
    for message in messages {
        let role = message.get("role").and_then(Value::as_str);
        if !matches!(role, Some("system" | "user" | "assistant" | "tool")) {
            return Err("The concierge conversation contains an invalid message.".into());
        }
        if let Some(details) = message.get("reasoning_details") {
            // Provider signatures/encrypted blocks must be replayed exactly to
            // continue a tool turn. Validate only their container; never inspect,
            // rewrite or log opaque reasoning payloads.
            if role != Some("assistant")
                || !details
                    .as_array()
                    .is_some_and(|blocks| blocks.iter().all(Value::is_object))
            {
                return Err("The concierge conversation contains invalid model context.".into());
            }
        }
        let content = message.get("content");
        let tool_calls = message.get("tool_calls").and_then(Value::as_array);
        let assistant_tools =
            role == Some("assistant") && tool_calls.is_some_and(|calls| !calls.is_empty());
        if !content.is_some_and(Value::is_string)
            && !(assistant_tools && content.is_some_and(Value::is_null))
        {
            return Err("The concierge accepts text messages only.".into());
        }
        if role == Some("tool")
            && !message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
        {
            return Err("A concierge tool result is missing its request ID.".into());
        }
        if let Some(calls) = tool_calls {
            if role != Some("assistant")
                || calls.len() > 64
                || calls.iter().any(|call| {
                    call.get("type").and_then(Value::as_str) != Some("function")
                        || !call
                            .get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| !id.is_empty())
                        || !call
                            .pointer("/function/name")
                            .and_then(Value::as_str)
                            .is_some_and(|name| !name.is_empty())
                        || !call
                            .pointer("/function/arguments")
                            .is_some_and(Value::is_string)
                })
            {
                return Err("The concierge conversation contains an invalid tool call.".into());
            }
        } else if message.get("tool_calls").is_some() {
            return Err("The concierge conversation contains invalid tool calls.".into());
        }
    }
    // Only the chat fields used by Hjem are accepted. The caller cannot inject
    // provider keys, alternate models, routing options, callbacks or paid plugins.
    object.retain(|key, _| {
        matches!(
            key.as_str(),
            "messages"
                | "tools"
                | "tool_choice"
                | "parallel_tool_calls"
                | "temperature"
                | "max_tokens"
        )
    });
    object.insert("model".into(), json!(model));
    object.insert("stream".into(), json!(false));
    object.insert("modalities".into(), json!(["text"]));
    let tokens = object
        .get("max_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(8192)
        .clamp(1, 8192);
    object.insert("max_tokens".into(), json!(tokens));
    if serde_json::to_vec(&body)
        .map_err(|_| "The concierge request is unreadable.")?
        .len()
        > REQUEST_LIMIT
    {
        return Err("This conversation is too large. Start a new conversation.".into());
    }
    Ok(body)
}

#[tauri::command]
pub async fn concierge_request(
    app: AppHandle,
    database: State<'_, DatabaseState>,
    state: State<'_, ConciergeState>,
    request_id: String,
    body: Value,
) -> Result<Value> {
    let (_guard, registration) = state.begin(request_id)?;
    let settings = snapshot(&app, &database)?;
    let body = request_body(body, &settings.model)?;
    let request = client()?
        .post(format!("{API}/chat/completions"))
        .bearer_auth(settings.key()?)
        .header("HTTP-Referer", "https://github.com/madsbuch/hjem")
        .header("X-Title", "Hjem Home Concierge")
        .json(&body);
    Abortable::new(response_json(request), registration)
        .await
        .map_err(|_| STOPPED.to_owned())?
}

#[tauri::command]
pub fn concierge_cancel(state: State<'_, ConciergeState>, request_id: String) -> Result<()> {
    state.cancel(request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_validate_and_public_response_never_contains_key() {
        let mut settings = StoredSettings::default();
        apply_settings(
            &mut settings,
            Some(" test-secret ".into()),
            " provider/model ".into(),
        )
        .unwrap();
        assert_eq!(settings.key().unwrap(), "test-secret");
        assert_eq!(
            serde_json::to_value(settings.public()).unwrap(),
            json!({"hasApiKey":true,"model":"provider/model"})
        );
        apply_settings(&mut settings, None, "provider/new".into()).unwrap();
        assert_eq!(settings.key().unwrap(), "test-secret");
        assert!(apply_settings(&mut settings, Some(" ".into()), "".into()).is_err());
        settings.api_key = None;
        assert!(!settings.public().has_api_key);
    }

    #[test]
    fn requests_use_saved_model_text_only_and_reject_oversize() {
        let body = request_body(json!({"messages":[{"role":"user","content":"hello"}],"model":"injected","stream":true,"provider":{"api_key":"other"},"plugins":[{"id":"web"}],"max_tokens":90000}), "saved/model").unwrap();
        assert_eq!(body["model"], "saved/model");
        assert_eq!(body["stream"], false);
        assert_eq!(body["modalities"], json!(["text"]));
        assert_eq!(body["max_tokens"], 8192);
        assert!(body.get("provider").is_none());
        assert!(body.get("plugins").is_none());
        assert!(request_body(json!({"messages":[]}), "saved/model").is_err());
        assert!(request_body(json!({"messages":["invalid"]}), "saved/model").is_err());
        assert!(request_body(
            json!({"messages":[{"role":"user","content":[{"type":"image_url"}]}]}),
            "saved/model"
        )
        .is_err());
        assert!(request_body(
            json!({"messages":[{"role":"tool","content":"done"}]}),
            "saved/model"
        )
        .is_err());
        assert!(request_body(json!({"messages":[
            {"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"home_control","arguments":"{}"}}]},
            {"role":"tool","content":"done","tool_call_id":"call-1"}
        ]}), "saved/model").is_ok());
        assert!(request_body(
            json!({"messages":[{"role":"user","content":"x".repeat(REQUEST_LIMIT)}]}),
            "saved/model"
        )
        .is_err());
    }

    #[test]
    fn reasoning_context_is_preserved_only_on_assistant_messages() {
        let details = json!([
            {"type":"reasoning.encrypted","data":"opaque-provider-payload","signature":"unchanged"},
            {"type":"reasoning.summary","summary":"fixture"}
        ]);
        let body = request_body(json!({"messages":[
            {"role":"assistant","content":null,"reasoning_details":details,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"home_status","arguments":"{}"}}]},
            {"role":"tool","content":"done","tool_call_id":"call-1"}
        ]}), "saved/model").unwrap();
        assert_eq!(body["messages"][0]["reasoning_details"], details);
        assert_eq!(body["max_tokens"], 8192);
        assert!(request_body(
            json!({"messages":[{"role":"user","content":"hello","reasoning_details":[]}]}),
            "saved/model"
        )
        .is_err());
        assert!(request_body(json!({"messages":[{"role":"assistant","content":"hello","reasoning_details":["invalid"]}]}), "saved/model").is_err());
    }

    #[test]
    fn models_require_tools_and_text_output() {
        let models = models_from_response(json!({"data":[
            {"id":"ok","name":"Good","supported_parameters":["tools"],"architecture":{"output_modalities":["text"]}},
            {"id":"image","supported_parameters":["tools"],"architecture":{"output_modalities":["image"]}},
            {"id":"plain","supported_parameters":[],"architecture":{"output_modalities":["text"]}}
        ]})).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "ok");
    }

    #[tokio::test]
    async fn stop_aborts_in_flight_work_and_handles_early_stop() {
        let state = ConciergeState::default();
        let (guard, registration) = state.begin("request-1".into()).unwrap();
        assert!(state.begin("request-1".into()).is_err());
        state.cancel("request-1".into()).unwrap();
        assert!(Abortable::new(std::future::pending::<()>(), registration)
            .await
            .is_err());
        drop(guard);
        assert!(state.pending.lock().unwrap().is_empty());
        state.cancel("request-2".into()).unwrap();
        assert!(matches!(state.begin("request-2".into()), Err(error) if error == STOPPED));
    }
}
