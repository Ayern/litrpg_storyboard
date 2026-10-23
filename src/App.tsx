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
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';

interface Story {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
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
};
type EdgeData = { label?: string; relationType?: string; createdBy: string };

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
type SearchKind = 'node' | 'cast' | 'link' | 'story';

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

interface StoryIndex {
  nodes: IndexedNode[];
  characters: Character[];
  edges: IndexedEdge[];
}

const searchResultTitles: Record<SearchKind, string> = {
  node: 'Open this node on its board',
  cast: "Open this character's sheet",
  link: "Open this connection's editor",
  story: 'Open this story',
};

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

  return (
    <div className={`graph-node ${kind}`}>
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
      <span className="graph-node-kind">{kind}</span>
      <span className="graph-node-label">{data.label}</span>
      {linked && (
        <span
          className="graph-node-cast"
          title={
            stats.length > 0
              ? stats.map(stat => `${stat.stat_name} ${stat.value}`).join(' · ')
              : undefined
          }
        >
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

const USER_KEY = 'litrpg.currentUser';

// The key labels the app shows. The help list and any tooltip that names a key
// both read from here, so the two cannot describe one route differently.
const shortcutKeys = {
  help: '?',
  search: 'Ctrl+F',
  choose: '↑ ↓',
  enter: 'Enter',
  escape: 'Esc',
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
      { keys: shortcutKeys.search, action: 'Open the search palette (Graph tab)' },
      { keys: shortcutKeys.choose, action: 'Move through the results' },
      { keys: shortcutKeys.enter, action: 'Go to the chosen result' },
      { keys: shortcutKeys.escape, action: 'Close the palette' },
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

function entityLabel(entry: AuditEntry): string {
  const base = entityLabels[entry.entity_type] ?? entry.entity_type;
  return entry.field_changed ? `${base} (${entry.field_changed})` : base;
}

function formatWhen(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
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
  
  const [selectedTab, setSelectedTab] = useState<'graph' | 'characters' | 'audit' | 'trash'>('graph');
  
  const [newStoryTitle, setNewStoryTitle] = useState('');
  const [newNodeLabel, setNewNodeLabel] = useState('');
  const [newNodeType, setNewNodeType] = useState<NodeType>('idea');

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

  // The search palette, opened with Ctrl+F while the graph is showing.
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

  const [trash, setTrash] = useState<DeletedItem[]>([]);
  const [deletedStories, setDeletedStories] = useState<DeletedItem[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);
  const [trashNotice, setTrashNotice] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);

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
    
    try {
      const dbNodes: any[] = await invoke('get_graph_nodes', { storyId: story.id });
      const dbEdges: any[] = await invoke('get_graph_edges', { storyId: story.id });

      const flowNodes: any[] = dbNodes.map((n: any) => ({
        id: n.id,
        type: 'default',
        position: { x: n.pos_x, y: n.pos_y },
        data: {
          label: n.label,
          nodeType: n.node_type,
          content: n.content,
          createdBy: n.created_by,
          characterId: n.character_id ?? null,
        },
      }));

      const flowEdges: any[] = dbEdges.map((e: any) => ({
        id: e.id,
        source: e.source_id,
        target: e.target_id,
        // The canvas shows one string, but the two fields stay separate in
        // `data` so the editor can tell a label from a relation type.
        label: e.label || e.relation_type || '',
        data: {
          label: e.label ?? undefined,
          relationType: e.relation_type ?? undefined,
          createdBy: e.created_by,
        },
      }));

      setNodes(flowNodes);
      setEdges(flowEdges);

      // The cast rail and the cards' badges both read from here, so the cast and
      // its numbers are loaded with the graph rather than on another tab.
      const [cast, stats] = await Promise.all([
        invoke<Character[]>('get_characters', { storyId: story.id }),
        invoke<CharacterStat[]>('get_story_character_stats', { storyId: story.id }),
      ]);
      setCharacters(cast);
      setCastStats(statsByCharacter(stats));

      // A node or connection from the previous story is no longer on the canvas.
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    } catch (e) {
      console.error('Failed to load story graph:', e);
    }
  }, [setNodes, setEdges]);

  // Load first story by default if none selected
  useEffect(() => {
    if (!currentStory && stories.length > 0) {
      loadStory(stories[0]);
    }
  }, [stories, currentStory, loadStory]);

  // Ctrl+F opens the canvas search only while the graph is on screen, so the
  // shortcut is not swallowed on another tab where the browser's find is fine.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // While the shortcut list is up it is the only thing the keys act on.
      if (selectedTab !== 'graph' || !currentStory || shortcutsOpen) return;

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
  }, [selectedTab, currentStory, searchOpen, shortcutsOpen]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // ? opens the shortcut list on any tab, but never while a field is being typed
  // in — there it is a question mark like any other.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
  }, [shortcutsOpen]);

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
        const [nodes, characters, edges] = await Promise.all([
          invoke<IndexedNode[]>('get_graph_nodes', { storyId: story.id }),
          invoke<Character[]>('get_characters', { storyId: story.id }),
          invoke<IndexedEdge[]>('get_graph_edges', { storyId: story.id }),
        ]);

        return [story.id, { nodes, characters, edges }] as const;
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
        },
      };

      setNodes(nds => [...nds, flowNode]);
      setNewNodeLabel('');
    } catch (e) {
      console.error('Failed to create node:', e);
    }
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
  const panCanvas = (x: number, y: number) => {
    const instance = flowRef.current;
    if (!instance) return;

    const zoom = Math.max(instance.getZoom?.() ?? 1, 1);
    instance.setCenter(x, y, { zoom, duration: 300 });
  };

  // Every result is a destination: a card opens in the inspector on its board, a
  // cast member opens their sheet, a connection opens the edge editor at its
  // midpoint, and a story result opens that story.
  const chooseSearchResult = async (result: SearchResult) => {
    const targetStory = stories.find(story => story.id === result.storyId) ?? null;

    closeCanvasSearch();
    setSelectedTab(result.kind === 'cast' ? 'characters' : 'graph');

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
          },
        },
      ]);

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
      } catch (e) {
        console.error('Failed to create edge:', e);
      }
    },
    [currentStory, actor, setEdges]
  );

  const onNodeDragStop = useCallback(
    async (_event: any, node: Node<NodeData>) => {
      if (!currentStory) return;

      try {
        await invoke('update_graph_node_position', {
          id: node.id,
          posX: node.position.x,
          posY: node.position.y,
          user: actor,
        });
      } catch (e) {
        console.error('Failed to persist node position:', e);
      }
    },
    [currentStory, actor]
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
      } catch (e) {
        console.error('Failed to delete node:', e);
        setActionError(`Could not delete node: ${String(e)}`);
        await loadStory(currentStory);
      }
    },
    [currentStory, actor, loadStory, setEdges]
  );

  const removeEdges = useCallback(
    async (deleted: Edge<EdgeData>[]) => {
      if (!currentStory) return;
      setActionError(null);

      const removedIds = new Set(deleted.map(edge => edge.id));
      setSelectedEdgeId(current => (current && removedIds.has(current) ? null : current));

      try {
        for (const edge of deleted) {
          await invoke('delete_edge', { id: edge.id, user: actor });
        }
      } catch (e) {
        console.error('Failed to delete connection:', e);
        setActionError(`Could not delete connection: ${String(e)}`);
        await loadStory(currentStory);
      }
    },
    [currentStory, actor, loadStory]
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
  // person remembers it rather than only by its exact name.
  const searchResults = useMemo<SearchResult[]>(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return [];

    const hits = (values: (string | null | undefined)[]) =>
      values.some(value => typeof value === 'string' && value.toLowerCase().includes(term));
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
            // A node's position is its top-left, so the pan aims at its middle.
            x: node.position.x + 70,
            y: node.position.y + 20,
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
          })
        );
      }

      if (!index) return;

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
            })
          );
        });
      }

      if (wants('link')) {
        const storyLabels = new Map(index.nodes.map(node => [node.id, node.label]));
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
              x: from && to ? (from.x + to.x) / 2 : 0,
              y: from && to ? (from.y + to.y) / 2 : 0,
            })
          );
        });
      }
    });

    return results;
  }, [searchTerm, searchKind, nodes, characters, edges, stories, currentStory, otherStoryIndex]);

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

  const selectedEdge = edges.find(edge => edge.id === selectedEdgeId) ?? null;

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
                onClick={() => !isRenaming && loadStory(story)}
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
              onClick={() => setSelectedTab('graph')}
            >
              Graph
            </button>
            <button
              className={selectedTab === 'characters' ? 'active' : ''}
              title="Manage the cast, their stats and attributes"
              onClick={() => setSelectedTab('characters')}
            >
              Characters
            </button>
            <button
              className={selectedTab === 'audit' ? 'active' : ''}
              title="See every recorded change and revert an edit"
              onClick={() => setSelectedTab('audit')}
            >
              Audit Log
            </button>
            <button
              className={selectedTab === 'trash' ? 'active' : ''}
              title="Restore something deleted, or delete it for good"
              onClick={() => setSelectedTab('trash')}
            >
              Trash
            </button>
          </div>
          <div className="topbar-actions">
            {currentStory && (
              <>
                <button
                  className="export-button"
                  title="Write the whole story, history included, to a JSON file"
                  onClick={exportStory}
                >
                  Export JSON
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
                    className="search-button"
                    title={`Find a node, a cast member, a connection or another story (${shortcutKeys.search})`}
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
                            {(castStats[character.id] ?? []).length > 0 && (
                              <span className="cast-chip-stats">
                                {(castStats[character.id] ?? [])
                                  .slice(0, NODE_STAT_BADGES)
                                  .map(stat => `${stat.stat_name} ${stat.value}`)
                                  .join(' · ')}
                              </span>
                            )}
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
                  {searchOpen && (
                    <div
                      className="canvas-search"
                      role="dialog"
                      aria-label="Search the storyboard"
                    >
                      <input
                        ref={searchInputRef}
                        className="canvas-search-input"
                        type="search"
                        aria-label="Search everything"
                        title="Nodes, cast, connections and other stories; Enter goes to the chosen one"
                        placeholder="Node, cast member, connection or story"
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
                          Type to find a node, a cast member, a connection or another story.
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
                  )}
                  <ReactFlow
                    nodes={canvasNodes}
                    edges={edges}
                    nodeTypes={flowNodeTypes}
                    onInit={instance => {
                      flowRef.current = instance;
                    }}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
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
                      onClick={() => setSelectedCharacterId(character.id)}
                    >
                      <span className="character-name">{character.name}</span>
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
    </div>
  );
}

export default App;