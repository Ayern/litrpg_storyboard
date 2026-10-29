import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useId,
} from 'react';
import {
  useNodesState,
  useEdgesState,
  Connection,
  addEdge,
} from 'reactflow';
import type { Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
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
import { AttributeList } from './domains/characters/AttributeList';
import { CurrencyList } from './domains/characters/CurrencyList';
import { InventoryList } from './domains/characters/InventoryList';
import type { InventoryDraft } from './domains/characters/InventoryList';
import { RelationList } from './domains/characters/RelationList';
import type { RelationDraft } from './domains/characters/RelationList';
import { StandingList } from './domains/characters/StandingList';
import type { StandingDraft } from './domains/characters/StandingList';
import { HelpTip, placeTooltip } from './components/HelpTip';
import { AuditPanel } from './domains/audit/AuditPanel';
import { CharacterSheetPanel } from './domains/characters/CharacterSheetPanel';
import {
  CharacterRelationsView,
  CharacterSkillsView,
} from './domains/characters/CharacterViews';
import { ChaptersPanel } from './domains/narrative/ChaptersPanel';
import { QuestLedgerPanel } from './domains/quests/QuestLedgerPanel';
import { useHistory } from './domains/history/useHistory';
import { TrashPanel } from './domains/trash/TrashPanel';
import { BackupsDialog } from './domains/stories/BackupsDialog';
import { GuideReader } from './domains/guide/GuideReader';
import { questsByChapter } from './domains/quests/ledger';
import type { CharacterAttribute } from './domains/characters/types';
import { GraphTab } from './domains/canvas/GraphTab';
import { useCanvasDrafts } from './domains/canvas/useCanvasDrafts';
import { useCanvasInspector } from './domains/canvas/useCanvasInspector';
import { useSkillHolderForm } from './domains/canvas/useSkillHolderForm';
import { useChapterWorkspace } from './domains/narrative/useChapterWorkspace';
import { useStoryShelf } from './domains/stories/useStoryShelf';
import { useSearchPalette } from './domains/search/useSearchPalette';
import { crossingsByCharacter, levelCrossingsFor } from './domains/progression/crossings';
import { effectiveGrowthRule } from './domains/progression/growth';
import { milestoneStatChanges } from './domains/progression/helpers';
import { findSheetStat, likelyRenamedStat, statKey } from './domains/progression/statNames';
import { useProgressionChart } from './domains/progression/useProgressionChart';
import { CAST_DRAG_TYPE, edgeKindClass, isCanvasCreateKind } from './domains/canvas/types';
import type { CanvasCreateKind, EdgeData } from './domains/canvas/types';
import type {
  ChapterCastBadge,
  ChapterEventRow,
  ChapterSkillChoice,
  IndexedEdge,
  IndexedNode,
  NodeData,
  NodeType,
} from './domains/canvas/types';
import type { CharacterCurrency, InventoryItem } from './domains/inventory/types';
import type {
  ChapterCastMember,
  ChapterCastState,
  ChapterEvent,
  ChapterEventType,
  ChapterTask,
} from './domains/narrative/types';
import { ProgressionSections } from './domains/characters/ProgressionSections';
import type {
  ProgressDraft,
  XpEntryDraft,
} from './domains/characters/ProgressionSections';
import type { LevelStatChangeDraft } from './domains/progression/drafts';
import type { GrowthScope } from './domains/progression/GrowthSection';
import type {
  AwardDraft,
  GrowthRateDraft,
  ProgressionFocus,
} from './domains/progression/types';
import type { Quest, QuestWarning } from './domains/quests/types';
import { SkillsSection } from './domains/skills/SkillsSection';
import type { SkillDraft, SkillEventDraft } from './domains/skills/SkillsSection';
import type { CharacterSkillEvent, SkillEvolutionInput } from './domains/skills/types';
import type {
  ChapterContinuityFlag,
  ContinuityPart,
  ProgressionTarget,
} from './domains/shared/types';
import type {
  Character,
  CharacterAward,
  CharacterChapterSkill,
  CharacterGrowthPoint,
  CharacterLevel,
  CharacterProgress,
  CharacterRelation,
  CharacterSkill,
  CharacterStat,
  GrowthPointSpend,
  FactionStanding,
  InventoryHolder,
  LevelGrowthRule,
  SkillEvolution,
  SkillHolder,
} from './domains/shared/types';
import type { Story } from './domains/stories/types';
import type { SearchKind, SearchResult } from './domains/search/types';
import type { DeletedItem } from './domains/trash/types';
import {
  SEARCH_RESULTS_SHOWN,
  searchKindFilters,
  searchResultTag,
  searchResultTitles,
} from './domains/search/labels';
import { formatCount } from './lib/format';
// Re-exported where the guide test has always imported it from.
export { placeTooltip };

// The bond kinds a sheet suggests. Like a connection's verbs these are only
// suggestions: the field keeps whatever word the author types.
const relationKindSuggestions = ['ally', 'rival', 'mentor', 'family', 'enemy', 'owes'] as const;

// Whether the first-run card has been put away. It is one flag for the whole
// app: a reader who understood the canvas once does not need it again per
// story. The guide stays reachable from the header either way.
const GUIDE_DISMISSED_KEY = 'litrpg.guide.dismissed';

// The three rules the first-run card lists, one line each. Their long form is the
// guide itself: the card's button opens `GUIDE.md`, whose first section is these
// rules written out, so the two cannot say different things.
const guideConcepts = [
  {
    title: 'The canvas is a database',
    short: 'A line you draw is a record: a relation, a cast entry, an audit entry.',
  },
  {
    title: 'A skill card has one identity',
    short: 'Editing a card changes every character who holds that skill.',
  },
  {
    title: 'History goes back whole actions',
    short: 'Undo and the Audit Log reverse a change made on the sheet or the canvas.',
  },
] as const;

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

// How many note cards hang under one chapter before the rest are counted.
const NOTE_CARDS_SHOWN = 3;

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
    className: edgeKindClass(row.relation_type),
    label: row.label || row.relation_type || '',
    data: {
      label: row.label ?? undefined,
      relationType: row.relation_type ?? undefined,
      createdBy: row.created_by,
    },
  };
}

