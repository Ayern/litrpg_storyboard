# Roadmap and integrity checklist

LitRPG Storyboard Tracker · updated 23 October 2026

This is the working plan. The [README](README.md) says what the app does today;
this file says what must stay true as it grows, and what comes next. One feature
at a time, each one finished — modelled, tested, documented and pushed — before
the next begins.

---

## 1. Where the project stands

**Solid ground**

- **The data model is honest.** Soft deletes with a real trash, purges that are
  the only irreversible action, cascades recorded individually, and an audit row
  written in the same transaction as every change. A bad audit write rolls the
  change back.
- **The history is checked, not decorative.** The revert state shown on a button
  and the check the engine runs come from one function, so a button never offers
  what a click would refuse.
- **The canvas behaves like a board.** Typed, coloured cards; a drawer that takes
  width instead of covering the node; cast members dragging in as linked nodes
  with live stat badges; drop-to-relink with a hover target and a rename offer.
- **Everything is local.** One SQLite file, launch snapshots, JSON export and
  all-or-nothing import, no accounts and no network.
- **The suite is real.** Frontend tests run against the actual `App` with IPC
  mocked; database tests cover rollback, migration from earlier versions and
  import round-trips; CI typechecks and builds both.

**Thin ice**

- **No undo.** There is a revert engine, but nothing reaches it from the canvas
  or the keyboard; a stray delete or a wiped note is a trip to the Trash tab at
  best.
- **Unsaved edits vanish.** `Escape` or `×` closes the drawer and silently drops
  the label and notes drafts.
- **It is only part of a LitRPG storyboard.** Level, XP and rank are real
  fields, but skills, items and system messages are still just `character_stats`
  rows and free-text attributes, and nothing checks whether a level-up was
  earned or a rank only rose.
- **In-world time is a day and a typed label.** A chapter can name its POV, its
  day and a free-text time, and appears on a timeline, but there is no calendar
  and only labels that read as a clock or a day part are ordered; a shared moment
  is flagged only when both labels can be read that way, and a time with no day
  is flagged so it is not lost. Chapters are still
  reordered with buttons rather than by dragging in the list, so "where is Rook
  at chapter 9?" is answered by the timeline, not by a search.
- **No continuity checking.** Nothing warns that a character is in two places, a
  skill is used before it is learned, or a chapter is missing.
- **Visuals are unverified.** Every UI claim in this project is proven through
  jsdom and synthetic events; the desktop window has never been looked at during
  development.
- **The desktop is unpushed-through-QA.** CI packages Windows only, on `main`
  only, unsigned.

---

## 2. Integrity checklist

Every change is checked against this before it is called done. It is deliberately
short enough to actually read each time.

### Data and schema

- [ ] SQL lives in `litrpg-db`; Tauri commands stay thin; no SQL in React.
- [ ] Every mutation writes its audit row **in the same transaction**; a failed
      audit write rolls the mutation back.
- [ ] Deletion is an `UPDATE` setting `deleted_at`. Only a confirmed purge issues
      `DELETE`, and a retention purge is attributed to `Trash retention`.
- [ ] Every read filters `deleted_at IS NULL`, and a child is hidden while its
      parent is in the trash.
- [ ] Every id arriving from the UI is re-checked server-side (same story, parent
      still live); never trust a client-supplied link.
- [ ] A schema change bumps `SCHEMA_VERSION`, adds a migration block for the next
      version **and** an upgrade test that opens a database from the previous
      version, then updates the README schema table.
- [ ] Export, import and the schema move together: a new column or table is in
      the snapshot, remapped on import, and covered by an export → import →
      export round-trip test.
- [ ] Import stays all-or-nothing, every id is remapped, and a title collision
      becomes `<title> (imported)`.
- [ ] No write without a real change: renaming to the current value, or
      re-dropping a node where it started, writes nothing and bumps no timestamp.
- [ ] Ordering that matters uses `rowid` or an explicit sequence — never a
      second-resolution timestamp or a random uuid.
- [ ] A new revertible field is wired into both the state shown next to the entry
      and the engine's guard, through the same function.
- [ ] Foreign keys stay on; new child tables cascade from their parent, and
      `audit_log` stays free of foreign keys so history outlives what it describes.

### History

- [ ] Every content change names the entity, the field, and readable before/after
      values a person can understand.
- [ ] Batches record each item, not a summary that hides what went.
- [ ] Cascades are recorded for what the user asked to delete, with the rule for
      the rest (as purges do) stated in the README.
- [ ] No entry claims an action that did not happen.

### Interface

- [ ] Anything destructive asks first and says exactly what will be lost.
- [ ] Unsaved work is never discarded without a choice, and `Escape` never
      destroys an edit.
