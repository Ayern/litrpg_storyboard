// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod db;

use db::{
    AuditEntry, Character, CharacterStat, Edge, Node, Story,
    add_or_update_stat, create_character, create_edge, create_node, create_story,
    get_audit_log, get_story, init_db, list_characters, list_edges, list_nodes,
    list_stats, list_stories, update_node_position,
};

#[tauri::command]
fn initialize_database() -> Result<String, String> {
    init_db().map_err(|e| e.to_string())
}

#[tauri::command]
fn create_new_story(title: String, description: Option<String>, user: String) -> Result<Story, String> {
    create_story(title, description, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_all_stories() -> Result<Vec<Story>, String> {
    list_stories().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_story_by_id(id: String) -> Result<Option<Story>, String> {
    get_story(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_new_character(
    story_id: String,
    name: String,
    description: Option<String>,
    user: String,
) -> Result<Character, String> {
    create_character(story_id, name, description, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_characters(story_id: String) -> Result<Vec<Character>, String> {
    list_characters(&story_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_character_stat(
    character_id: String,
    stat_name: String,
    value: i64,
    notes: Option<String>,
    user: String,
) -> Result<CharacterStat, String> {
    add_or_update_stat(character_id, stat_name, value, notes, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_character_stats(character_id: String) -> Result<Vec<CharacterStat>, String> {
    list_stats(&character_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_graph_node(
    story_id: String,
    node_type: String,
    label: String,
    content: Option<String>,
    pos_x: f64,
    pos_y: f64,
    created_by: String,
) -> Result<Node, String> {
    create_node(story_id, node_type, label, content, pos_x, pos_y, created_by)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_graph_nodes(story_id: String) -> Result<Vec<Node>, String> {
    list_nodes(&story_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_graph_node_position(id: String, pos_x: f64, pos_y: f64, user: String) -> Result<(), String> {
    update_node_position(id, pos_x, pos_y, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_graph_edge(
    story_id: String,
    source_id: String,
    target_id: String,
    label: Option<String>,
    relation_type: Option<String>,
    created_by: String,
) -> Result<Edge, String> {
    create_edge(story_id, source_id, target_id, label, relation_type, created_by)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_graph_edges(story_id: String) -> Result<Vec<Edge>, String> {
    list_edges(&story_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_audit_history(
    entity_type: Option<String>,
    entity_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<AuditEntry>, String> {
    let lim = limit.unwrap_or(100);
    get_audit_log(entity_type.as_deref(), entity_id.as_deref(), lim).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
