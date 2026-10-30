# Roadmap and integrity checklist

LitRPG Storyboard Tracker · updated 27 October 2026

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
- **The app is being taken apart at its seams.** Each tab, and then the state
  behind it, has moved into `src/domains/` with tests of its own, so `App.tsx` is
  the story state and the layout rather than every one of them at once. §5 has
  what is left.

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

That is the product order. Beside it, the app is being taken apart at its seams,
which §5 covers.

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

**4b. Canvas creation forms.** **Done.** **Add Node** keeps the quick label-only
path for narrative cards, while character, quest and skill open a full form and
create the record behind the card in the same step: a cast member and a linked
character card, a quest contract and its card, or a sheet skill and the card that
grants it. The toolbar label prefills the name, the accepted chapter defaults to
the first chapter, and required fields gate submission. The creation is one
undoable step whose undo and redo also keep the cast rail, quest ledger and skill
lists in step, and a refused skill removes the card it had just made. **M**

**4c. Add a holder from a skill card.** **Done.** Selecting a skill card in the
inspector lists its holders and offers **Add holder**. The card's saved name and
notes become the new character skill's name and effect, while rank and chapter
are entered for that holder; the character picker leaves out anyone who already
holds the card, and unsaved card edits pause the form. **S**

**4d. Card edits follow to holders.** **Done.** Saving a skill card's label or
notes updates every linked character skill's name and effect in the same
transaction, leaving each holder's rank and chapter alone. A rename that would
collide with another skill on a holder's sheet is refused as a whole, and the
open board and sheet follow the save without reopening the story. **S–M**

**4e. A card's life governs what it named.** **Done.** A skill row that names a
card is only read while that card is live: `list_skills` and `list_story_skills`
join to a card with no `deleted_at`, and `list_story_chapter_events` drops any
event naming a skill whose card is in the Trash, so a held skill and the chapter
that granted it arrive and leave together. An item row follows the same rule: a
sheet keeps an `item` card's item only while the card is live, and the scene that
announced the acquisition leaves the ledger with it, so both kinds of card that
name a row answer the Trash the same way. A skill or item typed straight onto a
sheet has no card and is never affected. Nothing is copied or rewritten on the
way down, so restoring the card — Undo, or Trash → **Restore** — brings the same
rows back with their rank or quantity, chapter and history, and no second undo
step. A purge is the end of it: `purge_card_rows` runs before the node row goes
and removes the chapter rows naming those skills and items, then the rows
themselves, so a purged card cannot leave anything pointing at a node that is
gone. The board, the open sheet and the ledgers re-read on delete, undo, redo and
restore rather than waiting for a tab switch. A row's line in the Trash says what
a permanent delete would take with it — `list_deleted` fills a `detail` from the
same rows the purge removes, so the skills, items, chapter events and notes go
named rather than discovered. The same line reaches the other kinds: a character's
counts the sheet, scenes, cast places, relationships and standings that cascade
with them and names apart the links a purge only clears (a card's cast link or POV,
a reward's target, a quest's giver), and a connection's names the two cards it
joined and says it takes nothing but the link. The quest half of that question is 4f. Remaining are the other kinds: `faction`
standings are deliberately read with trashed cards included so a standing
outlives a card, and a `character` card is only a shortcut to a cast member
expected to outlive it. A card copied off the
rail starts with no owner and no chapter, so it owns nothing to lose until an
author gives it a holder. **M**

