//! A bounded bridge to Home Assistant's scene editor. The caller cannot choose
//! an endpoint or supply a token; both come from the saved home connection.

use crate::database::{with_database, DatabaseState};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, State};

const LIMIT: usize = 256 * 1024;
const LENGTH_LIMIT: u64 = 256 * 1024;

#[derive(Debug, Serialize)]
pub struct SceneFailure {
    code: &'static str,
    message: String,
}

impl SceneFailure {
    fn rejected(message: impl Into<String>) -> Self {
        Self {
            code: "rejected",
            message: message.into(),
        }
    }
    fn unconfirmed(message: impl Into<String>) -> Self {
        Self {
            code: "unconfirmed",
            message: message.into(),
        }
    }
}

impl From<&str> for SceneFailure {
    fn from(message: &str) -> Self {
        Self::unconfirmed(message)
    }
}

#[derive(Deserialize, Clone, Copy)]
pub enum SceneMethod {
    GET,
    POST,
    DELETE,
}

fn validate_request(
    config_id: &str,
    method: SceneMethod,
    config: &Option<Value>,
) -> Result<(), String> {
    if config_id.is_empty()
        || config_id.len() > 128
        || !config_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("This scene has an unsupported configuration identifier.".into());
    }
    match (method, config) {
        (SceneMethod::POST, Some(value)) => {
            let object = value
                .as_object()
                .ok_or("A scene configuration is required.")?;
            if object
                .keys()
                .any(|key| !["id", "name", "icon", "entities", "metadata"].contains(&key.as_str()))
                || !object
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| !name.trim().is_empty())
                || !object.get("entities").is_some_and(Value::is_object)
            {
                return Err("A valid scene configuration is required.".into());
            }
            if serde_json::to_vec(value)
                .map_err(|_| "The mood could not be encoded.")?
                .len()
                > LIMIT
            {
                return Err("This mood is too large to save.".into());
            }
        }
        (SceneMethod::GET | SceneMethod::DELETE, None) => {}
        _ => return Err("This scene request has unsupported data.".into()),
    }
    Ok(())
}

#[tauri::command]
pub async fn home_scene_config(
    app: AppHandle,
    state: State<'_, DatabaseState>,
    expected_server_url: String,
    method: SceneMethod,
    config_id: String,
    config: Option<Value>,
) -> Result<Value, SceneFailure> {
    validate_request(&config_id, method, &config).map_err(SceneFailure::rejected)?;
    let (server, token) = with_database(&app, &state, |database| {
        database.scene_connection(&expected_server_url)
    })
    .map_err(SceneFailure::rejected)?;
    scene_request(&server, &token, method, &config_id, config).await
}

async fn scene_request(
    server: &str,
    token: &str,
    method: SceneMethod,
    config_id: &str,
    config: Option<Value>,
) -> Result<Value, SceneFailure> {
    validate_request(config_id, method, &config).map_err(SceneFailure::rejected)?;
    // Never follow redirects with a home token, including to a second host.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| "Home Assistant’s scene connection could not be opened.")?;
    let url = format!("{server}/api/config/scene/config/{config_id}");
    let request = match method {
        SceneMethod::GET => client.get(url),
        SceneMethod::POST => client.post(url),
        SceneMethod::DELETE => client.delete(url),
    }
    .bearer_auth(token);
    let request = if let Some(value) = config {
        request.json(&value)
    } else {
        request
    };
    let response = request.send().await.map_err(|_| "Home Assistant did not confirm this scene request. Check the saved mood before trying again.")?;
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return Err(SceneFailure::rejected("Home Assistant administrator access is required to manage moods. Update the connection in Settings."));
    }
    if !response.status().is_success() && status != 404 {
        let message = "Home Assistant rejected this scene request. No automatic retry was made.";
        return Err(if (400..500).contains(&status) {
            SceneFailure::rejected(message)
        } else {
            SceneFailure::unconfirmed(message)
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > LENGTH_LIMIT)
    {
        return Err("Home Assistant returned an oversized scene configuration.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Home Assistant’s scene response was interrupted. Check its current configuration before retrying.")?;
        if bytes.len().saturating_add(chunk.len()) > LIMIT {
            return Err("Home Assistant returned an oversized scene configuration.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let result: Value = serde_json::from_slice(&bytes).map_err(|_| {
        SceneFailure::unconfirmed("Home Assistant returned an unreadable scene response.")
    })?;
    if status == 404 {
        if result.get("message").and_then(Value::as_str) == Some("Resource not found") {
            return Err(SceneFailure {
                code: "not_found",
                message: "This scene no longer has a saved Home Assistant configuration.".into(),
            });
        }
        return Err(SceneFailure::rejected(
            "This Home Assistant connection does not support scene editing.",
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn fixed_endpoint_rejects_path_traversal_and_unexpected_bodies() {
        for id in [
            "",
            "../scene",
            "a/b",
            "a?token=secret",
            "a#x",
            "%2e%2e",
            "scene.id",
        ] {
            assert!(validate_request(id, SceneMethod::GET, &None).is_err());
        }
        assert!(validate_request("hjem_123-test", SceneMethod::GET, &None).is_ok());
        assert!(validate_request("123", SceneMethod::DELETE, &Some(json!({}))).is_err());
        assert!(validate_request(
            "123",
            SceneMethod::POST,
            &Some(json!({"name":"Mood","entities":{},"service":"shell_command"}))
        )
        .is_err());
        assert!(validate_request(
            "123",
            SceneMethod::POST,
            &Some(json!({"name":"Mood","entities":{"light.desk":"on"}}))
        )
        .is_ok());
    }

    #[tokio::test]
    async fn redirects_and_remote_error_details_never_escape() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let count = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..count]);
            assert!(request.contains("GET /api/config/scene/config/test"));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer fixture-secret"));
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/token-leak\r\nContent-Length: 14\r\nConnection: close\r\n\r\nfixture-secret").unwrap();
        });
        let error = scene_request(
            &format!("http://{address}"),
            "fixture-secret",
            SceneMethod::GET,
            "test",
            None,
        )
        .await
        .unwrap_err();
        assert!(!error.message.contains("fixture-secret"));
        assert!(error.message.contains("rejected"));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn only_the_scene_editors_missing_resource_is_classified_as_absent() {
        for (status, body, expected_code) in [
            (404, r#"{"message":"Resource not found"}"#, "not_found"),
            (404, r#"{"message":"unknown endpoint"}"#, "rejected"),
            (403, r#"{"message":"fixture-secret"}"#, "rejected"),
            (500, r#"{"message":"fixture-secret"}"#, "unconfirmed"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0; 4096];
                stream.read(&mut buffer).unwrap();
                write!(stream, "HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let error = scene_request(
                &format!("http://{address}"),
                "fixture-secret",
                SceneMethod::GET,
                "test",
                None,
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, expected_code);
            assert!(!error.message.contains("fixture-secret"));
            server.join().unwrap();
        }
    }
}
