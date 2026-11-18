CREATE TABLE electricity_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    api_key TEXT,
    location_id TEXT CHECK (location_id IS NULL OR length(location_id) BETWEEN 1 AND 64)
);
INSERT INTO electricity_settings (id, api_key, location_id) VALUES (1, NULL, NULL);
