# LitRPG Storyboard Tracker

[![CI](https://github.com/Ayern/litrpg_storyboard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Ayern/litrpg_storyboard/actions/workflows/ci.yml?query=branch%3Amain)

A local-first desktop app for plotting LitRPG and progression-fantasy stories: one
idea graph per story, a character sheet with numeric stats, and an audit trail that
records who changed what.

Everything lives in a single SQLite file on your machine. No accounts, no network,
no sync.

How to use it — plotting a story on the board, keeping its numbers straight, and
getting it back out — is the illustrated [STORYBOARDING.md](STORYBOARDING.md),
which is also what the app's own **Guide** button opens. How the engine works —
what happens between a line drawn on the canvas and the row it writes, and which
module owns which part of that trip — is the illustrated [GUIDE.md](GUIDE.md),
written for whoever changes the app. What comes next, and the invariants every
change keeps, are in [ROADMAP.md](ROADMAP.md).

## Features

**Stories** — create, rename and delete. The sidebar orders them by most recently
touched.**Load demo story** builds a prepared three-chapter story with three cast members, stats, skills, relations and faction standings, chapter cast, chapter objectives, level and stat milestones, and XP income rows. Its board is already drawn — the three chapter cards, cards for each cast member, an item card, a faction card, a quest card, two skill cards, and the connections between them — and its ledgers are filled: one finished quest with its four rewards, one still open, two chapter notes, an inventory and two currency rows. A cut cast member, a cut card and a scratch story wait in the trash, so restoring something can be tried without deleting anything of your own. Everything the guide documents is this story: the app builds it, and so do the pictures in [`GUIDE.md`](GUIDE.md). Its last chapter deliberately leaves Mira's ledger 100 XP short of her total, so the continuity warning and chapter-card badge can be tried without touching a real story. While it keeps its prepared title and the demo is
selected, **Reset demo story** replaces its chapters, cast, progression and
history in place with a fresh copy of the sample data, so a walkthrough can be
repeated without piling up demo stories. It is an ordinary story otherwise:
rename, export, edit or delete it like any other.

**Idea graph** — a pan/zoom canvas built on React Flow. Nodes have a type
(`chapter`, `idea`, `character`, `location`, `event`, `plot`, `system`, `skill`,
`item`, `quest`, `faction`, `misc`) and can be connected with edges. Each type
draws as its own colour with the type named on the card, and the legend uses the
same palette, so a board of a hundred notes reads by shape and colour before any
of it is read. The five LitRPG types make the board read in the genre's own
vocabulary, and a `system` card is drawn as the genre's blue box: monospace text,
a cyan edge and a faint glow. An unrecognised type is drawn as `misc`
rather than unstyled. Dragging a node saves its position. Deleting a node removes
the connections attached to it, and the node plus each removed connection are
recorded in the history.

**Chapter order** — the Chapters tab lists every live `chapter` card in reading
order, numbered from 1, with **New chapter** (which creates the card and puts it
last), **↑**/**↓** to move one place, a grip on each row to drag it anywhere in
the list, and **Renumber** whenever positions repeat, are missing, or a chapter
has none. A drag shows a line on the side of the row it would land on, and a
pointer is not required: the arrows move the same chapters from the keyboard. A
move writes the whole order in one command and renumbers the rest, so the list is
1..n unless a chapter was deleted or an older file was imported — and then the
tab says which positions are empty or doubled rather than renumbering behind your
back. A chapter card shows `Ch. N` beside its type on the canvas, both directions
of a move are recorded in the history, a move is undone like any canvas change,
and dropping a row where it already was writes nothing. Cards that are not
chapters are never numbered.

**Chapter arcs, counts, POV, days and times** — a chapter can also name the arc it
belongs to, record the words written against an optional target, say whose point
of view it is told from, and sit on an in-world day at a time of day. **Edit** on
its row opens Arc / Words / Target / POV / Day / Time in place; `Enter` saves,
`Escape` or **Cancel** closes without writing, asking first when anything has
been changed. Switching to another tab or story, or following a search result
away from the form, asks the same question before the edit is dropped. A question
puts focus on **Keep editing**, and answering gives the keyboard back to the
field; a second `Escape` dismisses it without touching the form. A blank arc,
target, POV, day or time stores nothing, while a count of zero is kept — "no
count" and "nothing written" are different facts. The POV picker lists the
story's live cast, and the day is a whole number from 0 up; there is no calendar,
so a story can count "days since the System arrived" instead of dating anything.
The time is free text — "Dusk", "18:40", "after the fire" — kept in the author's
own words. POV, day and time
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
backwards inside one day, two chapters placed at the same moment, one cast
member named as the POV of two chapters on the same day, an item still carried
after it was recorded lost, and an item lost before it was acquired. A time is
only compared when both labels read as a time of day, so "after the fire" is
never guessed at.
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
silently. **Cancel** and `Escape` ask the same question before closing the form,
and so do a tab switch, another story and a search result.

**Chapter notes** — a chapter can hold any number of short notes: **Notes** on its
row opens a panel with **Add note**, **Edit** and **Delete**. There is no
formatting and no manuscript — a note is exactly the text typed into it, shown
under the chapter it belongs to, and `Ctrl`/`Cmd`+`Enter` adds or saves one. A
note is stored as a `note` node with a parent pointer, which is what lets it
appear in the trash, name itself in the history by its first line, travel in an
export, sit under the chapter's heading in the story bible and be found by the
search palette. Notes are off the canvas by default; **Show notes** on the Graph
toolbar pins the first three under their chapter as small cards, clipped to their
first lines, with the rest counted on a `+N more` card. Clicking a card — or that
count — opens the chapter's panel on the Chapters tab with the note marked. They
are context only: the cards cannot be dragged, nothing is written, and hiding
them leaves the board exactly as it was. Deleting a
note moves it to the trash, and trashing a chapter takes its notes with it —
restoring the chapter brings them back, while a note trashed on its own waits in
the trash until its chapter is live again. The row's button counts the notes
under it. Closing the panel or moving it to another chapter asks before a
half-written note, or an edit that has not been saved, is dropped, and so does
switching stories or following a search result that would leave the note behind.
**Cancel** and `Escape` in the note editor ask before closing just that editor,
and a second `Escape` dismisses the question and leaves the editor as it was.
Closing the app window asks before either a chapter or a note draft goes, with
**Keep working** focused; `Escape` dismisses that question too and puts the
keyboard back in the field.

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

**Creating a card that is also a record** — the type picker and **Add Node** are
the quick path for narrative cards (chapter, idea, location, event, plot, system,
item, faction, misc): type a label and the card is made. Choosing **character**,
**quest** or **skill** opens a full form instead, because those cards stand for
real rows. A character form takes a name and description and creates the cast
member plus a linked card. A quest form takes a title, giver, faction, accepted
and optional ending chapters, description and notes; it creates the contract in
the ledger — completed when an ending chapter is chosen — and a quest card. A
skill form takes owner, name, rank, effect and chapter, and creates the skill on
the owner's sheet plus the skill card that grants it; with **No holder yet**
chosen it places the card alone, because a skill can be put on the board before
anybody holds it. The owner starts unset unless the form was opened by dragging a
connection off a character card, so nobody is attached by accident. The label typed in the
toolbar prefills the name or title, **Create card** stays disabled until the
required fields are there, and a refused write leaves no half-made card: a card
whose skill is rejected is removed again. The board history records both halves,
so Undo removes the card and the record and Redo puts them back; the cast rail and
the sheets follow without reopening the story. Cancelling, closing, or clicking
the dimmed backdrop writes nothing.

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
label and relation type (`leads_to`, `foreshadows`). The field suggests the
LitRPG verbs `unlocks`, `requires` and `rewards`, but stays free text for a
story's own words. Both fields are optional, and each change is recorded per
field like a node edit. A connection that draws a character relation is the
exception: clearing its relation type would leave the bond without its drawing,
so the editor refuses and asks for another verb instead. The canvas shows the
label when there is one and falls back to the relation type. Only one editor is
open at a time: selecting a node closes the connection editor and vice versa.

**Characters** — a cast list per story, each with a name, an optional description,
progression, numeric stats and free-text attributes. Stats and attributes are
identified by name, so adding a stat or an attribute you already have updates it
instead of creating a duplicate. The cast list says each character's level and
rank, and the cast rail on the Graph tab puts the level on every card.

**Progression** — a character's level, experience and rank. Only the rank is
typed: **Edit rank** saves it, and clearing it stores nothing rather than an empty
string. The other two are read. The experience is **XP by chapter** added up, and
the level is what the story's curve buys with it, so the sheet shows `1,400 /
2,100` under the bar and the caption counts down to the next level. A character
starts at level 1 with nothing earned. Nothing on this line can be set by hand,
which is what stops the header, the cast list, the cards, the chart and the exports
from disagreeing with each other.

**Stats** sit directly under the progression bar, because they are the numbers a
level moves. The heading names what the rule raises by itself — *Every level raises
Strength +1 on its own* — each row repeats that rate beside its value (`+1 a
level`), and a row that took placed points says how many (`+2 from levels`). A stat
the rule raises that the sheet has no row for gets a row of its own, marked as
missing, so the rule cannot quietly raise a number nobody records. The rows
otherwise behave as they always have: a name and a whole number, one row open at a
time, saved and audited individually.

**Level timeline** sits below the stats: the levels the curve wrote. A row carries
the level, the chapter whose income crossed it, the running total at that point and
the gains the rule handed out there. The row is written in the same transaction as
the income that paid for it, so a level never arrives without an entry behind it,
and deleting that entry takes the level and its gains back off the sheet. Levels
recorded before the curve existed stay on the timeline and act as a floor:
experience lifts the sheet above them, and taking experience away does not drop a
character below a level an author recorded. A **skill event** can still name the
level a skill changed at, and the skill keeps its own chapter, because it grows on
its own clock. The Chapters tab compares the timeline in reading order, so a level
that goes backwards, or a stat whose sheet value no longer matches what the level
recorded, shows up as a continuity warning that links to the holder's sheet.

**XP by chapter** is the ledger, and the only input progression has: one amount
per character per chapter, recorded on the sheet with that chapter. The sheet's
experience is these rows added up, so the header, the chart and the timeline all
answer the same question. A pair can hold only one amount, so recording the same
chapter twice is refused, and a trashed chapter keeps its row labelled as such
until the chapter is restored. Editing or deleting a row is immediate, and the
ledger travels in the JSON export and import. Purging a chapter for good keeps the
experience it paid for and clears the chapter: a level somebody earned cannot be
taken away by tidying the board.

**Level growth** sits between the timeline and the XP ledger and holds the curve:
what a level costs and what it hands out, kept for the story with a per-character
override. The cost is two numbers — XP for the second level, and a percentage more
for each level after it, where 0 keeps every level the same price. When the income
crosses a step the database writes the level, posts the rule's automatic stats to
the sheet as real stat rows, and leaves the points to place for the author, because
spending somebody's points for them is the part that would feel wrong. Those points
are counted under the progression bar — "5 of 6 points to place" — from the level
and the rule, so changing what a level hands out changes the tally rather than
leaving a number behind. Each stat row carries a **Place point** button while
points are left, and clicking it raises the stat and records where the point went
in one undoable step. Removing an override puts the character back on the story's
rule. A rule that hands out nothing is a valid choice rather than a missing value,
and a character with no income stays at level 1 however generous the rule is.

**Awards** are gains that are not level-ups: XP a chapter paid, or a stat point
handed over by a blessing, a hidden quest or a drop. Adding one applies it — XP
lands on that chapter's income, a stat point on the sheet — and deleting it takes
the same amount back out, so the record and the number cannot drift. An XP award
belongs to a chapter because income is kept per chapter; a stat award's chapter is
optional. Both travel in the JSON export and import.

**Progression chart and chapter state** — the top of the Characters tab draws a
power curve from the character's levels and the XP ledger: the chapters in
reading order along the x-axis. The y-axis switches between **Level**, **Total
XP**, **XP earned** and a chosen **stat**. Level, total XP and a stat draw
one step line per character, where only chapters with a recorded value get a
point and the last recorded value carries forward. **XP earned** instead draws
one bar per character in each chapter, because income belongs to that chapter and
is not a running total. Every cast member with a placed milestone starts on the
chart, and the XP-earned view includes a character with income even when they
have no milestone. The legend toggles each line or bar group on or off so two or
more characters can be compared without recolouring the others. A milestone or
income row with no live chapter is left off rather than guessed at. The chart is
read-only; **Edit** on the milestone or ledger row still changes the number or
snapshot.

Below it, **As of chapter** reads a snapshot rather than redrawing the chart by
hand: choose a chapter and the panel says each selected character's active level
and the skills they still held then. The database resolves the chapter's place in
the reading order, takes the last milestone at or before it, and follows skill
events up to the same point. A skill's rank is the latest upgrade or use recorded
by then, falling back to the skill row's own rank when no event carries one, and a
sacrifice removes it from that scene. A skill or milestone entered
without a chapter cannot be placed in a snapshot and is left out; an event entered
before its skill was learned is ignored as a contradiction rather than used to
rewrite later scenes. This is the same `character_state_at_chapter` query other
screens can use to ask what a character had in any chapter.

**Read sheet** on one of those rows opens the rest of that character's sheet as it
stood then: every stat with the chapter whose level-up recorded it, the skills
with the rank that applied, and each item gained by then that had not yet been
lost. A stat that has moved since is shown with today's value beside it, and one
that is not on the sheet now is marked rather than hidden. A stat the sheet holds but
no level-up has snapshotted is listed with no value instead of a zero — a missing
number is a gap in the ledger, not a real one. An item with no acquisition chapter
has no place in the story and is counted apart, and quantities are the sheet's own
because a count is not dated.

**Chapter workbench** — a chapter card on the Graph tab is drawn wider than the
other cards, because planning a scene happens on it rather than in another tab.
The face carries the chapter's own summary (the card's note), its roster, its
checklist and its **Progression & Events** ledger. **Cast** opens a small popover
on the card with the point of view as a select and one checkbox per live cast
member, so the roster is changed where it is read. **Done**, `Escape` or a press
off the card puts the popover away, and the **?** beside it opens outside the
board's zoom transform, so the bubble stays under the button at every zoom level.
**+ Event** logs one scene event: who it happened to (the point of view by
default) and its kind — **+ XP**, **Learn Skill**, **Rank Up**, **Evolve**,
**Sacrifice** or **Acquire Item** — with the reason, skill name or detail line and
a quantity where one applies. The rows sit on the card in the order they were
logged, each with its icon, the character and the line: `⚡ +250 XP · Paid for a
name at the toll gate`. XP pays into the chapter's income, a learned skill and an
acquired item are written on the sheet and in the inventory through the same
commands the sheets use, and a rank-up, evolution or sacrifice is the scene's
record, because the sheet already holds the change. Every one of those writes is a
named history step: **Undo** takes the event off the card and removes the award,
skill or item it wrote, reopens a ticked objective, or removes an added name.

**Chapter cast badges** — a chapter card names everyone present in that chapter:
the point-of-view character and every cast member ticked as present, from the
card's own **Cast** popover or from the same picker on the Chapters tab. There is
no single linked character on a chapter: that link was folded into cast rows in
schema v31, so the roster has one source. Each name gets a compact level badge
from the chapter snapshot, so "Rook (Lv 12)" is the level Rook had when the story
reached that chapter, not the level on the sheet today. Hovering or focusing a
badge lists that character's active skills and their ranks; clicking it opens the
character sheet as of that chapter. A character with no level yet keeps the name
badge without one, and a chapter with nobody in it says so rather than hiding the
roster. The badges are `nodrag nopan` buttons, so opening one does not drag the
card or pan the board. Every chapter's cast is read in one story-wide request
rather than one request per card, and the request is repeated when the milestones,
skills, point of view or cast rows change.

**Chapter objectives** — each chapter has a short checklist of lines it should
hit, stored one row per line in `chapter_tasks` (schema v32) with a `done` flag and
a `position`. The card lists them in the order they were written, ticks them in
place and drops one with **×**; **Add** or `Enter` writes a new line. Rows hang off
the chapter node, so a purged chapter takes its checklist with it, and they travel
in the JSON export under `chapter_tasks` while older files without the table still
import.

**Skills** — a cast member's skills are rows of their own rather than attributes
called "Skill": a name, an optional rank and effect in the author's own words,
and the chapter it was learned in. Each row can also name the `skill` card it
belongs to. **Add skill** takes the name, rank, effect, chapter and card, and
**Edit** changes any of them in place; a blank rank, effect, chapter or card
stores nothing rather than an empty string, and two skills of one character
cannot share a name. Skills are listed alphabetically on the sheet and are
saved, deleted and audited individually, so changing a rank is one history
entry that names the old and new rank. The chapter and card are links; if a
chapter is purged, the skill keeps its name, rank and effect and the missing
link is cleared instead of pointing at a row that no longer exists
(trashing it alone leaves the link in place, and an unrelated edit does not
force the author to re-pick it). A `skill` card on the board names the cast
members who have it, with each one's rank and the chapter it was learned in, and
says so when nobody has it yet. Selecting the card opens its holders in the
inspector, with an **Add holder** form: the card's saved name and notes become
the new row's name and effect, while rank and chapter are filled in for that
holder. The character picker leaves out anyone who already holds the card, and a
card with unsaved label or note edits asks for a save before it will add one.
Saving the card's label or notes updates every linked skill row to the same name
and effect, while each holder's rank and chapter stay as they are; if the new
name would collide with another skill on a holder's sheet, the save is refused
and both the card and its holders are left unchanged. Drawing a connection from
the card to a character card is the same write without the form: that character
becomes a holder of the same card, the line says `skill`, and Undo takes the line
and the sheet row back in one step. A second line between the same card and the
same character is refused with the reason rather than making a duplicate, and
deleting the line asks first, then takes the skill off that sheet and removes the
connection together as one undoable step. Deleting the skill from the sheet is
the same pair of writes the other way round: the line that drew it goes with the
row, and one Undo puts both back, along with the skill's events and tree links,
which the database cascades with the row. A card can also be placed with no holder at
all — **No holder yet** in the owner field — and characters join it later by
connecting their cards or from the card's **Add holder** form. Skills travel in the JSON export, the story
bible and an import with their chapter and card remapped like every other
reference, and they appear in the Audit tab under **Skills**. A skill's name, rank
and effect are revertible from the history; its chapter and card links are
recorded by name and are not, for the same reason a POV link is not.

Each skill also keeps its changes as **events**: an upgrade, a use or a sacrifice,
each with the chapter it happened in and an optional rank. The sheet lists them
under the skill in reading order, so a rank gained in one chapter and used in an
earlier one is visible as a contradiction rather than buried in a note. Events are
saved, edited and audited individually; a sacrifice drops its rank, because the
skill is no longer held. Skills, milestones, XP income and events travel in the
JSON export and an import with their skill and chapter links remapped, and older
files without the new tables still import.

**Skill trees** (schema v23) record which earlier skill a later one grew out of,
mutated from, branched away from or fused with. A link names a parent skill, a
child skill and one of four kinds — **upgrade**, **fusion**, **mutation** or
**branch** — plus the chapter it happened in, the parent rank it required in the
author's own words, and optional notes. Both ends must be live skills of the same
story, a skill cannot evolve into itself, and a link that would close a loop
directly or through a chain is refused. The **Skill trees** view on the Characters
tab draws the cast's skills in tiers: solid blue arrows for upgrades, golden ones
for fusions, dashed purple for mutations and dashed teal for branches, with a
legend, a character filter and a detail panel. Clicking a skill lists its
prerequisites and outcomes and offers **Add prerequisite** or **Add outcome**;
clicking a line shows its chapter, required rank and notes with **Delete link**.
The link form says which loop it would close while the other end is being
chosen — it walks the links forward from the skill that would become the child
and names the chain, such as *Ember → Flame → Ember*, and **Add link** stays
disabled until a later skill is picked. The chain is drawn on the tree too: its
skills take a red edge and background, and the links between them turn red and
dash-drawn, so the warning points at the picture and not only at the panel. A loop
the database alone can see, because another window recorded a link this board has
not read, still comes back as a refusal in the same panel.
The character filter follows the tree outwards, so a fusion can pull another
cast member's skill into view. On a sheet, each skill card names what it
**Requires** and what it **Evolves into**. Deleting a skill deletes its links;
purging a chapter clears the link's chapter but leaves the evolution. Evolution
links travel in the JSON export and an import with both skill ends and the
chapter remapped, and a file carrying a loop is refused rather than half
imported. The continuity panel flags a child skill that appears before its
parent was learned, a fusion unlocked before the parent reached the required rank
(a rank is compared as the same words), and a link whose parent or child is now
in the trash.

**Inventory and currency** — a cast member's belongings are rows of their own
rather than attributes called "Item": a name, an optional rarity and effect in
the author's own words, a quantity, the chapter it was acquired in, and the
chapter it was lost in. Each item can also name the `item` card it belongs to.
**Add item** takes all of those, and **Edit** changes any of them in place; a
blank rarity, effect, chapter, lost chapter or card stores nothing, two items of
one character cannot share a name, and a quantity is a whole number from zero up.
Currency is a separate named ledger — gold, credits, mana crystals — with an
amount and no exchange rate, so nothing is converted or added across names. Items and currencies are listed
alphabetically on the sheet and are saved, deleted and audited individually, so
changing a count is one history entry with the old and new number. The acquired
chapter, lost chapter and card are links; purging one clears the link and keeps
the item, while trashing it alone leaves the link in place. An `item` card on the
board names who carries it, with the quantity, rarity, chapter and where it was
lost, and says so when nobody does. The Chapters tab's continuity panel warns
when a recorded loss contradicts the ledger — an item still carried, or lost in
an earlier chapter than the one it was acquired in — and links the chapter it
names. The chapter card on the Graph tab carries the short version of that
warning, with the full sentence in its tooltip; clicking it opens the holder's
sheet on the Characters tab with that cast member selected. Beside the warning,
**Mark returned** clears the recorded lost chapter through the same audited
update the sheet uses, so the contradiction goes away without leaving the board
and the item and its other links stay as they were. The notice that follows
offers **Undo**, and the same step is in the board's history, so a mistake can be
put back without opening the Audit tab. This is a ledger, not a game engine: no prices, weight or encumbrance
maths. Items and currencies travel in the JSON export, the story bible and an
import with their links remapped, and appear in the Audit tab under **Inventory**
and **Currency**. An item's name, rarity, effect and quantity and a currency's
name and amount are revertible from the history; an item's acquired chapter,
lost chapter and card links are recorded by name and are not, for the same reason
a POV link is not.

**Progression continuity** uses the same panel and the same chapter cards. A level
that drops in reading order is flagged unless that milestone is marked as a
penalty; a skill used before it was learned, a rank used before the upgrade that
reached it, and a skill used or upgraded after it was sacrificed are flagged too.
So is a skill tree that contradicts the reading order: a child skill appearing
before its parent was learned, a fusion placed before the parent reached the rank
it required, or a link pointing at a skill in the trash.
A stat is compared with the last value its level-ups recorded: the snapshot on the
latest level-up in reading order is the number the story says the sheet had, so a
sheet that reads differently is flagged with the chapter whose level-up set it, and
so is a recorded stat the sheet has since dropped. Only the latest snapshot counts,
and a stat the sheet holds that no level-up has recorded is left alone: the story
has not given it a number yet. Names are compared without their case or their extra
spaces, so `strength` typed in one level-up and `Strength` in the next are the one
stat, and a sheet that spells it its own way is read as the same row rather than a
lost one — the **Set to N** button then writes the row the sheet already holds,
which is the name a stat is stored under. A name the sheet does not have at all is
checked against the rows it does have, and when one is close enough to be the same
stat renamed (`STR` for `Strength`, or a typo) the warning names it as the likely
one instead of claiming the stat was dropped; that stays a hint, with no button,
because two names being one stat is the author's decision. A mismatch carries a
**Set to N** button, in the panel and on the chapter card, that writes the recorded
value through the sheet's own stat command, so the history records who changed it;
the correction is one undoable step, and the notice that follows offers **Undo** for
a moment.
XP income is compared with every total-XP milestone as well: the ledger through
that chapter must add up to the recorded total, and both a shortfall and an excess
are named with the difference. The same warning carries a **Sync to N XP** button,
both in the Continuity panel and on the chapter card, that records the ledger's sum
on that milestone through the ordinary edit command, so the history says who
changed it; the correction is one undoable step, and the notice that follows
offers **Undo** for a moment. A character with no income rows
is left alone, so a story that only used totals is not warned about before it
starts a ledger. Each warning names the character and the chapters involved, and
clicking the character switches to Characters, selects that person, scrolls to the
relevant milestone or skill event and opens that entry for editing. The badges on the graph use ordinary buttons
with `nodrag` and `nopan`, so opening one never pans the board or moves a card.

**Relations and factions** live on the character's sheet (schema v20). A relation
joins two cast members with a free-text kind — **ally**, **rival**, **mentor**,
**family** and **owes** are suggestions, not limits — an optional note, and the
chapters it began and ended in. Symmetric kinds are stored in one direction, so an
alliance cannot be recorded twice from opposite sides, and the other end is fixed
once the relation exists rather than being silently rewritten. A **faction
standing** names the faction card, the place held there in the author's words, and
the chapter it began in, with an optional end. Every field change is audited, both
ledgers travel in the JSON export and the story bible, and a standing survives its
faction card being trashed — only a purge clears the link.

**The Relations view** is the second mode of the Characters tab: cast members on a
ring, faction hubs in the middle, and every bond drawn with its kind's colour and
line shape (ally solid green, rival dashed red, mentor amber with an arrow, family
dotted violet, owes dashed grey). Clicking a name focuses that person and dims
everyone else; clicking a line opens that relation or standing in its sheet
editor. Continuity names a relation that points at a cast member in the trash, a
standing whose faction card is in the trash, an arc that ends before it begins, and
two standings held in one faction at the same time; each warning opens the exact
row it names.

**Quests and contracts** (schema v21) live on their own tab. A quest has a title, a
required acceptance chapter, an optional ending chapter, a free-text status
(`active`, `completed`, `failed` and `abandoned` are suggestions), an optional
cast giver and faction card, an objectives description and private notes. Its
**rewards** are child rows: XP, an item, a stat gain or a faction standing, each
with an optional character or faction target and the author's own amount or
wording. The chapters place the contract, so choosing an ending chapter marks the
quest **completed** and clearing it reopens the quest; the form refuses a status
that says a quest ended while no ending chapter is set. A faction card can be made
from the quest form or a standing form with **Add faction**, so a missing faction
never sends the author to the Graph tab. Every create, field change and delete is
audited; the **Quests** tab filters by status and opens one quest for editing at a
time. A quest shows as a
badge on both chapters it names — a diamond where it was accepted, a tick where it
ended — and clicking the badge opens it in the ledger. **Apply rewards to chapter
ledger** on a completed quest prefills numeric XP into each character's income row
and item payouts into their inventory for the ending chapter; stat gains and
standings are left for the sheet because they are written in your words, and an
XP row the character already has in that chapter is added to rather than
duplicated, with the previous and new totals named in the notice. Each reward
remembers when it last reached the ledger (schema v22), so **Apply new rewards**
pays only what is still unpaid and a bundle that has already gone in asks for
confirmation in the quest card first, since a repeat payout is almost never
wanted; that memory survives a restart and is cleared when the reward or the
quest's ending chapter changes. Quests and
rewards travel in the JSON export with every link remapped, and the story is
warned when a contract ends before it is accepted, when an active quest's giver or
faction is in the trash, or when a reward goes to somebody not in the ending
chapter's cast.

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
A step that writes two halves — a cast row with the line that drew it, a relation
with its line, a skill with its hold — either finishes or leaves neither behind:
if the second write is refused, the first is put back and the step stays in the
history, so a retry starts from where it did rather than from half a change.
A refusal does not only live in the notice that fades: the attempt, the reason
and the half that was put back are written into the story's history as `undo
refused`, `redo refused` or `rolled back`, so the Audit tab still says what was
tried and why it stopped after the banner has gone. Undoing the deletion of a
chapter also names how many connections went to the trash with it, because those
come back one at a time from the Trash rather than with the chapter.
The stack holds the last 50 actions of the open story and is emptied when another
story is opened or something is purged; inside a text field `Ctrl+Z` is left to
the text being typed.

**Keyboard reference** — the `?` button beside the current-user field, or the
`?` key on any tab, opens a list of every keyboard route, grouped by where it
works. The list is rendered from one table, and the tooltip that names a key
reads the same table, so the help cannot describe a shortcut that no longer
works. `?` is ignored while a field has focus (there it is a question mark), and
the list closes on `Esc`, its close button, or a click outside it.

**Help badges.** The places where a rule is easy to miss carry a small `?` beside
them: the canvas toolbar's connections (drag-to-spawn and relation linking), the
connection editor's relation type, the bond form's kinds, the sheet's skills
(one identity, every holder), the continuity panel and the loop a skill tree
refuses. A badge opens on hover, on keyboard focus and on a tap, is announced to
a screen reader through `aria-describedby`, and closes on `Esc`, on blur, or when
the pointer leaves. The bubble is placed in the window rather than inside the
panel it belongs to and is clamped to the margins, so a badge near an edge still
shows the whole sentence instead of a clipped one.

**Guide and the first-run card.** The header's *Guide* opens
[STORYBOARDING.md](STORYBOARDING.md) where it is, inside the app: the author's
walkthrough of plotting a story, from an empty shelf to an export, with the
seventeen pictures of this app it needs, its reference table, and a link to the
keyboard list at the foot. It is the same file the repository keeps, so there is
one guide and not a summary of one; the developer's [GUIDE.md](GUIDE.md) is the
document underneath it, and neither is a copy of the other. A first run offers the
three rules as a *Start here* card above the tab content, with *Open the guide* and
*Got it*. Dismissing it writes `litrpg.guide.dismissed` to local storage, so it does
not come back on the next launch; the Guide button stays, and the welcome card
never blocks the board.

**Audit log** — every change is recorded with the acting user, the field, and the
before/after values, and can be reviewed per story. The tab shows the newest changes
first, 50 at a time, and can be narrowed to stories, characters, stats, attributes,
nodes, skills, skill evolutions, inventory, currency, relations, standings, quests,
quest rewards, connections or the history itself. "Show older changes" pages further back and says how many are
still there, so a long history is browsable rather than silently truncated. See
[The audit model](#the-audit-model).

**Reverting an edit** — any field change in the history can be put back, and a
revert is itself recorded, so it can be reverted in turn. The tab says on each
button whether the revert is still possible — *Changed since*, *In trash*, *Gone*,
*Already back* — with the full reason in its tooltip, so that is learned before a
click rather than after a refusal. It only applies while the field still holds the
value that entry produced: if it changed again since, writing the older value
would quietly throw the newer edit away. Creations and deletions are not
revertible — the trash is what undoes those. Quest edits are recorded but not yet
revertible, and neither are links the history stores as labels (a chapter or card).

**Trash** — deleting a story, character, node or connection moves it here rather
than destroying it. Restoring puts it back exactly as it was: a character returns
with its stats and attributes, a node with the connections that went with it, a
story with everything that was live inside it. A chapter is the exception: its
cast rows were never deleted with it, and its connections wait in the trash until
each is restored on its own, so undoing a chapter deletion is one action rather
than a bundle of chapter, cast and lines. "Delete forever" is the only
irreversible action in the app, and it asks first.

**Trash retention** — the trash can be kept forever (the default) or cleared
automatically after 7, 30, 90 days or a year. The window is applied at launch and
immediately when shortened, and anything it removes is recorded as a `purge` by
`Trash retention` rather than looking like someone's deliberate click.

**Export** — writes a complete JSON snapshot of one story — characters, stats,
attributes, skills, inventory, currency, graph and full history — beside the
database, under
`exports/<story-slug>-<timestamp>.json`.

**Story bible** — writes a Markdown file beside the JSON exports,
`exports/<story-slug>-story-bible-<timestamp>.md`. It opens with the title and
logline, then the chapters in reading order, each with its arc, its day, its POV,
its words against the target and its notes — the chapter card's own notes as a
paragraph, then the chapter's notes as a bulleted list under **Notes**, keeping
line breaks inside a note; a one-line story total follows the chapter list, and a
**Timeline** section lists the chapters that have a day in time order with their
time label and POV. The cast comes next — level, rank and XP where they exist, the description,
then the stats, attributes, skills, currencies and inventory as a plain list (a
skill with its rank, effect and the chapter it was learned in; an item with its
rarity, quantity, effect, the chapter it was acquired in and the chapter it was
lost in) — followed by the other cards grouped by kind. Character cards are left out because the cast section already carries their
sheet. Headings are numbered and nothing is written in app jargon, so the file can
be pasted into whatever you draft in. **Copy bible** puts the same text on the
clipboard without writing a file, for pasting straight into a document; the
window declares only the clipboard write permission, not read.

**Import** — restores one of those snapshots as a **new** story. Every id is
remapped, so importing the same file twice gives two independent stories and
nothing that already exists is touched; a title collision becomes
`<title> (imported)`. Graph connections, attribute values, skills with their
chapter and card links, inventory with its acquired, lost and item-card links,
currencies, and the original history come across, and the restore is
all-or-nothing.

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
| `entity_type` | `story`, `character`, its stats, attributes, skills, skill events, level milestones, growth rules, awards, progress, inventory, currency, relations and faction standings, a `quest` or `quest_reward`, a `node`, `edge` or `chapter_cast` row, or `history` for a step the board could not finish |
| `entity_id` | The row that changed |
| `action` | `create`, `update`, `level_up`, `revert`, `soft_delete`, `restore`, `purge`, `undo_refused`, `redo_refused` or `step_rolled_back` |
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
- **A step that did not happen is recorded too.** An undo or redo the database
  refused writes `undo_refused` or `redo_refused` against `history`, with the
  attempt and the reason in `new_value`. A two-part step whose first half had to
  be put back writes `step_rolled_back` instead, so the rollback is the entry
  rather than a second refusal beside it. Neither has a field to put back, so
  their rows carry no Revert button.
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
- **Words revert; links are labels.** A character's, skill's, item's, relation's
  or standing's text can be put back from the history. A link to a chapter or a
  card cannot: the entry records the label it had, and turning a label back into
  an id would be a guess. Putting a relation's kind back also restores the fixed
  end order a symmetric bond is stored in, and is refused if the author has since
  recorded that bond again.
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

SQLite, versioned with `PRAGMA user_version` (currently `21`). Migrations run at
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
one is typed, which is different from a time that was cleared. Version 12 added
`character_skills`; an older story has none until one is added, and the table is
empty on upgrade rather than inferred from attributes called "Skill". Version 13
added `character_inventory` and `character_currency`; an older story starts with
neither, and nothing is inferred from attributes called "Item" or "Gold". Version
14 added `character_inventory.lost_chapter_id`; an existing item has no recorded
loss until one is chosen, which is different from an item known to be lost. Version
15 added `character_level_milestones` and `character_skill_events`; an older story
starts with neither, so its levels and skills are still recorded on the sheets but
have no chapter-by-chapter history until the author adds one. Version 16 added
`chapter_cast`, which starts empty: a chapter's point of view is a link on the
node, and the table holds the rest of the people added with **Cast**. Version 17 added `character_level_milestones.xp`, `stat_name` and
`stat_points`; an existing milestone has no snapshots until one is recorded,
which is different from a recorded value of zero. Version 18 added
`character_progress`; an older story starts with no income rows, and one row per
character/chapter can be added afterwards. Version 19 moved a level-up's stat
snapshot into `character_level_stat_changes`, so one level can carry several
stats, and copied each old snapshot over as a value-after row without inventing a
gain. Version 20 added `character_relations` and `faction_standings`; an older
story starts with neither, so its cast simply has no recorded bonds or faction
memberships until one is added. Version 21 added `quests` and `quest_rewards`; an
older story starts with no contracts, and nothing is inferred from cards of type
`quest` — those remain plain cards until a quest is recorded on the Quests tab.
Version 27 added `character_level_records` — one row per character per level — and
copied the timeline's rows into it under the same ids, writing both tables for a
while so no reader was ever left without an answer. Version 28 moved each level's
stat gains onto the record they belong to, and version 29 dropped the old timeline
table and re-pointed a skill event's optional link at the level itself. A level
recorded twice while the old table allowed it collapses into the single row its
level now has; nothing else about a story changes on the way over. Version 30
added `character_growth_points`, where the points a level hands out are placed.
Version 31 folded the one cast member a chapter card used to name into
`chapter_cast`: that link becomes a cast row, and the card keeps no roster of its
own, so a chapter's people come from its point of view and its cast list and
nowhere else.

| Table | Contents |
| --- | --- |
| `stories` | `id`, `title`, `description`, timestamps, `deleted_at` |
| `characters` | Belongs to a story; `name`, `description`, progression (`level`, `xp`, nullable `rank` and `xp_to_next`), `deleted_at` |
| `character_stats` | Belongs to a character; `stat_name`, integer `value`, `notes` |
| `character_attributes` | Belongs to a character; `attr_name`, text `value`, unique per character |
| `character_skills` | Belongs to a character; `name` (unique per character), nullable `rank` and `effect`, optional `chapter_id` and `node_id` links (cleared when that node is purged) |
| `character_level_records` | One row per level a character has: integer `level` (1 or higher), optional `chapter_id` link (cleared when the chapter is purged), `is_debuff` for an explicit penalty, optional `xp` snapshot, and `source` — `level` when the curve wrote it, `recorded` when the author placed it, which makes it a floor experience cannot take back. Unique on the character/level pair |
| `character_progress` | One chapter's XP income for a character; integer `xp_earned` (zero or higher), unique on the character/chapter pair, cascading when either side is purged |
| `character_skill_events` | Belongs to a skill; `kind` (`upgraded`, `used` or `sacrificed`), optional `chapter_id` link (cleared when purged), nullable `rank`, and optional `level_record_id` linking the change to the level it came with (cleared when that level is deleted) |
| `chapter_cast` | One row per additional cast member in a chapter, unique on the chapter/character pair and cascading when either is purged |
| `character_inventory` | Belongs to a character; `name` (unique per character), nullable `rarity` and `effect`, integer `quantity`, optional `chapter_id`, `lost_chapter_id` and `node_id` links (cleared when that node is purged) |
| `character_currency` | Belongs to a character; `name` (unique per character), integer `amount` |
| `character_relations` | Two cast members in one story; free-text `kind`, optional `note` and `since_chapter_id`/`until_chapter_id` links (cleared when the chapter is purged); unique on the ordered pair and kind |
| `faction_standings` | One character's place in a faction card; free-text `standing`, optional `note` and `until_chapter_id`, required `since_chapter_id` when created; the faction link is cleared when its card is purged |
| `quests` | Belongs to a story; `title`, free-text `status`, required `accepted_chapter_id`, optional `completed_chapter_id`, `giver_character_id` and `faction_node_id`, `description`, `notes`; purging the acceptance chapter takes the quest with it, while the other links are cleared |
| `quest_rewards` | Belongs to a quest; `reward_type` (`xp`, `item`, `stat` or `faction_standing`), optional `target_id` (a character, or a faction card for a standing) and free-text `amount_or_details`; cascades with its quest |
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

`characters`, `character_stats`, `character_attributes`, `character_skills`,
`character_level_records`, `character_level_stat_changes`, `character_progress`,
`character_skill_events`,
`character_inventory`, `character_currency`, `chapter_cast`, `character_relations`,
`faction_standings`, `quests` (with their rewards), `nodes` and `edges` all cascade from their parent, with
`PRAGMA foreign_keys = ON`. `audit_log`
deliberately has no foreign key, so history survives the deletion of what it
describes. It is indexed on `(story_id, changed_at)` and
`(entity_type, entity_id)`.

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
npm test                             # canvas, search, inspector, cast drag-and-drop, progression chart and chapter state, chapter-card cast badges, progression links, skills and inventory, chapters, POV, in-world days and times, export and clipboard, audit paging, reverts and the trash (vitest, jsdom)
cd src-tauri && cargo test -p litrpg-db   # database layer, in-memory SQLite
```

The frontend suite renders the real `App` with Tauri's `invoke` mocked, so it covers
the wiring the Rust tests cannot see: what the tab requests, what it does with a
page that arrives late, and what it says when a filter matches nothing.

### Architecture

- **`src/`** — React 19 + React Flow 11 single-window UI. Every database command
  goes through a typed function in `src/domains/<domain>/api.ts`: that module is
  the only place a command name, its arguments and the row it answers with are
  written, and `@tauri-apps/api/core`'s `invoke` is called nowhere else. The
  argument names are camelCase and Tauri maps them to the snake_case parameters
  of the Rust commands. `App.tsx` owns the story state, the handlers and the tab
  layout; the pieces that do not need all of it live beside it —
  `src/components/` for shared widgets (help bubble, suggestion field, view
  toggle), `src/domains/<domain>/` for the command module, its types and any
  hook of its own, the
  canvas card, the Graph tab's board with its cast rail, connection editor and
  inspector drawer, the audit tab with its row and labels, progression chart,
  relations map, skill tree and the sheet's skill section, the Chapters tab with
  its cast and note panels and the chapter logic behind it, the Quests tab with
  the ledger behind it, the Trash tab with its two lists and the window that
  empties them, the Characters tab's shell with the power curve and cast
  rail above its sheets plus the wrappers that switch to the relations map and
  the skill tree, and `src/lib/` for small formatting helpers. Where a
  tab reads state nothing else uses, its domain module keeps it: the audit tab
  holds its own history window, filter and revert notices, and is handed the
  story, the current user and a way to reload the rest of the app; the skill
  section holds the open row and its draft
  fields, and is handed the rows, the labelled chapter and card choices and the
  writes, each answering whether the row was written so the form closes only on
  a save that happened; the quest ledger holds its quest and reward drafts, its
  status filter and its apply notices, writes the story's quests back through
  the setter that owns them, and is handed the chapters, the faction cards, the
  cast, the continuity warnings and the two reloads a payout reaches; the trash
  tab holds both of its lists, which one is waiting on a permanent-delete
  confirmation, the retention window and its notices, reads them on arrival,
  and is handed the story list, the open story's cards and the history that a
  purge makes unsafe to undo into through three callbacks; the sheet
  shell draws the power curve, the cast rail and the selected header from props
  and takes the rest of the sheet as children, and each of those sections keeps
  its own open row and draft fields and hands the app what the form typed, with
  every write answering whether the row was written so a form closes only on a
  save that happened; the Graph tab works out for itself only
  which holders the selected skill card already has and which cast members could
  still learn it, because that list is shown nowhere else, and takes the drafts,
  the board, its handlers and the cast member's numbers as props, while which
  card or connection is open and the text its fields hold are kept by the canvas
  domain's `useCanvasDrafts`: the hook holds the label and notes per card, the
  half-written text remembered for the cards visited this session, and the rule
  that an open editor follows the stored row unless it holds typing the author
  has not saved, and it takes the board in so it can answer whether those fields
  have moved away from it. Opening a card, closing it, discarding a draft and
  the dirty flags all live there, so a save writes through the ordinary commands
  and then hands the row it wrote back to the editor; and the
  history domain is a hook rather than a tab, because what it holds belongs to
  the session rather than to a view: `useHistory` keeps the last few actions
  with a command for each direction, the cap on them, the counts the toolbar
  draws and the notice that fades on its own, and is handed the story whose
  board a step re-reads, the notices a walk makes stale, the error line and the
  entry a refusal writes into the audit log. A step is two closures calling the
  ordinary commands, so walking one is an audited change like any other, and a
  step that puts its own half back says so, so the failure that follows does not
  write a second entry about the same thing; the badge map
  the chapter cards draw and
  the grouping of those warnings are plain functions in `ledger.ts`, for the
  same reason as the chapter logic below;
  `chapters.ts` works out the reading order, the numbering
  issues, the word totals, the timeline order, the notes grouped by chapter and
  the cast badges as plain functions, so the tab and the canvas cards read the
  same answers, and the panel keeps only the row-reorder interaction, because a
  cast edge on the board, a continuity flag and the undo history all write the
  rest of what it shows.
- **`src-tauri/db`** — all SQL, models and migrations, in a crate of its own with
  no Tauri dependency, so its tests build without WebKitGTK or GTK. The connection
  is owned by a `Db` value managed as Tauri state. Every public method takes the lock
  **once** and passes `&Connection` down to helpers such as `log_audit`; helpers must
  never call back into a locking method, because `std::sync::Mutex` is not
  reentrant and that would deadlock.
- **`src-tauri/src/lib.rs`** — the 81 thin `#[tauri::command]` wrappers, the JSON
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
- **Only chapters have these fields.** POV, a day and a time belong to chapters.
  Reordering by drag needs a pointer — HTML5 drag and drop, which a touch screen
  does not drive — while the ↑/↓ buttons move a chapter everywhere. Deleting a
  chapter leaves its position empty until something is moved or **Renumber** is
  pressed; that is shown in the tab, not repaired silently.
- **A chapter's cast is a chapter-level list, not per-scene blocking.** It joins
  the chapter's POV with every character ticked in **Cast**, and the same list
  applies to the whole chapter. Every present character gets a badge, so a large
  party makes the card taller rather than hiding names behind a count. A chapter
  card itself names no cast member: dropping one on the card adds them to this
  list, and the drawer lists the roster instead of offering a second binding.
- **The story bible carries only what the app models.** The file and the clipboard
  hold the same Markdown: chapters with arcs, days, times, POV and counts, a timeline,
  the cast with their skills and inventory, and the other cards. Copying needs
  the clipboard write
  permission; if the platform refuses it, the error strip says so.
- **Word counts are typed, not measured.** There is no manuscript to count, so the
  total is the sum of the numbers entered; a chapter without a target contributes
  words to the total but nothing to the target, which is why the tab says how many
  chapters have one. A target is a per-chapter number, not a share of the story
  total.
- **Levels are calculated; the gains are recorded.** Experience is the ledger
  added up and the level is the story's curve applied to it, so neither is a
  number an author types and neither can drift from the other. What a level hands
  out is still the author's: the rule says how many points to place and which
  stats rise by themselves, the sheet tallies what is left, and a placed point is
  one undoable step against the stat it went on. The
  bar clamps at 100% when experience passes the step rather than inventing a
  second level. XP income and skill events are author-recorded, and income is only
  reconciled against a recorded total for a character who kept a ledger. The chart
  draws the recorded points and bars, not a line fitted through them. A character
  with no level yet has no line in the level, total-XP or stat views, and one with
  no income row has no bars in the XP-earned view; the "as of" panel likewise
  reports "No level recorded" rather than borrowing the sheet's current level. A
  deliberate level jump is
  drawn exactly where the author placed it.
- **Inventory has one recorded loss, not a chapter-by-chapter history.** An item
  can name the chapter it was lost in, but the panel only compares that chapter
  with the acquisition chapter and with the item's current count. Reacquiring it
  means clearing or changing the loss; there is no per-chapter ledger of who held
  what.
- **Undoing an edit needs the field to still hold what the edit left.** Deleting
  a story, character, node or connection moves it to the Trash tab, where it can
  be restored exactly or deleted for good, and any single recorded field can be
  put back from the Audit tab. That revert refuses once the field changed again,
  so undoing an old rename means undoing the newer ones first — the tab marks such
  an entry *Changed since* rather than offering a button that would be refused. Creations and
  purges cannot be reverted at all: the first is undone by deleting it, and the
  second has no row left to write to.
- **Undoing a skill's deletion needs what it pointed at to still exist.** A
  skill's events and evolution links cascade with the row, so the undo writes the
  skill, its history, those links and the canvas line that drew it back against a
  new row. If a chapter, a milestone or the skill at the other end of a link has
  been deleted for good in the meantime, the restore is refused and the step stays
  where it was, rather than leaving half of a sheet behind.
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
- **Unsaved drafts live in memory.** A half-written chapter, label or note
  survives switching nodes, closing the drawer and switching stories, but not
  restarting the app; closing the window asks first, and nothing is written to
  disk until Save is pressed.
- **Shortcuts are fixed, not rebindable.** What the reference lists is the whole
  set of keyboard routes; customising them is not supported.
- **Skill-tree ranks are compared as words.** A required rank is matched against
a recorded upgrade rank ignoring case, so “Rank 2” and “rank 2” are the same
while “Second rank” is not. A link with no chapter or no required rank cannot be
placed in the reading order, so it is never flagged on timing.
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
