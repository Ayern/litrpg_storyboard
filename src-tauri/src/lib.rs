use litrpg_db::{
    AuditPage, BackupInfo, Character, CharacterAttribute, CharacterCurrency,
    CharacterLevelMilestone, CharacterSkill, CharacterSkillEvent, CharacterStat, Db, DeletedItem,
    Edge, InventoryItem, Node, Story, StoryExport,
};
use std::path::{Path, PathBuf};
use tauri::Manager;

const DB_FILE_NAME: &str = "storyboard.db";

/// How many launch-time copies of the database to keep beside it.
const SNAPSHOTS_TO_KEEP: usize = 10;

/// Earlier builds stored the database in a folder derived from `APPDATA`, not in
/// Tauri's app data directory. Kept so an existing story library can be adopted
/// instead of silently starting empty.
fn legacy_db_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("LOCALAPPDATA"))?;
    Some(
        PathBuf::from(base)
            .join("litrpg_storyboard")
            .join(DB_FILE_NAME),
    )
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

/// Saves level, XP, rank and the XP target as the author typed them. No formula
/// runs here: the app records progression, it does not decide it.
#[tauri::command]
fn set_character_progress(
    db: tauri::State<'_, Db>,
    character_id: String,
    level: i64,
    xp: i64,
    rank: Option<String>,
    xp_to_next: Option<i64>,
    user: String,
) -> Result<Character, String> {
    db.set_character_progress(&character_id, level, xp, rank, xp_to_next, user)
        .map_err(|e| e.to_string())
}

