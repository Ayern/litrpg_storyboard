# LitRPG Storyboard Tracker

[![CI](https://github.com/Ayern/litrpg_storyboard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Ayern/litrpg_storyboard/actions/workflows/ci.yml?query=branch%3Amain)

A local-first desktop app for plotting LitRPG and progression-fantasy stories: one
idea graph per story, a character sheet with numeric stats, and an audit trail that
records who changed what.

Everything lives in a single SQLite file on your machine. No accounts, no network,
no sync.

What comes next, and the invariants every change keeps, are in
[ROADMAP.md](ROADMAP.md).

## Features

**Stories** — create, rename and delete. The sidebar orders them by most recently
touched.

**Idea graph** — a pan/zoom canvas built on React Flow. Nodes have a type
(`chapter`, `idea`, `character`, `location`, `event`, `plot`, `misc`) and can be
connected with edges. Each type draws as its own colour with the type named on the
card, and the legend uses the same palette, so a board of a hundred notes reads by
shape and colour before any of it is read. An unrecognised type is drawn as `misc`
rather than unstyled. Dragging a node saves its position. Deleting a node removes
the connections attached to it, and the node plus each removed connection are
recorded in the history.

**Chapter order** — the Chapters tab lists every live `chapter` card in reading
order, numbered from 1, with **New chapter** (which creates the card and puts it
last), **↑**/**↓** to move one place, and **Renumber** whenever positions repeat,
are missing, or a chapter has none. A move writes the whole order in one command
and renumbers the rest, so the list is 1..n unless a chapter was deleted or an
older file was imported — and then the tab says which positions are empty or
doubled rather than renumbering behind your back. A chapter card shows `Ch. N`
beside its type on the canvas, both directions of a move are recorded in the
history, and a move is undone like any canvas change. Cards that are not chapters
are never numbered.

**Chapter arcs, counts, POV, days and times** — a chapter can also name the arc it
belongs to, record the words written against an optional target, say whose point
of view it is told from, and sit on an in-world day at a time of day. **Edit** on
its row opens Arc / Words / Target / POV / Day / Time in place; `Enter` saves,
`Escape` or **Cancel** closes without writing, asking first when anything has
been changed. A blank arc, target, POV, day or time stores nothing, while a
count of zero is kept — "no count" and "nothing written" are
different facts. The POV picker lists the story's live cast, and the day is a
whole number from 0 up; there is no calendar, so a story can count "days since
the System arrived" instead of dating anything. The time is free text — "Dusk",
"18:40", "after the fire" — kept in the author's own words. POV, day and time
show on the row, and the day places the chapter on the **Timeline** below the
list, which orders chapters by day rather than by chapter number and names each
one's POV. Inside a day, chapters whose time reads as a clock or a day part
(dawn, morning, noon, afternoon, dusk, night, with "early" or "late" nudging an
hour) are ordered by it; a label that reads as neither is left unordered, waiting
after the readable ones in reading order instead of being guessed at. The story
bible prints the same timeline in the same order. A chapter with no day stays off
it while the panel counts how many are waiting for one. The top of the tab totals
the counts across the chapters, adds up the targets that exist (and says how many
chapters have one), and fills a bar against that total. These numbers are the
author's: nothing reads a manuscript to work them out. Each field that changes is
a history entry of its own, so an arc, a count, a day or a time can be put back
from the Audit tab; a
POV is recorded by name (and is not revertible, because the link is stored as an
id).

**Continuity** — below the timeline, the Chapters tab lists what looks
inconsistent: a chapter with no POV, a chapter that names a time but no day,
a chapter whose day goes backwards in reading order, a chapter whose time goes
backwards inside one day, two chapters placed at the same moment, and one cast
member named as the POV of two chapters on the same day. A time is only compared
when both labels read as a time of day, so "after the fire" is never guessed at.
Two chapters collide when their labels resolve to the same minute, whether they
were written the same way or not — "Dusk" and "7:00 pm" are one moment — and the
flag quotes them as written. The flags are advisory — nothing is blocked, and the
list only appears when there is something to say — and a chapter with no day yet
is left out of the timing checks rather than being given one. A time label on
such a chapter is named, so it is not silently lost. Every chapter a flag names
is a link: clicking it opens that chapter's details, brings its row into view and
lights it for a moment, so the warning leads to the thing it is about. If the
open form holds unsaved edits, the switch waits: the row asks whether to discard
them and open the other chapter, or keep editing, rather than dropping them
silently. **Cancel** and `Escape` ask the same question before closing the form.

**Chapter notes** — a chapter can hold any number of short notes: **Notes** on its
row opens a panel with **Add note**, **Edit** and **Delete**. There is no
formatting and no manuscript — a note is exactly the text typed into it, shown
under the chapter it belongs to, and `Ctrl`/`Cmd`+`Enter` adds or saves one. A
note is stored as a `note` node with a parent pointer, which is what lets it
appear in the trash, name itself in the history by its first line, travel in an
export, sit under the chapter's heading in the story bible and be found by the
search palette. It is deliberately kept off the graph: a result opens the
chapter's panel with the note marked rather than a card on the canvas. Deleting a
note moves it to the trash, and trashing a chapter takes its notes with it —
restoring the chapter brings them back, while a note trashed on its own waits in
the trash until its chapter is live again. The row's button counts the notes
under it.

**Editing a node** — click a node and an inspector drawer slides in beside the
canvas, which gives up the width rather than hiding the node being edited. Reword
the label, add or change its notes, and save. Only the fields you actually changed
are written, each as its own history entry, so rewording a label is not buried
under a note edit. `Enter` saves. `Escape` or the close button closes the drawer;
when the label or notes hold unsaved changes it asks *Save / Discard / Keep
editing* first, and a dot beside the heading says there is something unsaved.
Unsaved text is kept per node for the session: switching to another node keeps
the draft quietly, and reopening that node puts the half-written label and notes
back. Only *Discard* drops it.

**Cast numbers in the inspector** — any node can be pointed at a cast member with
the picker in the drawer. The link is stored on the node as that character's id, so
renaming either the node or the cast member leaves it alone. When it is set, the
drawer lists that character's stats and attributes with the values as buttons: click
one, type the new value and press `Enter`, and it is saved exactly as if it had been
edited on the Characters tab. The picker saves the moment it changes, keeps showing
a link it cannot name (one whose cast member is in the trash) rather than dropping
it, and the drawer keeps its own copy of the numbers so editing from the canvas does
not disturb what the Characters tab has selected. Link changes are history entries
of their own, recorded as the names on either side. When a relink leaves the node
still named after the cast member it just left, the drawer offers to rename it to
the new one; accepting is an ordinary label edit, recorded like any other, and
declining leaves the author's name alone.

**Dragging cast onto the canvas** — the Graph tab has a cast rail beside the
canvas. Drag a card onto the board and it becomes a `character` node already
linked to that cast member, placed where the pointer was released, with the
inspector opened on it. Drop it on an existing node instead and that node is
repointed at the cast member — it keeps its label, notes and type, and only the
link changes; the node under the pointer is outlined while the drag is over it, so
it is clear which of the two will happen. A linked node draws its cast member's
numbers as badges —
the first two by name, then a count of the rest, with all of them in the tooltip —
so the board answers who is ahead without opening anybody. The badges follow edits
made in the drawer or on the Characters tab. The canvas is outlined while a card
is in the air, the drop is a single write that either makes a linked node or
nothing, and a node whose cast member is in the trash says so rather than looking
unlinked. This is HTML5 drag and drop, which is why the window sets
`dragDropEnabled: false`: Tauri's native handler would otherwise replace
WebView2's and swallow the drag events on Windows. Nothing in the app uses
Tauri's own drop handler — import goes through a file dialog.

**Finding anything** — `Ctrl+F` on the Graph or Chapters tab opens a search
palette (the Search buttons do the same). On the Graph tab it floats over the
canvas; on the Chapters tab it sits above the reading order, so a note can be
found without going back to the board first. A query is matched against a node's
label, notes, type and linked cast member; a character's name and description;
both ends of a connection and its label or relation type; the text of every
chapter note; and every story by title, description or the cards inside it —
other stories' boards and notes are read when the palette opens, so a word can be
found without opening the story that holds it. A result whose own name matched
is listed before one found only by its notes, description, relation or cast
member. Matches in the open story are outlined on the board as the query is
typed, and the first eight results are listed. `↑`/`↓` move through them, `Enter`
goes to the chosen one, and `Esc` closes the palette. A node opens in the
inspector, a cast member opens their sheet, a connection opens its editor centered
on it, a note opens the Chapters tab with its chapter's panel expanded and the
note marked for a moment, and a story result opens that story. The filter row
under the query narrows the list to one kind, and the count follows the filter.

**Editing a connection** — click an edge to open the same kind of editor for its
label and relation type (`leads_to`, `foreshadows`). Both are optional, and each
change is recorded per field like a node edit. The canvas shows the label when
there is one and falls back to the relation type. Only one editor is open at a
time: selecting a node closes the connection editor and vice versa.

**Characters** — a cast list per story, each with a name, an optional description,
progression, numeric stats and free-text attributes. Stats and attributes are
identified by name, so adding a stat or an attribute you already have updates it
instead of creating a duplicate. The cast list says each character's level and
rank, and the cast rail on the Graph tab puts the level on every card.

**Progression** — each character's level, experience, rank and optional "XP to
next" are stored as their own fields rather than as a stat called "Level". The
sheet shows the numbers under a bar filled against the XP target, and the caption
counts down to the next level; without a target the bar stays empty and the raw
total is shown instead. **Level up** adds one level and records it as a level-up
event in the history; **Edit progression** types all four fields at once, saving
only the ones that changed. Nothing is derived: experience never rolls over into
a level, and clearing the rank or the target stores nothing rather than an empty
string. A level starts at 1 and experience at 0, which is what the migration gives
a character created before these fields existed.

**Help before clicking** — controls that are not self-explanatory carry a hover
title saying what the click will do: save or discard, move to the trash or delete
for good, relink or keep the label. These are the platform's native tooltips, so
they appear after the system's usual hover delay rather than instantly.

**Undo and redo** — `Ctrl+Z` or the Undo button takes back the last recorded
change on the board: a label or notes edit, a connection edit, a relink, a node
move, accepting the rename offer, or creating and deleting a node or connection.
`Ctrl+Shift+Z` or Redo puts it back. Each step runs the ordinary command in the
opposite direction, so an undo appears in the Audit tab like any other change
rather than quietly rewriting the database, and a short notice names what moved.
The stack holds the last 50 actions of the open story and is emptied when another
story is opened or something is purged; inside a text field `Ctrl+Z` is left to
the text being typed.

**Keyboard reference** — the `?` button beside the current-user field, or the
`?` key on any tab, opens a list of every keyboard route, grouped by where it
works. The list is rendered from one table, and the tooltip that names a key
reads the same table, so the help cannot describe a shortcut that no longer
works. `?` is ignored while a field has focus (there it is a question mark), and
the list closes on `Esc`, its close button, or a click outside it.

**Audit log** — every change is recorded with the acting user, the field, and the
before/after values, and can be reviewed per story. The tab shows the newest changes
first, 50 at a time, and can be narrowed to stories, characters, stats, attributes,
nodes or connections. "Show older changes" pages further back and says how many are
still there, so a long history is browsable rather than silently truncated. See
[The audit model](#the-audit-model).

**Reverting an edit** — any field change in the history can be put back, and a
revert is itself recorded, so it can be reverted in turn. The tab says on each
button whether the revert is still possible — *Changed since*, *In trash*, *Gone*,
*Already back* — with the full reason in its tooltip, so that is learned before a
click rather than after a refusal. It only applies while the field still holds the
value that entry produced: if it changed again since, writing the older value
would quietly throw the newer edit away. Creations and deletions are not
revertible — the trash is what undoes those.

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

**Story bible** — writes a Markdown file beside the JSON exports,
`exports/<story-slug>-story-bible-<timestamp>.md`. It opens with the title and
logline, then the chapters in reading order, each with its arc, its day, its POV,
its words against the target and its notes — the chapter card's own notes as a
paragraph, then the chapter's notes as a bulleted list under **Notes**, keeping
line breaks inside a note; a one-line story total follows the chapter list, and a
**Timeline** section lists the chapters that have a day in time order with their
time label and POV. The cast comes next — level, rank and XP where they exist, the description,
then the stats and attributes as a plain list — followed by the other cards
grouped by kind. Character cards are left out because the cast section already carries their
sheet. Headings are numbered and nothing is written in app jargon, so the file can
be pasted into whatever you draft in. **Copy bible** puts the same text on the
clipboard without writing a file, for pasting straight into a document; the
window declares only the clipboard write permission, not read.

**Import** — restores one of those snapshots as a **new** story. Every id is
remapped, so importing the same file twice gives two independent stories and
nothing that already exists is touched; a title collision becomes
`<title> (imported)`. Graph connections, attribute values and the original history
come across, and the restore is all-or-nothing.

**Backups** — the Backups button lists the copies written at each launch, newest
first, with when each was written, its size and its file name. Restoring one asks
first, copies the current state into a new backup, then replaces the database and
loads the stories from it again; the session's undo history and any unsaved drafts
are dropped, because they describe rows that no longer exist. The chosen file is
opened and migrated before anything is replaced, so a damaged or foreign file
leaves the current data untouched.

**Current user** — remembered between launches and used to attribute every change.
This is a name, not an identity; see [Limitations](#limitations).

## Data location

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\com.chris.litrpg-storyboard-tracker\storyboard.db` |
| macOS | `~/Library/Application Support/com.chris.litrpg-storyboard-tracker/storyboard.db` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.chris.litrpg-storyboard-tracker/storyboard.db` |

Exports go to an `exports` folder beside the database: the JSON snapshot as
`<story-slug>-<timestamp>.json`, and the story bible as
`<story-slug>-story-bible-<timestamp>.md`. Launch copies live in `snapshots`
beside the database and are listed by the Backups dialog.

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
| `action` | `create`, `update`, `level_up`, `revert`, `soft_delete`, `restore` or `purge` |
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
- **A chapter move records the place it left and the place it took.** Moving one
  chapter renumbers the ones between, and each chapter whose number changed gets
  its own `chapter_seq` entry, so the history explains the whole new order rather
  than only the card that was dragged.
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
- **The button and the engine share one check.** The state shown beside an entry
  (`revert_state`, with the sentence a refusal would give in `revert_reason`) is
  worked out when the page is read, by the same function `revert_change` runs
  before writing. It is derived per request, never stored, so the history cannot
  go on claiming a revert is possible after the story has moved on.
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

SQLite, versioned with `PRAGMA user_version` (currently `6`). Migrations run at
startup in `db::migrate`; adding a new one means incrementing `SCHEMA_VERSION` and
adding a block for the next version. Version 2 added `character_attributes`, so a
database written by an earlier build gains the table on first launch and keeps
everything it already held. Version 3 added `deleted_at`, so every existing row
migrates in the live state. Version 4 added `settings`, which starts empty — so an
upgraded database keeps its trash forever until someone chooses otherwise. Version 5
added `nodes.character_id`, which is NULL on every existing node: nodes start
unlinked and are pointed at a cast member from the inspector. Version 6 added
`characters.level`, `xp`, `rank` and `xp_to_next`; an existing character gains
level 1 and 0 XP, and no level is inferred from a stat that happened to be called
"Level". Version 7 added `nodes.chapter_seq`, numbering existing chapter cards by
the order they were created; every other card holds NULL, and a chapter made
afterwards is numbered when it is created. Version 8 added `chapter_arc`,
`chapter_words` and `chapter_target`; an older chapter starts with none of them,
which is different from a word count of zero. Version 9 added `chapter_pov` and
`chapter_day`; an older chapter is unplaced and has no point of view until one is
set. Version 10 added `nodes.parent_node_id`, which is NULL on everything but a
note, so an existing story simply has no notes until one is added. Version 11
added `chapter_time`, the free-text time of day; an older chapter has none until
one is typed, which is different from a time that was cleared.

| Table | Contents |
| --- | --- |
| `stories` | `id`, `title`, `description`, timestamps, `deleted_at` |
| `characters` | Belongs to a story; `name`, `description`, progression (`level`, `xp`, nullable `rank` and `xp_to_next`), `deleted_at` |
| `character_stats` | Belongs to a character; `stat_name`, integer `value`, `notes` |
| `character_attributes` | Belongs to a character; `attr_name`, text `value`, unique per character |
| `nodes` | Graph node: `node_type`, `label`, `content`, position (`pos_x`/`pos_y`), optional `character_id` link to the cast, a chapter's `chapter_seq`, `chapter_arc`, `chapter_words`, `chapter_target`, `chapter_pov` (cast id), `chapter_day` and free-text `chapter_time`, a note's `parent_node_id` (its chapter), `created_by`, `deleted_at` |
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
npm test                             # canvas, search, inspector, cast drag-and-drop, progression, chapters, POV, in-world days and times, export and clipboard, audit paging, reverts and the trash (vitest, jsdom)
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
- **`src-tauri/src/lib.rs`** — the 43 thin `#[tauri::command]` wrappers, the JSON
  export writer and import reader, and startup (which opens the database and adopts
  a legacy file). The file picker for import comes from `tauri-plugin-dialog`, whose
  `dialog:default` permission is declared in `capabilities/default.json`, and the
  outline's copy action uses `tauri-plugin-clipboard-manager` with only
  `clipboard-manager:allow-write-text`.

## Limitations

- **Attribution is not authentication.** The current user is a free-text name stored
  in the app's local storage. Anyone using the machine can enter any name, and the
  audit log lives in a file they can edit. Treat the history as a helpful record,
  not a tamper-proof trail.
- **Stats are integers only.** Non-numeric facts belong in attributes (`Class` =
  `Rogue`), which are plain text with no typing, validation or formatting.
- **In-world time is a day and a typed label, not a clock.** A chapter's time is
  free text, and only labels that read as a time of day are ordered: a clock time
  such as `18:40` or `6:40 pm`, or a day part such as dawn, morning, noon,
  afternoon, dusk or night (with "early" or "late" nudging an hour). Anything
  else — "after the fire" — is stored and shown but never compared, so a scene it
  really follows is not flagged. There is no calendar; a time with no day is
  stored and flagged, but cannot be placed until a day is typed. A shared moment
  is caught only when both labels read as a time of day — two chapters that both
  say "after the fire" are not compared.
- **Only chapters have these fields.** POV, a day and a time belong to chapters, and
  chapters are reordered with the ↑/↓ buttons rather than by dragging in the
  list. Deleting a chapter leaves its position empty until something is moved
  or **Renumber** is pressed; that is shown in the tab, not repaired silently.
- **The story bible carries only what the app models.** The file and the clipboard
  hold the same Markdown: chapters with arcs, days, times, POV and counts, a timeline,
  the cast with their sheets, and the other cards. Skills and inventory have no
  fields yet, so they cannot appear in it. Copying needs the clipboard write
  permission; if the platform refuses it, the error strip says so.
- **Word counts are typed, not measured.** There is no manuscript to count, so the
  total is the sum of the numbers entered; a chapter without a target contributes
  words to the total but nothing to the target, which is why the tab says how many
  chapters have one. A target is a per-chapter number, not a share of the story
  total.
- **Progression is recorded, not calculated.** Nothing checks that experience is
  below the target, that a level-up is earned, or that a rank only rises: the
  fields hold whatever the author typed, and leveling up just adds one. The bar
  clamps at 100% when experience passes the target rather than inventing a
  second level, and without a target there is no bar to fill.
- **Undoing an edit needs the field to still hold what the edit left.** Deleting
  a story, character, node or connection moves it to the Trash tab, where it can
  be restored exactly or deleted for good, and any single recorded field can be
  put back from the Audit tab. That revert refuses once the field changed again,
  so undoing an old rename means undoing the newer ones first — the tab marks such
  an entry *Changed since* rather than offering a button that would be refused. Creations and
  purges cannot be reverted at all: the first is undone by deleting it, and the
  second has no row left to write to.
- **Retention only runs at launch and when it is changed.** A window of 30 days
  means an item deleted 40 days ago goes the next time the app starts, not the
  moment it turns 40 days old — a long-running session keeps everything until it
  is restarted. Nothing is ever purged while the app is closed.
- **Backups are taken at launch, not at every change.** A copy is written when the
  app starts (and just before a restore), so work done during the current session
  is not in the list; Export is the deliberate snapshot. Restoring replaces
  everything, including the trash, and the undo history starts again from there.
- **Import always creates a copy.** There is no way to overwrite or merge into an
  existing story, so restoring over a damaged one leaves the original in place to
  delete by hand.
- **A cast link is not revertible from the history.** Pointing a node at a
  different cast member is recorded as a `character` field change, with the names on
  either side, but the Audit tab offers no Revert for it: the recorded value is a
  name and the column holds an id, and resolving one to the other can be ambiguous.
  Change it with the picker instead.
- **A link survives its cast member going to the trash.** Trashing a character keeps
the links, so restoring it brings them back; the drawer says the link is to a cast
member that is not in the live cast. Purging the character clears the links first,
and each cleared node gets its own history entry — the canvas is re-read at that
point so it stops drawing the vanished badge.
- **Dragging a cast card needs a pointer.** The rail uses the platform's
  drag-and-drop, which a touch screen does not drive; the picker in the drawer
  makes the same link without dragging.
- **Dropping a card on a node does not rename it by itself.** The drop only
  changes the link and shows both names on the card; when the label is still the
  old cast member's name, the drawer offers the rename, and accepting it is a
  separate label edit in the history. The offer compares the label with the old
  name, so both cast members have to be in the live cast for it to appear.
- **Individual stats cannot be deleted**, only overwritten or removed with their
  character. Attributes can be deleted one at a time — deleting is done on the
  Characters tab, not in the inspector.
- **Undo covers the canvas, not every screen.** Character names, progression,
  stats and attributes, chapter arcs and word counts, story rename and delete,
  import, and actions in the Trash tab are not on the undo stack; for recorded
  fields the Audit tab's revert is the way back. The stack is per session and
  holds 50 steps, so restarting the app or switching stories empties it. A
  level-up is recorded as its own action and is not revertible from the Audit tab
  either: type the previous level back in.
- **Unsaved drafts live in memory.** A half-written label or note survives
  switching nodes, closing the drawer and switching stories, but not restarting
  the app; nothing is written to disk until Save is pressed.
- **Shortcuts are fixed, not rebindable.** What the reference lists is the whole
  set of keyboard routes; customising them is not supported.
- **Search is a plain substring match.** Case is ignored, but `rk` does not find
  `Rook`. Results are ranked into two bands — a name or title match first, then
  everything found by its notes, description, relation or cast member — and
  inside a band they keep the order they were gathered in: the open story first
  (nodes, chapter notes, cast, connections), then the other stories, each
  starting with its title. The palette is captured on the Graph and Chapters tabs
  only, and the keyboard reaches the first eight results. Another story's board is
  read when the palette opens and kept for the session; it is dropped when that
  story has been open and left, so edits are never searched from a stale copy.
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