// The short line a history step names a chapter event by.
function chapterEventLabel(
  event: Pick<ChapterEvent, 'event_type' | 'details' | 'amount'>
): string {
  switch (event.event_type) {
    case 'xp_award':
      return `${formatCount(event.amount ?? 0)} XP in this chapter`;
    case 'skill_learn':
      return `learning ${event.details}`;
    case 'item_acquire':
      return `${event.details} ×${event.amount ?? 1}`;
    default:
      return event.details;
  }
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

// The prepared story's title. It is how the sidebar knows that a reset would
// replace sample data rather than a story the author has made their own.
const DEMO_STORY_TITLE = 'The Ember Ledger (Demo)';

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

  // Closing the window is the last way to lose a draft, so it asks first. The
  // drafts themselves belong to the chapter workspace; what is left here is the
  // question, because it is about the window rather than about a chapter.
  const [quitPrompt, setQuitPrompt] = useState(false);
  const quitKeepWorkingRef = useRef<HTMLButtonElement | null>(null);

  // The explicit cast of each chapter: everyone present beyond its point of
  // view. The board writes these rows too — a character drawn or dropped into a
  // chapter adds one — so they stay here and the workspace is handed them.
  const [storyChapterCast, setStoryChapterCast] = useState<ChapterCastMember[]>([]);

  // The objectives written on each chapter card, in the order they were written.
  // The card ticks them off in place, so the list is the board's as well as the
  // database's: a tick is one row and one history step, never a refetch.
  const [storyChapterTasks, setStoryChapterTasks] = useState<ChapterTask[]>([]);

  // The scene's progression ledger, in the order each chapter's events were
  // logged. XP, learned skills and acquired items also write the sheet; the
  // rest are the scene's record.
  const [storyChapterEvents, setStoryChapterEvents] = useState<ChapterEvent[]>([]);

  // The live chapters, in reading order. The board says which cards are chapters
  // and the narrative domain says what order they read in; the tab, the cards
  // and the workspace below all work from this one list.
  const chapterNodes = useMemo(() => liveChapters(nodes), [nodes]);

  // The Chapters tab's own state lives in the narrative domain: the reading
  // list's controls, the details form and the question it asks before being
  // left, the notes panel, and the cast picker. The cards arrive as an argument
  // because the board writes them, and the cast rows go back out the same way,
  // since a connection drawn on the canvas adds a cast member too.
  const {
    newChapterTitle,
    setNewChapterTitle,
    chapterError,
    setChapterError,
    chapterBusy,
    setChapterBusy,
    revealedChapterId,
    revealChapter,
    editingChapterId,
    chapterArcDraft,
    setChapterArcDraft,
    chapterWordsDraft,
    setChapterWordsDraft,
    chapterTargetDraft,
    setChapterTargetDraft,
    chapterPovDraft,
    setChapterPovDraft,
    chapterDayDraft,
    setChapterDayDraft,
    chapterTimeDraft,
    setChapterTimeDraft,
    chapterArcInputRef,
    chapterKeepEditingRef,
    chapterDraftIsDirty,
    openChapterDetails,
    requestChapterClose,
    requestChapterLeave,
    askToLeaveChapter,
    chapterFormPrompt,
    dismissChapterPrompt,
    discardChapterEdit,
    closeChapterForm,
    leaveChapterForm,
    finishChapterSave,
    abandonChapterDrafts,
    notes,
    notesByChapter,
    noteCount,
    followLoadedNotes,
    clearNotes,
    openNotesChapterId,
    toggleChapterNotes,
    openChapterNotes,
    noteDraft,
    setNoteDraft,
    noteDraftIsDirty,
    editingNoteId,
    noteEditDraft,
    setNoteEditDraft,
    matchedNoteId,
    noteBusy,
    noteError,
    noteEditorRef,
    noteAddRef,
    noteKeepEditingRef,
    notePrompt,
    setNotePrompt,
    askNoteQuestion,
    dismissNotePrompt,
    discardNoteDraft,
    abandonNoteDrafts,
    addNote,
    startNoteEdit,
    requestNoteEditCancel,
    saveNoteEdit,
    deleteNote,
    openChapterCastId,
    chapterCastBusyId,
    chapterCastError,
    chapterCastIsExplicit,
    toggleChapterCastPanel,
    closeChapterCastPanel,
    setChapterCastPresence,
    focusDraftField,
  } = useChapterWorkspace({
    chapterNodes,
    chapterCast: storyChapterCast,
    actor,
    onCastMemberAdded: row =>
      setStoryChapterCast(previous =>
        previous.some(member => member.id === row.id) ? previous : [...previous, row]
      ),
    onCastMemberRemoved: id =>
      setStoryChapterCast(previous => previous.filter(member => member.id !== id)),
  });

  // Which card or connection is open, the label and notes its fields hold, and
  // the half-written text remembered for the cards visited this session live in
  // the canvas domain. The board says whether those fields hold something
  // unsaved, so it goes in and the answers come back out.
  const {
    selectedNode,
    selectedEdge,
    selectedNodeId,
    selectedEdgeId,
    nodeLabelDraft,
    setNodeLabelDraft,
    nodeContentDraft,
    setNodeContentDraft,
    nodeEditError,
    setNodeEditError,
    closePrompt,
    setClosePrompt,
    renameOffer,
    setRenameOffer,
    edgeLabelDraft,
    setEdgeLabelDraft,
    edgeRelationDraft,
    setEdgeRelationDraft,
    edgeEditError,
    setEdgeEditError,
    nodeDirty,
    edgeDirty,
    openNode,
    openEdge,
    closeNode,
    dismissNode,
    discardNode,
    closeEdge,
    closeEditors,
    cardsRemoved,
    edgesRemoved,
    rememberNodeDraft,
    rememberLabelWritten,
    forgetNodeDraft,
    forgetRememberedDrafts,
    followStoredRows,
  } = useCanvasDrafts({ nodes, edges });

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
  const [storyLevels, setStoryLevels] = useState<
    CharacterLevel[]
  >([]);
  // What a level hands out, for the story and for any character that overrides
  // it, and the gains that skipped a level-up entirely.
  const [storyGrowthRules, setStoryGrowthRules] = useState<LevelGrowthRule[]>([]);
  // Where the points a level handed out were placed. The pool itself is not here:
  // it follows the level and the rule, so only the placings are stored.
  const [storyGrowthPoints, setStoryGrowthPoints] = useState<CharacterGrowthPoint[]>([]);
  const [storyAwards, setStoryAwards] = useState<CharacterAward[]>([]);
  // Read by a sync's undo step, so putting an old total back does not also put
  // the milestone's other fields back.
  const storyLevelsRef = useRef<CharacterLevel[]>([]);
  // The one-click ledger sync, offered back for a moment like Mark returned.
  const [syncedXpNotice, setSyncedXpNotice] = useState<{
    characterName: string;
    xp: number;
  } | null>(null);
  const [syncingXpMilestoneId, setSyncingXpMilestoneId] = useState<string | null>(null);
  // The same correction for a stat: the level-up's number written onto the
  // sheet, offered back as one step with the value the sheet had before.
  const [syncedStatNotice, setSyncedStatNotice] = useState<{
    characterName: string;
    statName: string;
    value: number;
  } | null>(null);
  // The row being written, keyed by character and stat, so only its button waits.
  const [syncingStatKey, setSyncingStatKey] = useState<string | null>(null);
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

  const [characterInventory, setCharacterInventory] = useState<InventoryItem[]>([]);
  const [storyInventory, setStoryInventory] = useState<InventoryItem[]>([]);
  // Read by an undo step recorded before a later edit, so putting the lost
  // chapter back does not also put the item's other fields back.
  const storyInventoryRef = useRef<InventoryItem[]>([]);
  const [characterCurrency, setCharacterCurrency] = useState<CharacterCurrency[]>([]);


  const [returningItemId, setReturningItemId] = useState<string | null>(null);
  // What Mark returned just did, so the board can offer the correction back
  // before the notice fades.
  const [returnedNotice, setReturnedNotice] = useState<{ itemName: string } | null>(null);


  const [focusedProgression, setFocusedProgression] =
    useState<ProgressionFocus | null>(null);
  const progressionFocusTimer = useRef<number | null>(null);

  // The sheet a chapter card's badge asked for, read as of that chapter.
  const [chapterStateFocus, setChapterStateFocus] = useState<{
    characterId: string;
    chapterId: string;
    request: number;
  } | null>(null);

  // Every live cast member's stats, which is what the cards on the canvas show.
  // Kept here rather than fetched per card so one read covers the whole board.
  const [castStats, setCastStats] = useState<Record<string, CharacterStat[]>>({});
  // Read by a stat sync's undo step, so putting an old value back does not also
  // put the row's notes back from whenever the button was pressed.
  const castStatsRef = useRef<Record<string, CharacterStat[]>>({});
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

  // A pan asked for while the board was not on screen, applied when it mounts.
  const pendingPanRef = useRef<{ x: number; y: number } | null>(null);

  // The search palette's own state — whether it is open, what it is looking for,
  // which kind of result it is narrowed to, which row the keyboard is on, and the
  // boards of the stories that are not open — lives in the search domain. The
  // open story is searched from what is on screen, so its rows go in; choosing a
  // result stays here, because arriving at one moves the window.
  const {
    searchOpen,
    searchTerm,
    typeSearch,
    filterKind,
    searchKind,
    searchIndex,
    highlightResult,
    moveSearchSelection,
    searchInputRef,
    openSearch,
    closeSearch,
    searchResults,
    highlightedResult,
    otherStoryLoading,
    otherStoryError,
    forgetOtherStories,
    openStoryId,
  } = useSearchPalette({
    nodes,
    edges,
    characters,
    notes,
    stories,
    currentStory,
  });

  const dragStartRef = useRef<{ id: string; x: number; y: number } | null>(null);
  // Nodes React Flow is removing right now, so their connections are not
  // recorded as a separate deletion.
  const removedNodeIdsRef = useRef<Set<string>>(new Set());
  // React Flow's instance, for turning a drop's screen point into canvas space.
  const flowRef = useRef<any>(null);

  const [characterError, setCharacterError] = useState<string | null>(null);

  const [newCharacterName, setNewCharacterName] = useState('');
  const [newCharacterDescription, setNewCharacterDescription] = useState('');

  const [editingCharacter, setEditingCharacter] = useState(false);
  const [characterNameDraft, setCharacterNameDraft] = useState('');
  const [characterDescriptionDraft, setCharacterDescriptionDraft] = useState('');
  const [confirmDeleteCharacter, setConfirmDeleteCharacter] = useState(false);

  // Restoring a copy of the database replaces every row the trash lists, so the
  // tab is told to read both lists again even when the open story did not change.
  const [trashReloadToken, setTrashReloadToken] = useState(0);

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
    forgetHistory();
    clearHistoryNotice();
    setReturnedNotice(null);
    setSyncedXpNotice(null);

    // A note or cast panel belongs to the story it was opened in, so a switch
    // closes it and drops whatever was being typed in it.
    closeChapterCastPanel();
    abandonNoteDrafts();

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
        growthRules,
        growthPoints,
        awards,
        inventory,
        noteRows,
        chapterCast,
        chapterTasks,
        chapterEvents,
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
          progressionApi.getStoryLevels(story.id),
          progressionApi.getStoryCharacterProgress(story.id),
          progressionApi.getStoryLevelGrowthRules(story.id),
          progressionApi.getStoryGrowthPoints(story.id),
          progressionApi.getStoryCharacterAwards(story.id),
          inventoryApi.getStoryInventory(story.id),
          narrativeApi.getChapterNotes(story.id),
          narrativeApi.getStoryChapterCast(story.id),
          narrativeApi.getStoryChapterTasks(story.id),
          narrativeApi.getStoryChapterEvents(story.id),
          relationsApi.getStoryRelations(story.id),
          relationsApi.getStoryFactionStandings(story.id),
          questsApi.getStoryQuests(story.id),
          skillsApi.getStorySkillEvolutions(story.id),
        ]);
      setCharacters(cast);
      setCastStats(statsByCharacter(stats));
      setStorySkills(skills ?? []);
      setStorySkillEvents(skillEvents ?? []);
      setStoryLevels(levels ?? []);
      setStoryCharacterProgress(progress ?? []);
      setStoryGrowthRules(growthRules ?? []);
      setStoryGrowthPoints(growthPoints ?? []);
      setStoryAwards(awards ?? []);
      setStoryInventory(inventory ?? []);
      followLoadedNotes(noteRows ?? []);
      setStoryChapterCast(chapterCast ?? []);
      setStoryChapterTasks(chapterTasks ?? []);
      setStoryChapterEvents(chapterEvents ?? []);
      setStoryRelations(relations ?? []);
      setStoryFactionStandings(standings ?? []);
      setStoryQuests(quests ?? []);
      setStorySkillEvolutions(evolutions ?? []);
      setSkillEvolutionError(null);
      // The ledger clears its own form when the story changes; only the lit
      // quest is the app's.
      setQuestFocus(null);

      // A card or a line from the previous story is no longer on the canvas.
      closeEditors();
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

      // An open editor follows what the row now says, unless it holds typing the
      // author has not saved; undo does not touch unsaved text.
      followStoredRows({ nodes: dbNodes, edges: dbEdges });
    },
    [setNodes, setEdges, followStoredRows]
  );

  // This session's undo and redo stacks live in the history domain. What a walk
  // reaches outside it — the notices the last step left, the error line, the
  // board it re-reads and the entry a refusal writes — comes back through these.
  const {
    depth: historyDepth,
    notice: historyNotice,
    clearNotice: clearHistoryNotice,
    recordStep,
    noteRolledBack,
    undoLast,
    redoLast,
    forget: forgetHistory,
  } = useHistory({
    // A newer action owns the board: the correction the last step offered would
    // be a step out of order.
    onBoardTaken: () => {
      setReturnedNotice(null);
      setSyncedXpNotice(null);
    },
    // A step is about to run, so the error the last one reported and the nodes
    // it was removing belong to the step before it.
    onStepStarting: () => {
      removedNodeIdsRef.current = new Set();
      setActionError(null);
      setReturnedNotice(null);
      setSyncedXpNotice(null);
    },
    openStoryId,
    reloadStory,
    // A refusal is written by the reporter just below, which also keeps the
    // rollback note this hook holds, so it is reached through this rather than
    // named here. The hook only calls it when a step fails.
    onRefused: (action, detail) => recordHistoryEvent(action, detail),
    onError: setActionError,
  });

  // A refusal used to be a notice that faded after a few seconds. It is also a
  // fact about the story, so it goes where the Audit tab can keep it: what was
  // attempted, and what stopped it.
  const recordHistoryEvent = useCallback(
    async (action: 'undo_refused' | 'redo_refused' | 'step_rolled_back', detail: string) => {
      const storyId = currentStory?.id ?? openStoryId();
      if (!storyId) return;

      if (action === 'step_rolled_back') noteRolledBack();

      try {
        await auditApi.recordHistoryEvent(storyId, action, detail, actor);
      } catch (e) {
        // The refusal is what the author needs to see; an entry that could not
        // be written must not replace it.
        console.error('Failed to write a refused step into the history:', e);
      }
    },
    [currentStory, actor, noteRolledBack]
  );

  // The story shelf's own state — which row is being renamed or is a click away
  // from the trash, the notices the import and export round trips leave, and the
  // backups dialog — lives in the stories domain. The list and the open story are
  // read by the palette and the first-story load too, so they stay here, and
  // what each action did comes back through these rather than through a setter.
  const {
    renamingStoryId,
    renameValue,
    setRenameValue,
    startRename,
    cancelRename,
    commitRename,
    confirmDeleteStoryId,
    askDeleteStory,
    cancelDeleteStory,
    removeStory,
    storyNotice,
    announceStory,
    dismissStoryNotice,
    exportStatus,
    copyNotice,
    importStory,
    exportStory,
    exportStoryBible,
    copyStoryBible,
    backupsOpen,
    openBackups,
    closeBackups,
    backups,
    backupsLoading,
    backupsError,
    confirmRestore,
    askRestore,
    cancelRestore,
    restoringFile,
    restoreBackup,
    restoreNotice,
  } = useStoryShelf({
    stories,
    currentStory,
    actor,
    // The sidebar is ordered by most recently touched, matching the query, and
    // the open story wears the new name in the header.
    onStoryRenamed: updated => {
      setStories(previous =>
        [updated, ...previous.filter(other => other.id !== updated.id)].sort((a, b) =>
          b.updated_at.localeCompare(a.updated_at)
        )
      );
      setCurrentStory(previous =>
        previous && previous.id === updated.id ? updated : previous
      );
    },
    // Deleting the open story leaves the board on somebody else's, or empties it
    // when that was the last one.
    onStoryDeleted: (story, remaining) => {
      setStories(remaining);

      if (currentStory?.id !== story.id) return;

      if (remaining.length > 0) {
        void loadStory(remaining[0]);
        return;
      }

      setCurrentStory(null);
      setNodes([]);
      setEdges([]);
      clearNotes();
    },
    onStoryImported: imported => {
      setStories(previous => [
        imported,
        ...previous.filter(other => other.id !== imported.id),
      ]);
      setCurrentStory(imported);
      setSelectedTab('graph');
    },
    // Restoring replaces the file under the whole app: everything read from the
    // old one is dropped, and the session's undo history goes with it, because
    // it describes rows that no longer exist.
    onDatabaseRestored: restored => {
      forgetHistory();
      forgetRememberedDrafts();
      forgetOtherStories();

      closeEditors();
      setSelectedCharacterId(null);
      setClosePrompt(false);
      setNodes([]);
      setEdges([]);
      clearNotes();
      setCharacters([]);
      setCastStats({});
      setTrashReloadToken(previous => previous + 1);

      setCurrentStory(null);
      setStories(restored);
    },
    onError: setActionError,
  });

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
        openSearch();
        return;
      }

      if (event.key === 'Escape' && searchOpen) {
        event.preventDefault();
        closeSearch();
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
    storyLevelsRef.current = storyLevels;
  }, [storyLevels]);

  useEffect(() => {
    castStatsRef.current = castStats;
  }, [castStats]);

  // The sync's Undo is a correction offered straight away; the toolbar and
  // shortcut keep the step after this prompt has gone.
  useEffect(() => {
    if (!syncedXpNotice) return;

    const timer = setTimeout(() => setSyncedXpNotice(null), 10000);
    return () => clearTimeout(timer);
  }, [syncedXpNotice]);

  useEffect(() => {
    if (!syncedStatNotice) return;

    const timer = setTimeout(() => setSyncedStatNotice(null), 10000);
    return () => clearTimeout(timer);
  }, [syncedStatNotice]);

  // Mark returned's Undo is a correction offered straight away; the toolbar and
  // shortcut keep the step after this prompt has gone.
  useEffect(() => {
    if (!returnedNotice) return;

    const timer = setTimeout(() => setReturnedNotice(null), 10000);
    return () => clearTimeout(timer);
  }, [returnedNotice]);

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

  // Everything a restore or a purge touches outside the tab belongs to the app
  // and is done here: the story list, the open story's cards, whichever sheet is
  // selected, and the history that an irreversible delete makes unsafe.
  const restoredFromTrash = async (item: DeletedItem) => {
    if (item.kind === 'story') {
      const loadedStories: Story[] = await storiesApi.getAllStories();
      setStories(loadedStories);
      return;
    }

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
  };

  // A purged cast member or card clears every node linked to it, and purging a
  // faction card clears the standings that named it, so the story is re-read
  // instead of being left pointing at a row that no longer exists.
  const purgedFromTrash = async (item: DeletedItem) => {
    if ((item.kind === 'character' || item.kind === 'node') && currentStory) {
      await loadStory(currentStory);
    }
  };

  const loadDemoStory = async () => {
    if (demoStoryBusy) return;

    setDemoStoryBusy(true);
    setActionError(null);

    try {
      const story: Story = await storiesApi.createDemoStory(actor);

      setStories(previous => [story, ...previous.filter(other => other.id !== story.id)]);
      setSelectedTab('graph');
      await loadStory(story);
      announceStory(`Loaded "${story.title}"`);
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
      abandonChapterDrafts();
      abandonNoteDrafts();

      await loadStory(story);
      announceStory(`Rebuilt "${story.title}" with its original sample data`);
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
      clearNotes();
      closeEditors();
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

  // Everything the Chapters tab and the chapter cards work out from the reading
  // order. The chapter logic itself lives in the narrative domain; these memos
  // only say when it is worth running again.

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
  // database decides the assignment (POV and cast rows) and the snapshot; this
  // key only says when that assignment has changed enough to ask again, without
  // refetching on every node drag.
  const chapterCastAssignmentsKey = useMemo(
    () =>
      chapterNodes
        .map(
          node =>
            `${node.id}:${node.data.chapterPov ?? ''}`
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
    storyLevels,
    storySkills,
    storySkillEvents,
  ]);

  const chapterCastByChapter = useMemo(
    () => castBadgesByChapter(storyChapterCastStates, castNames),
    [storyChapterCastStates, castNames]
  );

  // Each card's checklist, in the order the lines were written. The database
  // returns them that way already; grouping here only saves the card a filter.
  const chapterTasksByChapter = useMemo(() => {
    const byChapter = new Map<string, ChapterTask[]>();

    for (const task of storyChapterTasks) {
      const list = byChapter.get(task.chapter_id) ?? [];
      list.push(task);
      byChapter.set(task.chapter_id, list);
    }

    for (const list of byChapter.values()) {
      list.sort(
        (a, b) =>
          a.position - b.position || a.created_at.localeCompare(b.created_at)
      );
    }

    return byChapter;
  }, [storyChapterTasks]);

  // Each chapter's progression ledger, in the order it was logged, with the
  // actor's name resolved once so a card row needs no lookup of its own.
  const chapterEventsByChapter = useMemo(() => {
    const byChapter = new Map<string, ChapterEventRow[]>();

    for (const event of storyChapterEvents) {
      const list = byChapter.get(event.chapter_id) ?? [];
      list.push({
        ...event,
        actorName: castNames.get(event.actor_id) ?? 'Cast member in the trash',
      });
      byChapter.set(event.chapter_id, list);
    }

    for (const list of byChapter.values()) {
      list.sort(
        (a, b) =>
          a.position - b.position || a.created_at.localeCompare(b.created_at)
      );
    }

    return byChapter;
  }, [storyChapterEvents, castNames]);

  // Everybody a chapter card can name, as the card needs them: an id and a
  // name, not a whole sheet.
  const castChoices = useMemo(
    () => characters.map(character => ({ id: character.id, name: character.name })),
    [characters]
  );

  // The skills a scene's event can change, grouped by their owner. A chapter
  // card offers these in its + Event form, so a rank-up or a sacrifice names the
  // sheet row it acts on rather than a line of free text.
  const skillsByCharacter = useMemo(() => {
    const byCharacter: Record<string, ChapterSkillChoice[]> = {};

    for (const skill of storySkills) {
      (byCharacter[skill.character_id] ??= []).push({
        id: skill.id,
        name: skill.name,
        rank: skill.rank,
      });
    }

    for (const list of Object.values(byCharacter)) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    return byCharacter;
  }, [storySkills]);

  // The chapters placed on the day, which is the reading order by other means.
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
    const milestonesByCharacter = new Map<string, CharacterLevel[]>();

    for (const milestone of storyLevels) {
      if (!milestone.chapter_id || seqOf(milestone.chapter_id) == null) continue;
      const existing = milestonesByCharacter.get(milestone.character_id) ?? [];
      existing.push(milestone);
      milestonesByCharacter.set(milestone.character_id, existing);
    }

    milestonesByCharacter.forEach((milestones, characterId) => {
      const owner = castNames.get(characterId) ?? 'A cast member';
      const byChapter = new Map<string, CharacterLevel>();

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

    // The rule is what a level costs. A level the author recorded by hand states
    // a total, and that total was written against whatever the rule said then, so
    // where the two disagree it is the row that is out of step, not the ledger:
    // the ledger is what buys the level. The fix puts the curve's number on the
    // row, which is the one place a total is still typed.
    const crossingsByCast = crossingsByCharacter(
      characters,
      storyCharacterProgress,
      storyLevels,
      storyGrowthRules,
      chapterNodes
    );

    for (const character of characters) {
      const owner = castNames.get(character.id) ?? 'A cast member';
      const crossings = crossingsByCast[character.id] ?? [];

      for (const milestone of storyLevels) {
        if (milestone.character_id !== character.id) continue;
        if (milestone.xp == null) continue;

        const crossing = crossings.find(entry => entry.level === milestone.level);
        if (!crossing || crossing.xp === milestone.xp) continue;

        const chapterId = milestone.chapter_id ?? crossing.chapterId;
        const chapter = chapterId ? chapterById.get(chapterId) : undefined;
        if (!chapter) continue;

        const recorded = milestone.xp;
        const target: ProgressionTarget = { kind: 'level', milestoneId: milestone.id };
        const parts: ContinuityPart[] = [
          characterLink(character.id, owner, target),
          `'s level ${milestone.level} is recorded at ${formatCount(recorded)} XP in `,
          chapterLink(chapter.id, chapter.data.label, true),
          `, but this story's rule puts level ${milestone.level} at ${formatCount(
            crossing.xp
          )} XP.`,
        ];

        flags.push({
          id: `xp-income-${milestone.id}`,
          kind: 'xp-income-mismatch',
          chapterId: chapter.id,
          characterId: character.id,
          characterName: owner,
          ledgerXp: crossing.xp,
          summary: `${owner}'s level ${milestone.level} is recorded at ${formatCount(
            recorded
          )} XP, the rule says ${formatCount(crossing.xp)}`,
          detail: continuityText(parts),
          parts,
          target,
        });
      }
    }

    // A level-up records the value a stat reached. That snapshot is the number
    // the story says the sheet had, so a sheet that reads differently has
    // drifted from its own ledger: the value was edited on the sheet without a
    // level-up, the stat was renamed, or it was dropped. Only the last snapshot
    // for a stat counts, in reading order, because a later level-up supersedes
    // an earlier one. A stat the sheet holds that no level-up has recorded is
    // not a disagreement, only a number the story has not told yet.
    const lastStatSnapshots = new Map<
      string,
      {
        characterId: string;
        statName: string;
        milestone: CharacterLevel;
        value: number;
        chapter: (typeof chapterNodes)[number];
        seq: number;
      }
    >();

    for (const milestone of storyLevels) {
      const chapter = milestone.chapter_id
        ? chapterById.get(milestone.chapter_id)
        : undefined;
      const seq = seqOf(milestone.chapter_id);

      if (!chapter || seq == null) continue;

      for (const change of milestoneStatChanges(milestone)) {
        if (change.value_after == null) continue;

        // Case and spacing are the author's typing, not the stat's, so two
        // level-ups that spelled it differently hold one snapshot and the later
        // one still wins, rather than reading as two stats.
        const key = `${milestone.character_id}::${statKey(change.stat_name)}`;
        const previous = lastStatSnapshots.get(key);

        // One chapter can hold two level-ups, and the later entry wins there
        // too, so the warning and the sheet readout agree on which number is
        // the last one recorded.
        const outranked =
          previous != null &&
          (previous.seq > seq ||
            (previous.seq === seq &&
              (previous.milestone.created_at.localeCompare(milestone.created_at) > 0 ||
                (previous.milestone.created_at === milestone.created_at &&
                  previous.milestone.id.localeCompare(milestone.id) > 0))));

        if (outranked) continue;

        lastStatSnapshots.set(key, {
          characterId: milestone.character_id,
          statName: change.stat_name,
          milestone,
          value: change.value_after,
          chapter,
          seq,
        });
      }
    }

    lastStatSnapshots.forEach(snapshot => {
      const { characterId, statName, milestone, value, chapter } = snapshot;
      const owner = castNames.get(characterId);

      // A character in the trash has no sheet left to open, so there is nothing
      // to send the author to fix.
      if (!owner) return;

      const target: ProgressionTarget = { kind: 'level', milestoneId: milestone.id };
      const sheetStats = castStats[characterId] ?? [];
      // Spacing and case are not a disagreement, so the row is read loosely.
      const sheet = findSheetStat(sheetStats, statName);

      if (!sheet) {
        // A name the sheet does not have is usually one the author spelled
        // another way rather than a stat they lost, so the hint names the row
        // that is probably the same one. Nothing is written on that guess: two
        // names being one stat is the author's call.
        const renamed = likelyRenamedStat(sheetStats, statName);
        const parts: ContinuityPart[] = [
          characterLink(characterId, owner, target),
          `'s ${statName} was recorded as ${value} in `,
          chapterLink(chapter.id, chapter.data.label, true),
          renamed
            ? `, but the sheet has “${renamed}” — likely the same stat under another name.`
            : ', but the sheet no longer has that stat.',
        ];

        flags.push({
          id: `stat-missing-${milestone.id}-${statKey(statName)}`,
          kind: 'stat-missing-from-sheet',
          chapterId: chapter.id,
          characterId,
          characterName: owner,
          summary: renamed
            ? `${owner}'s ${statName} may be “${renamed}” on the sheet`
            : `${owner}'s ${statName} is recorded but not on the sheet`,
          detail: continuityText(parts),
          parts,
          target,
        });
        return;
      }

      // A stat also rises without a level-up: a stat award, or a point placed
      // from the level pool. Both are recorded rows, so the sheet is only in
      // disagreement when it says something the snapshot plus those gains does
      // not. Counting them is what keeps a placed point from reading as drift.
      const gainsSince =
        storyAwards.reduce((total, award) => {
          if (award.kind !== 'stat' || award.character_id !== characterId) return total;
          if (!award.stat_name || statKey(award.stat_name) !== statKey(statName)) {
            return total;
          }

          return award.created_at > milestone.created_at ? total + award.amount : total;
        }, 0) +
        storyGrowthPoints.reduce((total, point) => {
          if (point.character_id !== characterId) return total;
          if (statKey(point.stat_name) !== statKey(statName)) return total;

          return point.created_at > milestone.created_at ? total + point.amount : total;
        }, 0);

      const ledgerValue = value + gainsSince;

      if (sheet.value === ledgerValue) return;

      // The sheet's own spelling is the row the fix writes, because a stat is
      // written by name; the recorded spelling is named when it differs.
      const spelling = sheet.stat_name === statName ? '' : ` as “${statName}”`;
      const parts: ContinuityPart[] = [
        characterLink(characterId, owner, target),
        `'s ${sheet.stat_name} is ${sheet.value} on the sheet, but the level-up in `,
        chapterLink(chapter.id, chapter.data.label, true),
        ` recorded ${value}${spelling}${
          gainsSince > 0 ? ` plus ${formatCount(gainsSince)} awarded or placed since` : ''
        }.`,
      ];

      flags.push({
        id: `stat-${milestone.id}-${statKey(statName)}`,
        kind: 'stat-sheet-mismatch',
        chapterId: chapter.id,
        characterId,
        characterName: owner,
        statName: sheet.stat_name,
        statValue: ledgerValue,
        summary: `${owner}'s ${sheet.stat_name} is ${sheet.value}, ledger says ${ledgerValue}`,
        detail: continuityText(parts),
        parts,
        target,
      });
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
    characters,
    storyLevels,
    storyCharacterProgress,
    storyGrowthRules,
    storyGrowthPoints,
    storyAwards,
    storySkillEvents,
    storySkills,
    storySkillEvolutions,
    storyRelations,
    storyFactionStandings,
    nodes,
    castStats,
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
      // The sheet's panels hold the rows, so the app hands them the focus and the
      // panel that owns the row opens its editor: the fix starts in front of the
      // author rather than making them find the row by hand.
      const focusId =
        target.kind === 'level'
          ? target.milestoneId
          : target.kind === 'skill-event'
            ? target.eventId
            : target.kind === 'relation'
              ? target.relationId
              : target.kind === 'faction-standing'
                ? target.standingId
                : target.skillId;

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
    []
  );

  // A chapter card's cast badge opens that sheet as it stood in that chapter:
  // the tab and the character are the sheet's, and the chapter is the readout's.
  // The counter makes a second click on the same badge a fresh request, so the
  // readout reopens even when it was closed in between.
  const openChapterCastSheet = useCallback(
    (characterId: string, chapterId: string) => {
      openCharacterSheet(characterId);
      setChapterStateFocus(previous => ({
        characterId,
        chapterId,
        request: (previous?.request ?? 0) + 1,
      }));
    },
    [openCharacterSheet]
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

  useEffect(() => {
    if (quitPrompt) quitKeepWorkingRef.current?.focus();
  }, [quitPrompt]);

  // A chapter card's quest badge opens the ledger on that quest, the way a cast
  // badge opens a sheet. The ledger puts its filter back to every status and
  // scrolls the row into view; only the tab and the lit quest are the app's, and
  // every click is a fresh request so the same badge works twice.
  const openQuest = useCallback((questId: string) => {
    setSelectedTab('quests');
    setQuestFocus(previous => ({ questId, request: (previous?.request ?? 0) + 1 }));
  }, []);

  // A chapter card's inspector sends the author to the one place its roster is
  // edited. The Chapters tab renders the row that is opened, so the form is
  // opened after that render rather than against the tab that is leaving.
  const openChapterFromInspector = useCallback(
    (chapterId: string) => {
      setSelectedTab('chapters');
      window.setTimeout(() => revealChapter(chapterId), 0);
    },
    [revealChapter]
  );

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
      abandonChapterDrafts();
      setNotePrompt(null);
      void loadStory(story);
    };

    // A note draft lives in the notes panel, so its question is asked there. The
    // same answer drops a chapter edit too, if both were open.
    if (noteDraftIsDirty()) {
      askNoteQuestion(`Open “${story.title}” and drop these changes?`, openStory);
      return;
    }

    requestChapterLeave(`Open “${story.title}” and drop these changes?`, openStory);
  };

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

      finishChapterSave();
    } catch (e) {
      console.error('Failed to save chapter details:', e);
      setChapterError(`Could not save the chapter details: ${String(e)}`);
    } finally {
      setChapterBusy(false);
    }
  };

  // ---- the chapter card's own workbench ----------------------------------
  //
  // A chapter card on the board is where the scene is planned, so the work that
  // used to mean opening the Chapters tab happens on the card: writing the
  // scene's objectives, ticking them off, naming the POV, putting somebody in
  // the cast and paying out XP. Each write is the command the panels already
  // use, and each records the step that reverses it, so a stray click on the
  // board is one Ctrl+Z away like every other edit.

  const addChapterObjective = async (
    chapterId: string,
    text: string
  ): Promise<boolean> => {
    const trimmed = text.trim();
    if (!currentStory || !trimmed) return false;

    try {
      const created = await narrativeApi.addChapterTask(chapterId, trimmed, actor);
      setStoryChapterTasks(previous => [...previous, created]);

      // A rewritten line gets a new row, so the step remembers which row is
      // live: undo after a redo takes the rewritten line away, not the first.
      let liveId = created.id;

      recordStep({
        label: `Add the objective “${created.text}”`,
        undo: async () => {
          const removing = liveId;
          await narrativeApi.deleteChapterTask(removing, actor);
          setStoryChapterTasks(previous =>
            previous.filter(task => task.id !== removing)
          );
        },
        redo: async () => {
          const again = await narrativeApi.addChapterTask(chapterId, trimmed, actor);
          liveId = again.id;
          setStoryChapterTasks(previous => [...previous, again]);
        },
      });

      return true;
    } catch (e) {
      console.error('Failed to add an objective:', e);
      setActionError(`Could not add the objective: ${String(e)}`);
      return false;
    }
  };

  const toggleChapterObjective = async (task: ChapterTask) => {
    const write = (done: boolean) =>
      narrativeApi.setChapterTaskDone(task.id, done, actor).then(saved => {
        setStoryChapterTasks(previous =>
          previous.map(row => (row.id === saved.id ? saved : row))
        );
        return saved;
      });

    try {
      const saved = await write(!task.done);

      recordStep({
        label: saved.done
          ? `Tick off “${saved.text}”`
          : `Reopen “${saved.text}”`,
        undo: () => write(task.done),
        redo: () => write(saved.done),
      });
    } catch (e) {
      console.error('Failed to tick off an objective:', e);
      setActionError(`Could not change the objective: ${String(e)}`);
    }
  };

  const removeChapterObjective = async (task: ChapterTask) => {
    try {
      await narrativeApi.deleteChapterTask(task.id, actor);
      setStoryChapterTasks(previous => previous.filter(row => row.id !== task.id));

      let liveId = task.id;

      recordStep({
        label: `Drop the objective “${task.text}”`,
        undo: async () => {
          const again = await narrativeApi.addChapterTask(
            task.chapter_id,
            task.text,
            actor
          );
          // The line comes back at the end of the checklist: the row it had is
          // gone, and a restored objective is worth more than a restored order.
          if (task.done) await narrativeApi.setChapterTaskDone(again.id, true, actor);
          const restored = task.done
            ? { ...again, done: true }
            : again;
          liveId = again.id;
          setStoryChapterTasks(previous => [...previous, restored]);
        },
        redo: async () => {
          const removing = liveId;
          await narrativeApi.deleteChapterTask(removing, actor);
          setStoryChapterTasks(previous =>
            previous.filter(row => row.id !== removing)
          );
        },
      });
    } catch (e) {
      console.error('Failed to drop an objective:', e);
      setActionError(`Could not drop the objective: ${String(e)}`);
    }
  };

  // The point of view is a column on the chapter card, so it is written with the
  // chapter's other details rather than with the cast rows.
  const setChapterPovOnBoard = async (chapterId: string, pov: string | null) => {
    const node = nodes.find(row => row.id === chapterId);
    if (!node) return;

    const before = node.data.chapterPov ?? null;
    if (before === pov) return;

    const write = async (next: string | null) => {
      const updated: any = await narrativeApi.setChapterDetails(
        chapterId,
        node.data.chapterArc ?? null,
        node.data.chapterWords ?? null,
        node.data.chapterTarget ?? null,
        next,
        node.data.chapterDay ?? null,
        node.data.chapterTime ?? null,
        actor
      );

      setNodes(previous =>
        previous.map(row =>
          row.id === chapterId
            ? {
                ...row,
                data: { ...row.data, chapterPov: updated.chapter_pov ?? null },
              }
            : row
        )
      );
    };

    try {
      await write(pov);

      const who = characters.find(character => character.id === pov)?.name;

      recordStep({
        label: who
          ? `Make ${who} the POV of “${node.data.label}”`
          : `Clear the POV of “${node.data.label}”`,
        undo: () => write(before),
        redo: () => write(pov),
      });
    } catch (e) {
      console.error('Failed to change a chapter POV:', e);
      setActionError(`Could not change the point of view: ${String(e)}`);
    }
  };

  // A name on the card's roster is one row in the chapter's cast. The POV is
  // always present and is not a row, so it is written above instead.
  const setChapterCastOnBoard = async (
    chapterId: string,
    characterId: string,
    present: boolean
  ) => {
    const existing = storyChapterCast.find(
      member =>
        member.chapter_id === chapterId && member.character_id === characterId
    );

    if (present === Boolean(existing)) return;

    const chapterLabel =
      nodes.find(row => row.id === chapterId)?.data.label ?? 'the chapter';
    const name = characters.find(character => character.id === characterId)?.name ?? 'Cast member';

    try {
      if (present) {
        const created = await narrativeApi.addChapterCastMember(
          chapterId,
          characterId,
          actor
        );
        setStoryChapterCast(previous =>
          previous.some(member => member.id === created.id)
            ? previous
            : [...previous, created]
        );

        let liveId = created.id;

        recordStep({
          label: `Add ${name} to “${chapterLabel}”`,
          undo: async () => {
            const removing = liveId;
            await narrativeApi.removeChapterCastMember(removing, actor);
            setStoryChapterCast(previous =>
              previous.filter(member => member.id !== removing)
            );
          },
          redo: async () => {
            const again = await narrativeApi.addChapterCastMember(
              chapterId,
              characterId,
              actor
            );
            liveId = again.id;
            setStoryChapterCast(previous => [...previous, again]);
          },
        });
      } else if (existing) {
        await narrativeApi.removeChapterCastMember(existing.id, actor);
        setStoryChapterCast(previous =>
          previous.filter(member => member.id !== existing.id)
        );

        let liveId = existing.id;

        recordStep({
          label: `Take ${name} out of “${chapterLabel}”`,
          undo: async () => {
            const again = await narrativeApi.addChapterCastMember(
              chapterId,
              characterId,
              actor
            );
            liveId = again.id;
            setStoryChapterCast(previous => [...previous, again]);
          },
          redo: async () => {
            const removing = liveId;
            await narrativeApi.removeChapterCastMember(removing, actor);
            setStoryChapterCast(previous =>
              previous.filter(member => member.id !== removing)
            );
          },
        });
      }
    } catch (e) {
      console.error('Failed to change a chapter cast:', e);
      setActionError(`Could not change the cast: ${String(e)}`);
    }
  };

  // A scene's progression is one ledger. XP, a learned skill and an acquired
  // item write their real row through the same commands the sheets use, so the
  // income, the curve's levels and the badges follow immediately; a rank-up, an
  // evolution and a sacrifice are the scene's own record. Each write is one
  // history step, and the step keeps the live event id so undo after a redo takes
  // back the row the redo wrote.
  const refreshAfterChapterEvent = async (event: ChapterEvent) => {
    if (!currentStory) return;

    if (
      event.event_type === 'skill_learn' ||
      event.event_type === 'skill_rank_up' ||
      event.event_type === 'skill_evolve' ||
      event.event_type === 'skill_sacrifice'
    ) {
      setStorySkills(await skillsApi.getStorySkills(currentStory.id));
      setStorySkillEvents(
        await skillsApi.getStorySkillEvents(currentStory.id)
      );
    }

    if (event.event_type === 'item_acquire') {
      setStoryInventory(await inventoryApi.getStoryInventory(currentStory.id));
    }

    if (event.event_type === 'xp_award' || event.event_type === 'skill_learn') {
      await reloadProgressionNumbers(event.actor_id);
    }
  };

  const addChapterEvent = async (
    chapterId: string,
    actorId: string,
    eventType: ChapterEventType,
    details: string,
    amount: number | null,
    skillId: string | null,
    keepBaseSkill: boolean,
    keepOnSheet: boolean
  ): Promise<boolean> => {
    const write = async () => {
      const created = await narrativeApi.addChapterEvent(
        chapterId,
        actorId,
        eventType,
        details,
        amount,
        skillId,
        keepBaseSkill,
        keepOnSheet,
        actor
      );

      setStoryChapterEvents(previous => [...previous, created]);
      await refreshAfterChapterEvent(created);

      return created;
    };

    let liveId = '';

    try {
      const created = await write();
      liveId = created.id;

      recordStep({
        label: `Log ${chapterEventLabel(created)}`,
        undo: async () => {
          const removing = liveId;
          if (!removing) return;

          await narrativeApi.deleteChapterEvent(removing, actor);
          setStoryChapterEvents(previous =>
            previous.filter(event => event.id !== removing)
          );
          await refreshAfterChapterEvent(created);
        },
        redo: async () => {
          const again = await write();
          liveId = again.id;
        },
      });

      return true;
    } catch (e) {
      console.error('Failed to log a chapter event:', e);
      setActionError(`Could not log the event: ${String(e)}`);
      return false;
    }
  };

  const removeChapterEvent = async (event: ChapterEventRow) => {
    const remove = async () => {
      await narrativeApi.deleteChapterEvent(event.id, actor);
      setStoryChapterEvents(previous =>
        previous.filter(row => row.id !== event.id)
      );
      await refreshAfterChapterEvent(event);
    };

    try {
      await remove();

      // A re-add writes a new row, so the step remembers which one is live.
      let liveId = event.id;

      recordStep({
        label: `Remove ${chapterEventLabel(event)}`,
        undo: async () => {
          const again = await narrativeApi.addChapterEvent(
            event.chapter_id,
            event.actor_id,
            event.event_type,
            event.details,
            event.amount,
            event.skill_id ?? null,
            event.keep_base_skill ?? true,
            event.keep_on_sheet ?? false,
            actor
          );
          liveId = again.id;
          setStoryChapterEvents(previous => [...previous, again]);
          await refreshAfterChapterEvent(again);
        },
        redo: async () => {
          const removing = liveId;
          await narrativeApi.deleteChapterEvent(removing, actor);
          setStoryChapterEvents(previous =>
            previous.filter(row => row.id !== removing)
          );
          await refreshAfterChapterEvent(event);
        },
      });
    } catch (e) {
      console.error('Failed to remove a chapter event:', e);
      setActionError(`Could not remove the event: ${String(e)}`);
    }
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
    focusDraftField();
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

  // A note card on the canvas is a way into the note, not another copy of it: the
  // Chapters tab opens with that chapter's notes showing and the card's note lit.
  const openNoteFromGraph = useCallback(
    (chapterId: string, noteId: string | null) => {
      setSelectedTab('chapters');
      openChapterNotes(chapterId, noteId);
    },
    [openChapterNotes]
  );

  // Which node the pointer is over, read from the card the event landed on.
  // React Flow puts `data-id` on each node's wrapper, so no geometry is needed.
  const nodeUnderPointer = (event: React.DragEvent<HTMLDivElement>) => {
    const wrapper = (event.target as HTMLElement | null)?.closest?.('.react-flow__node');
    const id = wrapper?.getAttribute('data-id') ?? null;

    return id && nodes.some(node => node.id === id) ? id : null;
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
      closeSearch();

      const message =
        changingStory && targetStory
          ? `Open “${targetStory.title}” and drop these changes?`
          : 'Leave Chapters and drop these changes?';

      // The answer drops every draft this panel could be holding, then the
      // result is followed with the question already behind it.
      const go = () => {
        abandonChapterDrafts();
        abandonNoteDrafts();
        void chooseSearchResult(result, true);
      };

      if (noteDraftIsDirty()) askNoteQuestion(message, go);
      else askToLeaveChapter(message, go);

      return;
    }

    closeSearch();
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
      closeEditors();

      if (result.chapterId) openChapterNotes(result.chapterId, result.targetId);
      return;
    }

    if (result.kind === 'node') {
      setRenameOffer(null);
      openNode({
        id: result.targetId,
        label: result.label,
        content: result.content,
      });
      panCanvas(result.x, result.y);
      return;
    }

    // A connection opens in its editor rather than only moving the view, so the
    // palette can be used to change a link as well as to look at it.
    openEdge({
      id: result.targetId,
      label: result.edgeLabel,
      relationType: result.edgeRelation,
    });
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

      // A chapter's cast is its point of view and its cast rows, so dropping a
      // cast member on a chapter card adds them to the scene rather than binding
      // the card to one person: the roster, not the card, is what names them.
      if (target.data.nodeType === 'chapter') {
        const already = storyChapterCast.some(
          row => row.chapter_id === target.id && row.character_id === character.id
        );

        if (already) {
          openNode({
            id: target.id,
            label: target.data.label,
            content: target.data.content,
          });
          return;
        }

        try {
          const member: ChapterCastMember = await narrativeApi.addChapterCastMember(
            target.id,
            character.id,
            actor
          );
          let currentCastId = member.id;

          setStoryChapterCast(previous =>
            previous.some(row => row.id === member.id) ? previous : [...previous, member]
          );

          recordStep({
            label: `Add ${character.name} to “${target.data.label}”`,
            undo: async () => {
              await narrativeApi.removeChapterCastMember(currentCastId, actor);
              setStoryChapterCast(previous =>
                previous.filter(row => row.id !== currentCastId)
              );
            },
            redo: async () => {
              const again: ChapterCastMember = await narrativeApi.addChapterCastMember(
                target.id,
                character.id,
                actor
              );
              currentCastId = again.id;
              setStoryChapterCast(previous =>
                previous.some(row => row.id === again.id) ? previous : [...previous, again]
              );
            },
          });

          openNode({
            id: target.id,
            label: target.data.label,
            content: target.data.content,
          });
        } catch (e) {
          console.error('Failed to add a cast member to a chapter:', e);
          setActionError(
            `Could not add ${character.name} to “${target.data.label}”: ${String(e)}`
          );
        }

        return;
      }

      // Already pointing at this member, so the drop changes nothing; opening it
      // still tells the person the card landed.
      if (target.data.characterId === character.id) {
        openNode({
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

        openNode({
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
      openNode({
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
            className: edgeKindClass('cast'),
            label: 'cast',
            data: { createdBy: actor, label: 'cast', relationType: 'cast' },
          };

          closeEdge();
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

            closeEdge();
            setEdges(eds =>
              addEdge(
                {
                  id: newDbEdge.id,
                  source: fromNodeId,
                  target: toNodeId,
                  className: edgeKindClass('skill'),
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
          className: edgeKindClass(null),
          label: '',
          data: {
            createdBy: actor,
          },
        };

        closeEdge();

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
      cardsRemoved(removedIds);
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
      edgesRemoved(removedIds);

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
  const rememberStat = useCallback((stat: CharacterStat) => {
    setCastStats(previous => {
      const current = previous[stat.character_id] ?? [];

      return {
        ...previous,
        [stat.character_id]: [...current.filter(other => other.id !== stat.id), stat].sort(
          (a, b) => a.stat_name.localeCompare(b.stat_name)
        ),
      };
    });
  }, []);

  // The linked cast member's own numbers, the row open for editing and the line
  // an error is written on live in the canvas domain. It is called here because
  // the handler that reaches the story-wide badges is what it is handed: a saved
  // stat has to move the badge on every card, not only this panel.
  const {
    inspectorCharacter,
    inspectorStats,
    inspectorAttributes,
    inspectorStatId,
    setInspectorStatId,
    inspectorStatValue,
    setInspectorStatValue,
    startInspectorStat,
    saveInspectorStat,
    inspectorAttrId,
    setInspectorAttrId,
    inspectorAttrValue,
    setInspectorAttrValue,
    startInspectorAttribute,
    saveInspectorAttribute,
    inspectorError,
    reportInspectorError,
  } = useCanvasInspector({
    linkedCharacterId: selectedNode?.data.characterId ?? null,
    characters,
    rememberStat,
    actor,
  });

  // A saved stat reaches both places at once: the sheet's own list, which the
  // stat read fills, and the story-wide map the canvas badges are drawn from.
  const applyWrittenStat = useCallback(
    (stat: CharacterStat) => {
      setCharacterStats(previous =>
        [...previous.filter(other => other.id !== stat.id), stat].sort((a, b) =>
          a.stat_name.localeCompare(b.stat_name)
        )
      );
      rememberStat(stat);
    },
    [rememberStat]
  );

  const saveAttribute = async (
    attribute: CharacterAttribute,
    value: string
  ): Promise<boolean> => {
    if (!selectedCharacterId) return false;

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
      return true;
    } catch (e) {
      console.error('Failed to save attribute:', e);
      setCharacterError(`Could not save attribute: ${String(e)}`);
      return false;
    }
  };

  const addAttribute = async (name: string, value: string): Promise<boolean> => {
    if (!selectedCharacterId) return false;

    setCharacterError(null);

    try {
      // Setting a name that already exists updates it, like stats do.
      const saved: CharacterAttribute = await charactersApi.setCharacterAttribute(
        selectedCharacterId,
        name,
        value,
        actor
      );

      setCharacterAttributes(prev =>
        [...prev.filter(other => other.id !== saved.id), saved].sort((a, b) =>
          a.attr_name.localeCompare(b.attr_name)
        )
      );
      return true;
    } catch (e) {
      console.error('Failed to add attribute:', e);
      setCharacterError(`Could not add attribute: ${String(e)}`);
      return false;
    }
  };

  const removeAttribute = async (
    attribute: CharacterAttribute
  ): Promise<boolean> => {
    setCharacterError(null);

    try {
      await charactersApi.deleteCharacterAttribute(attribute.id, actor);
      setCharacterAttributes(prev => prev.filter(other => other.id !== attribute.id));
      return true;
    } catch (e) {
      console.error('Failed to delete attribute:', e);
      setCharacterError(`Could not delete attribute: ${String(e)}`);
      return false;
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

      followStoredRows({
        nodes: [{ id: saved.node_id, label: saved.name, content: saved.effect ?? null }],
        edges: [],
      });
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

  // The card the holder form is filling. Only a skill card has holders, so a
  // drawer showing anything else leaves the form with no card to add to.
  const skillHolderCard =
    selectedNode?.data.nodeType === 'skill'
      ? {
          id: selectedNode.id,
          label: selectedNode.data.label,
          content: selectedNode.data.content ?? null,
        }
      : null;

  // A holder added from a card is listed by the board and, when it is the open
  // sheet's own character who learns it, by the sheet's list as well.
  const applyHolderAdded = (saved: CharacterSkill) => {
    const ordered = (list: CharacterSkill[]) =>
      [...list.filter(other => other.id !== saved.id), saved].sort((a, b) =>
        a.name.localeCompare(b.name)
      );

    setStorySkills(ordered);
    if (saved.character_id === selectedCharacterId) setCharacterSkills(ordered);
  };

  // The three answers, the line and the write behind the holder form live in the
  // canvas domain. The card is handed over rather than looked up in the board,
  // and the row that comes back is what the app lists.
  const {
    skillHolderCharacterId,
    setSkillHolderCharacterId,
    skillHolderRank,
    setSkillHolderRank,
    skillHolderChapterId,
    setSkillHolderChapterId,
    skillHolderError,
    setSkillHolderError,
    savingSkillHolder,
    addSkillHolder,
  } = useSkillHolderForm({
    card: skillHolderCard,
    onHolderAdded: applyHolderAdded,
    actor,
  });

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
        if (selectedEdgeId === matchingEdge.id) closeEdge();
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
                  event.level_record_id ?? null,
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

  // A milestone records where the curve put a level; it does not decide what the
  // level is. The level lives on the cast row, worked out from the ledger and the
  // rule, so writing a timeline row leaves the cast alone and the row is read back
  // from the database when a write could have moved it.
  const applyMilestoneList = useCallback((next: CharacterLevel[]) => {
    storyLevelsRef.current = next;
    setStoryLevels(next);
  }, []);

  const applyLevelMilestone = useCallback(
    (saved: CharacterLevel) => {
      const next = [
        ...storyLevelsRef.current.filter(
          milestone => milestone.id !== saved.id
        ),
        saved,
      ].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
      );

      applyMilestoneList(next);
    },
    [applyMilestoneList]
  );

  // The chapter ledger and a total-XP milestone can disagree. Recording the
  // ledger's sum on the milestone goes through the same audited command as the
  // sheet's editor, and the step keeps an Undo for the old total.
  const syncMilestoneXp = useCallback(
    async (flag: ChapterContinuityFlag) => {
      if (flag.target.kind !== 'level' || flag.ledgerXp == null) return;

      const ledgerXp = flag.ledgerXp;
      const targetMilestoneId = flag.target.milestoneId;
      const milestone = storyLevelsRef.current.find(
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
          storyLevelsRef.current.find(candidate => candidate.id === milestoneId) ??
          milestone;
        const saved: CharacterLevel = await progressionApi.updateCharacterLevel(
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

  // A sheet and the last level-up can disagree on a number. Recording the
  // level-up's value on the sheet goes through the same audited stat command the
  // sheet's own editor runs, and the step keeps the value the sheet had before,
  // so the correction comes back with one Undo.
  const syncSheetStat = useCallback(
    async (flag: ChapterContinuityFlag) => {
      if (
        flag.kind !== 'stat-sheet-mismatch' ||
        !flag.statName ||
        flag.statValue == null
      ) {
        return;
      }

      const characterId = flag.characterId;
      const statName = flag.statName;
      const recorded = flag.statValue;
      const key = `${characterId}::${statName}`;
      const sheetStat = findSheetStat(castStatsRef.current[characterId] ?? [], statName);

      if (!sheetStat || sheetStat.value === recorded) return;

      const previousValue = sheetStat.value;
      setActionError(null);
      setSyncingStatKey(key);

      // Read the row when the step runs, so its notes — the only other field on
      // a stat — are not put back from whenever the button was pressed.
      const writeValue = (value: number) => async () => {
        const current = findSheetStat(
          castStatsRef.current[characterId] ?? [],
          statName
        );
        const saved: CharacterStat = await charactersApi.setCharacterStat(
          characterId,
          statName,
          value,
          current?.notes ?? null,
          actor
        );

        applyWrittenStat(saved);
        return saved;
      };

      try {
        await writeValue(recorded)();
        recordStep({
          label: `Match ${flag.characterName}'s ${statName} to the ledger`,
          undo: writeValue(previousValue),
          redo: writeValue(recorded),
        });
        setSyncedStatNotice({
          characterName: flag.characterName,
          statName,
          value: recorded,
        });
      } catch (e) {
        console.error('Failed to sync a sheet stat:', e);
        setActionError(`Could not sync ${flag.characterName}'s ${statName}: ${String(e)}`);
      } finally {
        setSyncingStatKey(null);
      }
    },
    [actor, applyWrittenStat, recordStep]
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

  const addRelation = async (
    otherId: string,
    draft: RelationDraft
  ): Promise<boolean> => {
    if (!selectedCharacterId) return false;

    const kind = draft.kind.trim();

    if (!kind) {
      setCharacterError('A relation needs a kind.');
      return false;
    }

    if (!otherId) {
      setCharacterError('Choose the cast member the relation joins.');
      return false;
    }

    setCharacterError(null);

    try {
      const saved: CharacterRelation = await relationsApi.addRelation(
        selectedCharacterId,
        otherId,
        kind,
        draft.note.trim() || null,
        draft.sinceChapterId || null,
        null,
        actor
      );

      applyRelation(saved);
      return true;
    } catch (e) {
      console.error('Failed to add a relation:', e);
      setCharacterError(`Could not add the relation: ${String(e)}`);
      return false;
    }
  };

  const saveRelation = async (
    relation: CharacterRelation,
    draft: RelationDraft
  ): Promise<boolean> => {
    const kind = draft.kind.trim();

    if (!kind) {
      setCharacterError('A relation needs a kind.');
      return false;
    }

    setCharacterError(null);

    const note = draft.note.trim() || null;
    const sinceChapterId = draft.sinceChapterId || null;
    const untilChapterId = draft.untilChapterId || null;

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
                // The verb decides whether the line is a structural one or a
                // quiet thread, so a renamed connection is redrawn as what it
                // now is.
                className: edgeKindClass(updated.relation_type),
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
      followStoredRows({
        nodes: [],
        edges: [
          {
            id: matchingEdge.id,
            label: updated.label ?? null,
            relation_type: updated.relation_type ?? null,
          },
        ],
      });
    };

    try {
      await writeRelation({ kind, note, sinceChapterId, untilChapterId });
      if (edgeNeedsWrite) await writeEdge(nextEdgeLabel, kind);

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

      return true;
    } catch (e) {
      console.error('Failed to save a relation:', e);
      setCharacterError(`Could not save the relation: ${String(e)}`);
      return false;
    }
  };

  const removeRelation = async (
    relation: CharacterRelation
  ): Promise<boolean> => {
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
        if (selectedEdgeId === matchingEdge.id) closeEdge();
      }

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

      return true;
    } catch (e) {
      console.error('Failed to delete a relation:', e);
      setCharacterError(`Could not delete the relation: ${String(e)}`);
      return false;
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

  // The two standing forms hand over what was chosen; the app decides what a
  // standing needs and answers whether the row was written.
  const addStanding = async (draft: StandingDraft): Promise<boolean> => {
    if (!selectedCharacterId) return false;

    const standing = draft.standing.trim();

    if (!draft.factionId) {
      setCharacterError('Choose the faction this standing belongs to.');
      return false;
    }

    if (!standing) {
      setCharacterError('A faction standing needs a word for it.');
      return false;
    }

    if (!draft.sinceChapterId) {
      setCharacterError('A faction standing needs the chapter it began in.');
      return false;
    }

    setCharacterError(null);

    try {
      const saved: FactionStanding = await relationsApi.addFactionStanding(
        selectedCharacterId,
        draft.factionId,
        standing,
        draft.note.trim() || null,
        draft.sinceChapterId,
        null,
        actor
      );

      applyStanding(saved);
      return true;
    } catch (e) {
      console.error('Failed to add a faction standing:', e);
      setCharacterError(`Could not add the faction standing: ${String(e)}`);
      return false;
    }
  };

  const saveStanding = async (
    standing: FactionStanding,
    draft: StandingDraft
  ): Promise<boolean> => {
    const text = draft.standing.trim();

    if (!draft.factionId) {
      setCharacterError('Choose the faction this standing belongs to.');
      return false;
    }

    if (!text) {
      setCharacterError('A faction standing needs a word for it.');
      return false;
    }

    if (!draft.sinceChapterId) {
      setCharacterError('A faction standing needs the chapter it began in.');
      return false;
    }

    setCharacterError(null);

    try {
      const saved: FactionStanding = await relationsApi.updateFactionStanding(
        standing.id,
        draft.factionId,
        text,
        draft.note.trim() || null,
        draft.sinceChapterId,
        draft.untilChapterId || null,
        actor
      );

      applyStanding(saved);
      return true;
    } catch (e) {
      console.error('Failed to save a faction standing:', e);
      setCharacterError(`Could not save the faction standing: ${String(e)}`);
      return false;
    }
  };

  const removeStanding = async (
    standing: FactionStanding
  ): Promise<boolean> => {
    setCharacterError(null);

    try {
      await relationsApi.deleteFactionStanding(standing.id, actor);
      setStoryFactionStandings(previous =>
        previous.filter(other => other.id !== standing.id)
      );
      return true;
    } catch (e) {
      console.error('Failed to delete a faction standing:', e);
      setCharacterError(`Could not delete the faction standing: ${String(e)}`);
      return false;
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

  const saveXpEntry = async (
    entry: CharacterProgress,
    draft: XpEntryDraft
  ): Promise<boolean> => {
    if (!draft.chapterId) {
      setCharacterError('XP earned needs a chapter.');
      return false;
    }

    const xpEarned = xpEntryAmount(draft.xp);
    if (xpEarned === null) return false;

    setCharacterError(null);

    try {
      const saved: CharacterProgress = await progressionApi.updateCharacterProgress(
        entry.id,
        draft.chapterId,
        xpEarned,
        actor
      );

      applyXpEntry(saved);
      await reloadProgressionNumbers(entry.character_id);
      return true;
    } catch (e) {
      console.error('Failed to save XP income:', e);
      setCharacterError(`Could not save XP earned: ${String(e)}`);
      return false;
    }
  };

  const addXpEntry = async (draft: XpEntryDraft): Promise<boolean> => {
    if (!selectedCharacterId) return false;

    if (!draft.chapterId) {
      setCharacterError('XP earned needs a chapter.');
      return false;
    }

    const xpEarned = xpEntryAmount(draft.xp);
    if (xpEarned === null) return false;

    setCharacterError(null);

    try {
      const saved: CharacterProgress = await progressionApi.addCharacterProgress(
        selectedCharacterId,
        draft.chapterId,
        xpEarned,
        actor
      );

      applyXpEntry(saved);
      await reloadProgressionNumbers(selectedCharacterId);
      return true;
    } catch (e) {
      console.error('Failed to add XP income:', e);
      setCharacterError(`Could not add XP earned: ${String(e)}`);
      return false;
    }
  };

  const removeXpEntry = async (entry: CharacterProgress): Promise<boolean> => {
    setCharacterError(null);

    try {
      await progressionApi.deleteCharacterProgress(entry.id, actor);
      setStoryCharacterProgress(previous =>
        previous.filter(other => other.id !== entry.id)
      );
      await reloadProgressionNumbers(entry.character_id);
      return true;
    } catch (e) {
      console.error('Failed to delete XP income:', e);
      setCharacterError(`Could not delete XP earned: ${String(e)}`);
      return false;
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

  // The two item forms hand over what was typed; the app decides what a name, a
  // quantity and a link are, and answers whether the row was written.
  const itemFields = (draft: InventoryDraft): {
    name: string;
    rarity: string | null;
    quantity: number;
    effect: string | null;
    chapterId: string | null;
    lostChapterId: string | null;
    nodeId: string | null;
  } | null => {
    const name = draft.name.trim();

    if (!name) {
      setCharacterError('An item needs a name — delete it to remove it.');
      return null;
    }

    const quantity = parseCount(draft.quantity);

    if (quantity === null) {
      setCharacterError('An item needs a whole-number quantity, zero or more.');
      return null;
    }

    return {
      name,
      rarity: draft.rarity.trim() || null,
      quantity,
      effect: draft.effect.trim() || null,
      chapterId: draft.chapterId || null,
      lostChapterId: draft.lostChapterId || null,
      nodeId: draft.nodeId || null,
    };
  };

  const saveItem = async (
    item: InventoryItem,
    draft: InventoryDraft
  ): Promise<boolean> => {
    const fields = itemFields(draft);

    if (!fields) return false;

    setCharacterError(null);

    try {
      const updated: InventoryItem = await inventoryApi.updateInventoryItem(
        item.id,
        fields.name,
        fields.rarity,
        fields.quantity,
        fields.effect,
        fields.chapterId,
        fields.lostChapterId,
        fields.nodeId,
        actor
      );

      applyInventoryItem(updated);
      return true;
    } catch (e) {
      console.error('Failed to save item:', e);
      setCharacterError(`Could not save item: ${String(e)}`);
      return false;
    }
  };

  const addItem = async (draft: InventoryDraft): Promise<boolean> => {
    if (!selectedCharacterId || !draft.name.trim()) return false;

    const fields = itemFields(draft);

    if (!fields) return false;

    setCharacterError(null);

    try {
      const saved: InventoryItem = await inventoryApi.addInventoryItem(
        selectedCharacterId,
        fields.name,
        fields.rarity,
        fields.quantity,
        fields.effect,
        fields.chapterId,
        fields.lostChapterId,
        fields.nodeId,
        actor
      );

      applyInventoryItem(saved);
      return true;
    } catch (e) {
      console.error('Failed to add item:', e);
      setCharacterError(`Could not add item: ${String(e)}`);
      return false;
    }
  };

  const removeItem = async (item: InventoryItem): Promise<boolean> => {
    setCharacterError(null);

    try {
      await inventoryApi.deleteInventoryItem(item.id, actor);
      setCharacterInventory(prev => prev.filter(other => other.id !== item.id));
      setStoryInventory(prev => prev.filter(other => other.id !== item.id));
      return true;
    } catch (e) {
      console.error('Failed to delete item:', e);
      setCharacterError(`Could not delete item: ${String(e)}`);
      return false;
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

  const saveCurrency = async (
    currency: CharacterCurrency,
    nameText: string,
    amountText: string
  ): Promise<boolean> => {
    const name = nameText.trim();

    if (!name) {
      setCharacterError('A currency needs a name — delete it to remove it.');
      return false;
    }

    const amount = parseCount(amountText);

    if (amount === null) {
      setCharacterError('A currency amount must be a whole number, zero or more.');
      return false;
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
      return true;
    } catch (e) {
      console.error('Failed to save currency:', e);
      setCharacterError(`Could not save currency: ${String(e)}`);
      return false;
    }
  };

  const addCurrency = async (
    nameText: string,
    amountText: string
  ): Promise<boolean> => {
    if (!selectedCharacterId || !nameText.trim()) return false;

    const amount = parseCount(amountText);

    if (amount === null) {
      setCharacterError('A currency amount must be a whole number, zero or more.');
      return false;
    }

    setCharacterError(null);

    try {
      const saved: CharacterCurrency = await inventoryApi.addCurrency(
        selectedCharacterId,
        nameText.trim(),
        amount,
        actor
      );

      applyCurrency(saved);
      return true;
    } catch (e) {
      console.error('Failed to add currency:', e);
      setCharacterError(`Could not add currency: ${String(e)}`);
      return false;
    }
  };

  const removeCurrency = async (
    currency: CharacterCurrency
  ): Promise<boolean> => {
    setCharacterError(null);

    try {
      await inventoryApi.deleteCurrency(currency.id, actor);
      setCharacterCurrency(prev => prev.filter(other => other.id !== currency.id));
      return true;
    } catch (e) {
      console.error('Failed to delete currency:', e);
      setCharacterError(`Could not delete currency: ${String(e)}`);
      return false;
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
      setStoryLevels(previous =>
        previous.filter(milestone => milestone.character_id !== removedId)
      );
      setStoryGrowthPoints(previous =>
        previous.filter(point => point.character_id !== removedId)
      );
      setEditingCharacter(false);
    } catch (e) {
      console.error('Failed to delete character:', e);
      setCharacterError(`Could not delete character: ${String(e)}`);
    }
  };

  // Only one editor is open at a time: picking a card closes the connection
  // editor, because both occupy the same corner of the canvas.
  const selectNode = useCallback(
    (_event: React.MouseEvent, node: Node<NodeData>) => {
      openNode({ id: node.id, label: node.data.label, content: node.data.content });
      setRenameOffer(null);
    },
    [openNode]
  );

  const selectEdge = useCallback(
    (_event: React.MouseEvent, edge: Edge<EdgeData>) => {
      openEdge({
        id: edge.id,
        label: edge.data?.label ?? null,
        relationType: edge.data?.relationType ?? null,
      });
      setRenameOffer(null);
    },
    [openEdge]
  );

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
        dismissNode();
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
        dismissNode();
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
                // The verb decides whether the line is a structural one or a
                // quiet thread, so a renamed connection is redrawn as what it
                // now is.
                className: edgeKindClass(updated.relation_type),
                data: {
                  createdBy: edge.data?.createdBy ?? actor,
                  label: updated.label ?? undefined,
                  relationType: updated.relation_type ?? undefined,
                },
              }
            : edge
        )
      );

      followStoredRows({
        nodes: [],
        edges: [
          {
            id: updated.id,
            label: updated.label ?? null,
            relation_type: updated.relation_type ?? null,
          },
        ],
      });
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

    reportInspectorError(null);
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
      reportInspectorError(`Could not link the cast member: ${String(e)}`);
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

    reportInspectorError(null);

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
        rememberLabelWritten(node.id, updated.label);
      }
      setRenameOffer(null);
    } catch (e) {
      console.error('Failed to rename a relinked node:', e);
      reportInspectorError(`Could not rename the node: ${String(e)}`);
    }
  };

  const handleNodesChange = useCallback(
    (changes: any[]) => {
      onNodesChange(changes);
    },
    [onNodesChange]
  );

  // A search looks at everything a result is made of — a card's label, notes,
  // type and cast member; a character's name and description; both ends of a
  // connection; a story's title and description — so it can be found the way a
  // person remembers it rather than only by its exact name. A result whose
  // name matched is listed before one found only by its notes or description.
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
      const chapterTasks = chapterTasksByChapter.get(node.id) ?? [];
      const chapterEvents = chapterEventsByChapter.get(node.id) ?? [];
      const isChapterCard = node.data.nodeType === 'chapter';
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
        !isChapterCard &&
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
          ...(chapterCast.length > 0
            ? {
                chapterCast,
                onOpenChapterCast: (characterId: string) =>
                  openChapterCastSheet(characterId, node.id),
              }
            : {}),
          // A chapter card is a workbench: the roster, the scene's checklist and
          // a quick XP award are written on the card itself, so planning a scene
          // does not mean leaving the board.
          ...(isChapterCard
            ? {
                chapterTasks,
                castChoices,
                onSetChapterPov: (pov: string | null) =>
                  void setChapterPovOnBoard(node.id, pov),
                onAddChapterCast: (characterId: string) =>
                  void setChapterCastOnBoard(node.id, characterId, true),
                onRemoveChapterCast: (characterId: string) =>
                  void setChapterCastOnBoard(node.id, characterId, false),
                onAddChapterObjective: (text: string) =>
                  addChapterObjective(node.id, text),
                onToggleChapterObjective: (task: ChapterTask) =>
                  void toggleChapterObjective(task),
                onRemoveChapterObjective: (task: ChapterTask) =>
                  void removeChapterObjective(task),
                chapterEvents,
                chapterSkills: skillsByCharacter,
                onAddChapterEvent: (
                  actorId: string,
                  eventType: ChapterEventType,
                  details: string,
                  amount: number | null,
                  skillId: string | null,
                  keepBaseSkill: boolean,
                  keepOnSheet: boolean
                ) =>
                  addChapterEvent(
                    node.id,
                    actorId,
                    eventType,
                    details,
                    amount,
                    skillId,
                    keepBaseSkill,
                    keepOnSheet
                  ),
                onDeleteChapterEvent: (event: ChapterEventRow) =>
                  void removeChapterEvent(event),
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
                onSyncSheetStat: syncSheetStat,
                syncingStatKey,
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
    chapterTasksByChapter,
    chapterEventsByChapter,
    castChoices,
    skillsByCharacter,
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
    openChapterCastSheet,
    setChapterPovOnBoard,
    setChapterCastOnBoard,
    addChapterObjective,
    toggleChapterObjective,
    removeChapterObjective,
    addChapterEvent,
    removeChapterEvent,
    markItemReturned,
    returningItemId,
    syncMilestoneXp,
    syncingXpMilestoneId,
    syncSheetStat,
    syncingStatKey,
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

    // A chapter's point of view counts as present even when they were never
    // ticked into the cast list.
    for (const node of chapterNodes) {
      const existing = castInChapter.get(node.id) ?? new Set<string>();

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

  // The chart's own state — the metric, the stat a line follows, the hidden
  // comparison and the chapter snapshot — lives in the progression domain. The
  // story's rows arrive as arguments because the chart and the sheets read the
  // same ledgers; the sheet's jump target stays here, because it is about which
  // row is open rather than about what is drawn.
  const {
    chartMetric,
    setChartMetric,
    chartStatName,
    setChartStatName,
    statNameOptions,
    chartSeries,
    chartMilestoneSeries,
    chartMetricSeries,
    visibleChartSeries,
    visibleComparisonSeries,
    hiddenChartCharacterIds,
    toggleChartCharacter,
    chartStateChapters,
    chartStateChapter,
    chartStateChapterId,
    setChartStateChapterId,
    chartStateById,
    chartStateLoading,
    chartStateError,
  } = useProgressionChart({
    characters,
    milestones: storyLevels,
    progress: storyCharacterProgress,
    chapterNodes,
    castStats,
    growthRules: storyGrowthRules,
    active: selectedTab === 'characters',
    storyId: currentStory?.id ?? null,
    skillEvents: storySkillEvents,
  });

  const selectedCharacter =
    characters.find(character => character.id === selectedCharacterId) ?? null;

  // A chapter without a position sorts after every placed chapter, then by the
  // order it was recorded. The same order is used on the board and the sheet.
  const selectedLevels = useMemo(
    () =>
      storyLevels
        .filter(milestone => milestone.character_id === selectedCharacterId)
        .sort(
          (a, b) =>
            (chapterSeqById.get(a.chapter_id ?? '') ?? Number.MAX_SAFE_INTEGER) -
              (chapterSeqById.get(b.chapter_id ?? '') ?? Number.MAX_SAFE_INTEGER) ||
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id)
        ),
    [storyLevels, selectedCharacterId, chapterSeqById]
  );

  // The skill-event picker offers the levels the curve actually reached, so an
  // upgrade cannot be hung on a row the ledger never paid for.
  const selectedCrossingMilestones = useMemo(() => {
    const crossings = levelCrossingsFor(
      selectedCharacterId ?? '',
      storyCharacterProgress,
      storyLevels,
      effectiveGrowthRule(storyGrowthRules, selectedCharacterId),
      chapterNodes
    );
    const levels = new Set(crossings.map(crossing => crossing.level));

    return selectedLevels.filter(milestone => levels.has(milestone.level));
  }, [
    selectedCharacterId,
    storyCharacterProgress,
    storyLevels,
    storyGrowthRules,
    chapterNodes,
    selectedLevels,
  ]);

  const selectedXpEntries = useMemo(
    () =>
      storyCharacterProgress
        .filter(entry => entry.character_id === selectedCharacterId)
        .sort(
          (a, b) =>
            (chapterSeqById.get(a.chapter_id ?? '') ?? Number.MAX_SAFE_INTEGER) -
              (chapterSeqById.get(b.chapter_id ?? '') ?? Number.MAX_SAFE_INTEGER) ||
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id)
        ),
    [storyCharacterProgress, selectedCharacterId, chapterSeqById]
  );

  // What the sheet shows for the selected character.
  // The level is the one the curve wrote on the cast row — the ledger's total run
  // through the story's rule — and the target is the next step of that curve. The
  // timeline says where each level was reached, not where the character stands, so
  // reading the level out of it would show the last crossing instead.
  const shownLevel = selectedCharacter?.level ?? 1;
  const shownXp = selectedCharacter?.xp ?? 0;
  const shownTarget = selectedCharacter?.xp_to_next ?? null;
  const progressPercent =
    shownTarget && shownTarget > 0
      ? Math.min(100, Math.round((shownXp / shownTarget) * 100))
      : 0;

  // Where the points this character's levels handed out were placed. The pool
  // itself is worked out from the level and the rule, so the sheet reads the
  // tally from these rows rather than keeping a count of its own.
  const selectedGrowthPoints = useMemo(
    () => storyGrowthPoints.filter(point => point.character_id === selectedCharacterId),
    [storyGrowthPoints, selectedCharacterId]
  );

  const applyCharacterRow = (updated: Character) => {
    setCharacters(previous =>
      previous.map(entry => (entry.id === updated.id ? updated : entry))
    );
  };

  // The rank is the one progression field an author types. The total is the
  // ledger's sum and the level is the curve's, so both are read rather than sent.
  const saveProgress = async (draft: ProgressDraft): Promise<boolean> => {
    if (!selectedCharacter) return false;

    setCharacterError(null);

    try {
      const updated: Character = await progressionApi.setCharacterProgress(
        selectedCharacter.id,
        draft.rank.trim() || null,
        actor
      );

      applyCharacterRow(updated);
      return true;
    } catch (e) {
      console.error('Failed to save progression:', e);
      setCharacterError(`Could not save progression: ${String(e)}`);
      return false;
    }
  };

  // What a level hands out, saved for the story or for one character. The form
  // hands over text; what a whole number of points is belongs here.
  const saveGrowthRule = async (
    scope: GrowthScope,
    pointsPerLevel: string,
    xpBase: string,
    xpGrowth: string,
    rates: GrowthRateDraft[]
  ): Promise<boolean> => {
    if (!currentStory) return false;
    if (scope === 'character' && !selectedCharacterId) return false;

    const points = Number(pointsPerLevel);

    if (!/^\d+$/.test(pointsPerLevel.trim()) || points < 0) {
      setCharacterError('Points per level is a whole number, 0 or more.');
      return false;
    }

    const base = Number(xpBase);

    if (!/^\d+$/.test(xpBase.trim()) || base < 1) {
      setCharacterError('A level costs a whole number of XP, 1 or more.');
      return false;
    }

    const growth = Number(xpGrowth);

    if (!/^\d+$/.test(xpGrowth.trim()) || growth > 1000) {
      setCharacterError('The growth percentage is a whole number from 0 to 1,000.');
      return false;
    }

    const cleaned: { stat_name: string; per_level: number }[] = [];
    const seen = new Set<string>();

    for (const rate of rates) {
      const statName = rate.statName.trim();
      const perLevel = rate.perLevel.trim();

      if (statName === '' && perLevel === '') continue;

      if (statName === '') {
        setCharacterError('A growth rate needs a stat.');
        return false;
      }

      if (!/^-?\d+$/.test(perLevel) || Number(perLevel) === 0) {
        setCharacterError(`${statName} grows by a whole number other than zero.`);
        return false;
      }

      if (seen.has(statName)) {
        setCharacterError(`${statName} grows more than once per level.`);
        return false;
      }

      seen.add(statName);
      cleaned.push({ stat_name: statName, per_level: Number(perLevel) });
    }

    setCharacterError(null);

    try {
      const saved: LevelGrowthRule = await progressionApi.saveLevelGrowthRule(
        currentStory.id,
        scope === 'character' ? selectedCharacterId : null,
        points,
        base,
        growth,
        cleaned,
        actor
      );

      setStoryGrowthRules(previous => [
        ...previous.filter(rule => rule.id !== saved.id),
        saved,
      ]);

      // The curve is what levels the cast, so a rule that moved it has to be read
      // back rather than assumed: the levels, the timelines it wrote and the stats
      // those levels handed out.
      await reloadProgressionNumbers(selectedCharacterId);

      return true;
    } catch (e) {
      console.error('Failed to save a growth rule:', e);
      setCharacterError(`Could not save the growth rule: ${String(e)}`);
      return false;
    }
  };

  const removeGrowthRule = async (rule: LevelGrowthRule): Promise<void> => {
    setCharacterError(null);

    try {
      await progressionApi.deleteLevelGrowthRule(rule.id, actor);
      setStoryGrowthRules(previous => previous.filter(other => other.id !== rule.id));
    } catch (e) {
      console.error('Failed to delete a growth rule:', e);
      setCharacterError(`Could not remove the growth rule: ${String(e)}`);
    }
  };

  // An award or an income row applies itself in the database, where the ledger's
  // total, the level it buys and the stats that level hands out are all worked
  // out together. So none of it is guessed at here: the cast row (level, total and
  // target), the timeline the curve wrote and the numbers on the sheet are read
  // back, and the rail, the search results and the cards follow in the same render
  // instead of waiting for the tab to be opened again.
  const reloadProgressionNumbers = async (characterId: string | null) => {
    if (!currentStory) return;

    const [cast, milestones, storyStats, progress] = await Promise.all([
      charactersApi.getCharacters(currentStory.id),
      progressionApi.getStoryLevels(currentStory.id),
      charactersApi.getStoryCharacterStats(currentStory.id),
      progressionApi.getStoryCharacterProgress(currentStory.id),
    ]);

    applyMilestoneList(milestones);
    setCharacters(cast);
    setCastStats(statsByCharacter(storyStats));
    setStoryCharacterProgress(progress ?? []);

    // The sheet's own stats belong to whoever is open; a rule that moved the whole
    // cast still only has one sheet to fill.
    if (characterId) setCharacterStats(await charactersApi.getCharacterStats(characterId));
  };

  const addAward = async (draft: AwardDraft): Promise<boolean> => {
    if (!selectedCharacterId) return false;

    const amount = Number(draft.amount);

    if (!/^-?\d+$/.test(draft.amount.trim()) || amount === 0) {
      setCharacterError('An award is a whole number other than zero.');
      return false;
    }

    if (draft.kind === 'xp' && (!draft.chapterId || amount < 0)) {
      setCharacterError('XP awarded belongs to a chapter, as a whole number above zero.');
      return false;
    }

    if (draft.kind === 'stat' && draft.statName.trim() === '') {
      setCharacterError('A stat award needs a stat.');
      return false;
    }

    setCharacterError(null);

    try {
      const saved: CharacterAward = await progressionApi.addCharacterAward(
        selectedCharacterId,
        draft.chapterId || null,
        draft.kind,
        draft.kind === 'stat' ? draft.statName.trim() : null,
        amount,
        draft.note.trim() || null,
        actor
      );

      setStoryAwards(previous => [...previous, saved]);
      await reloadProgressionNumbers(selectedCharacterId);
      return true;
    } catch (e) {
      console.error('Failed to add an award:', e);
      setCharacterError(`Could not add the award: ${String(e)}`);
      return false;
    }
  };

  const removeAward = async (award: CharacterAward): Promise<void> => {
    setCharacterError(null);

    try {
      await progressionApi.deleteCharacterAward(award.id, actor);
      setStoryAwards(previous => previous.filter(other => other.id !== award.id));
      await reloadProgressionNumbers(award.character_id);
    } catch (e) {
      console.error('Failed to delete an award:', e);
      setCharacterError(`Could not delete the award: ${String(e)}`);
    }
  };

  // Puts one unspent growth point on a stat. The stat rises and the placement is
  // recorded in the same command, so the sheet and the tally cannot disagree, and
  // the pair is one undo step: undoing takes the placement back and the stat with
  // it. The pool is checked in the database rather than here, because a stale
  // sheet would otherwise spend a point the level never handed out.
  const placeGrowthPoint = async (statName: string): Promise<void> => {
    const characterId = selectedCharacterId;
    if (!characterId) return;

    setCharacterError(null);

    const spend = async (): Promise<GrowthPointSpend> => {
      const saved: GrowthPointSpend = await progressionApi.spendGrowthPoint(
        characterId,
        statName,
        1,
        null,
        actor
      );

      setStoryGrowthPoints(previous => [
        ...previous.filter(point => point.id !== saved.point.id),
        saved.point,
      ]);
      applyWrittenStat(saved.stat);

      return saved;
    };

    try {
      const saved = await spend();

      recordStep({
        label: `Place a point on ${statName}`,
        undo: async () => {
          await progressionApi.deleteGrowthPoint(saved.point.id, actor);
          setStoryGrowthPoints(previous =>
            previous.filter(point => point.id !== saved.point.id)
          );
          // The reversal moves the stat in the database, so both the sheet and
          // the badges on the cards are read back rather than adjusted by hand.
          const stats: CharacterStat[] =
            await charactersApi.getCharacterStats(characterId);
          setCastStats(previous => ({ ...previous, [characterId]: stats }));
          if (characterId === selectedCharacterId) setCharacterStats(stats);
        },
        redo: spend,
      });
    } catch (e) {
      console.error('Failed to place a growth point:', e);
      setCharacterError(`Could not place the point: ${String(e)}`);
    }
  };



  // One palette, placed on two tabs: over the canvas and above the chapter list.
  // Only one tab renders at a time, so there is never a second copy of it.
  // The tab's own Search button: the palette opens on everything, with the first
  // result already selected.
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
          aria-label="Search everything"
          title="Cards, cast, connections, chapter notes and other stories; Enter goes to the chosen one"
          placeholder="Node, cast member, connection, note or story"
          value={searchTerm}
          onChange={event => typeSearch(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeSearch();
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
              if (highlightedResult) void chooseSearchResult(highlightedResult);
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
              onClick={() => filterKind(filter.value)}
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
                    onMouseEnter={() => highlightResult(index)}
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
                      if (e.key === 'Escape') cancelRename();
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
                              cancelDeleteStory();
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
                              askDeleteStory(story.id);
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
              title="Read the illustrated guide: what the canvas, the skill cards and the history record"
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
                title="Read the illustrated guide, pictures and all"
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

        {syncedStatNotice && (
          <div className="status-strip returned-strip" role="status">
            <span>
              Synced {syncedStatNotice.characterName}'s {syncedStatNotice.statName} to{' '}
              {syncedStatNotice.value}.
            </span>
            <button
              className="status-undo"
              title={`Put ${syncedStatNotice.characterName}'s ${syncedStatNotice.statName} back as it was`}
              aria-label={`Undo syncing ${syncedStatNotice.characterName}'s ${syncedStatNotice.statName}`}
              onClick={() => void undoLast()}
            >
              Undo
            </button>
            <button
              className="status-dismiss"
              title="Keep the synced value"
              onClick={() => setSyncedStatNotice(null)}
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

        {storyNotice && (
          <div className="status-strip" title={storyNotice}>
            {storyNotice}
            <button
              className="status-dismiss"
              title="Hide this message"
              onClick={dismissStoryNotice}
            >
              Dismiss
            </button>
          </div>
        )}

        {selectedTab === 'graph' && (
          <GraphTab
            story={currentStory}
            renderSearchPalette={renderSearchPalette}
            openSearch={openSearch}
            shortcutKeys={shortcutKeys}
            newNodeType={newNodeType}
            setNewNodeType={setNewNodeType}
            newNodeLabel={newNodeLabel}
            setNewNodeLabel={setNewNodeLabel}
            openCanvasCreate={openCanvasCreate}
            undoLast={undoLast}
            redoLast={redoLast}
            historyDepth={historyDepth}
            showChapterNotes={showChapterNotes}
            setShowChapterNotes={setShowChapterNotes}
            nodes={nodes}
            canvasNodes={canvasNodes}
            edges={edges}
            flowRef={flowRef}
            pendingPanRef={pendingPanRef}
            panCanvas={panCanvas}
            handleNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            selectNode={selectNode}
            selectEdge={selectEdge}
            removeNodes={removeNodes}
            removeEdges={removeEdges}
            characters={characters}
            castStats={castStats}
            draggingCastId={draggingCastId}
            setDraggingCastId={setDraggingCastId}
            setDropTargetNodeId={setDropTargetNodeId}
            nodeUnderPointer={nodeUnderPointer}
            dropCastMember={dropCastMember}
            selectedEdgeId={selectedEdgeId}
            closeEdge={closeEdge}
            selectedEdge={selectedEdge}
            edgeLabelDraft={edgeLabelDraft}
            setEdgeLabelDraft={setEdgeLabelDraft}
            edgeRelationDraft={edgeRelationDraft}
            setEdgeRelationDraft={setEdgeRelationDraft}
            saveEdge={saveEdge}
            edgeEditError={edgeEditError}
            // The drawer reads the drawn card, not the stored row: the roster a
            // chapter shows is worked out when the board is drawn, and the
            // drawer lists the same names the card does.
            selectedNode={
              (selectedNodeId
                ? canvasNodes.find(node => node.id === selectedNodeId) ?? selectedNode
                : selectedNode)
            }
            selectedNodeId={selectedNodeId}
            nodeIsDirty={nodeDirty}
            closeNodeInspector={closeNode}
            nodeLabelDraft={nodeLabelDraft}
            setNodeLabelDraft={setNodeLabelDraft}
            nodeContentDraft={nodeContentDraft}
            setNodeContentDraft={setNodeContentDraft}
            rememberNodeDraft={rememberNodeDraft}
            renameOffer={renameOffer}
            setRenameOffer={setRenameOffer}
            applyRenameOffer={applyRenameOffer}
            nodeEditError={nodeEditError}
            saveNode={saveNode}
            closePrompt={closePrompt}
            setClosePrompt={setClosePrompt}
            discardNodeDraft={discardNode}
            changeNodeCharacter={changeNodeCharacter}
            onOpenSheet={openCharacterSheet}
            onOpenChapter={openChapterFromInspector}
            skills={storySkills}
            skillHolderCharacterId={skillHolderCharacterId}
            setSkillHolderCharacterId={setSkillHolderCharacterId}
            skillHolderRank={skillHolderRank}
            setSkillHolderRank={setSkillHolderRank}
            skillHolderChapterId={skillHolderChapterId}
            setSkillHolderChapterId={setSkillHolderChapterId}
            skillHolderError={skillHolderError}
            setSkillHolderError={setSkillHolderError}
            savingSkillHolder={savingSkillHolder}
            chapterChoices={chapterChoices}
            addSkillHolder={addSkillHolder}
            inspectorCharacter={inspectorCharacter}
            inspectorStats={inspectorStats}
            inspectorAttributes={inspectorAttributes}
            inspectorError={inspectorError}
            inspectorStatId={inspectorStatId}
            setInspectorStatId={setInspectorStatId}
            inspectorStatValue={inspectorStatValue}
            setInspectorStatValue={setInspectorStatValue}
            startInspectorStat={startInspectorStat}
            saveInspectorStat={saveInspectorStat}
            inspectorAttrId={inspectorAttrId}
            setInspectorAttrId={setInspectorAttrId}
            inspectorAttrValue={inspectorAttrValue}
            setInspectorAttrValue={setInspectorAttrValue}
            startInspectorAttribute={startInspectorAttribute}
            saveInspectorAttribute={saveInspectorAttribute}
          />
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
              syncingStatKey={syncingStatKey}
              syncSheetStat={syncSheetStat}
            />
          </div>
        )}

        {selectedTab === 'characters' && characterView === 'relations' && (
          <CharacterRelationsView
            story={currentStory}
            onViewChange={setCharacterView}
            characters={characters}
            relations={storyRelations}
            standings={storyFactionStandings}
            factionCards={factionCardChoices}
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

        {selectedTab === 'characters' && characterView === 'skills' && (
          <CharacterSkillsView
            story={currentStory}
            onViewChange={setCharacterView}
            skills={storySkills}
            characters={characters}
            evolutions={storySkillEvolutions}
            chapterNodes={chapterChoices}
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

        {selectedTab === 'characters' && characterView === 'sheet' && (
          <CharacterSheetPanel
            story={currentStory}
            onViewChange={setCharacterView}
            characterError={characterError}
            chapterNodes={chapterNodes}
            chartMetric={chartMetric}
            setChartMetric={setChartMetric}
            chartStatName={chartStatName}
            setChartStatName={setChartStatName}
            statNameOptions={statNameOptions}
            chartSeries={chartSeries}
            chartMetricSeries={chartMetricSeries}
            visibleChartSeries={visibleChartSeries}
            chartMilestoneSeries={chartMilestoneSeries}
            hiddenChartCharacterIds={hiddenChartCharacterIds}
            toggleChartCharacter={toggleChartCharacter}
            chartStateChapterId={chartStateChapterId}
            setChartStateChapterId={setChartStateChapterId}
            chartStateChapters={chartStateChapters}
            chartStateChapter={chartStateChapter}
            chartStateLoading={chartStateLoading}
            chartStateError={chartStateError}
            chartStateById={chartStateById}
            visibleComparisonSeries={visibleComparisonSeries}
            chapterStateFocus={chapterStateFocus}
            castStats={castStats}
            characters={characters}
            selectedCharacterId={selectedCharacterId}
            setSelectedCharacterId={setSelectedCharacterId}
            newCharacterName={newCharacterName}
            setNewCharacterName={setNewCharacterName}
            newCharacterDescription={newCharacterDescription}
            setNewCharacterDescription={setNewCharacterDescription}
            createCharacter={createCharacter}
            selectedCharacter={selectedCharacter}
            editingCharacter={editingCharacter}
            setEditingCharacter={setEditingCharacter}
            characterNameDraft={characterNameDraft}
            setCharacterNameDraft={setCharacterNameDraft}
            characterDescriptionDraft={characterDescriptionDraft}
            setCharacterDescriptionDraft={setCharacterDescriptionDraft}
            saveCharacter={saveCharacter}
            startCharacterEdit={startCharacterEdit}
            confirmDeleteCharacter={confirmDeleteCharacter}
            setConfirmDeleteCharacter={setConfirmDeleteCharacter}
            removeCharacter={removeCharacter}
          >
            <ProgressionSections
              character={selectedCharacter}
              characterId={selectedCharacterId}
              shownLevel={shownLevel}
              shownXp={shownXp}
              shownTarget={shownTarget}
              progressPercent={progressPercent}
              chapters={chapterChoices}
              milestones={selectedLevels}
              xpEntries={selectedXpEntries}
              skills={storySkills}
              skillEvents={storySkillEvents}
              statNameOptions={statNameOptions}
              focus={focusedProgression}
              growthRules={storyGrowthRules}
              growthPoints={selectedGrowthPoints}
              awards={storyAwards.filter(
                award => award.character_id === selectedCharacterId
              )}
              stats={characterStats}
              onStatWritten={applyWrittenStat}
              onPlacePoint={placeGrowthPoint}
              actor={actor}
              onError={setCharacterError}
              onSaveProgress={saveProgress}
              onSaveGrowth={saveGrowthRule}
              onDeleteGrowth={removeGrowthRule}
              onAddAward={addAward}
              onDeleteAward={removeAward}
              onCreateXpEntry={addXpEntry}
              onSaveXpEntry={saveXpEntry}
              onDeleteXpEntry={removeXpEntry}
            />

            <AttributeList
              attributes={characterAttributes}
              onError={setCharacterError}
              onCreate={addAttribute}
              onSave={saveAttribute}
              onDelete={removeAttribute}
            />

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
              milestones={selectedCrossingMilestones}
              chapterSeqById={chapterSeqById}
              focus={focusedProgression}
              onError={setCharacterError}
              onCreate={addSkill}
              onSave={saveSkill}
              onDelete={removeSkill}
              onSaveEvent={saveSkillEvent}
              onDeleteEvent={removeSkillEvent}
            />

            <InventoryList
              items={characterInventory}
              chapters={chapterChoices}
              cards={itemCardChoices}
              onCreate={addItem}
              onSave={saveItem}
              onDelete={removeItem}
            />

            <CurrencyList
              currencies={characterCurrency}
              onCreate={addCurrency}
              onSave={saveCurrency}
              onDelete={removeCurrency}
            />

            <RelationList
              relations={selectedRelations}
              selectedCharacterId={selectedCharacterId}
              characterNameById={characterNameById}
              chapterLabelById={chapterLabelById}
              chapters={chapterChoices}
              characters={characters}
              kindSuggestions={relationKindSuggestions}
              focus={focusedProgression}
              onCreate={addRelation}
              onSave={saveRelation}
              onDelete={removeRelation}
            />

            <StandingList
              standings={selectedStandings}
              factions={factionCardChoices}
              chapters={chapterChoices}
              chapterLabelById={chapterLabelById}
              focus={focusedProgression}
              onCreate={addStanding}
              onSave={saveStanding}
              onDelete={removeStanding}
              createFaction={createFactionCard}
              onError={setCharacterError}
            />

          </CharacterSheetPanel>
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
          <TrashPanel
            story={currentStory}
            actor={actor}
            reloadToken={trashReloadToken}
            onRestored={restoredFromTrash}
            onPurged={purgedFromTrash}
            onIrreversible={forgetHistory}
          />
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
        <GuideReader
          onClose={() => setGuideOpen(false)}
          onOpenShortcuts={() => {
            setGuideOpen(false);
            setShortcutsOpen(true);
          }}
        />
      )}

      {backupsOpen && (
        <BackupsDialog
          backups={backups}
          loading={backupsLoading}
          error={backupsError}
          confirmRestore={confirmRestore}
          restoringFile={restoringFile}
          onAskRestore={askRestore}
          onCancelRestore={cancelRestore}
          onRestore={backup => void restoreBackup(backup)}
          onClose={closeBackups}
        />
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