**4f. A card and its record name each other.** **Done.** The four card kinds with a
record behind them are joined by id, so a rename on either side leaves the pairing
alone: `nodes.character_id` for a person, `skill_definitions.node_id` for a skill,
`character_inventory.node_id` for an item, and — new in schema v35 —
`quests.card_node_id` for a contract. The quest column was the missing one; a quest
and its card were joined by nothing but a shared label, so the ledger could not name
the card, deleting one half left the other looking complete, and `link_quest_card`
could not be written at all. The migration back-fills the pairing from the label
match the board had been relying on (earliest quest with each title takes the
earliest card, case and spacing ignored, so the unique index holds), and a file
that never went through v3 keeps its quests unlinked rather than failing. The link
is by id and survives a card's trip to the Trash, which the ledger reads as
**Card: in the trash**; a purge clears it through `ON DELETE SET NULL`, and a
partial unique index lets one card stand for one quest while `link_quest_card`
refuses a card of the wrong kind or one another quest claims. A quest written in
the ledger has no card until **Place card** makes one, which writes both halves as a
single undoable step. Skill cards come back to the board's **Add** menu for the
matching reason: `canvasCreateNodeTypes` lists everything, a placed card starts
with no holders, and the first holder is what turns it into the shared definition
— so a skill can be planned before anyone learns it, without a second writer for
the definition row. The kinds with nothing behind the card say so in the drawer
(`cardOnlyNote`), so an author never hunts for a form that never existed. A
`faction` goes further, because two columns already point *at* its card and it has
no table of its own: `quests.faction_node_id` and `faction_standings.node_id` both
hold a `faction` node's id, so the ledger draws a quest's faction as a chip that
opens that card (`onOpenCard`, the same call the **Card:** chip makes) and the
card's drawer lists the quests issued from it, each opening the ledger focused on
that contract. A faction card in the Trash reads as **faction in the trash**
rather than opening nothing, and under the quests it lists the standings sheets hold
through it, each name opening that sheet. Remaining: renaming a quest does not
rename its card, and a card's own label can drift from the record it stands for —
the chip shows the card, which is honest, but there is no nudge. **M**

**4g. A quest with no card can still be dragged onto the board, and the System
writes itself out.** **Done.** Two gaps about the same thing: a record the board
could not show. The rail listed only cards, so a quest written in the ledger — and
stored with no `card_node_id` — was invisible on the Graph tab until somebody went
to the ledger. It is listed now as an **Unplaced** tile with a dashed edge, and it
is dragged with its ledger row under `QUEST_DRAG_TYPE` rather than a card id,
because there is no card to copy: `placeQuestFromRail` is `placeQuestCard` handed
the drop's point, so the card, the `link_quest_card` and the history step are the
same three writes the ledger's **Place card** makes. The second is the `system`
card, which was a label and a paragraph. It is now the box a LitRPG reader meets —
dark panel, cyan edge, gold hairline, header, title, stat block — and **Copy System
Box** puts the box on the clipboard as plain text with its bold lines marked, from
the card or from the drawer, because the announcement is written in this app and read
in a web editor. **Copy HTML** sits beside it with the same parts as a centred
`<div>`, every heading and stat line in its own `<strong>`, its parts escaped so a
stat line of `<HP>` stays text, for a site whose editor takes tags. Neither copy
carries a frame: no quote marks or list dashes, since the author centres the block
rather than pasting punctuation into the chapter.
The box needs no schema: the label is the header, the first notes line the title
and the rest the body, so `systemBoxOf` in `src/domains/canvas/SystemBox.tsx` reads
the two fields every card already has. Remaining: the header cannot be styled
apart from the card's label on the board. **M**

**4h. A System box knows what it is announcing.** **Done.** The box drew one shape
for every announcement: a header, a title and a paragraph, so a level-up could not
say which level moved and a quest could not show a ticked objective. The drawer now
opens on a **Message type** — notice, level up & stats, skill learn / evolve, quest
offer / completion, achievement unlocked — and shows only the fields that type asks
for: the level it moved between, the points to place and a row per stat; a skill's
rank and what it evolved out of; a quest's status, objectives and rewards; an
achievement's reward. The card face draws each in its own shape and the edge takes
the kind's colour, and both copies write the structured box — Markdown with a
quoted line per stat and `- [x]` per objective, HTML with a real `<ul>`. The
message is still text: `systemMessage.ts` reads and writes `nodes.content` in a
small line format (`Type:`, `Title:`, `Level: 3 → 4`, `Stat: Agility | 12 → 13`,
`---`, then free text), so there is no migration, one Save is still one
`update_node` and Undo takes the whole box back. A card written before the format
reads as a notice and converts on its first edit. The demo now seeds two cards — the
notice and Ivy's fourth level written out as a `level_up` box, its level and stat
rows matching the row the story's curve already records at 1,800 XP — so the guide's
picture is of a typed box and the board shows both shapes. Remaining: the type lives
in the notes, so an author who edits them by hand can drop back to a notice. **M**

