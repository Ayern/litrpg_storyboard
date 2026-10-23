pub mod snapshots;

use chrono::Utc;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use uuid::Uuid;

/// Schema version tracked with `PRAGMA user_version`.
///
/// Bump this and add a matching block to [`migrate`] whenever the schema changes.
const SCHEMA_VERSION: i32 = 3;

pub type DbResult<T> = Result<T, DbError>;

#[derive(Debug)]
pub enum DbError {
    Sqlite(rusqlite::Error),
    /// A previous panic happened while the connection was locked. Reported instead
    /// of panicking again, which with `panic = "abort"` would kill the app.
    Poisoned,
    NotFound(&'static str),
    /// The data is well formed but cannot be restored — for example a connection
    /// pointing at a node the file does not contain.
    Invalid(String),
}

impl From<rusqlite::Error> for DbError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "{error}"),
            Self::Poisoned => write!(f, "database connection is in a poisoned state"),
            Self::NotFound(what) => write!(f, "{what} not found"),
            Self::Invalid(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for DbError {}

/// Owns the single SQLite connection and hands it out under a lock.
///
/// Every public method acquires the lock exactly once and passes `&Connection`
/// down to helpers such as [`log_audit`]. That discipline is what makes this
/// deadlock-free: `std::sync::Mutex` is not reentrant, so a helper must never
/// call back into a public method that locks again.
pub struct Db {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
}

impl Db {
    pub fn open(path: &Path) -> DbResult<Self> {
        let conn = Connection::open(path)?;
        let db = Self::from_connection(conn)?;
        Ok(Self {
            path: Some(path.to_path_buf()),
            ..db
        })
    }

    /// Opens the database after copying it into a `snapshots` folder beside it.
    ///
    /// The copy is taken before `migrate` runs, so a migration that goes wrong,
    /// or a session that ends badly, can be undone by putting the previous file
    /// back. Note that the audit log cannot do this: its delete entries keep a
    /// name or a label, not the row.
    ///
    /// A copy that cannot be written is reported and then ignored. A read-only
    /// folder should not cost the user their session, even though it does cost
    /// them the safety net.
    pub fn open_with_snapshot(path: &Path, keep: usize) -> DbResult<Self> {
        if let Err(error) = snapshots::snapshot(path, keep) {
            eprintln!("could not copy the database before opening it: {error}");
        }

        Self::open(path)
    }

    /// In-memory database, used by the unit tests.
    #[cfg(test)]
    pub fn open_in_memory() -> DbResult<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> DbResult<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: None,
        })
    }

    /// Where this database lives, for display in the UI.
    pub fn location(&self) -> String {
        self.path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "in-memory database".to_string())
    }

    fn conn(&self) -> DbResult<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| DbError::Poisoned)
    }

    // ===== STORY OPERATIONS =====

    pub fn create_story(
        &self,
        title: String,
        description: Option<String>,
        user: String,
    ) -> DbResult<Story> {
        let id = Uuid::new_v4().to_string();
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        tx.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&id, &title, &description, &timestamp, &timestamp],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&id),
                entity_type: "story",
                entity_id: &id,
                action: "create",
                field_changed: None,
                old_value: None,
                new_value: Some(title.clone()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(Story {
            id,
            title,
            description,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    pub fn list_stories(&self) -> DbResult<Vec<Story>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT id, title, description, created_at, updated_at
             FROM stories WHERE deleted_at IS NULL ORDER BY updated_at DESC",
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

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    pub fn get_story(&self, id: &str) -> DbResult<Option<Story>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT id, title, description, created_at, updated_at
             FROM stories WHERE id = ?1 AND deleted_at IS NULL",
        )?;

        let story = stmt
            .query_row(params![id], |row| {
                Ok(Story {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .optional()?;

        Ok(story)
    }

    // ===== CHARACTER OPERATIONS =====

    pub fn create_character(
        &self,
        story_id: String,
        name: String,
        description: Option<String>,
        user: String,
    ) -> DbResult<Character> {
        let id = Uuid::new_v4().to_string();
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        tx.execute(
            "INSERT INTO characters (id, story_id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![&id, &story_id, &name, &description, &timestamp, &timestamp],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character",
                entity_id: &id,
                action: "create",
                field_changed: None,
                old_value: None,
                new_value: Some(name.clone()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(Character {
            id,
            story_id,
            name,
            description,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    pub fn list_characters(&self, story_id: &str) -> DbResult<Vec<Character>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT c.id, c.story_id, c.name, c.description, c.created_at, c.updated_at
             FROM characters c JOIN stories s ON s.id = c.story_id
             WHERE c.story_id = ?1 AND c.deleted_at IS NULL AND s.deleted_at IS NULL
             ORDER BY c.name",
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

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    // ===== STAT OPERATIONS =====

    pub fn add_or_update_stat(
        &self,
        character_id: String,
        stat_name: String,
        value: i64,
        notes: Option<String>,
        user: String,
    ) -> DbResult<CharacterStat> {
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        // Audit entries are scoped to a story, so resolve it from the character.
        let story_id: String = tx
            .query_row(
                "SELECT story_id FROM characters WHERE id = ?1",
                params![&character_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(DbError::NotFound("character"))?;

        let existing = tx
            .query_row(
                "SELECT id, value, created_at FROM character_stats WHERE character_id = ?1 AND stat_name = ?2",
                params![&character_id, &stat_name],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;

        let stat = if let Some((existing_id, old_value, created_at)) = existing {
            tx.execute(
                "UPDATE character_stats SET value = ?1, notes = ?2, updated_at = ?3 WHERE id = ?4",
                params![value, &notes, &timestamp, &existing_id],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_stat",
                    entity_id: &existing_id,
                    action: "update",
                    field_changed: Some("value"),
                    old_value: Some(old_value.to_string()),
                    new_value: Some(value.to_string()),
                    changed_by: &user,
                },
            )?;

            CharacterStat {
                id: existing_id,
                character_id,
                stat_name,
                value,
                notes,
                // Keep the real creation time rather than the update time.
                created_at,
                updated_at: timestamp,
            }
        } else {
            let id = Uuid::new_v4().to_string();

            tx.execute(
                "INSERT INTO character_stats (id, character_id, stat_name, value, notes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![&id, &character_id, &stat_name, value, &notes, &timestamp, &timestamp],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_stat",
                    entity_id: &id,
                    action: "create",
                    field_changed: Some("value"),
                    old_value: None,
                    new_value: Some(value.to_string()),
                    changed_by: &user,
                },
            )?;

            CharacterStat {
                id,
                character_id,
                stat_name,
                value,
                notes,
                created_at: timestamp.clone(),
                updated_at: timestamp,
            }
        };

        tx.commit()?;

        Ok(stat)
    }

    pub fn list_stats(&self, character_id: &str) -> DbResult<Vec<CharacterStat>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT s.id, s.character_id, s.stat_name, s.value, s.notes, s.created_at, s.updated_at
             FROM character_stats s
             JOIN characters c ON c.id = s.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE s.character_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY s.stat_name",
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

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    // ===== ATTRIBUTE OPERATIONS =====
    //
    // Attributes are named text values ("Class" = "Rogue", "Aura" = "Ember").
    // Setting a name that already exists updates it, exactly like stats, so the
    // sheet cannot end up with two different Classes.

    pub fn add_or_update_attribute(
        &self,
        character_id: String,
        attr_name: String,
        value: String,
        user: String,
    ) -> DbResult<CharacterAttribute> {
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        // Audit entries are scoped to a story, so resolve it from the character.
        let story_id: String = tx
            .query_row(
                "SELECT story_id FROM characters WHERE id = ?1",
                params![&character_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(DbError::NotFound("character"))?;

        let existing = tx
            .query_row(
                "SELECT id, value, created_at FROM character_attributes WHERE character_id = ?1 AND attr_name = ?2",
                params![&character_id, &attr_name],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;

        let attribute = if let Some((existing_id, old_value, created_at)) = existing {
            tx.execute(
                "UPDATE character_attributes SET value = ?1, updated_at = ?2 WHERE id = ?3",
                params![&value, &timestamp, &existing_id],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_attribute",
                    entity_id: &existing_id,
                    action: "update",
                    field_changed: Some("value"),
                    old_value: Some(old_value),
                    new_value: Some(value.clone()),
                    changed_by: &user,
                },
            )?;

            CharacterAttribute {
                id: existing_id,
                character_id,
                attr_name,
                value,
                // Keep the real creation time rather than the update time.
                created_at,
                updated_at: timestamp,
            }
        } else {
            let id = Uuid::new_v4().to_string();

            tx.execute(
                "INSERT INTO character_attributes (id, character_id, attr_name, value, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![&id, &character_id, &attr_name, &value, &timestamp, &timestamp],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_attribute",
                    entity_id: &id,
                    action: "create",
                    field_changed: Some("value"),
                    old_value: None,
                    new_value: Some(value.clone()),
                    changed_by: &user,
                },
            )?;

            CharacterAttribute {
                id,
                character_id,
                attr_name,
                value,
                created_at: timestamp.clone(),
                updated_at: timestamp,
            }
        };

        tx.commit()?;

        Ok(attribute)
    }

    pub fn list_attributes(&self, character_id: &str) -> DbResult<Vec<CharacterAttribute>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT a.id, a.character_id, a.attr_name, a.value, a.created_at, a.updated_at
             FROM character_attributes a
             JOIN characters c ON c.id = a.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE a.character_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY a.attr_name",
        )?;

        let rows = stmt.query_map(params![character_id], |row| {
            Ok(CharacterAttribute {
                id: row.get(0)?,
                character_id: row.get(1)?,
                attr_name: row.get(2)?,
                value: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    /// Removes one attribute. Deleting something already gone succeeds quietly, so
    /// a double click cannot fail.
    pub fn delete_attribute(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT a.attr_name, a.value, c.story_id
                 FROM character_attributes a
                 JOIN characters c ON c.id = a.character_id
                 WHERE a.id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;

        let Some((attr_name, value, story_id)) = existing else {
            return Ok(());
        };

        tx.execute("DELETE FROM character_attributes WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_attribute",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(format!("{attr_name}={value}")),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    // ===== NODE OPERATIONS (IDEA GRAPH) =====

    pub fn create_node(
        &self,
        story_id: String,
        node_type: String,
        label: String,
        content: Option<String>,
        pos_x: f64,
        pos_y: f64,
        created_by: String,
    ) -> DbResult<Node> {
        let id = Uuid::new_v4().to_string();
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        tx.execute(
            "INSERT INTO nodes (id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![&id, &story_id, &node_type, &label, &content, pos_x, pos_y, &created_by, &timestamp, &timestamp],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "node",
                entity_id: &id,
                action: "create",
                field_changed: None,
                old_value: None,
                new_value: Some(label.clone()),
                changed_by: &created_by,
            },
        )?;

        tx.commit()?;

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

    pub fn update_node_position(
        &self,
        id: String,
        pos_x: f64,
        pos_y: f64,
        user: String,
    ) -> DbResult<()> {
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let (story_id, old_x, old_y) = tx
            .query_row(
                "SELECT story_id, pos_x, pos_y FROM nodes WHERE id = ?1",
                params![&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, f64>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("node"))?;

        // A drag that ends where it started is not a change worth recording.
        if old_x != pos_x || old_y != pos_y {
            tx.execute(
                "UPDATE nodes SET pos_x = ?1, pos_y = ?2, updated_at = ?3 WHERE id = ?4",
                params![pos_x, pos_y, &timestamp, &id],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "node",
                    entity_id: &id,
                    action: "update",
                    field_changed: Some("position"),
                    old_value: Some(format!("{old_x:.1},{old_y:.1}")),
                    new_value: Some(format!("{pos_x:.1},{pos_y:.1}")),
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(())
    }

    /// Edits a node's label and/or content. Only the fields that actually changed
    /// are written, and each one gets its own history entry, so rewording a label
    /// is not buried under a content edit.
    pub fn update_node(
        &self,
        id: &str,
        label: String,
        content: Option<String>,
        user: String,
    ) -> DbResult<Node> {
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at
                 FROM nodes WHERE id = ?1",
                params![id],
                |row| {
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
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("node"))?;

        let label_changed = existing.label != label;
        let content_changed = existing.content != content;

        if !label_changed && !content_changed {
            return Ok(existing);
        }

        tx.execute(
            "UPDATE nodes SET label = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
            params![&label, &content, &timestamp, id],
        )?;

        if label_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "node",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("label"),
                    old_value: Some(existing.label.clone()),
                    new_value: Some(label.clone()),
                    changed_by: &user,
                },
            )?;
        }

        if content_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "node",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("content"),
                    old_value: existing.content.clone(),
                    new_value: content.clone(),
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(Node {
            label,
            content,
            updated_at: timestamp,
            ..existing
        })
    }

    pub fn list_nodes(&self, story_id: &str) -> DbResult<Vec<Node>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT n.id, n.story_id, n.node_type, n.label, n.content, n.pos_x, n.pos_y,
                    n.created_by, n.created_at, n.updated_at
             FROM nodes n JOIN stories s ON s.id = n.story_id
             WHERE n.story_id = ?1 AND n.deleted_at IS NULL AND s.deleted_at IS NULL
             ORDER BY n.created_at",
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

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    // ===== EDGE OPERATIONS =====

    pub fn create_edge(
        &self,
        story_id: String,
        source_id: String,
        target_id: String,
        label: Option<String>,
        relation_type: Option<String>,
        created_by: String,
    ) -> DbResult<Edge> {
        let id = Uuid::new_v4().to_string();
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        tx.execute(
            "INSERT INTO edges (id, story_id, source_id, target_id, label, relation_type, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![&id, &story_id, &source_id, &target_id, &label, &relation_type, &created_by, &timestamp],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "edge",
                entity_id: &id,
                action: "create",
                field_changed: None,
                old_value: None,
                new_value: Some(format!("{source_id} -> {target_id}")),
                changed_by: &created_by,
            },
        )?;

        tx.commit()?;

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

    pub fn list_edges(&self, story_id: &str) -> DbResult<Vec<Edge>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT e.id, e.story_id, e.source_id, e.target_id, e.label, e.relation_type,
                    e.created_by, e.created_at
             FROM edges e JOIN stories s ON s.id = e.story_id
             WHERE e.story_id = ?1 AND e.deleted_at IS NULL AND s.deleted_at IS NULL",
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

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    /// Edits a connection's label and/or relation type. As with nodes, only the
    /// fields that actually changed are written, and each gets its own history
    /// entry, so naming a connection is not buried under a type change. Both
    /// fields are optional: an edge may carry neither.
    pub fn update_edge(
        &self,
        id: &str,
        label: Option<String>,
        relation_type: Option<String>,
        user: String,
    ) -> DbResult<Edge> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT id, story_id, source_id, target_id, label, relation_type, created_by, created_at
                 FROM edges WHERE id = ?1",
                params![id],
                |row| {
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
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("edge"))?;

        let label_changed = existing.label != label;
        let relation_changed = existing.relation_type != relation_type;

        if !label_changed && !relation_changed {
            return Ok(existing);
        }

        tx.execute(
            "UPDATE edges SET label = ?1, relation_type = ?2 WHERE id = ?3",
            params![&label, &relation_type, id],
        )?;

        if label_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "edge",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("label"),
                    old_value: existing.label.clone(),
                    new_value: label.clone(),
                    changed_by: &user,
                },
            )?;
        }

        if relation_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "edge",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("relation_type"),
                    old_value: existing.relation_type.clone(),
                    new_value: relation_type.clone(),
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(Edge {
            label,
            relation_type,
            ..existing
        })
    }

    // ===== AUDIT LOG =====

    /// Newest-first history with no window boundary, optionally narrowed to one
    /// story and/or entity. The app itself pages through `get_audit_page`; this is
    /// the convenience the tests read whole histories with.
    #[cfg(test)]
    pub fn get_audit_log(
        &self,
        story_id: Option<&str>,
        entity_type: Option<&str>,
        entity_id: Option<&str>,
        limit: i64,
    ) -> DbResult<Vec<AuditEntry>> {
        let guard = self.conn()?;
        Ok(query_audit(
            &guard,
            story_id,
            entity_type,
            entity_id,
            Some(limit),
            0,
        )?)
    }

    /// One window of history plus the total matching the same filter. The count is
    /// queried from the same filter as the rows, so a page can never claim to be
    /// the last one while the rest of the history is still there.
    pub fn get_audit_page(
        &self,
        story_id: Option<&str>,
        entity_type: Option<&str>,
        entity_id: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> DbResult<AuditPage> {
        // A caller asking for zero rows, or a negative window, is asked for
        // something SQLite would answer unhelpfully; keep the window sane instead.
        let limit = limit.clamp(1, MAX_AUDIT_PAGE);
        let offset = offset.max(0);

        let guard = self.conn()?;
        let (filter, args) = audit_filters(story_id, entity_type, entity_id);

        let total: i64 = guard.query_row(
            &format!("SELECT COUNT(*) FROM audit_log{filter}"),
            rusqlite::params_from_iter(args),
            |row| row.get(0),
        )?;

        let entries = query_audit(
            &guard,
            story_id,
            entity_type,
            entity_id,
            Some(limit),
            offset,
        )?;

        Ok(AuditPage { entries, total })
    }

    // ===== EXPORT =====

    /// Everything needed to restore a story elsewhere, including its full history.
    pub fn export_story(&self, story_id: &str) -> DbResult<StoryExport> {
        let guard = self.conn()?;

        let story = guard
            .query_row(
                "SELECT id, title, description, created_at, updated_at
             FROM stories WHERE id = ?1 AND deleted_at IS NULL",
                params![story_id],
                |row| {
                    Ok(Story {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        description: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("story"))?;

        let characters = {
            let mut stmt = guard.prepare(
                "SELECT id, story_id, name, description, created_at, updated_at
                 FROM characters WHERE story_id = ?1 AND deleted_at IS NULL ORDER BY name",
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
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let character_stats = {
            let mut stmt = guard.prepare(
                "SELECT id, character_id, stat_name, value, notes, created_at, updated_at
                 FROM character_stats
                 WHERE character_id IN (SELECT id FROM characters
                                         WHERE story_id = ?1 AND deleted_at IS NULL)
                 ORDER BY stat_name",
            )?;
            let rows = stmt.query_map(params![story_id], |row| {
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
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let character_attributes = {
            let mut stmt = guard.prepare(
                "SELECT id, character_id, attr_name, value, created_at, updated_at
                 FROM character_attributes
                 WHERE character_id IN (SELECT id FROM characters
                                         WHERE story_id = ?1 AND deleted_at IS NULL)
                 ORDER BY attr_name",
            )?;
            let rows = stmt.query_map(params![story_id], |row| {
                Ok(CharacterAttribute {
                    id: row.get(0)?,
                    character_id: row.get(1)?,
                    attr_name: row.get(2)?,
                    value: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let nodes = {
            let mut stmt = guard.prepare(
                "SELECT id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at
                 FROM nodes WHERE story_id = ?1 AND deleted_at IS NULL ORDER BY created_at",
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
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let edges = {
            let mut stmt = guard.prepare(
                "SELECT id, story_id, source_id, target_id, label, relation_type, created_by, created_at
                 FROM edges WHERE story_id = ?1 AND deleted_at IS NULL",
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
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let audit_trail = query_audit(&guard, Some(story_id), None, None, None, 0)?;

        Ok(StoryExport {
            exported_at: now(),
            story,
            characters,
            character_stats,
            character_attributes,
            nodes,
            edges,
            audit_trail,
        })
    }

    // ===== STORY MAINTENANCE =====

    /// Renames a story. Renaming to the name it already has is not a change, so
    /// it writes nothing at all.
    pub fn update_story(&self, id: &str, title: String, user: String) -> DbResult<Story> {
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT id, title, description, created_at, updated_at
             FROM stories WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |row| {
                    Ok(Story {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        description: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("story"))?;

        if existing.title == title {
            return Ok(existing);
        }

        tx.execute(
            "UPDATE stories SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![&title, &timestamp, id],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(id),
                entity_type: "story",
                entity_id: id,
                action: "update",
                field_changed: Some("title"),
                old_value: Some(existing.title),
                new_value: Some(title.clone()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(Story {
            title,
            updated_at: timestamp,
            ..existing
        })
    }

    /// Moves a story to the trash. Its contents keep whatever state they already
    /// had, so restoring the story brings back exactly what was live beforehand,
    /// and anything deleted separately stays in the trash.
    pub fn delete_story(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT title FROM stories WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        // Already in the trash: nothing to move, nothing to record.
        let Some(title) = existing else {
            return Ok(());
        };

        let characters: i64 = tx.query_row(
            "SELECT count(*) FROM characters WHERE story_id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )?;
        let nodes: i64 = tx.query_row(
            "SELECT count(*) FROM nodes WHERE story_id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )?;
        let edges: i64 = tx.query_row(
            "SELECT count(*) FROM edges WHERE story_id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )?;

        tx.execute(
            "UPDATE stories SET deleted_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(id),
                entity_type: "story",
                entity_id: id,
                action: "soft_delete",
                field_changed: None,
                old_value: Some(format!(
                    "{title} ({characters} characters, {nodes} nodes, {edges} edges)"
                )),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    // ===== DELETIONS =====

    /// Moves a node to the trash, along with the connections attached to it.
    ///
    /// The node and those connections share one timestamp, so restoring the node
    /// brings back exactly the connections that went with it, and ones the user
    /// removed separately stay in the trash.
    pub fn delete_node(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, label FROM nodes WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((story_id, label)) = existing else {
            return Ok(());
        };

        let attached = {
            let mut stmt = tx.prepare(
                "SELECT id, source_id, target_id FROM edges
                 WHERE (source_id = ?1 OR target_id = ?1) AND deleted_at IS NULL",
            )?;
            let rows = stmt.query_map(params![id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let timestamp = now();

        tx.execute(
            "UPDATE nodes SET deleted_at = ?2 WHERE id = ?1",
            params![id, &timestamp],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "node",
                entity_id: id,
                action: "soft_delete",
                field_changed: None,
                old_value: Some(label),
                new_value: None,
                changed_by: &user,
            },
        )?;

        for (edge_id, source_id, target_id) in attached {
            tx.execute(
                "UPDATE edges SET deleted_at = ?2 WHERE id = ?1",
                params![&edge_id, &timestamp],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "edge",
                    entity_id: &edge_id,
                    action: "soft_delete",
                    field_changed: None,
                    old_value: Some(format!("{source_id} -> {target_id}")),
                    new_value: None,
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(())
    }

    /// Moves a single connection to the trash. Already gone is not an error,
    /// which matters because deleting a node also moves its connections.
    pub fn delete_edge(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, source_id, target_id
                   FROM edges WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;

        let Some((story_id, source_id, target_id)) = existing else {
            return Ok(());
        };

        tx.execute(
            "UPDATE edges SET deleted_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "edge",
                entity_id: id,
                action: "soft_delete",
                field_changed: None,
                old_value: Some(format!("{source_id} -> {target_id}")),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    // ===== CHARACTER MAINTENANCE =====

    /// Renames a character and/or edits its description. Only the fields that
    /// actually changed are written, and each one gets its own history entry so
    /// a rename is not buried under a description tweak.
    pub fn update_character(
        &self,
        id: &str,
        name: String,
        description: Option<String>,
        user: String,
    ) -> DbResult<Character> {
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT id, story_id, name, description, created_at, updated_at FROM characters WHERE id = ?1",
                params![id],
                |row| {
                    Ok(Character {
                        id: row.get(0)?,
                        story_id: row.get(1)?,
                        name: row.get(2)?,
                        description: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("character"))?;

        let name_changed = existing.name != name;
        let description_changed = existing.description != description;

        if !name_changed && !description_changed {
            return Ok(existing);
        }

        tx.execute(
            "UPDATE characters SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
            params![&name, &description, &timestamp, id],
        )?;

        if name_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "character",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("name"),
                    old_value: Some(existing.name.clone()),
                    new_value: Some(name.clone()),
                    changed_by: &user,
                },
            )?;
        }

        if description_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "character",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("description"),
                    old_value: existing.description.clone(),
                    new_value: description.clone(),
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(Character {
            name,
            description,
            updated_at: timestamp,
            ..existing
        })
    }

    /// Moves a character to the trash. Its stats and attributes are not copied
    /// anywhere: they stay attached to it, hidden while it is in the trash, and
    /// come back untouched when it is restored.
    pub fn delete_character(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, name FROM characters WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((story_id, name)) = existing else {
            return Ok(());
        };

        tx.execute(
            "UPDATE characters SET deleted_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character",
                entity_id: id,
                action: "soft_delete",
                field_changed: None,
                old_value: Some(name),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    // ===== TRASH =====

    /// What is in the trash: the deleted stories when no story is named, or the
    /// deleted characters, nodes and connections belonging to one story.
    pub fn list_deleted(&self, story_id: Option<&str>) -> DbResult<Vec<DeletedItem>> {
        let guard = self.conn()?;

        let mut stmt = match story_id {
            None => guard.prepare(
                "SELECT id, 'story', title, id, deleted_at FROM stories
                  WHERE deleted_at IS NOT NULL
                  ORDER BY deleted_at DESC",
            )?,
            Some(_) => guard.prepare(
                "SELECT id, kind, label, story_id, deleted_at FROM (
                     SELECT id, 'character' AS kind, name AS label, story_id, deleted_at
                       FROM characters WHERE story_id = ?1 AND deleted_at IS NOT NULL
                     UNION ALL
                     SELECT id, 'node', label, story_id, deleted_at
                       FROM nodes WHERE story_id = ?1 AND deleted_at IS NOT NULL
                     UNION ALL
                     SELECT id, 'edge', COALESCE(label, relation_type, 'connection'),
                            story_id, deleted_at
                       FROM edges WHERE story_id = ?1 AND deleted_at IS NOT NULL
                 )
                 ORDER BY deleted_at DESC",
            )?,
        };

        let items = match story_id {
            None => {
                let rows = stmt.query_map([], |row| {
                    Ok(DeletedItem {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        label: row.get(2)?,
                        story_id: row.get(3)?,
                        deleted_at: row.get(4)?,
                    })
                })?;
                rows.collect::<SqliteResult<Vec<_>>>()?
            }
            Some(story_id) => {
                let rows = stmt.query_map(params![story_id], |row| {
                    Ok(DeletedItem {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        label: row.get(2)?,
                        story_id: row.get(3)?,
                        deleted_at: row.get(4)?,
                    })
                })?;
                rows.collect::<SqliteResult<Vec<_>>>()?
            }
        };

        Ok(items)
    }

    /// Undoes a story deletion. The story comes back with whatever was live when
    /// it was deleted; anything that was already in the trash separately stays
    /// there.
    pub fn restore_story(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT title FROM stories WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        let Some(title) = existing else {
            return Ok(());
        };

        tx.execute(
            "UPDATE stories SET deleted_at = NULL WHERE id = ?1",
            params![id],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(id),
                entity_type: "story",
                entity_id: id,
                action: "restore",
                field_changed: None,
                old_value: Some(title),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    /// Undoes a character deletion, stats and attributes included.
    pub fn restore_character(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, name FROM characters
                  WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((story_id, name)) = existing else {
            return Ok(());
        };

        tx.execute(
            "UPDATE characters SET deleted_at = NULL WHERE id = ?1",
            params![id],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character",
                entity_id: id,
                action: "restore",
                field_changed: None,
                old_value: Some(name),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    /// Undoes a node deletion and brings back the connections that were removed
    /// with it, recognised by sharing its deletion timestamp.
    pub fn restore_node(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, label, deleted_at FROM nodes
                  WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;

        let Some((story_id, label, timestamp)) = existing else {
            return Ok(());
        };

        let attached = {
            let mut stmt = tx.prepare(
                "SELECT id, source_id, target_id FROM edges
                 WHERE (source_id = ?1 OR target_id = ?1)
                   AND deleted_at IS NOT NULL AND deleted_at = ?2",
            )?;
            let rows = stmt.query_map(params![id, &timestamp], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        tx.execute(
            "UPDATE nodes SET deleted_at = NULL WHERE id = ?1",
            params![id],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "node",
                entity_id: id,
                action: "restore",
                field_changed: None,
                old_value: Some(label),
                new_value: None,
                changed_by: &user,
            },
        )?;

        for (edge_id, source_id, target_id) in attached {
            tx.execute(
                "UPDATE edges SET deleted_at = NULL WHERE id = ?1",
                params![&edge_id],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "edge",
                    entity_id: &edge_id,
                    action: "restore",
                    field_changed: None,
                    old_value: Some(format!("{source_id} -> {target_id}")),
                    new_value: None,
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(())
    }

    /// Undoes a single connection deletion. Refused while either end is still in
    /// the trash, since such a connection would draw itself to nowhere.
    pub fn restore_edge(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, source_id, target_id FROM edges
                  WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;

        let Some((story_id, source_id, target_id)) = existing else {
            return Ok(());
        };

        let live_ends: i64 = tx.query_row(
            "SELECT (SELECT count(*) FROM nodes WHERE id = ?1 AND deleted_at IS NULL)
                  + (SELECT count(*) FROM nodes WHERE id = ?2 AND deleted_at IS NULL)",
            params![&source_id, &target_id],
            |row| row.get(0),
        )?;

        if live_ends != 2 {
            return Err(DbError::Invalid(
                "restore the connected nodes first".to_string(),
            ));
        }

        tx.execute(
            "UPDATE edges SET deleted_at = NULL WHERE id = ?1",
            params![id],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "edge",
                entity_id: id,
                action: "restore",
                field_changed: None,
                old_value: Some(format!("{source_id} -> {target_id}")),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    /// Deletes a story from the database for good, along with everything in it.
    /// Only reachable for something already in the trash.
    pub fn purge_story(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT title FROM stories WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        let Some(title) = existing else {
            return Err(DbError::Invalid(
                "only a story in the trash can be deleted permanently".to_string(),
            ));
        };

        tx.execute("DELETE FROM stories WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(id),
                entity_type: "story",
                entity_id: id,
                action: "purge",
                field_changed: None,
                old_value: Some(title),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    /// Deletes a character from the database for good, stats and attributes too.
    pub fn purge_character(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, name FROM characters
                  WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((story_id, name)) = existing else {
            return Err(DbError::Invalid(
                "only a character in the trash can be deleted permanently".to_string(),
            ));
        };

        tx.execute("DELETE FROM characters WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character",
                entity_id: id,
                action: "purge",
                field_changed: None,
                old_value: Some(name),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    /// Deletes a node from the database for good, and every connection touching
    /// it — including ones whose own deletion had already put them in the trash.
    pub fn purge_node(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, label FROM nodes WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((story_id, label)) = existing else {
            return Err(DbError::Invalid(
                "only a node in the trash can be deleted permanently".to_string(),
            ));
        };

        tx.execute("DELETE FROM nodes WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "node",
                entity_id: id,
                action: "purge",
                field_changed: None,
                old_value: Some(label),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    /// Deletes a connection from the database for good.
    pub fn purge_edge(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, source_id, target_id FROM edges
                  WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;

        let Some((story_id, source_id, target_id)) = existing else {
            return Err(DbError::Invalid(
                "only a connection in the trash can be deleted permanently".to_string(),
            ));
        };

        tx.execute("DELETE FROM edges WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "edge",
                entity_id: id,
                action: "purge",
                field_changed: None,
                old_value: Some(format!("{source_id} -> {target_id}")),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    // ===== IMPORT =====

    /// Restores a story from an export as a **new** story.
    ///
    /// Every id is remapped, so importing the same file twice yields two
    /// independent stories and nothing that already exists is touched. Titles,
    /// positions and history are carried across, and the restore runs in a single
    /// transaction: either the whole story arrives or nothing changes at all.
    pub fn import_story(&self, export: StoryExport, user: String) -> DbResult<Story> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let story_id = Uuid::new_v4().to_string();
        let title = unique_story_title(&tx, &export.story.title)?;

        // Every id is remapped before anything is written, so references can be
        // rewritten consistently and the source ids stay free to collide with ours.
        let characters: HashMap<String, String> = export
            .characters
            .iter()
            .map(|character| (character.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let stats: HashMap<String, String> = export
            .character_stats
            .iter()
            .map(|stat| (stat.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let attributes: HashMap<String, String> = export
            .character_attributes
            .iter()
            .map(|attribute| (attribute.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let nodes: HashMap<String, String> = export
            .nodes
            .iter()
            .map(|node| (node.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let edges: HashMap<String, String> = export
            .edges
            .iter()
            .map(|edge| (edge.id.clone(), Uuid::new_v4().to_string()))
            .collect();

        // Refuse a file whose contents cannot be restored rather than quietly
        // dropping the parts that do not fit.
        for stat in &export.character_stats {
            if !characters.contains_key(&stat.character_id) {
                return Err(DbError::Invalid(format!(
                    "the stat '{}' belongs to a character the file does not contain",
                    stat.stat_name
                )));
            }
        }

        for attribute in &export.character_attributes {
            if !characters.contains_key(&attribute.character_id) {
                return Err(DbError::Invalid(format!(
                    "the attribute '{}' belongs to a character the file does not contain",
                    attribute.attr_name
                )));
            }
        }

        for edge in &export.edges {
            if !nodes.contains_key(&edge.source_id) || !nodes.contains_key(&edge.target_id) {
                return Err(DbError::Invalid(
                    "a connection points at a node the file does not contain".to_string(),
                ));
            }
        }

        tx.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                &story_id,
                &title,
                &export.story.description,
                &export.story.created_at,
                &export.story.updated_at
            ],
        )?;

        for character in &export.characters {
            tx.execute(
                "INSERT INTO characters (id, story_id, name, description, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &characters[&character.id],
                    &story_id,
                    &character.name,
                    &character.description,
                    &character.created_at,
                    &character.updated_at
                ],
            )?;
        }

        for stat in &export.character_stats {
            tx.execute(
                "INSERT INTO character_stats (id, character_id, stat_name, value, notes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    &stats[&stat.id],
                    &characters[&stat.character_id],
                    &stat.stat_name,
                    stat.value,
                    &stat.notes,
                    &stat.created_at,
                    &stat.updated_at
                ],
            )?;
        }

        for attribute in &export.character_attributes {
            tx.execute(
                "INSERT INTO character_attributes (id, character_id, attr_name, value, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &attributes[&attribute.id],
                    &characters[&attribute.character_id],
                    &attribute.attr_name,
                    &attribute.value,
                    &attribute.created_at,
                    &attribute.updated_at
                ],
            )?;
        }

        for node in &export.nodes {
            tx.execute(
                "INSERT INTO nodes (id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    &nodes[&node.id],
                    &story_id,
                    &node.node_type,
                    &node.label,
                    &node.content,
                    node.pos_x,
                    node.pos_y,
                    &node.created_by,
                    &node.created_at,
                    &node.updated_at
                ],
            )?;
        }

        for edge in &export.edges {
            tx.execute(
                "INSERT INTO edges (id, story_id, source_id, target_id, label, relation_type, created_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    &edges[&edge.id],
                    &story_id,
                    &nodes[&edge.source_id],
                    &nodes[&edge.target_id],
                    &edge.label,
                    &edge.relation_type,
                    &edge.created_by,
                    &edge.created_at
                ],
            )?;
        }

        // History is restored with its original actor and timestamp. An entry for
        // something deleted before the export keeps its old id, exactly as it does
        // in the database it came from: that history is still history.
        for entry in &export.audit_trail {
            let remapped = match entry.entity_type.as_str() {
                "story" => Some(story_id.clone()),
                "character" => characters.get(&entry.entity_id).cloned(),
                "character_stat" => stats.get(&entry.entity_id).cloned(),
                "character_attribute" => attributes.get(&entry.entity_id).cloned(),
                "node" => nodes.get(&entry.entity_id).cloned(),
                "edge" => edges.get(&entry.entity_id).cloned(),
                _ => None,
            };

            tx.execute(
                "INSERT INTO audit_log
                 (id, story_id, entity_type, entity_id, action, field_changed, old_value, new_value, changed_by, changed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    Uuid::new_v4().to_string(),
                    &story_id,
                    &entry.entity_type,
                    remapped.as_deref().unwrap_or(&entry.entity_id),
                    &entry.action,
                    &entry.field_changed,
                    &entry.old_value,
                    &entry.new_value,
                    &entry.changed_by,
                    &entry.changed_at
                ],
            )?;
        }

        // The import itself is a change, so it is recorded like any other.
        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "story",
                entity_id: &story_id,
                action: "create",
                field_changed: None,
                old_value: None,
                new_value: Some(title.clone()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(Story {
            id: story_id,
            title,
            description: export.story.description,
            created_at: export.story.created_at,
            updated_at: export.story.updated_at,
        })
    }

}

// ===== MODELS =====

/// One deleted row, as the trash lists it.
///
/// `kind` is `story`, `character`, `node` or `edge`; `story_id` names the story
/// it belongs to (for a story, its own id), so a restore knows which view to
/// refresh.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct DeletedItem {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub story_id: String,
    pub deleted_at: String,
}

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
pub struct CharacterAttribute {
    pub id: String,
    pub character_id: String,
    pub attr_name: String,
    pub value: String,
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
    /// The story this change belongs to, so history can be shown per story.
    pub story_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    pub action: String,
    pub field_changed: Option<String>,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub changed_by: String,
    pub changed_at: String,
}

/// A window of history together with how many entries the filter matches in total.
#[derive(Debug, serde::Serialize)]
pub struct AuditPage {
    pub entries: Vec<AuditEntry>,
    pub total: i64,
}

/// Upper bound on one window of history, so a bad caller cannot ask for everything.
const MAX_AUDIT_PAGE: i64 = 500;

/// A complete, self-contained snapshot of one story.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct StoryExport {
    pub exported_at: String,
    pub story: Story,
    pub characters: Vec<Character>,
    pub character_stats: Vec<CharacterStat>,
    /// Absent from exports written before schema v2, so it defaults to empty.
    #[serde(default)]
    pub character_attributes: Vec<CharacterAttribute>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub audit_trail: Vec<AuditEntry>,
}

// ===== INTERNAL HELPERS =====
//
// These take a `&Connection` (or a transaction, which derefs to one) rather than
// reaching for the mutex. Locking happens once, in the public methods above.

/// Keeps the title unless a story already has it, in which case the copy is named
/// "(imported)", then "(imported 2)" and so on. Nothing existing is renamed.
fn unique_story_title(conn: &Connection, base: &str) -> SqliteResult<String> {
    fn taken(conn: &Connection, title: &str) -> SqliteResult<bool> {
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM stories WHERE title = ?1 AND deleted_at IS NULL",
                params![title],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    if !taken(conn, base)? {
        return Ok(base.to_string());
    }

    let mut attempt = 1;
    loop {
        let candidate = if attempt == 1 {
            format!("{base} (imported)")
        } else {
            format!("{base} (imported {attempt})")
        };

        if !taken(conn, &candidate)? {
            return Ok(candidate);
        }

        attempt += 1;
    }
}

struct AuditRecord<'a> {
    story_id: Option<&'a str>,
    entity_type: &'a str,
    entity_id: &'a str,
    action: &'a str,
    field_changed: Option<&'a str>,
    old_value: Option<String>,
    new_value: Option<String>,
    changed_by: &'a str,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

/// The `WHERE` clause shared by the history query and its count, so the rows and
/// the total can never disagree about which entries they are talking about.
fn audit_filters(
    story_id: Option<&str>,
    entity_type: Option<&str>,
    entity_id: Option<&str>,
) -> (String, Vec<Value>) {
    let mut sql = String::from(" WHERE 1 = 1");
    let mut args: Vec<Value> = Vec::new();

    if let Some(story_id) = story_id {
        sql.push_str(" AND story_id = ?");
        args.push(Value::Text(story_id.to_string()));
    }
    if let Some(entity_type) = entity_type {
        sql.push_str(" AND entity_type = ?");
        args.push(Value::Text(entity_type.to_string()));
    }
    if let Some(entity_id) = entity_id {
        sql.push_str(" AND entity_id = ?");
        args.push(Value::Text(entity_id.to_string()));
    }

    (sql, args)
}

fn query_audit(
    conn: &Connection,
    story_id: Option<&str>,
    entity_type: Option<&str>,
    entity_id: Option<&str>,
    limit: Option<i64>,
    offset: i64,
) -> SqliteResult<Vec<AuditEntry>> {
    let (filter, mut args) = audit_filters(story_id, entity_type, entity_id);
    let mut sql = String::from(
        "SELECT id, entity_type, entity_id, action, field_changed, old_value, new_value, changed_by, changed_at, story_id
         FROM audit_log",
    );
    sql.push_str(&filter);

    // rowid breaks ties so entries written in the same tick stay in order.
    sql.push_str(" ORDER BY changed_at DESC, rowid DESC");

    if let Some(limit) = limit {
        sql.push_str(" LIMIT ?");
        args.push(Value::Integer(limit));
        // SQLite only accepts OFFSET alongside a LIMIT, which is why a window with
        // no limit has no offset either.
        sql.push_str(" OFFSET ?");
        args.push(Value::Integer(offset));
    }

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), |row| {
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
            story_id: row.get(9)?,
        })
    })?;

    rows.collect()
}

fn log_audit(conn: &Connection, record: AuditRecord<'_>) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO audit_log (id, story_id, entity_type, entity_id, action, field_changed, old_value, new_value, changed_by, changed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            Uuid::new_v4().to_string(),
            record.story_id,
            record.entity_type,
            record.entity_id,
            record.action,
            record.field_changed,
            record.old_value,
            record.new_value,
            record.changed_by,
            now(),
        ],
    )?;

    Ok(())
}

// ===== MIGRATIONS =====

fn migrate(conn: &Connection) -> SqliteResult<()> {
    let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    if version >= SCHEMA_VERSION {
        return Ok(());
    }

    if version < 1 {
        conn.execute_batch(BASE_SCHEMA)?;

        // Databases created before story scoping existed have an audit_log
        // without this column, and CREATE TABLE IF NOT EXISTS leaves it alone.
        if !column_exists(conn, "audit_log", "story_id")? {
            conn.execute("ALTER TABLE audit_log ADD COLUMN story_id TEXT", [])?;
        }

        conn.execute_batch(INDEXES)?;
    }

    if version < 2 {
        conn.execute_batch(MIGRATION_002)?;
    }

    if version < 3 {
        conn.execute_batch(MIGRATION_003)?;
    }

    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;

    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> SqliteResult<bool> {
    // `table` is always one of our own literals, never user input.
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;

    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }

    Ok(false)
}

const BASE_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS character_stats (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        stat_name TEXT NOT NULL,
        value INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes (
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
    );

    CREATE TABLE IF NOT EXISTS edges (
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
    );

    CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        story_id TEXT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        field_changed TEXT,
        old_value TEXT,
        new_value TEXT,
        changed_by TEXT NOT NULL,
        changed_at TEXT NOT NULL
    );
";

/// Schema v2: named text attributes (Class, Title, Aura, Affinity). They live in
/// their own table because `character_stats.value` is an integer and cannot hold
/// them, and one table per kind keeps the numeric sheet intact.
const MIGRATION_002: &str = "
    CREATE TABLE IF NOT EXISTS character_attributes (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        attr_name TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
        UNIQUE(character_id, attr_name)
    );

    CREATE INDEX IF NOT EXISTS idx_character_attributes_character
        ON character_attributes (character_id);
";

/// Schema v3: deletions become recoverable.
///
/// `deleted_at` is NULL while a row is live and holds the RFC 3339 time it was
/// moved to the trash. Stats and attributes have no column of their own: they are
/// only reachable through their character, so they leave and return with it.
const MIGRATION_003: &str = "
    ALTER TABLE stories ADD COLUMN deleted_at TEXT;
    ALTER TABLE characters ADD COLUMN deleted_at TEXT;
    ALTER TABLE nodes ADD COLUMN deleted_at TEXT;
    ALTER TABLE edges ADD COLUMN deleted_at TEXT;
";

const INDEXES: &str = "
    CREATE INDEX IF NOT EXISTS idx_audit_log_story ON audit_log (story_id, changed_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id);
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_export_round_trips_into_a_new_story() {
        let source = Db::open_in_memory().unwrap();
        let story = source
            .create_story("Ash".into(), Some("notes".into()), "Ada".into())
            .unwrap();
        let character = source
            .create_character(story.id.clone(), "Rook".into(), Some("Scout".into()), "Ada".into())
            .unwrap();
        source
            .add_or_update_stat(character.id.clone(), "Level".into(), 7, None, "Ada".into())
            .unwrap();
        source
            .add_or_update_attribute(
                character.id.clone(),
                "Class".into(),
                "Rogue".into(),
                "Ada".into(),
            )
            .unwrap();
        let first = source
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "One".into(),
                None,
                5.0,
                6.0,
                "Ada".into(),
            )
            .unwrap();
        let second = source
            .create_node(
                story.id.clone(),
                "event".into(),
                "Two".into(),
                None,
                7.0,
                8.0,
                "Ada".into(),
            )
            .unwrap();
        source
            .create_edge(
                story.id.clone(),
                first.id.clone(),
                second.id.clone(),
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        let export = source.export_story(&story.id).unwrap();
        let history_before = export.audit_trail.len();

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(export, "Grace".into()).unwrap();

        assert_eq!(restored.title, "Ash");
        assert_eq!(restored.description.as_deref(), Some("notes"));
        assert_ne!(restored.id, story.id, "the story gets a fresh id");

        let characters = target.list_characters(&restored.id).unwrap();
        assert_eq!(characters.len(), 1);
        assert_eq!(characters[0].name, "Rook");
        assert_ne!(characters[0].id, character.id, "characters get fresh ids");

        let stats = target.list_stats(&characters[0].id).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].value, 7);

        let attributes = target.list_attributes(&characters[0].id).unwrap();
        assert_eq!(attributes.len(), 1);
        assert_eq!(attributes[0].value, "Rogue");

        // The graph arrives whole: both nodes and the connection between them.
        let nodes = target.list_nodes(&restored.id).unwrap();
        assert_eq!(nodes.len(), 2);
        let edges = target.list_edges(&restored.id).unwrap();
        assert_eq!(edges.len(), 1);
        assert!(nodes.iter().any(|node| node.id == edges[0].source_id));
        assert!(nodes.iter().any(|node| node.id == edges[0].target_id));

        // History came along, pointing at the new rows, plus the import itself.
        let history = target
            .get_audit_log(Some(&restored.id), None, None, 100)
            .unwrap();
        assert_eq!(history.len(), history_before + 1, "history plus the import entry");
        assert!(history
            .iter()
            .all(|entry| entry.story_id.as_deref() == Some(&restored.id)));
        assert!(history.iter().any(|entry| entry.entity_type == "character"
            && entry.entity_id == characters[0].id));
        assert!(history.iter().any(|entry| entry.changed_by == "Grace"));
    }

    #[test]
    fn importing_the_same_file_twice_creates_two_stories() {
        let source = Db::open_in_memory().unwrap();
        let story = source
            .create_story("Ash".into(), None, "Ada".into())
            .unwrap();

        let first = source.export_story(&story.id).unwrap();
        let second = source.export_story(&story.id).unwrap();

        let target = Db::open_in_memory().unwrap();
        let one = target.import_story(first, "Grace".into()).unwrap();
        let two = target.import_story(second, "Grace".into()).unwrap();

        assert_ne!(one.id, two.id);
        assert_eq!(one.title, "Ash");
        assert_eq!(two.title, "Ash (imported)", "the copy gets a distinct title");
        assert_eq!(target.list_stories().unwrap().len(), 2);
    }

    #[test]
    fn an_export_written_before_attributes_still_imports() {
        let source = Db::open_in_memory().unwrap();
        let story = source
            .create_story("Ash".into(), None, "Ada".into())
            .unwrap();
        source
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        // Strip the field a pre-v2 export would not have had.
        let export = source.export_story(&story.id).unwrap();
        let mut value = serde_json::to_value(&export).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("character_attributes");
        let older: StoryExport = serde_json::from_value(value).unwrap();
        assert!(older.character_attributes.is_empty());

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(older, "Grace".into()).unwrap();

        let characters = target.list_characters(&restored.id).unwrap();
        assert_eq!(characters.len(), 1);
        assert!(target.list_attributes(&characters[0].id).unwrap().is_empty());
    }

    #[test]
    fn a_connection_to_a_missing_node_is_rejected_without_writing_anything() {
        let source = Db::open_in_memory().unwrap();
        let story = source
            .create_story("Ash".into(), None, "Ada".into())
            .unwrap();
        let node = source
            .create_node(
                story.id.clone(),
                "idea".into(),
                "Only node".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let mut export = source.export_story(&story.id).unwrap();
        let target_node = node.id.clone();
        export.edges.push(Edge {
            id: "bogus-edge".into(),
            story_id: story.id.clone(),
            source_id: "missing-node".into(),
            target_id: target_node,
            label: None,
            relation_type: None,
            created_by: "Ada".into(),
            created_at: "now".into(),
        });

        let target = Db::open_in_memory().unwrap();
        let error = target.import_story(export, "Grace".into()).unwrap_err();

        assert!(
            error.to_string().contains("connection"),
            "unexpected error: {error}"
        );
        assert!(
            target.list_stories().unwrap().is_empty(),
            "a rejected import must write nothing"
        );
    }

    #[test]
    fn attributes_hold_text_and_update_by_name() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ash".into(), None, "Ada".into())
            .unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        db.add_or_update_attribute(
            character.id.clone(),
            "Class".into(),
            "Rogue".into(),
            "Ada".into(),
        )
        .unwrap();
        db.add_or_update_attribute(
            character.id.clone(),
            "Aura".into(),
            "Ember".into(),
            "Ada".into(),
        )
        .unwrap();

        let attributes = db.list_attributes(&character.id).unwrap();
        assert_eq!(attributes.len(), 2);
        assert_eq!(attributes[0].attr_name, "Aura", "ordered by name");

        // The same name updates in place rather than creating a second Class.
        db.add_or_update_attribute(
            character.id.clone(),
            "Class".into(),
            "Shadowblade".into(),
            "Grace".into(),
        )
        .unwrap();

        let attributes = db.list_attributes(&character.id).unwrap();
        assert_eq!(attributes.len(), 2);
        let class = attributes
            .iter()
            .find(|attribute| attribute.attr_name == "Class")
            .unwrap();
        assert_eq!(class.value, "Shadowblade");

        // Text attributes are not numeric, so they stay out of the stats table.
        assert!(db.list_stats(&character.id).unwrap().is_empty());

        let history = db
            .get_audit_log(Some(&story.id), Some("character_attribute"), None, 10)
            .unwrap();
        assert!(history
            .iter()
            .any(|entry| entry.action == "update" && entry.old_value.as_deref() == Some("Rogue")));
        assert!(history.iter().any(|entry| entry.changed_by == "Grace"));
    }

    #[test]
    fn deleting_an_attribute_is_recorded_and_idempotent() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ash".into(), None, "Ada".into())
            .unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let attribute = db
            .add_or_update_attribute(
                character.id.clone(),
                "Title".into(),
                "Ashborn".into(),
                "Ada".into(),
            )
            .unwrap();

        db.delete_attribute(&attribute.id, "Grace".into())
            .unwrap();
        assert!(db.list_attributes(&character.id).unwrap().is_empty());

        // A second delete of the same row is quiet and writes nothing.
        db.delete_attribute(&attribute.id, "Grace".into()).unwrap();

        let deletes = db
            .get_audit_log(
                Some(&story.id),
                Some("character_attribute"),
                Some(&attribute.id),
                10,
            )
            .unwrap()
            .into_iter()
            .filter(|entry| entry.action == "delete")
            .count();
        assert_eq!(deletes, 1, "the no-op delete wrote nothing");
    }

    #[test]
    fn a_deleted_character_takes_its_attributes_off_the_board() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ash".into(), None, "Ada".into())
            .unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let attribute = db
            .add_or_update_attribute(
                character.id.clone(),
                "Title".into(),
                "Ashborn".into(),
                "Ada".into(),
            )
            .unwrap();

        db.delete_character(&character.id, "Grace".into()).unwrap();

        assert!(db.list_attributes(&character.id).unwrap().is_empty());

        let history = db
            .get_audit_log(Some(&story.id), Some("character"), Some(&character.id), 10)
            .unwrap();
        assert_eq!(history.len(), 2, "creation and deletion are both recorded");
        assert!(history
            .iter()
            .any(|entry| entry.action == "soft_delete" && entry.changed_by == "Grace"));

        // The attribute was never removed, so the character comes back with it.
        db.restore_character(&character.id, "Grace".into()).unwrap();
        let restored = db.list_attributes(&character.id).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, attribute.id);
        assert_eq!(restored[0].value, "Ashborn");
    }

    #[test]
    fn the_trash_lists_what_belongs_to_one_story() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Trash".into(), None, "Ada".into()).unwrap();
        let other = db.create_story("Kept".into(), None, "Ada".into()).unwrap();
        let kept = db
            .create_character(story.id.clone(), "Kept".into(), None, "Ada".into())
            .unwrap();
        let gone = db
            .create_character(story.id.clone(), "Gone".into(), None, "Ada".into())
            .unwrap();
        let node = db
            .create_node(story.id.clone(), "idea".into(), "Hook".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();

        db.delete_character(&gone.id, "Ada".into()).unwrap();
        db.delete_node(&node.id, "Ada".into()).unwrap();
        db.delete_story(&other.id, "Ada".into()).unwrap();

        let trash = db.list_deleted(Some(&story.id)).unwrap();
        assert_eq!(trash.len(), 2);
        assert!(trash
            .iter()
            .any(|item| item.kind == "character" && item.label == "Gone"));
        assert!(trash
            .iter()
            .any(|item| item.kind == "node" && item.label == "Hook"));
        assert!(trash.iter().all(|item| item.story_id == story.id));

        let stories = db.list_deleted(None).unwrap();
        assert_eq!(stories.len(), 1);
        assert_eq!(stories[0].kind, "story");
        assert_eq!(stories[0].id, other.id);
        assert_eq!(stories[0].label, "Kept");

        // A live character is not in the trash, and its id is not a story id.
        assert!(db.list_deleted(Some(&kept.id)).unwrap().is_empty());
    }

    /// The command layer dispatches on these four strings, so a rename here has
    /// to be a deliberate change on both sides rather than a silent no-op.
    #[test]
    fn the_trash_reports_the_four_kinds_the_commands_understand() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Kinds".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let node = db
            .create_node(story.id.clone(), "idea".into(), "A".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        let other = db
            .create_node(story.id.clone(), "idea".into(), "B".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        let edge = db
            .create_edge(story.id.clone(), node.id.clone(), other.id.clone(), None, None, "Ada".into())
            .unwrap();

        db.delete_character(&character.id, "Ada".into()).unwrap();
        db.delete_edge(&edge.id, "Ada".into()).unwrap();
        db.delete_story(&story.id, "Ada".into()).unwrap();

        let kinds: Vec<String> = db
            .list_deleted(Some(&story.id))
            .unwrap()
            .into_iter()
            .map(|item| item.kind)
            .collect();
        assert!(kinds.contains(&"character".to_string()));
        assert!(kinds.contains(&"edge".to_string()));

        let stories = db.list_deleted(None).unwrap();
        assert_eq!(stories.len(), 1);
        assert_eq!(stories[0].kind, "story");

        // A deleted node is listed too, once the story is back.
        db.restore_story(&story.id, "Ada".into()).unwrap();
        db.delete_node(&node.id, "Ada".into()).unwrap();
        let kinds: Vec<String> = db
            .list_deleted(Some(&story.id))
            .unwrap()
            .into_iter()
            .map(|item| item.kind)
            .collect();
        assert!(kinds.contains(&"node".to_string()));

        // And every one of those four can be restored by the name it reported.
        for item in db.list_deleted(Some(&story.id)).unwrap() {
            match item.kind.as_str() {
                "character" => db.restore_character(&item.id, "Ada".into()).unwrap(),
                "node" => db.restore_node(&item.id, "Ada".into()).unwrap(),
                "edge" => {}
                other => panic!("the trash reported an unknown kind: {other}"),
            }
        }
    }

    #[test]
    fn restoring_a_story_leaves_separately_deleted_items_in_the_trash() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Split".into(), None, "Ada".into()).unwrap();
        let live = db
            .create_character(story.id.clone(), "Live".into(), None, "Ada".into())
            .unwrap();
        let gone = db
            .create_character(story.id.clone(), "Gone".into(), None, "Ada".into())
            .unwrap();
        db.create_node(story.id.clone(), "idea".into(), "Hook".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();

        db.delete_character(&gone.id, "Ada".into()).unwrap();
        db.delete_story(&story.id, "Ada".into()).unwrap();

        assert!(db.list_stories().unwrap().is_empty());

        db.restore_story(&story.id, "Ada".into()).unwrap();

        let characters = db.list_characters(&story.id).unwrap();
        assert_eq!(characters.len(), 1, "only what was live comes back");
        assert_eq!(characters[0].id, live.id);
        assert_eq!(db.list_nodes(&story.id).unwrap().len(), 1);
        assert_eq!(db.list_deleted(Some(&story.id)).unwrap().len(), 1);
    }

    #[test]
    fn purging_a_story_removes_it_and_its_contents_for_good() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Doomed".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        db.add_or_update_stat(character.id.clone(), "Level".into(), 3, None, "Ada".into())
            .unwrap();

        db.delete_story(&story.id, "Ada".into()).unwrap();
        db.purge_story(&story.id, "Grace".into()).unwrap();

        assert!(db.list_deleted(None).unwrap().is_empty());
        assert!(db.get_story(&story.id).unwrap().is_none());

        let stats: i64 = db
            .conn()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM character_stats WHERE character_id = ?1",
                params![character.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stats, 0, "the purged story took its stats with it");

        let purge = db
            .get_audit_log(None, Some("story"), Some(&story.id), 10)
            .unwrap()
            .into_iter()
            .find(|entry| entry.action == "purge")
            .expect("the permanent delete is recorded");
        assert_eq!(purge.changed_by, "Grace");
        assert_eq!(purge.old_value.as_deref(), Some("Doomed"));
    }

    #[test]
    fn purging_something_that_is_not_in_the_trash_is_refused() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Kept".into(), None, "Ada".into()).unwrap();
        let node = db
            .create_node(story.id.clone(), "idea".into(), "Live".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();

        assert!(
            db.purge_story(&story.id, "Ada".into()).is_err(),
            "a live story should not be purgeable"
        );
        assert!(db.purge_node(&node.id, "Ada".into()).is_err());
        assert_eq!(db.list_stories().unwrap().len(), 1);
        assert_eq!(db.list_nodes(&story.id).unwrap().len(), 1);

        db.delete_node(&node.id, "Ada".into()).unwrap();
        db.purge_node(&node.id, "Ada".into()).unwrap();
        assert!(
            db.purge_node(&node.id, "Ada".into()).is_err(),
            "purging is not repeatable"
        );
    }

    #[test]
    fn a_connection_waits_for_its_nodes_to_come_back() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Bonds".into(), None, "Ada".into()).unwrap();
        let from = db
            .create_node(story.id.clone(), "idea".into(), "A".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        let to = db
            .create_node(story.id.clone(), "idea".into(), "B".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        let edge = db
            .create_edge(story.id.clone(), from.id.clone(), to.id.clone(), None, None, "Ada".into())
            .unwrap();

        db.delete_edge(&edge.id, "Ada".into()).unwrap();
        db.delete_node(&from.id, "Ada".into()).unwrap();

        assert!(
            db.restore_edge(&edge.id, "Ada".into()).is_err(),
            "a connection to a node still in the trash should not come back"
        );

        // The connection went to the trash on its own, before the node did, so
        // restoring the node leaves it there.
        db.restore_node(&from.id, "Ada".into()).unwrap();
        assert!(db.list_edges(&story.id).unwrap().is_empty());

        db.restore_edge(&edge.id, "Ada".into()).unwrap();
        assert_eq!(db.list_edges(&story.id).unwrap().len(), 1);
    }

    #[test]
    fn restoring_something_that_is_not_in_the_trash_writes_nothing() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Live".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let before = db.get_audit_log(None, None, None, 100).unwrap().len();

        db.restore_story(&story.id, "Ada".into()).unwrap();
        db.restore_character(&character.id, "Ada".into()).unwrap();
        db.restore_node("does-not-exist", "Ada".into()).unwrap();
        db.restore_edge("does-not-exist", "Ada".into()).unwrap();

        assert_eq!(db.get_audit_log(None, None, None, 100).unwrap().len(), before);
    }

    #[test]
    fn migrating_a_version_2_database_leaves_every_row_live() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(MIGRATION_002).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES ('s1', 'Written before v3', NULL, 'then', 'then')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let deleted_at: Option<String> = conn
            .query_row("SELECT deleted_at FROM stories WHERE id = 's1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(deleted_at, None, "a migrated row starts live");
        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }
    #[test]
    fn migrating_a_version_1_database_adds_attributes_without_losing_data() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES ('s1', 'Written before v2', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO characters (id, story_id, name, description, created_at, updated_at)
             VALUES ('c1', 's1', 'Rook', NULL, 'then', 'then')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // The new table exists: this insert is the assertion.
        conn.execute(
            "INSERT INTO character_attributes
             (id, character_id, attr_name, value, created_at, updated_at)
             VALUES ('a1', 'c1', 'Class', 'Rogue', 'now', 'now')",
            [],
        )
        .unwrap();

        let title: String = conn
            .query_row("SELECT title FROM stories WHERE id = 's1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "Written before v2", "existing rows are untouched");
    }

    #[test]
    fn every_mutation_is_audited_with_the_acting_user() {
        let db = Db::open_in_memory().unwrap();

        let story = db
            .create_story("The Long Walk".into(), None, "Ada".into())
            .unwrap();
        let node = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "Opening hook".into(),
                None,
                10.0,
                20.0,
                "Grace".into(),
            )
            .unwrap();
        db.create_edge(
            story.id.clone(),
            node.id.clone(),
            node.id.clone(),
            None,
            None,
            "Grace".into(),
        )
        .unwrap();

        let entries = db.get_audit_log(None, None, None, 100).unwrap();
        assert_eq!(entries.len(), 3, "one audit row per mutation");

        let node_entry = entries
            .iter()
            .find(|entry| entry.entity_type == "node")
            .expect("node creation was not audited");
        assert_eq!(node_entry.action, "create");
        assert_eq!(node_entry.changed_by, "Grace");
        assert_eq!(node_entry.new_value.as_deref(), Some("Opening hook"));

        let story_entry = entries
            .iter()
            .find(|entry| entry.entity_type == "story")
            .expect("story creation was not audited");
        assert_eq!(story_entry.changed_by, "Ada");
    }

    #[test]
    fn audit_entries_are_scoped_to_their_story() {
        let db = Db::open_in_memory().unwrap();

        let first = db.create_story("First".into(), None, "Ada".into()).unwrap();
        let second = db.create_story("Second".into(), None, "Ada".into()).unwrap();
        db.create_character(first.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        let first_history = db.get_audit_log(Some(&first.id), None, None, 100).unwrap();
        assert_eq!(first_history.len(), 2, "story + character");
        assert!(first_history
            .iter()
            .all(|e| e.story_id.as_deref() == Some(&first.id)));

        let second_history = db.get_audit_log(Some(&second.id), None, None, 100).unwrap();
        assert_eq!(second_history.len(), 1, "just the story itself");

        let all = db.get_audit_log(None, None, None, 100).unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn audit_history_pages_without_repeating_or_dropping_entries() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Paged".into(), None, "Ada".into()).unwrap();

        for i in 0..5 {
            db.create_node(
                story.id.clone(),
                "idea".into(),
                format!("Node {i}"),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        }

        let all = db
            .get_audit_log(Some(&story.id), Some("node"), None, 100)
            .unwrap();
        assert_eq!(all.len(), 5);

        let mut paged = Vec::new();
        let mut offsets = Vec::new();
        let mut offset = 0;

        loop {
            let page = db
                .get_audit_page(Some(&story.id), Some("node"), None, 2, offset)
                .unwrap();

            assert_eq!(page.total, 5, "the total describes the filter, not the window");

            if page.entries.is_empty() {
                break;
            }

            offsets.push(offset);
            paged.extend(page.entries.into_iter().map(|entry| entry.id));
            offset += 2;
        }

        assert_eq!(offsets, vec![0, 2, 4], "three pages, then the end");
        assert_eq!(paged.len(), 5, "no entry was skipped or repeated");
        assert_eq!(
            paged,
            all.iter().map(|entry| entry.id.clone()).collect::<Vec<_>>(),
            "pages stitch back into exactly the full history"
        );
    }

    #[test]
    fn audit_paging_keeps_the_window_sane_and_scoped() {
        let db = Db::open_in_memory().unwrap();
        let first = db.create_story("First".into(), None, "Ada".into()).unwrap();
        let second = db.create_story("Second".into(), None, "Ada".into()).unwrap();
        db.create_character(first.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        // A zero or negative window still returns rows rather than quietly meaning
        // "no limit", which is what SQLite would do with LIMIT 0 / OFFSET -10.
        let clamped = db
            .get_audit_page(Some(&first.id), None, None, 0, -10)
            .unwrap();
        assert_eq!(clamped.total, 2, "story + character");
        assert_eq!(clamped.entries.len(), 1);

        // Asking past the end is empty, not an error, and still knows the total.
        let past_end = db
            .get_audit_page(Some(&first.id), None, None, 10, 2)
            .unwrap();
        assert!(past_end.entries.is_empty());
        assert_eq!(past_end.total, 2);

        // Another story's history never leaks into a filtered page.
        let other = db
            .get_audit_page(Some(&second.id), Some("character"), None, 10, 0)
            .unwrap();
        assert_eq!(other.total, 0);
        assert!(other.entries.is_empty());
    }

    #[test]
    fn stat_updates_capture_old_and_new_values() {
        let db = Db::open_in_memory().unwrap();

        let story = db.create_story("Stats".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        let created = db
            .add_or_update_stat(character.id.clone(), "Level".into(), 4, None, "Ada".into())
            .unwrap();
        let updated = db
            .add_or_update_stat(character.id.clone(), "Level".into(), 5, None, "Ada".into())
            .unwrap();

        // Updating an existing stat must not pretend it was just created.
        assert_eq!(created.id, updated.id);
        assert_eq!(created.created_at, updated.created_at);
        assert_eq!(created.value, 4);
        assert_eq!(updated.value, 5);

        let stat_history = db
            .get_audit_log(Some(&story.id), Some("character_stat"), None, 100)
            .unwrap();
        assert_eq!(stat_history.len(), 2);

        let update = stat_history
            .iter()
            .find(|entry| entry.action == "update")
            .expect("stat update was not audited");
        assert_eq!(update.old_value.as_deref(), Some("4"));
        assert_eq!(update.new_value.as_deref(), Some("5"));
        assert_eq!(update.field_changed.as_deref(), Some("value"));
    }

    #[test]
    fn position_updates_are_audited_but_no_op_drags_are_not() {
        let db = Db::open_in_memory().unwrap();

        let story = db.create_story("Graph".into(), None, "Ada".into()).unwrap();
        let node = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "A".into(),
                None,
                1.0,
                2.0,
                "Ada".into(),
            )
            .unwrap();

        db.update_node_position(node.id.clone(), 50.0, 60.0, "Grace".into())
            .unwrap();
        // Same coordinates: nothing changed, so nothing should be recorded.
        db.update_node_position(node.id.clone(), 50.0, 60.0, "Grace".into())
            .unwrap();

        let history = db
            .get_audit_log(Some(&story.id), Some("node"), None, 100)
            .unwrap();
        assert_eq!(history.len(), 2, "one create plus one real move");

        let move_entry = history
            .iter()
            .find(|e| e.action == "update")
            .expect("the move was not audited");
        assert_eq!(move_entry.changed_by, "Grace");
        assert_eq!(move_entry.old_value.as_deref(), Some("1.0,2.0"));
        assert_eq!(move_entry.new_value.as_deref(), Some("50.0,60.0"));

        let stored = db.list_nodes(&story.id).unwrap();
        assert_eq!(stored[0].pos_x, 50.0);
        assert_eq!(stored[0].pos_y, 60.0);
    }

    /// A write that cannot be audited must not be committed.
    #[test]
    fn audit_failure_rolls_back_the_mutation() {
        let db = Db::open_in_memory().unwrap();
        db.conn()
            .unwrap()
            .execute(
                "CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log
                 BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
                [],
            )
            .unwrap();

        let result = db.create_story("Never".into(), None, "Ada".into());

        assert!(result.is_err(), "the story write should have failed");
        assert!(db.list_stories().unwrap().is_empty(), "and rolled back");
    }

    /// History written before audit entries carried a story id must survive.
    #[test]
    fn existing_database_is_migrated_and_keeps_its_history() {
        let legacy = Connection::open_in_memory().unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE audit_log (
                    id TEXT PRIMARY KEY,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    field_changed TEXT,
                    old_value TEXT,
                    new_value TEXT,
                    changed_by TEXT NOT NULL,
                    changed_at TEXT NOT NULL
                );
                INSERT INTO audit_log (id, entity_type, entity_id, action, changed_by, changed_at)
                    VALUES ('old-1', 'story', 'story-1', 'create', 'Chris', '2026-01-01T00:00:00Z');",
            )
            .unwrap();
        assert_eq!(
            legacy
                .pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
                .unwrap(),
            0,
            "simulates a database written before migrations existed"
        );

        let db = Db::from_connection(legacy).unwrap();

        assert_eq!(
            db.conn()
                .unwrap()
                .pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
                .unwrap(),
            SCHEMA_VERSION
        );

        let migrated = db.get_audit_log(None, None, None, 10).unwrap();
        assert_eq!(migrated.len(), 1, "old history is preserved");
        assert_eq!(migrated[0].changed_by, "Chris");
        assert_eq!(migrated[0].story_id, None, "unknown for pre-migration rows");

        // And new writes now carry a story id.
        let story = db.create_story("Fresh".into(), None, "Ada".into()).unwrap();
        let fresh = db.get_audit_log(Some(&story.id), None, None, 10).unwrap();
        assert_eq!(fresh.len(), 1);
    }

    #[test]
    fn editing_a_node_records_each_changed_field_separately() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ash".into(), None, "Ada".into())
            .unwrap();
        let node = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "Opening hook".into(),
                None,
                10.0,
                20.0,
                "Ada".into(),
            )
            .unwrap();

        let updated = db
            .update_node(
                &node.id,
                "Opening beat".into(),
                Some("Ash wakes in the hold".into()),
                "Grace".into(),
            )
            .unwrap();

        assert_eq!(updated.label, "Opening beat");
        assert_eq!(updated.content.as_deref(), Some("Ash wakes in the hold"));
        assert_eq!(updated.pos_x, 10.0, "position and type are untouched");
        assert_eq!(updated.node_type, "idea");
        assert_eq!(updated.created_at, node.created_at, "creation time is kept");

        let history = db
            .get_audit_log(Some(&story.id), Some("node"), Some(&node.id), 10)
            .unwrap()
            .into_iter()
            .filter(|entry| entry.action == "update")
            .collect::<Vec<_>>();

        assert_eq!(history.len(), 2, "one entry per changed field");
        assert!(history.iter().all(|entry| entry.changed_by == "Grace"));
        assert!(history
            .iter()
            .any(|entry| entry.field_changed.as_deref() == Some("label")
                && entry.old_value.as_deref() == Some("Opening hook")
                && entry.new_value.as_deref() == Some("Opening beat")));
        assert!(history
            .iter()
            .any(|entry| entry.field_changed.as_deref() == Some("content")
                && entry.old_value.is_none()
                && entry.new_value.as_deref() == Some("Ash wakes in the hold")));

        let stored = db.list_nodes(&story.id).unwrap();
        assert_eq!(stored[0].label, "Opening beat");
    }

    #[test]
    fn editing_a_node_with_no_changes_writes_nothing() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ash".into(), None, "Ada".into())
            .unwrap();
        let node = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "Opening hook".into(),
                Some("notes".into()),
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let audit_before = db
            .get_audit_log(Some(&story.id), None, None, 100)
            .unwrap()
            .len();

        let unchanged = db
            .update_node(
                &node.id,
                "Opening hook".into(),
                Some("notes".into()),
                "Grace".into(),
            )
            .unwrap();

        assert_eq!(unchanged.updated_at, node.updated_at, "no timestamp bump");
        assert_eq!(
            db.get_audit_log(Some(&story.id), None, None, 100)
                .unwrap()
                .len(),
            audit_before,
            "a no-op edit is not history"
        );

        // A node that does not exist is an error rather than a silent success.
        assert!(db
            .update_node("missing", "x".into(), None, "Grace".into())
            .is_err());
    }

    #[test]
    fn deleting_a_node_hides_its_edges_and_records_both() {
        let db = Db::open_in_memory().unwrap();

        let story = db.create_story("Prune".into(), None, "Ada".into()).unwrap();
        let first = db
            .create_node(story.id.clone(), "idea".into(), "First".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        let second = db
            .create_node(story.id.clone(), "idea".into(), "Second".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        db.create_edge(
            story.id.clone(),
            first.id.clone(),
            second.id.clone(),
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        db.delete_node(&first.id, "Grace".into()).unwrap();

        let nodes = db.list_nodes(&story.id).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, second.id);

        let edges = db.list_edges(&story.id).unwrap();
        assert!(edges.is_empty(), "the attached edge went with the node");

        let deletes: Vec<AuditEntry> = db
            .get_audit_log(Some(&story.id), None, None, 100)
            .unwrap()
            .into_iter()
            .filter(|entry| entry.action == "soft_delete")
            .collect();

        assert_eq!(deletes.len(), 2, "the node and its edge are both recorded");
        assert!(deletes.iter().all(|entry| entry.changed_by == "Grace"));
        assert!(deletes.iter().any(|entry| entry.entity_type == "node"
            && entry.old_value.as_deref() == Some("First")));
        assert!(deletes.iter().any(|entry| entry.entity_type == "edge"));

        // The edge went to the trash with the node, so it comes back with it.
        db.restore_node(&first.id, "Grace".into()).unwrap();
        assert_eq!(db.list_nodes(&story.id).unwrap().len(), 2);
        assert_eq!(db.list_edges(&story.id).unwrap().len(), 1);
    }
    #[test]
    fn deleting_something_already_gone_is_a_quiet_no_op() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Empty".into(), None, "Ada".into()).unwrap();
        let before = db.get_audit_log(None, None, None, 100).unwrap().len();

        // The frontend reports a node's edges as deleted too, even though the
        // node's cascade already removed them, so this must not error.
        db.delete_edge("does-not-exist".into(), "Ada".into()).unwrap();
        db.delete_node("does-not-exist".into(), "Ada".into()).unwrap();
        db.delete_story("does-not-exist".into(), "Ada".into()).unwrap();

        assert_eq!(db.get_audit_log(None, None, None, 100).unwrap().len(), before);
        assert_eq!(db.list_stories().unwrap().len(), 1);
        assert_eq!(db.list_stories().unwrap()[0].id, story.id);
    }

    #[test]
    fn deleting_an_edge_records_it_and_puts_it_in_the_trash() {
        let db = Db::open_in_memory().unwrap();

        let story = db.create_story("Cut".into(), None, "Ada".into()).unwrap();
        let node = db
            .create_node(story.id.clone(), "idea".into(), "A".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        let other = db
            .create_node(story.id.clone(), "idea".into(), "B".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        let edge = db
            .create_edge(
                story.id.clone(),
                node.id.clone(),
                other.id.clone(),
                Some("cut me".into()),
                None,
                "Ada".into(),
            )
            .unwrap();

        db.delete_edge(&edge.id, "Grace".into()).unwrap();

        assert!(db.list_edges(&story.id).unwrap().is_empty());

        let delete = db
            .get_audit_log(Some(&story.id), Some("edge"), Some(&edge.id), 10)
            .unwrap()
            .into_iter()
            .find(|entry| entry.action == "soft_delete")
            .expect("edge deletion was not recorded");

        assert_eq!(delete.changed_by, "Grace");
        assert_eq!(
            delete.old_value.as_deref(),
            Some(format!("{} -> {}", node.id, other.id).as_str())
        );

        let trash = db.list_deleted(Some(&story.id)).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].kind, "edge");
        assert_eq!(trash[0].label, "cut me");

        // Both ends are still live, so it can come straight back.
        db.restore_edge(&edge.id, "Grace".into()).unwrap();
        assert_eq!(db.list_edges(&story.id).unwrap().len(), 1);
    }
    #[test]
    fn editing_an_edge_records_each_changed_field_separately() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Bonds".into(), None, "Ada".into()).unwrap();
        let from = db
            .create_node(story.id.clone(), "idea".into(), "A".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        let to = db
            .create_node(story.id.clone(), "idea".into(), "B".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        let edge = db
            .create_edge(
                story.id.clone(),
                from.id.clone(),
                to.id.clone(),
                Some("early".into()),
                Some("leads_to".into()),
                "Ada".into(),
            )
            .unwrap();

        let updated = db
            .update_edge(
                &edge.id,
                Some("later".into()),
                Some("foreshadows".into()),
                "Grace".into(),
            )
            .unwrap();

        assert_eq!(updated.label.as_deref(), Some("later"));
        assert_eq!(updated.relation_type.as_deref(), Some("foreshadows"));
        assert_eq!(updated.source_id, from.id, "endpoints are untouched");
        assert_eq!(updated.target_id, to.id);
        assert_eq!(updated.created_at, edge.created_at, "creation time is kept");

        let history = db
            .get_audit_log(Some(&story.id), Some("edge"), Some(&edge.id), 10)
            .unwrap()
            .into_iter()
            .filter(|entry| entry.action == "update")
            .collect::<Vec<_>>();

        assert_eq!(history.len(), 2, "one entry per changed field");
        assert!(history.iter().all(|entry| entry.changed_by == "Grace"));
        assert!(history
            .iter()
            .any(|entry| entry.field_changed.as_deref() == Some("label")
                && entry.old_value.as_deref() == Some("early")
                && entry.new_value.as_deref() == Some("later")));
        assert!(history
            .iter()
            .any(|entry| entry.field_changed.as_deref() == Some("relation_type")
                && entry.old_value.as_deref() == Some("leads_to")
                && entry.new_value.as_deref() == Some("foreshadows")));

        let stored = db.list_edges(&story.id).unwrap();
        assert_eq!(stored[0].label.as_deref(), Some("later"));
    }

    #[test]
    fn editing_an_edge_with_no_changes_writes_nothing() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Bonds".into(), None, "Ada".into()).unwrap();
        let from = db
            .create_node(story.id.clone(), "idea".into(), "A".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        let to = db
            .create_node(story.id.clone(), "idea".into(), "B".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();
        let edge = db
            .create_edge(
                story.id.clone(),
                from.id.clone(),
                to.id.clone(),
                Some("early".into()),
                None,
                "Ada".into(),
            )
            .unwrap();

        let audit_before = db
            .get_audit_log(Some(&story.id), None, None, 100)
            .unwrap()
            .len();

        let unchanged = db
            .update_edge(&edge.id, Some("early".into()), None, "Grace".into())
            .unwrap();

        assert_eq!(unchanged.label.as_deref(), Some("early"));
        assert_eq!(
            db.get_audit_log(Some(&story.id), None, None, 100)
                .unwrap()
                .len(),
            audit_before,
            "a no-op edit is not history"
        );

        // Clearing a field is a real change, recorded with no new value.
        db.update_edge(&edge.id, None, Some("leads_to".into()), "Grace".into())
            .unwrap();
        let cleared = db
            .get_audit_log(Some(&story.id), Some("edge"), Some(&edge.id), 10)
            .unwrap()
            .into_iter()
            .find(|entry| entry.field_changed.as_deref() == Some("label"))
            .expect("clearing a label was not recorded");
        assert_eq!(cleared.old_value.as_deref(), Some("early"));
        assert!(cleared.new_value.is_none());

        // A connection that does not exist is an error rather than a silent success.
        assert!(db
            .update_edge("missing", Some("x".into()), None, "Grace".into())
            .is_err());
    }

    #[test]
    fn renaming_a_story_records_the_previous_title() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Untitled".into(), None, "Ada".into()).unwrap();

        let renamed = db
            .update_story(&story.id, "The Long Walk".into(), "Grace".into())
            .unwrap();

        assert_eq!(renamed.title, "The Long Walk");
        assert_eq!(renamed.id, story.id);
        assert_eq!(renamed.created_at, story.created_at);
        assert_eq!(db.list_stories().unwrap()[0].title, "The Long Walk");

        let rename = db
            .get_audit_log(Some(&story.id), Some("story"), None, 10)
            .unwrap()
            .into_iter()
            .find(|entry| entry.action == "update")
            .expect("rename was not recorded");

        assert_eq!(rename.field_changed.as_deref(), Some("title"));
        assert_eq!(rename.old_value.as_deref(), Some("Untitled"));
        assert_eq!(rename.new_value.as_deref(), Some("The Long Walk"));
        assert_eq!(rename.changed_by, "Grace");
    }

    #[test]
    fn renaming_to_the_same_title_writes_nothing() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Same".into(), None, "Ada".into()).unwrap();
        let before = db.get_audit_log(None, None, None, 100).unwrap().len();

        let unchanged = db
            .update_story(&story.id, "Same".into(), "Grace".into())
            .unwrap();

        assert_eq!(unchanged.updated_at, story.updated_at);
        assert_eq!(db.get_audit_log(None, None, None, 100).unwrap().len(), before);
    }

    #[test]
    fn deleting_a_story_hides_its_contents_but_keeps_the_history() {
        let db = Db::open_in_memory().unwrap();

        let story = db.create_story("Doomed".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        db.add_or_update_stat(character.id.clone(), "Level".into(), 3, None, "Ada".into())
            .unwrap();
        let node = db
            .create_node(story.id.clone(), "idea".into(), "Hook".into(), None, 1.0, 1.0, "Ada".into())
            .unwrap();
        db.create_edge(
            story.id.clone(),
            node.id.clone(),
            node.id.clone(),
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        db.delete_story(&story.id, "Grace".into()).unwrap();

        assert!(db.list_stories().unwrap().is_empty());
        assert!(db.list_characters(&story.id).unwrap().is_empty());
        assert!(db.list_stats(&character.id).unwrap().is_empty());
        assert!(db.list_nodes(&story.id).unwrap().is_empty());
        assert!(db.list_edges(&story.id).unwrap().is_empty());

        let history = db.get_audit_log(Some(&story.id), None, None, 100).unwrap();
        assert!(
            history
                .iter()
                .any(|entry| entry.entity_type == "story"
                    && entry.action == "soft_delete"
                    && entry.changed_by == "Grace"),
            "the deletion itself is recorded"
        );
        assert!(
            history.len() > 1,
            "earlier history survives the deletion"
        );

        // Everything inside the story was live when it went to the trash, so all
        // of it comes back with the story.
        db.restore_story(&story.id, "Grace".into()).unwrap();
        assert_eq!(db.list_stories().unwrap().len(), 1);
        assert_eq!(db.list_characters(&story.id).unwrap().len(), 1);
        assert_eq!(db.list_nodes(&story.id).unwrap().len(), 1);
        assert_eq!(db.list_edges(&story.id).unwrap().len(), 1);
        assert_eq!(db.list_stats(&character.id).unwrap().len(), 1);
    }
    #[test]
    fn export_contains_the_whole_story() {
        let db = Db::open_in_memory().unwrap();

        let story = db
            .create_story("Exportable".into(), Some("notes".into()), "Ada".into())
            .unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        db.add_or_update_stat(character.id.clone(), "Level".into(), 7, None, "Ada".into())
            .unwrap();
        db.add_or_update_attribute(
            character.id.clone(),
            "Class".into(),
            "Rogue".into(),
            "Ada".into(),
        )
        .unwrap();
        let first = db
            .create_node(story.id.clone(), "chapter".into(), "One".into(), None, 5.0, 6.0, "Ada".into())
            .unwrap();
        let second = db
            .create_node(story.id.clone(), "event".into(), "Two".into(), None, 7.0, 8.0, "Ada".into())
            .unwrap();
        db.create_edge(
            story.id.clone(),
            first.id.clone(),
            second.id.clone(),
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        // Another story must not leak into the export.
        let other = db.create_story("Other".into(), None, "Ada".into()).unwrap();
        db.create_node(other.id.clone(), "idea".into(), "Nope".into(), None, 0.0, 0.0, "Ada".into())
            .unwrap();

        let export = db.export_story(&story.id).unwrap();

        assert_eq!(export.story.id, story.id);
        assert_eq!(export.story.description.as_deref(), Some("notes"));
        assert_eq!(export.characters.len(), 1);
        assert_eq!(export.character_stats.len(), 1);
        assert_eq!(export.character_attributes.len(), 1, "text attributes travel too");
        assert_eq!(export.character_attributes[0].value, "Rogue");
        assert_eq!(export.nodes.len(), 2);
        assert_eq!(export.edges.len(), 1);
        assert!(!export.audit_trail.is_empty());
        assert!(
            export.audit_trail.iter().all(|entry| entry.story_id.as_deref() == Some(&story.id)),
            "history from other stories must not be included"
        );
        assert!(!export.exported_at.is_empty());

        assert!(db.export_story("missing").is_err());
    }

    #[test]
    fn renaming_a_character_and_editing_its_description_are_recorded() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Cast".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), Some("Scout".into()), "Ada".into())
            .unwrap();

        let updated = db
            .update_character(
                &character.id,
                "Rook Ashford".into(),
                Some("Scout with a debt".into()),
                "Grace".into(),
            )
            .unwrap();

        assert_eq!(updated.name, "Rook Ashford");
        assert_eq!(updated.description.as_deref(), Some("Scout with a debt"));
        assert_eq!(updated.created_at, character.created_at);

        // The list reflects the new name.
        let listed = db.list_characters(&story.id).unwrap();
        assert_eq!(listed[0].name, "Rook Ashford");

        let changes: Vec<AuditEntry> = db
            .get_audit_log(Some(&story.id), Some("character"), None, 100)
            .unwrap()
            .into_iter()
            .filter(|entry| entry.action == "update")
            .collect();

        assert_eq!(changes.len(), 2, "name and description are separate entries");
        assert!(changes.iter().all(|entry| entry.changed_by == "Grace"));

        let rename = changes
            .iter()
            .find(|entry| entry.field_changed.as_deref() == Some("name"))
            .expect("rename was not recorded");
        assert_eq!(rename.old_value.as_deref(), Some("Rook"));
        assert_eq!(rename.new_value.as_deref(), Some("Rook Ashford"));

        let description = changes
            .iter()
            .find(|entry| entry.field_changed.as_deref() == Some("description"))
            .expect("description edit was not recorded");
        assert_eq!(description.old_value.as_deref(), Some("Scout"));
        assert_eq!(description.new_value.as_deref(), Some("Scout with a debt"));
    }

    #[test]
    fn updating_a_character_with_no_changes_writes_nothing() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Cast".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let before = db.get_audit_log(None, None, None, 100).unwrap().len();

        let unchanged = db
            .update_character(&character.id, "Rook".into(), None, "Grace".into())
            .unwrap();

        assert_eq!(unchanged.updated_at, character.updated_at);
        assert_eq!(db.get_audit_log(None, None, None, 100).unwrap().len(), before);
    }

    #[test]
    fn a_deleted_character_takes_its_stats_off_the_board() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Cast".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        db.add_or_update_stat(character.id.clone(), "Level".into(), 3, Some("from the raid".into()), "Ada".into())
            .unwrap();
        let survivor = db
            .create_character(story.id.clone(), "Mira".into(), None, "Ada".into())
            .unwrap();

        db.delete_character(&character.id, "Grace".into()).unwrap();

        let remaining = db.list_characters(&story.id).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, survivor.id);
        assert!(db.list_stats(&character.id).unwrap().is_empty());

        let deletes: Vec<AuditEntry> = db
            .get_audit_log(Some(&story.id), None, None, 100)
            .unwrap()
            .into_iter()
            .filter(|entry| entry.action == "soft_delete")
            .collect();

        assert_eq!(
            deletes.len(),
            1,
            "the character is recorded once; its stat was not touched"
        );
        assert_eq!(deletes[0].entity_type, "character");
        assert_eq!(deletes[0].changed_by, "Grace");
        assert_eq!(deletes[0].old_value.as_deref(), Some("Rook"));

        // The stat keeps its notes: nothing about it was rewritten.
        db.restore_character(&character.id, "Grace".into()).unwrap();
        assert_eq!(db.list_characters(&story.id).unwrap().len(), 2);
        let stats = db.list_stats(&character.id).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].value, 3);
        assert_eq!(stats[0].notes.as_deref(), Some("from the raid"));
    }
    #[test]
    fn deleting_a_character_that_is_already_gone_is_quiet() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Cast".into(), None, "Ada".into()).unwrap();
        db.create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let before = db.get_audit_log(None, None, None, 100).unwrap().len();

        db.delete_character("does-not-exist", "Ada".into()).unwrap();

        assert_eq!(db.list_characters(&story.id).unwrap().len(), 1);
        assert_eq!(db.get_audit_log(None, None, None, 100).unwrap().len(), before);
    }

    /// The point of copying the file is that the copy predates the migration, so
    /// a migration that goes wrong leaves the previous schema on disk.
    #[test]
    fn the_copy_is_taken_before_the_schema_is_migrated() {
        let dir = std::env::temp_dir().join(format!("litrpg-open-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("storyboard.db");

        {
            let old = Connection::open(&path).unwrap();
            old.execute_batch(
                "CREATE TABLE audit_log (
                    id TEXT PRIMARY KEY,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    changed_by TEXT NOT NULL,
                    changed_at TEXT NOT NULL
                );",
            )
            .unwrap();
        }

        let db = Db::open_with_snapshot(&path, 5).unwrap();

        let live: i32 = db
            .conn()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(live, SCHEMA_VERSION, "opening migrates the working copy");

        let copy = std::fs::read_dir(snapshots::snapshot_dir(&path))
            .unwrap()
            .next()
            .expect("a copy should have been written")
            .unwrap()
            .path();
        let before: i32 = Connection::open(&copy)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(before, 0, "the copy is what was on disk before migrating");
    }
}
