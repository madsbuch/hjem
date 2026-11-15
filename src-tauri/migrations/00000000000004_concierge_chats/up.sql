CREATE TABLE concierge_chats (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
    model TEXT NOT NULL,
    home_key TEXT NOT NULL,
    message_count INTEGER NOT NULL CHECK (message_count BETWEEN 0 AND 20000),
    messages_json TEXT NOT NULL
);
CREATE INDEX concierge_chats_updated ON concierge_chats(updated_at DESC, id ASC);