/// One level more, recorded as a level-up rather than an ordinary field edit.
#[tauri::command]
fn level_up_character(
    db: tauri::State<'_, Db>,
    character_id: String,
    user: String,
) -> Result<Character, String> {
    db.level_up_character(&character_id, user)
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
fn delete_character_attribute(
    db: tauri::State<'_, Db>,
    id: String,
    user: String,
) -> Result<(), String> {
    db.delete_attribute(&id, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_skill(
    db: tauri::State<'_, Db>,
    character_id: String,
    name: String,
    rank: Option<String>,
    effect: Option<String>,
    chapter_id: Option<String>,
    node_id: Option<String>,
    user: String,
) -> Result<CharacterSkill, String> {
    db.add_skill(character_id, name, rank, effect, chapter_id, node_id, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_skill(
    db: tauri::State<'_, Db>,
    id: String,
    name: String,
    rank: Option<String>,
    effect: Option<String>,
    chapter_id: Option<String>,
    node_id: Option<String>,
    user: String,
) -> Result<CharacterSkill, String> {
    db.update_skill(id, name, rank, effect, chapter_id, node_id, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_skill(db: tauri::State<'_, Db>, id: String, user: String) -> Result<(), String> {
    db.delete_skill(&id, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_character_skills(
    db: tauri::State<'_, Db>,
    character_id: String,
) -> Result<Vec<CharacterSkill>, String> {
    db.list_skills(&character_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_story_skills(
    db: tauri::State<'_, Db>,
    story_id: String,
) -> Result<Vec<CharacterSkill>, String> {
    db.list_story_skills(&story_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_character_level_milestones(
    db: tauri::State<'_, Db>,
    character_id: String,
) -> Result<Vec<CharacterLevelMilestone>, String> {
    db.list_level_milestones(&character_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_story_level_milestones(
    db: tauri::State<'_, Db>,
    story_id: String,
) -> Result<Vec<CharacterLevelMilestone>, String> {
    db.list_story_level_milestones(&story_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn add_level_milestone(
    db: tauri::State<'_, Db>,
    character_id: String,
    level: i64,
    chapter_id: Option<String>,
    is_debuff: bool,
    user: String,
) -> Result<CharacterLevelMilestone, String> {
    db.add_level_milestone(character_id, level, chapter_id, is_debuff, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_level_milestone(
    db: tauri::State<'_, Db>,
    id: String,
    level: i64,
    chapter_id: Option<String>,
    is_debuff: bool,
    user: String,
) -> Result<CharacterLevelMilestone, String> {
    db.update_level_milestone(id, level, chapter_id, is_debuff, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_level_milestone(
    db: tauri::State<'_, Db>,
    id: String,
    user: String,
) -> Result<(), String> {
    db.delete_level_milestone(&id, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_skill_events(
    db: tauri::State<'_, Db>,
    skill_id: String,
) -> Result<Vec<CharacterSkillEvent>, String> {
    db.list_skill_events(&skill_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_story_skill_events(
    db: tauri::State<'_, Db>,
    story_id: String,
) -> Result<Vec<CharacterSkillEvent>, String> {
    db.list_story_skill_events(&story_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn add_skill_event(
    db: tauri::State<'_, Db>,
    skill_id: String,
    kind: String,
    chapter_id: Option<String>,
    rank: Option<String>,
    user: String,
) -> Result<CharacterSkillEvent, String> {
    db.add_skill_event(skill_id, kind, chapter_id, rank, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_skill_event(
    db: tauri::State<'_, Db>,
    id: String,
    kind: String,
    chapter_id: Option<String>,
    rank: Option<String>,
    user: String,
) -> Result<CharacterSkillEvent, String> {
    db.update_skill_event(id, kind, chapter_id, rank, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_skill_event(db: tauri::State<'_, Db>, id: String, user: String) -> Result<(), String> {
    db.delete_skill_event(&id, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_inventory_item(
    db: tauri::State<'_, Db>,
    character_id: String,
    name: String,
    rarity: Option<String>,
    quantity: i64,
    effect: Option<String>,
    chapter_id: Option<String>,
    lost_chapter_id: Option<String>,
    node_id: Option<String>,
    user: String,
) -> Result<InventoryItem, String> {
    db.add_inventory_item(
        character_id,
        name,
        rarity,
        quantity,
        effect,
        chapter_id,
        lost_chapter_id,
        node_id,
        user,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_inventory_item(
    db: tauri::State<'_, Db>,
    id: String,
    name: String,
    rarity: Option<String>,
    quantity: i64,
    effect: Option<String>,
    chapter_id: Option<String>,
    lost_chapter_id: Option<String>,
    node_id: Option<String>,
    user: String,
) -> Result<InventoryItem, String> {
    db.update_inventory_item(
        id,
        name,
        rarity,
        quantity,
        effect,
        chapter_id,
        lost_chapter_id,
        node_id,
        user,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_inventory_item(db: tauri::State<'_, Db>, id: String, user: String) -> Result<(), String> {
    db.delete_inventory_item(&id, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_character_inventory(
    db: tauri::State<'_, Db>,
    character_id: String,
) -> Result<Vec<InventoryItem>, String> {
    db.list_inventory(&character_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_story_inventory(
    db: tauri::State<'_, Db>,
    story_id: String,
) -> Result<Vec<InventoryItem>, String> {
    db.list_story_inventory(&story_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn add_currency(
    db: tauri::State<'_, Db>,
    character_id: String,
    name: String,
    amount: i64,
    user: String,
) -> Result<CharacterCurrency, String> {
    db.add_currency(character_id, name, amount, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_currency(
    db: tauri::State<'_, Db>,
    id: String,
    name: String,
    amount: i64,
    user: String,
) -> Result<CharacterCurrency, String> {
    db.update_currency(id, name, amount, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_currency(db: tauri::State<'_, Db>, id: String, user: String) -> Result<(), String> {
    db.delete_currency(&id, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_character_currency(
    db: tauri::State<'_, Db>,
    character_id: String,
) -> Result<Vec<CharacterCurrency>, String> {
    db.list_currency(&character_id).map_err(|e| e.to_string())
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
    character_id: Option<String>,
) -> Result<Node, String> {
    db.create_node_with_character(
        story_id,
        node_type,
        label,
        content,
        pos_x,
        pos_y,
        created_by,
        character_id,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_graph_nodes(db: tauri::State<'_, Db>, story_id: String) -> Result<Vec<Node>, String> {
    db.list_nodes(&story_id).map_err(|e| e.to_string())
}

/// Numbers the live chapters 1..n in the order given. A list that misses or
/// repeats a chapter is refused rather than half-applied.
#[tauri::command]
fn set_chapter_order(
    db: tauri::State<'_, Db>,
    story_id: String,
    ordered_ids: Vec<String>,
    user: String,
) -> Result<Vec<Node>, String> {
    db.set_chapter_order(&story_id, ordered_ids, user)
        .map_err(|e| e.to_string())
}

/// Saves a chapter's arc, its in-world day and time, and its words against a
/// target. Nothing is derived: these are the numbers the author typed.
#[tauri::command]
fn set_chapter_details(
    db: tauri::State<'_, Db>,
    node_id: String,
    arc: Option<String>,
    words: Option<i64>,
    target: Option<i64>,
    pov: Option<String>,
    day: Option<i64>,
    time: Option<String>,
    user: String,
) -> Result<Node, String> {
    db.set_chapter_details(&node_id, arc, words, target, pov, day, time, user)
        .map_err(|e| e.to_string())
}

/// The notes of every chapter, oldest first. They are not on the board, so the
/// Chapters tab reads them separately.
#[tauri::command]
fn get_chapter_notes(db: tauri::State<'_, Db>, story_id: String) -> Result<Vec<Node>, String> {
    db.list_chapter_notes(&story_id).map_err(|e| e.to_string())
}

/// Adds a plain-text note under a chapter. The label is taken from its first
/// line so the trash and the history can name it.
#[tauri::command]
fn add_chapter_note(
    db: tauri::State<'_, Db>,
    chapter_id: String,
    text: String,
    user: String,
) -> Result<Node, String> {
    db.add_chapter_note(&chapter_id, text, user)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_chapter_note(
    db: tauri::State<'_, Db>,
    id: String,
    text: String,
    user: String,
) -> Result<Node, String> {
    db.update_note(&id, text, user).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_story_character_stats(
    db: tauri::State<'_, Db>,
    story_id: String,
) -> Result<Vec<CharacterStat>, String> {
    db.list_story_stats(&story_id).map_err(|e| e.to_string())
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
fn set_node_character(
    db: tauri::State<'_, Db>,
    node_id: String,
    character_id: Option<String>,
    user: String,
) -> Result<Node, String> {
    db.set_node_character(&node_id, character_id, user)
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
    db.create_edge(
        story_id,
        source_id,
        target_id,
        label,
        relation_type,
        created_by,
    )
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

/// What can be brought back: the deleted stories when no story is named, or the
/// deleted contents of one story.
#[tauri::command]
fn get_trash(
    db: tauri::State<'_, Db>,
    story_id: Option<String>,
) -> Result<Vec<DeletedItem>, String> {
    db.list_deleted(story_id.as_deref())
        .map_err(|e| e.to_string())
}

/// Undoes one deletion. The kind is what the trash row said it was, so the UI
/// never has to know which table an id belongs to.
#[tauri::command]
fn restore_deleted(
    db: tauri::State<'_, Db>,
    id: String,
    kind: String,
    user: String,
) -> Result<(), String> {
    match kind.as_str() {
        "story" => db.restore_story(&id, user),
        "character" => db.restore_character(&id, user),
        "node" => db.restore_node(&id, user),
        "edge" => db.restore_edge(&id, user),
        other => return Err(format!("nothing called {other} can be restored")),
    }
    .map_err(|e| e.to_string())
}

/// How long items stay in the trash, in days; `None` means forever.
#[tauri::command]
fn get_trash_retention(db: tauri::State<'_, Db>) -> Result<Option<i64>, String> {
    db.trash_retention_days().map_err(|e| e.to_string())
}

/// Sets the window and applies it immediately, so shortening it has a visible
/// effect instead of waiting for the next launch. Returns how many items went.
#[tauri::command]
fn set_trash_retention(db: tauri::State<'_, Db>, days: Option<i64>) -> Result<i64, String> {
    db.set_trash_retention_days(days)
        .map_err(|e| e.to_string())?;

    match days {
        Some(days) => db
            .purge_expired(days)
            .map(|purged| purged as i64)
            .map_err(|e| e.to_string()),
        None => Ok(0),
    }
}

/// Deletes one item from the trash for good.
#[tauri::command]
fn purge_deleted(
    db: tauri::State<'_, Db>,
    id: String,
    kind: String,
    user: String,
) -> Result<(), String> {
    match kind.as_str() {
        "story" => db.purge_story(&id, user),
        "character" => db.purge_character(&id, user),
        "node" => db.purge_node(&id, user),
        "edge" => db.purge_edge(&id, user),
        other => return Err(format!("nothing called {other} can be deleted permanently")),
    }
    .map_err(|e| e.to_string())
}

/// Puts one field back to what a history entry recorded, refusing when the field
/// changed again since — a revert never discards a newer edit.
#[tauri::command]
fn revert_change(db: tauri::State<'_, Db>, entry_id: String, user: String) -> Result<bool, String> {
    db.revert_change(&entry_id, user).map_err(|e| e.to_string())
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

    std::fs::write(&path, json).map_err(|e| format!("could not write {}: {e}", path.display()))?;

    Ok(path.display().to_string())
}

/// Writes a Markdown story bible beside the JSON exports and returns the path it
/// wrote. It is the hand-off for drafting elsewhere, so it carries only words.
#[tauri::command]
fn export_story_markdown(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    story_id: String,
) -> Result<String, String> {
    let bible = db.story_bible(&story_id).map_err(|e| e.to_string())?;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?
        .join("exports");

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("{}-story-bible-{stamp}.md", slugify(&bible.title)));

    std::fs::write(&path, bible.markdown)
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;

    Ok(path.display().to_string())
}

/// The Markdown a clipboard copy needs: the same text the saved file holds, so
/// the two cannot drift.
#[tauri::command]
fn story_bible_markdown(db: tauri::State<'_, Db>, story_id: String) -> Result<String, String> {
    db.story_bible(&story_id)
        .map(|bible| bible.markdown)
        .map_err(|e| e.to_string())
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

/// The launch copies of the database, newest first, for the backups dialog.
#[tauri::command]
fn list_backups(db: tauri::State<'_, Db>) -> Result<Vec<BackupInfo>, String> {
    db.list_backups().map_err(|e| e.to_string())
}

/// Puts one of those copies back in place and reopens the database from it. The
/// state it replaces is copied first, so the restore itself can be undone.
#[tauri::command]
fn restore_backup(db: tauri::State<'_, Db>, file_name: String) -> Result<(), String> {
    db.restore_backup(&file_name, SNAPSHOTS_TO_KEEP)
        .map_err(|e| e.to_string())
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            let path = resolve_db_path(app.handle())?;
            // Copies the file before opening it, so the copy is the state on disk
            // before any migration runs.
            let db = Db::open_with_snapshot(&path, SNAPSHOTS_TO_KEEP)?;

            // Launch is when the trash retention window is applied: the copy just
            // taken holds whatever this is about to remove.
            match db.trash_retention_days() {
                Ok(Some(days)) => {
                    if let Err(error) = db.purge_expired(days) {
                        eprintln!("could not apply the trash retention window: {error}");
                    }
                }
                Ok(None) => {}
                Err(error) => eprintln!("could not read the trash retention window: {error}"),
            }

            app.manage(db);
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
            set_character_progress,
            level_up_character,
            delete_character,
            set_character_stat,
            get_character_stats,
            set_character_attribute,
            get_character_attributes,
            delete_character_attribute,
            add_skill,
            update_skill,
            delete_skill,
            get_character_skills,
            get_story_skills,
            get_character_level_milestones,
            get_story_level_milestones,
            add_level_milestone,
            update_level_milestone,
            delete_level_milestone,
            get_skill_events,
            get_story_skill_events,
            add_skill_event,
            update_skill_event,
            delete_skill_event,
            add_inventory_item,
            update_inventory_item,
            delete_inventory_item,
            get_character_inventory,
            get_story_inventory,
            add_currency,
            update_currency,
            delete_currency,
            get_character_currency,
            create_graph_node,
            get_graph_nodes,
            set_chapter_order,
            set_chapter_details,
            get_chapter_notes,
            add_chapter_note,
            update_chapter_note,
            get_story_character_stats,
            update_graph_node_position,
            update_graph_node,
            set_node_character,
            create_graph_edge,
            update_graph_edge,
            get_graph_edges,
            get_audit_history,
            revert_change,
            update_story,
            delete_story,
            delete_node,
            delete_edge,
            get_trash,
            restore_deleted,
            purge_deleted,
            get_trash_retention,
            set_trash_retention,
            list_backups,
            restore_backup,
            export_story_json,
            export_story_markdown,
            story_bible_markdown,
            import_story_json,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
