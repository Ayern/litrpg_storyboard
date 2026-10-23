import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactFlow, {
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Connection,
  addEdge,
  Panel,
  Handle,
  Position,
} from 'reactflow';
import type { Edge, Node, NodeProps } from 'reactflow';
import 'reactflow/dist/style.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

interface Story {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

// One copy of the database, as the backups dialog lists it.
interface BackupInfo {
  file_name: string;
  created_at: string;
  size_bytes: number;
}

// Whether the history says one entry's earlier value can still be written back.
// Worked out by the database when the page is read, against the value the field
// holds now — so the tab can tell before it is clicked. Keep in step with
// `RevertState` in the database crate.
type RevertState =
  | 'available'
  | 'changed_since'
  | 'in_trash'
  | 'gone'
  | 'already_back';

interface AuditEntry {
  id: string;
  story_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  field_changed: string | null;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
  changed_at: string;
  // Absent when the entry has nothing to put back at all.
  revert_state?: RevertState | null;
  // What a click would be refused with, when it would be refused.
  revert_reason?: string | null;
}

interface AuditPage {
  entries: AuditEntry[];
  total: number;
}

// One deleted row. `kind` is what it was, `story_id` is the story it belonged to
// (its own id for a story), so the trash can tell a restore where to look.
interface DeletedItem {
  id: string;
  kind: string;
  label: string;
  story_id: string;
  deleted_at: string;
}

interface Character {
  id: string;
  story_id: string;
  name: string;
  description: string | null;
  // Progression, saved as its own fields. Optional here because a character from
  // a story written by an older build has no such fields until it is read again.
  level?: number;
  xp?: number;
  rank?: string | null;
  xp_to_next?: number | null;
  created_at: string;
  updated_at: string;
}

interface CharacterStat {
  id: string;
  character_id: string;
  stat_name: string;
  value: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface CharacterAttribute {
  id: string;
  character_id: string;
  attr_name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

// Simple type aliases for our custom node/edge data
type NodeData = {
  label: string;
  nodeType: string;
  content?: string;
  createdBy: string;
  // The cast member this node points at, stored as an id on the node itself.
  characterId?: string | null;
  // The linked cast member's name and numbers, put here when the canvas is
  // drawn so the card can show them without reading the database itself.
  characterName?: string | null;
  characterStats?: CharacterStat[];
  // The linked cast member's level, drawn before the numbers.
  characterLevel?: number | null;
  // Where a chapter sits in the reading order; null on every other kind.
  chapterSeq?: number | null;
  // A chapter's arc and the words written against a target, all optional.
  chapterArc?: string | null;
  chapterWords?: number | null;
  chapterTarget?: number | null;
  // The cast member the chapter is told from, kept as an id like the node's
  // own link, and the in-world day it happens on. Both optional.
  chapterPov?: string | null;
  chapterDay?: number | null;
  // When inside that day, in the author's own words: “Dusk”, “18:40”.
  chapterTime?: string | null;
};
type EdgeData = { label?: string; relationType?: string; createdBy: string };

// One advisory line in the continuity panel: its words, with every chapter it
// names as a part that opens that chapter when clicked.
type ContinuityPart = string | { id: string; text: string };

// We'll use ReactFlow's internal types but cast our data
const nodeTypes = ['chapter', 'idea', 'character', 'location', 'event', 'plot', 'misc'] as const;
type NodeType = typeof nodeTypes[number];

function isNodeType(value: string): value is NodeType {
  return (nodeTypes as readonly string[]).includes(value);
}

// How many numbers a card has room for before it starts counting.
const NODE_STAT_BADGES = 2;

// The search palette lists this many; the rest are still reachable by typing
// more of the name, and the hint says how many matched.
const SEARCH_RESULTS_SHOWN = 8;

// What the palette can find. A card is not the only thing worth searching for:
// the cast, the connections and the other boards are all destinations, and the
// kind is what the filter row narrows to.
type SearchKind = 'node' | 'cast' | 'link' | 'note' | 'story';

const searchKindFilters: {
  value: 'all' | SearchKind;
  label: string;
  noun: string;
  title: string;
}[] = [
  { value: 'all', label: 'All', noun: 'results', title: 'Show every kind of result' },
  { value: 'node', label: 'Nodes', noun: 'nodes', title: 'Show only cards on the boards' },
  { value: 'cast', label: 'Cast', noun: 'cast members', title: 'Show only characters in the cast lists' },
  { value: 'link', label: 'Links', noun: 'connections', title: 'Show only connections between cards' },
  { value: 'note', label: 'Notes', noun: 'notes', title: 'Show only notes kept with chapters' },
  { value: 'story', label: 'Stories', noun: 'stories', title: 'Show only other stories' },
];

// One row in the palette. It carries everything needed to arrive at the thing it
// names, because a result in another story is chosen before that story is open.
interface SearchResult {
  key: string;
  kind: SearchKind;
  storyId: string;
  storyTitle: string;
  targetId: string;
  label: string;
  detail: string | null;
  nodeType: string | null;
  characterName: string | null;
  // Where the viewport goes when this result is chosen.
  x: number;
  y: number;
  content: string | null;
  edgeLabel: string;
  edgeRelation: string;
  // A note is reached through the chapter that holds it, so the result carries
  // both the chapter and the text that found it.
  chapterId: string | null;
  chapterLabel: string | null;
  // 0 when the query matched the name the result is listed by, 1 when it only
  // matched what surrounds it. Name matches are listed first.
  rank: number;
}

// Another story's board, read when the palette opens so its nodes can be found
// without loading the story first.
interface IndexedNode {
  id: string;
  label: string;
  node_type: string;
  content: string | null;
  pos_x: number;
  pos_y: number;
  character_id: string | null;
}

interface IndexedEdge {
  id: string;
  source_id: string;
  target_id: string;
  label: string | null;
  relation_type: string | null;
}

interface IndexedNote {
  id: string;
  chapter_id: string | null;
  text: string;
}

interface StoryIndex {
  nodes: IndexedNode[];
  characters: Character[];
  edges: IndexedEdge[];
  notes: IndexedNote[];
}

const searchResultTitles: Record<SearchKind, string> = {
  node: 'Open this node on its board',
  cast: "Open this character's sheet",
  link: "Open this connection's editor",
  note: "Open this chapter's notes",
  story: 'Open this story',
};

// The line a note is listed by: its first, with the rest left to the panel.
function noteFirstLine(text: string): string {
  return text.split('\n')[0].trim();
}

// What sits on the right of a result: whose character a card belongs to, both
// ends of a connection, or the story it lives in when that is not the open one.
function searchResultTag(result: SearchResult, openStoryId: string | undefined): string | null {
  const elsewhere = result.storyId !== openStoryId;

  if (result.kind === 'node') {
    return result.characterName ?? (elsewhere ? result.storyTitle : null);
  }

  if (result.kind === 'link' || result.kind === 'cast') {
    return elsewhere ? result.storyTitle : result.detail;
  }

  // A note says which chapter holds it, since that is where choosing it lands,
  // and names the story too when it is not the open one.
  if (result.kind === 'note') {
    const chapter = result.chapterLabel;

    if (!chapter) return elsewhere ? result.storyTitle : null;

    return elsewhere ? `${chapter} · ${result.storyTitle}` : chapter;
  }

  return null;
}

// The card a node is drawn as. Its type is both the colour of its edge and the
// word above the label, so a board reads at a glance instead of every note
// looking the same. A linked node also carries its cast member's numbers, so a
// board of characters shows who is ahead without opening anybody. The handles
// keep a node connectable from either side.
function GraphNode({ data, isConnectable }: NodeProps<NodeData>) {
  const kind = isNodeType(data.nodeType) ? data.nodeType : 'misc';
  const stats = data.characterStats ?? [];
  const shown = stats.slice(0, NODE_STAT_BADGES);
  const hidden = stats.length - shown.length;
  const linked = Boolean(data.characterId);
  const level = data.characterLevel ?? null;

  return (
    <div className={`graph-node ${kind}`}>
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
      <span className="graph-node-topline">
        <span className="graph-node-kind">{kind}</span>
        {kind === 'chapter' && data.chapterSeq != null && (
          <span className="graph-node-chapter" title="Place in the reading order">
            Ch. {data.chapterSeq}
          </span>
        )}
      </span>
      <span className="graph-node-label">{data.label}</span>
      {linked && (
        <span
          className="graph-node-cast"
          title={
            level !== null || stats.length > 0
              ? [
                  level !== null ? `Level ${level}` : null,
                  ...stats.map(stat => `${stat.stat_name} ${stat.value}`),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : undefined
          }
        >
          {level !== null && (
            <span className="graph-node-level">Lv {level}</span>
          )}
          {data.characterName && data.characterName !== data.label && (
            <span className="graph-node-cast-name">{data.characterName}</span>
          )}
          {shown.map(stat => (
            <span className="graph-node-stat" key={stat.id}>
              {stat.stat_name} {stat.value}
            </span>
          ))}
          {hidden > 0 && <span className="graph-node-stat more">+{hidden}</span>}
          {stats.length === 0 && (
            <span className="graph-node-cast-empty">
              {data.characterName ? 'no stats yet' : 'cast member in the trash'}
            </span>
          )}
        </span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
    </div>
  );
}

// Defined once: React Flow re-creates every node when this object changes.
const flowNodeTypes = { default: GraphNode };

// How many actions this session's undo stack keeps. The audit tab is the
// permanent record; this is only the last few steps, so it is capped and never
// written to disk.
const UNDO_LIMIT = 50;

// One recorded action, with the commands that walk it backwards and forwards.
// The closures call the ordinary commands, so an undo is an audited change like
// any other rather than a quiet rewrite of the database.
interface UndoStep {
  label: string;
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
}

// A database node row as React Flow wants it. One mapping, used by the story
// load and by the refresh after an undo, so the two cannot drift.
function toFlowNode(row: any): Node<NodeData> {
  return {
    id: row.id,
    type: 'default',
    position: { x: row.pos_x, y: row.pos_y },
    data: {
      label: row.label,
      nodeType: row.node_type,
      content: row.content,
      createdBy: row.created_by,
      characterId: row.character_id ?? null,
      characterLevel: null,
      chapterSeq: row.chapter_seq ?? null,
      chapterArc: row.chapter_arc ?? null,
      chapterWords: row.chapter_words ?? null,
      chapterTarget: row.chapter_target ?? null,
      chapterPov: row.chapter_pov ?? null,
      chapterDay: row.chapter_day ?? null,
      chapterTime: row.chapter_time ?? null,
    },
  };
}

// A note kept with a chapter. It is stored as a node, but the row shows only
// what a note needs: its text and the chapter it hangs under.
interface ChapterNote {
  id: string;
  chapterId: string;
  text: string;
}

function toChapterNote(row: any): ChapterNote {
  return {
    id: row.id,
    chapterId: row.parent_node_id ?? '',
    text: row.content ?? '',
  };
}

// Plain digits with thousands separators, so a story total reads at a glance.
function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

// What a chapter row says about its words. A target without a count reads as
// zero of that target rather than hiding the target.
function formatChapterWords(
  words: number | null | undefined,
  target: number | null | undefined
): string {
  if (words == null && target == null) return 'No word count';
  if (target == null) return `${formatCount(words ?? 0)} words`;

  return `${formatCount(words ?? 0)} / ${formatCount(target)} words`;
}

// The canvas shows one string for a connection, but the two fields stay separate
// in `data` so the editor can tell a label from a relation type.
function toFlowEdge(row: any): Edge<EdgeData> {
  return {
    id: row.id,
    source: row.source_id,
    target: row.target_id,
    label: row.label || row.relation_type || '',
    data: {
      label: row.label ?? undefined,
      relationType: row.relation_type ?? undefined,
      createdBy: row.created_by,
    },
  };
}

const USER_KEY = 'litrpg.currentUser';

// The key labels the app shows. The help list and any tooltip that names a key
// both read from here, so the two cannot describe one route differently.
const shortcutKeys = {
  help: '?',
  search: 'Ctrl+F',
  choose: '↑ ↓',
  enter: 'Enter',
  escape: 'Esc',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
} as const;

// Every keyboard route the app actually has, written once. The overlay renders
// this list rather than its own copy, so a key cannot be documented unless it
// works, and the wording is the same wherever the route is mentioned.
const shortcutGroups: {
  title: string;
  keys: { keys: string; action: string }[];
}[] = [
  {
    title: 'Anywhere',
    keys: [
      { keys: shortcutKeys.help, action: 'Show or hide this list' },
      { keys: shortcutKeys.escape, action: 'Close this list' },
    ],
  },
  {
    title: 'Search',
    keys: [
      {
        keys: shortcutKeys.search,
        action: 'Open the search palette (Graph and Chapters tabs)',
      },
      { keys: shortcutKeys.choose, action: 'Move through the results' },
      { keys: shortcutKeys.enter, action: 'Go to the chosen result' },
      { keys: shortcutKeys.escape, action: 'Close the palette' },
    ],
  },
  {
    title: 'Undo and redo',
    keys: [
      { keys: shortcutKeys.undo, action: 'Undo the last recorded change' },
      { keys: shortcutKeys.redo, action: 'Redo the last undone change' },
    ],
  },
  {
    title: 'Graph toolbar',
    keys: [
      {
        keys: shortcutKeys.enter,
        action: 'Add the node whose label is being typed',
      },
    ],
  },
  {
    title: 'Node inspector',
    keys: [
      { keys: shortcutKeys.enter, action: 'Save the label and notes' },
      {
        keys: shortcutKeys.escape,
        action: 'Close the inspector while the label is focused',
      },
    ],
  },
  {
    title: 'Connection editor',
    keys: [
      { keys: shortcutKeys.enter, action: 'Save the label and relation' },
      { keys: shortcutKeys.escape, action: 'Close without saving' },
    ],
  },
  {
    title: 'Story list',
    keys: [
      { keys: shortcutKeys.enter, action: 'Finish renaming a story' },
      { keys: shortcutKeys.escape, action: 'Cancel the rename' },
    ],
  },
  {
    title: 'Characters',
    keys: [
      { keys: shortcutKeys.enter, action: 'Add a character from the name fields' },
      { keys: shortcutKeys.enter, action: 'Save a name being edited' },
      { keys: shortcutKeys.escape, action: 'Cancel the name edit' },
    ],
  },
];

// The drag payload a cast card carries. A MIME type of our own keeps a dropped
// file or a link from being mistaken for a cast member.
const CAST_DRAG_TYPE = 'application/x-litrpg-character';

// One stat list per character, from the story-wide read.
function statsByCharacter(stats: CharacterStat[]): Record<string, CharacterStat[]> {
  const grouped: Record<string, CharacterStat[]> = {};

  for (const stat of stats) {
    if (!grouped[stat.character_id]) grouped[stat.character_id] = [];
    grouped[stat.character_id].push(stat);
  }

  // The badges are a short list of the same numbers everywhere, so the order is
  // decided here rather than by whatever order the read happened to return.
  for (const stat of Object.values(grouped)) {
    stat.sort((a, b) => a.stat_name.localeCompare(b.stat_name));
  }

  return grouped;
}

const trashKindLabels: Record<string, string> = {
  story: 'Story',
  character: 'Character',
  node: 'Graph node',
  edge: 'Graph connection',
};

const entityLabels: Record<string, string> = {
  story: 'Story',
  character: 'Character',
  character_stat: 'Character stat',
  character_attribute: 'Character attribute',
  node: 'Graph node',
  edge: 'Graph connection',
};

// One screenful of history at a time. The tab used to request everything up to a
// fixed 200 and then stop silently, so anything older was simply unreachable.
const AUDIT_PAGE_SIZE = 50;

// Mirrors the entity types the database records in `audit_log.entity_type`.
type AuditFilter = string | null;

const auditFilters: { value: AuditFilter; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'story', label: 'Story' },
  { value: 'character', label: 'Characters' },
  { value: 'character_stat', label: 'Stats' },
  { value: 'character_attribute', label: 'Attributes' },
  { value: 'node', label: 'Nodes' },
  { value: 'edge', label: 'Connections' },
];

// The badge reads as a word; the CSS class stays the raw action so the colours
// are keyed to what the database recorded.
const actionLabels: Record<string, string> = {
  soft_delete: 'trash',
  purge: 'delete forever',
  revert: 'revert',
  level_up: 'level up',
};

// Both lists the trash shows, in one round trip. Shared by the tab's first load
// and by anything that changes what is in the trash.
async function fetchTrash(storyId: string | null) {
  const [inStory, stories] = await Promise.all([
    storyId
      ? invoke<DeletedItem[]>('get_trash', { storyId })
      : Promise.resolve<DeletedItem[]>([]),
    invoke<DeletedItem[]>('get_trash', { storyId: null }),
  ]);

  return { inStory, stories };
}

// How long the trash is kept. `null` is forever, which is the default.
const retentionChoices: { value: string; label: string }[] = [
  { value: 'forever', label: 'Forever' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

// A few recorded field names are column names rather than words.
const fieldLabels: Record<string, string> = {
  xp: 'XP',
  xp_to_next: 'XP to next',
  chapter_pov: 'POV',
  chapter_day: 'in-world day',
  chapter_time: 'time of day',
};

// The chapter list's one-sentence warning. Positions start at 1, so a story
// whose middle chapter was deleted can have 1 and 3 while 2 is empty.
function describeChapterIssues(issues: {
  duplicates: number[];
  missing: number[];
  unnumbered: number;
}): string {
  const parts: string[] = [];

  if (issues.duplicates.length > 0) {
    parts.push(`position ${issues.duplicates.join(', ')} is used more than once`);
  }
  if (issues.missing.length > 0) {
    parts.push(`position ${issues.missing.join(', ')} is empty`);
  }
  if (issues.unnumbered > 0) {
    parts.push(
      `${issues.unnumbered} chapter${issues.unnumbered === 1 ? '' : 's'} ${
        issues.unnumbered === 1 ? 'has' : 'have'
      } no position`
    );
  }

  return `The reading order needs attention: ${parts.join('; ')}.`;
}

// A chapter's time is free text, so comparing two of them means reading the
// label as a clock first: “18:40”, “6:40 pm”, or one of the day parts writers
// reach for, optionally qualified (“late evening”, “just before dawn”). A label
// that reads as neither — “after the fire” — gets no order at all and is left
// where reading order put it, rather than guessed at.
const DAY_PARTS: [RegExp, number][] = [
  [/\bmidnight\b/, 0],
  [/\bdawn\b|\bsunrise\b|\bfirst light\b/, 6 * 60],
  [/\bmorning\b/, 9 * 60],
  [/\bnoon\b|\bmidday\b/, 12 * 60],
  [/\bafternoon\b/, 14 * 60 + 30],
  [/\bdusk\b|\bsunset\b|\bevening\b/, 19 * 60],
  [/\bnight\b|\bnightfall\b|\bafter dark\b/, 21 * 60],
];

const DAY_PART_NUDGES: [RegExp, number][] = [
  [/\bearly\b|\bbefore\b/, -60],
  [/\blate\b|\bafter\b|\bdeep\b/, 60],
];

/** A label's place in the day, in minutes from midnight, or null when it does
 * not read as a time of day. */
function timeOfDay(label?: string | null): number | null {
  if (!label) return null;

  const text = label.trim().toLowerCase();

  const clock = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/);
  const hourOnly = text.match(/^(\d{1,2})\s*(am|pm)$/);

  if (clock || hourOnly) {
    const hour = Number((clock ?? hourOnly)?.[1]);
    const minute = clock ? Number(clock[2]) : 0;
    const meridiem = (clock?.[3] ?? hourOnly?.[2]) as 'am' | 'pm' | undefined;

    if (hour > (meridiem ? 12 : 23) || minute > 59) return null;

    // 12am is midnight and 12pm is noon; every other hour simply shifts.
    const wrapped = meridiem ? (hour % 12) + (meridiem === 'pm' ? 12 : 0) : hour;

    return wrapped * 60 + minute;
  }

  let best: { at: number; minutes: number } | null = null;

  for (const [pattern, minutes] of DAY_PARTS) {
    const hit = pattern.exec(text);

    if (hit && (best === null || hit.index < best.at)) {
      best = { at: hit.index, minutes };
    }
  }

  if (best === null) return null;

  const nudge = DAY_PART_NUDGES.reduce(
    (offset, [pattern, minutes]) => (pattern.test(text) ? offset + minutes : offset),
    0
  );

  // Clamped to the day so “late night” does not spill into tomorrow.
  return Math.min(23 * 60 + 59, Math.max(0, best.minutes + nudge));
}

function entityLabel(entry: AuditEntry): string {
  const base = entityLabels[entry.entity_type] ?? entry.entity_type;
  if (!entry.field_changed) return base;

  return `${base} (${fieldLabels[entry.field_changed] ?? entry.field_changed})`;
}

function formatWhen(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// What the button says when a revert is not on offer. The words name the reason
// in the space the action would take; the full sentence is in its tooltip.
const revertLabels: Record<RevertState, string> = {
  available: 'Revert',
  changed_since: 'Changed since',
  in_trash: 'In trash',
  gone: 'Gone',
  already_back: 'Already back',
};

function AuditChange({
  entry,
  onRevert,
  busy,
}: {
  entry: AuditEntry;
  onRevert: (entry: AuditEntry) => void;
  busy: string | null;
}) {
  const state = entry.revert_state ?? null;
  const blocked = state !== null && state !== 'available';

  // A disabled button keeps the action where it would be and says why it is not
  // on offer, so a reader learns that before clicking rather than after.
  const revertButton = state === null ? null : (
    <button
      className="audit-revert"
      aria-label={
        blocked
          ? `Revert ${entry.field_changed} — ${revertLabels[state].toLowerCase()}`
          : `Revert ${entry.field_changed}`
      }
      title={
        blocked
          ? entry.revert_reason ?? undefined
          : 'Put this field back to what it was before this change'
      }
      onClick={() => onRevert(entry)}
      disabled={blocked || busy !== null}
    >
      {busy === entry.id ? 'Reverting…' : revertLabels[state]}
    </button>
  );

  if (entry.action === 'update' || entry.action === 'revert') {
    return (
      <div className="audit-change">
        <span className="audit-old">{entry.old_value ?? 'nothing'}</span>
        <span className="audit-arrow">→</span>
        <span className="audit-new">{entry.new_value ?? 'nothing'}</span>
        {revertButton}
      </div>
    );
  }

  if (!entry.new_value) return null;

  return (
    <div className="audit-change">
      <span className="audit-new">{entry.new_value}</span>
      {revertButton}
    </div>
  );
}

function App() {
  const [stories, setStories] = useState<Story[]>([]);
  const [currentStory, setCurrentStory] = useState<Story | null>(null);
  const [currentUser, setCurrentUser] = useState<string>(() => {
    try {
      return localStorage.getItem(USER_KEY) ?? 'You';
    } catch {
      return 'You';
    }
  });

  // Attribution always uses a non-empty name, so a blank field can never put a
  // change into the history with nobody's name on it.
  const actor = currentUser.trim() || 'You';
  
  const [nodes, setNodes, onNodesChange] = useNodesState<NodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<EdgeData>([]);
  
  const [selectedTab, setSelectedTab] = useState<
    'graph' | 'chapters' | 'characters' | 'audit' | 'trash'
  >('graph');
  
  const [newStoryTitle, setNewStoryTitle] = useState('');
  const [newNodeLabel, setNewNodeLabel] = useState('');
  const [newNodeType, setNewNodeType] = useState<NodeType>('idea');

  // The chapter list's own controls.
  const [newChapterTitle, setNewChapterTitle] = useState('');
  const [chapterError, setChapterError] = useState<string | null>(null);
  const [chapterBusy, setChapterBusy] = useState(false);

  // The arc and word counts, edited one chapter at a time in the list.
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  // The chapter a continuity flag just opened, lit briefly so the eye can find
  // the row the scroll landed on.
  const [revealedChapterId, setRevealedChapterId] = useState<string | null>(null);
  const revealTimer = useRef<number | null>(null);
  // The question the open form is waiting on: opening another chapter while this
  // one has unsaved edits, closing the form, or navigating away from it — a tab,
  // a story, a search result. One state, so two questions can never be asked at
  // once.
  const [chapterFormPrompt, setChapterFormPrompt] = useState<
    | { kind: 'open'; id: string }
    | { kind: 'close' }
    | { kind: 'leave'; message: string; go: () => void }
    | null
  >(null);
  // The drafts the open form started with, so an untouched form is known to be
  // clean even when its values are not what the saved chapter holds.
  const chapterOpenedDrafts = useRef<string[] | null>(null);
  // Where focus goes when a question appears, so the keyboard is on the answer
  // rather than left in the field the question is about.
  const chapterKeepEditingRef = useRef<HTMLButtonElement | null>(null);
  const noteKeepEditingRef = useRef<HTMLButtonElement | null>(null);
  const quitKeepWorkingRef = useRef<HTMLButtonElement | null>(null);
  // Where the keyboard goes back to once a question is answered, so dismissing it
  // does not leave focus on a button that is about to disappear.
  const chapterArcInputRef = useRef<HTMLInputElement | null>(null);
  const noteEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const noteAddRef = useRef<HTMLTextAreaElement | null>(null);
  const [chapterArcDraft, setChapterArcDraft] = useState('');
  const [chapterWordsDraft, setChapterWordsDraft] = useState('');
  const [chapterTargetDraft, setChapterTargetDraft] = useState('');
  const [chapterPovDraft, setChapterPovDraft] = useState('');
  const [chapterDayDraft, setChapterDayDraft] = useState('');
  const [chapterTimeDraft, setChapterTimeDraft] = useState('');

  // The plain-text notes kept with each chapter, and the one panel that is open.
  const [chapterNotes, setChapterNotes] = useState<ChapterNote[]>([]);
  const [openNotesChapterId, setOpenNotesChapterId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  // The note a search result pointed at, marked for a moment after it is opened.
  const [matchedNoteId, setMatchedNoteId] = useState<string | null>(null);
  const noteHighlightRef = useRef<number | null>(null);
  // Closing the note panel or moving it to another chapter is a way to lose a
  // half-written note, so it asks first, in the panel where the typing is.
  const [notePrompt, setNotePrompt] = useState<{ message: string; go: () => void } | null>(
    null
  );
  // Closing the window is the last way to lose a draft, so it asks too.
  const [quitPrompt, setQuitPrompt] = useState(false);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeLabelDraft, setNodeLabelDraft] = useState('');
  const [nodeContentDraft, setNodeContentDraft] = useState('');

  // Unsaved label and notes, per node, for this session. Closing or switching
  // away no longer has to discard them: reopening the node offers the text back.
  const nodeDraftsRef = useRef<Record<string, { label: string; content: string }>>({});
  // Whether the drawer has been asked what to do with an unsaved edit.
  const [closePrompt, setClosePrompt] = useState(false);
  const [nodeEditError, setNodeEditError] = useState<string | null>(null);

  // The inspector keeps its own copy of the matched cast member's numbers, so
  // editing from the canvas never depends on what the Characters tab has
  // selected. One row at a time is open for editing, as on that tab.
  const [inspectorStats, setInspectorStats] = useState<CharacterStat[]>([]);
  const [inspectorAttributes, setInspectorAttributes] = useState<CharacterAttribute[]>([]);
  const [inspectorStatId, setInspectorStatId] = useState<string | null>(null);
  const [inspectorStatValue, setInspectorStatValue] = useState('');
  const [inspectorAttrId, setInspectorAttrId] = useState<string | null>(null);
  const [inspectorAttrValue, setInspectorAttrValue] = useState('');
  const [inspectorError, setInspectorError] = useState<string | null>(null);
  // A relink can leave a node named after the person it no longer points at.
  // The label is the author's, so this offers the rename instead of taking it.
  const [renameOffer, setRenameOffer] = useState<{
    nodeId: string;
    from: string;
    to: string;
  } | null>(null);

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [edgeLabelDraft, setEdgeLabelDraft] = useState('');
  const [edgeRelationDraft, setEdgeRelationDraft] = useState('');
  const [edgeEditError, setEdgeEditError] = useState<string | null>(null);

  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditFilter, setAuditFilter] = useState<AuditFilter>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [revertBusyId, setRevertBusyId] = useState<string | null>(null);
  const [revertNotice, setRevertNotice] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  // Read by the "show older" request when it returns, so a page fetched under one
  // filter is never appended to a list showing another.
  const auditFilterRef = useRef<AuditFilter>(null);

  const [renamingStoryId, setRenamingStoryId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteStoryId, setConfirmDeleteStoryId] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [characterStats, setCharacterStats] = useState<CharacterStat[]>([]);
  const [characterAttributes, setCharacterAttributes] = useState<CharacterAttribute[]>([]);

  // Every live cast member's stats, which is what the cards on the canvas show.
  // Kept here rather than fetched per card so one read covers the whole board.
  const [castStats, setCastStats] = useState<Record<string, CharacterStat[]>>({});
  // The cast card being dragged, used to show the canvas as a drop target.
  const [draggingCastId, setDraggingCastId] = useState<string | null>(null);
  // The node the card is hovering over: dropping there relinks it rather than
  // making a new node, so the target is marked before the drop.
  const [dropTargetNodeId, setDropTargetNodeId] = useState<string | null>(null);

  // The list of keyboard routes, opened with ? or the button beside the user
  // name. It is not tied to a tab, because most of the routes are not either.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // The search palette, opened with Ctrl+F on the Graph and Chapters tabs.
  // A pan asked for while the board was not on screen, applied when it mounts.
  const pendingPanRef = useRef<{ x: number; y: number } | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  // Which kind of result the list is narrowed to; "all" searches everything.
  const [searchKind, setSearchKind] = useState<'all' | SearchKind>('all');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // The other stories' boards, read once per story and kept for the session so a
  // search reaches them without opening them. The copy for a story is dropped
  // when it is closed, because edits made while it was open would make it stale.
  const [otherStoryIndex, setOtherStoryIndex] = useState<Record<string, StoryIndex>>({});
  const otherStoryIndexRef = useRef<Record<string, StoryIndex>>({});
  const lastStoryIdRef = useRef<string | null>(null);
  const [otherStoryLoading, setOtherStoryLoading] = useState(false);
  const [otherStoryError, setOtherStoryError] = useState<string | null>(null);

  // This session's actions, with a command for each direction. The stacks are
  // refs because they are read only when a key is pressed; the counts below are
  // what the toolbar draws.
  const undoStackRef = useRef<UndoStep[]>([]);
  const redoStackRef = useRef<UndoStep[]>([]);
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const dragStartRef = useRef<{ id: string; x: number; y: number } | null>(null);
  // Nodes React Flow is removing right now, so their connections are not
  // recorded as a separate deletion.
  const removedNodeIdsRef = useRef<Set<string>>(new Set());
  // Read by the refresh after an undo, which runs outside a render.
  const selectedNodeIdRef = useRef<string | null>(null);
  const selectedEdgeIdRef = useRef<string | null>(null);
  const nodeIsDirtyRef = useRef(false);
  const edgeIsDirtyRef = useRef(false);

  // React Flow's instance, for turning a drop's screen point into canvas space.
  const flowRef = useRef<any>(null);

  const [newAttributeName, setNewAttributeName] = useState('');
  const [newAttributeValue, setNewAttributeValue] = useState('');
  const [editingAttributeId, setEditingAttributeId] = useState<string | null>(null);
  const [attributeValueDraft, setAttributeValueDraft] = useState('');
  const [characterError, setCharacterError] = useState<string | null>(null);

  const [newCharacterName, setNewCharacterName] = useState('');
  const [newCharacterDescription, setNewCharacterDescription] = useState('');

  const [editingStatId, setEditingStatId] = useState<string | null>(null);
  const [statValueDraft, setStatValueDraft] = useState('');
  const [statNotesDraft, setStatNotesDraft] = useState('');

  const [newStatName, setNewStatName] = useState('');
  const [newStatValue, setNewStatValue] = useState('');

  const [editingCharacter, setEditingCharacter] = useState(false);
  const [characterNameDraft, setCharacterNameDraft] = useState('');
  const [characterDescriptionDraft, setCharacterDescriptionDraft] = useState('');
  const [confirmDeleteCharacter, setConfirmDeleteCharacter] = useState(false);

  // The progression form, open one character at a time.
  const [editingProgress, setEditingProgress] = useState(false);
  const [progressLevelDraft, setProgressLevelDraft] = useState('1');
  const [progressXpDraft, setProgressXpDraft] = useState('0');
  const [progressTargetDraft, setProgressTargetDraft] = useState('');
  const [progressRankDraft, setProgressRankDraft] = useState('');

  const [trash, setTrash] = useState<DeletedItem[]>([]);
  const [deletedStories, setDeletedStories] = useState<DeletedItem[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);
  const [trashNotice, setTrashNotice] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);

  // The launch copies beside the database, and the dialog that lists them.
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupsError, setBackupsError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoringFile, setRestoringFile] = useState<string | null>(null);
  // Kept apart from the undo notice: loading a story clears that one, and this
  // one is written just as the restored story is being loaded.
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  // Initialize DB and load stories
  useEffect(() => {
    const init = async () => {
      try {
        await invoke('initialize_database');
        const loadedStories: Story[] = await invoke('get_all_stories');
        setStories(loadedStories);
      } catch (e) {
        console.error('Failed to init DB or load stories:', e);
      }
    };
    init();
  }, []);

  const loadStory = useCallback(async (story: Story) => {
    setCurrentStory(story);

    // Undo is scoped to the story it was recorded in, so a switch starts clean.
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryDepth({ undo: 0, redo: 0 });
    setHistoryNotice(null);

    // A note panel belongs to the story it was opened in, so a switch closes it.
    setOpenNotesChapterId(null);
    setEditingNoteId(null);
    setNoteDraft('');
    setNoteError(null);
    setMatchedNoteId(null);

    try {
      const dbNodes: any[] = await invoke('get_graph_nodes', { storyId: story.id });
      const dbEdges: any[] = await invoke('get_graph_edges', { storyId: story.id });

      setNodes(dbNodes.map(toFlowNode));
      setEdges(dbEdges.map(toFlowEdge));

      // The cast rail and the cards' badges both read from here, so the cast and
      // its numbers are loaded with the graph rather than on another tab.
      const [cast, stats, notes] = await Promise.all([
        invoke<Character[]>('get_characters', { storyId: story.id }),
        invoke<CharacterStat[]>('get_story_character_stats', { storyId: story.id }),
        invoke<any[]>('get_chapter_notes', { storyId: story.id }),
      ]);
      setCharacters(cast);
      setCastStats(statsByCharacter(stats));
      setChapterNotes((notes ?? []).map(toChapterNote));

      // A node or connection from the previous story is no longer on the canvas.
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    } catch (e) {
      console.error('Failed to load story graph:', e);
    }
  }, [setNodes, setEdges]);

  // After an undo the board is read back rather than patched from memory: a
  // restored node brings its connections with it, and a move lives only in the
  // database. Open editors follow the stored values unless they hold unsaved
  // typing, which undo does not touch.
  const reloadStory = useCallback(
    async (storyId: string) => {
      const [dbNodes, dbEdges] = await Promise.all([
        invoke<any[]>('get_graph_nodes', { storyId }),
        invoke<any[]>('get_graph_edges', { storyId }),
      ]);

      setNodes(dbNodes.map(toFlowNode));
      setEdges(dbEdges.map(toFlowEdge));

      if (selectedNodeIdRef.current && !nodeIsDirtyRef.current) {
        const fresh = dbNodes.find(row => row.id === selectedNodeIdRef.current);
        if (fresh) {
          setNodeLabelDraft(fresh.label);
          setNodeContentDraft(fresh.content ?? '');
        }
      }

      if (selectedEdgeIdRef.current && !edgeIsDirtyRef.current) {
        const fresh = dbEdges.find(row => row.id === selectedEdgeIdRef.current);
        if (fresh) {
          setEdgeLabelDraft(fresh.label ?? '');
          setEdgeRelationDraft(fresh.relation_type ?? '');
        }
      }
    },
    [setNodes, setEdges]
  );

  const recordStep = useCallback((step: UndoStep) => {
    // A new action makes the old redo branch impossible, as in any editor.
    redoStackRef.current = [];
    undoStackRef.current = [...undoStackRef.current, step].slice(-UNDO_LIMIT);
    setHistoryDepth({ undo: undoStackRef.current.length, redo: 0 });
  }, []);

  const moveInHistory = useCallback(
    async (direction: 'undo' | 'redo') => {
      const source = direction === 'undo' ? undoStackRef : redoStackRef;
      const target = direction === 'undo' ? redoStackRef : undoStackRef;
      const step = source.current[source.current.length - 1];

      if (!step) return;

      removedNodeIdsRef.current = new Set();
      setActionError(null);

      try {
        await (direction === 'undo' ? step.undo() : step.redo());
      } catch (e) {
        // The step stays where it was, so the failed change can be retried.
        console.error(`Failed to ${direction}:`, e);
        setActionError(`Could not ${direction} ${step.label}: ${String(e)}`);
        return;
      }

      source.current = source.current.slice(0, -1);
      target.current = [...target.current, step];
      setHistoryDepth({
        undo: undoStackRef.current.length,
        redo: redoStackRef.current.length,
      });
      setHistoryNotice(`${direction === 'undo' ? 'Undid' : 'Redid'}: ${step.label}`);

      const storyId = lastStoryIdRef.current;
      if (!storyId) return;

      try {
        await reloadStory(storyId);
      } catch (e) {
        // The change itself went through; a failed refresh is reported, not
        // pretended away.
        console.error('Failed to reload the board after moving through history:', e);
        setActionError(`The change was made, but the board could not be reloaded: ${String(e)}`);
      }
    },
    [reloadStory]
  );

  const undoLast = useCallback(() => moveInHistory('undo'), [moveInHistory]);
  const redoLast = useCallback(() => moveInHistory('redo'), [moveInHistory]);

  // Load first story by default if none selected
  useEffect(() => {
    if (!currentStory && stories.length > 0) {
      loadStory(stories[0]);
    }
  }, [stories, currentStory, loadStory]);

  // Ctrl+F opens the search palette on the two tabs that show the story, so the
  // shortcut is not swallowed where the browser's find is fine.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // While a modal is up, the keys it owns are the only ones that act.
      if (
        (selectedTab !== 'graph' && selectedTab !== 'chapters') ||
        !currentStory ||
        shortcutsOpen ||
        backupsOpen ||
        quitPrompt
      ) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSearchOpen(true);
        setSearchIndex(0);
        setSearchKind('all');
        return;
      }

      if (event.key === 'Escape' && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
        setSearchTerm('');
        setSearchIndex(0);
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedTab, currentStory, searchOpen, shortcutsOpen, backupsOpen, quitPrompt]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // ? opens the shortcut list on any tab, but never while a field is being typed
  // in — there it is a question mark like any other.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The quit question owns the keyboard while it is up.
      if (quitPrompt) return;

      if (event.key === 'Escape' && shortcutsOpen) {
        event.preventDefault();
        setShortcutsOpen(false);
        return;
      }

      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ['input', 'textarea', 'select'].includes(target?.tagName?.toLowerCase() ?? '');

      if (typing) return;

      event.preventDefault();
      setShortcutsOpen(open => !open);
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcutsOpen, quitPrompt]);