**4i. A System box can be written from the scene that caused it.** **Done.** The
ledger on a chapter card already records the XP paid, the skill learned and the
rank that moved, so the drawer no longer makes an author retype it: **Write from a
chapter event** lists the scenes that can be announcements and fills the type and
its fields when one is chosen. The levels are the ones the story's own curve
produces — `chapterEventChoices` adds the chapter incomes in reading order and asks
`levelForXp` with the character's rule or the story's — so an award that crossed a
level offers the points the rule hands out for each crossing, and an award that
crossed nothing is not offered at all. Skill events offer the name, the rank on the
sheet and, for an evolution, what it grew out of; an acquired item is left to the
author because no box kind is an inventory row. Everything stays editable, and the
prefill is one draft write, so it is one Save and one Undo. The picker offers the
chapter the box belongs to rather than the whole story: `chapterBesideCard` reads a
drawn edge to a chapter first, then the nearest chapter card on the board, and the
note under the picker says which chapter and why; a chapter with nothing writeable
falls back instead of leaving an empty picker: first the chapters one ring out in the
reading order, then the next ring, and the whole story only when no scene has anything
writeable. That line also carries **Show every chapter** and the way back — **This
chapter only**, or **Nearby chapters only** when it had widened — so the narrowing is a
default rather than a cage, and returning to a card starts narrow. A level-up also
writes the stat rows of the levels it crossed: one row per stat, aggregated across the
crossing with `statKey` so a spelling difference does not split it, and a level holding
only its gain prints the gain. The demo's typed gain card is drawn from chapter five, so
the guide's picture shows the connected case. Remaining: an item the scene handed over
still has no box kind, and an award that crossed no level is not offered even when the
levels it paid into recorded a stat gain. **M**

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

**9. Progression ledger.** **Started.** A per-chapter level row now exists (since schema v29,
`character_level_records`), entered on the sheet with a chapter, an explicit
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
also carry compact badges for the POV character and every character added with
**Cast** on the Chapters tab, with that snapshot's level and the active skills in
the tooltip. `chapter_cast` is schema v16, so a party can share a chapter, and
schema v31 folded each chapter's old single link into those rows: the badges are
the whole roster now, and the card has no second binding to disagree with them.
The explicit list travels in export and import. Remaining: a grid entry flow and declared jumps
allowed. **L**

**9b. A level that explains itself.** **Done.** The level is no longer a field
anybody types: `characters.level` is rewritten from the last level-up recorded
(schema v25), so the sheet, the cast rail, search and the cards read one number,
and `set_character_progress` lost its level argument. The silent **Level up**
counter is gone; **Record level-up** opens the next milestone in the creator with
the level already in it. A growth rule (`level_growth_rules` and
`level_growth_stats`) says what one level hands out — points to place and stats
that rise on their own — set once for the story with a per-character override,
read by the level-up form and never applied by itself. `character_awards` records
the gains that skip a level-up: XP paid into a chapter's income, or a stat point
put on the sheet, applied and withdrawn in the same step. A skill event may name a
level-up from another chapter now, because a skill grows on its own clock. All
three travel in export and import, and a revert of an old typed level is refused
with a reason rather than desyncing the sheet from its milestones. **M**

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

**10b. Skill evolution and fusion trees.** **Done.** `skill_evolutions` (schema
v23) links a parent skill to the later skill it became, by upgrade, fusion,
mutation or branch, with an optional chapter, required parent rank and notes.
Both ends must be live skills of the story, self-links are refused, and a direct
or indirect loop is rejected against the recorded graph. Every link is audited
when created and deleted; editing means deleting and recording it again. The
Characters tab's **Skill trees** view lays the skills out in tiers and draws each
kind of link in its own colour, with a character filter, a legend and a panel that
adds prerequisites or outcomes and deletes a link. Sheets name each skill's
requirements and outcomes, the database exposes story and per-character tree
queries, and export/import remap both ends and the chapter, refusing a file that
carries a loop. Deleting a skill cascades its links; purging a chapter clears the
link's chapter. Continuity flags a child that appears before its parent, a fusion
unlocked before the required rank, and a link into the trash. **L**

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

