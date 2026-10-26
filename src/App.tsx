import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useId,
} from 'react';
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
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
// Every database command goes through one of these, so the command string and
// the row it answers with are named in one place instead of at each call site.
import * as auditApi from './domains/audit/api';
import * as canvasApi from './domains/canvas/api';
import * as charactersApi from './domains/characters/api';
import * as inventoryApi from './domains/inventory/api';
import * as narrativeApi from './domains/narrative/api';
import {
  CHAPTER_DRAG_TYPE,
  castBadgesByChapter,
  describeNumberingIssues,
  formatChapterWords,
  groupNotesByChapter,
  liveChapters,
  numberingIssues,
  sumChapterWords,
  timelineOrder,
  timeOfDay,
  wordTargetPercent,
} from './domains/narrative/chapters';
import * as progressionApi from './domains/progression/api';
import * as questsApi from './domains/quests/api';
import * as relationsApi from './domains/relations/api';
import * as skillsApi from './domains/skills/api';
import * as storiesApi from './domains/stories/api';
import * as trashApi from './domains/trash/api';
import { CharacterViewToggle } from './components/CharacterViewToggle';
import { HelpTip, placeTooltip } from './components/HelpTip';
import { SuggestionInput } from './components/SuggestionInput';
import { AuditPanel } from './domains/audit/AuditPanel';
import { ChaptersPanel } from './domains/narrative/ChaptersPanel';
import { QuestLedgerPanel } from './domains/quests/QuestLedgerPanel';
import { questsByChapter } from './domains/quests/ledger';
import type { CharacterAttribute } from './domains/characters/types';
import { flowNodeTypes } from './domains/canvas/GraphNode';
import { nodeTypes, NODE_STAT_BADGES } from './domains/canvas/types';
import type {
  ChapterCastBadge,
  IndexedEdge,
  IndexedNode,
  NodeData,
  NodeType,
} from './domains/canvas/types';
import type { CharacterCurrency, InventoryItem } from './domains/inventory/types';
import type {
  ChapterCastMember,
  ChapterCastState,
  CharacterChapterState,
} from './domains/narrative/types';
import { ProgressionChart } from './domains/progression/ProgressionChart';
import {
  milestoneLabel,
  milestoneStatChanges,
  statChangeText,
} from './domains/progression/helpers';
import type { ProgressionChartSeries, ProgressionMetric } from './domains/progression/types';
import type { Quest, QuestWarning } from './domains/quests/types';
import { RelationsMap } from './domains/relations/RelationsMap';
import { SkillsSection } from './domains/skills/SkillsSection';
import type { SkillDraft, SkillEventDraft } from './domains/skills/SkillsSection';
import { SkillTreeView } from './domains/skills/SkillTreeView';
import type { CharacterSkillEvent, SkillEvolutionInput } from './domains/skills/types';
import type {
  ChapterContinuityFlag,
  ContinuityPart,
  ProgressionTarget,
} from './domains/shared/types';
import type {
  ChapterNote,
  Character,
  CharacterChapterSkill,
  CharacterLevelMilestone,
  CharacterProgress,
  CharacterRelation,
  CharacterSkill,
  CharacterStat,
  FactionStanding,
  InventoryHolder,
  SkillEvolution,
  SkillHolder,
} from './domains/shared/types';
import type { BackupInfo, Story } from './domains/stories/types';
import type { DeletedItem } from './domains/trash/types';
import { formatCount, formatWhen } from './lib/format';
// Re-exported where the guide test has always imported it from.
export { placeTooltip };

interface LevelStatChangeDraft {
  statName: string;
  amount: string;
  valueAfter: string;
}

type EdgeData = { label?: string; relationType?: string; createdBy: string };

// Suggested relation types for a connection. The field stays free text, because
// a story's own verbs matter more than a fixed list.
const relationTypes = ['unlocks', 'requires', 'rewards'] as const;

// The bond kinds a sheet suggests. Like a connection's verbs these are only
// suggestions: the field keeps whatever word the author types.
const relationKindSuggestions = ['ally', 'rival', 'mentor', 'family', 'enemy', 'owes'] as const;

// Whether the first-run card has been put away. It is one flag for the whole
// app: a reader who understood the canvas once does not need it again per
// story. The guide stays reachable from the header either way.
const GUIDE_DISMISSED_KEY = 'litrpg.guide.dismissed';

// The three rules the welcome card lists and the guide explains, written once so
// the short card and the long dialog cannot drift apart.
const guideConcepts = [
  {
    title: 'The canvas is a database',
    short: 'A line you draw is a record: a relation, a cast entry, an audit entry.',
    body:
      'A connection is not decoration. Draw one between two characters and a relation is written onto both sheets; draw one to a chapter and that character joins its cast; draw one from a skill card to a character and that character becomes one of its holders. Every one of those writes is recorded in the history with your name on it.',
  },
  {
    title: 'A skill card has one identity',
    short: 'Editing a card changes every character who holds that skill.',
    body:
      'A skill’s name, rank and effect belong to the skill itself, not to the card or to one holder. A card and every sheet that holds it show the same values, so a correction made in one place reaches the others at once — as a single undo step.',
  },
  {
    title: 'History goes back whole actions',
    short: 'Undo and the Audit Log reverse a change made on the sheet or the canvas.',
    body:
      'One save is one step, even when it touches a card and a sheet together. Ctrl+Z walks back through those steps and Redo walks forward again; the Audit Log keeps the longer record of who changed what, with a Revert on each field.',
  },
] as const;

// The card types whose Add form also creates the record behind the card. The
// other types are narrative cards and keep the quick label-only creation.
type CanvasCreateKind = 'character' | 'quest' | 'skill';

function isCanvasCreateKind(value: string): value is CanvasCreateKind {
  return value === 'character' || value === 'quest' || value === 'skill';
}

// One open creation form on the canvas. The fields a kind does not use stay
// empty and are never read for it.
interface CanvasCreateDraft {
  kind: CanvasCreateKind;
  name: string;
  description: string;
  ownerId: string;
  rank: string;
  chapterId: string;
  completedChapterId: string;
  giverId: string;
  factionId: string;
  notes: string;
  // Where the card was dropped when a connection drag opened this form, so the
  // new card lands where the author let go instead of somewhere random.
  position?: { x: number; y: number };
}

// A connection between two character cards that is waiting on its kind. The
// canvas edge is not written until this form is submitted, so cancelling leaves
// nothing behind.
interface CharacterConnectionDraft {
  sourceNodeId: string;
  targetNodeId: string;
  sourceCharacterId: string;
  targetCharacterId: string;
  sourceName: string;
  targetName: string;
  kind: string;
  note: string;
  chapterId: string;
}

// A connection whose removal also removes a domain row: the cast of a chapter, a
// relation between two characters, or a character's hold on a skill card.
// Cancelling puts the edge back untouched.
interface PendingEdgeRemoval {
  edge: Edge<EdgeData>;
  kind: 'cast' | 'relation' | 'skill';
  title: string;
  detail: string;
  stepLabel: string;
  castId?: string;
  characterId?: string;
  chapterId?: string;
  relationId?: string;
  relationFromId?: string;
  relationToId?: string;
  relationKind?: string;
  relationNote?: string | null;
  relationSinceChapterId?: string | null;
  relationUntilChapterId?: string | null;
  skillId?: string;
  skillCharacterId?: string;
  skillName?: string;
  skillRank?: string | null;
  skillEffect?: string | null;
  skillChapterId?: string | null;
  skillNodeId?: string | null;
}

// Fixed, distinguishable line colours. A cast member keeps the same colour while
// the chart is open, so hiding one line does not recolour the comparison.
const PROGRESSION_CHART_COLORS = [
  '#7ac47a',
  '#7aa2f7',
  '#e0af68',
  '#f7768e',
  '#bb9af7',
  '#2ac3de',
  '#9ece6a',
  '#ff9e64',
];

// How many note cards hang under one chapter before the rest are counted.
const NOTE_CARDS_SHOWN = 3;

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

// The edge that drew a relation: both ends are its two character cards and the
// edge's verb names the bond. An edge that lost its verb still belongs to the
// only relation between the pair, but never to one of several.
function matchingRelationEdge(
  edges: Edge<EdgeData>[],
  nodes: Node<NodeData>[],
  relations: CharacterRelation[],
  relation: Pick<CharacterRelation, 'from_character_id' | 'to_character_id' | 'kind'>
): Edge<EdgeData> | undefined {
  const characterIdForNode = (nodeId: string) => {
    const node = nodes.find(candidate => candidate.id === nodeId);
    return node?.data.nodeType === 'character' ? node.data.characterId ?? null : null;
  };
  const pairEdges = edges.filter(edge => {
    const fromId = characterIdForNode(edge.source);
    const toId = characterIdForNode(edge.target);

    return (
      (fromId === relation.from_character_id && toId === relation.to_character_id) ||
      (fromId === relation.to_character_id && toId === relation.from_character_id)
    );
  });
  const pairRelations = relations.filter(
    other =>
      (other.from_character_id === relation.from_character_id &&
        other.to_character_id === relation.to_character_id) ||
      (other.from_character_id === relation.to_character_id &&
        other.to_character_id === relation.from_character_id)
  );

  return (
    pairEdges.find(
      edge => (edge.data?.relationType ?? edge.label ?? '') === relation.kind
    ) ?? (pairEdges.length === 1 && pairRelations.length === 1 ? pairEdges[0] : undefined)
  );
}

// The relation a character-to-character connection drew. Read the edge's verb
// before it is edited, since the change may be about to replace the very word
// that picks the bond out of a crowded pair.
function relationForEdge(
  edge: Edge<EdgeData>,
  nodes: Node<NodeData>[],
  relations: CharacterRelation[]
): CharacterRelation | undefined {
  const characterIdForNode = (nodeId: string) => {
    const node = nodes.find(candidate => candidate.id === nodeId);
    return node?.data.nodeType === 'character' ? node.data.characterId ?? null : null;
  };
  const fromId = characterIdForNode(edge.source);
  const toId = characterIdForNode(edge.target);

  if (!fromId || !toId) return undefined;

  const pair = relations.filter(
    relation =>
      (relation.from_character_id === fromId && relation.to_character_id === toId) ||
      (relation.from_character_id === toId && relation.to_character_id === fromId)
  );

  return (
    pair.find(
      relation => relation.kind === (edge.data?.relationType ?? edge.label ?? '')
    ) ?? (pair.length === 1 ? pair[0] : undefined)
  );
}

// A connection between a skill card and a character card. The card is the shared
// identity; the character is whoever the line puts on it. Either end may be the
// card, because a line has no front, and a character card that was never linked
// to a cast member cannot stand for anybody.
function skillCardEnds(
  edge: Edge<EdgeData>,
  nodes: Node<NodeData>[]
): { card: Node<NodeData>; characterId: string } | null {
  const source = nodes.find(node => node.id === edge.source);
  const target = nodes.find(node => node.id === edge.target);

  if (!source || !target) return null;

  const card =
    source.data.nodeType === 'skill'
      ? source
      : target.data.nodeType === 'skill'
        ? target
        : null;

  if (!card) return null;

  const other = card === source ? target : source;
  const characterId =
    other.data.nodeType === 'character' ? other.data.characterId ?? null : null;

  return characterId ? { card, characterId } : null;
}

// The sheet row a skill-card connection stands for: that character's skill which
// points at this very card. A skill the character typed in by hand without a
// card is not this line, so it is left alone.
function skillForEdge(
  edge: Edge<EdgeData>,
  nodes: Node<NodeData>[],
  skills: CharacterSkill[]
): CharacterSkill | undefined {
  const ends = skillCardEnds(edge, nodes);

  if (!ends) return undefined;

  return skills.find(
    row => row.node_id === ends.card.id && row.character_id === ends.characterId
  );
}

