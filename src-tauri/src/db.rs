use chrono::Utc;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use uuid::Uuid;

/// Schema version tracked with `PRAGMA user_version`.
///
/// Bump this and add a matching block to [`migrate`] whenever the schema changes.
const SCHEMA_VERSION: i32 = 1;

pub type DbResult<T> = Result<T, DbError>;

#[derive(Debug)]
pub enum DbError {
    Sqlite(rusqlite::Error),
    /// A previous panic happened while the connection was locked. Reported instead
    /// of panicking again, which with `panic = "abort"` would kill the app.
    Poisoned,
    NotFound(&'static str),
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
            "SELECT id, title, description, created_at, updated_at FROM stories ORDER BY updated_at DESC",
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
            "SELECT id, title, description, created_at, updated_at FROM stories WHERE id = ?1",
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
            "SELECT id, story_id, name, description, created_at, updated_at
             FROM characters WHERE story_id = ?1 ORDER BY name",
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
            "SELECT id, character_id, stat_name, value, notes, created_at, updated_at
             FROM character_stats WHERE character_id = ?1 ORDER BY stat_name",
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

    pub fn list_nodes(&self, story_id: &str) -> DbResult<Vec<Node>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at
             FROM nodes WHERE story_id = ?1 ORDER BY created_at",
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
            "SELECT id, story_id, source_id, target_id, label, relation_type, created_by, created_at
             FROM edges WHERE story_id = ?1",
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

    // ===== AUDIT LOG =====

    /// Newest-first history, optionally narrowed to one story and/or entity.
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
        )?)
    }

    // ===== EXPORT =====

    /// Everything needed to restore a story elsewhere, including its full history.
    pub fn export_story(&self, story_id: &str) -> DbResult<StoryExport> {
        let guard = self.conn()?;

        let story = guard
            .query_row(
                "SELECT id, title, description, created_at, updated_at FROM stories WHERE id = ?1",
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
                 FROM characters WHERE story_id = ?1 ORDER BY name",
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
                 WHERE character_id IN (SELECT id FROM characters WHERE story_id = ?1)
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

        let nodes = {
            let mut stmt = guard.prepare(
                "SELECT id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at
                 FROM nodes WHERE story_id = ?1 ORDER BY created_at",
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
                 FROM edges WHERE story_id = ?1",
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

        let audit_trail = query_audit(&guard, Some(story_id), None, None, None)?;

        Ok(StoryExport {
            exported_at: now(),
            story,
            characters,
            character_stats,
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
                "SELECT id, title, description, created_at, updated_at FROM stories WHERE id = ?1",
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

    /// Removes a story and everything hanging off it. Children are removed by the
    /// foreign key cascade; the audit entry records how much went with it.
    ///
    /// The story's audit rows are deliberately kept: the history of a deleted
    /// story is still history, and an audit log that erases itself is not one.
    pub fn delete_story(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT title FROM stories WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        // Already gone: nothing to delete, nothing to record.
        let Some(title) = existing else {
            return Ok(());
        };

        let characters: i64 = tx.query_row(
            "SELECT count(*) FROM characters WHERE story_id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        let nodes: i64 = tx.query_row(
            "SELECT count(*) FROM nodes WHERE story_id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        let edges: i64 = tx.query_row(
            "SELECT count(*) FROM edges WHERE story_id = ?1",
            params![id],
            |row| row.get(0),
        )?;

        tx.execute("DELETE FROM stories WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(id),
                entity_type: "story",
                entity_id: id,
                action: "delete",
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

    /// Deletes a node along with the edges attached to it. Edges removed by the
    /// cascade are recorded individually, so the history does not silently lose
    /// connections. Deleting something that is already gone succeeds quietly.
    pub fn delete_node(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, label FROM nodes WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((story_id, label)) = existing else {
            return Ok(());
        };

        let attached = {
            let mut stmt = tx.prepare(
                "SELECT id, source_id, target_id FROM edges WHERE source_id = ?1 OR target_id = ?1",
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

        tx.execute("DELETE FROM nodes WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "node",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(label),
                new_value: None,
                changed_by: &user,
            },
        )?;

        for (edge_id, source_id, target_id) in attached {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "edge",
                    entity_id: &edge_id,
                    action: "delete",
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

    /// Deletes a single connection. Already gone is not an error, which matters
    /// because deleting a node also reports its edges as deleted.
    pub fn delete_edge(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, source_id, target_id FROM edges WHERE id = ?1",
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

        tx.execute("DELETE FROM edges WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "edge",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(format!("{source_id} -> {target_id}")),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }
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

/// A complete, self-contained snapshot of one story.
#[derive(Debug, serde::Serialize)]
pub struct StoryExport {
    pub exported_at: String,
    pub story: Story,
    pub characters: Vec<Character>,
    pub character_stats: Vec<CharacterStat>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub audit_trail: Vec<AuditEntry>,
}

// ===== INTERNAL HELPERS =====
//
// These take a `&Connection` (or a transaction, which derefs to one) rather than
// reaching for the mutex. Locking happens once, in the public methods above.

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

fn query_audit(
    conn: &Connection,
    story_id: Option<&str>,
    entity_type: Option<&str>,
    entity_id: Option<&str>,
    limit: Option<i64>,
) -> SqliteResult<Vec<AuditEntry>> {
    let mut sql = String::from(
        "SELECT id, entity_type, entity_id, action, field_changed, old_value, new_value, changed_by, changed_at, story_id
         FROM audit_log WHERE 1 = 1",
    );
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

    // rowid breaks ties so entries written in the same tick stay in order.
    sql.push_str(" ORDER BY changed_at DESC, rowid DESC");

    if let Some(limit) = limit {
        sql.push_str(" LIMIT ?");
        args.push(Value::Integer(limit));
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

const INDEXES: &str = "
    CREATE INDEX IF NOT EXISTS idx_audit_log_story ON audit_log (story_id, changed_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id);
";

#[cfg(test)]
mod tests {
    use super::*;

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
    fn deleting_a_node_removes_its_edges_and_records_both() {
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
            .filter(|entry| entry.action == "delete")
            .collect();

        assert_eq!(deletes.len(), 2, "the node and its edge are both recorded");
        assert!(deletes.iter().all(|entry| entry.changed_by == "Grace"));
        assert!(deletes.iter().any(|entry| entry.entity_type == "node"
            && entry.old_value.as_deref() == Some("First")));
        assert!(deletes.iter().any(|entry| entry.entity_type == "edge"));
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
    fn deleting_an_edge_is_recorded() {
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
                None,
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
            .find(|entry| entry.action == "delete")
            .expect("edge deletion was not recorded");

        assert_eq!(delete.changed_by, "Grace");
        assert_eq!(
            delete.old_value.as_deref(),
            Some(format!("{} -> {}", node.id, other.id).as_str())
        );
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
    fn deleting_a_story_removes_its_contents_but_keeps_the_history() {
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
                    && entry.action == "delete"
                    && entry.changed_by == "Grace"),
            "the deletion itself is recorded"
        );
        assert!(
            history.len() > 1,
            "earlier history survives the deletion"
        );
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
}