  // Ctrl+Z and Ctrl+Shift+Z walk the recorded actions. Inside a field they are
  // left alone, because there they belong to the text being typed.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ['input', 'textarea', 'select'].includes(target?.tagName?.toLowerCase() ?? '');

      if (typing || shortcutsOpen || backupsOpen || quitPrompt) return;

      const key = event.key.toLowerCase();

      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        void undoLast();
        return;
      }

      if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        void redoLast();
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undoLast, redoLast, shortcutsOpen, backupsOpen, quitPrompt]);

  // The backups dialog is modal: Escape closes it, but not while a restore is
  // already running.
  useEffect(() => {
    if (!backupsOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || restoringFile) return;

      event.preventDefault();
      setBackupsOpen(false);
      setConfirmRestore(null);
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [backupsOpen, restoringFile]);

  // A notice about an undo is useful for a moment, then it is just stale text.
  useEffect(() => {
    if (!historyNotice) return;

    const timer = setTimeout(() => setHistoryNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [historyNotice]);

  useEffect(() => {
    if (!restoreNotice) return;

    const timer = setTimeout(() => setRestoreNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [restoreNotice]);

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
    selectedEdgeIdRef.current = selectedEdgeId;
  }, [selectedNodeId, selectedEdgeId]);

  // A story's board is kept for searching only while that story is closed. The
  // moment it is opened the screen becomes the truth, and when it is left the
  // cached copy is dropped so the next search reads it again.
  useEffect(() => {
    const nextId = currentStory?.id ?? null;
    const previousId = lastStoryIdRef.current;
    lastStoryIdRef.current = nextId;

    if (!previousId || previousId === nextId || !otherStoryIndexRef.current[previousId]) {
      return;
    }

    const next = { ...otherStoryIndexRef.current };
    delete next[previousId];
    otherStoryIndexRef.current = next;
    setOtherStoryIndex(next);
  }, [currentStory]);

  // The other stories are read when the palette opens, all at once, so typing
  // never waits on the database and the results cover every story.
  useEffect(() => {
    if (!searchOpen || !currentStory) return;

    const missing = stories.filter(
      story => story.id !== currentStory.id && !otherStoryIndexRef.current[story.id]
    );
    if (missing.length === 0) {
      // Everything is cached, so a read cancelled by an earlier close cannot
      // leave the palette saying it is still searching.
      setOtherStoryLoading(false);
      return;
    }

    let cancelled = false;
    setOtherStoryLoading(true);
    setOtherStoryError(null);

    Promise.all(
      missing.map(async story => {
        const [nodes, characters, edges, notes] = await Promise.all([
          invoke<IndexedNode[]>('get_graph_nodes', { storyId: story.id }),
          invoke<Character[]>('get_characters', { storyId: story.id }),
          invoke<IndexedEdge[]>('get_graph_edges', { storyId: story.id }),
          invoke<any[]>('get_chapter_notes', { storyId: story.id }),
        ]);

        return [
          story.id,
          {
            nodes,
            characters,
            edges,
            notes: (notes ?? []).map(note => ({
              id: note.id,
              chapter_id: note.parent_node_id ?? null,
              text: note.content ?? '',
            })),
          },
        ] as const;
      })
    )
      .then(entries => {
        if (cancelled) return;

        const next = { ...otherStoryIndexRef.current };
        entries.forEach(([id, index]) => {
          next[id] = index;
        });
        otherStoryIndexRef.current = next;
        setOtherStoryIndex(next);
      })
      .catch(error => {
        // A board that cannot be read is left out of the results rather than
        // failing the whole search; the footer says some stories were skipped.
        if (!cancelled) setOtherStoryError(String(error));
      })
      .finally(() => {
        if (!cancelled) setOtherStoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [searchOpen, stories, currentStory]);

  // History is fetched whenever the tab is opened, the story changes or the
  // filter changes, so returning to the tab always reflects the latest changes.
  useEffect(() => {
    auditFilterRef.current = auditFilter;
  }, [auditFilter]);

  useEffect(() => {
    if (selectedTab !== 'audit' || !currentStory) return;

    let cancelled = false;

    const loadAudit = async () => {
      setAuditLoading(true);
      setAuditError(null);

      try {
        const page: AuditPage = await invoke('get_audit_history', {
          storyId: currentStory.id,
          entityType: auditFilter,
          entityId: null,
          limit: AUDIT_PAGE_SIZE,
          offset: 0,
        });
        if (!cancelled) {
          setAuditEntries(page.entries);
          setAuditTotal(page.total);
        }
      } catch (e) {
        console.error('Failed to load audit history:', e);
        if (!cancelled) setAuditError(String(e));
      } finally {
        if (!cancelled) setAuditLoading(false);
      }
    };

    loadAudit();

    return () => {
      cancelled = true;
    };
  }, [selectedTab, currentStory, auditFilter]);

  // Older changes are appended rather than reloaded, so the list grows where the
  // reader is instead of jumping back to the newest entry.
  const loadMoreAudit = async () => {
    if (!currentStory) return;

    const filter = auditFilter;
    setAuditLoadingMore(true);
    setAuditError(null);

    try {
      const page: AuditPage = await invoke('get_audit_history', {
        storyId: currentStory.id,
        entityType: filter,
        entityId: null,
        limit: AUDIT_PAGE_SIZE,
        offset: auditEntries.length,
      });

      if (filter !== auditFilterRef.current) return;

      setAuditEntries(previous => [...previous, ...page.entries]);
      setAuditTotal(page.total);
    } catch (e) {
      console.error('Failed to load more audit history:', e);
      setAuditError(String(e));
    } finally {
      setAuditLoadingMore(false);
    }
  };

  // A revert changes what the other tabs show, so they are reloaded rather than
  // left displaying the value the history just put back.
  const refreshAfterRevert = async () => {
    if (!currentStory) return;

    await loadStory(currentStory);

    const loaded: Character[] = await invoke('get_characters', {
      storyId: currentStory.id,
    });
    setCharacters(loaded);

    if (selectedCharacterId) {
      const [stats, attributes] = await Promise.all([
        invoke<CharacterStat[]>('get_character_stats', {
          characterId: selectedCharacterId,
        }),
        invoke<CharacterAttribute[]>('get_character_attributes', {
          characterId: selectedCharacterId,
        }),
      ]);
      setCharacterStats(stats);
      setCharacterAttributes(attributes);
    }
  };

  // The window is refetched at the size the reader had reached, so a revert adds
  // its own entry without collapsing "show older changes" back to one page.
  const reloadAuditWindow = async () => {
    if (!currentStory) return;

    const page: AuditPage = await invoke('get_audit_history', {
      storyId: currentStory.id,
      entityType: auditFilter,
      entityId: null,
      limit: Math.min(Math.max(auditEntries.length, AUDIT_PAGE_SIZE), 500),
      offset: 0,
    });

    setAuditEntries(page.entries);
    setAuditTotal(page.total);
  };

  const revertChange = async (entry: AuditEntry) => {
    setRevertBusyId(entry.id);
    setRevertError(null);
    setRevertNotice(null);

    try {
      const changed: boolean = await invoke('revert_change', {
        entryId: entry.id,
        user: actor,
      });

      if (!changed) {
        setRevertNotice('Nothing to put back: that field already holds its earlier value.');
      } else {
        setRevertNotice(
          `Reverted ${entityLabel(entry)} to “${entry.old_value ?? 'nothing'}”.`
        );
      }

      try {
        await refreshAfterRevert();
        await reloadAuditWindow();
      } catch (e) {
        // The revert itself succeeded; a failed refresh must not be reported as one.
        console.error('Failed to refresh after a revert:', e);
      }
    } catch (e) {
      console.error('Failed to revert a change:', e);
      setRevertError(String(e));
    } finally {
      setRevertBusyId(null);
    }
  };

  // Remember who is using the app: an audit trail that resets everyone to
  // "You" after a restart is not attribution.
  useEffect(() => {
    try {
      localStorage.setItem(USER_KEY, currentUser);
    } catch (e) {
      console.warn('Could not persist the current user name:', e);
    }
  }, [currentUser]);

  // A stale "exported to ..." note is worse than none, so let it expire.
  useEffect(() => {
    if (!exportStatus) return;
    const timer = setTimeout(() => setExportStatus(null), 8000);
    return () => clearTimeout(timer);
  }, [exportStatus]);

  // A copied outline is a smaller event than a file, so its note is shorter.
  useEffect(() => {
    if (!copyNotice) return;
    const timer = setTimeout(() => setCopyNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [copyNotice]);

  // Characters are refreshed whenever the tab is opened or the story changes.
  useEffect(() => {
    if (selectedTab !== 'characters' || !currentStory) return;

    let cancelled = false;

    const loadCharacters = async () => {
      setCharacterError(null);

      try {
        const loaded: Character[] = await invoke('get_characters', {
          storyId: currentStory.id,
        });
        if (cancelled) return;

        setCharacters(loaded);
        // Keep the current pick if it still exists, otherwise fall back to the
        // first character so the panel is never empty for no reason.
        setSelectedCharacterId(previous =>
          previous && loaded.some(character => character.id === previous)
            ? previous
            : loaded[0]?.id ?? null
        );
      } catch (e) {
        console.error('Failed to load characters:', e);
        if (!cancelled) setCharacterError(String(e));
      }
    };

    loadCharacters();

    return () => {
      cancelled = true;
    };
  }, [selectedTab, currentStory]);

  // Stats follow whichever character is selected.
  useEffect(() => {
    if (!selectedCharacterId) {
      setCharacterStats([]);
      return;
    }

    let cancelled = false;

    const loadStats = async () => {
      try {
        const loaded: CharacterStat[] = await invoke('get_character_stats', {
          characterId: selectedCharacterId,
        });
        if (!cancelled) setCharacterStats(loaded);
      } catch (e) {
        console.error('Failed to load character stats:', e);
        if (!cancelled) setCharacterError(String(e));
      }
    };

    loadStats();

    return () => {
      cancelled = true;
    };
  }, [selectedCharacterId]);

  // Text attributes follow the selected character too.
  useEffect(() => {
    if (!selectedCharacterId) {
      setCharacterAttributes([]);
      return;
    }

    let cancelled = false;

    const loadAttributes = async () => {
      try {
        const loaded: CharacterAttribute[] = await invoke('get_character_attributes', {
          characterId: selectedCharacterId,
        });
        if (!cancelled) setCharacterAttributes(loaded);
      } catch (e) {
        console.error('Failed to load character attributes:', e);
        if (!cancelled) setCharacterError(String(e));
      }
    };

    loadAttributes();

    return () => {
      cancelled = true;
    };
  }, [selectedCharacterId]);

  // The trash is re-read every time the tab is opened, so it always reflects the
  // latest deletions — including ones made a moment ago from another tab.
  useEffect(() => {
    if (selectedTab !== 'trash') return;

    let cancelled = false;

    const loadTrash = async () => {
      setTrashLoading(true);
      setTrashError(null);

      try {
        const [lists, days] = await Promise.all([
          fetchTrash(currentStory?.id ?? null),
          invoke<number | null>('get_trash_retention'),
        ]);

        if (cancelled) return;
        setTrash(lists.inStory);
        setDeletedStories(lists.stories);
        setRetentionDays(days);
      } catch (e) {
        console.error('Failed to load the trash:', e);
        if (!cancelled) setTrashError(String(e));
      } finally {
        if (!cancelled) setTrashLoading(false);
      }
    };

    loadTrash();

    return () => {
      cancelled = true;
    };
  }, [selectedTab, currentStory]);

  // A restored item has to reappear where the user last saw it, so the sides of
  // the app that show it are reloaded rather than patched by hand.
  const restoreDeleted = async (item: DeletedItem) => {
    setConfirmPurgeId(null);
    setTrashError(null);
    setTrashNotice(null);

    try {
      await invoke('restore_deleted', { id: item.id, kind: item.kind, user: actor });

      if (item.kind === 'story') {
        const loadedStories: Story[] = await invoke('get_all_stories');
        setStories(loadedStories);
        setDeletedStories(previous => previous.filter(other => other.id !== item.id));
      } else {
        setTrash(previous => previous.filter(other => other.id !== item.id));

        if (currentStory) {
          await loadStory(currentStory);

          const loaded: Character[] = await invoke('get_characters', {
            storyId: currentStory.id,
          });
          setCharacters(loaded);
          setSelectedCharacterId(previous => {
            if (item.kind === 'character' && loaded.some(other => other.id === item.id)) {
              return item.id;
            }
            return previous && loaded.some(other => other.id === previous)
              ? previous
              : loaded[0]?.id ?? null;
          });
        }
      }

      setTrashNotice(`Restored ${trashKindLabels[item.kind] ?? item.kind} “${item.label}”.`);
    } catch (e) {
      console.error('Failed to restore:', e);
      setTrashError(String(e));
    }
  };

  // The one irreversible action in the app, so it stays behind a confirmation.
  const purgeDeleted = async (item: DeletedItem) => {
    setConfirmPurgeId(null);
    setTrashError(null);

    try {
      await invoke('purge_deleted', { id: item.id, kind: item.kind, user: actor });

      // Nothing can bring a purged row back, so earlier steps are no longer a
      // safe branch to undo into.
      undoStackRef.current = [];
      redoStackRef.current = [];
      setHistoryDepth({ undo: 0, redo: 0 });

      if (item.kind === 'story') {
        setDeletedStories(previous => previous.filter(other => other.id !== item.id));
      } else {
        setTrash(previous => previous.filter(other => other.id !== item.id));

        // Purging a cast member clears every node linked to it, so the graph is
        // re-read instead of being left pointing at a row that no longer exists.
        if (item.kind === 'character' && currentStory) {
          await loadStory(currentStory);
        }
      }
    } catch (e) {
      console.error('Failed to delete permanently:', e);
      setTrashError(String(e));
    }
  };

  // Shortening the window applies it straight away, so the effect of the choice
  // is visible instead of deferred to the next launch.
  const changeRetention = async (value: string) => {
    const days = value === 'forever' ? null : Number(value);

    setTrashError(null);
    setTrashNotice(null);

    try {
      const purged: number = await invoke('set_trash_retention', { days });
      setRetentionDays(days);

      if (purged > 0) {
        // Retention is a purge too: undoing past it could not restore what went.
        undoStackRef.current = [];
        redoStackRef.current = [];
        setHistoryDepth({ undo: 0, redo: 0 });

        const lists = await fetchTrash(currentStory?.id ?? null);
        setTrash(lists.inStory);
        setDeletedStories(lists.stories);

        setTrashNotice(
          `Removed ${purged} ${purged === 1 ? 'item' : 'items'} deleted more than ${days} ${
            days === 1 ? 'day' : 'days'
          } ago.`
        );
      }
    } catch (e) {
      console.error('Failed to change how long the trash is kept:', e);
      setTrashError(String(e));
    }
  };

  const renderTrashItem = (item: DeletedItem) => (
    <li key={item.id} className="trash-item">
      <span className={`trash-kind ${item.kind}`}>
        {trashKindLabels[item.kind] ?? item.kind}
      </span>
      <span className="trash-label">{item.label}</span>
      <span className="trash-when">deleted {formatWhen(item.deleted_at)}</span>

      {confirmPurgeId === item.id ? (
        <>
          <button
            className="trash-danger"
            title="Delete permanently — this cannot be undone"
            onClick={() => purgeDeleted(item)}
          >
            Yes, delete forever
          </button>
          <button title="Keep it in the trash" onClick={() => setConfirmPurgeId(null)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            title="Put it back exactly as it was"
            onClick={() => restoreDeleted(item)}
          >
            Restore
          </button>
          <button
            className="trash-danger"
            title="Delete permanently — this cannot be undone"
            onClick={() => setConfirmPurgeId(item.id)}
          >
            Delete forever
          </button>
        </>
      )}
    </li>
  );

  const createNewStory = async () => {
    if (!newStoryTitle.trim()) return;
    
    try {
      const story: Story = await invoke('create_new_story', {
        title: newStoryTitle.trim(),
        description: null,
        user: actor,
      });
      
      setStories(prev => [story, ...prev]);
      setNewStoryTitle('');
      setCurrentStory(story);
      // A new story has no graph, so drop the previous story's canvas — leaving
      // it up would let a node from the old story be edited from this one.
      setNodes([]);
      setEdges([]);
      setChapterNotes([]);
      setSelectedNodeId(null);
    } catch (e) {
      console.error('Failed to create story:', e);
    }
  };

  const addNewNode = async () => {
    if (!currentStory || !newNodeLabel.trim()) return;

    const position = { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 };

    try {
      const newDbNode: any = await invoke('create_graph_node', {
        storyId: currentStory.id,
        nodeType: newNodeType,
        label: newNodeLabel.trim(),
        content: null,
        posX: position.x,
        posY: position.y,
        createdBy: actor,
      });

      const flowNode: any = {
        id: newDbNode.id,
        type: 'default',
        position,
        data: {
          label: newDbNode.label,
          nodeType: newDbNode.node_type,
          content: newDbNode.content,
          createdBy: newDbNode.created_by,
          characterId: newDbNode.character_id ?? null,
          chapterSeq: newDbNode.chapter_seq ?? null,
          chapterArc: newDbNode.chapter_arc ?? null,
          chapterWords: newDbNode.chapter_words ?? null,
          chapterTarget: newDbNode.chapter_target ?? null,
          chapterPov: newDbNode.chapter_pov ?? null,
          chapterDay: newDbNode.chapter_day ?? null,
          chapterTime: newDbNode.chapter_time ?? null,
        },
      };

      setNodes(nds => [...nds, flowNode]);
      setNewNodeLabel('');

      recordStep({
        label: `Add “${newDbNode.label}”`,
        undo: () => invoke('delete_node', { id: newDbNode.id, user: actor }),
        redo: () => invoke('restore_deleted', { id: newDbNode.id, kind: 'node', user: actor }),
      });
    } catch (e) {
      console.error('Failed to create node:', e);
    }
  };

  // The live chapters, in reading order. One with no position yet sorts last by
  // name, so it is visible and can be given a place rather than hidden.
  const chapterNodes = useMemo(() => {
    const chapters = nodes.filter(node => node.data.nodeType === 'chapter');

    return [...chapters].sort((left, right) => {
      const leftSeq = left.data.chapterSeq ?? Number.MAX_SAFE_INTEGER;
      const rightSeq = right.data.chapterSeq ?? Number.MAX_SAFE_INTEGER;

      return leftSeq === rightSeq
        ? left.data.label.localeCompare(right.data.label)
        : leftSeq - rightSeq;
    });
  }, [nodes]);

  // Duplicated, missing or absent numbers. Reordering avoids all three, so this
  // only has something to say after a deletion or after an older import.
  const chapterIssues = useMemo(() => {
    const positions = chapterNodes
      .map(node => node.data.chapterSeq)
      .filter((sequence): sequence is number => sequence != null);

    const duplicates = [...new Set(
      positions.filter((sequence, index) => positions.indexOf(sequence) !== index)
    )].sort((left, right) => left - right);

    const missing: number[] = [];
    const highest = positions.length > 0 ? Math.max(...positions) : 0;
    for (let position = 1; position <= highest; position += 1) {
      if (!positions.includes(position)) missing.push(position);
    }

    const unnumbered = chapterNodes.filter(
      node => node.data.chapterSeq == null
    ).length;

    return { duplicates, missing, unnumbered };
  }, [chapterNodes]);

  // The story total: every count the author has entered, and the sum of the
  // targets that exist — a chapter without one contributes no target rather than
  // pretending its words were uncounted for.
  const chapterTotals = useMemo(() => {
    const words = chapterNodes.reduce(
      (sum, node) => sum + (node.data.chapterWords ?? 0),
      0
    );
    const targets = chapterNodes
      .map(node => node.data.chapterTarget)
      .filter((target): target is number => target != null);

    return {
      words,
      target: targets.length > 0 ? targets.reduce((sum, target) => sum + target, 0) : null,
      targeted: targets.length,
    };
  }, [chapterNodes]);

  const chapterWordsPercent =
    chapterTotals.target && chapterTotals.target > 0
      ? Math.min(100, Math.round((chapterTotals.words / chapterTotals.target) * 100))
      : 0;

  // A chapter's POV is stored as a cast id, so the list and the timeline resolve
  // it here instead of every copy of a chapter carrying the name.
  const castNames = useMemo(
    () => new Map(characters.map(character => [character.id, character.name])),
    [characters]
  );

  // Time order, which is not always reading order. A chapter without a day is
  // left off rather than quietly given one; the note above the list counts them.
  // The sort is stable, so chapters sharing a day keep their reading order.
  // The notes grouped by the chapter they belong to, so a row can show its count
  // without scanning the whole list.
  const notesByChapter = useMemo(() => {
    const grouped = new Map<string, ChapterNote[]>();

    for (const note of chapterNotes) {
      grouped.set(note.chapterId, [...(grouped.get(note.chapterId) ?? []), note]);
    }

    return grouped;
  }, [chapterNotes]);

  const noteCount = (chapterId: string) => notesByChapter.get(chapterId)?.length ?? 0;

  const chapterTimeline = useMemo(() => {
    return chapterNodes
      .filter(node => node.data.chapterDay != null)
      .sort((left, right) => {
        const day = (left.data.chapterDay ?? 0) - (right.data.chapterDay ?? 0);

        if (day !== 0) return day;

        // Inside a day, only labels that read as a time can be ordered. One that
        // cannot has no place in the day, so it waits after the ones that can,
        // keeping its reading order among the others the clock cannot read.
        const leftTime = timeOfDay(left.data.chapterTime);
        const rightTime = timeOfDay(right.data.chapterTime);

        if (leftTime == null) return rightTime == null ? 0 : 1;
        if (rightTime == null) return -1;

        return leftTime - rightTime;
      });
  }, [chapterNodes]);

  // Continuity is advisory: nothing here blocks a save. It names what looks
  // inconsistent — a chapter with no POV, a time with no day to place it on, a
  // day that goes backwards, a time that goes backwards inside a day, two
  // chapters at the same moment, or one cast member in two chapters on the same
  // day — and leaves the decision to the author. Every chapter it names is a
  // link that opens that chapter, so a flag leads to the thing to fix.
  const chapterContinuity = useMemo(() => {
    const warnings: ContinuityPart[][] = [];

    const chapterLink = (id: string, label: string, quoted = false): ContinuityPart => ({
      id,
      text: quoted ? `“${label}”` : label,
    });

    // The names in a grouped flag, comma-separated like the other counts.
    const commaList = (chapters: { id: string; label: string }[]): ContinuityPart[] =>
      chapters.flatMap((chapter, index) => [
        ...(index === 0 ? [] : [', ']),
        chapterLink(chapter.id, chapter.label),
      ]);

    // “One, Two and Three”, so a sentence reads as one.
    const andList = (chapters: { id: string; label: string }[]): ContinuityPart[] =>
      chapters.flatMap((chapter, index) => [
        ...(index === 0 ? [] : [index === chapters.length - 1 ? ' and ' : ', ']),
        chapterLink(chapter.id, chapter.label, true),
      ]);

    const withoutPov = chapterNodes.filter(node => !node.data.chapterPov);

    if (withoutPov.length > 0) {
      warnings.push([
        `${withoutPov.length} chapter${
          withoutPov.length === 1 ? ' has' : 's have'
        } no POV: `,
        ...commaList(withoutPov.map(node => ({ id: node.id, label: node.data.label }))),
        '.',
      ]);
    }

    // A time without a day is kept but cannot be placed: the timeline has
    // nothing to order the label against, so the author is told where to put it.
    const timeWithoutDay = chapterNodes.filter(
      node => node.data.chapterDay == null && (node.data.chapterTime ?? '').trim() !== ''
    );

    if (timeWithoutDay.length > 0) {
      warnings.push([
        `${timeWithoutDay.length} chapter${
          timeWithoutDay.length === 1 ? ' has' : 's have'
        } a time but no day: `,
        ...commaList(timeWithoutDay.map(node => ({ id: node.id, label: node.data.label }))),
        '.',
      ]);
    }

    // Reading order, with the chapters that are not placed in time skipped.
    const placed = chapterNodes.filter(node => node.data.chapterDay != null);

    for (let index = 1; index < placed.length; index += 1) {
      const before = placed[index - 1];
      const after = placed[index];

      if ((after.data.chapterDay ?? 0) < (before.data.chapterDay ?? 0)) {
        warnings.push([
          chapterLink(after.id, after.data.label, true),
          ` goes back to Day ${after.data.chapterDay} after `,
          chapterLink(before.id, before.data.label, true),
          ` on Day ${before.data.chapterDay}.`,
        ]);
        continue;
      }

      // Inside one day the same reading order should move forward through the
      // day too. Only labels that read as a time of day are compared; the author
      // may write “after the fire” and mean something no clock can check.
      if (before.data.chapterDay !== after.data.chapterDay) continue;

      const beforeTime = timeOfDay(before.data.chapterTime);
      const afterTime = timeOfDay(after.data.chapterTime);

      if (beforeTime == null || afterTime == null || afterTime >= beforeTime) {
        continue;
      }

      warnings.push([
        chapterLink(after.id, after.data.label, true),
        ` goes back to ${after.data.chapterTime} after `,
        chapterLink(before.id, before.data.label, true),
        ` at ${before.data.chapterTime} on Day ${after.data.chapterDay}.`,
      ]);
    }

    // Two chapters cannot happen at the same moment on the same day. Only labels
    // that read as a time of day can collide, so “after the fire” is left alone.
    const moments = new Map<
      string,
      { day: number; chapters: { id: string; label: string; time: string }[] }
    >();

    placed.forEach(node => {
      const minutes = timeOfDay(node.data.chapterTime);

      if (minutes == null) return;

      const key = `${node.data.chapterDay}::${minutes}`;
      const chapter = {
        id: node.id,
        label: node.data.label,
        time: (node.data.chapterTime ?? '').trim(),
      };
      const moment = moments.get(key);

      if (moment) {
        moment.chapters.push(chapter);
        return;
      }

      moments.set(key, { day: node.data.chapterDay ?? 0, chapters: [chapter] });
    });

    moments.forEach(moment => {
      if (moment.chapters.length < 2) return;

      // The same wording written twice is one moment said once; labels that only
      // mean the same time to a clock (“Dusk” and “7:00 pm”) are quoted apart.
      const writtenTheSame = moment.chapters.every(
        chapter => chapter.time.toLowerCase() === moment.chapters[0].time.toLowerCase()
      );

      if (writtenTheSame) {
        warnings.push([
          ...andList(moment.chapters),
          ` ${moment.chapters.length === 2 ? 'are both' : 'are all'} at ${
            moment.chapters[0].time
          } on Day ${moment.day}.`,
        ]);
        return;
      }

      const parts: ContinuityPart[] = [];

      moment.chapters.forEach((chapter, index) => {
        parts.push(
          ...(index === 0
            ? []
            : [index === moment.chapters.length - 1 ? ' and ' : ', '])
        );
        parts.push(chapterLink(chapter.id, chapter.label, true));
        parts.push(` at ${chapter.time}`);
      });

      parts.push(` happen at the same moment on Day ${moment.day}.`);

      warnings.push(parts);
    });

    // One cast member cannot be the point of view of two chapters on one day.
    const bookings = new Map<
      string,
      { pov: string; day: number; chapters: { id: string; label: string }[] }
    >();

    placed.forEach(node => {
      const pov = node.data.chapterPov;

      if (!pov) return;

      const key = `${pov}::${node.data.chapterDay}`;
      const booking = bookings.get(key);

      if (booking) {
        booking.chapters.push({ id: node.id, label: node.data.label });
        return;
      }

      bookings.set(key, {
        pov,
        day: node.data.chapterDay ?? 0,
        chapters: [{ id: node.id, label: node.data.label }],
      });
    });

    bookings.forEach(booking => {
      if (booking.chapters.length < 2) return;

      warnings.push([
        `${
          castNames.get(booking.pov) ?? 'A cast member in the trash'
        } is the POV of ${booking.chapters.length} chapters on Day ${booking.day}: `,
        ...commaList(booking.chapters),
        '.',
      ]);
    });

    return warnings;
  }, [chapterNodes, castNames]);

  const focusChapterRow = (chapterId: string) => {
    document
      .querySelector(`[data-chapter-id="${chapterId}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });

    setRevealedChapterId(chapterId);

    if (revealTimer.current != null) window.clearTimeout(revealTimer.current);

    revealTimer.current = window.setTimeout(() => {
      setRevealedChapterId(null);
      revealTimer.current = null;
    }, 1200);
  };

  // Whether the open form holds anything that has not been saved. Comparing with
  // the drafts it opened with, rather than with the stored chapter, means typing
  // a value and undoing it leaves the form clean.
  const chapterDraftIsDirty = () => {
    const opened = chapterOpenedDrafts.current;

    if (!opened) return false;

    return [
      chapterArcDraft,
      chapterWordsDraft,
      chapterTargetDraft,
      chapterPovDraft,
      chapterDayDraft,
      chapterTimeDraft,
    ].some((draft, index) => draft !== opened[index]);
  };

  // Opens a chapter's details. When another chapter's form has unsaved drafts the
  // switch waits for an answer instead of dropping them, which is what a flag or
  // another row's Edit button used to do silently. Answers whether the details
  // are now open on that chapter.
  const openChapterDetails = (node: { id: string; data: NodeData }) => {
    if (editingChapterId === node.id) return true;

    if (editingChapterId != null && chapterDraftIsDirty()) {
      setChapterError(null);
      setChapterFormPrompt({ kind: 'open', id: node.id });
      return false;
    }

    setChapterFormPrompt(null);
    startChapterEdit(node);
    return true;
  };

  // Answering a question returns the keyboard to the field it was about.
  const dismissChapterPrompt = () => {
    setChapterFormPrompt(null);
    chapterArcInputRef.current?.focus();
  };

  // Closing the form is the other way to lose a draft, so it asks the same
  // question when there is something to lose. A second Escape dismisses the
  // question, as it does for a note.
  const requestChapterClose = () => {
    if (chapterFormPrompt) {
      dismissChapterPrompt();
      return;
    }

    if (chapterDraftIsDirty()) {
      setChapterFormPrompt({ kind: 'close' });
      return;
    }

    setEditingChapterId(null);
  };

  // Leaving the form behind — another tab, another story, a search result — asks
  // the same question, then does what was asked.
  const requestChapterLeave = (message: string, go: () => void) => {
    if (chapterDraftIsDirty()) {
      setChapterFormPrompt({ kind: 'leave', message, go });
      return;
    }

    go();
  };

  const requestTab = (tab: typeof selectedTab) => {
    if (tab === selectedTab) return;

    // Only leaving the tab with the form is a question; coming back to it, or
    // moving between the other tabs, is not.
    if (selectedTab !== 'chapters') {
      setSelectedTab(tab);
      return;
    }

    requestChapterLeave('Leave Chapters and drop these changes?', () =>
      setSelectedTab(tab)
    );
  };

  const requestStory = (story: Story) => {
    if (story.id === currentStory?.id) {
      void loadStory(story);
      return;
    }

    const openStory = () => {
      setChapterFormPrompt(null);
      setNotePrompt(null);
      setEditingChapterId(null);
      void loadStory(story);
    };

    // A note draft lives in the notes panel, so its question is asked there. The
    // same answer drops a chapter edit too, if both were open.
    if (noteDraftIsDirty()) {
      setChapterFormPrompt(null);
      setNotePrompt({
        message: `Open “${story.title}” and drop these changes?`,
        go: openStory,
      });
      return;
    }

    requestChapterLeave(`Open “${story.title}” and drop these changes?`, openStory);
  };

  // A flag leads somewhere: the chapter it names opens its details, and the row
  // is brought into view and lit for a moment so the warning is answered where
  // it was raised.
  const revealChapter = (chapterId: string) => {
    const node = chapterNodes.find(candidate => candidate.id === chapterId);

    if (!node || !openChapterDetails(node)) return;

    focusChapterRow(chapterId);
  };

  // The answer to the prompt: drop the open drafts and go where the flag pointed.
  const discardChapterEdit = () => {
    const next =
      chapterFormPrompt?.kind === 'open'
        ? chapterNodes.find(candidate => candidate.id === chapterFormPrompt.id)
        : null;

    setChapterFormPrompt(null);

    if (!next) return;

    startChapterEdit(next);
    focusChapterRow(next.id);
  };

  // The same answer when the form was being closed: drop the drafts and close.
  const closeChapterForm = () => {
    setChapterFormPrompt(null);
    setEditingChapterId(null);
  };

  // The answer when the form was being left behind: drop the drafts, then go
  // where the author asked to go.
  const leaveChapterForm = () => {
    if (chapterFormPrompt?.kind !== 'leave') return;

    const go = chapterFormPrompt.go;

    setChapterFormPrompt(null);
    setEditingChapterId(null);
    go();
  };

  // A timer left behind by a flag must not reach into an unmounted panel.
  useEffect(
    () => () => {
      if (revealTimer.current != null) window.clearTimeout(revealTimer.current);
    },
    []
  );

  // Closing the note panel drops the question with it.
  useEffect(() => {
    if (openNotesChapterId == null) setNotePrompt(null);
  }, [openNotesChapterId]);

  // A question takes the keyboard with it: the safe answer is already focused, so
  // Enter keeps the work instead of discarding it.
  useEffect(() => {
    if (chapterFormPrompt) chapterKeepEditingRef.current?.focus();
  }, [chapterFormPrompt]);

  useEffect(() => {
    if (notePrompt) noteKeepEditingRef.current?.focus();
  }, [notePrompt]);

  useEffect(() => {
    if (quitPrompt) quitKeepWorkingRef.current?.focus();
  }, [quitPrompt]);

  // Closing the form drops the question with it.
  useEffect(() => {
    if (editingChapterId == null) setChapterFormPrompt(null);
  }, [editingChapterId]);

  const applyChapterOrder = async (orderedIds: string[]) => {
    if (!currentStory) return;

    const updated: any[] = await invoke('set_chapter_order', {
      storyId: currentStory.id,
      orderedIds,
      user: actor,
    });

    const byId = new Map<string, number | null>(
      updated.map(row => [row.id, row.chapter_seq ?? null])
    );

    setNodes(previous =>
      previous.map(node =>
        byId.has(node.id)
          ? {
              ...node,
              data: { ...node.data, chapterSeq: byId.get(node.id) ?? null },
            }
          : node
      )
    );
  };

  // One move at a time: the list is read back from the database, so a second
  // click before the first finishes would order the chapters from a stale list.
  const saveChapterOrder = async (orderedIds: string[], undoIds: string[] | null) => {
    if (!currentStory || chapterBusy) return;

    setChapterBusy(true);
    setChapterError(null);

    try {
      await applyChapterOrder(orderedIds);

      // Renumbering has no earlier order worth returning to: the numbers it
      // replaces were the problem.
      if (undoIds) {
        recordStep({
          label: 'Reorder chapters',
          undo: () => applyChapterOrder(undoIds),
          redo: () => applyChapterOrder(orderedIds),
        });
      }
    } catch (e) {
      console.error('Failed to reorder chapters:', e);
      setChapterError(`Could not reorder chapters: ${String(e)}`);
    } finally {
      setChapterBusy(false);
    }
  };

  const moveChapter = (id: string, delta: number) => {
    const order = chapterNodes.map(node => node.id);
    const from = order.indexOf(id);
    const to = from + delta;

    if (from < 0 || to < 0 || to >= order.length) return;

    const next = [...order];
    [next[from], next[to]] = [next[to], next[from]];
    void saveChapterOrder(next, order);
  };

  // The escape hatch for data that arrived numbered badly: number what is shown,
  // in the order it is shown.
  const renumberChapters = () => {
    void saveChapterOrder(
      chapterNodes.map(node => node.id),
      null
    );
  };

  const addChapter = async () => {
    if (!currentStory || !newChapterTitle.trim()) return;

    const position = { x: 120 + Math.random() * 360, y: 100 + Math.random() * 240 };

    setChapterBusy(true);
    setChapterError(null);

    try {
      const created: any = await invoke('create_graph_node', {
        storyId: currentStory.id,
        nodeType: 'chapter',
        label: newChapterTitle.trim(),
        content: null,
        posX: position.x,
        posY: position.y,
        createdBy: actor,
      });

      setNodes(previous => [...previous, toFlowNode(created)]);
      setNewChapterTitle('');

      recordStep({
        label: `Add “${created.label}”`,
        undo: () => invoke('delete_node', { id: created.id, user: actor }),
        redo: () => invoke('restore_deleted', { id: created.id, kind: 'node', user: actor }),
      });
    } catch (e) {
      console.error('Failed to add a chapter:', e);
      setChapterError(`Could not add a chapter: ${String(e)}`);
    } finally {
      setChapterBusy(false);
    }
  };

  const startChapterEdit = (node: { id: string; data: NodeData }) => {
    setChapterError(null);
    setEditingChapterId(node.id);

    const drafts = [
      node.data.chapterArc ?? '',
      node.data.chapterWords != null ? String(node.data.chapterWords) : '',
      node.data.chapterTarget != null ? String(node.data.chapterTarget) : '',
      node.data.chapterPov ?? '',
      node.data.chapterDay != null ? String(node.data.chapterDay) : '',
      node.data.chapterTime ?? '',
    ];

    setChapterArcDraft(drafts[0]);
    setChapterWordsDraft(drafts[1]);
    setChapterTargetDraft(drafts[2]);
    setChapterPovDraft(drafts[3]);
    setChapterDayDraft(drafts[4]);
    setChapterTimeDraft(drafts[5]);

    chapterOpenedDrafts.current = drafts;
  };

  const saveChapterDetails = async () => {
    if (!editingChapterId) return;

    const words = chapterWordsDraft.trim() === '' ? null : Number(chapterWordsDraft);
    const target = chapterTargetDraft.trim() === '' ? null : Number(chapterTargetDraft);
    const day = chapterDayDraft.trim() === '' ? null : Number(chapterDayDraft);

    if (words !== null && (!Number.isInteger(words) || words < 0)) {
      setChapterError('A word count is a whole number, 0 or more.');
      return;
    }

    if (target !== null && (!Number.isInteger(target) || target < 1)) {
      setChapterError('A word target is a whole number above 0, or blank.');
      return;
    }

    if (day !== null && (!Number.isInteger(day) || day < 0)) {
      setChapterError('An in-world day is a whole number, 0 or more, or blank.');
      return;
    }

    setChapterBusy(true);
    setChapterError(null);

    try {
      const updated: any = await invoke('set_chapter_details', {
        nodeId: editingChapterId,
        arc: chapterArcDraft.trim() || null,
        words,
        target,
        pov: chapterPovDraft || null,
        day,
        time: chapterTimeDraft.trim() || null,
        user: actor,
      });

      setNodes(previous =>
        previous.map(node =>
          node.id === updated.id
            ? {
                ...node,
                data: {
                  ...node.data,
                  chapterArc: updated.chapter_arc ?? null,
                  chapterWords: updated.chapter_words ?? null,
                  chapterTarget: updated.chapter_target ?? null,
                  chapterPov: updated.chapter_pov ?? null,
                  chapterDay: updated.chapter_day ?? null,
                  chapterTime: updated.chapter_time ?? null,
                },
              }
            : node
        )
      );

      setEditingChapterId(null);
    } catch (e) {
      console.error('Failed to save chapter details:', e);
      setChapterError(`Could not save the chapter details: ${String(e)}`);
    } finally {
      setChapterBusy(false);
    }
  };

  // Whether the note panel holds something not yet saved: an edited note whose
  // text has changed, or a new note that has been typed into.
  const noteDraftIsDirty = () => {
    if (editingNoteId != null) {
      const saved = chapterNotes.find(note => note.id === editingNoteId);

      return saved != null && noteEditDraft !== saved.text;
    }

    return noteDraft.trim() !== '';
  };

  // Closing the window is the last way to lose a draft. The listener is installed
  // once and reads the latest answer through a ref, so it never needs rewiring as
  // the forms change.
  const unsavedDraft = chapterDraftIsDirty() || noteDraftIsDirty();
  const unsavedDraftRef = useRef(false);

  useEffect(() => {
    unsavedDraftRef.current = unsavedDraft;
  }, [unsavedDraft]);

  useEffect(() => {
    // A plain browser page has no window to close; only the desktop app asks.
    if (!('__TAURI_INTERNALS__' in window)) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void getCurrentWindow()
      .onCloseRequested(event => {
        if (!unsavedDraftRef.current) return;

        event.preventDefault();
        setQuitPrompt(true);
      })
      .then(stop => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(error => {
        console.error('Failed to watch for the window closing:', error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Where the keyboard goes back to once the question is answered: the field the
  // draft is in, so the next keystroke still acts on it.
  const dismissQuitPrompt = () => {
    setQuitPrompt(false);

    if (editingNoteId != null) noteEditorRef.current?.focus();
    else if (openNotesChapterId != null) noteAddRef.current?.focus();
    else if (editingChapterId != null) chapterArcInputRef.current?.focus();
  };

  // The answer when the work can go: close the window without writing. Destroying
  // it skips the close request that would ask the same question again.
  const quitWithoutSaving = () => {
    setQuitPrompt(false);

    void getCurrentWindow()
      .destroy()
      .catch(error => {
        console.error('Failed to close the window:', error);
        setQuitPrompt(true);
      });
  };

  const requestNoteLeave = (go: () => void) => {
    if (!noteDraftIsDirty()) {
      go();
      return;
    }

    setNoteError(null);
    setNotePrompt({
      message:
        editingNoteId != null
          ? 'Discard your changes to this note?'
          : 'Discard this new note?',
      go,
    });
  };

  // Notes are shown one chapter at a time. Opening another or closing this one
  // asks first when there is typing to lose.
  const toggleChapterNotes = (chapterId: string) => {
    const closing = openNotesChapterId === chapterId;

    requestNoteLeave(() => {
      setEditingNoteId(null);
      setNoteDraft('');
      setNoteError(null);
      setMatchedNoteId(null);
      setNotePrompt(null);
      setOpenNotesChapterId(closing ? null : chapterId);
    });
  };

  const addNote = async (chapterId: string) => {
    const text = noteDraft.trim();

    if (!text) {
      setNoteError('A note needs some text.');
      return;
    }

    setNoteBusy(true);
    setNoteError(null);

    try {
      const created: any = await invoke('add_chapter_note', {
        chapterId,
        text,
        user: actor,
      });

      setChapterNotes(previous => [...previous, toChapterNote(created)]);
      setNoteDraft('');
    } catch (e) {
      console.error('Failed to add a note:', e);
      setNoteError(`Could not add the note: ${String(e)}`);
    } finally {
      setNoteBusy(false);
    }
  };

  const startNoteEdit = (note: ChapterNote) => {
    if (editingNoteId === note.id) return;

    const open = () => {
      setNoteError(null);
      setEditingNoteId(note.id);
      setNoteEditDraft(note.text);
      setNotePrompt(null);
    };

    // Editing another note is a move within the panel, and only an edited note
    // holds a draft that the move would drop.
    if (editingNoteId != null) {
      requestNoteLeave(open);
      return;
    }

    open();
  };

  const dismissNotePrompt = () => {
    setNotePrompt(null);
    (editingNoteId != null ? noteEditorRef.current : noteAddRef.current)?.focus();
  };

  // Cancelling an edit closes the editor rather than the panel, and asks first
  // when the note has been changed. A second Escape is the answer to the
  // question: it dismisses it, the same as Keep editing.
  const requestNoteEditCancel = () => {
    if (notePrompt) {
      dismissNotePrompt();
      return;
    }

    const closeEditor = () => {
      setEditingNoteId(null);
      setNoteEditDraft('');
      setNotePrompt(null);
    };

    if (editingNoteId != null && noteDraftIsDirty()) {
      setNoteError(null);
      setNotePrompt({
        message: 'Discard your changes to this note?',
        go: closeEditor,
      });
      return;
    }

    closeEditor();
  };

  // The answer to the note prompt: drop the draft and do what was asked.
  const discardNoteDraft = () => {
    if (!notePrompt) return;

    const go = notePrompt.go;

    setNotePrompt(null);
    go();
  };

  const saveNoteEdit = async () => {
    if (!editingNoteId) return;

    const text = noteEditDraft.trim();

    if (!text) {
      setNoteError('A note needs some text.');
      return;
    }

    setNoteBusy(true);
    setNoteError(null);

    try {
      const updated: any = await invoke('update_chapter_note', {
        id: editingNoteId,
        text,
        user: actor,
      });
      const row = toChapterNote(updated);

      setChapterNotes(previous =>
        previous.map(note => (note.id === row.id ? row : note))
      );
      setEditingNoteId(null);
    } catch (e) {
      console.error('Failed to save a note:', e);
      setNoteError(`Could not save the note: ${String(e)}`);
    } finally {
      setNoteBusy(false);
    }
  };

  // Deleting a note moves it to the trash, like a card: the Trash tab can bring it
  // back for as long as the retention window lasts.
  const deleteNote = async (note: ChapterNote) => {
    setNoteBusy(true);
    setNoteError(null);

    try {
      await invoke('delete_node', { id: note.id, user: actor });

      setChapterNotes(previous => previous.filter(entry => entry.id !== note.id));
      setEditingNoteId(previous => (previous === note.id ? null : previous));
    } catch (e) {
      console.error('Failed to delete a note:', e);
      setNoteError(`Could not delete the note: ${String(e)}`);
    } finally {
      setNoteBusy(false);
    }
  };

  // A search result for a note opens the chapter it lives in and marks the note
  // for a moment, so the found text does not have to be hunted for in the list.
  const openChapterNotes = (chapterId: string, noteId: string | null) => {
    // An edit in progress in another chapter keeps its draft: the panel hides it
    // rather than throwing the typing away.
    setNoteError(null);
    setOpenNotesChapterId(chapterId);
    setMatchedNoteId(noteId);

    if (noteHighlightRef.current !== null) {
      window.clearTimeout(noteHighlightRef.current);
    }
    noteHighlightRef.current = window.setTimeout(() => {
      setMatchedNoteId(null);
      noteHighlightRef.current = null;
    }, 2400);

    // The tab is rendered by now, but the row still has to be scrolled to.
    setTimeout(() => {
      document
        .querySelector(`[data-chapter-id="${chapterId}"]`)
        ?.scrollIntoView?.({ block: 'nearest' });
    }, 0);
  };

  // Which node the pointer is over, read from the card the event landed on.
  // React Flow puts `data-id` on each node's wrapper, so no geometry is needed.
  const nodeUnderPointer = (event: React.DragEvent<HTMLDivElement>) => {
    const wrapper = (event.target as HTMLElement | null)?.closest?.('.react-flow__node');
    const id = wrapper?.getAttribute('data-id') ?? null;

    return id && nodes.some(node => node.id === id) ? id : null;
  };

  const rememberNodeDraft = (id: string, draft: { label: string; content: string }) => {
    nodeDraftsRef.current = { ...nodeDraftsRef.current, [id]: draft };
  };

  const forgetNodeDraft = (id: string) => {
    if (!nodeDraftsRef.current[id]) return;

    const next = { ...nodeDraftsRef.current };
    delete next[id];
    nodeDraftsRef.current = next;
  };

  // Opening a node is the same gesture whether it was just created or relinked,
  // and it is where a half-written draft comes back.
  const openNodeInspector = useCallback(
    (node: { id: string; label: string; content?: string | null }) => {
      const draft = nodeDraftsRef.current[node.id];

      setSelectedEdgeId(null);
      setNodeEditError(null);
      setSelectedNodeId(node.id);
      setNodeLabelDraft(draft?.label ?? node.label);
      setNodeContentDraft(draft?.content ?? node.content ?? '');
      setClosePrompt(false);
    },
    []
  );

  const closeCanvasSearch = () => {
    setSearchOpen(false);
    setSearchTerm('');
    setSearchIndex(0);
    // A filter left on would hide results the next time the palette opens.
    setSearchKind('all');
  };

  // A board zoomed out further than 1 would arrive too small to read, so the pan
  // never goes below that.
  // The board is unmounted on the other tabs, so a result chosen there has to
  // wait for it to come back before it can be centred on. Until then the pan is
  // parked, and the board applies it as soon as it initializes.
  useEffect(() => {
    if (selectedTab !== 'graph') flowRef.current = null;
  }, [selectedTab]);

  const panCanvas = (x: number, y: number) => {
    const instance = flowRef.current;

    if (!instance) {
      pendingPanRef.current = { x, y };
      return;
    }

    const zoom = Math.max(instance.getZoom?.() ?? 1, 1);
    instance.setCenter(x, y, { zoom, duration: 300 });
  };

  // Every result is a destination: a card opens in the inspector on its board, a
  // cast member opens their sheet, a connection opens the edge editor at its
  // midpoint, and a story result opens that story.
  const chooseSearchResult = async (result: SearchResult, skipDraftGuard = false) => {
    const targetStory = stories.find(story => story.id === result.storyId) ?? null;
    const targetTab =
      result.kind === 'cast' ? 'characters' : result.kind === 'note' ? 'chapters' : 'graph';
    const changingStory = targetStory != null && targetStory.id !== currentStory?.id;

    // A result can leave an open chapter form or a half-written note behind, so
    // it asks first. Closing the palette happens either way; the result is
    // followed once answered.
    if (
      !skipDraftGuard &&
      (chapterDraftIsDirty() || noteDraftIsDirty()) &&
      (changingStory || targetTab !== 'chapters')
    ) {
      closeCanvasSearch();

      const message =
        changingStory && targetStory
          ? `Open “${targetStory.title}” and drop these changes?`
          : 'Leave Chapters and drop these changes?';

      // The answer drops every draft this panel could be holding, then the
      // result is followed with the question already behind it.
      const go = () => {
        setChapterFormPrompt(null);
        setNotePrompt(null);
        setEditingChapterId(null);
        setEditingNoteId(null);
        setNoteEditDraft('');
        setNoteDraft('');
        setNoteError(null);
        setMatchedNoteId(null);
        void chooseSearchResult(result, true);
      };

      if (noteDraftIsDirty()) {
        setChapterFormPrompt(null);
        setNotePrompt({ message, go });
      } else {
        setChapterFormPrompt({ kind: 'leave', message, go });
      }

      return;
    }

    closeCanvasSearch();
    setSelectedTab(targetTab);

    if (result.kind === 'story') {
      if (targetStory) await loadStory(targetStory);
      return;
    }

    // A result in another story has to be opened before it can be shown, and the
    // board it names is loaded by the same code the sidebar uses.
    if (targetStory && targetStory.id !== currentStory?.id) {
      await loadStory(targetStory);
    }

    if (result.kind === 'cast') {
      setSelectedCharacterId(result.targetId);

      // The sheet is rendered by the tab that was just switched to, so the row
      // is scrolled to after that render rather than against the old list.
      setTimeout(() => {
        document
          .querySelector(`[data-character-id="${result.targetId}"]`)
          ?.scrollIntoView?.({ block: 'nearest' });
      }, 0);
      return;
    }

    if (result.kind === 'note') {
      setSelectedNodeId(null);
      setSelectedEdgeId(null);

      if (result.chapterId) openChapterNotes(result.chapterId, result.targetId);
      return;
    }

    if (result.kind === 'node') {
      setRenameOffer(null);
      openNodeInspector({
        id: result.targetId,
        label: result.label,
        content: result.content,
      });
      panCanvas(result.x, result.y);
      return;
    }

    // A connection opens in its editor rather than only moving the view, so the
    // palette can be used to change a link as well as to look at it.
    setSelectedNodeId(null);
    setSelectedEdgeId(result.targetId);
    setEdgeLabelDraft(result.edgeLabel);
    setEdgeRelationDraft(result.edgeRelation);
    panCanvas(result.x, result.y);
  };

  // A cast card dropped on empty canvas makes a new character node already
  // pointing at that member, where it was dropped; dropped on a node, it points
  // that node at the member instead of making another. Creation and link are one
  // command, so a refused link leaves nothing behind either way.
  const dropCastMember = async (event: React.DragEvent<HTMLDivElement>) => {
    const characterId = event.dataTransfer.getData(CAST_DRAG_TYPE);
    const targetId = nodeUnderPointer(event);

    setDraggingCastId(null);
    setDropTargetNodeId(null);
    setRenameOffer(null);

    if (!characterId || !currentStory) return;
    event.preventDefault();

    const character = characters.find(candidate => candidate.id === characterId);
    if (!character) return;

    setActionError(null);

    if (targetId) {
      const target = nodes.find(node => node.id === targetId);
      if (!target) return;

      // Already pointing at this member, so the drop changes nothing; opening it
      // still tells the person the card landed.
      if (target.data.characterId === character.id) {
        openNodeInspector({
          id: target.id,
          label: target.data.label,
          content: target.data.content,
        });
        return;
      }

      const previousId = target.data.characterId ?? null;

      try {
        const updated: any = await invoke('set_node_character', {
          nodeId: target.id,
          characterId: character.id,
          user: actor,
        });

        setNodes(nds =>
          nds.map(node =>
            node.id === updated.id
              ? { ...node, data: { ...node.data, characterId: updated.character_id ?? null } }
              : node
          )
        );

        recordStep({
          label: `Relink “${target.data.label}”`,
          undo: () =>
            invoke('set_node_character', {
              nodeId: target.id,
              characterId: previousId,
              user: actor,
            }),
          redo: () =>
            invoke('set_node_character', {
              nodeId: target.id,
              characterId: character.id,
              user: actor,
            }),
        });

        // Only the link changes here: the label, notes and type are the
        // author's. If the label was the old member's name, the drawer offers
        // the rename instead of taking it.
        offerRenameAfterRelink(
          { id: target.id, label: target.data.label },
          previousId,
          character.id
        );

        openNodeInspector({
          id: target.id,
          label: target.data.label,
          content: target.data.content,
        });
      } catch (e) {
        console.error('Failed to link a cast member to a node:', e);
        setActionError(
          `Could not link ${character.name} to “${target.data.label}”: ${String(e)}`
        );
      }

      return;
    }

    const position = flowRef.current
      ? flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      : { x: event.clientX, y: event.clientY };

    try {
      const created: any = await invoke('create_graph_node', {
        storyId: currentStory.id,
        nodeType: 'character',
        label: character.name,
        content: null,
        posX: position.x,
        posY: position.y,
        createdBy: actor,
        characterId: character.id,
      });

      setNodes(nds => [
        ...nds,
        {
          id: created.id,
          type: 'default',
          position,
          data: {
            label: created.label,
            nodeType: created.node_type,
            content: created.content,
            createdBy: created.created_by,
            characterId: created.character_id ?? character.id,
            chapterSeq: created.chapter_seq ?? null,
          },
        },
      ]);

      recordStep({
        label: `Add “${created.label}”`,
        undo: () => invoke('delete_node', { id: created.id, user: actor }),
        redo: () => invoke('restore_deleted', { id: created.id, kind: 'node', user: actor }),
      });

      // Opening it is what makes the drop feel finished: the numbers are in the
      // inspector, and the link can be changed without hunting for the node.
      openNodeInspector({
        id: created.id,
        label: created.label,
        content: created.content,
      });
    } catch (e) {
      console.error('Failed to drop a cast member onto the canvas:', e);
      setActionError(`Could not add ${character.name} to the canvas: ${String(e)}`);
    }
  };

  const onConnect = useCallback(
    async (params: Connection) => {
      if (!currentStory || !params.source || !params.target) return;

      try {
        const newDbEdge: any = await invoke('create_graph_edge', {
          storyId: currentStory.id,
          sourceId: params.source,
          targetId: params.target,
          label: null,
          relationType: null,
          createdBy: actor,
        });

        const newEdge: any = {
          id: newDbEdge.id,
          source: params.source,
          target: params.target,
          label: '',
          data: {
            createdBy: actor,
          },
        };

        setSelectedEdgeId(null);

        setEdges(eds => addEdge(newEdge, eds));

        recordStep({
          label: 'Add a connection',
          undo: () => invoke('delete_edge', { id: newDbEdge.id, user: actor }),
          redo: () =>
            invoke('restore_deleted', { id: newDbEdge.id, kind: 'edge', user: actor }),
        });
      } catch (e) {
        console.error('Failed to create edge:', e);
      }
    },
    [currentStory, actor, setEdges, recordStep]
  );

  // Where a drag began, so ending it can record both ends of the move.
  const onNodeDragStart = useCallback((_event: any, node: Node<NodeData>) => {
    dragStartRef.current = { id: node.id, x: node.position.x, y: node.position.y };
  }, []);

  const onNodeDragStop = useCallback(
    async (_event: any, node: Node<NodeData>) => {
      if (!currentStory) return;

      const start = dragStartRef.current;
      dragStartRef.current = null;

      const from = start && start.id === node.id ? start : null;
      const to = { x: node.position.x, y: node.position.y };

      try {
        await invoke('update_graph_node_position', {
          id: node.id,
          posX: to.x,
          posY: to.y,
          user: actor,
        });

        if (from && (from.x !== to.x || from.y !== to.y)) {
          recordStep({
            label: `Move “${node.data.label}”`,
            undo: () =>
              invoke('update_graph_node_position', {
                id: node.id,
                posX: from.x,
                posY: from.y,
                user: actor,
              }),
            redo: () =>
              invoke('update_graph_node_position', {
                id: node.id,
                posX: to.x,
                posY: to.y,
                user: actor,
              }),
          });
        }
      } catch (e) {
        console.error('Failed to persist node position:', e);
      }
    },
    [currentStory, actor, recordStep]
  );

  // React Flow removes the node from the canvas optimistically. Persist that,
  // and if the write fails put the canvas back to what the database says.
  const removeNodes = useCallback(
    async (deleted: Node<NodeData>[]) => {
      if (!currentStory) return;
      setActionError(null);

      // Attached edges disappear with the node in the database, so drop them
      // locally too in case the canvas still shows them.
      const removedIds = new Set(deleted.map(node => node.id));
      // The edges going with these nodes are restored by the node restore, so
      // they must not become a step of their own.
      removedNodeIdsRef.current = removedIds;
      setSelectedNodeId(current => (current && removedIds.has(current) ? null : current));
      // Connections attached to those nodes go with them, so close that editor.
      setSelectedEdgeId(null);
      setEdges(eds =>
        eds.filter(edge => !removedIds.has(edge.source) && !removedIds.has(edge.target))
      );

      try {
        for (const node of deleted) {
          await invoke('delete_node', { id: node.id, user: actor });
        }

        recordStep({
          label:
            deleted.length === 1
              ? `Delete “${deleted[0].data.label}”`
              : `Delete ${deleted.length} nodes`,
          undo: async () => {
            for (const node of deleted) {
              await invoke('restore_deleted', { id: node.id, kind: 'node', user: actor });
            }
          },
          redo: async () => {
            for (const node of deleted) {
              await invoke('delete_node', { id: node.id, user: actor });
            }
          },
        });
      } catch (e) {
        console.error('Failed to delete node:', e);
        setActionError(`Could not delete node: ${String(e)}`);
        await loadStory(currentStory);
      }
    },
    [currentStory, actor, loadStory, setEdges, recordStep]
  );

  const removeEdges = useCallback(
    async (deleted: Edge<EdgeData>[]) => {
      if (!currentStory) return;
      setActionError(null);

      const removedIds = new Set(deleted.map(edge => edge.id));
      setSelectedEdgeId(current => (current && removedIds.has(current) ? null : current));

      // Connections torn down by a node deletion are already part of that step.
      const ownDeletes = deleted.filter(
        edge =>
          !removedNodeIdsRef.current.has(edge.source) &&
          !removedNodeIdsRef.current.has(edge.target)
      );
      removedNodeIdsRef.current = new Set();

      try {
        for (const edge of ownDeletes) {
          await invoke('delete_edge', { id: edge.id, user: actor });
        }

        if (ownDeletes.length > 0) {
          recordStep({
            label:
              ownDeletes.length === 1
                ? 'Delete a connection'
                : `Delete ${ownDeletes.length} connections`,
            undo: async () => {
              for (const edge of ownDeletes) {
                await invoke('restore_deleted', { id: edge.id, kind: 'edge', user: actor });
              }
            },
            redo: async () => {
              for (const edge of ownDeletes) {
                await invoke('delete_edge', { id: edge.id, user: actor });
              }
            },
          });
        }
      } catch (e) {
        console.error('Failed to delete connection:', e);
        setActionError(`Could not delete connection: ${String(e)}`);
        await loadStory(currentStory);
      }
    },
    [currentStory, actor, loadStory, recordStep]
  );

  const startRename = (story: Story) => {
    setActionError(null);
    setConfirmDeleteStoryId(null);
    setRenamingStoryId(story.id);
    setRenameValue(story.title);
  };

  const commitRename = useCallback(
    async (story: Story) => {
      setRenamingStoryId(null);

      const title = renameValue.trim();
      if (!title || title === story.title) return;

      try {
        const updated: Story = await invoke('update_story', {
          id: story.id,
          title,
          user: actor,
        });

        // The sidebar is ordered by most recently touched, matching the query.
        setStories(prev =>
          [updated, ...prev.filter(other => other.id !== updated.id)].sort((a, b) =>
            b.updated_at.localeCompare(a.updated_at)
          )
        );
        setCurrentStory(prev => (prev && prev.id === updated.id ? updated : prev));
      } catch (e) {
        console.error('Failed to rename story:', e);
        setActionError(`Could not rename story: ${String(e)}`);
      }
    },
    [renameValue, actor]
  );

  const removeStory = async (story: Story) => {
    setConfirmDeleteStoryId(null);
    setActionError(null);

    try {
      await invoke('delete_story', { id: story.id, user: actor });

      const remaining = stories.filter(other => other.id !== story.id);
      setStories(remaining);

      if (currentStory?.id === story.id) {
        if (remaining.length > 0) {
          await loadStory(remaining[0]);
        } else {
          setCurrentStory(null);
          setNodes([]);
          setEdges([]);
          setChapterNotes([]);
        }
      }
    } catch (e) {
      console.error('Failed to delete story:', e);
      setActionError(`Could not delete story: ${String(e)}`);
    }
  };

  const createCharacter = async () => {
    if (!currentStory || !newCharacterName.trim()) return;
    setCharacterError(null);

    try {
      const character: Character = await invoke('create_new_character', {
        storyId: currentStory.id,
        name: newCharacterName.trim(),
        description: newCharacterDescription.trim() || null,
        user: actor,
      });

      setCharacters(prev =>
        [...prev, character].sort((a, b) => a.name.localeCompare(b.name))
      );
      setSelectedCharacterId(character.id);
      setNewCharacterName('');
      setNewCharacterDescription('');
    } catch (e) {
      console.error('Failed to create character:', e);
      setCharacterError(`Could not create character: ${String(e)}`);
    }
  };

  // A saved stat has to reach the cards on the canvas too, whichever tab it was
  // edited from, or a badge would go on showing the number it replaced.
  const rememberStat = (stat: CharacterStat) => {
    setCastStats(previous => {
      const current = previous[stat.character_id] ?? [];

      return {
        ...previous,
        [stat.character_id]: [...current.filter(other => other.id !== stat.id), stat].sort(
          (a, b) => a.stat_name.localeCompare(b.stat_name)
        ),
      };
    });
  };

  const startStatEdit = (stat: CharacterStat) => {
    setEditingStatId(stat.id);
    setStatValueDraft(String(stat.value));
    setStatNotesDraft(stat.notes ?? '');
  };

  const saveStat = async (stat: CharacterStat) => {
    const value = Number(statValueDraft);

    if (!statValueDraft.trim() || !Number.isFinite(value)) {
      setCharacterError('A stat value has to be a number.');
      return;
    }

    setCharacterError(null);

    try {
      const updated: CharacterStat = await invoke('set_character_stat', {
        characterId: stat.character_id,
        statName: stat.stat_name,
        value: Math.trunc(value),
        notes: statNotesDraft.trim() || null,
        user: actor,
      });

      setCharacterStats(prev =>
        [...prev.filter(other => other.id !== updated.id), updated].sort((a, b) =>
          a.stat_name.localeCompare(b.stat_name)
        )
      );
      rememberStat(updated);
      setEditingStatId(null);
    } catch (e) {
      console.error('Failed to save stat:', e);
      setCharacterError(`Could not save stat: ${String(e)}`);
    }
  };

  const addStat = async () => {
    if (!selectedCharacterId || !newStatName.trim()) return;

    const raw = newStatValue.trim();
    const value = Number(raw || '0');

    if (!Number.isFinite(value)) {
      setCharacterError('A stat value has to be a number.');
      return;
    }

    setCharacterError(null);

    try {
      // Setting a stat that already exists updates it, which is what the name
      // implies; the list below merges by id either way.
      const saved: CharacterStat = await invoke('set_character_stat', {
        characterId: selectedCharacterId,
        statName: newStatName.trim(),
        value: Math.trunc(value),
        notes: null,
        user: actor,
      });

      setCharacterStats(prev =>
        [...prev.filter(other => other.id !== saved.id), saved].sort((a, b) =>
          a.stat_name.localeCompare(b.stat_name)
        )
      );
      rememberStat(saved);
      setNewStatName('');
      setNewStatValue('');
    } catch (e) {
      console.error('Failed to add stat:', e);
      setCharacterError(`Could not add stat: ${String(e)}`);
    }
  };

  const startAttributeEdit = (attribute: CharacterAttribute) => {
    setEditingAttributeId(attribute.id);
    setAttributeValueDraft(attribute.value);
  };

  const saveAttribute = async (attribute: CharacterAttribute) => {
    if (!selectedCharacterId) return;

    const value = attributeValueDraft.trim();

    if (!value) {
      setCharacterError('An attribute needs a value — delete it to remove it.');
      return;
    }

    setCharacterError(null);

    try {
      const updated: CharacterAttribute = await invoke('set_character_attribute', {
        characterId: selectedCharacterId,
        attrName: attribute.attr_name,
        value,
        user: actor,
      });

      setCharacterAttributes(prev =>
        [...prev.filter(other => other.id !== updated.id), updated].sort((a, b) =>
          a.attr_name.localeCompare(b.attr_name)
        )
      );
      setEditingAttributeId(null);
    } catch (e) {
      console.error('Failed to save attribute:', e);
      setCharacterError(`Could not save attribute: ${String(e)}`);
    }
  };

  const addAttribute = async () => {
    if (!selectedCharacterId || !newAttributeName.trim()) return;

    const value = newAttributeValue.trim();

    if (!value) {
      setCharacterError('An attribute needs a value.');
      return;
    }

    setCharacterError(null);

    try {
      // Setting a name that already exists updates it, like stats do.
      const saved: CharacterAttribute = await invoke('set_character_attribute', {
        characterId: selectedCharacterId,
        attrName: newAttributeName.trim(),
        value,
        user: actor,
      });

      setCharacterAttributes(prev =>
        [...prev.filter(other => other.id !== saved.id), saved].sort((a, b) =>
          a.attr_name.localeCompare(b.attr_name)
        )
      );
      setNewAttributeName('');
      setNewAttributeValue('');
    } catch (e) {
      console.error('Failed to add attribute:', e);
      setCharacterError(`Could not add attribute: ${String(e)}`);
    }
  };

  const removeAttribute = async (attribute: CharacterAttribute) => {
    setCharacterError(null);

    try {
      await invoke('delete_character_attribute', { id: attribute.id, user: actor });
      setCharacterAttributes(prev => prev.filter(other => other.id !== attribute.id));
      setEditingAttributeId(null);
    } catch (e) {
      console.error('Failed to delete attribute:', e);
      setCharacterError(`Could not delete attribute: ${String(e)}`);
    }
  };

  const startCharacterEdit = () => {
    if (!selectedCharacter) return;
    setCharacterError(null);
    setConfirmDeleteCharacter(false);
    setCharacterNameDraft(selectedCharacter.name);
    setCharacterDescriptionDraft(selectedCharacter.description ?? '');
    setEditingCharacter(true);
  };

  const saveCharacter = async () => {
    if (!selectedCharacter) return;

    const name = characterNameDraft.trim();

    if (!name) {
      setCharacterError('A character needs a name.');
      return;
    }

    setCharacterError(null);

    try {
      const updated: Character = await invoke('update_character', {
        id: selectedCharacter.id,
        name,
        description: characterDescriptionDraft.trim() || null,
        user: actor,
      });

      setCharacters(prev =>
        prev
          .map(character => (character.id === updated.id ? updated : character))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      setEditingCharacter(false);
    } catch (e) {
      console.error('Failed to update character:', e);
      setCharacterError(`Could not update character: ${String(e)}`);
    }
  };

  const removeCharacter = async () => {
    if (!selectedCharacter) return;
    setConfirmDeleteCharacter(false);
    setCharacterError(null);

    const removedId = selectedCharacter.id;

    try {
      await invoke('delete_character', { id: removedId, user: actor });

      const remaining = characters.filter(character => character.id !== removedId);
      setCharacters(remaining);
      setSelectedCharacterId(remaining[0]?.id ?? null);
      setCharacterStats([]);
      setCharacterAttributes([]);
      setEditingCharacter(false);
    } catch (e) {
      console.error('Failed to delete character:', e);
      setCharacterError(`Could not delete character: ${String(e)}`);
    }
  };

  const importStory = async () => {
    setActionError(null);
    setImportStatus(null);

    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'Story export', extensions: ['json'] }],
      });

      // The dialog returns null when it is dismissed, which is not an error.
      if (typeof selected !== 'string') return;

      const imported: Story = await invoke('import_story_json', {
        path: selected,
        user: actor,
      });

      setStories(prev => [
        imported,
        ...prev.filter(other => other.id !== imported.id),
      ]);
      setCurrentStory(imported);
      setSelectedTab('graph');
      setImportStatus(`Imported "${imported.title}"`);
    } catch (e) {
      console.error('Failed to import story:', e);
      setActionError(`Could not import that file: ${String(e)}`);
    }
  };

  const exportStory = async () => {
    if (!currentStory) return;
    setActionError(null);
    setExportStatus(null);

    try {
      const path: string = await invoke('export_story_json', {
        storyId: currentStory.id,
      });
      setExportStatus(path);
    } catch (e) {
      console.error('Failed to export story:', e);
      setActionError(`Could not export story: ${String(e)}`);
    }
  };

  // The hand-off for drafting elsewhere: Markdown, not a snapshot of the app.
  const exportStoryBible = async () => {
    if (!currentStory) return;
    setActionError(null);
    setExportStatus(null);

    try {
      const path: string = await invoke('export_story_markdown', {
        storyId: currentStory.id,
      });
      setExportStatus(path);
    } catch (e) {
      console.error('Failed to write the story bible:', e);
      setActionError(`Could not write the story bible: ${String(e)}`);
    }
  };

  // The same text the file holds, so copying and saving cannot say different
  // things; the Markdown is read from the database rather than the last file.
  const copyStoryBible = async () => {
    if (!currentStory) return;
    setActionError(null);
    setCopyNotice(null);

    try {
      const markdown: string = await invoke('story_bible_markdown', {
        storyId: currentStory.id,
      });

      await writeText(markdown);
      setCopyNotice('Story bible copied to the clipboard');
    } catch (e) {
      console.error('Failed to copy the story bible:', e);
      setActionError(`Could not copy the story bible: ${String(e)}`);
    }
  };

  const openBackups = async () => {
    setBackupsOpen(true);
    setConfirmRestore(null);
    setBackupsError(null);
    setBackupsLoading(true);

    try {
      const list = await invoke<BackupInfo[]>('list_backups');
      setBackups(list);
    } catch (e) {
      console.error('Failed to list backups:', e);
      setBackupsError(`Could not read the backups: ${String(e)}`);
    } finally {
      setBackupsLoading(false);
    }
  };

  // Restoring replaces the file under the whole app. Everything read from the old
  // one is dropped and read again, and the session's undo history goes with it,
  // because it describes rows that no longer exist.
  const restoreBackup = async (file: BackupInfo) => {
    setRestoringFile(file.file_name);
    setBackupsError(null);

    try {
      await invoke('restore_backup', { fileName: file.file_name });

      undoStackRef.current = [];
      redoStackRef.current = [];
      setHistoryDepth({ undo: 0, redo: 0 });
      nodeDraftsRef.current = {};
      otherStoryIndexRef.current = {};
      setOtherStoryIndex({});

      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setSelectedCharacterId(null);
      setClosePrompt(false);
      setNodes([]);
      setEdges([]);
      setChapterNotes([]);
      setCharacters([]);
      setCastStats({});
      setAuditEntries([]);
      setAuditTotal(0);
      setTrash([]);
      setDeletedStories([]);

      const restored: Story[] = await invoke('get_all_stories');
      setCurrentStory(null);
      setStories(restored);

      setConfirmRestore(null);
      setBackupsOpen(false);
      setRestoreNotice(`Restored the copy from ${formatWhen(file.created_at)}`);
    } catch (e) {
      console.error('Failed to restore a backup:', e);
      setBackupsError(`Could not restore that copy: ${String(e)}`);
    } finally {
      setRestoringFile(null);
    }
  };

  // Only one editor is open at a time: picking a node closes the connection
  // editor, because both occupy the same corner of the canvas.
  const selectNode = useCallback(
    (_event: React.MouseEvent, node: Node<NodeData>) => {
      openNodeInspector({ id: node.id, label: node.data.label, content: node.data.content });
      setRenameOffer(null);
    },
    [openNodeInspector]
  );

  const selectEdge = useCallback((_event: React.MouseEvent, edge: Edge<EdgeData>) => {
    setEdgeEditError(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(edge.id);
    setEdgeLabelDraft(edge.data?.label ?? '');
    setEdgeRelationDraft(edge.data?.relationType ?? '');
    setRenameOffer(null);
  }, []);

  const saveNode = async (closeAfter = false) => {
    if (!selectedNodeId) return;

    const label = nodeLabelDraft.trim();

    if (!label) {
      setNodeEditError('A node needs a label.');
      return;
    }

    setNodeEditError(null);

    const content = nodeContentDraft.trim() || null;
    const currentNode = nodes.find(node => node.id === selectedNodeId);

    // Saving without changing anything is not an edit, so it writes nothing.
    if (
      currentNode &&
      currentNode.data.label === label &&
      (currentNode.data.content ?? null) === content
    ) {
      // Nothing to write, but the field may still hold untrimmed text: the draft
      // is settled either way, so a later close does not ask about it.
      forgetNodeDraft(selectedNodeId);
      setNodeLabelDraft(label);
      setNodeContentDraft(content ?? '');
      if (closeAfter) {
        setClosePrompt(false);
        setSelectedNodeId(null);
      }
      return;
    }

    try {
      const updated: any = await invoke('update_graph_node', {
        id: selectedNodeId,
        label,
        content,
        user: actor,
      });

      setNodes(nds =>
        nds.map(node =>
          node.id === updated.id
            ? {
                ...node,
                data: {
                  ...node.data,
                  label: updated.label,
                  content: updated.content ?? undefined,
                },
              }
            : node
        )
      );

      // The values before the save, kept so undo can put them back through the
      // same command; the history records the walk in both directions.
      const before = currentNode
        ? { label: currentNode.data.label, content: currentNode.data.content ?? null }
        : null;

      if (before) {
        recordStep({
          label: `Edit “${label}”`,
          undo: () => invoke('update_graph_node', { id: selectedNodeId, ...before, user: actor }),
          redo: () =>
            invoke('update_graph_node', { id: selectedNodeId, label, content, user: actor }),
        });
      }

      // The label is now whatever was saved, so any pending rename offer for it
      // was about a name that no longer exists.
      forgetNodeDraft(updated.id);
      setNodeLabelDraft(updated.label);
      setNodeContentDraft(updated.content ?? '');
      setRenameOffer(null);

      if (closeAfter) {
        setClosePrompt(false);
        setSelectedNodeId(null);
      }
    } catch (e) {
      // The draft stays, so a refused save leaves the text where it was.
      console.error('Failed to update node:', e);
      setNodeEditError(`Could not save node: ${String(e)}`);
    }
  };

  const saveEdge = async () => {
    if (!selectedEdgeId) return;

    setEdgeEditError(null);

    // Both fields are optional, so an empty box means "no label", not invalid.
    const label = edgeLabelDraft.trim() || null;
    const relationType = edgeRelationDraft.trim() || null;
    const currentEdge = edges.find(edge => edge.id === selectedEdgeId);

    // Saving without changing anything is not an edit, so it writes nothing.
    if (
      currentEdge &&
      (currentEdge.data?.label ?? null) === label &&
      (currentEdge.data?.relationType ?? null) === relationType
    ) {
      return;
    }

    try {
      const updated: any = await invoke('update_graph_edge', {
        id: selectedEdgeId,
        label,
        relationType,
        user: actor,
      });

      setEdges(eds =>
        eds.map(edge =>
          edge.id === updated.id
            ? {
                ...edge,
                label: updated.label || updated.relation_type || '',
                data: {
                  createdBy: edge.data?.createdBy ?? actor,
                  label: updated.label ?? undefined,
                  relationType: updated.relation_type ?? undefined,
                },
              }
            : edge
        )
      );

      if (currentEdge) {
        const beforeLabel = currentEdge.data?.label ?? null;
        const beforeRelation = currentEdge.data?.relationType ?? null;

        recordStep({
          label: 'Edit a connection',
          undo: () =>
            invoke('update_graph_edge', {
              id: selectedEdgeId,
              label: beforeLabel,
              relationType: beforeRelation,
              user: actor,
            }),
          redo: () =>
            invoke('update_graph_edge', {
              id: selectedEdgeId,
              label,
              relationType,
              user: actor,
            }),
        });
      }
    } catch (e) {
      console.error('Failed to update connection:', e);
      setEdgeEditError(`Could not save connection: ${String(e)}`);
    }
  };

  // The link is saved as soon as the picker changes, so the drawer never holds an
  // unsaved link that looks applied.
  const changeNodeCharacter = async (characterId: string) => {
    if (!selectedNode) return;

    const previousId = selectedNode.data.characterId ?? null;

    setInspectorError(null);
    setRenameOffer(null);

    try {
      const updated: any = await invoke('set_node_character', {
        nodeId: selectedNode.id,
        characterId: characterId || null,
        user: actor,
      });

      setNodes(nds =>
        nds.map(node =>
          node.id === updated.id
            ? { ...node, data: { ...node.data, characterId: updated.character_id ?? null } }
            : node
        )
      );

      recordStep({
        label: `Relink “${selectedNode.data.label}”`,
        undo: () =>
          invoke('set_node_character', {
            nodeId: selectedNode.id,
            characterId: previousId,
            user: actor,
          }),
        redo: () =>
          invoke('set_node_character', {
            nodeId: selectedNode.id,
            characterId: characterId || null,
            user: actor,
          }),
      });

      offerRenameAfterRelink(
        { id: selectedNode.id, label: selectedNode.data.label },
        previousId,
        characterId
      );
    } catch (e) {
      console.error('Failed to link a cast member to a node:', e);
      setInspectorError(`Could not link the cast member: ${String(e)}`);
    }
  };

  // A relink only offers a rename when the label is exactly the name the node
  // was linked to before. Any other label was written for its own sake, and a
  // rename would be a change nobody asked for.
  const offerRenameAfterRelink = (
    node: { id: string; label: string },
    previousCharacterId: string | null,
    characterId: string
  ) => {
    const previous = previousCharacterId
      ? characters.find(entry => entry.id === previousCharacterId) ?? null
      : null;
    const next = characterId
      ? characters.find(entry => entry.id === characterId) ?? null
      : null;

    if (
      previous &&
      next &&
      node.label.trim() === previous.name &&
      next.name !== node.label
    ) {
      setRenameOffer({ nodeId: node.id, from: previous.name, to: next.name });
      return;
    }

    setRenameOffer(null);
  };

  // Renaming from the offer is the same write as saving the label, so the change
  // lands in the history exactly as if it had been typed.
  const applyRenameOffer = async () => {
    if (!renameOffer) return;

    const node = nodes.find(candidate => candidate.id === renameOffer.nodeId);

    if (!node) {
      setRenameOffer(null);
      return;
    }

    setInspectorError(null);

    try {
      const updated: any = await invoke('update_graph_node', {
        id: node.id,
        label: renameOffer.to,
        content: node.data.content ?? null,
        user: actor,
      });

      setNodes(nds =>
        nds.map(other =>
          other.id === updated.id
            ? { ...other, data: { ...other.data, label: updated.label } }
            : other
        )
      );

      recordStep({
        label: `Rename “${node.data.label}”`,
        undo: () =>
          invoke('update_graph_node', {
            id: node.id,
            label: node.data.label,
            content: node.data.content ?? null,
            user: actor,
          }),
        redo: () =>
          invoke('update_graph_node', {
            id: node.id,
            label: updated.label,
            content: updated.content ?? null,
            user: actor,
          }),
      });

      if (selectedNodeId === node.id) {
        setNodeLabelDraft(updated.label);

        // The label is saved now; notes typed but not saved must survive it.
        const draft = nodeDraftsRef.current[node.id];
        if (draft) rememberNodeDraft(node.id, { label: updated.label, content: draft.content });
      }
      setRenameOffer(null);
    } catch (e) {
      console.error('Failed to rename a relinked node:', e);
      setInspectorError(`Could not rename the node: ${String(e)}`);
    }
  };

  const startInspectorStat = (stat: CharacterStat) => {
    setInspectorStatId(stat.id);
    setInspectorStatValue(String(stat.value));
    setInspectorError(null);
  };

  // Editing a stat from the canvas writes through the same command as the
  // Characters tab, so the change is recorded exactly as if it were made there.
  // The notes are passed back unchanged rather than being cleared.
  const saveInspectorStat = async (stat: CharacterStat) => {
    if (!inspectorCharacter) return;

    const value = Number(inspectorStatValue);

    if (!inspectorStatValue.trim() || !Number.isFinite(value)) {
      setInspectorError('A stat value has to be a number.');
      return;
    }

    try {
      const updated: CharacterStat = await invoke('set_character_stat', {
        characterId: inspectorCharacter.id,
        statName: stat.stat_name,
        value: Math.trunc(value),
        notes: stat.notes,
        user: actor,
      });

      setInspectorStats(prev =>
        [...prev.filter(other => other.id !== updated.id), updated].sort((a, b) =>
          a.stat_name.localeCompare(b.stat_name)
        )
      );
      rememberStat(updated);
      setInspectorStatId(null);
      setInspectorError(null);
    } catch (e) {
      console.error('Failed to save a stat from the inspector:', e);
      setInspectorError(`Could not save stat: ${String(e)}`);
    }
  };

  const startInspectorAttribute = (attribute: CharacterAttribute) => {
    setInspectorAttrId(attribute.id);
    setInspectorAttrValue(attribute.value);
    setInspectorError(null);
  };

  const saveInspectorAttribute = async (attribute: CharacterAttribute) => {
    if (!inspectorCharacter) return;

    const value = inspectorAttrValue.trim();

    if (!value) {
      setInspectorError(
        'An attribute needs a value — delete it on the Characters tab to remove it.'
      );
      return;
    }

    try {
      const updated: CharacterAttribute = await invoke('set_character_attribute', {
        characterId: inspectorCharacter.id,
        attrName: attribute.attr_name,
        value,
        user: actor,
      });

      setInspectorAttributes(prev =>
        [...prev.filter(other => other.id !== updated.id), updated].sort((a, b) =>
          a.attr_name.localeCompare(b.attr_name)
        )
      );
      setInspectorAttrId(null);
      setInspectorError(null);
    } catch (e) {
      console.error('Failed to save an attribute from the inspector:', e);
      setInspectorError(`Could not save attribute: ${String(e)}`);
    }
  };

  const handleNodesChange = useCallback(
    (changes: any[]) => {
      onNodesChange(changes);
    },
    [onNodesChange]
  );

  // A window the list does not offer (a hand-edited database, or one written by
  // a future build) still has to show as itself rather than as a blank box.
  const retentionOptions =
    retentionDays !== null &&
    !retentionChoices.some(choice => choice.value === String(retentionDays))
      ? [...retentionChoices, { value: String(retentionDays), label: `${retentionDays} days` }]
      : retentionChoices;

  // A search looks at everything a result is made of — a card's label, notes,
  // type and cast member; a character's name and description; both ends of a
  // connection; a story's title and description — so it can be found the way a
  // person remembers it rather than only by its exact name. A result whose
  // name matched is listed before one found only by its notes or description.
  const searchResults = useMemo<SearchResult[]>(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return [];

    const matches = (value: string | null | undefined) =>
      typeof value === 'string' && value.toLowerCase().includes(term);
    const hits = (values: (string | null | undefined)[]) => values.some(matches);
    const wants = (kind: SearchKind) => searchKind === 'all' || searchKind === kind;

    const result = (
      kind: SearchKind,
      story: { id: string; title: string },
      targetId: string,
      label: string,
      extra: Partial<SearchResult> = {}
    ): SearchResult => ({
      key: `${kind}:${story.id}:${targetId}`,
      kind,
      storyId: story.id,
      storyTitle: story.title,
      targetId,
      label,
      detail: null,
      nodeType: null,
      characterName: null,
      x: 0,
      y: 0,
      content: null,
      edgeLabel: '',
      edgeRelation: '',
      chapterId: null,
      chapterLabel: null,
      rank: 1,
      ...extra,
    });

    const results: SearchResult[] = [];
    const openStory = { id: currentStory?.id ?? '', title: currentStory?.title ?? '' };

    // The open story reads from what is on screen, so its results are live.
    const castById = new Map(characters.map(character => [character.id, character]));
    const labelOf = new Map(nodes.map(node => [node.id, node.data.label]));
    const positionOf = new Map(nodes.map(node => [node.id, node.position]));

    if (wants('node')) {
      nodes.forEach(node => {
        const characterName = node.data.characterId
          ? castById.get(node.data.characterId)?.name ?? null
          : null;

        if (!hits([node.data.label, node.data.content, node.data.nodeType, characterName])) {
          return;
        }

        results.push(
          result('node', openStory, node.id, node.data.label, {
            nodeType: node.data.nodeType,
            characterName,
            detail: node.data.content ?? null,
            content: node.data.content ?? null,
            rank: matches(node.data.label) ? 0 : 1,
            // A node's position is its top-left, so the pan aims at its middle.
            x: node.position.x + 70,
            y: node.position.y + 20,
          })
        );
      });
    }

    if (wants('note')) {
      chapterNotes.forEach(note => {
        const chapterLabel = labelOf.get(note.chapterId);

        // A note whose chapter is not on the board has nowhere to open.
        if (!chapterLabel || !hits([note.text])) return;

        const label = noteFirstLine(note.text);

        results.push(
          result('note', openStory, note.id, label, {
            chapterId: note.chapterId,
            chapterLabel,
            detail: note.text,
            rank: matches(label) ? 0 : 1,
          })
        );
      });
    }

    if (wants('cast')) {
      characters.forEach(character => {
        if (!hits([character.name, character.description])) return;

        results.push(
          result('cast', openStory, character.id, character.name, {
            detail: character.description,
            rank: matches(character.name) ? 0 : 1,
          })
        );
      });
    }

    if (wants('link')) {
      edges.forEach(edge => {
        const source = labelOf.get(edge.source) ?? '?';
        const target = labelOf.get(edge.target) ?? '?';
        const edgeLabel = edge.data?.label ?? '';
        const edgeRelation = edge.data?.relationType ?? '';

        if (!hits([edgeLabel, edgeRelation, source, target])) return;

        const from = positionOf.get(edge.source);
        const to = positionOf.get(edge.target);

        results.push(
          result('link', openStory, edge.id, edgeLabel || edgeRelation || `${source} → ${target}`, {
            detail: `${source} → ${target}`,
            edgeLabel,
            edgeRelation,
            rank: matches(edgeLabel) ? 0 : 1,
            x: from && to ? (from.x + to.x) / 2 : 0,
            y: from && to ? (from.y + to.y) / 2 : 0,
          })
        );
      });
    }

    // Every other story is searched from the copy read when the palette opened,
    // so a word can be found without opening the story that holds it.
    stories.forEach(story => {
      if (story.id === openStory.id) return;

      const index = otherStoryIndex[story.id];
      const storyCast = index ? new Map(index.characters.map(entry => [entry.id, entry])) : null;

      if (wants('story') && hits([story.title, story.description])) {
        results.push(
          result('story', { id: story.id, title: story.title }, story.id, story.title, {
            detail: story.description,
            rank: matches(story.title) ? 0 : 1,
          })
        );
      }

      if (!index) return;

      const storyLabels = new Map(index.nodes.map(node => [node.id, node.label]));

      if (wants('note')) {
        index.notes.forEach(note => {
          const chapterLabel = note.chapter_id
            ? storyLabels.get(note.chapter_id) ?? null
            : null;

          if (!chapterLabel || !hits([note.text])) return;

          const label = noteFirstLine(note.text);

          results.push(
            result('note', story, note.id, label, {
              chapterId: note.chapter_id,
              chapterLabel,
              detail: note.text,
              rank: matches(label) ? 0 : 1,
            })
          );
        });
      }

      if (wants('node')) {
        index.nodes.forEach(node => {
          const characterName = node.character_id
            ? storyCast?.get(node.character_id)?.name ?? null
            : null;

          if (!hits([node.label, node.content, node.node_type, characterName])) return;

          results.push(
            result('node', story, node.id, node.label, {
              nodeType: node.node_type,
              characterName,
              detail: node.content,
              content: node.content,
              rank: matches(node.label) ? 0 : 1,
              x: node.pos_x + 70,
              y: node.pos_y + 20,
            })
          );
        });
      }

      if (wants('cast')) {
        index.characters.forEach(character => {
          if (!hits([character.name, character.description])) return;

          results.push(
            result('cast', story, character.id, character.name, {
              detail: character.description,
              rank: matches(character.name) ? 0 : 1,
            })
          );
        });
      }

      if (wants('link')) {
        const storyPositions = new Map(
          index.nodes.map(node => [node.id, { x: node.pos_x, y: node.pos_y }])
        );

        index.edges.forEach(edge => {
          const source = storyLabels.get(edge.source_id) ?? '?';
          const target = storyLabels.get(edge.target_id) ?? '?';
          const edgeLabel = edge.label ?? '';
          const edgeRelation = edge.relation_type ?? '';

          if (!hits([edgeLabel, edgeRelation, source, target])) return;

          const from = storyPositions.get(edge.source_id);
          const to = storyPositions.get(edge.target_id);

          results.push(
            result('link', story, edge.id, edgeLabel || edgeRelation || `${source} → ${target}`, {
              detail: `${source} → ${target}`,
              edgeLabel,
              edgeRelation,
              rank: matches(edgeLabel) ? 0 : 1,
              x: from && to ? (from.x + to.x) / 2 : 0,
              y: from && to ? (from.y + to.y) / 2 : 0,
            })
          );
        });
      }
    });

    // Name matches first. The sort is stable, so within each band the results
    // keep the order they were gathered in: the open story before the others.
    return results.sort((left, right) => left.rank - right.rank);
  }, [
    searchTerm,
    searchKind,
    nodes,
    chapterNotes,
    characters,
    edges,
    stories,
    currentStory,
    otherStoryIndex,
  ]);

  // Only the open board is outlined: a result in another story is not on screen
  // until it is chosen, which opens that story.
  const searchMatchIds = useMemo(
    () =>
      new Set(
        searchResults
          .filter(
            entry => entry.kind === 'node' && entry.storyId === currentStory?.id
          )
          .map(entry => entry.targetId)
      ),
    [searchResults, currentStory]
  );

  const moveSearchSelection = (delta: number) => {
    // Only the listed results can be chosen with the keyboard, so the highlight
    // wraps within them rather than walking into matches that are not on screen.
    const shown = Math.min(searchResults.length, SEARCH_RESULTS_SHOWN);
    if (shown === 0) return;

    setSearchIndex(current => (current + delta + shown) % shown);
  };

  // The canvas gets the nodes plus their cast member's name and numbers, and the
  // classes for the relink target and the search hits. Only those nodes are
  // rebuilt, so the rest keep their identity across a render.
  const canvasNodes = useMemo(() => {
    const castById = new Map(characters.map(character => [character.id, character]));

    return nodes.map(node => {
      const characterId = node.data.characterId;
      const classes = [
        node.id === dropTargetNodeId ? 'drop-target' : '',
        searchOpen && searchMatchIds.has(node.id) ? 'search-hit' : '',
      ]
        .filter(Boolean)
        .join(' ');

      if (!characterId && !classes) return node;

      return {
        ...node,
        className: classes || undefined,
        data: characterId
          ? {
              ...node.data,
              characterName: castById.get(characterId)?.name ?? null,
              characterStats: castStats[characterId] ?? [],
              characterLevel: castById.get(characterId)?.level ?? null,
            }
          : node.data,
      };
    });
  }, [nodes, characters, castStats, dropTargetNodeId, searchOpen, searchMatchIds]);

  const selectedCharacter =
    characters.find(character => character.id === selectedCharacterId) ?? null;

  const selectedNode = nodes.find(node => node.id === selectedNodeId) ?? null;

  // What the drawer's fields hold against what the node still says. A restored
  // draft counts as unsaved, because it has not been written anywhere.
  const nodeIsDirty =
    selectedNode !== null &&
    (nodeLabelDraft !== selectedNode.data.label ||
      nodeContentDraft.trim() !== (selectedNode.data.content ?? ''));

  const closeNodeInspector = () => {
    if (nodeIsDirty) {
      setClosePrompt(true);
      return;
    }

    setClosePrompt(false);
    setSelectedNodeId(null);
  };

  const discardNodeDraft = () => {
    if (selectedNodeId) forgetNodeDraft(selectedNodeId);
    setClosePrompt(false);
    setSelectedNodeId(null);
  };

  // What the sheet shows for the selected character.
  const shownLevel = selectedCharacter?.level ?? 1;
  const shownXp = selectedCharacter?.xp ?? 0;
  const shownTarget = selectedCharacter?.xp_to_next ?? null;
  const progressPercent =
    shownTarget && shownTarget > 0
      ? Math.min(100, Math.round((shownXp / shownTarget) * 100))
      : 0;

  const applyCharacterRow = (updated: Character) => {
    setCharacters(previous =>
      previous.map(entry => (entry.id === updated.id ? updated : entry))
    );
  };

  // The progression form opens with the stored numbers, so a save can change one
  // field without having to retype the others.
  const startProgressEdit = () => {
    if (!selectedCharacter) return;

    setProgressLevelDraft(String(shownLevel));
    setProgressXpDraft(String(shownXp));
    setProgressTargetDraft(shownTarget ? String(shownTarget) : '');
    setProgressRankDraft(selectedCharacter.rank ?? '');
    setCharacterError(null);
    setEditingProgress(true);
  };

  const saveProgress = async () => {
    if (!selectedCharacter) return;

    const level = Number(progressLevelDraft);
    const xp = Number(progressXpDraft);
    const target = progressTargetDraft.trim() === '' ? null : Number(progressTargetDraft);

    if (!Number.isInteger(level) || level < 1) {
      setCharacterError('A level is a whole number, 1 or more.');
      return;
    }

    if (!Number.isInteger(xp) || xp < 0) {
      setCharacterError('Experience is a whole number, 0 or more.');
      return;
    }

    if (target !== null && (!Number.isInteger(target) || target < 1)) {
      setCharacterError('XP to next is a whole number above 0, or blank.');
      return;
    }

    setCharacterError(null);

    try {
      const updated: Character = await invoke('set_character_progress', {
        characterId: selectedCharacter.id,
        level,
        xp,
        rank: progressRankDraft.trim() || null,
        xpToNext: target,
        user: actor,
      });

      applyCharacterRow(updated);
      setEditingProgress(false);
    } catch (e) {
      console.error('Failed to save progression:', e);
      setCharacterError(`Could not save progression: ${String(e)}`);
    }
  };

  // One level more, recorded as a level-up event rather than a field edit.
  const levelUpCharacter = async () => {
    if (!selectedCharacter) return;

    setCharacterError(null);

    try {
      const updated: Character = await invoke('level_up_character', {
        characterId: selectedCharacter.id,
        user: actor,
      });

      applyCharacterRow(updated);
    } catch (e) {
      console.error('Failed to level up:', e);
      setCharacterError(`Could not level up: ${String(e)}`);
    }
  };

  const selectedEdge = edges.find(edge => edge.id === selectedEdgeId) ?? null;

  const edgeIsDirty =
    selectedEdge !== null &&
    ((edgeLabelDraft.trim() || null) !== (selectedEdge.data?.label ?? null) ||
      (edgeRelationDraft.trim() || null) !== (selectedEdge.data?.relationType ?? null));

  // Read when the board is refreshed after an undo, which runs outside a render.
  useEffect(() => {
    nodeIsDirtyRef.current = nodeIsDirty;
  }, [nodeIsDirty]);

  useEffect(() => {
    edgeIsDirtyRef.current = edgeIsDirty;
  }, [edgeIsDirty]);

  // The node's stored link, resolved against the live cast. A link to a cast
  // member that is not in the list is one in the trash; nothing is guessed from
  // the node's label any more.
  const inspectorCharacter =
    selectedNode?.data.characterId
      ? characters.find(character => character.id === selectedNode.data.characterId) ?? null
      : null;

  useEffect(() => {
    if (!inspectorCharacter) {
      setInspectorStats([]);
      setInspectorAttributes([]);
      setInspectorStatId(null);
      setInspectorAttrId(null);
      return;
    }

    const characterId = inspectorCharacter.id;
    let cancelled = false;

    const load = async () => {
      try {
        const [stats, attributes] = await Promise.all([
          invoke<CharacterStat[]>('get_character_stats', { characterId }),
          invoke<CharacterAttribute[]>('get_character_attributes', { characterId }),
        ]);
        if (cancelled) return;

        setInspectorStats(stats);
        setInspectorAttributes(attributes);
        setInspectorError(null);
      } catch (e) {
        console.error('Failed to load the cast member for the inspector:', e);
        if (!cancelled) setInspectorError(`Could not load the cast member: ${String(e)}`);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [inspectorCharacter]);

  // One palette, placed on two tabs: over the canvas and above the chapter list.
  // Only one tab renders at a time, so there is never a second copy of it.
  const renderSearchPalette = (placement: 'overlay' | 'inline') =>
    searchOpen && (
      <div
        className={`canvas-search${placement === 'inline' ? ' inline' : ''}`}
        role="dialog"
        aria-label="Search the storyboard"
      >
        <input
          ref={searchInputRef}
          className="canvas-search-input"
          type="search"
          aria-label="Search everything"                        title="Cards, cast, connections, chapter notes and other stories; Enter goes to the chosen one"
                        placeholder="Node, cast member, connection, note or story"
          value={searchTerm}
          onChange={event => {
            setSearchTerm(event.target.value);
            setSearchIndex(0);
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeCanvasSearch();
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              moveSearchSelection(1);
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              moveSearchSelection(-1);
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              const match =
                searchResults[Math.min(searchIndex, searchResults.length - 1)];
              if (match) void chooseSearchResult(match);
            }
          }}
        />

        <div
          className="canvas-search-filters"
          role="group"
          aria-label="Filter by kind"
        >
          {searchKindFilters.map(filter => (
            <button
              key={filter.value}
              type="button"
              className={`canvas-search-filter${
                searchKind === filter.value ? ' active' : ''
              }`}
              aria-pressed={searchKind === filter.value}
              title={filter.title}
              onClick={() => {
                setSearchKind(filter.value);
                setSearchIndex(0);
              }}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {searchTerm.trim() ? (
          searchResults.length === 0 ? (
            <p className="canvas-search-empty">
              {searchKind === 'all'
                ? `Nothing matches “${searchTerm.trim()}”.`
                : `No ${
                    searchKindFilters.find(filter => filter.value === searchKind)
                      ?.noun
                  } match “${searchTerm.trim()}”.`}
            </p>
          ) : (
            <div className="canvas-search-results">
              {searchResults.slice(0, SEARCH_RESULTS_SHOWN).map((entry, index) => {
                const tag = searchResultTag(entry, currentStory?.id);

                return (
                  <button
                    type="button"
                    key={entry.key}
                    className={`canvas-search-result${
                      index === searchIndex ? ' active' : ''
                    }`}
                    title={searchResultTitles[entry.kind]}
                    onMouseEnter={() => setSearchIndex(index)}
                    onClick={() => void chooseSearchResult(entry)}
                  >
                    {entry.kind === 'node' ? (
                      <span className={`legend ${entry.nodeType ?? 'misc'}`}>
                        {entry.nodeType ?? 'node'}
                      </span>
                    ) : (
                      <span className={`canvas-search-kind ${entry.kind}`}>
                        {entry.kind}
                      </span>
                    )}
                    <span className="canvas-search-label">{entry.label}</span>
                    {tag && <span className="canvas-search-tag">{tag}</span>}
                  </button>
                );
              })}
            </div>
          )
        ) : (
          <p className="canvas-search-empty">
            Type to find a node, a cast member, a connection, a chapter
            note or another story.
          </p>
        )}

        <div className="canvas-search-hint">
          {searchTerm.trim() &&
            `${searchResults.length} ${
              searchResults.length === 1 ? 'match' : 'matches'
            } · `}
          ↑↓ choose · Enter go · Esc close
        </div>

        {otherStoryLoading && (
          <div className="canvas-search-hint">Searching the other stories…</div>
        )}
        {otherStoryError && (
          <div className="canvas-search-error">
            Some stories could not be searched.
          </div>
        )}
      </div>
    );

  return (
    <div className="app-container">
      <div className="sidebar">
        <div className="user-section">
          <div className="user-section-head">
            <label>Current User</label>
            <button
              className="shortcut-button"
              aria-label="Keyboard shortcuts"
              title="Every keyboard route in the app (?)"
              onClick={() => setShortcutsOpen(true)}
            >
              ?
            </button>
          </div>
          <input
            value={currentUser}
            title="Recorded as the person making each change in the history"
            onChange={(e) => setCurrentUser(e.target.value)}
            placeholder="Your name"
          />
        </div>

        <h2>Stories</h2>
        <div className="story-creator">
          <input
            placeholder="New story title"
            title="Title for the new story"
            value={newStoryTitle}
            onChange={(e) => setNewStoryTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createNewStory()}
          />
          <button title="Create a story with this title" onClick={createNewStory}>
            Create
          </button>
        </div>

        <button className="import-button" title="Restore a story from a JSON export" onClick={importStory}>
          Import JSON
        </button>

        <div className="story-list">
          {stories.length === 0 && <div className="empty">No stories yet</div>}
          {stories.map(story => {
            const isRenaming = renamingStoryId === story.id;
            const isConfirmingDelete = confirmDeleteStoryId === story.id;

            return (
              <div
                key={story.id}
                className={`story-item ${currentStory?.id === story.id ? 'active' : ''}`}
                onClick={() => !isRenaming && requestStory(story)}
              >
                {isRenaming ? (
                  <input
                    className="story-rename"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(story)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(story);
                      if (e.key === 'Escape') setRenamingStoryId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span
                      className="story-title"
                      title="Double-click to rename"
                      onDoubleClick={() => startRename(story)}
                    >
                      {story.title}
                    </span>
                    <span className="story-actions">
                      {isConfirmingDelete ? (
                        <>
                          <button
                            className="danger"
                            title="Move this story to the trash"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeStory(story);
                            }}
                          >
                            Delete
                          </button>
                          <button
                            title="Keep this story"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteStoryId(null);
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            title="Rename story"
                            onClick={(e) => {
                              e.stopPropagation();
                              startRename(story);
                            }}
                          >
                            Rename
                          </button>
                          <button
                            title="Delete story"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteStoryId(story.id);
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="main-area">
        <div className="topbar">
          <div className="tabs">
            <button
              className={selectedTab === 'graph' ? 'active' : ''}
              title="The story's idea graph"
              onClick={() => requestTab('graph')}
            >
              Graph
            </button>
            <button
              className={selectedTab === 'chapters' ? 'active' : ''}
              title="Put the chapters in reading order and add a new one"
              onClick={() => requestTab('chapters')}
            >
              Chapters
            </button>
            <button
              className={selectedTab === 'characters' ? 'active' : ''}
              title="Manage the cast, their stats and attributes"
              onClick={() => requestTab('characters')}
            >
              Characters
            </button>
            <button
              className={selectedTab === 'audit' ? 'active' : ''}
              title="See every recorded change and revert an edit"
              onClick={() => requestTab('audit')}
            >
              Audit Log
            </button>
            <button
              className={selectedTab === 'trash' ? 'active' : ''}
              title="Restore something deleted, or delete it for good"
              onClick={() => requestTab('trash')}
            >
              Trash
            </button>
          </div>
          <div className="topbar-actions">
            {historyNotice && (
              <span className="history-notice" role="status">
                {historyNotice}
              </span>
            )}
            {restoreNotice && (
              <span className="history-notice" role="status">
                {restoreNotice}
              </span>
            )}
            {copyNotice && (
              <span className="history-notice" role="status">
                {copyNotice}
              </span>
            )}
            <button
              className="backups-button"
              title="Restore an earlier copy of the whole database"
              onClick={() => void openBackups()}
            >
              Backups
            </button>
            {currentStory && (
              <>
                <button
                  className="export-button"
                  title="Write the whole story, history included, to a JSON file"
                  onClick={exportStory}
                >
                  Export JSON
                </button>
                <button
                  className="export-button"
                  title="Write a Markdown outline of the chapters, cast and cards"
                  onClick={() => void exportStoryBible()}
                >
                  Story bible
                </button>
                <button
                  className="export-button"
                  title="Copy the same Markdown outline to the clipboard"
                  onClick={() => void copyStoryBible()}
                >
                  Copy bible
                </button>
                <span className="current-story">{currentStory.title}</span>
              </>
            )}
          </div>
        </div>

        {actionError && (
          <div className="error-strip">
            <span>{actionError}</span>
            <button title="Hide this message" onClick={() => setActionError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {exportStatus && (
          <div className="status-strip" title={exportStatus}>
            Exported to {exportStatus}
          </div>
        )}

        {importStatus && (
          <div className="status-strip" title={importStatus}>
            {importStatus}
            <button
              className="status-dismiss"
              title="Hide this message"
              onClick={() => setImportStatus(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {selectedTab === 'graph' && (
          <div className="graph-container">
            {!currentStory ? (
              <div className="empty-state">Select or create a story</div>
            ) : (
              <>
                <div className="graph-toolbar">
                  <select
                    title="The kind of node the Add button creates"
                    value={newNodeType}
                    onChange={(e) => setNewNodeType(e.target.value as NodeType)}
                  >
                    {nodeTypes.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <input
                    title="Label for the new node"
                    placeholder="Node label"
                    value={newNodeLabel}
                    onChange={(e) => setNewNodeLabel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addNewNode()}
                  />
                  <button
                    title="Add a node of the selected type to the canvas"
                    onClick={addNewNode}
                    disabled={!newNodeLabel.trim()}
                  >
                    Add Node
                  </button>
                  <button
                    className="undo-button"
                    title={`Undo the last change (${shortcutKeys.undo})`}
                    onClick={() => void undoLast()}
                    disabled={historyDepth.undo === 0}
                  >
                    Undo
                  </button>
                  <button
                    className="redo-button"
                    title={`Redo the last undone change (${shortcutKeys.redo})`}
                    onClick={() => void redoLast()}
                    disabled={historyDepth.redo === 0}
                  >
                    Redo
                  </button>
                  <button
                    className="search-button"
                    title={`Find a card, a cast member, a connection, a note or a story (${shortcutKeys.search})`}
                    onClick={() => {
                      setSearchOpen(true);
                      setSearchIndex(0);
                      setSearchKind('all');
                    }}
                  >
                    Search
                  </button>
                  <span className="hint">Drag nodes • Connect nodes by dragging from a handle</span>
                </div>
                <div className="graph-body">
                  <aside className="cast-rail" aria-label="Cast">
                    <div className="cast-rail-title">Cast</div>

                    {characters.length === 0 ? (
                      <p className="cast-rail-hint">
                        No cast yet — add someone on the Characters tab.
                      </p>
                    ) : (
                      <>
                        {characters.map(character => (
                          <div
                            key={character.id}
                            className={`cast-chip ${
                              draggingCastId === character.id ? 'dragging' : ''
                            }`}
                            draggable
                            title={`Drag ${character.name} onto the canvas`}
                            onDragStart={event => {
                              event.dataTransfer.setData(CAST_DRAG_TYPE, character.id);
                              event.dataTransfer.effectAllowed = 'copy';
                              setDraggingCastId(character.id);
                            }}
                            onDragEnd={() => {
                              setDraggingCastId(null);
                              setDropTargetNodeId(null);
                            }}
                          >
                            <span className="cast-chip-name">{character.name}</span>
                            <span className="cast-chip-stats">
                              {[
                                // A character read from an older story may have no
                                // level yet; the chip then shows only its numbers.
                                ...(character.level != null
                                  ? [`Lv ${character.level}`]
                                  : []),
                                ...(castStats[character.id] ?? [])
                                  .slice(0, NODE_STAT_BADGES)
                                  .map(stat => `${stat.stat_name} ${stat.value}`),
                              ].join(' · ')}
                            </span>
                          </div>
                        ))}
                        <p className="cast-rail-hint">
                          Drag a cast member onto the canvas to make a linked node.
                        </p>
                      </>
                    )}
                  </aside>
                  <div
                    className={`graph-canvas${draggingCastId ? ' drop-ready' : ''}`}
                    onDragOver={event => {
                      // The payload type says what is in the air even if the state
                      // update from the drag has not landed yet.
                      if (
                        !draggingCastId &&
                        !event.dataTransfer.types.includes(CAST_DRAG_TYPE)
                      ) {
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'copy';

                      const next = nodeUnderPointer(event);
                      setDropTargetNodeId(current => (current === next ? current : next));
                    }}
                    onDragLeave={event => {
                      // `Node` here is React Flow's, so the DOM node is named in full.
                      const next = event.relatedTarget as globalThis.Node | null;

                      if (!next || !event.currentTarget.contains(next)) {
                        setDropTargetNodeId(null);
                      }
                    }}
                    onDrop={dropCastMember}
                  >
                  {renderSearchPalette('overlay')}
                  <ReactFlow
                    nodes={canvasNodes}
                    edges={edges}
                    nodeTypes={flowNodeTypes}
                    onInit={instance => {
                      flowRef.current = instance;

                      // A pan asked for on another tab waited for this moment.
                      const pending = pendingPanRef.current;
                      if (pending) {
                        pendingPanRef.current = null;
                        panCanvas(pending.x, pending.y);
                      }
                    }}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onNodeDragStart={onNodeDragStart}
                    onNodeDragStop={onNodeDragStop}
                    onNodeClick={selectNode}
                    onEdgeClick={selectEdge}
                    onNodesDelete={removeNodes}
                    onEdgesDelete={removeEdges}
                    fitView
                  >
                    <Controls />
                    <Background />
                    <Panel position="top-right">
                      <div className="node-legend">
                        {nodeTypes.map(t => (
                          <span
                            key={t}
                            className={`legend ${t}`}
                            title={`${t} nodes are drawn in this colour`}
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </Panel>
                    {selectedEdgeId && (
                      <Panel position="top-left">
                        <div className="node-editor">
                          <div className="node-editor-heading">
                            Edit connection
                            {selectedEdge && (
                              <span className="edge-endpoints">
                                {nodes.find(node => node.id === selectedEdge.source)?.data.label ?? '?'}
                                {' → '}
                                {nodes.find(node => node.id === selectedEdge.target)?.data.label ?? '?'}
                              </span>
                            )}
                          </div>
                          <input
                            className="node-editor-label"
                            placeholder="Label (optional)"
                            value={edgeLabelDraft}
                            onChange={e => setEdgeLabelDraft(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveEdge();
                              if (e.key === 'Escape') setSelectedEdgeId(null);
                            }}
                          />
                          <input
                            className="node-editor-label"
                            placeholder="Relation type (optional)"
                            value={edgeRelationDraft}
                            onChange={e => setEdgeRelationDraft(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveEdge();
                              if (e.key === 'Escape') setSelectedEdgeId(null);
                            }}
                          />
                          {edgeEditError && (
                            <div className="node-editor-error">{edgeEditError}</div>
                          )}
                          <div className="node-editor-actions">
                            <button title="Save this connection's fields" onClick={saveEdge}>
                              Save
                            </button>
                            <button
                              title="Close without saving (Esc)"
                              onClick={() => setSelectedEdgeId(null)}
                            >
                              Close
                            </button>
                          </div>
                        </div>
                      </Panel>
                    )}
                  </ReactFlow>
                  </div>

                  {selectedNode && (
                    <aside className="node-drawer" aria-label="Node inspector">
                      <div className="node-drawer-head">
                        <div className="node-drawer-heading">
                          <span className="node-drawer-title">Inspector</span>
                          <span className={`legend ${selectedNode.data.nodeType}`}>
                            {selectedNode.data.nodeType}
                          </span>
                          {nodeIsDirty && (
                            <span
                              className="node-drawer-dirty"
                              role="img"
                              aria-label="Unsaved changes"
                              title="Unsaved changes"
                            />
                          )}
                        </div>
                        <button
                          className="node-drawer-close"
                          aria-label="Close inspector"
                          title="Close the inspector (Esc)"
                          onClick={closeNodeInspector}
                        >
                          ×
                        </button>
                      </div>

                      <label className="node-drawer-label" htmlFor="inspector-label">
                        Label
                      </label>
                      <input
                        id="inspector-label"
                        className="node-editor-label"
                        value={nodeLabelDraft}
                        onChange={e => {
                          const label = e.target.value;
                          setNodeLabelDraft(label);
                          if (selectedNodeId) {
                            rememberNodeDraft(selectedNodeId, {
                              label,
                              content: nodeContentDraft,
                            });
                          }
                          // Typing a label is a decision of its own, so the rename
                          // offer stops being about this node.
                          setRenameOffer(null);
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveNode();
                          if (e.key === 'Escape') closeNodeInspector();
                        }}
                      />

                      <label className="node-drawer-label" htmlFor="inspector-notes">
                        Notes
                      </label>
                      <textarea
                        id="inspector-notes"
                        className="node-editor-content"
                        placeholder="Notes for this node (optional)"
                        value={nodeContentDraft}
                        onChange={e => {
                          const content = e.target.value;
                          setNodeContentDraft(content);
                          if (selectedNodeId) {
                            rememberNodeDraft(selectedNodeId, {
                              label: nodeLabelDraft,
                              content,
                            });
                          }
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Escape') closeNodeInspector();
                        }}
                      />

                      {nodeEditError && (
                        <div className="node-editor-error">{nodeEditError}</div>
                      )}

                      <div className="node-editor-actions">
                        <button
                          title="Save the label and notes"
                          onClick={() => saveNode()}
                          disabled={!nodeLabelDraft.trim()}
                        >
                          Save
                        </button>
                        <button
                          title="Close without saving (Esc)"
                          onClick={closeNodeInspector}
                        >
                          Close
                        </button>
                      </div>

                      {closePrompt && (
                        <div
                          className="node-drawer-prompt"
                          role="alertdialog"
                          aria-label="Unsaved changes"
                        >
                          <p>Save this node's changes before closing?</p>
                          <div className="node-drawer-prompt-actions">
                            <button
                              title="Save the label and notes, then close"
                              onClick={() => saveNode(true)}
                              disabled={!nodeLabelDraft.trim()}
                            >
                              Save
                            </button>
                            <button
                              title="Close and drop these changes; the saved version stays"
                              onClick={discardNodeDraft}
                            >
                              Discard
                            </button>
                            <button
                              title="Stay here with the changes as they are"
                              onClick={() => setClosePrompt(false)}
                            >
                              Keep editing
                            </button>
                          </div>
                        </div>
                      )}

                      <label className="node-drawer-label" htmlFor="inspector-cast">
                        Cast member
                      </label>
                      <select
                        id="inspector-cast"
                        className="node-drawer-select"
                        title="Link this node to a cast member; saved as soon as you choose"
                        value={selectedNode.data.characterId ?? ''}
                        onChange={e => changeNodeCharacter(e.target.value)}
                      >
                        <option value="">Not linked</option>
                        {characters.map(character => (
                          <option key={character.id} value={character.id}>
                            {character.name}
                          </option>
                        ))}
                        {selectedNode.data.characterId &&
                          !characters.some(
                            character => character.id === selectedNode.data.characterId
                          ) && (
                            <option value={selectedNode.data.characterId}>
                              Linked cast member (not in the cast)
                            </option>
                          )}
                      </select>

                      {renameOffer && renameOffer.nodeId === selectedNode.id && (
                        <div className="node-drawer-offer" role="status">
                          <span>
                            This node was named after {renameOffer.from}. Rename it to “
                            {renameOffer.to}”?
                          </span>
                          <div className="node-drawer-offer-actions">
                            <button
                              title="Use the new cast member's name as this node's label"
                              onClick={applyRenameOffer}
                            >
                              Rename
                            </button>
                            <button
                              title="Leave the label as it is"
                              onClick={() => setRenameOffer(null)}
                            >
                              Keep label
                            </button>
                          </div>
                        </div>
                      )}

                      {selectedNode.data.characterId && (
                        <section className="node-drawer-cast" aria-label="Cast numbers">
                          {inspectorCharacter ? (
                            <>
                              <div className="node-drawer-section">
                                {inspectorCharacter.name}
                              </div>

                              {inspectorStats.map(stat => (
                                <div className="node-drawer-row" key={stat.id}>
                                  <span className="node-drawer-key">{stat.stat_name}</span>
                                  {inspectorStatId === stat.id ? (
                                    <>
                                      <input
                                        className="node-drawer-input"
                                        type="number"
                                        aria-label={`${stat.stat_name} value`}
                                        value={inspectorStatValue}
                                        autoFocus
                                        onChange={e => setInspectorStatValue(e.target.value)}
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') saveInspectorStat(stat);
                                          if (e.key === 'Escape') setInspectorStatId(null);
                                        }}
                                      />
                                      <button
                                        title={`Save this new ${stat.stat_name} value`}
                                        onClick={() => saveInspectorStat(stat)}
                                      >
                                        Save
                                      </button>
                                      <button
                                        title="Leave the value as it was"
                                        onClick={() => setInspectorStatId(null)}
                                      >
                                        Cancel
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      className="node-drawer-value"
                                      title="Change this stat"
                                      onClick={() => startInspectorStat(stat)}
                                    >
                                      {stat.value}
                                    </button>
                                  )}
                                </div>
                              ))}

                              {inspectorAttributes.map(attribute => (
                                <div className="node-drawer-row" key={attribute.id}>
                                  <span className="node-drawer-key">{attribute.attr_name}</span>
                                  {inspectorAttrId === attribute.id ? (
                                    <>
                                      <input
                                        className="node-drawer-input"
                                        aria-label={`${attribute.attr_name} value`}
                                        value={inspectorAttrValue}
                                        autoFocus
                                        onChange={e => setInspectorAttrValue(e.target.value)}
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') saveInspectorAttribute(attribute);
                                          if (e.key === 'Escape') setInspectorAttrId(null);
                                        }}
                                      />
                                      <button
                                        title={`Save this new ${attribute.attr_name} value`}
                                        onClick={() => saveInspectorAttribute(attribute)}
                                      >
                                        Save
                                      </button>
                                      <button
                                        title="Leave the value as it was"
                                        onClick={() => setInspectorAttrId(null)}
                                      >
                                        Cancel
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      className="node-drawer-value"
                                      title="Change this attribute"
                                      onClick={() => startInspectorAttribute(attribute)}
                                    >
                                      {attribute.value}
                                    </button>
                                  )}
                                </div>
                              ))}

                              {inspectorStats.length === 0 &&
                                inspectorAttributes.length === 0 && (
                                  <p className="node-drawer-hint">
                                    This cast member has no stats or attributes yet.
                                  </p>
                                )}

                              {inspectorError && (
                                <div className="node-editor-error">{inspectorError}</div>
                              )}
                            </>
                          ) : (
                            <p className="node-drawer-hint">
                              That cast member is not in this story's live cast — it is probably in
                              the trash. Restore it on the Trash tab to see its numbers here.
                            </p>
                          )}
                        </section>
                      )}
                    </aside>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {selectedTab === 'chapters' && (
          <div className="tab-content">
            {!currentStory ? (
              <div className="empty-state">Load a story to put its chapters in order</div>
            ) : (
              <div className="chapters-layout">
                {renderSearchPalette('inline')}
                <div className="chapters-header">
                  <div>
                    <h3 className="chapters-heading">Reading order</h3>
                    <p className="chapters-hint">
                      Chapter cards on the Graph tab, numbered from 1. Moving one
                      renumbers the rest. A new chapter joins the end.
                    </p>
                  </div>

                  <div className="chapter-creator">
                    <input
                      placeholder="Chapter title"
                      value={newChapterTitle}
                      onChange={(e) => setNewChapterTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void addChapter();
                      }}
                    />
                    <button
                      title="Create a chapter card at the end of the reading order"
                      onClick={() => void addChapter()}
                      disabled={!newChapterTitle.trim() || chapterBusy}
                    >
                      New chapter
                    </button>
                    <button
                      type="button"
                      className="chapter-search-button"
                      title={`Find a card, a cast member, a connection, a note or a story (${shortcutKeys.search})`}
                      onClick={() => {
                        setSearchOpen(true);
                        setSearchIndex(0);
                        setSearchKind('all');
                      }}
                    >
                      Search
                    </button>
                  </div>
                </div>

                {chapterError && <div className="audit-error">{chapterError}</div>}

                {(chapterIssues.duplicates.length > 0 ||
                  chapterIssues.missing.length > 0 ||
                  chapterIssues.unnumbered > 0) && (
                  <div className="chapter-warning">
                    <span>{describeChapterIssues(chapterIssues)}</span>
                    <button
                      title="Number the chapters one after another in the order shown"
                      onClick={renumberChapters}
                      disabled={chapterBusy}
                    >
                      Renumber
                    </button>
                  </div>
                )}

                {chapterNodes.length === 0 ? (
                  <div className="empty">
                    No chapters yet — add one here, or add a chapter card on the Graph tab.
                  </div>
                ) : (
                  <>
                    <div className="chapter-totals">
                      <div className="chapter-totals-head">
                        <span className="chapter-totals-count">
                          {formatCount(chapterTotals.words)}{' '}
                          {chapterTotals.words === 1 ? 'word' : 'words'}
                          {chapterTotals.target != null &&
                            ` of ${formatCount(chapterTotals.target)}`}
                        </span>
                        <span className="chapter-totals-note">
                          {chapterNodes.length} chapter
                          {chapterNodes.length === 1 ? '' : 's'}
                          {chapterTotals.target != null &&
                          chapterTotals.targeted < chapterNodes.length
                            ? ` · ${chapterTotals.targeted} with a target`
                            : ''}
                        </span>
                      </div>

                      {chapterTotals.target != null && (
                        <div
                          className="chapter-total-bar"
                          role="progressbar"
                          aria-label="Story word count"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={chapterWordsPercent}
                        >
                          <div
                            className="chapter-total-fill"
                            style={{ width: `${chapterWordsPercent}%` }}
                          />
                        </div>
                      )}
                    </div>

                    <ol className="chapter-list" aria-label="Chapters">
                      {chapterNodes.map((node, index) => (
                        <li
                          key={node.id}
                          className={
                            revealedChapterId === node.id
                              ? 'chapter-row chapter-row-revealed'
                              : 'chapter-row'
                          }
                          data-chapter-id={node.id}
                        >
                          <div className="chapter-row-main">
                            <span className="chapter-number">
                              {node.data.chapterSeq ?? '—'}
                            </span>
                            <span className="chapter-label">{node.data.label}</span>
                            {node.data.chapterArc && (
                              <span className="chapter-arc" title="Arc">
                                {node.data.chapterArc}
                              </span>
                            )}
                            {node.data.chapterPov && (
                              <span className="chapter-pov" title="Point of view">
                                {castNames.get(node.data.chapterPov) ??
                                  'cast member in the trash'}
                              </span>
                            )}
                            {node.data.chapterDay != null && (
                              <span className="chapter-day" title="In-world day">
                                Day {node.data.chapterDay}
                              </span>
                            )}
                            {node.data.chapterTime && (
                              <span className="chapter-time" title="Time of day">
                                {node.data.chapterTime}
                              </span>
                            )}
                            <span className="chapter-words">
                              {formatChapterWords(
                                node.data.chapterWords,
                                node.data.chapterTarget
                              )}
                            </span>
                            <button
                              aria-label={`Edit ${node.data.label} details`}
                              title="Set the arc, the day, the time and the word count"
                              onClick={() => openChapterDetails(node)}
                              disabled={chapterBusy}
                            >
                              Edit
                            </button>
                            <button
                              aria-label={`Notes for ${node.data.label}`}
                              title="Plain-text notes kept with this chapter"
                              onClick={() => toggleChapterNotes(node.id)}
                              disabled={chapterBusy}
                            >
                              {noteCount(node.id) > 0
                                ? `Notes (${noteCount(node.id)})`
                                : 'Notes'}
                            </button>
                            <button
                              aria-label={`Move ${node.data.label} earlier`}
                              title="Move this chapter one place earlier"
                              onClick={() => moveChapter(node.id, -1)}
                              disabled={index === 0 || chapterBusy}
                            >
                              ↑
                            </button>
                            <button
                              aria-label={`Move ${node.data.label} later`}
                              title="Move this chapter one place later"
                              onClick={() => moveChapter(node.id, 1)}
                              disabled={index === chapterNodes.length - 1 || chapterBusy}
                            >
                              ↓
                            </button>
                          </div>

                          {editingChapterId === node.id && (
                            <div className="chapter-details-form">
                              <label>
                                Arc
                                <input
                                  ref={chapterArcInputRef}
                                  autoFocus
                                  placeholder="No arc"
                                  value={chapterArcDraft}
                                  onChange={(e) => setChapterArcDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') void saveChapterDetails();
                                    if (e.key === 'Escape') requestChapterClose();
                                  }}
                                />
                              </label>
                              <label>
                                Words
                                <input
                                  type="number"
                                  min={0}
                                  placeholder="0"
                                  value={chapterWordsDraft}
                                  onChange={(e) => setChapterWordsDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') void saveChapterDetails();
                                    if (e.key === 'Escape') requestChapterClose();
                                  }}
                                />
                              </label>
                              <label>
                                Target
                                <input
                                  type="number"
                                  min={1}
                                  placeholder="None"
                                  value={chapterTargetDraft}
                                  onChange={(e) => setChapterTargetDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') void saveChapterDetails();
                                    if (e.key === 'Escape') requestChapterClose();
                                  }}
                                />
                              </label>
                              <label>
                                POV
                                <select
                                  title="Whose point of view the chapter is told from"
                                  value={chapterPovDraft}
                                  onChange={(e) => setChapterPovDraft(e.target.value)}
                                >
                                  <option value="">No POV</option>
                                  {/* A POV whose cast member is in the trash is
                                      kept and shown, not silently dropped. */}
                                  {chapterPovDraft && !castNames.has(chapterPovDraft) && (
                                    <option value={chapterPovDraft}>
                                      Cast member in the trash
                                    </option>
                                  )}
                                  {characters.map(character => (
                                    <option key={character.id} value={character.id}>
                                      {character.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                Day
                                <input
                                  type="number"
                                  min={0}
                                  placeholder="Not placed"
                                  value={chapterDayDraft}
                                  onChange={(e) => setChapterDayDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') void saveChapterDetails();
                                    if (e.key === 'Escape') requestChapterClose();
                                  }}
                                />
                              </label>
                              <label>
                                Time
                                <input
                                  placeholder="Dusk"
                                  title="When inside the day, in your own words: Dusk, 18:40, after the fire"
                                  value={chapterTimeDraft}
                                  onChange={(e) => setChapterTimeDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') void saveChapterDetails();
                                    if (e.key === 'Escape') requestChapterClose();
                                  }}
                                />
                              </label>
                              <div className="chapter-details-actions">
                                <button
                                  title="Save the arc, the day, the time and the word counts"
                                  onClick={() => void saveChapterDetails()}
                                  disabled={chapterBusy}
                                >
                                  Save
                                </button>
                                <button
                                  title="Leave this chapter as it was"
                                  onClick={requestChapterClose}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}

                          {editingChapterId === node.id && chapterFormPrompt && (
                            <div
                              className="chapter-details-prompt"
                              role="alertdialog"
                              aria-label="Unsaved chapter changes"
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.stopPropagation();
                                  dismissChapterPrompt();
                                }
                              }}
                            >
                              <p>
                                {chapterFormPrompt.kind === 'open'
                                  ? `Open “${
                                      chapterNodes.find(
                                        candidate => candidate.id === chapterFormPrompt.id
                                      )?.data.label ?? 'another chapter'
                                    }” and drop these changes?`
                                  : chapterFormPrompt.kind === 'close'
                                    ? 'Close this chapter and drop these changes?'
                                    : chapterFormPrompt.message}
                              </p>
                              <div className="chapter-details-prompt-actions">
                                {chapterFormPrompt.kind === 'open' ? (
                                  <button
                                    title="Open the other chapter and lose these edits"
                                    onClick={discardChapterEdit}
                                  >
                                    Discard and open
                                  </button>
                                ) : chapterFormPrompt.kind === 'close' ? (
                                  <button
                                    title="Close the form and lose these edits"
                                    onClick={closeChapterForm}
                                  >
                                    Discard changes
                                  </button>
                                ) : (
                                  <button
                                    title="Leave this chapter and lose these edits"
                                    onClick={leaveChapterForm}
                                  >
                                    Discard and continue
                                  </button>
                                )}
                                <button
                                  ref={chapterKeepEditingRef}
                                  title="Stay on this chapter with the edits as they are"
                                  onClick={dismissChapterPrompt}
                                >
                                  Keep editing
                                </button>
                              </div>
                            </div>
                          )}

                          {openNotesChapterId === node.id && (
                            <div
                              className="chapter-notes"
                              onKeyDown={(e) => {
                                // Escape is how the question is dismissed, wherever
                                // the focus was left when it appeared.
                                if (e.key === 'Escape' && notePrompt) {
                                  e.stopPropagation();
                                  dismissNotePrompt();
                                }
                              }}
                            >
                              {notePrompt && (
                                <div
                                  className="chapter-details-prompt"
                                  role="alertdialog"
                                  aria-label="Unsaved note changes"
                                >
                                  <p>{notePrompt.message}</p>
                                  <div className="chapter-details-prompt-actions">
                                    <button
                                      title="Drop this note and continue"
                                      onClick={discardNoteDraft}
                                    >
                                      Discard and continue
                                    </button>
                                    <button
                                      ref={noteKeepEditingRef}
                                      title="Stay with the note as it is"
                                      onClick={dismissNotePrompt}
                                    >
                                      Keep editing
                                    </button>
                                  </div>
                                </div>
                              )}

                              {(notesByChapter.get(node.id) ?? []).map(note =>
                                editingNoteId === note.id ? (
                                  <div
                                    key={note.id}
                                    className={`chapter-note${
                                      note.id === matchedNoteId ? ' matched' : ''
                                    }`}
                                  >
                                    <textarea
                                      ref={noteEditorRef}
                                      className="chapter-note-editor"
                                      aria-label={`Edit note in ${node.data.label}`}
                                      autoFocus
                                      value={noteEditDraft}
                                      onChange={(e) => setNoteEditDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Escape') requestNoteEditCancel();
                                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                          void saveNoteEdit();
                                        }
                                      }}
                                    />
                                    <div className="chapter-note-actions">
                                      <button
                                        title="Save this note (Ctrl+Enter)"
                                        onClick={() => void saveNoteEdit()}
                                        disabled={noteBusy}
                                      >
                                        Save
                                      </button>
                                      <button
                                        title="Leave the note as it was"
                                        onClick={requestNoteEditCancel}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div
                                    key={note.id}
                                    className={`chapter-note${
                                      note.id === matchedNoteId ? ' matched' : ''
                                    }`}
                                  >
                                    <div className="chapter-note-text">{note.text}</div>
                                    <div className="chapter-note-actions">
                                      <button
                                        aria-label={`Edit the note ${note.text.split('\n')[0]}`}
                                        title="Edit this note"
                                        onClick={() => startNoteEdit(note)}
                                        disabled={noteBusy}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        aria-label={`Delete the note ${note.text.split('\n')[0]}`}
                                        title="Move this note to the trash"
                                        onClick={() => void deleteNote(note)}
                                        disabled={noteBusy}
                                      >
                                        Delete
                                      </button>
                                    </div>
                                  </div>
                                )
                              )}

                              {noteCount(node.id) === 0 && (
                                <div className="chapter-notes-empty">
                                  No notes yet — a note is plain text, kept with the
                                  chapter.
                                </div>
                              )}

                              {editingNoteId === null && (
                                <div className="chapter-note-add">
                                  <textarea
                                    ref={noteAddRef}
                                    aria-label={`New note for ${node.data.label}`}
                                    placeholder="A note for this chapter"
                                    title="Ctrl+Enter adds the note"
                                    value={noteDraft}
                                    onChange={(e) => setNoteDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                        void addNote(node.id);
                                      }
                                    }}
                                  />
                                  <button
                                    title="Add this note to the chapter"
                                    onClick={() => void addNote(node.id)}
                                    disabled={noteBusy || !noteDraft.trim()}
                                  >
                                    Add note
                                  </button>
                                </div>
                              )}

                              {noteError && (
                                <div className="chapter-note-error">{noteError}</div>
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>

                    <section
                      className="chapter-timeline"
                      aria-labelledby="chapter-timeline-heading"
                    >
                      <div className="chapter-timeline-head">
                        <h3 id="chapter-timeline-heading">Timeline</h3>
                        <span className="chapter-timeline-note">
                          {chapterTimeline.length} placed
                          {chapterTimeline.length < chapterNodes.length &&
                            ` · ${chapterNodes.length - chapterTimeline.length} without a day`}
                        </span>
                      </div>

                      {chapterTimeline.length === 0 ? (
                        <p className="chapters-hint">
                          Give a chapter an in-world day to place it on the timeline.
                        </p>
                      ) : (
                        <ol className="chapter-timeline-list" aria-label="Chapter timeline">
                          {chapterTimeline.map(node => (
                            <li key={node.id} className="chapter-timeline-row">
                              <span className="chapter-timeline-day">
                                Day {node.data.chapterDay}
                              </span>
                              {node.data.chapterTime && (
                                <span className="chapter-timeline-time">
                                  {node.data.chapterTime}
                                </span>
                              )}
                              {node.data.chapterSeq != null && (
                                <span className="chapter-timeline-seq">
                                  #{node.data.chapterSeq}
                                </span>
                              )}
                              <span className="chapter-timeline-label">
                                {node.data.label}
                              </span>
                              {node.data.chapterPov && (
                                <span className="chapter-timeline-pov">
                                  {castNames.get(node.data.chapterPov) ??
                                    'cast member in the trash'}
                                </span>
                              )}
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>

                    {chapterContinuity.length > 0 && (
                      <section
                        className="chapter-continuity"
                        aria-labelledby="chapter-continuity-heading"
                      >
                        <div className="chapter-continuity-head">
                          <h3 id="chapter-continuity-heading">Continuity</h3>
                          <span className="chapter-continuity-note">
                            {chapterContinuity.length} to check · advisory
                          </span>
                        </div>
                        <ul>
                          {chapterContinuity.map((parts, index) => (
                            <li
                              key={`${index}-${parts
                                .map(part => (typeof part === 'string' ? part : part.text))
                                .join('')}`}
                            >
                              {parts.map((part, partIndex) =>
                                typeof part === 'string' ? (
                                  <React.Fragment key={partIndex}>{part}</React.Fragment>
                                ) : (
                                  <button
                                    key={partIndex}
                                    type="button"
                                    className="chapter-continuity-link"
                                    title="Open this chapter's details"
                                    onClick={() => revealChapter(part.id)}
                                  >
                                    {part.text}
                                  </button>
                                )
                              )}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {selectedTab === 'characters' && (
          <div className="tab-content">
            {!currentStory ? (
              <div className="empty-state">Load a story to manage characters</div>
            ) : (
              <div className="characters-layout">
                <div className="character-list">
                  <div className="character-creator">
                    <input
                      placeholder="Character name"
                      value={newCharacterName}
                      onChange={(e) => setNewCharacterName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && createCharacter()}
                    />
                    <input
                      placeholder="Description (optional)"
                      value={newCharacterDescription}
                      onChange={(e) => setNewCharacterDescription(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && createCharacter()}
                    />
                    <button
                      title="Add this character to the story's cast"
                      onClick={createCharacter}
                      disabled={!newCharacterName.trim()}
                    >
                      Add character
                    </button>
                  </div>

                  {characters.length === 0 && <div className="empty">No characters yet</div>}

                  {characters.map(character => (
                    <div
                      key={character.id}
                      data-character-id={character.id}
                      className={`character-item ${
                        selectedCharacterId === character.id ? 'active' : ''
                      }`}
                      title={`Show ${character.name}'s sheet`}
                      onClick={() => {
                        setSelectedCharacterId(character.id);
                        setEditingProgress(false);
                      }}
                    >
                      <span className="character-name">{character.name}</span>
                      <span className="character-level">
                        Level {character.level ?? 1}
                        {character.rank ? ` · ${character.rank}` : ''}
                      </span>
                      {character.description && (
                        <span className="character-description">{character.description}</span>
                      )}
                    </div>
                  ))}
                </div>

                <div className="character-detail">
                  {characterError && <div className="audit-error">{characterError}</div>}

                  {!selectedCharacterId ? (
                    <div className="empty">Select or create a character</div>
                  ) : (
                    <>
                      <div className="character-header">
                        {editingCharacter ? (
                          <div className="character-editor">
                            <input
                              className="character-name-input"
                              autoFocus
                              value={characterNameDraft}
                              onChange={(e) => setCharacterNameDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveCharacter();
                                if (e.key === 'Escape') setEditingCharacter(false);
                              }}
                            />
                            <input
                              placeholder="Description (optional)"
                              value={characterDescriptionDraft}
                              onChange={(e) => setCharacterDescriptionDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveCharacter();
                                if (e.key === 'Escape') setEditingCharacter(false);
                              }}
                            />
                            <button
                              title="Save this character's name and description"
                              onClick={saveCharacter}
                              disabled={!characterNameDraft.trim()}
                            >
                              Save
                            </button>
                            <button
                              title="Discard the edit"
                              onClick={() => setEditingCharacter(false)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="character-title">
                              <h3 className="character-heading">
                                {selectedCharacter?.name ?? 'Character'}
                              </h3>
                              {selectedCharacter?.description && (
                                <div className="character-subheading">
                                  {selectedCharacter.description}
                                </div>
                              )}
                            </div>
                            <div className="character-actions">
                              {confirmDeleteCharacter ? (
                                <>
                                  <button
                                    className="danger"
                                    title="Move this character to the trash; linked nodes keep their links"
                                    onClick={removeCharacter}
                                  >
                                    Delete
                                  </button>
                                  <button
                                    title="Keep this character"
                                    onClick={() => setConfirmDeleteCharacter(false)}
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    title="Change this character's name or description"
                                    onClick={startCharacterEdit}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    title="Delete character"
                                    onClick={() => setConfirmDeleteCharacter(true)}
                                  >
                                    Delete
                                  </button>
                                </>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      <section className="progress-section" aria-label="Progression">
                        <div className="progress-head">
                          <h4 className="character-section-heading">Progression</h4>
                          <span className="progress-rank">
                            {selectedCharacter?.rank || 'Unranked'}
                          </span>
                        </div>

                        <div className="progress-stats">
                          <div className="progress-stat">
                            <span className="progress-stat-label">Level</span>
                            <span className="progress-stat-value">{shownLevel}</span>
                          </div>
                          <div className="progress-stat">
                            <span className="progress-stat-label">Experience</span>
                            <span className="progress-stat-value">
                              {shownTarget ? `${shownXp} / ${shownTarget}` : shownXp}
                            </span>
                          </div>
                        </div>

                        <div
                          className="progress-bar"
                          role="progressbar"
                          aria-label="Progress to the next level"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={progressPercent}
                        >
                          <div
                            className="progress-bar-fill"
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>

                        <div className="progress-caption">
                          {shownTarget
                            ? `${Math.max(0, shownTarget - shownXp)} XP to level ${shownLevel + 1}`
                            : 'No target set — edit progression to show a bar.'}
                        </div>

                        {editingProgress ? (
                          <div className="progress-form">
                            <label>
                              Level
                              <input
                                type="number"
                                min={1}
                                autoFocus
                                value={progressLevelDraft}
                                onChange={(e) => setProgressLevelDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveProgress();
                                  if (e.key === 'Escape') setEditingProgress(false);
                                }}
                              />
                            </label>
                            <label>
                              Experience
                              <input
                                type="number"
                                min={0}
                                value={progressXpDraft}
                                onChange={(e) => setProgressXpDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveProgress();
                                  if (e.key === 'Escape') setEditingProgress(false);
                                }}
                              />
                            </label>
                            <label>
                              XP to next
                              <input
                                type="number"
                                min={1}
                                placeholder="None"
                                value={progressTargetDraft}
                                onChange={(e) => setProgressTargetDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveProgress();
                                  if (e.key === 'Escape') setEditingProgress(false);
                                }}
                              />
                            </label>
                            <label>
                              Rank
                              <input
                                placeholder="Unranked"
                                value={progressRankDraft}
                                onChange={(e) => setProgressRankDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveProgress();
                                  if (e.key === 'Escape') setEditingProgress(false);
                                }}
                              />
                            </label>
                            <div className="progress-actions">
                              <button
                                title="Save level, experience, rank and the next-level target"
                                onClick={saveProgress}
                              >
                                Save
                              </button>
                              <button
                                title="Leave the progression as it was"
                                onClick={() => setEditingProgress(false)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="progress-actions">
                            <button
                              title="Add one level, recorded as a level-up in the audit log"
                              onClick={levelUpCharacter}
                            >
                              Level up
                            </button>
                            <button
                              title="Type the level, experience, rank and XP target directly"
                              onClick={startProgressEdit}
                            >
                              Edit progression
                            </button>
                          </div>
                        )}
                      </section>

                      <div className="attribute-section">
                        <h4 className="character-section-heading">Attributes</h4>

                        <div className="attribute-list">
                          {characterAttributes.length === 0 && (
                            <div className="empty">
                              No attributes yet — Class, Title, Aura, Affinity.
                            </div>
                          )}

                          {characterAttributes.map(attribute => (
                            <div key={attribute.id} className="attribute-row">
                              <span className="attribute-name">{attribute.attr_name}</span>

                              {editingAttributeId === attribute.id ? (
                                <>
                                  <input
                                    className="attribute-value-input"
                                    autoFocus
                                    value={attributeValueDraft}
                                    onChange={(e) => setAttributeValueDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') saveAttribute(attribute);
                                      if (e.key === 'Escape') setEditingAttributeId(null);
                                    }}
                                  />
                                  <button
                                    title={`Save this new ${attribute.attr_name} value`}
                                    onClick={() => saveAttribute(attribute)}
                                  >
                                    Save
                                  </button>
                                  <button
                                    title="Leave the value as it was"
                                    onClick={() => setEditingAttributeId(null)}
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <span className="attribute-value">{attribute.value}</span>
                                  <button
                                    title={`Change this ${attribute.attr_name} value`}
                                    onClick={() => startAttributeEdit(attribute)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    title={`Delete ${attribute.attr_name}`}
                                    onClick={() => removeAttribute(attribute)}
                                  >
                                    Delete
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>

                        <div className="attribute-creator">
                          <input
                            placeholder="Attribute (Class)"
                            value={newAttributeName}
                            onChange={(e) => setNewAttributeName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addAttribute()}
                          />
                          <input
                            className="attribute-value-input"
                            placeholder="Value (Rogue)"
                            value={newAttributeValue}
                            onChange={(e) => setNewAttributeValue(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addAttribute()}
                          />
                          <button
                            title="Add this attribute, or update it if the name already exists"
                            onClick={addAttribute}
                            disabled={!newAttributeName.trim() || !newAttributeValue.trim()}
                          >
                            Add attribute
                          </button>
                        </div>
                      </div>

                      <div className="stat-list">
                        {characterStats.length === 0 && (
                          <div className="empty">No stats yet — add one below.</div>
                        )}

                        {characterStats.map(stat => (
                          <div key={stat.id} className="stat-row">
                            <span className="stat-name">{stat.stat_name}</span>

                            {editingStatId === stat.id ? (
                              <>
                                <input
                                  className="stat-value-input"
                                  type="number"
                                  autoFocus
                                  value={statValueDraft}
                                  onChange={(e) => setStatValueDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveStat(stat);
                                    if (e.key === 'Escape') setEditingStatId(null);
                                  }}
                                />
                                <input
                                  className="stat-notes-input"
                                  placeholder="Notes (optional)"
                                  value={statNotesDraft}
                                  onChange={(e) => setStatNotesDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveStat(stat);
                                    if (e.key === 'Escape') setEditingStatId(null);
                                  }}
                                />
                                <button
                                  title={`Save this new ${stat.stat_name} value and notes`}
                                  onClick={() => saveStat(stat)}
                                >
                                  Save
                                </button>
                                <button
                                  title="Leave the value as it was"
                                  onClick={() => setEditingStatId(null)}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <span className="stat-value">{stat.value}</span>
                                {stat.notes && <span className="stat-notes">{stat.notes}</span>}
                                <button
                                  title={`Change this ${stat.stat_name} value or notes`}
                                  onClick={() => startStatEdit(stat)}
                                >
                                  Edit
                                </button>
                              </>
                            )}
                          </div>
                        ))}
                      </div>

                      <div className="stat-creator">
                        <input
                          placeholder="Stat name"
                          value={newStatName}
                          onChange={(e) => setNewStatName(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && addStat()}
                        />
                        <input
                          className="stat-value-input"
                          type="number"
                          placeholder="0"
                          value={newStatValue}
                          onChange={(e) => setNewStatValue(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && addStat()}
                        />
                        <button
                          title="Add this stat, or update it if the name already exists"
                          onClick={addStat}
                          disabled={!newStatName.trim()}
                        >
                          Add stat
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {selectedTab === 'trash' && (
          <div className="tab-content">
            <div className="trash-intro">
              Deleting a story, character, node or connection puts it here instead of
              destroying it. Restoring brings it back exactly as it was.
            </div>

            {trashError && (
              <div className="audit-error">Could not use the trash: {trashError}</div>
            )}

            {trashNotice && (
              <div className="status-strip">
                {trashNotice}
                <button
                  className="status-dismiss"
                  title="Hide this message"
                  onClick={() => setTrashNotice(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="trash-retention">
              <label htmlFor="trash-retention">Keep deleted items for</label>
              <select
                id="trash-retention"
                title="How long deleted items are kept before they are removed for good"
                value={retentionDays === null ? 'forever' : String(retentionDays)}
                onChange={event => changeRetention(event.target.value)}
              >
                {retentionOptions.map(choice => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
              <span className="hint">
                Older items are removed when the app starts, and as soon as you shorten
                this window.
              </span>
            </div>

            {trashLoading ? (
              <div className="empty">Loading the trash…</div>
            ) : (
              <>
                <div className="trash-section">
                  <h4 className="character-section-heading">Deleted stories</h4>

                  {deletedStories.length === 0 ? (
                    <div className="empty">No stories in the trash.</div>
                  ) : (
                    <ul className="trash-list" aria-label="Deleted stories">
                      {deletedStories.map(item => renderTrashItem(item))}
                    </ul>
                  )}
                </div>

                <div className="trash-section">
                  <h4 className="character-section-heading">
                    {currentStory ? `Deleted from “${currentStory.title}”` : 'Deleted items'}
                  </h4>

                  {!currentStory ? (
                    <div className="empty">Select a story to see what was deleted from it.</div>
                  ) : trash.length === 0 ? (
                    <div className="empty">Nothing deleted from this story.</div>
                  ) : (
                    <ul className="trash-list" aria-label="Deleted from this story">
                      {trash.map(item => renderTrashItem(item))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {selectedTab === 'audit' && (
          <div className="tab-content">
            {!currentStory ? (
              <div className="empty-state">Load a story to see history</div>
            ) : (
              <>
                <div
                  className="audit-filters"
                  role="group"
                  aria-label="Filter history by what changed"
                >
                  {auditFilters.map(filter => (
                    <button
                      key={filter.value ?? 'all'}
                      className={
                        auditFilter === filter.value ? 'audit-filter active' : 'audit-filter'
                      }
                      aria-pressed={auditFilter === filter.value}
                      title={
                        filter.value
                          ? `Show only ${filter.label.toLowerCase()} changes`
                          : 'Show every kind of change'
                      }
                      onClick={() => setAuditFilter(filter.value)}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>

                {auditError && (
                  <div className="audit-error">
                    Could not load history for this story: {auditError}
                  </div>
                )}

                {revertError && (
                  <div className="audit-error">
                    Cannot revert that change: {revertError}{' '}
                    <button
                      className="status-dismiss"
                      title="Hide this message"
                      onClick={() => setRevertError(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {revertNotice && (
                  <div className="status-strip">
                    {revertNotice}
                    <button
                      className="status-dismiss"
                      title="Hide this message"
                      onClick={() => setRevertNotice(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {auditLoading ? (
                  <div className="empty">Loading history…</div>
                ) : auditEntries.length === 0 ? (
                  auditError ? null : (
                    <div className="empty">
                      {auditFilter
                        ? 'No changes of this kind recorded yet.'
                        : 'No changes recorded yet. Edits to this story will show up here, newest first.'}
                    </div>
                  )
                ) : (
                  <>
                    <div className="audit-summary">
                      Showing {auditEntries.length} of {auditTotal}{' '}
                      {auditTotal === 1 ? 'change' : 'changes'}
                    </div>

                    <ol className="audit-list" aria-label="Change history">
                      {auditEntries.map(entry => (
                        <li key={entry.id} className="audit-entry">
                          <div className="audit-row">
                            <span className={`audit-badge ${entry.action}`}>
                              {actionLabels[entry.action] ?? entry.action}
                            </span>
                            <span className="audit-entity">{entityLabel(entry)}</span>
                            <span className="audit-when">
                              {entry.changed_by} · {formatWhen(entry.changed_at)}
                            </span>
                          </div>
                          <AuditChange
                            entry={entry}
                            onRevert={revertChange}
                            busy={revertBusyId}
                          />
                        </li>
                      ))}
                    </ol>

                    {auditEntries.length < auditTotal && (
                      <button
                        className="audit-more"
                        title="Load the next page of changes"
                        onClick={loadMoreAudit}
                        disabled={auditLoadingMore}
                      >
                        {auditLoadingMore
                          ? 'Loading…'
                          : `Show older changes (${auditTotal - auditEntries.length} more)`}
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {quitPrompt && (
        <div className="shortcuts-backdrop" role="presentation">
          <div
            className="quit-prompt"
            role="alertdialog"
            aria-modal="true"
            aria-label="Unsaved changes before quitting"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                dismissQuitPrompt();
              }
            }}
          >
            <h2>Quit without saving?</h2>
            <p>
              Your chapter or note edits have not been saved. Quitting now drops
              them.
            </p>
            <div className="quit-prompt-actions">
              <button
                title="Close the window and lose these edits"
                onClick={quitWithoutSaving}
              >
                Quit without saving
              </button>
              <button
                ref={quitKeepWorkingRef}
                title="Stay in the app with these edits as they are"
                onClick={dismissQuitPrompt}
              >
                Keep working
              </button>
            </div>
          </div>
        </div>
      )}

      {shortcutsOpen && (
        <div
          className="shortcuts-backdrop"
          role="presentation"
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            className="shortcuts"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            onClick={event => event.stopPropagation()}
          >
            <div className="shortcuts-head">
              <h2>Keyboard shortcuts</h2>
              <button
                className="shortcuts-close"
                aria-label="Close shortcuts"
                title="Close this list (Esc)"
                onClick={() => setShortcutsOpen(false)}
              >
                ×
              </button>
            </div>

            <p className="shortcuts-intro">
              Everything here also works by clicking. These are the routes that save a
              trip to the mouse; on a Mac, use ⌘ wherever Ctrl is shown.
            </p>

            <div className="shortcuts-groups">
              {shortcutGroups.map(group => (
                <section key={group.title} className="shortcuts-group">
                  <h3>{group.title}</h3>
                  <dl>
                    {group.keys.map(entry => (
                      <div
                        key={`${group.title}:${entry.keys}:${entry.action}`}
                        className="shortcuts-row"
                      >
                        <dt>
                          <kbd>{entry.keys}</kbd>
                        </dt>
                        <dd>{entry.action}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>

            <p className="shortcuts-hint">
              Press {shortcutKeys.help} any time to bring this list back.
            </p>
          </div>
        </div>
      )}

      {backupsOpen && (
        <div
          className="shortcuts-backdrop"
          role="presentation"
          onClick={() => !restoringFile && setBackupsOpen(false)}
        >
          <div
            className="backups"
            role="dialog"
            aria-modal="true"
            aria-label="Backups"
            onClick={event => event.stopPropagation()}
          >
            <div className="shortcuts-head">
              <h2>Backups</h2>
              <button
                className="shortcuts-close"
                aria-label="Close backups"
                title="Close this dialog (Esc)"
                onClick={() => setBackupsOpen(false)}
              >
                ×
              </button>
            </div>

            <p className="shortcuts-intro">
              A copy of the whole database is written each time the app starts, and the
              newest ten are kept. Restoring one replaces every story in this window;
              the state it replaces is copied first, so a restore can be walked back
              from this same list.
            </p>

            {backupsLoading && <p className="backups-empty">Reading the backups…</p>}

            {backupsError && (
              <div className="backups-error" role="alert">
                {backupsError}
              </div>
            )}

            {!backupsLoading && !backupsError && backups.length === 0 && (
              <p className="backups-empty">
                No copies yet. One is written each time the app starts.
              </p>
            )}

            {backups.length > 0 && (
              <ul className="backup-list" aria-label="Database backups">
                {backups.map(backup => (
                  <li key={backup.file_name} className="backup-item">
                    <div className="backup-when">
                      {formatWhen(backup.created_at)}
                      <span className="backup-meta">
                        {formatBytes(backup.size_bytes)} · {backup.file_name}
                      </span>
                    </div>

                    {confirmRestore === backup.file_name ? (
                      <div className="backup-confirm">
                        <span>Replace everything with this copy?</span>
                        <button
                          title="Replace the database with this copy; a copy of what is here now is taken first"
                          onClick={() => void restoreBackup(backup)}
                          disabled={restoringFile !== null}
                        >
                          {restoringFile === backup.file_name
                            ? 'Restoring…'
                            : 'Restore this copy'}
                        </button>
                        <button
                          title="Keep the current data"
                          onClick={() => setConfirmRestore(null)}
                          disabled={restoringFile !== null}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        title={`Replace the database with the copy from ${formatWhen(
                          backup.created_at
                        )}`}
                        onClick={() => setConfirmRestore(backup.file_name)}
                        disabled={restoringFile !== null}
                      >
                        Restore
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;