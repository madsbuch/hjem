//! Persistent visible chat transcripts. Never persist microphone data, provider
//! reasoning, tool payloads, or credentials as conversation state.

use crate::database::{with_database, DatabaseState};
use crate::schema::concierge_chats;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::{AppHandle, State};

pub(crate) const MAX_MESSAGES: usize = 20_000;
pub(crate) const MAX_BYTES: usize = 32 * 1024 * 1024;
// Chat dates are rendered with JavaScript Date, whose range is narrower than
// Number.MAX_SAFE_INTEGER.
const MAX_STAMP: i64 = 8_640_000_000_000_000;
pub(crate) const UNREADABLE: &str =
    "Saved Concierge chats could not be read. Your saved chats have not been changed.";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
    Activity,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRecord {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub model: String,
    pub home_key: String,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Serialize, Queryable, Selectable)]
#[serde(rename_all = "camelCase")]
#[diesel(table_name = concierge_chats)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub model: String,
    pub home_key: String,
    pub message_count: i32,
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

fn bounded(value: &str, maximum: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty()) && value.encode_utf16().count() <= maximum
}

impl ChatSummary {
    pub(crate) fn validate(&self) -> std::result::Result<(), String> {
        if !valid_id(&self.id)
            || !bounded(&self.title, 256, false)
            || !(0..=MAX_STAMP).contains(&self.created_at)
            || !(self.created_at..=MAX_STAMP).contains(&self.updated_at)
            || !bounded(&self.model, 200, true)
            || !bounded(&self.home_key, 1024, false)
            || !(0..=20_000).contains(&self.message_count)
        {
            return Err(UNREADABLE.into());
        }
        Ok(())
    }
}

impl ChatRecord {
    /// Return false for a harmless delayed snapshot. Diverging transcripts must
    /// remain unsaved in their caller instead of overwriting another window.
    pub(crate) fn accepts_update(&self, next: &Self) -> std::result::Result<bool, String> {
        if self.id != next.id
            || self.created_at != next.created_at
            || self.home_key != next.home_key
        {
            return Err("This chat belongs to a different conversation. Start a new chat.".into());
        }
        let prefix = |earlier: &[ChatMessage], later: &[ChatMessage]| {
            earlier.len() <= later.len()
                && earlier.iter().zip(later).all(|(previous, next)| {
                    previous.id == next.id
                        && previous.role == next.role
                        && (previous.role == ChatRole::Activity || previous.text == next.text)
                })
        };
        let stale = self.updated_at > next.updated_at;
        let preserved = if stale {
            prefix(&next.messages, &self.messages)
        } else {
            prefix(&self.messages, &next.messages)
        };
        if !preserved {
            return Err(
                "A newer version of this chat is already saved. Reopen it before continuing."
                    .into(),
            );
        }
        Ok(!stale)
    }

    pub(crate) fn summary(&self) -> ChatSummary {
        ChatSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            model: self.model.clone(),
            home_key: self.home_key.clone(),
            message_count: i32::try_from(self.messages.len()).unwrap_or(i32::MAX),
        }
    }

    pub(crate) fn validate(&self) -> std::result::Result<(), String> {
        self.summary().validate()?;
        if self.messages.len() > MAX_MESSAGES {
            return Err(UNREADABLE.into());
        }
        let mut ids = HashSet::new();
        for message in &self.messages {
            if !valid_id(&message.id)
                || !ids.insert(&message.id)
                || !bounded(&message.text, 1024 * 1024, true)
            {
                return Err(UNREADABLE.into());
            }
        }
        if serde_json::to_vec(self).map_err(|_| UNREADABLE)?.len() > MAX_BYTES {
            return Err("This conversation is too large to save. Start a new chat; existing saved chats are unchanged.".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub fn concierge_list_chats(
    app: AppHandle,
    database: State<'_, DatabaseState>,
) -> Result<Vec<ChatSummary>, String> {
    with_database(&app, &database, |database| database.list_concierge_chats())
}

#[tauri::command]
pub fn concierge_load_chat(
    app: AppHandle,
    database: State<'_, DatabaseState>,
    id: String,
) -> Result<Option<ChatRecord>, String> {
    if !valid_id(&id) {
        return Err(UNREADABLE.into());
    }
    with_database(&app, &database, |database| {
        database.load_concierge_chat(&id)
    })
}

#[tauri::command]
pub fn concierge_save_chat(
    app: AppHandle,
    database: State<'_, DatabaseState>,
    chat: ChatRecord,
) -> Result<(), String> {
    chat.validate()?;
    with_database(&app, &database, |database| {
        database.save_concierge_chat(&chat)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_timestamps_stay_within_the_javascript_date_range() {
        let mut chat: ChatRecord = serde_json::from_value(json!({
            "id":"chat-1", "title":"Lights", "createdAt":MAX_STAMP,
            "updatedAt":MAX_STAMP, "model":"provider/model", "homeKey":"demo", "messages":[]
        }))
        .unwrap();
        chat.validate().unwrap();
        chat.summary().validate().unwrap();
        chat.updated_at = MAX_STAMP + 1;
        assert!(chat.validate().is_err());
        assert!(chat.summary().validate().is_err());
        chat.created_at = MAX_STAMP + 1;
        assert!(chat.validate().is_err());
        assert!(chat.summary().validate().is_err());
    }

    #[test]
    fn chat_contract_rejects_non_visible_content_and_invalid_metadata() {
        let valid = json!({"id":"chat-1","title":"Lights","createdAt":1,"updatedAt":2,"model":"provider/model","homeKey":"demo","messages":[{"id":"msg-1","role":"user","text":"Which lights?"}]});
        let chat: ChatRecord = serde_json::from_value(valid.clone()).unwrap();
        chat.validate().unwrap();
        for field in ["audio", "apiKey", "reasoning_details", "tool_calls"] {
            let mut invalid = valid.clone();
            invalid["messages"][0][field] = json!("not-to-store");
            assert!(serde_json::from_value::<ChatRecord>(invalid).is_err());
        }
        let mut duplicate = chat.clone();
        duplicate.messages.push(duplicate.messages[0].clone());
        assert!(duplicate.validate().is_err());
        let mut invalid = chat.clone();
        invalid.updated_at = 0;
        assert!(invalid.validate().is_err());
        invalid = chat;
        invalid.id = "not a valid id".into();
        assert!(invalid.validate().is_err());
    }
}
