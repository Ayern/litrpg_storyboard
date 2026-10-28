//! Writes the sample story the documentation screenshots are taken from.
//!
//! Run it from `src-tauri`:
//!
//! ```text
//! cargo run -p litrpg-db --example screenshot_fixture -- ../tools/screenshots/fixture.json
//! ```
//!
//! The story itself is not written here. `create_demo_story` builds it — the same
//! seed the app's **Load demo story** button runs — so the story `GUIDE.md`
//! documents, the pictures in `screenshots/` and the demo in the desktop build
//! are one story rather than three that drift apart.
//!
//! What this example adds is the file: every read the front end makes while
//! loading the tabs, keyed as the harness's in-memory backend answers them, so
//! the browser page sees the shapes the desktop build is given. The harness
//! itself lives in `tools/screenshots/`.

use litrpg_db::{Db, Node};
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::PathBuf;

const USER: &str = "Ada";

fn main() {
    let out: PathBuf = std::env::args()
        .nth(1)
        .expect("usage: screenshot_fixture <output.json>")
        .into();

    // A scratch file rather than an in-memory database: `open_in_memory` is
    // test-only, and a real path is also what lets the backups command answer.
    let db_path = std::env::temp_dir().join("litrpg-screenshot-fixture.db");
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_dir_all(db_path.parent().unwrap().join("snapshots"));

    let db = Db::open(&db_path).expect("open a scratch database");
    let user = USER.to_string();

    // The prepared demo story, complete: the cast and the three chapters, the
    // skills with their history, the levels, the deliberate 100 XP gap
    // in Mira's ledger that the continuity panel is meant to find, and the cards,
    // connections, quests, loot, notes and trash the guide's pictures show.
    let story = db
        .create_demo_story(user.clone())
        .expect("seed the prepared demo story");
    let story_id = story.id.clone();

    let characters = db.list_characters(&story_id).expect("read the cast");
    let nodes = db.list_nodes(&story_id).expect("read the board");

    let ashen_gate = node_id(&nodes, "The Ashen Gate");
    let ledger = node_id(&nodes, "A Ledger of Cinders");
    let ember_court = node_id(&nodes, "The Ember Court");
    let chapters = [&ashen_gate, &ledger, &ember_court];

    let mut root = Map::new();
    root.insert("storyId".into(), Value::String(story_id.clone()));
    put(
        &mut root,
        "story",
        &db.get_story(&story_id).unwrap().unwrap(),
    );
    put(&mut root, "stories", &db.list_stories().unwrap());
    put(&mut root, "nodes", &nodes);
    put(&mut root, "edges", &db.list_edges(&story_id).unwrap());
    put(&mut root, "characters", &characters);
    put(
        &mut root,
        "story_stats",
        &db.list_story_stats(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_skills",
        &db.list_story_skills(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_skill_events",
        &db.list_story_skill_events(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_levels",
        &db.list_story_levels(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_progress",
        &db.list_story_character_progress(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_growth_points",
        &db.list_story_growth_points(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_level_growth_rules",
        &db.list_story_level_growth_rules(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_inventory",
        &db.list_story_inventory(&story_id).unwrap(),
    );
    put(
        &mut root,
        "chapter_notes",
        &db.list_chapter_notes(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_chapter_cast",
        &db.list_story_chapter_cast(&story_id).unwrap(),
    );
    put(
        &mut root,
        "chapter_cast_states",
        &db.list_chapter_cast_states(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_relations",
        &db.list_story_relations(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_faction_standings",
        &db.list_story_faction_standings(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_quests",
        &db.list_story_quests(&story_id, None).unwrap(),
    );
    put(
        &mut root,
        "story_skill_evolutions",
        &db.list_story_skill_evolutions(&story_id).unwrap(),
    );
    put(
        &mut root,
        "audit",
        &db.get_audit_page(Some(&story_id), None, None, 500, 0)
            .unwrap()
            .entries,
    );
    put(
        &mut root,
        "trash",
        &db.list_deleted(Some(&story_id)).unwrap(),
    );
    put(&mut root, "trash_stories", &db.list_deleted(None).unwrap());
    put(
        &mut root,
        "trash_retention",
        &db.trash_retention_days().unwrap(),
    );
    put(&mut root, "backups", &db.list_backups().unwrap());

    // The sheet reads are per cast member, and a chapter card asks for the
    // snapshot of every character it carries.
    let mut stats = Map::new();
    let mut attributes = Map::new();
    let mut skills = Map::new();
    let mut inventory = Map::new();
    let mut currency = Map::new();

    for character in &characters {
        stats.insert(
            character.id.clone(),
            json_of(&db.list_stats(&character.id).unwrap()),
        );
        attributes.insert(
            character.id.clone(),
            json_of(&db.list_attributes(&character.id).unwrap()),
        );
        skills.insert(
            character.id.clone(),
            json_of(&db.list_skills(&character.id).unwrap()),
        );
        inventory.insert(
            character.id.clone(),
            json_of(&db.list_inventory(&character.id).unwrap()),
        );
        currency.insert(
            character.id.clone(),
            json_of(&db.list_currency(&character.id).unwrap()),
        );
    }

    root.insert("character_stats".into(), Value::Object(stats));
    root.insert("character_attributes".into(), Value::Object(attributes));
    root.insert("character_skills".into(), Value::Object(skills));
    root.insert("character_inventory".into(), Value::Object(inventory));
    root.insert("character_currency".into(), Value::Object(currency));

    let mut states = Map::new();
    for character in &characters {
        for chapter in chapters {
            states.insert(
                format!("{}|{}", character.id, chapter),
                json_of(
                    &db.character_state_at_chapter(&character.id, chapter)
                        .unwrap(),
                ),
            );
        }
    }

    root.insert("chapter_states".into(), Value::Object(states));

    std::fs::write(
        &out,
        serde_json::to_string_pretty(&Value::Object(root)).expect("serialise the fixture"),
    )
    .expect("write the fixture");

    println!("wrote {}", out.display());
}

fn put<T: Serialize>(root: &mut Map<String, Value>, key: &str, value: &T) {
    root.insert(key.to_string(), json_of(value));
}

fn json_of<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("serialise a row")
}

fn node_id(nodes: &[Node], label: &str) -> String {
    nodes
        .iter()
        .find(|node| node.label == label)
        .unwrap_or_else(|| panic!("no card labelled {label}"))
        .id
        .clone()
}