**13b. The curve, and experience that levels.** **Done.** Schema v26 gave the
growth rule two numbers — `xp_base`, the XP the second level costs, and
`xp_growth`, a percentage more for each level after it — and made `characters.xp`
the sum of the chapter income instead of a typed field. `characters.level` and
`characters.xp_to_next` are now read from that curve by
`refresh_character_progression`, which runs inside every transaction that changes
the income (an amount added, edited or deleted, an XP award, a rule saved) and
writes the timeline row plus the rule's automatic stats when a step is crossed;
deleting the income reverses both. **Record level-up**, the milestone creator and
the XP and target fields are gone: the sheet's only progression input is the rank,
and experience is recorded where it was earned, on the chapter it was earned in.
The timeline is a readout, and a level recorded before the curve is a floor rather
than a rival (`character_level_records.source`). The sheet's head reads the cast
row the curve wrote, not the last level in the timeline, so a character whose
experience has carried it past its recorded levels shows the level it is at; and
every write that can move a level — income, an award, a rule — reads the cast row,
the timeline and the sheet's stats back in the same step rather than waiting for
the tab to be opened again. Purging a chapter keeps the
experience it paid for and clears the chapter, so tidying the board cannot de-level
anybody.

**13c. The curve's crossings.** **Started.** `src/domains/progression/crossings.ts`
works out where the curve was crossed — one level per step, in the chapter whose
income carried the total over it — from the ledger and the effective growth rule,
and every reader that needs a level now reads it there. The chart's level and XP
lines plot the crossings (the XP line plots what the rule says a level costs, not
what a hand-written row says it cost); the warning about a level-up's total
compares the row against the curve's step for that level, and its one-click fix
writes the rule's number; the chapter snapshot's level is the curve's. A row the
author recorded keeps its chapter, because that placement is the story's, and a
level recorded above the ledger's reach still stands as a floor. The demo's own
timeline was reseeded to cross the rule's steps, so the clean demo now records the
rule's +1 Strength and +1 Insight on every level instead of a hand-typed set that
contradicted its System. Remaining, and next: `character_state_at_chapter` still
picks its level from the last row at or before the chapter rather than from the
income paid by then, the skill-event picker still lists every row instead of the
levels reached, and the milestone table is still where a level's stat gains live.
The snapshot and the picker both read the curve now, so what is left is the table
itself. Done: the levels live in one table. `character_level_records` holds one
row per character per level — the chapter it landed in, the total it stood at, and
whether the curve (`level`) or the author (`recorded`) put it there — unique on the
pair, so a level can only be recorded once. Version 27 copied the timeline into it
under the same ids and wrote both tables while the readers moved; version 28 moved
each level's stat gains onto the record, so they travel with the level when it
moves; version 29 dropped the timeline table and re-pointed a skill event's link at
the level itself. The readers, the export, the import, the demo seed and the guide's
fixture all answer from the records, and the commands say so:
`get_character_levels`, `get_story_levels`, `add_character_level`,
`update_character_level`, `delete_character_level`. Adding a level the curve has
already written takes that row over rather than making a second one, which is how
an author places a level the experience paid for, and an empty form on that add
leaves the gains the level already handed out alone. **M**

**13d. Points a level hands out.** **Done.** Version 30 adds
`character_growth_points`, and it holds only the placings: what a character has
earned is `points_per_level` taken once for every level above the first, read from
the rule their sheet follows. That is why a rule the author retunes retunes the
pool instead of leaving old rows claiming a share the rule no longer describes, and
why nothing had to be back-filled for a story already on file — an empty table is
every point still waiting. The sheet shows the tally directly under the progression
bar ("5 of 6 points to place", with what has been placed beside it), each stat row
carries a **Place point** button while points are left, and a stat that took any
says how many of its value came from levelling rather than from typing.
`spend_growth_point` raises the stat and records the placement in one transaction
and refuses a point the levels never handed out — the pool is checked there, not in
the form, because a stale sheet would otherwise overspend it. The pair is one undo
step: undo takes the placement back and the stat with it, and redo spends again.
Placings travel with the JSON export and import. The continuity check now counts a
stat award and a placed point recorded after a level-up when it compares the sheet
with the ledger, so spending a point no longer reads as the sheet drifting, while a
value beyond what was recorded still does. **M**

