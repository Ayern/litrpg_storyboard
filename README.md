# LitRPG Storyboard Tracker

[![CI](https://github.com/Ayern/litrpg_storyboard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Ayern/litrpg_storyboard/actions/workflows/ci.yml?query=branch%3Amain)

A local-first desktop app for plotting LitRPG and progression-fantasy stories: one
idea graph per story, a character sheet with numeric stats, and an audit trail that
records who changed what.

Everything lives in a single SQLite file on your machine. No accounts, no network,
no sync.

## Features

**Stories** — create, rename and delete. The sidebar orders them by most recently
touched.

**Idea graph** — a pan/zoom canvas built on React Flow. Nodes have a type
(`chapter`, `idea`, `character`, `location`, `event`, `plot`, `misc`) and can be
connected with edges. Dragging a node saves its position. Deleting a node removes
the connections attached to it, and the node plus each removed connection are
recorded in the history.

**Characters** — a cast list per story, each with a name, an optional description
and numeric stats. Stats are identified by name, so adding a stat you already have
updates it instead of creating a duplicate.

**Audit log** — every change is recorded with the acting user, the field, and the
before/after values, and can be reviewed per story. See
[The audit model](#the-audit-model).

**Export** — writes a complete JSON snapshot of one story — characters, stats,
graph and full history — beside the database.

**Current user** — remembered between launches and used to attribute every change.
This is a name, not an identity; see [Limitations](#limitations).

## Data location

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\com.chris.litrpg-storyboard-tracker\storyboard.db` |
| macOS | `~/Library/Application Support/com.chris.litrpg-storyboard-tracker/storyboard.db` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.chris.litrpg-storyboard-tracker/storyboard.db` |

Exports go to an `exports` folder beside the database, named
`<story-slug>-<timestamp>.json`.

Earlier builds stored the database at `%APPDATA%\litrpg_storyboard\storyboard.db`.
On first launch the app copies that file to the new location if — and only if — the
new one does not exist. The original is left untouched, so it is safe to delete
once you are satisfied the adopted copy is correct.

## The audit model

Every mutating operation writes its audit entry **inside the same transaction** as
the change. If the entry cannot be written, the change is rolled back rather than
committed unattributed — there is a test for exactly this
(`audit_failure_rolls_back_the_mutation`).

An entry records:

| Column | Meaning |
| --- | --- |
| `story_id` | Which story the change belongs to, so history can be shown per story |
| `entity_type` | `story`, `character`, `character_stat`, `node` or `edge` |
| `entity_id` | The row that changed |
| `action` | `create`, `update` or `delete` |
| `field_changed` | Name of the changed field, for updates |
| `old_value` / `new_value` | Before and after, as text |
| `changed_by` | The current user's name at the time |
| `changed_at` | RFC 3339 timestamp, UTC |

Behaviour worth knowing:

- **Each field is recorded separately.** Renaming a character and editing its
  description produces two entries, so a rename is not buried inside an unrelated
  edit.
- **Cascades are recorded individually.** Deleting a node records the node and
  every edge that went with it; deleting a character records its stats.
- **No-ops write nothing.** Renaming to the existing title, or ending a drag where
  it started, produces no entry and no timestamp bump.
- **Deleting a story keeps its history.** The audit rows are not cascaded away — the
  history of a deleted story is still history. They remain in the database but are
  not reachable from the Audit tab, which filters by an existing story.
- **Deletion is idempotent.** Deleting something already gone succeeds quietly and
  writes nothing, which matters because the canvas reports a node's edges as
  deleted as well as the node.

## Schema

SQLite, versioned with `PRAGMA user_version` (currently `1`). Migrations run at
startup in `db::migrate`; adding a new one means incrementing `SCHEMA_VERSION` and
adding a block for the next version.

| Table | Contents |
| --- | --- |
| `stories` | `id`, `title`, `description`, timestamps |
| `characters` | Belongs to a story; `name`, `description` |
| `character_stats` | Belongs to a character; `stat_name`, integer `value`, `notes` |
| `nodes` | Graph node: `node_type`, `label`, `content`, position (`pos_x`/`pos_y`), `created_by` |
| `edges` | Directed connection: `source_id` → `target_id`, optional `label`/`relation_type` |
| `audit_log` | Change history, described above |

`characters`, `character_stats`, `nodes` and `edges` all cascade from their parent,
with `PRAGMA foreign_keys = ON`. `audit_log` deliberately has no foreign key, so
history survives the deletion of what it describes. It is indexed on
`(story_id, changed_at)` and `(entity_type, entity_id)`.

## Development

Prerequisites: Node.js with npm, a Rust toolchain, and the Tauri v2 system
dependencies for your platform (WebView2 on Windows, WebKitGTK on Linux, Xcode
command-line tools on macOS). No Node version is pinned yet.

```bash
npm install
npm run tauri dev      # run the desktop app
npm run dev            # frontend only, in a browser — Tauri IPC is unavailable
npm run build          # typecheck (tsc) + production frontend bundle
npm run tauri build    # package a desktop installer
```

Tests:

```bash
cd src-tauri && cargo test --lib     # database layer, in-memory SQLite
```

### Architecture

- **`src/`** — React 19 + React Flow 11 single-window UI. All commands are called
  through `@tauri-apps/api/core`'s `invoke`; the argument names are camelCase and
  Tauri maps them to the snake_case parameters of the Rust commands.
- **`src-tauri/src/db.rs`** — all SQL, models and migrations. The connection is
  owned by a `Db` value managed as Tauri state. Every public method takes the lock
  **once** and passes `&Connection` down to helpers such as `log_audit`; helpers must
  never call back into a locking method, because `std::sync::Mutex` is not
  reentrant and that would deadlock.
- **`src-tauri/src/lib.rs`** — the 21 thin `#[tauri::command]` wrappers, the JSON
  export writer, and startup (which opens the database and adopts a legacy file).

## Limitations

- **Attribution is not authentication.** The current user is a free-text name stored
  in the app's local storage. Anyone using the machine can enter any name, and the
  audit log lives in a file they can edit. Treat the history as a helpful record,
  not a tamper-proof trail.
- **Stats are integers only.** Something like "Class: Rogue" has to live in notes.
- **There is no undo.** Deletions are permanent; they are recorded in the history
  but cannot be restored from it.
- **Export only, no import.** A snapshot cannot be loaded back into the app yet.
- **Individual stats cannot be deleted**, only overwritten or removed with their
  character.
- **Single machine, no sync.** Sharing means copying the database file.
- **CI checks Linux only, and not the desktop bundle.** The workflow typechecks and
  builds the frontend and runs the database tests on Ubuntu; `tauri build` and any
  platform-specific packaging (WebView2, macOS signing) are not exercised, so a
  Windows- or macOS-only break would still reach `main`.

## Licence

MIT — see [LICENSE](LICENSE). You may use, copy, modify, redistribute and sell this
software, provided the copyright notice and permission notice travel with it. There
is no warranty.

If the app saves you time, [a donation via PayPal](https://paypal.me/cjdugwyler) is
welcome but never required. The licence grants unrestricted use, and nothing in it
depends on payment.
