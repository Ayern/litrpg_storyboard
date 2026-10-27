//! Writes the sample story the documentation screenshots are taken from.
//!
//! Run it from `src-tauri`:
//!
//! ```text
//! cargo run -p litrpg-db --example screenshot_fixture -- ../tools/screenshots/fixture.json
//! ```
//!
//! It seeds the prepared demo story through the ordinary API and then adds the
//! cards, quests, bonds and loot `GUIDE.md` needs to show. Nothing is written
//! by hand: every row in the file came out of the real database, so the shapes
//! the browser harness serves are the shapes the app is given in the desktop
//! build. The harness itself lives in `tools/screenshots/`.

use litrpg_db::{Character, Db, Node};
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

    // The prepared demo story brings the cast, three chapters, two skills with
    // their history, the level milestones and the deliberate 100 XP gap in
    // Mira's ledger that the continuity panel is meant to find.
    let story = db
        .create_demo_story(user.clone())
        .expect("seed the prepared demo story");
    let story_id = story.id.clone();

    let cast = db.list_characters(&story_id).expect("read the cast");
    let rook = id_of(&cast, "Rook Valebright");
    let mira = id_of(&cast, "Mira Sable");

    let nodes = db.list_nodes(&story_id).expect("read the board");
    let ashen_gate = node_id(&nodes, "The Ashen Gate");
    let ledger = node_id(&nodes, "A Ledger of Cinders");
    let ember_court = node_id(&nodes, "The Ember Court");

    // A third cast member, so the rail, the relations map and the quest ledger
    // have somebody on the other side of the debt.
    let vane = db
        .create_character(
            story_id.clone(),
            "Halden Vane".into(),
            Some("The Ember Court's clerk, who keeps every debt in his own hand.".into()),
            user.clone(),
        )
        .expect("add a third cast member");

    // ---- the cards the board draws ---------------------------------------

    let rook_card = card(
        &db,
        &story_id,
        "character",
        "Rook Valebright",
        "Reads the System like a ledger and owes the Court a debt he cannot name.",
        200.0,
        400.0,
        Some(rook.clone()),
    );
    let mira_card = card(
        &db,
        &story_id,
        "character",
        "Mira Sable",
        "A courier with a stolen ember and a talent for exits.",
        620.0,
        400.0,
        Some(mira.clone()),
    );
    let vane_card = card(
        &db,
        &story_id,
        "character",
        "Halden Vane",
        "The clerk who wrote the debt down, and who intends to collect it.",
        1040.0,
        400.0,
        Some(vane.id.clone()),
    );
    let court_card = card(
        &db,
        &story_id,
        "faction",
        "The Ember Court",
        "Every flame in this room remembers what it was paid.",
        1040.0,
        700.0,
        None,
    );
    let ash_card = card(
        &db,
        &story_id,
        "skill",
        "Ash Step",
        "A short step through smoke that leaves a grey afterimage.",
        200.0,
        700.0,
        None,
    );
    let ember_card = card(
        &db,
        &story_id,
        "skill",
        "Ember Whisper",
        "Reads the last emotion a flame touched.",
        620.0,
        700.0,
        None,
    );
    let toll_card = card(
        &db,
        &story_id,
        "idea",
        "Cut: the toll bell",
        "Dropped from chapter two; kept on the board in case the gate needs it again.",
        1380.0,
        700.0,
        None,
    );

    // The demo's own skill rows are pointed at the cards that now stand for
    // them, which is what makes the holder list on a skill card real.
    let skills = db.list_story_skills(&story_id).expect("read the skills");
    let ash_step = id_of_skill(&skills, "Ash Step");
    let ember_whisper = id_of_skill(&skills, "Ember Whisper");

    db.update_skill(
        ash_step.clone(),
        "Ash Step".into(),
        Some("Rank 2".into()),
        Some("A short step through smoke that leaves a grey afterimage.".into()),
        Some(ashen_gate.clone()),
        Some(ash_card.clone()),
        user.clone(),
    )
    .expect("point Ash Step at its card");

    db.update_skill(
        ember_whisper.clone(),
        "Ember Whisper".into(),
        Some("Rank 1".into()),
        Some("Reads the last emotion a flame touched.".into()),
        Some(ashen_gate.clone()),
        Some(ember_card.clone()),
        user.clone(),
    )
    .expect("point Ember Whisper at its card");

    // A skill a sheet holds without a card of its own, and the evolution link
    // between the two: the tree tab draws the parent and the child.
    let cinder_step = db
        .add_skill(
            rook.clone(),
            "Cinder Step".into(),
            Some("Rank 1".into()),
            Some("The step carries heat once the ember answers.".into()),
            Some(ember_court.clone()),
            None,
            user.clone(),
        )
        .expect("add a second skill for the tree");

    db.add_skill_evolution(
        ash_step.clone(),
        cinder_step.id.clone(),
        "upgrade".into(),
        Some(ember_court.clone()),
        Some("Rank 2".into()),
        Some("Learned when the debt came due and the ember answered.".into()),
        user.clone(),
    )
    .expect("link the two skills");

    // ---- the board's connections ----------------------------------------

    edge(&db, &story_id, &ashen_gate, &ledger, "next", "next", &user);
    edge(&db, &story_id, &ledger, &ember_court, "next", "next", &user);

    // Cast: each chapter points at the member the demo already assigned to it,
    // and each skill card at the character who holds it.
    edge(
        &db,
        &story_id,
        &ashen_gate,
        &mira_card,
        "cast",
        "cast",
        &user,
    );
    edge(&db, &story_id, &ledger, &rook_card, "cast", "cast", &user);
    edge(
        &db,
        &story_id,
        &ember_court,
        &mira_card,
        "cast",
        "cast",
        &user,
    );
    edge(
        &db, &story_id, &rook_card, &ash_card, "skill", "skill", &user,
    );
    edge(
        &db,
        &story_id,
        &mira_card,
        &ember_card,
        "skill",
        "skill",
        &user,
    );

    // A bond and a grudge, drawn exactly as the canvas draws them.
    edge(
        &db, &story_id, &rook_card, &mira_card, "rival", "rival", &user,
    );
    edge(
        &db, &story_id, &rook_card, &vane_card, "enemy", "enemy", &user,
    );
    edge(
        &db,
        &story_id,
        &vane_card,
        &court_card,
        "serves",
        "serves",
        &user,
    );

    // ---- the ledgers behind the cards -----------------------------------

    db.add_relation(
        rook.clone(),
        mira.clone(),
        "rival".into(),
        Some("Two couriers who keep meeting at the same locked door.".into()),
        Some(ledger.clone()),
        None,
        user.clone(),
    )
    .expect("link the two rivals");

    db.add_relation(
        rook.clone(),
        vane.id.clone(),
        "enemy".into(),
        Some("The debt Rook cannot name is the one Vane wrote down.".into()),
        Some(ashen_gate.clone()),
        None,
        user.clone(),
    )
    .expect("link Rook to the clerk");

    let debt = db
        .add_quest(
            story_id.clone(),
            "Pay the Ember Debt".into(),
            Some(vane.id.clone()),
            Some(court_card.clone()),
            ashen_gate.clone(),
            Some(ember_court.clone()),
            "completed".into(),
            Some("The debt comes due in a room where every flame remembers.".into()),
            Some("Settled with the ledger Rook was never meant to read.".into()),
            user.clone(),
        )
        .expect("add the debt");

    for (reward_type, target, details) in [
        ("xp", rook.clone(), "1200"),
        ("item", rook.clone(), "Sealed Ledger"),
        ("stat", rook.clone(), "Insight +2"),
        ("faction_standing", court_card.clone(), "cleared"),
    ] {
        db.add_quest_reward(
            debt.id.clone(),
            reward_type.into(),
            Some(target),
            Some(details.into()),
            user.clone(),
        )
        .expect("add a reward");
    }

    db.add_quest(
        story_id.clone(),
        "Find the Cinder Road".into(),
        Some(mira.clone()),
        None,
        ledger.clone(),
        None,
        "active".into(),
        Some("Mira needs the road that only burns for people who owe nothing.".into()),
        Some("Open: the gate only answers at dusk.".into()),
        user.clone(),
    )
    .expect("add the open quest");

    for (character_id, name, rarity, quantity, effect, chapter, lost) in [
        (
            &rook,
            "Sealed Ledger",
            Some("Rare"),
            1,
            Some("Every name in it reads as a number the reader cannot forget."),
            Some(&ashen_gate),
            None,
        ),
        (
            &rook,
            "Cinder Key",
            Some("Uncommon"),
            2,
            Some("Opens a door that has been paid for."),
            Some(&ember_court),
            None,
        ),
        (
            &mira,
            "Stolen Ember",
            Some("Legendary"),
            1,
            Some("Warm to the touch, warmer when somebody lies."),
            Some(&ashen_gate),
            Some(&ember_court),
        ),
        (&mira, "Courier's Cache", None, 1, None, Some(&ledger), None),
    ] {
        db.add_inventory_item(
            character_id.clone(),
            name.into(),
            rarity.map(str::to_string),
            quantity,
            effect.map(str::to_string),
            chapter.cloned(),
            lost.cloned(),
            None,
            user.clone(),
        )
        .expect("add an item");
    }

    db.add_currency(rook.clone(), "Marks".into(), 420, user.clone())
        .expect("add marks");
    db.add_currency(rook.clone(), "Ember Script".into(), 3, user.clone())
        .expect("add script");
    db.add_currency(mira.clone(), "Marks".into(), 95, user.clone())
        .expect("add marks");

    for (character_id, name, value) in [
        (&rook, "Class", "Delver"),
        (&rook, "Homeland", "Ashfall"),
        (&mira, "Class", "Courier"),
        (&mira, "Notable", "Never caught twice"),
    ] {
        db.add_or_update_attribute(
            character_id.clone(),
            name.into(),
            value.into(),
            user.clone(),
        )
        .expect("add an attribute");
    }

    db.add_chapter_note(
        &ledger,
        "Rook's debt is named for the first time in this chapter, and he still \
         cannot repeat it out loud."
            .into(),
        user.clone(),
    )
    .expect("add a chapter note");
    db.add_chapter_note(
        &ember_court,
        "Check the candle count against chapter two before the confrontation \
         is revised."
            .into(),
        user.clone(),
    )
    .expect("add a chapter note");

    for (character_id, standing, note, since) in [
        (
            &rook,
            "wary",
            Some("Known to the Court by debt rather than by name."),
            &ashen_gate,
        ),
        (
            &mira,
            "wanted",
            Some("The stolen ember is still on the Court's ledger."),
            &ashen_gate,
        ),
    ] {
        db.add_faction_standing(
            character_id.clone(),
            Some(court_card.clone()),
            standing.into(),
            note.map(str::to_string),
            since.clone(),
            None,
            user.clone(),
        )
        .expect("record a standing");
    }

    // ---- something in the trash -----------------------------------------

    // A cut scene and a cut cast member, so the trash tab is not empty. Both
    // were written and then deleted through the ordinary commands.
    let cut = db
        .create_character(
            story_id.clone(),
            "Wren Ashgrove".into(),
            Some("Cut in the second draft; kept here so the deletion can be undone.".into()),
            user.clone(),
        )
        .expect("add a cast member about to be cut");

    let _ = cut;
    db.delete_character(&cut.id, user.clone())
        .expect("cut the second-draft cast member");
    db.delete_node(&toll_card, user.clone())
        .expect("cut the toll bell card");

    // A whole story in the trash as well. The trash reads it through the same
    // command with no story named, which is how the shelf's own section is
    // filled.
    let scratch = db
        .create_story(
            "Scratch: gate variants".into(),
            Some("Two drafts of the gate scene, kept for a week and then let go.".into()),
            user.clone(),
        )
        .expect("add a scratch story");
    db.delete_story(&scratch.id, user.clone())
        .expect("delete the scratch story");

    // ---- the read commands the app loads a story with -------------------

    let characters = db.list_characters(&story_id).expect("read the cast");
    let chapters = [&ashen_gate, &ledger, &ember_court];

    let mut root = Map::new();
    root.insert("storyId".into(), Value::String(story_id.clone()));
    put(
        &mut root,
        "story",
        &db.get_story(&story_id).unwrap().unwrap(),
    );
    put(&mut root, "stories", &db.list_stories().unwrap());
    put(&mut root, "nodes", &db.list_nodes(&story_id).unwrap());
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
        "story_level_milestones",
        &db.list_story_level_milestones(&story_id).unwrap(),
    );
    put(
        &mut root,
        "story_progress",
        &db.list_story_character_progress(&story_id).unwrap(),
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

/// Creates a narrative card, optionally already pointing at a cast member.
fn card(
    db: &Db,
    story_id: &str,
    node_type: &str,
    label: &str,
    content: &str,
    x: f64,
    y: f64,
    character_id: Option<String>,
) -> String {
    db.create_node_with_character(
        story_id.to_string(),
        node_type.to_string(),
        label.to_string(),
        Some(content.to_string()),
        x,
        y,
        USER.to_string(),
        character_id,
    )
    .expect("create a card")
    .id
}

/// Draws one connection between two cards, the way the canvas writes it.
fn edge(db: &Db, story_id: &str, from: &str, to: &str, label: &str, relation: &str, user: &str) {
    db.create_edge(
        story_id.to_string(),
        from.to_string(),
        to.to_string(),
        Some(label.to_string()),
        Some(relation.to_string()),
        user.to_string(),
    )
    .expect("draw a connection");
}

fn put<T: Serialize>(root: &mut Map<String, Value>, key: &str, value: &T) {
    root.insert(key.to_string(), json_of(value));
}

fn json_of<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("serialise a row")
}

fn id_of(cast: &[Character], name: &str) -> String {
    cast.iter()
        .find(|character| character.name == name)
        .unwrap_or_else(|| panic!("no cast member named {name}"))
        .id
        .clone()
}

fn id_of_skill(skills: &[litrpg_db::CharacterSkill], name: &str) -> String {
    skills
        .iter()
        .find(|skill| skill.name == name)
        .unwrap_or_else(|| panic!("no skill named {name}"))
        .id
        .clone()
}

fn node_id(nodes: &[Node], label: &str) -> String {
    nodes
        .iter()
        .find(|node| node.label == label)
        .unwrap_or_else(|| panic!("no card labelled {label}"))
        .id
        .clone()
}
