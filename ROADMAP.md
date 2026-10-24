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
  fields, and the board now has `system`, `skill`, `item`, `quest` and `faction`
  cards. Skills and inventory are real rows with the chapter they arrived in,
  an item can record where it was lost, skills keep upgrades, uses and sacrifices
  in reading order, and a `skill` or `item` card names who has it. Quests are real
  rows with two chapters and a reward bundle, shown on the chapter cards, while a
  `faction` card is named by the standings held through it. Nothing checks whether
  a level-up was earned or a rank only rose.
- **In-world time is a day and a typed label.** A chapter can name its POV, its
  day and a free-text time, and appears on a timeline, but there is no calendar
  and only labels that read as a clock or a day part are ordered; a shared moment
  is flagged only when both labels can be read that way, and a time with no day
  is flagged so it is not lost. Chapters can be dragged by a row's grip or moved
  with the arrow buttons, but "where is Rook at chapter 9?" is still answered by
  the timeline, not by a search.
- **Continuity checking is partial.** The Chapters tab warns about chapter
  timing, a cast member in two places on one day, an item still carried or
  acquired after its recorded loss, a level drop without a penalty flag, a skill
  used before it was learned or upgraded, a skill used after it was sacrificed,
  and a quest that ends before it starts, names a trashed issuer or pays someone
  absent from its ending chapter.
  Nothing checks that a character is in two places across days, that a chapter is
  missing, or that an event was entered at all; warnings only exist where the
  author recorded the chapter.
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

**7. Chapter spine.** **Done.**
Migration v7 gives `nodes.chapter_seq`; existing chapter cards are numbered by
creation order, and each new chapter takes the next number. The Chapters tab
lists them from 1 with **New chapter** appending, ↑/↓ moving one place, a grip
on each row to drag it anywhere in the list, and
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
a second `Escape` dismisses that question. A dragged row shows which side of the
target it would land on and writes the whole order once; the arrows remain the
keyboard route, and dropping a row where it already was writes nothing.
Remaining: any formatting at all in a note. **M**

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
is dropped, and a second `Escape` dismisses that question. Closing the app
window asks before a chapter or note draft goes, with **Keep working** focused.
Remaining: cast in two places at once across different days, and
moments that can only be described in words. **M**

**9. Progression ledger.** **Started.** A per-chapter level milestone now exists
(`character_level_milestones`), entered on the sheet with a chapter, an explicit
penalty flag, optional **Total XP** and any number of **stat changes** (schema v19:
gain, resulting value, or both, one row per stat), and compared
in reading order on the Chapters tab and the chapter cards. The Characters tab now
draws a **Power curve**: one step line per character, chapters in reading order on
the x-axis, and a y-axis that switches between level, total XP, XP earned and any
recorded stat, with a toggle for every plotted line or bar group so power
curves can be compared side by side. Level and total XP come from milestone rows;
an unplaced or trashed chapter is left off rather than guessed at, and a milestone
without the chosen snapshot does not erase the last recorded value. XP earned now
has its own ledger (`character_progress`, schema v18): one amount per character
per chapter, edited on the sheet and drawn as grouped bars rather than a line
because income is not cumulative. The ledger travels in export and import, and
the continuity panel reconciles the income through each total-XP milestone with
the total recorded there, naming both a shortfall and an excess; a one-click
**Sync to N XP** puts the ledger's sum on that milestone as an undoable edit. A
database query
also answers "where did this character stand as of this chapter?" —
active level, skills learned and their rank at the time, with sacrifices removed —
and the chart's **As of chapter** readout uses it. Chapter cards on the Graph tab
also carry compact badges for the linked cast, the POV character and every
character added with **Cast** on the Chapters tab, with that snapshot's level and
the active skills in the tooltip. `chapter_cast` is schema v16, so a party can
share a chapter without overwriting its one linked cast member; the explicit list
travels in export and import. Remaining: a grid entry flow and declared jumps
allowed. **L**

### Phase 3 — the world

**10. Skills.** **Done.** A cast member's skills are rows with a name, an
optional rank and effect, the chapter they were acquired in, and optionally the
`skill` card that grants them. Each field change is its own history entry, the
character sheet lists them alphabetically with their chapter, and a skill's card
names its holders with each one's rank and chapter. A reference whose node is
purged is cleared rather than left dangling; trashing one alone keeps it.
`character_skills` is schema v12, carried by export, import and the story bible,
and covered by database and UI tests. **Skill events** (schema v15) record an
upgrade, a use or a sacrifice against a chapter, with an optional rank, and can
name the level-up they came with so an upgrade groups under that one milestone;
they are listed in reading order under the skill, audited individually, and
carried by export and import. **M**