// The line that put a holder on the board: the card the skill names, joined to a
// card linked to the holder. A skill typed onto the sheet without a card has no
// line to find, and the sheet edit stands on its own.
function matchingSkillEdge(
  edges: Edge<EdgeData>[],
  nodes: Node<NodeData>[],
  skill: Pick<CharacterSkill, 'character_id' | 'node_id'>
): Edge<EdgeData> | undefined {
  if (!skill.node_id) return undefined;

  return edges.find(edge => {
    const ends = skillCardEnds(edge, nodes);

    return (
      ends !== null &&
      ends.card.id === skill.node_id &&
      ends.characterId === skill.character_id
    );
  });
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
  // Said after a successful undo only. A step whose work left something else
  // behind — a chapter's connections, which are restored separately — names it
  // here, so the notice says where the rest went.
  undoNote?: string;
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

function toChapterNote(row: any): ChapterNote {
  return {
    id: row.id,
    chapterId: row.parent_node_id ?? '',
    text: row.content ?? '',
  };
}

// The plain sentence behind a continuity flag, without its chapter buttons.
function continuityText(parts: ContinuityPart[]): string {
  return parts.map(part => (typeof part === 'string' ? part : part.text)).join('');
}

// A chapter named inside a continuity sentence, which the panel renders as a
// button that opens that chapter.
function chapterLink(id: string, label: string, quoted = false): ContinuityPart {
  return { id, text: quoted ? `“${label}”` : label };
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

// The prepared story's title. It is how the sidebar knows that a reset would
// replace sample data rather than a story the author has made their own.
const DEMO_STORY_TITLE = 'The Ember Ledger (Demo)';

// Both lists the trash shows, in one round trip. Shared by the tab's first load
// and by anything that changes what is in the trash.
async function fetchTrash(storyId: string | null) {
  const [inStory, stories] = await Promise.all([
    storyId
      ? trashApi.getTrash(storyId)
      : Promise.resolve<DeletedItem[]>([]),
    trashApi.getTrash(null),
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statChangesFromMilestone(milestone: CharacterLevelMilestone): LevelStatChangeDraft[] {
  return milestoneStatChanges(milestone).map(change => ({
    statName: change.stat_name,
    amount: change.amount == null ? '' : String(change.amount),
    valueAfter: change.value_after == null ? '' : String(change.value_after),
  }));
}

function blankStatChange(): LevelStatChangeDraft {
  return { statName: '', amount: '', valueAfter: '' };
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
    'graph' | 'chapters' | 'characters' | 'quests' | 'audit' | 'trash'
  >('graph');
  
  const [newStoryTitle, setNewStoryTitle] = useState('');
  const [demoStoryBusy, setDemoStoryBusy] = useState(false);
  const [demoResetConfirm, setDemoResetConfirm] = useState(false);
  const [newNodeLabel, setNewNodeLabel] = useState('');
  const [newNodeType, setNewNodeType] = useState<NodeType>('idea');
  // The full form behind a character, quest or skill card. Empty until Add is
  // pressed with one of those types selected.
  const [canvasCreate, setCanvasCreate] = useState<CanvasCreateDraft | null>(null);
  const [canvasCreateError, setCanvasCreateError] = useState<string | null>(null);
  const [savingCanvasCreate, setSavingCanvasCreate] = useState(false);

  // A character-to-character connection asks for its relation before anything
  // is written. The drag that opened it is remembered so dropping on empty
  // canvas can open the matching card form instead.
  const [characterConnection, setCharacterConnection] = useState<CharacterConnectionDraft | null>(
    null
  );
  const [characterConnectionError, setCharacterConnectionError] = useState<string | null>(null);
  const [savingCharacterConnection, setSavingCharacterConnection] = useState(false);
  const connectionStartNodeRef = useRef<string | null>(null);
  const connectionStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const connectionMadeRef = useRef(false);

  // Edges that carry a cast or relation removal wait for the author's answer.
  const [pendingEdgeRemoval, setPendingEdgeRemoval] = useState<PendingEdgeRemoval[] | null>(
    null
  );
  const [removingDomainEdges, setRemovingDomainEdges] = useState(false);

  // Escape closes the creation form as long as a write is not in flight.
  useEffect(() => {
    if (!canvasCreate) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || savingCanvasCreate) return;
      event.preventDefault();
      setCanvasCreate(null);
      setCanvasCreateError(null);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canvasCreate, savingCanvasCreate]);

  // Escape closes the relation form too, unless the relation is being written.
  useEffect(() => {
    if (!characterConnection) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || savingCharacterConnection) return;
      event.preventDefault();
      setCharacterConnection(null);
      setCharacterConnectionError(null);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [characterConnection, savingCharacterConnection]);

  // Escape keeps the edge and its relation or cast row, the same as Keep.
  useEffect(() => {
    if (!pendingEdgeRemoval) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || removingDomainEdges) return;
      event.preventDefault();
      setPendingEdgeRemoval(null);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingEdgeRemoval, removingDomainEdges]);

  // Chapter notes are context rather than cards, so the canvas stays the drawing
  // it was until the author asks for the reminders to hang under their chapters.
  const [showChapterNotes, setShowChapterNotes] = useState(false);

  // The chapter list's own controls.
  const [newChapterTitle, setNewChapterTitle] = useState('');
  const [chapterError, setChapterError] = useState<string | null>(null);
  const [chapterBusy, setChapterBusy] = useState(false);
  // A chapter being dragged, and the row under the pointer with the side the
  // drop would land on. Both are cleared when the drag ends, however it ends.
  const [draggedChapterId, setDraggedChapterId] = useState<string | null>(null);
  const [chapterDrop, setChapterDrop] = useState<{ id: string; after: boolean } | null>(
    null
  );

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

  // The explicit cast of each chapter: everyone present beyond the card's own
  // linked cast member and its point of view. One picker is open at a time.
  const [storyChapterCast, setStoryChapterCast] = useState<ChapterCastMember[]>([]);
  const [openChapterCastId, setOpenChapterCastId] = useState<string | null>(null);
  const [chapterCastBusyId, setChapterCastBusyId] = useState<string | null>(null);
  const [chapterCastError, setChapterCastError] = useState<string | null>(null);

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
  // Adding a holder from a skill card copies the card's name and notes onto that
  // character's sheet; rank and chapter stay the holder's own facts.
  const [skillHolderCharacterId, setSkillHolderCharacterId] = useState('');
  const [skillHolderRank, setSkillHolderRank] = useState('');
  const [skillHolderChapterId, setSkillHolderChapterId] = useState('');
  const [skillHolderError, setSkillHolderError] = useState<string | null>(null);
  const [savingSkillHolder, setSavingSkillHolder] = useState(false);
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
  const [characterSkills, setCharacterSkills] = useState<CharacterSkill[]>([]);
  // Every live cast member's skills, so a skill card can name who has it without
  // one read per card.
  const [storySkills, setStorySkills] = useState<CharacterSkill[]>([]);
  // Progression is read for the whole story so continuity can compare every
  // character's chapters without one request per character.
  const [storySkillEvents, setStorySkillEvents] = useState<CharacterSkillEvent[]>([]);
  const [storyLevelMilestones, setStoryLevelMilestones] = useState<
    CharacterLevelMilestone[]
  >([]);
  // Read by a sync's undo step, so putting an old total back does not also put
  // the milestone's other fields back.
  const storyLevelMilestonesRef = useRef<CharacterLevelMilestone[]>([]);
  // The one-click ledger sync, offered back for a moment like Mark returned.
  const [syncedXpNotice, setSyncedXpNotice] = useState<{
    characterName: string;
    xp: number;
  } | null>(null);
  const [syncingXpMilestoneId, setSyncingXpMilestoneId] = useState<string | null>(null);
  // Cast relations and faction standings are story-wide, like the progression
  // ledgers, so the map, the sheets and the continuity checks read one copy.
  const [storyRelations, setStoryRelations] = useState<CharacterRelation[]>([]);
  const [storyFactionStandings, setStoryFactionStandings] = useState<FactionStanding[]>([]);
  // The Characters tab opens on the sheets; the map is a mode, not another tab.
  const [characterView, setCharacterView] = useState<'sheet' | 'relations' | 'skills'>(
    'sheet'
  );
  // Every evolution link in the story. The tree view draws them and the sheets
  // name them on each skill, so one read covers both.
  const [storySkillEvolutions, setStorySkillEvolutions] = useState<SkillEvolution[]>([]);
  const [skillEvolutionError, setSkillEvolutionError] = useState<string | null>(null);
  // Quests are read with the rest of the story, because chapter cards, the
  // ledger and the continuity checks all read the same copy.
  const [storyQuests, setStoryQuests] = useState<Quest[]>([]);
  const [newStandingFactionName, setNewStandingFactionName] = useState('');
  // The quest a chapter badge just opened, lit briefly so the eye can find it,
  // and which click opened it so a second click on the same badge still counts.
  const [questFocus, setQuestFocus] = useState<{
    questId: string;
    request: number;
  } | null>(null);
  // One income row per character and chapter, read with the rest of the story so
  // the chart and a sheet share the same ledger.
  const [storyCharacterProgress, setStoryCharacterProgress] = useState<
    CharacterProgress[]
  >([]);
  // One snapshot per assigned character per chapter, read in one request so a
  // board of cards does not issue one command each.
  const [storyChapterCastStates, setStoryChapterCastStates] = useState<ChapterCastState[]>(
    []
  );

  // The chart compares cast members, so a line is only hidden explicitly rather
  // than being selected on first load. The chapter-state readout asks the
  // database for the active level and skills rather than recalculating them.
  const [hiddenChartCharacterIds, setHiddenChartCharacterIds] = useState<string[]>([]);
  const [chartStateChapterId, setChartStateChapterId] = useState('');
  const [chartChapterStates, setChartChapterStates] = useState<CharacterChapterState[]>([]);
  const [chartStateLoading, setChartStateLoading] = useState(false);
  const [chartStateError, setChartStateError] = useState<string | null>(null);

  const [characterInventory, setCharacterInventory] = useState<InventoryItem[]>([]);
  const [storyInventory, setStoryInventory] = useState<InventoryItem[]>([]);
  // Read by an undo step recorded before a later edit, so putting the lost
  // chapter back does not also put the item's other fields back.
  const storyInventoryRef = useRef<InventoryItem[]>([]);
  const [characterCurrency, setCharacterCurrency] = useState<CharacterCurrency[]>([]);

  // The relations form, and the one row open for editing at a time. A relation's
  // other end is fixed once made: changing who it joins means a different bond,
  // so it is deleted and recorded again rather than silently rewritten.
  const [newRelationKind, setNewRelationKind] = useState('ally');
  const [newRelationToId, setNewRelationToId] = useState('');
  const [newRelationChapterId, setNewRelationChapterId] = useState('');
  const [newRelationNote, setNewRelationNote] = useState('');
  const [editingRelationId, setEditingRelationId] = useState<string | null>(null);
  const [relationKindDraft, setRelationKindDraft] = useState('');
  const [relationChapterDraft, setRelationChapterDraft] = useState('');
  const [relationUntilChapterDraft, setRelationUntilChapterDraft] = useState('');
  const [relationNoteDraft, setRelationNoteDraft] = useState('');

  // The faction standing form, one row open at a time like the rest.
  const [newStandingFactionId, setNewStandingFactionId] = useState('');
  const [newStandingText, setNewStandingText] = useState('');
  const [newStandingChapterId, setNewStandingChapterId] = useState('');
  const [newStandingNote, setNewStandingNote] = useState('');
  const [editingStandingId, setEditingStandingId] = useState<string | null>(null);
  const [standingFactionDraft, setStandingFactionDraft] = useState('');
  const [standingTextDraft, setStandingTextDraft] = useState('');
  const [standingChapterDraft, setStandingChapterDraft] = useState('');
  const [standingUntilChapterDraft, setStandingUntilChapterDraft] = useState('');
  const [standingNoteDraft, setStandingNoteDraft] = useState('');

  // The item form, one row open at a time like skills. Quantities are kept as
  // typed text so a field can be cleared while it is being changed.
  const [newItemName, setNewItemName] = useState('');
  const [newItemRarity, setNewItemRarity] = useState('');
  const [newItemQuantity, setNewItemQuantity] = useState('1');
  const [newItemEffect, setNewItemEffect] = useState('');
  const [newItemChapterId, setNewItemChapterId] = useState('');
  const [newItemLostChapterId, setNewItemLostChapterId] = useState('');
  const [newItemNodeId, setNewItemNodeId] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemNameDraft, setItemNameDraft] = useState('');
  const [itemRarityDraft, setItemRarityDraft] = useState('');
  const [itemQuantityDraft, setItemQuantityDraft] = useState('1');
  const [itemEffectDraft, setItemEffectDraft] = useState('');
  const [itemChapterDraft, setItemChapterDraft] = useState('');
  const [itemLostChapterDraft, setItemLostChapterDraft] = useState('');
  const [itemNodeDraft, setItemNodeDraft] = useState('');
  const [returningItemId, setReturningItemId] = useState<string | null>(null);
  // What Mark returned just did, so the board can offer the correction back
  // before the notice fades.
  const [returnedNotice, setReturnedNotice] = useState<{ itemName: string } | null>(null);

  const [newCurrencyName, setNewCurrencyName] = useState('');
  const [newCurrencyAmount, setNewCurrencyAmount] = useState('0');
  const [editingCurrencyId, setEditingCurrencyId] = useState<string | null>(null);
  const [currencyNameDraft, setCurrencyNameDraft] = useState('');
  const [currencyAmountDraft, setCurrencyAmountDraft] = useState('0');

  // The level milestone form, one row open at a time. XP is optional, and a
  // level-up can award as many stat changes as the story needs.
  const [editingLevelMilestoneId, setEditingLevelMilestoneId] = useState<string | null>(null);
  const [levelMilestoneLevelDraft, setLevelMilestoneLevelDraft] = useState('1');
  const [levelMilestoneChapterDraft, setLevelMilestoneChapterDraft] = useState('');
  const [levelMilestoneDebuffDraft, setLevelMilestoneDebuffDraft] = useState(false);
  const [levelMilestoneXpDraft, setLevelMilestoneXpDraft] = useState('');
  const [levelMilestoneStatChangesDraft, setLevelMilestoneStatChangesDraft] = useState<
    LevelStatChangeDraft[]
  >([]);
  const [newLevelMilestoneLevel, setNewLevelMilestoneLevel] = useState('1');
  const [newLevelMilestoneChapter, setNewLevelMilestoneChapter] = useState('');
  const [newLevelMilestoneDebuff, setNewLevelMilestoneDebuff] = useState(false);
  const [newLevelMilestoneXp, setNewLevelMilestoneXp] = useState('');
  const [newLevelMilestoneStatChanges, setNewLevelMilestoneStatChanges] = useState<
    LevelStatChangeDraft[]
  >([blankStatChange()]);
  // The XP-by-chapter ledger, one row open at a time like the milestone form.
  const [editingXpEntryId, setEditingXpEntryId] = useState<string | null>(null);
  const [xpEntryChapterDraft, setXpEntryChapterDraft] = useState('');
  const [xpEntryXpDraft, setXpEntryXpDraft] = useState('');
  const [newXpEntryChapter, setNewXpEntryChapter] = useState('');
  const [newXpEntryXp, setNewXpEntryXp] = useState('');
  const [chartMetric, setChartMetric] = useState<ProgressionMetric>('level');
  const [chartStatName, setChartStatName] = useState('');
  const [focusedProgression, setFocusedProgression] = useState<{
    kind: 'skill' | 'skill-event' | 'level' | 'relation' | 'faction-standing';
    id: string;
  } | null>(null);
  const progressionFocusTimer = useRef<number | null>(null);

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

  // The guide covers the three rules the canvas keeps. It is reachable from the
  // header at any time; the welcome card is what points at it on a first run.
  const [guideOpen, setGuideOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => {
    try {
      return localStorage.getItem(GUIDE_DISMISSED_KEY) === '1';
    } catch {
      // Without storage the card would greet the reader on every launch, so it
      // stays out of the way instead and the Guide button carries the rules.
      return true;
    }
  });

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
  // Set when a step put its own half back, so the move that then failed writes
  // the rollback's entry instead of a second one saying the same thing.
  const rollbackRecordedRef = useRef(false);

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
        await storiesApi.initializeDatabase();
        const loadedStories: Story[] = await storiesApi.getAllStories();
        setStories(loadedStories);
      } catch (e) {
        console.error('Failed to init DB or load stories:', e);
      }
    };
    init();
  }, []);

  const loadStory = useCallback(async (story: Story) => {
    setCurrentStory(story);

    // A reset confirmation belongs to the story it was opened for.
    setDemoResetConfirm(false);

    // Undo is scoped to the story it was recorded in, so a switch starts clean.
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryDepth({ undo: 0, redo: 0 });
    setHistoryNotice(null);
    setReturnedNotice(null);
    setSyncedXpNotice(null);

    // A note or cast panel belongs to the story it was opened in, so a switch
    // closes it.
    setOpenChapterCastId(null);
    setChapterCastError(null);
    setOpenNotesChapterId(null);
    setEditingNoteId(null);
    setNoteDraft('');
    setNoteError(null);
    setMatchedNoteId(null);

    try {
      const dbNodes: any[] = await canvasApi.getGraphNodes(story.id);
      const dbEdges: any[] = await canvasApi.getGraphEdges(story.id);

      setNodes(dbNodes.map(toFlowNode));
      setEdges(dbEdges.map(toFlowEdge));

      // The cast rail and the cards' badges both read from here, so the cast and
      // its numbers are loaded with the graph rather than on another tab.
      const [
        cast,
        stats,
        skills,
        skillEvents,
        levels,
        progress,
        inventory,
        notes,
        chapterCast,
        relations,
        standings,
        quests,
        evolutions,
      ] =
        await Promise.all([
          charactersApi.getCharacters(story.id),
          charactersApi.getStoryCharacterStats(story.id),
          skillsApi.getStorySkills(story.id),
          skillsApi.getStorySkillEvents(story.id),
          progressionApi.getStoryLevelMilestones(story.id),
          progressionApi.getStoryCharacterProgress(story.id),
          inventoryApi.getStoryInventory(story.id),
          narrativeApi.getChapterNotes(story.id),
          narrativeApi.getStoryChapterCast(story.id),
          relationsApi.getStoryRelations(story.id),
          relationsApi.getStoryFactionStandings(story.id),
          questsApi.getStoryQuests(story.id),
          skillsApi.getStorySkillEvolutions(story.id),
        ]);
      setCharacters(cast);
      setCastStats(statsByCharacter(stats));
      setStorySkills(skills ?? []);
      setStorySkillEvents(skillEvents ?? []);
      setStoryLevelMilestones(levels ?? []);
      setStoryCharacterProgress(progress ?? []);
      setStoryInventory(inventory ?? []);
      setChapterNotes((notes ?? []).map(toChapterNote));
      setStoryChapterCast(chapterCast ?? []);
      setStoryRelations(relations ?? []);
      setStoryFactionStandings(standings ?? []);
      setStoryQuests(quests ?? []);
      setStorySkillEvolutions(evolutions ?? []);
      setSkillEvolutionError(null);
      // The ledger clears its own form when the story changes; only the lit
      // quest is the app's.
      setQuestFocus(null);

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
        canvasApi.getGraphNodes(storyId),
        canvasApi.getGraphEdges(storyId),
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
    // A newer action owns the board now; the old correction's Undo would be a
    // step out of order.
    setReturnedNotice(null);
    setSyncedXpNotice(null);
  }, []);

  // A refusal used to be a notice that faded after a few seconds. It is also a
  // fact about the story, so it goes where the Audit tab can keep it: what was
  // attempted, and what stopped it.
  const recordHistoryEvent = useCallback(
    async (action: 'undo_refused' | 'redo_refused' | 'step_rolled_back', detail: string) => {
      const storyId = currentStory?.id ?? lastStoryIdRef.current;
      if (!storyId) return;

      if (action === 'step_rolled_back') rollbackRecordedRef.current = true;

      try {
        await auditApi.recordHistoryEvent(storyId, action, detail, actor);
      } catch (e) {
        // The refusal is what the author needs to see; an entry that could not
        // be written must not replace it.
        console.error('Failed to write a refused step into the history:', e);
      }
    },
    [currentStory, actor]
  );

  const moveInHistory = useCallback(
    async (direction: 'undo' | 'redo') => {
      const source = direction === 'undo' ? undoStackRef : redoStackRef;
      const target = direction === 'undo' ? redoStackRef : undoStackRef;
      const step = source.current[source.current.length - 1];

      if (!step) return;

      removedNodeIdsRef.current = new Set();
      rollbackRecordedRef.current = false;
      setActionError(null);
      setReturnedNotice(null);
      setSyncedXpNotice(null);

      try {
        await (direction === 'undo' ? step.undo() : step.redo());
      } catch (e) {
        // The step stays where it was, so the failed change can be retried. The
        // half a step put back has already written its own entry; otherwise the
        // refusal itself is the entry.
        console.error(`Failed to ${direction}:`, e);
        setActionError(`Could not ${direction} ${step.label}: ${String(e)}`);

        if (!rollbackRecordedRef.current) {
          await recordHistoryEvent(
            direction === 'undo' ? 'undo_refused' : 'redo_refused',
            `${direction === 'undo' ? 'Undo' : 'Redo'} refused — ${step.label}: ${String(
              e
            )} The step stays in the history, so it can be tried again.`
          );
        }

        return;
      }

      source.current = source.current.slice(0, -1);
      target.current = [...target.current, step];
      setHistoryDepth({
        undo: undoStackRef.current.length,
        redo: redoStackRef.current.length,
      });
      // The note belongs to the undo: a redo takes the same things away again.
      const note = direction === 'undo' ? step.undoNote : null;
      setHistoryNotice(
        `${direction === 'undo' ? 'Undid' : 'Redid'}: ${step.label}${note ? ` — ${note}` : ''}`
      );

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
    [reloadStory, recordHistoryEvent]
  );

  const undoLast = useCallback(() => moveInHistory('undo'), [moveInHistory]);
  const redoLast = useCallback(() => moveInHistory('redo'), [moveInHistory]);

  // Putting the card away is a decision about this machine, not about the
  // story, so it is remembered rather than shown again on the next launch.
  const dismissWelcome = useCallback(() => {
    setWelcomeDismissed(true);

    try {
      localStorage.setItem(GUIDE_DISMISSED_KEY, '1');
    } catch {
      // The card stays hidden for this session; a failed write changes nothing
      // else, so it is not worth an error banner.
    }
  }, []);

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
        guideOpen ||
        backupsOpen ||
        quitPrompt ||
        canvasCreate ||
        characterConnection ||
        pendingEdgeRemoval
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
  }, [
    selectedTab,
    currentStory,
    searchOpen,
    shortcutsOpen,
    guideOpen,
    backupsOpen,
    quitPrompt,
    canvasCreate,
    characterConnection,
    pendingEdgeRemoval,
  ]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // ? opens the shortcut list on any tab, but never while a field is being typed
  // in — there it is a question mark like any other.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The quit question owns the keyboard while it is up, and the guide owns it
      // while that is up: ? there would open a second overlay behind it.
      if (quitPrompt || guideOpen) return;

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
  }, [shortcutsOpen, quitPrompt, guideOpen]);

  // Ctrl+Z and Ctrl+Shift+Z walk the recorded actions. Inside a field they are
  // left alone, because there they belong to the text being typed.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ['input', 'textarea', 'select'].includes(target?.tagName?.toLowerCase() ?? '');

      if (typing || shortcutsOpen || guideOpen || backupsOpen || quitPrompt) return;

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
  }, [undoLast, redoLast, shortcutsOpen, guideOpen, backupsOpen, quitPrompt]);

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

  // Escape closes the guide, the same way it closes the shortcut list it sits
  // beside in the header.
  useEffect(() => {
    if (!guideOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      event.preventDefault();
      setGuideOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [guideOpen]);

  // The board's undo closures read the latest row rather than the one captured
  // when the action happened, so a later field edit is not swept away by Undo.
  useEffect(() => {
    storyInventoryRef.current = storyInventory;
  }, [storyInventory]);

  useEffect(() => {
    storyLevelMilestonesRef.current = storyLevelMilestones;
  }, [storyLevelMilestones]);

  // The sync's Undo is a correction offered straight away; the toolbar and
  // shortcut keep the step after this prompt has gone.
  useEffect(() => {
    if (!syncedXpNotice) return;

    const timer = setTimeout(() => setSyncedXpNotice(null), 10000);
    return () => clearTimeout(timer);
  }, [syncedXpNotice]);

  // A notice about an undo is useful for a moment, then it is just stale text.
  useEffect(() => {
    if (!historyNotice) return;

    const timer = setTimeout(() => setHistoryNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [historyNotice]);

  // Mark returned's Undo is a correction offered straight away; the toolbar and
  // shortcut keep the step after this prompt has gone.
  useEffect(() => {
    if (!returnedNotice) return;

    const timer = setTimeout(() => setReturnedNotice(null), 10000);
    return () => clearTimeout(timer);
  }, [returnedNotice]);

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
          canvasApi.getGraphNodes(story.id),
          charactersApi.getCharacters(story.id),
          canvasApi.getGraphEdges(story.id),
          narrativeApi.getChapterNotes(story.id),
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

  // A revert changes what the other tabs show, so they are reloaded rather than
  // left displaying the value the history just put back.
  const refreshAfterRevert = async () => {
    if (!currentStory) return;

    await loadStory(currentStory);

    const loaded: Character[] = await charactersApi.getCharacters(currentStory.id);
    setCharacters(loaded);

    if (selectedCharacterId) {
      const [stats, attributes, skills, inventory, currency] = await Promise.all([
        charactersApi.getCharacterStats(selectedCharacterId),
        charactersApi.getCharacterAttributes(selectedCharacterId),
        skillsApi.getCharacterSkills(selectedCharacterId),
        inventoryApi.getCharacterInventory(selectedCharacterId),
        inventoryApi.getCharacterCurrency(selectedCharacterId),
      ]);
      setCharacterStats(stats);
      setCharacterAttributes(attributes);
      setCharacterSkills(skills ?? []);
      setCharacterInventory(inventory ?? []);
      setCharacterCurrency(currency ?? []);
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
        const loaded: Character[] = await charactersApi.getCharacters(currentStory.id);
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
        const loaded: CharacterStat[] = await charactersApi.getCharacterStats(selectedCharacterId);
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
        const loaded: CharacterAttribute[] = await charactersApi.getCharacterAttributes(
          selectedCharacterId
        );
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

  // Skills follow the selected character as well.
  useEffect(() => {
    if (!selectedCharacterId) {
      setCharacterSkills([]);
      return;
    }

    let cancelled = false;

    const loadSkills = async () => {
      try {
        const loaded: CharacterSkill[] = await skillsApi.getCharacterSkills(selectedCharacterId);
        if (!cancelled) setCharacterSkills(loaded ?? []);
      } catch (e) {
        console.error('Failed to load character skills:', e);
        if (!cancelled) setCharacterError(String(e));
      }
    };

    loadSkills();

    return () => {
      cancelled = true;
    };
  }, [selectedCharacterId]);

  // Inventory and currency follow the selected character as well.
  useEffect(() => {
    if (!selectedCharacterId) {
      setCharacterInventory([]);
      setCharacterCurrency([]);
      return;
    }

    let cancelled = false;

    const loadLedger = async () => {
      try {
        const [items, currency] = await Promise.all([
          inventoryApi.getCharacterInventory(selectedCharacterId),
          inventoryApi.getCharacterCurrency(selectedCharacterId),
        ]);

        if (cancelled) return;
        setCharacterInventory(items ?? []);
        setCharacterCurrency(currency ?? []);
      } catch (e) {
        console.error('Failed to load inventory and currency:', e);
        if (!cancelled) setCharacterError(String(e));
      }
    };

    loadLedger();

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
          trashApi.getTrashRetention(),
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
      await trashApi.restoreDeleted(item.id, item.kind, actor);

      if (item.kind === 'story') {
        const loadedStories: Story[] = await storiesApi.getAllStories();
        setStories(loadedStories);
        setDeletedStories(previous => previous.filter(other => other.id !== item.id));
      } else {
        setTrash(previous => previous.filter(other => other.id !== item.id));

        if (currentStory) {
          await loadStory(currentStory);

          const loaded: Character[] = await charactersApi.getCharacters(currentStory.id);
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
      await trashApi.purgeDeleted(item.id, item.kind, actor);

      // Nothing can bring a purged row back, so earlier steps are no longer a
      // safe branch to undo into.
      undoStackRef.current = [];
      redoStackRef.current = [];
      setHistoryDepth({ undo: 0, redo: 0 });

      if (item.kind === 'story') {
        setDeletedStories(previous => previous.filter(other => other.id !== item.id));
      } else {
        setTrash(previous => previous.filter(other => other.id !== item.id));

        // Purging a cast member clears every node linked to it, and purging a
        // faction card clears the standings that named it, so the story is
        // re-read instead of being left pointing at a row that no longer exists.
        if ((item.kind === 'character' || item.kind === 'node') && currentStory) {
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
      const purged: number = await trashApi.setTrashRetention(days);
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

  const loadDemoStory = async () => {
    if (demoStoryBusy) return;

    setDemoStoryBusy(true);
    setActionError(null);

    try {
      const story: Story = await storiesApi.createDemoStory(actor);

      setStories(previous => [story, ...previous.filter(other => other.id !== story.id)]);
      setSelectedTab('graph');
      await loadStory(story);
      setImportStatus(`Loaded "${story.title}"`);
    } catch (e) {
      console.error('Failed to create the demo story:', e);
      setActionError(`Could not create the demo story: ${String(e)}`);
    } finally {
      setDemoStoryBusy(false);
    }
  };

  const resetDemoStory = async () => {
    if (!currentStory || demoStoryBusy) return;

    setDemoStoryBusy(true);
    setActionError(null);

    try {
      const story: Story = await storiesApi.resetDemoStory(currentStory.id, actor);

      setStories(previous =>
        previous.map(other => (other.id === story.id ? story : other))
      );

      // The reset was confirmed, so any draft about the replaced rows goes with
      // them rather than being left pointing at a chapter that no longer exists.
      setChapterFormPrompt(null);
      setNotePrompt(null);
      setEditingChapterId(null);

      await loadStory(story);
      setImportStatus(`Rebuilt "${story.title}" with its original sample data`);
    } catch (e) {
      console.error('Failed to reset the demo story:', e);
      setActionError(`Could not reset the demo story: ${String(e)}`);
    } finally {
      setDemoStoryBusy(false);
      setDemoResetConfirm(false);
    }
  };

  const createNewStory = async () => {
    if (!newStoryTitle.trim()) return;
    
    try {
      const story: Story = await storiesApi.createNewStory(newStoryTitle.trim(), null, actor);
      
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
      const newDbNode: any = await canvasApi.createGraphNode(
        currentStory.id,
        newNodeType,
        newNodeLabel.trim(),
        null,
        position.x,
        position.y,
        actor,
        null
      );

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
        undo: () => canvasApi.deleteNode(newDbNode.id, actor),
        redo: () => trashApi.restoreDeleted(newDbNode.id, 'node', actor),
      });
    } catch (e) {
      console.error('Failed to create node:', e);
    }
  };

  // Add is one button for every card type. A character, quest or skill card is
  // a view of a real record, so those open their own form instead of creating a
  // label-only card; the narrative types keep the quick path.
  const openCanvasCreate = (spawn?: {
    position: { x: number; y: number };
    sourceNodeId: string;
  }) => {
    if (!currentStory) return;

    if (!isCanvasCreateKind(newNodeType)) {
      void addNewNode();
      return;
    }

    const chapters = nodes
      .filter(node => node.data.nodeType === 'chapter')
      .sort(
        (a, b) =>
          (a.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) -
            (b.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) ||
          a.data.label.localeCompare(b.data.label)
      );

    // A connection dragged into empty canvas carries the card it came from into
    // the form: a character becomes the skill's owner or the quest's giver, and
    // a chapter becomes the chapter the skill was learned in or the quest was
    // accepted in.
    const source = spawn ? nodes.find(node => node.id === spawn.sourceNodeId) : null;
    const sourceCharacterId =
      source?.data.nodeType === 'character' ? source.data.characterId ?? null : null;
    const sourceChapterId = source?.data.nodeType === 'chapter' ? source.id : null;

    setCanvasCreateError(null);
    setCanvasCreate({
      kind: newNodeType,
      name: newNodeLabel.trim(),
      description: '',
      // Only a drag from a character card picks an owner. Otherwise the field
      // starts empty: placing a card nobody holds yet is a real answer, and the
      // author should be the one who says who has it.
      ownerId: newNodeType === 'skill' ? sourceCharacterId ?? '' : '',
      rank: '',
      chapterId:
        newNodeType === 'quest'
          ? sourceChapterId ?? chapters[0]?.id ?? ''
          : newNodeType === 'skill'
            ? sourceChapterId ?? ''
            : '',
      completedChapterId: '',
      giverId: newNodeType === 'quest' ? sourceCharacterId ?? '' : '',
      factionId: '',
      notes: '',
      position: spawn?.position,
    });
  };

  // The form writes the record and its card together, so a card is never a
  // decoration pointing at nothing. The step records both halves in the board
  // history; the sheet lists follow the same change.
  const submitCanvasCreate = async () => {
    if (!currentStory || !canvasCreate || savingCanvasCreate) return;

    const draft = canvasCreate;
    const name = draft.name.trim();

    if (!name) {
      setCanvasCreateError(
        draft.kind === 'quest' ? 'A quest needs a title.' : 'A record needs a name.'
      );
      return;
    }

    if (draft.kind === 'quest' && !draft.chapterId) {
      setCanvasCreateError('A quest needs the chapter it was accepted in.');
      return;
    }

    setSavingCanvasCreate(true);
    setCanvasCreateError(null);

    const description = draft.description.trim() || null;
    const position = draft.position ?? {
      x: 120 + Math.random() * 360,
      y: 120 + Math.random() * 240,
    };

    try {
      if (draft.kind === 'character') {
        const created: Character = await charactersApi.createCharacter(
          currentStory.id,
          name,
          description,
          actor
        );
        const node: any = await canvasApi.createGraphNode(
          currentStory.id,
          'character',
          name,
          description,
          position.x,
          position.y,
          actor,
          created.id
        );

        setCharacters(previous => [...previous, created]);
        setNodes(nds => [...nds, toFlowNode(node)]);

        recordStep({
          label: `Add “${name}”`,
          undo: async () => {
            await canvasApi.deleteNode(node.id, actor);
            await charactersApi.deleteCharacter(created.id, actor);
            setCharacters(previous => previous.filter(row => row.id !== created.id));
          },
          redo: async () => {
            await trashApi.restoreDeleted(created.id, 'character', actor);
            await trashApi.restoreDeleted(node.id, 'node', actor);
            setCharacters(previous =>
              previous.some(row => row.id === created.id)
                ? previous
                : [...previous, created]
            );
          },
        });
      } else if (draft.kind === 'quest') {
        const status = draft.completedChapterId ? 'completed' : 'active';
        const quest: Quest = await questsApi.addQuest(
          currentStory.id,
          name,
          draft.giverId || null,
          draft.factionId || null,
          draft.chapterId,
          draft.completedChapterId || null,
          status,
          description,
          draft.notes.trim() || null,
          actor
        );
        const node: any = await canvasApi.createGraphNode(
          currentStory.id,
          'quest',
          name,
          description,
          position.x,
          position.y,
          actor,
          null
        );

        setStoryQuests(previous => [...previous, { ...quest, rewards: quest.rewards ?? [] }]);
        setNodes(nds => [...nds, toFlowNode(node)]);

        // Quests are deleted for good rather than trashed, so a redo records a
        // fresh quest with the same facts and remembers its new id for the next
        // undo.
        let currentQuestId = quest.id;

        recordStep({
          label: `Add “${name}”`,
          undo: async () => {
            await canvasApi.deleteNode(node.id, actor);
            await questsApi.deleteQuest(currentQuestId, actor);
            setStoryQuests(previous => previous.filter(row => row.id !== currentQuestId));
          },
          redo: async () => {
            await trashApi.restoreDeleted(node.id, 'node', actor);
            const again: Quest = await questsApi.addQuest(
              currentStory.id,
              name,
              draft.giverId || null,
              draft.factionId || null,
              draft.chapterId,
              draft.completedChapterId || null,
              status,
              description,
              draft.notes.trim() || null,
              actor
            );
            currentQuestId = again.id;
            setStoryQuests(previous => [
              ...previous,
              { ...again, rewards: again.rewards ?? [] },
            ]);
          },
        });
      } else {
        const node: any = await canvasApi.createGraphNode(
          currentStory.id,
          'skill',
          name,
          description,
          position.x,
          position.y,
          actor,
          null
        );

        // An owner is optional: a skill can be placed on the board before anybody
        // holds it. A character joins later by connecting their card to it, or
        // with the card's Add holder form, and that is when the first sheet row
        // and the shared definition are written.
        const learn = (characterId: string) =>
          skillsApi.addSkill(
            characterId,
            name,
            draft.rank.trim() || null,
            description,
            draft.chapterId || null,
            node.id,
            actor
          );

        let skill: CharacterSkill | null = null;

        if (draft.ownerId) {
          try {
            skill = await learn(draft.ownerId);
          } catch (e) {
            // The skill was refused, so the card made for it must not stay behind.
            await canvasApi.deleteNode(node.id, actor).catch(() => {});
            await recordHistoryEvent(
              'step_rolled_back',
              `Put back — “${name}”: its holder row could not be written (${String(
                e
              )}), so the card was not kept.`
            );
            throw e;
          }
        }

        setNodes(nds => [...nds, toFlowNode(node)]);
        if (skill) showSkillOnLists(skill);

        let currentSkillId = skill?.id ?? null;

        recordStep({
          label: `Add “${name}”`,
          undo: async () => {
            if (currentSkillId) {
              await skillsApi.deleteSkill(currentSkillId, actor);
              hideSkillOnLists(currentSkillId, draft.ownerId);
            }
            await canvasApi.deleteNode(node.id, actor);
          },
          redo: async () => {
            await trashApi.restoreDeleted(node.id, 'node', actor);

            if (!draft.ownerId) return;

            const again = await learn(draft.ownerId);
            currentSkillId = again.id;
            showSkillOnLists(again);
          },
        });
      }

      setCanvasCreate(null);
      setNewNodeLabel('');
    } catch (e) {
      console.error('Failed to create a canvas record:', e);
      setCanvasCreateError(`Could not create it: ${String(e)}`);
    } finally {
      setSavingCanvasCreate(false);
    }
  };

  // Creates a faction card on the board and hands its id back, so a quest or a
  // standing can name it without leaving the form.
  const createFactionCard = async (
    name: string,
    onCreated: (id: string) => void,
    onError: (message: string) => void
  ) => {
    if (!currentStory || !name.trim()) return;

    const position = { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 };

    try {
      const created: any = await canvasApi.createGraphNode(
        currentStory.id,
        'faction',
        name.trim(),
        null,
        position.x,
        position.y,
        actor,
        null
      );

      setNodes(nds => [...nds, toFlowNode(created)]);
      onCreated(created.id);
    } catch (e) {
      console.error('Failed to create a faction:', e);
      onError(`Could not create the faction: ${String(e)}`);
    }
  };

  // The live chapters, in reading order, and everything the Chapters tab and
  // the chapter cards work out from them. The chapter logic itself lives in the
  // narrative domain; these memos only say when it is worth running again.
  const chapterNodes = useMemo(() => liveChapters(nodes), [nodes]);

  // A quest shows on both chapters it names. The badge map itself lives in the
  // quests domain, because the ledger and the chapter cards read the same one.
  const questBadgesByChapter = useMemo(
    () => questsByChapter(storyQuests),
    [storyQuests]
  );

  // Duplicated, missing or absent numbers, and the story's word totals.
  const chapterIssues = useMemo(() => numberingIssues(chapterNodes), [chapterNodes]);

  const chapterTotals = useMemo(() => sumChapterWords(chapterNodes), [chapterNodes]);

  const chapterWordsPercent = wordTargetPercent(chapterTotals);

  // A chapter's POV is stored as a cast id, so the list and the timeline resolve
  // it here instead of every copy of a chapter carrying the name.
  const castNames = useMemo(
    () => new Map(characters.map(character => [character.id, character.name])),
    [characters]
  );

  // The chapter card badges describe the cast assigned to each chapter. The
  // database decides the assignment (linked cast and POV) and the snapshot; this
  // key only says when that assignment has changed enough to ask again, without
  // refetching on every node drag.
  const chapterCastAssignmentsKey = useMemo(
    () =>
      chapterNodes
        .map(
          node =>
            `${node.id}:${node.data.characterId ?? ''}:${node.data.chapterPov ?? ''}`
        )
        .join('|'),
    [chapterNodes]
  );

  useEffect(() => {
    if (!currentStory || chapterNodes.length === 0) {
      setStoryChapterCastStates(previous => (previous.length === 0 ? previous : []));
      return;
    }

    let cancelled = false;

    narrativeApi.getStoryChapterCastStates(currentStory.id)
      .then(states => {
        if (!cancelled) {
          setStoryChapterCastStates(Array.isArray(states) ? states : []);
        }
      })
      .catch(error => {
        console.error('Failed to read chapter cast states:', error);
        if (!cancelled) {
          setStoryChapterCastStates(previous => (previous.length === 0 ? previous : []));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    currentStory,
    chapterCastAssignmentsKey,
    chapterNodes.length,
    storyChapterCast,
    storyLevelMilestones,
    storySkills,
    storySkillEvents,
  ]);

  const chapterCastByChapter = useMemo(
    () => castBadgesByChapter(storyChapterCastStates, castNames),
    [storyChapterCastStates, castNames]
  );

  // The notes grouped by their chapter, and the chapters placed on the day.
  const notesByChapter = useMemo(() => groupNotesByChapter(chapterNotes), [chapterNotes]);

  const noteCount = (chapterId: string) => notesByChapter.get(chapterId)?.length ?? 0;

  const chapterTimeline = useMemo(() => timelineOrder(chapterNodes), [chapterNodes]);

  // The lost-item checks are worked out once so the Chapters tab and the chapter
  // cards say the same thing. A flag belongs to the chapter it was lost in; one
  // whose chapter is in the trash has no card of its own and stays in the panel.
  const inventoryContinuity = useMemo(() => {
    const flags: ChapterContinuityFlag[] = [];
    const chapterById = new Map(chapterNodes.map(node => [node.id, node]));

    storyInventory.forEach(item => {
      if (!item.lost_chapter_id) return;

      const owner = castNames.get(item.character_id) ?? 'A cast member';
      const lostChapter = chapterById.get(item.lost_chapter_id);
      const lostName = lostChapter ? lostChapter.data.label : 'a chapter in the trash';

      // An item marked lost but still carried is a contradiction the ledger can
      // see without guessing where in the story the author is reading.
      if (item.quantity > 0) {
        const parts: ContinuityPart[] = [
          `${owner}'s “${item.name}” is marked lost in `,
          ...(lostChapter ? [chapterLink(lostChapter.id, lostName, true)] : [lostName]),
          ` but is still carried (×${formatCount(item.quantity)}).`,
        ];

        flags.push({
          id: `inventory-${item.id}-still-carried`,
          itemId: item.id,
          itemName: item.name,
          kind: 'still-carried',
          chapterId: lostChapter?.id ?? null,
          characterId: item.character_id,
          characterName: owner,
          summary: `${owner} still has “${item.name}” (×${formatCount(item.quantity)})`,
          detail: continuityText(parts),
          parts,
          target: { kind: 'inventory', itemId: item.id },
        });
      }

      // A lost chapter earlier than the acquisition is the other mistake the
      // recorded links can prove, because both chapters have a reading position.
      const acquiredChapter = item.chapter_id
        ? chapterById.get(item.chapter_id)
        : undefined;
      const lostSeq = lostChapter?.data.chapterSeq ?? null;
      const acquiredSeq = acquiredChapter?.data.chapterSeq ?? null;

      if (
        lostChapter &&
        acquiredChapter &&
        lostSeq != null &&
        acquiredSeq != null &&
        lostSeq < acquiredSeq
      ) {
        const parts: ContinuityPart[] = [
          `${owner}'s “${item.name}” is marked lost in `,
          chapterLink(lostChapter.id, lostName, true),
          ` before it was acquired in `,
          chapterLink(acquiredChapter.id, acquiredChapter.data.label, true),
          '.',
        ];

        flags.push({
          id: `inventory-${item.id}-lost-before-acquired`,
          itemId: item.id,
          itemName: item.name,
          kind: 'lost-before-acquired',
          chapterId: lostChapter.id,
          characterId: item.character_id,
          characterName: owner,
          summary: `${owner}'s “${item.name}” lost before acquired`,
          detail: continuityText(parts),
          parts,
          target: { kind: 'inventory', itemId: item.id },
        });
      }
    });

    return flags;
  }, [chapterNodes, castNames, storyInventory]);

  // A chapter card carries the lost-item warnings filed under the chapter whose
  // card it is, so the problem is visible where the chapter sits on the board.
  const inventoryFlagsByChapter = useMemo(() => {
    const byChapter = new Map<string, ChapterContinuityFlag[]>();

    inventoryContinuity.forEach(flag => {
      if (!flag.chapterId) return;

      const existing = byChapter.get(flag.chapterId) ?? [];
      existing.push(flag);
      byChapter.set(flag.chapterId, existing);
    });

    return byChapter;
  }, [inventoryContinuity]);

  // Progression is compared in reading order. A level can go backward only when
  // that milestone says it was a penalty; a skill can be used before it was
  // learned or after it was sacrificed; a rank can be used before the upgrade
  // that reached it; and income through a chapter must add up to the total-XP
  // milestone recorded there.
  const progressContinuity = useMemo(() => {
    const flags: ChapterContinuityFlag[] = [];
    const chapterById = new Map(chapterNodes.map(node => [node.id, node]));
    const seqById = new Map(
      chapterNodes.map(node => [
        node.id,
        node.data.chapterSeq ?? Number.MAX_SAFE_INTEGER,
      ])
    );
    const seqOf = (chapterId: string | null) =>
      chapterId ? seqById.get(chapterId) ?? null : null;
    const characterLink = (
      characterId: string,
      name: string,
      target: ProgressionTarget
    ): ContinuityPart => ({ id: characterId, text: name, kind: 'character', target });

    // One level per chapter: the last one recorded there is the one that counts,
    // so two notes on the same chapter cannot make a false regression.
    const milestonesByCharacter = new Map<string, CharacterLevelMilestone[]>();

    for (const milestone of storyLevelMilestones) {
      if (!milestone.chapter_id || seqOf(milestone.chapter_id) == null) continue;
      const existing = milestonesByCharacter.get(milestone.character_id) ?? [];
      existing.push(milestone);
      milestonesByCharacter.set(milestone.character_id, existing);
    }

    milestonesByCharacter.forEach((milestones, characterId) => {
      const owner = castNames.get(characterId) ?? 'A cast member';
      const byChapter = new Map<string, CharacterLevelMilestone>();

      for (const milestone of [...milestones].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
      )) {
        byChapter.set(milestone.chapter_id as string, milestone);
      }

      const ordered = [...byChapter.values()].sort(
        (a, b) =>
          (seqOf(a.chapter_id) ?? Number.MAX_SAFE_INTEGER) -
          (seqOf(b.chapter_id) ?? Number.MAX_SAFE_INTEGER)
      );

      for (let index = 1; index < ordered.length; index += 1) {
        const before = ordered[index - 1];
        const after = ordered[index];

        if (after.level >= before.level || after.is_debuff) continue;

        const beforeChapter = chapterById.get(before.chapter_id as string);
        const afterChapter = chapterById.get(after.chapter_id as string);
        if (!beforeChapter || !afterChapter) continue;

        const target: ProgressionTarget = { kind: 'level', milestoneId: after.id };
        const parts: ContinuityPart[] = [
          characterLink(characterId, owner, target),
          `'s level goes back from ${before.level} in `,
          chapterLink(beforeChapter.id, beforeChapter.data.label, true),
          ` to ${after.level} in `,
          chapterLink(afterChapter.id, afterChapter.data.label, true),
          '.',
        ];

        flags.push({
          id: `level-${after.id}`,
          kind: 'level-regression',
          chapterId: afterChapter.id,
          characterId,
          characterName: owner,
          summary: `${owner}'s level drops to ${after.level} in ${afterChapter.data.label}`,
          detail: continuityText(parts),
          parts,
          target,
        });
      }
    });

    // A total-XP milestone is a running total, while the ledger records income.
    // Sum each character's income through a milestone's chapter and compare the
    // two; the last snapshot in a chapter is the one that counts. A character
    // with no income rows has not started a ledger, so older stories that only
    // used totals are left alone rather than warned about on every chapter.
    const incomeByCharacter = new Map<string, Map<string, number>>();

    for (const entry of storyCharacterProgress) {
      if (!chapterById.has(entry.chapter_id)) continue;

      const byChapter = incomeByCharacter.get(entry.character_id) ?? new Map<string, number>();
      byChapter.set(
        entry.chapter_id,
        (byChapter.get(entry.chapter_id) ?? 0) + entry.xp_earned
      );
      incomeByCharacter.set(entry.character_id, byChapter);
    }

    milestonesByCharacter.forEach((milestones, characterId) => {
      const income = incomeByCharacter.get(characterId);
      if (!income || income.size === 0) return;

      const owner = castNames.get(characterId) ?? 'A cast member';
      const totalsByChapter = new Map<string, CharacterLevelMilestone>();

      for (const milestone of [...milestones].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
      )) {
        if (milestone.xp != null) {
          totalsByChapter.set(milestone.chapter_id as string, milestone);
        }
      }

      if (totalsByChapter.size === 0) return;

      let earned = 0;

      for (const chapter of chapterNodes) {
        earned += income.get(chapter.id) ?? 0;

        const milestone = totalsByChapter.get(chapter.id);
        if (!milestone) continue;

        const recorded = milestone.xp as number;
        if (earned === recorded) continue;

        const target: ProgressionTarget = { kind: 'level', milestoneId: milestone.id };
        const difference = Math.abs(recorded - earned);
        const parts: ContinuityPart[] = [
          characterLink(characterId, owner, target),
          `'s XP earned through `,
          chapterLink(chapter.id, chapter.data.label, true),
          ` adds up to ${formatCount(earned)} XP, but the total XP milestone there records ${formatCount(
            recorded
          )} XP (${formatCount(difference)} ${earned < recorded ? 'short' : 'over'}).`,
        ];

        flags.push({
          id: `xp-income-${milestone.id}`,
          kind: 'xp-income-mismatch',
          chapterId: chapter.id,
          characterId,
          characterName: owner,
          ledgerXp: earned,
          summary: `${owner}'s XP income is ${formatCount(
            earned
          )} XP, milestone says ${formatCount(recorded)}`,
          detail: continuityText(parts),
          parts,
          target,
        });
      }
    });

    // A relation or a standing can point at the trash, or describe an arc that
    // ends before it began. The same advisory pass names those, because they are
    // read from the same chapter order as the rest of progression.
    const factionLabels = new Map(
      nodes
        .filter(node => node.data.nodeType === 'faction')
        .map(node => [node.id, node.data.label])
    );

    for (const relation of storyRelations) {
      const fromName = castNames.get(relation.from_character_id);
      const toName = castNames.get(relation.to_character_id);

      // Both ends in the trash: there is no sheet left to open, so nothing is
      // claimed about a bond that cannot be read on either side.
      if (!fromName && !toName) continue;

      const target: ProgressionTarget = { kind: 'relation', relationId: relation.id };
      const chapterId = relation.since_chapter_id ?? relation.until_chapter_id;

      if (!fromName || !toName) {
        const liveId = fromName ? relation.from_character_id : relation.to_character_id;
        const liveName = (fromName ?? toName) as string;
        const parts: ContinuityPart[] = [
          characterLink(liveId, liveName, target),
          `'s ${relation.kind} relation points at a cast member in the trash.`,
        ];

        flags.push({
          id: `relation-trashed-${relation.id}`,
          kind: 'relation-trashed-cast',
          chapterId,
          characterId: liveId,
          characterName: liveName,
          summary: `${liveName}'s ${relation.kind} is in the trash`,
          detail: continuityText(parts),
          parts,
          target,
        });
        continue;
      }

      const sinceSeq = seqOf(relation.since_chapter_id);
      const untilSeq = seqOf(relation.until_chapter_id);

      if (sinceSeq == null || untilSeq == null || untilSeq >= sinceSeq) continue;

      const sinceChapter = chapterById.get(relation.since_chapter_id as string);
      const untilChapter = chapterById.get(relation.until_chapter_id as string);

      if (!sinceChapter || !untilChapter) continue;

      const parts: ContinuityPart[] = [
        characterLink(relation.from_character_id, fromName, target),
        `'s ${relation.kind} relation with ${toName} ends in `,
        chapterLink(untilChapter.id, untilChapter.data.label, true),
        ' before it begins in ',
        chapterLink(sinceChapter.id, sinceChapter.data.label, true),
        '.',
      ];

      flags.push({
        id: `relation-order-${relation.id}`,
        kind: 'relation-ends-before-it-begins',
        chapterId: relation.until_chapter_id,
        characterId: relation.from_character_id,
        characterName: fromName,
        summary: `${fromName}'s ${relation.kind} ends before it begins`,
        detail: continuityText(parts),
        parts,
        target,
      });
    }

    for (const standing of storyFactionStandings) {
      const owner = castNames.get(standing.character_id);

      if (!owner) continue;

      const target: ProgressionTarget = {
        kind: 'faction-standing',
        standingId: standing.id,
      };
      const factionName = standing.faction_node_id
        ? factionLabels.get(standing.faction_node_id)
        : undefined;
      const chapterId = standing.since_chapter_id ?? standing.until_chapter_id;

      if (!factionName) {
        const parts: ContinuityPart[] = [
          characterLink(standing.character_id, owner, target),
          `'s ${standing.standing} standing is on a faction card in the trash.`,
        ];

        flags.push({
          id: `standing-trashed-${standing.id}`,
          kind: 'standing-faction-trashed',
          chapterId,
          characterId: standing.character_id,
          characterName: owner,
          summary: `${owner}'s ${standing.standing} faction is in the trash`,
          detail: continuityText(parts),
          parts,
          target,
        });
        continue;
      }

      const sinceSeq = seqOf(standing.since_chapter_id);
      const untilSeq = seqOf(standing.until_chapter_id);

      if (
        standing.since_chapter_id &&
        standing.until_chapter_id &&
        sinceSeq != null &&
        untilSeq != null &&
        untilSeq < sinceSeq
      ) {
        const sinceChapter = chapterById.get(standing.since_chapter_id);
        const untilChapter = chapterById.get(standing.until_chapter_id);

        if (sinceChapter && untilChapter) {
          const parts: ContinuityPart[] = [
            characterLink(standing.character_id, owner, target),
            `'s ${standing.standing} standing in ${factionName} ends in `,
            chapterLink(untilChapter.id, untilChapter.data.label, true),
            ' before it begins in ',
            chapterLink(sinceChapter.id, sinceChapter.data.label, true),
            '.',
          ];

          flags.push({
            id: `standing-order-${standing.id}`,
            kind: 'standing-ends-before-it-begins',
            chapterId: standing.until_chapter_id,
            characterId: standing.character_id,
            characterName: owner,
            summary: `${owner}'s ${standing.standing} standing ends before it begins`,
            detail: continuityText(parts),
            parts,
            target,
          });
        }
      }

      // Two stints in one faction that share a chapter contradict each other:
      // a person cannot be a captain and an exile at the same moment. Each pair
      // is named once, against the stint that starts later.
      for (const other of storyFactionStandings) {
        if (
          other.id <= standing.id ||
          other.character_id !== standing.character_id ||
          other.faction_node_id !== standing.faction_node_id
        ) {
          continue;
        }

        const leftStart = seqOf(standing.since_chapter_id);
        const rightStart = seqOf(other.since_chapter_id);

        if (leftStart == null || rightStart == null) continue;

        const leftEnd = seqOf(standing.until_chapter_id) ?? Number.MAX_SAFE_INTEGER;
        const rightEnd = seqOf(other.until_chapter_id) ?? Number.MAX_SAFE_INTEGER;

        if (leftStart > rightEnd || rightStart > leftEnd) continue;

        const later = rightStart >= leftStart ? other : standing;
        const earlier = later.id === standing.id ? other : standing;
        const laterChapter = chapterById.get(later.since_chapter_id as string);
        const earlierChapter = chapterById.get(earlier.since_chapter_id as string);

        if (!laterChapter || !earlierChapter) continue;

        const laterTarget: ProgressionTarget = {
          kind: 'faction-standing',
          standingId: later.id,
        };
        const parts: ContinuityPart[] = [
          characterLink(standing.character_id, owner, laterTarget),
          ` holds two standings in ${factionName} at once: ${earlier.standing} since `,
          chapterLink(earlierChapter.id, earlierChapter.data.label, true),
          ` and ${later.standing} since `,
          chapterLink(laterChapter.id, laterChapter.data.label, true),
          '.',
        ];

        flags.push({
          id: `standing-overlap-${earlier.id}-${later.id}`,
          kind: 'standing-overlap',
          chapterId: later.since_chapter_id,
          characterId: standing.character_id,
          characterName: owner,
          summary: `${owner} holds two standings in ${factionName} at once`,
          detail: continuityText(parts),
          parts,
          target: laterTarget,
        });
      }
    }

    const skillById = new Map(storySkills.map(skill => [skill.id, skill]));
    const eventsBySkill = new Map<string, CharacterSkillEvent[]>();

    for (const event of storySkillEvents) {
      if (!event.chapter_id || seqOf(event.chapter_id) == null) continue;
      const existing = eventsBySkill.get(event.skill_id) ?? [];
      existing.push(event);
      eventsBySkill.set(event.skill_id, existing);
    }

    eventsBySkill.forEach((events, skillId) => {
      const skill = skillById.get(skillId);
      if (!skill) return;

      const owner = castNames.get(skill.character_id) ?? 'A cast member';
      const ordered = [...events].sort(
        (a, b) =>
          (seqOf(a.chapter_id) ?? Number.MAX_SAFE_INTEGER) -
          (seqOf(b.chapter_id) ?? Number.MAX_SAFE_INTEGER) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id)
      );
      const acquisitionChapter = skill.chapter_id
        ? chapterById.get(skill.chapter_id)
        : undefined;
      const acquisitionSeq = seqOf(skill.chapter_id);
      const upgrades = ordered.filter(
        event => event.kind === 'upgraded' && event.rank?.trim()
      );
      const sacrifices = ordered.filter(event => event.kind === 'sacrificed');

      for (const use of ordered) {
        if (use.kind !== 'used') continue;

        const useChapter = chapterById.get(use.chapter_id as string);
        const useSeq = seqOf(use.chapter_id);
        if (!useChapter || useSeq == null) continue;

        const target: ProgressionTarget = {
          kind: 'skill-event',
          eventId: use.id,
          skillId,
        };

        if (
          acquisitionChapter &&
          acquisitionSeq != null &&
          useSeq < acquisitionSeq
        ) {
          const parts: ContinuityPart[] = [
            characterLink(skill.character_id, owner, target),
            `'s “${skill.name}” is used in `,
            chapterLink(useChapter.id, useChapter.data.label, true),
            ` before it was learned in `,
            chapterLink(acquisitionChapter.id, acquisitionChapter.data.label, true),
            '.',
          ];

          flags.push({
            id: `skill-${use.id}-before-acquired`,
            kind: 'skill-before-acquired',
            chapterId: useChapter.id,
            characterId: skill.character_id,
            characterName: owner,
            summary: `${owner}'s “${skill.name}” used before learned`,
            detail: continuityText(parts),
            parts,
            target,
          });
          continue;
        }

        const usedRank = use.rank?.trim();

        if (usedRank) {
          const upgrade = upgrades.find(
            event =>
              event.rank?.trim().toLowerCase() === usedRank.toLowerCase() &&
              seqOf(event.chapter_id) != null &&
              (seqOf(event.chapter_id) as number) > useSeq
          );

          if (upgrade) {
            const upgradeChapter = chapterById.get(upgrade.chapter_id as string);

            if (upgradeChapter) {
              const parts: ContinuityPart[] = [
                characterLink(skill.character_id, owner, target),
                `'s “${skill.name}” is used at ${usedRank} in `,
                chapterLink(useChapter.id, useChapter.data.label, true),
                ` before that rank is gained in `,
                chapterLink(upgradeChapter.id, upgradeChapter.data.label, true),
                '.',
              ];

              flags.push({
                id: `skill-${use.id}-rank-before-upgrade`,
                kind: 'skill-rank-before-upgrade',
                chapterId: useChapter.id,
                characterId: skill.character_id,
                characterName: owner,
                summary: `${owner}'s “${skill.name}” ${usedRank} used early`,
                detail: continuityText(parts),
                parts,
                target,
              });
            }
          }
        }

        const sacrifice = sacrifices
          .filter(event => (seqOf(event.chapter_id) ?? Number.MAX_SAFE_INTEGER) < useSeq)
          .pop();

        if (sacrifice) {
          const sacrificeChapter = chapterById.get(sacrifice.chapter_id as string);

          if (sacrificeChapter) {
            const parts: ContinuityPart[] = [
              characterLink(skill.character_id, owner, target),
              `'s “${skill.name}” is used in `,
              chapterLink(useChapter.id, useChapter.data.label, true),
              ` after it was sacrificed in `,
              chapterLink(sacrificeChapter.id, sacrificeChapter.data.label, true),
              '.',
            ];

            flags.push({
              id: `skill-${use.id}-after-sacrifice`,
              kind: 'skill-after-sacrifice',
              chapterId: useChapter.id,
              characterId: skill.character_id,
              characterName: owner,
              summary: `${owner}'s “${skill.name}” used after sacrifice`,
              detail: continuityText(parts),
              parts,
              target,
            });
          }
        }
      }

      // An upgrade after a sacrifice is the same contradiction from the other
      // side: the skill is gone, yet it is still being made stronger.
      for (const upgrade of upgrades) {
        const upgradeChapter = chapterById.get(upgrade.chapter_id as string);
        const upgradeSeq = seqOf(upgrade.chapter_id);
        if (!upgradeChapter || upgradeSeq == null) continue;

        const sacrifice = sacrifices
          .filter(
            event => (seqOf(event.chapter_id) ?? Number.MAX_SAFE_INTEGER) < upgradeSeq
          )
          .pop();

        if (!sacrifice) continue;

        const sacrificeChapter = chapterById.get(sacrifice.chapter_id as string);
        if (!sacrificeChapter) continue;

        const target: ProgressionTarget = {
          kind: 'skill-event',
          eventId: upgrade.id,
          skillId,
        };
        const parts: ContinuityPart[] = [
          characterLink(skill.character_id, owner, target),
          `'s “${skill.name}” is upgraded in `,
          chapterLink(upgradeChapter.id, upgradeChapter.data.label, true),
          ` after it was sacrificed in `,
          chapterLink(sacrificeChapter.id, sacrificeChapter.data.label, true),
          '.',
        ];

        flags.push({
          id: `skill-${upgrade.id}-upgraded-after-sacrifice`,
          kind: 'skill-after-sacrifice',
          chapterId: upgradeChapter.id,
          characterId: skill.character_id,
          characterName: owner,
          summary: `${owner}'s “${skill.name}” upgraded after sacrifice`,
          detail: continuityText(parts),
          parts,
          target,
        });
      }
    });

    // A skill tree is read against the same chapter order. A link whose parent
    // or child is in the trash cannot be followed; a child that appears before
    // its parent was learned is a contradiction; and a fusion placed before the
    // parent reached the rank it required is another.
    const firstEventBySkill = new Map<string, CharacterSkillEvent>();

    for (const event of storySkillEvents) {
      if (!event.chapter_id || seqOf(event.chapter_id) == null) continue;
      const current = firstEventBySkill.get(event.skill_id);

      if (
        !current ||
        (seqOf(event.chapter_id) as number) <
          (seqOf(current.chapter_id) as number)
      ) {
        firstEventBySkill.set(event.skill_id, event);
      }
    }

    for (const evolution of storySkillEvolutions) {
      const parent = skillById.get(evolution.parent_skill_id);
      const child = skillById.get(evolution.child_skill_id);

      if (!parent || !child) {
        const present = parent ?? child;
        if (!present) continue;

        const ownerId = present.character_id;
        const owner = castNames.get(ownerId) ?? 'A cast member';
        const target: ProgressionTarget = { kind: 'skill', skillId: present.id };
        const missing = parent ? 'child' : 'parent';
        const parts: ContinuityPart[] = [
          characterLink(ownerId, owner, target),
          `'s ${evolution.evolution_type} link has a ${missing} skill in the trash.`,
        ];

        flags.push({
          id: `skill-evolution-trashed-${evolution.id}`,
          kind: 'skill-evolution-trashed',
          chapterId: evolution.chapter_id,
          characterId: ownerId,
          characterName: owner,
          summary: `${owner}'s skill evolution points at the trash`,
          detail: continuityText(parts),
          parts,
          target,
        });
        continue;
      }

      const owner = castNames.get(child.character_id) ?? 'A cast member';
      const target: ProgressionTarget = { kind: 'skill', skillId: child.id };
      const parentAcquired = seqOf(parent.chapter_id);
      const parentChapter = parent.chapter_id
        ? chapterById.get(parent.chapter_id)
        : undefined;
      const childSeen = [
        seqOf(child.chapter_id),
        firstEventBySkill.has(child.id)
          ? seqOf((firstEventBySkill.get(child.id) as CharacterSkillEvent).chapter_id)
          : null,
      ].filter((value): value is number => value != null);
      const childFirst = childSeen.length > 0 ? Math.min(...childSeen) : null;
      const childChapterId =
        firstEventBySkill.get(child.id)?.chapter_id ?? child.chapter_id;
      const childChapter = childChapterId ? chapterById.get(childChapterId) : undefined;

      const childBeforeParent =
        parentAcquired != null &&
        Boolean(parentChapter) &&
        childFirst != null &&
        childFirst < parentAcquired &&
        Boolean(childChapter);

      if (childBeforeParent && childChapter && parentChapter) {
        const parts: ContinuityPart[] = [
          characterLink(child.character_id, owner, target),
          `'s “${child.name}” appears in `,
          chapterLink(childChapter.id, childChapter.data.label, true),
          ` before its parent skill “${parent.name}” is learned in `,
          chapterLink(parentChapter.id, parentChapter.data.label, true),
          '.',
        ];

        flags.push({
          id: `skill-evolution-${evolution.id}-before-parent`,
          kind: 'skill-evolution-before-parent',
          chapterId: childChapter.id,
          characterId: child.character_id,
          characterName: owner,
          summary: `${owner}'s “${child.name}” appears before “${parent.name}”`,
          detail: continuityText(parts),
          parts,
          target,
        });
      }

      const evolutionSeq = seqOf(evolution.chapter_id);

      // The child's own chapter already said this above; only the link's own
      // chapter needs a second warning when the two disagree with the parent.
      if (
        !childBeforeParent &&
        evolutionSeq != null &&
        parentAcquired != null &&
        evolutionSeq < parentAcquired &&
        parentChapter
      ) {
        const evolutionChapter = chapterById.get(evolution.chapter_id as string);

        if (evolutionChapter) {
          const parts: ContinuityPart[] = [
            characterLink(child.character_id, owner, target),
            `'s “${child.name}” evolves from “${parent.name}” in `,
            chapterLink(evolutionChapter.id, evolutionChapter.data.label, true),
            ` before that parent is learned in `,
            chapterLink(parentChapter.id, parentChapter.data.label, true),
            '.',
          ];

          flags.push({
            id: `skill-evolution-${evolution.id}-chapter-before-parent`,
            kind: 'skill-evolution-before-parent',
            chapterId: evolutionChapter.id,
            characterId: child.character_id,
            characterName: owner,
            summary: `${owner}'s “${child.name}” evolves before “${parent.name}” exists`,
            detail: continuityText(parts),
            parts,
            target,
          });
        }
      }

      const requiredRank = evolution.required_rank?.trim();

      if (evolutionSeq != null && requiredRank) {
        const upgrade = storySkillEvents.find(
          event =>
            event.skill_id === parent.id &&
            event.kind === 'upgraded' &&
            event.rank?.trim().toLowerCase() === requiredRank.toLowerCase() &&
            (seqOf(event.chapter_id) ?? Number.MAX_SAFE_INTEGER) > evolutionSeq
        );
        const evolutionChapter = chapterById.get(evolution.chapter_id as string);
        const upgradeChapter = upgrade?.chapter_id
          ? chapterById.get(upgrade.chapter_id)
          : undefined;

        if (upgradeChapter && evolutionChapter) {
          const parts: ContinuityPart[] = [
            characterLink(child.character_id, owner, target),
            `'s “${child.name}” is unlocked in `,
            chapterLink(evolutionChapter.id, evolutionChapter.data.label, true),
            ` but “${parent.name}” only reaches ${requiredRank} in `,
            chapterLink(upgradeChapter.id, upgradeChapter.data.label, true),
            '.',
          ];

          flags.push({
            id: `skill-evolution-${evolution.id}-rank-late`,
            kind: 'skill-evolution-rank-late',
            chapterId: evolutionChapter.id,
            characterId: child.character_id,
            characterName: owner,
            summary: `${owner}'s “${child.name}” unlocked before ${requiredRank}`,
            detail: continuityText(parts),
            parts,
            target,
          });
        }
      }
    }

    return flags;
  }, [
    chapterNodes,
    castNames,
    storyLevelMilestones,
    storyCharacterProgress,
    storySkillEvents,
    storySkills,
    storySkillEvolutions,
    storyRelations,
    storyFactionStandings,
    nodes,
  ]);

  const progressFlagsByChapter = useMemo(() => {
    const byChapter = new Map<string, ChapterContinuityFlag[]>();

    progressContinuity.forEach(flag => {
      if (!flag.chapterId) return;
      const existing = byChapter.get(flag.chapterId) ?? [];
      existing.push(flag);
      byChapter.set(flag.chapterId, existing);
    });

    return byChapter;
  }, [progressContinuity]);

  // A warning names the cast member whose ledger contradicts it. Opening their
  // sheet from the card puts the item, level or skill event in front of the
  // author, so the fix starts where the warning is rather than in a search.
  const openCharacterSheet = useCallback(
    (characterId: string, target?: ProgressionTarget) => {
      setSelectedTab('characters');
      // A warning or a map edge opens the entry on the sheet, not the map.
      setCharacterView('sheet');
      setSelectedCharacterId(characterId);
      setEditingProgress(false);
      setCharacterError(null);

      if (progressionFocusTimer.current != null) {
        window.clearTimeout(progressionFocusTimer.current);
        progressionFocusTimer.current = null;
      }

      if (!target || target.kind === 'inventory') {
        setFocusedProgression(null);

        // The sheet is rendered by the tab that was just switched to, so scroll
        // its row into view after that render rather than against the old list.
        setTimeout(() => {
          document
            .querySelector(`[data-character-id="${characterId}"]`)
            ?.scrollIntoView?.({ block: 'nearest' });
        }, 0);
        return;
      }

      // A progression warning names the exact entry that contradicts the story.
      // Opening its editor puts the fix in front of the author instead of making
      // them find the row by hand.
      let focusId =
        target.kind === 'level'
          ? target.milestoneId
          : target.kind === 'skill-event'
            ? target.eventId
            : target.kind === 'relation'
              ? target.relationId
              : target.kind === 'faction-standing'
                ? target.standingId
                : target.skillId;

      if (target.kind === 'relation') {
        const relation = storyRelations.find(entry => entry.id === target.relationId);

        setEditingLevelMilestoneId(null);
        setEditingStandingId(null);

        if (relation) {
          setEditingRelationId(relation.id);
          setRelationKindDraft(relation.kind);
          setRelationChapterDraft(relation.since_chapter_id ?? '');
          setRelationUntilChapterDraft(relation.until_chapter_id ?? '');
          setRelationNoteDraft(relation.note ?? '');
        }
      } else if (target.kind === 'faction-standing') {
        const standing = storyFactionStandings.find(
          entry => entry.id === target.standingId
        );

        setEditingLevelMilestoneId(null);
        setEditingRelationId(null);

        if (standing) {
          setEditingStandingId(standing.id);
          setStandingFactionDraft(standing.faction_node_id ?? '');
          setStandingTextDraft(standing.standing);
          setStandingChapterDraft(standing.since_chapter_id ?? '');
          setStandingUntilChapterDraft(standing.until_chapter_id ?? '');
          setStandingNoteDraft(standing.note ?? '');
        }
      } else if (target.kind === 'level') {
        const milestone = storyLevelMilestones.find(entry => entry.id === target.milestoneId);

        if (milestone) {
          setEditingLevelMilestoneId(milestone.id);
          setLevelMilestoneLevelDraft(String(milestone.level));
          setLevelMilestoneChapterDraft(milestone.chapter_id ?? '');
          setLevelMilestoneDebuffDraft(milestone.is_debuff);
          setLevelMilestoneXpDraft(milestone.xp == null ? '' : String(milestone.xp));
          setLevelMilestoneStatChangesDraft(statChangesFromMilestone(milestone));
        }
      } else if (target.kind === 'skill-event') {
        const event = storySkillEvents.find(entry => entry.id === target.eventId);
        focusId = target.eventId;

        if (event) setEditingLevelMilestoneId(null);
      } else {
        const skill = storySkills.find(entry => entry.id === target.skillId);

        if (skill) setEditingLevelMilestoneId(null);
      }

      setFocusedProgression({ kind: target.kind, id: focusId });
      progressionFocusTimer.current = window.setTimeout(() => {
        setFocusedProgression(null);
        progressionFocusTimer.current = null;
      }, 5000);

      // The sheet is rendered by the tab that was just switched to, so scroll its
      // entry into view after that render rather than against the old list.
      setTimeout(() => {
        document
          .querySelector(`[data-progression="${target.kind}-${focusId}"]`)
          ?.scrollIntoView?.({ block: 'nearest' });
      }, 0);
    },
    [storyLevelMilestones, storySkillEvents, storySkills, storyRelations, storyFactionStandings]
  );

  // Continuity is advisory: nothing here blocks a save. It names what looks
  // inconsistent — a chapter with no POV, a time with no day to place it on, a
  // day that goes backwards, a time that goes backwards inside a day, two
  // chapters at the same moment, one cast member in two chapters on the same
  // day, an item still carried after it was lost, a level or skill that
  // contradicts its recorded chapters, or XP income that does not add up to a
  // recorded total — and leaves the decision to the author.
  // Every chapter it names is a link that opens that chapter, and every
  // progression entry opens on the holder's sheet, so a flag leads to the
  // thing to fix.
  // Every line keeps the warning it came from when it has one, so the panel can
  // offer a fix beside the sentence rather than sending the author to a sheet.
  const chapterContinuity = useMemo(() => {
    const warnings: { parts: ContinuityPart[]; flag?: ChapterContinuityFlag }[] = [];

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
      warnings.push({
        parts: [
          `${withoutPov.length} chapter${
            withoutPov.length === 1 ? ' has' : 's have'
          } no POV: `,
          ...commaList(withoutPov.map(node => ({ id: node.id, label: node.data.label }))),
          '.',
        ],
      });
    }

    // A time without a day is kept but cannot be placed: the timeline has
    // nothing to order the label against, so the author is told where to put it.
    const timeWithoutDay = chapterNodes.filter(
      node => node.data.chapterDay == null && (node.data.chapterTime ?? '').trim() !== ''
    );

    if (timeWithoutDay.length > 0) {
      warnings.push({
        parts: [
          `${timeWithoutDay.length} chapter${
            timeWithoutDay.length === 1 ? ' has' : 's have'
          } a time but no day: `,
          ...commaList(timeWithoutDay.map(node => ({ id: node.id, label: node.data.label }))),
          '.',
        ],
      });
    }

    // Reading order, with the chapters that are not placed in time skipped.
    const placed = chapterNodes.filter(node => node.data.chapterDay != null);

    for (let index = 1; index < placed.length; index += 1) {
      const before = placed[index - 1];
      const after = placed[index];

      if ((after.data.chapterDay ?? 0) < (before.data.chapterDay ?? 0)) {
        warnings.push({
          parts: [
            chapterLink(after.id, after.data.label, true),
            ` goes back to Day ${after.data.chapterDay} after `,
            chapterLink(before.id, before.data.label, true),
            ` on Day ${before.data.chapterDay}.`,
          ],
        });
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

      warnings.push({
        parts: [
          chapterLink(after.id, after.data.label, true),
          ` goes back to ${after.data.chapterTime} after `,
          chapterLink(before.id, before.data.label, true),
          ` at ${before.data.chapterTime} on Day ${after.data.chapterDay}.`,
        ],
      });
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
        warnings.push({
          parts: [
            ...andList(moment.chapters),
            ` ${moment.chapters.length === 2 ? 'are both' : 'are all'} at ${
              moment.chapters[0].time
            } on Day ${moment.day}.`,
          ],
        });
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

      warnings.push({ parts });
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

      warnings.push({
        parts: [
          `${
            castNames.get(booking.pov) ?? 'A cast member in the trash'
          } is the POV of ${booking.chapters.length} chapters on Day ${booking.day}: `,
          ...commaList(booking.chapters),
          '.',
        ],
      });
    });

    warnings.push(
      ...inventoryContinuity.map(flag => ({ parts: flag.parts, flag })),
      ...progressContinuity.map(flag => ({ parts: flag.parts, flag }))
    );

    return warnings;
  }, [chapterNodes, castNames, inventoryContinuity, progressContinuity]);

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
    // A closed form holds no draft. Saving closes it and leaves the baseline it
    // opened with behind, so comparing against that would call saved work dirty
    // and block every tab with a question that has no form left to show it in.
    if (editingChapterId == null) return false;

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

  // A chapter card's quest badge opens the ledger on that quest, the way a cast
  // badge opens a sheet. The ledger puts its filter back to every status and
  // scrolls the row into view; only the tab and the lit quest are the app's, and
  // every click is a fresh request so the same badge works twice.
  const openQuest = useCallback((questId: string) => {
    setSelectedTab('quests');
    setQuestFocus(previous => ({ questId, request: (previous?.request ?? 0) + 1 }));
  }, []);

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

    const updated: any[] = await narrativeApi.setChapterOrder(currentStory.id, orderedIds, actor);

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

  const addChapter = async () => {
    if (!currentStory || !newChapterTitle.trim()) return;

    const position = { x: 120 + Math.random() * 360, y: 100 + Math.random() * 240 };

    setChapterBusy(true);
    setChapterError(null);

    try {
      const created: any = await canvasApi.createGraphNode(
        currentStory.id,
        'chapter',
        newChapterTitle.trim(),
        null,
        position.x,
        position.y,
        actor,
        null
      );

      setNodes(previous => [...previous, toFlowNode(created)]);
      setNewChapterTitle('');

      recordStep({
        label: `Add “${created.label}”`,
        undo: () => canvasApi.deleteNode(created.id, actor),
        redo: () => trashApi.restoreDeleted(created.id, 'node', actor),
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
      const updated: any = await narrativeApi.setChapterDetails(
        editingChapterId,
        chapterArcDraft.trim() || null,
        words,
        target,
        chapterPovDraft || null,
        day,
        chapterTimeDraft.trim() || null,
        actor
      );

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

  const chapterCastIsExplicit = (chapterId: string, characterId: string) =>
    storyChapterCast.some(
      member => member.chapter_id === chapterId && member.character_id === characterId
    );

  const toggleChapterCastPanel = (chapterId: string) => {
    setChapterCastError(null);
    setOpenChapterCastId(current => (current === chapterId ? null : chapterId));
  };

  // The card's linked cast member and POV are always present. This adds or
  // removes the rest of the scene's cast, one command per person, so every
  // change is recorded in the history like any other edit.
  const setChapterCastPresence = async (
    chapterId: string,
    characterId: string,
    present: boolean
  ) => {
    const existing = storyChapterCast.find(
      member => member.chapter_id === chapterId && member.character_id === characterId
    );

    if (present && existing) return;
    if (!present && !existing) return;

    setChapterCastBusyId(characterId);
    setChapterCastError(null);

    try {
      if (present) {
        const created = await narrativeApi.addChapterCastMember(chapterId, characterId, actor);

        setStoryChapterCast(previous =>
          previous.some(member => member.id === created.id) ? previous : [...previous, created]
        );
      } else {
        if (!existing) return;
        const removingId = existing.id;

        await narrativeApi.removeChapterCastMember(removingId, actor);
        setStoryChapterCast(previous =>
          previous.filter(member => member.id !== removingId)
        );
      }
    } catch (e) {
      console.error('Failed to change the chapter cast:', e);
      setChapterCastError(`Could not change the chapter cast: ${String(e)}`);
    } finally {
      setChapterCastBusyId(null);
    }
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
      const created: any = await narrativeApi.addChapterNote(chapterId, text, actor);

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
      const updated: any = await narrativeApi.updateChapterNote(editingNoteId, text, actor);
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
      await canvasApi.deleteNode(note.id, actor);

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

  // A note card on the canvas is a way into the note, not another copy of it: the
  // Chapters tab opens with that chapter's notes showing and the card's note lit.
  const openNoteFromGraph = useCallback(
    (chapterId: string, noteId: string | null) => {
      setSelectedTab('chapters');
      openChapterNotes(chapterId, noteId);
    },
    []
  );

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
        const updated: any = await canvasApi.setNodeCharacter(target.id, character.id, actor);

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
            canvasApi.setNodeCharacter(target.id, previousId, actor),
          redo: () =>
            canvasApi.setNodeCharacter(target.id, character.id, actor),
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
      const created: any = await canvasApi.createGraphNode(
        currentStory.id,
        'character',
        character.name,
        null,
        position.x,
        position.y,
        actor,
        character.id
      );

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
        undo: () => canvasApi.deleteNode(created.id, actor),
        redo: () => trashApi.restoreDeleted(created.id, 'node', actor),
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

  // A holder added or taken away by a canvas connection touches the story list
  // always and the open sheet only when it is that character's. Both keep the
  // order the database reads them in, so the board and the sheet agree before the
  // story is reopened.
  const showSkillOnLists = (skill: CharacterSkill) => {
    const ordered = (list: CharacterSkill[]) =>
      [...list.filter(other => other.id !== skill.id), skill].sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
      );

    setStorySkills(ordered);
    if (skill.character_id === selectedCharacterId) setCharacterSkills(ordered);
  };

  const hideSkillOnLists = (id: string, characterId: string) => {
    setStorySkills(previous => previous.filter(row => row.id !== id));

    if (characterId === selectedCharacterId) {
      setCharacterSkills(previous => previous.filter(row => row.id !== id));
    }
  };

  // A connection means something different depending on what it joins. Two
  // character cards ask for a relation, a character and a chapter add that
  // character to the chapter's cast, and anything else stays a plain edge.
  const onConnect = useCallback(
    async (params: Connection) => {
      if (!currentStory || !params.source || !params.target) return;

      connectionMadeRef.current = true;
      setActionError(null);

      const sourceNode = nodes.find(node => node.id === params.source);
      const targetNode = nodes.find(node => node.id === params.target);

      const sourceCharacterId =
        sourceNode?.data.nodeType === 'character' ? sourceNode.data.characterId ?? null : null;
      const targetCharacterId =
        targetNode?.data.nodeType === 'character' ? targetNode.data.characterId ?? null : null;

      if (sourceNode && targetNode && sourceCharacterId && targetCharacterId) {
        // Nothing is written until the kind is chosen; the dialog owns the edge.
        setCharacterConnectionError(null);
        setCharacterConnection({
          sourceNodeId: sourceNode.id,
          targetNodeId: targetNode.id,
          sourceCharacterId,
          targetCharacterId,
          sourceName: sourceNode.data.label,
          targetName: targetNode.data.label,
          kind: relationKindSuggestions[0],
          note: '',
          chapterId: '',
        });
        return;
      }

      // Either direction means the same thing: the character is in the chapter.
      const characterNode =
        sourceNode?.data.nodeType === 'character'
          ? sourceNode
          : targetNode?.data.nodeType === 'character'
            ? targetNode
            : null;
      const chapterNode =
        sourceNode?.data.nodeType === 'chapter'
          ? sourceNode
          : targetNode?.data.nodeType === 'chapter'
            ? targetNode
            : null;

      if (characterNode && chapterNode) {
        const characterId = characterNode.data.characterId;

        if (!characterId) {
          setActionError('Link this character card to a cast member before adding them to a chapter.');
          return;
        }

        const chapterId = chapterNode.id;
        const hadCast = storyChapterCast.some(
          member => member.chapter_id === chapterId && member.character_id === characterId
        );

        try {
          const member: ChapterCastMember = await narrativeApi.addChapterCastMember(
            chapterId,
            characterId,
            actor
          );

          if (!hadCast) {
            setStoryChapterCast(previous =>
              previous.some(row => row.id === member.id) ? previous : [...previous, member]
            );
          }

          let newDbEdge: any;

          try {
            newDbEdge = await canvasApi.createGraphEdge(
              currentStory.id,
              params.source,
              params.target,
              'cast',
              'cast',
              actor
            );
          } catch (e) {
            // The edge is what the author drew; without it the cast change would
            // be an invisible edit they did not ask for.
            if (!hadCast) {
              await narrativeApi.removeChapterCastMember(member.id, actor).catch(() => {});
              setStoryChapterCast(previous => previous.filter(row => row.id !== member.id));
              await recordHistoryEvent(
                'step_rolled_back',
                `Put back — Connecting ${characterNode.data.label} to ${chapterNode.data.label}: the connection could not be saved (${String(
                  e
                )}), so the cast member is not on the chapter.`
              );
            }
            throw e;
          }

          const newEdge: Edge<EdgeData> = {
            id: newDbEdge.id,
            source: params.source,
            target: params.target,
            label: 'cast',
            data: { createdBy: actor, label: 'cast', relationType: 'cast' },
          };

          setSelectedEdgeId(null);
          setEdges(eds => addEdge(newEdge, eds));

          let currentCastId = member.id;

          recordStep({
            label: `Add ${characterNode.data.label} to ${chapterNode.data.label}'s cast`,
            undo: async () => {
              await canvasApi.deleteEdge(newDbEdge.id, actor);
              if (!hadCast) {
                await narrativeApi.removeChapterCastMember(currentCastId, actor);
                setStoryChapterCast(previous =>
                  previous.filter(row => row.id !== currentCastId)
                );
              }
            },
            redo: async () => {
              await trashApi.restoreDeleted(newDbEdge.id, 'edge', actor);
              if (!hadCast) {
                const again: ChapterCastMember = await narrativeApi.addChapterCastMember(
                  chapterId,
                  characterId,
                  actor
                );
                currentCastId = again.id;
                setStoryChapterCast(previous =>
                  previous.some(row => row.id === again.id)
                    ? previous
                    : [...previous, again]
                );
              }
            },
          });
        } catch (e) {
          console.error('Failed to connect a character to a chapter:', e);
          setActionError(`Could not connect the card to the chapter: ${String(e)}`);
        }

        return;
      }

      // A skill card is one shared identity, so a line to a character card is
      // that character learning it: the sheet gains a row that points at the
      // same card, and the card's saved words are the row's words.
      const skillNode =
        sourceNode?.data.nodeType === 'skill'
          ? sourceNode
          : targetNode?.data.nodeType === 'skill'
            ? targetNode
            : null;

      if (skillNode && characterNode) {
        const characterId = characterNode.data.characterId;
        // Read once: the narrowing of the two ends is lost inside the callbacks
        // that draw the line and record the step.
        const fromNodeId: string = params.source;
        const toNodeId: string = params.target;

        if (!characterId) {
          setActionError(
            'Link this character card to a cast member before giving them a skill.'
          );
          return;
        }

        const held = storySkills.find(
          row => row.node_id === skillNode.id && row.character_id === characterId
        );

        if (held) {
          setActionError(
            `${characterNode.data.label} already has ${skillNode.data.label}.`
          );
          return;
        }

        const learn = () =>
          skillsApi.addSkill(
            characterId,
            skillNode.data.label,
            null,
            skillNode.data.content?.trim() || null,
            null,
            skillNode.id,
            actor
          );

        // A line may already join these two cards: one drawn before a skill hold
        // was written, or left behind when the skill was deleted from the sheet.
        // The hold is then the only thing missing, and a second line would say
        // the same thing twice.
        const existingEdge = edges.find(
          candidate =>
            (candidate.source === fromNodeId && candidate.target === toNodeId) ||
            (candidate.source === toNodeId && candidate.target === fromNodeId)
        );

        try {
          const learned = await learn();
          let newDbEdge: any = null;

          if (!existingEdge) {
            try {
              newDbEdge = await canvasApi.createGraphEdge(
                currentStory.id,
                fromNodeId,
                toNodeId,
                'skill',
                'skill',
                actor
              );
            } catch (e) {
              // The line is what the author drew. Without it the sheet row would
              // be an edit they never asked for, so it goes back.
              await skillsApi.deleteSkill(learned.id, actor).catch(() => {});
              await recordHistoryEvent(
                'step_rolled_back',
                `Put back — ${characterNode.data.label} learning ${skillNode.data.label}: the connection could not be saved (${String(
                  e
                )}), so the skill is not on their sheet.`
              );
              throw e;
            }

            setSelectedEdgeId(null);
            setEdges(eds =>
              addEdge(
                {
                  id: newDbEdge.id,
                  source: fromNodeId,
                  target: toNodeId,
                  label: 'skill',
                  data: { createdBy: actor, label: 'skill', relationType: 'skill' },
                },
                eds
              )
            );
          }

          showSkillOnLists(learned);

          const heldEdge = newDbEdge;
          let currentSkillId = learned.id;

          recordStep({
            label: `${characterNode.data.label} learns ${skillNode.data.label}`,
            undo: async () => {
              await skillsApi.deleteSkill(currentSkillId, actor);
              hideSkillOnLists(currentSkillId, characterId);
              if (heldEdge) await canvasApi.deleteEdge(heldEdge.id, actor);
            },
            redo: async () => {
              const again = await learn();
              currentSkillId = again.id;
              showSkillOnLists(again);
              if (heldEdge) {
                await trashApi.restoreDeleted(heldEdge.id, 'edge', actor);
              }
            },
          });
        } catch (e) {
          console.error('Failed to link a skill to a character:', e);
          setActionError(
            `Could not give ${characterNode.data.label} ${skillNode.data.label}: ${String(e)}`
          );
        }

        return;
      }

      try {
        const newDbEdge: any = await canvasApi.createGraphEdge(
          currentStory.id,
          params.source,
          params.target,
          null,
          null,
          actor
        );

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
          undo: () => canvasApi.deleteEdge(newDbEdge.id, actor),
          redo: () =>
            trashApi.restoreDeleted(newDbEdge.id, 'edge', actor),
        });
      } catch (e) {
        console.error('Failed to create edge:', e);
      }
    },
    [
      currentStory,
      actor,
      nodes,
      edges,
      storyChapterCast,
      storySkills,
      setEdges,
      recordStep,
      recordHistoryEvent,
      showSkillOnLists,
      hideSkillOnLists,
    ]
  );

  // A connection drag remembers where it started. Ending on a card makes an
  // edge; ending on empty canvas opens the selected card's form, already filled
  // in from the card the drag came from.
  const onConnectStart = useCallback((event: any, params: any) => {
    connectionStartNodeRef.current = params?.nodeId ?? null;
    connectionMadeRef.current = false;

    const touch = event?.changedTouches?.[0] ?? event?.touches?.[0];
    const x = touch?.clientX ?? event?.clientX;
    const y = touch?.clientY ?? event?.clientY;
    connectionStartPointRef.current =
      typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
  }, []);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const sourceId = connectionStartNodeRef.current;
      const startPoint = connectionStartPointRef.current;
      connectionStartNodeRef.current = null;
      connectionStartPointRef.current = null;

      // Dropped on a card, the connection was already handled by onConnect.
      if (!sourceId || connectionMadeRef.current) {
        connectionMadeRef.current = false;
        return;
      }

      connectionMadeRef.current = false;

      if (!isCanvasCreateKind(newNodeType)) return;

      const touch = 'changedTouches' in event ? event.changedTouches[0] : null;
      const point =
        touch != null
          ? { x: touch.clientX, y: touch.clientY }
          : { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };

      // A click on a handle is not a drag, and should not open a form.
      if (
        startPoint &&
        Math.hypot(point.x - startPoint.x, point.y - startPoint.y) < 4
      ) {
        return;
      }

      // A drop on a card is not empty canvas, even when the edge was refused.
      try {
        const under = document.elementFromPoint?.(point.x, point.y) as HTMLElement | null;
        if (under?.closest?.('.react-flow__node')) return;
      } catch {
        // No hit testing in this environment; the drag still opened the form.
      }

      const sourceNode = nodes.find(node => node.id === sourceId);
      if (!sourceNode) return;

      const sourceCharacterId =
        sourceNode.data.nodeType === 'character'
          ? sourceNode.data.characterId ?? null
          : null;
      const sourceChapterId =
        sourceNode.data.nodeType === 'chapter' ? sourceNode.id : null;

      // Only a character or a chapter has something to hand to a new card.
      if (!sourceCharacterId && !sourceChapterId) return;

      const position = flowRef.current
        ? flowRef.current.screenToFlowPosition(point)
        : point;

      openCanvasCreate({ position, sourceNodeId: sourceNode.id });
    },
    [newNodeType, nodes, openCanvasCreate]
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
        await canvasApi.updateGraphNodePosition(node.id, to.x, to.y, actor);

        if (from && (from.x !== to.x || from.y !== to.y)) {
          recordStep({
            label: `Move “${node.data.label}”`,
            undo: () =>
              canvasApi.updateGraphNodePosition(node.id, from.x, from.y, actor),
            redo: () =>
              canvasApi.updateGraphNodePosition(node.id, to.x, to.y, actor),
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
      // A chapter comes back without its connections, so the undo says how many
      // of them went to the trash with it. Counted while the board still has
      // them, and only for chapter ends: those are the ones the restore leaves.
      const chapterIds = new Set(
        deleted.filter(node => node.data.nodeType === 'chapter').map(node => node.id)
      );
      const strandedConnections = edges.filter(
        edge => chapterIds.has(edge.source) || chapterIds.has(edge.target)
      ).length;

      setEdges(eds =>
        eds.filter(edge => !removedIds.has(edge.source) && !removedIds.has(edge.target))
      );

      try {
        for (const node of deleted) {
          await canvasApi.deleteNode(node.id, actor);
        }

        recordStep({
          label:
            deleted.length === 1
              ? `Delete “${deleted[0].data.label}”`
              : `Delete ${deleted.length} nodes`,
          undo: async () => {
            for (const node of deleted) {
              await trashApi.restoreDeleted(node.id, 'node', actor);
            }
          },
          redo: async () => {
            for (const node of deleted) {
              await canvasApi.deleteNode(node.id, actor);
            }
          },
          undoNote:
            strandedConnections > 0
              ? `${strandedConnections} connection${
                  strandedConnections === 1 ? '' : 's'
                } went to the Trash with it. Restore ${
                  strandedConnections === 1 ? 'it' : 'them'
                } there to draw ${strandedConnections === 1 ? 'it' : 'them'} again.`
              : undefined,
        });
      } catch (e) {
        console.error('Failed to delete node:', e);
        setActionError(`Could not delete node: ${String(e)}`);
        await loadStory(currentStory);
      }
    },
    [currentStory, actor, edges, loadStory, setEdges, recordStep]
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

      const plain: Edge<EdgeData>[] = [];
      const domain: PendingEdgeRemoval[] = [];

      for (const edge of ownDeletes) {
        const source = nodes.find(node => node.id === edge.source);
        const target = nodes.find(node => node.id === edge.target);

        const characterNode =
          source?.data.nodeType === 'character'
            ? source
            : target?.data.nodeType === 'character'
              ? target
              : null;
        const chapterNode =
          source?.data.nodeType === 'chapter'
            ? source
            : target?.data.nodeType === 'chapter'
              ? target
              : null;

        // A character-to-chapter edge is a cast change when that character is
        // actually in the chapter's explicit cast.
        if (characterNode && chapterNode) {
          const characterId = characterNode.data.characterId;
          const cast = characterId
            ? storyChapterCast.find(
                member =>
                  member.chapter_id === chapterNode.id &&
                  member.character_id === characterId
              )
            : undefined;

          if (cast && characterId) {
            domain.push({
              edge,
              kind: 'cast',
              title: `Remove ${characterNode.data.label} from the cast?`,
              detail: `${characterNode.data.label} will leave ${chapterNode.data.label}'s cast, and this connection will be deleted.`,
              stepLabel: `Remove ${characterNode.data.label} from ${chapterNode.data.label}'s cast`,
              castId: cast.id,
              characterId,
              chapterId: chapterNode.id,
            });
            continue;
          }
        }

        // A character-to-character edge whose cast pair already has a relation
        // is the drawing of that relation, so deleting it deletes the relation.
        if (
          source?.data.nodeType === 'character' &&
          target?.data.nodeType === 'character' &&
          source.data.characterId &&
          target.data.characterId
        ) {
          const fromId = source.data.characterId;
          const toId = target.data.characterId;
          const pair = storyRelations.filter(
            row =>
              (row.from_character_id === fromId && row.to_character_id === toId) ||
              (row.from_character_id === toId && row.to_character_id === fromId)
          );
          // The edge's own verb says which bond it drew. One bond between the
          // pair is unambiguous; several are only matched by that verb.
          const relation =
            pair.find(row => row.kind === edge.data?.relationType) ??
            (pair.length === 1 ? pair[0] : undefined);

          if (relation) {
            domain.push({
              edge,
              kind: 'relation',
              title: 'Delete this relation?',
              detail: `The ${relation.kind} relation between ${source.data.label} and ${target.data.label} will be deleted, and this connection will go with it.`,
              stepLabel: `Delete the ${relation.kind} relation between ${source.data.label} and ${target.data.label}`,
              relationId: relation.id,
              relationFromId: relation.from_character_id,
              relationToId: relation.to_character_id,
              relationKind: relation.kind,
              relationNote: relation.note,
              relationSinceChapterId: relation.since_chapter_id,
              relationUntilChapterId: relation.until_chapter_id,
            });
            continue;
          }
        }

        // A line between a skill card and a character is that character holding
        // the skill, so removing the line takes the row off their sheet too.
        const heldSkill = skillForEdge(edge, nodes, storySkills);

        if (heldSkill) {
          const characterName =
            characters.find(character => character.id === heldSkill.character_id)?.name ??
            'This character';
          const cardLabel =
            skillCardEnds(edge, nodes)?.card.data.label ?? heldSkill.name;

          domain.push({
            edge,
            kind: 'skill',
            title: `Remove ${cardLabel} from ${characterName}'s sheet?`,
            detail: `${characterName} will lose ${cardLabel}, and this connection will be deleted.`,
            stepLabel: `Remove ${cardLabel} from ${characterName}`,
            skillId: heldSkill.id,
            skillCharacterId: heldSkill.character_id,
            skillName: heldSkill.name,
            skillRank: heldSkill.rank,
            skillEffect: heldSkill.effect,
            skillChapterId: heldSkill.chapter_id,
            skillNodeId: heldSkill.node_id,
          });
          continue;
        }

        plain.push(edge);
      }

      try {
        for (const edge of plain) {
          await canvasApi.deleteEdge(edge.id, actor);
        }

        if (plain.length > 0) {
          recordStep({
            label:
              plain.length === 1
                ? 'Delete a connection'
                : `Delete ${plain.length} connections`,
            undo: async () => {
              for (const edge of plain) {
                await trashApi.restoreDeleted(edge.id, 'edge', actor);
              }
            },
            redo: async () => {
              for (const edge of plain) {
                await canvasApi.deleteEdge(edge.id, actor);
              }
            },
          });
        }

        if (domain.length > 0) {
          // React Flow has already taken the edges off the canvas. Read them back
          // from the database while the question is open, so cancelling truly
          // leaves the board as it was.
          await reloadStory(currentStory.id);
          setPendingEdgeRemoval(domain);
        }
      } catch (e) {
        console.error('Failed to delete connection:', e);
        setActionError(`Could not delete connection: ${String(e)}`);
        await loadStory(currentStory);
      }
    },
    [
      currentStory,
      actor,
      nodes,
      characters,
      storyChapterCast,
      storyRelations,
      storySkills,
      loadStory,
      reloadStory,
      recordStep,
    ]
  );

  // Confirms the domain half of an edge deletion. The relation or cast row and
  // the edge are removed together and recorded as one undoable step.
  const confirmDomainEdgeRemoval = async () => {
    if (!pendingEdgeRemoval || removingDomainEdges) return;

    const entries = pendingEdgeRemoval;
    setPendingEdgeRemoval(null);
    setRemovingDomainEdges(true);
    setActionError(null);

    try {
      for (const entry of entries) {
        if (entry.kind === 'cast') {
          const castId = entry.castId;
          const characterId = entry.characterId;
          const chapterId = entry.chapterId;

          if (!castId || !characterId || !chapterId) continue;

          // The cast row and the line that drew it are one fact, so a half that
          // fails leaves the other where it was: the step stays in the history
          // and can be run again as a whole instead of wedging on a duplicate or
          // a missing row.
          await narrativeApi.removeChapterCastMember(castId, actor);

          try {
            await canvasApi.deleteEdge(entry.edge.id, actor);
          } catch (e) {
            const again = await narrativeApi
              .addChapterCastMember(chapterId, characterId, actor)
              .catch(() => null);

            if (again) {
              setStoryChapterCast(previous => [
                ...previous.filter(row => row.id !== castId),
                again,
              ]);
              await recordHistoryEvent(
                'step_rolled_back',
                `Put back — ${entry.stepLabel}: the connection could not be deleted (${String(
                  e
                )}), so the cast row is still there. Nothing changed.`
              );
            } else {
              await recordHistoryEvent(
                'step_rolled_back',
                `Stopped halfway — ${entry.stepLabel}: the connection could not be deleted and the cast row could not be written back (${String(
                  e
                )}). The chapter's cast needs checking.`
              );
            }
            throw e;
          }

          setStoryChapterCast(previous => previous.filter(row => row.id !== castId));
          setEdges(previous => previous.filter(edge => edge.id !== entry.edge.id));

          let currentCastId = castId;

          recordStep({
            label: entry.stepLabel,
            undo: async () => {
              const again: ChapterCastMember = await narrativeApi.addChapterCastMember(
                chapterId,
                characterId,
                actor
              );

              try {
                await trashApi.restoreDeleted(entry.edge.id, 'edge', actor);
              } catch (e) {
                // The cast member is back but its line is not, so put the row
                // away again rather than leave the two halves disagreeing.
                await narrativeApi.removeChapterCastMember(again.id, actor).catch(() => {});
                await recordHistoryEvent(
                  'step_rolled_back',
                  `Put back — Undo of ${entry.stepLabel}: the connection could not be restored (${String(
                    e
                  )}), so the cast member is off the chapter again.`
                );
                throw e;
              }

              currentCastId = again.id;
              setStoryChapterCast(previous =>
                previous.some(row => row.id === again.id) ? previous : [...previous, again]
              );
              setEdges(previous =>
                previous.some(edge => edge.id === entry.edge.id)
                  ? previous
                  : [...previous, entry.edge]
              );
            },
            redo: async () => {
              await canvasApi.deleteEdge(entry.edge.id, actor);

              try {
                await narrativeApi.removeChapterCastMember(currentCastId, actor);
              } catch (e) {
                await trashApi.restoreDeleted(entry.edge.id, 'edge', actor).catch(() => {});
                setEdges(previous =>
                  previous.some(edge => edge.id === entry.edge.id)
                    ? previous
                    : [...previous, entry.edge]
                );
                await recordHistoryEvent(
                  'step_rolled_back',
                  `Put back — Redo of ${entry.stepLabel}: the cast member could not be removed (${String(
                    e
                  )}), so the connection is drawn again.`
                );
                throw e;
              }

              setStoryChapterCast(previous =>
                previous.filter(row => row.id !== currentCastId)
              );
              setEdges(previous => previous.filter(edge => edge.id !== entry.edge.id));
            },
          });
        } else if (entry.kind === 'relation') {
          const relationId = entry.relationId;

          if (!relationId) continue;

          await relationsApi.deleteRelation(relationId, actor);
          setStoryRelations(previous => previous.filter(row => row.id !== relationId));
          await canvasApi.deleteEdge(entry.edge.id, actor);
          setEdges(previous => previous.filter(edge => edge.id !== entry.edge.id));

          let currentRelationId = relationId;

          recordStep({
            label: entry.stepLabel,
            undo: async () => {
              const again: CharacterRelation = await relationsApi.addRelation(
                entry.relationFromId ?? entry.edge.source,
                entry.relationToId ?? entry.edge.target,
                entry.relationKind ?? 'ally',
                entry.relationNote ?? null,
                entry.relationSinceChapterId ?? null,
                entry.relationUntilChapterId ?? null,
                actor
              );
              currentRelationId = again.id;
              setStoryRelations(previous =>
                [...previous.filter(row => row.id !== again.id), again].sort(
                  (a, b) =>
                    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
                )
              );
              await trashApi.restoreDeleted(entry.edge.id, 'edge', actor);
            },
            redo: async () => {
              await relationsApi.deleteRelation(currentRelationId, actor);
              setStoryRelations(previous =>
                previous.filter(row => row.id !== currentRelationId)
              );
              await canvasApi.deleteEdge(entry.edge.id, actor);
            },
          });
        } else {
          const { skillId, skillCharacterId, skillName } = entry;

          // A step recorded without all three cannot be put back through the
          // sheet, so it is left alone rather than half-undone.
          if (!skillId || !skillCharacterId || !skillName) continue;

          await skillsApi.deleteSkill(skillId, actor);
          hideSkillOnLists(skillId, skillCharacterId);
          await canvasApi.deleteEdge(entry.edge.id, actor);
          setEdges(previous => previous.filter(edge => edge.id !== entry.edge.id));

          let currentSkillId = skillId;

          recordStep({
            label: entry.stepLabel,
            undo: async () => {
              const again: CharacterSkill = await skillsApi.addSkill(
                skillCharacterId,
                skillName,
                entry.skillRank ?? null,
                entry.skillEffect ?? null,
                entry.skillChapterId ?? null,
                entry.skillNodeId ?? null,
                actor
              );
              currentSkillId = again.id;
              showSkillOnLists(again);
              await trashApi.restoreDeleted(entry.edge.id, 'edge', actor);
            },
            redo: async () => {
              await skillsApi.deleteSkill(currentSkillId, actor);
              hideSkillOnLists(currentSkillId, skillCharacterId);
              await canvasApi.deleteEdge(entry.edge.id, actor);
            },
          });
        }
      }
    } catch (e) {
      console.error('Failed to remove the connection:', e);
      setActionError(`Could not remove the connection: ${String(e)}`);
      if (currentStory) await reloadStory(currentStory.id);
    } finally {
      setRemovingDomainEdges(false);
    }
  };

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
        const updated: Story = await storiesApi.updateStory(story.id, title, actor);

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
      await storiesApi.deleteStory(story.id, actor);

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
      const character: Character = await charactersApi.createCharacter(
        currentStory.id,
        newCharacterName.trim(),
        newCharacterDescription.trim() || null,
        actor
      );

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
      const updated: CharacterStat = await charactersApi.setCharacterStat(
        stat.character_id,
        stat.stat_name,
        Math.trunc(value),
        statNotesDraft.trim() || null,
        actor
      );

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
      const saved: CharacterStat = await charactersApi.setCharacterStat(
        selectedCharacterId,
        newStatName.trim(),
        Math.trunc(value),
        null,
        actor
      );

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
      const updated: CharacterAttribute = await charactersApi.setCharacterAttribute(
        selectedCharacterId,
        attribute.attr_name,
        value,
        actor
      );

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
      const saved: CharacterAttribute = await charactersApi.setCharacterAttribute(
        selectedCharacterId,
        newAttributeName.trim(),
        value,
        actor
      );

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
      await charactersApi.deleteCharacterAttribute(attribute.id, actor);
      setCharacterAttributes(prev => prev.filter(other => other.id !== attribute.id));
      setEditingAttributeId(null);
    } catch (e) {
      console.error('Failed to delete attribute:', e);
      setCharacterError(`Could not delete attribute: ${String(e)}`);
    }
  };

  // A skill is shown on the sheet and on its card, so both lists take the saved
  // row. The sort matches the read, which is by name.
  const applySkill = (saved: CharacterSkill) => {
    const ordered = (list: CharacterSkill[]) =>
      [...list.filter(other => other.id !== saved.id), saved].sort((a, b) =>
        a.name.localeCompare(b.name)
      );

    setCharacterSkills(ordered);
    setStorySkills(ordered);
  };

  // A sheet edit changes the shared definition, so every holder of that
  // definition follows and the card takes the same words. The database has
  // already written all of them; this keeps the open tabs from showing the old
  // copies until the story is reopened.
  const applySharedSkillEdit = (saved: CharacterSkill, before: CharacterSkill) => {
    const sameDefinition = (row: CharacterSkill) =>
      before.node_id
        ? row.node_id === before.node_id
        : row.name.toLowerCase() === before.name.toLowerCase();

    const update = (list: CharacterSkill[]) =>
      list
        .map(row => {
          if (row.id === saved.id) return saved;

          return sameDefinition(row)
            ? {
                ...row,
                name: saved.name,
                effect: saved.effect,
                node_id: saved.node_id,
                updated_at: saved.updated_at,
              }
            : row;
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    setStorySkills(update);
    setCharacterSkills(update);

    if (saved.node_id) {
      setNodes(list =>
        list.map(node =>
          node.id === saved.node_id
            ? {
                ...node,
                data: { ...node.data, label: saved.name, content: saved.effect ?? undefined },
              }
            : node
        )
      );

      if (selectedNodeIdRef.current === saved.node_id && !nodeIsDirtyRef.current) {
        setNodeLabelDraft(saved.name);
        setNodeContentDraft(saved.effect ?? '');
      }
    }
  };

  // The database keeps a skill card's linked rows in step when its label or
  // notes change. Mirror that here so the board and the open sheet do not keep
  // showing the old name until the story is reopened. Only the fields that
  // changed are replaced; a holder's rank and chapter stay as they were.
  const applySkillCardSync = (
    nodeId: string,
    label: string,
    content: string | null,
    changed: { name: boolean; effect: boolean }
  ) => {
    const update = (list: CharacterSkill[]) =>
      list.map(skill =>
        skill.node_id !== nodeId
          ? skill
          : {
              ...skill,
              ...(changed.name ? { name: label } : {}),
              ...(changed.effect ? { effect: content } : {}),
            }
      );

    setStorySkills(update);
    setCharacterSkills(update);
  };

  // The sheet's skill form is the skills domain's own module; these writes stay
  // here, where the card on the canvas and the audit log are. Each answers
  // whether the row was written, so the form closes only on a save that
  // happened.
  const saveSkill = async (
    skill: CharacterSkill,
    input: SkillDraft
  ): Promise<boolean> => {
    setCharacterError(null);

    try {
      const updated: CharacterSkill = await skillsApi.updateSkill(
        skill.id,
        input.name,
        input.rank,
        input.effect,
        input.chapterId,
        input.nodeId,
        actor
      );

      applySharedSkillEdit(updated, skill);
      return true;
    } catch (e) {
      console.error('Failed to save skill:', e);
      setCharacterError(`Could not save skill: ${String(e)}`);
      return false;
    }
  };

  const addSkill = async (input: SkillDraft): Promise<boolean> => {
    if (!selectedCharacterId) return false;

    setCharacterError(null);

    try {
      const saved: CharacterSkill = await skillsApi.addSkill(
        selectedCharacterId,
        input.name,
        input.rank,
        input.effect,
        input.chapterId,
        input.nodeId,
        actor
      );

      applySkill(saved);
      return true;
    } catch (e) {
      console.error('Failed to add skill:', e);
      setCharacterError(`Could not add skill: ${String(e)}`);
      return false;
    }
  };

  // A skill card is a link target, not a template the sheet knows about. Adding
  // a holder from the card is the deliberate exception: the card's saved name
  // and notes become the new row's name and effect, because those identify the
  // skill. Rank and chapter are the holder's own facts, so they are entered
  // here rather than copied from somebody else's row.
  const addSkillHolder = async () => {
    const card = nodes.find(node => node.id === selectedNodeId);

    if (!card || card.data.nodeType !== 'skill') return;

    const characterId = skillHolderCharacterId;
    const name = card.data.label.trim();
    const effect = card.data.content?.trim() || null;

    if (!characterId) {
      setSkillHolderError('Choose the character who learns this skill.');
      return;
    }

    if (!name) {
      setSkillHolderError('The card needs a name before it can be added to a sheet.');
      return;
    }

    setSkillHolderError(null);
    setSavingSkillHolder(true);

    try {
      const saved: CharacterSkill = await skillsApi.addSkill(
        characterId,
        name,
        skillHolderRank.trim() || null,
        effect,
        skillHolderChapterId || null,
        card.id,
        actor
      );

      const ordered = (list: CharacterSkill[]) =>
        [...list.filter(other => other.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name)
        );

      setStorySkills(ordered);
      if (saved.character_id === selectedCharacterId) {
        setCharacterSkills(ordered);
      }
      setSkillHolderCharacterId('');
      setSkillHolderRank('');
      setSkillHolderChapterId('');
    } catch (e) {
      console.error('Failed to add a skill holder:', e);
      setSkillHolderError(`Could not add the holder: ${String(e)}`);
    } finally {
      setSavingSkillHolder(false);
    }
  };

  const removeSkill = async (skill: CharacterSkill): Promise<boolean> => {
    setCharacterError(null);

    // The canvas line that put this skill on the sheet. A skill typed in by hand
    // has none; when a line exists, the row and the line leave together, so the
    // board cannot keep a connection to a hold that no longer exists.
    const matchingEdge = matchingSkillEdge(edges, nodes, skill);

    // The row takes its history with it: the database cascades both, so the step
    // keeps a copy to write back if it is undone.
    const lostEvents = storySkillEvents.filter(event => event.skill_id === skill.id);
    const lostLinks = storySkillEvolutions.filter(
      evolution =>
        evolution.parent_skill_id === skill.id || evolution.child_skill_id === skill.id
    );

    try {
      await skillsApi.deleteSkill(skill.id, actor);
      setCharacterSkills(prev => prev.filter(other => other.id !== skill.id));
      setStorySkills(prev => prev.filter(other => other.id !== skill.id));
      // The database cascades the events and evolution links with the skill;
      // keep the board copy in step so continuity cannot read a skill that is
      // no longer there.
      setStorySkillEvents(prev => prev.filter(event => event.skill_id !== skill.id));
      setStorySkillEvolutions(prev =>
        prev.filter(
          evolution =>
            evolution.parent_skill_id !== skill.id && evolution.child_skill_id !== skill.id
        )
      );

      if (matchingEdge) {
        await canvasApi.deleteEdge(matchingEdge.id, actor);
        setEdges(previous => previous.filter(edge => edge.id !== matchingEdge.id));
        if (selectedEdgeId === matchingEdge.id) setSelectedEdgeId(null);
      }

      // The row is deleted for good, so a redo writes it again and remembers the
      // id it was given; the edge is in the trash and can simply be restored.
      // Events and evolution links are written back after it, against the new id.
      let currentSkillId = skill.id;

      recordStep({
        label: `Delete “${skill.name}”`,
        undo: async () => {
          const again: CharacterSkill = await skillsApi.addSkill(
            skill.character_id,
            skill.name,
            skill.rank,
            skill.effect,
            skill.chapter_id,
            skill.node_id,
            actor
          );
          currentSkillId = again.id;
          showSkillOnLists(again);

          const restoredEvents: CharacterSkillEvent[] = [];
          const restoredLinks: SkillEvolution[] = [];

          try {
            for (const event of lostEvents) {
              restoredEvents.push(
                await skillsApi.addSkillEvent(
                  currentSkillId,
                  event.kind,
                  event.chapter_id,
                  event.rank,
                  event.milestone_id ?? null,
                  actor
                )
              );
            }

            for (const evolution of lostLinks) {
              restoredLinks.push(
                await skillsApi.addSkillEvolution(
                  evolution.parent_skill_id === skill.id
                      ? currentSkillId
                      : evolution.parent_skill_id,
                  evolution.child_skill_id === skill.id
                      ? currentSkillId
                      : evolution.child_skill_id,
                  evolution.evolution_type,
                  evolution.chapter_id,
                  evolution.required_rank,
                  evolution.notes,
                  actor
                )
              );
            }
          } catch (e) {
            // A chapter, a milestone or the skill at the other end of a link can
            // be gone by now. The half-written restore goes back so the step can
            // be tried again rather than leaving a sheet that is not the one that
            // was deleted.
            await skillsApi.deleteSkill(currentSkillId, actor).catch(() => {});
            hideSkillOnLists(currentSkillId, skill.character_id);
            await recordHistoryEvent(
              'step_rolled_back',
              `Put back — Delete “${skill.name}”: its history could not be restored (${String(
                e
              )}), so the skill is off the sheet again.`
            );
            throw e;
          }

          if (restoredEvents.length > 0) {
            setStorySkillEvents(previous =>
              [...previous, ...restoredEvents].sort(
                (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
              )
            );
          }

          if (restoredLinks.length > 0) {
            setStorySkillEvolutions(previous => [...previous, ...restoredLinks]);
          }

          if (matchingEdge) {
            await trashApi.restoreDeleted(matchingEdge.id, 'edge', actor);
            setEdges(previous =>
              previous.some(edge => edge.id === matchingEdge.id)
                ? previous
                : [...previous, matchingEdge]
            );
          }
        },
        redo: async () => {
          await skillsApi.deleteSkill(currentSkillId, actor);
          hideSkillOnLists(currentSkillId, skill.character_id);
          setStorySkillEvents(previous =>
            previous.filter(event => event.skill_id !== currentSkillId)
          );
          setStorySkillEvolutions(previous =>
            previous.filter(
              evolution =>
                evolution.parent_skill_id !== currentSkillId &&
                evolution.child_skill_id !== currentSkillId
            )
          );

          if (matchingEdge) {
            await canvasApi.deleteEdge(matchingEdge.id, actor);
            setEdges(previous => previous.filter(edge => edge.id !== matchingEdge.id));
          }
        },
      });

      return true;
    } catch (e) {
      console.error('Failed to delete skill:', e);
      setCharacterError(`Could not delete skill: ${String(e)}`);
      return false;
    }
  };

  // An evolution link is its own row, so a failed save leaves both skills as
  // they were and says why in the tree view rather than in the sheet's error.
  const addSkillEvolutionLink = async (input: SkillEvolutionInput) => {
    setSkillEvolutionError(null);

    try {
      const saved: SkillEvolution = await skillsApi.addSkillEvolution(
        input.parentSkillId,
        input.childSkillId,
        input.evolutionType,
        input.chapterId,
        input.requiredRank,
        input.notes,
        actor
      );

      setStorySkillEvolutions(prev => [...prev, saved]);
      return true;
    } catch (e) {
      console.error('Failed to add a skill evolution:', e);
      setSkillEvolutionError(`Could not add the link: ${String(e)}`);
      return false;
    }
  };

  const removeSkillEvolutionLink = async (id: string) => {
    setSkillEvolutionError(null);

    try {
      await skillsApi.deleteSkillEvolution(id, actor);
      setStorySkillEvolutions(prev => prev.filter(evolution => evolution.id !== id));
    } catch (e) {
      console.error('Failed to delete a skill evolution:', e);
      setSkillEvolutionError(`Could not delete the link: ${String(e)}`);
    }
  };

  const applySkillEvent = useCallback((saved: CharacterSkillEvent) => {
    setStorySkillEvents(previous =>
      [...previous.filter(event => event.id !== saved.id), saved].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
      )
    );
  }, []);

  const saveSkillEvent = async (
    skillId: string,
    eventId: string | null,
    input: SkillEventDraft
  ): Promise<boolean> => {
    setCharacterError(null);

    try {
      // Editing writes the row that is open; adding writes a new one, which is
      // why the two commands take different ids for the same fields.
      const saved: CharacterSkillEvent = eventId
        ? await skillsApi.updateSkillEvent(
            eventId,
            input.kind,
            input.chapterId,
            input.rank,
            input.milestoneId,
            actor
          )
        : await skillsApi.addSkillEvent(
            skillId,
            input.kind,
            input.chapterId,
            input.rank,
            input.milestoneId,
            actor
          );

      applySkillEvent(saved);
      return true;
    } catch (e) {
      console.error('Failed to save a skill event:', e);
      setCharacterError(`Could not save the skill event: ${String(e)}`);
      return false;
    }
  };

  const removeSkillEvent = async (event: CharacterSkillEvent): Promise<boolean> => {
    setCharacterError(null);

    try {
      await skillsApi.deleteSkillEvent(event.id, actor);
      setStorySkillEvents(previous => previous.filter(other => other.id !== event.id));
      return true;
    } catch (e) {
      console.error('Failed to delete a skill event:', e);
      setCharacterError(`Could not delete the skill event: ${String(e)}`);
      return false;
    }
  };

  const applyLevelMilestone = useCallback((saved: CharacterLevelMilestone) => {
    setStoryLevelMilestones(previous =>
      [...previous.filter(milestone => milestone.id !== saved.id), saved].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
      )
    );
  }, []);

  // The chapter ledger and a total-XP milestone can disagree. Recording the
  // ledger's sum on the milestone goes through the same audited command as the
  // sheet's editor, and the step keeps an Undo for the old total.
  const syncMilestoneXp = useCallback(
    async (flag: ChapterContinuityFlag) => {
      if (flag.target.kind !== 'level' || flag.ledgerXp == null) return;

      const ledgerXp = flag.ledgerXp;
      const targetMilestoneId = flag.target.milestoneId;
      const milestone = storyLevelMilestonesRef.current.find(
        candidate => candidate.id === targetMilestoneId
      );

      if (!milestone || milestone.xp === ledgerXp) return;

      const previousXp = milestone.xp ?? null;
      const milestoneId = milestone.id;
      setActionError(null);
      setSyncingXpMilestoneId(milestoneId);

      // Read the row when the step runs, so a later edit to its level, chapter
      // or stats is not swept away by this correction.
      const writeXp = (xp: number | null) => async () => {
        const current =
          storyLevelMilestonesRef.current.find(candidate => candidate.id === milestoneId) ??
          milestone;
        const saved: CharacterLevelMilestone = await progressionApi.updateLevelMilestone(
          current.id,
          current.level,
          current.chapter_id,
          current.is_debuff,
          xp,
          (current.stat_changes ?? []).map(change => ({
            stat_name: change.stat_name,
            amount: change.amount ?? null,
            value_after: change.value_after ?? null,
          })),
          actor
        );

        applyLevelMilestone(saved);
        return saved;
      };

      try {
        await writeXp(ledgerXp)();
        recordStep({
          label: `Sync ${flag.characterName}'s total XP to ${formatCount(ledgerXp)} XP`,
          undo: writeXp(previousXp),
          redo: writeXp(ledgerXp),
        });
        setSyncedXpNotice({ characterName: flag.characterName, xp: ledgerXp });
      } catch (e) {
        console.error('Failed to sync a milestone total:', e);
        setActionError(`Could not sync ${flag.characterName}'s total XP: ${String(e)}`);
      } finally {
        setSyncingXpMilestoneId(null);
      }
    },
    [actor, applyLevelMilestone, recordStep]
  );

  const applyRelation = useCallback((saved: CharacterRelation) => {
    setStoryRelations(previous =>
      [...previous.filter(relation => relation.id !== saved.id), saved].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
      )
    );
  }, []);

  // The relation form opened by dragging one character card onto another. The
  // relation and the edge that drew it are written together, and undone as one
  // step, so the board never shows a bond the ledger does not have.
  const submitCharacterConnection = async () => {
    if (!currentStory || !characterConnection || savingCharacterConnection) return;

    const draft = characterConnection;
    const kind = draft.kind.trim();

    if (!kind) {
      setCharacterConnectionError('A relation needs a kind.');
      return;
    }

    setSavingCharacterConnection(true);
    setCharacterConnectionError(null);

    let edgeId: string | null = null;

    try {
      const edge: any = await canvasApi.createGraphEdge(
        currentStory.id,
        draft.sourceNodeId,
        draft.targetNodeId,
        kind,
        kind,
        actor
      );
      edgeId = edge.id;

      let saved: CharacterRelation;

      try {
        saved = await relationsApi.addRelation(
          draft.sourceCharacterId,
          draft.targetCharacterId,
          kind,
          draft.note.trim() || null,
          draft.chapterId || null,
          null,
          actor
        );
      } catch (e) {
        // No relation, no connection: the edge was only the drawing of it.
        await canvasApi.deleteEdge(edge.id, actor).catch(() => {});
        await recordHistoryEvent(
          'step_rolled_back',
          `Put back — Connecting ${draft.sourceName} and ${draft.targetName}: the relation could not be saved (${String(
            e
          )}), so the connection was removed.`
        );
        throw e;
      }

      const newEdge: Edge<EdgeData> = {
        id: edge.id,
        source: draft.sourceNodeId,
        target: draft.targetNodeId,
        label: kind,
        data: { createdBy: actor, label: kind, relationType: kind },
      };

      setEdges(eds => addEdge(newEdge, eds));
      applyRelation(saved);

      let currentRelationId = saved.id;

      recordStep({
        label: `Connect ${draft.sourceName} and ${draft.targetName}`,
        undo: async () => {
          await relationsApi.deleteRelation(currentRelationId, actor);
          await canvasApi.deleteEdge(edge.id, actor);
          setStoryRelations(previous =>
            previous.filter(relation => relation.id !== currentRelationId)
          );
        },
        redo: async () => {
          await trashApi.restoreDeleted(edge.id, 'edge', actor);
          const again: CharacterRelation = await relationsApi.addRelation(
            draft.sourceCharacterId,
            draft.targetCharacterId,
            kind,
            draft.note.trim() || null,
            draft.chapterId || null,
            null,
            actor
          );
          currentRelationId = again.id;
          applyRelation(again);
        },
      });

      setCharacterConnection(null);
    } catch (e) {
      console.error('Failed to connect two characters:', e);
      setCharacterConnectionError(`Could not save the relation: ${String(e)}`);
      if (edgeId) {
        // The refused relation left no edge behind; a successful one closes the
        // form above and never reaches this branch.
        setEdges(eds => eds.filter(edge => edge.id !== edgeId));
      }
    } finally {
      setSavingCharacterConnection(false);
    }
  };

  const addRelation = async () => {
    if (!selectedCharacterId) return;

    const kind = newRelationKind.trim();

    if (!kind) {
      setCharacterError('A relation needs a kind.');
      return;
    }

    if (!newRelationToId) {
      setCharacterError('Choose the cast member the relation joins.');
      return;
    }

    setCharacterError(null);

    try {
      const saved: CharacterRelation = await relationsApi.addRelation(
        selectedCharacterId,
        newRelationToId,
        kind,
        newRelationNote.trim() || null,
        newRelationChapterId || null,
        null,
        actor
      );

      applyRelation(saved);
      setNewRelationToId('');
      setNewRelationChapterId('');
      setNewRelationNote('');
    } catch (e) {
      console.error('Failed to add a relation:', e);
      setCharacterError(`Could not add the relation: ${String(e)}`);
    }
  };

  const startRelationEdit = (relation: CharacterRelation) => {
    setCharacterError(null);
    setEditingRelationId(relation.id);
    setRelationKindDraft(relation.kind);
    setRelationChapterDraft(relation.since_chapter_id ?? '');
    setRelationUntilChapterDraft(relation.until_chapter_id ?? '');
    setRelationNoteDraft(relation.note ?? '');
  };

  const saveRelation = async (relation: CharacterRelation) => {
    const kind = relationKindDraft.trim();

    if (!kind) {
      setCharacterError('A relation needs a kind.');
      return;
    }

    setCharacterError(null);

    const note = relationNoteDraft.trim() || null;
    const sinceChapterId = relationChapterDraft || null;
    const untilChapterId = relationUntilChapterDraft || null;

    // The connection that drew this bond carries its verb on the line and in
    // its data. The sheet and that line move together, so deleting either one
    // later still names the same bond. A label the author rewrote by hand is
    // theirs to keep; only the relation type has to follow the sheet.
    const matchingEdge = matchingRelationEdge(edges, nodes, storyRelations, relation);
    const oldEdgeLabel = matchingEdge?.data?.label ?? null;
    const oldEdgeRelation = matchingEdge?.data?.relationType ?? null;
    const nextEdgeLabel =
      matchingEdge && oldEdgeLabel && oldEdgeLabel !== relation.kind
        ? oldEdgeLabel
        : kind;
    const edgeNeedsWrite = Boolean(
      matchingEdge &&
        ((oldEdgeLabel ?? '') !== nextEdgeLabel ||
          (oldEdgeRelation ?? '') !== kind)
    );

    const writeRelation = async (next: {
      kind: string;
      note: string | null;
      sinceChapterId: string | null;
      untilChapterId: string | null;
    }) => {
      const saved: CharacterRelation = await relationsApi.updateRelation(
        relation.id,
        next.kind,
        next.note,
        next.sinceChapterId,
        next.untilChapterId,
        actor
      );

      applyRelation(saved);
    };

    const writeEdge = async (label: string | null, relationType: string | null) => {
      if (!matchingEdge) return;

      const updated: any = await canvasApi.updateGraphEdge(
        matchingEdge.id,
        label,
        relationType,
        actor
      );

      setEdges(previous =>
        previous.map(edge =>
          edge.id === matchingEdge.id
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

      // An inspector left open on this connection follows the saved verb,
      // unless it holds typing the author has not saved.
      if (selectedEdgeIdRef.current === matchingEdge.id && !edgeIsDirtyRef.current) {
        setEdgeLabelDraft(updated.label ?? '');
        setEdgeRelationDraft(updated.relation_type ?? '');
      }
    };

    try {
      await writeRelation({ kind, note, sinceChapterId, untilChapterId });
      if (edgeNeedsWrite) await writeEdge(nextEdgeLabel, kind);
      setEditingRelationId(null);

      const fromName =
        characters.find(character => character.id === relation.from_character_id)?.name ??
        'a cast member';
      const toName =
        characters.find(character => character.id === relation.to_character_id)?.name ??
        'a cast member';

      recordStep({
        label:
          relation.kind === kind
            ? `Edit the ${kind} relation between ${fromName} and ${toName}`
            : `Change the ${relation.kind} relation between ${fromName} and ${toName} to ${kind}`,
        undo: async () => {
          await writeRelation({
            kind: relation.kind,
            note: relation.note,
            sinceChapterId: relation.since_chapter_id,
            untilChapterId: relation.until_chapter_id,
          });
          if (edgeNeedsWrite) await writeEdge(oldEdgeLabel, oldEdgeRelation);
        },
        redo: async () => {
          await writeRelation({ kind, note, sinceChapterId, untilChapterId });
          if (edgeNeedsWrite) await writeEdge(nextEdgeLabel, kind);
        },
      });
    } catch (e) {
      console.error('Failed to save a relation:', e);
      setCharacterError(`Could not save the relation: ${String(e)}`);
    }
  };

  const removeRelation = async (relation: CharacterRelation) => {
    setCharacterError(null);

    // The canvas connection that drew this relation. A bond can be recorded on
    // the sheet without ever being drawn, so the edge is optional; when it is
    // there, both halves leave together.
    const matchingEdge = matchingRelationEdge(edges, nodes, storyRelations, relation);
    const fromName =
      characters.find(character => character.id === relation.from_character_id)?.name ??
      'a cast member';
    const toName =
      characters.find(character => character.id === relation.to_character_id)?.name ??
      'a cast member';

    try {
      await relationsApi.deleteRelation(relation.id, actor);
      setStoryRelations(previous =>
        previous.filter(other => other.id !== relation.id)
      );

      if (matchingEdge) {
        await canvasApi.deleteEdge(matchingEdge.id, actor);
        setEdges(previous => previous.filter(edge => edge.id !== matchingEdge.id));
        if (selectedEdgeId === matchingEdge.id) setSelectedEdgeId(null);
      }

      if (editingRelationId === relation.id) setEditingRelationId(null);

      let currentRelationId = relation.id;

      recordStep({
        label: `Delete the ${relation.kind} relation between ${fromName} and ${toName}`,
        undo: async () => {
          const again: CharacterRelation = await relationsApi.addRelation(
            relation.from_character_id,
            relation.to_character_id,
            relation.kind,
            relation.note,
            relation.since_chapter_id,
            relation.until_chapter_id,
            actor
          );
          currentRelationId = again.id;
          applyRelation(again);

          if (matchingEdge) {
            await trashApi.restoreDeleted(matchingEdge.id, 'edge', actor);
            setEdges(previous =>
              previous.some(edge => edge.id === matchingEdge.id)
                ? previous
                : addEdge(matchingEdge, previous)
            );
          }
        },
        redo: async () => {
          await relationsApi.deleteRelation(currentRelationId, actor);
          setStoryRelations(previous =>
            previous.filter(other => other.id !== currentRelationId)
          );

          if (matchingEdge) {
            await canvasApi.deleteEdge(matchingEdge.id, actor);
            setEdges(previous => previous.filter(edge => edge.id !== matchingEdge.id));
          }
        },
      });
    } catch (e) {
      console.error('Failed to delete a relation:', e);
      setCharacterError(`Could not delete the relation: ${String(e)}`);
    }
  };

  const applyStanding = useCallback((saved: FactionStanding) => {
    setStoryFactionStandings(previous =>
      [...previous.filter(standing => standing.id !== saved.id), saved].sort(
        (a, b) =>
          (a.since_chapter_id ?? '').localeCompare(b.since_chapter_id ?? '') ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id)
      )
    );
  }, []);

  const addStanding = async () => {
    if (!selectedCharacterId) return;

    const standing = newStandingText.trim();

    if (!newStandingFactionId) {
      setCharacterError('Choose the faction this standing belongs to.');
      return;
    }

    if (!standing) {
      setCharacterError('A faction standing needs a word for it.');
      return;
    }

    if (!newStandingChapterId) {
      setCharacterError('A faction standing needs the chapter it began in.');
      return;
    }

    setCharacterError(null);

    try {
      const saved: FactionStanding = await relationsApi.addFactionStanding(
        selectedCharacterId,
        newStandingFactionId,
        standing,
        newStandingNote.trim() || null,
        newStandingChapterId,
        null,
        actor
      );

      applyStanding(saved);
      setNewStandingText('');
      setNewStandingChapterId('');
      setNewStandingNote('');
    } catch (e) {
      console.error('Failed to add a faction standing:', e);
      setCharacterError(`Could not add the faction standing: ${String(e)}`);
    }
  };

  const startStandingEdit = (standing: FactionStanding) => {
    setCharacterError(null);
    setEditingStandingId(standing.id);
    setStandingFactionDraft(standing.faction_node_id ?? '');
    setStandingTextDraft(standing.standing);
    setStandingChapterDraft(standing.since_chapter_id ?? '');
    setStandingUntilChapterDraft(standing.until_chapter_id ?? '');
    setStandingNoteDraft(standing.note ?? '');
  };

  const saveStanding = async (standing: FactionStanding) => {
    const text = standingTextDraft.trim();

    if (!standingFactionDraft) {
      setCharacterError('Choose the faction this standing belongs to.');
      return;
    }

    if (!text) {
      setCharacterError('A faction standing needs a word for it.');
      return;
    }

    if (!standingChapterDraft) {
      setCharacterError('A faction standing needs the chapter it began in.');
      return;
    }

    setCharacterError(null);

    try {
      const saved: FactionStanding = await relationsApi.updateFactionStanding(
        standing.id,
        standingFactionDraft,
        text,
        standingNoteDraft.trim() || null,
        standingChapterDraft,
        standingUntilChapterDraft || null,
        actor
      );

      applyStanding(saved);
      setEditingStandingId(null);
    } catch (e) {
      console.error('Failed to save a faction standing:', e);
      setCharacterError(`Could not save the faction standing: ${String(e)}`);
    }
  };

  const removeStanding = async (standing: FactionStanding) => {
    setCharacterError(null);

    try {
      await relationsApi.deleteFactionStanding(standing.id, actor);
      setStoryFactionStandings(previous =>
        previous.filter(other => other.id !== standing.id)
      );
      if (editingStandingId === standing.id) setEditingStandingId(null);
    } catch (e) {
      console.error('Failed to delete a faction standing:', e);
      setCharacterError(`Could not delete the faction standing: ${String(e)}`);
    }
  };

  // The two reads a payout reaches once it is written: the chapter income rows
  // it joins and the inventory it lands in. Both are shared with the chart and
  // the sheets, so the ledger asks for a reload rather than owning either.
  const reloadCharacterProgress = useCallback(async () => {
    if (!currentStory) return;

    const rows = await progressionApi.getStoryCharacterProgress(currentStory.id);
    setStoryCharacterProgress(rows ?? []);
  }, [currentStory]);

  const reloadInventory = useCallback(async () => {
    if (!currentStory) return;

    const rows = await inventoryApi.getStoryInventory(currentStory.id);
    setStoryInventory(rows ?? []);
  }, [currentStory]);

  const levelMilestoneXpFromDraft = (text: string): number | null | 'invalid' => {
    const xp = text.trim();

    if (xp === '') return null;

    if (!/^\d+$/.test(xp) || Number(xp) < 0) {
      setCharacterError('Total XP is a whole number, 0 or more, or blank.');
      return 'invalid';
    }

    return Number(xp);
  };

  const statChangesFromDrafts = (
    drafts: LevelStatChangeDraft[]
  ): { stat_name: string; amount: number | null; value_after: number | null }[] | null => {
    const seen = new Set<string>();
    const changes: {
      stat_name: string;
      amount: number | null;
      value_after: number | null;
    }[] = [];

    for (const draft of drafts) {
      const statName = draft.statName.trim();
      const amountText = draft.amount.trim();
      const valueText = draft.valueAfter.trim();

      if (statName === '' && amountText === '' && valueText === '') continue;

      if (statName === '') {
        setCharacterError('A stat change needs a stat name.');
        return null;
      }

      if (amountText === '' && valueText === '') {
        setCharacterError(
          `${statName} needs a gain, a resulting value, or both.`
        );
        return null;
      }

      if (amountText !== '' && !/^-?\d+$/.test(amountText)) {
        setCharacterError(`${statName}'s gain is a whole number, or blank.`);
        return null;
      }

      if (valueText !== '' && !/^-?\d+$/.test(valueText)) {
        setCharacterError(`${statName}'s resulting value is a whole number, or blank.`);
        return null;
      }

      if (seen.has(statName)) {
        setCharacterError(`${statName} is changed more than once in this level-up.`);
        return null;
      }
      seen.add(statName);

      changes.push({
        stat_name: statName,
        amount: amountText === '' ? null : Number(amountText),
        value_after: valueText === '' ? null : Number(valueText),
      });
    }

    return changes;
  };

  const startLevelMilestoneEdit = (milestone: CharacterLevelMilestone) => {
    setCharacterError(null);
    setEditingLevelMilestoneId(milestone.id);
    setLevelMilestoneLevelDraft(String(milestone.level));
    setLevelMilestoneChapterDraft(milestone.chapter_id ?? '');
    setLevelMilestoneDebuffDraft(milestone.is_debuff);
    setLevelMilestoneXpDraft(milestone.xp == null ? '' : String(milestone.xp));
    setLevelMilestoneStatChangesDraft(statChangesFromMilestone(milestone));
  };

  const saveLevelMilestone = async (milestone: CharacterLevelMilestone) => {
    const level = Number(levelMilestoneLevelDraft);

    if (!/^\d+$/.test(levelMilestoneLevelDraft.trim()) || level < 1) {
      setCharacterError('A level milestone needs a whole-number level of 1 or more.');
      return;
    }

    const xp = levelMilestoneXpFromDraft(levelMilestoneXpDraft);
    if (xp === 'invalid') return;

    const statChanges = statChangesFromDrafts(levelMilestoneStatChangesDraft);
    if (!statChanges) return;

    setCharacterError(null);

    try {
      const saved: CharacterLevelMilestone = await progressionApi.updateLevelMilestone(
        milestone.id,
        level,
        levelMilestoneChapterDraft || null,
        levelMilestoneDebuffDraft,
        xp,
        statChanges,
        actor
      );

      applyLevelMilestone(saved);
      setEditingLevelMilestoneId(null);
    } catch (e) {
      console.error('Failed to save a level milestone:', e);
      setCharacterError(`Could not save the level milestone: ${String(e)}`);
    }
  };

  const addLevelMilestone = async () => {
    if (!selectedCharacterId) return;

    const level = Number(newLevelMilestoneLevel);

    if (!/^\d+$/.test(newLevelMilestoneLevel.trim()) || level < 1) {
      setCharacterError('A level milestone needs a whole-number level of 1 or more.');
      return;
    }

    const xp = levelMilestoneXpFromDraft(newLevelMilestoneXp);
    if (xp === 'invalid') return;

    const statChanges = statChangesFromDrafts(newLevelMilestoneStatChanges);
    if (!statChanges) return;

    setCharacterError(null);

    try {
      const saved: CharacterLevelMilestone = await progressionApi.addLevelMilestone(
        selectedCharacterId,
        level,
        newLevelMilestoneChapter || null,
        newLevelMilestoneDebuff,
        xp,
        statChanges,
        actor
      );

      applyLevelMilestone(saved);
      setNewLevelMilestoneLevel(String(level));
      setNewLevelMilestoneChapter('');
      setNewLevelMilestoneDebuff(false);
      setNewLevelMilestoneXp('');
      setNewLevelMilestoneStatChanges([blankStatChange()]);
    } catch (e) {
      console.error('Failed to add a level milestone:', e);
      setCharacterError(`Could not add the level milestone: ${String(e)}`);
    }
  };

  const removeLevelMilestone = async (milestone: CharacterLevelMilestone) => {
    setCharacterError(null);

    try {
      await progressionApi.deleteLevelMilestone(milestone.id, actor);
      setStoryLevelMilestones(previous =>
        previous.filter(other => other.id !== milestone.id)
      );
      // The database sets a skill event's level-up link to null when the
      // milestone goes; keep the board copy in step so no row points at it.
      setStorySkillEvents(previous =>
        previous.map(event =>
          event.milestone_id === milestone.id ? { ...event, milestone_id: null } : event
        )
      );
      if (editingLevelMilestoneId === milestone.id) setEditingLevelMilestoneId(null);
    } catch (e) {
      console.error('Failed to delete a level milestone:', e);
      setCharacterError(`Could not delete the level milestone: ${String(e)}`);
    }
  };

  const xpEntryAmount = (text: string): number | null => {
    const trimmed = text.trim();

    if (!/^\d+$/.test(trimmed)) {
      setCharacterError('XP earned is a whole number, 0 or more.');
      return null;
    }

    return Number(trimmed);
  };

  const applyXpEntry = (saved: CharacterProgress) => {
    setStoryCharacterProgress(previous => [
      ...previous.filter(entry => entry.id !== saved.id),
      saved,
    ]);
  };

  const startXpEntryEdit = (entry: CharacterProgress) => {
    setCharacterError(null);
    setEditingXpEntryId(entry.id);
    setXpEntryChapterDraft(entry.chapter_id);
    setXpEntryXpDraft(String(entry.xp_earned));
  };

  const saveXpEntry = async (entry: CharacterProgress) => {
    if (!xpEntryChapterDraft) {
      setCharacterError('XP earned needs a chapter.');
      return;
    }

    const xpEarned = xpEntryAmount(xpEntryXpDraft);
    if (xpEarned === null) return;

    setCharacterError(null);

    try {
      const saved: CharacterProgress = await progressionApi.updateCharacterProgress(
        entry.id,
        xpEntryChapterDraft,
        xpEarned,
        actor
      );

      applyXpEntry(saved);
      setEditingXpEntryId(null);
    } catch (e) {
      console.error('Failed to save XP income:', e);
      setCharacterError(`Could not save XP earned: ${String(e)}`);
    }
  };

  const addXpEntry = async () => {
    if (!selectedCharacterId) return;

    if (!newXpEntryChapter) {
      setCharacterError('XP earned needs a chapter.');
      return;
    }

    const xpEarned = xpEntryAmount(newXpEntryXp);
    if (xpEarned === null) return;

    setCharacterError(null);

    try {
      const saved: CharacterProgress = await progressionApi.addCharacterProgress(
        selectedCharacterId,
        newXpEntryChapter,
        xpEarned,
        actor
      );

      applyXpEntry(saved);
      setNewXpEntryChapter('');
      setNewXpEntryXp('');
    } catch (e) {
      console.error('Failed to add XP income:', e);
      setCharacterError(`Could not add XP earned: ${String(e)}`);
    }
  };

  const removeXpEntry = async (entry: CharacterProgress) => {
    setCharacterError(null);

    try {
      await progressionApi.deleteCharacterProgress(entry.id, actor);
      setStoryCharacterProgress(previous =>
        previous.filter(other => other.id !== entry.id)
      );
      if (editingXpEntryId === entry.id) setEditingXpEntryId(null);
    } catch (e) {
      console.error('Failed to delete XP income:', e);
      setCharacterError(`Could not delete XP earned: ${String(e)}`);
    }
  };

  // An item is shown on the sheet and on its card, so both lists take the saved
  // row. The sort matches the read, which is by name.
  const applyInventoryItem = (saved: InventoryItem) => {
    const ordered = (list: InventoryItem[]) =>
      [...list.filter(other => other.id !== saved.id), saved].sort((a, b) =>
        a.name.localeCompare(b.name)
      );

    setCharacterInventory(ordered);
    setStoryInventory(ordered);
  };

  // A correction made on the board can name an item whose owner's sheet is not
  // the one loaded, so only the story list always takes the saved row.
  const applyReturnedItem = useCallback((saved: InventoryItem) => {
    const ordered = (list: InventoryItem[]) =>
      [...list.filter(other => other.id !== saved.id), saved].sort((a, b) =>
        a.name.localeCompare(b.name)
      );

    setStoryInventory(previous => {
      const next = ordered(previous);
      storyInventoryRef.current = next;
      return next;
    });
    setCharacterInventory(previous =>
      previous.some(other => other.id === saved.id) ? ordered(previous) : previous
    );
  }, []);

  const parseCount = (text: string): number | null => {
    const trimmed = text.trim();
    return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
  };

  const startItemEdit = (item: InventoryItem) => {
    setCharacterError(null);
    setEditingItemId(item.id);
    setItemNameDraft(item.name);
    setItemRarityDraft(item.rarity ?? '');
    setItemQuantityDraft(String(item.quantity));
    setItemEffectDraft(item.effect ?? '');
    setItemChapterDraft(item.chapter_id ?? '');
    setItemLostChapterDraft(item.lost_chapter_id ?? '');
    setItemNodeDraft(item.node_id ?? '');
  };

  const saveItem = async (item: InventoryItem) => {
    const name = itemNameDraft.trim();

    if (!name) {
      setCharacterError('An item needs a name — delete it to remove it.');
      return;
    }

    const quantity = parseCount(itemQuantityDraft);

    if (quantity === null) {
      setCharacterError('An item needs a whole-number quantity, zero or more.');
      return;
    }

    setCharacterError(null);

    try {
      const updated: InventoryItem = await inventoryApi.updateInventoryItem(
        item.id,
        name,
        itemRarityDraft.trim() || null,
        quantity,
        itemEffectDraft.trim() || null,
        itemChapterDraft || null,
        itemLostChapterDraft || null,
        itemNodeDraft || null,
        actor
      );

      applyInventoryItem(updated);
      setEditingItemId(null);
    } catch (e) {
      console.error('Failed to save item:', e);
      setCharacterError(`Could not save item: ${String(e)}`);
    }
  };

  const addItem = async () => {
    if (!selectedCharacterId || !newItemName.trim()) return;

    const quantity = parseCount(newItemQuantity);

    if (quantity === null) {
      setCharacterError('An item needs a whole-number quantity, zero or more.');
      return;
    }

    setCharacterError(null);

    try {
      const saved: InventoryItem = await inventoryApi.addInventoryItem(
        selectedCharacterId,
        newItemName.trim(),
        newItemRarity.trim() || null,
        quantity,
        newItemEffect.trim() || null,
        newItemChapterId || null,
        newItemLostChapterId || null,
        newItemNodeId || null,
        actor
      );

      applyInventoryItem(saved);
      setNewItemName('');
      setNewItemRarity('');
      setNewItemQuantity('1');
      setNewItemEffect('');
      setNewItemChapterId('');
      setNewItemLostChapterId('');
      setNewItemNodeId('');
    } catch (e) {
      console.error('Failed to add item:', e);
      setCharacterError(`Could not add item: ${String(e)}`);
    }
  };

  const removeItem = async (item: InventoryItem) => {
    setCharacterError(null);

    try {
      await inventoryApi.deleteInventoryItem(item.id, actor);
      setCharacterInventory(prev => prev.filter(other => other.id !== item.id));
      setStoryInventory(prev => prev.filter(other => other.id !== item.id));
      setEditingItemId(null);
    } catch (e) {
      console.error('Failed to delete item:', e);
      setCharacterError(`Could not delete item: ${String(e)}`);
    }
  };

  // Clearing the loss is the one correction the card can make without leaving
  // the board. It goes through the same audited command as the sheet's editor,
  // so the history records the lost chapter it removed.
  const markItemReturned = useCallback(
    async (itemId: string) => {
      const item = storyInventory.find(candidate => candidate.id === itemId);

      if (!item || !item.lost_chapter_id) return;

      const previousLostChapterId = item.lost_chapter_id;
      setActionError(null);
      setReturningItemId(itemId);

      try {
        const updated: InventoryItem = await inventoryApi.updateInventoryItem(
          item.id,
          item.name,
          item.rarity,
          item.quantity,
          item.effect,
          item.chapter_id,
          null,
          item.node_id,
          actor
        );

        applyReturnedItem(updated);

        // Walk only the lost chapter, and read the item as it stands when the
        // step runs, so undo does not also undo an edit made in between.
        const setLostChapter = (lostChapterId: string | null) => async () => {
          const current =
            storyInventoryRef.current.find(candidate => candidate.id === updated.id) ?? updated;
          const saved: InventoryItem = await inventoryApi.updateInventoryItem(
            current.id,
            current.name,
            current.rarity,
            current.quantity,
            current.effect,
            current.chapter_id,
            lostChapterId,
            current.node_id,
            actor
          );

          applyReturnedItem(saved);
          return saved;
        };

        recordStep({
          label: `Mark “${item.name}” returned`,
          undo: setLostChapter(previousLostChapterId),
          redo: setLostChapter(null),
        });
        setReturnedNotice({ itemName: item.name });
      } catch (e) {
        console.error('Failed to mark an item returned:', e);
        setActionError(`Could not mark ${item.name} returned: ${String(e)}`);
      } finally {
        setReturningItemId(null);
      }
    },
    [storyInventory, actor, applyReturnedItem, recordStep]
  );

  const applyCurrency = (saved: CharacterCurrency) => {
    const ordered = (list: CharacterCurrency[]) =>
      [...list.filter(other => other.id !== saved.id), saved].sort((a, b) =>
        a.name.localeCompare(b.name)
      );

    setCharacterCurrency(ordered);
  };

  const startCurrencyEdit = (currency: CharacterCurrency) => {
    setCharacterError(null);
    setEditingCurrencyId(currency.id);
    setCurrencyNameDraft(currency.name);
    setCurrencyAmountDraft(String(currency.amount));
  };

  const saveCurrency = async (currency: CharacterCurrency) => {
    const name = currencyNameDraft.trim();

    if (!name) {
      setCharacterError('A currency needs a name — delete it to remove it.');
      return;
    }

    const amount = parseCount(currencyAmountDraft);

    if (amount === null) {
      setCharacterError('A currency amount must be a whole number, zero or more.');
      return;
    }

    setCharacterError(null);

    try {
      const updated: CharacterCurrency = await inventoryApi.updateCurrency(
        currency.id,
        name,
        amount,
        actor
      );

      applyCurrency(updated);
      setEditingCurrencyId(null);
    } catch (e) {
      console.error('Failed to save currency:', e);
      setCharacterError(`Could not save currency: ${String(e)}`);
    }
  };

  const addCurrency = async () => {
    if (!selectedCharacterId || !newCurrencyName.trim()) return;

    const amount = parseCount(newCurrencyAmount);

    if (amount === null) {
      setCharacterError('A currency amount must be a whole number, zero or more.');
      return;
    }

    setCharacterError(null);

    try {
      const saved: CharacterCurrency = await inventoryApi.addCurrency(
        selectedCharacterId,
        newCurrencyName.trim(),
        amount,
        actor
      );

      applyCurrency(saved);
      setNewCurrencyName('');
      setNewCurrencyAmount('0');
    } catch (e) {
      console.error('Failed to add currency:', e);
      setCharacterError(`Could not add currency: ${String(e)}`);
    }
  };

  const removeCurrency = async (currency: CharacterCurrency) => {
    setCharacterError(null);

    try {
      await inventoryApi.deleteCurrency(currency.id, actor);
      setCharacterCurrency(prev => prev.filter(other => other.id !== currency.id));
      setEditingCurrencyId(null);
    } catch (e) {
      console.error('Failed to delete currency:', e);
      setCharacterError(`Could not delete currency: ${String(e)}`);
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
      const updated: Character = await charactersApi.updateCharacter(
        selectedCharacter.id,
        name,
        characterDescriptionDraft.trim() || null,
        actor
      );

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
      await charactersApi.deleteCharacter(removedId, actor);

      const remaining = characters.filter(character => character.id !== removedId);
      const removedSkillIds = new Set(
        storySkills.filter(skill => skill.character_id === removedId).map(skill => skill.id)
      );

      setCharacters(remaining);
      setSelectedCharacterId(remaining[0]?.id ?? null);
      setCharacterStats([]);
      setCharacterAttributes([]);
      setCharacterSkills([]);
      setStorySkills(previous => previous.filter(skill => skill.character_id !== removedId));
      setStorySkillEvents(previous =>
        previous.filter(event => !removedSkillIds.has(event.skill_id))
      );
      setStoryLevelMilestones(previous =>
        previous.filter(milestone => milestone.character_id !== removedId)
      );
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

      const imported: Story = await storiesApi.importStoryJson(selected, actor);

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
      const path: string = await storiesApi.exportStoryJson(currentStory.id);
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
      const path: string = await storiesApi.exportStoryMarkdown(currentStory.id);
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
      const markdown: string = await storiesApi.storyBibleMarkdown(currentStory.id);

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
      const list = await storiesApi.listBackups();
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
      await storiesApi.restoreBackup(file.file_name);

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
      setTrash([]);
      setDeletedStories([]);

      const restored: Story[] = await storiesApi.getAllStories();
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
      const updated: any = await canvasApi.updateGraphNode(selectedNodeId, label, content, actor);

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

      // The card's linked skill rows follow the name and notes that were just
      // saved. Only the changed fields are mirrored, because rank and chapter
      // belong to each holder.
      const cardNameChanged =
        currentNode?.data.nodeType === 'skill' && currentNode.data.label !== label;
      const cardEffectChanged =
        currentNode?.data.nodeType === 'skill' &&
        (currentNode.data.content ?? null) !== content;

      if (cardNameChanged || cardEffectChanged) {
        applySkillCardSync(updated.id, label, content, {
          name: cardNameChanged,
          effect: cardEffectChanged,
        });
      }

      // The values before the save, kept so undo can put them back through the
      // same command; the history records the walk in both directions.
      const before = currentNode
        ? { label: currentNode.data.label, content: currentNode.data.content ?? null }
        : null;

      if (before) {
        recordStep({
          label: `Edit “${label}”`,
          undo: async () => {
            await canvasApi.updateGraphNode(selectedNodeId, before.label, before.content, actor);
            if (cardNameChanged || cardEffectChanged) {
              applySkillCardSync(updated.id, before.label, before.content, {
                name: cardNameChanged,
                effect: cardEffectChanged,
              });
            }
          },
          redo: async () => {
            await canvasApi.updateGraphNode(selectedNodeId, label, content, actor);
            if (cardNameChanged || cardEffectChanged) {
              applySkillCardSync(updated.id, label, content, {
                name: cardNameChanged,
                effect: cardEffectChanged,
              });
            }
          },
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

    // A character-to-character line can be the drawing of a relation. Match it
    // before the edge changes, while its old verb still names the bond.
    const linkedRelation = currentEdge
      ? relationForEdge(currentEdge, nodes, storyRelations)
      : undefined;
    const relationKindChanged = Boolean(
      linkedRelation && relationType && linkedRelation.kind !== relationType
    );
    // A label that still repeats the old verb follows the new one. A label the
    // author wrote by hand is theirs to keep.
    const nextLabel =
      linkedRelation && relationType && label === linkedRelation.kind
        ? relationType
        : label;

    // A relation must keep a kind. Clearing every verb on the line that draws
    // one would leave the bond without its connection, so ask for another verb
    // instead of silently detaching or deleting the relation.
    const losingRelationVerb = Boolean(
      linkedRelation &&
        !relationType &&
        (!nextLabel || currentEdge?.data?.relationType)
    );

    if (losingRelationVerb && linkedRelation && currentEdge) {
      const endpointName = (nodeId: string) =>
        nodes.find(node => node.id === nodeId)?.data.label ?? '?';

      setEdgeEditError(
        `This connection draws the ${linkedRelation.kind} relation between ` +
          `${endpointName(currentEdge.source)} and ${endpointName(currentEdge.target)}. ` +
          'Choose another relation type, or delete the connection to remove the bond.'
      );
      return;
    }

    // Saving without changing anything is not an edit, so it writes nothing.
    if (
      currentEdge &&
      (currentEdge.data?.label ?? null) === nextLabel &&
      (currentEdge.data?.relationType ?? null) === relationType
    ) {
      return;
    }

    const beforeLabel = currentEdge?.data?.label ?? null;
    const beforeRelation = currentEdge?.data?.relationType ?? null;

    const writeEdge = async (
      nextLabelValue: string | null,
      nextRelationType: string | null
    ) => {
      const updated: any = await canvasApi.updateGraphEdge(
        selectedEdgeId,
        nextLabelValue,
        nextRelationType,
        actor
      );

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

      if (selectedEdgeIdRef.current === updated.id && !edgeIsDirtyRef.current) {
        setEdgeLabelDraft(updated.label ?? '');
        setEdgeRelationDraft(updated.relation_type ?? '');
      }
    };

    const writeRelationKind = async (kind: string) => {
      if (!linkedRelation) return;

      const saved: CharacterRelation = await relationsApi.updateRelation(
        linkedRelation.id,
        kind,
        linkedRelation.note,
        linkedRelation.since_chapter_id,
        linkedRelation.until_chapter_id,
        actor
      );

      applyRelation(saved);
    };

    try {
      await writeEdge(nextLabel, relationType);
      if (relationKindChanged && relationType) await writeRelationKind(relationType);

      setEdgeLabelDraft(nextLabel ?? '');
      setEdgeRelationDraft(relationType ?? '');

      if (currentEdge) {
        recordStep({
          label: 'Edit a connection',
          undo: async () => {
            await writeEdge(beforeLabel, beforeRelation);
            if (relationKindChanged && linkedRelation) {
              await writeRelationKind(linkedRelation.kind);
            }
          },
          redo: async () => {
            await writeEdge(nextLabel, relationType);
            if (relationKindChanged && relationType) await writeRelationKind(relationType);
          },
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
      const updated: any = await canvasApi.setNodeCharacter(
        selectedNode.id,
        characterId || null,
        actor
      );

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
          canvasApi.setNodeCharacter(selectedNode.id, previousId, actor),
        redo: () =>
          canvasApi.setNodeCharacter(selectedNode.id, characterId || null, actor),
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
      const updated: any = await canvasApi.updateGraphNode(
        node.id,
        renameOffer.to,
        node.data.content ?? null,
        actor
      );

      setNodes(nds =>
        nds.map(other =>
          other.id === updated.id
            ? { ...other, data: { ...other.data, label: updated.label } }
            : other
        )
      );

      if (node.data.nodeType === 'skill') {
        applySkillCardSync(node.id, updated.label, updated.content ?? null, {
          name: true,
          effect: false,
        });
      }

      recordStep({
        label: `Rename “${node.data.label}”`,
        undo: async () => {
          await canvasApi.updateGraphNode(
            node.id,
            node.data.label,
            node.data.content ?? null,
            actor
          );
          if (node.data.nodeType === 'skill') {
            applySkillCardSync(node.id, node.data.label, node.data.content ?? null, {
              name: true,
              effect: false,
            });
          }
        },
        redo: async () => {
          await canvasApi.updateGraphNode(node.id, updated.label, updated.content ?? null, actor);
          if (node.data.nodeType === 'skill') {
            applySkillCardSync(node.id, updated.label, updated.content ?? null, {
              name: true,
              effect: false,
            });
          }
        },
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
      const updated: CharacterStat = await charactersApi.setCharacterStat(
        inspectorCharacter.id,
        stat.stat_name,
        Math.trunc(value),
        stat.notes,
        actor
      );

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
      const updated: CharacterAttribute = await charactersApi.setCharacterAttribute(
        inspectorCharacter.id,
        attribute.attr_name,
        value,
        actor
      );

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
  // rebuilt, so the rest keep their identity across a render. Chapter notes join
  // them while the note toggle is on, as cards pinned under the chapter.
  const canvasNodes = useMemo(() => {
    const castById = new Map(characters.map(character => [character.id, character]));
    const nodeLabels = new Map(nodes.map(node => [node.id, node.data.label]));
    // A skill card names its holders in one read rather than asking the database
    // per card. A skill whose character is gone (in the trash) is left out.
    const holdersByNode: Record<string, SkillHolder[]> = {};

    for (const skill of storySkills) {
      if (!skill.node_id) continue;
      const character = castById.get(skill.character_id);
      if (!character) continue;

      if (!holdersByNode[skill.node_id]) holdersByNode[skill.node_id] = [];
      holdersByNode[skill.node_id].push({
        id: skill.id,
        characterName: character.name,
        rank: skill.rank,
        chapterLabel: skill.chapter_id ? nodeLabels.get(skill.chapter_id) ?? null : null,
      });
    }

    for (const holders of Object.values(holdersByNode)) {
      holders.sort((a, b) => a.characterName.localeCompare(b.characterName));
    }

    // The same for an item card: who carries it, how many and how rare.
    const inventoryByNode: Record<string, InventoryHolder[]> = {};

    for (const item of storyInventory) {
      if (!item.node_id) continue;
      const character = castById.get(item.character_id);
      if (!character) continue;

      if (!inventoryByNode[item.node_id]) inventoryByNode[item.node_id] = [];
      inventoryByNode[item.node_id].push({
        id: item.id,
        characterName: character.name,
        quantity: item.quantity,
        rarity: item.rarity,
        chapterLabel: item.chapter_id ? nodeLabels.get(item.chapter_id) ?? null : null,
        lostChapterLabel: item.lost_chapter_id
          ? nodeLabels.get(item.lost_chapter_id) ?? null
          : null,
      });
    }

    for (const holders of Object.values(inventoryByNode)) {
      holders.sort((a, b) => a.characterName.localeCompare(b.characterName));
    }

    return nodes.map(node => {
      const characterId = node.data.characterId;
      const notes = showChapterNotes ? notesByChapter.get(node.id) ?? [] : [];
      const noteCards = notes.slice(0, NOTE_CARDS_SHOWN);
      const hiddenNotes = notes.length - noteCards.length;
      const holders = holdersByNode[node.id] ?? [];
      const itemHolders = inventoryByNode[node.id] ?? [];
      const chapterCast = chapterCastByChapter.get(node.id) ?? [];
      const chapterQuests = questBadgesByChapter.get(node.id) ?? [];
      const continuityFlags = [
        ...(inventoryFlagsByChapter.get(node.id) ?? []),
        ...(progressFlagsByChapter.get(node.id) ?? []),
      ];
      const classes = [
        node.id === dropTargetNodeId ? 'drop-target' : '',
        searchOpen && searchMatchIds.has(node.id) ? 'search-hit' : '',
      ]
        .filter(Boolean)
        .join(' ');

      if (
        !characterId &&
        !classes &&
        notes.length === 0 &&
        holders.length === 0 &&
        itemHolders.length === 0 &&
        chapterCast.length === 0 &&
        chapterQuests.length === 0 &&
        continuityFlags.length === 0
      ) {
        return node;
      }

      return {
        ...node,
        className: classes || undefined,
        // Without this the node wrapper's name is the whole card plus every note
        // under it, since React Flow labels the wrapper from its contents.
        ariaLabel:
          notes.length > 0
            ? `${node.data.label}${
                node.data.chapterSeq != null ? `, chapter ${node.data.chapterSeq}` : ''
              }, ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} pinned beneath`
            : undefined,
        data: {
          ...node.data,
          ...(characterId
            ? {
                characterName: castById.get(characterId)?.name ?? null,
                characterStats: castStats[characterId] ?? [],
                characterLevel: castById.get(characterId)?.level ?? null,
              }
            : {}),
          ...(notes.length > 0
            ? {
                noteCards,
                hiddenNotes,
                onOpenNote: (noteId: string | null) =>
                  openNoteFromGraph(node.id, noteId),
              }
            : {}),
          ...(holders.length > 0
            ? {
                skillHolders: holders,
                hiddenSkillHolders: Math.max(0, holders.length - 2),
              }
            : {}),
          ...(itemHolders.length > 0
            ? {
                inventoryHolders: itemHolders,
                hiddenInventoryHolders: Math.max(0, itemHolders.length - 2),
              }
            : {}),
          ...(chapterCast.length > 0              ? {
                  chapterCast,
                  onOpenChapterCast: (characterId: string) =>
                    openCharacterSheet(characterId),
                }
              : {}),
          ...(chapterQuests.length > 0
            ? {
                questBadges: chapterQuests,
                onOpenQuest: openQuest,
              }
            : {}),
          ...(continuityFlags.length > 0
            ? {
                continuityFlags,
                hiddenContinuityFlags: Math.max(0, continuityFlags.length - 2),
                onOpenContinuity: openCharacterSheet,
                onMarkItemReturned: markItemReturned,
                returningItemId,
                onSyncMilestoneXp: syncMilestoneXp,
                syncingMilestoneXpId: syncingXpMilestoneId,
              }
            : {}),
        },
      };
    });
  }, [
    nodes,
    characters,
    storySkills,
    storyInventory,
    castStats,
    chapterCastByChapter,
    dropTargetNodeId,
    searchOpen,
    searchMatchIds,
    showChapterNotes,
    notesByChapter,
    openNoteFromGraph,
    inventoryFlagsByChapter,
    progressFlagsByChapter,
    questBadgesByChapter,
    openQuest,
    openCharacterSheet,
    markItemReturned,
    returningItemId,
    syncMilestoneXp,
    syncingXpMilestoneId,
  ]);

  // The chapter a skill was learned in, offered in reading order. Skill cards
  // are the optional other end of the link, so a skill can name the card that
  // grants it.
  const chapterChoices = useMemo(
    () =>
      nodes
        .filter(node => node.data.nodeType === 'chapter')
        .sort(
          (a, b) =>
            (a.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) -
              (b.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) ||
            a.data.label.localeCompare(b.data.label)
        ),
    [nodes]
  );

  // The skills domain names the chapters and the skill cards a skill can point
  // at, so the sheet hands it labelled choices rather than canvas nodes.
  const skillChapterOptions = useMemo(
    () =>
      chapterChoices.map(choice => ({ id: choice.id, label: choice.data.label })),
    [chapterChoices]
  );

  const skillCardOptions = useMemo(
    () =>
      nodes
        .filter(node => node.data.nodeType === 'skill')
        .sort((a, b) => a.data.label.localeCompare(b.data.label))
        .map(node => ({ id: node.id, label: node.data.label })),
    [nodes]
  );

  const itemCardChoices = useMemo(
    () =>
      nodes
        .filter(node => node.data.nodeType === 'item')
        .sort((a, b) => a.data.label.localeCompare(b.data.label)),
    [nodes]
  );

  const factionCardChoices = useMemo(
    () =>
      nodes
        .filter(node => node.data.nodeType === 'faction')
        .sort((a, b) => a.data.label.localeCompare(b.data.label)),
    [nodes]
  );

  // Quest continuity is advisory like the rest: a contract that ends before it
  // began, one still open after its issuer was trashed, or a payout to somebody
  // who is not in the chapter it is paid in. Only recorded links are compared.
  const questContinuity = useMemo(() => {
    const warnings: QuestWarning[] = [];
    const chapterById = new Map(chapterChoices.map(node => [node.id, node]));
    const liveCast = new Set(characters.map(character => character.id));
    const factions = new Set(factionCardChoices.map(node => node.id));
    const castInChapter = new Map<string, Set<string>>();

    // A chapter's linked cast member and point of view count as present even
    // when they were never added to the extra cast list.
    for (const node of chapterNodes) {
      const existing = castInChapter.get(node.id) ?? new Set<string>();

      if (node.data.characterId) existing.add(node.data.characterId);
      if (node.data.chapterPov) existing.add(node.data.chapterPov);

      if (existing.size > 0) castInChapter.set(node.id, existing);
    }

    for (const member of storyChapterCast) {
      const existing = castInChapter.get(member.chapter_id) ?? new Set<string>();
      existing.add(member.character_id);
      castInChapter.set(member.chapter_id, existing);
    }

    for (const quest of storyQuests) {
      const accepted = quest.accepted_chapter_id
        ? chapterById.get(quest.accepted_chapter_id)
        : undefined;
      const completed = quest.completed_chapter_id
        ? chapterById.get(quest.completed_chapter_id)
        : undefined;
      const acceptedSeq = accepted?.data.chapterSeq ?? null;
      const completedSeq = completed?.data.chapterSeq ?? null;

      if (
        accepted &&
        completed &&
        acceptedSeq != null &&
        completedSeq != null &&
        completedSeq < acceptedSeq
      ) {
        warnings.push({
          id: `quest-${quest.id}-ends-before-start`,
          questId: quest.id,
          questTitle: quest.title,
          kind: 'ends-before-start',
          summary: `“${quest.title}” ends before it is accepted`,
          chapterIds: [completed.id, accepted.id],
        });
      }

      if (quest.status.trim().toLowerCase() === 'active') {
        if (quest.giver_character_id && !liveCast.has(quest.giver_character_id)) {
          warnings.push({
            id: `quest-${quest.id}-giver-in-trash`,
            questId: quest.id,
            questTitle: quest.title,
            kind: 'giver-in-trash',
            summary: `“${quest.title}” is still active but its giver is in the trash`,
            chapterIds: accepted ? [accepted.id] : [],
          });
        }

        if (quest.faction_node_id && !factions.has(quest.faction_node_id)) {
          warnings.push({
            id: `quest-${quest.id}-faction-in-trash`,
            questId: quest.id,
            questTitle: quest.title,
            kind: 'faction-in-trash',
            summary: `“${quest.title}” is still active but its faction is in the trash`,
            chapterIds: accepted ? [accepted.id] : [],
          });
        }
      }

      const present = completed ? castInChapter.get(completed.id) : undefined;

      if (!completed || !present || present.size === 0) continue;

      const named = new Set<string>();

      for (const reward of quest.rewards) {
        if (reward.reward_type === 'faction_standing' || !reward.target_id) continue;
        if (present.has(reward.target_id) || named.has(reward.target_id)) continue;

        // A character with no live cast entry cannot be in a chapter either, but
        // that is the trashed-cast story rather than this one.
        if (!liveCast.has(reward.target_id)) continue;

        named.add(reward.target_id);
        const name = castNames.get(reward.target_id) ?? 'A cast member';

        warnings.push({
          id: `quest-${quest.id}-reward-${reward.target_id}`,
          questId: quest.id,
          questTitle: quest.title,
          kind: 'reward-target-absent',
          summary: `“${quest.title}” pays ${name}, who is not in ${completed.data.label}`,
          chapterIds: [completed.id],
        });
      }
    }

    return warnings;
  }, [
    storyQuests,
    chapterNodes,
    chapterChoices,
    characters,
    factionCardChoices,
    storyChapterCast,
    castNames,
  ]);

  // A quest warning joins the same advisory list as the chapter and progression
  // checks. Its chapters are links, so the panel leads to the rows compared.
  const questContinuityLines = useMemo<
    { parts: ContinuityPart[]; flag?: ChapterContinuityFlag }[]
  >(
    () =>
      questContinuity.map(warning => {
        const named = warning.chapterIds
          .map(id => chapterNodes.find(node => node.id === id))
          .filter(
            (node, index, all): node is (typeof chapterNodes)[number] =>
              node != null && all.findIndex(other => other?.id === node.id) === index
          );

        return {
          parts: [
            warning.summary,
            ...(named.length > 0
              ? [
                  ': ',
                  ...named.flatMap((node, index): ContinuityPart[] => [
                    ...(index === 0 ? [] : [', ']),
                    chapterLink(node.id, node.data.label),
                  ]),
                ]
              : []),
            '.',
          ] as ContinuityPart[],
        };
      }),
    [questContinuity, chapterNodes]
  );

  // Everything the Chapters tab's continuity panel lists, in one place.
  const continuityLines = useMemo(
    () => [...chapterContinuity, ...questContinuityLines],
    [chapterContinuity, questContinuityLines]
  );

  // The sheet lists the bonds that touch this character from either side, and
  // the standings recorded for them, from the one story-wide copy.
  const selectedRelations = useMemo(
    () =>
      storyRelations.filter(
        relation =>
          relation.from_character_id === selectedCharacterId ||
          relation.to_character_id === selectedCharacterId
      ),
    [storyRelations, selectedCharacterId]
  );

  const selectedStandings = useMemo(() => {
    const seq = new Map(
      chapterChoices.map(node => [
        node.id,
        node.data.chapterSeq ?? Number.MAX_SAFE_INTEGER,
      ])
    );

    return storyFactionStandings
      .filter(standing => standing.character_id === selectedCharacterId)
      .sort(
        (left, right) =>
          (seq.get(left.since_chapter_id ?? '') ?? Number.MAX_SAFE_INTEGER) -
            (seq.get(right.since_chapter_id ?? '') ?? Number.MAX_SAFE_INTEGER) ||
          left.created_at.localeCompare(right.created_at)
      );
  }, [storyFactionStandings, selectedCharacterId, chapterChoices]);

  const characterNameById = useMemo(
    () => new Map(characters.map(character => [character.id, character.name])),
    [characters]
  );

  const chapterLabelById = useMemo(
    () => new Map(chapterChoices.map(node => [node.id, node.data.label])),
    [chapterChoices]
  );

  const chapterSeqById = useMemo(
    () =>
      new Map(
        chapterNodes.map(node => [
          node.id,
          node.data.chapterSeq ?? Number.MAX_SAFE_INTEGER,
        ])
      ),
    [chapterNodes]
  );

  // A primary-stat line needs a name that either sits on a sheet now or was
  // snapshotted on a milestone before the sheet changed.
  const statNameOptions = useMemo(() => {
    const names = new Set<string>();

    for (const stats of Object.values(castStats)) {
      for (const stat of stats) names.add(stat.stat_name);
    }

    for (const milestone of storyLevelMilestones) {
      for (const change of milestoneStatChanges(milestone)) {
        names.add(change.stat_name);
      }
    }

    return [...names].sort((left, right) => left.localeCompare(right));
  }, [castStats, storyLevelMilestones]);

  useEffect(() => {
    if (chartMetric !== 'stat') return;

    setChartStatName(previous =>
      previous && statNameOptions.includes(previous)
        ? previous
        : statNameOptions[0] ?? ''
    );
  }, [chartMetric, statNameOptions]);

  // One editor for both the new and existing milestone forms. A level-up can
  // carry any number of stat changes, so rows are added and removed here rather
  // than forcing the author to save the same level several times.
  const renderStatChangeRows = (
    drafts: LevelStatChangeDraft[],
    setDrafts: React.Dispatch<React.SetStateAction<LevelStatChangeDraft[]>>,
    prefix: string
  ) => (
    <div className="stat-change-list">
      {drafts.map((draft, index) => (
        <div className="stat-change-row" key={`${prefix}-${index}`}>
          <select
            aria-label={`${prefix} stat ${index + 1} name`}
            title="The stat this level changed"
            value={draft.statName}
            onChange={e =>
              setDrafts(previous =>
                previous.map((entry, at) =>
                  at === index ? { ...entry, statName: e.target.value } : entry
                )
              )
            }
          >
            <option value="">Choose stat</option>
            {draft.statName &&
              !statNameOptions.includes(draft.statName) && (
                <option value={draft.statName}>{draft.statName} (not on sheet)</option>
              )}
            {statNameOptions.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <input
            aria-label={`${prefix} stat ${index + 1} gain`}
            title="How many points this level awarded, such as +2 or -1"
            type="number"
            step={1}
            placeholder="+2"
            value={draft.amount}
            onChange={e =>
              setDrafts(previous =>
                previous.map((entry, at) =>
                  at === index ? { ...entry, amount: e.target.value } : entry
                )
              )
            }
          />
          <input
            aria-label={`${prefix} stat ${index + 1} value after`}
            title="The stat's value once the gain applied; optional"
            type="number"
            step={1}
            placeholder="Now (optional)"
            value={draft.valueAfter}
            onChange={e =>
              setDrafts(previous =>
                previous.map((entry, at) =>
                  at === index ? { ...entry, valueAfter: e.target.value } : entry
                )
              )
            }
          />
          <button
            type="button"
            className="stat-change-remove"
            title="Remove this stat change"
            aria-label={`Remove ${prefix} stat ${index + 1}`}
            onClick={() =>
              setDrafts(previous => previous.filter((_, at) => at !== index))
            }
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="stat-change-add"
        aria-label={`Add ${prefix === 'New milestone' ? 'a new milestone' : 'a milestone'} stat`}
        title="Add another stat this level changed"
        onClick={() => setDrafts(previous => [...previous, blankStatChange()])}
      >
        Add stat
      </button>
    </div>
  );

  // The chart reads the same story-wide milestone rows the continuity checks
  // use. Only chapters that are on the board can place a point, so a milestone
  // whose chapter is in the trash is left out rather than guessed at.
  const chartSeries = useMemo<ProgressionChartSeries[]>(() => {
    const chapterIds = new Set(chapterNodes.map(chapter => chapter.id));

    return characters
      .map((character, index) => ({
        characterId: character.id,
        name: character.name,
        color: PROGRESSION_CHART_COLORS[index % PROGRESSION_CHART_COLORS.length],
        milestones: storyLevelMilestones.filter(
          milestone =>
            milestone.character_id === character.id &&
            milestone.chapter_id !== null &&
            chapterIds.has(milestone.chapter_id)
        ),
        progress: storyCharacterProgress.filter(
          entry =>
            entry.character_id === character.id && chapterIds.has(entry.chapter_id)
        ),
      }))
      .filter(series => series.milestones.length > 0 || series.progress.length > 0);
  }, [characters, storyLevelMilestones, storyCharacterProgress, chapterNodes]);

  const chartMilestoneSeries = useMemo(
    () => chartSeries.filter(series => series.milestones.length > 0),
    [chartSeries]
  );

  // Only a character with a recorded value can have a point in the chosen
  // metric. Level is always present, XP and a stat snapshot are optional, and
  // income comes from its own ledger rather than being inferred from totals.
  const chartMetricSeries = useMemo(() => {
    if (chartMetric === 'level') return chartMilestoneSeries;

    if (chartMetric === 'xp') {
      return chartMilestoneSeries.filter(series =>
        series.milestones.some(milestone => milestone.xp != null)
      );
    }

    if (chartMetric === 'earned') {
      return chartSeries.filter(series => series.progress.length > 0);
    }

    if (!chartStatName) return [];

    return chartMilestoneSeries.filter(series =>
      series.milestones.some(milestone =>
        milestoneStatChanges(milestone).some(
          change => change.stat_name === chartStatName && change.value_after != null
        )
      )
    );
  }, [chartSeries, chartMilestoneSeries, chartMetric, chartStatName]);

  const visibleComparisonSeries = useMemo(
    () =>
      chartMilestoneSeries.filter(
        series => !hiddenChartCharacterIds.includes(series.characterId)
      ),
    [chartMilestoneSeries, hiddenChartCharacterIds]
  );

  const visibleChartSeries = useMemo(
    () =>
      chartMetricSeries.filter(
        series => !hiddenChartCharacterIds.includes(series.characterId)
      ),
    [chartMetricSeries, hiddenChartCharacterIds]
  );

  // The chapter-state request is keyed by ids rather than by the series array.
  // `useMemo` can hand back a fresh array when the board redraws; the ids are what
  // actually change the question being asked of the database. It follows the
  // comparison set, not the metric, so switching to XP does not hide a character
  // from the "as of chapter" readout.
  const visibleChartCharacterIds = visibleComparisonSeries
    .map(series => series.characterId)
    .join('|');

  // A chapter without a reading-order number cannot anchor an "as of" query, so
  // the readout offers only chapters the database can actually place.
  const chartStateChapters = useMemo(
    () => chapterNodes.filter(chapter => chapter.data.chapterSeq != null),
    [chapterNodes]
  );

  const chartStateById = useMemo(
    () => new Map(chartChapterStates.map(state => [state.character_id, state])),
    [chartChapterStates]
  );

  const chartStateChapter =
    chartStateChapters.find(chapter => chapter.id === chartStateChapterId) ?? null;

  useEffect(() => {
    if (selectedTab !== 'characters') return;

    setChartStateChapterId(previous => {
      if (previous && chartStateChapters.some(chapter => chapter.id === previous)) {
        return previous;
      }

      return chartStateChapters[chartStateChapters.length - 1]?.id ?? '';
    });
  }, [selectedTab, chartStateChapters]);

  useEffect(() => {
    if (
      selectedTab !== 'characters' ||
      !currentStory ||
      !chartStateChapterId ||
      !visibleChartCharacterIds
    ) {
      setChartChapterStates(previous => (previous.length === 0 ? previous : []));
      setChartStateLoading(false);
      setChartStateError(null);
      return;
    }

    let cancelled = false;
    setChartStateLoading(true);
    setChartStateError(null);

    Promise.all(
      visibleChartCharacterIds.split('|').map(characterId =>
        progressionApi.getCharacterStateAtChapter(characterId, chartStateChapterId)
      )
    )
      .then(states => {
        if (cancelled) return;
        setChartChapterStates(
          states.filter((state): state is CharacterChapterState => Boolean(state))
        );
      })
      .catch(error => {
        if (cancelled) return;
        setChartChapterStates([]);
        setChartStateError(String(error));
      })
      .finally(() => {
        if (!cancelled) setChartStateLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedTab,
    currentStory,
    chartStateChapterId,
    visibleChartCharacterIds,
    storyLevelMilestones,
    storySkillEvents,
  ]);

  const toggleChartCharacter = (characterId: string) => {
    setHiddenChartCharacterIds(previous =>
      previous.includes(characterId)
        ? previous.filter(id => id !== characterId)
        : [...previous, characterId]
    );
  };

  const selectedCharacter =
    characters.find(character => character.id === selectedCharacterId) ?? null;

  // A chapter without a position sorts after every placed chapter, then by the
  // order it was recorded. The same order is used on the board and the sheet.
  const selectedLevelMilestones = useMemo(
    () =>
      storyLevelMilestones
        .filter(milestone => milestone.character_id === selectedCharacterId)
        .sort(
          (a, b) =>
            (chapterSeqById.get(a.chapter_id ?? '') ?? Number.MAX_SAFE_INTEGER) -
              (chapterSeqById.get(b.chapter_id ?? '') ?? Number.MAX_SAFE_INTEGER) ||
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id)
        ),
    [storyLevelMilestones, selectedCharacterId, chapterSeqById]
  );

  const selectedXpEntries = useMemo(
    () =>
      storyCharacterProgress
        .filter(entry => entry.character_id === selectedCharacterId)
        .sort(
          (a, b) =>
            (chapterSeqById.get(a.chapter_id) ?? Number.MAX_SAFE_INTEGER) -
              (chapterSeqById.get(b.chapter_id) ?? Number.MAX_SAFE_INTEGER) ||
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id)
        ),
    [storyCharacterProgress, selectedCharacterId, chapterSeqById]
  );

  const selectedNode = nodes.find(node => node.id === selectedNodeId) ?? null;
  const skillCardNode =
    selectedNode?.data.nodeType === 'skill' ? selectedNode : null;

  // The holders already attached to the selected card, and the cast members who
  // could still learn it. A person is only offered once: the database also
  // refuses a second skill with the same name, but not showing the option is
  // clearer than an error after the click.
  const skillCardHolders = skillCardNode
    ? storySkills
        .filter(skill => skill.node_id === skillCardNode.id)
        .map(skill => {
          const character = characters.find(entry => entry.id === skill.character_id);
          const chapter = skill.chapter_id
            ? nodes.find(node => node.id === skill.chapter_id) ?? null
            : null;

          return {
            skill,
            characterName: character?.name ?? 'Cast member in the trash',
            chapterLabel: chapter?.data.label ?? null,
          };
        })
        .sort((a, b) => a.characterName.localeCompare(b.characterName))
    : [];

  const skillHolderCandidates = skillCardNode
    ? characters.filter(
        character =>
          !skillCardHolders.some(holder => holder.skill.character_id === character.id)
      )
    : [];

  // A new card starts with an empty holder form, not the previous card's
  // half-filled one.
  useEffect(() => {
    setSkillHolderCharacterId('');
    setSkillHolderRank('');
    setSkillHolderChapterId('');
    setSkillHolderError(null);
  }, [selectedNodeId]);

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
      const updated: Character = await progressionApi.setCharacterProgress(
        selectedCharacter.id,
        level,
        xp,
        progressRankDraft.trim() || null,
        target,
        actor
      );

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
      const updated: Character = await progressionApi.levelUpCharacter(
        selectedCharacter.id,
        actor
      );

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
          charactersApi.getCharacterStats(characterId),
          charactersApi.getCharacterAttributes(characterId),
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
  // The tab's own Search button: the palette opens on everything, with the first
  // result already selected.
  const openSearch = () => {
    setSearchOpen(true);
    setSearchIndex(0);
    setSearchKind('all');
  };

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

        <button
          className="import-button demo-story-button"
          title="Create a prepared story with cast, chapters, milestones and XP income to try the progression tools"
          onClick={loadDemoStory}
          disabled={demoStoryBusy}
        >
          {demoStoryBusy ? 'Building demo…' : 'Load demo story'}
        </button>

        {currentStory?.title === DEMO_STORY_TITLE &&
          (demoResetConfirm ? (
            <>
              <button
                className="import-button demo-reset-button demo-reset-confirm"
                title="Replace this demo's chapters, cast, progression and history with the original sample data"
                onClick={resetDemoStory}
                disabled={demoStoryBusy}
              >
                {demoStoryBusy ? 'Rebuilding demo…' : 'Replace the demo data'}
              </button>
              <button
                className="import-button"
                title="Keep the demo as it is"
                onClick={() => setDemoResetConfirm(false)}
                disabled={demoStoryBusy}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="import-button demo-reset-button"
              title="Replace this demo's edits in place with the original sample data"
              onClick={() => setDemoResetConfirm(true)}
              disabled={demoStoryBusy}
            >
              Reset demo story
            </button>
          ))}

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
              className={selectedTab === 'quests' ? 'active' : ''}
              title="Track quests, contracts and their rewards by chapter"
              onClick={() => requestTab('quests')}
            >
              Quests
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
              title="What the canvas, the skill cards and the history record"
              onClick={() => setGuideOpen(true)}
            >
              Guide
            </button>
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

        {currentStory && !welcomeDismissed && (
          <section className="welcome-card" aria-labelledby="welcome-heading">
            <div className="welcome-head">
              <h2 id="welcome-heading">Start here</h2>
              <button
                type="button"
                className="welcome-close"
                aria-label="Dismiss the welcome card"
                title="Hide this card; the Guide button keeps the rules in reach"
                onClick={dismissWelcome}
              >
                ×
              </button>
            </div>

            <ul className="welcome-list">
              {guideConcepts.map(concept => (
                <li key={concept.title}>
                  <strong>{concept.title}.</strong> {concept.short}
                </li>
              ))}
            </ul>

            <div className="welcome-actions">
              <button
                type="button"
                title="Read the three rules in full, with the keyboard routes one click away"
                onClick={() => setGuideOpen(true)}
              >
                Open the guide
              </button>
              <button
                type="button"
                title="Put this card away for good"
                onClick={dismissWelcome}
              >
                Got it
              </button>
            </div>
          </section>
        )}

        {actionError && (
          <div className="error-strip">
            <span>{actionError}</span>
            <button title="Hide this message" onClick={() => setActionError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {returnedNotice && (
          <div className="status-strip returned-strip" role="status">
            <span>Marked “{returnedNotice.itemName}” returned.</span>
            <button
              className="status-undo"
              title={`Put the lost chapter back for “${returnedNotice.itemName}”`}
              aria-label={`Undo marking ${returnedNotice.itemName} returned`}
              onClick={() => void undoLast()}
            >
              Undo
            </button>
            <button
              className="status-dismiss"
              title="Keep the item returned"
              onClick={() => setReturnedNotice(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {syncedXpNotice && (
          <div className="status-strip returned-strip" role="status">
            <span>
              Synced {syncedXpNotice.characterName}'s total to{' '}
              {formatCount(syncedXpNotice.xp)} XP.
            </span>
            <button
              className="status-undo"
              title={`Put ${syncedXpNotice.characterName}'s recorded total back`}
              aria-label={`Undo syncing ${syncedXpNotice.characterName}'s total XP`}
              onClick={() => void undoLast()}
            >
              Undo
            </button>
            <button
              className="status-dismiss"
              title="Keep the synced total"
              onClick={() => setSyncedXpNotice(null)}
            >
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
                    onKeyDown={(e) => e.key === 'Enter' && openCanvasCreate()}
                  />
                  <button
                    title="Add a node of the selected type to the canvas"
                    onClick={() => openCanvasCreate()}
                    disabled={
                      !newNodeLabel.trim() && !isCanvasCreateKind(newNodeType)
                    }
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
                  <button
                    className={`notes-toggle${showChapterNotes ? ' active' : ''}`}
                    aria-pressed={showChapterNotes}
                    title={
                      showChapterNotes
                        ? 'Hide the chapter notes pinned under their chapters'
                        : 'Show each chapter’s notes pinned under it'
                    }
                    onClick={() => setShowChapterNotes(shown => !shown)}
                  >
                    {showChapterNotes ? 'Hide notes' : 'Show notes'}
                  </button>
                  <span className="hint">Drag nodes • Connect nodes by dragging from a handle</span>
                  <HelpTip label="drawing connections">
                    Drag from a card’s dot onto another card to draw a connection.
                    Let go over empty canvas and a new card is created there, already
                    filled in from the card you dragged from: a skill takes that
                    character as its owner, a quest takes them as its giver. Character
                    to character opens the bond form; character to chapter puts them in
                    that chapter’s cast.
                  </HelpTip>
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
                    onConnectStart={onConnectStart}
                    onConnectEnd={onConnectEnd}
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
                            list="edge-relation-types"
                            value={edgeRelationDraft}
                            onChange={e => setEdgeRelationDraft(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveEdge();
                              if (e.key === 'Escape') setSelectedEdgeId(null);
                            }}
                          />
                          <datalist id="edge-relation-types">
                            {relationTypes.map(type => (
                              <option key={type} value={type} />
                            ))}
                          </datalist>
                          <div className="node-editor-help">
                            <HelpTip label="connection relation types">
                              The relation type is the verb the line carries: unlocks,
                              requires, rewards, or a word of your own. When this
                              connection draws a bond between two characters, changing
                              the type here changes the bond on both sheets. A line
                              that draws a bond always keeps a type, so clearing it is
                              refused rather than quietly unlinking the relation.
                            </HelpTip>
                            <span>
                              The type is the line’s verb; a hand-written label is
                              kept.
                            </span>
                          </div>
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

                      {skillCardNode && (
                        <section
                          className="node-drawer-skill-holders"
                          aria-label="Skill holders"
                        >
                          <div className="node-drawer-section">
                            Holders
                            <span className="node-drawer-note">
                              {skillCardHolders.length === 0
                                ? 'nobody yet'
                                : `${skillCardHolders.length} ${
                                    skillCardHolders.length === 1
                                      ? 'character'
                                      : 'characters'
                                  }`}
                            </span>
                          </div>

                          {skillCardHolders.length === 0 ? (
                            <p className="node-drawer-hint">
                              No one has this skill yet. Add a holder to copy the card's
                              name and notes onto their sheet.
                            </p>
                          ) : (
                            <ul className="node-drawer-holder-list">
                              {skillCardHolders.map(holder => (
                                <li
                                  className="node-drawer-holder"
                                  key={holder.skill.id}
                                  title={[
                                    holder.characterName,
                                    holder.skill.rank,
                                    holder.chapterLabel
                                      ? `learned in ${holder.chapterLabel}`
                                      : null,
                                    holder.skill.effect,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                >
                                  <span className="node-drawer-holder-name">
                                    {holder.characterName}
                                  </span>
                                  {holder.skill.rank && (
                                    <span className="node-drawer-holder-rank">
                                      {holder.skill.rank}
                                    </span>
                                  )}
                                  <span className="node-drawer-holder-chapter">
                                    {holder.chapterLabel ?? 'No chapter'}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}

                          <p className="node-drawer-hint">
                            The name and notes come from this card; rank and chapter
                            belong to the holder.
                          </p>

                          {nodeIsDirty && (
                            <p className="node-drawer-hint">
                              Save the card's label and notes before adding a holder.
                            </p>
                          )}

                          <label
                            className="node-drawer-label"
                            htmlFor="skill-holder-character"
                          >
                            Character
                          </label>
                          <select
                            id="skill-holder-character"
                            className="node-drawer-select"
                            title="The character who learns this skill"
                            value={skillHolderCharacterId}
                            onChange={event => {
                              setSkillHolderCharacterId(event.target.value);
                              setSkillHolderError(null);
                            }}
                          >
                            <option value="">Choose a character</option>
                            {skillHolderCandidates.map(character => (
                              <option key={character.id} value={character.id}>
                                {character.name}
                              </option>
                            ))}
                          </select>

                          {characters.length === 0 && (
                            <p className="node-drawer-hint">
                              Add a character first — a skill needs someone to hold it.
                            </p>
                          )}

                          {characters.length > 0 && skillHolderCandidates.length === 0 && (
                            <p className="node-drawer-hint">
                              Everyone in the cast already holds this card.
                            </p>
                          )}

                          <label
                            className="node-drawer-label"
                            htmlFor="skill-holder-rank"
                          >
                            Rank
                          </label>
                          <input
                            id="skill-holder-rank"
                            className="node-drawer-input"
                            placeholder="Optional"
                            title="This holder's rank, in the author's own words"
                            value={skillHolderRank}
                            onChange={event => setSkillHolderRank(event.target.value)}
                            onKeyDown={event => {
                              if (event.key === 'Enter') void addSkillHolder();
                            }}
                          />

                          <label
                            className="node-drawer-label"
                            htmlFor="skill-holder-chapter"
                          >
                            Learned in
                          </label>
                          <select
                            id="skill-holder-chapter"
                            className="node-drawer-select"
                            title="The chapter this holder learned the skill in"
                            value={skillHolderChapterId}
                            onChange={event => setSkillHolderChapterId(event.target.value)}
                          >
                            <option value="">No chapter</option>
                            {chapterChoices.map(choice => (
                              <option key={choice.id} value={choice.id}>
                                {choice.data.label}
                              </option>
                            ))}
                          </select>

                          {skillHolderError && (
                            <div className="node-editor-error">{skillHolderError}</div>
                          )}

                          <button
                            type="button"
                            className="node-drawer-add-holder"
                            title="Create this skill on the chosen character's sheet, linked to this card"
                            onClick={() => void addSkillHolder()}
                            disabled={
                              savingSkillHolder ||
                              !skillHolderCharacterId ||
                              nodeIsDirty ||
                              !skillCardNode.data.label.trim()
                            }
                          >
                            {savingSkillHolder ? 'Adding…' : 'Add holder'}
                          </button>
                        </section>
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
            <ChaptersPanel
              story={currentStory}
              renderSearchPalette={renderSearchPalette}
              searchShortcut={shortcutKeys.search}
              openSearch={openSearch}
              chapterNodes={chapterNodes}
              chapterIssues={chapterIssues}
              chapterTotals={chapterTotals}
              chapterWordsPercent={chapterWordsPercent}
              chapterTimeline={chapterTimeline}
              chapterError={chapterError}
              chapterBusy={chapterBusy}
              newChapterTitle={newChapterTitle}
              setNewChapterTitle={setNewChapterTitle}
              addChapter={addChapter}
              saveChapterOrder={saveChapterOrder}
              revealedChapterId={revealedChapterId}
              characters={characters}
              castNames={castNames}
              chapterCastByChapter={chapterCastByChapter}
              chapterCastIsExplicit={chapterCastIsExplicit}
              setChapterCastPresence={setChapterCastPresence}
              chapterCastBusyId={chapterCastBusyId}
              chapterCastError={chapterCastError}
              openChapterCastId={openChapterCastId}
              toggleChapterCastPanel={toggleChapterCastPanel}
              editingChapterId={editingChapterId}
              openChapterDetails={openChapterDetails}
              chapterArcInputRef={chapterArcInputRef}
              chapterArcDraft={chapterArcDraft}
              setChapterArcDraft={setChapterArcDraft}
              chapterWordsDraft={chapterWordsDraft}
              setChapterWordsDraft={setChapterWordsDraft}
              chapterTargetDraft={chapterTargetDraft}
              setChapterTargetDraft={setChapterTargetDraft}
              chapterPovDraft={chapterPovDraft}
              setChapterPovDraft={setChapterPovDraft}
              chapterDayDraft={chapterDayDraft}
              setChapterDayDraft={setChapterDayDraft}
              chapterTimeDraft={chapterTimeDraft}
              setChapterTimeDraft={setChapterTimeDraft}
              saveChapterDetails={saveChapterDetails}
              requestChapterClose={requestChapterClose}
              chapterFormPrompt={chapterFormPrompt}
              dismissChapterPrompt={dismissChapterPrompt}
              discardChapterEdit={discardChapterEdit}
              closeChapterForm={closeChapterForm}
              leaveChapterForm={leaveChapterForm}
              chapterKeepEditingRef={chapterKeepEditingRef}
              notesByChapter={notesByChapter}
              noteCount={noteCount}
              openNotesChapterId={openNotesChapterId}
              toggleChapterNotes={toggleChapterNotes}
              notePrompt={notePrompt}
              dismissNotePrompt={dismissNotePrompt}
              discardNoteDraft={discardNoteDraft}
              noteKeepEditingRef={noteKeepEditingRef}
              noteEditorRef={noteEditorRef}
              noteAddRef={noteAddRef}
              editingNoteId={editingNoteId}
              matchedNoteId={matchedNoteId}
              noteEditDraft={noteEditDraft}
              setNoteEditDraft={setNoteEditDraft}
              noteDraft={noteDraft}
              setNoteDraft={setNoteDraft}
              noteBusy={noteBusy}
              noteError={noteError}
              startNoteEdit={startNoteEdit}
              requestNoteEditCancel={requestNoteEditCancel}
              saveNoteEdit={saveNoteEdit}
              deleteNote={deleteNote}
              addNote={addNote}
              continuityLines={continuityLines}
              openCharacterSheet={openCharacterSheet}
              revealChapter={revealChapter}
              syncingXpMilestoneId={syncingXpMilestoneId}
              syncMilestoneXp={syncMilestoneXp}
            />
          </div>
        )}

        {selectedTab === 'characters' && characterView === 'relations' && (
          <div className="tab-content">
            <CharacterViewToggle view="relations" onChange={setCharacterView} />
            {!currentStory ? (
              <div className="empty-state">Load a story to map its cast</div>
            ) : (
              <RelationsMap
                characters={characters}
                relations={storyRelations}
                standings={storyFactionStandings}
                factions={factionCardChoices.map(node => ({
                  id: node.id,
                  label: node.data.label,
                }))}
                onOpenRelation={relation =>
                  openCharacterSheet(relation.from_character_id, {
                    kind: 'relation',
                    relationId: relation.id,
                  })
                }
                onOpenStanding={standing =>
                  openCharacterSheet(standing.character_id, {
                    kind: 'faction-standing',
                    standingId: standing.id,
                  })
                }
              />
            )}
          </div>
        )}

        {selectedTab === 'characters' && characterView === 'skills' && (
          <div className="tab-content">
            <CharacterViewToggle view="skills" onChange={setCharacterView} />
            {!currentStory ? (
              <div className="empty-state">Load a story to see how its skills evolved</div>
            ) : (
              <SkillTreeView
                skills={storySkills}
                characters={characters}
                evolutions={storySkillEvolutions}
                chapters={chapterChoices.map(node => ({
                  id: node.id,
                  label: node.data.label,
                }))}
                error={skillEvolutionError}
                onCreate={addSkillEvolutionLink}
                onDelete={removeSkillEvolutionLink}
                onOpenSkill={skill =>
                  openCharacterSheet(skill.character_id, {
                    kind: 'skill',
                    skillId: skill.id,
                  })
                }
              />
            )}
          </div>
        )}

        {selectedTab === 'characters' && characterView === 'sheet' && (
          <div className="tab-content">
            <CharacterViewToggle view="sheet" onChange={setCharacterView} />
            {!currentStory ? (
              <div className="empty-state">Load a story to manage characters</div>
            ) : (
              <>
                <section className="progression-chart-panel" aria-label="Progression chart">
                  <div className="progression-chart-head">
                    <div>
                      <h3 className="progression-chart-title">Power curve</h3>
                      <div className="progression-chart-caption">
                        {chartMetric === 'level'
                          ? 'Level milestones by chapter in reading order.'
                          : chartMetric === 'xp'
                            ? 'Total XP recorded at each level milestone by chapter.'
                            : chartMetric === 'earned'
                              ? 'XP earned in each chapter, shown as one bar per character.'
                              : chartStatName
                                ? `${chartStatName} snapshots recorded at each level milestone.`
                                : 'Choose a numeric stat to plot.'}
                      </div>
                    </div>

                    {chartMetricSeries.length > 0 && (
                      <div
                        className="progression-legend"
                        role="group"
                        aria-label="Compare characters"
                      >
                        {chartMetricSeries.map(series => {
                          const shown = !hiddenChartCharacterIds.includes(
                            series.characterId
                          );

                          return (
                            <button
                              key={series.characterId}
                              className={`progression-legend-button ${
                                shown ? 'active' : ''
                              }`}
                              aria-pressed={shown}
                              title={`${shown ? 'Hide' : 'Show'} ${series.name}'s ${
                                chartMetric === 'earned' ? 'XP bars' : 'line'
                              }`}
                              onClick={() => toggleChartCharacter(series.characterId)}
                            >
                              <span
                                className="progression-legend-swatch"
                                style={{ backgroundColor: series.color }}
                                aria-hidden="true"
                              />
                              {series.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="progression-chart-controls">
                    <span className="progression-chart-controls-label">Y-axis</span>
                    <div
                      className="progression-metric-toggle"
                      role="group"
                      aria-label="Chart metric"
                    >
                      {(
                        [
                          ['level', 'Level'],
                          ['xp', 'Total XP'],
                          ['earned', 'XP earned'],
                          ['stat', 'Stats'],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          className={`progression-metric-button ${
                            chartMetric === value ? 'active' : ''
                          }`}
                          aria-pressed={chartMetric === value}
                          onClick={() => setChartMetric(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {chartMetric === 'stat' &&
                      (statNameOptions.length > 0 ? (
                        <label className="progression-stat-picker">
                          <span>Stat</span>
                          <select
                            aria-label="Stat to plot"
                            value={chartStatName}
                            onChange={e => setChartStatName(e.target.value)}
                          >
                            {statNameOptions.map(name => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <span className="progression-chart-controls-note">
                          No numeric stats yet.
                        </span>
                      ))}
                  </div>

                  {chapterNodes.length === 0 ? (
                    <div className="empty">
                      Add a chapter before plotting a power curve.
                    </div>
                  ) : chartSeries.length === 0 ? (
                    <div className="empty">
                      No progression recorded yet — add a level milestone or XP earned on a
                      character's sheet.
                    </div>
                  ) : chartMetricSeries.length === 0 ? (
                    <div className="empty">
                      {chartMetric === 'level'
                        ? 'No level milestones yet — record one on a character\'s sheet.'
                        : chartMetric === 'xp'
                          ? 'No XP recorded on a level milestone yet — add total XP on a character\'s sheet.'
                          : chartMetric === 'earned'
                            ? 'No XP earned by chapter yet — record it on a character\'s sheet.'
                            : chartStatName
                              ? `No ${chartStatName} snapshots yet — record one on a level milestone.`
                              : 'No numeric stats yet — add a stat on a character\'s sheet first.'}
                    </div>
                  ) : visibleChartSeries.length === 0 ? (
                    <div className="empty">
                      {chartMetric === 'level'
                        ? 'Choose a character above to show a level line.'
                        : chartMetric === 'earned'
                          ? 'Choose a character above to show its XP bars.'
                          : 'Choose a character above to show a line.'}
                    </div>
                  ) : (
                    <ProgressionChart
                      chapters={chapterNodes}
                      series={visibleChartSeries}
                      metric={chartMetric}
                      statName={chartStatName}
                    />
                  )}

                  {chartMilestoneSeries.length > 0 && chartStateChapters.length > 0 && (
                    <div className="progression-chapter-state">
                      <label className="progression-state-picker">
                        <span>As of chapter</span>
                        <select
                          aria-label="Chapter state"
                          title="Read each selected character's level and skills at this chapter"
                          value={chartStateChapterId}
                          onChange={(e) => setChartStateChapterId(e.target.value)}
                        >
                          {chartStateChapters.map(chapter => (
                            <option key={chapter.id} value={chapter.id}>
                              {`Ch. ${chapter.data.chapterSeq} — ${chapter.data.label}`}
                            </option>
                          ))}
                        </select>
                      </label>

                      {visibleComparisonSeries.length === 0 ? (
                        <div className="progression-state-note">
                          Choose a character to read a chapter state.
                        </div>
                      ) : chartStateLoading ? (
                        <div className="progression-state-note" role="status">
                          Reading chapter state…
                        </div>
                      ) : chartStateError ? (
                        <div className="audit-error">
                          Could not read chapter state: {chartStateError}
                        </div>
                      ) : (
                        <ul
                          className="progression-state-list"
                          aria-label={`Character state at ${
                            chartStateChapter?.data.label ?? 'chapter'
                          }`}
                        >
                          {visibleComparisonSeries.map(series => {
                            const state = chartStateById.get(series.characterId);
                            const skills = state?.skills ?? [];

                            return (
                              <li
                                key={series.characterId}
                                data-state-character={series.characterId}
                              >
                                <span
                                  className="progression-legend-swatch"
                                  style={{ backgroundColor: series.color }}
                                  aria-hidden="true"
                                />
                                <span className="progression-state-name">
                                  {series.name}
                                </span>
                                <span className="progression-state-level">
                                  {state?.level != null
                                    ? `Level ${state.level}${
                                        state.level_is_penalty ? ' (penalty)' : ''
                                      }`
                                    : 'No level recorded'}
                                </span>
                                <span className="progression-state-skills">
                                  {skills.length === 0
                                    ? 'No active skills'
                                    : skills
                                        .map(skill =>
                                          skill.rank
                                            ? `${skill.name} (${skill.rank})`
                                            : skill.name
                                        )
                                        .join(' · ')}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </section>

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

                      {/* A milestone is where a level was reached, not the level
                          the sheet shows now. It is what continuity compares in
                          reading order, and a deliberate drop can say so. */}
                      <section className="level-section" aria-label="Level milestones">
                        <h4 className="character-section-heading">Level milestones</h4>

                        <div className="level-list">
                          {selectedLevelMilestones.length === 0 && (
                            <div className="empty">
                              No level milestones yet — record where a level was reached.
                            </div>
                          )}

                          {selectedLevelMilestones.map(milestone => {
                            const chapter = chapterChoices.find(
                              choice => choice.id === milestone.chapter_id
                            );
                            const focused =
                              focusedProgression?.kind === 'level' &&
                              focusedProgression.id === milestone.id;

                            return (
                              <div
                                key={milestone.id}
                                className={`level-row${focused ? ' progression-row-focused' : ''}`}
                                data-progression={`level-${milestone.id}`}
                              >
                                {editingLevelMilestoneId === milestone.id ? (
                                  <div className="level-editor">
                                    <input
                                      aria-label="Milestone level"
                                      type="number"
                                      min={1}
                                      step={1}
                                      autoFocus
                                      value={levelMilestoneLevelDraft}
                                      onChange={(e) => setLevelMilestoneLevelDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') saveLevelMilestone(milestone);
                                        if (e.key === 'Escape') setEditingLevelMilestoneId(null);
                                      }}
                                    />
                                    <select
                                      aria-label="Milestone chapter"
                                      title="The chapter where this level was reached"
                                      value={levelMilestoneChapterDraft}
                                      onChange={(e) => setLevelMilestoneChapterDraft(e.target.value)}
                                    >
                                      <option value="">No chapter</option>
                                      {levelMilestoneChapterDraft &&
                                        !chapterChoices.some(
                                          choice => choice.id === levelMilestoneChapterDraft
                                        ) && (
                                          <option value={levelMilestoneChapterDraft}>
                                            Chapter in the trash
                                          </option>
                                        )}
                                      {chapterChoices.map(choice => (
                                        <option key={choice.id} value={choice.id}>
                                          {choice.data.label}
                                        </option>
                                      ))}
                                    </select>
                                    <label className="level-penalty-field">
                                      <input
                                        aria-label="Level drop is a penalty"
                                        type="checkbox"
                                        checked={levelMilestoneDebuffDraft}
                                        onChange={(e) => setLevelMilestoneDebuffDraft(e.target.checked)}
                                      />
                                      Penalty
                                    </label>
                                    <label className="level-metric-field">
                                      Total XP
                                      <input
                                        aria-label="Milestone total XP"
                                        type="number"
                                        min={0}
                                        step={1}
                                        placeholder="Optional"
                                        value={levelMilestoneXpDraft}
                                        onChange={e => setLevelMilestoneXpDraft(e.target.value)}
                                      />
                                    </label>
                                    {renderStatChangeRows(
                                      levelMilestoneStatChangesDraft,
                                      setLevelMilestoneStatChangesDraft,
                                      'Milestone'
                                    )}
                                    <div className="level-actions">
                                      <button
                                        title={`Save this level ${milestone.level} milestone`}
                                        onClick={() => saveLevelMilestone(milestone)}
                                      >
                                        Save milestone
                                      </button>
                                      <button
                                        title="Leave the milestone as it was"
                                        onClick={() => setEditingLevelMilestoneId(null)}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <div className="level-summary">
                                      <span className="level-value">Level {milestone.level}</span>
                                      <span className="level-chapter">
                                        {chapter
                                          ? `Reached in ${chapter.data.label}`
                                          : milestone.chapter_id
                                            ? 'Chapter in the trash'
                                            : 'No chapter recorded'}
                                      </span>
                                      {milestone.is_debuff && (
                                        <span className="level-penalty">Penalty</span>
                                      )}
                                      {milestone.xp != null && (
                                        <span className="level-xp">XP {milestone.xp}</span>
                                      )}
                                      {milestoneStatChanges(milestone).map(change => (
                                        <span className="level-stat" key={change.id}>
                                          {statChangeText(change)}
                                        </span>
                                      ))}
                                      {storySkillEvents
                                        .filter(event => event.milestone_id === milestone.id)
                                        .map(event => {
                                          const skill = storySkills.find(
                                            entry => entry.id === event.skill_id
                                          );

                                          return (
                                            <span
                                              className="level-stat level-skill-change"
                                              key={event.id}
                                            >
                                              {skill?.name ?? 'Skill'} · {event.kind}
                                              {event.rank ? ` ${event.rank}` : ''}
                                            </span>
                                          );
                                        })}
                                    </div>
                                    <button
                                      title={`Change the level and chapter of the level ${milestone.level} milestone`}
                                      onClick={() => startLevelMilestoneEdit(milestone)}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      title={`Delete the level ${milestone.level} milestone`}
                                      onClick={() => removeLevelMilestone(milestone)}
                                    >
                                      Delete
                                    </button>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div className="level-creator">
                          <input
                            aria-label="New milestone level"
                            type="number"
                            min={1}
                            step={1}
                            value={newLevelMilestoneLevel}
                            onChange={(e) => setNewLevelMilestoneLevel(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addLevelMilestone()}
                          />
                          <select
                            aria-label="New milestone chapter"
                            title="The chapter where this level was reached"
                            value={newLevelMilestoneChapter}
                            onChange={(e) => setNewLevelMilestoneChapter(e.target.value)}
                          >
                            <option value="">No chapter</option>
                            {chapterChoices.map(choice => (
                              <option key={choice.id} value={choice.id}>
                                {choice.data.label}
                              </option>
                            ))}
                          </select>
                          <label className="level-penalty-field">
                            <input
                              aria-label="New milestone is a penalty"
                              type="checkbox"
                              checked={newLevelMilestoneDebuff}
                              onChange={(e) => setNewLevelMilestoneDebuff(e.target.checked)}
                            />
                            Penalty
                          </label>
                          <label className="level-metric-field">
                            Total XP
                            <input
                              aria-label="New milestone total XP"
                              type="number"
                              min={0}
                              step={1}
                              placeholder="Optional"
                              value={newLevelMilestoneXp}
                              onChange={e => setNewLevelMilestoneXp(e.target.value)}
                            />
                          </label>
                          {renderStatChangeRows(
                            newLevelMilestoneStatChanges,
                            setNewLevelMilestoneStatChanges,
                            'New milestone'
                          )}
                          <button
                            title="Record this level in the selected character's timeline"
                            onClick={addLevelMilestone}
                          >
                            Add milestone
                          </button>
                        </div>
                      </section>

                      {/* Income is what a chapter paid out, kept separate from the
                          running total on a milestone so the chart can show either. */}
                      <section className="xp-ledger-section" aria-label="XP by chapter">
                        <h4 className="character-section-heading">XP by chapter</h4>

                        <div className="xp-ledger-list">
                          {selectedXpEntries.length === 0 && (
                            <div className="empty">
                              No XP earned by chapter yet — record what a chapter paid out.
                            </div>
                          )}

                          {selectedXpEntries.map(entry => {
                            const chapter = chapterChoices.find(
                              choice => choice.id === entry.chapter_id
                            );
                            const chapterLabel = chapter
                              ? chapter.data.label
                              : 'Chapter in the trash';

                            return (
                              <div
                                key={entry.id}
                                className="xp-ledger-row"
                                data-xp-entry={entry.id}
                              >
                                {editingXpEntryId === entry.id ? (
                                  <div className="level-editor">
                                    <select
                                      aria-label="XP entry chapter"
                                      value={xpEntryChapterDraft}
                                      onChange={e =>
                                        setXpEntryChapterDraft(e.target.value)
                                      }
                                    >
                                      <option value="">Choose chapter</option>
                                      {xpEntryChapterDraft &&
                                        !chapterChoices.some(
                                          choice => choice.id === xpEntryChapterDraft
                                        ) && (
                                          <option value={xpEntryChapterDraft}>
                                            Chapter in the trash
                                          </option>
                                        )}
                                      {chapterChoices.map(choice => (
                                        <option key={choice.id} value={choice.id}>
                                          {choice.data.label}
                                        </option>
                                      ))}
                                    </select>
                                    <label className="level-metric-field">
                                      XP earned
                                      <input
                                        aria-label="XP entry earned XP"
                                        type="number"
                                        min={0}
                                        step={1}
                                        value={xpEntryXpDraft}
                                        onChange={e => setXpEntryXpDraft(e.target.value)}
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') saveXpEntry(entry);
                                          if (e.key === 'Escape')
                                            setEditingXpEntryId(null);
                                        }}
                                      />
                                    </label>
                                    <div className="level-actions">
                                      <button
                                        title={`Save the XP earned in ${chapterLabel}`}
                                        onClick={() => saveXpEntry(entry)}
                                      >
                                        Save XP
                                      </button>
                                      <button
                                        title="Leave the XP entry as it was"
                                        onClick={() => setEditingXpEntryId(null)}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <div className="xp-ledger-summary">
                                      <span className="xp-ledger-chapter">
                                        {chapterLabel}
                                      </span>
                                      <span className="level-xp">
                                        {entry.xp_earned} XP earned
                                      </span>
                                    </div>
                                    <button
                                      title={`Change the XP earned in ${chapterLabel}`}
                                      onClick={() => startXpEntryEdit(entry)}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      title={`Delete the XP earned in ${chapterLabel}`}
                                      onClick={() => removeXpEntry(entry)}
                                    >
                                      Delete
                                    </button>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div className="level-creator xp-ledger-creator">
                          <select
                            aria-label="New XP entry chapter"
                            value={newXpEntryChapter}
                            onChange={e => setNewXpEntryChapter(e.target.value)}
                          >
                            <option value="">Choose chapter</option>
                            {chapterChoices.map(choice => (
                              <option key={choice.id} value={choice.id}>
                                {choice.data.label}
                              </option>
                            ))}
                          </select>
                          <label className="level-metric-field">
                            XP earned
                            <input
                              aria-label="New XP entry earned XP"
                              type="number"
                              min={0}
                              step={1}
                              value={newXpEntryXp}
                              onChange={e => setNewXpEntryXp(e.target.value)}
                              onKeyDown={e => e.key === 'Enter' && addXpEntry()}
                            />
                          </label>
                          <button
                            title="Record the XP this chapter paid out"
                            onClick={addXpEntry}
                          >
                            Add XP
                          </button>
                        </div>
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

                      {/* Skills are rows of their own: a rank and an effect are
                          the author's words, and the chapter is where it was
                          learned. A skill card can name its holders too. */}
                      {/* The skill rows, their events and the creator form
                          live in the skills domain; the writes they ask for
                          stay here, where the canvas, the card and the audit
                          log are. */}
                      <SkillsSection
                        skills={characterSkills}
                        storySkills={storySkills}
                        events={storySkillEvents}
                        evolutions={storySkillEvolutions}
                        chapters={skillChapterOptions}
                        cards={skillCardOptions}
                        milestones={selectedLevelMilestones}
                        chapterSeqById={chapterSeqById}
                        focus={focusedProgression}
                        onError={setCharacterError}
                        onCreate={addSkill}
                        onSave={saveSkill}
                        onDelete={removeSkill}
                        onSaveEvent={saveSkillEvent}
                        onDeleteEvent={removeSkillEvent}
                      />

                      {/* Inventory is a ledger, not a game engine: a name, a
                          rarity, how many, what it does and where it was found. */}
                      <div className="inventory-section">
                        <h4 className="character-section-heading">Inventory</h4>

                        <div className="inventory-list">
                          {characterInventory.length === 0 && (
                            <div className="empty">
                              No items yet — add one below.
                            </div>
                          )}

                          {characterInventory.map(item => {
                            const chapter = chapterChoices.find(
                              choice => choice.id === item.chapter_id
                            );
                            const card = itemCardChoices.find(
                              choice => choice.id === item.node_id
                            );
                            const lostChapter = chapterChoices.find(
                              choice => choice.id === item.lost_chapter_id
                            );

                            return (
                              <div key={item.id} className="inventory-row">
                                {editingItemId === item.id ? (
                                  <div className="inventory-editor">
                                    <input
                                      aria-label="Item name"
                                      autoFocus
                                      value={itemNameDraft}
                                      onChange={(e) => setItemNameDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') saveItem(item);
                                        if (e.key === 'Escape') setEditingItemId(null);
                                      }}
                                    />
                                    <input
                                      aria-label="Item rarity"
                                      placeholder="Rarity (optional)"
                                      value={itemRarityDraft}
                                      onChange={(e) => setItemRarityDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') saveItem(item);
                                        if (e.key === 'Escape') setEditingItemId(null);
                                      }}
                                    />
                                    <input
                                      aria-label="Item quantity"
                                      type="number"
                                      min={0}
                                      step={1}
                                      title="How many of this item the character carries"
                                      value={itemQuantityDraft}
                                      onChange={(e) => setItemQuantityDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') saveItem(item);
                                        if (e.key === 'Escape') setEditingItemId(null);
                                      }}
                                    />
                                    <input
                                      aria-label="Item effect"
                                      placeholder="Effect (optional)"
                                      value={itemEffectDraft}
                                      onChange={(e) => setItemEffectDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') saveItem(item);
                                        if (e.key === 'Escape') setEditingItemId(null);
                                      }}
                                    />
                                    <select
                                      aria-label="Item chapter acquired"
                                      title="The chapter this item was acquired in"
                                      value={itemChapterDraft}
                                      onChange={(e) => setItemChapterDraft(e.target.value)}
                                    >
                                      <option value="">No chapter</option>
                                      {itemChapterDraft &&
                                        !chapterChoices.some(
                                          choice => choice.id === itemChapterDraft
                                        ) && (
                                          <option value={itemChapterDraft}>
                                            Chapter in the trash
                                          </option>
                                        )}
                                      {chapterChoices.map(choice => (
                                        <option key={choice.id} value={choice.id}>
                                          {choice.data.label}
                                        </option>
                                      ))}
                                    </select>
                                    <select
                                      aria-label="Item chapter lost"
                                      title="The chapter this item was lost in"
                                      value={itemLostChapterDraft}
                                      onChange={(e) => setItemLostChapterDraft(e.target.value)}
                                    >
                                      <option value="">Not lost</option>
                                      {itemLostChapterDraft &&
                                        !chapterChoices.some(
                                          choice => choice.id === itemLostChapterDraft
                                        ) && (
                                          <option value={itemLostChapterDraft}>
                                            Chapter in the trash
                                          </option>
                                        )}
                                      {chapterChoices.map(choice => (
                                        <option key={choice.id} value={choice.id}>
                                          {choice.data.label}
                                        </option>
                                      ))}
                                    </select>
                                    <select
                                      aria-label="Item card"
                                      title="The item card this row belongs to"
                                      value={itemNodeDraft}
                                      onChange={(e) => setItemNodeDraft(e.target.value)}
                                    >
                                      <option value="">No card</option>
                                      {itemNodeDraft &&
                                        !itemCardChoices.some(
                                          choice => choice.id === itemNodeDraft
                                        ) && (
                                          <option value={itemNodeDraft}>
                                            Card in the trash
                                          </option>
                                        )}
                                      {itemCardChoices.map(choice => (
                                        <option key={choice.id} value={choice.id}>
                                          {choice.data.label}
                                        </option>
                                      ))}
                                    </select>
                                    <div className="inventory-actions">
                                      <button
                                        title={`Save this ${item.name}`}
                                        onClick={() => saveItem(item)}
                                      >
                                        Save item
                                      </button>
                                      <button
                                        title="Leave the item as it was"
                                        onClick={() => setEditingItemId(null)}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <div className="inventory-summary">
                                      <span className="inventory-name">{item.name}</span>
                                      <span className="inventory-quantity">
                                        ×{formatCount(item.quantity)}
                                      </span>
                                      {item.rarity && (
                                        <span className="inventory-rarity">{item.rarity}</span>
                                      )}
                                      {item.effect && (
                                        <span className="inventory-effect">{item.effect}</span>
                                      )}
                                      <span className="inventory-chapter">
                                        {chapter
                                          ? `Found in ${chapter.data.label}`
                                          : item.chapter_id
                                            ? 'Chapter in the trash'
                                            : 'Chapter not recorded'}
                                      </span>
                                      {item.lost_chapter_id && (
                                        <span className="inventory-lost">
                                          {lostChapter
                                            ? `Lost in ${lostChapter.data.label}`
                                            : 'Lost in a chapter in the trash'}
                                        </span>
                                      )}
                                      {card && (
                                        <span className="inventory-card-link">
                                          Card: {card.data.label}
                                        </span>
                                      )}
                                    </div>
                                    <button
                                      title={`Change ${item.name}'s rarity, quantity, effect or chapter`}
                                      onClick={() => startItemEdit(item)}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      title={`Delete ${item.name}`}
                                      onClick={() => removeItem(item)}
                                    >
                                      Delete
                                    </button>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div className="inventory-creator">
                          <input
                            aria-label="New item name"
                            placeholder="Item"
                            value={newItemName}
                            onChange={(e) => setNewItemName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addItem()}
                          />
                          <input
                            aria-label="New item rarity"
                            placeholder="Rarity"
                            value={newItemRarity}
                            onChange={(e) => setNewItemRarity(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addItem()}
                          />
                          <input
                            aria-label="New item quantity"
                            type="number"
                            min={0}
                            step={1}
                            title="How many of this item the character carries"
                            value={newItemQuantity}
                            onChange={(e) => setNewItemQuantity(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addItem()}
                          />
                          <input
                            aria-label="New item effect"
                            placeholder="Effect"
                            value={newItemEffect}
                            onChange={(e) => setNewItemEffect(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addItem()}
                          />
                          <select
                            aria-label="New item chapter"
                            title="The chapter this item was acquired in"
                            value={newItemChapterId}
                            onChange={(e) => setNewItemChapterId(e.target.value)}
                          >
                            <option value="">No chapter</option>
                            {chapterChoices.map(choice => (
                              <option key={choice.id} value={choice.id}>
                                {choice.data.label}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label="New item lost chapter"
                            title="The chapter this item was lost in"
                            value={newItemLostChapterId}
                            onChange={(e) => setNewItemLostChapterId(e.target.value)}
                          >
                            <option value="">Not lost</option>
                            {chapterChoices.map(choice => (
                              <option key={choice.id} value={choice.id}>
                                {choice.data.label}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label="New item card"
                            title="The item card this row belongs to"
                            value={newItemNodeId}
                            onChange={(e) => setNewItemNodeId(e.target.value)}
                          >
                            <option value="">No card</option>
                            {itemCardChoices.map(choice => (
                              <option key={choice.id} value={choice.id}>
                                {choice.data.label}
                              </option>
                            ))}
                          </select>
                          <button
                            title="Add this item to the selected character"
                            onClick={addItem}
                            disabled={!newItemName.trim()}
                          >
                            Add item
                          </button>
                        </div>
                      </div>

                      {/* Currency is a named amount per character. Nothing adds
                          up across names: gold and mana crystals stay separate. */}
                      <div className="currency-section">
                        <h4 className="character-section-heading">Currency</h4>

                        <div className="currency-list">
                          {characterCurrency.length === 0 && (
                            <div className="empty">
                              No currency yet — add one below.
                            </div>
                          )}

                          {characterCurrency.map(currency => (
                            <div key={currency.id} className="currency-row">
                              {editingCurrencyId === currency.id ? (
                                <div className="currency-editor">
                                  <input
                                    aria-label="Currency name"
                                    autoFocus
                                    value={currencyNameDraft}
                                    onChange={(e) => setCurrencyNameDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') saveCurrency(currency);
                                      if (e.key === 'Escape') setEditingCurrencyId(null);
                                    }}
                                  />
                                  <input
                                    aria-label="Currency amount"
                                    type="number"
                                    min={0}
                                    step={1}
                                    value={currencyAmountDraft}
                                    onChange={(e) => setCurrencyAmountDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') saveCurrency(currency);
                                      if (e.key === 'Escape') setEditingCurrencyId(null);
                                    }}
                                  />
                                  <div className="currency-actions">
                                    <button
                                      title={`Save this ${currency.name} amount`}
                                      onClick={() => saveCurrency(currency)}
                                    >
                                      Save currency
                                    </button>
                                    <button
                                      title="Leave the amount as it was"
                                      onClick={() => setEditingCurrencyId(null)}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div className="currency-summary">
                                    <span className="currency-amount">
                                      {formatCount(currency.amount)}
                                    </span>
                                    <span className="currency-name">{currency.name}</span>
                                  </div>
                                  <button
                                    title={`Change the amount of ${currency.name}`}
                                    onClick={() => startCurrencyEdit(currency)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    title={`Delete ${currency.name}`}
                                    onClick={() => removeCurrency(currency)}
                                  >
                                    Delete
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>

                        <div className="currency-creator">
                          <input
                            aria-label="New currency name"
                            placeholder="Currency (Gold)"
                            value={newCurrencyName}
                            onChange={(e) => setNewCurrencyName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addCurrency()}
                          />
                          <input
                            aria-label="New currency amount"
                            type="number"
                            min={0}
                            step={1}
                            value={newCurrencyAmount}
                            onChange={(e) => setNewCurrencyAmount(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addCurrency()}
                          />
                          <button
                            title="Add this currency to the selected character"
                            onClick={addCurrency}
                            disabled={!newCurrencyName.trim()}
                          >
                            Add currency
                          </button>
                        </div>
                      </div>

                      {/* Relations join two cast members, so they live on the
                          sheet beside the skills and items rather than on a card. */}
                      <div className="relations-section">
                        <h4 className="character-section-heading">Relations</h4>

                        <div className="relation-list">
                          {selectedRelations.length === 0 && (
                            <div className="empty">
                              No relations yet — a bond with another cast member is
                              recorded below.
                            </div>
                          )}

                          {selectedRelations.map(relation => {
                            const otherId =
                              relation.from_character_id === selectedCharacterId
                                ? relation.to_character_id
                                : relation.from_character_id;
                            const otherName =
                              characterNameById.get(otherId) ??
                              'a cast member in the trash';
                            const sinceLabel = relation.since_chapter_id
                              ? chapterLabelById.get(relation.since_chapter_id) ??
                                'a chapter in the trash'
                              : null;
                            const untilLabel = relation.until_chapter_id
                              ? chapterLabelById.get(relation.until_chapter_id) ??
                                'a chapter in the trash'
                              : null;
                            const focused =
                              focusedProgression?.kind === 'relation' &&
                              focusedProgression.id === relation.id;

                            return (
                              <div
                                key={relation.id}
                                data-progression={`relation-${relation.id}`}
                                className={`relation-row${
                                  focused ? ' progression-row-focused' : ''
                                }`}
                              >
                                {editingRelationId === relation.id ? (
                                  <div className="relation-editor">
                                    <SuggestionInput
                                      label="Relation kind"
                                      title="Ally, rival, mentor, family and owes are only suggestions"
                                      autoFocus
                                      value={relationKindDraft}
                                      suggestions={relationKindSuggestions}
                                      onChange={setRelationKindDraft}
                                      onEnter={() => void saveRelation(relation)}
                                      onEscape={() => setEditingRelationId(null)}
                                    />
                                    <span className="relation-other">{otherName}</span>
                                    <select
                                      aria-label="Relation since chapter"
                                      title="The chapter this bond began in"
                                      value={relationChapterDraft}
                                      onChange={(e) => setRelationChapterDraft(e.target.value)}
                                    >
                                      <option value="">No chapter recorded</option>
                                      {chapterChoices.map(node => (
                                        <option key={node.id} value={node.id}>
                                          {node.data.label}
                                        </option>
                                      ))}
                                    </select>
                                    <select
                                      aria-label="Relation until chapter"
                                      title="The chapter this bond ended in, if it did"
                                      value={relationUntilChapterDraft}
                                      onChange={(e) =>
                                        setRelationUntilChapterDraft(e.target.value)
                                      }
                                    >
                                      <option value="">Still current</option>
                                      {chapterChoices.map(node => (
                                        <option key={node.id} value={node.id}>
                                          {node.data.label}
                                        </option>
                                      ))}
                                    </select>
                                    <input
                                      aria-label="Relation note"
                                      placeholder="Note"
                                      value={relationNoteDraft}
                                      onChange={(e) => setRelationNoteDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') void saveRelation(relation);
                                        if (e.key === 'Escape') setEditingRelationId(null);
                                      }}
                                    />
                                    <div className="relation-actions">
                                      <button
                                        title={`Save this ${relation.kind} relation`}
                                        onClick={() => void saveRelation(relation)}
                                      >
                                        Save relation
                                      </button>
                                      <button
                                        title="Leave the relation as it was"
                                        onClick={() => setEditingRelationId(null)}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <div className="relation-summary">
                                      <span className="relation-kind">
                                        {relation.kind}
                                      </span>
                                      <span className="relation-other">{otherName}</span>
                                      <span className="relation-when">
                                        {sinceLabel
                                          ? `since ${sinceLabel}`
                                          : 'no chapter recorded'}
                                        {untilLabel ? ` – ${untilLabel}` : ''}
                                      </span>
                                    </div>
                                    {relation.note && (
                                      <span className="relation-note">
                                        {relation.note}
                                      </span>
                                    )}
                                    <button
                                      title={`Change this ${relation.kind} relation`}
                                      onClick={() => startRelationEdit(relation)}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      title={`Delete this ${relation.kind} relation`}
                                      onClick={() => void removeRelation(relation)}
                                    >
                                      Delete
                                    </button>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div className="relation-creator">
                          <SuggestionInput
                            label="New relation kind"
                            title="Ally, rival, mentor, family and owes are only suggestions"
                            placeholder="Kind (ally)"
                            value={newRelationKind}
                            suggestions={relationKindSuggestions}
                            onChange={setNewRelationKind}
                            onEnter={() => void addRelation()}
                          />
                          <select
                            aria-label="New relation with"
                            title="The other cast member in this relation"
                            value={newRelationToId}
                            onChange={(e) => setNewRelationToId(e.target.value)}
                          >
                            <option value="">Choose cast…</option>
                            {characters
                              .filter(character => character.id !== selectedCharacterId)
                              .map(character => (
                                <option key={character.id} value={character.id}>
                                  {character.name}
                                </option>
                              ))}
                          </select>
                          <select
                            aria-label="New relation since chapter"
                            title="The chapter this bond began in"
                            value={newRelationChapterId}
                            onChange={(e) => setNewRelationChapterId(e.target.value)}
                          >
                            <option value="">No chapter recorded</option>
                            {chapterChoices.map(node => (
                              <option key={node.id} value={node.id}>
                                {node.data.label}
                              </option>
                            ))}
                          </select>
                          <input
                            aria-label="New relation note"
                            placeholder="Note"
                            value={newRelationNote}
                            onChange={(e) => setNewRelationNote(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && void addRelation()}
                          />
                          <button
                            title="Record this relation on the character's sheet"
                            onClick={() => void addRelation()}
                            disabled={!newRelationToId || !newRelationKind.trim()}
                          >
                            Add relation
                          </button>
                        </div>
                      </div>

                      {/* A faction is a card, so the standing names it by its
                          label and keeps the arc it began in. */}
                      <div className="standings-section">
                        <h4 className="character-section-heading">
                          Faction standings
                        </h4>

                        <div className="standing-list">
                          {selectedStandings.length === 0 && (
                            <div className="empty">
                              No faction standings yet — record one below.
                            </div>
                          )}

                          {selectedStandings.map(standing => {
                            const factionName =
                              (standing.faction_node_id
                                ? factionCardChoices.find(
                                    node => node.id === standing.faction_node_id
                                  )?.data.label
                                : null) ?? 'a faction no longer on the board';
                            const sinceLabel = standing.since_chapter_id
                              ? chapterLabelById.get(standing.since_chapter_id) ??
                                'a chapter in the trash'
                              : null;
                            const untilLabel = standing.until_chapter_id
                              ? chapterLabelById.get(standing.until_chapter_id) ??
                                'a chapter in the trash'
                              : null;
                            const focused =
                              focusedProgression?.kind === 'faction-standing' &&
                              focusedProgression.id === standing.id;

                            return (
                              <div
                                key={standing.id}
                                data-progression={`faction-standing-${standing.id}`}
                                className={`standing-row${
                                  focused ? ' progression-row-focused' : ''
                                }`}
                              >
                                {editingStandingId === standing.id ? (
                                  <div className="standing-editor">
                                    <select
                                      aria-label="Standing faction"
                                      title="The faction card this standing belongs to"
                                      value={standingFactionDraft}
                                      onChange={(e) =>
                                        setStandingFactionDraft(e.target.value)
                                      }
                                    >
                                      <option value="">Choose faction…</option>
                                      {factionCardChoices.map(node => (
                                        <option key={node.id} value={node.id}>
                                          {node.data.label}
                                        </option>
                                      ))}
                                    </select>
                                    <input
                                      aria-label="Standing role"
                                      placeholder="Standing (Member)"
                                      autoFocus
                                      value={standingTextDraft}
                                      onChange={(e) => setStandingTextDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') void saveStanding(standing);
                                        if (e.key === 'Escape') setEditingStandingId(null);
                                      }}
                                    />
                                    <select
                                      aria-label="Standing since chapter"
                                      title="The chapter this standing began in"
                                      value={standingChapterDraft}
                                      onChange={(e) =>
                                        setStandingChapterDraft(e.target.value)
                                      }
                                    >
                                      <option value="">Choose chapter…</option>
                                      {chapterChoices.map(node => (
                                        <option key={node.id} value={node.id}>
                                          {node.data.label}
                                        </option>
                                      ))}
                                    </select>
                                    <select
                                      aria-label="Standing until chapter"
                                      title="The chapter this standing ended in, if it did"
                                      value={standingUntilChapterDraft}
                                      onChange={(e) =>
                                        setStandingUntilChapterDraft(e.target.value)
                                      }
                                    >
                                      <option value="">Still standing</option>
                                      {chapterChoices.map(node => (
                                        <option key={node.id} value={node.id}>
                                          {node.data.label}
                                        </option>
                                      ))}
                                    </select>
                                    <input
                                      aria-label="Standing note"
                                      placeholder="Note"
                                      value={standingNoteDraft}
                                      onChange={(e) => setStandingNoteDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') void saveStanding(standing);
                                        if (e.key === 'Escape') setEditingStandingId(null);
                                      }}
                                    />
                                    <div className="standing-actions">
                                      <button
                                        title="Save this faction standing"
                                        onClick={() => void saveStanding(standing)}
                                      >
                                        Save standing
                                      </button>
                                      <button
                                        title="Leave the standing as it was"
                                        onClick={() => setEditingStandingId(null)}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <div className="standing-summary">
                                      <span className="standing-faction">
                                        {factionName}
                                      </span>
                                      <span className="standing-role">
                                        {standing.standing}
                                      </span>
                                      <span className="standing-when">
                                        {sinceLabel
                                          ? `since ${sinceLabel}`
                                          : 'no chapter recorded'}
                                        {untilLabel ? ` – ${untilLabel}` : ''}
                                      </span>
                                    </div>
                                    {standing.note && (
                                      <span className="standing-note">
                                        {standing.note}
                                      </span>
                                    )}
                                    <button
                                      title={`Change this ${standing.standing} standing`}
                                      onClick={() => startStandingEdit(standing)}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      title={`Delete this ${standing.standing} standing`}
                                      onClick={() => void removeStanding(standing)}
                                    >
                                      Delete
                                    </button>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div className="standing-creator">
                          <select
                            aria-label="New standing faction"
                            title="The faction card this standing belongs to"
                            value={newStandingFactionId}
                            onChange={(e) => setNewStandingFactionId(e.target.value)}
                          >
                            <option value="">Choose faction…</option>
                            {factionCardChoices.map(node => (
                              <option key={node.id} value={node.id}>
                                {node.data.label}
                              </option>
                            ))}
                          </select>
                          <span className="faction-quick-add">
                            <input
                              aria-label="New standing faction name"
                              title="Make a faction card and record this standing in it"
                              placeholder="New faction…"
                              value={newStandingFactionName}
                              onChange={event =>
                                setNewStandingFactionName(event.target.value)
                              }
                              onKeyDown={event => {
                                if (event.key !== 'Enter') return;
                                event.preventDefault();
                                void createFactionCard(
                                  newStandingFactionName,
                                  id => {
                                    setNewStandingFactionId(id);
                                    setNewStandingFactionName('');
                                  },
                                  setCharacterError
                                );
                              }}
                            />
                            <button
                              type="button"
                              title="Create this faction card and choose it"
                              disabled={!newStandingFactionName.trim()}
                              onClick={() =>
                                void createFactionCard(
                                  newStandingFactionName,
                                  id => {
                                    setNewStandingFactionId(id);
                                    setNewStandingFactionName('');
                                  },
                                  setCharacterError
                                )
                              }
                            >
                              Add faction
                            </button>
                          </span>
                          <input
                            aria-label="New standing role"
                            placeholder="Standing (Member)"
                            value={newStandingText}
                            onChange={(e) => setNewStandingText(e.target.value)}
                          />
                          <select
                            aria-label="New standing since chapter"
                            title="The chapter this standing began in"
                            value={newStandingChapterId}
                            onChange={(e) => setNewStandingChapterId(e.target.value)}
                          >
                            <option value="">Choose chapter…</option>
                            {chapterChoices.map(node => (
                              <option key={node.id} value={node.id}>
                                {node.data.label}
                              </option>
                            ))}
                          </select>
                          <input
                            aria-label="New standing note"
                            placeholder="Note"
                            value={newStandingNote}
                            onChange={(e) => setNewStandingNote(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && void addStanding()}
                          />
                          <button
                            title="Record this faction standing on the character's sheet"
                            onClick={() => void addStanding()}
                            disabled={
                              !newStandingFactionId ||
                              !newStandingText.trim() ||
                              !newStandingChapterId
                            }
                          >
                            Add standing
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
              </>
            )}
          </div>
        )}

        {selectedTab === 'quests' && (
          <QuestLedgerPanel
            story={currentStory}
            actor={actor}
            quests={storyQuests}
            setQuests={setStoryQuests}
            warnings={questContinuity}
            focus={questFocus}
            chapters={chapterChoices.map(node => ({
              id: node.id,
              label: node.data.label,
            }))}
            factions={factionCardChoices.map(node => ({
              id: node.id,
              label: node.data.label,
            }))}
            characters={characters}
            characterProgress={storyCharacterProgress}
            reloadCharacterProgress={reloadCharacterProgress}
            reloadInventory={reloadInventory}
            createFaction={createFactionCard}
          />
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
          <AuditPanel
            storyId={currentStory?.id ?? null}
            actor={actor}
            onReverted={refreshAfterRevert}
          />
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

      {guideOpen && (
        <div
          className="shortcuts-backdrop"
          role="presentation"
          onClick={() => setGuideOpen(false)}
        >
          <div
            className="shortcuts guide"
            role="dialog"
            aria-modal="true"
            aria-label="Guide"
            onClick={event => event.stopPropagation()}
          >
            <div className="shortcuts-head">
              <h2>Guide</h2>
              <button
                className="shortcuts-close"
                aria-label="Close guide"
                title="Close this guide (Esc)"
                onClick={() => setGuideOpen(false)}
              >
                ×
              </button>
            </div>

            <p className="shortcuts-intro">
              Three rules the canvas, the skill cards and the history keep. If you
              put the welcome card away, this is where it lives.
            </p>

            <ol className="guide-concepts">
              {guideConcepts.map(concept => (
                <li key={concept.title}>
                  <h3>{concept.title}</h3>
                  <p>{concept.body}</p>
                </li>
              ))}
            </ol>

            <div className="guide-actions">
              <button
                type="button"
                title={`Show every keyboard route (${shortcutKeys.help})`}
                onClick={() => {
                  setGuideOpen(false);
                  setShortcutsOpen(true);
                }}
              >
                Keyboard shortcuts
              </button>
              <button type="button" title="Close this guide" onClick={() => setGuideOpen(false)}>
                Close
              </button>
            </div>
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
      {characterConnection && (
        <div
          className="canvas-create-overlay"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !savingCharacterConnection) {
              setCharacterConnection(null);
              setCharacterConnectionError(null);
            }
          }}
        >
          <form
            className="canvas-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Connect characters"
            onSubmit={event => {
              event.preventDefault();
              void submitCharacterConnection();
            }}
          >
            <div className="canvas-create-head">
              <div className="canvas-create-title">
                <h3>Connect characters</h3>
                <HelpTip label="bond kinds">
                  A bond names how two people stand with each other: ally, rival,
                  mentor, family or enemy are the suggested ones, and any word you
                  type works too. It is written onto both sheets with the chapter it
                  began in, and the line on the canvas keeps the same word.
                </HelpTip>
              </div>
              <button
                type="button"
                className="canvas-create-close"
                aria-label="Close relation form"
                title="Close without connecting them"
                disabled={savingCharacterConnection}
                onClick={() => {
                  setCharacterConnection(null);
                  setCharacterConnectionError(null);
                }}
              >
                ×
              </button>
            </div>

            <p className="canvas-create-note">
              {characterConnection.sourceName} → {characterConnection.targetName}. The relation is
              recorded on both sheets, and the card keeps the connection.
            </p>

            <label className="canvas-create-field">
              Relation kind
              <input
                autoFocus
                list="connection-relation-kinds"
                value={characterConnection.kind}
                onChange={event => {
                  const value = event.target.value;
                  setCharacterConnection(current =>
                    current ? { ...current, kind: value } : current
                  );
                }}
              />
              <datalist id="connection-relation-kinds">
                {relationKindSuggestions.map(kind => (
                  <option key={kind} value={kind} />
                ))}
              </datalist>
            </label>

            <label className="canvas-create-field">
              Since chapter (optional)
              <select
                value={characterConnection.chapterId}
                onChange={event => {
                  const value = event.target.value;
                  setCharacterConnection(current =>
                    current ? { ...current, chapterId: value } : current
                  );
                }}
              >
                <option value="">From the beginning</option>
                {nodes
                  .filter(node => node.data.nodeType === 'chapter')
                  .sort(
                    (a, b) =>
                      (a.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) -
                        (b.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) ||
                      a.data.label.localeCompare(b.data.label)
                  )
                  .map(node => (
                    <option key={node.id} value={node.id}>
                      {node.data.label}
                    </option>
                  ))}
              </select>
            </label>

            <label className="canvas-create-field">
              Note (optional)
              <textarea
                rows={2}
                value={characterConnection.note}
                onChange={event => {
                  const value = event.target.value;
                  setCharacterConnection(current =>
                    current ? { ...current, note: value } : current
                  );
                }}
              />
            </label>

            {characterConnectionError && (
              <div className="canvas-create-error" role="alert">
                {characterConnectionError}
              </div>
            )}

            <div className="canvas-create-actions">
              <button
                type="submit"
                disabled={savingCharacterConnection || !characterConnection.kind.trim()}
              >
                {savingCharacterConnection ? 'Connecting…' : 'Connect characters'}
              </button>
              <button
                type="button"
                disabled={savingCharacterConnection}
                onClick={() => {
                  setCharacterConnection(null);
                  setCharacterConnectionError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {pendingEdgeRemoval && (
        <div
          className="canvas-create-overlay"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !removingDomainEdges) {
              setPendingEdgeRemoval(null);
            }
          }}
        >
          <div
            className="canvas-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Remove connection"
          >
            <div className="canvas-create-head">
              <h3>
                {pendingEdgeRemoval.length === 1
                  ? pendingEdgeRemoval[0].title
                  : 'Remove these connections?'}
              </h3>
              <button
                type="button"
                className="canvas-create-close"
                aria-label="Keep the connection"
                title="Keep the connection and what it records"
                disabled={removingDomainEdges}
                onClick={() => setPendingEdgeRemoval(null)}
              >
                ×
              </button>
            </div>

            <ul className="canvas-create-removal-list">
              {pendingEdgeRemoval.map(entry => (
                <li key={entry.edge.id}>{entry.detail}</li>
              ))}
            </ul>

            <div className="canvas-create-actions">
              <button
                type="button"
                disabled={removingDomainEdges}
                onClick={() => void confirmDomainEdgeRemoval()}
              >
                {removingDomainEdges ? 'Removing…' : 'Remove'}
              </button>
              <button
                type="button"
                disabled={removingDomainEdges}
                onClick={() => setPendingEdgeRemoval(null)}
              >
                Keep
              </button>
            </div>
          </div>
        </div>
      )}

      {canvasCreate && (
        <div
          className="canvas-create-overlay"
          onMouseDown={event => {
            // A click on the dimmed backdrop closes the form; a click inside the
            // form itself does not.
            if (
              event.target === event.currentTarget &&
              !savingCanvasCreate
            ) {
              setCanvasCreate(null);
              setCanvasCreateError(null);
            }
          }}
        >
          <form
            className="canvas-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              canvasCreate.kind === 'character'
                ? 'New character'
                : canvasCreate.kind === 'quest'
                  ? 'New quest'
                  : 'New skill'
            }
            onSubmit={event => {
              event.preventDefault();
              void submitCanvasCreate();
            }}
          >
            <div className="canvas-create-head">
              <h3>
                {canvasCreate.kind === 'character'
                  ? 'New character'
                  : canvasCreate.kind === 'quest'
                    ? 'New quest'
                    : 'New skill'}
              </h3>
              <button
                type="button"
                className="canvas-create-close"
                aria-label="Close new card form"
                title="Close without creating anything"
                disabled={savingCanvasCreate}
                onClick={() => {
                  setCanvasCreate(null);
                  setCanvasCreateError(null);
                }}
              >
                ×
              </button>
            </div>

            <p className="canvas-create-note">
              {canvasCreate.kind === 'character'
                ? 'The cast member and a card on the board are created together.'
                : canvasCreate.kind === 'quest'
                  ? 'The contract in the ledger and a quest card are created together.'
                  : "The card and the skill on its owner's sheet are created together."}
            </p>

            {canvasCreate.kind === 'character' && (
              <>
                <label className="canvas-create-field">
                  Character name
                  <input
                    autoFocus
                    value={canvasCreate.name}
                    onChange={event => {
                      const value = event.target.value;
                      setCanvasCreate(current =>
                        current ? { ...current, name: value } : current
                      );
                    }}
                  />
                </label>
                <label className="canvas-create-field">
                  Character description
                  <textarea
                    rows={3}
                    value={canvasCreate.description}
                    onChange={event => {
                      const value = event.target.value;
                      setCanvasCreate(current =>
                        current ? { ...current, description: value } : current
                      );
                    }}
                  />
                </label>
              </>
            )}

            {canvasCreate.kind === 'quest' && (
              <>
                <label className="canvas-create-field">
                  Quest title
                  <input
                    autoFocus
                    value={canvasCreate.name}
                    onChange={event => {
                      const value = event.target.value;
                      setCanvasCreate(current =>
                        current ? { ...current, name: value } : current
                      );
                    }}
                  />
                </label>
                <div className="canvas-create-row">
                  <label className="canvas-create-field">
                    Quest giver
                    <select
                      value={canvasCreate.giverId}
                      onChange={event => {
                        const value = event.target.value;
                        setCanvasCreate(current =>
                          current ? { ...current, giverId: value } : current
                        );
                      }}
                    >
                      <option value="">No giver</option>
                      {characters.map(character => (
                        <option key={character.id} value={character.id}>
                          {character.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="canvas-create-field">
                    Quest faction
                    <select
                      value={canvasCreate.factionId}
                      onChange={event => {
                        const value = event.target.value;
                        setCanvasCreate(current =>
                          current ? { ...current, factionId: value } : current
                        );
                      }}
                    >
                      <option value="">No faction</option>
                      {nodes
                        .filter(node => node.data.nodeType === 'faction')
                        .map(node => (
                          <option key={node.id} value={node.id}>
                            {node.data.label}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <div className="canvas-create-row">
                  <label className="canvas-create-field">
                    Quest accepted chapter
                    <select
                      value={canvasCreate.chapterId}
                      onChange={event => {
                        const value = event.target.value;
                        setCanvasCreate(current =>
                          current ? { ...current, chapterId: value } : current
                        );
                      }}
                    >
                      <option value="">Choose a chapter</option>
                      {nodes
                        .filter(node => node.data.nodeType === 'chapter')
                        .sort(
                          (a, b) =>
                            (a.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) -
                              (b.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) ||
                            a.data.label.localeCompare(b.data.label)
                        )
                        .map(node => (
                          <option key={node.id} value={node.id}>
                            {node.data.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="canvas-create-field">
                    Quest ending chapter
                    <select
                      value={canvasCreate.completedChapterId}
                      onChange={event => {
                        const value = event.target.value;
                        setCanvasCreate(current =>
                          current ? { ...current, completedChapterId: value } : current
                        );
                      }}
                    >
                      <option value="">Not ended</option>
                      {nodes
                        .filter(node => node.data.nodeType === 'chapter')
                        .sort(
                          (a, b) =>
                            (a.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) -
                              (b.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) ||
                            a.data.label.localeCompare(b.data.label)
                        )
                        .map(node => (
                          <option key={node.id} value={node.id}>
                            {node.data.label}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <p className="canvas-create-hint">
                  {canvasCreate.completedChapterId
                    ? 'The quest will be recorded as completed.'
                    : 'The quest will be recorded as active.'}
                </p>
                <label className="canvas-create-field">
                  Quest description
                  <textarea
                    rows={2}
                    value={canvasCreate.description}
                    onChange={event => {
                      const value = event.target.value;
                      setCanvasCreate(current =>
                        current ? { ...current, description: value } : current
                      );
                    }}
                  />
                </label>
                <label className="canvas-create-field">
                  Quest notes
                  <textarea
                    rows={2}
                    value={canvasCreate.notes}
                    onChange={event => {
                      const value = event.target.value;
                      setCanvasCreate(current =>
                        current ? { ...current, notes: value } : current
                      );
                    }}
                  />
                </label>
              </>
            )}

            {canvasCreate.kind === 'skill' && (
              <>
                <label className="canvas-create-field">
                  Skill owner
                  <select
                    value={canvasCreate.ownerId}
                    onChange={event => {
                      const value = event.target.value;
                      setCanvasCreate(current =>
                        current ? { ...current, ownerId: value } : current
                      );
                    }}
                  >
                    <option value="">No holder yet</option>
                    {characters.map(character => (
                      <option key={character.id} value={character.id}>
                        {character.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="canvas-create-field">
                  Skill name
                  <input
                    autoFocus
                    value={canvasCreate.name}
                    onChange={event => {
                      const value = event.target.value;
                      setCanvasCreate(current =>
                        current ? { ...current, name: value } : current
                      );
                    }}
                  />
                </label>
                <div className="canvas-create-row">
                  <label className="canvas-create-field">
                    Skill rank
                    <input
                      value={canvasCreate.rank}
                      onChange={event => {
                        const value = event.target.value;
                        setCanvasCreate(current =>
                          current ? { ...current, rank: value } : current
                        );
                      }}
                    />
                  </label>
                  <label className="canvas-create-field">
                    Skill chapter
                    <select
                      value={canvasCreate.chapterId}
                      onChange={event => {
                        const value = event.target.value;
                        setCanvasCreate(current =>
                          current ? { ...current, chapterId: value } : current
                        );
                      }}
                    >
                      <option value="">No chapter</option>
                      {nodes
                        .filter(node => node.data.nodeType === 'chapter')
                        .sort(
                          (a, b) =>
                            (a.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) -
                              (b.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) ||
                            a.data.label.localeCompare(b.data.label)
                        )
                        .map(node => (
                          <option key={node.id} value={node.id}>
                            {node.data.label}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <label className="canvas-create-field">
                  Skill effect
                  <textarea
                    rows={2}
                    value={canvasCreate.description}
                    onChange={event => {
                      const value = event.target.value;
                      setCanvasCreate(current =>
                        current ? { ...current, description: value } : current
                      );
                    }}
                  />
                </label>
              </>
            )}

            {canvasCreate.kind === 'quest' &&
              !nodes.some(node => node.data.nodeType === 'chapter') && (
                <p className="canvas-create-hint">
                  Add a chapter on the Chapters tab first — a quest needs one.
                </p>
              )}

            {canvasCreate.kind === 'skill' && (
              <p className="canvas-create-hint">
                {canvasCreate.ownerId
                  ? 'The skill is written onto that sheet as well as the board.'
                  : characters.length === 0
                    ? 'Nobody can hold it yet — place the card now and add a character later.'
                    : 'Leave the owner unset to place the card now; connect a character to it later to give the skill out.'}
              </p>
            )}

            {canvasCreateError && (
              <div className="canvas-create-error" role="alert">
                {canvasCreateError}
              </div>
            )}

            <div className="canvas-create-actions">
              <button
                type="submit"
                disabled={
                  savingCanvasCreate ||
                  !canvasCreate.name.trim() ||
                  (canvasCreate.kind === 'quest' && !canvasCreate.chapterId)
                }
              >
                {savingCanvasCreate ? 'Creating…' : 'Create card'}
              </button>
              <button
                type="button"
                disabled={savingCanvasCreate}
                onClick={() => {
                  setCanvasCreate(null);
                  setCanvasCreateError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
