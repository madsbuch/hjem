diesel::table! {
    saved_connection (id) {
        id -> Integer,
        server_url -> Text,
        token -> Nullable<Text>,
    }
}
diesel::table! {
    app_preferences (id) {
        id -> Integer,
        theme -> Text,
    }
}
diesel::table! {
    pin_scopes (scope) { scope -> Text, }
}
diesel::table! {
    pinned_apps (scope, package_name) {
        scope -> Text,
        package_name -> Text,
        position -> Integer,
    }
}
diesel::table! {
    favourite_scopes (scope) { scope -> Text, }
}
diesel::table! {
    favourites (scope, entity_id) {
        scope -> Text,
        entity_id -> Text,
        position -> Integer,
    }
}
diesel::table! {
    selected_speakers (scope) {
        scope -> Text,
        entity_id -> Nullable<Text>,
    }
}
diesel::table! {
    concierge_settings (id) {
        id -> Integer,
        api_key -> Nullable<Text>,
        model -> Text,
    }
}
diesel::table! {
    import_status (migration) { migration -> Text, }
}
diesel::table! {
    calendar_feeds (id) {
        id -> Integer,
        name -> Text,
        url -> Text,
    }
}
diesel::table! {
    hidden_apps (scope, package_name) {
        scope -> Text,
        package_name -> Text,
    }
}
