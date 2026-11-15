CREATE TABLE saved_connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    server_url TEXT NOT NULL,
    token TEXT
);
INSERT INTO saved_connection (id, server_url, token) VALUES (1, '', NULL);

CREATE TABLE app_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark'))
);
INSERT INTO app_preferences (id, theme) VALUES (1, 'system');

CREATE TABLE pin_scopes (
    scope TEXT PRIMARY KEY NOT NULL CHECK (scope IN ('demo', 'android'))
);
CREATE TABLE pinned_apps (
    scope TEXT NOT NULL REFERENCES pin_scopes(scope) ON DELETE CASCADE,
    package_name TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (scope, package_name),
    UNIQUE (scope, position)
);
CREATE TABLE favourite_scopes (scope TEXT PRIMARY KEY NOT NULL);
CREATE TABLE favourites (
    scope TEXT NOT NULL REFERENCES favourite_scopes(scope) ON DELETE CASCADE,
    entity_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (scope, entity_id),
    UNIQUE (scope, position)
);
CREATE TABLE selected_speakers (
    scope TEXT PRIMARY KEY NOT NULL,
    entity_id TEXT
);
CREATE TABLE concierge_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    api_key TEXT,
    model TEXT NOT NULL
);
INSERT INTO concierge_settings (id, api_key, model) VALUES (1, NULL, '');
CREATE TABLE import_status (migration TEXT PRIMARY KEY NOT NULL);
