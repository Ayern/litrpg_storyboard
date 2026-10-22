mod db;

use db::{AuditEntry, Character, CharacterStat, Db, Edge, Node, Story};
use std::path::{Path, PathBuf};
use tauri::Manager;

const DB_FILE_NAME: &str = "storyboard.db";

/// Earlier builds stored the database in a folder derived from `APPDATA`, not in
/// Tauri's app data directory. Kept so an existing story library can be adopted
/// instead of silently starting empty.
fn legacy_db_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("LOCALAPPDATA"))?;
    Some(PathBuf::from(base).join("litrpg_storyboard").join(DB_FILE_NAME))
}

fn adopt_legacy_database(db_path: &Path) {
    if db_path.exists() {
        return;
    }

    let Some(legacy) = legacy_db_path() else {
        return;
    };

    if !legacy.exists() {
        return;
    }

    if let Err(error) = std::fs::copy(&legacy, db_path) {
        eprintln!(
            "Could not copy the existing database from {} to {}: {error}",
            legacy.display(),
            db_path.display()
        );
    }
}

fn resolve_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?;

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let db_path = dir.join(DB_FILE_NAME);
    adopt_legacy_database(&db_path);

    Ok(db_path)
}

#[tauri::command]
fn initialize_database(db: tauri::State<'_, Db>) -> Result<String, String> {
    Ok(db.location())
}

#[tauri::command]
fn create_new_story(
    db: tauri::State<'_, Db>,
    title: String,
    description: Option<String>,
    user: String,
) -> Result<Story, String> {
    db.create_story(title, description, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_all_stories(db: tauri::State<'_, Db>) -> Result<Vec<Story>, String> {
    db.list_stories().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_story_by_id(db: tauri::State<'_, Db>, id: String) -> Result<Option<Story>, String> {
    db.get_story(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_new_character(
    db: tauri::State<'_, Db>,
    story_id: String,
    name: String,
    description: Option<String>,
    user: String,
) -> Result<Character, String> {
    db.create_character(story_id, name, description, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_characters(db: tauri::State<'_, Db>, story_id: String) -> Result<Vec<Character>, String> {
    db.list_characters(&story_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_character_stat(
    db: tauri::State<'_, Db>,
    character_id: String,
    stat_name: String,
    value: i64,
    notes: Option<String>,
    user: String,
) -> Result<CharacterStat, String> {
    db.add_or_update_stat(character_id, stat_name, value, notes, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_character_stats(
    db: tauri::State<'_, Db>,
    character_id: String,
) -> Result<Vec<CharacterStat>, String> {
    db.list_stats(&character_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_graph_node(
    db: tauri::State<'_, Db>,
    story_id: String,
    node_type: String,
    label: String,
    content: Option<String>,
    pos_x: f64,
    pos_y: f64,
    created_by: String,
) -> Result<Node, String> {
    db.create_node(story_id, node_type, label, content, pos_x, pos_y, created_by)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_graph_nodes(db: tauri::State<'_, Db>, story_id: String) -> Result<Vec<Node>, String> {
    db.list_nodes(&story_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_graph_node_position(
    db: tauri::State<'_, Db>,
    id: String,
    pos_x: f64,
    pos_y: f64,
    user: String,
) -> Result<(), String> {
    db.update_node_position(id, pos_x, pos_y, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_graph_edge(
    db: tauri::State<'_, Db>,
    story_id: String,
    source_id: String,
    target_id: String,
    label: Option<String>,
    relation_type: Option<String>,
    created_by: String,
) -> Result<Edge, String> {
    db.create_edge(story_id, source_id, target_id, label, relation_type, created_by)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_graph_edges(db: tauri::State<'_, Db>, story_id: String) -> Result<Vec<Edge>, String> {
    db.list_edges(&story_id).map_err(|e| e.to_string())
}

/// History is scoped by story, so one story's changes never show up in another.
#[tauri::command]
fn get_audit_history(
    db: tauri::State<'_, Db>,
    story_id: Option<String>,
    entity_type: Option<String>,
    entity_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<AuditEntry>, String> {
    db.get_audit_log(
        story_id.as_deref(),
        entity_type.as_deref(),
        entity_id.as_deref(),
        limit.unwrap_or(100),
    )
    .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            let path = resolve_db_path(app.handle())?;
            app.manage(Db::open(&path)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initialize_database,
            create_new_story,
            get_all_stories,
            get_story_by_id,
            create_new_character,
            get_characters,
            set_character_stat,
            get_character_stats,
            create_graph_node,
            get_graph_nodes,
            update_graph_node_position,
            create_graph_edge,
            get_graph_edges,
            get_audit_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
