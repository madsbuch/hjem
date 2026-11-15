CREATE TABLE hidden_apps (
    scope TEXT NOT NULL CHECK (scope IN ('demo', 'android')),
    package_name TEXT NOT NULL CHECK (length(package_name) BETWEEN 1 AND 255),
    PRIMARY KEY (scope, package_name)
);
