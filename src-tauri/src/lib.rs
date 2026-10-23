use litrpg_db::{
    AuditPage, Character, CharacterAttribute, CharacterStat, Db, Edge, Node, Story, StoryExport,
};
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
fn update_character(
    db: tauri::State<'_, Db>,
    id: String,
    name: String,
    description: Option<String>,
    user: String,
) -> Result<Character, String> {
    db.update_character(&id, name, description, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_character(db: tauri::State<'_, Db>, id: String, user: String) -> Result<(), String> {
    db.delete_character(&id, user).map_err(|e| e.to_string())
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
fn set_character_attribute(
    db: tauri::State<'_, Db>,
    character_id: String,
    attr_name: String,
    value: String,
    user: String,
) -> Result<CharacterAttribute, String> {
    db.add_or_update_attribute(character_id, attr_name, value, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_character_attributes(
    db: tauri::State<'_, Db>,
    character_id: String,
) -> Result<Vec<CharacterAttribute>, String> {
    db.list_attributes(&character_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_character_attribute(db: tauri::State<'_, Db>, id: String, user: String) -> Result<(), String> {
    db.delete_attribute(&id, user).map_err(|e| e.to_string())
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
fn update_graph_node(
    db: tauri::State<'_, Db>,
    id: String,
    label: String,
    content: Option<String>,
    user: String,
) -> Result<Node, String> {
    db.update_node(&id, label, content, user)
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
fn update_graph_edge(
    db: tauri::State<'_, Db>,
    id: String,
    label: Option<String>,
    relation_type: Option<String>,
    user: String,
) -> Result<Edge, String> {
    db.update_edge(&id, label, relation_type, user)
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
    offset: Option<i64>,
) -> Result<AuditPage, String> {
    db.get_audit_page(
        story_id.as_deref(),
        entity_type.as_deref(),
        entity_id.as_deref(),
        limit.unwrap_or(100),
        offset.unwrap_or(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_story(
    db: tauri::State<'_, Db>,
    id: String,
    title: String,
    user: String,
) -> Result<Story, String> {
    db.update_story(&id, title, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_story(db: tauri::State<'_, Db>, id: String, user: String) -> Result<(), String> {
    db.delete_story(&id, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_node(db: tauri::State<'_, Db>, id: String, user: String) -> Result<(), String> {
    db.delete_node(&id, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_edge(db: tauri::State<'_, Db>, id: String, user: String) -> Result<(), String> {
    db.delete_edge(&id, user).map_err(|e| e.to_string())
}

/// Writes a complete JSON snapshot of one story next to the database and returns
/// the path it wrote, so the user can copy it somewhere safe.
#[tauri::command]
fn export_story_json(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    story_id: String,
) -> Result<String, String> {
    let export = db.export_story(&story_id).map_err(|e| e.to_string())?;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?
        .join("exports");

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("{}-{stamp}.json", slugify(&export.story.title)));

    let json = serde_json::to_string_pretty(&export)
        .map_err(|e| format!("could not serialize the story: {e}"))?;

    std::fs::write(&path, json)
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;

    Ok(path.display().to_string())
}

/// Restores a story from a JSON export as a new copy. The path comes from the file
/// dialog, and every id is remapped, so an import never overwrites anything.
#[tauri::command]
fn import_story_json(
    db: tauri::State<'_, Db>,
    path: String,
    user: String,
) -> Result<Story, String> {
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("could not read {path}: {e}"))?;

    let export: StoryExport =
        serde_json::from_str(&raw).map_err(|e| format!("{path} is not a story export: {e}"))?;

    db.import_story(export, user).map_err(|e| e.to_string())
}

/// Turns a title into a safe file name: "The Long Walk" becomes "the-long-walk".
fn slugify(title: &str) -> String {
    let mut slug = String::new();

    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }

    let slug = slug.trim_matches('-');

    if slug.is_empty() {
        "story".to_string()
    } else {
        slug.to_string()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            update_character,
            delete_character,
            set_character_stat,
            get_character_stats,
            set_character_attribute,
            get_character_attributes,
            delete_character_attribute,
            create_graph_node,
            get_graph_nodes,
            update_graph_node_position,
            update_graph_node,
            create_graph_edge,
            update_graph_edge,
            get_graph_edges,
            get_audit_history,
            update_story,
            delete_story,
            delete_node,
            delete_edge,
            export_story_json,
            import_story_json,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
