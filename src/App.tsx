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
          <button className="trash-danger" onClick={() => purgeDeleted(item)}>
            Yes, delete forever
          </button>
          <button onClick={() => setConfirmPurgeId(null)}>Cancel</button>
        </>
      ) : (
        <>
          <button onClick={() => restoreDeleted(item)}>Restore</button>
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

  // Opening a node is the same gesture whether it was just created or relinked.
  const openNodeInspector = (node: { id: string; label: string; content?: string | null }) => {
    setSelectedEdgeId(null);
    setNodeEditError(null);
    setSelectedNodeId(node.id);
    setNodeLabelDraft(node.label);
    setNodeContentDraft(node.content ?? '');
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
  const selectNode = useCallback((_event: React.MouseEvent, node: Node<NodeData>) => {
    setNodeEditError(null);
    setSelectedEdgeId(null);
    setSelectedNodeId(node.id);
    setNodeLabelDraft(node.data.label);
    setNodeContentDraft(node.data.content ?? '');
    setRenameOffer(null);
  }, []);

  const selectEdge = useCallback((_event: React.MouseEvent, edge: Edge<EdgeData>) => {
    setEdgeEditError(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(edge.id);
    setEdgeLabelDraft(edge.data?.label ?? '');
    setEdgeRelationDraft(edge.data?.relationType ?? '');
    setRenameOffer(null);
  }, []);

  const saveNode = async () => {
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
      setRenameOffer(null);
    } catch (e) {
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

      if (selectedNodeId === node.id) setNodeLabelDraft(updated.label);
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

  // The canvas gets the nodes plus their cast member's name and numbers. Only
  // linked nodes and the relink target are rebuilt, so the rest keep their
  // identity across a render.
  const canvasNodes = useMemo(() => {
    const castById = new Map(characters.map(character => [character.id, character]));

    return nodes.map(node => {
      const characterId = node.data.characterId;
      const isDropTarget = node.id === dropTargetNodeId;

      if (!characterId && !isDropTarget) return node;

      return {
        ...node,
        className: isDropTarget ? 'drop-target' : undefined,
        data: characterId
          ? {
              ...node.data,
              characterName: castById.get(characterId)?.name ?? null,
              characterStats: castStats[characterId] ?? [],
            }
          : node.data,
      };
    });
  }, [nodes, characters, castStats, dropTargetNodeId]);

  const selectedCharacter =
    characters.find(character => character.id === selectedCharacterId) ?? null;

  const selectedNode = nodes.find(node => node.id === selectedNodeId) ?? null;

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
          <label>Current User</label>
          <input
            value={currentUser}
            onChange={(e) => setCurrentUser(e.target.value)}
            placeholder="Your name"
          />
        </div>

        <h2>Stories</h2>
        <div className="story-creator">
          <input
            placeholder="New story title"
            value={newStoryTitle}
            onChange={(e) => setNewStoryTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createNewStory()}
          />
          <button onClick={createNewStory}>Create</button>
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
                            onClick={(e) => {
                              e.stopPropagation();
                              removeStory(story);
                            }}
                          >
                            Delete
                          </button>
                          <button
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
              onClick={() => setSelectedTab('graph')}
            >
              Graph
            </button>
            <button
              className={selectedTab === 'characters' ? 'active' : ''}
              onClick={() => setSelectedTab('characters')}
            >
              Characters
            </button>
            <button
              className={selectedTab === 'audit' ? 'active' : ''}
              onClick={() => setSelectedTab('audit')}
            >
              Audit Log
            </button>
            <button
              className={selectedTab === 'trash' ? 'active' : ''}
              onClick={() => setSelectedTab('trash')}
            >
              Trash
            </button>
          </div>
          <div className="topbar-actions">
            {currentStory && (
              <>
                <button className="export-button" onClick={exportStory}>
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
            <button onClick={() => setActionError(null)}>Dismiss</button>
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
            <button className="status-dismiss" onClick={() => setImportStatus(null)}>
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
                    value={newNodeType}
                    onChange={(e) => setNewNodeType(e.target.value as NodeType)}
                  >
                    {nodeTypes.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <input
                    placeholder="Node label"
                    value={newNodeLabel}
                    onChange={(e) => setNewNodeLabel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addNewNode()}
                  />
                  <button onClick={addNewNode} disabled={!newNodeLabel.trim()}>
                    Add Node
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
                        {nodeTypes.map(t => <span key={t} className={`legend ${t}`}>{t}</span>)}
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
                            <button onClick={saveEdge}>Save</button>
                            <button onClick={() => setSelectedEdgeId(null)}>Close</button>
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
                        </div>
                        <button
                          className="node-drawer-close"
                          aria-label="Close inspector"
                          onClick={() => setSelectedNodeId(null)}
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
                          setNodeLabelDraft(e.target.value);
                          // Typing a label is a decision of its own, so the rename
                          // offer stops being about this node.
                          setRenameOffer(null);
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveNode();
                          if (e.key === 'Escape') setSelectedNodeId(null);
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
                        onChange={e => setNodeContentDraft(e.target.value)}
                      />

                      {nodeEditError && (
                        <div className="node-editor-error">{nodeEditError}</div>
                      )}

                      <div className="node-editor-actions">
                        <button onClick={saveNode} disabled={!nodeLabelDraft.trim()}>
                          Save
                        </button>
                        <button onClick={() => setSelectedNodeId(null)}>Close</button>
                      </div>

                      <label className="node-drawer-label" htmlFor="inspector-cast">
                        Cast member
                      </label>
                      <select
                        id="inspector-cast"
                        className="node-drawer-select"
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
                            <button onClick={applyRenameOffer}>Rename</button>
                            <button onClick={() => setRenameOffer(null)}>Keep label</button>
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
                                      <button onClick={() => saveInspectorStat(stat)}>Save</button>
                                      <button onClick={() => setInspectorStatId(null)}>
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
                                      <button onClick={() => saveInspectorAttribute(attribute)}>
                                        Save
                                      </button>
                                      <button onClick={() => setInspectorAttrId(null)}>
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
                    <button onClick={createCharacter} disabled={!newCharacterName.trim()}>
                      Add character
                    </button>
                  </div>

                  {characters.length === 0 && <div className="empty">No characters yet</div>}

                  {characters.map(character => (
                    <div
                      key={character.id}
                      className={`character-item ${
                        selectedCharacterId === character.id ? 'active' : ''
                      }`}
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
                            <button onClick={saveCharacter} disabled={!characterNameDraft.trim()}>
                              Save
                            </button>
                            <button onClick={() => setEditingCharacter(false)}>Cancel</button>
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
                                  <button className="danger" onClick={removeCharacter}>
                                    Delete
                                  </button>
                                  <button onClick={() => setConfirmDeleteCharacter(false)}>
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button onClick={startCharacterEdit}>Edit</button>
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
                                  <button onClick={() => saveAttribute(attribute)}>Save</button>
                                  <button onClick={() => setEditingAttributeId(null)}>
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <span className="attribute-value">{attribute.value}</span>
                                  <button onClick={() => startAttributeEdit(attribute)}>
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
                                <button onClick={() => saveStat(stat)}>Save</button>
                                <button onClick={() => setEditingStatId(null)}>Cancel</button>
                              </>
                            ) : (
                              <>
                                <span className="stat-value">{stat.value}</span>
                                {stat.notes && <span className="stat-notes">{stat.notes}</span>}
                                <button onClick={() => startStatEdit(stat)}>Edit</button>
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
                        <button onClick={addStat} disabled={!newStatName.trim()}>
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
                <button className="status-dismiss" onClick={() => setTrashNotice(null)}>
                  Dismiss
                </button>
              </div>
            )}

            <div className="trash-retention">
              <label htmlFor="trash-retention">Keep deleted items for</label>
              <select
                id="trash-retention"
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
                    <button className="status-dismiss" onClick={() => setRevertError(null)}>
                      Dismiss
                    </button>
                  </div>
                )}

                {revertNotice && (
                  <div className="status-strip">
                    {revertNotice}
                    <button className="status-dismiss" onClick={() => setRevertNotice(null)}>
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
    </div>
  );
}

export default App;