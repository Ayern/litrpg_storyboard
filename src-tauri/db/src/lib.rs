pub mod snapshots;

use chrono::Utc;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;
use uuid::Uuid;

/// Settings key holding the trash retention window, in days.
const TRASH_RETENTION_KEY: &str = "trash_retention_days";

/// Ten years: long enough to mean "effectively forever", short enough that no
/// stray value can overflow the date arithmetic.
const MAX_RETENTION_DAYS: i64 = 3650;

/// Attributed to deletions the retention window performs, so automatic purges
/// are not mistaken for something a person did.
const RETENTION_ACTOR: &str = "Trash retention";

/// Schema version tracked with `PRAGMA user_version`.
///
/// Bump this and add a matching block to [`migrate`] whenever the schema changes.
const SCHEMA_VERSION: i32 = 24;

pub type DbResult<T> = Result<T, DbError>;

#[derive(Debug)]
pub enum DbError {
    Sqlite(rusqlite::Error),
    /// Reading, copying or replacing the database file itself.
    Io(std::io::Error),
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

impl From<std::io::Error> for DbError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "{error}"),
            Self::Io(error) => write!(f, "{error}"),
            Self::Poisoned => write!(f, "database connection is in a poisoned state"),
            Self::NotFound(what) => write!(f, "{what} not found"),
            Self::Invalid(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for DbError {}

/// The written order of a backup, read from its name: the `YYYYMMDD-HHMMSS`
/// timestamp, then the suffix that tells apart two copies from the same second.
fn backup_stamp(name: &str, prefix: &str) -> (String, u64) {
    let rest = name.strip_prefix(prefix).unwrap_or(name);
    let rest = rest.strip_suffix(".db").unwrap_or(rest);

    // Fifteen characters is the whole timestamp; anything after that is the
    // suffix the writer added to avoid overwriting a copy from the same second.
    if rest.len() > 15 && rest.as_bytes()[15] == b'-' {
        (
            rest[..15].to_string(),
            rest[16..].parse::<u64>().unwrap_or(0),
        )
    } else {
        (rest.to_string(), 0)
    }
}

/// The prepared story's title, used to create it and to recognise it when its
/// contents are rebuilt in place. A demo that has been renamed is an ordinary
/// story and is not reset behind the author's back.
const DEMO_STORY_TITLE: &str = "The Ember Ledger (Demo)";

const DEMO_STORY_DESCRIPTION: &str = "A prepared story for trying cast badges, milestones, stat snapshots, XP income and continuity. Mira's ledger is intentionally 100 XP short in Chapter Three.";

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

/// Copies a skill card's shared facts onto every character skill linked to it.
///
/// Only the named field is touched, so a card rename does not rewrite a holder's
/// description and a content edit does not rewrite their name. Rank, chapter and
/// the card link stay the holder's own. The unique name is per character, so a
/// rename that would collide on one sheet refuses the whole transaction rather
/// than leaving some holders renamed.
#[allow(clippy::too_many_arguments)]
fn sync_skill_card_holders(
    tx: &rusqlite::Transaction<'_>,
    story_id: &str,
    node_id: &str,
    label: &str,
    content: Option<&str>,
    sync_name: bool,
    sync_effect: bool,
    user: &str,
    timestamp: &str,
) -> DbResult<()> {
    let existing = tx
        .query_row(
            "SELECT id FROM skill_definitions WHERE story_id = ?1 AND node_id = ?2",
            params![story_id, node_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    let definition_id = match existing {
        Some(id) => id,
        None => {
            let id = Uuid::new_v4().to_string();

            tx.execute(
                "INSERT INTO skill_definitions
                 (id, story_id, name, description, node_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![&id, story_id, label, content, node_id, timestamp],
            )?;

            // A card made before the definition existed still names its holders;
            // link those rows once, so the shared words reach them too.
            tx.execute(
                "UPDATE character_skills SET skill_id = ?1
                  WHERE node_id = ?2 AND skill_id IS NULL",
                params![&id, node_id],
            )?;

            id
        }
    };

    tx.execute(
        "UPDATE skill_definitions
            SET name = ?1, description = ?2, updated_at = ?3
          WHERE id = ?4",
        params![label, content, timestamp, &definition_id],
    )?;

    sync_skill_definition_holders(
        tx,
        story_id,
        &definition_id,
        label,
        content,
        Some(node_id),
        sync_name,
        sync_effect,
        false,
        user,
        timestamp,
    )
}

/// Applies a definition's changed words to every holder row.
///
/// The mirrors on `character_skills` are what the sheets, history and card
/// badges read, so they follow the shared definition. Rank and chapter are never
/// touched here, and a name that would collide on one holder's sheet refuses the
/// whole transaction.
#[allow(clippy::too_many_arguments)]
fn sync_skill_definition_holders(
    tx: &rusqlite::Transaction<'_>,
    story_id: &str,
    definition_id: &str,
    name: &str,
    effect: Option<&str>,
    node_id: Option<&str>,
    sync_name: bool,
    sync_effect: bool,
    sync_node: bool,
    user: &str,
    timestamp: &str,
) -> DbResult<()> {
    let holders = {
        let mut stmt = tx.prepare(
            "SELECT id, character_id, name, effect, node_id
               FROM character_skills
              WHERE skill_id = ?1",
        )?;
        let rows = stmt.query_map(params![definition_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;

        rows.collect::<SqliteResult<Vec<_>>>()?
    };

    for (skill_id, character_id, old_name, old_effect, old_node) in holders {
        let new_name = if sync_name {
            name.to_string()
        } else {
            old_name.clone()
        };
        let new_effect = if sync_effect {
            effect.map(str::to_string)
        } else {
            old_effect.clone()
        };
        let new_node = if sync_node {
            node_id.map(str::to_string)
        } else {
            old_node.clone()
        };

        if new_name == old_name && new_effect == old_effect && new_node == old_node {
            continue;
        }

        if new_name != old_name {
            let conflict = tx
                .query_row(
                    "SELECT c.name
                       FROM character_skills s
                       JOIN characters c ON c.id = s.character_id
                      WHERE s.character_id = ?1 AND s.name = ?2 AND s.id <> ?3",
                    params![&character_id, &new_name, &skill_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;

            if let Some(character_name) = conflict {
                return Err(DbError::Invalid(format!(
                    "{character_name} already has a skill named {new_name}"
                )));
            }
        }

        tx.execute(
            "UPDATE character_skills
                SET name = ?1, effect = ?2, node_id = ?3, updated_at = ?4
              WHERE id = ?5",
            params![&new_name, &new_effect, &new_node, timestamp, &skill_id],
        )?;

        if new_name != old_name {
            log_audit(
                tx,
                AuditRecord {
                    story_id: Some(story_id),
                    entity_type: "character_skill",
                    entity_id: &skill_id,
                    action: "update",
                    field_changed: Some("name"),
                    old_value: Some(old_name),
                    new_value: Some(new_name),
                    changed_by: user,
                },
            )?;
        }

        if new_effect != old_effect {
            log_audit(
                tx,
                AuditRecord {
                    story_id: Some(story_id),
                    entity_type: "character_skill",
                    entity_id: &skill_id,
                    action: "update",
                    field_changed: Some("effect"),
                    old_value: old_effect,
                    new_value: new_effect,
                    changed_by: user,
                },
            )?;
        }

        if new_node != old_node {
            let old_label = reference_label(tx, old_node.as_deref())?;
            let new_label = reference_label(tx, new_node.as_deref())?;

            log_audit(
                tx,
                AuditRecord {
                    story_id: Some(story_id),
                    entity_type: "character_skill",
                    entity_id: &skill_id,
                    action: "update",
                    field_changed: Some("card"),
                    old_value: old_label,
                    new_value: new_label,
                    changed_by: user,
                },
            )?;
        }
    }

    Ok(())
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

    // ===== BACKUPS =====

    /// The copies this app has written beside the database, newest first.
    ///
    /// Only files named the way [`snapshots`] names them are listed, so anything
    /// else in the folder is left out rather than offered for restore.
    pub fn list_backups(&self) -> DbResult<Vec<BackupInfo>> {
        let Some(db_path) = self.path.as_ref() else {
            return Ok(Vec::new());
        };

        let folder = snapshots::snapshot_dir(db_path);
        if !folder.is_dir() {
            return Ok(Vec::new());
        }

        let stem = db_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("storyboard");
        let prefix = format!("{stem}-");

        let mut copies: Vec<((String, u64), std::time::SystemTime, BackupInfo)> = Vec::new();

        for entry in fs::read_dir(&folder)? {
            let entry = entry?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };

            if !name.starts_with(&prefix) || !name.ends_with(".db") || !path.is_file() {
                continue;
            }

            let metadata = entry.metadata()?;
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);

            copies.push((
                backup_stamp(name, &prefix),
                modified,
                BackupInfo {
                    file_name: name.to_string(),
                    created_at: chrono::DateTime::<Utc>::from(modified).to_rfc3339(),
                    size_bytes: metadata.len(),
                },
            ));
        }

        // The name is what orders them: two copies in the same second can carry
        // the same filesystem timestamp, but the second one gets a suffix.
        copies.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| right.1.cmp(&left.1))
                .then_with(|| right.2.file_name.cmp(&left.2.file_name))
        });

        Ok(copies.into_iter().map(|(_, _, info)| info).collect())
    }

    /// Puts a copy back in place of the live database and reopens it.
    ///
    /// The copy is staged and opened before the live file is touched, so a
    /// damaged backup cannot cost anything. Just before the swap the current
    /// state is copied as well, which is what makes a restore itself reversible
    /// from the same dialog.
    pub fn restore_backup(&self, file_name: &str, keep: usize) -> DbResult<()> {
        let db_path = self
            .path
            .as_ref()
            .ok_or_else(|| DbError::Invalid("this database is not on disk".to_string()))?;

        let stem = db_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("storyboard");
        let prefix = format!("{stem}-");

        // A plain file name from this app's folder: no directory parts, so a
        // crafted name cannot reach any other file.
        let named_like_a_backup = Path::new(file_name).components().count() == 1
            && file_name.starts_with(&prefix)
            && file_name.ends_with(".db");

        if !named_like_a_backup {
            return Err(DbError::Invalid(
                "that is not one of this app's backups".to_string(),
            ));
        }

        let source = snapshots::snapshot_dir(db_path).join(file_name);
        if !source.is_file() {
            return Err(DbError::NotFound("backup"));
        }

        // Staged beside the database, then opened: a bad or old file is found
        // before anything has been replaced, and migrations run on the copy.
        let staged = db_path.with_extension("restoring");
        fs::copy(&source, &staged)?;

        let prepared = (|| -> DbResult<()> {
            let conn = Connection::open(&staged)?;
            conn.execute_batch("PRAGMA foreign_keys = ON;")?;
            migrate(&conn)?;
            Ok(())
        })();

        if let Err(error) = prepared {
            let _ = fs::remove_file(&staged);
            return Err(error);
        }

        // Close the live connection before the file under it changes. Until the
        // replacement is open, the database holds an empty in-memory stand-in.
        let mut guard = self.conn()?;
        let placeholder = Connection::open_in_memory()?;
        let previous = std::mem::replace(&mut *guard, placeholder);
        drop(previous);

        let swapped = (|| -> DbResult<()> {
            // The state about to be replaced is copied first: a closed file is
            // a consistent one, and the copy is the way back.
            snapshots::snapshot(db_path, keep)?;

            fs::copy(&staged, db_path)?;

            // Journal files belong to the database that was just replaced.
            let _ = fs::remove_file(db_path.with_extension("db-wal"));
            let _ = fs::remove_file(db_path.with_extension("db-shm"));

            let conn = Connection::open(db_path)?;
            conn.execute_batch("PRAGMA foreign_keys = ON;")?;
            migrate(&conn)?;
            *guard = conn;

            Ok(())
        })();

        let _ = fs::remove_file(&staged);

        if let Err(error) = swapped {
            // Get a working connection back if the file is still readable; the
            // copy taken above is the fallback when it is not.
            if let Ok(conn) = Connection::open(db_path) {
                let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
                let _ = migrate(&conn);
                *guard = conn;
            }

            return Err(DbError::Invalid(format!(
                "the backup could not be put in place: {error}"
            )));
        }

        Ok(())
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

    /// Builds a small, ready-to-explore story for trying the progression tools.
    ///
    /// The data is deliberately hand-written rather than generated from the
    /// current date, so a walkthrough is repeatable. Mira's ledger is one
    /// hundred XP short in the last chapter, which gives the continuity check
    /// something real to find while the rest of the story stays consistent.
    pub fn create_demo_story(&self, user: String) -> DbResult<Story> {
        let story = self.create_story(
            DEMO_STORY_TITLE.into(),
            Some(DEMO_STORY_DESCRIPTION.into()),
            user.clone(),
        )?;

        if let Err(error) = self.seed_demo_story(&story.id, &user) {
            // Do not leave half a demo behind if one step is refused.
            let _ = self.delete_story(&story.id, user.clone());
            let _ = self.purge_story(&story.id, user);
            return Err(error);
        }

        Ok(story)
    }

    /// Rebuilds the prepared demo in place with its original sample data.
    ///
    /// The story keeps its id, so it stays selected in the sidebar and any
    /// bookmarks or exports of that id still name the same story. Its contents
    /// and history are replaced: a reset is meant to undo a trial run, not to
    /// preserve it. Only a story still carrying the demo title can be reset, so
    /// a renamed story is never mistaken for a scratchpad and wiped.
    pub fn reset_demo_story(&self, story_id: &str, user: String) -> DbResult<Story> {
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT title, created_at FROM stories WHERE id = ?1 AND deleted_at IS NULL",
                params![story_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((title, created_at)) = existing else {
            return Err(DbError::NotFound("story"));
        };

        if title != DEMO_STORY_TITLE {
            return Err(DbError::Invalid(
                "only the demo story can be reset".to_string(),
            ));
        }

        // Old history names rows that are about to go, so it goes with them.
        tx.execute(
            "DELETE FROM audit_log WHERE story_id = ?1",
            params![story_id],
        )?;

        // Deleting the story cascades to its cast, nodes, edges and every row
        // that hangs off them, including skills, milestones and XP income.
        tx.execute("DELETE FROM stories WHERE id = ?1", params![story_id])?;

        tx.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                story_id,
                DEMO_STORY_TITLE,
                DEMO_STORY_DESCRIPTION,
                &created_at,
                &timestamp
            ],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(story_id),
                entity_type: "story",
                entity_id: story_id,
                action: "reset",
                field_changed: None,
                old_value: Some(title),
                new_value: Some("prepared demo data".to_string()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;
        drop(guard);

        // The seed writes through the ordinary public methods, each with its own
        // transaction, so it runs after the reset transaction above.
        self.seed_demo_story(story_id, &user)?;

        Ok(Story {
            id: story_id.to_string(),
            title: DEMO_STORY_TITLE.to_string(),
            description: Some(DEMO_STORY_DESCRIPTION.to_string()),
            created_at,
            updated_at: timestamp,
        })
    }

    fn seed_demo_story(&self, story_id: &str, user: &str) -> DbResult<()> {
        let user = user.to_string();

        let rook = self.create_character(
            story_id.to_string(),
            "Rook Valebright".into(),
            Some("A debt-bound delver who reads the System like a ledger.".into()),
            user.clone(),
        )?;
        let mira = self.create_character(
            story_id.to_string(),
            "Mira Sable".into(),
            Some("A courier with a stolen ember and a talent for exits.".into()),
            user.clone(),
        )?;

        self.set_character_progress(
            &rook.id,
            4,
            2400,
            Some("Bronze".into()),
            Some(3000),
            user.clone(),
        )?;
        self.set_character_progress(
            &mira.id,
            3,
            1500,
            Some("Bronze".into()),
            Some(2200),
            user.clone(),
        )?;

        for (character_id, stat_name, value) in [
            (&rook.id, "Strength", 18),
            (&rook.id, "Agility", 14),
            (&rook.id, "Insight", 12),
            (&mira.id, "Agility", 17),
            (&mira.id, "Insight", 16),
            (&mira.id, "Strength", 9),
        ] {
            self.add_or_update_stat(
                character_id.clone(),
                stat_name.into(),
                value,
                None,
                user.clone(),
            )?;
        }

        let first = self.create_node_with_character(
            story_id.to_string(),
            "chapter".into(),
            "The Ashen Gate".into(),
            Some("Rook buys a place at the gate with a debt he cannot name.".into()),
            140.0,
            120.0,
            user.clone(),
            Some(rook.id.clone()),
        )?;
        let second = self.create_node_with_character(
            story_id.to_string(),
            "chapter".into(),
            "A Ledger of Cinders".into(),
            Some("Mira offers the ember to the clerk who wrote Rook's debt.".into()),
            500.0,
            120.0,
            user.clone(),
            Some(mira.id.clone()),
        )?;
        let third = self.create_node_with_character(
            story_id.to_string(),
            "chapter".into(),
            "The Ember Court".into(),
            Some("The debt comes due in a room where every flame remembers.".into()),
            860.0,
            120.0,
            user.clone(),
            Some(rook.id.clone()),
        )?;

        self.set_chapter_details(
            &first.id,
            Some("Arrival".into()),
            Some(2200),
            Some(2500),
            Some(rook.id.clone()),
            Some(1),
            Some("Dusk".into()),
            user.clone(),
        )?;
        self.set_chapter_details(
            &second.id,
            Some("Bargain".into()),
            Some(2600),
            Some(3000),
            Some(mira.id.clone()),
            Some(2),
            Some("Morning".into()),
            user.clone(),
        )?;
        self.set_chapter_details(
            &third.id,
            Some("Confrontation".into()),
            Some(3200),
            Some(3000),
            Some(rook.id.clone()),
            Some(3),
            Some("Night".into()),
            user.clone(),
        )?;

        self.add_chapter_cast_member(first.id.clone(), mira.id.clone(), user.clone())?;
        self.add_chapter_cast_member(second.id.clone(), rook.id.clone(), user.clone())?;
        self.add_chapter_cast_member(third.id.clone(), mira.id.clone(), user.clone())?;

        let ash_step = self.add_skill(
            rook.id.clone(),
            "Ash Step".into(),
            Some("Rank 2".into()),
            Some("A short step through smoke that leaves a grey afterimage.".into()),
            Some(first.id.clone()),
            None,
            user.clone(),
        )?;
        let ember_whisper = self.add_skill(
            mira.id.clone(),
            "Ember Whisper".into(),
            Some("Rank 1".into()),
            Some("Reads the last emotion a flame touched.".into()),
            Some(first.id.clone()),
            None,
            user.clone(),
        )?;

        self.add_skill_event(
            ash_step.id.clone(),
            "used".into(),
            Some(second.id.clone()),
            Some("Rank 1".into()),
            None,
            user.clone(),
        )?;
        self.add_skill_event(
            ember_whisper.id.clone(),
            "used".into(),
            Some(second.id.clone()),
            Some("Rank 1".into()),
            None,
            user.clone(),
        )?;

        // A level-up awards more than one stat at a time, so each milestone below
        // carries every stat it changed. The skill upgrade is grouped with the
        // level-up it came with.
        for (character, level, xp, changes, chapter) in [
            (
                &rook,
                2,
                600,
                vec![stat_gain("Strength", 2, 15), stat_gain("Endurance", 1, 11)],
                &first,
            ),
            (
                &rook,
                3,
                1500,
                vec![stat_gain("Strength", 1, 16), stat_gain("Endurance", 1, 12)],
                &second,
            ),
            (
                &rook,
                4,
                2400,
                vec![
                    stat_gain("Strength", 2, 18),
                    stat_gain("Agility", 1, 12),
                    stat_gain("Endurance", 1, 13),
                ],
                &third,
            ),
            (
                &mira,
                1,
                200,
                vec![stat_gain("Agility", 2, 13), stat_gain("Perception", 1, 12)],
                &first,
            ),
            (
                &mira,
                2,
                800,
                vec![stat_gain("Agility", 2, 15), stat_gain("Perception", 1, 13)],
                &second,
            ),
            (
                &mira,
                3,
                1500,
                vec![stat_gain("Agility", 2, 17), stat_gain("Perception", 1, 14)],
                &third,
            ),
        ] {
            let milestone = self.add_level_milestone_with_changes(
                character.id.clone(),
                level,
                Some(chapter.id.clone()),
                false,
                Some(xp),
                changes,
                user.clone(),
            )?;

            if level == 4 && character.id == rook.id {
                self.add_skill_event(
                    ash_step.id.clone(),
                    "upgraded".into(),
                    Some(third.id.clone()),
                    Some("Rank 2".into()),
                    Some(milestone.id.clone()),
                    user.clone(),
                )?;
            }
        }

        for (character, amount, chapter) in [
            (&rook, 600, &first),
            (&rook, 900, &second),
            (&rook, 900, &third),
            (&mira, 200, &first),
            (&mira, 600, &second),
            // Mira's total says 1,500 here; this row deliberately leaves the
            // ledger 100 short so the continuity panel has a real mismatch.
            (&mira, 600, &third),
        ] {
            self.add_character_progress(
                character.id.clone(),
                chapter.id.clone(),
                amount,
                user.clone(),
            )?;
        }

        Ok(())
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
            level: 1,
            xp: 0,
            rank: None,
            xp_to_next: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    pub fn list_characters(&self, story_id: &str) -> DbResult<Vec<Character>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT c.id, c.story_id, c.name, c.description, c.level, c.xp, c.rank,
                    c.xp_to_next, c.created_at, c.updated_at
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
                level: row.get(4)?,
                xp: row.get(5)?,
                rank: row.get(6)?,
                xp_to_next: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
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

    /// Every stat of every live cast member in a story, in one read. The canvas
    /// draws all of a story's linked nodes at once, so asking per character would
    /// be one round trip per card.
    pub fn list_story_stats(&self, story_id: &str) -> DbResult<Vec<CharacterStat>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT s.id, s.character_id, s.stat_name, s.value, s.notes, s.created_at, s.updated_at
             FROM character_stats s
             JOIN characters c ON c.id = s.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE c.story_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY s.stat_name",
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

        tx.execute(
            "DELETE FROM character_attributes WHERE id = ?1",
            params![id],
        )?;

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

    // ===== SKILL OPERATIONS =====
    //
    // Skills belong to a character, not to the board. The optional chapter and
    // skill card are links; both are checked to be live nodes of the same story
    // before anything is written, and both survive the card being trashed.

    pub fn add_skill(
        &self,
        character_id: String,
        name: String,
        rank: Option<String>,
        effect: Option<String>,
        chapter_id: Option<String>,
        node_id: Option<String>,
        user: String,
    ) -> DbResult<CharacterSkill> {
        let name = name.trim().to_string();

        if name.is_empty() {
            return Err(DbError::Invalid("a skill needs a name".to_string()));
        }

        let rank = clean_optional(rank);
        let effect = clean_optional(effect);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let story_id = live_character_story(&tx, &character_id)?;
        validate_node_reference(&tx, &story_id, chapter_id.as_deref(), "chapter", "chapter")?;
        validate_node_reference(&tx, &story_id, node_id.as_deref(), "skill", "skill card")?;

        let (skill_id, name, effect, node_id) =
            skill_definition_for(&tx, &story_id, &name, effect.as_deref(), node_id.as_deref())?;

        let taken: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM character_skills WHERE character_id = ?1 AND name = ?2",
                params![&character_id, &name],
                |row| row.get(0),
            )
            .optional()?;

        if taken.is_some() {
            return Err(DbError::Invalid(format!(
                "{name} is already one of this character's skills"
            )));
        }

        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO character_skills
             (id, character_id, skill_id, name, rank, effect, chapter_id, node_id,
              created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                &id,
                &character_id,
                &skill_id,
                &name,
                &rank,
                &effect,
                &chapter_id,
                &node_id,
                &timestamp,
                &timestamp
            ],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_skill",
                entity_id: &id,
                action: "create",
                field_changed: Some("name"),
                old_value: None,
                new_value: Some(name.clone()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(CharacterSkill {
            id,
            character_id,
            name,
            rank,
            effect,
            chapter_id,
            node_id,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    pub fn update_skill(
        &self,
        id: String,
        name: String,
        rank: Option<String>,
        effect: Option<String>,
        chapter_id: Option<String>,
        node_id: Option<String>,
        user: String,
    ) -> DbResult<CharacterSkill> {
        let name = name.trim().to_string();

        if name.is_empty() {
            return Err(DbError::Invalid("a skill needs a name".to_string()));
        }

        let rank = clean_optional(rank);
        let effect = clean_optional(effect);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT s.character_id, s.name, s.rank, s.effect, s.chapter_id, s.node_id,
                        s.created_at, s.updated_at, c.story_id, s.skill_id
                 FROM character_skills s
                 JOIN characters c ON c.id = s.character_id
                 JOIN stories st ON st.id = c.story_id
                 WHERE s.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
                params![&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, Option<String>>(9)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("skill"))?;

        let (
            character_id,
            old_name,
            old_rank,
            old_effect,
            old_chapter,
            old_node,
            created_at,
            old_updated_at,
            story_id,
            existing_skill_id,
        ) = existing;

        // A link sent back unchanged is not checked again: its chapter or card
        // may have been trashed since, and that should not stop an unrelated
        // rank being saved.
        if chapter_id != old_chapter {
            validate_node_reference(&tx, &story_id, chapter_id.as_deref(), "chapter", "chapter")?;
        }
        if node_id != old_node {
            validate_node_reference(&tx, &story_id, node_id.as_deref(), "skill", "skill card")?;
        }

        let name_changed = name != old_name;
        let effect_changed = effect != old_effect;
        let node_changed = node_id != old_node;

        if name_changed {
            let taken: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM character_skills
                      WHERE character_id = ?1 AND name = ?2 AND id <> ?3",
                    params![&character_id, &name, &id],
                    |row| row.get(0),
                )
                .optional()?;

            if taken.is_some() {
                return Err(DbError::Invalid(format!(
                    "{name} is already one of this character's skills"
                )));
            }
        }

        // A sheet edit is an edit to the shared skill, not to this one copy. The
        // definition takes the new words, the card follows them, and every other
        // holder is brought along by the same transaction. Rank and chapter stay
        // on the edited row.
        let mut definition_changed = false;

        if name_changed || effect_changed || node_changed || existing_skill_id.is_none() {
            let skill_id = match existing_skill_id {
                Some(skill_id) => skill_id,
                None => {
                    let (skill_id, _, _, _) = skill_definition_for(
                        &tx,
                        &story_id,
                        &old_name,
                        old_effect.as_deref(),
                        old_node.as_deref(),
                    )?;
                    tx.execute(
                        "UPDATE character_skills SET skill_id = ?1 WHERE id = ?2",
                        params![&skill_id, &id],
                    )?;
                    skill_id
                }
            };

            if name_changed || effect_changed || node_changed {
                definition_changed = true;

                tx.execute(
                    "UPDATE skill_definitions
                        SET name = ?1, description = ?2, node_id = ?3, updated_at = ?4
                      WHERE id = ?5",
                    params![&name, &effect, &node_id, &timestamp, &skill_id],
                )?;

                // The card is the definition's public face. A sheet edit updates
                // it too, so the board and the sheet never tell different stories.
                if let Some(card) = &node_id {
                    let card_row = tx
                        .query_row(
                            "SELECT label, content FROM nodes WHERE id = ?1",
                            params![card],
                            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                        )
                        .optional()?;

                    if let Some((old_label, old_content)) = card_row {
                        if old_label != name || old_content != effect {
                            tx.execute(
                                "UPDATE nodes
                                    SET label = ?1, content = ?2, updated_at = ?3
                                  WHERE id = ?4",
                                params![&name, &effect, &timestamp, card],
                            )?;

                            if old_label != name {
                                log_audit(
                                    &tx,
                                    AuditRecord {
                                        story_id: Some(&story_id),
                                        entity_type: "node",
                                        entity_id: card,
                                        action: "update",
                                        field_changed: Some("label"),
                                        old_value: Some(old_label),
                                        new_value: Some(name.clone()),
                                        changed_by: &user,
                                    },
                                )?;
                            }

                            if old_content != effect {
                                log_audit(
                                    &tx,
                                    AuditRecord {
                                        story_id: Some(&story_id),
                                        entity_type: "node",
                                        entity_id: card,
                                        action: "update",
                                        field_changed: Some("content"),
                                        old_value: old_content,
                                        new_value: effect.clone(),
                                        changed_by: &user,
                                    },
                                )?;
                            }
                        }
                    }
                }

                sync_skill_definition_holders(
                    &tx,
                    &story_id,
                    &skill_id,
                    &name,
                    effect.as_deref(),
                    node_id.as_deref(),
                    name_changed,
                    effect_changed,
                    node_changed,
                    &user,
                    &timestamp,
                )?;
            }
        }

        // Only rank and chapter belong to this row; the shared words were
        // recorded above, once, for every holder.
        let old_chapter_label = reference_label(&tx, old_chapter.as_deref())?;
        let new_chapter_label = reference_label(&tx, chapter_id.as_deref())?;

        let mut changes: Vec<(&str, Option<String>, Option<String>)> = Vec::new();

        if rank != old_rank {
            changes.push(("rank", old_rank.clone(), rank.clone()));
        }
        if chapter_id != old_chapter {
            changes.push(("chapter", old_chapter_label, new_chapter_label));
        }

        let updated = CharacterSkill {
            id: id.clone(),
            character_id,
            name,
            rank,
            effect,
            chapter_id,
            node_id,
            created_at,
            updated_at: timestamp.clone(),
        };

        // Saving the same values writes nothing and bumps no timestamp. A
        // definition change is a real write even when this row's rank, chapter
        // and mirrors already hold the new words.
        if changes.is_empty() && !definition_changed {
            return Ok(CharacterSkill {
                updated_at: old_updated_at,
                ..updated
            });
        }

        tx.execute(
            "UPDATE character_skills
                SET name = ?1, rank = ?2, effect = ?3, chapter_id = ?4, node_id = ?5,
                    updated_at = ?6
              WHERE id = ?7",
            params![
                &updated.name,
                &updated.rank,
                &updated.effect,
                &updated.chapter_id,
                &updated.node_id,
                &updated.updated_at,
                &updated.id
            ],
        )?;

        for (field, old_value, new_value) in changes {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_skill",
                    entity_id: &updated.id,
                    action: "update",
                    field_changed: Some(field),
                    old_value,
                    new_value,
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(updated)
    }

    pub fn delete_skill(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT s.name, c.story_id
                 FROM character_skills s
                 JOIN characters c ON c.id = s.character_id
                 WHERE s.id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((name, story_id)) = existing else {
            return Ok(());
        };

        tx.execute("DELETE FROM character_skills WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_skill",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(name),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    pub fn list_skills(&self, character_id: &str) -> DbResult<Vec<CharacterSkill>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT s.id, s.character_id, s.name, s.rank, s.effect, s.chapter_id, s.node_id,
                    s.created_at, s.updated_at
             FROM character_skills s
             JOIN characters c ON c.id = s.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE s.character_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY s.name COLLATE NOCASE",
        )?;

        let rows = stmt.query_map(params![character_id], character_skill_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    /// Every skill of every live cast member in a story, so a skill card can
    /// name who has it without one read per card.
    pub fn list_story_skills(&self, story_id: &str) -> DbResult<Vec<CharacterSkill>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT s.id, s.character_id, s.name, s.rank, s.effect, s.chapter_id, s.node_id,
                    s.created_at, s.updated_at
             FROM character_skills s
             JOIN characters c ON c.id = s.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE c.story_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY s.name COLLATE NOCASE",
        )?;

        let rows = stmt.query_map(params![story_id], character_skill_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    // ===== CAST RELATIONS AND FACTION STANDINGS =====
    //
    // A relation is between two cast members, not two cards: a character may
    // have no card at all. Symmetric kinds are stored in a fixed id order so the
    // same bond cannot be recorded twice. A faction standing is one character's
    // place in a faction card for an arc, and stays readable if the card is
    // trashed or purged.

    /// Every relation in a story, including ones whose cast member is now in the
    /// trash, so continuity can name the problem instead of silently dropping it.
    pub fn list_story_relations(&self, story_id: &str) -> DbResult<Vec<CharacterRelation>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT id, story_id, from_character_id, to_character_id, kind, note,
                    since_chapter_id, until_chapter_id, created_by, created_at, updated_at
             FROM character_relations
             WHERE story_id = ?1
             ORDER BY created_at, id",
        )?;

        let rows = stmt.query_map(params![story_id], character_relation_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    /// Every faction standing in a story, trashed cards included for the same
    /// reason relations include trashed cast.
    pub fn list_story_faction_standings(&self, story_id: &str) -> DbResult<Vec<FactionStanding>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT id, story_id, character_id, faction_node_id, standing, note,
                    since_chapter_id, until_chapter_id, created_by, created_at, updated_at
             FROM faction_standings
             WHERE story_id = ?1
             ORDER BY since_chapter_id, created_at, id",
        )?;

        let rows = stmt.query_map(params![story_id], faction_standing_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_relation(
        &self,
        from_character_id: String,
        to_character_id: String,
        kind: String,
        note: Option<String>,
        since_chapter_id: Option<String>,
        until_chapter_id: Option<String>,
        user: String,
    ) -> DbResult<CharacterRelation> {
        let kind = clean_relation_kind(kind)?;
        let note = clean_optional(note);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let story_id = live_character_story(&tx, &from_character_id)?;
        ensure_live_cast_in_story(&tx, &story_id, &to_character_id)?;

        if from_character_id == to_character_id {
            return Err(DbError::Invalid(
                "a character cannot be related to themselves".to_string(),
            ));
        }

        let (from, to) = relation_ends(&from_character_id, &to_character_id, &kind);

        validate_node_reference(
            &tx,
            &story_id,
            since_chapter_id.as_deref(),
            "chapter",
            "chapter",
        )?;
        validate_node_reference(
            &tx,
            &story_id,
            until_chapter_id.as_deref(),
            "chapter",
            "chapter",
        )?;

        let taken: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM character_relations
                  WHERE from_character_id = ?1 AND to_character_id = ?2 AND lower(kind) = lower(?3)",
                params![&from, &to, &kind],
                |row| row.get(0),
            )
            .optional()?;

        if taken.is_some() {
            return Err(DbError::Invalid(format!(
                "a {kind} relation is already recorded between these two"
            )));
        }

        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO character_relations
             (id, story_id, from_character_id, to_character_id, kind, note,
              since_chapter_id, until_chapter_id, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &id,
                &story_id,
                &from,
                &to,
                &kind,
                &note,
                &since_chapter_id,
                &until_chapter_id,
                &user,
                &timestamp,
                &timestamp
            ],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_relation",
                entity_id: &id,
                action: "create",
                field_changed: Some("kind"),
                old_value: None,
                new_value: Some(kind.clone()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(CharacterRelation {
            id,
            story_id,
            from_character_id: from,
            to_character_id: to,
            kind,
            note,
            since_chapter_id,
            until_chapter_id,
            created_by: user,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_relation(
        &self,
        id: String,
        kind: String,
        note: Option<String>,
        since_chapter_id: Option<String>,
        until_chapter_id: Option<String>,
        user: String,
    ) -> DbResult<CharacterRelation> {
        let kind = clean_relation_kind(kind)?;
        let note = clean_optional(note);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, from_character_id, to_character_id, kind, note,
                        since_chapter_id, until_chapter_id, created_by, created_at
                 FROM character_relations WHERE id = ?1",
                params![&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("relation"))?;

        let (
            story_id,
            from_character_id,
            to_character_id,
            old_kind,
            old_note,
            old_since,
            old_until,
            created_by,
            created_at,
        ) = existing;

        // A link sent back unchanged is not checked again: its chapter may have
        // been trashed since, and that should not stop an unrelated edit.
        if since_chapter_id != old_since {
            validate_node_reference(
                &tx,
                &story_id,
                since_chapter_id.as_deref(),
                "chapter",
                "chapter",
            )?;
        }
        if until_chapter_id != old_until {
            validate_node_reference(
                &tx,
                &story_id,
                until_chapter_id.as_deref(),
                "chapter",
                "chapter",
            )?;
        }

        let (from, to) = relation_ends(&from_character_id, &to_character_id, &kind);

        let taken: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM character_relations
                  WHERE from_character_id = ?1 AND to_character_id = ?2
                    AND lower(kind) = lower(?3) AND id <> ?4",
                params![&from, &to, &kind, &id],
                |row| row.get(0),
            )
            .optional()?;

        if taken.is_some() {
            return Err(DbError::Invalid(format!(
                "a {kind} relation is already recorded between these two"
            )));
        }

        let old_since_label = reference_label(&tx, old_since.as_deref())?;
        let old_until_label = reference_label(&tx, old_until.as_deref())?;
        let new_since_label = reference_label(&tx, since_chapter_id.as_deref())?;
        let new_until_label = reference_label(&tx, until_chapter_id.as_deref())?;

        let mut changes: Vec<(&str, Option<String>, Option<String>)> = Vec::new();

        if old_kind != kind {
            changes.push(("kind", Some(old_kind), Some(kind.clone())));
        }
        if old_note != note {
            changes.push(("note", old_note, note.clone()));
        }
        if old_since != since_chapter_id {
            changes.push(("since", old_since_label, new_since_label));
        }
        if old_until != until_chapter_id {
            changes.push(("until", old_until_label, new_until_label));
        }

        tx.execute(
            "UPDATE character_relations
                SET from_character_id = ?1, to_character_id = ?2, kind = ?3, note = ?4,
                    since_chapter_id = ?5, until_chapter_id = ?6, updated_at = ?7
              WHERE id = ?8",
            params![
                &from,
                &to,
                &kind,
                &note,
                &since_chapter_id,
                &until_chapter_id,
                &timestamp,
                &id
            ],
        )?;

        for (field, old_value, new_value) in changes {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_relation",
                    entity_id: &id,
                    action: "update",
                    field_changed: Some(field),
                    old_value,
                    new_value,
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(CharacterRelation {
            id,
            story_id,
            from_character_id: from,
            to_character_id: to,
            kind,
            note,
            since_chapter_id,
            until_chapter_id,
            created_by,
            created_at,
            updated_at: timestamp,
        })
    }

    pub fn delete_relation(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, kind FROM character_relations WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((story_id, kind)) = existing else {
            return Ok(());
        };

        tx.execute("DELETE FROM character_relations WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_relation",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(kind),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_faction_standing(
        &self,
        character_id: String,
        faction_node_id: Option<String>,
        standing: String,
        note: Option<String>,
        since_chapter_id: String,
        until_chapter_id: Option<String>,
        user: String,
    ) -> DbResult<FactionStanding> {
        let standing = clean_standing(standing)?;
        let note = clean_optional(note);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let story_id = live_character_story(&tx, &character_id)?;
        validate_node_reference(
            &tx,
            &story_id,
            faction_node_id.as_deref(),
            "faction",
            "faction card",
        )?;
        validate_node_reference(
            &tx,
            &story_id,
            Some(&since_chapter_id),
            "chapter",
            "chapter",
        )?;
        validate_node_reference(
            &tx,
            &story_id,
            until_chapter_id.as_deref(),
            "chapter",
            "chapter",
        )?;

        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO faction_standings
             (id, story_id, character_id, faction_node_id, standing, note,
              since_chapter_id, until_chapter_id, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &id,
                &story_id,
                &character_id,
                &faction_node_id,
                &standing,
                &note,
                &since_chapter_id,
                &until_chapter_id,
                &user,
                &timestamp,
                &timestamp
            ],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "faction_standing",
                entity_id: &id,
                action: "create",
                field_changed: Some("standing"),
                old_value: None,
                new_value: Some(standing.clone()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(FactionStanding {
            id,
            story_id,
            character_id,
            faction_node_id,
            standing,
            note,
            since_chapter_id: Some(since_chapter_id),
            until_chapter_id,
            created_by: user,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_faction_standing(
        &self,
        id: String,
        faction_node_id: Option<String>,
        standing: String,
        note: Option<String>,
        since_chapter_id: String,
        until_chapter_id: Option<String>,
        user: String,
    ) -> DbResult<FactionStanding> {
        let standing = clean_standing(standing)?;
        let note = clean_optional(note);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, character_id, faction_node_id, standing, note,
                        since_chapter_id, until_chapter_id, created_by, created_at
                 FROM faction_standings WHERE id = ?1",
                params![&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("faction standing"))?;

        let (
            story_id,
            character_id,
            old_faction,
            old_standing,
            old_note,
            old_since,
            old_until,
            created_by,
            created_at,
        ) = existing;

        if faction_node_id != old_faction {
            validate_node_reference(
                &tx,
                &story_id,
                faction_node_id.as_deref(),
                "faction",
                "faction card",
            )?;
        }
        if since_chapter_id != old_since.clone().unwrap_or_default() {
            validate_node_reference(
                &tx,
                &story_id,
                Some(&since_chapter_id),
                "chapter",
                "chapter",
            )?;
        }
        if until_chapter_id != old_until {
            validate_node_reference(
                &tx,
                &story_id,
                until_chapter_id.as_deref(),
                "chapter",
                "chapter",
            )?;
        }

        let old_faction_label = reference_label(&tx, old_faction.as_deref())?;
        let old_since_label = reference_label(&tx, old_since.as_deref())?;
        let old_until_label = reference_label(&tx, old_until.as_deref())?;
        let new_faction_label = reference_label(&tx, faction_node_id.as_deref())?;
        let new_since_label = reference_label(&tx, Some(&since_chapter_id))?;
        let new_until_label = reference_label(&tx, until_chapter_id.as_deref())?;

        let mut changes: Vec<(&str, Option<String>, Option<String>)> = Vec::new();

        if old_faction != faction_node_id {
            changes.push(("faction", old_faction_label, new_faction_label));
        }
        if old_standing != standing {
            changes.push(("standing", Some(old_standing), Some(standing.clone())));
        }
        if old_note != note {
            changes.push(("note", old_note, note.clone()));
        }
        if old_since.as_deref() != Some(since_chapter_id.as_str()) {
            changes.push(("since", old_since_label, new_since_label));
        }
        if old_until != until_chapter_id {
            changes.push(("until", old_until_label, new_until_label));
        }

        tx.execute(
            "UPDATE faction_standings
                SET faction_node_id = ?1, standing = ?2, note = ?3,
                    since_chapter_id = ?4, until_chapter_id = ?5, updated_at = ?6
              WHERE id = ?7",
            params![
                &faction_node_id,
                &standing,
                &note,
                &since_chapter_id,
                &until_chapter_id,
                &timestamp,
                &id
            ],
        )?;

        for (field, old_value, new_value) in changes {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "faction_standing",
                    entity_id: &id,
                    action: "update",
                    field_changed: Some(field),
                    old_value,
                    new_value,
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(FactionStanding {
            id,
            story_id,
            character_id,
            faction_node_id,
            standing,
            note,
            since_chapter_id: Some(since_chapter_id),
            until_chapter_id,
            created_by,
            created_at,
            updated_at: timestamp,
        })
    }

    pub fn delete_faction_standing(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, standing FROM faction_standings WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((story_id, standing)) = existing else {
            return Ok(());
        };

        tx.execute("DELETE FROM faction_standings WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "faction_standing",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(standing),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    // ===== QUESTS =====
    //
    // A quest is a story-level record with two chapters: the one it was accepted
    // in and the one it ended in, if it has. Its rewards are child rows, so a
    // bundle is read and written with the quest it belongs to.

    /// Every quest in a story, optionally narrowed to one status. Rewards come
    /// with each quest, so the Quesal tab and chapter badges need one read.
    pub fn list_story_quests(&self, story_id: &str, status: Option<&str>) -> DbResult<Vec<Quest>> {
        let guard = self.conn()?;
        let status = clean_optional(status.map(str::to_string));

        let mut quests = {
            let mut stmt = guard.prepare(
                "SELECT id, story_id, title, giver_character_id, faction_node_id,
                        accepted_chapter_id, completed_chapter_id, status, description,
                        notes, created_by, created_at, updated_at
                 FROM quests
                 WHERE story_id = ?1 AND (?2 IS NULL OR lower(status) = lower(?2))
                 ORDER BY created_at, id",
            )?;
            let rows = stmt.query_map(params![story_id, &status], quest_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        attach_quest_rewards(&guard, story_id, &mut quests)?;

        Ok(quests)
    }

    /// The quests that were open at a chapter: accepted there or earlier, and not
    /// yet ended. A chapter with no place in the reading order has no answer.
    pub fn list_story_quests_as_of(
        &self,
        story_id: &str,
        chapter_id: &str,
    ) -> DbResult<Vec<Quest>> {
        let guard = self.conn()?;
        let target: Option<i64> = guard
            .query_row(
                "SELECT chapter_seq FROM nodes
                  WHERE id = ?1 AND story_id = ?2 AND deleted_at IS NULL",
                params![chapter_id, story_id],
                |row| row.get(0),
            )
            .optional()?;

        let Some(target) = target else {
            return Ok(Vec::new());
        };

        let mut quests = {
            let mut stmt = guard.prepare(
                "SELECT q.id, q.story_id, q.title, q.giver_character_id, q.faction_node_id,
                        q.accepted_chapter_id, q.completed_chapter_id, q.status,
                        q.description, q.notes, q.created_by, q.created_at, q.updated_at
                 FROM quests q
                 JOIN nodes a ON a.id = q.accepted_chapter_id
                 LEFT JOIN nodes c ON c.id = q.completed_chapter_id
                 WHERE q.story_id = ?1
                   AND a.deleted_at IS NULL AND a.chapter_seq IS NOT NULL
                   AND a.chapter_seq <= ?2
                   AND (q.completed_chapter_id IS NULL
                        OR (c.deleted_at IS NULL AND c.chapter_seq > ?2))
                 ORDER BY a.chapter_seq, q.created_at, q.id",
            )?;
            let rows = stmt.query_map(params![story_id, target], quest_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        attach_quest_rewards(&guard, story_id, &mut quests)?;

        Ok(quests)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_quest(
        &self,
        story_id: String,
        title: String,
        giver_character_id: Option<String>,
        faction_node_id: Option<String>,
        accepted_chapter_id: String,
        completed_chapter_id: Option<String>,
        status: String,
        description: Option<String>,
        notes: Option<String>,
        user: String,
    ) -> DbResult<Quest> {
        let title = title.trim().to_string();

        if title.is_empty() {
            return Err(DbError::Invalid("a quest needs a title".to_string()));
        }

        let status = clean_quest_status(status)?;
        let description = clean_optional(description);
        let notes = clean_optional(notes);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        ensure_live_story(&tx, &story_id)?;
        validate_node_reference(
            &tx,
            &story_id,
            Some(&accepted_chapter_id),
            "chapter",
            "chapter",
        )?;
        validate_node_reference(
            &tx,
            &story_id,
            completed_chapter_id.as_deref(),
            "chapter",
            "chapter",
        )?;
        validate_node_reference(
            &tx,
            &story_id,
            faction_node_id.as_deref(),
            "faction",
            "faction card",
        )?;

        if let Some(giver) = giver_character_id.as_deref() {
            let giver_live: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM characters
                      WHERE id = ?1 AND story_id = ?2 AND deleted_at IS NULL",
                    params![giver, &story_id],
                    |row| row.get(0),
                )
                .optional()?;

            if giver_live.is_none() {
                return Err(DbError::Invalid(
                    "a quest giver must be live cast of this story".to_string(),
                ));
            }
        }

        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO quests
             (id, story_id, title, giver_character_id, faction_node_id,
              accepted_chapter_id, completed_chapter_id, status, description, notes,
              created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                &id,
                &story_id,
                &title,
                &giver_character_id,
                &faction_node_id,
                &accepted_chapter_id,
                &completed_chapter_id,
                &status,
                &description,
                &notes,
                &user,
                &timestamp,
                &timestamp
            ],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "quest",
                entity_id: &id,
                action: "create",
                field_changed: Some("title"),
                old_value: None,
                new_value: Some(title.clone()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(Quest {
            id,
            story_id,
            title,
            giver_character_id,
            faction_node_id,
            accepted_chapter_id: Some(accepted_chapter_id),
            completed_chapter_id,
            status,
            description,
            notes,
            created_by: user,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            rewards: Vec::new(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_quest(
        &self,
        id: String,
        title: String,
        giver_character_id: Option<String>,
        faction_node_id: Option<String>,
        accepted_chapter_id: String,
        completed_chapter_id: Option<String>,
        status: String,
        description: Option<String>,
        notes: Option<String>,
        user: String,
    ) -> DbResult<Quest> {
        let title = title.trim().to_string();

        if title.is_empty() {
            return Err(DbError::Invalid("a quest needs a title".to_string()));
        }

        let status = clean_quest_status(status)?;
        let description = clean_optional(description);
        let notes = clean_optional(notes);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, title, giver_character_id, faction_node_id,
                        accepted_chapter_id, completed_chapter_id, status, description, notes,
                        created_by, created_at
                 FROM quests WHERE id = ?1",
                params![&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("quest"))?;

        let (
            story_id,
            old_title,
            old_giver,
            old_faction,
            old_accepted,
            old_completed,
            old_status,
            old_description,
            old_notes,
            created_by,
            created_at,
        ) = existing;

        // Links sent back unchanged are not checked again: a chapter or card may
        // have been trashed since, and that should not stop an unrelated edit.
        if Some(accepted_chapter_id.as_str()) != old_accepted.as_deref() {
            validate_node_reference(
                &tx,
                &story_id,
                Some(&accepted_chapter_id),
                "chapter",
                "chapter",
            )?;
        }
        if completed_chapter_id != old_completed {
            validate_node_reference(
                &tx,
                &story_id,
                completed_chapter_id.as_deref(),
                "chapter",
                "chapter",
            )?;
        }
        if faction_node_id != old_faction {
            validate_node_reference(
                &tx,
                &story_id,
                faction_node_id.as_deref(),
                "faction",
                "faction card",
            )?;
        }
        if giver_character_id != old_giver {
            if let Some(giver) = giver_character_id.as_deref() {
                let giver_live: Option<i64> = tx
                    .query_row(
                        "SELECT 1 FROM characters
                          WHERE id = ?1 AND story_id = ?2 AND deleted_at IS NULL",
                        params![giver, &story_id],
                        |row| row.get(0),
                    )
                    .optional()?;

                if giver_live.is_none() {
                    return Err(DbError::Invalid(
                        "a quest giver must be live cast of this story".to_string(),
                    ));
                }
            }
        }

        let old_giver_label = character_reference_label(&tx, old_giver.as_deref())?;
        let new_giver_label = character_reference_label(&tx, giver_character_id.as_deref())?;
        let old_faction_label = reference_label(&tx, old_faction.as_deref())?;
        let new_faction_label = reference_label(&tx, faction_node_id.as_deref())?;
        let old_accepted_label = reference_label(&tx, old_accepted.as_deref())?;
        let new_accepted_label = reference_label(&tx, Some(&accepted_chapter_id))?;
        let old_completed_label = reference_label(&tx, old_completed.as_deref())?;
        let new_completed_label = reference_label(&tx, completed_chapter_id.as_deref())?;

        let mut changes: Vec<(&str, Option<String>, Option<String>)> = Vec::new();

        if old_title != title {
            changes.push(("title", Some(old_title), Some(title.clone())));
        }
        if old_status != status {
            changes.push(("status", Some(old_status), Some(status.clone())));
        }
        if old_giver != giver_character_id {
            changes.push(("giver", old_giver_label, new_giver_label));
        }
        if old_faction != faction_node_id {
            changes.push(("faction", old_faction_label, new_faction_label));
        }
        if old_accepted.as_deref() != Some(accepted_chapter_id.as_str()) {
            changes.push(("accepted", old_accepted_label, new_accepted_label));
        }
        if old_completed != completed_chapter_id {
            changes.push(("completed", old_completed_label, new_completed_label));
        }
        if old_description != description {
            changes.push(("description", old_description, description.clone()));
        }
        if old_notes != notes {
            changes.push(("notes", old_notes, notes.clone()));
        }

        tx.execute(
            "UPDATE quests
                SET title = ?1, giver_character_id = ?2, faction_node_id = ?3,
                    accepted_chapter_id = ?4, completed_chapter_id = ?5, status = ?6,
                    description = ?7, notes = ?8, updated_at = ?9
              WHERE id = ?10",
            params![
                &title,
                &giver_character_id,
                &faction_node_id,
                &accepted_chapter_id,
                &completed_chapter_id,
                &status,
                &description,
                &notes,
                &timestamp,
                &id
            ],
        )?;

        // A payout that went into one chapter has not been paid in a different
        // one, so changing where the quest ended makes its rewards fresh again.
        if old_completed != completed_chapter_id {
            tx.execute(
                "UPDATE quest_rewards SET applied_at = NULL WHERE quest_id = ?1",
                params![&id],
            )?;
        }

        for (field, old_value, new_value) in changes {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "quest",
                    entity_id: &id,
                    action: "update",
                    field_changed: Some(field),
                    old_value,
                    new_value,
                    changed_by: &user,
                },
            )?;
        }

        let rewards = {
            let mut stmt = tx.prepare(
                "SELECT id, quest_id, reward_type, target_id, amount_or_details,
                        created_at, updated_at, applied_at
                 FROM quest_rewards WHERE quest_id = ?1
                 ORDER BY created_at, id",
            )?;
            let rows = stmt.query_map(params![&id], quest_reward_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        tx.commit()?;

        Ok(Quest {
            id,
            story_id,
            title,
            giver_character_id,
            faction_node_id,
            accepted_chapter_id: Some(accepted_chapter_id),
            completed_chapter_id,
            status,
            description,
            notes,
            created_by,
            created_at,
            updated_at: timestamp,
            rewards,
        })
    }

    pub fn delete_quest(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT story_id, title FROM quests WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((story_id, title)) = existing else {
            return Ok(());
        };

        tx.execute("DELETE FROM quests WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "quest",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(title),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    pub fn add_quest_reward(
        &self,
        quest_id: String,
        reward_type: String,
        target_id: Option<String>,
        amount_or_details: Option<String>,
        user: String,
    ) -> DbResult<QuestReward> {
        let reward_type = clean_reward_type(reward_type)?;
        let details = clean_optional(amount_or_details);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let story_id: String = tx
            .query_row(
                "SELECT story_id FROM quests WHERE id = ?1",
                params![&quest_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(DbError::NotFound("quest"))?;

        validate_reward_target(&tx, &story_id, &reward_type, target_id.as_deref())?;

        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO quest_rewards
             (id, quest_id, reward_type, target_id, amount_or_details, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &id,
                &quest_id,
                &reward_type,
                &target_id,
                &details,
                &timestamp,
                &timestamp
            ],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "quest_reward",
                entity_id: &id,
                action: "create",
                field_changed: Some("type"),
                old_value: None,
                new_value: Some(reward_type.clone()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(QuestReward {
            id,
            quest_id,
            reward_type,
            target_id,
            amount_or_details: details,
            applied_at: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    pub fn update_quest_reward(
        &self,
        id: String,
        reward_type: String,
        target_id: Option<String>,
        amount_or_details: Option<String>,
        user: String,
    ) -> DbResult<QuestReward> {
        let reward_type = clean_reward_type(reward_type)?;
        let details = clean_optional(amount_or_details);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT r.quest_id, r.reward_type, r.target_id, r.amount_or_details,
                        r.created_at, q.story_id, r.applied_at
                 FROM quest_rewards r
                 JOIN quests q ON q.id = r.quest_id
                 WHERE r.id = ?1",
                params![&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("quest reward"))?;

        let (quest_id, old_type, old_target, old_details, created_at, story_id, old_applied) =
            existing;

        if reward_type != old_type || target_id != old_target {
            validate_reward_target(&tx, &story_id, &reward_type, target_id.as_deref())?;
        }

        let old_target_label = if old_type == "faction_standing" {
            reference_label(&tx, old_target.as_deref())?
        } else {
            character_reference_label(&tx, old_target.as_deref())?
        };
        let new_target_label = if reward_type == "faction_standing" {
            reference_label(&tx, target_id.as_deref())?
        } else {
            character_reference_label(&tx, target_id.as_deref())?
        };

        let mut changes: Vec<(&str, Option<String>, Option<String>)> = Vec::new();

        if old_type != reward_type {
            changes.push(("type", Some(old_type), Some(reward_type.clone())));
        }
        if old_target != target_id {
            changes.push(("target", old_target_label, new_target_label));
        }
        if old_details != details {
            changes.push(("details", old_details, details.clone()));
        }

        // Changing what a payout is means the earlier application no longer
        // describes it, so the next one is a first application again.
        let applied_at = if changes.is_empty() {
            old_applied
        } else {
            None
        };

        tx.execute(
            "UPDATE quest_rewards
                SET reward_type = ?1, target_id = ?2, amount_or_details = ?3,
                    updated_at = ?4, applied_at = ?5
              WHERE id = ?6",
            params![
                &reward_type,
                &target_id,
                &details,
                &timestamp,
                &applied_at,
                &id
            ],
        )?;

        for (field, old_value, new_value) in changes {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "quest_reward",
                    entity_id: &id,
                    action: "update",
                    field_changed: Some(field),
                    old_value,
                    new_value,
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(QuestReward {
            id,
            quest_id,
            reward_type,
            target_id,
            amount_or_details: details,
            applied_at,
            created_at,
            updated_at: timestamp,
        })
    }

    /// Remembers that a payout reached the chapter ledger, so the next session
    /// can warn before adding it a second time. Not audited: this is the app's
    /// memory of what it wrote, not an edit to the reward.
    pub fn mark_quest_rewards_applied(&self, ids: &[String]) -> DbResult<()> {
        if ids.is_empty() {
            return Ok(());
        }

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;
        let timestamp = now();

        for id in ids {
            tx.execute(
                "UPDATE quest_rewards SET applied_at = ?1 WHERE id = ?2",
                params![&timestamp, id],
            )?;
        }

        tx.commit()?;

        Ok(())
    }

    pub fn delete_quest_reward(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT r.reward_type, q.story_id
                 FROM quest_rewards r
                 JOIN quests q ON q.id = r.quest_id
                 WHERE r.id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((reward_type, story_id)) = existing else {
            return Ok(());
        };

        tx.execute("DELETE FROM quest_rewards WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "quest_reward",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(reward_type),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    // ===== LEVEL MILESTONES =====
    //
    // A milestone is the level a character had in a chapter, not the character's
    // current level. The two stay separate so recording where a level was reached
    // does not rewrite the sheet, and a deliberate penalty can be marked as such.

    /// The original milestone shape: no XP and no stat gains. Kept as a
    /// convenience for callers that only record a level.
    pub fn add_level_milestone(
        &self,
        character_id: String,
        level: i64,
        chapter_id: Option<String>,
        is_debuff: bool,
        user: String,
    ) -> DbResult<CharacterLevelMilestone> {
        self.add_level_milestone_with_changes(
            character_id,
            level,
            chapter_id,
            is_debuff,
            None,
            Vec::new(),
            user,
        )
    }

    /// The v17 shape, kept for older callers and tests: a single stat snapshot.
    /// It becomes one child row with a value-after and no recorded gain.
    #[allow(clippy::too_many_arguments)]
    pub fn add_level_milestone_with_metrics(
        &self,
        character_id: String,
        level: i64,
        chapter_id: Option<String>,
        is_debuff: bool,
        xp: Option<i64>,
        stat_name: Option<String>,
        stat_points: Option<i64>,
        user: String,
    ) -> DbResult<CharacterLevelMilestone> {
        let stat_changes = legacy_level_stat_changes(stat_name, stat_points)?;

        self.add_level_milestone_with_changes(
            character_id,
            level,
            chapter_id,
            is_debuff,
            xp,
            stat_changes,
            user,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_level_milestone_with_changes(
        &self,
        character_id: String,
        level: i64,
        chapter_id: Option<String>,
        is_debuff: bool,
        xp: Option<i64>,
        stat_changes: Vec<LevelStatChangeInput>,
        user: String,
    ) -> DbResult<CharacterLevelMilestone> {
        if level < 1 {
            return Err(DbError::Invalid(
                "a level milestone must be level 1 or higher".to_string(),
            ));
        }

        let xp = clean_level_xp(xp)?;
        let stat_changes = clean_level_stat_changes(stat_changes)?;
        let timestamp = now();
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;
        let story_id = live_character_story(&tx, &character_id)?;

        validate_node_reference(&tx, &story_id, chapter_id.as_deref(), "chapter", "chapter")?;

        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO character_level_milestones
             (id, character_id, level, chapter_id, is_debuff, xp, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                &id,
                &character_id,
                level,
                &chapter_id,
                is_debuff,
                xp,
                &timestamp
            ],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_level_milestone",
                entity_id: &id,
                action: "create",
                field_changed: Some("level"),
                old_value: None,
                new_value: Some(level.to_string()),
                changed_by: &user,
            },
        )?;

        if let Some(value) = xp {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_level_milestone",
                    entity_id: &id,
                    action: "create",
                    field_changed: Some("xp"),
                    old_value: None,
                    new_value: Some(value.to_string()),
                    changed_by: &user,
                },
            )?;
        }

        apply_level_stat_changes(&tx, &id, &story_id, &[], &stat_changes, &timestamp, &user)?;

        let stored_changes = load_level_stat_changes(&tx, &id)?;

        tx.commit()?;

        Ok(CharacterLevelMilestone {
            id,
            character_id,
            level,
            chapter_id,
            is_debuff,
            xp,
            stat_changes: stored_changes,
            stat_name: None,
            stat_points: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    pub fn update_level_milestone(
        &self,
        id: String,
        level: i64,
        chapter_id: Option<String>,
        is_debuff: bool,
        user: String,
    ) -> DbResult<CharacterLevelMilestone> {
        self.update_level_milestone_with_changes(
            id,
            level,
            chapter_id,
            is_debuff,
            None,
            Vec::new(),
            user,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_level_milestone_with_metrics(
        &self,
        id: String,
        level: i64,
        chapter_id: Option<String>,
        is_debuff: bool,
        xp: Option<i64>,
        stat_name: Option<String>,
        stat_points: Option<i64>,
        user: String,
    ) -> DbResult<CharacterLevelMilestone> {
        let stat_changes = legacy_level_stat_changes(stat_name, stat_points)?;

        self.update_level_milestone_with_changes(
            id,
            level,
            chapter_id,
            is_debuff,
            xp,
            stat_changes,
            user,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_level_milestone_with_changes(
        &self,
        id: String,
        level: i64,
        chapter_id: Option<String>,
        is_debuff: bool,
        xp: Option<i64>,
        stat_changes: Vec<LevelStatChangeInput>,
        user: String,
    ) -> DbResult<CharacterLevelMilestone> {
        if level < 1 {
            return Err(DbError::Invalid(
                "a level milestone must be level 1 or higher".to_string(),
            ));
        }

        let xp = clean_level_xp(xp)?;
        let stat_changes = clean_level_stat_changes(stat_changes)?;
        let timestamp = now();
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT m.character_id, m.level, m.chapter_id, m.is_debuff,
                        m.xp, m.created_at, m.updated_at, c.story_id
                 FROM character_level_milestones m
                 JOIN characters c ON c.id = m.character_id
                 JOIN stories st ON st.id = c.story_id
                 WHERE m.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
                params![&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("level milestone"))?;

        let (
            character_id,
            old_level,
            old_chapter,
            old_debuff,
            old_xp,
            created_at,
            old_updated_at,
            story_id,
        ) = existing;

        let existing_changes = load_level_stat_changes(&tx, &id)?;

        if chapter_id != old_chapter {
            validate_node_reference(&tx, &story_id, chapter_id.as_deref(), "chapter", "chapter")?;
        }

        let mut changes: Vec<(&str, Option<String>, Option<String>)> = Vec::new();

        if level != old_level {
            changes.push((
                "level",
                Some(old_level.to_string()),
                Some(level.to_string()),
            ));
        }

        if chapter_id != old_chapter {
            changes.push((
                "chapter",
                reference_label(&tx, old_chapter.as_deref())?,
                reference_label(&tx, chapter_id.as_deref())?,
            ));
        }

        if is_debuff != old_debuff {
            changes.push((
                "is_debuff",
                Some(yes_no(old_debuff)),
                Some(yes_no(is_debuff)),
            ));
        }

        if xp != old_xp {
            changes.push((
                "xp",
                old_xp.map(|value| value.to_string()),
                xp.map(|value| value.to_string()),
            ));
        }

        let stat_changes_changed = existing_changes.len() != stat_changes.len()
            || existing_changes.iter().any(|old| {
                stat_changes
                    .iter()
                    .find(|new| new.stat_name == old.stat_name)
                    .is_none_or(|new| {
                        new.amount != old.amount || new.value_after != old.value_after
                    })
            });

        if changes.is_empty() && !stat_changes_changed {
            return Ok(CharacterLevelMilestone {
                id,
                character_id,
                level,
                chapter_id,
                is_debuff,
                xp,
                stat_changes: existing_changes,
                stat_name: None,
                stat_points: None,
                created_at,
                updated_at: old_updated_at,
            });
        }

        tx.execute(
            "UPDATE character_level_milestones
                SET level = ?1, chapter_id = ?2, is_debuff = ?3, xp = ?4,
                    updated_at = ?5
              WHERE id = ?6",
            params![level, &chapter_id, is_debuff, xp, &timestamp, &id],
        )?;

        for (field, old_value, new_value) in changes {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_level_milestone",
                    entity_id: &id,
                    action: "update",
                    field_changed: Some(field),
                    old_value,
                    new_value,
                    changed_by: &user,
                },
            )?;
        }

        apply_level_stat_changes(
            &tx,
            &id,
            &story_id,
            &existing_changes,
            &stat_changes,
            &timestamp,
            &user,
        )?;

        let stored_changes = load_level_stat_changes(&tx, &id)?;

        tx.commit()?;

        Ok(CharacterLevelMilestone {
            id,
            character_id,
            level,
            chapter_id,
            is_debuff,
            xp,
            stat_changes: stored_changes,
            stat_name: None,
            stat_points: None,
            created_at,
            updated_at: timestamp,
        })
    }

    pub fn delete_level_milestone(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT m.level, c.story_id
                 FROM character_level_milestones m
                 JOIN characters c ON c.id = m.character_id
                 JOIN stories st ON st.id = c.story_id
                 WHERE m.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
                params![id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((level, story_id)) = existing else {
            return Ok(());
        };

        tx.execute(
            "DELETE FROM character_level_milestones WHERE id = ?1",
            params![id],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_level_milestone",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(level.to_string()),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    pub fn list_level_milestones(
        &self,
        character_id: &str,
    ) -> DbResult<Vec<CharacterLevelMilestone>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT m.id, m.character_id, m.level, m.chapter_id, m.is_debuff,
                    m.xp, m.created_at, m.updated_at
             FROM character_level_milestones m
             JOIN characters c ON c.id = m.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE m.character_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY m.created_at, m.id",
        )?;

        let rows = stmt.query_map(params![character_id], level_milestone_row)?;
        let mut milestones = rows.collect::<SqliteResult<Vec<_>>>()?;
        attach_level_stat_changes(&guard, &mut milestones)?;

        Ok(milestones)
    }

    pub fn list_story_level_milestones(
        &self,
        story_id: &str,
    ) -> DbResult<Vec<CharacterLevelMilestone>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT m.id, m.character_id, m.level, m.chapter_id, m.is_debuff,
                    m.xp, m.created_at, m.updated_at
             FROM character_level_milestones m
             JOIN characters c ON c.id = m.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE c.story_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY m.created_at, m.id",
        )?;

        let rows = stmt.query_map(params![story_id], level_milestone_row)?;
        let mut milestones = rows.collect::<SqliteResult<Vec<_>>>()?;
        attach_level_stat_changes(&guard, &mut milestones)?;

        Ok(milestones)
    }

    // ===== XP LEDGER =====
    //
    // One income row per character per chapter. A milestone can snapshot the
    // running total, but this table is what was earned in that chapter, so the
    // two answer different questions and neither is inferred from the other.

    pub fn add_character_progress(
        &self,
        character_id: String,
        chapter_id: String,
        xp_earned: i64,
        user: String,
    ) -> DbResult<CharacterProgress> {
        if xp_earned < 0 {
            return Err(DbError::Invalid(
                "experience earned cannot be negative".to_string(),
            ));
        }

        let timestamp = now();
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;
        let story_id = live_character_story(&tx, &character_id)?;
        let chapter_label =
            validate_node_reference(&tx, &story_id, Some(&chapter_id), "chapter", "chapter")?
                .ok_or_else(|| DbError::Invalid("a chapter is required".to_string()))?;

        let already_recorded: Option<String> = tx
            .query_row(
                "SELECT id FROM character_progress
                  WHERE character_id = ?1 AND chapter_id = ?2",
                params![&character_id, &chapter_id],
                |row| row.get(0),
            )
            .optional()?;

        if already_recorded.is_some() {
            return Err(DbError::Invalid(
                "that chapter already has XP recorded for this character".to_string(),
            ));
        }

        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO character_progress
             (id, character_id, chapter_id, xp_earned, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![&id, &character_id, &chapter_id, xp_earned, &timestamp],
        )?;

        for (field, value) in [
            ("chapter", chapter_label),
            ("xp_earned", xp_earned.to_string()),
        ] {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_progress",
                    entity_id: &id,
                    action: "create",
                    field_changed: Some(field),
                    old_value: None,
                    new_value: Some(value),
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(CharacterProgress {
            id,
            character_id,
            chapter_id,
            xp_earned,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    pub fn update_character_progress(
        &self,
        id: String,
        chapter_id: String,
        xp_earned: i64,
        user: String,
    ) -> DbResult<CharacterProgress> {
        if xp_earned < 0 {
            return Err(DbError::Invalid(
                "experience earned cannot be negative".to_string(),
            ));
        }

        let timestamp = now();
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT p.character_id, p.chapter_id, p.xp_earned, p.created_at,
                        p.updated_at, c.story_id
                 FROM character_progress p
                 JOIN characters c ON c.id = p.character_id
                 JOIN stories st ON st.id = c.story_id
                 WHERE p.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
                params![&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("XP ledger row"))?;

        let (character_id, old_chapter, old_xp, created_at, old_updated_at, story_id) = existing;

        let chapter_label = if chapter_id == old_chapter {
            reference_label(&tx, Some(&chapter_id))?
        } else {
            validate_node_reference(&tx, &story_id, Some(&chapter_id), "chapter", "chapter")?
                .ok_or_else(|| DbError::Invalid("a chapter is required".to_string()))?
                .into()
        };

        let mut changes: Vec<(&str, Option<String>, Option<String>)> = Vec::new();

        if chapter_id != old_chapter {
            changes.push((
                "chapter",
                reference_label(&tx, Some(&old_chapter))?,
                chapter_label.clone(),
            ));
        }

        if xp_earned != old_xp {
            changes.push((
                "xp_earned",
                Some(old_xp.to_string()),
                Some(xp_earned.to_string()),
            ));
        }

        let updated = CharacterProgress {
            id,
            character_id,
            chapter_id,
            xp_earned,
            created_at,
            updated_at: timestamp.clone(),
        };

        if changes.is_empty() {
            return Ok(CharacterProgress {
                updated_at: old_updated_at,
                ..updated
            });
        }

        let conflict: Option<String> = tx
            .query_row(
                "SELECT id FROM character_progress
                  WHERE character_id = ?1 AND chapter_id = ?2 AND id <> ?3",
                params![&updated.character_id, &updated.chapter_id, &updated.id],
                |row| row.get(0),
            )
            .optional()?;

        if conflict.is_some() {
            return Err(DbError::Invalid(
                "that chapter already has XP recorded for this character".to_string(),
            ));
        }

        tx.execute(
            "UPDATE character_progress
                SET chapter_id = ?1, xp_earned = ?2, updated_at = ?3
              WHERE id = ?4",
            params![&updated.chapter_id, xp_earned, &timestamp, &updated.id],
        )?;

        for (field, old_value, new_value) in changes {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_progress",
                    entity_id: &updated.id,
                    action: "update",
                    field_changed: Some(field),
                    old_value,
                    new_value,
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(updated)
    }

    pub fn delete_character_progress(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT p.xp_earned, c.story_id
                 FROM character_progress p
                 JOIN characters c ON c.id = p.character_id
                 JOIN stories st ON st.id = c.story_id
                 WHERE p.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
                params![id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((xp_earned, story_id)) = existing else {
            return Ok(());
        };

        tx.execute("DELETE FROM character_progress WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_progress",
                entity_id: id,
                action: "delete",
                field_changed: Some("xp_earned"),
                old_value: Some(xp_earned.to_string()),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    pub fn list_character_progress(&self, character_id: &str) -> DbResult<Vec<CharacterProgress>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT p.id, p.character_id, p.chapter_id, p.xp_earned,
                    p.created_at, p.updated_at
             FROM character_progress p
             JOIN characters c ON c.id = p.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE p.character_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY p.created_at, p.id",
        )?;

        let rows = stmt.query_map(params![character_id], character_progress_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    pub fn list_story_character_progress(
        &self,
        story_id: &str,
    ) -> DbResult<Vec<CharacterProgress>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT p.id, p.character_id, p.chapter_id, p.xp_earned,
                    p.created_at, p.updated_at
             FROM character_progress p
             JOIN characters c ON c.id = p.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE c.story_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY p.created_at, p.id",
        )?;

        let rows = stmt.query_map(params![story_id], character_progress_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    // ===== SKILL EVENTS =====
    //
    // A skill row says what the skill is now. These events say when it changed:
    // when a rank was reached, when it was used, and when it was sacrificed.

    #[allow(clippy::too_many_arguments)]
    pub fn add_skill_event(
        &self,
        skill_id: String,
        kind: String,
        chapter_id: Option<String>,
        rank: Option<String>,
        milestone_id: Option<String>,
        user: String,
    ) -> DbResult<CharacterSkillEvent> {
        let kind = clean_skill_event_kind(&kind)?;
        // A sacrifice ends the skill; it has no rank to carry, and keeping one
        // would let a later use look like a rank that was never lost.
        let rank = if kind == "sacrificed" {
            None
        } else {
            clean_optional(rank)
        };
        let timestamp = now();
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let (character_id, story_id) = tx
            .query_row(
                "SELECT s.character_id, c.story_id
                 FROM character_skills s
                 JOIN characters c ON c.id = s.character_id
                 JOIN stories st ON st.id = c.story_id
                 WHERE s.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
                params![&skill_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or(DbError::NotFound("skill"))?;

        let milestone = milestone_id
            .as_deref()
            .map(|id| resolve_level_milestone(&tx, id, &character_id))
            .transpose()?;

        let chapter_id = match (&chapter_id, &milestone) {
            (Some(chapter), Some((Some(milestone_chapter), _))) if chapter != milestone_chapter => {
                return Err(DbError::Invalid(
                    "a skill change and its level-up must be in the same chapter".to_string(),
                ));
            }
            (None, Some((Some(milestone_chapter), _))) => Some(milestone_chapter.clone()),
            _ => chapter_id,
        };

        validate_node_reference(&tx, &story_id, chapter_id.as_deref(), "chapter", "chapter")?;

        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO character_skill_events
             (id, skill_id, kind, chapter_id, rank, milestone_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                &id,
                &skill_id,
                &kind,
                &chapter_id,
                &rank,
                &milestone_id,
                &timestamp
            ],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_skill_event",
                entity_id: &id,
                action: "create",
                field_changed: Some("event"),
                old_value: None,
                new_value: Some(kind.clone()),
                changed_by: &user,
            },
        )?;

        if let Some((_, label)) = &milestone {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_skill_event",
                    entity_id: &id,
                    action: "create",
                    field_changed: Some("milestone"),
                    old_value: None,
                    new_value: Some(label.clone()),
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(CharacterSkillEvent {
            id,
            skill_id,
            kind,
            chapter_id,
            rank,
            milestone_id,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_skill_event(
        &self,
        id: String,
        kind: String,
        chapter_id: Option<String>,
        rank: Option<String>,
        milestone_id: Option<String>,
        user: String,
    ) -> DbResult<CharacterSkillEvent> {
        let kind = clean_skill_event_kind(&kind)?;
        let rank = if kind == "sacrificed" {
            None
        } else {
            clean_optional(rank)
        };
        let timestamp = now();
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT e.skill_id, e.kind, e.chapter_id, e.rank, e.milestone_id,
                        e.created_at, e.updated_at, c.story_id, s.character_id
                 FROM character_skill_events e
                 JOIN character_skills s ON s.id = e.skill_id
                 JOIN characters c ON c.id = s.character_id
                 JOIN stories st ON st.id = c.story_id
                 WHERE e.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
                params![&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("skill event"))?;

        let (
            skill_id,
            old_kind,
            old_chapter,
            old_rank,
            old_milestone,
            created_at,
            old_updated_at,
            story_id,
            character_id,
        ) = existing;

        let milestone = milestone_id
            .as_deref()
            .map(|milestone_id| resolve_level_milestone(&tx, milestone_id, &character_id))
            .transpose()?;
        let old_milestone_label = old_milestone
            .as_deref()
            .map(|milestone_id| resolve_level_milestone(&tx, milestone_id, &character_id))
            .transpose()?
            .map(|(_, label)| label);
        let new_milestone_label = milestone.as_ref().map(|(_, label)| label.clone());

        let chapter_id = match (&chapter_id, &milestone) {
            (Some(chapter), Some((Some(milestone_chapter), _))) if chapter != milestone_chapter => {
                return Err(DbError::Invalid(
                    "a skill change and its level-up must be in the same chapter".to_string(),
                ));
            }
            (None, Some((Some(milestone_chapter), _))) => Some(milestone_chapter.clone()),
            _ => chapter_id,
        };

        if chapter_id != old_chapter {
            validate_node_reference(&tx, &story_id, chapter_id.as_deref(), "chapter", "chapter")?;
        }

        let mut changes: Vec<(&str, Option<String>, Option<String>)> = Vec::new();

        if kind != old_kind {
            changes.push(("event", Some(old_kind.clone()), Some(kind.clone())));
        }
        if chapter_id != old_chapter {
            changes.push((
                "chapter",
                reference_label(&tx, old_chapter.as_deref())?,
                reference_label(&tx, chapter_id.as_deref())?,
            ));
        }
        if rank != old_rank {
            changes.push(("rank", old_rank.clone(), rank.clone()));
        }
        if milestone_id != old_milestone {
            changes.push(("milestone", old_milestone_label, new_milestone_label));
        }

        let updated = CharacterSkillEvent {
            id: id.clone(),
            skill_id,
            kind,
            chapter_id,
            rank,
            milestone_id,
            created_at,
            updated_at: timestamp.clone(),
        };

        if changes.is_empty() {
            return Ok(CharacterSkillEvent {
                updated_at: old_updated_at,
                ..updated
            });
        }

        tx.execute(
            "UPDATE character_skill_events
                SET kind = ?1, chapter_id = ?2, rank = ?3, milestone_id = ?4,
                    updated_at = ?5
              WHERE id = ?6",
            params![
                &updated.kind,
                &updated.chapter_id,
                &updated.rank,
                &updated.milestone_id,
                &timestamp,
                &id
            ],
        )?;

        for (field, old_value, new_value) in changes {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_skill_event",
                    entity_id: &updated.id,
                    action: "update",
                    field_changed: Some(field),
                    old_value,
                    new_value,
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(updated)
    }

    pub fn delete_skill_event(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT e.kind, c.story_id
                 FROM character_skill_events e
                 JOIN character_skills s ON s.id = e.skill_id
                 JOIN characters c ON c.id = s.character_id
                 JOIN stories st ON st.id = c.story_id
                 WHERE e.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((kind, story_id)) = existing else {
            return Ok(());
        };

        tx.execute(
            "DELETE FROM character_skill_events WHERE id = ?1",
            params![id],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_skill_event",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(kind),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    pub fn list_skill_events(&self, skill_id: &str) -> DbResult<Vec<CharacterSkillEvent>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT e.id, e.skill_id, e.kind, e.chapter_id, e.rank, e.milestone_id,
                    e.created_at, e.updated_at
             FROM character_skill_events e
             JOIN character_skills s ON s.id = e.skill_id
             JOIN characters c ON c.id = s.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE e.skill_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY e.created_at, e.id",
        )?;

        let rows = stmt.query_map(params![skill_id], skill_event_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    pub fn list_story_skill_events(&self, story_id: &str) -> DbResult<Vec<CharacterSkillEvent>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT e.id, e.skill_id, e.kind, e.chapter_id, e.rank, e.milestone_id,
                    e.created_at, e.updated_at
             FROM character_skill_events e
             JOIN character_skills s ON s.id = e.skill_id
             JOIN characters c ON c.id = s.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE c.story_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY e.created_at, e.id",
        )?;

        let rows = stmt.query_map(params![story_id], skill_event_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    // ===== SKILL EVOLUTIONS =====
    //
    // A skill row says what an ability is now; a skill event says when it
    // changed. An evolution is the other kind of history: which earlier skill it
    // grew out of, or which skills fused into it. The links form a graph, so the
    // database refuses a skill evolving into itself and any link that would close
    // a loop, and a character's tree is the closure around their own skills.

    pub fn add_skill_evolution(
        &self,
        parent_skill_id: String,
        child_skill_id: String,
        evolution_type: String,
        chapter_id: Option<String>,
        required_rank: Option<String>,
        notes: Option<String>,
        user: String,
    ) -> DbResult<SkillEvolution> {
        let evolution_type = clean_evolution_type(&evolution_type)?;
        let required_rank = clean_optional(required_rank);
        let notes = clean_optional(notes);
        let timestamp = now();

        if parent_skill_id == child_skill_id {
            return Err(DbError::Invalid(
                "a skill cannot evolve into itself".to_string(),
            ));
        }

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let parent = live_skill_ref(&tx, &parent_skill_id, "parent")?;
        let child = live_skill_ref(&tx, &child_skill_id, "child")?;
        let story_id = parent.0.clone();

        if story_id != child.0 {
            return Err(DbError::Invalid(
                "both skills in an evolution must belong to the same story".to_string(),
            ));
        }

        let chapter_label =
            validate_node_reference(&tx, &story_id, chapter_id.as_deref(), "chapter", "chapter")?;

        let duplicate: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM skill_evolutions
                  WHERE parent_skill_id = ?1 AND child_skill_id = ?2
                    AND evolution_type = ?3",
                params![&parent_skill_id, &child_skill_id, &evolution_type],
                |row| row.get(0),
            )
            .optional()?;

        if duplicate.is_some() {
            return Err(DbError::Invalid(format!(
                "“{}” → “{}” is already recorded as a {evolution_type} link",
                parent.1, child.1
            )));
        }

        if evolution_would_cycle(&tx, &parent_skill_id, &child_skill_id)? {
            return Err(DbError::Invalid(format!(
                "“{}” already leads to “{}”, so this link would close a loop",
                child.1, parent.1
            )));
        }

        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO skill_evolutions
             (id, story_id, parent_skill_id, child_skill_id, evolution_type,
              chapter_id, required_rank, notes, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                &id,
                &story_id,
                &parent_skill_id,
                &child_skill_id,
                &evolution_type,
                &chapter_id,
                &required_rank,
                &notes,
                &user,
                &timestamp
            ],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "skill_evolution",
                entity_id: &id,
                action: "create",
                field_changed: Some("evolution"),
                old_value: None,
                new_value: Some(format!("{} → {} ({evolution_type})", parent.1, child.1)),
                changed_by: &user,
            },
        )?;

        if let Some(label) = &chapter_label {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "skill_evolution",
                    entity_id: &id,
                    action: "create",
                    field_changed: Some("chapter"),
                    old_value: None,
                    new_value: Some(label.clone()),
                    changed_by: &user,
                },
            )?;
        }

        if let Some(rank) = &required_rank {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "skill_evolution",
                    entity_id: &id,
                    action: "create",
                    field_changed: Some("required rank"),
                    old_value: None,
                    new_value: Some(rank.clone()),
                    changed_by: &user,
                },
            )?;
        }

        if let Some(note) = &notes {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "skill_evolution",
                    entity_id: &id,
                    action: "create",
                    field_changed: Some("notes"),
                    old_value: None,
                    new_value: Some(note.clone()),
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(SkillEvolution {
            id,
            story_id,
            parent_skill_id,
            child_skill_id,
            evolution_type,
            chapter_id,
            required_rank,
            notes,
            created_by: user,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    pub fn delete_skill_evolution(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT e.story_id, e.evolution_type, p.name, c.name
                 FROM skill_evolutions e
                 JOIN character_skills p ON p.id = e.parent_skill_id
                 JOIN character_skills c ON c.id = e.child_skill_id
                 WHERE e.id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;

        let Some((story_id, evolution_type, parent_name, child_name)) = existing else {
            return Ok(());
        };

        tx.execute("DELETE FROM skill_evolutions WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "skill_evolution",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(format!("{parent_name} → {child_name} ({evolution_type})")),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    /// Every evolution link recorded in a story, including links whose skill is
    /// now in the trash, so continuity can name the problem rather than drop it.
    pub fn list_story_skill_evolutions(&self, story_id: &str) -> DbResult<Vec<SkillEvolution>> {
        let guard = self.conn()?;
        skill_evolutions_in(&guard, story_id)
    }

    /// One character's tree: every link connected to one of their skills, in
    /// either direction, followed outwards until the tree is closed.
    pub fn list_character_skill_evolutions(
        &self,
        character_id: &str,
    ) -> DbResult<Vec<SkillEvolution>> {
        let guard = self.conn()?;
        let story_id = live_character_story(&guard, character_id)?;
        let all = skill_evolutions_in(&guard, &story_id)?;

        let mut skill_ids: HashSet<String> = {
            let mut stmt =
                guard.prepare("SELECT id FROM character_skills WHERE character_id = ?1")?;
            let rows = stmt.query_map(params![character_id], |row| row.get::<_, String>(0))?;
            rows.collect::<SqliteResult<HashSet<_>>>()?
        };

        // Walk outwards from the character's own skills until no new skill is
        // reached; a link belongs to the tree when either end is reached.
        let mut chosen: Vec<SkillEvolution> = Vec::new();
        let mut visited_edges: HashSet<String> = HashSet::new();

        loop {
            let mut grew = false;

            for evolution in &all {
                if visited_edges.contains(&evolution.id) {
                    continue;
                }

                let touches = skill_ids.contains(&evolution.parent_skill_id)
                    || skill_ids.contains(&evolution.child_skill_id);

                if !touches {
                    continue;
                }

                visited_edges.insert(evolution.id.clone());
                chosen.push(evolution.clone());
                grew |= skill_ids.insert(evolution.parent_skill_id.clone());
                grew |= skill_ids.insert(evolution.child_skill_id.clone());
            }

            if !grew {
                break;
            }
        }

        chosen.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });

        Ok(chosen)
    }

    /// The whole story's skill graph, as the tree view reads it: live skills and
    /// the links between them.
    pub fn skill_tree_for_story(&self, story_id: &str) -> DbResult<SkillTree> {
        let skills = self.list_story_skills(story_id)?;
        let evolutions = self.list_story_skill_evolutions(story_id)?;
        let live: HashSet<String> = skills.iter().map(|skill| skill.id.clone()).collect();
        let evolutions = evolutions
            .into_iter()
            .filter(|evolution| {
                live.contains(&evolution.parent_skill_id)
                    && live.contains(&evolution.child_skill_id)
            })
            .collect();

        Ok(SkillTree { skills, evolutions })
    }

    /// One character's closed skill tree, ready to draw without another pass.
    pub fn skill_tree_for_character(&self, character_id: &str) -> DbResult<SkillTree> {
        let evolutions = self.list_character_skill_evolutions(character_id)?;
        let mut ids: HashSet<String> = {
            let guard = self.conn()?;
            let mut stmt =
                guard.prepare("SELECT id FROM character_skills WHERE character_id = ?1")?;
            let rows = stmt.query_map(params![character_id], |row| row.get::<_, String>(0))?;
            rows.collect::<SqliteResult<HashSet<_>>>()?
        };

        for evolution in &evolutions {
            ids.insert(evolution.parent_skill_id.clone());
            ids.insert(evolution.child_skill_id.clone());
        }

        let skills = {
            let guard = self.conn()?;
            let story_id = live_character_story(&guard, character_id)?;
            let mut stmt = guard.prepare(
                "SELECT s.id, s.character_id, s.name, s.rank, s.effect, s.chapter_id, s.node_id,
                        s.created_at, s.updated_at
                 FROM character_skills s
                 JOIN characters c ON c.id = s.character_id
                 JOIN stories st ON st.id = c.story_id
                 WHERE c.story_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
                 ORDER BY s.name COLLATE NOCASE",
            )?;
            let rows = stmt.query_map(params![&story_id], character_skill_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
                .into_iter()
                .filter(|skill| ids.contains(&skill.id))
                .collect::<Vec<_>>()
        };

        let live: HashSet<String> = skills.iter().map(|skill| skill.id.clone()).collect();
        let evolutions = evolutions
            .into_iter()
            .filter(|evolution| {
                live.contains(&evolution.parent_skill_id)
                    && live.contains(&evolution.child_skill_id)
            })
            .collect();

        Ok(SkillTree { skills, evolutions })
    }

    // ===== CHAPTER SNAPSHOT =====
    //
    // The progress ledger is a history, not a set of totals. This answers the
    // question the rest of the app asks when it looks at a scene: what did this
    // character's sheet hold when the story reached that chapter? The chapter's
    // place in the reading order, not when a row happened to be entered, decides.

    pub fn character_state_at_chapter(
        &self,
        character_id: &str,
        chapter_id: &str,
    ) -> DbResult<CharacterChapterState> {
        let guard = self.conn()?;
        Self::character_state_at_chapter_on(&guard, character_id, chapter_id)
    }

    /// The chapter cards need the same snapshot for every character assigned to
    /// every chapter, without one command per card. The database still decides
    /// who is assigned — a chapter's linked cast, its point of view and the
    /// explicit cast rows — and what each snapshot held as the story reached
    /// that chapter.
    pub fn list_chapter_cast_states(&self, story_id: &str) -> DbResult<Vec<ChapterCastState>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT n.id, n.character_id, n.chapter_pov
             FROM nodes n
             JOIN stories st ON st.id = n.story_id
             WHERE n.story_id = ?1 AND n.node_type = 'chapter'
               AND n.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY n.chapter_seq, n.created_at, n.id",
        )?;

        let nodes = stmt
            .query_map(params![story_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<SqliteResult<Vec<_>>>()?;

        drop(stmt);

        let mut assignments: Vec<(String, String)> = Vec::new();

        for (chapter_id, linked, pov) in nodes {
            for character_id in [linked, pov].into_iter().flatten() {
                let pair = (chapter_id.clone(), character_id);
                if !assignments.contains(&pair) {
                    assignments.push(pair);
                }
            }
        }

        // The explicit cast joins the linked cast and point of view. Trashed
        // chapters and characters drop out here so the board never shows a
        // badge for someone who is no longer in the story.
        let mut explicit_stmt = guard.prepare(
            "SELECT cc.chapter_id, cc.character_id
             FROM chapter_cast cc
             JOIN nodes n ON n.id = cc.chapter_id
             JOIN characters ch ON ch.id = cc.character_id
             JOIN stories st ON st.id = n.story_id
             WHERE n.story_id = ?1 AND n.node_type = 'chapter'
               AND n.deleted_at IS NULL AND ch.deleted_at IS NULL
               AND st.deleted_at IS NULL
             ORDER BY n.chapter_seq, cc.created_at, ch.name, ch.id",
        )?;

        let explicit = explicit_stmt
            .query_map(params![story_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<SqliteResult<Vec<_>>>()?;

        drop(explicit_stmt);

        for pair in explicit {
            if !assignments.contains(&pair) {
                assignments.push(pair);
            }
        }

        let mut states = Vec::new();

        for (chapter_id, character_id) in assignments {
            match Self::character_state_at_chapter_on(&guard, &character_id, &chapter_id) {
                Ok(state) => states.push(ChapterCastState {
                    chapter_id,
                    character_id,
                    level: state.level,
                    level_is_penalty: state.level_is_penalty,
                    skills: state.skills,
                }),
                // A cast member in the trash has no badge to draw, and a
                // chapter without a reading-order place has no snapshot;
                // neither should keep the rest of the board from loading.
                Err(DbError::NotFound(_)) | Err(DbError::Invalid(_)) => {}
                Err(error) => return Err(error),
            }
        }

        Ok(states)
    }

    // ===== CHAPTER CAST =====
    //
    // A chapter's cast is the linked cast member and point of view, plus every
    // character explicitly attached as present in the scene. The explicit rows
    // are kept here so a party can share a chapter without overwriting the
    // card's one linked cast member.

    pub fn list_story_chapter_cast(&self, story_id: &str) -> DbResult<Vec<ChapterCastMember>> {
        let guard = self.conn()?;

        let mut stmt = guard.prepare(
            "SELECT cc.id, cc.chapter_id, cc.character_id, cc.created_at, cc.updated_at
             FROM chapter_cast cc
             JOIN nodes n ON n.id = cc.chapter_id
             JOIN characters ch ON ch.id = cc.character_id
             JOIN stories st ON st.id = n.story_id
             WHERE n.story_id = ?1 AND n.node_type = 'chapter'
               AND n.deleted_at IS NULL AND ch.deleted_at IS NULL
               AND st.deleted_at IS NULL
             ORDER BY n.chapter_seq, cc.created_at, ch.name, ch.id",
        )?;

        let rows = stmt
            .query_map(params![story_id], |row| {
                Ok(ChapterCastMember {
                    id: row.get(0)?,
                    chapter_id: row.get(1)?,
                    character_id: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?
            .collect::<SqliteResult<Vec<_>>>()?;

        Ok(rows)
    }

    pub fn add_chapter_cast_member(
        &self,
        chapter_id: String,
        character_id: String,
        user: String,
    ) -> DbResult<ChapterCastMember> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let story_id = live_character_story(&tx, &character_id)?;
        validate_node_reference(&tx, &story_id, Some(&chapter_id), "chapter", "chapter")?
            .ok_or_else(|| DbError::Invalid("a chapter is required".to_string()))?;

        let existing = tx
            .query_row(
                "SELECT id, chapter_id, character_id, created_at, updated_at
                 FROM chapter_cast WHERE chapter_id = ?1 AND character_id = ?2",
                params![&chapter_id, &character_id],
                |row| {
                    Ok(ChapterCastMember {
                        id: row.get(0)?,
                        chapter_id: row.get(1)?,
                        character_id: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()?;

        // Toggling the same person on twice is not a change worth a history
        // entry; the scene already has them.
        if let Some(member) = existing {
            return Ok(member);
        }

        let name = tx
            .query_row(
                "SELECT name FROM characters WHERE id = ?1",
                params![&character_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or(DbError::NotFound("character"))?;
        let timestamp = now();
        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO chapter_cast (id, chapter_id, character_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![&id, &chapter_id, &character_id, &timestamp],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "chapter_cast",
                entity_id: &id,
                action: "create",
                field_changed: None,
                old_value: None,
                new_value: Some(name),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(ChapterCastMember {
            id,
            chapter_id,
            character_id,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    pub fn remove_chapter_cast_member(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT ch.name, n.story_id
                 FROM chapter_cast cc
                 JOIN nodes n ON n.id = cc.chapter_id
                 JOIN characters ch ON ch.id = cc.character_id
                 JOIN stories st ON st.id = n.story_id
                 WHERE cc.id = ?1 AND n.deleted_at IS NULL AND ch.deleted_at IS NULL
                   AND st.deleted_at IS NULL",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        // Already gone: nothing to remove, nothing to record.
        let Some((name, story_id)) = existing else {
            return Ok(());
        };

        tx.execute("DELETE FROM chapter_cast WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "chapter_cast",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(name),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    fn character_state_at_chapter_on(
        conn: &Connection,
        character_id: &str,
        chapter_id: &str,
    ) -> DbResult<CharacterChapterState> {
        let story_id = live_character_story(conn, character_id)?;

        let chapter = conn
            .query_row(
                "SELECT n.chapter_seq, n.story_id
                 FROM nodes n
                 JOIN stories st ON st.id = n.story_id
                 WHERE n.id = ?1 AND n.node_type = 'chapter'
                   AND n.deleted_at IS NULL AND st.deleted_at IS NULL",
                params![chapter_id],
                |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or(DbError::NotFound("chapter"))?;

        if chapter.1 != story_id {
            return Err(DbError::NotFound("chapter"));
        }

        let chapter_seq = chapter.0.ok_or_else(|| {
            DbError::Invalid(
                "a chapter needs a place in the reading order before its state can be read"
                    .to_string(),
            )
        })?;

        // The last milestone at or before this chapter is the level that applied.
        // A later chapter's milestone is not allowed to leak backwards.
        let milestone = conn
            .query_row(
                "SELECT m.id, m.character_id, m.level, m.chapter_id, m.is_debuff,
                        m.xp, m.created_at, m.updated_at
                 FROM character_level_milestones m
                 JOIN nodes n ON n.id = m.chapter_id
                 WHERE m.character_id = ?1 AND n.deleted_at IS NULL
                   AND n.node_type = 'chapter' AND n.chapter_seq IS NOT NULL
                   AND n.chapter_seq <= ?2
                 ORDER BY n.chapter_seq DESC, m.created_at DESC, m.id DESC
                 LIMIT 1",
                params![character_id, chapter_seq],
                level_milestone_row,
            )
            .optional()?;

        let (level, level_milestone_id, level_is_penalty) = match milestone {
            Some(milestone) => (
                Some(milestone.level),
                Some(milestone.id),
                milestone.is_debuff,
            ),
            None => (None, None, false),
        };

        // A skill is learned at a chapter, so only skills placed at or before this
        // one can be active. The chapter join is what makes "as of" honest: an
        // unplaced skill cannot be guessed into a scene.
        let mut learned = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT s.id, s.character_id, s.name, s.rank, s.effect, s.chapter_id,
                        s.node_id, s.created_at, s.updated_at, n.chapter_seq
                 FROM character_skills s
                 JOIN characters c ON c.id = s.character_id
                 JOIN stories st ON st.id = c.story_id
                 JOIN nodes n ON n.id = s.chapter_id
                 WHERE s.character_id = ?1 AND c.deleted_at IS NULL
                   AND st.deleted_at IS NULL AND n.deleted_at IS NULL
                   AND n.node_type = 'chapter' AND n.chapter_seq IS NOT NULL
                   AND n.chapter_seq <= ?2
                 ORDER BY n.chapter_seq, s.created_at, s.id",
            )?;

            let rows = stmt.query_map(params![character_id, chapter_seq], |row| {
                Ok((character_skill_row(row)?, row.get::<_, i64>(9)?))
            })?;

            for row in rows {
                learned.push(row?);
            }
        }

        // Events decide which of those skills survived to this chapter and which
        // rank applied. Only events at or before the chapter count, and an event
        // entered before the skill was learned is ignored rather than turning a
        // later scene into a contradiction.
        let mut events_by_skill: HashMap<String, Vec<(CharacterSkillEvent, i64)>> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT e.id, e.skill_id, e.kind, e.chapter_id, e.rank, e.milestone_id,
                        e.created_at, e.updated_at, n.chapter_seq
                 FROM character_skill_events e
                 JOIN character_skills s ON s.id = e.skill_id
                 JOIN characters c ON c.id = s.character_id
                 JOIN stories st ON st.id = c.story_id
                 JOIN nodes n ON n.id = e.chapter_id
                 WHERE s.character_id = ?1 AND c.deleted_at IS NULL
                   AND st.deleted_at IS NULL AND n.deleted_at IS NULL
                   AND n.node_type = 'chapter' AND n.chapter_seq IS NOT NULL
                   AND n.chapter_seq <= ?2
                 ORDER BY n.chapter_seq, e.created_at, e.id",
            )?;

            let rows = stmt.query_map(params![character_id, chapter_seq], |row| {
                Ok((skill_event_row(row)?, row.get::<_, i64>(8)?))
            })?;

            for row in rows {
                let (event, sequence) = row?;
                events_by_skill
                    .entry(event.skill_id.clone())
                    .or_default()
                    .push((event, sequence));
            }
        }

        let mut skills = Vec::new();

        for (skill, learned_seq) in learned {
            let Some(learned_chapter_id) = skill.chapter_id.clone() else {
                continue;
            };

            let mut events = events_by_skill.remove(&skill.id).unwrap_or_default();
            events.retain(|(_, sequence)| *sequence >= learned_seq);

            // A sacrifice removes the skill; a later use or upgrade is a
            // continuity warning, not a revival. Any sacrifice by this chapter
            // means there is nothing left to show.
            if events.iter().any(|(event, _)| event.kind == "sacrificed") {
                continue;
            }

            let rank = events
                .iter()
                .rev()
                .find_map(|(event, _)| match event.kind.as_str() {
                    "upgraded" | "used" => {
                        event.rank.clone().filter(|rank| !rank.trim().is_empty())
                    }
                    _ => None,
                })
                .or_else(|| skill.rank.clone());

            skills.push(CharacterChapterSkill {
                skill_id: skill.id,
                name: skill.name,
                rank,
                effect: skill.effect,
                learned_chapter_id,
                learned_chapter_seq: learned_seq,
            });
        }

        Ok(CharacterChapterState {
            character_id: character_id.to_string(),
            chapter_id: chapter_id.to_string(),
            chapter_seq,
            level,
            level_milestone_id,
            level_is_penalty,
            skills,
        })
    }

    // ===== INVENTORY AND CURRENCY =====
    //
    // Like skills, an item belongs to a character rather than to the board. The
    // optional acquired chapter, lost chapter and `item` card are links, checked
    // to be live nodes of the same story before anything is written, and all
    // survive a link being trashed. Currency is a named amount with no exchange
    // rate: the app records the ledger, it does not price anything.

    pub fn add_inventory_item(
        &self,
        character_id: String,
        name: String,
        rarity: Option<String>,
        quantity: i64,
        effect: Option<String>,
        chapter_id: Option<String>,
        lost_chapter_id: Option<String>,
        node_id: Option<String>,
        user: String,
    ) -> DbResult<InventoryItem> {
        let name = name.trim().to_string();

        if name.is_empty() {
            return Err(DbError::Invalid("an item needs a name".to_string()));
        }

        if quantity < 0 {
            return Err(DbError::Invalid(
                "an item's quantity cannot be negative".to_string(),
            ));
        }

        let rarity = clean_optional(rarity);
        let effect = clean_optional(effect);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let story_id = live_character_story(&tx, &character_id)?;
        validate_node_reference(&tx, &story_id, chapter_id.as_deref(), "chapter", "chapter")?;
        validate_node_reference(
            &tx,
            &story_id,
            lost_chapter_id.as_deref(),
            "chapter",
            "chapter",
        )?;
        validate_node_reference(&tx, &story_id, node_id.as_deref(), "item", "item card")?;

        let taken: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM character_inventory WHERE character_id = ?1 AND name = ?2",
                params![&character_id, &name],
                |row| row.get(0),
            )
            .optional()?;

        if taken.is_some() {
            return Err(DbError::Invalid(format!(
                "{name} is already in this character's inventory"
            )));
        }

        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO character_inventory
             (id, character_id, name, rarity, quantity, effect, chapter_id,
              lost_chapter_id, node_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &id,
                &character_id,
                &name,
                &rarity,
                quantity,
                &effect,
                &chapter_id,
                &lost_chapter_id,
                &node_id,
                &timestamp,
                &timestamp
            ],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_inventory",
                entity_id: &id,
                action: "create",
                field_changed: Some("name"),
                old_value: None,
                new_value: Some(name.clone()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(InventoryItem {
            id,
            character_id,
            name,
            rarity,
            quantity,
            effect,
            chapter_id,
            lost_chapter_id,
            node_id,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    pub fn update_inventory_item(
        &self,
        id: String,
        name: String,
        rarity: Option<String>,
        quantity: i64,
        effect: Option<String>,
        chapter_id: Option<String>,
        lost_chapter_id: Option<String>,
        node_id: Option<String>,
        user: String,
    ) -> DbResult<InventoryItem> {
        let name = name.trim().to_string();

        if name.is_empty() {
            return Err(DbError::Invalid("an item needs a name".to_string()));
        }

        if quantity < 0 {
            return Err(DbError::Invalid(
                "an item's quantity cannot be negative".to_string(),
            ));
        }

        let rarity = clean_optional(rarity);
        let effect = clean_optional(effect);
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT i.character_id, i.name, i.rarity, i.quantity, i.effect,
                        i.chapter_id, i.lost_chapter_id, i.node_id, i.created_at,
                        i.updated_at, c.story_id
                 FROM character_inventory i
                 JOIN characters c ON c.id = i.character_id
                 JOIN stories st ON st.id = c.story_id
                 WHERE i.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
                params![&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("inventory item"))?;

        let (
            character_id,
            old_name,
            old_rarity,
            old_quantity,
            old_effect,
            old_chapter,
            old_lost_chapter,
            old_node,
            created_at,
            old_updated_at,
            story_id,
        ) = existing;

        // A link sent back unchanged is not checked again: its chapter or card
        // may have been trashed since, and that should not stop an unrelated
        // quantity being saved.
        if chapter_id != old_chapter {
            validate_node_reference(&tx, &story_id, chapter_id.as_deref(), "chapter", "chapter")?;
        }
        if lost_chapter_id != old_lost_chapter {
            validate_node_reference(
                &tx,
                &story_id,
                lost_chapter_id.as_deref(),
                "chapter",
                "chapter",
            )?;
        }
        if node_id != old_node {
            validate_node_reference(&tx, &story_id, node_id.as_deref(), "item", "item card")?;
        }

        if name != old_name {
            let taken: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM character_inventory
                      WHERE character_id = ?1 AND name = ?2 AND id <> ?3",
                    params![&character_id, &name, &id],
                    |row| row.get(0),
                )
                .optional()?;

            if taken.is_some() {
                return Err(DbError::Invalid(format!(
                    "{name} is already in this character's inventory"
                )));
            }
        }

        // References read as their labels in the history, not as opaque ids.
        let old_chapter_label = reference_label(&tx, old_chapter.as_deref())?;
        let old_lost_chapter_label = reference_label(&tx, old_lost_chapter.as_deref())?;
        let old_node_label = reference_label(&tx, old_node.as_deref())?;
        let new_chapter_label = reference_label(&tx, chapter_id.as_deref())?;
        let new_lost_chapter_label = reference_label(&tx, lost_chapter_id.as_deref())?;
        let new_node_label = reference_label(&tx, node_id.as_deref())?;

        let mut changes: Vec<(&str, Option<String>, Option<String>)> = Vec::new();

        if name != old_name {
            changes.push(("name", Some(old_name.clone()), Some(name.clone())));
        }
        if rarity != old_rarity {
            changes.push(("rarity", old_rarity.clone(), rarity.clone()));
        }
        if quantity != old_quantity {
            changes.push((
                "quantity",
                Some(old_quantity.to_string()),
                Some(quantity.to_string()),
            ));
        }
        if effect != old_effect {
            changes.push(("effect", old_effect.clone(), effect.clone()));
        }
        if chapter_id != old_chapter {
            changes.push(("chapter", old_chapter_label, new_chapter_label));
        }
        if lost_chapter_id != old_lost_chapter {
            changes.push((
                "lost_chapter",
                old_lost_chapter_label,
                new_lost_chapter_label,
            ));
        }
        if node_id != old_node {
            changes.push(("item_card", old_node_label, new_node_label));
        }

        let updated = InventoryItem {
            id: id.clone(),
            character_id,
            name,
            rarity,
            quantity,
            effect,
            chapter_id,
            lost_chapter_id,
            node_id,
            created_at,
            updated_at: timestamp.clone(),
        };

        // Saving the same values writes nothing and bumps no timestamp.
        if changes.is_empty() {
            return Ok(InventoryItem {
                updated_at: old_updated_at,
                ..updated
            });
        }

        tx.execute(
            "UPDATE character_inventory
                SET name = ?1, rarity = ?2, quantity = ?3, effect = ?4,
                    chapter_id = ?5, lost_chapter_id = ?6, node_id = ?7,
                    updated_at = ?8
              WHERE id = ?9",
            params![
                &updated.name,
                &updated.rarity,
                updated.quantity,
                &updated.effect,
                &updated.chapter_id,
                &updated.lost_chapter_id,
                &updated.node_id,
                &updated.updated_at,
                &updated.id
            ],
        )?;

        for (field, old_value, new_value) in changes {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_inventory",
                    entity_id: &updated.id,
                    action: "update",
                    field_changed: Some(field),
                    old_value,
                    new_value,
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(updated)
    }

    pub fn delete_inventory_item(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT i.name, c.story_id
                 FROM character_inventory i
                 JOIN characters c ON c.id = i.character_id
                 WHERE i.id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((name, story_id)) = existing else {
            return Ok(());
        };

        tx.execute("DELETE FROM character_inventory WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_inventory",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(name),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    pub fn list_inventory(&self, character_id: &str) -> DbResult<Vec<InventoryItem>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT i.id, i.character_id, i.name, i.rarity, i.quantity, i.effect,
                    i.chapter_id, i.lost_chapter_id, i.node_id, i.created_at,
                    i.updated_at
             FROM character_inventory i
             JOIN characters c ON c.id = i.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE i.character_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY i.name COLLATE NOCASE",
        )?;

        let rows = stmt.query_map(params![character_id], inventory_item_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    /// Every item carried by every live cast member in a story, so an `item`
    /// card can name who holds it without one read per card.
    pub fn list_story_inventory(&self, story_id: &str) -> DbResult<Vec<InventoryItem>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT i.id, i.character_id, i.name, i.rarity, i.quantity, i.effect,
                    i.chapter_id, i.lost_chapter_id, i.node_id, i.created_at,
                    i.updated_at
             FROM character_inventory i
             JOIN characters c ON c.id = i.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE c.story_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY i.name COLLATE NOCASE",
        )?;

        let rows = stmt.query_map(params![story_id], inventory_item_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    pub fn add_currency(
        &self,
        character_id: String,
        name: String,
        amount: i64,
        user: String,
    ) -> DbResult<CharacterCurrency> {
        let name = name.trim().to_string();

        if name.is_empty() {
            return Err(DbError::Invalid("a currency needs a name".to_string()));
        }

        if amount < 0 {
            return Err(DbError::Invalid(
                "a currency amount cannot be negative".to_string(),
            ));
        }

        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let story_id = live_character_story(&tx, &character_id)?;

        let taken: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM character_currency WHERE character_id = ?1 AND name = ?2",
                params![&character_id, &name],
                |row| row.get(0),
            )
            .optional()?;

        if taken.is_some() {
            return Err(DbError::Invalid(format!(
                "{name} is already one of this character's currencies"
            )));
        }

        let id = Uuid::new_v4().to_string();

        tx.execute(
            "INSERT INTO character_currency (id, character_id, name, amount, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![&id, &character_id, &name, amount, &timestamp, &timestamp],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_currency",
                entity_id: &id,
                action: "create",
                field_changed: Some("name"),
                old_value: None,
                new_value: Some(name.clone()),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(CharacterCurrency {
            id,
            character_id,
            name,
            amount,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    pub fn update_currency(
        &self,
        id: String,
        name: String,
        amount: i64,
        user: String,
    ) -> DbResult<CharacterCurrency> {
        let name = name.trim().to_string();

        if name.is_empty() {
            return Err(DbError::Invalid("a currency needs a name".to_string()));
        }

        if amount < 0 {
            return Err(DbError::Invalid(
                "a currency amount cannot be negative".to_string(),
            ));
        }

        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT k.character_id, k.name, k.amount, k.created_at, k.updated_at, c.story_id
                 FROM character_currency k
                 JOIN characters c ON c.id = k.character_id
                 JOIN stories st ON st.id = c.story_id
                 WHERE k.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
                params![&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("currency"))?;

        let (character_id, old_name, old_amount, created_at, old_updated_at, story_id) = existing;

        if name != old_name {
            let taken: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM character_currency
                      WHERE character_id = ?1 AND name = ?2 AND id <> ?3",
                    params![&character_id, &name, &id],
                    |row| row.get(0),
                )
                .optional()?;

            if taken.is_some() {
                return Err(DbError::Invalid(format!(
                    "{name} is already one of this character's currencies"
                )));
            }
        }

        let mut changes: Vec<(&str, Option<String>, Option<String>)> = Vec::new();

        if name != old_name {
            changes.push(("name", Some(old_name.clone()), Some(name.clone())));
        }
        if amount != old_amount {
            changes.push((
                "amount",
                Some(old_amount.to_string()),
                Some(amount.to_string()),
            ));
        }

        let updated = CharacterCurrency {
            id: id.clone(),
            character_id,
            name,
            amount,
            created_at,
            updated_at: timestamp.clone(),
        };

        // Saving the same values writes nothing and bumps no timestamp.
        if changes.is_empty() {
            return Ok(CharacterCurrency {
                updated_at: old_updated_at,
                ..updated
            });
        }

        tx.execute(
            "UPDATE character_currency SET name = ?1, amount = ?2, updated_at = ?3 WHERE id = ?4",
            params![
                &updated.name,
                updated.amount,
                &updated.updated_at,
                &updated.id
            ],
        )?;

        for (field, old_value, new_value) in changes {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "character_currency",
                    entity_id: &updated.id,
                    action: "update",
                    field_changed: Some(field),
                    old_value,
                    new_value,
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(updated)
    }

    pub fn delete_currency(&self, id: &str, user: String) -> DbResult<()> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT k.name, c.story_id
                 FROM character_currency k
                 JOIN characters c ON c.id = k.character_id
                 WHERE k.id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((name, story_id)) = existing else {
            return Ok(());
        };

        tx.execute("DELETE FROM character_currency WHERE id = ?1", params![id])?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "character_currency",
                entity_id: id,
                action: "delete",
                field_changed: None,
                old_value: Some(name),
                new_value: None,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(())
    }

    pub fn list_currency(&self, character_id: &str) -> DbResult<Vec<CharacterCurrency>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT k.id, k.character_id, k.name, k.amount, k.created_at, k.updated_at
             FROM character_currency k
             JOIN characters c ON c.id = k.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE k.character_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY k.name COLLATE NOCASE",
        )?;

        let rows = stmt.query_map(params![character_id], character_currency_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    pub fn list_story_currency(&self, story_id: &str) -> DbResult<Vec<CharacterCurrency>> {
        let guard = self.conn()?;
        let mut stmt = guard.prepare(
            "SELECT k.id, k.character_id, k.name, k.amount, k.created_at, k.updated_at
             FROM character_currency k
             JOIN characters c ON c.id = k.character_id
             JOIN stories st ON st.id = c.story_id
             WHERE c.story_id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL
             ORDER BY k.name COLLATE NOCASE",
        )?;

        let rows = stmt.query_map(params![story_id], character_currency_row)?;

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
        self.create_node_with_character(
            story_id, node_type, label, content, pos_x, pos_y, created_by, None,
        )
    }

    /// Creates a node that may already point at a cast member — what dropping a
    /// cast card on the canvas does. The link is checked exactly as
    /// `set_node_character` checks it, before anything is written, so a drop
    /// either makes a linked node or nothing at all.
    pub fn create_node_with_character(
        &self,
        story_id: String,
        node_type: String,
        label: String,
        content: Option<String>,
        pos_x: f64,
        pos_y: f64,
        created_by: String,
        character_id: Option<String>,
    ) -> DbResult<Node> {
        let id = Uuid::new_v4().to_string();
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let character_name = linkable_character_name(&tx, &story_id, character_id.as_deref())?;

        // A chapter joins the end of the reading order. Trashed chapters count
        // too, so restoring one never collides with a chapter made since.
        let chapter_seq = if node_type == "chapter" {
            Some(tx.query_row(
                "SELECT COALESCE(MAX(chapter_seq), 0) + 1 FROM nodes
                 WHERE story_id = ?1 AND node_type = 'chapter'",
                params![&story_id],
                |row| row.get::<_, i64>(0),
            )?)
        } else {
            None
        };

        tx.execute(
            "INSERT INTO nodes (id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at, character_id, chapter_seq)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![&id, &story_id, &node_type, &label, &content, pos_x, pos_y, &created_by, &timestamp, &timestamp, &character_id, chapter_seq],
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

        // The link is part of the creation, not a second edit: the history says
        // the node arrived pointing at someone. `create` has nothing to revert
        // to, so this entry follows the same rule as the node's own creation.
        if let Some(name) = character_name {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "node",
                    entity_id: &id,
                    action: "create",
                    field_changed: Some("character"),
                    old_value: None,
                    new_value: Some(name),
                    changed_by: &created_by,
                },
            )?;
        }

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
            character_id,
            chapter_seq,
            chapter_arc: None,
            chapter_words: None,
            chapter_target: None,
            chapter_pov: None,
            chapter_day: None,
            chapter_time: None,
            parent_node_id: None,
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
                "SELECT id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at, character_id, chapter_seq,
                        chapter_arc, chapter_words, chapter_target, chapter_pov, chapter_day, chapter_time, parent_node_id
                 FROM nodes WHERE id = ?1",
                params![id],
                node_row,
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

        // A skill card is the shared name and description for every holder. The
        // same helper also runs when a revert puts a card's old label or notes
        // back, so the sheets never keep a value the card no longer has.
        if existing.node_type == "skill" && (label_changed || content_changed) {
            sync_skill_card_holders(
                &tx,
                &existing.story_id,
                id,
                &label,
                content.as_deref(),
                label_changed,
                content_changed,
                &user,
                &timestamp,
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

    /// Points a node at a cast member, or clears the link with `None`.
    ///
    /// The link is the character's id, so renaming either side leaves it intact —
    /// which is the whole reason it is not a name match. The history records the
    /// names, because a reader wants to see "Rook → Wren", not two UUIDs.
    pub fn set_node_character(
        &self,
        node_id: &str,
        character_id: Option<String>,
        user: String,
    ) -> DbResult<Node> {
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let (story_id, previous, deleted_at) = tx
            .query_row(
                "SELECT story_id, character_id, deleted_at FROM nodes WHERE id = ?1",
                params![node_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("node"))?;

        if deleted_at.is_some() {
            return Err(DbError::Invalid(
                "that node is in the trash; restore it before linking a cast member".to_string(),
            ));
        }

        // Checked before anything is written, so a refusal leaves the node exactly
        // as it was.
        let next_name = linkable_character_name(&tx, &story_id, character_id.as_deref())?;

        // Re-selecting the same cast member is not a change, and writes nothing.
        if previous == character_id {
            return Ok(read_node(&tx, node_id)?.ok_or(DbError::NotFound("node"))?);
        }

        // The name as it reads now, so the entry says what was replaced even if
        // that character has since been renamed or trashed.
        let previous_name: Option<String> = match &previous {
            Some(id) => tx
                .query_row(
                    "SELECT name FROM characters WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?,
            None => None,
        };

        tx.execute(
            "UPDATE nodes SET character_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![&character_id, &timestamp, node_id],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&story_id),
                entity_type: "node",
                entity_id: node_id,
                action: "update",
                field_changed: Some("character"),
                old_value: previous_name,
                new_value: next_name,
                changed_by: &user,
            },
        )?;

        let updated = read_node(&tx, node_id)?.ok_or(DbError::NotFound("node"))?;

        tx.commit()?;

        Ok(updated)
    }

    /// The board's cards: every live node of a story except notes. A note lives
    /// in a chapter row rather than on the canvas, so it is read by
    /// [`Db::list_chapter_notes`] instead.
    pub fn list_nodes(&self, story_id: &str) -> DbResult<Vec<Node>> {
        self.list_story_nodes(story_id, false)
    }

    /// Every live note of a story, oldest first. The caller groups them by the
    /// chapter in `parent_node_id`; one read serves the whole list.
    pub fn list_chapter_notes(&self, story_id: &str) -> DbResult<Vec<Node>> {
        self.list_story_nodes(story_id, true)
    }

    fn list_story_nodes(&self, story_id: &str, notes: bool) -> DbResult<Vec<Node>> {
        // The two reads differ only in which side of the note line they want.
        let sql = if notes {
            "SELECT n.id, n.story_id, n.node_type, n.label, n.content, n.pos_x, n.pos_y,
                    n.created_by, n.created_at, n.updated_at, n.character_id, n.chapter_seq,
                    n.chapter_arc, n.chapter_words, n.chapter_target, n.chapter_pov, n.chapter_day,
                    n.chapter_time, n.parent_node_id
             FROM nodes n JOIN stories s ON s.id = n.story_id
             WHERE n.story_id = ?1 AND n.node_type = 'note'
               AND n.deleted_at IS NULL AND s.deleted_at IS NULL
             ORDER BY n.created_at"
        } else {
            "SELECT n.id, n.story_id, n.node_type, n.label, n.content, n.pos_x, n.pos_y,
                    n.created_by, n.created_at, n.updated_at, n.character_id, n.chapter_seq,
                    n.chapter_arc, n.chapter_words, n.chapter_target, n.chapter_pov, n.chapter_day,
                    n.chapter_time, n.parent_node_id
             FROM nodes n JOIN stories s ON s.id = n.story_id
             WHERE n.story_id = ?1 AND n.node_type <> 'note'
               AND n.deleted_at IS NULL AND s.deleted_at IS NULL
             ORDER BY n.created_at"
        };

        let guard = self.conn()?;
        let mut stmt = guard.prepare(sql)?;
        let rows = stmt.query_map(params![story_id], node_row)?;

        Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
    }

    /// Adds a note under a chapter. A note is a node with `node_type = 'note'`
    /// and a parent pointer, so the history, the trash and the export carry it
    /// like anything else; it is simply not on the board. The label is the note's
    /// first line, which is what the trash and the history have to show.
    pub fn add_chapter_note(&self, chapter_id: &str, text: String, user: String) -> DbResult<Node> {
        let body = note_body(text)?;
        let label = note_label(&body);
        let timestamp = now();
        let id = Uuid::new_v4().to_string();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let story_id = writable_chapter(&tx, chapter_id)?;

        tx.execute(
            "INSERT INTO nodes (id, story_id, node_type, label, content, pos_x, pos_y,
                                created_by, created_at, updated_at, parent_node_id)
             VALUES (?1, ?2, 'note', ?3, ?4, 0, 0, ?5, ?6, ?6, ?7)",
            params![&id, &story_id, &label, &body, &user, &timestamp, chapter_id],
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
                new_value: Some(label),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        read_node(&guard, &id)?.ok_or(DbError::NotFound("node"))
    }

    /// Rewrites a note's text. Its label follows the first line, so the trash and
    /// the history keep naming it by what it now says; the text itself is the
    /// change the history records.
    pub fn update_note(&self, id: &str, text: String, user: String) -> DbResult<Node> {
        let body = note_body(text)?;
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at, character_id, chapter_seq,
                        chapter_arc, chapter_words, chapter_target, chapter_pov, chapter_day, chapter_time, parent_node_id
                 FROM nodes WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                node_row,
            )
            .optional()?
            .ok_or(DbError::NotFound("node"))?;

        if existing.node_type != "note" {
            return Err(DbError::Invalid(
                "only a note is edited with note text".to_string(),
            ));
        }

        if existing.content.as_deref() == Some(body.as_str()) {
            return Ok(existing);
        }

        tx.execute(
            "UPDATE nodes SET label = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
            params![note_label(&body), &body, &timestamp, id],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&existing.story_id),
                entity_type: "node",
                entity_id: id,
                action: "update",
                field_changed: Some("content"),
                old_value: existing.content.clone(),
                new_value: Some(body),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        read_node(&guard, id)?.ok_or(DbError::NotFound("node"))
    }

    /// Puts the live chapters of a story in the given reading order, numbering
    /// them 1..n. Every chapter must be listed exactly once: a partial order
    /// would leave a chapter unnumbered or a number doubled.
    pub fn set_chapter_order(
        &self,
        story_id: &str,
        ordered_ids: Vec<String>,
        user: String,
    ) -> DbResult<Vec<Node>> {
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing: Vec<(String, Option<i64>)> = {
            let mut stmt = tx.prepare(
                "SELECT id, chapter_seq FROM nodes
                 WHERE story_id = ?1 AND node_type = 'chapter' AND deleted_at IS NULL",
            )?;
            let rows = stmt.query_map(params![story_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
            })?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let listed: std::collections::HashSet<&str> =
            ordered_ids.iter().map(|id| id.as_str()).collect();

        if listed.len() != ordered_ids.len()
            || listed.len() != existing.len()
            || !existing.iter().all(|(id, _)| listed.contains(id.as_str()))
        {
            return Err(DbError::Invalid(
                "the order must list every live chapter of this story exactly once".to_string(),
            ));
        }

        for (index, id) in ordered_ids.iter().enumerate() {
            let position = (index + 1) as i64;
            let previous = existing
                .iter()
                .find(|(chapter_id, _)| chapter_id == id)
                .and_then(|(_, sequence)| *sequence);

            if previous == Some(position) {
                continue;
            }

            tx.execute(
                "UPDATE nodes SET chapter_seq = ?1, updated_at = ?2 WHERE id = ?3",
                params![position, &timestamp, id],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(story_id),
                    entity_type: "node",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("chapter_seq"),
                    old_value: previous.map(|value| value.to_string()),
                    new_value: Some(position.to_string()),
                    changed_by: &user,
                },
            )?;
        }

        let chapters = {
            let mut stmt = tx.prepare(
                "SELECT id, story_id, node_type, label, content, pos_x, pos_y,
                        created_by, created_at, updated_at, character_id, chapter_seq,
                        chapter_arc, chapter_words, chapter_target, chapter_pov, chapter_day, chapter_time, parent_node_id
                 FROM nodes
                 WHERE story_id = ?1 AND node_type = 'chapter' AND deleted_at IS NULL
                 ORDER BY chapter_seq, created_at",
            )?;
            let rows = stmt.query_map(params![story_id], node_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        tx.commit()?;

        Ok(chapters)
    }

    /// Saves the arc and the word counts a chapter carries.
    ///
    /// Only a live chapter has these fields, so another kind of node is refused
    /// rather than quietly storing numbers no screen would show. The counts are
    /// the author's: the app does not read a manuscript to work them out.
    pub fn set_chapter_details(
        &self,
        id: &str,
        arc: Option<String>,
        words: Option<i64>,
        target: Option<i64>,
        pov: Option<String>,
        day: Option<i64>,
        time: Option<String>,
        user: String,
    ) -> DbResult<Node> {
        if words.is_some_and(|count| count < 0) {
            return Err(DbError::Invalid(
                "a word count cannot be negative".to_string(),
            ));
        }

        if target.is_some_and(|count| count < 1) {
            return Err(DbError::Invalid(
                "a word target must be at least 1".to_string(),
            ));
        }

        if day.is_some_and(|day| day < 0) {
            return Err(DbError::Invalid(
                "an in-world day cannot be negative".to_string(),
            ));
        }

        let timestamp = now();
        let arc = arc
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        // A time is the author's own words, so only the spacing is tidied: what
        // is left is theirs to spell however they like.
        let time = time
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let pov = pov.filter(|id| !id.trim().is_empty());

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at, character_id, chapter_seq,
                        chapter_arc, chapter_words, chapter_target, chapter_pov, chapter_day, chapter_time, parent_node_id
                 FROM nodes WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                node_row,
            )
            .optional()?
            .ok_or(DbError::NotFound("node"))?;

        if existing.node_type != "chapter" {
            return Err(DbError::Invalid(
                "only a chapter has an arc, a POV, a day or word counts".to_string(),
            ));
        }

        // A POV is a cast link, checked the same way as the node's own link, so a
        // member from another story or one in the trash is refused up front. A POV
        // sent back unchanged is not checked again: its cast member may be in the
        // trash by now, and that should not stop an unrelated arc being saved.
        let pov_name = if pov == existing.chapter_pov {
            character_name(&tx, pov.as_deref())?
        } else {
            linkable_character_name(&tx, &existing.story_id, pov.as_deref())?
        };
        let previous_pov_name = character_name(&tx, existing.chapter_pov.as_deref())?;

        let arc_changed = existing.chapter_arc != arc;
        let words_changed = existing.chapter_words != words;
        let target_changed = existing.chapter_target != target;
        let pov_changed = existing.chapter_pov != pov;
        let day_changed = existing.chapter_day != day;
        let time_changed = existing.chapter_time != time;

        if !arc_changed
            && !words_changed
            && !target_changed
            && !pov_changed
            && !day_changed
            && !time_changed
        {
            return Ok(existing);
        }

        tx.execute(
            "UPDATE nodes SET chapter_arc = ?1, chapter_words = ?2, chapter_target = ?3,
                    chapter_pov = ?4, chapter_day = ?5, chapter_time = ?6, updated_at = ?7
             WHERE id = ?8",
            params![&arc, words, target, &pov, day, &time, &timestamp, id],
        )?;

        // One entry per field that changed, including a value being cleared: the
        // history should say the target was removed, not that nothing happened.
        if arc_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "node",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("chapter_arc"),
                    old_value: existing.chapter_arc.clone(),
                    new_value: arc.clone(),
                    changed_by: &user,
                },
            )?;
        }

        if words_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "node",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("chapter_words"),
                    old_value: existing.chapter_words.map(|value| value.to_string()),
                    new_value: words.map(|value| value.to_string()),
                    changed_by: &user,
                },
            )?;
        }

        if target_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "node",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("chapter_target"),
                    old_value: existing.chapter_target.map(|value| value.to_string()),
                    new_value: target.map(|value| value.to_string()),
                    changed_by: &user,
                },
            )?;
        }

        // Names, not ids, for the same reason a node's link records names: the
        // history is meant to be read, not resolved.
        if pov_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "node",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("chapter_pov"),
                    old_value: previous_pov_name,
                    new_value: pov_name,
                    changed_by: &user,
                },
            )?;
        }

        if day_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "node",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("chapter_day"),
                    old_value: existing.chapter_day.map(|value| value.to_string()),
                    new_value: day.map(|value| value.to_string()),
                    changed_by: &user,
                },
            )?;
        }

        if time_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "node",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("chapter_time"),
                    old_value: existing.chapter_time.clone(),
                    new_value: time.clone(),
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(Node {
            chapter_arc: arc,
            chapter_words: words,
            chapter_target: target,
            chapter_pov: pov,
            chapter_day: day,
            chapter_time: time,
            updated_at: timestamp,
            ..existing
        })
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

        let mut entries = query_audit(
            &guard,
            story_id,
            entity_type,
            entity_id,
            Some(limit),
            offset,
        )?;

        // Each entry is checked against the value its field holds now, so the tab
        // can say that a revert is no longer possible — and why — before a click.
        for entry in &mut entries {
            let check = check_revert(&guard, entry)?;
            entry.revert_state = check.state();
            entry.revert_reason = check.reason();
        }

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
                "SELECT id, story_id, name, description, level, xp, rank, xp_to_next,
                        created_at, updated_at
                 FROM characters WHERE story_id = ?1 AND deleted_at IS NULL ORDER BY name",
            )?;
            let rows = stmt.query_map(params![story_id], |row| {
                Ok(Character {
                    id: row.get(0)?,
                    story_id: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    level: row.get(4)?,
                    xp: row.get(5)?,
                    rank: row.get(6)?,
                    xp_to_next: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
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

        let mut character_skills = {
            let mut stmt = guard.prepare(
                "SELECT s.id, s.character_id, s.name, s.rank, s.effect, s.chapter_id, s.node_id,
                        s.created_at, s.updated_at
                 FROM character_skills s
                 JOIN characters c ON c.id = s.character_id
                 WHERE c.story_id = ?1 AND c.deleted_at IS NULL
                 ORDER BY s.name",
            )?;
            let rows = stmt.query_map(params![story_id], character_skill_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let skill_definitions = {
            let mut stmt = guard.prepare(
                "SELECT id, story_id, name, description, node_id, created_at, updated_at
                   FROM skill_definitions
                  WHERE story_id = ?1
                  ORDER BY created_at, id",
            )?;
            let rows = stmt.query_map(params![story_id], |row| {
                Ok(SkillDefinition {
                    id: row.get(0)?,
                    story_id: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    node_id: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let mut character_level_milestones = {
            let mut stmt = guard.prepare(
                "SELECT m.id, m.character_id, m.level, m.chapter_id, m.is_debuff,
                        m.xp, m.created_at, m.updated_at
                 FROM character_level_milestones m
                 JOIN characters c ON c.id = m.character_id
                 WHERE c.story_id = ?1 AND c.deleted_at IS NULL
                 ORDER BY m.created_at",
            )?;
            let rows = stmt.query_map(params![story_id], level_milestone_row)?;
            let mut milestones = rows.collect::<SqliteResult<Vec<_>>>()?;
            attach_level_stat_changes(&guard, &mut milestones)?;
            milestones
        };

        let mut character_skill_events = {
            let mut stmt = guard.prepare(
                "SELECT e.id, e.skill_id, e.kind, e.chapter_id, e.rank,
                        e.milestone_id, e.created_at, e.updated_at
                 FROM character_skill_events e
                 JOIN character_skills s ON s.id = e.skill_id
                 JOIN characters c ON c.id = s.character_id
                 WHERE c.story_id = ?1 AND c.deleted_at IS NULL
                 ORDER BY e.created_at",
            )?;
            let rows = stmt.query_map(params![story_id], skill_event_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let mut skill_evolutions = {
            let mut stmt = guard.prepare(
                "SELECT e.id, e.story_id, e.parent_skill_id, e.child_skill_id,
                        e.evolution_type, e.chapter_id, e.required_rank, e.notes,
                        e.created_by, e.created_at, e.updated_at
                 FROM skill_evolutions e
                 WHERE e.story_id = ?1
                 ORDER BY e.created_at, e.id",
            )?;
            let rows = stmt.query_map(params![story_id], skill_evolution_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let mut character_progress = {
            let mut stmt = guard.prepare(
                "SELECT p.id, p.character_id, p.chapter_id, p.xp_earned,
                        p.created_at, p.updated_at
                 FROM character_progress p
                 JOIN characters c ON c.id = p.character_id
                 WHERE c.story_id = ?1 AND c.deleted_at IS NULL
                 ORDER BY p.created_at, p.id",
            )?;
            let rows = stmt.query_map(params![story_id], character_progress_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let chapter_cast = {
            let mut stmt = guard.prepare(
                "SELECT cc.id, cc.chapter_id, cc.character_id, cc.created_at, cc.updated_at
                 FROM chapter_cast cc
                 JOIN nodes n ON n.id = cc.chapter_id
                 JOIN characters c ON c.id = cc.character_id
                 JOIN stories st ON st.id = n.story_id
                 WHERE n.story_id = ?1 AND n.node_type = 'chapter'
                   AND n.deleted_at IS NULL AND c.deleted_at IS NULL
                   AND st.deleted_at IS NULL
                 ORDER BY n.chapter_seq, cc.created_at, c.name",
            )?;
            let rows = stmt.query_map(params![story_id], |row| {
                Ok(ChapterCastMember {
                    id: row.get(0)?,
                    chapter_id: row.get(1)?,
                    character_id: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let mut character_inventory = {
            let mut stmt = guard.prepare(
                "SELECT i.id, i.character_id, i.name, i.rarity, i.quantity, i.effect,
                        i.chapter_id, i.lost_chapter_id, i.node_id, i.created_at,
                    i.updated_at
                 FROM character_inventory i
                 JOIN characters c ON c.id = i.character_id
                 WHERE c.story_id = ?1 AND c.deleted_at IS NULL
                 ORDER BY i.name",
            )?;
            let rows = stmt.query_map(params![story_id], inventory_item_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let character_currency = {
            let mut stmt = guard.prepare(
                "SELECT k.id, k.character_id, k.name, k.amount, k.created_at, k.updated_at
                 FROM character_currency k
                 JOIN characters c ON c.id = k.character_id
                 WHERE c.story_id = ?1 AND c.deleted_at IS NULL
                 ORDER BY k.name",
            )?;
            let rows = stmt.query_map(params![story_id], character_currency_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let nodes = {
            let mut stmt = guard.prepare(
                "SELECT id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at, character_id, chapter_seq,
                        chapter_arc, chapter_words, chapter_target, chapter_pov, chapter_day, chapter_time, parent_node_id
                 FROM nodes WHERE story_id = ?1 AND deleted_at IS NULL ORDER BY created_at",
            )?;
            let rows = stmt.query_map(params![story_id], node_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        // The trash is not exported, so a skill pointing at a chapter or card in
        // it would make the file reference a node it does not contain. The link
        // is cleared here, which keeps every export importable.
        let live_node_ids: std::collections::HashSet<&str> =
            nodes.iter().map(|node| node.id.as_str()).collect();
        let live_character_ids: std::collections::HashSet<&str> = characters
            .iter()
            .map(|character| character.id.as_str())
            .collect();

        for skill in &mut character_skills {
            if skill
                .chapter_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                skill.chapter_id = None;
            }
            if skill
                .node_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                skill.node_id = None;
            }
        }

        for milestone in &mut character_level_milestones {
            if milestone
                .chapter_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                milestone.chapter_id = None;
            }
        }

        // An XP income row is meaningless without its chapter, so a row whose
        // chapter is in the trash stays out of the file rather than pointing at
        // a node the copy does not contain.
        character_progress.retain(|entry| live_node_ids.contains(entry.chapter_id.as_str()));

        for event in &mut character_skill_events {
            if event
                .chapter_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                event.chapter_id = None;
            }
        }

        // An evolution needs both of its skills in the file, or the import would
        // point at a row that is not there. A link that touches a trashed skill
        // stays out of the export, and its chapter is cleared like the others.
        let exported_skill_ids: std::collections::HashSet<&str> = character_skills
            .iter()
            .map(|skill| skill.id.as_str())
            .collect();

        skill_evolutions.retain(|evolution| {
            exported_skill_ids.contains(evolution.parent_skill_id.as_str())
                && exported_skill_ids.contains(evolution.child_skill_id.as_str())
        });

        for evolution in &mut skill_evolutions {
            if evolution
                .chapter_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                evolution.chapter_id = None;
            }
        }

        for item in &mut character_inventory {
            if item
                .chapter_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                item.chapter_id = None;
            }
            if item
                .lost_chapter_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                item.lost_chapter_id = None;
            }
            if item
                .node_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                item.node_id = None;
            }
        }

        let mut character_relations = {
            let mut stmt = guard.prepare(
                "SELECT r.id, r.story_id, r.from_character_id, r.to_character_id, r.kind, r.note,
                        r.since_chapter_id, r.until_chapter_id, r.created_by, r.created_at, r.updated_at
                 FROM character_relations r
                 JOIN characters c ON c.id = r.from_character_id
                 JOIN characters d ON d.id = r.to_character_id
                 WHERE r.story_id = ?1 AND c.deleted_at IS NULL AND d.deleted_at IS NULL
                 ORDER BY r.created_at",
            )?;
            let rows = stmt.query_map(params![story_id], character_relation_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        for relation in &mut character_relations {
            if relation
                .since_chapter_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                relation.since_chapter_id = None;
            }
            if relation
                .until_chapter_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                relation.until_chapter_id = None;
            }
        }

        // A standing without the chapter it began in cannot be placed, so a row
        // whose start chapter is in the trash stays out of the file.
        let mut faction_standings = {
            let mut stmt = guard.prepare(
                "SELECT s.id, s.story_id, s.character_id, s.faction_node_id, s.standing, s.note,
                        s.since_chapter_id, s.until_chapter_id, s.created_by, s.created_at,
                        s.updated_at
                 FROM faction_standings s
                 JOIN characters c ON c.id = s.character_id
                 WHERE s.story_id = ?1 AND c.deleted_at IS NULL
                 ORDER BY s.created_at",
            )?;
            let rows = stmt.query_map(params![story_id], faction_standing_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        for standing in &mut faction_standings {
            if standing
                .faction_node_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                standing.faction_node_id = None;
            }
            if standing
                .until_chapter_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                standing.until_chapter_id = None;
            }
        }

        faction_standings.retain(|standing| {
            standing
                .since_chapter_id
                .as_deref()
                .is_some_and(|id| live_node_ids.contains(id))
        });

        // A quest is placed by the chapter it was accepted in, so a quest whose
        // acceptance chapter is in the trash is left out of the file. The rest
        // of its links are cleared the way a skill's are.
        let mut quests = {
            let mut stmt = guard.prepare(
                "SELECT q.id, q.story_id, q.title, q.giver_character_id, q.faction_node_id,
                        q.accepted_chapter_id, q.completed_chapter_id, q.status, q.description,
                        q.notes, q.created_by, q.created_at, q.updated_at
                 FROM quests q
                 JOIN nodes a ON a.id = q.accepted_chapter_id
                 WHERE q.story_id = ?1 AND a.deleted_at IS NULL
                 ORDER BY q.created_at, q.id",
            )?;
            let rows = stmt.query_map(params![story_id], quest_row)?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        let mut quest_rewards = Vec::new();

        {
            let mut stmt = guard.prepare(
                "SELECT r.id, r.quest_id, r.reward_type, r.target_id, r.amount_or_details,
                        r.created_at, r.updated_at, r.applied_at
                 FROM quest_rewards r
                 JOIN quests q ON q.id = r.quest_id
                 JOIN nodes a ON a.id = q.accepted_chapter_id
                 WHERE q.story_id = ?1 AND a.deleted_at IS NULL
                 ORDER BY r.created_at, r.id",
            )?;
            let rows = stmt.query_map(params![story_id], quest_reward_row)?;
            quest_rewards.extend(rows.collect::<SqliteResult<Vec<_>>>()?);
        }

        for quest in &mut quests {
            if quest
                .giver_character_id
                .as_deref()
                .is_some_and(|id| !live_character_ids.contains(id))
            {
                quest.giver_character_id = None;
            }
            if quest
                .faction_node_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                quest.faction_node_id = None;
            }
            if quest
                .completed_chapter_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                quest.completed_chapter_id = None;
            }
            if quest
                .accepted_chapter_id
                .as_deref()
                .is_some_and(|id| !live_node_ids.contains(id))
            {
                quest.accepted_chapter_id = None;
            }
        }

        quest_rewards.retain(|reward| quests.iter().any(|quest| quest.id == reward.quest_id));

        for reward in &mut quest_rewards {
            let target_alive = match reward.target_id.as_deref() {
                None => true,
                Some(id) if reward.reward_type == "faction_standing" => live_node_ids.contains(id),
                Some(id) => live_character_ids.contains(id),
            };

            if !target_alive {
                reward.target_id = None;
            }
        }

        for quest in &mut quests {
            let own: Vec<QuestReward> = quest_rewards
                .iter()
                .filter(|reward| reward.quest_id == quest.id)
                .cloned()
                .collect();
            quest.rewards = own;
        }

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
            character_skills,
            skill_definitions,
            character_level_milestones,
            character_skill_events,
            skill_evolutions,
            character_progress,
            chapter_cast,
            character_inventory,
            character_currency,
            character_relations,
            faction_standings,
            quests,
            nodes,
            edges,
            audit_trail,
        })
    }

    /// A plain Markdown outline for a drafting tool: chapters in reading order
    /// with their arc, counts and notes, the cast with their sheets, then the
    /// other cards. Deliberately free of app jargon — it is written to be pasted
    /// into another program, not read back by this one.
    pub fn story_bible(&self, story_id: &str) -> DbResult<StoryBible> {
        let story = self
            .get_story(story_id)?
            .ok_or(DbError::NotFound("story"))?;
        let nodes = self.list_nodes(story_id)?;
        let characters = self.list_characters(story_id)?;
        let stats = self.list_story_stats(story_id)?;
        let skills = self.list_story_skills(story_id)?;
        let inventory = self.list_story_inventory(story_id)?;
        let currencies = self.list_story_currency(story_id)?;
        let relations = self.list_story_relations(story_id)?;
        let faction_standings = self.list_story_faction_standings(story_id)?;
        // The notes are nodes of their own, kept off the board, so they are read
        // separately and filed under the chapter that holds them.
        let chapter_notes = self.list_chapter_notes(story_id)?;
        let notes_by_chapter: std::collections::HashMap<&str, Vec<&Node>> = {
            let mut grouped: std::collections::HashMap<&str, Vec<&Node>> =
                std::collections::HashMap::new();

            for note in &chapter_notes {
                if let Some(chapter_id) = note.parent_node_id.as_deref() {
                    grouped.entry(chapter_id).or_default().push(note);
                }
            }

            grouped
        };
        let pov_names: std::collections::HashMap<&str, &str> = characters
            .iter()
            .map(|character| (character.id.as_str(), character.name.as_str()))
            .collect();
        // A skill names the chapter it was learned in by the chapter's title, the
        // same way a POV is named by the cast member's name.
        let node_names: std::collections::HashMap<&str, &str> = nodes
            .iter()
            .map(|node| (node.id.as_str(), node.label.as_str()))
            .collect();

        let mut lines: Vec<String> = vec![format!("# {}", story.title)];

        if let Some(description) = story
            .description
            .as_deref()
            .map(str::trim)
            .filter(|description| !description.is_empty())
        {
            lines.push(String::new());
            lines.push(description.to_string());
        }

        let mut chapters: Vec<&Node> = nodes
            .iter()
            .filter(|node| node.node_type == "chapter")
            .collect();
        chapters.sort_by(|left, right| {
            left.chapter_seq
                .unwrap_or(i64::MAX)
                .cmp(&right.chapter_seq.unwrap_or(i64::MAX))
                .then_with(|| left.created_at.cmp(&right.created_at))
        });

        if !chapters.is_empty() {
            lines.push(String::new());
            lines.push("## Chapters".to_string());

            let words: i64 = chapters.iter().filter_map(|node| node.chapter_words).sum();
            let targets: Vec<i64> = chapters
                .iter()
                .filter_map(|node| node.chapter_target)
                .collect();

            if words > 0 || !targets.is_empty() {
                let mut total = format!("{} words in {} chapters", grouped(words), chapters.len());

                if !targets.is_empty() {
                    total.push_str(&format!(
                        "; {} targeted across {} of them",
                        grouped(targets.iter().sum()),
                        targets.len()
                    ));
                }

                total.push('.');

                lines.push(String::new());
                lines.push(format!("*{total}*"));
            }

            for chapter in &chapters {
                lines.push(String::new());
                lines.push(match chapter.chapter_seq {
                    Some(sequence) => format!("### {sequence}. {}", chapter.label),
                    None => format!("### {}", chapter.label),
                });

                let mut facts: Vec<String> = Vec::new();

                if let Some(arc) = chapter
                    .chapter_arc
                    .as_deref()
                    .map(str::trim)
                    .filter(|arc| !arc.is_empty())
                {
                    facts.push(format!("**Arc:** {arc}"));
                }

                if let Some(day) = chapter.chapter_day {
                    facts.push(format!("**Day:** {day}"));
                }

                // The author's own words for the moment inside the day, printed
                // as typed: the bible is theirs to read, not a clock to parse.
                if let Some(time) = chapter
                    .chapter_time
                    .as_deref()
                    .map(str::trim)
                    .filter(|time| !time.is_empty())
                {
                    facts.push(format!("**Time:** {time}"));
                }

                if let Some(pov) = chapter
                    .chapter_pov
                    .as_deref()
                    .and_then(|id| pov_names.get(id))
                {
                    facts.push(format!("**POV:** {pov}"));
                }

                match (chapter.chapter_words, chapter.chapter_target) {
                    (Some(words), Some(target)) => facts.push(format!(
                        "**Words:** {} of {}",
                        grouped(words),
                        grouped(target)
                    )),
                    (Some(words), None) => facts.push(format!("**Words:** {}", grouped(words))),
                    (None, Some(target)) => {
                        facts.push(format!("**Target:** {} words", grouped(target)))
                    }
                    (None, None) => {}
                }

                if !facts.is_empty() {
                    lines.push(String::new());
                    lines.push(facts.join(" · "));
                }

                if let Some(notes) = chapter
                    .content
                    .as_deref()
                    .map(str::trim)
                    .filter(|notes| !notes.is_empty())
                {
                    lines.push(String::new());
                    lines.push(notes.to_string());
                }

                // The chapter's own notes, in the order they were written. The
                // label heads the list once rather than repeating on every line.
                if let Some(notes) = notes_by_chapter.get(chapter.id.as_str()) {
                    let items: Vec<String> = notes
                        .iter()
                        .flat_map(|note| note_markdown(note.content.as_deref().unwrap_or("")))
                        .collect();

                    if !items.is_empty() {
                        lines.push(String::new());
                        lines.push("**Notes**".to_string());
                        lines.push(String::new());
                        lines.extend(items);
                    }
                }
            }
        }

        // Time order, which is not always reading order. Only chapters with a day
        // appear here; an unplaced chapter is not quietly given one. Inside a day
        // the author's time labels order the chapters when they read as a time of
        // day; the rest wait after them in reading order, as on the Chapters tab.
        let mut timeline: Vec<&Node> = chapters
            .iter()
            .copied()
            .filter(|chapter| chapter.chapter_day.is_some())
            .collect();

        if !timeline.is_empty() {
            timeline.sort_by(|left, right| {
                let day = left
                    .chapter_day
                    .unwrap_or(0)
                    .cmp(&right.chapter_day.unwrap_or(0));

                if day != Ordering::Equal {
                    return day;
                }

                // A label the clock cannot read has no place inside the day, so
                // it waits after the ones that do, in reading order.
                match (
                    left.chapter_time.as_deref().and_then(time_of_day),
                    right.chapter_time.as_deref().and_then(time_of_day),
                ) {
                    (Some(left), Some(right)) => left.cmp(&right),
                    (None, None) => Ordering::Equal,
                    (None, Some(_)) => Ordering::Greater,
                    (Some(_), None) => Ordering::Less,
                }
            });

            lines.push(String::new());
            lines.push("## Timeline".to_string());

            for chapter in timeline {
                let pov = chapter
                    .chapter_pov
                    .as_deref()
                    .and_then(|id| pov_names.get(id))
                    .map(|name| format!(" ({name})"))
                    .unwrap_or_default();

                let time = chapter
                    .chapter_time
                    .as_deref()
                    .map(str::trim)
                    .filter(|time| !time.is_empty())
                    .map(|time| format!(", {time}"))
                    .unwrap_or_default();

                lines.push(format!(
                    "- Day {}{} — {}{}",
                    chapter.chapter_day.unwrap_or(0),
                    time,
                    chapter.label,
                    pov
                ));
            }
        }

        if !characters.is_empty() {
            lines.push(String::new());
            lines.push("## Cast".to_string());

            for character in &characters {
                lines.push(String::new());
                lines.push(format!("### {}", character.name));

                let mut facts = vec![format!("Level {}", character.level)];

                if let Some(rank) = character
                    .rank
                    .as_deref()
                    .map(str::trim)
                    .filter(|rank| !rank.is_empty())
                {
                    facts.push(format!("Rank {rank}"));
                }

                if let Some(target) = character.xp_to_next {
                    facts.push(format!(
                        "{} XP of {}",
                        grouped(character.xp),
                        grouped(target)
                    ));
                } else if character.xp > 0 {
                    facts.push(format!("{} XP", grouped(character.xp)));
                }

                lines.push(String::new());
                lines.push(facts.join(" · "));

                if let Some(description) = character
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|description| !description.is_empty())
                {
                    lines.push(String::new());
                    lines.push(description.to_string());
                }

                let own_stats: Vec<&CharacterStat> = stats
                    .iter()
                    .filter(|stat| stat.character_id == character.id)
                    .collect();
                let attributes = self.list_attributes(&character.id)?;
                let own_skills: Vec<&CharacterSkill> = skills
                    .iter()
                    .filter(|skill| skill.character_id == character.id)
                    .collect();
                let own_items: Vec<&InventoryItem> = inventory
                    .iter()
                    .filter(|item| item.character_id == character.id)
                    .collect();
                let own_currency: Vec<&CharacterCurrency> = currencies
                    .iter()
                    .filter(|currency| currency.character_id == character.id)
                    .collect();
                // A relation is printed under both people it joins, each naming
                // the other; one whose other end is in the trash is left out of
                // the bible because there is no live name to print.
                let own_relations: Vec<(&CharacterRelation, &str)> = relations
                    .iter()
                    .filter_map(|relation| {
                        if relation.from_character_id == character.id {
                            pov_names
                                .get(relation.to_character_id.as_str())
                                .map(|name| (relation, *name))
                        } else if relation.to_character_id == character.id {
                            pov_names
                                .get(relation.from_character_id.as_str())
                                .map(|name| (relation, *name))
                        } else {
                            None
                        }
                    })
                    .collect();
                let own_standings: Vec<&FactionStanding> = faction_standings
                    .iter()
                    .filter(|standing| standing.character_id == character.id)
                    .collect();

                if !own_stats.is_empty()
                    || !attributes.is_empty()
                    || !own_skills.is_empty()
                    || !own_items.is_empty()
                    || !own_currency.is_empty()
                    || !own_relations.is_empty()
                    || !own_standings.is_empty()
                {
                    lines.push(String::new());

                    for stat in own_stats {
                        lines.push(format!("- {}: {}", stat.stat_name, stat.value));
                    }

                    for attribute in attributes {
                        lines.push(format!("- {}: {}", attribute.attr_name, attribute.value));
                    }

                    for skill in own_skills {
                        let mut line = format!("- **{}**", skill.name);

                        if let Some(rank) = skill
                            .rank
                            .as_deref()
                            .map(str::trim)
                            .filter(|rank| !rank.is_empty())
                        {
                            line.push_str(&format!(" · {rank}"));
                        }

                        if let Some(effect) = skill
                            .effect
                            .as_deref()
                            .map(str::trim)
                            .filter(|effect| !effect.is_empty())
                        {
                            line.push_str(&format!(" — {effect}"));
                        }

                        if let Some(chapter) = skill
                            .chapter_id
                            .as_deref()
                            .and_then(|id| node_names.get(id))
                        {
                            line.push_str(&format!(" (learned in \"{chapter}\")"));
                        }

                        lines.push(line);
                    }

                    for (relation, other) in own_relations {
                        let mut line = if relation_is_symmetric(&relation.kind) {
                            format!("- **{}** with {other}", relation.kind)
                        } else {
                            format!("- **{}** → {other}", relation.kind)
                        };

                        if let Some(since) = relation
                            .since_chapter_id
                            .as_deref()
                            .and_then(|id| node_names.get(id))
                        {
                            line.push_str(&format!(" (since \"{since}\")"));
                        }

                        if let Some(note) = relation
                            .note
                            .as_deref()
                            .map(str::trim)
                            .filter(|note| !note.is_empty())
                        {
                            line.push_str(&format!(" — {note}"));
                        }

                        lines.push(line);
                    }

                    // A standing names the faction, the place held there, and the
                    // chapter it began in, in the author's own words.
                    for standing in own_standings {
                        let faction = standing
                            .faction_node_id
                            .as_deref()
                            .and_then(|id| node_names.get(id))
                            .map(|label| label.to_string())
                            .unwrap_or_else(|| "a faction no longer on the board".to_string());
                        let mut line = format!("- **{faction}** — {}", standing.standing);

                        if let Some(since) = standing
                            .since_chapter_id
                            .as_deref()
                            .and_then(|id| node_names.get(id))
                        {
                            line.push_str(&format!(" (since \"{since}\")"));
                        }

                        if let Some(until) = standing
                            .until_chapter_id
                            .as_deref()
                            .and_then(|id| node_names.get(id))
                        {
                            line.push_str(&format!(" (until \"{until}\")"));
                        }

                        if let Some(note) = standing
                            .note
                            .as_deref()
                            .map(str::trim)
                            .filter(|note| !note.is_empty())
                        {
                            line.push_str(&format!(" — {note}"));
                        }

                        lines.push(line);
                    }

                    // Currency reads as a plain ledger line: the amount, then the
                    // name the author gave it. No conversion is implied.
                    for currency in own_currency {
                        lines.push(format!("- {} {}", grouped(currency.amount), currency.name));
                    }

                    // An item names its rarity and effect when it has them, and the
                    // chapter it was acquired in by that chapter's title.
                    for item in own_items {
                        let mut line = format!("- **{}**", item.name);

                        if item.quantity != 1 {
                            line.push_str(&format!(" ×{}", grouped(item.quantity)));
                        }

                        if let Some(rarity) = item
                            .rarity
                            .as_deref()
                            .map(str::trim)
                            .filter(|rarity| !rarity.is_empty())
                        {
                            line.push_str(&format!(" · {rarity}"));
                        }

                        if let Some(effect) = item
                            .effect
                            .as_deref()
                            .map(str::trim)
                            .filter(|effect| !effect.is_empty())
                        {
                            line.push_str(&format!(" — {effect}"));
                        }

                        let acquired = item.chapter_id.as_deref().and_then(|id| node_names.get(id));
                        let lost = item
                            .lost_chapter_id
                            .as_deref()
                            .and_then(|id| node_names.get(id));

                        match (acquired, lost) {
                            (Some(acquired), Some(lost)) => line.push_str(&format!(
                                " (acquired in \"{acquired}\"; lost in \"{lost}\")"
                            )),
                            (Some(acquired), None) => {
                                line.push_str(&format!(" (acquired in \"{acquired}\")"))
                            }
                            (None, Some(lost)) => line.push_str(&format!(" (lost in \"{lost}\")")),
                            (None, None) => {}
                        }

                        lines.push(line);
                    }
                }
            }
        }

        // Character cards are left out on purpose: the cast section already
        // carries their sheet, and repeating the card would say it twice.
        let mut others: Vec<&Node> = nodes
            .iter()
            .filter(|node| node.node_type != "chapter" && node.node_type != "character")
            .collect();
        others.sort_by(|left, right| {
            left.node_type
                .cmp(&right.node_type)
                .then_with(|| left.label.to_lowercase().cmp(&right.label.to_lowercase()))
        });

        if !others.is_empty() {
            lines.push(String::new());
            lines.push("## Other cards".to_string());

            for node in others {
                lines.push(String::new());
                lines.push(format!("### {}", node.label));
                lines.push(String::new());
                lines.push(format!("*{}*", node.node_type));

                if let Some(notes) = node
                    .content
                    .as_deref()
                    .map(str::trim)
                    .filter(|notes| !notes.is_empty())
                {
                    lines.push(String::new());
                    lines.push(notes.to_string());
                }
            }
        }

        Ok(StoryBible {
            title: story.title,
            markdown: format!("{}\n", lines.join("\n")),
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

        // A chapter's notes go with it, under the same timestamp, so restoring
        // the chapter can bring them back and a purge takes them too.
        let notes = {
            let mut stmt = tx.prepare(
                "SELECT id, label FROM nodes
                 WHERE parent_node_id = ?1 AND deleted_at IS NULL",
            )?;
            let rows = stmt.query_map(params![id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        for (note_id, note_label) in notes {
            tx.execute(
                "UPDATE nodes SET deleted_at = ?2 WHERE id = ?1",
                params![&note_id, &timestamp],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "node",
                    entity_id: &note_id,
                    action: "soft_delete",
                    field_changed: None,
                    old_value: Some(note_label),
                    new_value: None,
                    changed_by: &user,
                },
            )?;
        }

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
                "SELECT id, story_id, name, description, level, xp, rank, xp_to_next,
                        created_at, updated_at
                 FROM characters WHERE id = ?1",
                params![id],
                |row| {
                    Ok(Character {
                        id: row.get(0)?,
                        story_id: row.get(1)?,
                        name: row.get(2)?,
                        description: row.get(3)?,
                        level: row.get(4)?,
                        xp: row.get(5)?,
                        rank: row.get(6)?,
                        xp_to_next: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
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

    /// Saves progression as its own fields, recording each one that changed.
    ///
    /// Nothing is derived: the level, the XP and the target are whatever the
    /// author typed, and a level is never implied by the XP total.
    pub fn set_character_progress(
        &self,
        id: &str,
        level: i64,
        xp: i64,
        rank: Option<String>,
        xp_to_next: Option<i64>,
        user: String,
    ) -> DbResult<Character> {
        if level < 1 {
            return Err(DbError::Invalid("a level starts at 1".to_string()));
        }

        if xp < 0 {
            return Err(DbError::Invalid(
                "experience cannot be negative".to_string(),
            ));
        }

        if xp_to_next.is_some_and(|target| target < 1) {
            return Err(DbError::Invalid(
                "the next level needs a positive XP target".to_string(),
            ));
        }

        let timestamp = now();
        let rank = rank
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT id, story_id, name, description, level, xp, rank, xp_to_next,
                        created_at, updated_at
                 FROM characters WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |row| {
                    Ok(Character {
                        id: row.get(0)?,
                        story_id: row.get(1)?,
                        name: row.get(2)?,
                        description: row.get(3)?,
                        level: row.get(4)?,
                        xp: row.get(5)?,
                        rank: row.get(6)?,
                        xp_to_next: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("character"))?;

        let level_changed = existing.level != level;
        let xp_changed = existing.xp != xp;
        let rank_changed = existing.rank != rank;
        let target_changed = existing.xp_to_next != xp_to_next;

        if !level_changed && !xp_changed && !rank_changed && !target_changed {
            return Ok(existing);
        }

        tx.execute(
            "UPDATE characters SET level = ?1, xp = ?2, rank = ?3, xp_to_next = ?4,
                    updated_at = ?5
             WHERE id = ?6",
            params![level, xp, &rank, xp_to_next, &timestamp, id],
        )?;

        // One entry per field, including a rank or target being cleared, which
        // is a change with no value on one side.
        let old_target = existing.xp_to_next.map(|value| value.to_string());
        let new_target = xp_to_next.map(|value| value.to_string());
        let old_level = existing.level.to_string();
        let new_level = level.to_string();
        let old_xp = existing.xp.to_string();
        let new_xp = xp.to_string();

        if level_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "character",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("level"),
                    old_value: Some(old_level.clone()),
                    new_value: Some(new_level.clone()),
                    changed_by: &user,
                },
            )?;
        }

        if xp_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "character",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("xp"),
                    old_value: Some(old_xp.clone()),
                    new_value: Some(new_xp.clone()),
                    changed_by: &user,
                },
            )?;
        }

        if rank_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "character",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("rank"),
                    old_value: existing.rank.clone(),
                    new_value: rank.clone(),
                    changed_by: &user,
                },
            )?;
        }

        if target_changed {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&existing.story_id),
                    entity_type: "character",
                    entity_id: id,
                    action: "update",
                    field_changed: Some("xp_to_next"),
                    old_value: old_target.clone(),
                    new_value: new_target.clone(),
                    changed_by: &user,
                },
            )?;
        }

        tx.commit()?;

        Ok(Character {
            level,
            xp,
            rank,
            xp_to_next,
            updated_at: timestamp,
            ..existing
        })
    }

    /// Adds one level and records it as a level-up event rather than an ordinary
    /// edit, so the history can say what actually happened.
    pub fn level_up_character(&self, id: &str, user: String) -> DbResult<Character> {
        let timestamp = now();

        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let existing = tx
            .query_row(
                "SELECT id, story_id, name, description, level, xp, rank, xp_to_next,
                        created_at, updated_at
                 FROM characters WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |row| {
                    Ok(Character {
                        id: row.get(0)?,
                        story_id: row.get(1)?,
                        name: row.get(2)?,
                        description: row.get(3)?,
                        level: row.get(4)?,
                        xp: row.get(5)?,
                        rank: row.get(6)?,
                        xp_to_next: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                },
            )
            .optional()?
            .ok_or(DbError::NotFound("character"))?;

        let next = existing.level + 1;
        let old_level = existing.level.to_string();
        let new_level = next.to_string();

        tx.execute(
            "UPDATE characters SET level = ?1, updated_at = ?2 WHERE id = ?3",
            params![next, &timestamp, id],
        )?;

        log_audit(
            &tx,
            AuditRecord {
                story_id: Some(&existing.story_id),
                entity_type: "character",
                entity_id: id,
                action: "level_up",
                field_changed: Some("level"),
                old_value: Some(old_level),
                new_value: Some(new_level),
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(Character {
            level: next,
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
                "SELECT story_id, label, deleted_at, node_type, parent_node_id FROM nodes
                  WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()?;

        let Some((story_id, label, timestamp, node_type, parent_node_id)) = existing else {
            return Ok(());
        };

        // A note belongs to a chapter, so it cannot come back before the chapter
        // does: that would leave it live with nowhere to be shown.
        if node_type == "note" {
            let chapter_state = match parent_node_id {
                Some(chapter_id) => tx
                    .query_row(
                        "SELECT deleted_at FROM nodes WHERE id = ?1",
                        params![&chapter_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()?,
                None => None,
            };

            match chapter_state {
                Some(None) => {}
                Some(Some(_)) => {
                    return Err(DbError::Invalid(
                        "restore the chapter before its notes".to_string(),
                    ))
                }
                None => {
                    return Err(DbError::Invalid(
                        "that note's chapter is no longer there".to_string(),
                    ))
                }
            }
        }

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

        // The notes the chapter took with it come back with it. A note trashed on
        // its own carries a different timestamp and stays where it is.
        let notes = {
            let mut stmt = tx.prepare(
                "SELECT id, label FROM nodes
                 WHERE parent_node_id = ?1 AND deleted_at = ?2",
            )?;
            let rows = stmt.query_map(params![id, &timestamp], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<SqliteResult<Vec<_>>>()?
        };

        for (note_id, note_label) in notes {
            tx.execute(
                "UPDATE nodes SET deleted_at = NULL WHERE id = ?1",
                params![&note_id],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "node",
                    entity_id: &note_id,
                    action: "restore",
                    field_changed: None,
                    old_value: Some(note_label),
                    new_value: None,
                    changed_by: &user,
                },
            )?;
        }

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

        // A link to a row that is about to stop existing has nothing left to point
        // at, so it goes with the character, and each node's history says the link
        // was removed. Trashing one keeps its links: a restore brings them back.
        let linked = {
            let mut stmt = tx.prepare("SELECT id FROM nodes WHERE character_id = ?1")?;
            let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0))?;
            rows.collect::<SqliteResult<Vec<String>>>()?
        };

        for node_id in linked {
            tx.execute(
                "UPDATE nodes SET character_id = NULL WHERE id = ?1",
                params![&node_id],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "node",
                    entity_id: &node_id,
                    action: "update",
                    field_changed: Some("character"),
                    old_value: Some(name.clone()),
                    new_value: None,
                    changed_by: &user,
                },
            )?;
        }

        // A chapter's point of view points at the same row, so it goes the same
        // way; trashing the member keeps it, and restoring brings it back.
        let narrated = {
            let mut stmt = tx.prepare("SELECT id FROM nodes WHERE chapter_pov = ?1")?;
            let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0))?;
            rows.collect::<SqliteResult<Vec<String>>>()?
        };

        for node_id in narrated {
            tx.execute(
                "UPDATE nodes SET chapter_pov = NULL WHERE id = ?1",
                params![&node_id],
            )?;

            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&story_id),
                    entity_type: "node",
                    entity_id: &node_id,
                    action: "update",
                    field_changed: Some("chapter_pov"),
                    old_value: Some(name.clone()),
                    new_value: None,
                    changed_by: &user,
                },
            )?;
        }

        // A payout aimed at this character keeps its amount and kind but loses
        // the person it was meant for, the way a faction link does when its card
        // is purged.
        let rewarded = {
            let mut stmt = tx.prepare(
                "SELECT id FROM quest_rewards
                  WHERE target_id = ?1 AND reward_type != 'faction_standing'",
            )?;
            let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0))?;
            rows.collect::<SqliteResult<Vec<String>>>()?
        };

        for reward_id in rewarded {
            tx.execute(
                "UPDATE quest_rewards SET target_id = NULL WHERE id = ?1",
                params![&reward_id],
            )?;
        }

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

        // A standing paid through this card loses the card but keeps its wording,
        // the way a faction link does. Quest and chapter links are foreign keys,
        // so the database clears or cascades them with the node.
        let paid_through_card = {
            let mut stmt = tx.prepare(
                "SELECT id FROM quest_rewards
                  WHERE target_id = ?1 AND reward_type = 'faction_standing'",
            )?;
            let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0))?;
            rows.collect::<SqliteResult<Vec<String>>>()?
        };

        for reward_id in paid_through_card {
            tx.execute(
                "UPDATE quest_rewards SET target_id = NULL WHERE id = ?1",
                params![&reward_id],
            )?;
        }

        // The chapter is gone, so its notes go with it rather than lingering in
        // the trash with nothing left to attach to.
        tx.execute("DELETE FROM nodes WHERE parent_node_id = ?1", params![id])?;
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

    // ===== SETTINGS =====

    /// How long items stay in the trash. `None` means forever, which is the
    /// default: an upgrade must never start deleting anything on its own.
    pub fn trash_retention_days(&self) -> DbResult<Option<i64>> {
        let guard = self.conn()?;
        let stored: Option<String> = guard
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![TRASH_RETENTION_KEY],
                |row| row.get(0),
            )
            .optional()?;

        Ok(stored
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|days| *days > 0))
    }

    /// Sets the retention window, or turns it off again with `None`.
    pub fn set_trash_retention_days(&self, days: Option<i64>) -> DbResult<()> {
        if let Some(days) = days {
            if !(1..=MAX_RETENTION_DAYS).contains(&days) {
                return Err(DbError::Invalid(format!(
                    "a retention window has to be between 1 and {MAX_RETENTION_DAYS} days"
                )));
            }
        }

        let guard = self.conn()?;

        match days {
            Some(days) => {
                guard.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![TRASH_RETENTION_KEY, days.to_string()],
                )?;
            }
            None => {
                guard.execute(
                    "DELETE FROM settings WHERE key = ?1",
                    params![TRASH_RETENTION_KEY],
                )?;
            }
        }

        Ok(())
    }

    /// Removes everything that has been in the trash for longer than `days`.
    ///
    /// This is the only deletion the app performs without being asked for that
    /// exact row, so it records itself: each item it removes gets a `purge` entry
    /// attributed to `Trash retention`. Returns how many items went.
    pub fn purge_expired(&self, days: i64) -> DbResult<usize> {
        if days < 1 {
            return Err(DbError::Invalid(
                "a retention window needs at least one day".to_string(),
            ));
        }

        let cutoff = (Utc::now() - chrono::Duration::days(days)).to_rfc3339();
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let mut purged = 0;

        // Children before stories: deleting a story cascades, and a row already
        // taken out by that cascade could not have its own removal recorded.
        let children = [
            (
                "characters",
                "character",
                "SELECT id, story_id, name FROM characters
                  WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            ),
            (
                "nodes",
                "node",
                "SELECT id, story_id, label FROM nodes
                  WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            ),
            (
                "edges",
                "edge",
                "SELECT id, story_id, COALESCE(label, relation_type, 'connection')
                   FROM edges
                  WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            ),
        ];

        for (table, entity_type, sql) in children {
            for (id, story_id, label) in expired_rows(&tx, sql, &cutoff)? {
                log_audit(
                    &tx,
                    AuditRecord {
                        story_id: Some(&story_id),
                        entity_type,
                        entity_id: &id,
                        action: "purge",
                        field_changed: None,
                        old_value: Some(label),
                        new_value: None,
                        changed_by: RETENTION_ACTOR,
                    },
                )?;

                // `table` is one of our own literals, never user input.
                tx.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![&id])?;
                purged += 1;
            }
        }

        let stories = expired_rows(
            &tx,
            "SELECT id, id, title FROM stories
              WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            &cutoff,
        )?;

        for (id, _, title) in stories {
            log_audit(
                &tx,
                AuditRecord {
                    story_id: Some(&id),
                    entity_type: "story",
                    entity_id: &id,
                    action: "purge",
                    field_changed: None,
                    old_value: Some(title),
                    new_value: None,
                    changed_by: RETENTION_ACTOR,
                },
            )?;

            tx.execute("DELETE FROM stories WHERE id = ?1", params![&id])?;
            purged += 1;
        }

        tx.commit()?;

        Ok(purged)
    }

    // ===== UNDOING AN EDIT =====

    /// Puts one field back to the value a history entry recorded before it changed.
    ///
    /// The entry's own `new_value` is the guard: the revert only happens while the
    /// field still holds it. If the field changed again since, writing the older
    /// value would discard the newer edit without saying so, so the request is
    /// refused and the caller is told what the field reads now.
    ///
    /// A revert is recorded as a `revert` entry holding the value it replaced, which
    /// makes it a change like any other: it shows up in the history and can itself
    /// be reverted. Returns whether anything was written — a field that already
    /// holds the earlier value is left alone and records nothing.
    pub fn revert_change(&self, entry_id: &str, user: String) -> DbResult<bool> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;

        let entry = tx
            .query_row(
                "SELECT id, entity_type, entity_id, action, field_changed, old_value, new_value, changed_by, changed_at, story_id
                 FROM audit_log WHERE id = ?1",
                params![entry_id],
                audit_row,
            )
            .optional()?
            .ok_or(DbError::NotFound("history entry"))?;

        // The same check the Audit tab reads its button state from, so a button
        // that looks available cannot then be refused, or the other way round.
        let target = match check_revert(&tx, &entry)? {
            RevertCheck::Ready { target } => target,
            RevertCheck::Unchanged => return Ok(false),
            RevertCheck::Nothing { reason } | RevertCheck::Blocked { reason, .. } => {
                return Err(DbError::Invalid(reason))
            }
        };

        let RevertTarget {
            spec,
            restore,
            current,
        } = target;
        let entity_id = &entry.entity_id;
        let field = entry.field_changed.clone().unwrap_or_default();
        let timestamp = now();

        // A symmetric relation is stored with its ids in a fixed order. Putting
        // the kind back has to put that order back too, or the pair would only
        // look the same until someone tried to add the same bond again.
        if entry.entity_type == "character_relation" && field == "kind" {
            if let Some(kind) = entry.old_value.as_deref() {
                let pair = tx
                    .query_row(
                        "SELECT from_character_id, to_character_id FROM character_relations WHERE id = ?1",
                        params![entity_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .optional()?;

                if let Some((from, to)) = pair {
                    let (from, to) = relation_ends(&from, &to, kind);

                    tx.execute(
                        "UPDATE character_relations
                            SET from_character_id = ?1, to_character_id = ?2
                          WHERE id = ?3",
                        params![&from, &to, entity_id],
                    )?;
                }
            }
        }

        match spec.kind {
            RevertKind::Text => {
                if spec.touched {
                    tx.execute(
                        &format!(
                            "UPDATE {} SET {} = ?1, updated_at = ?2 WHERE id = ?3",
                            spec.table, spec.column
                        ),
                        params![restore, &timestamp, entity_id],
                    )?;
                } else {
                    tx.execute(
                        &format!(
                            "UPDATE {} SET {} = ?1 WHERE id = ?2",
                            spec.table, spec.column
                        ),
                        params![restore, entity_id],
                    )?;
                }
            }
            RevertKind::Number => {
                let value = match restore.as_deref() {
                    Some(text) => Some(text.parse::<i64>().ok().ok_or_else(|| {
                        DbError::Invalid("that entry did not record a whole number".to_string())
                    })?),
                    None if spec.nullable => None,
                    None => {
                        return Err(DbError::Invalid(
                            "that entry did not record a whole number".to_string(),
                        ))
                    }
                };

                tx.execute(
                    &format!(
                        "UPDATE {} SET {} = ?1, updated_at = ?2 WHERE id = ?3",
                        spec.table, spec.column
                    ),
                    params![value, &timestamp, entity_id],
                )?;
            }
            RevertKind::Point => {
                let (x, y) = parse_point(restore.as_deref()).ok_or_else(|| {
                    DbError::Invalid("that entry did not record a position".to_string())
                })?;

                let pair = spec.pair.unwrap_or("pos_y");

                tx.execute(
                    &format!(
                        "UPDATE {} SET {} = ?1, {} = ?2, updated_at = ?3 WHERE id = ?4",
                        spec.table, spec.column, pair
                    ),
                    params![x, y, &timestamp, entity_id],
                )?;
            }
        }

        // Reverting one holder's words puts the shared definition and every other
        // holder back too, and follows through to the card when one is attached.
        // The revert entry above remains the history of the action itself.
        if entry.entity_type == "character_skill" && (field == "name" || field == "effect") {
            let holder = tx
                .query_row(
                    "SELECT skill_id, node_id FROM character_skills WHERE id = ?1",
                    params![entity_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .optional()?;

            if let Some((Some(skill_id), node_id)) = holder {
                let restored = restore.clone();

                if field == "name" {
                    if let Some(value) = restored.as_deref() {
                        tx.execute(
                            "UPDATE skill_definitions SET name = ?1, updated_at = ?2 WHERE id = ?3",
                            params![value, &timestamp, &skill_id],
                        )?;
                        tx.execute(
                            "UPDATE character_skills SET name = ?1, updated_at = ?2 WHERE skill_id = ?3",
                            params![value, &timestamp, &skill_id],
                        )?;
                        if let Some(card) = node_id.as_deref() {
                            tx.execute(
                                "UPDATE nodes SET label = ?1, updated_at = ?2 WHERE id = ?3",
                                params![value, &timestamp, card],
                            )?;
                        }
                    }
                } else {
                    tx.execute(
                        "UPDATE skill_definitions SET description = ?1, updated_at = ?2 WHERE id = ?3",
                        params![&restored, &timestamp, &skill_id],
                    )?;
                    tx.execute(
                        "UPDATE character_skills SET effect = ?1, updated_at = ?2 WHERE skill_id = ?3",
                        params![&restored, &timestamp, &skill_id],
                    )?;
                    if let Some(card) = node_id.as_deref() {
                        tx.execute(
                            "UPDATE nodes SET content = ?1, updated_at = ?2 WHERE id = ?3",
                            params![&restored, &timestamp, card],
                        )?;
                    }
                }
            }
        }

        // Reverting a skill card's label or notes is still a card change: the
        // linked sheets follow it through the same helper a normal save uses.
        if entry.entity_type == "node" && (field == "label" || field == "content") {
            let node = tx
                .query_row(
                    "SELECT story_id, node_type, label, content FROM nodes WHERE id = ?1",
                    params![entity_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .optional()?;

            if let Some((story_id, node_type, label, content)) = node {
                if node_type == "skill" {
                    sync_skill_card_holders(
                        &tx,
                        &story_id,
                        entity_id,
                        &label,
                        content.as_deref(),
                        field == "label",
                        field == "content",
                        &user,
                        &timestamp,
                    )?;
                }
            }
        }

        log_audit(
            &tx,
            AuditRecord {
                story_id: entry.story_id.as_deref(),
                entity_type: &entry.entity_type,
                entity_id,
                action: "revert",
                field_changed: Some(field.as_str()),
                old_value: current,
                new_value: restore,
                changed_by: &user,
            },
        )?;

        tx.commit()?;

        Ok(true)
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
        let skills: HashMap<String, String> = export
            .character_skills
            .iter()
            .map(|skill| (skill.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let definitions: HashMap<String, String> = export
            .skill_definitions
            .iter()
            .map(|definition| (definition.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let level_milestones: HashMap<String, String> = export
            .character_level_milestones
            .iter()
            .map(|milestone| (milestone.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let skill_events: HashMap<String, String> = export
            .character_skill_events
            .iter()
            .map(|event| (event.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let evolution_ids: HashMap<String, String> = export
            .skill_evolutions
            .iter()
            .map(|evolution| (evolution.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let character_progress: HashMap<String, String> = export
            .character_progress
            .iter()
            .map(|entry| (entry.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let chapter_cast: HashMap<String, String> = export
            .chapter_cast
            .iter()
            .map(|member| (member.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let inventory: HashMap<String, String> = export
            .character_inventory
            .iter()
            .map(|item| (item.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let currencies: HashMap<String, String> = export
            .character_currency
            .iter()
            .map(|currency| (currency.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let relations: HashMap<String, String> = export
            .character_relations
            .iter()
            .map(|relation| (relation.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let standings: HashMap<String, String> = export
            .faction_standings
            .iter()
            .map(|standing| (standing.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let quest_ids: HashMap<String, String> = export
            .quests
            .iter()
            .map(|quest| (quest.id.clone(), Uuid::new_v4().to_string()))
            .collect();
        let reward_ids: HashMap<String, String> = export
            .quests
            .iter()
            .flat_map(|quest| quest.rewards.iter())
            .map(|reward| (reward.id.clone(), Uuid::new_v4().to_string()))
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

        for skill in &export.character_skills {
            if !characters.contains_key(&skill.character_id) {
                return Err(DbError::Invalid(format!(
                    "the skill '{}' belongs to a character the file does not contain",
                    skill.name
                )));
            }

            for (reference, what) in [
                (skill.chapter_id.as_ref(), "chapter"),
                (skill.node_id.as_ref(), "skill card"),
            ] {
                if reference.is_some_and(|id| !nodes.contains_key(id)) {
                    return Err(DbError::Invalid(format!(
                        "the skill '{}' points at a {what} the file does not contain",
                        skill.name
                    )));
                }
            }
        }

        for definition in &export.skill_definitions {
            if definition.story_id != export.story.id {
                return Err(DbError::Invalid(
                    "a skill definition belongs to another story".to_string(),
                ));
            }

            if definition.name.trim().is_empty() {
                return Err(DbError::Invalid(
                    "a skill definition needs a name".to_string(),
                ));
            }

            // A definition whose card was trashed before the export is kept by
            // its words; the missing card link is simply dropped on import.
        }

        for milestone in &export.character_level_milestones {
            if !characters.contains_key(&milestone.character_id) {
                return Err(DbError::Invalid(
                    "a level milestone belongs to a character the file does not contain"
                        .to_string(),
                ));
            }

            if milestone.level < 1 {
                return Err(DbError::Invalid(
                    "a level milestone must be level 1 or higher".to_string(),
                ));
            }

            clean_level_xp(milestone.xp)?;
            imported_level_stat_changes(milestone)?;

            if milestone
                .chapter_id
                .as_ref()
                .is_some_and(|id| !nodes.contains_key(id))
            {
                return Err(DbError::Invalid(
                    "a level milestone points at a chapter the file does not contain".to_string(),
                ));
            }
        }

        for entry in &export.character_progress {
            if !characters.contains_key(&entry.character_id) {
                return Err(DbError::Invalid(
                    "an XP ledger row belongs to a character the file does not contain".to_string(),
                ));
            }

            if !nodes.contains_key(&entry.chapter_id) {
                return Err(DbError::Invalid(
                    "an XP ledger row points at a chapter the file does not contain".to_string(),
                ));
            }

            if entry.xp_earned < 0 {
                return Err(DbError::Invalid(
                    "experience earned cannot be negative".to_string(),
                ));
            }
        }

        for event in &export.character_skill_events {
            if !skills.contains_key(&event.skill_id) {
                return Err(DbError::Invalid(
                    "a skill event belongs to a skill the file does not contain".to_string(),
                ));
            }

            clean_skill_event_kind(&event.kind)?;

            if event
                .chapter_id
                .as_ref()
                .is_some_and(|id| !nodes.contains_key(id))
            {
                return Err(DbError::Invalid(
                    "a skill event points at a chapter the file does not contain".to_string(),
                ));
            }

            if let Some(milestone_id) = &event.milestone_id {
                let skill = export
                    .character_skills
                    .iter()
                    .find(|skill| &skill.id == &event.skill_id)
                    .expect("the skill was checked above");
                let milestone = export
                    .character_level_milestones
                    .iter()
                    .find(|milestone| &milestone.id == milestone_id)
                    .ok_or_else(|| {
                        DbError::Invalid(
                            "a skill event points at a level-up the file does not contain"
                                .to_string(),
                        )
                    })?;

                if milestone.character_id != skill.character_id {
                    return Err(DbError::Invalid(
                        "a skill event links to a level-up of another character".to_string(),
                    ));
                }

                if let (Some(event_chapter), Some(milestone_chapter)) =
                    (&event.chapter_id, &milestone.chapter_id)
                {
                    if event_chapter != milestone_chapter {
                        return Err(DbError::Invalid(
                            "a skill event and its level-up are in different chapters".to_string(),
                        ));
                    }
                }
            }
        }

        let evolution_links: Vec<(String, String)> = export
            .skill_evolutions
            .iter()
            .map(|evolution| {
                (
                    evolution.parent_skill_id.clone(),
                    evolution.child_skill_id.clone(),
                )
            })
            .collect();

        if evolution_links_have_cycle(&evolution_links) {
            return Err(DbError::Invalid(
                "the file's skill evolutions loop back on themselves".to_string(),
            ));
        }

        for evolution in &export.skill_evolutions {
            if evolution.parent_skill_id == evolution.child_skill_id {
                return Err(DbError::Invalid(
                    "a skill cannot evolve into itself".to_string(),
                ));
            }

            if !skills.contains_key(&evolution.parent_skill_id)
                || !skills.contains_key(&evolution.child_skill_id)
            {
                return Err(DbError::Invalid(
                    "a skill evolution points at a skill the file does not contain".to_string(),
                ));
            }

            clean_evolution_type(&evolution.evolution_type)?;

            if evolution
                .chapter_id
                .as_ref()
                .is_some_and(|id| !nodes.contains_key(id))
            {
                return Err(DbError::Invalid(
                    "a skill evolution points at a chapter the file does not contain".to_string(),
                ));
            }
        }

        for item in &export.character_inventory {
            if !characters.contains_key(&item.character_id) {
                return Err(DbError::Invalid(format!(
                    "the item '{}' belongs to a character the file does not contain",
                    item.name
                )));
            }

            for (reference, what) in [
                (item.chapter_id.as_ref(), "chapter"),
                (item.lost_chapter_id.as_ref(), "chapter"),
                (item.node_id.as_ref(), "item card"),
            ] {
                if reference.is_some_and(|id| !nodes.contains_key(id)) {
                    return Err(DbError::Invalid(format!(
                        "the item '{}' points at a {what} the file does not contain",
                        item.name
                    )));
                }
            }
        }

        let mut cast_pairs = std::collections::HashSet::new();

        for member in &export.chapter_cast {
            if !characters.contains_key(&member.character_id) {
                return Err(DbError::Invalid(
                    "a chapter cast member belongs to a character the file does not contain"
                        .to_string(),
                ));
            }

            let chapter = export
                .nodes
                .iter()
                .find(|node| node.id == member.chapter_id);

            match chapter {
                Some(node) if node.node_type == "chapter" => {}
                Some(_) => {
                    return Err(DbError::Invalid(
                        "a chapter cast member points at something that is not a chapter"
                            .to_string(),
                    ))
                }
                None => {
                    return Err(DbError::Invalid(
                        "a chapter cast member points at a chapter the file does not contain"
                            .to_string(),
                    ))
                }
            }

            if !cast_pairs.insert((&member.chapter_id, &member.character_id)) {
                return Err(DbError::Invalid(
                    "a character is listed in the same chapter's cast more than once".to_string(),
                ));
            }
        }

        let mut relation_pairs: std::collections::HashSet<(String, String, String)> =
            std::collections::HashSet::new();

        for relation in &export.character_relations {
            for id in [&relation.from_character_id, &relation.to_character_id] {
                if !characters.contains_key(id) {
                    return Err(DbError::Invalid(
                        "a relation names a character the file does not contain".to_string(),
                    ));
                }
            }

            if relation.from_character_id == relation.to_character_id {
                return Err(DbError::Invalid(
                    "a relation cannot join a character to themselves".to_string(),
                ));
            }

            if relation.kind.trim().is_empty() {
                return Err(DbError::Invalid("a relation needs a kind".to_string()));
            }

            for reference in [&relation.since_chapter_id, &relation.until_chapter_id] {
                if reference.as_ref().is_some_and(|id| !nodes.contains_key(id)) {
                    return Err(DbError::Invalid(
                        "a relation points at a chapter the file does not contain".to_string(),
                    ));
                }
            }

            let pair = (
                relation.from_character_id.clone(),
                relation.to_character_id.clone(),
                relation.kind.to_lowercase(),
            );

            if !relation_pairs.insert(pair) {
                return Err(DbError::Invalid(
                    "the same relation is recorded twice in the file".to_string(),
                ));
            }
        }

        for standing in &export.faction_standings {
            if !characters.contains_key(&standing.character_id) {
                return Err(DbError::Invalid(
                    "a faction standing belongs to a character the file does not contain"
                        .to_string(),
                ));
            }

            if standing.standing.trim().is_empty() {
                return Err(DbError::Invalid(
                    "a faction standing needs a word for it".to_string(),
                ));
            }

            let Some(since) = standing.since_chapter_id.as_ref() else {
                return Err(DbError::Invalid(
                    "a faction standing needs the chapter it began in".to_string(),
                ));
            };

            if !nodes.contains_key(since)
                || standing
                    .until_chapter_id
                    .as_ref()
                    .is_some_and(|id| !nodes.contains_key(id))
            {
                return Err(DbError::Invalid(
                    "a faction standing points at a chapter the file does not contain".to_string(),
                ));
            }

            if let Some(faction) = standing.faction_node_id.as_ref() {
                match export.nodes.iter().find(|node| &node.id == faction) {
                    Some(node) if node.node_type == "faction" => {}
                    Some(_) => {
                        return Err(DbError::Invalid(
                            "a faction standing points at a card that is not a faction".to_string(),
                        ))
                    }
                    None => {
                        return Err(DbError::Invalid(
                            "a faction standing points at a card the file does not contain"
                                .to_string(),
                        ))
                    }
                }
            }
        }

        // A quest's two chapters, its giver, its faction card and its rewards all
        // have to be present in the same file, or the copy would point at rows the
        // source story owns.
        for quest in &export.quests {
            if quest.title.trim().is_empty() {
                return Err(DbError::Invalid(
                    "a quest in the file has no title".to_string(),
                ));
            }

            if quest.status.trim().is_empty() {
                return Err(DbError::Invalid(format!(
                    "the quest '{}' has no status",
                    quest.title
                )));
            }

            let accepted = quest.accepted_chapter_id.as_ref().ok_or_else(|| {
                DbError::Invalid(format!(
                    "the quest '{}' has no chapter it was accepted in",
                    quest.title
                ))
            })?;

            let chapter_type = |id: &String| {
                export
                    .nodes
                    .iter()
                    .find(|node| &node.id == id)
                    .map(|node| node.node_type.as_str())
            };

            if chapter_type(accepted) != Some("chapter")
                || quest
                    .completed_chapter_id
                    .as_ref()
                    .is_some_and(|id| chapter_type(id) != Some("chapter"))
            {
                return Err(DbError::Invalid(format!(
                    "the quest '{}' points at a chapter the file does not contain",
                    quest.title
                )));
            }

            if quest
                .giver_character_id
                .as_ref()
                .is_some_and(|id| !characters.contains_key(id))
            {
                return Err(DbError::Invalid(format!(
                    "the quest '{}' is given by a character the file does not contain",
                    quest.title
                )));
            }

            if let Some(faction) = quest.faction_node_id.as_ref() {
                match export.nodes.iter().find(|node| &node.id == faction) {
                    Some(node) if node.node_type == "faction" => {}
                    Some(_) => {
                        return Err(DbError::Invalid(format!(
                            "the quest '{}' is issued by a card that is not a faction",
                            quest.title
                        )))
                    }
                    None => {
                        return Err(DbError::Invalid(format!(
                            "the quest '{}' is issued by a card the file does not contain",
                            quest.title
                        )))
                    }
                }
            }

            for reward in &quest.rewards {
                if clean_reward_type(reward.reward_type.clone()).is_err() {
                    return Err(DbError::Invalid(format!(
                        "the quest '{}' has a reward that is not xp, item, stat or faction_standing",
                        quest.title
                    )));
                }

                match reward.target_id.as_ref() {
                    None => {}
                    Some(target) if reward.reward_type == "faction_standing" => {
                        match export.nodes.iter().find(|node| &node.id == target) {
                            Some(node) if node.node_type == "faction" => {}
                            Some(_) => {
                                return Err(DbError::Invalid(format!(
                                    "the quest '{}' pays a standing on a card that is not a faction",
                                    quest.title
                                )))
                            }
                            None => {
                                return Err(DbError::Invalid(format!(
                                    "the quest '{}' pays a standing on a card the file does not contain",
                                    quest.title
                                )))
                            }
                        }
                    }
                    Some(target) if !characters.contains_key(target) => {
                        return Err(DbError::Invalid(format!(
                            "the quest '{}' rewards a character the file does not contain",
                            quest.title
                        )))
                    }
                    Some(_) => {}
                }
            }
        }

        for currency in &export.character_currency {
            if !characters.contains_key(&currency.character_id) {
                return Err(DbError::Invalid(format!(
                    "the currency '{}' belongs to a character the file does not contain",
                    currency.name
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

        // A note is shown under its chapter, so a file that lost the chapter
        // cannot be restored as it was.
        for node in export
            .nodes
            .iter()
            .filter(|node| node.parent_node_id.is_some())
        {
            let parent = node
                .parent_node_id
                .as_ref()
                .and_then(|id| export.nodes.iter().find(|other| &other.id == id));

            match parent {
                Some(parent) if parent.node_type == "chapter" => {}
                Some(_) => {
                    return Err(DbError::Invalid(
                        "a note points at something that is not a chapter".to_string(),
                    ))
                }
                None => {
                    return Err(DbError::Invalid(
                        "a note points at a chapter the file does not contain".to_string(),
                    ))
                }
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
                "INSERT INTO characters
                 (id, story_id, name, description, level, xp, rank, xp_to_next,
                  created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    &characters[&character.id],
                    &story_id,
                    &character.name,
                    &character.description,
                    character.level,
                    character.xp,
                    &character.rank,
                    character.xp_to_next,
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

        // An export written before chapters had a reading order has no numbers
        // to carry, so its chapters are numbered in the order the file lists
        // them rather than arriving unnumbered.
        let mut next_chapter_seq = export
            .nodes
            .iter()
            .filter_map(|node| node.chapter_seq)
            .max()
            .unwrap_or(0)
            + 1;

        for node in &export.nodes {
            let chapter_seq = match node.chapter_seq {
                Some(sequence) => Some(sequence),
                None if node.node_type == "chapter" => {
                    let sequence = next_chapter_seq;
                    next_chapter_seq += 1;
                    Some(sequence)
                }
                None => None,
            };

            tx.execute(
                "INSERT INTO nodes (id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at, character_id, chapter_seq,
                                    chapter_arc, chapter_words, chapter_target, chapter_pov, chapter_day, chapter_time, parent_node_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
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
                    &node.updated_at,
                    // The linked cast member gets a new id with the rest of the story,
                    // so the link has to be remapped or the copy would point at the
                    // source story's row.
                    node.character_id.as_ref().and_then(|id| characters.get(id)),
                    chapter_seq,
                    &node.chapter_arc,
                    node.chapter_words,
                    node.chapter_target,
                    // The point of view is a cast id, remapped like the node's own
                    // link so the copy does not point at the source story's row.
                    node.chapter_pov.as_ref().and_then(|id| characters.get(id)),
                    node.chapter_day,
                    &node.chapter_time,
                    // A note's chapter is remapped like every other node, so the
                    // copy holds together without pointing at the source story.
                    node.parent_node_id.as_ref().and_then(|id| nodes.get(id)).cloned(),
                ],
            )?;
        }

        // Definitions come after the cards they can point at, and before the
        // skills that are matched back to them below.
        for definition in &export.skill_definitions {
            tx.execute(
                "INSERT INTO skill_definitions
                 (id, story_id, name, description, node_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    &definitions[&definition.id],
                    &story_id,
                    definition.name.trim(),
                    &definition.description,
                    definition.node_id.as_ref().and_then(|id| nodes.get(id)),
                    &definition.created_at,
                    &definition.updated_at
                ],
            )?;
        }

        for member in &export.chapter_cast {
            tx.execute(
                "INSERT INTO chapter_cast
                 (id, chapter_id, character_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    &chapter_cast[&member.id],
                    &nodes[&member.chapter_id],
                    &characters[&member.character_id],
                    &member.created_at,
                    &member.updated_at
                ],
            )?;
        }

        // Relations and standings come after both the cast and the chapters they
        // name, because each link is a foreign key into the copy.
        for relation in &export.character_relations {
            tx.execute(
                "INSERT INTO character_relations
                 (id, story_id, from_character_id, to_character_id, kind, note,
                  since_chapter_id, until_chapter_id, created_by, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    &relations[&relation.id],
                    &story_id,
                    &characters[&relation.from_character_id],
                    &characters[&relation.to_character_id],
                    relation.kind.trim(),
                    &relation.note,
                    relation
                        .since_chapter_id
                        .as_ref()
                        .and_then(|id| nodes.get(id)),
                    relation
                        .until_chapter_id
                        .as_ref()
                        .and_then(|id| nodes.get(id)),
                    &relation.created_by,
                    &relation.created_at,
                    &relation.updated_at
                ],
            )?;
        }

        for standing in &export.faction_standings {
            tx.execute(
                "INSERT INTO faction_standings
                 (id, story_id, character_id, faction_node_id, standing, note,
                  since_chapter_id, until_chapter_id, created_by, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    &standings[&standing.id],
                    &story_id,
                    &characters[&standing.character_id],
                    standing
                        .faction_node_id
                        .as_ref()
                        .and_then(|id| nodes.get(id)),
                    standing.standing.trim(),
                    &standing.note,
                    standing
                        .since_chapter_id
                        .as_ref()
                        .and_then(|id| nodes.get(id)),
                    standing
                        .until_chapter_id
                        .as_ref()
                        .and_then(|id| nodes.get(id)),
                    &standing.created_by,
                    &standing.created_at,
                    &standing.updated_at
                ],
            )?;
        }

        // Quests come after the cast and chapters they name, and their rewards
        // after the quests, because each link is a foreign key into the copy.
        for quest in &export.quests {
            let Some(accepted) = quest
                .accepted_chapter_id
                .as_ref()
                .and_then(|id| nodes.get(id))
            else {
                // Validation already refused a quest with no acceptance chapter.
                continue;
            };

            tx.execute(
                "INSERT INTO quests
                 (id, story_id, title, giver_character_id, faction_node_id,
                  accepted_chapter_id, completed_chapter_id, status, description, notes,
                  created_by, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    &quest_ids[&quest.id],
                    &story_id,
                    quest.title.trim(),
                    quest
                        .giver_character_id
                        .as_ref()
                        .and_then(|id| characters.get(id)),
                    quest.faction_node_id.as_ref().and_then(|id| nodes.get(id)),
                    accepted,
                    quest
                        .completed_chapter_id
                        .as_ref()
                        .and_then(|id| nodes.get(id)),
                    quest.status.trim(),
                    &quest.description,
                    &quest.notes,
                    &quest.created_by,
                    &quest.created_at,
                    &quest.updated_at
                ],
            )?;

            for reward in &quest.rewards {
                tx.execute(
                    "INSERT INTO quest_rewards
                     (id, quest_id, reward_type, target_id, amount_or_details,
                      created_at, updated_at, applied_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        &reward_ids[&reward.id],
                        &quest_ids[&quest.id],
                        reward.reward_type.trim().to_lowercase(),
                        reward.target_id.as_ref().and_then(|id| {
                            if reward.reward_type == "faction_standing" {
                                nodes.get(id)
                            } else {
                                characters.get(id)
                            }
                        }),
                        &reward.amount_or_details,
                        &reward.created_at,
                        &reward.updated_at,
                        &reward.applied_at
                    ],
                )?;
            }
        }

        // Skills come after the nodes they can point at, because the chapter and
        // card links are foreign keys into the copy.
        for skill in &export.character_skills {
            tx.execute(
                "INSERT INTO character_skills
                 (id, character_id, name, rank, effect, chapter_id, node_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    &skills[&skill.id],
                    &characters[&skill.character_id],
                    &skill.name,
                    &skill.rank,
                    &skill.effect,
                    // The chapter and card get new ids with the rest of the story.
                    skill.chapter_id.as_ref().and_then(|id| nodes.get(id)),
                    skill.node_id.as_ref().and_then(|id| nodes.get(id)),
                    &skill.created_at,
                    &skill.updated_at
                ],
            )?;
        }

        // The imported rows do not carry a definition id, so link them the same
        // way a migration does: by their card when they have one, otherwise by
        // their name within the story. Definitions carried by the file are found
        // rather than duplicated.
        backfill_skill_definitions(&tx)?;

        // Evolutions come after the skills at both ends, because both ids are
        // foreign keys into the copy.
        for evolution in &export.skill_evolutions {
            let evolution_type = clean_evolution_type(&evolution.evolution_type)?;

            tx.execute(
                "INSERT INTO skill_evolutions
                 (id, story_id, parent_skill_id, child_skill_id, evolution_type,
                  chapter_id, required_rank, notes, created_by, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    &evolution_ids[&evolution.id],
                    &story_id,
                    &skills[&evolution.parent_skill_id],
                    &skills[&evolution.child_skill_id],
                    &evolution_type,
                    evolution.chapter_id.as_ref().and_then(|id| nodes.get(id)),
                    &evolution.required_rank,
                    &evolution.notes,
                    &evolution.created_by,
                    &evolution.created_at,
                    &evolution.updated_at
                ],
            )?;
        }

        for milestone in &export.character_level_milestones {
            let xp = clean_level_xp(milestone.xp)?;
            let stat_changes = imported_level_stat_changes(milestone)?;
            let milestone_id = &level_milestones[&milestone.id];

            tx.execute(
                "INSERT INTO character_level_milestones
                 (id, character_id, level, chapter_id, is_debuff, xp, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    milestone_id,
                    &characters[&milestone.character_id],
                    milestone.level,
                    milestone.chapter_id.as_ref().and_then(|id| nodes.get(id)),
                    milestone.is_debuff,
                    xp,
                    &milestone.created_at,
                    &milestone.updated_at
                ],
            )?;

            for change in stat_changes {
                tx.execute(
                    "INSERT INTO character_level_stat_changes
                     (id, milestone_id, stat_name, amount, value_after, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        Uuid::new_v4().to_string(),
                        milestone_id,
                        &change.stat_name,
                        change.amount,
                        change.value_after,
                        &milestone.created_at,
                        &milestone.updated_at
                    ],
                )?;
            }
        }

        for entry in &export.character_progress {
            tx.execute(
                "INSERT INTO character_progress
                 (id, character_id, chapter_id, xp_earned, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &character_progress[&entry.id],
                    &characters[&entry.character_id],
                    &nodes[&entry.chapter_id],
                    entry.xp_earned,
                    &entry.created_at,
                    &entry.updated_at
                ],
            )?;
        }

        for event in &export.character_skill_events {
            tx.execute(
                "INSERT INTO character_skill_events
                 (id, skill_id, kind, chapter_id, rank, milestone_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    &skill_events[&event.id],
                    &skills[&event.skill_id],
                    &event.kind,
                    event.chapter_id.as_ref().and_then(|id| nodes.get(id)),
                    &event.rank,
                    event
                        .milestone_id
                        .as_ref()
                        .and_then(|id| level_milestones.get(id)),
                    &event.created_at,
                    &event.updated_at
                ],
            )?;
        }

        // Inventory follows the nodes for the same reason a skill does: its
        // chapter and item-card links are foreign keys into the copy.
        for item in &export.character_inventory {
            tx.execute(
                "INSERT INTO character_inventory
                 (id, character_id, name, rarity, quantity, effect, chapter_id,
                  lost_chapter_id, node_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    &inventory[&item.id],
                    &characters[&item.character_id],
                    &item.name,
                    &item.rarity,
                    item.quantity,
                    &item.effect,
                    item.chapter_id.as_ref().and_then(|id| nodes.get(id)),
                    item.lost_chapter_id.as_ref().and_then(|id| nodes.get(id)),
                    item.node_id.as_ref().and_then(|id| nodes.get(id)),
                    &item.created_at,
                    &item.updated_at
                ],
            )?;
        }

        for currency in &export.character_currency {
            tx.execute(
                "INSERT INTO character_currency
                 (id, character_id, name, amount, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &currencies[&currency.id],
                    &characters[&currency.character_id],
                    &currency.name,
                    currency.amount,
                    &currency.created_at,
                    &currency.updated_at
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
                "character_skill" => skills.get(&entry.entity_id).cloned(),
                "character_level_milestone" => level_milestones.get(&entry.entity_id).cloned(),
                "character_skill_event" => skill_events.get(&entry.entity_id).cloned(),
                "skill_evolution" => evolution_ids.get(&entry.entity_id).cloned(),
                "character_progress" => character_progress.get(&entry.entity_id).cloned(),
                "chapter_cast" => chapter_cast.get(&entry.entity_id).cloned(),
                "character_inventory" => inventory.get(&entry.entity_id).cloned(),
                "character_currency" => currencies.get(&entry.entity_id).cloned(),
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

/// One copy of the database, as the backups dialog lists it.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct BackupInfo {
    pub file_name: String,
    /// When the copy was written, in RFC 3339 (UTC).
    pub created_at: String,
    pub size_bytes: u64,
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
    /// Progression is the author's: no formula is applied anywhere.
    #[serde(default = "default_level")]
    pub level: i64,
    #[serde(default)]
    pub xp: i64,
    #[serde(default)]
    pub rank: Option<String>,
    /// The XP that makes the next level, when the author has decided one. The
    /// bar is drawn against it; without it the bar shows the raw total instead.
    #[serde(default)]
    pub xp_to_next: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

fn default_level() -> i64 {
    1
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

/// One skill a cast member has. The rank is the author's words (“Master”,
/// “Rank 2”), and the chapter and card are optional links, kept nullable so a
/// skill survives the purging of the chapter it was learned in.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct CharacterSkill {
    pub id: String,
    pub character_id: String,
    pub name: String,
    pub rank: Option<String>,
    pub effect: Option<String>,
    pub chapter_id: Option<String>,
    pub node_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// The story-level words every holder of a skill shares. The card is the public
/// face when there is one; without a card the name is the identity. Character
/// rows keep mirrors of `name` and `description` so the sheets, history, badges
/// and exports can read one row without a join.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct SkillDefinition {
    pub id: String,
    pub story_id: String,
    pub name: String,
    pub description: Option<String>,
    pub node_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One cast-to-cast relation within a story. `kind` is free text so the author's
/// own word survives; the suggested five are only suggestions. Symmetric kinds
/// (ally, rival, family) are stored with the two ids in a fixed order, so the
/// same bond cannot be recorded twice in opposite directions.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct CharacterRelation {
    pub id: String,
    pub story_id: String,
    pub from_character_id: String,
    pub to_character_id: String,
    pub kind: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub since_chapter_id: Option<String>,
    #[serde(default)]
    pub until_chapter_id: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One character's standing in a faction card, from a chapter until an optional
/// later one. The faction link can be cleared by a purge without deleting the
/// recorded standing.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct FactionStanding {
    pub id: String,
    pub story_id: String,
    pub character_id: String,
    #[serde(default)]
    pub faction_node_id: Option<String>,
    pub standing: String,
    #[serde(default)]
    pub note: Option<String>,
    pub since_chapter_id: Option<String>,
    #[serde(default)]
    pub until_chapter_id: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One quest or contract. It is accepted in a chapter and optionally ended in a
/// later one; the status is free text so the author's own word survives, with
/// `active`, `completed`, `failed` and `abandoned` as the offered set. Rewards are
/// child rows, loaded with the quest so a list needs one read.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct Quest {
    pub id: String,
    pub story_id: String,
    pub title: String,
    #[serde(default)]
    pub giver_character_id: Option<String>,
    #[serde(default)]
    pub faction_node_id: Option<String>,
    pub accepted_chapter_id: Option<String>,
    #[serde(default)]
    pub completed_chapter_id: Option<String>,
    pub status: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub rewards: Vec<QuestReward>,
}

/// One payout attached to a quest. `reward_type` is `xp`, `item`, `stat` or
/// `faction_standing`; `target_id` is a character for the first three and a
/// faction card for the last; `amount_or_details` holds a number or a phrase,
/// whichever the kind needs, because a payout is not always countable.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct QuestReward {
    pub id: String,
    pub quest_id: String,
    pub reward_type: String,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub amount_or_details: Option<String>,
    /// When this payout last reached the chapter ledger, if it has. Cleared when
    /// the reward or its chapter changes, so a new fact is not called applied.
    #[serde(default)]
    pub applied_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One stat a level-up changed. `amount` is what the level awarded (`+2`), and
/// `value_after` is the sheet's value once it applied (`16`), when the author
/// recorded it. A row moved over from schema v18 has only `value_after`.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct CharacterLevelStatChange {
    pub id: String,
    pub milestone_id: String,
    pub stat_name: String,
    #[serde(default)]
    pub amount: Option<i64>,
    #[serde(default)]
    pub value_after: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// What the editor sends for one stat change. The row's identity and timestamps
/// belong to the database.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct LevelStatChangeInput {
    pub stat_name: String,
    #[serde(default)]
    pub amount: Option<i64>,
    #[serde(default)]
    pub value_after: Option<i64>,
}

/// One level a cast member had in a chapter. `is_debuff` says whether a lower
/// level was deliberate, so a regression can be told from a penalty.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct CharacterLevelMilestone {
    pub id: String,
    pub character_id: String,
    pub level: i64,
    pub chapter_id: Option<String>,
    #[serde(default)]
    pub is_debuff: bool,
    /// Total experience at this chapter, when the author recorded it.
    #[serde(default)]
    pub xp: Option<i64>,
    /// Every stat this level changed, one row per stat.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stat_changes: Vec<CharacterLevelStatChange>,
    /// Legacy v18 columns, read only so an export written before v19 still
    /// imports. New rows never set them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stat_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stat_points: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// One chapter's XP income for one character. This is what was earned in the
/// chapter, not the running total the milestone snapshots carry.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct CharacterProgress {
    pub id: String,
    pub character_id: String,
    pub chapter_id: String,
    pub xp_earned: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// One active skill in a character's state at a chapter. The rank is the one
/// that applied then: the latest upgrade or use at or before that chapter,
/// falling back to the skill row's own rank when no event recorded one.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct CharacterChapterSkill {
    pub skill_id: String,
    pub name: String,
    pub rank: Option<String>,
    pub effect: Option<String>,
    pub learned_chapter_id: String,
    pub learned_chapter_seq: i64,
}

/// What a character's sheet held at one chapter: the latest level milestone at
/// or before it in reading order, and the skills learned by then that had not
/// yet been sacrificed.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct CharacterChapterState {
    pub character_id: String,
    pub chapter_id: String,
    pub chapter_seq: i64,
    pub level: Option<i64>,
    pub level_milestone_id: Option<String>,
    pub level_is_penalty: bool,
    pub skills: Vec<CharacterChapterSkill>,
}

/// The snapshot for one character assigned to one chapter, as the graph cards
/// need it: enough for a compact badge and a tooltip, without repeating the
/// chapter sequence that the caller already knows.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct ChapterCastState {
    pub chapter_id: String,
    pub character_id: String,
    pub level: Option<i64>,
    pub level_is_penalty: bool,
    pub skills: Vec<CharacterChapterSkill>,
}

/// One explicit member of a chapter's cast. The chapter's linked cast member
/// and point of view are implicit additions to the same scene; this row is the
/// author's additional list of who is present.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct ChapterCastMember {
    pub id: String,
    pub chapter_id: String,
    pub character_id: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One change in a skill's life: a rank gained, a use in a chapter, or a
/// sacrifice. The chapter is optional so an event can be recorded before its
/// place in the reading order is known.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct CharacterSkillEvent {
    pub id: String,
    pub skill_id: String,
    pub kind: String,
    pub chapter_id: Option<String>,
    pub rank: Option<String>,
    /// The level-up that granted this change, when it belongs to one. The skill
    /// keeps its own ledger; this link only groups the event on the milestone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One link in a character's skill tree: the parent skill a later skill grew
/// out of, mutating from or fused with. The type says how the child came about;
/// the chapter places the change in the reading order, and the required rank is
/// the parent's rank the author says it needed. Both skills live in the same
/// story, and a link is deleted with either of them.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct SkillEvolution {
    pub id: String,
    pub story_id: String,
    pub parent_skill_id: String,
    pub child_skill_id: String,
    pub evolution_type: String,
    #[serde(default)]
    pub chapter_id: Option<String>,
    #[serde(default)]
    pub required_rank: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A whole skill tree as the database sees it: the skills, plus the evolution
/// links between them. Either list can be empty, and the links are the ones the
/// caller asked to close over — a story's whole graph, or one character's tree.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct SkillTree {
    pub skills: Vec<CharacterSkill>,
    pub evolutions: Vec<SkillEvolution>,
}

/// One item a cast member carries. The rarity and effect are the author's own
/// words, the quantity is how many they hold, and the chapter is where it was
/// found. `lost_chapter_id` records where it left their hands. Every link is
/// optional and nullable so an item survives the purging of the chapter it was
/// acquired in, lost in, or both.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct InventoryItem {
    pub id: String,
    pub character_id: String,
    pub name: String,
    pub rarity: Option<String>,
    pub quantity: i64,
    pub effect: Option<String>,
    pub chapter_id: Option<String>,
    /// Absent from exports written before schema v14, so it defaults to none.
    #[serde(default)]
    pub lost_chapter_id: Option<String>,
    pub node_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One named currency a cast member holds — gold, credits, mana crystals. The
/// name and amount are the author's ledger, with no exchange rate anywhere.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct CharacterCurrency {
    pub id: String,
    pub character_id: String,
    pub name: String,
    pub amount: i64,
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
    /// The cast member this node points at, if any. Kept as an id rather than a
    /// name, so renaming either side leaves the link alone. Absent from exports
    /// written before schema v5, hence the default.
    #[serde(default)]
    pub character_id: Option<String>,
    /// Where a chapter sits in the reading order, 1-based. NULL on every node
    /// that is not a chapter, and absent from exports written before schema v7.
    #[serde(default)]
    pub chapter_seq: Option<i64>,
    /// The arc a chapter belongs to, the author's own label. Optional, and only
    /// meaningful on a chapter.
    #[serde(default)]
    pub chapter_arc: Option<String>,
    /// Words written and the author's target for them. Both optional: a chapter
    /// can be counted without a target, and a target can be set before any words
    /// exist. The app never counts words in a manuscript; these are the numbers
    /// the author types.
    #[serde(default)]
    pub chapter_words: Option<i64>,
    #[serde(default)]
    pub chapter_target: Option<i64>,
    /// Whose point of view the chapter is told from, kept as a cast id like the
    /// node's own link. Absent from exports written before schema v9.
    #[serde(default)]
    pub chapter_pov: Option<String>,
    /// The in-world day the chapter happens on; NULL when it is not placed yet.
    #[serde(default)]
    pub chapter_day: Option<i64>,
    /// When inside that day it happens, in the author's own words. Free text, so
    /// it is only ordered when it reads as a time of day; absent from exports
    /// written before schema v11.
    #[serde(default)]
    pub chapter_time: Option<String>,
    /// The chapter a note belongs to. NULL on everything else, including a
    /// chapter; absent from exports written before schema v10.
    #[serde(default)]
    pub parent_node_id: Option<String>,
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
    /// Whether this entry can still be put back, worked out when the history is
    /// read. Not stored: the answer changes as the story moves on, so it is
    /// derived per request. `None` means the entry has nothing to put back at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revert_state: Option<RevertState>,
    /// What a revert would say if it were attempted now — the same sentence the
    /// engine refuses with — so the tab can explain itself before it is clicked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revert_reason: Option<String>,
}

/// Whether one history entry's field can still be put back.
///
/// The Audit tab shows this on the Revert button, so a reader learns that an edit
/// is no longer undoable — and why — without clicking first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevertState {
    /// The field still holds what the entry produced; the older value can be written.
    Available,
    /// The field moved on after this entry, so writing the older value would
    /// discard that newer edit.
    ChangedSince,
    /// The row is in the trash, where the change would be hidden with it.
    InTrash,
    /// The row is no longer in the database, so there is nothing to write to.
    Gone,
    /// The field already holds the value a revert would write, so it would be a no-op.
    AlreadyBack,
}

/// A window of history together with how many entries the filter matches in total.
#[derive(Debug, serde::Serialize)]
pub struct AuditPage {
    pub entries: Vec<AuditEntry>,
    pub total: i64,
}

/// Upper bound on one window of history, so a bad caller cannot ask for everything.
const MAX_AUDIT_PAGE: i64 = 500;

/// The Markdown outline of a story, with the title used to name the file.
#[derive(Debug, Clone)]
pub struct StoryBible {
    pub title: String,
    pub markdown: String,
}

/// Thousands separators without a locale, so the same story writes the same
/// file on every machine.
fn grouped(value: i64) -> String {
    let digits = value.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);

    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }

    grouped
}

/// The day parts a time label can name, with where each sits in the day. Only
/// the earliest one counts when a label names two, as on the Chapters tab.
const DAY_PARTS: [(&[&str], i32); 7] = [
    (&["midnight"], 0),
    (&["dawn", "sunrise", "first light"], 6 * 60),
    (&["morning"], 9 * 60),
    (&["noon", "midday"], 12 * 60),
    (&["afternoon"], 14 * 60 + 30),
    (&["dusk", "sunset", "evening"], 19 * 60),
    (&["night", "nightfall", "after dark"], 21 * 60),
];

/// Words that pull a day part earlier or later: “early morning”, “late night”.
const DAY_PART_NUDGES: [(&[&str], i32); 2] = [
    (&["early", "before"], -60),
    (&["late", "after", "deep"], 60),
];

/// Whether a byte counts as part of a word for `\b`, which in the frontend's
/// patterns (like JavaScript's) means ASCII letters, digits and the underscore.
fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// The first place `word` appears in `text` on word boundaries. The words are
/// ASCII, so byte offsets are safe and one byte past a match is still a char
/// boundary.
fn find_word(text: &str, word: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut from = 0;

    while let Some(offset) = text[from..].find(word) {
        let start = from + offset;
        let end = start + word.len();
        let before = start == 0 || !is_word_byte(bytes[start - 1]);
        let after = end == text.len() || !is_word_byte(bytes[end]);

        if before && after {
            return Some(start);
        }

        from = start + 1;
    }

    None
}

/// A clock hour, which is one or two digits.
fn hour_of(bits: &str) -> Option<i32> {
    if bits.is_empty() || bits.len() > 2 || !bits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    bits.parse().ok()
}

/// Clock minutes and seconds, which are exactly two digits each.
fn two_digits(bits: &str) -> Option<i32> {
    if bits.len() != 2 || !bits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    bits.parse().ok()
}

/// Where a chapter's free-text time label sits in its day, in minutes from
/// midnight, or `None` when the label does not read as a time of day.
///
/// This answers exactly as `timeOfDay` in `src/App.tsx` does: the tab and the
/// story bible must place a day the same way. Both read a clock (`18:40`,
/// `6:40 pm`) and a day part (`dawn`, `dusk`, `night`), and both leave anything
/// else — `after the fire` — uncompared rather than guessing at it.
fn time_of_day(label: &str) -> Option<i32> {
    let text = label.trim().to_lowercase();

    if text.is_empty() {
        return None;
    }

    // A clock reading, with or without a meridiem. Seconds are allowed and then
    // ignored: the order only needs the minute.
    let (body, meridiem) = if let Some(rest) = text.strip_suffix("pm") {
        (rest.trim_end(), Some(true))
    } else if let Some(rest) = text.strip_suffix("am") {
        (rest.trim_end(), Some(false))
    } else {
        (text.as_str(), None)
    };

    let parts: Vec<&str> = body.split(':').collect();

    let clock = match (parts.as_slice(), meridiem) {
        ([hour, minute], _) => hour_of(hour).zip(two_digits(minute)),
        ([hour, minute, seconds], _) => hour_of(hour)
            .zip(two_digits(minute))
            .and_then(|(hour, minute)| two_digits(seconds).map(|_| (hour, minute))),
        ([hour], Some(_)) => hour_of(hour).map(|hour| (hour, 0)),
        _ => None,
    };

    if let Some((hour, minute)) = clock {
        let latest = if meridiem.is_some() { 12 } else { 23 };

        if hour > latest || minute > 59 {
            return None;
        }

        // 12am is midnight and 12pm is noon; every other hour simply shifts.
        let hour = match meridiem {
            Some(true) => (hour % 12) + 12,
            Some(false) => hour % 12,
            None => hour,
        };

        return Some(hour * 60 + minute);
    }

    // A day part, wherever it appears in the label, nudged by “early” or “late”.
    let mut best: Option<(usize, i32)> = None;

    for (words, minutes) in DAY_PARTS {
        let found = words.iter().filter_map(|word| find_word(&text, word)).min();

        if let Some(at) = found {
            let earlier = match best {
                Some((closest, _)) => at < closest,
                None => true,
            };

            if earlier {
                best = Some((at, minutes));
            }
        }
    }

    let (_, base) = best?;

    let nudge: i32 = DAY_PART_NUDGES
        .iter()
        .filter(|(words, _)| words.iter().any(|word| find_word(&text, word).is_some()))
        .map(|(_, minutes)| *minutes)
        .sum();

    // Clamped to the day so “late night” does not spill into tomorrow.
    Some((base + nudge).clamp(0, 23 * 60 + 59))
}

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
    /// Absent from exports written before schema v12, so it defaults to empty.
    #[serde(default)]
    pub character_skills: Vec<CharacterSkill>,
    /// Absent from exports written before schema v24, so it defaults to empty.
    /// The importer rebuilds missing definitions from the skill rows.
    #[serde(default)]
    pub skill_definitions: Vec<SkillDefinition>,
    /// Absent from exports written before schema v15, so they default to empty.
    #[serde(default)]
    pub character_level_milestones: Vec<CharacterLevelMilestone>,
    #[serde(default)]
    pub character_skill_events: Vec<CharacterSkillEvent>,
    /// Absent from exports written before schema v23, so they default to empty.
    #[serde(default)]
    pub skill_evolutions: Vec<SkillEvolution>,
    /// Absent from exports written before schema v18, so they default to empty.
    #[serde(default)]
    pub character_progress: Vec<CharacterProgress>,
    /// Absent from exports written before schema v16, so they default to empty.
    #[serde(default)]
    pub chapter_cast: Vec<ChapterCastMember>,
    /// Absent from exports written before schema v13, so they default to empty.
    #[serde(default)]
    pub character_inventory: Vec<InventoryItem>,
    #[serde(default)]
    pub character_currency: Vec<CharacterCurrency>,
    /// Absent from exports written before schema v20, so they default to empty.
    #[serde(default)]
    pub character_relations: Vec<CharacterRelation>,
    #[serde(default)]
    pub faction_standings: Vec<FactionStanding>,
    /// Absent from exports written before schema v21, so they default to empty.
    /// A quest carries its own reward bundle, so there is no separate list.
    #[serde(default)]
    pub quests: Vec<Quest>,
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

/// How a reverted value is compared and written back.
#[derive(Clone, Copy)]
enum RevertKind {
    Text,
    Number,
    /// Two coordinates recorded as one `x,y` value.
    Point,
}

/// Where one reverted field lives, and whether the row may still be edited.
struct RevertSpec {
    table: &'static str,
    /// The column holding the value, or the first half of a [`RevertKind::Point`].
    column: &'static str,
    /// Second half of a point; always set for one.
    pair: Option<&'static str>,
    /// `FROM` clause with the target table aliased `t`.
    from: &'static str,
    /// True while the row is on the board; a child also follows its parents.
    live: &'static str,
    /// Whether the table has an `updated_at` to bump.
    touched: bool,
    /// Whether the column may be empty. On one that may not, an entry with no
    /// earlier value recorded nothing to put back rather than an empty value.
    nullable: bool,
    kind: RevertKind,
}

impl RevertSpec {
    /// The current value as text, in the shape the history records it.
    fn current_sql(&self) -> String {
        match self.kind {
            RevertKind::Text => format!("t.{}", self.column),
            RevertKind::Number => format!("CAST(t.{} AS TEXT)", self.column),
            RevertKind::Point => format!(
                "t.{} || ',' || t.{}",
                self.column,
                self.pair.unwrap_or(self.column)
            ),
        }
    }
}

const CHARACTER_FROM: &str = "characters t JOIN stories s ON s.id = t.story_id";
const NODE_FROM: &str = "nodes t JOIN stories s ON s.id = t.story_id";
const EDGE_FROM: &str = "edges t JOIN stories s ON s.id = t.story_id";
const STAT_FROM: &str =
    "character_stats t JOIN characters c ON c.id = t.character_id JOIN stories s ON s.id = c.story_id";
const ATTRIBUTE_FROM: &str = "character_attributes t JOIN characters c ON c.id = t.character_id JOIN stories s ON s.id = c.story_id";
const SKILL_FROM: &str =
    "character_skills t JOIN characters c ON c.id = t.character_id JOIN stories s ON s.id = c.story_id";
const INVENTORY_FROM: &str =
    "character_inventory t JOIN characters c ON c.id = t.character_id JOIN stories s ON s.id = c.story_id";
const CURRENCY_FROM: &str =
    "character_currency t JOIN characters c ON c.id = t.character_id JOIN stories s ON s.id = c.story_id";
const RELATION_FROM: &str =
    "character_relations t JOIN characters c ON c.id = t.from_character_id JOIN stories s ON s.id = c.story_id";
const STANDING_FROM: &str =
    "faction_standings t JOIN characters c ON c.id = t.character_id JOIN stories s ON s.id = c.story_id";

/// A story's own children are visible while they and the story are live.
const OWN_LIVE: &str = "t.deleted_at IS NULL AND s.deleted_at IS NULL";
/// Stats and attributes have no `deleted_at`; they follow their character.
const CHILD_LIVE: &str = "c.deleted_at IS NULL AND s.deleted_at IS NULL";

fn text_spec(
    table: &'static str,
    column: &'static str,
    from: &'static str,
    live: &'static str,
    touched: bool,
) -> RevertSpec {
    RevertSpec {
        table,
        column,
        pair: None,
        from,
        live,
        touched,
        nullable: false,
        kind: RevertKind::Text,
    }
}

/// A text field that may legitimately have been empty before the change, so an
/// empty earlier value is a value it can go back to.
fn optional_text_spec(
    table: &'static str,
    column: &'static str,
    from: &'static str,
    live: &'static str,
    touched: bool,
) -> RevertSpec {
    RevertSpec {
        nullable: true,
        ..text_spec(table, column, from, live, touched)
    }
}

fn number_spec(
    table: &'static str,
    column: &'static str,
    from: &'static str,
    live: &'static str,
) -> RevertSpec {
    RevertSpec {
        table,
        column,
        pair: None,
        from,
        live,
        touched: true,
        nullable: false,
        kind: RevertKind::Number,
    }
}

/// A number that may legitimately have been absent before the change, so an
/// empty earlier value means the column goes back to NULL.
fn optional_number_spec(
    table: &'static str,
    column: &'static str,
    from: &'static str,
    live: &'static str,
) -> RevertSpec {
    RevertSpec {
        nullable: true,
        ..number_spec(table, column, from, live)
    }
}

/// The fields a history entry can put back. Anything absent — a creation, a
/// deletion, or a field the app never records — has nothing to restore.
fn revert_spec(entity_type: &str, field: &str) -> Option<RevertSpec> {
    Some(match (entity_type, field) {
        ("story", "title") => text_spec(
            "stories",
            "title",
            "stories t",
            "t.deleted_at IS NULL",
            true,
        ),
        ("character", "name") => text_spec("characters", "name", CHARACTER_FROM, OWN_LIVE, true),
        ("character", "description") => {
            optional_text_spec("characters", "description", CHARACTER_FROM, OWN_LIVE, true)
        }
        ("character", "level") => number_spec("characters", "level", CHARACTER_FROM, OWN_LIVE),
        ("character", "xp") => number_spec("characters", "xp", CHARACTER_FROM, OWN_LIVE),
        ("character", "rank") => {
            optional_text_spec("characters", "rank", CHARACTER_FROM, OWN_LIVE, true)
        }
        ("character", "xp_to_next") => {
            optional_number_spec("characters", "xp_to_next", CHARACTER_FROM, OWN_LIVE)
        }
        ("character_stat", "value") => {
            number_spec("character_stats", "value", STAT_FROM, CHILD_LIVE)
        }
        ("character_attribute", "value") => text_spec(
            "character_attributes",
            "value",
            ATTRIBUTE_FROM,
            CHILD_LIVE,
            true,
        ),
        // A skill's words are revertible like any other text. Its chapter and card
        // links are not: the history records their labels, and turning a label
        // back into an id would be a guess.
        ("character_skill", "name") => {
            text_spec("character_skills", "name", SKILL_FROM, CHILD_LIVE, true)
        }
        ("character_skill", "rank") => {
            optional_text_spec("character_skills", "rank", SKILL_FROM, CHILD_LIVE, true)
        }
        ("character_skill", "effect") => {
            optional_text_spec("character_skills", "effect", SKILL_FROM, CHILD_LIVE, true)
        }
        // An item's words and count are revertible; its chapter and item-card
        // links are not, for the same reason a skill's are not.
        ("character_inventory", "name") => text_spec(
            "character_inventory",
            "name",
            INVENTORY_FROM,
            CHILD_LIVE,
            true,
        ),
        ("character_inventory", "rarity") => optional_text_spec(
            "character_inventory",
            "rarity",
            INVENTORY_FROM,
            CHILD_LIVE,
            true,
        ),
        ("character_inventory", "effect") => optional_text_spec(
            "character_inventory",
            "effect",
            INVENTORY_FROM,
            CHILD_LIVE,
            true,
        ),
        ("character_inventory", "quantity") => number_spec(
            "character_inventory",
            "quantity",
            INVENTORY_FROM,
            CHILD_LIVE,
        ),
        ("character_currency", "name") => text_spec(
            "character_currency",
            "name",
            CURRENCY_FROM,
            CHILD_LIVE,
            true,
        ),
        ("character_currency", "amount") => {
            number_spec("character_currency", "amount", CURRENCY_FROM, CHILD_LIVE)
        }
        // A relation's words are revertible. Its chapters are not: the history
        // records their labels, and turning a label back into an id would be a
        // guess. The pair itself never changes, so putting the kind back also
        // puts the two ends back in the fixed order a symmetric kind is stored in.
        ("character_relation", "kind") => text_spec(
            "character_relations",
            "kind",
            RELATION_FROM,
            CHILD_LIVE,
            true,
        ),
        ("character_relation", "note") => optional_text_spec(
            "character_relations",
            "note",
            RELATION_FROM,
            CHILD_LIVE,
            true,
        ),
        // A standing's word and note are revertible; the faction card and the
        // chapter it began in are labels in the history, not ids.
        ("faction_standing", "standing") => text_spec(
            "faction_standings",
            "standing",
            STANDING_FROM,
            CHILD_LIVE,
            true,
        ),
        ("faction_standing", "note") => {
            optional_text_spec("faction_standings", "note", STANDING_FROM, CHILD_LIVE, true)
        }
        ("node", "label") => text_spec("nodes", "label", NODE_FROM, OWN_LIVE, true),
        ("node", "content") => optional_text_spec("nodes", "content", NODE_FROM, OWN_LIVE, true),
        ("node", "chapter_seq") => {
            optional_number_spec("nodes", "chapter_seq", NODE_FROM, OWN_LIVE)
        }
        ("node", "chapter_arc") => {
            optional_text_spec("nodes", "chapter_arc", NODE_FROM, OWN_LIVE, true)
        }
        ("node", "chapter_words") => {
            optional_number_spec("nodes", "chapter_words", NODE_FROM, OWN_LIVE)
        }
        ("node", "chapter_target") => {
            optional_number_spec("nodes", "chapter_target", NODE_FROM, OWN_LIVE)
        }
        ("node", "chapter_day") => {
            optional_number_spec("nodes", "chapter_day", NODE_FROM, OWN_LIVE)
        }
        ("node", "chapter_time") => {
            optional_text_spec("nodes", "chapter_time", NODE_FROM, OWN_LIVE, true)
        }
        ("node", "position") => RevertSpec {
            table: "nodes",
            column: "pos_x",
            pair: Some("pos_y"),
            from: NODE_FROM,
            live: OWN_LIVE,
            touched: true,
            nullable: false,
            kind: RevertKind::Point,
        },
        // Connections have no `updated_at` to bump.
        ("edge", "label") => optional_text_spec("edges", "label", EDGE_FROM, OWN_LIVE, false),
        ("edge", "relation_type") => {
            optional_text_spec("edges", "relation_type", EDGE_FROM, OWN_LIVE, false)
        }
        _ => return None,
    })
}

/// Reads the `x,y` a position entry records.
fn parse_point(text: Option<&str>) -> Option<(f64, f64)> {
    let (x, y) = text?.split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

/// Whether two recorded values describe the same thing. Numbers compare as
/// numbers, and a position within the one decimal the history keeps.
fn same_value(kind: RevertKind, left: Option<&str>, right: Option<&str>) -> bool {
    match kind {
        RevertKind::Number => match (
            left.and_then(|value| value.parse::<i64>().ok()),
            right.and_then(|value| value.parse::<i64>().ok()),
        ) {
            (Some(left), Some(right)) => left == right,
            _ => left == right,
        },
        RevertKind::Point => match (parse_point(left), parse_point(right)) {
            // A drag is recorded to one decimal, so the stored value and the text
            // can differ by half that much without being a different position.
            (Some((left_x, left_y)), Some((right_x, right_y))) => {
                (left_x - right_x).abs() <= 0.05 + f64::EPSILON
                    && (left_y - right_y).abs() <= 0.05 + f64::EPSILON
            }
            _ => left == right,
        },
        RevertKind::Text => left == right,
    }
}

/// What one entry can still do, once its field has been read from the row.
enum RevertCheck {
    /// The entry has nothing to put back at all: a creation, a deletion, a purge,
    /// a restore, or a field the app never writes back. No button is shown.
    Nothing { reason: String },
    /// A revert is refused until something else is done — the row is gone, in the
    /// trash, or the field moved on.
    Blocked { state: RevertState, reason: String },
    /// The field already holds the value a revert would write.
    Unchanged,
    /// The older value can be written back.
    Ready { target: RevertTarget },
}

/// The values a revert needs once its field has been read.
struct RevertTarget {
    spec: RevertSpec,
    /// The value to write back, which may legitimately be empty.
    restore: Option<String>,
    /// What the field holds now.
    current: Option<String>,
}

impl RevertCheck {
    fn nothing(reason: impl Into<String>) -> Self {
        RevertCheck::Nothing {
            reason: reason.into(),
        }
    }

    fn blocked(state: RevertState, reason: impl Into<String>) -> Self {
        RevertCheck::Blocked {
            state,
            reason: reason.into(),
        }
    }

    /// The state the Audit tab shows beside the entry, if it shows one at all.
    fn state(&self) -> Option<RevertState> {
        match self {
            RevertCheck::Nothing { .. } => None,
            RevertCheck::Blocked { state, .. } => Some(*state),
            RevertCheck::Unchanged => Some(RevertState::AlreadyBack),
            RevertCheck::Ready { .. } => Some(RevertState::Available),
        }
    }

    /// What a click would be answered with, when the answer is not a revert.
    fn reason(&self) -> Option<String> {
        match self {
            RevertCheck::Nothing { .. } | RevertCheck::Ready { .. } => None,
            RevertCheck::Blocked { reason, .. } => Some(reason.clone()),
            RevertCheck::Unchanged => Some(ALREADY_BACK.to_string()),
        }
    }
}

const ALREADY_BACK: &str =
    "that field already holds its earlier value, so there is nothing to put back";

/// Reads one entry's field and decides whether its earlier value can still be
/// written back.
///
/// This is where the rules live. The Audit tab asks it about every entry it shows,
/// and `revert_change` asks it again before writing, so a button and the engine
/// cannot disagree about what is still possible.
fn check_revert(conn: &Connection, entry: &AuditEntry) -> SqliteResult<RevertCheck> {
    // Only an edit keeps the value it replaced. Everything else is undone
    // somewhere else, or cannot be undone at all.
    match entry.action.as_str() {
        "update" | "revert" => {}
        "create" => {
            return Ok(RevertCheck::nothing(
                "a creation has nothing to put back; delete it and it goes to the trash",
            ))
        }
        "soft_delete" => {
            return Ok(RevertCheck::nothing(
                "a deletion is undone from the trash, not from the history",
            ))
        }
        "restore" => {
            return Ok(RevertCheck::nothing(
                "that entry is already a restore, so there is nothing to undo",
            ))
        }
        "purge" => {
            return Ok(RevertCheck::nothing(
                "that item was deleted for good, so there is nothing to put back",
            ))
        }
        other => {
            return Ok(RevertCheck::nothing(format!(
                "a {other} cannot be reverted"
            )))
        }
    }

    let Some(field) = entry.field_changed.as_deref() else {
        return Ok(RevertCheck::nothing(
            "that entry did not record which field changed",
        ));
    };

    let Some(spec) = revert_spec(&entry.entity_type, field) else {
        return Ok(RevertCheck::nothing(format!(
            "a change to {} {field} has nothing to put back",
            entry.entity_type
        )));
    };

    // On a column that cannot be empty, an entry with no earlier value recorded
    // nothing to put back rather than an empty value.
    if !spec.nullable && entry.old_value.is_none() {
        return Ok(RevertCheck::nothing(format!(
            "that entry did not record what {field} was before it changed"
        )));
    }

    let kind = spec.kind;

    let read = format!(
        "SELECT {} AS value, ({}) AS live FROM {} WHERE t.id = ?1",
        spec.current_sql(),
        spec.live,
        spec.from
    );

    let row = conn
        .query_row(&read, params![&entry.entity_id], |row| {
            Ok((row.get::<_, Option<String>>(0)?, row.get::<_, bool>(1)?))
        })
        .optional()?;

    let Some((current, live)) = row else {
        return Ok(RevertCheck::blocked(
            RevertState::Gone,
            "that item is no longer in the database, so there is nothing to put back",
        ));
    };

    // A row in the trash would take the change with it into hiding, so it has to
    // come back first.
    if !live {
        return Ok(RevertCheck::blocked(
            RevertState::InTrash,
            "that item is in the trash; restore it before reverting an edit",
        ));
    }

    if same_value(kind, current.as_deref(), entry.old_value.as_deref()) {
        return Ok(RevertCheck::Unchanged);
    }

    if !same_value(kind, current.as_deref(), entry.new_value.as_deref()) {
        return Ok(RevertCheck::blocked(
            RevertState::ChangedSince,
            format!(
                "{field} changed after that entry — it now reads \"{}\", so reverting would discard that edit",
                current.as_deref().unwrap_or("nothing")
            ),
        ));
    }

    // A relation's kind is half of its identity. Putting the old word back could
    // collide with a bond recorded since, which the unique pair would refuse as
    // a raw constraint error; the same test `add_relation` makes runs here first,
    // including the fixed order a symmetric kind is stored in.
    if entry.entity_type == "character_relation" && field == "kind" {
        if let Some(restore) = entry.old_value.as_deref() {
            let pair = conn
                .query_row(
                    "SELECT from_character_id, to_character_id FROM character_relations WHERE id = ?1",
                    params![&entry.entity_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;

            if let Some((from, to)) = pair {
                let (from, to) = relation_ends(&from, &to, restore);
                let taken: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM character_relations
                          WHERE id <> ?1 AND from_character_id = ?2
                            AND to_character_id = ?3 AND lower(kind) = lower(?4)",
                        params![&entry.entity_id, &from, &to, restore],
                        |row| row.get(0),
                    )
                    .optional()?;

                if taken.is_some() {
                    return Ok(RevertCheck::blocked(
                        RevertState::ChangedSince,
                        format!(
                            "a {restore} relation is already recorded between these two, so the old kind cannot be put back"
                        ),
                    ));
                }
            }
        }
    }

    Ok(RevertCheck::Ready {
        target: RevertTarget {
            spec,
            restore: entry.old_value.clone(),
            current,
        },
    })
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
    let rows = stmt.query_map(rusqlite::params_from_iter(args), audit_row)?;

    rows.collect()
}

/// One row in the column order `query_audit` selects.
fn audit_row(row: &rusqlite::Row<'_>) -> SqliteResult<AuditEntry> {
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
        // Worked out against the live row by whoever asked for the entry, not
        // stored, so a copy of the history never carries a stale answer.
        revert_state: None,
        revert_reason: None,
    })
}

/// Every skill read selects its columns in this order.
fn character_skill_row(row: &rusqlite::Row<'_>) -> SqliteResult<CharacterSkill> {
    Ok(CharacterSkill {
        id: row.get(0)?,
        character_id: row.get(1)?,
        name: row.get(2)?,
        rank: row.get(3)?,
        effect: row.get(4)?,
        chapter_id: row.get(5)?,
        node_id: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

/// Every relation read selects its columns in this order.
fn character_relation_row(row: &rusqlite::Row<'_>) -> SqliteResult<CharacterRelation> {
    Ok(CharacterRelation {
        id: row.get(0)?,
        story_id: row.get(1)?,
        from_character_id: row.get(2)?,
        to_character_id: row.get(3)?,
        kind: row.get(4)?,
        note: row.get(5)?,
        since_chapter_id: row.get(6)?,
        until_chapter_id: row.get(7)?,
        created_by: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

/// Every faction standing read selects its columns in this order.
fn faction_standing_row(row: &rusqlite::Row<'_>) -> SqliteResult<FactionStanding> {
    Ok(FactionStanding {
        id: row.get(0)?,
        story_id: row.get(1)?,
        character_id: row.get(2)?,
        faction_node_id: row.get(3)?,
        standing: row.get(4)?,
        note: row.get(5)?,
        since_chapter_id: row.get(6)?,
        until_chapter_id: row.get(7)?,
        created_by: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

/// Every quest read selects its columns in this order; rewards are loaded
/// separately and attached.
fn quest_row(row: &rusqlite::Row<'_>) -> SqliteResult<Quest> {
    Ok(Quest {
        id: row.get(0)?,
        story_id: row.get(1)?,
        title: row.get(2)?,
        giver_character_id: row.get(3)?,
        faction_node_id: row.get(4)?,
        accepted_chapter_id: row.get(5)?,
        completed_chapter_id: row.get(6)?,
        status: row.get(7)?,
        description: row.get(8)?,
        notes: row.get(9)?,
        created_by: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        rewards: Vec::new(),
    })
}

/// Every reward read selects its columns in this order.
fn quest_reward_row(row: &rusqlite::Row<'_>) -> SqliteResult<QuestReward> {
    Ok(QuestReward {
        id: row.get(0)?,
        quest_id: row.get(1)?,
        reward_type: row.get(2)?,
        target_id: row.get(3)?,
        amount_or_details: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        applied_at: row.get(7)?,
    })
}

/// Loads each quest's reward bundle in one query and hands it to the quest,
/// rather than one query per quest.
fn attach_quest_rewards(conn: &Connection, story_id: &str, quests: &mut [Quest]) -> DbResult<()> {
    if quests.is_empty() {
        return Ok(());
    }

    let mut by_quest: HashMap<String, Vec<QuestReward>> = HashMap::new();

    {
        let mut stmt = conn.prepare(
            "SELECT r.id, r.quest_id, r.reward_type, r.target_id, r.amount_or_details,
                    r.created_at, r.updated_at, r.applied_at
             FROM quest_rewards r
             JOIN quests q ON q.id = r.quest_id
             WHERE q.story_id = ?1
             ORDER BY r.created_at, r.id",
        )?;
        let rows = stmt.query_map(params![story_id], quest_reward_row)?;

        for row in rows {
            let reward = row?;
            by_quest
                .entry(reward.quest_id.clone())
                .or_default()
                .push(reward);
        }
    }

    for quest in quests {
        quest.rewards = by_quest.remove(&quest.id).unwrap_or_default();
    }

    Ok(())
}

/// Every level milestone read selects its columns in this order. Stat changes
/// are loaded separately and attached by the caller.
fn level_milestone_row(row: &rusqlite::Row<'_>) -> SqliteResult<CharacterLevelMilestone> {
    Ok(CharacterLevelMilestone {
        id: row.get(0)?,
        character_id: row.get(1)?,
        level: row.get(2)?,
        chapter_id: row.get(3)?,
        is_debuff: row.get(4)?,
        xp: row.get(5)?,
        stat_changes: Vec::new(),
        stat_name: None,
        stat_points: None,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// Every stat change read selects its columns in this order.
fn level_stat_change_row(row: &rusqlite::Row<'_>) -> SqliteResult<CharacterLevelStatChange> {
    Ok(CharacterLevelStatChange {
        id: row.get(0)?,
        milestone_id: row.get(1)?,
        stat_name: row.get(2)?,
        amount: row.get(3)?,
        value_after: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// Every XP ledger read selects its columns in this order.
fn character_progress_row(row: &rusqlite::Row<'_>) -> SqliteResult<CharacterProgress> {
    Ok(CharacterProgress {
        id: row.get(0)?,
        character_id: row.get(1)?,
        chapter_id: row.get(2)?,
        xp_earned: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

/// Every skill event read selects its columns in this order.
fn skill_event_row(row: &rusqlite::Row<'_>) -> SqliteResult<CharacterSkillEvent> {
    Ok(CharacterSkillEvent {
        id: row.get(0)?,
        skill_id: row.get(1)?,
        kind: row.get(2)?,
        chapter_id: row.get(3)?,
        rank: row.get(4)?,
        milestone_id: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// Every evolution read selects its columns in this order.
fn skill_evolution_row(row: &rusqlite::Row<'_>) -> SqliteResult<SkillEvolution> {
    Ok(SkillEvolution {
        id: row.get(0)?,
        story_id: row.get(1)?,
        parent_skill_id: row.get(2)?,
        child_skill_id: row.get(3)?,
        evolution_type: row.get(4)?,
        chapter_id: row.get(5)?,
        required_rank: row.get(6)?,
        notes: row.get(7)?,
        created_by: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

/// Every inventory read selects its columns in this order.
fn inventory_item_row(row: &rusqlite::Row<'_>) -> SqliteResult<InventoryItem> {
    Ok(InventoryItem {
        id: row.get(0)?,
        character_id: row.get(1)?,
        name: row.get(2)?,
        rarity: row.get(3)?,
        quantity: row.get(4)?,
        effect: row.get(5)?,
        chapter_id: row.get(6)?,
        lost_chapter_id: row.get(7)?,
        node_id: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

/// Every currency read selects its columns in this order.
fn character_currency_row(row: &rusqlite::Row<'_>) -> SqliteResult<CharacterCurrency> {
    Ok(CharacterCurrency {
        id: row.get(0)?,
        character_id: row.get(1)?,
        name: row.get(2)?,
        amount: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

/// A recorded boolean reads as a word in the history rather than as 1 or 0.
fn yes_no(value: bool) -> String {
    if value { "yes" } else { "no" }.to_string()
}

/// Skill events are deliberately a small vocabulary; anything else is a typo
/// rather than a new kind of progression.
fn clean_skill_event_kind(value: &str) -> DbResult<String> {
    let kind = value.trim().to_lowercase();

    if matches!(kind.as_str(), "upgraded" | "sacrificed" | "used") {
        return Ok(kind);
    }

    Err(DbError::Invalid(
        "a skill event must be an upgrade, a sacrifice or a use".to_string(),
    ))
}

/// The four ways a skill can follow another. Deliberately a small vocabulary:
/// anything else is a typo, not a new kind of progression.
fn clean_evolution_type(value: &str) -> DbResult<String> {
    let kind = value.trim().to_lowercase();

    if matches!(kind.as_str(), "upgrade" | "fusion" | "mutation" | "branch") {
        return Ok(kind);
    }

    Err(DbError::Invalid(
        "an evolution must be an upgrade, fusion, mutation or branch".to_string(),
    ))
}

/// The story and name of a skill on a live sheet, refusing a row that is gone or
/// whose owner is in the trash.
fn live_skill_ref(conn: &Connection, skill_id: &str, role: &str) -> DbResult<(String, String)> {
    conn.query_row(
        "SELECT c.story_id, s.name
         FROM character_skills s
         JOIN characters c ON c.id = s.character_id
         JOIN stories st ON st.id = c.story_id
         WHERE s.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
        params![skill_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()?
    .ok_or_else(|| DbError::Invalid(format!("the {role} skill is not on a live character sheet")))
}

/// Whether adding parent → child would close a loop: true when the parent is
/// already reachable from the child. The walk follows the graph as recorded, so
/// A → B → C refuses C → A as well as B → A.
fn evolution_would_cycle(
    conn: &Connection,
    parent_skill_id: &str,
    child_skill_id: &str,
) -> DbResult<bool> {
    let found: Option<i64> = conn
        .query_row(
            "WITH RECURSIVE reachable(id) AS (
                 SELECT child_skill_id FROM skill_evolutions WHERE parent_skill_id = ?1
                 UNION
                 SELECT e.child_skill_id
                 FROM skill_evolutions e
                 JOIN reachable r ON e.parent_skill_id = r.id
             )
             SELECT 1 FROM reachable WHERE id = ?2 LIMIT 1",
            params![child_skill_id, parent_skill_id],
            |row| row.get(0),
        )
        .optional()?;

    Ok(found.is_some())
}

/// Every row in a story, in the order it was recorded. Skills in the trash are
/// included on purpose: continuity reads this and names them.
fn skill_evolutions_in(conn: &Connection, story_id: &str) -> DbResult<Vec<SkillEvolution>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.story_id, e.parent_skill_id, e.child_skill_id, e.evolution_type,
                e.chapter_id, e.required_rank, e.notes, e.created_by, e.created_at,
                e.updated_at
         FROM skill_evolutions e
         JOIN stories st ON st.id = e.story_id
         WHERE e.story_id = ?1 AND st.deleted_at IS NULL
         ORDER BY e.created_at, e.id",
    )?;

    let rows = stmt.query_map(params![story_id], skill_evolution_row)?;

    Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
}

/// Whether a set of parent → child links contains a loop. Import checks the
/// whole file before writing, because a file can carry a cycle no single insert
/// would have caught while the rows were being added one at a time.
fn evolution_links_have_cycle(links: &[(String, String)]) -> bool {
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();

    for (parent, child) in links {
        children
            .entry(parent.as_str())
            .or_default()
            .push(child.as_str());
    }

    fn reaches(
        current: &str,
        target: &str,
        children: &HashMap<&str, Vec<&str>>,
        seen: &mut HashSet<String>,
    ) -> bool {
        if current == target {
            return true;
        }

        if !seen.insert(current.to_string()) {
            return false;
        }

        children
            .get(current)
            .is_some_and(|next| next.iter().any(|id| reaches(id, target, children, seen)))
    }

    for (parent, child) in links {
        if parent == child {
            return true;
        }

        if reaches(child, parent, &children, &mut HashSet::new()) {
            return true;
        }
    }

    false
}

/// An optional text field with its edges trimmed; blank means absent, so a skill
/// never carries an empty rank or effect.
fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// The story-level definition a skill row should point at.
///
/// A card is the strongest identity: every holder of the same card shares its
/// words. Without a card, the name is the identity within the story. The first
/// time a skill is written the definition is created; later writes reuse it and
/// keep the canonical words rather than letting one sheet's copy drift.
fn skill_definition_for(
    tx: &rusqlite::Transaction<'_>,
    story_id: &str,
    name: &str,
    effect: Option<&str>,
    node_id: Option<&str>,
) -> DbResult<(String, String, Option<String>, Option<String>)> {
    let existing = if let Some(card) = node_id {
        tx.query_row(
            "SELECT id, name, description, node_id FROM skill_definitions
              WHERE story_id = ?1 AND node_id = ?2",
            params![story_id, card],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?
    } else {
        tx.query_row(
            "SELECT id, name, description, node_id FROM skill_definitions
              WHERE story_id = ?1 AND lower(name) = lower(?2)
              ORDER BY (node_id IS NULL) DESC, created_at, id LIMIT 1",
            params![story_id, name],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?
    };

    if let Some((id, canonical_name, mut description, canonical_node)) = existing {
        // A definition that had no description yet can take the first one the
        // author writes, but an established description is never overwritten by
        // a later holder's wording.
        if description.is_none() && effect.is_some() {
            tx.execute(
                "UPDATE skill_definitions
                    SET description = ?1, updated_at = ?2
                  WHERE id = ?3",
                params![effect, now(), &id],
            )?;
            description = effect.map(str::to_string);
        }

        return Ok((id, canonical_name, description, canonical_node));
    }

    let id = Uuid::new_v4().to_string();
    let timestamp = now();

    tx.execute(
        "INSERT INTO skill_definitions
         (id, story_id, name, description, node_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![&id, story_id, name, effect, node_id, &timestamp],
    )?;

    Ok((
        id,
        name.to_string(),
        effect.map(str::to_string),
        node_id.map(str::to_string),
    ))
}

/// A relation kind is free text, but it cannot be blank.
fn clean_relation_kind(kind: String) -> DbResult<String> {
    let kind = kind.trim().to_string();

    if kind.is_empty() {
        return Err(DbError::Invalid("a relation needs a kind".to_string()));
    }

    Ok(kind)
}

/// Bonds that mean the same thing said from either side. The comparison ignores
/// case so the author's own capitalisation is kept without making a duplicate.
fn relation_is_symmetric(kind: &str) -> bool {
    matches!(kind.to_lowercase().as_str(), "ally" | "rival" | "family")
}

/// The order a relation's two ends are stored in. A symmetric bond reads the
/// same either way, so the ids are sorted and the unique index catches a copy
/// entered from the other side.
fn relation_ends(from: &str, to: &str, kind: &str) -> (String, String) {
    if relation_is_symmetric(kind) && to < from {
        (to.to_string(), from.to_string())
    } else {
        (from.to_string(), to.to_string())
    }
}

/// A faction standing needs a word for the place the character holds.
fn clean_standing(standing: String) -> DbResult<String> {
    let standing = standing.trim().to_string();

    if standing.is_empty() {
        return Err(DbError::Invalid(
            "a faction standing needs a word for it".to_string(),
        ));
    }

    Ok(standing)
}

/// A second cast member named by a record must be live and in the same story.
fn ensure_live_cast_in_story(
    conn: &Connection,
    story_id: &str,
    character_id: &str,
) -> DbResult<()> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM characters c
             JOIN stories st ON st.id = c.story_id
             WHERE c.id = ?1 AND c.story_id = ?2
               AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
            params![character_id, story_id],
            |row| row.get(0),
        )
        .optional()?;

    if found.is_some() {
        return Ok(());
    }

    Err(DbError::Invalid(
        "both sides of a relation must be live cast of the same story".to_string(),
    ))
}

/// A quest's status is the author's word, but it cannot be empty.
fn clean_quest_status(status: String) -> DbResult<String> {
    let status = status.trim().to_string();

    if status.is_empty() {
        return Err(DbError::Invalid("a quest needs a status".to_string()));
    }

    Ok(status)
}

/// The four kinds a payout can be. Kept as a small set because each one is
/// applied differently; the details beside it stay free text.
fn clean_reward_type(reward_type: String) -> DbResult<String> {
    let reward_type = reward_type.trim().to_lowercase();

    match reward_type.as_str() {
        "xp" | "item" | "stat" | "faction_standing" => Ok(reward_type),
        _ => Err(DbError::Invalid(
            "a reward is xp, item, stat or faction_standing".to_string(),
        )),
    }
}

/// A reward's target depends on what it pays: a character for XP, stats and
/// loot, a faction card for a standing, and either may be left out.
fn validate_reward_target(
    conn: &Connection,
    story_id: &str,
    reward_type: &str,
    target_id: Option<&str>,
) -> DbResult<()> {
    let Some(target_id) = target_id else {
        return Ok(());
    };

    if reward_type == "faction_standing" {
        validate_node_reference(conn, story_id, Some(target_id), "faction", "faction card")?;
        return Ok(());
    }

    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM characters c
             JOIN stories st ON st.id = c.story_id
             WHERE c.id = ?1 AND c.story_id = ?2
               AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
            params![target_id, story_id],
            |row| row.get(0),
        )
        .optional()?;

    if found.is_some() {
        return Ok(());
    }

    Err(DbError::Invalid(
        "a reward target must be live cast of this story".to_string(),
    ))
}

fn ensure_live_story(conn: &Connection, story_id: &str) -> DbResult<()> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM stories WHERE id = ?1 AND deleted_at IS NULL",
            params![story_id],
            |row| row.get(0),
        )
        .optional()?;

    if found.is_some() {
        return Ok(());
    }

    Err(DbError::NotFound("story"))
}

/// A cast member's name as the history records it, live or in the trash.
fn character_reference_label(
    conn: &Connection,
    character_id: Option<&str>,
) -> DbResult<Option<String>> {
    let Some(character_id) = character_id else {
        return Ok(None);
    };

    Ok(conn
        .query_row(
            "SELECT name FROM characters WHERE id = ?1",
            params![character_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

/// The story a live cast member belongs to, refusing one that is gone or in the
/// trash.
fn live_character_story(conn: &Connection, character_id: &str) -> DbResult<String> {
    conn.query_row(
        "SELECT c.story_id
         FROM characters c
         JOIN stories st ON st.id = c.story_id
         WHERE c.id = ?1 AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
        params![character_id],
        |row| row.get::<_, String>(0),
    )
    .optional()?
    .ok_or(DbError::NotFound("character"))
}

/// XP is an optional running total, but it can never be negative. The stat
/// changes are cleaned separately because a level-up may award several.
fn clean_level_xp(xp: Option<i64>) -> DbResult<Option<i64>> {
    if xp.is_some_and(|value| value < 0) {
        return Err(DbError::Invalid(
            "experience cannot be negative".to_string(),
        ));
    }

    Ok(xp)
}

/// A stat a level-up raised, with both what it gained and what it became.
fn stat_gain(stat_name: &str, amount: i64, value_after: i64) -> LevelStatChangeInput {
    LevelStatChangeInput {
        stat_name: stat_name.to_string(),
        amount: Some(amount),
        value_after: Some(value_after),
    }
}

/// Turns the old single snapshot into a child row. The old value was the stat
/// after the chapter, not a gain, so only `value_after` is known.
fn legacy_level_stat_changes(
    stat_name: Option<String>,
    stat_points: Option<i64>,
) -> DbResult<Vec<LevelStatChangeInput>> {
    let stat_name = stat_name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());

    match (stat_name, stat_points) {
        (None, None) => Ok(Vec::new()),
        (Some(stat_name), Some(value_after)) => Ok(vec![LevelStatChangeInput {
            stat_name,
            amount: None,
            value_after: Some(value_after),
        }]),
        _ => Err(DbError::Invalid(
            "a primary stat needs both a name and a value".to_string(),
        )),
    }
}

/// Trims stat names, drops fully blank rows, and refuses two changes to the same
/// stat in one level-up. A row needs at least a gain or a resulting value.
fn clean_level_stat_changes(
    changes: Vec<LevelStatChangeInput>,
) -> DbResult<Vec<LevelStatChangeInput>> {
    let mut cleaned = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for change in changes {
        let stat_name = change.stat_name.trim().to_string();

        if stat_name.is_empty() {
            if change.amount.is_none() && change.value_after.is_none() {
                continue;
            }

            return Err(DbError::Invalid(
                "a stat change needs a stat name".to_string(),
            ));
        }

        if change.amount.is_none() && change.value_after.is_none() {
            return Err(DbError::Invalid(format!(
                "the {stat_name} change needs a gain, a resulting value, or both"
            )));
        }

        if !seen.insert(stat_name.clone()) {
            return Err(DbError::Invalid(format!(
                "{stat_name} is changed more than once in this level-up"
            )));
        }

        cleaned.push(LevelStatChangeInput {
            stat_name,
            amount: change.amount,
            value_after: change.value_after,
        });
    }

    Ok(cleaned)
}

/// The stat changes an imported milestone carries. A v19 file puts them in
/// `stat_changes`; an older file has the one legacy snapshot instead. New data
/// wins when both are present, so a file round-tripped through a newer build
/// never doubles its rows.
fn imported_level_stat_changes(
    milestone: &CharacterLevelMilestone,
) -> DbResult<Vec<LevelStatChangeInput>> {
    if !milestone.stat_changes.is_empty() {
        return clean_level_stat_changes(
            milestone
                .stat_changes
                .iter()
                .map(|change| LevelStatChangeInput {
                    stat_name: change.stat_name.clone(),
                    amount: change.amount,
                    value_after: change.value_after,
                })
                .collect(),
        );
    }

    legacy_level_stat_changes(milestone.stat_name.clone(), milestone.stat_points)
}

fn describe_level_stat_change(amount: Option<i64>, value_after: Option<i64>) -> String {
    match (amount, value_after) {
        (Some(amount), Some(value)) => format!("{amount:+} (now {value})"),
        (Some(amount), None) => format!("{amount:+}"),
        (None, Some(value)) => format!("now {value}"),
        (None, None) => String::new(),
    }
}

fn load_level_stat_changes(
    conn: &Connection,
    milestone_id: &str,
) -> DbResult<Vec<CharacterLevelStatChange>> {
    let mut stmt = conn.prepare(
        "SELECT id, milestone_id, stat_name, amount, value_after, created_at, updated_at
         FROM character_level_stat_changes
         WHERE milestone_id = ?1
         ORDER BY stat_name COLLATE NOCASE, id",
    )?;

    let rows = stmt.query_map(params![milestone_id], level_stat_change_row)?;

    Ok(rows.collect::<SqliteResult<Vec<_>>>()?)
}

fn attach_level_stat_changes(
    conn: &Connection,
    milestones: &mut [CharacterLevelMilestone],
) -> DbResult<()> {
    for milestone in milestones {
        milestone.stat_changes = load_level_stat_changes(conn, &milestone.id)?;
    }

    Ok(())
}

/// Adds, updates and removes the stat changes of one milestone. The incoming
/// list is the whole new set, so a stat left out is removed. Returns whether
/// anything was written, which lets a no-op save keep its old timestamp.
fn apply_level_stat_changes(
    conn: &Connection,
    milestone_id: &str,
    story_id: &str,
    existing: &[CharacterLevelStatChange],
    incoming: &[LevelStatChangeInput],
    timestamp: &str,
    user: &str,
) -> DbResult<bool> {
    let existing_by_name: HashMap<&str, &CharacterLevelStatChange> = existing
        .iter()
        .map(|change| (change.stat_name.as_str(), change))
        .collect();
    let incoming_by_name: HashMap<&str, &LevelStatChangeInput> = incoming
        .iter()
        .map(|change| (change.stat_name.as_str(), change))
        .collect();
    let mut changed = false;

    for old in existing {
        if incoming_by_name.contains_key(old.stat_name.as_str()) {
            continue;
        }

        conn.execute(
            "DELETE FROM character_level_stat_changes WHERE id = ?1",
            params![&old.id],
        )?;

        let field = format!("stat:{}", old.stat_name);
        log_audit(
            conn,
            AuditRecord {
                story_id: Some(story_id),
                entity_type: "character_level_milestone",
                entity_id: milestone_id,
                action: "delete",
                field_changed: Some(field.as_str()),
                old_value: Some(describe_level_stat_change(old.amount, old.value_after)),
                new_value: None,
                changed_by: user,
            },
        )?;
        changed = true;
    }

    for change in incoming {
        if let Some(old) = existing_by_name.get(change.stat_name.as_str()) {
            if old.amount == change.amount && old.value_after == change.value_after {
                continue;
            }

            conn.execute(
                "UPDATE character_level_stat_changes
                    SET amount = ?1, value_after = ?2, updated_at = ?3
                  WHERE id = ?4",
                params![change.amount, change.value_after, timestamp, &old.id],
            )?;

            let field = format!("stat:{}", change.stat_name);
            log_audit(
                conn,
                AuditRecord {
                    story_id: Some(story_id),
                    entity_type: "character_level_milestone",
                    entity_id: milestone_id,
                    action: "update",
                    field_changed: Some(field.as_str()),
                    old_value: Some(describe_level_stat_change(old.amount, old.value_after)),
                    new_value: Some(describe_level_stat_change(
                        change.amount,
                        change.value_after,
                    )),
                    changed_by: user,
                },
            )?;
            changed = true;
            continue;
        }

        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO character_level_stat_changes
             (id, milestone_id, stat_name, amount, value_after, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                &id,
                milestone_id,
                &change.stat_name,
                change.amount,
                change.value_after,
                timestamp
            ],
        )?;

        let field = format!("stat:{}", change.stat_name);
        log_audit(
            conn,
            AuditRecord {
                story_id: Some(story_id),
                entity_type: "character_level_milestone",
                entity_id: milestone_id,
                action: "create",
                field_changed: Some(field.as_str()),
                old_value: None,
                new_value: Some(describe_level_stat_change(
                    change.amount,
                    change.value_after,
                )),
                changed_by: user,
            },
        )?;
        changed = true;
    }

    Ok(changed)
}

/// Checks that a level-up belongs to the skill's character and answers its
/// chapter and a readable label for the history.
fn resolve_level_milestone(
    conn: &Connection,
    milestone_id: &str,
    character_id: &str,
) -> DbResult<(Option<String>, String)> {
    conn.query_row(
        "SELECT m.chapter_id, m.level
         FROM character_level_milestones m
         JOIN characters c ON c.id = m.character_id
         JOIN stories st ON st.id = c.story_id
         WHERE m.id = ?1 AND m.character_id = ?2
           AND c.deleted_at IS NULL AND st.deleted_at IS NULL",
        params![milestone_id, character_id],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                format!("Level {}", row.get::<_, i64>(1)?),
            ))
        },
    )
    .optional()?
    .ok_or_else(|| {
        DbError::Invalid(
            "a skill event can only link to a level-up of its own character".to_string(),
        )
    })
}

/// Checks that a skill's optional link points at a live node of the right type
/// in the same story, and answers its label for the history.
fn validate_node_reference(
    conn: &Connection,
    story_id: &str,
    node_id: Option<&str>,
    node_type: &str,
    noun: &str,
) -> DbResult<Option<String>> {
    let Some(id) = node_id else {
        return Ok(None);
    };

    let label = conn
        .query_row(
            "SELECT label FROM nodes
              WHERE id = ?1 AND story_id = ?2 AND node_type = ?3 AND deleted_at IS NULL",
            params![id, story_id, node_type],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    label.map(Some).ok_or_else(|| {
        DbError::Invalid(format!(
            "the {noun} must be a live {node_type} of this story"
        ))
    })
}

/// The label of a linked node, live or in the trash, for the history. The link
/// itself is kept as an id, so the entry reads as the name it had.
fn reference_label(conn: &Connection, node_id: Option<&str>) -> DbResult<Option<String>> {
    let Some(id) = node_id else {
        return Ok(None);
    };

    Ok(conn
        .query_row(
            "SELECT label FROM nodes WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

/// Every node read selects its columns in this order.
fn node_row(row: &rusqlite::Row<'_>) -> SqliteResult<Node> {
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
        character_id: row.get(10)?,
        chapter_seq: row.get(11)?,
        chapter_arc: row.get(12)?,
        chapter_words: row.get(13)?,
        chapter_target: row.get(14)?,
        chapter_pov: row.get(15)?,
        chapter_day: row.get(16)?,
        chapter_time: row.get(17)?,
        parent_node_id: row.get(18)?,
    })
}

/// The text of a note, trimmed. An empty note is refused rather than stored, so
/// nothing on the board has a blank line where a note should be.
fn note_body(text: String) -> DbResult<String> {
    let body = text.trim().to_string();

    if body.is_empty() {
        return Err(DbError::Invalid("a note needs some text".to_string()));
    }

    Ok(body)
}

/// One note as Markdown list lines: the first line follows the bullet and the
/// rest are indented, so a note that uses line breaks stays a single item.
fn note_markdown(body: &str) -> Vec<String> {
    if body.trim().is_empty() {
        return Vec::new();
    }

    body.lines()
        .enumerate()
        .map(|(index, line)| {
            let text = line.trim_end();

            match (index, text.is_empty()) {
                (0, _) => format!("- {text}"),
                (_, true) => "  ".to_string(),
                (_, false) => format!("  {text}"),
            }
        })
        .collect()
}

/// A note's label: its first line, shortened. The full text stays in `content`.
fn note_label(body: &str) -> String {
    let first = body.lines().next().unwrap_or("").trim();
    let mut label: String = first.chars().take(60).collect();

    if first.chars().count() > 60 {
        label.push('…');
    }

    label
}

/// Checks that a note's chapter is live and answers the story it belongs to, so
/// a note can never be filed under a chapter of another story or one in the
/// trash.
fn writable_chapter(conn: &Connection, chapter_id: &str) -> DbResult<String> {
    let found = conn
        .query_row(
            "SELECT story_id, node_type, deleted_at FROM nodes WHERE id = ?1",
            params![chapter_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;

    let Some((story_id, node_type, deleted_at)) = found else {
        return Err(DbError::Invalid(
            "that chapter is no longer in this story".to_string(),
        ));
    };

    if node_type != "chapter" {
        return Err(DbError::Invalid(
            "a note can only belong to a chapter".to_string(),
        ));
    }

    if deleted_at.is_some() {
        return Err(DbError::Invalid(
            "a note cannot be added to a chapter in the trash".to_string(),
        ));
    }

    Ok(story_id)
}

/// One node as stored, live or in the trash.
fn read_node(conn: &Connection, id: &str) -> SqliteResult<Option<Node>> {
    conn.query_row(
        "SELECT id, story_id, node_type, label, content, pos_x, pos_y, created_by, created_at, updated_at, character_id, chapter_seq,
                chapter_arc, chapter_words, chapter_target, chapter_pov, chapter_day, chapter_time, parent_node_id
         FROM nodes WHERE id = ?1",
        params![id],
        node_row,
    )
    .optional()
}

/// Checks that a cast member can be linked to a node in `story_id`, and answers
/// the name the history should record. `None` needs no checks because there is
/// nothing to point at. Both the link setter and the creator go through here, so
/// a drop and a picker refusal say the same thing.
/// The name a cast id currently has, live or in the trash, for the history.
fn character_name(conn: &Connection, character_id: Option<&str>) -> DbResult<Option<String>> {
    let Some(id) = character_id else {
        return Ok(None);
    };

    Ok(conn
        .query_row(
            "SELECT name FROM characters WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

fn linkable_character_name(
    conn: &Connection,
    story_id: &str,
    character_id: Option<&str>,
) -> DbResult<Option<String>> {
    let Some(id) = character_id else {
        return Ok(None);
    };

    let (character_story, name, deleted_at) = conn
        .query_row(
            "SELECT story_id, name, deleted_at FROM characters WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            DbError::Invalid("that cast member is no longer in the database".to_string())
        })?;

    if deleted_at.is_some() {
        return Err(DbError::Invalid(
            "that cast member is in the trash; restore it before linking nodes to it".to_string(),
        ));
    }

    if character_story != story_id {
        return Err(DbError::Invalid(
            "a node can only be linked to a cast member of its own story".to_string(),
        ));
    }

    Ok(Some(name))
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

    if version < 4 {
        conn.execute_batch(MIGRATION_004)?;
    }

    if version < 5 {
        conn.execute_batch(MIGRATION_005)?;
    }

    if version < 6 {
        conn.execute_batch(MIGRATION_006)?;
    }

    if version < 7 {
        conn.execute_batch(MIGRATION_007)?;
    }

    if version < 8 {
        conn.execute_batch(MIGRATION_008)?;
    }

    if version < 9 {
        conn.execute_batch(MIGRATION_009)?;
    }

    if version < 10 {
        conn.execute_batch(MIGRATION_010)?;
    }

    if version < 11 {
        conn.execute_batch(MIGRATION_011)?;
    }

    if version < 12 {
        conn.execute_batch(MIGRATION_012)?;
    }

    if version < 13 {
        conn.execute_batch(MIGRATION_013)?;
    }

    if version < 14 {
        conn.execute_batch(MIGRATION_014)?;
    }

    if version < 15 {
        conn.execute_batch(MIGRATION_015)?;
    }

    if version < 16 {
        conn.execute_batch(MIGRATION_016)?;
    }

    if version < 17 {
        conn.execute_batch(MIGRATION_017)?;
    }

    if version < 18 {
        conn.execute_batch(MIGRATION_018)?;
    }

    if version < 19 {
        conn.execute_batch(MIGRATION_019)?;
    }

    if version < 20 {
        conn.execute_batch(MIGRATION_020)?;
    }

    if version < 21 {
        conn.execute_batch(MIGRATION_021)?;
    }

    if version < 22 {
        conn.execute_batch(MIGRATION_022)?;
    }

    if version < 23 {
        conn.execute_batch(MIGRATION_023)?;
    }

    if version < 24 {
        conn.execute_batch(MIGRATION_024)?;

        if !column_exists(conn, "character_skills", "skill_id")? {
            conn.execute(
                "ALTER TABLE character_skills ADD COLUMN skill_id TEXT
                    REFERENCES skill_definitions(id) ON DELETE CASCADE",
                [],
            )?;
        }

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_character_skills_definition
                ON character_skills (skill_id)",
            [],
        )?;

        backfill_skill_definitions(conn)?;
    }

    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;

    Ok(())
}

/// Gives every skill row that predates schema v24 a shared definition.
///
/// Rows with a card group by that card; rows without one group by their name
/// within the story. The first row in a group provides the words, and every row
/// in the group is updated to them, so the migration itself removes drift that
/// the old per-sheet copies allowed.
fn backfill_skill_definitions(conn: &Connection) -> SqliteResult<()> {
    let rows = {
        let mut stmt = conn.prepare(
            "SELECT s.id, c.story_id, s.name, s.effect, s.node_id
               FROM character_skills s
               JOIN characters c ON c.id = s.character_id
              WHERE s.skill_id IS NULL
              ORDER BY s.created_at, s.id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;

        rows.collect::<SqliteResult<Vec<_>>>()?
    };

    // Keyed by card when there is one, otherwise by folded name within the story.
    let mut known: HashMap<String, (String, String, Option<String>, Option<String>)> =
        HashMap::new();

    for (row_id, story_id, name, effect, node_id) in rows {
        let name = if name.trim().is_empty() {
            "Unnamed skill".to_string()
        } else {
            name
        };
        let key = match &node_id {
            Some(card) => format!("card:{card}"),
            None => format!("name:{}:{}", story_id, name.trim().to_lowercase()),
        };

        let definition = match known.get(&key) {
            Some(definition) => definition.clone(),
            None => {
                let existing = if let Some(card) = &node_id {
                    conn.query_row(
                        "SELECT id, name, description, node_id FROM skill_definitions
                          WHERE story_id = ?1 AND node_id = ?2",
                        params![&story_id, card],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, Option<String>>(2)?,
                                row.get::<_, Option<String>>(3)?,
                            ))
                        },
                    )
                    .optional()?
                } else {
                    conn.query_row(
                        "SELECT id, name, description, node_id FROM skill_definitions
                          WHERE story_id = ?1 AND node_id IS NULL
                            AND lower(name) = lower(?2)
                          ORDER BY created_at, id LIMIT 1",
                        params![&story_id, &name],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, Option<String>>(2)?,
                                row.get::<_, Option<String>>(3)?,
                            ))
                        },
                    )
                    .optional()?
                };

                let definition = match existing {
                    Some(definition) => definition,
                    None => {
                        let id = Uuid::new_v4().to_string();
                        let timestamp = now();

                        conn.execute(
                            "INSERT INTO skill_definitions
                             (id, story_id, name, description, node_id, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                            params![&id, &story_id, &name, &effect, &node_id, &timestamp],
                        )?;

                        (id, name.clone(), effect.clone(), node_id.clone())
                    }
                };

                known.insert(key, definition.clone());
                definition
            }
        };

        conn.execute(
            "UPDATE character_skills
                SET skill_id = ?1, name = ?2, effect = ?3, node_id = ?4
              WHERE id = ?5",
            params![
                &definition.0,
                &definition.1,
                &definition.2,
                &definition.3,
                &row_id
            ],
        )?;
    }

    Ok(())
}

/// Rows past their retention window, as `(id, story_id, label)`.
fn expired_rows(
    conn: &Connection,
    sql: &str,
    cutoff: &str,
) -> SqliteResult<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![cutoff], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    rows.collect()
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

/// Schema v5: a node can point at a cast member.
///
/// Deliberately not a foreign key: a trashed character keeps its links, so
/// restoring it brings them back, and purging one clears them explicitly. A
/// foreign key with `ON DELETE SET NULL` would also need the pragma on for every
/// connection, which this app does not rely on.
const MIGRATION_005: &str = "
    ALTER TABLE nodes ADD COLUMN character_id TEXT;
";

/// Schema v6: progression as its own fields rather than stats called "Level".
///
/// Level 1 and 0 XP are what an existing cast member starts at, which is what a
/// character created before this schema effectively was.
const MIGRATION_006: &str = "
    ALTER TABLE characters ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE characters ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE characters ADD COLUMN rank TEXT;
    ALTER TABLE characters ADD COLUMN xp_to_next INTEGER;
";

/// Schema v7: chapters get a reading order of their own.
///
/// Existing chapter nodes are numbered by the order they were created, which is
/// the only order an older story has; everyone else gets NULL, because a card
/// that is not a chapter has no place in the books.
const MIGRATION_007: &str = "
    ALTER TABLE nodes ADD COLUMN chapter_seq INTEGER;
    UPDATE nodes SET chapter_seq = (
        SELECT COUNT(*) FROM nodes earlier
        WHERE earlier.story_id = nodes.story_id
          AND earlier.node_type = 'chapter'
          AND earlier.rowid <= nodes.rowid
    ) WHERE node_type = 'chapter';
";

/// Schema v8: a chapter can name its arc and record its words against a target.
///
/// Nothing is backfilled: an older chapter has no arc and no counts until the
/// author types them, and a count of zero is not the same as no count at all.
const MIGRATION_008: &str = "
    ALTER TABLE nodes ADD COLUMN chapter_arc TEXT;
    ALTER TABLE nodes ADD COLUMN chapter_words INTEGER;
    ALTER TABLE nodes ADD COLUMN chapter_target INTEGER;
";

/// Schema v9: a chapter can name whose eyes it is told through and which
/// in-world day it happens on. Nothing is backfilled; a day of 0 is a day, not
/// an absence.
const MIGRATION_009: &str = "
    ALTER TABLE nodes ADD COLUMN chapter_pov TEXT;
    ALTER TABLE nodes ADD COLUMN chapter_day INTEGER;
";

/// Schema v10: a note belongs to a chapter.
///
/// A note is an ordinary node with `node_type = 'note'`, so the history, the
/// trash and the export already carry it. The parent is the chapter whose row it
/// is shown under. Not a foreign key, for the same reason the cast link is not:
/// a trashed chapter keeps its notes until both are purged.
const MIGRATION_010: &str = "
    ALTER TABLE nodes ADD COLUMN parent_node_id TEXT;
";

/// Schema v11: a chapter can name a time inside its in-world day.
///
/// Free text on purpose, so an author can write “Dusk”, “18:40” or “after the
/// fire” and keep their own words. Nothing is backfilled: an older chapter has
/// no time until one is typed, and a time without a day is stored as written.
const MIGRATION_011: &str = "
    ALTER TABLE nodes ADD COLUMN chapter_time TEXT;
";

/// Schema v12: a cast member's skills are rows of their own.
///
/// A skill has a name, an optional rank and effect, and optionally the chapter
/// it was learned in and the `skill` card that grants it. Both references are
/// nullable and cleared when their node is purged, so a skill outlives a deleted
/// card without pointing at a row that no longer exists.
const MIGRATION_012: &str = "
    CREATE TABLE IF NOT EXISTS character_skills (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        name TEXT NOT NULL,
        rank TEXT,
        effect TEXT,
        chapter_id TEXT,
        node_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id) REFERENCES nodes(id) ON DELETE SET NULL,
        FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE SET NULL,
        UNIQUE(character_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_character_skills_character
        ON character_skills (character_id);
";

/// Schema v13: a cast member's inventory and currencies are rows of their own.
///
/// An item has a name, an optional rarity and effect, a quantity, and optionally
/// the chapter it was acquired in and the `item` card it belongs to. Currency is
/// a named amount — gold, credits, mana crystals — with no exchange rate. Every
/// link is nullable and cleared when its node is purged, so an item outlives a
/// deleted chapter or card without pointing at a row that no longer exists.
const MIGRATION_013: &str = "
    CREATE TABLE IF NOT EXISTS character_inventory (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        name TEXT NOT NULL,
        rarity TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        effect TEXT,
        chapter_id TEXT,
        node_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id) REFERENCES nodes(id) ON DELETE SET NULL,
        FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE SET NULL,
        UNIQUE(character_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_character_inventory_character
        ON character_inventory (character_id);

    CREATE TABLE IF NOT EXISTS character_currency (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        name TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
        UNIQUE(character_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_character_currency_character
        ON character_currency (character_id);
";

/// Schema v14: an item can record the chapter in which it was lost.
///
/// The link is nullable and cleared when its chapter is purged. An item that is
/// marked lost but still carried, or lost before it was acquired, is a
/// contradiction the Chapters tab flags; the history keeps the change like any
/// other.
const MIGRATION_014: &str = "
    ALTER TABLE character_inventory
        ADD COLUMN lost_chapter_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;
";

/// Schema v18: XP earned can be recorded per character per chapter.
///
/// A row is one chapter's income, not the character's running total. The pair is
/// unique so a chapter cannot earn two separate amounts, and purging either side
/// removes the row.
const MIGRATION_018: &str = "
    CREATE TABLE IF NOT EXISTS character_progress (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        chapter_id TEXT NOT NULL,
        xp_earned INTEGER NOT NULL CHECK (xp_earned >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(character_id, chapter_id),
        FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_character_progress_character
        ON character_progress (character_id);

    CREATE INDEX IF NOT EXISTS idx_character_progress_chapter
        ON character_progress (chapter_id);
";

/// Schema v24: a skill's shared identity lives in the story, not on each sheet.
///
/// A definition owns the name and description and can point at the `skill` card
/// that represents it. A character's row keeps the rank and chapter that are
/// theirs; its name and effect are kept in step with the definition so cards,
/// sheets, history and exports all read the same words. Existing rows are
/// grouped by their card, or by name when they have none, and linked during the
/// migration.
const MIGRATION_024: &str = "\n    CREATE TABLE IF NOT EXISTS skill_definitions (\n        id TEXT PRIMARY KEY,\n        story_id TEXT NOT NULL,\n        name TEXT NOT NULL,\n        description TEXT,\n        node_id TEXT,\n        created_at TEXT NOT NULL,\n        updated_at TEXT NOT NULL,\n        FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,\n        FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE SET NULL\n    );\n\n    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_definitions_card\n        ON skill_definitions (node_id)\n        WHERE node_id IS NOT NULL;\n\n    CREATE INDEX IF NOT EXISTS idx_skill_definitions_story\n        ON skill_definitions (story_id);\n";

/// Schema v23: one skill grows from, mutates into or fuses with another.
///
/// Both ends are `character_skills` rows of the same story and are deleted with
/// them; the chapter is a link that is cleared when its card is purged. The
/// type is one of upgrade, fusion, mutation or branch, and the required rank is
/// the author's words. A skill cannot evolve into itself, and the application
/// refuses a link that would close a loop.
const MIGRATION_023: &str = "
    CREATE TABLE IF NOT EXISTS skill_evolutions (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        parent_skill_id TEXT NOT NULL,
        child_skill_id TEXT NOT NULL,
        evolution_type TEXT NOT NULL,
        chapter_id TEXT,
        required_rank TEXT,
        notes TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(parent_skill_id, child_skill_id, evolution_type),
        CHECK(parent_skill_id <> child_skill_id),
        FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_skill_id) REFERENCES character_skills(id) ON DELETE CASCADE,
        FOREIGN KEY(child_skill_id) REFERENCES character_skills(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id) REFERENCES nodes(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_evolutions_story
        ON skill_evolutions (story_id);

    CREATE INDEX IF NOT EXISTS idx_skill_evolutions_parent
        ON skill_evolutions (parent_skill_id);

    CREATE INDEX IF NOT EXISTS idx_skill_evolutions_child
        ON skill_evolutions (child_skill_id);
";

/// Schema v22: remembers which reward payouts already reached the chapter
/// ledger, so a repeat application can warn after a restart. NULL on every reward
/// written before this version, which is treated as not yet applied.
const MIGRATION_022: &str = "
    ALTER TABLE quest_rewards ADD COLUMN applied_at TEXT;
";

/// Schema v21: quests and their reward bundles.
///
/// A quest belongs to a story, names the chapter it was accepted in and
/// optionally the one it ended in, and can name a cast member and a faction that
/// issued it. Rewards are child rows with a category, an optional target (a
/// character for XP, stats and loot, a faction for standing) and free-text
/// details, so an XP amount and an item name share one honest column. Links to a
/// chapter, character or faction are nullable so a purge can clear them rather
/// than delete the record.
const MIGRATION_021: &str = "
    CREATE TABLE IF NOT EXISTS quests (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        title TEXT NOT NULL,
        giver_character_id TEXT,
        faction_node_id TEXT,
        accepted_chapter_id TEXT NOT NULL,
        completed_chapter_id TEXT,
        status TEXT NOT NULL,
        description TEXT,
        notes TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
        FOREIGN KEY(giver_character_id) REFERENCES characters(id) ON DELETE SET NULL,
        FOREIGN KEY(faction_node_id) REFERENCES nodes(id) ON DELETE SET NULL,
        -- A quest cannot be placed without the chapter it was accepted in, so
        -- purging that chapter takes the quest and its rewards with it.
        FOREIGN KEY(accepted_chapter_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY(completed_chapter_id) REFERENCES nodes(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_quests_story
        ON quests (story_id);

    CREATE INDEX IF NOT EXISTS idx_quests_accepted
        ON quests (accepted_chapter_id);

    CREATE TABLE IF NOT EXISTS quest_rewards (
        id TEXT PRIMARY KEY,
        quest_id TEXT NOT NULL,
        reward_type TEXT NOT NULL,
        target_id TEXT,
        amount_or_details TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(quest_id) REFERENCES quests(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_quest_rewards_quest
        ON quest_rewards (quest_id);
";

/// Schema v20: cast-to-cast relations and faction standings.
///
/// Relations connect two cast members in one story, with a free-text kind so the
/// author's own words survive. Symmetric kinds are stored with their ids in a
/// fixed order, and the unique index makes a second "ally" in either direction
/// impossible. A standing places one character in a faction card for an arc; the
/// faction link is nullable so purging the card clears it rather than deleting
/// the history.
const MIGRATION_020: &str = "
    CREATE TABLE IF NOT EXISTS character_relations (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        from_character_id TEXT NOT NULL,
        to_character_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        note TEXT,
        since_chapter_id TEXT,
        until_chapter_id TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (from_character_id <> to_character_id),
        FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
        FOREIGN KEY(from_character_id) REFERENCES characters(id) ON DELETE CASCADE,
        FOREIGN KEY(to_character_id) REFERENCES characters(id) ON DELETE CASCADE,
        FOREIGN KEY(since_chapter_id) REFERENCES nodes(id) ON DELETE SET NULL,
        FOREIGN KEY(until_chapter_id) REFERENCES nodes(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_character_relations_pair
        ON character_relations (from_character_id, to_character_id, kind);

    CREATE INDEX IF NOT EXISTS idx_character_relations_story
        ON character_relations (story_id);

    CREATE TABLE IF NOT EXISTS faction_standings (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        faction_node_id TEXT,
        standing TEXT NOT NULL,
        note TEXT,
        since_chapter_id TEXT,
        until_chapter_id TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
        FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
        FOREIGN KEY(faction_node_id) REFERENCES nodes(id) ON DELETE SET NULL,
        FOREIGN KEY(since_chapter_id) REFERENCES nodes(id) ON DELETE SET NULL,
        FOREIGN KEY(until_chapter_id) REFERENCES nodes(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_faction_standings_story
        ON faction_standings (story_id);

    CREATE INDEX IF NOT EXISTS idx_faction_standings_character
        ON faction_standings (character_id);
";

/// Schema v19: a level-up can award several stat increases, and a skill event
/// can name the level-up it belongs to.
///
/// The old single `stat_name`/`stat_points` pair was a snapshot, not a gain. It
/// is copied into the new child table as a value-after row, so an older story
/// keeps its chart point without inventing a gain it never recorded. New rows
/// may carry a signed amount, a resulting value, or both. Skill events keep
/// their own ledger; `milestone_id` only groups an upgrade under its level-up.
const MIGRATION_019: &str = "
    CREATE TABLE IF NOT EXISTS character_level_stat_changes (
        id TEXT PRIMARY KEY,
        milestone_id TEXT NOT NULL,
        stat_name TEXT NOT NULL,
        amount INTEGER,
        value_after INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (amount IS NOT NULL OR value_after IS NOT NULL),
        UNIQUE(milestone_id, stat_name),
        FOREIGN KEY(milestone_id) REFERENCES character_level_milestones(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_character_level_stat_changes_milestone
        ON character_level_stat_changes (milestone_id);

    INSERT INTO character_level_stat_changes
        (id, milestone_id, stat_name, amount, value_after, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), id, stat_name, NULL, stat_points,
           created_at, updated_at
    FROM character_level_milestones
    WHERE stat_name IS NOT NULL AND stat_points IS NOT NULL;

    ALTER TABLE character_skill_events
        ADD COLUMN milestone_id TEXT REFERENCES character_level_milestones(id)
            ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_character_skill_events_milestone
        ON character_skill_events (milestone_id);

    ALTER TABLE character_level_milestones DROP COLUMN stat_name;
    ALTER TABLE character_level_milestones DROP COLUMN stat_points;
";

/// Schema v17: a level milestone can also record the total XP and one primary
/// stat at that chapter.
///
/// Both are optional snapshots, not rules: the chart draws only what the author
/// recorded, and a milestone without them still means what it did before.
const MIGRATION_017: &str = "
    ALTER TABLE character_level_milestones
        ADD COLUMN xp INTEGER CHECK (xp IS NULL OR xp >= 0);
    ALTER TABLE character_level_milestones
        ADD COLUMN stat_name TEXT;
    ALTER TABLE character_level_milestones
        ADD COLUMN stat_points INTEGER;
";

/// Schema v16: more than one cast member can be present in a chapter.
///
/// The chapter's linked cast member and point of view stay single links on the
/// node. This table adds the rest of the scene's cast, one live character per
/// chapter, and cascades when either side is purged.
const MIGRATION_016: &str = "
    CREATE TABLE IF NOT EXISTS chapter_cast (
        id TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(chapter_id, character_id),
        FOREIGN KEY(chapter_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chapter_cast_chapter
        ON chapter_cast (chapter_id);

    CREATE INDEX IF NOT EXISTS idx_chapter_cast_character
        ON chapter_cast (character_id);
";

/// Schema v15: progression can be placed in the reading order.
///
/// A level milestone records the level a character had in a chapter, with a
/// penalty flag for a deliberately lower level. A skill event records an
/// upgrade, a use or a sacrifice against a chapter, so acquisition and later
/// changes can be compared in reading order. Both chapter links are nullable
/// and cleared when their chapter is purged.
const MIGRATION_015: &str = "
    CREATE TABLE IF NOT EXISTS character_level_milestones (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        level INTEGER NOT NULL CHECK (level >= 1),
        chapter_id TEXT,
        is_debuff INTEGER NOT NULL DEFAULT 0 CHECK (is_debuff IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id) REFERENCES nodes(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_character_level_milestones_character
        ON character_level_milestones (character_id);

    CREATE TABLE IF NOT EXISTS character_skill_events (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('upgraded', 'sacrificed', 'used')),
        chapter_id TEXT,
        rank TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(skill_id) REFERENCES character_skills(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id) REFERENCES nodes(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_character_skill_events_skill
        ON character_skill_events (skill_id);
";

/// Schema v4: app-wide settings, starting with how long the trash is kept.
///
/// A table rather than a config file, so the setting travels with the database,
/// is covered by the launch snapshot, and cannot drift out of step with what is
/// actually in the trash.
const MIGRATION_004: &str = "
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
    fn a_demo_story_arrives_with_a_cast_and_an_intentional_xp_gap() {
        let db = Db::open_in_memory().unwrap();

        let story = db.create_demo_story("Ada".into()).unwrap();

        assert_eq!(story.title, "The Ember Ledger (Demo)");
        assert!(story
            .description
            .as_deref()
            .is_some_and(|description| description.contains("intentionally 100 XP short")));

        let characters = db.list_characters(&story.id).unwrap();
        assert_eq!(characters.len(), 2);
        let rook = characters
            .iter()
            .find(|character| character.name == "Rook Valebright")
            .expect("Rook is in the demo cast");
        let mira = characters
            .iter()
            .find(|character| character.name == "Mira Sable")
            .expect("Mira is in the demo cast");

        let chapters: Vec<_> = db
            .list_nodes(&story.id)
            .unwrap()
            .into_iter()
            .filter(|node| node.node_type == "chapter")
            .collect();
        assert_eq!(chapters.len(), 3);
        assert_eq!(
            chapters
                .iter()
                .map(|chapter| chapter.chapter_seq)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(3)]
        );
        assert_eq!(chapters[0].chapter_pov.as_deref(), Some(rook.id.as_str()));
        assert_eq!(chapters[1].chapter_pov.as_deref(), Some(mira.id.as_str()));
        assert_eq!(chapters[2].chapter_pov.as_deref(), Some(rook.id.as_str()));
        assert_eq!(chapters[2].chapter_arc.as_deref(), Some("Confrontation"));

        let milestones = db.list_story_level_milestones(&story.id).unwrap();
        assert_eq!(milestones.len(), 6);
        let mira_total = milestones
            .iter()
            .find(|milestone| {
                milestone.character_id == mira.id
                    && milestone.chapter_id.as_deref() == Some(chapters[2].id.as_str())
            })
            .expect("Mira's last total is recorded");
        assert_eq!(mira_total.xp, Some(1500));

        // A demo level-up carries every stat it awarded, not one summary row.
        let rook_last = milestones
            .iter()
            .find(|milestone| {
                milestone.character_id == rook.id
                    && milestone.chapter_id.as_deref() == Some(chapters[2].id.as_str())
            })
            .expect("Rook's last level is recorded");
        assert_eq!(rook_last.level, 4);
        assert_eq!(rook_last.stat_changes.len(), 3);
        assert!(rook_last
            .stat_changes
            .iter()
            .any(|change| change.stat_name == "Agility"
                && change.amount == Some(1)
                && change.value_after == Some(12)));

        let upgrade = db
            .list_story_skill_events(&story.id)
            .unwrap()
            .into_iter()
            .find(|event| event.kind == "upgraded")
            .expect("Ash Step is upgraded in the demo");
        assert_eq!(upgrade.milestone_id.as_deref(), Some(rook_last.id.as_str()));

        let progress = db.list_story_character_progress(&story.id).unwrap();
        assert_eq!(progress.len(), 6);
        let mira_income: i64 = progress
            .iter()
            .filter(|entry| entry.character_id == mira.id)
            .map(|entry| entry.xp_earned)
            .sum();
        assert_eq!(mira_income, 1400, "the demo leaves a 100 XP mismatch");
        let rook_income: i64 = progress
            .iter()
            .filter(|entry| entry.character_id == rook.id)
            .map(|entry| entry.xp_earned)
            .sum();
        assert_eq!(rook_income, 2400);

        assert_eq!(db.list_story_skills(&story.id).unwrap().len(), 2);
        assert_eq!(db.list_story_chapter_cast(&story.id).unwrap().len(), 3);
        assert_eq!(db.list_story_stats(&story.id).unwrap().len(), 6);
    }

    #[test]
    fn a_demo_story_can_be_reset_in_place() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_demo_story("Ada".into()).unwrap();
        let original_created_at = story.created_at.clone();

        // Change the demo the way a trial run would: more cast, another chapter,
        // and a hand-edited ledger amount.
        db.create_character(story.id.clone(), "Trespasser".into(), None, "Ada".into())
            .unwrap();
        db.create_node(
            story.id.clone(),
            "chapter".into(),
            "Stray chapter".into(),
            None,
            1.0,
            2.0,
            "Ada".into(),
        )
        .unwrap();
        let edited = db.list_story_character_progress(&story.id).unwrap()[0].clone();
        db.update_character_progress(edited.id, edited.chapter_id, 9999, "Ada".into())
            .unwrap();

        let reset = db.reset_demo_story(&story.id, "Grace".into()).unwrap();

        assert_eq!(reset.id, story.id, "the story is rebuilt in place");
        assert_eq!(reset.title, DEMO_STORY_TITLE);
        assert_eq!(reset.created_at, original_created_at);
        assert!(reset
            .description
            .as_deref()
            .is_some_and(|description| description.contains("intentionally 100 XP short")));

        let characters = db.list_characters(&story.id).unwrap();
        assert_eq!(characters.len(), 2);
        assert!(characters
            .iter()
            .all(|character| character.name != "Trespasser"));

        let nodes = db.list_nodes(&story.id).unwrap();
        assert_eq!(nodes.len(), 3);
        assert!(nodes.iter().all(|node| node.label != "Stray chapter"));

        let progress = db.list_story_character_progress(&story.id).unwrap();
        assert_eq!(progress.len(), 6);
        let mira = characters
            .iter()
            .find(|character| character.name == "Mira Sable")
            .expect("Mira is back in the demo cast");
        let mira_income: i64 = progress
            .iter()
            .filter(|entry| entry.character_id == mira.id)
            .map(|entry| entry.xp_earned)
            .sum();
        assert_eq!(mira_income, 1400, "the intentional XP gap is back");

        assert_eq!(db.list_story_level_milestones(&story.id).unwrap().len(), 6);
        assert_eq!(db.list_story_skills(&story.id).unwrap().len(), 2);
        assert_eq!(db.list_story_chapter_cast(&story.id).unwrap().len(), 3);
        assert_eq!(db.list_story_stats(&story.id).unwrap().len(), 6);

        // The trial run's history went with the data it described, and the reset
        // itself is recorded under the person who asked for it.
        let history = db.get_audit_log(Some(&story.id), None, None, 1000).unwrap();
        assert!(history
            .iter()
            .any(|entry| entry.action == "reset" && entry.changed_by == "Grace"));
        assert!(history.iter().all(|entry| entry.changed_by == "Grace"));
    }

    #[test]
    fn only_the_demo_story_can_be_reset() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("A real story".into(), None, "Ada".into())
            .unwrap();

        let error = db.reset_demo_story(&story.id, "Grace".into()).unwrap_err();

        assert!(matches!(error, DbError::Invalid(_)));
        assert!(db.get_story(&story.id).unwrap().is_some());
    }

    #[test]
    fn an_export_round_trips_into_a_new_story() {
        let source = Db::open_in_memory().unwrap();
        let story = source
            .create_story("Ash".into(), Some("notes".into()), "Ada".into())
            .unwrap();
        let character = source
            .create_character(
                story.id.clone(),
                "Rook".into(),
                Some("Scout".into()),
                "Ada".into(),
            )
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
        assert_eq!(
            history.len(),
            history_before + 1,
            "history plus the import entry"
        );
        assert!(history
            .iter()
            .all(|entry| entry.story_id.as_deref() == Some(&restored.id)));
        assert!(history
            .iter()
            .any(|entry| entry.entity_type == "character" && entry.entity_id == characters[0].id));
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
        assert_eq!(
            two.title, "Ash (imported)",
            "the copy gets a distinct title"
        );
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
        assert!(target
            .list_attributes(&characters[0].id)
            .unwrap()
            .is_empty());
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
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
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
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
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

        db.delete_attribute(&attribute.id, "Grace".into()).unwrap();
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
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
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
            .create_node(
                story.id.clone(),
                "idea".into(),
                "Hook".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
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
            .create_node(
                story.id.clone(),
                "idea".into(),
                "A".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let other = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "B".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
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
        db.create_node(
            story.id.clone(),
            "idea".into(),
            "Hook".into(),
            None,
            0.0,
            0.0,
            "Ada".into(),
        )
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
        let story = db
            .create_story("Doomed".into(), None, "Ada".into())
            .unwrap();
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
            .create_node(
                story.id.clone(),
                "idea".into(),
                "Live".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
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
            .create_node(
                story.id.clone(),
                "idea".into(),
                "A".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let to = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "B".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let edge = db
            .create_edge(
                story.id.clone(),
                from.id.clone(),
                to.id.clone(),
                None,
                None,
                "Ada".into(),
            )
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

        assert_eq!(
            db.get_audit_log(None, None, None, 100).unwrap().len(),
            before
        );
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
            .query_row(
                "SELECT deleted_at FROM stories WHERE id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(deleted_at, None, "a migrated row starts live");
        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }
    #[test]
    fn migrating_a_version_11_database_adds_skills_without_losing_data() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        conn.pragma_update(None, "user_version", 11).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES ('s1', 'Written before v12', NULL, 'then', 'then')",
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
            "INSERT INTO character_skills
             (id, character_id, name, rank, effect, created_at, updated_at)
             VALUES ('k1', 'c1', 'Fireball', 'Rank 1', NULL, 'now', 'now')",
            [],
        )
        .unwrap();

        let title: String = conn
            .query_row("SELECT title FROM stories WHERE id = 's1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "Written before v12", "existing rows are untouched");
    }

    #[test]
    fn migrating_a_version_12_database_adds_inventory_and_currency() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        conn.execute_batch(MIGRATION_002).unwrap();
        for block in [
            MIGRATION_003,
            MIGRATION_004,
            MIGRATION_005,
            MIGRATION_006,
            MIGRATION_007,
            MIGRATION_008,
            MIGRATION_009,
            MIGRATION_010,
            MIGRATION_011,
            MIGRATION_012,
        ] {
            conn.execute_batch(block).unwrap();
        }
        conn.pragma_update(None, "user_version", 12).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES ('s1', 'Written before v13', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO characters (id, story_id, name, description, created_at, updated_at)
             VALUES ('c1', 's1', 'Rook', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO character_skills (id, character_id, name, created_at, updated_at)
             VALUES ('k1', 'c1', 'Fireball', 'then', 'then')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // The new tables exist: these inserts are the assertion.
        conn.execute(
            "INSERT INTO character_inventory
             (id, character_id, name, rarity, quantity, created_at, updated_at)
             VALUES ('i1', 'c1', 'Iron Sword', 'Rare', 2, 'now', 'now')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO character_currency (id, character_id, name, amount, created_at, updated_at)
             VALUES ('m1', 'c1', 'Gold', 250, 'now', 'now')",
            [],
        )
        .unwrap();

        let skills: i64 = conn
            .query_row("SELECT count(*) FROM character_skills", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(skills, 1, "the skill that was there is untouched");
        let title: String = conn
            .query_row("SELECT title FROM stories WHERE id = 's1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "Written before v13");
    }

    #[test]
    fn migrating_a_version_13_database_adds_the_lost_chapter() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        conn.execute_batch(MIGRATION_002).unwrap();
        for block in [
            MIGRATION_003,
            MIGRATION_004,
            MIGRATION_005,
            MIGRATION_006,
            MIGRATION_007,
            MIGRATION_008,
            MIGRATION_009,
            MIGRATION_010,
            MIGRATION_011,
            MIGRATION_012,
            MIGRATION_013,
        ] {
            conn.execute_batch(block).unwrap();
        }
        conn.pragma_update(None, "user_version", 13).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES ('s1', 'Written before v14', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO characters (id, story_id, name, description, created_at, updated_at)
             VALUES ('c1', 's1', 'Rook', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO nodes (id, story_id, node_type, label, pos_x, pos_y, created_by, created_at, updated_at)
             VALUES ('n1', 's1', 'chapter', 'Chapter One', 0, 0, 'Ada', 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO character_inventory
             (id, character_id, name, rarity, quantity, created_at, updated_at)
             VALUES ('i1', 'c1', 'Iron Sword', 'Rare', 2, 'now', 'now')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let lost: Option<String> = conn
            .query_row(
                "SELECT lost_chapter_id FROM character_inventory WHERE id = 'i1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(lost, None, "an existing item starts without a lost chapter");

        conn.execute(
            "UPDATE character_inventory SET lost_chapter_id = 'n1' WHERE id = 'i1'",
            [],
        )
        .unwrap();
        let name: String = conn
            .query_row(
                "SELECT name FROM character_inventory WHERE id = 'i1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "Iron Sword", "the item itself is untouched");
    }

    #[test]
    fn migrating_a_version_14_database_adds_level_and_skill_progression() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        conn.execute_batch(MIGRATION_002).unwrap();
        for block in [
            MIGRATION_003,
            MIGRATION_004,
            MIGRATION_005,
            MIGRATION_006,
            MIGRATION_007,
            MIGRATION_008,
            MIGRATION_009,
            MIGRATION_010,
            MIGRATION_011,
            MIGRATION_012,
            MIGRATION_013,
            MIGRATION_014,
        ] {
            conn.execute_batch(block).unwrap();
        }
        conn.pragma_update(None, "user_version", 14).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES ('s1', 'Written before v15', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO characters (id, story_id, name, description, created_at, updated_at)
             VALUES ('c1', 's1', 'Rook', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO nodes (id, story_id, node_type, label, pos_x, pos_y, created_by, created_at, updated_at)
             VALUES ('n1', 's1', 'chapter', 'Chapter One', 0, 0, 'Ada', 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO character_skills (id, character_id, name, rank, created_at, updated_at)
             VALUES ('k1', 'c1', 'Fireball', 'Rank 1', 'then', 'then')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // The new tables exist: these inserts are the assertion.
        conn.execute(
            "INSERT INTO character_level_milestones
             (id, character_id, level, chapter_id, is_debuff, created_at, updated_at)
             VALUES ('m1', 'c1', 3, 'n1', 0, 'now', 'now')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO character_skill_events
             (id, skill_id, kind, chapter_id, rank, created_at, updated_at)
             VALUES ('e1', 'k1', 'upgraded', 'n1', 'Rank 2', 'now', 'now')",
            [],
        )
        .unwrap();

        let skills: i64 = conn
            .query_row("SELECT count(*) FROM character_skills", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(skills, 1, "the skill that was there is untouched");
        let title: String = conn
            .query_row("SELECT title FROM stories WHERE id = 's1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "Written before v15");
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
        let second = db
            .create_story("Second".into(), None, "Ada".into())
            .unwrap();
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

            assert_eq!(
                page.total, 5,
                "the total describes the filter, not the window"
            );

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
        let second = db
            .create_story("Second".into(), None, "Ada".into())
            .unwrap();
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
    fn a_version_22_database_gains_the_evolution_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&conn).unwrap();

        // Simulate a file written before skill evolutions existed.
        conn.execute_batch("DROP TABLE skill_evolutions; PRAGMA user_version = 22;")
            .unwrap();

        migrate(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 24);

        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                  WHERE type = 'table' AND name = 'skill_evolutions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1, "the migration created the table");

        let skill_links: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_list('skill_evolutions')
                  WHERE \"table\" = 'character_skills' AND on_delete = 'CASCADE'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(skill_links, 2, "both ends cascade with their skill");
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
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
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
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
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
    fn editing_a_skill_card_updates_every_holder_name_and_effect() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let card = db
            .create_node(
                story.id.clone(),
                "skill".into(),
                "Frost Touch".into(),
                Some("A cold touch.".into()),
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let rook = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let mira = db
            .create_character(story.id.clone(), "Mira".into(), None, "Ada".into())
            .unwrap();
        let rook_skill = db
            .add_skill(
                rook.id.clone(),
                "Frost Touch".into(),
                Some("Rank 1".into()),
                Some("A cold touch.".into()),
                None,
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();
        let mira_skill = db
            .add_skill(
                mira.id.clone(),
                "Frost Touch".into(),
                Some("Rank 2".into()),
                Some("Mira's own wording.".into()),
                None,
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();

        db.update_node(
            &card.id,
            "Chill Touch".into(),
            Some("A deeper cold.".into()),
            "Grace".into(),
        )
        .unwrap();

        let skills = db.list_story_skills(&story.id).unwrap();
        let rook_after = skills
            .iter()
            .find(|skill| skill.id == rook_skill.id)
            .unwrap();
        let mira_after = skills
            .iter()
            .find(|skill| skill.id == mira_skill.id)
            .unwrap();

        for (skill, rank) in [(rook_after, "Rank 1"), (mira_after, "Rank 2")] {
            assert_eq!(skill.name, "Chill Touch");
            assert_eq!(skill.effect.as_deref(), Some("A deeper cold."));
            assert_eq!(skill.rank.as_deref(), Some(rank));
            assert_eq!(skill.node_id.as_deref(), Some(card.id.as_str()));
        }

        let updates = db
            .get_audit_log(Some(&story.id), Some("character_skill"), None, 100)
            .unwrap()
            .into_iter()
            .filter(|entry| entry.action == "update")
            .collect::<Vec<_>>();
        assert_eq!(updates.len(), 4, "a name and an effect for each holder");
        assert!(updates.iter().any(|entry| {
            entry.entity_id == rook_skill.id
                && entry.field_changed.as_deref() == Some("name")
                && entry.old_value.as_deref() == Some("Frost Touch")
                && entry.new_value.as_deref() == Some("Chill Touch")
        }));
        assert!(updates.iter().any(|entry| {
            entry.entity_id == mira_skill.id
                && entry.field_changed.as_deref() == Some("effect")
                && entry.old_value.as_deref() == Some("A cold touch.")
                && entry.new_value.as_deref() == Some("A deeper cold.")
        }));
    }

    #[test]
    fn a_skill_card_rename_that_collides_leaves_the_card_and_holders_alone() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let card = db
            .create_node(
                story.id.clone(),
                "skill".into(),
                "Frost Touch".into(),
                Some("A cold touch.".into()),
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let rook = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        db.add_skill(
            rook.id.clone(),
            "Frost Touch".into(),
            None,
            Some("A cold touch.".into()),
            None,
            Some(card.id.clone()),
            "Ada".into(),
        )
        .unwrap();
        db.add_skill(
            rook.id.clone(),
            "Ice Lance".into(),
            None,
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        let refused = db.update_node(
            &card.id,
            "Ice Lance".into(),
            Some("A colder touch.".into()),
            "Grace".into(),
        );

        assert!(refused.is_err());
        assert!(refused
            .unwrap_err()
            .to_string()
            .contains("already has a skill named Ice Lance"));

        let stored_card = db
            .list_nodes(&story.id)
            .unwrap()
            .into_iter()
            .find(|node| node.id == card.id)
            .unwrap();
        assert_eq!(stored_card.label, "Frost Touch");
        assert_eq!(stored_card.content.as_deref(), Some("A cold touch."));

        let skills = db.list_story_skills(&story.id).unwrap();
        let linked = skills
            .iter()
            .find(|skill| skill.node_id.as_deref() == Some(card.id.as_str()))
            .unwrap();
        assert_eq!(linked.name, "Frost Touch");
        assert_eq!(linked.effect.as_deref(), Some("A cold touch."));
    }

    #[test]
    fn a_sheet_edit_updates_the_card_and_every_other_holder() {
        let (db, story, rook, chapter, card) = skill_story();
        let mira = db
            .create_character(story.id.clone(), "Mira".into(), None, "Ada".into())
            .unwrap();

        let rook_skill = db
            .add_skill(
                rook.id.clone(),
                "Frost Touch".into(),
                Some("Rank 1".into()),
                Some("A cold touch.".into()),
                Some(chapter.id.clone()),
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();
        let mira_skill = db
            .add_skill(
                mira.id.clone(),
                "Frost Touch".into(),
                Some("Rank 4".into()),
                Some("Mira's own wording.".into()),
                None,
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();

        // Editing one sheet is an edit to the shared skill: the card and the
        // other holder follow, while each holder keeps its own rank and chapter.
        db.update_skill(
            rook_skill.id.clone(),
            "Chill Touch".into(),
            Some("Rank 2".into()),
            Some("A deeper cold.".into()),
            Some(chapter.id.clone()),
            Some(card.id.clone()),
            "Ada".into(),
        )
        .unwrap();

        let skills = db.list_story_skills(&story.id).unwrap();
        let rook_after = skills
            .iter()
            .find(|skill| skill.id == rook_skill.id)
            .unwrap();
        let mira_after = skills
            .iter()
            .find(|skill| skill.id == mira_skill.id)
            .unwrap();

        for skill in [rook_after, mira_after] {
            assert_eq!(skill.name, "Chill Touch");
            assert_eq!(skill.effect.as_deref(), Some("A deeper cold."));
            assert_eq!(skill.node_id.as_deref(), Some(card.id.as_str()));
        }
        assert_eq!(rook_after.rank.as_deref(), Some("Rank 2"));
        assert_eq!(mira_after.rank.as_deref(), Some("Rank 4"));
        assert_eq!(mira_after.chapter_id, None);

        let stored_card = db
            .list_nodes(&story.id)
            .unwrap()
            .into_iter()
            .find(|node| node.id == card.id)
            .unwrap();
        assert_eq!(stored_card.label, "Chill Touch");
        assert_eq!(stored_card.content.as_deref(), Some("A deeper cold."));
    }

    #[test]
    fn a_sheet_edit_without_a_card_still_reaches_the_other_holders() {
        let (db, story, rook, _, _) = skill_story();
        let mira = db
            .create_character(story.id.clone(), "Mira".into(), None, "Ada".into())
            .unwrap();

        let rook_skill = db
            .add_skill(
                rook.id.clone(),
                "Tracking".into(),
                None,
                Some("Reads tracks.".into()),
                None,
                None,
                "Ada".into(),
            )
            .unwrap();
        let mira_skill = db
            .add_skill(
                mira.id.clone(),
                "tracking".into(),
                None,
                Some("Different words.".into()),
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        // The name is the identity when there is no card, and the first wording
        // is the canonical one rather than whichever sheet was edited last.
        assert_eq!(mira_skill.name, "Tracking");
        assert_eq!(mira_skill.effect.as_deref(), Some("Reads tracks."));

        db.update_skill(
            mira_skill.id.clone(),
            "Trailcraft".into(),
            None,
            Some("Follows a trail.".into()),
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        let skills = db.list_story_skills(&story.id).unwrap();
        for skill in &skills {
            assert_eq!(skill.name, "Trailcraft");
            assert_eq!(skill.effect.as_deref(), Some("Follows a trail."));
        }
        assert!(skills.iter().any(|skill| skill.id == rook_skill.id));
    }

    #[test]
    fn deleting_a_node_hides_its_edges_and_records_both() {
        let db = Db::open_in_memory().unwrap();

        let story = db.create_story("Prune".into(), None, "Ada".into()).unwrap();
        let first = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "First".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let second = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "Second".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
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
        assert!(deletes.iter().any(
            |entry| entry.entity_type == "node" && entry.old_value.as_deref() == Some("First")
        ));
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
        db.delete_edge("does-not-exist".into(), "Ada".into())
            .unwrap();
        db.delete_node("does-not-exist".into(), "Ada".into())
            .unwrap();
        db.delete_story("does-not-exist".into(), "Ada".into())
            .unwrap();

        assert_eq!(
            db.get_audit_log(None, None, None, 100).unwrap().len(),
            before
        );
        assert_eq!(db.list_stories().unwrap().len(), 1);
        assert_eq!(db.list_stories().unwrap()[0].id, story.id);
    }

    #[test]
    fn deleting_an_edge_records_it_and_puts_it_in_the_trash() {
        let db = Db::open_in_memory().unwrap();

        let story = db.create_story("Cut".into(), None, "Ada".into()).unwrap();
        let node = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "A".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let other = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "B".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
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
            .create_node(
                story.id.clone(),
                "idea".into(),
                "A".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let to = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "B".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
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
        assert!(history.iter().any(|entry| entry.field_changed.as_deref()
            == Some("relation_type")
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
            .create_node(
                story.id.clone(),
                "idea".into(),
                "A".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let to = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "B".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
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
        let story = db
            .create_story("Untitled".into(), None, "Ada".into())
            .unwrap();

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
        assert_eq!(
            db.get_audit_log(None, None, None, 100).unwrap().len(),
            before
        );
    }

    #[test]
    fn deleting_a_story_hides_its_contents_but_keeps_the_history() {
        let db = Db::open_in_memory().unwrap();

        let story = db
            .create_story("Doomed".into(), None, "Ada".into())
            .unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        db.add_or_update_stat(character.id.clone(), "Level".into(), 3, None, "Ada".into())
            .unwrap();
        let node = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "Hook".into(),
                None,
                1.0,
                1.0,
                "Ada".into(),
            )
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
            history.iter().any(|entry| entry.entity_type == "story"
                && entry.action == "soft_delete"
                && entry.changed_by == "Grace"),
            "the deletion itself is recorded"
        );
        assert!(history.len() > 1, "earlier history survives the deletion");

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
        let second = db
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
        db.create_node(
            other.id.clone(),
            "idea".into(),
            "Nope".into(),
            None,
            0.0,
            0.0,
            "Ada".into(),
        )
        .unwrap();

        let export = db.export_story(&story.id).unwrap();

        assert_eq!(export.story.id, story.id);
        assert_eq!(export.story.description.as_deref(), Some("notes"));
        assert_eq!(export.characters.len(), 1);
        assert_eq!(export.character_stats.len(), 1);
        assert_eq!(
            export.character_attributes.len(),
            1,
            "text attributes travel too"
        );
        assert_eq!(export.character_attributes[0].value, "Rogue");
        assert_eq!(export.nodes.len(), 2);
        assert_eq!(export.edges.len(), 1);
        assert!(!export.audit_trail.is_empty());
        assert!(
            export
                .audit_trail
                .iter()
                .all(|entry| entry.story_id.as_deref() == Some(&story.id)),
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
            .create_character(
                story.id.clone(),
                "Rook".into(),
                Some("Scout".into()),
                "Ada".into(),
            )
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

        assert_eq!(
            changes.len(),
            2,
            "name and description are separate entries"
        );
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
        assert_eq!(
            db.get_audit_log(None, None, None, 100).unwrap().len(),
            before
        );
    }

    #[test]
    fn a_deleted_character_takes_its_stats_off_the_board() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Cast".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        db.add_or_update_stat(
            character.id.clone(),
            "Level".into(),
            3,
            Some("from the raid".into()),
            "Ada".into(),
        )
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
        assert_eq!(
            db.get_audit_log(None, None, None, 100).unwrap().len(),
            before
        );
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

    fn backup_scratch(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("litrpg-backups-{name}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("storyboard.db");
        (dir, path)
    }

    #[test]
    fn lists_this_database_s_backups_newest_first() {
        let (_dir, path) = backup_scratch("list");
        let db = Db::open(&path).unwrap();
        db.create_story("Ledger".into(), None, "Ada".into())
            .unwrap();

        let first = snapshots::snapshot(&path, 10).unwrap().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let second = snapshots::snapshot(&path, 10).unwrap().unwrap();

        // The folder is the user's, so something else in it is not a backup.
        std::fs::write(snapshots::snapshot_dir(&path).join("notes.txt"), "mine").unwrap();

        let backups = db.list_backups().unwrap();
        let names: Vec<&str> = backups
            .iter()
            .map(|backup| backup.file_name.as_str())
            .collect();

        assert_eq!(
            names,
            vec![
                second.file_name().unwrap().to_str().unwrap(),
                first.file_name().unwrap().to_str().unwrap(),
            ]
        );
        assert!(backups.iter().all(|backup| backup.size_bytes > 0));
        assert!(backups.iter().all(|backup| !backup.created_at.is_empty()));
    }

    #[test]
    fn restoring_a_copy_replaces_the_contents_and_copies_what_it_replaced() {
        let (_dir, path) = backup_scratch("restore");
        let db = Db::open(&path).unwrap();
        db.create_story("One".into(), None, "Ada".into()).unwrap();

        let copy = snapshots::snapshot(&path, 10).unwrap().unwrap();
        let file_name = copy.file_name().unwrap().to_str().unwrap().to_string();

        db.create_story("Two".into(), None, "Ada".into()).unwrap();
        assert_eq!(db.list_stories().unwrap().len(), 2);

        db.restore_backup(&file_name, 10).unwrap();

        let stories = db.list_stories().unwrap();
        assert_eq!(stories.len(), 1);
        assert_eq!(stories[0].title, "One");

        // The state that was replaced was copied before it went, so the restore
        // can itself be walked back from the same dialog.
        assert!(db.list_backups().unwrap().len() >= 2);
    }

    #[test]
    fn refuses_foreign_names_and_files_that_are_not_databases() {
        let (_dir, path) = backup_scratch("refuse");
        let db = Db::open(&path).unwrap();
        db.create_story("Kept".into(), None, "Ada".into()).unwrap();

        // No directory parts, and only names this app writes.
        assert!(matches!(
            db.restore_backup("../storyboard.db", 10),
            Err(DbError::Invalid(_))
        ));
        assert!(db.restore_backup("storyboard.db", 10).is_err());

        let folder = snapshots::snapshot_dir(&path);
        std::fs::create_dir_all(&folder).unwrap();

        let corrupt = folder.join("storyboard-corrupt.db");
        std::fs::write(&corrupt, "this is not a database").unwrap();

        assert!(db.restore_backup("storyboard-corrupt.db", 10).is_err());

        // Nothing was replaced, and the failed attempt left no staging file.
        assert_eq!(db.list_stories().unwrap().len(), 1);
        assert!(!path.with_extension("restoring").exists());
    }

    #[test]
    fn an_older_database_gains_progression_defaults() {
        let dir = std::env::temp_dir().join(format!("litrpg-migrate6-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("storyboard.db");

        // Built at v5, the shape the previous release wrote, with a character in
        // it that predates level and XP.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(BASE_SCHEMA).unwrap();
            conn.execute_batch(INDEXES).unwrap();
            conn.execute_batch(MIGRATION_002).unwrap();
            conn.execute_batch(MIGRATION_003).unwrap();
            conn.execute_batch(MIGRATION_004).unwrap();
            conn.execute_batch(MIGRATION_005).unwrap();
            conn.pragma_update(None, "user_version", 5).unwrap();

            conn.execute(
                "INSERT INTO stories (id, title, description, created_at, updated_at)
                 VALUES ('s1', 'Old', NULL, 'then', 'then')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO characters (id, story_id, name, description, created_at, updated_at)
                 VALUES ('c1', 's1', 'Rook', NULL, 'then', 'then')",
                [],
            )
            .unwrap();
        }

        let db = Db::open(&path).unwrap();

        let version: i32 = db
            .conn()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let characters = db.list_characters("s1").unwrap();
        assert_eq!(characters[0].level, 1);
        assert_eq!(characters[0].xp, 0);
        assert_eq!(characters[0].rank, None);
        assert_eq!(characters[0].xp_to_next, None);
    }

    #[test]
    fn an_older_database_numbers_its_chapters_in_the_order_they_were_made() {
        let dir = std::env::temp_dir().join(format!("litrpg-migrate7-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("storyboard.db");

        // Built at v6, before chapters had a reading order.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(BASE_SCHEMA).unwrap();
            conn.execute_batch(INDEXES).unwrap();
            conn.execute_batch(MIGRATION_002).unwrap();
            conn.execute_batch(MIGRATION_003).unwrap();
            conn.execute_batch(MIGRATION_004).unwrap();
            conn.execute_batch(MIGRATION_005).unwrap();
            conn.execute_batch(MIGRATION_006).unwrap();
            conn.pragma_update(None, "user_version", 6).unwrap();

            conn.execute(
                "INSERT INTO stories (id, title, description, created_at, updated_at)
                 VALUES ('s1', 'Old', NULL, 'then', 'then')",
                [],
            )
            .unwrap();

            // Created out of order on the calendar, but made first and third: the
            // reading order follows the making, which is the order the old board
            // showed them in.
            for (id, node_type, label, created_at) in [
                ("n1", "chapter", "One", "2026-01-09"),
                ("n2", "idea", "Idea", "2026-01-02"),
                ("n3", "chapter", "Two", "2026-01-01"),
            ] {
                conn.execute(
                    "INSERT INTO nodes (id, story_id, node_type, label, content, pos_x, pos_y,
                                        created_by, created_at, updated_at)
                     VALUES (?1, 's1', ?2, ?3, NULL, 0, 0, 'Ada', ?4, ?4)",
                    params![id, node_type, label, created_at],
                )
                .unwrap();
            }
        }

        let db = Db::open(&path).unwrap();
        let nodes = db.list_nodes("s1").unwrap();
        let sequence = |id: &str| {
            nodes
                .iter()
                .find(|node| node.id == id)
                .and_then(|node| node.chapter_seq)
        };

        assert_eq!(sequence("n1"), Some(1));
        assert_eq!(sequence("n3"), Some(2));
        assert_eq!(
            sequence("n2"),
            None,
            "only a chapter has a place in the book"
        );

        // v8 adds the arc and the counts; an old chapter starts without either.
        for node in &nodes {
            assert_eq!(node.chapter_arc, None);
            assert_eq!(node.chapter_words, None);
            assert_eq!(node.chapter_target, None);
        }
    }

    #[test]
    fn chapters_join_the_end_and_are_reordered_as_a_whole() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ledger".into(), None, "Ada".into())
            .unwrap();

        let make = |label: &str, node_type: &str| {
            db.create_node(
                story.id.clone(),
                node_type.into(),
                label.into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap()
        };

        let one = make("One", "chapter");
        let idea = make("Idea", "idea");
        let two = make("Two", "chapter");
        let three = make("Three", "chapter");

        assert_eq!(one.chapter_seq, Some(1));
        assert_eq!(two.chapter_seq, Some(2));
        assert_eq!(three.chapter_seq, Some(3));
        assert_eq!(idea.chapter_seq, None);

        let reordered = db
            .set_chapter_order(
                &story.id,
                vec![two.id.clone(), one.id.clone(), three.id.clone()],
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(
            reordered
                .iter()
                .map(|node| (node.label.as_str(), node.chapter_seq))
                .collect::<Vec<_>>(),
            vec!["Two", "One", "Three"]
                .into_iter()
                .zip([Some(1), Some(2), Some(3)])
                .collect::<Vec<_>>()
        );

        let page = db
            .get_audit_page(Some(&story.id), Some("node"), Some(&one.id), 50, 0)
            .unwrap();
        let moved = page
            .entries
            .iter()
            .find(|entry| entry.field_changed.as_deref() == Some("chapter_seq"))
            .expect("the move should be recorded");
        assert_eq!(moved.old_value.as_deref(), Some("1"));
        assert_eq!(moved.new_value.as_deref(), Some("2"));

        // A partial, doubled or foreign list is refused whole rather than leaving
        // the numbers half-written.
        assert!(db
            .set_chapter_order(&story.id, vec![one.id.clone()], "Ada".into())
            .is_err());
        assert!(db
            .set_chapter_order(
                &story.id,
                vec![two.id.clone(), one.id.clone(), one.id.clone()],
                "Ada".into()
            )
            .is_err());
        assert!(db
            .set_chapter_order(
                &story.id,
                vec![two.id.clone(), one.id.clone(), idea.id.clone()],
                "Ada".into()
            )
            .is_err());

        let chapters = db
            .list_nodes(&story.id)
            .unwrap()
            .into_iter()
            .filter(|node| node.node_type == "chapter")
            .map(|node| node.label)
            .collect::<Vec<_>>();
        assert_eq!(
            chapters,
            vec!["One", "Two", "Three"],
            "refusals change nothing"
        );

        // A chapter in the trash keeps its number, so restoring it cannot collide
        // with a chapter made since.
        db.delete_node(&three.id, "Ada".into()).unwrap();
        let four = make("Four", "chapter");
        assert_eq!(four.chapter_seq, Some(4));
    }

    #[test]
    fn an_export_carries_the_reading_order_through_an_import() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ledger".into(), None, "Ada".into())
            .unwrap();

        let make = |label: &str| {
            db.create_node(
                story.id.clone(),
                "chapter".into(),
                label.into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap()
        };

        let one = make("One");
        let two = make("Two");
        db.set_chapter_order(
            &story.id,
            vec![two.id.clone(), one.id.clone()],
            "Ada".into(),
        )
        .unwrap();

        let imported = db
            .import_story(db.export_story(&story.id).unwrap(), "Ada".into())
            .unwrap();

        let mut order: Vec<(String, Option<i64>)> = db
            .list_nodes(&imported.id)
            .unwrap()
            .into_iter()
            .filter(|node| node.node_type == "chapter")
            .map(|node| (node.label, node.chapter_seq))
            .collect();
        order.sort_by_key(|(_, sequence)| *sequence);

        assert_eq!(
            order,
            vec![("Two".to_string(), Some(1)), ("One".to_string(), Some(2))]
        );

        // An export written before the column existed has no order to carry, so
        // its chapters are numbered in the order the file holds them.
        let mut legacy = db.export_story(&story.id).unwrap();
        for node in legacy.nodes.iter_mut() {
            if node.node_type == "chapter" {
                node.chapter_seq = None;
            }
        }

        let restored = db.import_story(legacy, "Ada".into()).unwrap();
        let mut sequences: Vec<Option<i64>> = db
            .list_nodes(&restored.id)
            .unwrap()
            .into_iter()
            .filter(|node| node.node_type == "chapter")
            .map(|node| node.chapter_seq)
            .collect();
        sequences.sort();

        assert_eq!(sequences, vec![Some(1), Some(2)]);
    }

    #[test]
    fn a_chapter_keeps_its_arc_and_counts_and_only_a_chapter_has_them() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ledger".into(), None, "Ada".into())
            .unwrap();

        let make = |label: &str, node_type: &str| {
            db.create_node(
                story.id.clone(),
                node_type.into(),
                label.into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap()
        };

        let chapter = make("One", "chapter");
        let idea = make("Idea", "idea");

        let saved = db
            .set_chapter_details(
                &chapter.id,
                Some("  The Vault ".into()),
                Some(1200),
                Some(2000),
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(saved.chapter_arc.as_deref(), Some("The Vault"));
        assert_eq!(saved.chapter_words, Some(1200));
        assert_eq!(saved.chapter_target, Some(2000));

        let page = db
            .get_audit_page(Some(&story.id), Some("node"), Some(&chapter.id), 50, 0)
            .unwrap();
        for field in ["chapter_arc", "chapter_words", "chapter_target"] {
            assert!(
                page.entries
                    .iter()
                    .any(|entry| entry.field_changed.as_deref() == Some(field)),
                "{field} should be in the history"
            );
        }

        // A count can be put back from the history, including back to no count.
        let words_entry = page
            .entries
            .iter()
            .find(|entry| entry.field_changed.as_deref() == Some("chapter_words"))
            .unwrap();
        assert!(db.revert_change(&words_entry.id, "Ada".into()).unwrap());
        let reverted = db
            .list_nodes(&story.id)
            .unwrap()
            .into_iter()
            .find(|node| node.id == chapter.id)
            .unwrap();
        assert_eq!(reverted.chapter_words, None);
        assert_eq!(reverted.chapter_arc.as_deref(), Some("The Vault"));

        // The arc, the counts and their clearing survive an export and import.
        let imported = db
            .import_story(db.export_story(&story.id).unwrap(), "Ada".into())
            .unwrap();
        let copy = db
            .list_nodes(&imported.id)
            .unwrap()
            .into_iter()
            .find(|node| node.label == "One")
            .unwrap();
        assert_eq!(copy.chapter_arc.as_deref(), Some("The Vault"));
        assert_eq!(copy.chapter_words, None);
        assert_eq!(copy.chapter_target, Some(2000));

        let cleared = db
            .set_chapter_details(
                &chapter.id,
                None,
                Some(0),
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(cleared.chapter_arc, None);
        assert_eq!(
            cleared.chapter_words,
            Some(0),
            "zero is a count, not an absence"
        );
        assert_eq!(cleared.chapter_target, None);

        // Counts are the author's, but they still have to make sense, and a card
        // that is not a chapter has no place to keep them.
        assert!(db
            .set_chapter_details(
                &chapter.id,
                None,
                Some(-1),
                None,
                None,
                None,
                None,
                "Ada".into()
            )
            .is_err());
        assert!(db
            .set_chapter_details(
                &chapter.id,
                None,
                None,
                Some(0),
                None,
                None,
                None,
                "Ada".into()
            )
            .is_err());
        assert!(db
            .set_chapter_details(
                &idea.id,
                Some("Arc".into()),
                None,
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .is_err());
    }

    #[test]
    fn a_chapter_names_its_pov_and_its_in_world_day() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ledger".into(), None, "Ada".into())
            .unwrap();
        let chapter = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Opening".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let rook = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        let saved = db
            .set_chapter_details(
                &chapter.id,
                None,
                None,
                None,
                Some(rook.id.clone()),
                Some(12),
                None,
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(saved.chapter_pov.as_deref(), Some(rook.id.as_str()));
        assert_eq!(saved.chapter_day, Some(12));

        // The history names the cast member rather than storing an id, and a day
        // that is just a number is recorded the same way as any other edit.
        let page = db
            .get_audit_page(Some(&story.id), Some("node"), Some(&chapter.id), 50, 0)
            .unwrap();
        let pov_entry = page
            .entries
            .iter()
            .find(|entry| entry.field_changed.as_deref() == Some("chapter_pov"))
            .unwrap();
        assert_eq!(pov_entry.new_value.as_deref(), Some("Rook"));
        assert!(page
            .entries
            .iter()
            .any(|entry| entry.field_changed.as_deref() == Some("chapter_day")));

        let day_entry = page
            .entries
            .iter()
            .find(|entry| entry.field_changed.as_deref() == Some("chapter_day"))
            .unwrap();
        assert!(db.revert_change(&day_entry.id, "Ada".into()).unwrap());
        let reverted = db
            .list_nodes(&story.id)
            .unwrap()
            .into_iter()
            .find(|node| node.id == chapter.id)
            .unwrap();
        assert_eq!(reverted.chapter_day, None);
        assert_eq!(
            reverted.chapter_pov.as_deref(),
            Some(rook.id.as_str()),
            "putting the day back leaves the POV alone"
        );

        // Both survive an export, and the POV points at the copy's own cast.
        db.set_chapter_details(
            &chapter.id,
            None,
            None,
            None,
            Some(rook.id.clone()),
            Some(12),
            None,
            "Ada".into(),
        )
        .unwrap();

        let imported = db
            .import_story(db.export_story(&story.id).unwrap(), "Ada".into())
            .unwrap();
        let copy = db
            .list_nodes(&imported.id)
            .unwrap()
            .into_iter()
            .find(|node| node.label == "Opening")
            .unwrap();
        assert_eq!(copy.chapter_day, Some(12));

        let copied_pov = copy.chapter_pov.expect("the POV link comes across");
        let copied_cast = db.list_characters(&imported.id).unwrap();
        assert_eq!(
            copied_cast
                .iter()
                .find(|character| character.id == copied_pov)
                .unwrap()
                .name,
            "Rook"
        );

        // A cast member in the trash keeps its chapter's POV, and sending that POV
        // back unchanged does not stop an unrelated field being saved. A restore
        // brings the name back with the member.
        db.delete_character(&rook.id, "Ada".into()).unwrap();
        let edited = db
            .set_chapter_details(
                &chapter.id,
                Some("The Vault".into()),
                None,
                None,
                Some(rook.id.clone()),
                Some(12),
                None,
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(edited.chapter_pov.as_deref(), Some(rook.id.as_str()));
        assert_eq!(edited.chapter_arc.as_deref(), Some("The Vault"));
        db.restore_character(&rook.id, "Ada".into()).unwrap();

        // A day cannot be negative, and a POV has to be live cast of this story.
        assert!(db
            .set_chapter_details(
                &chapter.id,
                None,
                None,
                None,
                None,
                Some(-1),
                None,
                "Ada".into(),
            )
            .is_err());

        let other = db.create_story("Other".into(), None, "Ada".into()).unwrap();
        let stranger = db
            .create_character(other.id, "Stranger".into(), None, "Ada".into())
            .unwrap();
        assert!(db
            .set_chapter_details(
                &chapter.id,
                None,
                None,
                None,
                Some(stranger.id),
                Some(1),
                None,
                "Ada".into(),
            )
            .is_err());
    }

    #[test]
    fn a_chapter_keeps_its_time_of_day_as_written() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ledger".into(), None, "Ada".into())
            .unwrap();
        let chapter = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Opening".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let saved = db
            .set_chapter_details(
                &chapter.id,
                None,
                None,
                None,
                None,
                Some(3),
                Some("  Dusk, after the fire ".into()),
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(
            saved.chapter_time.as_deref(),
            Some("Dusk, after the fire"),
            "the author's words are kept, only the spacing is tidied"
        );

        let page = db
            .get_audit_page(Some(&story.id), Some("node"), Some(&chapter.id), 50, 0)
            .unwrap();
        let time_entry = page
            .entries
            .iter()
            .find(|entry| entry.field_changed.as_deref() == Some("chapter_time"))
            .unwrap();
        assert_eq!(
            time_entry.new_value.as_deref(),
            Some("Dusk, after the fire")
        );

        // The time survives an export, and putting it back through the history
        // clears only the time.
        let imported = db
            .import_story(db.export_story(&story.id).unwrap(), "Ada".into())
            .unwrap();
        let copy = db
            .list_nodes(&imported.id)
            .unwrap()
            .into_iter()
            .find(|node| node.label == "Opening")
            .unwrap();
        assert_eq!(copy.chapter_day, Some(3));
        assert_eq!(copy.chapter_time.as_deref(), Some("Dusk, after the fire"));

        assert!(db.revert_change(&time_entry.id, "Ada".into()).unwrap());
        let reverted = db
            .list_nodes(&story.id)
            .unwrap()
            .into_iter()
            .find(|node| node.id == chapter.id)
            .unwrap();
        assert_eq!(reverted.chapter_time, None);
        assert_eq!(reverted.chapter_day, Some(3), "the day is left alone");

        // Blank is no time at all, not a label of nothing.
        let cleared = db
            .set_chapter_details(
                &chapter.id,
                None,
                None,
                None,
                None,
                Some(3),
                Some("   ".into()),
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(cleared.chapter_time, None);
    }

    #[test]
    fn a_note_belongs_to_a_chapter_and_stays_off_the_board() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ledger".into(), None, "Ada".into())
            .unwrap();
        let chapter = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Opening".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let card = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "An idea".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let note = db
            .add_chapter_note(
                &chapter.id,
                "  Rook owes the vault\nand the warder knows it  ".into(),
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(note.node_type, "note");
        assert_eq!(note.parent_node_id.as_deref(), Some(chapter.id.as_str()));
        assert_eq!(
            note.content.as_deref(),
            Some("Rook owes the vault\nand the warder knows it")
        );
        // The label is the first line, which is what the trash and the history
        // name the note by.
        assert_eq!(note.label, "Rook owes the vault");

        // The board is unchanged: a note is read for its chapter row instead.
        assert!(db
            .list_nodes(&story.id)
            .unwrap()
            .iter()
            .all(|node| node.id != note.id));
        let notes = db.list_chapter_notes(&story.id).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, note.id);

        let edited = db
            .update_note(&note.id, "The vault answers".into(), "Ada".into())
            .unwrap();
        assert_eq!(edited.label, "The vault answers");

        // The history records the text itself, not the derived label.
        let page = db
            .get_audit_page(Some(&story.id), Some("node"), Some(&note.id), 50, 0)
            .unwrap();
        let edit = page
            .entries
            .iter()
            .find(|entry| entry.field_changed.as_deref() == Some("content"))
            .unwrap();
        assert_eq!(
            edit.old_value.as_deref(),
            Some("Rook owes the vault\nand the warder knows it")
        );
        assert_eq!(edit.new_value.as_deref(), Some("The vault answers"));

        // An empty note is refused, and a note only belongs to a chapter.
        assert!(db
            .add_chapter_note(&chapter.id, "   \n  ".into(), "Ada".into())
            .is_err());
        assert!(db
            .add_chapter_note(&card.id, "Not here".into(), "Ada".into())
            .is_err());
        assert!(db
            .update_note(&card.id, "Not here".into(), "Ada".into())
            .is_err());

        // A trashed chapter takes no new notes: the note would have nowhere to
        // be shown until the chapter came back.
        db.delete_node(&chapter.id, "Ada".into()).unwrap();
        assert!(db
            .add_chapter_note(&chapter.id, "Too late".into(), "Ada".into())
            .is_err());
    }

    #[test]
    fn a_chapter_takes_its_notes_to_the_trash_and_back() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ledger".into(), None, "Ada".into())
            .unwrap();
        let chapter = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Opening".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let kept = db
            .add_chapter_note(&chapter.id, "Goes with the chapter".into(), "Ada".into())
            .unwrap();
        let loose = db
            .add_chapter_note(&chapter.id, "Trashed on its own".into(), "Ada".into())
            .unwrap();
        db.delete_node(&loose.id, "Ada".into()).unwrap();

        db.delete_node(&chapter.id, "Ada".into()).unwrap();
        assert!(db.list_chapter_notes(&story.id).unwrap().is_empty());

        let trashed: Vec<String> = db
            .list_deleted(Some(&story.id))
            .unwrap()
            .into_iter()
            .map(|item| item.id)
            .collect();
        assert!(trashed.contains(&chapter.id));
        assert!(trashed.contains(&kept.id));
        assert!(trashed.contains(&loose.id));

        // A note cannot come back before the chapter that holds it.
        assert!(db.restore_node(&loose.id, "Ada".into()).is_err());

        db.restore_node(&chapter.id, "Ada".into()).unwrap();
        let live: Vec<String> = db
            .list_chapter_notes(&story.id)
            .unwrap()
            .into_iter()
            .map(|note| note.id)
            .collect();
        assert_eq!(live, vec![kept.id.clone()]);

        db.restore_node(&loose.id, "Ada".into()).unwrap();
        assert_eq!(db.list_chapter_notes(&story.id).unwrap().len(), 2);

        // Purging the chapter takes the notes with it, since there would be
        // nothing left for them to belong to.
        db.delete_node(&chapter.id, "Ada".into()).unwrap();
        db.purge_node(&chapter.id, "Ada".into()).unwrap();
        assert!(db.list_chapter_notes(&story.id).unwrap().is_empty());
        assert!(db
            .list_deleted(Some(&story.id))
            .unwrap()
            .iter()
            .all(|item| item.id != kept.id && item.id != loose.id));
    }

    #[test]
    fn notes_travel_with_a_story() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ledger".into(), None, "Ada".into())
            .unwrap();
        let chapter = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Opening".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let note = db
            .add_chapter_note(&chapter.id, "Rook owes the vault".into(), "Ada".into())
            .unwrap();

        let imported = db
            .import_story(db.export_story(&story.id).unwrap(), "Ada".into())
            .unwrap();
        let copied_chapter = db
            .list_nodes(&imported.id)
            .unwrap()
            .into_iter()
            .find(|node| node.node_type == "chapter")
            .unwrap();
        let copied = db.list_chapter_notes(&imported.id).unwrap();
        assert_eq!(copied.len(), 1);
        assert_ne!(copied[0].id, note.id, "the copy gets its own ids");
        assert_eq!(
            copied[0].parent_node_id.as_deref(),
            Some(copied_chapter.id.as_str())
        );

        // A file whose note has lost its chapter cannot be restored faithfully.
        let mut broken = db.export_story(&story.id).unwrap();
        broken.nodes.retain(|node| node.id != chapter.id);
        assert!(db.import_story(broken, "Ada".into()).is_err());
    }

    #[test]
    fn the_story_bible_reads_as_an_outline_for_another_program() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story(
                "Ledger".into(),
                Some("A vault, a warder, and the debt between them.".into()),
                "Ada".into(),
            )
            .unwrap();

        let make = |label: &str, node_type: &str, content: Option<String>| {
            db.create_node(
                story.id.clone(),
                node_type.into(),
                label.into(),
                content,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap()
        };

        let opening = make("Opening", "chapter", None);
        db.update_node(
            &opening.id,
            "Opening".into(),
            Some("The gates open.".into()),
            "Ada".into(),
        )
        .unwrap();
        db.set_chapter_details(
            &opening.id,
            Some("The Vault".into()),
            Some(1200),
            Some(2000),
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        let second = make("Second", "chapter", None);
        db.set_chapter_details(
            &second.id,
            None,
            Some(300),
            None,
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        let rook = db
            .create_character(
                story.id.clone(),
                "Rook".into(),
                Some("A warder.".into()),
                "Ada".into(),
            )
            .unwrap();
        db.set_character_progress(
            &rook.id,
            3,
            250,
            Some("Copper".into()),
            Some(1000),
            "Ada".into(),
        )
        .unwrap();
        db.add_or_update_stat(rook.id.clone(), "HP".into(), 20, None, "Ada".into())
            .unwrap();
        db.add_or_update_attribute(
            rook.id.clone(),
            "Class".into(),
            "Warden".into(),
            "Ada".into(),
        )
        .unwrap();

        // Told from Rook, on day 3, at dusk. The second chapter happens earlier
        // in the world than the one the reader meets first.
        db.set_chapter_details(
            &opening.id,
            Some("The Vault".into()),
            Some(1200),
            Some(2000),
            Some(rook.id.clone()),
            Some(3),
            Some("Dusk".into()),
            "Ada".into(),
        )
        .unwrap();
        db.set_chapter_details(
            &second.id,
            None,
            Some(300),
            None,
            None,
            Some(1),
            None,
            "Ada".into(),
        )
        .unwrap();

        db.add_chapter_note(
            &opening.id,
            "Rook owes the vault.\nThe warder knows it.".into(),
            "Ada".into(),
        )
        .unwrap();
        db.add_chapter_note(
            &opening.id,
            "The gate opens on its own.".into(),
            "Ada".into(),
        )
        .unwrap();
        db.add_chapter_note(&second.id, "Told after the fact.".into(), "Ada".into())
            .unwrap();

        make(
            "Blackgate",
            "location",
            Some("A gate that remembers.".into()),
        );
        // A character card is not repeated: the cast section carries the sheet.
        make("Rook", "character", Some("The card.".into()));

        let bible = db.story_bible(&story.id).unwrap();
        let markdown = &bible.markdown;

        assert_eq!(bible.title, "Ledger");
        assert!(markdown.starts_with("# Ledger\n\nA vault, a warder, and the debt between them."));
        assert!(markdown.ends_with('\n'));

        let chapters = markdown.find("## Chapters").unwrap();
        let timeline = markdown.find("## Timeline").unwrap();
        let cast = markdown.find("## Cast").unwrap();
        let cards = markdown.find("## Other cards").unwrap();
        assert!(chapters < timeline && timeline < cast && cast < cards);

        let first = markdown.find("### 1. Opening").unwrap();
        let next = markdown.find("### 2. Second").unwrap();
        assert!(first < next);

        assert!(markdown.contains(
            "**Arc:** The Vault · **Day:** 3 · **Time:** Dusk · **POV:** Rook · **Words:** 1,200 of 2,000"
        ));
        assert!(markdown.contains("**Day:** 1 · **Words:** 300"));

        // The timeline is time order, and only the chapters with a day are on it.
        assert!(markdown.contains("- Day 1 — Second\n- Day 3, Dusk — Opening (Rook)"));
        assert_eq!(markdown.matches("## Timeline").count(), 1);
        assert!(markdown.contains("The gates open."));
        assert!(markdown.contains("*1,500 words in 2 chapters; 2,000 targeted across 1 of them.*"));

        // Each chapter's notes sit under that chapter's heading, in the order they
        // were written, and a note that runs to a second line stays one item.
        assert_eq!(markdown.matches("**Notes**").count(), 2);
        let notes_heading = markdown.find("**Notes**").unwrap();
        assert!(first < notes_heading && notes_heading < next);
        assert!(markdown.contains(
            "**Notes**\n\n- Rook owes the vault.\n  The warder knows it.\n- The gate opens on its own."
        ));
        assert!(markdown.find("- Told after the fact.").unwrap() > next);
        // Notes belong after the chapter's facts, not before them.
        assert!(notes_heading > markdown.find("**Arc:** The Vault").unwrap());

        assert!(markdown.contains("### Rook"));
        assert_eq!(markdown.matches("### Rook").count(), 1);
        assert!(markdown.contains("Level 3 · Rank Copper · 250 XP of 1,000"));
        assert!(markdown.contains("A warder."));
        assert!(markdown.contains("- HP: 20"));
        assert!(markdown.contains("- Class: Warden"));

        assert!(markdown.contains("### Blackgate"));
        assert!(markdown.contains("*location*"));
        assert!(markdown.contains("A gate that remembers."));
        assert!(!markdown.contains("The card."));
    }

    #[test]
    fn the_story_bible_orders_a_day_by_its_time_labels() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ledger".into(), None, "Ada".into())
            .unwrap();

        let make = |label: &str| {
            db.create_node(
                story.id.clone(),
                "chapter".into(),
                label.into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap()
        };

        // Written in one order, placed on the day in another, plus one label the
        // clock cannot read.
        let evening = make("Evening");
        let morning = make("Morning");
        let unreadable = make("After the fire");
        let early = make("Early");

        for (chapter, time) in [
            (&evening, "Dusk"),
            (&morning, "7:30 am"),
            (&unreadable, "after the fire"),
            (&early, "early morning"),
        ] {
            db.set_chapter_details(
                &chapter.id,
                None,
                None,
                None,
                None,
                Some(4),
                Some(time.into()),
                "Ada".into(),
            )
            .unwrap();
        }

        let markdown = db.story_bible(&story.id).unwrap().markdown;

        // 7:30am, then early morning at 8:00, then Dusk, and the label no clock
        // can read last, printed as the author typed it.
        assert!(markdown.contains(
            "- Day 4, 7:30 am — Morning\n- Day 4, early morning — Early\n- Day 4, Dusk — Evening\n- Day 4, after the fire — After the fire"
        ));
    }

    #[test]
    fn time_labels_are_read_the_same_way_as_the_tab() {
        // Clock readings, as a person would write them.
        assert_eq!(time_of_day("18:40"), Some(1120));
        assert_eq!(time_of_day("6:40 pm"), Some(1120));
        assert_eq!(time_of_day("6:40pm"), Some(1120));
        assert_eq!(time_of_day("7:30:15 am"), Some(450));
        assert_eq!(time_of_day("12:30 am"), Some(30));
        assert_eq!(time_of_day("12 pm"), Some(720));
        assert_eq!(time_of_day("11:59 pm"), Some(1439));

        // Day parts, with the nudges that move them, and the edge of the day.
        assert_eq!(time_of_day("  DUSK  "), Some(1140));
        assert_eq!(time_of_day("midnight"), Some(0));
        assert_eq!(time_of_day("afternoon"), Some(870));
        assert_eq!(time_of_day("nightfall"), Some(1260));
        assert_eq!(time_of_day("early morning"), Some(480));
        assert_eq!(time_of_day("just before dawn"), Some(300));
        assert_eq!(time_of_day("late night"), Some(1320));
        assert_eq!(time_of_day("after dark"), Some(1320));

        // Anything else is stored and printed, but never ordered or guessed at.
        assert_eq!(time_of_day(""), None);
        assert_eq!(time_of_day("after the fire"), None);
        assert_eq!(time_of_day("25:00"), None);
        assert_eq!(time_of_day("6:4"), None);
        assert_eq!(time_of_day("noonish"), None);
    }

    #[test]
    fn progression_is_saved_field_by_field_and_level_up_is_its_own_event() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ledger".into(), None, "Ada".into())
            .unwrap();
        let rook = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        assert_eq!(rook.level, 1, "a new character starts at level 1");

        let saved = db
            .set_character_progress(
                &rook.id,
                3,
                250,
                Some("Copper".into()),
                Some(1000),
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(saved.level, 3);
        assert_eq!(saved.xp, 250);
        assert_eq!(saved.rank.as_deref(), Some("Copper"));
        assert_eq!(saved.xp_to_next, Some(1000));

        let page = db
            .get_audit_page(Some(&story.id), Some("character"), Some(&rook.id), 50, 0)
            .unwrap();
        let fields: Vec<&str> = page
            .entries
            .iter()
            .filter_map(|entry| entry.field_changed.as_deref())
            .collect();
        for field in ["level", "xp", "rank", "xp_to_next"] {
            assert!(fields.contains(&field), "{field} should be in the history");
        }

        // Progression fields are ordinary recorded edits, so the history can put
        // them back — including a target that had no value before it was set.
        let entry_for = |field: &str| {
            page.entries
                .iter()
                .find(|entry| entry.field_changed.as_deref() == Some(field))
                .unwrap()
                .id
                .clone()
        };
        let level_entry = entry_for("level");
        let target_entry = entry_for("xp_to_next");
        assert!(db.revert_change(&level_entry, "Ada".into()).unwrap());
        assert!(db.revert_change(&target_entry, "Ada".into()).unwrap());

        let reverted = db.list_characters(&story.id).unwrap();
        assert_eq!(reverted[0].level, 1);
        assert_eq!(reverted[0].xp_to_next, None);
        assert_eq!(reverted[0].rank.as_deref(), Some("Copper"));

        db.set_character_progress(
            &rook.id,
            3,
            250,
            Some("Copper".into()),
            Some(1000),
            "Ada".into(),
        )
        .unwrap();

        let levelled = db.level_up_character(&rook.id, "Ada".into()).unwrap();
        assert_eq!(levelled.level, 4);
        assert_eq!(levelled.xp, 250, "levelling up does not touch XP");
        assert_eq!(levelled.rank.as_deref(), Some("Copper"));

        let page = db
            .get_audit_page(Some(&story.id), Some("character"), Some(&rook.id), 50, 0)
            .unwrap();
        assert_eq!(page.entries[0].action, "level_up");
        assert_eq!(page.entries[0].new_value.as_deref(), Some("4"));

        // The numbers are the author's, but they still have to make sense.
        assert!(db
            .set_character_progress(&rook.id, 0, 0, None, None, "Ada".into())
            .is_err());
        assert!(db
            .set_character_progress(&rook.id, 1, -5, None, None, "Ada".into())
            .is_err());
        assert!(db
            .set_character_progress(&rook.id, 1, 0, None, Some(0), "Ada".into())
            .is_err());
    }

    #[test]
    fn an_export_carries_progression_through_an_import() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ledger".into(), None, "Ada".into())
            .unwrap();
        let rook = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        db.set_character_progress(
            &rook.id,
            5,
            1200,
            Some("Iron".into()),
            Some(2000),
            "Ada".into(),
        )
        .unwrap();

        let export = db.export_story(&story.id).unwrap();
        let imported = db.import_story(export, "Ada".into()).unwrap();

        let characters = db.list_characters(&imported.id).unwrap();
        assert_eq!(characters.len(), 1);
        assert_eq!(characters[0].level, 5);
        assert_eq!(characters[0].xp, 1200);
        assert_eq!(characters[0].rank.as_deref(), Some("Iron"));
        assert_eq!(characters[0].xp_to_next, Some(2000));
    }

    /// Retention deletes for real, so the launch order matters: the copy taken
    /// before the file is opened is the only place a purged item still exists.
    #[test]
    fn a_launch_copy_still_holds_what_retention_removes() {
        let dir = std::env::temp_dir().join(format!("litrpg-retention-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("storyboard.db");

        {
            let first = Db::open(&path).unwrap();
            let story = first
                .create_story("Retained".into(), None, "Ada".into())
                .unwrap();
            let character = first
                .create_character(story.id.clone(), "Old Rook".into(), None, "Ada".into())
                .unwrap();
            first.delete_character(&character.id, "Ada".into()).unwrap();
            backdate_trash(&first, "characters", &character.id, 40);
            first.set_trash_retention_days(Some(30)).unwrap();
        }

        // What startup does, in the order it does it.
        let db = Db::open_with_snapshot(&path, 5).unwrap();
        let window = db.trash_retention_days().unwrap().unwrap();
        assert_eq!(db.purge_expired(window).unwrap(), 1);

        let gone: i64 = db
            .conn()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM characters WHERE name = 'Old Rook'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(gone, 0);

        let copy = std::fs::read_dir(snapshots::snapshot_dir(&path))
            .unwrap()
            .next()
            .expect("a copy should have been written")
            .unwrap()
            .path();
        let kept: i64 = Connection::open(&copy)
            .unwrap()
            .query_row(
                "SELECT count(*) FROM characters WHERE name = 'Old Rook'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept, 1, "the launch copy was taken before the purge");

        drop(db);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== retention =====

    /// Deletes are stamped with the clock, so a test that wants an old deletion
    /// has to backdate it through the same connection the code uses.
    fn backdate_trash(db: &Db, table: &str, id: &str, days_ago: i64) {
        let stamp = (Utc::now() - chrono::Duration::days(days_ago)).to_rfc3339();
        // `table` is one of our own literals, never user input.
        db.conn()
            .unwrap()
            .execute(
                &format!("UPDATE {table} SET deleted_at = ?1 WHERE id = ?2"),
                params![stamp, id],
            )
            .unwrap();
    }

    #[test]
    fn a_new_database_keeps_the_trash_forever() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(db.trash_retention_days().unwrap(), None);
    }

    #[test]
    fn the_retention_window_is_remembered_and_can_be_turned_off() {
        let db = Db::open_in_memory().unwrap();

        db.set_trash_retention_days(Some(30)).unwrap();
        assert_eq!(db.trash_retention_days().unwrap(), Some(30));

        // Changing it replaces the value instead of piling up settings.
        db.set_trash_retention_days(Some(7)).unwrap();
        assert_eq!(db.trash_retention_days().unwrap(), Some(7));
        let rows: i64 = db
            .conn()
            .unwrap()
            .query_row("SELECT count(*) FROM settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);

        db.set_trash_retention_days(None).unwrap();
        assert_eq!(db.trash_retention_days().unwrap(), None);
    }

    #[test]
    fn an_impossible_retention_window_is_refused() {
        let db = Db::open_in_memory().unwrap();
        db.set_trash_retention_days(Some(30)).unwrap();

        for days in [0, -1, 3651] {
            assert!(
                db.set_trash_retention_days(Some(days)).is_err(),
                "{days} days should be refused"
            );
        }
        assert_eq!(
            db.trash_retention_days().unwrap(),
            Some(30),
            "a refused change leaves the window alone"
        );

        assert!(db.purge_expired(0).is_err());
    }

    #[test]
    fn retention_removes_only_what_is_older_than_the_window() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Retention".into(), None, "Ada".into())
            .unwrap();
        let old = db
            .create_character(story.id.clone(), "Ancient".into(), None, "Ada".into())
            .unwrap();
        let recent = db
            .create_character(story.id.clone(), "Recent".into(), None, "Ada".into())
            .unwrap();
        let live = db
            .create_character(story.id.clone(), "Live".into(), None, "Ada".into())
            .unwrap();

        db.delete_character(&old.id, "Ada".into()).unwrap();
        backdate_trash(&db, "characters", &old.id, 40);
        db.delete_character(&recent.id, "Ada".into()).unwrap();

        let purged = db.purge_expired(30).unwrap();
        assert_eq!(purged, 1, "only the character older than the window went");

        let trash = db.list_deleted(Some(&story.id)).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, recent.id);

        let live_characters = db.list_characters(&story.id).unwrap();
        assert_eq!(live_characters.len(), 1);
        assert_eq!(live_characters[0].id, live.id);

        // The old row is gone from the table, not merely hidden.
        let remaining: i64 = db
            .conn()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM characters WHERE id = ?1",
                params![old.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn retention_records_who_removed_the_item() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Receipts".into(), None, "Ada".into())
            .unwrap();
        let character = db
            .create_character(story.id.clone(), "Ancient".into(), None, "Ada".into())
            .unwrap();

        db.delete_character(&character.id, "Ada".into()).unwrap();
        backdate_trash(&db, "characters", &character.id, 40);
        db.purge_expired(30).unwrap();

        let purge = db
            .get_audit_log(Some(&story.id), Some("character"), Some(&character.id), 10)
            .unwrap()
            .into_iter()
            .find(|entry| entry.action == "purge")
            .expect("the automatic purge is recorded");
        assert_eq!(purge.changed_by, "Trash retention");
        assert_eq!(purge.old_value.as_deref(), Some("Ancient"));

        // A run that removes nothing writes nothing.
        let before = db.get_audit_log(None, None, None, 100).unwrap().len();
        assert_eq!(db.purge_expired(30).unwrap(), 0);
        assert_eq!(
            db.get_audit_log(None, None, None, 100).unwrap().len(),
            before
        );
    }

    #[test]
    fn retention_takes_a_whole_story_and_its_contents() {
        let db = Db::open_in_memory().unwrap();
        let story = db
            .create_story("Ancient".into(), None, "Ada".into())
            .unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        db.add_or_update_stat(character.id.clone(), "Level".into(), 3, None, "Ada".into())
            .unwrap();
        db.delete_story(&story.id, "Ada".into()).unwrap();
        backdate_trash(&db, "stories", &story.id, 40);

        assert_eq!(db.purge_expired(30).unwrap(), 1);

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
        assert_eq!(stats, 0, "the story's stats went with it");

        let purge = db
            .get_audit_log(None, Some("story"), Some(&story.id), 10)
            .unwrap()
            .into_iter()
            .find(|entry| entry.action == "purge")
            .expect("the story purge is recorded");
        assert_eq!(purge.changed_by, "Trash retention");
    }

    // ===== reverting an edit =====

    /// The newest entry for one field — the one a click in the audit tab targets.
    fn latest_entry(db: &Db, entity_type: &str, entity_id: &str, field: &str) -> AuditEntry {
        db.get_audit_log(None, Some(entity_type), Some(entity_id), 50)
            .unwrap()
            .into_iter()
            .find(|entry| entry.field_changed.as_deref() == Some(field))
            .expect("the change should be in the history")
    }

    #[test]
    fn reverting_a_rename_puts_the_previous_name_back() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        db.update_character(&character.id, "Wren".into(), None, "Ada".into())
            .unwrap();
        let rename = latest_entry(&db, "character", &character.id, "name");
        assert_eq!(rename.action, "update");

        assert!(db.revert_change(&rename.id, "Grace".into()).unwrap());

        let characters = db.list_characters(&story.id).unwrap();
        assert_eq!(characters[0].name, "Rook");

        let revert = latest_entry(&db, "character", &character.id, "name");
        assert_eq!(revert.action, "revert");
        assert_eq!(revert.old_value.as_deref(), Some("Wren"));
        assert_eq!(revert.new_value.as_deref(), Some("Rook"));
        assert_eq!(revert.changed_by, "Grace");
        assert_eq!(revert.story_id.as_deref(), Some(story.id.as_str()));
    }

    #[test]
    fn reverting_a_skill_card_rename_also_renames_its_holders() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let card = db
            .create_node(
                story.id.clone(),
                "skill".into(),
                "Frost Touch".into(),
                Some("A cold touch.".into()),
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let rook = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        db.add_skill(
            rook.id.clone(),
            "Frost Touch".into(),
            Some("Rank 1".into()),
            Some("A cold touch.".into()),
            None,
            Some(card.id.clone()),
            "Ada".into(),
        )
        .unwrap();

        db.update_node(
            &card.id,
            "Chill Touch".into(),
            Some("A deeper cold.".into()),
            "Ada".into(),
        )
        .unwrap();
        let rename = latest_entry(&db, "node", &card.id, "label");

        assert!(db.revert_change(&rename.id, "Grace".into()).unwrap());

        let stored = db
            .list_nodes(&story.id)
            .unwrap()
            .into_iter()
            .find(|node| node.id == card.id)
            .unwrap();
        assert_eq!(stored.label, "Frost Touch");
        assert_eq!(stored.content.as_deref(), Some("A deeper cold."));

        let skills = db.list_story_skills(&story.id).unwrap();
        assert_eq!(skills[0].name, "Frost Touch");
        assert_eq!(skills[0].effect.as_deref(), Some("A deeper cold."));
        assert_eq!(skills[0].rank.as_deref(), Some("Rank 1"));
    }

    #[test]
    fn reverting_a_shared_skill_edit_restores_the_card_and_every_holder() {
        let (db, story, rook, _, card) = skill_story();
        let mira = db
            .create_character(story.id.clone(), "Mira".into(), None, "Ada".into())
            .unwrap();

        let rook_skill = db
            .add_skill(
                rook.id.clone(),
                "Frost Touch".into(),
                Some("Rank 1".into()),
                Some("A cold touch.".into()),
                None,
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();
        let mira_skill = db
            .add_skill(
                mira.id.clone(),
                "Frost Touch".into(),
                Some("Rank 4".into()),
                Some("Mira's own wording.".into()),
                None,
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();

        db.update_skill(
            rook_skill.id.clone(),
            "Chill Touch".into(),
            Some("Rank 1".into()),
            Some("A deeper cold.".into()),
            None,
            Some(card.id.clone()),
            "Ada".into(),
        )
        .unwrap();

        let name_entry = latest_entry(&db, "character_skill", &rook_skill.id, "name");
        let effect_entry = latest_entry(&db, "character_skill", &rook_skill.id, "effect");

        assert!(db.revert_change(&name_entry.id, "Grace".into()).unwrap());
        assert!(db.revert_change(&effect_entry.id, "Grace".into()).unwrap());

        let stored = db
            .list_nodes(&story.id)
            .unwrap()
            .into_iter()
            .find(|node| node.id == card.id)
            .unwrap();
        assert_eq!(stored.label, "Frost Touch");
        assert_eq!(stored.content.as_deref(), Some("A cold touch."));

        let skills = db.list_story_skills(&story.id).unwrap();
        for skill in &skills {
            assert_eq!(skill.name, "Frost Touch");
            assert_eq!(skill.effect.as_deref(), Some("A cold touch."));
        }
        assert_eq!(
            skills
                .iter()
                .find(|skill| skill.id == mira_skill.id)
                .unwrap()
                .rank
                .as_deref(),
            Some("Rank 4")
        );
    }

    #[test]
    fn reverting_a_skill_rank_puts_it_back() {
        let (db, story, character, chapter, _) = skill_story();
        let second = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let skill = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 1".into()),
                None,
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();
        db.update_skill(
            skill.id.clone(),
            "Fireball".into(),
            Some("Rank 2".into()),
            None,
            Some(second.id.clone()),
            None,
            "Ada".into(),
        )
        .unwrap();

        let rank = latest_entry(&db, "character_skill", &skill.id, "rank");
        assert_eq!(entry_state(&db, &rank.id).0, Some(RevertState::Available));
        assert!(db.revert_change(&rank.id, "Grace".into()).unwrap());

        let skills = db.list_skills(&character.id).unwrap();
        assert_eq!(skills[0].rank.as_deref(), Some("Rank 1"));

        // The chapter link is recorded by label, so it is not offered as a revert.
        let chapter = latest_entry(&db, "character_skill", &skill.id, "chapter");
        assert_eq!(entry_state(&db, &chapter.id).0, None);
    }

    #[test]
    fn a_field_that_moved_on_is_not_reverted() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        db.update_character(&character.id, "Wren".into(), None, "Ada".into())
            .unwrap();
        db.update_character(&character.id, "Ash".into(), None, "Ada".into())
            .unwrap();

        let first_rename = db
            .get_audit_log(None, Some("character"), Some(&character.id), 50)
            .unwrap()
            .into_iter()
            .find(|entry| entry.old_value.as_deref() == Some("Rook"))
            .expect("the first rename is in the history");

        let error = db
            .revert_change(&first_rename.id, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("changed after that entry"), "{error}");
        // The refusal says what the field reads now, which is why it refused.
        assert!(error.contains("Ash"), "{error}");

        let characters = db.list_characters(&story.id).unwrap();
        assert_eq!(characters[0].name, "Ash", "the newer edit stands");
    }

    #[test]
    fn a_revert_is_itself_a_change_that_can_be_reverted() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        db.update_character(&character.id, "Wren".into(), None, "Ada".into())
            .unwrap();
        let rename = latest_entry(&db, "character", &character.id, "name");
        db.revert_change(&rename.id, "Ada".into()).unwrap();

        let revert = latest_entry(&db, "character", &character.id, "name");
        assert_eq!(revert.action, "revert");

        // Undoing the undo puts the rename back, so no edit is a dead end.
        assert!(db.revert_change(&revert.id, "Ada".into()).unwrap());
        let characters = db.list_characters(&story.id).unwrap();
        assert_eq!(characters[0].name, "Wren");

        let undo = latest_entry(&db, "character", &character.id, "name");
        assert_eq!(undo.action, "revert");
        assert_eq!(undo.old_value.as_deref(), Some("Rook"));
        assert_eq!(undo.new_value.as_deref(), Some("Wren"));
    }

    #[test]
    fn reverting_an_added_description_empties_it_again() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        db.update_character(
            &character.id,
            "Rook".into(),
            Some("Scout".into()),
            "Ada".into(),
        )
        .unwrap();
        let edit = latest_entry(&db, "character", &character.id, "description");
        assert_eq!(edit.old_value, None);

        assert!(db.revert_change(&edit.id, "Ada".into()).unwrap());

        let characters = db.list_characters(&story.id).unwrap();
        assert_eq!(
            characters[0].description, None,
            "a field that was empty comes back empty, not as a blank string"
        );

        let revert = latest_entry(&db, "character", &character.id, "description");
        assert_eq!(revert.old_value.as_deref(), Some("Scout"));
        assert_eq!(revert.new_value, None);
    }

    #[test]
    fn a_stat_goes_back_to_its_old_number() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let stat = db
            .add_or_update_stat(character.id.clone(), "Level".into(), 3, None, "Ada".into())
            .unwrap();
        db.add_or_update_stat(character.id.clone(), "Level".into(), 7, None, "Ada".into())
            .unwrap();

        let change = latest_entry(&db, "character_stat", &stat.id, "value");
        assert!(db.revert_change(&change.id, "Ada".into()).unwrap());

        let stats = db.list_stats(&character.id).unwrap();
        assert_eq!(stats[0].value, 3);
        assert_eq!(
            stats[0].stat_name, "Level",
            "the stat itself is still there"
        );
    }

    #[test]
    fn a_connection_label_can_be_put_back() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let first = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "One".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let second = db
            .create_node(
                story.id.clone(),
                "event".into(),
                "Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let edge = db
            .create_edge(
                story.id.clone(),
                first.id.clone(),
                second.id.clone(),
                Some("first".into()),
                None,
                "Ada".into(),
            )
            .unwrap();
        db.update_edge(
            &edge.id,
            Some("second".into()),
            Some("leads_to".into()),
            "Ada".into(),
        )
        .unwrap();

        let rename = latest_entry(&db, "edge", &edge.id, "label");
        assert!(db.revert_change(&rename.id, "Ada".into()).unwrap());

        let edges = db.list_edges(&story.id).unwrap();
        assert_eq!(edges[0].label.as_deref(), Some("first"));
        assert_eq!(
            edges[0].relation_type.as_deref(),
            Some("leads_to"),
            "one field is put back, not the whole row"
        );
    }

    #[test]
    fn a_node_move_can_be_undone_and_a_rounding_drag_writes_nothing() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let node = db
            .create_node(
                story.id.clone(),
                "idea".into(),
                "Beat".into(),
                None,
                10.0,
                20.0,
                "Ada".into(),
            )
            .unwrap();

        db.update_node_position(node.id.clone(), 30.0, 40.0, "Ada".into())
            .unwrap();
        let moved = latest_entry(&db, "node", &node.id, "position");
        assert_eq!(moved.old_value.as_deref(), Some("10.0,20.0"));

        assert!(db.revert_change(&moved.id, "Ada".into()).unwrap());
        let nodes = db.list_nodes(&story.id).unwrap();
        assert_eq!(nodes[0].pos_x, 10.0);
        assert_eq!(nodes[0].pos_y, 20.0);

        // A nudge smaller than the one decimal the history keeps records the same
        // value twice, so putting it back would change nothing at all.
        db.update_node_position(node.id.clone(), 10.02, 20.0, "Ada".into())
            .unwrap();
        let nudge = latest_entry(&db, "node", &node.id, "position");
        let before = db.get_audit_log(None, None, None, 100).unwrap().len();

        assert!(!db.revert_change(&nudge.id, "Ada".into()).unwrap());
        assert_eq!(
            db.get_audit_log(None, None, None, 100).unwrap().len(),
            before,
            "a revert with nothing to do writes no history"
        );
        let nodes = db.list_nodes(&story.id).unwrap();
        assert_eq!(nodes[0].pos_x, 10.02);
    }

    #[test]
    fn only_an_edit_has_something_to_put_back() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        let history = |action: &str| {
            db.get_audit_log(None, Some("character"), Some(&character.id), 50)
                .unwrap()
                .into_iter()
                .find(|entry| entry.action == action)
                .expect("the entry should be in the history")
        };

        let creation = history("create");
        let error = db
            .revert_change(&creation.id, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("a creation has nothing to put back"),
            "{error}"
        );

        db.update_character(&character.id, "Wren".into(), None, "Ada".into())
            .unwrap();
        let rename = latest_entry(&db, "character", &character.id, "name");
        db.delete_character(&character.id, "Ada".into()).unwrap();

        let error = db
            .revert_change(&rename.id, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("in the trash"), "{error}");

        let deletion = history("soft_delete");
        let error = db
            .revert_change(&deletion.id, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("undone from the trash"), "{error}");

        // Nothing above touched the character, so it is still in the trash.
        let trash = db.list_deleted(Some(&story.id)).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, character.id);
    }

    #[test]
    fn a_purged_item_has_nothing_left_to_put_back() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        db.delete_character(&character.id, "Ada".into()).unwrap();
        db.purge_character(&character.id, "Ada".into()).unwrap();

        let purge = db
            .get_audit_log(None, Some("character"), Some(&character.id), 50)
            .unwrap()
            .into_iter()
            .find(|entry| entry.action == "purge")
            .unwrap();

        let error = db
            .revert_change(&purge.id, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("deleted for good"), "{error}");
    }

    #[test]
    fn a_story_title_can_be_put_back() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        db.update_story(&story.id, "Embers".into(), "Ada".into())
            .unwrap();

        let rename = latest_entry(&db, "story", &story.id, "title");
        assert!(db.revert_change(&rename.id, "Ada".into()).unwrap());

        let stored = db.get_story(&story.id).unwrap().unwrap();
        assert_eq!(stored.title, "Ash");
        assert_eq!(db.list_stories().unwrap()[0].title, "Ash");
    }

    /// The state and the words the Audit tab shows for one entry, from a page.
    fn entry_state(db: &Db, id: &str) -> (Option<RevertState>, Option<String>) {
        let entry = db
            .get_audit_page(None, None, None, 500, 0)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.id == id)
            .expect("the entry should be on the page");

        (entry.revert_state, entry.revert_reason)
    }

    #[test]
    fn the_history_says_which_edits_can_still_be_put_back() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        db.update_character(&character.id, "Wren".into(), None, "Ada".into())
            .unwrap();
        let first = latest_entry(&db, "character", &character.id, "name");

        db.update_character(&character.id, "Sable".into(), None, "Ada".into())
            .unwrap();
        let second = latest_entry(&db, "character", &character.id, "name");

        // The newest edit is still undoable; the one under it was overtaken.
        assert_eq!(entry_state(&db, &second.id).0, Some(RevertState::Available));

        let (state, reason) = entry_state(&db, &first.id);
        assert_eq!(state, Some(RevertState::ChangedSince));
        assert!(reason.as_deref().unwrap_or_default().contains("Sable"));

        // A creation has no state at all, which is what keeps its button away.
        let creation = db
            .get_audit_log(None, Some("character"), Some(&character.id), 50)
            .unwrap()
            .into_iter()
            .find(|entry| entry.action == "create")
            .unwrap();
        assert_eq!(entry_state(&db, &creation.id), (None, None));
    }

    #[test]
    fn an_entry_whose_field_already_moved_back_is_not_offered() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        db.update_character(&character.id, "Wren".into(), None, "Ada".into())
            .unwrap();

        assert!(db
            .revert_change(
                &latest_entry(&db, "character", &character.id, "name").id,
                "Ada".into()
            )
            .unwrap());

        // The rename is undone: its own entry now has nothing to write.
        let rename = db
            .get_audit_log(None, Some("character"), Some(&character.id), 50)
            .unwrap()
            .into_iter()
            .find(|entry| entry.action == "update")
            .unwrap();
        let (state, reason) = entry_state(&db, &rename.id);
        assert_eq!(state, Some(RevertState::AlreadyBack));
        assert!(reason
            .as_deref()
            .unwrap_or_default()
            .contains("already holds"));

        // The revert that undid it can itself be put back.
        let revert = db
            .get_audit_log(None, Some("character"), Some(&character.id), 50)
            .unwrap()
            .into_iter()
            .find(|entry| entry.action == "revert")
            .unwrap();
        assert_eq!(entry_state(&db, &revert.id).0, Some(RevertState::Available));
    }

    #[test]
    fn an_entry_in_the_trash_or_a_purged_one_says_why_it_cannot_be_reverted() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        db.update_character(&character.id, "Wren".into(), None, "Ada".into())
            .unwrap();
        let rename = latest_entry(&db, "character", &character.id, "name");

        db.delete_character(&character.id, "Ada".into()).unwrap();

        let (state, reason) = entry_state(&db, &rename.id);
        assert_eq!(state, Some(RevertState::InTrash));
        assert!(reason.as_deref().unwrap_or_default().contains("restore it"));

        // A deletion is not something to undo here, so it gets no state either.
        let deletion = db
            .get_audit_log(None, Some("character"), Some(&character.id), 50)
            .unwrap()
            .into_iter()
            .find(|entry| entry.action == "soft_delete")
            .unwrap();
        assert_eq!(entry_state(&db, &deletion.id), (None, None));

        // Once the row is gone, the entry that described it can only say so.
        db.purge_character(&character.id, "Ada".into()).unwrap();
        let (state, reason) = entry_state(&db, &rename.id);
        assert_eq!(state, Some(RevertState::Gone));
        assert!(reason
            .as_deref()
            .unwrap_or_default()
            .contains("no longer in the database"));
    }

    #[test]
    fn the_state_shown_is_the_answer_a_click_gets() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        db.update_character(&character.id, "Wren".into(), None, "Ada".into())
            .unwrap();
        let first = latest_entry(&db, "character", &character.id, "name");
        db.update_character(&character.id, "Sable".into(), None, "Ada".into())
            .unwrap();

        let (_, reason) = entry_state(&db, &first.id);
        let error = db
            .revert_change(&first.id, "Ada".into())
            .unwrap_err()
            .to_string();

        assert_eq!(
            Some(error),
            reason,
            "the tab refuses for the reason it showed"
        );
    }

    #[test]
    fn a_version_3_database_gains_settings_without_losing_anything() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(MIGRATION_002).unwrap();
        conn.execute_batch(MIGRATION_003).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        conn.pragma_update(None, "user_version", 3).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at, deleted_at)
             VALUES ('s1', 'Kept', NULL, 'then', 'then', NULL)",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let settings: i64 = conn
            .query_row("SELECT count(*) FROM settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            settings, 0,
            "the table starts empty, so nothing is ever purged by default"
        );

        let title: String = conn
            .query_row("SELECT title FROM stories WHERE id = 's1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "Kept");
    }

    #[test]
    fn a_version_4_database_gains_the_cast_link_without_losing_its_nodes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(MIGRATION_002).unwrap();
        conn.execute_batch(MIGRATION_003).unwrap();
        conn.execute_batch(MIGRATION_004).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        conn.pragma_update(None, "user_version", 4).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at, deleted_at)
             VALUES ('s1', 'Kept', NULL, 'then', 'then', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO nodes (id, story_id, node_type, label, content, pos_x, pos_y,
                                created_by, created_at, updated_at, deleted_at)
             VALUES ('n1', 's1', 'idea', 'Kept', NULL, 1.0, 2.0, 'Ada', 'then', 'then', NULL)",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        assert!(column_exists(&conn, "nodes", "character_id").unwrap());

        let node = read_node(&conn, "n1").unwrap().unwrap();
        assert_eq!(node.label, "Kept");
        assert_eq!(node.character_id, None, "an existing node starts unlinked");
    }

    fn linked_node(db: &Db, story_id: &str, character_id: &str) -> Node {
        let node = db
            .create_node(
                story_id.to_string(),
                "character".into(),
                "Rook".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        db.set_node_character(&node.id, Some(character_id.to_string()), "Ada".into())
            .unwrap()
    }

    #[test]
    fn linking_a_node_to_a_cast_member_is_recorded_by_name() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        let node = linked_node(&db, &story.id, &character.id);
        assert_eq!(node.character_id.as_deref(), Some(character.id.as_str()));

        // The entry reads as the names, not as two ids.
        let entry = latest_entry(&db, "node", &node.id, "character");
        assert_eq!(entry.old_value, None);
        assert_eq!(entry.new_value.as_deref(), Some("Rook"));

        // The link follows the id, so renaming either side leaves it intact.
        db.update_character(&character.id, "Wren".into(), None, "Ada".into())
            .unwrap();
        db.update_node(&node.id, "Rook the Bold".into(), None, "Ada".into())
            .unwrap();

        let nodes = db.list_nodes(&story.id).unwrap();
        assert_eq!(
            nodes[0].character_id.as_deref(),
            Some(character.id.as_str())
        );
    }

    #[test]
    fn clearing_a_link_is_recorded_and_relinking_the_same_member_writes_nothing() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let node = linked_node(&db, &story.id, &character.id);

        let entries = || db.get_audit_log(None, None, None, 100).unwrap().len();
        let before = entries();

        db.set_node_character(&node.id, Some(character.id.clone()), "Ada".into())
            .unwrap();
        assert_eq!(entries(), before, "the same cast member is not a change");

        let cleared = db.set_node_character(&node.id, None, "Ada".into()).unwrap();
        assert_eq!(cleared.character_id, None);

        let entry = latest_entry(&db, "node", &node.id, "character");
        assert_eq!(entry.old_value.as_deref(), Some("Rook"));
        assert_eq!(entry.new_value, None);
    }

    #[test]
    fn a_link_is_refused_across_stories_and_through_the_trash() {
        let db = Db::open_in_memory().unwrap();
        let first = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let second = db
            .create_story("Embers".into(), None, "Ada".into())
            .unwrap();
        let theirs = db
            .create_character(second.id.clone(), "Wren".into(), None, "Ada".into())
            .unwrap();
        let ours = db
            .create_character(first.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let node = linked_node(&db, &first.id, &ours.id);

        let error = db
            .set_node_character(&node.id, Some(theirs.id.clone()), "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("own story"), "{error}");

        db.delete_character(&ours.id, "Ada".into()).unwrap();
        let error = db
            .set_node_character(&node.id, Some(ours.id.clone()), "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("in the trash"), "{error}");

        // A link that is already there survives its cast member going to the
        // trash, so restoring the character brings it back.
        assert_eq!(
            db.list_nodes(&first.id).unwrap()[0].character_id.as_deref(),
            Some(ours.id.as_str())
        );
        db.restore_character(&ours.id, "Ada".into()).unwrap();
        assert_eq!(
            db.list_nodes(&first.id).unwrap()[0].character_id.as_deref(),
            Some(ours.id.as_str())
        );

        db.delete_node(&node.id, "Ada".into()).unwrap();
        let error = db
            .set_node_character(&node.id, None, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("restore it"), "{error}");
    }

    #[test]
    fn purging_a_character_clears_the_links_to_it() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let node = linked_node(&db, &story.id, &character.id);

        db.delete_character(&character.id, "Ada".into()).unwrap();
        db.purge_character(&character.id, "Ada".into()).unwrap();

        assert_eq!(db.list_nodes(&story.id).unwrap()[0].character_id, None);

        // The history still says what the link was, and that it is gone now.
        let entries = db
            .get_audit_log(Some(&story.id), Some("node"), Some(&node.id), 50)
            .unwrap();
        assert!(entries.iter().any(|entry| {
            entry.field_changed.as_deref() == Some("character")
                && entry.old_value.as_deref() == Some("Rook")
        }));
    }

    #[test]
    fn an_export_carries_the_link_into_the_copy() {
        let source = Db::open_in_memory().unwrap();
        let story = source
            .create_story("Ash".into(), None, "Ada".into())
            .unwrap();
        let character = source
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let node = linked_node(&source, &story.id, &character.id);

        let export = source.export_story(&story.id).unwrap();
        assert_eq!(
            export.nodes[0].character_id.as_deref(),
            Some(character.id.as_str()),
            "the export names the linked cast member"
        );

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(export, "Grace".into()).unwrap();

        let characters = target.list_characters(&restored.id).unwrap();
        let nodes = target.list_nodes(&restored.id).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_ne!(nodes[0].id, node.id, "nodes get fresh ids");
        assert_eq!(
            nodes[0].character_id.as_deref(),
            Some(characters[0].id.as_str()),
            "the copy points at the copied cast member, not the original"
        );
    }

    #[test]
    fn a_node_can_be_created_already_linked_to_a_cast_member() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        let node = db
            .create_node_with_character(
                story.id.clone(),
                "character".into(),
                "Rook".into(),
                None,
                12.5,
                40.0,
                "Ada".into(),
                Some(character.id.clone()),
            )
            .unwrap();

        assert_eq!(node.character_id.as_deref(), Some(character.id.as_str()));
        assert_eq!(
            db.list_nodes(&story.id).unwrap()[0].character_id.as_deref(),
            Some(character.id.as_str()),
            "the link is stored, not just returned"
        );

        // One creation, and one entry that says who it arrived pointing at —
        // not a creation followed by a separate link edit.
        let entries = db
            .get_audit_log(Some(&story.id), Some("node"), Some(&node.id), 50)
            .unwrap();
        assert!(entries.iter().all(|entry| entry.action != "update"));
        assert!(entries.iter().any(|entry| {
            entry.action == "create"
                && entry.field_changed.as_deref() == Some("character")
                && entry.old_value.is_none()
                && entry.new_value.as_deref() == Some("Rook")
        }));
    }

    #[test]
    fn a_linked_node_is_refused_through_the_trash_and_across_stories() {
        let db = Db::open_in_memory().unwrap();
        let first = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let second = db
            .create_story("Embers".into(), None, "Ada".into())
            .unwrap();
        let theirs = db
            .create_character(second.id.clone(), "Wren".into(), None, "Ada".into())
            .unwrap();
        let ours = db
            .create_character(first.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();

        let create = |character_id: Option<String>| {
            db.create_node_with_character(
                first.id.clone(),
                "character".into(),
                "Dropped".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
                character_id,
            )
        };

        let error = create(Some(theirs.id.clone())).unwrap_err().to_string();
        assert!(error.contains("own story"), "{error}");

        db.delete_character(&ours.id, "Ada".into()).unwrap();
        let error = create(Some(ours.id.clone())).unwrap_err().to_string();
        assert!(error.contains("in the trash"), "{error}");

        let error = create(Some("nobody".into())).unwrap_err().to_string();
        assert!(error.contains("no longer in the database"), "{error}");

        // Every refusal rolled back whole: no half-made node is left behind.
        assert!(db.list_nodes(&first.id).unwrap().is_empty());
    }

    #[test]
    fn a_story_reads_all_of_its_live_cast_stats_in_one_go() {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let other = db
            .create_story("Embers".into(), None, "Ada".into())
            .unwrap();
        let rook = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let wren = db
            .create_character(story.id.clone(), "Wren".into(), None, "Ada".into())
            .unwrap();
        let trashed = db
            .create_character(story.id.clone(), "Ghost".into(), None, "Ada".into())
            .unwrap();
        let elsewhere = db
            .create_character(other.id.clone(), "Faraway".into(), None, "Ada".into())
            .unwrap();

        db.add_or_update_stat(rook.id.clone(), "Level".into(), 4, None, "Ada".into())
            .unwrap();
        db.add_or_update_stat(wren.id.clone(), "Level".into(), 9, None, "Ada".into())
            .unwrap();
        db.add_or_update_stat(trashed.id.clone(), "Level".into(), 1, None, "Ada".into())
            .unwrap();
        db.add_or_update_stat(elsewhere.id.clone(), "Level".into(), 2, None, "Ada".into())
            .unwrap();
        db.delete_character(&trashed.id, "Ada".into()).unwrap();

        let stats = db.list_story_stats(&story.id).unwrap();

        assert_eq!(stats.len(), 2, "only the live cast of this story");
        assert!(stats.iter().all(|stat| stat.character_id != trashed.id));
        assert!(stats
            .iter()
            .any(|stat| stat.character_id == wren.id && stat.value == 9));
    }

    // A story with a cast member, a chapter and a skill card, which is the shape
    // every skill test starts from.
    fn skill_story() -> (Db, Story, Character, Node, Node) {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let chapter = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter One".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let card = db
            .create_node(
                story.id.clone(),
                "skill".into(),
                "Fireball".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        (db, story, character, chapter, card)
    }

    #[test]
    fn a_skill_keeps_its_rank_effect_and_chapter() {
        let (db, story, character, chapter, card) = skill_story();

        let skill = db
            .add_skill(
                character.id.clone(),
                "  Fireball  ".into(),
                Some("Rank 2 ".into()),
                Some("  3d6 fire  ".into()),
                Some(chapter.id.clone()),
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(skill.name, "Fireball", "the name is trimmed");
        assert_eq!(skill.rank.as_deref(), Some("Rank 2"));
        assert_eq!(skill.effect.as_deref(), Some("3d6 fire"));
        assert_eq!(skill.chapter_id.as_deref(), Some(chapter.id.as_str()));
        assert_eq!(skill.node_id.as_deref(), Some(card.id.as_str()));

        let skills = db.list_skills(&character.id).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, skill.id);

        // A skill card can name everyone who has the skill.
        let board = db.list_story_skills(&story.id).unwrap();
        assert_eq!(board.len(), 1);
        assert_eq!(board[0].character_id, character.id);
    }

    #[test]
    fn a_blank_rank_is_stored_as_nothing() {
        let (db, _, character, _, _) = skill_story();

        let skill = db
            .add_skill(
                character.id.clone(),
                "Tracking".into(),
                Some("   ".into()),
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(skill.rank, None);
        assert_eq!(skill.effect, None);
    }

    #[test]
    fn a_skill_needs_a_name_and_a_unique_one() {
        let (db, _, character, _, _) = skill_story();

        let error = db
            .add_skill(
                character.id.clone(),
                "   ".into(),
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("needs a name"), "{error}");

        db.add_skill(
            character.id.clone(),
            "Fireball".into(),
            None,
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        let error = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("already one of"), "{error}");
        assert_eq!(db.list_skills(&character.id).unwrap().len(), 1);
    }

    #[test]
    fn a_skill_only_links_to_its_own_story() {
        let (db, _, character, _, _) = skill_story();
        let other = db
            .create_story("Embers".into(), None, "Ada".into())
            .unwrap();
        let theirs = db
            .create_node(
                other.id.clone(),
                "chapter".into(),
                "Their Chapter".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let error = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                None,
                None,
                Some(theirs.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("live chapter of this story"), "{error}");

        // A node of the wrong type is refused just as plainly.
        let event = db
            .create_node(
                other.id.clone(),
                "event".into(),
                "Not a card".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let error = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                None,
                None,
                None,
                Some(event.id.clone()),
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("live skill of this story"), "{error}");
        assert!(db.list_skills(&character.id).unwrap().is_empty());
    }

    #[test]
    fn editing_a_skill_records_each_field_it_changes() {
        let (db, story, character, chapter, _) = skill_story();
        let second_chapter = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let skill = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 1".into()),
                Some("1d6 fire".into()),
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        let updated = db
            .update_skill(
                skill.id.clone(),
                "Greater Fireball".into(),
                Some("Rank 2".into()),
                Some("3d6 fire".into()),
                Some(second_chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(updated.name, "Greater Fireball");
        assert_eq!(updated.rank.as_deref(), Some("Rank 2"));
        assert_eq!(
            updated.chapter_id.as_deref(),
            Some(second_chapter.id.as_str())
        );

        let history = db
            .get_audit_log(Some(&story.id), Some("character_skill"), None, 100)
            .unwrap();
        let fields: Vec<&str> = history
            .iter()
            .filter_map(|entry| entry.field_changed.as_deref())
            .collect();

        assert_eq!(history[0].entity_id, skill.id);
        assert!(fields.contains(&"name"));
        assert!(fields.contains(&"rank"));
        assert!(fields.contains(&"effect"));
        assert!(fields.contains(&"chapter"));
        // The history says the chapter by its title, not its id.
        assert!(history
            .iter()
            .any(|entry| entry.field_changed.as_deref() == Some("chapter")
                && entry.new_value.as_deref() == Some("Chapter Two")));
    }

    #[test]
    fn saving_the_same_skill_writes_nothing() {
        let (db, story, character, chapter, _) = skill_story();
        let skill = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 1".into()),
                None,
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();
        let before = db
            .get_audit_log(Some(&story.id), Some("character_skill"), None, 100)
            .unwrap();

        let unchanged = db
            .update_skill(
                skill.id.clone(),
                "Fireball".into(),
                Some("Rank 1".into()),
                None,
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();
        let after = db
            .get_audit_log(Some(&story.id), Some("character_skill"), None, 100)
            .unwrap();

        assert_eq!(unchanged.updated_at, skill.updated_at);
        assert_eq!(after.len(), before.len());
    }

    #[test]
    fn deleting_a_skill_leaves_the_cast_member_alone() {
        let (db, story, character, _, _) = skill_story();
        let skill = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        db.delete_skill(&skill.id, "Ada".into()).unwrap();

        assert!(db.list_skills(&character.id).unwrap().is_empty());
        assert_eq!(db.list_characters(&story.id).unwrap().len(), 1);

        // Deleting the same skill twice is not an error, and records nothing more.
        db.delete_skill(&skill.id, "Ada".into()).unwrap();

        let history = db
            .get_audit_log(Some(&story.id), Some("character_skill"), None, 100)
            .unwrap();
        assert!(history
            .iter()
            .any(|entry| entry.action == "delete" && entry.new_value.is_none()));
    }

    #[test]
    fn a_trashed_character_takes_its_skills_out_of_view() {
        let (db, story, character, _, _) = skill_story();
        db.add_skill(
            character.id.clone(),
            "Fireball".into(),
            None,
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        db.delete_character(&character.id, "Ada".into()).unwrap();

        assert!(db.list_skills(&character.id).unwrap().is_empty());
        assert!(db.list_story_skills(&story.id).unwrap().is_empty());
    }

    #[test]
    fn purging_a_chapter_clears_the_link_but_keeps_the_skill() {
        let (db, _, character, chapter, _) = skill_story();
        let skill = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 2".into()),
                None,
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        db.delete_node(&chapter.id, "Ada".into()).unwrap();
        db.purge_node(&chapter.id, "Ada".into()).unwrap();

        let skills = db.list_skills(&character.id).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, skill.id);
        assert_eq!(skills[0].chapter_id, None, "the missing chapter is cleared");
    }

    #[test]
    fn skills_travel_with_an_export_and_keep_their_chapter() {
        let (source, story, character, chapter, card) = skill_story();
        source
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 2".into()),
                Some("3d6 fire".into()),
                Some(chapter.id.clone()),
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();

        let export = source.export_story(&story.id).unwrap();
        assert_eq!(export.character_skills.len(), 1);
        assert_eq!(export.skill_definitions.len(), 1);

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(export, "Grace".into()).unwrap();
        let characters = target.list_characters(&restored.id).unwrap();
        let skills = target.list_story_skills(&restored.id).unwrap();

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "Fireball");
        assert_eq!(skills[0].rank.as_deref(), Some("Rank 2"));
        assert_eq!(skills[0].effect.as_deref(), Some("3d6 fire"));
        assert_eq!(skills[0].character_id, characters[0].id);
        assert_ne!(skills[0].chapter_id.as_deref(), Some(chapter.id.as_str()));
        assert_ne!(skills[0].node_id.as_deref(), Some(card.id.as_str()));

        // The links point at the copy's own nodes, which are the chapter and the
        // card the file carried.
        let nodes = target.list_nodes(&restored.id).unwrap();
        let linked_chapter = nodes
            .iter()
            .find(|node| Some(node.id.as_str()) == skills[0].chapter_id.as_deref())
            .expect("the chapter link is remapped");
        assert_eq!(linked_chapter.label, "Chapter One");
        assert_eq!(linked_chapter.node_type, "chapter");

        let linked_card = nodes
            .iter()
            .find(|node| Some(node.id.as_str()) == skills[0].node_id.as_deref())
            .expect("the card link is remapped");
        assert_eq!(linked_card.node_type, "skill");

        // The skill's own history came along, pointing at the copied row.
        let history = target
            .get_audit_log(Some(&restored.id), Some("character_skill"), None, 100)
            .unwrap();
        assert!(history.iter().any(|entry| entry.entity_id == skills[0].id));

        // The shared definition travelled too, and the imported row points at it
        // instead of carrying an unlinked copy.
        let guard = target.conn().unwrap();
        let linked: Option<String> = guard
            .query_row(
                "SELECT skill_id FROM character_skills WHERE id = ?1",
                params![&skills[0].id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(linked.is_some(), "the imported skill has a definition");

        let definitions: i64 = guard
            .query_row(
                "SELECT count(*) FROM skill_definitions WHERE story_id = ?1",
                params![&restored.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            definitions, 1,
            "the carried definition was reused, not copied"
        );
    }

    // A story with three skills and two chapters, the smallest shape that can
    // show a chain and a fusion.
    fn evolution_story() -> (
        Db,
        Story,
        Character,
        Node,
        Node,
        CharacterSkill,
        CharacterSkill,
        CharacterSkill,
    ) {
        let (db, story, character, first, _card) = skill_story();
        let second = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                320.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let ember = db
            .add_skill(
                character.id.clone(),
                "Ember".into(),
                Some("Rank 1".into()),
                None,
                Some(first.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();
        let flame = db
            .add_skill(
                character.id.clone(),
                "Flame".into(),
                Some("Rank 2".into()),
                None,
                Some(second.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();
        let inferno = db
            .add_skill(
                character.id.clone(),
                "Inferno".into(),
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        (db, story, character, first, second, ember, flame, inferno)
    }

    #[test]
    fn an_evolution_records_its_kind_chapter_and_rank() {
        let (db, story, character, _, chapter, ember, flame, _) = evolution_story();

        let link = db
            .add_skill_evolution(
                ember.id.clone(),
                flame.id.clone(),
                " Upgrade ".into(),
                Some(chapter.id.clone()),
                Some(" Rank 1 ".into()),
                Some("  burned hotter  ".into()),
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(link.evolution_type, "upgrade", "the kind is normalised");
        assert_eq!(link.chapter_id.as_deref(), Some(chapter.id.as_str()));
        assert_eq!(link.required_rank.as_deref(), Some("Rank 1"));
        assert_eq!(link.notes.as_deref(), Some("burned hotter"));
        assert_eq!(link.story_id, story.id);

        let links = db.list_story_skill_evolutions(&story.id).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].id, link.id);

        // The whole story's tree and one character's tree both see it.
        let story_tree = db.skill_tree_for_story(&story.id).unwrap();
        assert_eq!(story_tree.skills.len(), 3);
        assert_eq!(story_tree.evolutions.len(), 1);

        let character_tree = db.skill_tree_for_character(&character.id).unwrap();
        assert_eq!(character_tree.skills.len(), 3);
        assert_eq!(character_tree.evolutions.len(), 1);

        let history = db
            .get_audit_log(Some(&story.id), Some("skill_evolution"), Some(&link.id), 20)
            .unwrap();
        assert!(history.iter().any(|entry| entry.action == "create"
            && entry.field_changed.as_deref() == Some("evolution")
            && entry.new_value.as_deref().unwrap_or("").contains("Ember")));
        assert!(history
            .iter()
            .any(|entry| entry.field_changed.as_deref() == Some("chapter")));

        db.delete_skill_evolution(&link.id, "Ada".into()).unwrap();
        assert!(db
            .list_story_skill_evolutions(&story.id)
            .unwrap()
            .is_empty());

        let history = db
            .get_audit_log(Some(&story.id), Some("skill_evolution"), Some(&link.id), 20)
            .unwrap();
        assert!(history.iter().any(|entry| entry.action == "delete"));
    }

    #[test]
    fn a_characters_tree_follows_a_fusion_into_another_sheet() {
        let (db, story, rook, _, chapter, ember, flame, _) = evolution_story();
        let mira = db
            .create_character(story.id.clone(), "Mira".into(), None, "Ada".into())
            .unwrap();
        let mist = db
            .add_skill(
                mira.id.clone(),
                "Mist".into(),
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        db.add_skill_evolution(
            ember.id.clone(),
            flame.id.clone(),
            "upgrade".into(),
            Some(chapter.id.clone()),
            None,
            None,
            "Ada".into(),
        )
        .unwrap();
        db.add_skill_evolution(
            flame.id.clone(),
            mist.id.clone(),
            "fusion".into(),
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        // Rook's tree reaches through the fusion onto Mira's sheet, and back
        // again from Mira's side of the same link.
        let rook_tree = db.skill_tree_for_character(&rook.id).unwrap();
        assert_eq!(rook_tree.skills.len(), 4);
        assert_eq!(rook_tree.evolutions.len(), 2);
        assert!(rook_tree.skills.iter().any(|skill| skill.id == mist.id));

        let mira_tree = db.skill_tree_for_character(&mira.id).unwrap();
        assert_eq!(mira_tree.skills.len(), 3, "Mira's tree stops at the fusion");
        assert_eq!(mira_tree.evolutions.len(), 2);
        assert!(mira_tree.skills.iter().any(|skill| skill.id == flame.id));

        // A character with no skills and no links gets an empty tree rather than
        // every skill in the story.
        let stranger = db
            .create_character(story.id.clone(), "Wren".into(), None, "Ada".into())
            .unwrap();
        let stranger_tree = db.skill_tree_for_character(&stranger.id).unwrap();
        assert!(stranger_tree.skills.is_empty());
        assert!(stranger_tree.evolutions.is_empty());
    }

    #[test]
    fn a_skill_cannot_evolve_into_itself_or_close_a_loop() {
        let (db, _, _, _, _, ember, flame, inferno) = evolution_story();

        let error = db
            .add_skill_evolution(
                ember.id.clone(),
                ember.id.clone(),
                "mutation".into(),
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("itself"), "{error}");

        let error = db
            .add_skill_evolution(
                ember.id.clone(),
                flame.id.clone(),
                "sideways".into(),
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("upgrade, fusion"), "{error}");

        db.add_skill_evolution(
            ember.id.clone(),
            flame.id.clone(),
            "upgrade".into(),
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();
        db.add_skill_evolution(
            flame.id.clone(),
            inferno.id.clone(),
            "fusion".into(),
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        // The direct loop and the long way round are both refused.
        for (parent, child) in [
            (flame.id.clone(), ember.id.clone()),
            (inferno.id.clone(), ember.id.clone()),
        ] {
            let error = db
                .add_skill_evolution(
                    parent,
                    child,
                    "branch".into(),
                    None,
                    None,
                    None,
                    "Ada".into(),
                )
                .unwrap_err()
                .to_string();
            assert!(error.contains("close a loop"), "{error}");
        }
    }

    #[test]
    fn evolution_links_go_with_their_skills_and_lose_a_purged_chapter() {
        let (db, story, _, _, second, ember, flame, inferno) = evolution_story();

        let link = db
            .add_skill_evolution(
                ember.id.clone(),
                flame.id.clone(),
                "upgrade".into(),
                Some(second.id.clone()),
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        db.delete_node(&second.id, "Ada".into()).unwrap();
        db.purge_node(&second.id, "Ada".into()).unwrap();

        let links = db.list_story_skill_evolutions(&story.id).unwrap();
        assert_eq!(links.len(), 1, "the link survives its chapter");
        assert_eq!(links[0].chapter_id, None, "the purged chapter is cleared");
        assert_eq!(links[0].id, link.id);

        // Deleting either skill takes the link with it, because both ends are
        // foreign keys.
        db.delete_skill(&flame.id, "Ada".into()).unwrap();
        assert!(db
            .list_story_skill_evolutions(&story.id)
            .unwrap()
            .is_empty());

        let tree = db.skill_tree_for_story(&story.id).unwrap();
        assert_eq!(tree.skills.len(), 2);
        assert!(tree.evolutions.is_empty());
        assert!(tree.skills.iter().any(|skill| skill.id == inferno.id));
    }

    #[test]
    fn skill_evolutions_travel_with_the_story_and_remap_both_ends() {
        let (source, story, _, _, chapter, ember, flame, _) = evolution_story();
        let link = source
            .add_skill_evolution(
                ember.id.clone(),
                flame.id.clone(),
                "mutation".into(),
                Some(chapter.id.clone()),
                Some("Rank 2".into()),
                Some("the fire learned to think".into()),
                "Ada".into(),
            )
            .unwrap();

        let export = source.export_story(&story.id).unwrap();
        assert_eq!(export.skill_evolutions.len(), 1);
        assert_eq!(export.skill_evolutions[0].id, link.id);

        // Older files have no evolution list at all and still import.
        let mut older = serde_json::to_value(&export).unwrap();
        older.as_object_mut().unwrap().remove("skill_evolutions");
        let older: StoryExport = serde_json::from_value(older).unwrap();
        assert!(older.skill_evolutions.is_empty());

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(export, "Grace".into()).unwrap();
        let links = target.list_story_skill_evolutions(&restored.id).unwrap();
        let skills = target.list_story_skills(&restored.id).unwrap();

        assert_eq!(links.len(), 1);
        assert_ne!(links[0].id, link.id, "the copy gets its own link id");
        assert_ne!(links[0].parent_skill_id, ember.id, "the parent is remapped");
        assert_ne!(links[0].child_skill_id, flame.id, "the child is remapped");
        assert_eq!(
            skills
                .iter()
                .find(|skill| skill.id == links[0].parent_skill_id)
                .map(|skill| skill.name.as_str()),
            Some("Ember")
        );
        assert_eq!(
            skills
                .iter()
                .find(|skill| skill.id == links[0].child_skill_id)
                .map(|skill| skill.name.as_str()),
            Some("Flame")
        );
        assert_eq!(links[0].evolution_type, "mutation");
        assert_eq!(links[0].required_rank.as_deref(), Some("Rank 2"));
        assert_eq!(links[0].notes.as_deref(), Some("the fire learned to think"));

        // The chapter points into the copy, not at the source story.
        let nodes = target.list_nodes(&restored.id).unwrap();
        let copied_chapter = nodes
            .iter()
            .find(|node| Some(node.id.as_str()) == links[0].chapter_id.as_deref())
            .expect("the chapter is remapped");
        assert_eq!(copied_chapter.label, "Chapter Two");

        let tree = target.skill_tree_for_story(&restored.id).unwrap();
        assert_eq!(tree.evolutions.len(), 1);

        // The copied history names the copied link.
        let history = target
            .get_audit_log(Some(&restored.id), Some("skill_evolution"), None, 20)
            .unwrap();
        assert!(history.iter().any(|entry| entry.entity_id == links[0].id));
    }

    #[test]
    fn an_imported_file_with_a_skill_loop_is_refused() {
        let (source, story, _, _, _, ember, flame, inferno) = evolution_story();
        source
            .add_skill_evolution(
                ember.id.clone(),
                flame.id.clone(),
                "upgrade".into(),
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();
        source
            .add_skill_evolution(
                flame.id.clone(),
                inferno.id.clone(),
                "upgrade".into(),
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        let mut export = source.export_story(&story.id).unwrap();
        assert_eq!(export.skill_evolutions.len(), 2);

        // The file claims the last skill also feeds the first: a loop no single
        // insert would have been allowed to make.
        let mut closing = export.skill_evolutions[0].clone();
        closing.id = "closing-link".into();
        closing.parent_skill_id = inferno.id.clone();
        closing.child_skill_id = ember.id.clone();
        export.skill_evolutions.push(closing);

        let target = Db::open_in_memory().unwrap();
        let error = target
            .import_story(export, "Grace".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("loop"), "{error}");
    }

    #[test]
    fn a_trashed_link_is_left_out_of_an_export_rather_than_breaking_it() {
        let (source, story, character, chapter, _) = skill_story();
        source
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 2".into()),
                None,
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();
        source.delete_node(&chapter.id, "Ada".into()).unwrap();

        let export = source.export_story(&story.id).unwrap();
        assert_eq!(export.character_skills.len(), 1);
        assert_eq!(
            export.character_skills[0].chapter_id, None,
            "a chapter in the trash is not in the file"
        );

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(export, "Grace".into()).unwrap();
        let skills = target.list_story_skills(&restored.id).unwrap();

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "Fireball");
        assert_eq!(skills[0].chapter_id, None);
    }

    #[test]
    fn a_trashed_chapter_link_does_not_block_an_unrelated_edit() {
        let (db, _, character, chapter, _) = skill_story();
        let skill = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 1".into()),
                None,
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        db.delete_node(&chapter.id, "Ada".into()).unwrap();

        let updated = db
            .update_skill(
                skill.id.clone(),
                "Fireball".into(),
                Some("Rank 2".into()),
                None,
                // Sent back unchanged, so it is not checked again.
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(updated.rank.as_deref(), Some("Rank 2"));
        assert_eq!(updated.chapter_id.as_deref(), Some(chapter.id.as_str()));
    }

    #[test]
    fn a_story_bible_lists_each_skill_with_its_chapter() {
        let (db, story, character, chapter, _) = skill_story();
        db.add_skill(
            character.id.clone(),
            "Fireball".into(),
            Some("Rank 2".into()),
            Some("3d6 fire".into()),
            Some(chapter.id.clone()),
            None,
            "Ada".into(),
        )
        .unwrap();

        let bible = db.story_bible(&story.id).unwrap();

        assert!(bible
            .markdown
            .contains("- **Fireball** · Rank 2 — 3d6 fire (learned in \"Chapter One\")"));
    }

    #[test]
    fn a_level_milestone_keeps_its_level_chapter_and_penalty() {
        let (db, story, character, chapter, card) = skill_story();
        let second = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let first = db
            .add_level_milestone(
                character.id.clone(),
                3,
                Some(chapter.id.clone()),
                false,
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(first.level, 3);
        assert_eq!(first.chapter_id.as_deref(), Some(chapter.id.as_str()));
        assert!(!first.is_debuff);

        let error = db
            .add_level_milestone(character.id.clone(), 0, None, false, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("level 1 or higher"), "{error}");

        let error = db
            .add_level_milestone(
                character.id.clone(),
                2,
                Some(card.id.clone()),
                false,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("live chapter"), "{error}");

        let penalty = db
            .add_level_milestone(
                character.id.clone(),
                2,
                Some(second.id.clone()),
                true,
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(db.list_level_milestones(&character.id).unwrap().len(), 2);
        assert_eq!(db.list_story_level_milestones(&story.id).unwrap().len(), 2);

        let updated = db
            .update_level_milestone(
                penalty.id.clone(),
                4,
                Some(second.id.clone()),
                false,
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(updated.level, 4);
        assert!(!updated.is_debuff);

        let history = db
            .get_audit_log(
                Some(&story.id),
                Some("character_level_milestone"),
                Some(&penalty.id),
                100,
            )
            .unwrap();
        assert!(history.iter().any(|entry| {
            entry.field_changed.as_deref() == Some("level")
                && entry.old_value.as_deref() == Some("2")
                && entry.new_value.as_deref() == Some("4")
        }));
        assert!(history.iter().any(|entry| {
            entry.field_changed.as_deref() == Some("is_debuff")
                && entry.old_value.as_deref() == Some("yes")
                && entry.new_value.as_deref() == Some("no")
        }));

        let before = history.len();
        db.update_level_milestone(
            penalty.id.clone(),
            4,
            Some(second.id.clone()),
            false,
            "Ada".into(),
        )
        .unwrap();
        assert_eq!(
            db.get_audit_log(
                Some(&story.id),
                Some("character_level_milestone"),
                Some(&penalty.id),
                100,
            )
            .unwrap()
            .len(),
            before,
            "saving the same milestone writes nothing"
        );

        db.delete_level_milestone(&penalty.id, "Ada".into())
            .unwrap();
        assert_eq!(db.list_level_milestones(&character.id).unwrap().len(), 1);
        let history = db
            .get_audit_log(
                Some(&story.id),
                Some("character_level_milestone"),
                Some(&penalty.id),
                100,
            )
            .unwrap();
        assert!(history.iter().any(|entry| entry.action == "delete"));
    }

    #[test]
    fn a_skill_event_keeps_its_kind_chapter_and_rank() {
        let (db, story, character, chapter, card) = skill_story();
        let second = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let skill = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 1".into()),
                None,
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        let upgraded = db
            .add_skill_event(
                skill.id.clone(),
                "UPGRADED".into(),
                Some(chapter.id.clone()),
                Some("  Rank 2  ".into()),
                None,
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(upgraded.kind, "upgraded");
        assert_eq!(upgraded.rank.as_deref(), Some("Rank 2"));
        assert_eq!(upgraded.chapter_id.as_deref(), Some(chapter.id.as_str()));

        let used = db
            .add_skill_event(
                skill.id.clone(),
                "used".into(),
                Some(second.id.clone()),
                Some("Rank 2".into()),
                None,
                "Ada".into(),
            )
            .unwrap();

        let sacrificed = db
            .add_skill_event(
                skill.id.clone(),
                "sacrificed".into(),
                Some(second.id.clone()),
                Some("Rank 9".into()),
                None,
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(sacrificed.rank, None, "a sacrifice has no rank to carry");

        let error = db
            .add_skill_event(
                skill.id.clone(),
                "lost".into(),
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("upgrade, a sacrifice or a use"), "{error}");

        let error = db
            .add_skill_event(
                skill.id.clone(),
                "used".into(),
                Some(card.id.clone()),
                None,
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("live chapter"), "{error}");

        assert_eq!(db.list_skill_events(&skill.id).unwrap().len(), 3);
        assert_eq!(db.list_story_skill_events(&story.id).unwrap().len(), 3);

        let updated = db
            .update_skill_event(
                used.id.clone(),
                "upgraded".into(),
                Some(second.id.clone()),
                Some("Rank 3".into()),
                None,
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(updated.kind, "upgraded");
        assert_eq!(updated.rank.as_deref(), Some("Rank 3"));

        let history = db
            .get_audit_log(
                Some(&story.id),
                Some("character_skill_event"),
                Some(&used.id),
                100,
            )
            .unwrap();
        assert!(history.iter().any(|entry| {
            entry.field_changed.as_deref() == Some("event")
                && entry.old_value.as_deref() == Some("used")
                && entry.new_value.as_deref() == Some("upgraded")
        }));
        assert!(history.iter().any(|entry| {
            entry.field_changed.as_deref() == Some("rank")
                && entry.old_value.as_deref() == Some("Rank 2")
                && entry.new_value.as_deref() == Some("Rank 3")
        }));

        db.delete_skill_event(&sacrificed.id, "Ada".into()).unwrap();
        assert_eq!(db.list_skill_events(&skill.id).unwrap().len(), 2);

        db.delete_skill(&skill.id, "Ada".into()).unwrap();
        assert!(db.list_story_skill_events(&story.id).unwrap().is_empty());
        assert_eq!(
            db.get_audit_log(
                Some(&story.id),
                Some("character_skill_event"),
                Some(&updated.id),
                100,
            )
            .unwrap()
            .len(),
            3,
            "deleting the skill removes its events from the ledger"
        );
    }

    #[test]
    fn a_level_milestone_can_record_xp_and_one_primary_stat() {
        let (db, story, character, chapter, _) = skill_story();

        let milestone = db
            .add_level_milestone_with_metrics(
                character.id.clone(),
                3,
                Some(chapter.id.clone()),
                false,
                Some(1200),
                Some("Strength".into()),
                Some(18),
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(milestone.xp, Some(1200));
        assert_eq!(milestone.stat_changes.len(), 1);
        assert_eq!(milestone.stat_changes[0].stat_name, "Strength");
        assert_eq!(milestone.stat_changes[0].amount, None);
        assert_eq!(milestone.stat_changes[0].value_after, Some(18));

        let listed = db.list_story_level_milestones(&story.id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].xp, Some(1200));
        assert_eq!(listed[0].stat_changes.len(), 1);
        assert_eq!(listed[0].stat_changes[0].value_after, Some(18));

        let updated = db
            .update_level_milestone_with_metrics(
                milestone.id.clone(),
                4,
                Some(chapter.id.clone()),
                false,
                Some(1500),
                Some("Strength".into()),
                Some(20),
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(updated.level, 4);
        assert_eq!(updated.xp, Some(1500));
        assert_eq!(updated.stat_changes[0].value_after, Some(20));

        let history = db
            .get_audit_log(
                Some(&story.id),
                Some("character_level_milestone"),
                Some(&milestone.id),
                100,
            )
            .unwrap();
        assert!(history.iter().any(|entry| {
            entry.field_changed.as_deref() == Some("xp")
                && entry.old_value.as_deref() == Some("1200")
                && entry.new_value.as_deref() == Some("1500")
        }));
        assert!(history.iter().any(|entry| {
            entry.field_changed.as_deref() == Some("stat:Strength")
                && entry.old_value.as_deref() == Some("now 18")
                && entry.new_value.as_deref() == Some("now 20")
        }));

        let cleared = db
            .update_level_milestone_with_metrics(
                milestone.id.clone(),
                4,
                Some(chapter.id.clone()),
                false,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(cleared.xp, None);
        assert!(cleared.stat_changes.is_empty());

        assert!(db
            .add_level_milestone_with_metrics(
                character.id.clone(),
                5,
                None,
                false,
                Some(-1),
                None,
                None,
                "Ada".into(),
            )
            .is_err());
        assert!(db
            .add_level_milestone_with_metrics(
                character.id.clone(),
                5,
                None,
                false,
                None,
                Some("Strength".into()),
                None,
                "Ada".into(),
            )
            .is_err());
    }

    #[test]
    fn a_level_up_can_award_several_stats_and_group_its_skill_changes() {
        let (db, story, character, chapter, _) = skill_story();
        let skill = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 1".into()),
                None,
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        let milestone = db
            .add_level_milestone_with_changes(
                character.id.clone(),
                2,
                Some(chapter.id.clone()),
                false,
                Some(900),
                vec![
                    LevelStatChangeInput {
                        stat_name: " Strength ".into(),
                        amount: Some(2),
                        value_after: Some(18),
                    },
                    LevelStatChangeInput {
                        stat_name: "Agility".into(),
                        amount: Some(1),
                        value_after: None,
                    },
                ],
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(milestone.stat_changes.len(), 2);
        assert_eq!(milestone.stat_changes[0].stat_name, "Agility");
        assert_eq!(milestone.stat_changes[0].amount, Some(1));
        assert_eq!(milestone.stat_changes[0].value_after, None);
        assert_eq!(milestone.stat_changes[1].stat_name, "Strength");
        assert_eq!(milestone.stat_changes[1].amount, Some(2));
        assert_eq!(milestone.stat_changes[1].value_after, Some(18));

        let event = db
            .add_skill_event(
                skill.id.clone(),
                "upgraded".into(),
                None,
                Some("Rank 2".into()),
                Some(milestone.id.clone()),
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(event.milestone_id.as_deref(), Some(milestone.id.as_str()));
        assert_eq!(
            event.chapter_id.as_deref(),
            Some(chapter.id.as_str()),
            "a linked event inherits the level-up's chapter"
        );

        // A level-up from another character is not a valid link.
        let other = db
            .create_character(story.id.clone(), "Wren".into(), None, "Ada".into())
            .unwrap();
        let other_milestone = db
            .add_level_milestone(other.id.clone(), 1, None, false, "Ada".into())
            .unwrap();
        assert!(db
            .add_skill_event(
                skill.id.clone(),
                "used".into(),
                Some(chapter.id.clone()),
                None,
                Some(other_milestone.id.clone()),
                "Ada".into(),
            )
            .is_err());

        // Deleting the level-up unlinks its skill change instead of deleting it.
        db.delete_level_milestone(&milestone.id, "Ada".into())
            .unwrap();
        let events = db.list_skill_events(&skill.id).unwrap();
        assert_eq!(events[0].id, event.id);
        assert_eq!(events[0].milestone_id, None);
    }

    #[test]
    fn an_export_written_before_milestone_metrics_still_imports() {
        let (source, story, character, chapter, _) = skill_story();
        source
            .add_level_milestone(
                character.id.clone(),
                4,
                Some(chapter.id.clone()),
                false,
                "Ada".into(),
            )
            .unwrap();

        let export = source.export_story(&story.id).unwrap();
        let mut value = serde_json::to_value(&export).unwrap();
        for milestone in value
            .get_mut("character_level_milestones")
            .and_then(|value| value.as_array_mut())
            .expect("the milestone is in the export")
        {
            let object = milestone.as_object_mut().unwrap();
            object.remove("xp");
            object.remove("stat_name");
            object.remove("stat_points");
        }

        let older: StoryExport = serde_json::from_value(value).unwrap();
        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(older, "Grace".into()).unwrap();
        let milestones = target.list_story_level_milestones(&restored.id).unwrap();

        assert_eq!(milestones.len(), 1);
        assert_eq!(milestones[0].level, 4);
        assert_eq!(milestones[0].xp, None);
        assert_eq!(milestones[0].stat_name, None);
        assert_eq!(milestones[0].stat_points, None);
    }

    #[test]
    fn purging_a_chapter_clears_level_and_skill_links() {
        let (db, _, character, chapter, _) = skill_story();
        let skill = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 1".into()),
                None,
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();
        let milestone = db
            .add_level_milestone(
                character.id.clone(),
                3,
                Some(chapter.id.clone()),
                false,
                "Ada".into(),
            )
            .unwrap();
        let event = db
            .add_skill_event(
                skill.id.clone(),
                "upgraded".into(),
                Some(chapter.id.clone()),
                Some("Rank 2".into()),
                None,
                "Ada".into(),
            )
            .unwrap();

        db.delete_node(&chapter.id, "Ada".into()).unwrap();
        db.purge_node(&chapter.id, "Ada".into()).unwrap();

        let milestones = db.list_level_milestones(&character.id).unwrap();
        assert_eq!(milestones[0].id, milestone.id);
        assert_eq!(milestones[0].chapter_id, None);

        let events = db.list_skill_events(&skill.id).unwrap();
        assert_eq!(events[0].id, event.id);
        assert_eq!(events[0].chapter_id, None);
    }

    #[test]
    fn levels_and_skill_events_travel_with_an_export() {
        let (source, story, character, chapter, _) = skill_story();
        let skill = source
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 2".into()),
                None,
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();
        let milestone = source
            .add_level_milestone_with_changes(
                character.id.clone(),
                5,
                Some(chapter.id.clone()),
                false,
                Some(2400),
                vec![
                    LevelStatChangeInput {
                        stat_name: "Strength".into(),
                        amount: Some(2),
                        value_after: Some(22),
                    },
                    LevelStatChangeInput {
                        stat_name: "Agility".into(),
                        amount: Some(1),
                        value_after: Some(12),
                    },
                ],
                "Ada".into(),
            )
            .unwrap();
        source
            .add_skill_event(
                skill.id.clone(),
                "upgraded".into(),
                Some(chapter.id.clone()),
                Some("Rank 2".into()),
                Some(milestone.id.clone()),
                "Ada".into(),
            )
            .unwrap();

        let export = source.export_story(&story.id).unwrap();
        assert_eq!(export.character_level_milestones.len(), 1);
        assert_eq!(export.character_skill_events.len(), 1);
        assert_eq!(
            export.character_level_milestones[0].chapter_id.as_deref(),
            Some(chapter.id.as_str())
        );
        assert_eq!(export.character_level_milestones[0].stat_changes.len(), 2);
        assert_eq!(
            export.character_skill_events[0].chapter_id.as_deref(),
            Some(chapter.id.as_str())
        );
        assert_eq!(
            export.character_skill_events[0].milestone_id.as_deref(),
            Some(milestone.id.as_str())
        );

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(export, "Grace".into()).unwrap();
        let nodes = target.list_nodes(&restored.id).unwrap();
        let skills = target.list_story_skills(&restored.id).unwrap();
        let milestones = target.list_story_level_milestones(&restored.id).unwrap();
        let events = target.list_story_skill_events(&restored.id).unwrap();

        let chapter_id = nodes
            .iter()
            .find(|node| node.node_type == "chapter")
            .map(|node| node.id.clone())
            .expect("the chapter came across");

        assert_eq!(milestones.len(), 1);
        assert_eq!(milestones[0].level, 5);
        assert_eq!(milestones[0].xp, Some(2400));
        assert_eq!(milestones[0].stat_changes.len(), 2);
        assert_eq!(milestones[0].stat_changes[0].stat_name, "Agility");
        assert_eq!(milestones[0].stat_changes[0].amount, Some(1));
        assert_eq!(milestones[0].stat_changes[0].value_after, Some(12));
        assert_eq!(milestones[0].stat_changes[1].stat_name, "Strength");
        assert_eq!(milestones[0].stat_changes[1].amount, Some(2));
        assert_eq!(milestones[0].stat_changes[1].value_after, Some(22));
        assert_eq!(
            milestones[0].chapter_id.as_deref(),
            Some(chapter_id.as_str())
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].skill_id, skills[0].id);
        assert_eq!(events[0].chapter_id.as_deref(), Some(chapter_id.as_str()));
        assert_eq!(events[0].rank.as_deref(), Some("Rank 2"));
        assert_eq!(
            events[0].milestone_id.as_deref(),
            Some(milestones[0].id.as_str())
        );

        let history = target
            .get_audit_log(Some(&restored.id), None, None, 500)
            .unwrap();
        assert!(history
            .iter()
            .any(|entry| entry.entity_id == milestones[0].id));
        assert!(history.iter().any(|entry| entry.entity_id == events[0].id));
    }

    #[test]
    fn an_export_written_before_level_and_skill_events_still_imports() {
        let (source, story, character, chapter, _) = skill_story();
        source
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                None,
                None,
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        let export = source.export_story(&story.id).unwrap();
        let mut value = serde_json::to_value(&export).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("character_level_milestones");
        object.remove("character_skill_events");
        let older: StoryExport = serde_json::from_value(value).unwrap();
        assert!(older.character_level_milestones.is_empty());
        assert!(older.character_skill_events.is_empty());

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(older, "Grace".into()).unwrap();
        assert!(target
            .list_story_level_milestones(&restored.id)
            .unwrap()
            .is_empty());
        assert!(target
            .list_story_skill_events(&restored.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn xp_income_is_one_amount_per_character_per_chapter() {
        let (db, story, character, chapter, _) = skill_story();

        let entry = db
            .add_character_progress(character.id.clone(), chapter.id.clone(), 500, "Ada".into())
            .unwrap();

        assert_eq!(entry.xp_earned, 500);
        assert_eq!(entry.chapter_id, chapter.id);
        assert_eq!(db.list_character_progress(&character.id).unwrap().len(), 1);
        assert_eq!(
            db.list_story_character_progress(&story.id).unwrap().len(),
            1
        );

        let duplicate = db
            .add_character_progress(character.id.clone(), chapter.id.clone(), 25, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(duplicate.contains("already has XP"), "{duplicate}");

        let negative = db
            .add_character_progress(character.id.clone(), chapter.id.clone(), -1, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(negative.contains("cannot be negative"), "{negative}");

        let second = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let updated = db
            .update_character_progress(entry.id.clone(), second.id.clone(), 700, "Ada".into())
            .unwrap();
        assert_eq!(updated.chapter_id, second.id);
        assert_eq!(updated.xp_earned, 700);

        let history = db
            .get_audit_log(
                Some(&story.id),
                Some("character_progress"),
                Some(&entry.id),
                100,
            )
            .unwrap();
        assert!(history.iter().any(|event| {
            event.field_changed.as_deref() == Some("xp_earned")
                && event.old_value.as_deref() == Some("500")
                && event.new_value.as_deref() == Some("700")
        }));
        assert!(history.iter().any(|event| {
            event.field_changed.as_deref() == Some("chapter")
                && event.new_value.as_deref() == Some("Chapter Two")
        }));

        let before = history.len();
        db.update_character_progress(entry.id.clone(), second.id.clone(), 700, "Ada".into())
            .unwrap();
        assert_eq!(
            db.get_audit_log(
                Some(&story.id),
                Some("character_progress"),
                Some(&entry.id),
                100,
            )
            .unwrap()
            .len(),
            before,
            "saving the same income writes nothing"
        );

        db.delete_character_progress(&entry.id, "Ada".into())
            .unwrap();
        assert!(db
            .list_story_character_progress(&story.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn xp_income_cannot_move_onto_a_chapter_that_already_has_it() {
        let (db, story, character, first, _) = skill_story();
        let second = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let entry = db
            .add_character_progress(character.id.clone(), first.id.clone(), 100, "Ada".into())
            .unwrap();
        db.add_character_progress(character.id.clone(), second.id.clone(), 200, "Ada".into())
            .unwrap();

        let refused = db
            .update_character_progress(entry.id.clone(), second.id.clone(), 300, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(refused.contains("already has XP"), "{refused}");
    }

    #[test]
    fn purging_a_chapter_removes_its_xp_income() {
        let (db, story, character, chapter, _) = skill_story();

        db.add_character_progress(character.id.clone(), chapter.id.clone(), 400, "Ada".into())
            .unwrap();

        db.delete_node(&chapter.id, "Ada".into()).unwrap();
        db.purge_node(&chapter.id, "Ada".into()).unwrap();

        assert!(db
            .list_story_character_progress(&story.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn xp_income_travels_with_an_export() {
        let (source, story, character, chapter, _) = skill_story();
        source
            .add_character_progress(character.id.clone(), chapter.id.clone(), 650, "Ada".into())
            .unwrap();

        let export = source.export_story(&story.id).unwrap();
        assert_eq!(export.character_progress.len(), 1);
        assert_eq!(export.character_progress[0].xp_earned, 650);

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(export, "Grace".into()).unwrap();
        let progress = target.list_story_character_progress(&restored.id).unwrap();
        let nodes = target.list_nodes(&restored.id).unwrap();
        let chapter_id = nodes
            .iter()
            .find(|node| node.node_type == "chapter")
            .map(|node| node.id.clone())
            .expect("the chapter came across");

        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0].xp_earned, 650);
        assert_eq!(progress[0].chapter_id, chapter_id);
    }

    #[test]
    fn a_trashed_chapters_xp_income_stays_out_of_an_export() {
        let (source, story, character, chapter, _) = skill_story();
        source
            .add_character_progress(character.id.clone(), chapter.id.clone(), 300, "Ada".into())
            .unwrap();
        source.delete_node(&chapter.id, "Ada".into()).unwrap();

        let export = source.export_story(&story.id).unwrap();
        assert!(export.character_progress.is_empty());
    }

    #[test]
    fn an_export_written_before_xp_income_still_imports() {
        let (source, story, _, _, _) = skill_story();
        let export = source.export_story(&story.id).unwrap();
        let mut value = serde_json::to_value(&export).unwrap();
        value.as_object_mut().unwrap().remove("character_progress");

        let older: StoryExport = serde_json::from_value(value).unwrap();
        assert!(older.character_progress.is_empty());

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(older, "Grace".into()).unwrap();
        assert!(target
            .list_story_character_progress(&restored.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_chapter_state_reads_levels_in_reading_order_not_entry_order() {
        let (db, story, character, one, _) = skill_story();
        let third = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Three".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let second = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let prologue = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Prologue".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        db.set_chapter_order(
            &story.id,
            vec![
                prologue.id.clone(),
                one.id.clone(),
                third.id.clone(),
                second.id.clone(),
            ],
            "Ada".into(),
        )
        .unwrap();

        // The milestones are entered in a different order from the chapters, so
        // a query that trusted `created_at` would give the wrong answer.
        let first = db
            .add_level_milestone(
                character.id.clone(),
                2,
                Some(one.id.clone()),
                false,
                "Ada".into(),
            )
            .unwrap();
        db.add_level_milestone(
            character.id.clone(),
            9,
            Some(second.id.clone()),
            false,
            "Ada".into(),
        )
        .unwrap();
        let penalty = db
            .add_level_milestone(
                character.id.clone(),
                6,
                Some(third.id.clone()),
                true,
                "Ada".into(),
            )
            .unwrap();

        let before = db
            .character_state_at_chapter(&character.id, &prologue.id)
            .unwrap();
        assert_eq!(before.chapter_seq, 1);
        assert_eq!(before.level, None, "no milestone had happened yet");
        assert!(before.skills.is_empty());

        let opening = db
            .character_state_at_chapter(&character.id, &one.id)
            .unwrap();
        assert_eq!(opening.chapter_seq, 2);
        assert_eq!(opening.level, Some(2));
        assert_eq!(
            opening.level_milestone_id.as_deref(),
            Some(first.id.as_str())
        );
        assert!(!opening.level_is_penalty);

        let middle = db
            .character_state_at_chapter(&character.id, &third.id)
            .unwrap();
        assert_eq!(middle.chapter_seq, 3);
        assert_eq!(middle.level, Some(6));
        assert_eq!(
            middle.level_milestone_id.as_deref(),
            Some(penalty.id.as_str())
        );
        assert!(
            middle.level_is_penalty,
            "the penalty flag travels with the level"
        );

        let last = db
            .character_state_at_chapter(&character.id, &second.id)
            .unwrap();
        assert_eq!(last.chapter_seq, 4);
        assert_eq!(last.level, Some(9));

        let other = db
            .create_story("Embers".into(), None, "Ada".into())
            .unwrap();
        let elsewhere = db
            .create_node(
                other.id.clone(),
                "chapter".into(),
                "Elsewhere".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        assert!(
            db.character_state_at_chapter(&character.id, &elsewhere.id)
                .is_err(),
            "a chapter from another story is not a valid anchor"
        );
    }

    #[test]
    fn a_chapter_state_lists_only_the_skills_active_then() {
        let (db, story, character, one, _) = skill_story();
        let two = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let three = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Three".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let fireball = db
            .add_skill(
                character.id.clone(),
                "Fireball".into(),
                Some("Rank 1".into()),
                Some("3d6 fire".into()),
                Some(one.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();
        let shield = db
            .add_skill(
                character.id.clone(),
                "Shield".into(),
                Some("Novice".into()),
                None,
                Some(two.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();
        db.add_skill(
            character.id.clone(),
            "Unplaced".into(),
            None,
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        db.add_skill_event(
            fireball.id.clone(),
            "upgraded".into(),
            Some(two.id.clone()),
            Some("Rank 2".into()),
            None,
            "Ada".into(),
        )
        .unwrap();
        db.add_skill_event(
            shield.id.clone(),
            "sacrificed".into(),
            Some(three.id.clone()),
            None,
            None,
            "Ada".into(),
        )
        .unwrap();
        // A use recorded at the same chapter as the sacrifice does not revive it.
        db.add_skill_event(
            shield.id.clone(),
            "used".into(),
            Some(three.id.clone()),
            Some("Novice".into()),
            None,
            "Ada".into(),
        )
        .unwrap();

        let opening = db
            .character_state_at_chapter(&character.id, &one.id)
            .unwrap();
        assert_eq!(opening.skills.len(), 1);
        assert_eq!(opening.skills[0].name, "Fireball");
        assert_eq!(opening.skills[0].rank.as_deref(), Some("Rank 1"));
        assert_eq!(
            opening.skills[0].learned_chapter_id.as_str(),
            one.id.as_str()
        );
        assert_eq!(opening.skills[0].learned_chapter_seq, 1);

        let middle = db
            .character_state_at_chapter(&character.id, &two.id)
            .unwrap();
        assert_eq!(middle.skills.len(), 2);
        let upgraded = middle
            .skills
            .iter()
            .find(|skill| skill.name == "Fireball")
            .unwrap();
        assert_eq!(upgraded.rank.as_deref(), Some("Rank 2"));
        assert!(middle.skills.iter().any(|skill| skill.name == "Shield"));
        assert!(
            !middle.skills.iter().any(|skill| skill.name == "Unplaced"),
            "a skill with no chapter cannot be placed in a scene"
        );

        let end = db
            .character_state_at_chapter(&character.id, &three.id)
            .unwrap();
        assert_eq!(end.skills.len(), 1);
        assert_eq!(end.skills[0].name, "Fireball");
        assert_eq!(end.skills[0].rank.as_deref(), Some("Rank 2"));
        assert!(
            !end.skills.iter().any(|skill| skill.name == "Shield"),
            "a sacrificed skill is no longer active"
        );
    }

    #[test]
    fn chapter_cast_states_follow_the_linked_cast_and_pov_without_duplicates() {
        let (db, story, character, one, _) = skill_story();
        let wren = db
            .create_character(story.id.clone(), "Wren".into(), None, "Ada".into())
            .unwrap();
        let tess = db
            .create_character(story.id.clone(), "Tess".into(), None, "Ada".into())
            .unwrap();
        let two = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let three = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Three".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        db.set_node_character(&one.id, Some(character.id.clone()), "Ada".into())
            .unwrap();
        // The second chapter names Wren in both ways. The card should not show
        // her twice because the two links happen to agree.
        db.set_node_character(&two.id, Some(wren.id.clone()), "Ada".into())
            .unwrap();
        db.set_chapter_details(
            &two.id,
            None,
            None,
            None,
            Some(wren.id.clone()),
            None,
            None,
            "Ada".into(),
        )
        .unwrap();
        // The third chapter links Tess, who has no milestone at all.
        db.set_node_character(&three.id, Some(tess.id.clone()), "Ada".into())
            .unwrap();

        db.add_level_milestone(
            character.id.clone(),
            3,
            Some(one.id.clone()),
            false,
            "Ada".into(),
        )
        .unwrap();
        db.add_level_milestone(
            wren.id.clone(),
            2,
            Some(two.id.clone()),
            false,
            "Ada".into(),
        )
        .unwrap();

        let states = db.list_chapter_cast_states(&story.id).unwrap();

        assert_eq!(states.len(), 3);

        let opening = states
            .iter()
            .find(|state| state.chapter_id == one.id)
            .unwrap();
        assert_eq!(opening.character_id, character.id);
        assert_eq!(opening.level, Some(3));

        let second: Vec<_> = states
            .iter()
            .filter(|state| state.chapter_id == two.id)
            .collect();
        assert_eq!(second.len(), 1, "the same cast member is shown once");
        assert_eq!(second[0].character_id, wren.id);
        assert_eq!(second[0].level, Some(2));

        let third = states
            .iter()
            .find(|state| state.chapter_id == three.id)
            .unwrap();
        assert_eq!(third.character_id, tess.id);
        assert_eq!(
            third.level, None,
            "a character with no milestone yet keeps a badge but no level"
        );
    }

    #[test]
    fn an_explicit_chapter_cast_joins_the_linked_cast_and_pov_without_duplicates() {
        let (db, story, rook, chapter, _) = skill_story();
        let wren = db
            .create_character(story.id.clone(), "Wren".into(), None, "Ada".into())
            .unwrap();
        let tess = db
            .create_character(story.id.clone(), "Tess".into(), None, "Ada".into())
            .unwrap();

        db.set_node_character(&chapter.id, Some(rook.id.clone()), "Ada".into())
            .unwrap();
        db.set_chapter_details(
            &chapter.id,
            None,
            None,
            None,
            Some(wren.id.clone()),
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        let tess_member = db
            .add_chapter_cast_member(chapter.id.clone(), tess.id.clone(), "Ada".into())
            .unwrap();
        let wren_member = db
            .add_chapter_cast_member(chapter.id.clone(), wren.id.clone(), "Ada".into())
            .unwrap();

        let members = db.list_story_chapter_cast(&story.id).unwrap();
        assert_eq!(members.len(), 2, "only the explicit rows are listed");
        assert!(members.iter().any(|member| member.id == tess_member.id));

        // Adding the same person again is a no-op rather than a duplicate row.
        let again = db
            .add_chapter_cast_member(chapter.id.clone(), wren.id.clone(), "Ada".into())
            .unwrap();
        assert_eq!(again.id, wren_member.id);
        assert_eq!(db.list_story_chapter_cast(&story.id).unwrap().len(), 2);

        let states = db.list_chapter_cast_states(&story.id).unwrap();
        assert_eq!(states.len(), 3, "linked cast, POV and Tess, each once");
        assert!(states.iter().all(|state| state.chapter_id == chapter.id));
        for character in [&rook, &wren, &tess] {
            assert!(
                states
                    .iter()
                    .any(|state| state.character_id == character.id),
                "{} has a badge exactly once",
                character.name
            );
        }

        db.remove_chapter_cast_member(&wren_member.id, "Ada".into())
            .unwrap();
        assert_eq!(db.list_story_chapter_cast(&story.id).unwrap().len(), 1);
        let after = db.list_chapter_cast_states(&story.id).unwrap();
        assert_eq!(
            after.len(),
            3,
            "removing the explicit row leaves the POV badge"
        );
    }

    #[test]
    fn chapter_cast_refuses_a_character_or_node_from_outside_the_story() {
        let (db, story, _, chapter, card) = skill_story();
        let other = db.create_story("Other".into(), None, "Ada".into()).unwrap();
        let outsider = db
            .create_character(other.id.clone(), "Mara".into(), None, "Ada".into())
            .unwrap();

        assert!(matches!(
            db.add_chapter_cast_member(chapter.id.clone(), outsider.id.clone(), "Ada".into(),),
            Err(DbError::Invalid(_))
        ));
        assert!(matches!(
            db.add_chapter_cast_member(
                card.id.clone(),
                db.list_characters(&story.id).unwrap()[0].id.clone(),
                "Ada".into(),
            ),
            Err(DbError::Invalid(_))
        ));
        assert!(db.list_story_chapter_cast(&story.id).unwrap().is_empty());
    }

    #[test]
    fn purging_a_chapter_removes_its_cast_rows() {
        let (db, story, character, chapter, _) = skill_story();
        db.add_chapter_cast_member(chapter.id.clone(), character.id.clone(), "Ada".into())
            .unwrap();

        db.delete_node(&chapter.id, "Ada".into()).unwrap();
        assert!(
            db.list_story_chapter_cast(&story.id).unwrap().is_empty(),
            "a trashed chapter takes its explicit cast out of view"
        );

        db.purge_node(&chapter.id, "Ada".into()).unwrap();
        let remaining: i64 = db
            .conn()
            .unwrap()
            .query_row("SELECT count(*) FROM chapter_cast", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "the foreign key cleans the rows up");
    }

    #[test]
    fn a_chapter_cast_travels_with_an_export_and_an_older_file_still_imports() {
        let (source, story, character, chapter, _) = skill_story();
        let wren = source
            .create_character(story.id.clone(), "Wren".into(), None, "Ada".into())
            .unwrap();
        source
            .add_chapter_cast_member(chapter.id.clone(), character.id.clone(), "Ada".into())
            .unwrap();
        let member = source
            .add_chapter_cast_member(chapter.id.clone(), wren.id.clone(), "Ada".into())
            .unwrap();

        let export = source.export_story(&story.id).unwrap();
        assert_eq!(export.chapter_cast.len(), 2);
        let mut value = serde_json::to_value(&export).unwrap();

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(export, "Grace".into()).unwrap();
        let restored_characters = target.list_characters(&restored.id).unwrap();
        let restored_chapters = target.list_nodes(&restored.id).unwrap();
        let restored_cast = target.list_story_chapter_cast(&restored.id).unwrap();
        assert_eq!(restored_cast.len(), 2);
        assert!(restored_cast.iter().all(|row| {
            row.chapter_id == restored_chapters[0].id
                && restored_characters
                    .iter()
                    .any(|character| character.id == row.character_id)
        }));
        assert!(restored_cast.iter().all(|row| row.id != member.id));

        value.as_object_mut().unwrap().remove("chapter_cast");
        let older: StoryExport = serde_json::from_value(value).unwrap();
        assert!(older.chapter_cast.is_empty());
        let old_copy = target.import_story(older, "Grace".into()).unwrap();
        assert!(target
            .list_story_chapter_cast(&old_copy.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn migrating_a_version_15_database_adds_chapter_cast() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        for block in [
            MIGRATION_002,
            MIGRATION_003,
            MIGRATION_004,
            MIGRATION_005,
            MIGRATION_006,
            MIGRATION_007,
            MIGRATION_008,
            MIGRATION_009,
            MIGRATION_010,
            MIGRATION_011,
            MIGRATION_012,
            MIGRATION_013,
            MIGRATION_014,
            MIGRATION_015,
        ] {
            conn.execute_batch(block).unwrap();
        }
        conn.pragma_update(None, "user_version", 15).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES ('s1', 'Written before v16', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO characters (id, story_id, name, description, created_at, updated_at)
             VALUES ('c1', 's1', 'Rook', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO nodes (id, story_id, node_type, label, pos_x, pos_y, created_by, created_at, updated_at)
             VALUES ('n1', 's1', 'chapter', 'One', 0, 0, 'Ada', 'then', 'then')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        conn.execute(
            "INSERT INTO chapter_cast (id, chapter_id, character_id, created_at, updated_at)
             VALUES ('cc1', 'n1', 'c1', 'now', 'now')",
            [],
        )
        .unwrap();

        let title: String = conn
            .query_row("SELECT title FROM stories WHERE id = 's1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "Written before v16");
    }

    #[test]
    fn migrating_a_version_18_database_moves_the_stat_snapshot_into_a_change() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        for block in [
            MIGRATION_002,
            MIGRATION_003,
            MIGRATION_004,
            MIGRATION_005,
            MIGRATION_006,
            MIGRATION_007,
            MIGRATION_008,
            MIGRATION_009,
            MIGRATION_010,
            MIGRATION_011,
            MIGRATION_012,
            MIGRATION_013,
            MIGRATION_014,
            MIGRATION_015,
            MIGRATION_016,
            MIGRATION_017,
            MIGRATION_018,
        ] {
            conn.execute_batch(block).unwrap();
        }
        conn.pragma_update(None, "user_version", 18).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES ('s1', 'Written before v19', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO characters (id, story_id, name, description, created_at, updated_at)
             VALUES ('c1', 's1', 'Rook', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO nodes (id, story_id, node_type, label, pos_x, pos_y, created_by, created_at, updated_at)
             VALUES ('n1', 's1', 'chapter', 'One', 0, 0, 'Ada', 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO character_level_milestones
             (id, character_id, level, chapter_id, is_debuff, xp, stat_name,
              stat_points, created_at, updated_at)
             VALUES ('m1', 'c1', 3, 'n1', 0, 1200, 'Strength', 18, 'now', 'now')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let change: (String, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT stat_name, amount, value_after
                 FROM character_level_stat_changes WHERE milestone_id = 'm1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(change, ("Strength".into(), None, Some(18)));

        // A skill event can now point at the migrated level-up.
        conn.execute(
            "INSERT INTO character_skills
             (id, character_id, name, rank, effect, chapter_id, node_id,
              created_at, updated_at)
             VALUES ('sk1', 'c1', 'Dash', NULL, NULL, 'n1', NULL, 'now', 'now')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO character_skill_events
             (id, skill_id, kind, chapter_id, rank, milestone_id, created_at, updated_at)
             VALUES ('e1', 'sk1', 'upgraded', 'n1', 'Rank 2', 'm1', 'now', 'now')",
            [],
        )
        .unwrap();

        let linked: Option<String> = conn
            .query_row(
                "SELECT milestone_id FROM character_skill_events WHERE id = 'e1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(linked.as_deref(), Some("m1"));
    }

    #[test]
    fn migrating_a_version_20_database_adds_the_quest_ledger() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        for block in [
            MIGRATION_002,
            MIGRATION_003,
            MIGRATION_004,
            MIGRATION_005,
            MIGRATION_006,
            MIGRATION_007,
            MIGRATION_008,
            MIGRATION_009,
            MIGRATION_010,
            MIGRATION_011,
            MIGRATION_012,
            MIGRATION_013,
            MIGRATION_014,
            MIGRATION_015,
            MIGRATION_016,
            MIGRATION_017,
            MIGRATION_018,
            MIGRATION_019,
            MIGRATION_020,
        ] {
            conn.execute_batch(block).unwrap();
        }
        conn.pragma_update(None, "user_version", 20).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES ('s1', 'Written before v21', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO characters (id, story_id, name, description, created_at, updated_at)
             VALUES ('c1', 's1', 'Rook', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO nodes (id, story_id, node_type, label, pos_x, pos_y, created_by, created_at, updated_at)
             VALUES ('n1', 's1', 'chapter', 'One', 0, 0, 'Ada', 'then', 'then')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let db = Db {
            conn: Mutex::new(conn),
            path: None,
        };

        assert!(db.list_story_quests("s1", None).unwrap().is_empty());

        let quest = db
            .add_quest(
                "s1".into(),
                "The Ledger".into(),
                Some("c1".into()),
                None,
                "n1".into(),
                None,
                "active".into(),
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(
            db.list_story_quests("s1", None).unwrap()[0].id,
            quest.id,
            "a story written before v21 gains an empty quest ledger"
        );
    }

    #[test]
    fn migrating_a_version_17_database_adds_the_xp_ledger() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(BASE_SCHEMA).unwrap();
        conn.execute_batch(INDEXES).unwrap();
        for block in [
            MIGRATION_002,
            MIGRATION_003,
            MIGRATION_004,
            MIGRATION_005,
            MIGRATION_006,
            MIGRATION_007,
            MIGRATION_008,
            MIGRATION_009,
            MIGRATION_010,
            MIGRATION_011,
            MIGRATION_012,
            MIGRATION_013,
            MIGRATION_014,
            MIGRATION_015,
            MIGRATION_016,
            MIGRATION_017,
        ] {
            conn.execute_batch(block).unwrap();
        }
        conn.pragma_update(None, "user_version", 17).unwrap();
        conn.execute(
            "INSERT INTO stories (id, title, description, created_at, updated_at)
             VALUES ('s1', 'Written before v18', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO characters (id, story_id, name, description, created_at, updated_at)
             VALUES ('c1', 's1', 'Rook', NULL, 'then', 'then')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO nodes (id, story_id, node_type, label, pos_x, pos_y, created_by, created_at, updated_at)
             VALUES ('n1', 's1', 'chapter', 'One', 0, 0, 'Ada', 'then', 'then')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        conn.execute(
            "INSERT INTO character_progress
             (id, character_id, chapter_id, xp_earned, created_at, updated_at)
             VALUES ('p1', 'c1', 'n1', 450, 'now', 'now')",
            [],
        )
        .unwrap();

        let earned: i64 = conn
            .query_row(
                "SELECT xp_earned FROM character_progress WHERE id = 'p1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(earned, 450);
    }

    // A story with a cast member, a chapter and an item card, which is the shape
    // every inventory test starts from.
    fn inventory_story() -> (Db, Story, Character, Node, Node) {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let character = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let chapter = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter One".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let card = db
            .create_node(
                story.id.clone(),
                "item".into(),
                "Iron Sword".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        (db, story, character, chapter, card)
    }

    // Two cast members, two chapters and a faction card: the shape relations and
    // standings tests start from.
    fn relations_story() -> (Db, Story, Character, Character, Node, Node, Node) {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let rook = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let mira = db
            .create_character(story.id.clone(), "Mira".into(), None, "Ada".into())
            .unwrap();
        let first = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter One".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let second = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let faction = db
            .create_node(
                story.id.clone(),
                "faction".into(),
                "The Ashen Guild".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        (db, story, rook, mira, first, second, faction)
    }

    #[test]
    fn relations_join_two_cast_members_once_in_either_direction() {
        let (db, story, rook, mira, first, _, _) = relations_story();

        let relation = db
            .add_relation(
                rook.id.clone(),
                mira.id.clone(),
                "  Ally  ".into(),
                Some("  Saved her in the pass  ".into()),
                Some(first.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(relation.kind, "Ally", "the kind keeps the author's word");
        assert_eq!(relation.note.as_deref(), Some("Saved her in the pass"));
        assert_eq!(
            relation.since_chapter_id.as_deref(),
            Some(first.id.as_str())
        );

        // Ally is symmetric, so the same bond entered from the other side is a
        // duplicate rather than a second row; the stored ids are in a fixed order.
        let reversed = db.add_relation(
            mira.id.clone(),
            rook.id.clone(),
            "ally".into(),
            None,
            None,
            None,
            "Ada".into(),
        );
        assert!(matches!(reversed, Err(DbError::Invalid(_))));

        // An asymmetric kind reads one way, so the other direction is a
        // different statement and is allowed.
        let mentor = db
            .add_relation(
                mira.id.clone(),
                rook.id.clone(),
                "mentor".into(),
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();
        assert_ne!(mentor.from_character_id, mentor.to_character_id);

        let self_link = db.add_relation(
            rook.id.clone(),
            rook.id.clone(),
            "ally".into(),
            None,
            None,
            None,
            "Ada".into(),
        );
        assert!(matches!(self_link, Err(DbError::Invalid(_))));

        let other = db
            .create_story("Elsewhere".into(), None, "Ada".into())
            .unwrap();
        let stranger = db
            .create_character(other.id, "Tess".into(), None, "Ada".into())
            .unwrap();
        let cross_story = db.add_relation(
            rook.id.clone(),
            stranger.id.clone(),
            "ally".into(),
            None,
            None,
            None,
            "Ada".into(),
        );
        assert!(matches!(cross_story, Err(DbError::Invalid(_))));

        assert_eq!(db.list_story_relations(&story.id).unwrap().len(), 2);
    }

    #[test]
    fn editing_and_deleting_a_relation_is_audited() {
        let (db, story, rook, mira, first, second, _) = relations_story();

        let relation = db
            .add_relation(
                rook.id.clone(),
                mira.id.clone(),
                "ally".into(),
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        let updated = db
            .update_relation(
                relation.id.clone(),
                "rival".into(),
                Some("The pass changed that".into()),
                Some(first.id.clone()),
                Some(second.id.clone()),
                "Grace".into(),
            )
            .unwrap();

        assert_eq!(updated.kind, "rival");
        assert_eq!(updated.since_chapter_id.as_deref(), Some(first.id.as_str()));
        assert_eq!(
            updated.until_chapter_id.as_deref(),
            Some(second.id.as_str())
        );

        let history = db
            .get_audit_log(Some(&story.id), Some("character_relation"), None, 50)
            .unwrap();
        let fields: Vec<&str> = history
            .iter()
            .filter_map(|entry| entry.field_changed.as_deref())
            .collect();
        assert!(fields.contains(&"kind"));
        assert!(fields.contains(&"note"));
        assert!(fields.contains(&"since"));
        assert!(fields.contains(&"until"));
        assert_eq!(history[0].changed_by, "Grace");

        db.delete_relation(&relation.id, "Grace".into()).unwrap();
        assert!(db.list_story_relations(&story.id).unwrap().is_empty());
        assert!(db
            .get_audit_log(Some(&story.id), Some("character_relation"), None, 50)
            .unwrap()
            .iter()
            .any(|entry| entry.action == "delete"));
    }

    #[test]
    fn a_relation_kind_and_note_can_be_put_back_from_the_history() {
        let (db, story, rook, mira, first, _, _) = relations_story();

        let relation = db
            .add_relation(
                rook.id.clone(),
                mira.id.clone(),
                "ally".into(),
                Some("Saved her in the pass".into()),
                Some(first.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        db.update_relation(
            relation.id.clone(),
            "rival".into(),
            Some("The pass changed that".into()),
            Some(first.id.clone()),
            None,
            "Grace".into(),
        )
        .unwrap();

        let history = db
            .get_audit_log(Some(&story.id), Some("character_relation"), None, 50)
            .unwrap();
        let kind_entry = history
            .iter()
            .find(|entry| {
                entry.entity_id == relation.id
                    && entry.action == "update"
                    && entry.field_changed.as_deref() == Some("kind")
            })
            .expect("the kind change is in the history")
            .clone();

        assert!(db.revert_change(&kind_entry.id, "Grace".into()).unwrap());

        let restored = db
            .list_story_relations(&story.id)
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == relation.id)
            .unwrap();
        assert_eq!(restored.kind, "ally");
        assert_eq!(restored.note.as_deref(), Some("The pass changed that"));
        assert!(
            restored.from_character_id <= restored.to_character_id,
            "a symmetric kind keeps its ends in the fixed order"
        );

        let note_entry = history
            .iter()
            .find(|entry| {
                entry.entity_id == relation.id
                    && entry.action == "update"
                    && entry.field_changed.as_deref() == Some("note")
            })
            .expect("the note change is in the history")
            .clone();

        db.revert_change(&note_entry.id, "Grace".into()).unwrap();

        let restored = db
            .list_story_relations(&story.id)
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == relation.id)
            .unwrap();
        assert_eq!(restored.note.as_deref(), Some("Saved her in the pass"));

        assert!(db
            .get_audit_log(Some(&story.id), Some("character_relation"), None, 80)
            .unwrap()
            .iter()
            .any(|entry| entry.action == "revert"));
    }

    #[test]
    fn putting_a_relation_kind_back_is_refused_when_that_bond_exists() {
        let (db, story, rook, mira, _, _, _) = relations_story();

        let relation = db
            .add_relation(
                rook.id.clone(),
                mira.id.clone(),
                "ally".into(),
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        db.update_relation(
            relation.id.clone(),
            "rival".into(),
            None,
            None,
            None,
            "Grace".into(),
        )
        .unwrap();

        // The author recorded the alliance again while the first row read as a
        // rivalry, so putting the old kind back would make two allies.
        db.add_relation(
            rook.id.clone(),
            mira.id.clone(),
            "ally".into(),
            None,
            None,
            None,
            "Grace".into(),
        )
        .unwrap();

        let kind_entry = db
            .get_audit_log(Some(&story.id), Some("character_relation"), None, 50)
            .unwrap()
            .into_iter()
            .find(|entry| {
                entry.entity_id == relation.id
                    && entry.action == "update"
                    && entry.field_changed.as_deref() == Some("kind")
            })
            .expect("the kind change is in the history");

        let refused = db.revert_change(&kind_entry.id, "Ada".into());
        assert!(matches!(refused, Err(DbError::Invalid(_))));

        let still = db
            .list_story_relations(&story.id)
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == relation.id)
            .unwrap();
        assert_eq!(still.kind, "rival");
    }

    #[test]
    fn a_faction_standing_word_can_be_put_back_from_the_history() {
        let (db, story, rook, _, first, _, faction) = relations_story();

        let standing = db
            .add_faction_standing(
                rook.id.clone(),
                Some(faction.id.clone()),
                "Captain".into(),
                None,
                first.id.clone(),
                None,
                "Ada".into(),
            )
            .unwrap();

        db.update_faction_standing(
            standing.id.clone(),
            Some(faction.id.clone()),
            "Exiled".into(),
            Some("The gate fell".into()),
            first.id.clone(),
            None,
            "Grace".into(),
        )
        .unwrap();

        let history = db
            .get_audit_log(Some(&story.id), Some("faction_standing"), None, 50)
            .unwrap();
        let entry = history
            .iter()
            .find(|entry| {
                entry.entity_id == standing.id
                    && entry.action == "update"
                    && entry.field_changed.as_deref() == Some("standing")
            })
            .expect("the word change is in the history")
            .clone();

        assert!(db.revert_change(&entry.id, "Grace".into()).unwrap());

        let restored = db
            .list_story_faction_standings(&story.id)
            .unwrap()
            .into_iter()
            .find(|row| row.id == standing.id)
            .unwrap();
        assert_eq!(restored.standing, "Captain");
        assert_eq!(restored.note.as_deref(), Some("The gate fell"));
    }

    #[test]
    fn a_faction_standing_needs_a_faction_card_and_the_chapter_it_began_in() {
        let (db, story, rook, _mira, first, second, faction) = relations_story();

        let standing = db
            .add_faction_standing(
                rook.id.clone(),
                Some(faction.id.clone()),
                "  Captain  ".into(),
                Some("  Sworn at the gate  ".into()),
                first.id.clone(),
                Some(second.id.clone()),
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(standing.standing, "Captain");
        assert_eq!(
            standing.faction_node_id.as_deref(),
            Some(faction.id.as_str())
        );
        assert_eq!(standing.note.as_deref(), Some("Sworn at the gate"));

        // An item card is not a faction, and a standing without an arc cannot be
        // placed, so both are refused before anything is written.
        let item_card = db
            .create_node(
                story.id.clone(),
                "item".into(),
                "Iron Sword".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let wrong_card = db.add_faction_standing(
            rook.id.clone(),
            Some(item_card.id),
            "member".into(),
            None,
            first.id.clone(),
            None,
            "Ada".into(),
        );
        assert!(matches!(wrong_card, Err(DbError::Invalid(_))));

        let no_chapter = db.add_faction_standing(
            rook.id.clone(),
            Some(faction.id.clone()),
            "member".into(),
            None,
            "not-a-chapter".into(),
            None,
            "Ada".into(),
        );
        assert!(matches!(no_chapter, Err(DbError::Invalid(_))));

        let updated = db
            .update_faction_standing(
                standing.id.clone(),
                Some(faction.id.clone()),
                "Exiled".into(),
                None,
                first.id.clone(),
                None,
                "Grace".into(),
            )
            .unwrap();
        assert_eq!(updated.standing, "Exiled");
        assert_eq!(updated.until_chapter_id, None);

        let fields: Vec<String> = db
            .get_audit_log(Some(&story.id), Some("faction_standing"), None, 50)
            .unwrap()
            .into_iter()
            .filter_map(|entry| entry.field_changed)
            .collect();
        assert!(fields.iter().any(|field| field == "standing"));
        assert!(fields.iter().any(|field| field == "until"));

        db.delete_faction_standing(&standing.id, "Grace".into())
            .unwrap();
        assert!(db
            .list_story_faction_standings(&story.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn relations_and_standings_travel_with_the_story() {
        let (db, story, rook, mira, first, second, faction) = relations_story();

        db.add_relation(
            rook.id.clone(),
            mira.id.clone(),
            "rival".into(),
            Some("For the ledger".into()),
            Some(first.id.clone()),
            Some(second.id.clone()),
            "Ada".into(),
        )
        .unwrap();
        db.add_faction_standing(
            mira.id.clone(),
            Some(faction.id.clone()),
            "Warden".into(),
            None,
            first.id.clone(),
            None,
            "Ada".into(),
        )
        .unwrap();

        let export = db.export_story(&story.id).unwrap();
        assert_eq!(export.character_relations.len(), 1);
        assert_eq!(export.faction_standings.len(), 1);

        let markdown = db.story_bible(&story.id).unwrap().markdown;
        assert!(markdown.contains("**rival** with Mira"));
        assert!(markdown.contains("**The Ashen Guild** — Warden"));

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(export, "Grace".into()).unwrap();

        let relations = target.list_story_relations(&restored.id).unwrap();
        assert_eq!(relations.len(), 1);
        assert_eq!(relations[0].kind, "rival");
        assert_eq!(relations[0].note.as_deref(), Some("For the ledger"));

        let characters = target.list_characters(&restored.id).unwrap();
        assert!(characters
            .iter()
            .any(|character| character.id == relations[0].from_character_id));
        assert!(characters
            .iter()
            .any(|character| character.id == relations[0].to_character_id));

        let standings = target.list_story_faction_standings(&restored.id).unwrap();
        assert_eq!(standings.len(), 1);
        assert_eq!(standings[0].standing, "Warden");

        let nodes = target.list_nodes(&restored.id).unwrap();
        let faction = nodes
            .iter()
            .find(|node| node.id == standings[0].faction_node_id.clone().unwrap())
            .expect("the faction card came with the copy");
        assert_eq!(faction.label, "The Ashen Guild");
    }

    #[test]
    fn an_older_export_without_relations_imports_as_an_empty_ledger() {
        let (db, story, _, _, _, _, _) = relations_story();
        let export = db.export_story(&story.id).unwrap();
        let mut older = serde_json::to_value(&export).unwrap();
        older.as_object_mut().unwrap().remove("character_relations");
        older.as_object_mut().unwrap().remove("faction_standings");
        let older: StoryExport = serde_json::from_value(older).unwrap();

        let restored = Db::open_in_memory()
            .unwrap()
            .import_story(older, "Grace".into())
            .unwrap();

        assert!(db.list_story_relations(&restored.id).unwrap().is_empty());
    }

    #[test]
    fn an_item_keeps_its_rarity_quantity_effect_and_chapter() {
        let (db, story, character, chapter, card) = inventory_story();

        let item = db
            .add_inventory_item(
                character.id.clone(),
                "  Iron Sword  ".into(),
                Some("  Rare  ".into()),
                2,
                Some("  +1 damage  ".into()),
                Some(chapter.id.clone()),
                None,
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(item.name, "Iron Sword", "the name is trimmed");
        assert_eq!(item.rarity.as_deref(), Some("Rare"));
        assert_eq!(item.quantity, 2);
        assert_eq!(item.effect.as_deref(), Some("+1 damage"));
        assert_eq!(item.chapter_id.as_deref(), Some(chapter.id.as_str()));
        assert_eq!(item.node_id.as_deref(), Some(card.id.as_str()));

        let carried = db.list_inventory(&character.id).unwrap();
        assert_eq!(carried.len(), 1);
        assert_eq!(carried[0].id, item.id);

        // An item card can name everyone carrying it.
        let board = db.list_story_inventory(&story.id).unwrap();
        assert_eq!(board.len(), 1);
        assert_eq!(board[0].character_id, character.id);
    }

    #[test]
    fn an_item_records_the_chapter_it_was_lost_in() {
        let (db, story, character, chapter, _) = inventory_story();
        let lost = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let item = db
            .add_inventory_item(
                character.id.clone(),
                "Iron Sword".into(),
                None,
                2,
                None,
                Some(chapter.id.clone()),
                Some(lost.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(item.lost_chapter_id.as_deref(), Some(lost.id.as_str()));
        assert_eq!(
            db.list_inventory(&character.id).unwrap()[0]
                .lost_chapter_id
                .as_deref(),
            Some(lost.id.as_str())
        );
        assert_eq!(
            db.list_story_inventory(&story.id).unwrap()[0]
                .lost_chapter_id
                .as_deref(),
            Some(lost.id.as_str())
        );
    }

    #[test]
    fn a_blank_rarity_is_stored_as_nothing_and_quantity_cannot_be_negative() {
        let (db, _, character, _, _) = inventory_story();

        let item = db
            .add_inventory_item(
                character.id.clone(),
                "Torch".into(),
                Some("   ".into()),
                0,
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(item.rarity, None);
        assert_eq!(item.effect, None);
        assert_eq!(item.quantity, 0, "a zero count is a real count");

        let error = db
            .add_inventory_item(
                character.id.clone(),
                "Debt".into(),
                None,
                -1,
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("cannot be negative"), "{error}");
        assert_eq!(db.list_inventory(&character.id).unwrap().len(), 1);
    }

    #[test]
    fn an_item_needs_a_unique_name_and_an_item_card_of_this_story() {
        let (db, story, character, _, _) = inventory_story();

        let error = db
            .add_inventory_item(
                character.id.clone(),
                "   ".into(),
                None,
                1,
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("needs a name"), "{error}");

        db.add_inventory_item(
            character.id.clone(),
            "Iron Sword".into(),
            None,
            1,
            None,
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        let error = db
            .add_inventory_item(
                character.id.clone(),
                "Iron Sword".into(),
                None,
                1,
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("already in"), "{error}");

        // A chapter from another story is refused, and so is a live card of the
        // wrong type in this one.
        let other = db
            .create_story("Embers".into(), None, "Ada".into())
            .unwrap();
        let theirs = db
            .create_node(
                other.id.clone(),
                "chapter".into(),
                "Their Chapter".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let error = db
            .add_inventory_item(
                character.id.clone(),
                "Lantern".into(),
                None,
                1,
                None,
                Some(theirs.id.clone()),
                None,
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("live chapter of this story"), "{error}");

        // A lost chapter is checked the same way as the chapter it was acquired in.
        let error = db
            .add_inventory_item(
                character.id.clone(),
                "Lantern".into(),
                None,
                1,
                None,
                None,
                Some(theirs.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("live chapter of this story"), "{error}");

        let skill = db
            .create_node(
                story.id.clone(),
                "skill".into(),
                "Fireball".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();

        let error = db
            .add_inventory_item(
                character.id.clone(),
                "Lantern".into(),
                None,
                1,
                None,
                None,
                None,
                Some(skill.id.clone()),
                "Ada".into(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("live item of this story"), "{error}");
        assert_eq!(db.list_inventory(&character.id).unwrap().len(), 1);
    }

    #[test]
    fn editing_an_item_records_each_field_it_changes() {
        let (db, story, character, chapter, card) = inventory_story();
        let second = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let lost = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Three".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let item = db
            .add_inventory_item(
                character.id.clone(),
                "Iron Sword".into(),
                Some("Common".into()),
                1,
                Some("+1 damage".into()),
                Some(chapter.id.clone()),
                Some(chapter.id.clone()),
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();

        let updated = db
            .update_inventory_item(
                item.id.clone(),
                "Greater Iron Sword".into(),
                Some("Epic".into()),
                3,
                Some("+2 damage".into()),
                Some(second.id.clone()),
                Some(lost.id.clone()),
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(updated.name, "Greater Iron Sword");
        assert_eq!(updated.rarity.as_deref(), Some("Epic"));
        assert_eq!(updated.quantity, 3);
        assert_eq!(updated.chapter_id.as_deref(), Some(second.id.as_str()));
        assert_eq!(updated.lost_chapter_id.as_deref(), Some(lost.id.as_str()));

        let history = db
            .get_audit_log(Some(&story.id), Some("character_inventory"), None, 100)
            .unwrap();
        let fields: Vec<&str> = history
            .iter()
            .filter_map(|entry| entry.field_changed.as_deref())
            .collect();

        assert_eq!(history[0].entity_id, item.id);
        for field in [
            "name",
            "rarity",
            "quantity",
            "effect",
            "chapter",
            "lost_chapter",
        ] {
            assert!(fields.contains(&field), "missing {field}");
        }
        assert!(history.iter().any(|entry| {
            entry.field_changed.as_deref() == Some("quantity")
                && entry.old_value.as_deref() == Some("1")
                && entry.new_value.as_deref() == Some("3")
        }));
        assert!(history
            .iter()
            .any(|entry| entry.field_changed.as_deref() == Some("chapter")
                && entry.new_value.as_deref() == Some("Chapter Two")));
        assert!(history.iter().any(|entry| {
            entry.field_changed.as_deref() == Some("lost_chapter")
                && entry.old_value.as_deref() == Some("Chapter One")
                && entry.new_value.as_deref() == Some("Chapter Three")
        }));
    }

    #[test]
    fn saving_the_same_item_writes_nothing() {
        let (db, story, character, chapter, card) = inventory_story();
        let item = db
            .add_inventory_item(
                character.id.clone(),
                "Iron Sword".into(),
                Some("Rare".into()),
                2,
                None,
                Some(chapter.id.clone()),
                None,
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();
        let before = db
            .get_audit_log(Some(&story.id), Some("character_inventory"), None, 100)
            .unwrap();

        let unchanged = db
            .update_inventory_item(
                item.id.clone(),
                "Iron Sword".into(),
                Some("Rare".into()),
                2,
                None,
                Some(chapter.id.clone()),
                None,
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();
        let after = db
            .get_audit_log(Some(&story.id), Some("character_inventory"), None, 100)
            .unwrap();

        assert_eq!(unchanged.updated_at, item.updated_at);
        assert_eq!(after.len(), before.len());
    }

    #[test]
    fn deleting_an_item_leaves_the_cast_member_alone() {
        let (db, story, character, _, _) = inventory_story();
        let item = db
            .add_inventory_item(
                character.id.clone(),
                "Iron Sword".into(),
                None,
                1,
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        db.delete_inventory_item(&item.id, "Ada".into()).unwrap();

        assert!(db.list_inventory(&character.id).unwrap().is_empty());
        assert_eq!(db.list_characters(&story.id).unwrap().len(), 1);

        // Deleting the same item twice is not an error, and records nothing more.
        db.delete_inventory_item(&item.id, "Ada".into()).unwrap();

        let history = db
            .get_audit_log(Some(&story.id), Some("character_inventory"), None, 100)
            .unwrap();
        assert_eq!(
            history
                .iter()
                .filter(|entry| entry.action == "delete")
                .count(),
            1
        );
    }

    #[test]
    fn a_trashed_character_takes_its_inventory_out_of_view() {
        let (db, story, character, _, _) = inventory_story();
        db.add_inventory_item(
            character.id.clone(),
            "Iron Sword".into(),
            None,
            1,
            None,
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        db.delete_character(&character.id, "Ada".into()).unwrap();

        assert!(db.list_inventory(&character.id).unwrap().is_empty());
        assert!(db.list_story_inventory(&story.id).unwrap().is_empty());
    }

    #[test]
    fn purging_a_chapter_clears_the_item_link_but_keeps_the_item() {
        let (db, _, character, chapter, _) = inventory_story();
        let item = db
            .add_inventory_item(
                character.id.clone(),
                "Iron Sword".into(),
                Some("Rare".into()),
                2,
                None,
                Some(chapter.id.clone()),
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();

        db.delete_node(&chapter.id, "Ada".into()).unwrap();
        db.purge_node(&chapter.id, "Ada".into()).unwrap();

        let carried = db.list_inventory(&character.id).unwrap();
        assert_eq!(carried.len(), 1);
        assert_eq!(carried[0].id, item.id);
        assert_eq!(
            carried[0].chapter_id, None,
            "the missing chapter is cleared"
        );
        assert_eq!(
            carried[0].lost_chapter_id, None,
            "the lost link is cleared too"
        );
    }

    #[test]
    fn inventory_and_currency_travel_with_an_export() {
        let (source, story, character, chapter, card) = inventory_story();
        let lost = source
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        source
            .add_inventory_item(
                character.id.clone(),
                "Iron Sword".into(),
                Some("Rare".into()),
                2,
                Some("+1 damage".into()),
                Some(chapter.id.clone()),
                Some(lost.id.clone()),
                Some(card.id.clone()),
                "Ada".into(),
            )
            .unwrap();
        source
            .add_currency(character.id.clone(), "Gold".into(), 250, "Ada".into())
            .unwrap();

        let export = source.export_story(&story.id).unwrap();
        assert_eq!(export.character_inventory.len(), 1);
        assert_eq!(export.character_currency.len(), 1);

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(export, "Grace".into()).unwrap();
        let characters = target.list_characters(&restored.id).unwrap();
        let items = target.list_story_inventory(&restored.id).unwrap();
        let currencies = target.list_story_currency(&restored.id).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "Iron Sword");
        assert_eq!(items[0].rarity.as_deref(), Some("Rare"));
        assert_eq!(items[0].quantity, 2);
        assert_eq!(items[0].effect.as_deref(), Some("+1 damage"));
        assert_eq!(items[0].character_id, characters[0].id);
        assert_ne!(items[0].chapter_id.as_deref(), Some(chapter.id.as_str()));
        assert_ne!(items[0].lost_chapter_id.as_deref(), Some(lost.id.as_str()));
        assert_ne!(items[0].node_id.as_deref(), Some(card.id.as_str()));

        let nodes = target.list_nodes(&restored.id).unwrap();
        let linked_chapter = nodes
            .iter()
            .find(|node| Some(node.id.as_str()) == items[0].chapter_id.as_deref())
            .expect("the chapter link is remapped");
        assert_eq!(linked_chapter.label, "Chapter One");
        let linked_lost = nodes
            .iter()
            .find(|node| Some(node.id.as_str()) == items[0].lost_chapter_id.as_deref())
            .expect("the lost chapter link is remapped");
        assert_eq!(linked_lost.label, "Chapter Two");
        let linked_card = nodes
            .iter()
            .find(|node| Some(node.id.as_str()) == items[0].node_id.as_deref())
            .expect("the item card link is remapped");
        assert_eq!(linked_card.node_type, "item");

        assert_eq!(currencies.len(), 1);
        assert_eq!(currencies[0].name, "Gold");
        assert_eq!(currencies[0].amount, 250);

        // Both rows' histories came along, pointing at the copies.
        let history = target
            .get_audit_log(Some(&restored.id), None, None, 200)
            .unwrap();
        assert!(history.iter().any(|entry| entry.entity_id == items[0].id));
        assert!(history
            .iter()
            .any(|entry| entry.entity_id == currencies[0].id));
    }

    #[test]
    fn an_export_written_before_the_lost_chapter_still_imports() {
        let (source, story, character, chapter, _) = inventory_story();
        source
            .add_inventory_item(
                character.id.clone(),
                "Iron Sword".into(),
                None,
                1,
                None,
                Some(chapter.id.clone()),
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        // Strip the field a pre-v14 export would not have had.
        let export = source.export_story(&story.id).unwrap();
        let mut value = serde_json::to_value(&export).unwrap();
        value
            .get_mut("character_inventory")
            .and_then(|items| items.get_mut(0))
            .and_then(|item| item.as_object_mut())
            .unwrap()
            .remove("lost_chapter_id");
        let older: StoryExport = serde_json::from_value(value).unwrap();
        assert_eq!(older.character_inventory[0].lost_chapter_id, None);

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(older, "Grace".into()).unwrap();
        let items = target.list_story_inventory(&restored.id).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "Iron Sword");
        assert_eq!(items[0].lost_chapter_id, None);
    }

    #[test]
    fn a_trashed_chapter_link_is_left_out_of_an_export() {
        let (source, story, character, chapter, _) = inventory_story();
        source
            .add_inventory_item(
                character.id.clone(),
                "Iron Sword".into(),
                None,
                1,
                None,
                Some(chapter.id.clone()),
                Some(chapter.id.clone()),
                None,
                "Ada".into(),
            )
            .unwrap();
        source.delete_node(&chapter.id, "Ada".into()).unwrap();

        let export = source.export_story(&story.id).unwrap();
        assert_eq!(export.character_inventory.len(), 1);
        assert_eq!(
            export.character_inventory[0].chapter_id, None,
            "a chapter in the trash is not in the file"
        );
        assert_eq!(
            export.character_inventory[0].lost_chapter_id, None,
            "a lost chapter in the trash is not in the file either"
        );

        let target = Db::open_in_memory().unwrap();
        let restored = target.import_story(export, "Grace".into()).unwrap();
        let items = target.list_story_inventory(&restored.id).unwrap();
        assert_eq!(items[0].name, "Iron Sword");
        assert_eq!(items[0].chapter_id, None);
        assert_eq!(items[0].lost_chapter_id, None);
    }

    #[test]
    fn currency_is_a_named_amount_with_its_own_history() {
        let (db, story, character, _, _) = inventory_story();
        let gold = db
            .add_currency(character.id.clone(), "  Gold  ".into(), 250, "Ada".into())
            .unwrap();

        assert_eq!(gold.name, "Gold");
        assert_eq!(gold.amount, 250);
        assert_eq!(db.list_currency(&character.id).unwrap().len(), 1);

        let updated = db
            .update_currency(gold.id.clone(), "Gold".into(), 300, "Ada".into())
            .unwrap();
        assert_eq!(updated.amount, 300);

        let history = db
            .get_audit_log(Some(&story.id), Some("character_currency"), None, 100)
            .unwrap();
        assert!(history.iter().any(|entry| {
            entry.field_changed.as_deref() == Some("amount")
                && entry.old_value.as_deref() == Some("250")
                && entry.new_value.as_deref() == Some("300")
        }));

        // Saving the same amount is not a change.
        let before = history.len();
        db.update_currency(gold.id.clone(), "Gold".into(), 300, "Ada".into())
            .unwrap();
        assert_eq!(
            db.get_audit_log(Some(&story.id), Some("character_currency"), None, 100)
                .unwrap()
                .len(),
            before
        );

        db.delete_currency(&gold.id, "Ada".into()).unwrap();
        assert!(db.list_currency(&character.id).unwrap().is_empty());
    }

    #[test]
    fn a_currency_needs_a_unique_name_and_a_non_negative_amount() {
        let (db, _, character, _, _) = inventory_story();

        let error = db
            .add_currency(character.id.clone(), "  ".into(), 10, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("needs a name"), "{error}");

        db.add_currency(character.id.clone(), "Gold".into(), 10, "Ada".into())
            .unwrap();

        let error = db
            .add_currency(character.id.clone(), "Gold".into(), 20, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("already one of"), "{error}");

        let error = db
            .add_currency(character.id.clone(), "Debt".into(), -5, "Ada".into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("cannot be negative"), "{error}");
    }

    #[test]
    fn item_counts_and_currency_amounts_are_revertible() {
        let (db, _, character, _, _) = inventory_story();
        let item = db
            .add_inventory_item(
                character.id.clone(),
                "Iron Sword".into(),
                Some("Common".into()),
                1,
                None,
                None,
                None,
                None,
                "Ada".into(),
            )
            .unwrap();
        db.update_inventory_item(
            item.id.clone(),
            "Iron Sword".into(),
            Some("Rare".into()),
            3,
            None,
            None,
            None,
            None,
            "Ada".into(),
        )
        .unwrap();

        let quantity = latest_entry(&db, "character_inventory", &item.id, "quantity");
        assert!(db.revert_change(&quantity.id, "Grace".into()).unwrap());
        let items = db.list_inventory(&character.id).unwrap();
        assert_eq!(items[0].quantity, 1);

        let rarity = latest_entry(&db, "character_inventory", &item.id, "rarity");
        assert!(db.revert_change(&rarity.id, "Grace".into()).unwrap());
        assert_eq!(
            db.list_inventory(&character.id).unwrap()[0]
                .rarity
                .as_deref(),
            Some("Common")
        );

        let gold = db
            .add_currency(character.id.clone(), "Gold".into(), 100, "Ada".into())
            .unwrap();
        db.update_currency(gold.id.clone(), "Gold".into(), 200, "Ada".into())
            .unwrap();
        let amount = latest_entry(&db, "character_currency", &gold.id, "amount");
        assert!(db.revert_change(&amount.id, "Grace".into()).unwrap());
        assert_eq!(db.list_currency(&character.id).unwrap()[0].amount, 100);
    }

    #[test]
    fn a_story_bible_lists_currency_and_each_item_with_its_chapter() {
        let (db, story, character, chapter, _) = inventory_story();
        let lost = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        db.add_inventory_item(
            character.id.clone(),
            "Iron Sword".into(),
            Some("Rare".into()),
            2,
            Some("+1 damage".into()),
            Some(chapter.id.clone()),
            Some(lost.id.clone()),
            None,
            "Ada".into(),
        )
        .unwrap();
        db.add_currency(character.id.clone(), "Gold".into(), 250, "Ada".into())
            .unwrap();

        let bible = db.story_bible(&story.id).unwrap();

        assert!(bible.markdown.contains("- 250 Gold"));
        assert!(bible.markdown.contains(
            "- **Iron Sword** ×2 · Rare — +1 damage (acquired in \"Chapter One\"; lost in \"Chapter Two\")"
        ));
    }

    // ===== QUESTS =====

    fn quests_story() -> (Db, Story, Character, Character, Node, Node, Node) {
        let db = Db::open_in_memory().unwrap();
        let story = db.create_story("Ash".into(), None, "Ada".into()).unwrap();
        let rook = db
            .create_character(story.id.clone(), "Rook".into(), None, "Ada".into())
            .unwrap();
        let mira = db
            .create_character(story.id.clone(), "Mira".into(), None, "Ada".into())
            .unwrap();
        let first = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter One".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let second = db
            .create_node(
                story.id.clone(),
                "chapter".into(),
                "Chapter Two".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        let faction = db
            .create_node(
                story.id.clone(),
                "faction".into(),
                "The Ashen Guild".into(),
                None,
                0.0,
                0.0,
                "Ada".into(),
            )
            .unwrap();
        (db, story, rook, mira, first, second, faction)
    }

    #[test]
    fn a_quest_moves_from_accepted_to_completed_and_every_edit_is_recorded() {
        let (db, story, rook, _, first, second, faction) = quests_story();

        let quest = db
            .add_quest(
                story.id.clone(),
                "  The Ledger  ".into(),
                Some(rook.id.clone()),
                Some(faction.id.clone()),
                first.id.clone(),
                None,
                "active".into(),
                Some("  Find the missing page  ".into()),
                None,
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(quest.title, "The Ledger", "the title is trimmed");
        assert_eq!(quest.description.as_deref(), Some("Find the missing page"));
        assert!(quest.rewards.is_empty());

        // Filtering is case-insensitive and every quest comes with its bundle.
        assert_eq!(
            db.list_story_quests(&story.id, Some("ACTIVE"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            db.list_story_quests(&story.id, Some("failed"))
                .unwrap()
                .len(),
            0
        );

        // At the acceptance chapter it is open; at the completion chapter the
        // chapter has already ended it.
        assert_eq!(
            db.list_story_quests_as_of(&story.id, &first.id)
                .unwrap()
                .len(),
            1
        );

        let completed = db
            .update_quest(
                quest.id.clone(),
                "The Ledger".into(),
                None,
                Some(faction.id.clone()),
                first.id.clone(),
                Some(second.id.clone()),
                "completed".into(),
                Some("Find the missing page".into()),
                Some("  Paid out by the guild  ".into()),
                "Ada".into(),
            )
            .unwrap();

        assert_eq!(completed.status, "completed");
        assert_eq!(completed.giver_character_id, None);
        assert_eq!(completed.notes.as_deref(), Some("Paid out by the guild"));
        assert_eq!(
            db.list_story_quests_as_of(&story.id, &first.id)
                .unwrap()
                .len(),
            1,
            "accepted in that same chapter, so still not yet ended there"
        );
        assert!(
            db.list_story_quests_as_of(&story.id, &second.id)
                .unwrap()
                .is_empty(),
            "the chapter it ended in is past it"
        );

        let audit = db
            .get_audit_log(Some(&story.id), Some("quest"), Some(&quest.id), 50)
            .unwrap();

        assert!(audit
            .iter()
            .any(|entry| entry.action == "create"
                && entry.new_value.as_deref() == Some("The Ledger")));
        assert!(audit.iter().any(|entry| {
            entry.field_changed.as_deref() == Some("status")
                && entry.new_value.as_deref() == Some("completed")
        }));
        assert!(
            audit.iter().any(|entry| {
                entry.field_changed.as_deref() == Some("giver") && entry.new_value.is_none()
            }),
            "removing the giver is recorded as a change, not a silent clear"
        );

        db.delete_quest(&quest.id, "Ada".into()).unwrap();
        assert!(db.list_story_quests(&story.id, None).unwrap().is_empty());
        assert!(db
            .get_audit_log(Some(&story.id), Some("quest"), Some(&quest.id), 50)
            .unwrap()
            .iter()
            .any(|entry| entry.action == "delete"));
    }

    #[test]
    fn a_quest_refuses_a_chapter_card_of_the_wrong_kind_or_another_story() {
        let (db, story, rook, _, first, _, faction) = quests_story();
        let other_story = db
            .create_story("Elsewhere".into(), None, "Ada".into())
            .unwrap();
        let stranger = db
            .create_character(
                other_story.id.clone(),
                "Stranger".into(),
                None,
                "Ada".into(),
            )
            .unwrap();

        assert!(db
            .add_quest(
                story.id.clone(),
                "No title kind".into(),
                None,
                None,
                faction.id.clone(),
                None,
                "active".into(),
                None,
                None,
                "Ada".into(),
            )
            .is_err());

        assert!(db
            .add_quest(
                story.id.clone(),
                "Wrong giver".into(),
                Some(stranger.id.clone()),
                None,
                first.id.clone(),
                None,
                "active".into(),
                None,
                None,
                "Ada".into(),
            )
            .is_err());

        assert!(db
            .add_quest(
                story.id.clone(),
                "  ".into(),
                Some(rook.id.clone()),
                None,
                first.id.clone(),
                None,
                "active".into(),
                None,
                None,
                "Ada".into(),
            )
            .is_err());

        db.add_quest(
            story.id.clone(),
            "A real one".into(),
            Some(rook.id.clone()),
            None,
            first.id.clone(),
            None,
            "active".into(),
            None,
            None,
            "Ada".into(),
        )
        .unwrap();
    }

    #[test]
    fn rewards_pay_the_right_kind_of_holder_and_follow_a_purge() {
        let (db, story, rook, mira, first, second, faction) = quests_story();

        let quest = db
            .add_quest(
                story.id.clone(),
                "The Ledger".into(),
                Some(rook.id.clone()),
                Some(faction.id.clone()),
                first.id.clone(),
                Some(second.id.clone()),
                "completed".into(),
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        let xp = db
            .add_quest_reward(
                quest.id.clone(),
                " XP ".into(),
                Some(rook.id.clone()),
                Some("250".into()),
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(xp.reward_type, "xp");

        db.add_quest_reward(
            quest.id.clone(),
            "faction_standing".into(),
            Some(faction.id.clone()),
            Some("Honoured".into()),
            "Ada".into(),
        )
        .unwrap();

        // A standing belongs on a faction card and the rest on a character; a
        // card or character from elsewhere is refused with words, not a raw
        // constraint error.
        assert!(db
            .add_quest_reward(
                quest.id.clone(),
                "faction_standing".into(),
                Some(rook.id.clone()),
                None,
                "Ada".into()
            )
            .is_err());
        assert!(db
            .add_quest_reward(
                quest.id.clone(),
                "xp".into(),
                Some(faction.id.clone()),
                None,
                "Ada".into()
            )
            .is_err());
        assert!(db
            .add_quest_reward(quest.id.clone(), "gold".into(), None, None, "Ada".into())
            .is_err());

        let changed = db
            .update_quest_reward(
                xp.id.clone(),
                "item".into(),
                Some(mira.id.clone()),
                Some("  Iron Key  ".into()),
                "Ada".into(),
            )
            .unwrap();
        assert_eq!(changed.reward_type, "item");
        assert_eq!(changed.amount_or_details.as_deref(), Some("Iron Key"));

        let audit = db
            .get_audit_log(Some(&story.id), Some("quest_reward"), Some(&xp.id), 50)
            .unwrap();
        assert!(audit
            .iter()
            .any(|entry| entry.field_changed.as_deref() == Some("type")));
        assert!(audit
            .iter()
            .any(|entry| entry.field_changed.as_deref() == Some("target")));

        // Purging the cast member clears the giver and every payout aimed at them,
        // while the amount and kind stay as the author wrote them.
        let lost = db
            .add_quest_reward(
                quest.id.clone(),
                "xp".into(),
                Some(rook.id.clone()),
                Some("10".into()),
                "Ada".into(),
            )
            .unwrap();

        db.delete_character(&rook.id, "Ada".into()).unwrap();
        db.purge_character(&rook.id, "Ada".into()).unwrap();

        let fresh = db.list_story_quests(&story.id, None).unwrap();
        assert_eq!(fresh[0].giver_character_id, None);
        assert!(fresh[0]
            .rewards
            .iter()
            .any(|reward| reward.id == lost.id && reward.target_id.is_none()));

        // Purging the faction card clears the issuing card and the standing paid
        // through it, without deleting either record.
        db.delete_node(&faction.id, "Ada".into()).unwrap();
        db.purge_node(&faction.id, "Ada".into()).unwrap();

        let fresh = db.list_story_quests(&story.id, None).unwrap();
        assert_eq!(fresh[0].faction_node_id, None);
        assert!(fresh[0]
            .rewards
            .iter()
            .all(|reward| reward.reward_type != "faction_standing" || reward.target_id.is_none()));

        // Purging the chapter a quest was accepted in takes the quest and its
        // reward bundle with it, because a quest cannot be placed without it.
        db.delete_node(&first.id, "Ada".into()).unwrap();
        db.purge_node(&first.id, "Ada".into()).unwrap();

        assert!(db.list_story_quests(&story.id, None).unwrap().is_empty());
        let remaining: i64 = db
            .conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM quest_rewards", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "the rewards went with their quest");
    }

    #[test]
    fn quests_and_their_rewards_survive_export_and_import_with_new_ids() {
        let (db, story, rook, _, first, second, faction) = quests_story();

        let quest = db
            .add_quest(
                story.id.clone(),
                "The Ledger".into(),
                Some(rook.id.clone()),
                Some(faction.id.clone()),
                first.id.clone(),
                Some(second.id.clone()),
                "completed".into(),
                Some("Find the missing page".into()),
                None,
                "Ada".into(),
            )
            .unwrap();
        db.add_quest_reward(
            quest.id.clone(),
            "xp".into(),
            Some(rook.id.clone()),
            Some("250".into()),
            "Ada".into(),
        )
        .unwrap();
        db.add_quest_reward(
            quest.id.clone(),
            "faction_standing".into(),
            Some(faction.id.clone()),
            Some("Honoured".into()),
            "Ada".into(),
        )
        .unwrap();

        let export = db.export_story(&story.id).unwrap();
        assert_eq!(export.quests.len(), 1);
        assert_eq!(export.quests[0].rewards.len(), 2);

        // Through actual JSON, not just the in-memory shape, so a quest and its
        // bundle are proven to serialize and come back whole.
        let json = serde_json::to_string(&export).unwrap();
        let export: StoryExport = serde_json::from_str(&json).unwrap();
        assert_eq!(export.quests[0].rewards.len(), 2);

        // A file written before v21 has no `quests` key at all.
        let mut older = serde_json::to_value(&export).unwrap();
        older.as_object_mut().unwrap().remove("quests");
        let older: StoryExport = serde_json::from_value(older).unwrap();
        assert!(older.quests.is_empty());

        let copy = db.import_story(export, "Ada".into()).unwrap();
        let imported = db.list_story_quests(&copy.id, None).unwrap();

        assert_eq!(imported.len(), 1);
        assert_ne!(imported[0].id, quest.id, "the copy gets its own ids");
        assert_eq!(imported[0].title, "The Ledger");
        assert_eq!(imported[0].status, "completed");
        assert_eq!(imported[0].rewards.len(), 2);
        assert!(imported[0]
            .rewards
            .iter()
            .all(|reward| reward.quest_id == imported[0].id));

        // Every link points into the copy, not back at the source story.
        let copy_cast = db.list_characters(&copy.id).unwrap();
        let copy_nodes = db.list_nodes(&copy.id).unwrap();
        let giver = imported[0].giver_character_id.as_deref().unwrap();
        assert!(copy_cast.iter().any(|character| character.id == giver));
        assert!(copy_nodes
            .iter()
            .any(|node| Some(&node.id) == imported[0].accepted_chapter_id.as_ref()));
        assert!(imported[0].rewards.iter().all(|reward| {
            reward.target_id.as_ref().is_none_or(|id| {
                copy_cast.iter().any(|character| &character.id == id)
                    || copy_nodes.iter().any(|node| &node.id == id)
            })
        }));
    }

    #[test]
    fn applied_rewards_are_remembered_until_the_payout_changes() {
        let (db, story, rook, _, first, second, _) = quests_story();

        let quest = db
            .add_quest(
                story.id.clone(),
                "The Ledger".into(),
                None,
                None,
                first.id.clone(),
                Some(second.id.clone()),
                "completed".into(),
                None,
                None,
                "Ada".into(),
            )
            .unwrap();
        let reward = db
            .add_quest_reward(
                quest.id.clone(),
                "xp".into(),
                Some(rook.id.clone()),
                Some("100".into()),
                "Ada".into(),
            )
            .unwrap();
        assert!(reward.applied_at.is_none());

        db.mark_quest_rewards_applied(&[reward.id.clone()]).unwrap();

        // A fresh read, as a restart would do, still knows the payout was made.
        let saved = db.list_story_quests(&story.id, None).unwrap();
        assert!(saved[0].rewards[0].applied_at.is_some());

        // Editing the payout makes it a new fact, so it is no longer called applied.
        db.update_quest_reward(
            reward.id.clone(),
            "xp".into(),
            Some(rook.id.clone()),
            Some("150".into()),
            "Ada".into(),
        )
        .unwrap();
        let saved = db.list_story_quests(&story.id, None).unwrap();
        assert!(saved[0].rewards[0].applied_at.is_none());

        db.mark_quest_rewards_applied(&[reward.id.clone()]).unwrap();

        // So does ending the quest in a different chapter.
        db.update_quest(
            quest.id.clone(),
            "The Ledger".into(),
            None,
            None,
            first.id.clone(),
            Some(first.id.clone()),
            "completed".into(),
            None,
            None,
            "Ada".into(),
        )
        .unwrap();
        let saved = db.list_story_quests(&story.id, None).unwrap();
        assert!(saved[0].rewards[0].applied_at.is_none());
    }

    #[test]
    fn an_imported_quest_must_find_everything_it_points_at() {
        let (db, story, rook, _, first, _, _) = quests_story();
        let quest = db
            .add_quest(
                story.id.clone(),
                "The Ledger".into(),
                Some(rook.id.clone()),
                None,
                first.id.clone(),
                None,
                "active".into(),
                None,
                None,
                "Ada".into(),
            )
            .unwrap();

        let mut export = db.export_story(&story.id).unwrap();
        export.quests[0].accepted_chapter_id = Some(quest.id.clone());

        let error = db.import_story(export, "Ada".into()).unwrap_err();
        assert!(format!("{error}").contains("chapter"));
    }
}
