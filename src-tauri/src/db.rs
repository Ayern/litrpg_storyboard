use once_cell::sync::Lazy;
use rusqlite::{params, Connection, Result as SqliteResult};
use std::sync::Mutex;
use uuid::Uuid;
use chrono::Utc;

pub static DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

pub fn init_db() -> SqliteResult<String> {
    let app_data = std::env::var("APPDATA")
        .or_else(|_| std::env::var("LOCALAPPDATA"))
        .unwrap_or_else(|_| ".".to_string());
    
    let db_path = format!("{}\\litrpg_storyboard\\storyboard.db", app_data);
    
    // Ensure directory exists
    if let Some(parent) = std::path::Path::new(&db_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let conn = Connection::open(&db_path)?;
    
    // Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON", [])?;

    // Stories
    conn.execute(
        "CREATE TABLE IF NOT EXISTS stories (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Characters
    conn.execute(
        "CREATE TABLE IF NOT EXISTS characters (
            id TEXT PRIMARY KEY,
            story_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Character Stats (simple key-value per character)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS character_stats (
            id TEXT PRIMARY KEY,
            character_id TEXT NOT NULL,
            stat_name TEXT NOT NULL,
            value INTEGER NOT NULL DEFAULT 0,
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Nodes (idea graph nodes: chapter, idea, character, location, event, etc.)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS nodes (
            id TEXT PRIMARY KEY,
            story_id TEXT NOT NULL,
            node_type TEXT NOT NULL,
            label TEXT NOT NULL,
            content TEXT,
            pos_x REAL NOT NULL DEFAULT 0,
            pos_y REAL NOT NULL DEFAULT 0,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Edges (connections between nodes)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS edges (
            id TEXT PRIMARY KEY,
            story_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            label TEXT,
            relation_type TEXT,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
            FOREIGN KEY(source_id) REFERENCES nodes(id) ON DELETE CASCADE,
            FOREIGN KEY(target_id) REFERENCES nodes(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Audit log for all changes with user attribution
    conn.execute(
        "CREATE TABLE IF NOT EXISTS audit_log (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL,
            field_changed TEXT,
            old_value TEXT,
            new_value TEXT,
            changed_by TEXT NOT NULL,
            changed_at TEXT NOT NULL
        )",
        [],
    )?;

    // Save connection
    {
        let mut guard = DB.lock().unwrap();
        *guard = Some(conn);
    }

    Ok(db_path)
}

fn get_conn() -> SqliteResult<std::sync::MutexGuard<'static, Option<Connection>>> {
    let guard = DB.lock().unwrap();
    if guard.is_none() {
        drop(guard);
        init_db()?;
        Ok(DB.lock().unwrap())
    } else {
        Ok(guard)
    }
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

// ===== MODELS =====

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct Story {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct Character {
    pub id: String,
    pub story_id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct CharacterStat {
    pub id: String,
    pub character_id: String,
    pub stat_name: String,
    pub value: i64,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct Node {
    pub id: String,
    pub story_id: String,
    pub node_type: String,
    pub label: String,
    pub content: Option<String>,
    pub pos_x: f64,
    pub pos_y: f64,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct Edge {
    pub id: String,
    pub story_id: String,
    pub source_id: String,
    pub target_id: String,
    pub label: Option<String>,
    pub relation_type: Option<String>,
    pub created_by: String,
    pub created_at: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct AuditEntry {
    pub id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub action: String,
    pub field_changed: Option<String>,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub changed_by: String,
    pub changed_at: String,
}

// ===== STORY OPERATIONS =====

pub fn create_story(title: String, description: Option<String>, user: String) -> SqliteResult<Story> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    conn.execute(
        "INSERT INTO stories (id, title, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![&id, &title, &description, &timestamp, &timestamp],
    )?;

    Ok(Story {
        id,
        title,
        description,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    })
}

pub fn list_stories() -> SqliteResult<Vec<Story>> {
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    let mut stmt = conn.prepare(
        "SELECT id, title, description, created_at, updated_at FROM stories ORDER BY updated_at DESC"
    )?;
    
    let rows = stmt.query_map([], |row| {
        Ok(Story {
            id: row.get(0)?,
            title: row.get(1)?,
            description: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;

    rows.collect()
}

pub fn get_story(id: &str) -> SqliteResult<Option<Story>> {
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    let mut stmt = conn.prepare(
        "SELECT id, title, description, created_at, updated_at FROM stories WHERE id = ?1"
    )?;
    
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(Story {
            id: row.get(0)?,
            title: row.get(1)?,
            description: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;

    Ok(rows.next().transpose()?)
}

// ===== CHARACTER OPERATIONS =====

pub fn create_character(story_id: String, name: String, description: Option<String>, user: String) -> SqliteResult<Character> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    conn.execute(
        "INSERT INTO characters (id, story_id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![&id, &story_id, &name, &description, &timestamp, &timestamp],
    )?;

    Ok(Character {
        id,
        story_id,
        name,
        description,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    })
}

pub fn list_characters(story_id: &str) -> SqliteResult<Vec<Character>> {
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    let mut stmt = conn.prepare(
        "SELECT id, story_id, name, description, created_at, updated_at 
         FROM characters WHERE story_id = ?1 ORDER BY name"
    )?;
    
    let rows = stmt.query_map(params![story_id], |row| {
        Ok(Character {
            id: row.get(0)?,
            story_id: row.get(1)?,
            name: row.get(2)?,
            description: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;

    rows.collect()
}

// ===== STAT OPERATIONS =====

pub fn add_or_update_stat(
    character_id: String,
    stat_name: String,
    value: i64,
    notes: Option<String>,
    user: String,
) -> SqliteResult<CharacterStat> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();

    // Check if stat already exists for this character + name
    let existing: Option<String> = conn.query_row(
        "SELECT id FROM character_stats WHERE character_id = ?1 AND stat_name = ?2",
        params![&character_id, &stat_name],
        |row| row.get(0),
    ).ok();

    if let Some(existing_id) = existing {
        // Update
        let old_value: i64 = conn.query_row(
            "SELECT value FROM character_stats WHERE id = ?1",
            params![&existing_id],
            |row| row.get(0),
        ).unwrap_or(0);

        conn.execute(
            "UPDATE character_stats SET value = ?1, notes = ?2, updated_at = ?3 WHERE id = ?4",
            params![value, &notes, &timestamp, &existing_id],
        )?;

        Ok(CharacterStat {
            id: existing_id,
            character_id,
            stat_name,
            value,
            notes,
            created_at: timestamp.clone(), // we don't track original created, keep simple
            updated_at: timestamp,
        })
    } else {
        // Insert new
        conn.execute(
            "INSERT INTO character_stats (id, character_id, stat_name, value, notes, created_at, updated_at) 
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![&id, &character_id, &stat_name, value, &notes, &timestamp, &timestamp],
        )?;

        Ok(CharacterStat {
            id,
            character_id,
            stat_name,
            value,
            notes,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }
}

pub fn list_stats(character_id: &str) -> SqliteResult<Vec<CharacterStat>> {
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    let mut stmt = conn.prepare(
        "SELECT id, character_id, stat_name, value, notes, created_at, updated_at 
         FROM character_stats WHERE character_id = ?1 ORDER BY stat_name"
    )?;
    
    let rows = stmt.query_map(params![character_id], |row| {
        Ok(CharacterStat {
            id: row.get(0)?,
            character_id: row.get(1)?,
            stat_name: row.get(2)?,
            value: row.get(3)?,
            notes: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;

    rows.collect()
}

// ===== NODE OPERATIONS (IDEA GRAPH) =====

pub fn create_node(
    story_id: String,
    node_type: String,
    label: String,
    content: Option<String>,
    pos_x: f64,
    pos_y: f64,
    created_by: String,
) -> SqliteResult<Node> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    conn.execute(
        "INSERT INTO nodes (id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![&id, &story_id, &node_type, &label, &content, pos_x, pos_y, &created_by, &timestamp, &timestamp],
    )?;

    Ok(Node {
        id,
        story_id,
        node_type,
        label,
        content,
        pos_x,
        pos_y,
        created_by,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    })
}

pub fn update_node_position(id: String, pos_x: f64, pos_y: f64, user: String) -> SqliteResult<()> {
    let timestamp = now();
    
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    conn.execute(
        "UPDATE nodes SET pos_x = ?1, pos_y = ?2, updated_at = ?3 WHERE id = ?4",
        params![pos_x, pos_y, &timestamp, &id],
    )?;

    Ok(())
}

pub fn list_nodes(story_id: &str) -> SqliteResult<Vec<Node>> {
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    let mut stmt = conn.prepare(
        "SELECT id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at 
         FROM nodes WHERE story_id = ?1 ORDER BY created_at"
    )?;
    
    let rows = stmt.query_map(params![story_id], |row| {
        Ok(Node {
            id: row.get(0)?,
            story_id: row.get(1)?,
            node_type: row.get(2)?,
            label: row.get(3)?,
            content: row.get(4)?,
            pos_x: row.get(5)?,
            pos_y: row.get(6)?,
            created_by: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;

    rows.collect()
}

// ===== EDGE OPERATIONS =====

pub fn create_edge(
    story_id: String,
    source_id: String,
    target_id: String,
    label: Option<String>,
    relation_type: Option<String>,
    created_by: String,
) -> SqliteResult<Edge> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    conn.execute(
        "INSERT INTO edges (id, story_id, source_id, target_id, label, relation_type, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![&id, &story_id, &source_id, &target_id, &label, &relation_type, &created_by, &timestamp],
    )?;

    Ok(Edge {
        id,
        story_id,
        source_id,
        target_id,
        label,
        relation_type,
        created_by,
        created_at: timestamp,
    })
}

pub fn list_edges(story_id: &str) -> SqliteResult<Vec<Edge>> {
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    let mut stmt = conn.prepare(
        "SELECT id, story_id, source_id, target_id, label, relation_type, created_by, created_at 
         FROM edges WHERE story_id = ?1"
    )?;
    
    let rows = stmt.query_map(params![story_id], |row| {
        Ok(Edge {
            id: row.get(0)?,
            story_id: row.get(1)?,
            source_id: row.get(2)?,
            target_id: row.get(3)?,
            label: row.get(4)?,
            relation_type: row.get(5)?,
            created_by: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;

    rows.collect()
}

// ===== AUDIT LOG =====

fn log_audit(
    entity_type: &str,
    entity_id: &str,
    action: &str,
    field_changed: Option<&str>,
    old_value: Option<String>,
    new_value: Option<String>,
    changed_by: &str,
    changed_at: &str,
) -> SqliteResult<()> {
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();
    
    let audit_id = Uuid::new_v4().to_string();
    
    conn.execute(
        "INSERT INTO audit_log (id, entity_type, entity_id, action, field_changed, old_value, new_value, changed_by, changed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            &audit_id,
            entity_type,
            entity_id,
            action,
            field_changed,
            old_value,
            new_value,
            changed_by,
            changed_at
        ],
    )?;

    Ok(())
}

pub fn get_audit_log(
    entity_type: Option<&str>,
    entity_id: Option<&str>,
    limit: i64,
) -> SqliteResult<Vec<AuditEntry>> {
    let conn_guard = get_conn()?;
    let conn = conn_guard.as_ref().unwrap();

    let mut entries = Vec::new();

    if let (Some(et), Some(eid)) = (entity_type, entity_id) {
        let mut stmt = conn.prepare(
            "SELECT id, entity_type, entity_id, action, field_changed, old_value, new_value, changed_by, changed_at 
             FROM audit_log 
             WHERE entity_type = ?1 AND entity_id = ?2 
             ORDER BY changed_at DESC 
             LIMIT ?3"
        )?;
        let rows = stmt.query_map(params![et, eid, limit], |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                entity_type: row.get(1)?,
                entity_id: row.get(2)?,
                action: row.get(3)?,
                field_changed: row.get(4)?,
                old_value: row.get(5)?,
                new_value: row.get(6)?,
                changed_by: row.get(7)?,
                changed_at: row.get(8)?,
            })
        })?;
        for entry in rows {
            entries.push(entry?);
        }
    } else if let Some(et) = entity_type {
        let mut stmt = conn.prepare(
            "SELECT id, entity_type, entity_id, action, field_changed, old_value, new_value, changed_by, changed_at 
             FROM audit_log 
             WHERE entity_type = ?1 
             ORDER BY changed_at DESC 
             LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![et, limit], |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                entity_type: row.get(1)?,
                entity_id: row.get(2)?,
                action: row.get(3)?,
                field_changed: row.get(4)?,
                old_value: row.get(5)?,
                new_value: row.get(6)?,
                changed_by: row.get(7)?,
                changed_at: row.get(8)?,
            })
        })?;
        for entry in rows {
            entries.push(entry?);
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, entity_type, entity_id, action, field_changed, old_value, new_value, changed_by, changed_at 
             FROM audit_log 
             ORDER BY changed_at DESC 
             LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                entity_type: row.get(1)?,
                entity_id: row.get(2)?,
                action: row.get(3)?,
                field_changed: row.get(4)?,
                old_value: row.get(5)?,
                new_value: row.get(6)?,
                changed_by: row.get(7)?,
                changed_at: row.get(8)?,
            })
        })?;
        for entry in rows {
            entries.push(entry?);
        }
    }

    Ok(entries)
}