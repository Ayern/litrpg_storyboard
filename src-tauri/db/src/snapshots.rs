//! Copies of the database, taken before it is opened.
//!
//! The audit log records what changed, but only as human-readable strings: a
//! deleted character leaves its name behind, not its description, and a deleted
//! node leaves its label, not its canvas position. A copy of the file is the one
//! thing that can bring everything back, which is why it is taken before [`crate::Db::open`]
//! runs the migrations that could damage it.

use chrono::Utc;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The folder, beside the database, that holds the copies.
pub const SNAPSHOT_DIR: &str = "snapshots";

/// Copies `db_path` into a `snapshots` folder beside it, keeping the newest
/// `keep` copies and deleting the rest.
///
/// Returns the copy that was written, or `None` when there is no database yet,
/// which is the first launch. Call this while nothing has the database open: the
/// file is copied as it stands, and only then is it the whole database.
pub fn snapshot(db_path: &Path, keep: usize) -> io::Result<Option<PathBuf>> {
    if !db_path.exists() {
        return Ok(None);
    }

    let folder = snapshot_dir(db_path);
    fs::create_dir_all(&folder)?;

    let stem = db_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("storyboard");
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");

    // Two launches in the same second would otherwise overwrite each other.
    let mut target = folder.join(format!("{stem}-{stamp}.db"));
    let mut attempt = 1;
    while target.exists() {
        target = folder.join(format!("{stem}-{stamp}-{attempt}.db"));
        attempt += 1;
    }

    fs::copy(db_path, &target)?;
    prune(&folder, stem, keep)?;

    Ok(Some(target))
}

/// Where the copies live: `snapshots`, next to the database.
pub fn snapshot_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(SNAPSHOT_DIR)
}

/// Deletes all but the newest `keep` copies, newest first by modification time.
fn prune(folder: &Path, stem: &str, keep: usize) -> io::Result<()> {
    if keep == 0 {
        return Ok(());
    }

    let prefix = format!("{stem}-");
    let mut copies: Vec<(SystemTime, PathBuf)> = Vec::new();

    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };

        // Only this database's copies: another file in the folder is not ours to
        // delete.
        if !name.starts_with(&prefix) || !name.ends_with(".db") || !path.is_file() {
            continue;
        }

        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH);
        copies.push((modified, path));
    }

    if copies.len() <= keep {
        return Ok(());
    }

    copies.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));

    for (_, path) in copies.into_iter().skip(keep) {
        // A copy that will not go away is not worth failing a launch over.
        let _ = fs::remove_file(path);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("litrpg-snapshots-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn copies_in(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("storyboard-"))
            })
            .map(|path| fs::read_to_string(path).unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn copies_the_database_beside_it() {
        let dir = scratch_dir();
        let db = dir.join("storyboard.db");
        let contents = b"not really sqlite, but a copy does not care";
        fs::write(&db, contents).unwrap();

        let copy = snapshot(&db, 10).unwrap().expect("a copy should be written");

        assert_eq!(copy.parent().unwrap(), dir.join(SNAPSHOT_DIR));
        assert_eq!(fs::read(&copy).unwrap(), contents);
        assert!(copy
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("storyboard-"));
    }

    #[test]
    fn a_first_launch_has_nothing_to_copy() {
        let dir = scratch_dir();

        assert_eq!(snapshot(&dir.join("storyboard.db"), 10).unwrap(), None);
        assert!(!dir.join(SNAPSHOT_DIR).exists());
    }

    #[test]
    fn keeps_only_the_newest_copies() {
        let dir = scratch_dir();
        let db = dir.join("storyboard.db");

        for state in 1..=5 {
            fs::write(&db, format!("state-{state}")).unwrap();
            snapshot(&db, 3).unwrap().expect("a copy should be written");
            // The pruning order is modification time, so make each copy distinct.
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        assert_eq!(
            copies_in(&dir.join(SNAPSHOT_DIR)),
            vec!["state-3", "state-4", "state-5"]
        );
    }

    #[test]
    fn leaves_other_files_in_the_folder_alone() {
        let dir = scratch_dir();
        let db = dir.join("storyboard.db");
        fs::write(&db, "current").unwrap();

        let folder = snapshot_dir(&db);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("notes.txt"), "mine").unwrap();
        fs::write(folder.join("other-app-20260101-000000.db"), "not ours").unwrap();

        for _ in 0..4 {
            snapshot(&db, 1).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        assert!(folder.join("notes.txt").exists());
        assert!(folder.join("other-app-20260101-000000.db").exists());
        assert_eq!(copies_in(&folder).len(), 1);
    }
}