- [ ] A control whose consequence is unclear carries a hover title; an icon-only
      control also has an accessible name.
- [ ] Pointer actions have a keyboard route, and a refused action leaves the
      canvas exactly as it was with the reason shown in the UI.
- [ ] Every list has loading, empty and error states; failures are visible in the
      app, not only in the console.
- [ ] New copy is specific ("Delete Rook forever?", not "Are you sure?").
- [ ] Nothing blocks on the network, and nothing is sent anywhere.

### Verification and claims

- [ ] `npx tsc --noEmit`, `npm test`, `npm run build`.
- [ ] `cargo test -p litrpg-db` when the database crate changes;
      `cd src-tauri && cargo check` when the app crate changes.
- [ ] Each new behaviour has a test that fails if the behaviour is removed, at
      the layer that owns it (SQL in Rust, wiring in the App tests).
- [ ] A skipped or impossible check is reported as skipped, never folded into a
      pass — especially visual review of the desktop window.
- [ ] README features and limitations describe what actually ships, in the same
      commit as the code.

### Process

- [ ] One feature per commit, message states why it exists.
- [ ] `git status` checked first; other people's files and hunks are left alone.
- [ ] No new service, dependency or network call without a decision recorded here.
- [ ] Budgets held: a 500-node board stays smooth, search answers within a
      keystroke, the audit page stays 50, and no keystroke reloads the story.

### Definition of done

1. The smallest useful slice is named before code is written.
2. Model + migration, with an upgrade test.
3. Commands with audit entries.
4. UI including empty / loading / error, tooltip, keyboard route.
5. Tests at both layers.
6. README features, limitations and schema.
7. Typecheck, build, both suites green; counts reported.
8. One commit, pushed.

---

## 3. Order of work

| Phase | Theme | Why now |
| --- | --- | --- |
| 0 | **Finish the agreed pair** — search everywhere, shortcut reference | Closes the promises already in the README and makes the app teachable |
| 1 | **Protect the work** — unsaved-edit guard, undo/redo, in-app backups | Every later feature adds more ways to lose a story; fix that before building on it |
| 2 | **Become a LitRPG sheet** — level/XP/rank, chapter spine, POV and in-world time, progression ledger | These four turn a node board into a story tracker and unlock everything in phase 3 |
| 3 | **Model the world** — skills, inventory, relationships, LitRPG node types | The vocabulary players expect, attached to chapters and cast |
| 4 | **See the story** — continuity checks, dashboard, story-bible export | Only possible once phases 2–3 give it something to check |
| 5 | **Make it feel inevitable** — onboarding, starters, canvas and cast ergonomics | Polish last, on a model that is already right |

---

## 4. Features

Each item is a single shippable feature, ordered as it should be built. Sizes are
honest: **S** is a short session, **M** a solid one, **L** several.

### Phase 0 — closing the promises

**1. Find anything.** **Done.** `Ctrl+F` on the Graph and Chapters tabs reaches
nodes, chapter notes, cast members, connections and the other stories, whose
boards and notes are read when the palette opens; choosing a result opens the
inspector, the chapter's notes, the character sheet, the connection editor or the
story. A filter row narrows the list by kind, and the eight-result keyboard limit
and the count stay. Results are ranked into two bands: a card, note, cast member,
connection or story whose own name matched is listed before one found only by its
notes, description, relation or cast member, with the gathering order kept inside
each band.

**2. Shortcut reference.** **Done.** A `?` overlay groups every keyboard route by
where it works, reached from a `?` button beside the current-user field or the
`?` key on any tab. The overlay renders one table, and the tooltip that names a
key reads the same table. It does not open itself on a first run: a modal on
launch interrupts before there is a board to act on, so the button is always
visible instead. **S**

### Phase 1 — nothing gets lost

**3. Guard unsaved edits.** **Done.** Closing the drawer with a changed label or
notes asks *Save / Discard / Keep editing*; `Escape` with no changes closes
silently. The draft is kept per node for the session, so switching nodes loses
nothing and reopening offers the half-written text back. A dot beside the heading
marks unsaved changes, and a save that writes nothing still settles the draft.
Two follow-ups: drafts do not survive a restart, and switching nodes keeps the
draft rather than asking, which is a deliberate choice rather than an oversight.
**S–M**

**4. Undo and redo.** **Done.** `Ctrl+Z` / `Ctrl+Shift+Z` and two toolbar buttons
cover label and note edits, connection edits, relinks, moves, the rename offer,
and creating or deleting nodes and connections. Each step is a pair of ordinary
commands (edit → edit back, delete → restore), so the Audit tab records both
directions; the stack holds 50 steps, is scoped to the open story, and is emptied
on story switch and on any purge. Field edits use the same command as the
forward write rather than `revert_change`, because undo here is a new recorded
change rather than a correction of an old entry. Not covered, and stated in the
README: character and story edits, stats and attributes, import, and the Trash
tab. **L**

