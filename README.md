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

**Editing a node** — click a node to open its editor: reword the label, add or
change its notes, and save. Only the fields you actually changed are written, each
as its own history entry, so rewording a label is not buried under a note edit.
`Enter` saves and `Escape` closes the editor.

**Editing a connection** — click an edge to open the same kind of editor for its
label and relation type (`leads_to`, `foreshadows`). Both are optional, and each
change is recorded per field like a node edit. The canvas shows the label when
there is one and falls back to the relation type. Only one editor is open at a
time: selecting a node closes the connection editor and vice versa.

**Characters** — a cast list per story, each with a name, an optional description,
numeric stats and free-text attributes. Both are identified by name, so adding a
stat or an attribute you already have updates it instead of creating a duplicate.

**Audit log** — every change is recorded with the acting user, the field, and the
before/after values, and can be reviewed per story. The tab shows the newest changes
first, 50 at a time, and can be narrowed to stories, characters, stats, attributes,
nodes or connections. "Show older changes" pages further back and says how many are
still there, so a long history is browsable rather than silently truncated. See
[The audit model](#the-audit-model).

**Reverting an edit** — any field change in the history can be put back, and a
revert is itself recorded, so it can be reverted in turn. It only applies while
the field still holds the value that entry produced: if it changed again since,
the revert is refused and says what the field reads now, rather than quietly
throwing the newer edit away. Creations and deletions are not revertible — the
trash is what undoes those.

**Trash** — deleting a story, character, node or connection moves it here rather
than destroying it. Restoring puts it back exactly as it was: a character returns
with its stats and attributes, a node with the connections that went with it, a
story with everything that was live inside it. "Delete forever" is the only
irreversible action in the app, and it asks first.

**Trash retention** — the trash can be kept forever (the default) or cleared
automatically after 7, 30, 90 days or a year. The window is applied at launch and
immediately when shortened, and anything it removes is recorded as a `purge` by
`Trash retention` rather than looking like someone's deliberate click.

**Export** — writes a complete JSON snapshot of one story — characters, stats,
attributes, graph and full history — beside the database, under
`exports/<story-slug>-<timestamp>.json`.

**Import** — restores one of those snapshots as a **new** story. Every id is
remapped, so importing the same file twice gives two independent stories and
nothing that already exists is touched; a title collision becomes
`<title> (imported)`. Graph connections, attribute values and the original history
come across, and the restore is all-or-nothing.

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
| `entity_type` | `story`, `character`, `character_stat`, `character_attribute`, `node` or `edge` |
| `entity_id` | The row that changed |
| `action` | `create`, `update`, `revert`, `soft_delete`, `restore` or `purge` |
| `field_changed` | Name of the changed field, for updates and reverts |
| `old_value` / `new_value` | Before and after, as text |
| `changed_by` | The current user's name at the time |
| `changed_at` | RFC 3339 timestamp, UTC |

Behaviour worth knowing:

- **Each field is recorded separately.** Renaming a character and editing its
  description produces two entries, so a rename is not buried inside an unrelated
  edit. Rewording a graph node's label and its notes work the same way, as do an
  edge's label and relation type.
- **Cascades are recorded individually.** Deleting a node records the node and
  every edge that went with it.
- **A deletion records where the item can be found again.** Deleting a character
  writes one entry naming it; its stats and attributes are not touched, because
  they stay attached to it and come back with it. Restoring writes a `restore`
  entry, and deleting from the trash for good writes `purge`.
- **A purge records the item it was asked about.** Whatever cascades from that
  row — a character's stats, a node's connections, everything inside a story —
  goes without an entry of its own, since those rows are gone by the time a
  cascade could be logged. A window-driven purge is attributed to
  `Trash retention` rather than to the current user.
- **A revert is an edit.** It writes a `revert` entry holding the value it
  replaced, which is why reverting a revert puts the original change back. The
  guard is the entry's own `new_value`: the field must still hold it, so a revert
  can never discard a later edit, and one with nothing to put back writes nothing.
- **No-ops write nothing.** Renaming to the existing title, or ending a drag where
  it started, produces no entry and no timestamp bump.
- **Deleting a story keeps its history.** The audit rows are not cascaded away — the
  history of a deleted story is still history. They remain in the database but are
  not reachable from the Audit tab, which filters by an existing story.
- **An import records itself.** Restoring a file replays that file's history and
  then adds one `story` creation by the person importing, so the story's arrival on
  this machine is visible rather than looking like it was always there.
- **Deletion is idempotent.** Deleting something already gone succeeds quietly and
  writes nothing, which matters because the canvas reports a node's edges as
  deleted as well as the node.

## Schema

SQLite, versioned with `PRAGMA user_version` (currently `4`). Migrations run at
startup in `db::migrate`; adding a new one means incrementing `SCHEMA_VERSION` and
adding a block for the next version. Version 2 added `character_attributes`, so a
database written by an earlier build gains the table on first launch and keeps
everything it already held. Version 3 added `deleted_at`, so every existing row
migrates in the live state. Version 4 added `settings`, which starts empty — so an
upgraded database keeps its trash forever until someone chooses otherwise.

| Table | Contents |
| --- | --- |
| `stories` | `id`, `title`, `description`, timestamps, `deleted_at` |
| `characters` | Belongs to a story; `name`, `description`, `deleted_at` |
| `character_stats` | Belongs to a character; `stat_name`, integer `value`, `notes` |
| `character_attributes` | Belongs to a character; `attr_name`, text `value`, unique per character |
| `nodes` | Graph node: `node_type`, `label`, `content`, position (`pos_x`/`pos_y`), `created_by`, `deleted_at` |
| `edges` | Directed connection: `source_id` → `target_id`, optional `label`/`relation_type`, `deleted_at` |
| `audit_log` | Change history, described above |
| `settings` | App-wide key/value pairs; currently only the trash retention window |

`deleted_at` is `NULL` while a row is live and holds the RFC 3339 time it was
moved to the trash. Deletion is an `UPDATE`, not a `DELETE`: restoring sets it
back to `NULL` and the row reappears unchanged, and only a `purge` in the Trash
tab issues the real `DELETE`. Every read filters on `deleted_at IS NULL`, and a
child row is also hidden while its parent is in the trash. Stats and attributes
have no column of their own — they are reachable only through their character, so
they leave and return with it.

A node and the connections removed with it share one `deleted_at` value, which is
how restoring the node knows which connections to bring back with it. A
connection deleted on its own keeps its earlier timestamp and stays in the trash.

`characters`, `character_stats`, `character_attributes`, `nodes` and `edges` all
cascade from their parent,
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
npm test                             # audit paging, reverts and the trash tab (vitest, jsdom)
cd src-tauri && cargo test -p litrpg-db   # database layer, in-memory SQLite
```

The frontend suite renders the real `App` with Tauri's `invoke` mocked, so it covers
the wiring the Rust tests cannot see: what the tab requests, what it does with a
page that arrives late, and what it says when a filter matches nothing.

### Architecture

- **`src/`** — React 19 + React Flow 11 single-window UI. All commands are called
  through `@tauri-apps/api/core`'s `invoke`; the argument names are camelCase and
  Tauri maps them to the snake_case parameters of the Rust commands.
- **`src-tauri/db`** — all SQL, models and migrations, in a crate of its own with
  no Tauri dependency, so its tests build without WebKitGTK or GTK. The connection
  is owned by a `Db` value managed as Tauri state. Every public method takes the lock
  **once** and passes `&Connection` down to helpers such as `log_audit`; helpers must
  never call back into a locking method, because `std::sync::Mutex` is not
  reentrant and that would deadlock.
- **`src-tauri/src/lib.rs`** — the 33 thin `#[tauri::command]` wrappers, the JSON
  export writer and import reader, and startup (which opens the database and adopts
  a legacy file). The file picker for import comes from `tauri-plugin-dialog`, whose
  `dialog:default` permission is declared in `capabilities/default.json`.

## Limitations

- **Attribution is not authentication.** The current user is a free-text name stored
  in the app's local storage. Anyone using the machine can enter any name, and the
  audit log lives in a file they can edit. Treat the history as a helpful record,
  not a tamper-proof trail.
- **Stats are integers only.** Non-numeric facts belong in attributes (`Class` =
  `Rogue`), which are plain text with no typing, validation or formatting.
- **Undoing an edit needs the field to still hold what the edit left.** Deleting
  a story, character, node or connection moves it to the Trash tab, where it can
  be restored exactly or deleted for good, and any single recorded field can be
  put back from the Audit tab. That revert refuses once the field changed again,
  so undoing an old rename means undoing the newer ones first. Creations and
  purges cannot be reverted at all: the first is undone by deleting it, and the
  second has no row left to write to.
- **Retention only runs at launch and when it is changed.** A window of 30 days
  means an item deleted 40 days ago goes the next time the app starts, not the
  moment it turns 40 days old — a long-running session keeps everything until it
  is restarted. Nothing is ever purged while the app is closed.
- **Recovery is a file copy, not a button.** Every launch copies the database into
  a `snapshots` folder beside it, before the schema is migrated, and keeps the last
  ten. A bad import, a wrong deletion or a migration that went wrong can be undone
  by putting an older copy back, but nothing in the app does that for you, and
  anything done since the last launch is not in a copy.
- **Import always creates a copy.** There is no way to overwrite or merge into an
  existing story, so restoring over a damaged one leaves the original in place to
  delete by hand.
- **Individual stats cannot be deleted**, only overwritten or removed with their
  character. Attributes can be deleted one at a time.
- **Single machine, no sync.** Sharing means copying the database file.
- **CI packages for Windows only, and not on every push.** The workflow typechecks,
  builds and tests the frontend and runs the database tests on Ubuntu for every
  push and pull request — those need no system packages, since only the app crate
  links WebKitGTK — but runs `tauri build` on `windows-latest` only for
  pushes to `main`, tags and manual runs. Every packaging run keeps the installers
  as workflow artifacts, and a tagged build also publishes them on a GitHub
  Release. The installers are unsigned, and nothing is packaged for macOS or
  Linux, so a break in those targets would still reach `main`.

## Licence

MIT — see [LICENSE](LICENSE). You may use, copy, modify, redistribute and sell this
software, provided the copyright notice and permission notice travel with it. There
is no warranty.

If the app saves you time, [a donation via PayPal](https://paypal.me/cjdugwyler) is
welcome but never required. The licence grants unrestricted use, and nothing in it
depends on payment.