**13e. The sheet's stats where the levels are.** **Done.** The stats live in
`src/domains/characters/StatList.tsx`, rendered by the progression sections
directly under the bar, before the timeline: the order is now level, points, the
numbers the level moved, and then the record of where it came from. The section's
heading names the rule's own gains in a sentence (`Every level raises Strength +1
on its own`), each row repeats its rate beside the value (`+1 a level`, or `-2 a
level` when a level takes something away), and a stat the rule raises that the
sheet has no row for is drawn as its own dashed row saying so — the rule cannot
raise a number nobody records. The row's open editor and the two writes moved with
it: `useSheetStats` is called by the list now rather than the app, the open row
closes when the sheet changes hands, and the app keeps only the rows themselves,
because the canvas badges are drawn from them. **S**

**14. Continuity panel.** **Started.** An advisory list, never a blocker. The
Chapters tab currently flags chapter timing and duplication, a cast member intwo chapters on one day, an item still carried after its recorded loss or lost before
acquisition, a level drop without a penalty flag, a skill used before acquisition,
a rank used before its upgrade, a skill used after sacrifice, a skill that appears
before its parent in a skill tree, a fusion unlocked before the required parent
rank, and an evolution link into the trash. The last three
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

## 5. Stage 4 — the domain hooks

The tab panels came out of `App.tsx` one domain at a time. What is left there is
mostly *state*: the drafts, prompts and notices of a single slice, spread from the
top of the file to the bottom. Stage 4 moves each slice into a hook beside its
domain, so a change to the canvas or the history opens one file instead of
searching ten thousand lines. Nine are done.

- **`domains/history/useHistory.ts`** — the session's undo and redo stacks, the
  50-step cap, the counts the toolbar draws, the undo notice and its own fade,
  the walk between the stacks, and the note that stops a half-step being reported
  twice. Direct suite of 19.
- **`domains/canvas/useCanvasDrafts.ts`** — which card or connection is open, the
  label and notes its fields hold, the half-written text remembered per card, the
  close prompt, the rename offer, both editors' messages, and the rule that an
  open editor follows the stored row unless it holds typing. Direct suite of 22.
- **`domains/narrative/useChapterWorkspace.ts`** — the reading list's controls,
  the details form and the six drafts it edits, the question it asks before
  another chapter replaces them, the notes panel with a question of its own, and
  the cast picker: the notes rows move in, the cast rows go back out. Direct
  suite of 31.
- **`domains/stories/useStoryShelf.ts`** — the sidebar's rename field and the
  delete question asked in its row, the import, export and copy notices with
  their own fades, and the backups dialog: which copy is asked about, the one
  being restored, and the rule that keeps every close path shut while the file
  underneath the app is half replaced. A restore hands back the stories the
  restored file holds, so the board, the notes, the cast and the undo history are
  dropped from the one place that owns them. The dialog's markup moved with it
  into `BackupsDialog.tsx`. Direct suite of 32.
- **`domains/search/useSearchPalette.ts`** — the open flag, the term, the kind
  filter and the cursor, and the boards of the stories that are not open: read
  once each when the palette opens, dropped the moment their story is opened, and
  forgotten whole when the database is replaced. The search itself is a pure
  function over the open story's rows and those copies, in `results.ts`, so the
  reach and the ranking are read without React; the wording is in `labels.ts` and
  the four reads of a closed board in `api.ts`. It also keeps the id of the story
  the window was showing, which is what the history writes a refused step
  against. Direct suite of 29.
- **`domains/progression/statNames.ts`** — how a stat name is compared when a sheet
  is checked against the values its level-ups recorded: no case and no doubled or
  outer spaces, an exact spelling preferred when the sheet holds both, and the row
  that is probably the same stat renamed (an abbreviation or a typo), which is only
  ever offered as a hint. Pure, so the rule is read without React. Direct suite of
  10.
- **`domains/progression/useProgressionChart.ts`** — the metric a line is read in,
  the stat it follows, the cast members hidden from the comparison, and the
  chapter snapshot: which chapter it asks about, the answer keyed by cast member,
  and the rule that nothing is asked while another tab is showing. The lines and
  the metric filter are pure, in `chart.ts`, so what a metric can plot is read
  without React. Direct suite of 27.
- **`domains/canvas/useCanvasInspector.ts`** — the cast member the open card
  names, that member's own stats and attributes, the one row of each list that
  is open for editing, and the four writes, which run the same commands the
  sheet runs, so a number changed from the canvas is recorded as if it had been
  typed on the sheet. The cast arrives as an argument, so resolving the link is
  all it does with the board; a saved stat goes back out through `rememberStat`,
  because the badges are drawn from the story-wide read. The relink and the
  rename report on the same line, so they are handed the hook's own reporter.
  Direct suite of 31.
- **`domains/characters/useSheetStats.ts`** — the sheet's stat section: the name and
  value of its new-stat form, the one row open for editing with that row's
  value and notes, and the two writes, which run the command the sheet has
  always run. The rows themselves stayed with the app, which reads them for the
  open cast member and reads them again after a revert, so a write hands the row
  that came back straight back out: it has two places to go, the sheet's own
  list and the story-wide map the badges on every card are drawn from. The
  tab's error line is shared with every other write on it, so it arrives as a
  callback rather than being owned here. Direct suite of 26.
- **`domains/canvas/useSkillHolderForm.ts`** — the character, rank and chapter a
  holder is added with, the line the form complains on, the busy flag the
  button reads, and the write, which copies the card's saved name and notes
  onto the chosen character's sheet. The card arrives as an argument rather
  than being looked up in the board, so nothing about React Flow reaches the
  form; the row that comes back leaves on one callback, because a skill is
  listed by the board and, when the open sheet is showing the character who
  learned it, by the sheet as well. The form belongs to the card the drawer is
  showing, so opening another card — or closing the drawer — empties it, and the
  card's id rather than the object it arrives in decides, because the app builds
  that object afresh on every render. Direct suite of 21.

Each follows one shape, and every later hook should too:

- **The rows come in.** A hook that has to measure a draft against a stored row
  takes the rows as an argument rather than reading the database.
- **Writes stay with the app.** A save still runs its command, its history step
  and its audit entry in `App.tsx`; the hook is handed the row that came back.
  A plain field edit is the exception: the inspector's four writes run the
  sheet's own commands, which write their audit entry themselves, and carry no
  history step, so there is nothing outside the hook for them to keep in step.
- **Outside work is a callback.** What a hook cannot own — the error line, the
  board reload, the audit entry — arrives as a named callback, never a bare
  setter.
- **Each one lands with its own suite.** A direct test of the hook, mutation
  checks against it, then `tsc`, the full suite and the build before one commit.

### What is left

The drafts are out: the nine hooks above hold every field, prompt and notice
that belonged to a single slice of the app. What remains in `App.tsx` is the
board's half of the two loads — `loadStory` and `reloadStory`, the pair every
write ends with, and the rows the canvas, the undo refresh and the sheet all
read. A `useStoryBoard` is the biggest remaining cut and the riskiest, and it
is described with everything else that stays.

### What stays in `App.tsx`

- **The rows every tab reads.** `stories`, `currentStory`, `characters`, `nodes`,
  `edges` and the story-wide lists are read by several tabs at once, so they stay
  where the loads and the writes can both reach them.
- **The two loads.** `loadStory` and `reloadStory` are the pair every write ends
  with. Taking the board's half of them into a `useStoryBoard` is the biggest
  remaining cut and the riskiest, because the canvas writes, the undo refresh and
  the sheet all read the same rows. The story shelf's drafts are out, so what is
  left in front of it is the board itself.
- **The writes themselves.** A handler that runs a command, records a history
  step and writes an audit entry belongs beside the history hook, not inside a
  drafts hook.
- **`actionError`.** One line at the top of the window collects whatever any of
  them refused, so it stays app-wide rather than per-slice.

---

## 6. Smaller wins

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

## 7. Deliberately not planned

- **Sync, accounts, sharing.** Local-first is the product. Copying the file is
  the sharing story until it stops being true.
- **A levelling formula, auto-levelling or dice engine.** A growth rule fills in
  the level-up form so an author does not retype the same points every level, but
  nothing awards a level, spends a point or rolls a die on its own.
- **Reader-facing publishing.** The story bible export covers the hand-off.
- **A second database or a service.** SQLite, one file, no daemons.