**5. Backups you can restore.** **Done.** The Backups dialog lists the launch
copies newest first with date, size and file name, and restores one behind a
confirmation. The chosen file is copied to a staging file, opened and migrated
before anything is replaced; the live connection is then closed, the current
state is copied into a new backup, and the database is replaced and reopened. The
UI drops its undo history and drafts and reads the stories again. Only names this
app writes are accepted, so a crafted path or a foreign file is refused. **M**

### Phase 2 — the LitRPG sheet

**6. Level, rank and XP.** **Done.** Progression is first-class: `characters.level`,
`characters.xp`, `characters.rank` (free text such as `Copper → Iron`) and
`characters.xp_to_next`, added by migration v6 with level 1 and 0 XP for an
existing character. The sheet draws a bar filled against the optional target with
a countdown caption, **Level up** adds one level as its own recorded `level_up`
event, and **Edit progression** saves all four fields, writing a history entry per
field that changed. The level shows in the cast list, on the cast rail and as the
first badge on a linked node. No formula runs anywhere: experience never rolls
over, a target below the current XP simply fills the bar, and a rank is whatever
was typed. Export, import and the launch copies carry the new columns, and an
older export imports at the defaults. **M**

**7. Chapter spine.** **Almost done — only dragging in the list is left.**
Migration v7 gives `nodes.chapter_seq`; existing chapter cards are numbered by
creation order, and each new chapter takes the next number. The Chapters tab
lists them from 1 with **New chapter** appending, ↑/↓ moving one place, and
**Renumber** to repair repeated, missing or absent numbers; a gap left by a
deleted chapter is reported rather than silently closed. The whole order is
written in one `set_chapter_order` command (partial or doubled lists are
refused), each changed chapter's position lands in the history, a move is
undoable, and a chapter card shows `Ch. N` on the canvas. Migration v8 adds
`chapter_arc`, `chapter_words` and `chapter_target`, edited in the row and
validated as whole numbers (zero written, no target below 1), with a story total
that sums the counts and the targets that exist and a bar against them. Every
changed field is revertible from the history. Export and import carry the
numbers and the counts, numbering an older file's chapters in its own order.
Migration v10 adds `nodes.parent_node_id`, so a chapter can hold plain-text
notes: **Notes** on the row opens a panel to add, edit and delete them, each note
kept as a `note` node off the board, named in the trash and the history by its
first line, carried by export and import, printed under its chapter in the story
bible, found by the search palette (which opens the chapter's panel on the note),
and trashed and purged with its chapter. Closing the panel, moving it to another
chapter, switching stories, following a search result away, or cancelling the
editor with **Cancel** or `Escape` asks before an unsaved note draft is dropped;
a second `Escape` dismisses that question.
Remaining: dragging rows to reorder them (the ↑/↓ buttons do the job meanwhile),
and any formatting at all in a note. **M**

**8. POV and in-world time.** **Started.** Migration v9 gives chapters
`chapter_pov` (a live cast id, named in the history and cleared when its cast
member is purged) and `chapter_day` (a whole number from 0 up). Both are edited
in the chapter row beside the arc and counts, validated, carried by export and
import, and drawn on the row. Migration v11 adds `chapter_time`, a free-text time
of day — "Dusk", "18:40", "after the fire" — edited beside the day, kept in the
author's words, printed on the row, in the story bible and in the timeline, and
revertible like any other field. The Chapters tab has a **Timeline** below the
list that orders chapters by day, and inside a day by the time when the label
reads as a clock or a day part (an unreadable label waits after them, in reading
order), names each POV, and counts the chapters with no day yet; the story bible
carries the same timeline and reads the labels the same way. A **Continuity**
panel below it lists advisory flags — chapters with no POV, a chapter that names
a time but no day, a chapter whose day goes backwards in reading order, a
chapter whose time goes backwards inside one day, two chapters placed at the
same moment (labels that resolve to the same minute, quoted as written), and one
cast member named as the POV of two chapters on the same day — and says nothing
when the chapters agree. Each chapter a flag names is a link that opens its
details and brings its row into view, lit briefly to show where the scroll
landed. Editing a chapter is guarded too: opening another chapter, **Cancel**,
`Escape`, another tab or story, or a search result asks before an unsaved draft
is dropped, and a second `Escape` dismisses that question. Remaining: cast in two places at once across different days, and
moments that can only be described in words. **M**

**9. Progression ledger.** A per-chapter record of level and XP for each cast
member (`character_progress`, unique on character + chapter), entered in a small
grid, then drawn as a power curve — one line per character, chapter on the x-axis
and the choice of level, XP or any stat on the y. Warn on drops and on jumps
larger than the author declares. This is the feature a LitRPG writer will open
every session once it exists. **L**

### Phase 3 — the world

**10. Skills.** Replace "Skill: Fireball = Master" attributes with real rows:
name, rank, short effect, the chapter it was acquired in, and optionally the node
that grants it (a `skill` card). Rank can rise, so rank changes get their own
history. The character sheet shows a compact ladder, and a skill's card lists who
has it. **M**

**11. Inventory and currency.** Items with name, rarity, quantity, effect, and
the chapter acquired/lost; a currency row per character (gold, credits, mana
crystals — named by the author). Show carried items on the cast sheet, and
optionally on the graph when a node is an `item`. Keep it a ledger, not a game
engine: no prices, no encumbrance maths. **M**

**12. Relationship map.** Cast-to-cast relations (`ally`, `rival`, `mentor`,
`family`, `owes`) stored per story, drawn as a small graph in a new Cast view and
listed on each character. Relations carry history like everything else. Later,
the continuity check can use them ("mentor is dead in chapter 14 but teaches in
16"). **M**

**13. LitRPG vocabulary.** New node types — `system`, `skill`, `item`, `quest`,
`faction` — with their own colours and legend entries, plus a `system` card styled
as the genre's blue box (monospace, cyan border) and new relation types
(`unlocks`, `requires`, `rewards`). Small, visible, and it makes the board read as
LitRPG at a glance. Export/import and the legend test follow automatically.
**S**

### Phase 4 — see the story

**14. Continuity panel.** An advisory list, never a blocker: chapter gaps and
duplicates, chapters with no POV, cast linked after they are dead or trashed,
skills used before acquisition, level drops between chapters, items held after
being lost, nodes untouched for 30 days, and dangling plot threads with no
`resolves` edge. Every finding names its node and chapter, and clicking it pans
there. Warnings are derived on read, so they cannot go stale. **M–L**

**15. Story dashboard.** The landing view for a story: counts by type, chapters
written vs drafted (a small status on chapter nodes), word totals, the cast with
levels, recent history, trash count, and what changed last. Read-only and cheap
to compute. **M**

**16. Story-bible export.** **Started.** A Markdown file beside the JSON export
opens with the title and logline, then chapters in reading order with their arc,
words against target and notes, followed by a story total; the cast comes next
with level, rank, XP, description, stats and attributes, then the other cards
grouped by kind. Character cards are omitted so a sheet is never written twice,
and no app jargon reaches the file. **Copy bible** puts the same Markdown on the
clipboard, so both routes carry identical text, and chapters now carry their POV,
in-world day and time label, with a **Timeline** section in time order.
Remaining: skills and inventory (phase 3), and open threads. **M**

### Phase 5 — make it feel inevitable

**17. First run and starters.** A sample story — *The System Arrives* — with four
cast members, six ordered chapters, a handful of linked nodes and a couple of
level-ups, created only when the database is empty and skippable. Story templates
for the common openings (`System integration`, `Academy arc`, `Dungeon crawl`,
`Base building`) that create the cast and chapter shell, never fake content.
Empty states on every tab say what the tab is for in one line. **M**

---

## 5. Smaller wins

Individually shippable, in rough value order, to slot between larger features:

- **Duplicate a node** (`Ctrl+D`), offset slightly, links and notes copied,
  recorded as a creation.
- **Box select and bulk move**, then bulk trash behind one confirmation that
  names the count.
- **Tidy layout** — layer nodes by their connections, animate the move, record
  positions as one action so undo can put them back.
- **Fit to view** and **center on selection** (`.`), plus a minimap toggle for
  large boards.
- **Resizable drawer**, remembered per session, so long notes get room.
- **Cast search and sort** (name, level, recently edited) with a pin for the
  protagonist.
- **Node status pills** (`idea` / `drafting` / `written`) on cards, the basis for
  the dashboard.
- **Search filters** in the palette (type, linked cast, has notes) once feature 1
  lands.
- **A visible save beat** — a brief "Saved" in the drawer footer, so silence is
  never ambiguous.

---

## 6. Deliberately not planned

- **Sync, accounts, sharing.** Local-first is the product. Copying the file is
  the sharing story until it stops being true.
- **A levelling formula or dice engine.** The app records the author's numbers; it
  does not decide them.
- **Reader-facing publishing.** The story bible export covers the hand-off.
- **A second database or a service.** SQLite, one file, no daemons.