**11. Inventory and currency.** **Done.** A cast member's items are rows with a
name, an optional rarity and effect, a quantity, the chapter acquired in, the
chapter lost in, and optionally the `item` card they belong to. Currencies are
separate named amounts (gold, credits, mana crystals — named by the author), with
no exchange rate. Both are listed on the cast sheet, saved field by field into
the history, and carried by export, import and the story bible. An `item` card
names its holders with quantity, rarity and chapter, the Chapters tab flags an
item still carried after it was recorded lost, or lost before it was acquired,
and that short warning sits on the lost chapter's card on the Graph tab, where
clicking it opens the holder's sheet and **Mark returned** clears the recorded
loss in place. The notice that follows offers **Undo**, and the correction is
recorded as one board history step. A purged chapter or card clears only the link. `character_inventory` and
`character_currency` are schema v13, and `lost_chapter_id` is schema v14, with
database and UI tests. **M**

**12. Relationship map.** **Done.** `character_relations` (schema v20) joins two
cast members with a free-text kind, an optional note and the chapters it began
and ended in; `ally`, `rival`, `mentor`, `family` and `owes` are only suggestions,
and symmetric kinds are stored in one direction so a bond cannot be entered
twice. `faction_standings` records a character's place in a faction card for an
arc, with the chapter it began in required and an optional end. Both are listed on
the character sheet with add/edit/delete, audited per field, carried by JSON
export/import and the story bible, and a trashed card clears its link only on a
purge. The Characters tab gained a **Relations** view: cast on a ring, faction
hubs in the middle, edges styled by kind, focus dimming, and a line that opens its
entry on the sheet. Continuity names a relation pointing at a trashed cast
member, a standing on a trashed faction card, an arc that ends before it begins,
and two stints held in one faction at once. A dead-mentor check still needs a way
to record death. **M**

**12b. Quest and contract ledger.** **Done.** `quests` and `quest_rewards`
(schema v21) record a contract's title, free-text status, required acceptance
chapter, optional ending chapter, cast giver and faction card, description and
notes, plus a bundle of XP, item, stat and faction-standing payouts; choosing an
ending chapter marks the quest completed and clearing it reopens it, with the
form refusing a status that says otherwise. A faction card can be created from
the form that needs it. Every field
change is audited; the acceptance chapter is a foreign key that takes the quest
with it on purge, while the other links are cleared. The Quests tab filters by
status and edits one quest at a time; chapter cards badge both chapters a quest
touches and open it in the ledger. A completed quest offers **Apply rewards to
chapter ledger**, which prefills numeric XP rows and loot for the ending chapter
and leaves stats and standings to the sheet; an existing XP row in that chapter
is added to rather than duplicated, and the notice names the old and new totals. A
reward remembers when it last reached the ledger (schema v22), so a repeat
application pays only the unpaid rewards and a fully paid bundle asks for
confirmation inside the quest card before it writes anything; editing the reward
or changing the ending chapter clears that memory. Export and import remap every link, and continuity flags an ending
before the acceptance, a trashed issuer on an open quest, and a payout to someone
not in the ending chapter's cast. **L**

**13. LitRPG vocabulary.** **Done.** `system`, `skill`, `item`, `quest` and
`faction` are first-class node types with their own colours, legend entries and
captions, so the board reads in the genre's own words. A `system` card is drawn as
the genre's blue box — monospace, cyan edge, faint glow. The connection editor
suggests `unlocks`, `requires` and `rewards` while staying free text. No schema
change: a node's type was already a string, so export and import carry the new
names unchanged, and the legend test covers them. **S**

### Phase 4 — see the story

**14. Continuity panel.** **Started.** An advisory list, never a blocker. The
Chapters tab currently flags chapter timing and duplication, a cast member intwo chapters on one day, an item still carried after its recorded loss or lost before
acquisition, a level drop without a penalty flag, a skill used before acquisition,
a rank used before its upgrade, and a skill used after sacrifice. The last three
and the level drop also appear as buttons on the affected chapter card; clicking
one selects the holder and opens the exact milestone or skill event. The
Characters tab's chapter-state query uses the same reading order for a snapshot
of active level and skills. Remaining:
chapter gaps, cast linked after they are dead or trashed, nodes untouched for 30
days, and dangling plot threads with no `resolves` edge. Every finding names its
node and chapter; chapter links pan to that chapter, and progression links cross
to the character sheet. Warnings are derived on read, so they cannot go stale.
**M–L**

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
Remaining: open threads. **M**

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
