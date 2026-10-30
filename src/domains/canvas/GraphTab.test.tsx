import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Edge, Node } from 'reactflow';

import type { CharacterAttribute } from '../characters/types';
import type { Character, CharacterSkill, CharacterStat } from '../shared/types';
import type { Story } from '../stories/types';
import { GraphTab } from './GraphTab';
import type { GraphTabProps } from './GraphTab';
import { allLayers, CHAPTER_SPINE_LAYERS } from './layers';
import type { GraphLayers } from './layers';
import {
  CARD_DRAG_TYPE,
  CAST_DRAG_TYPE,
  NODE_STAT_BADGES,
  QUEST_DRAG_TYPE,
  edgeKindClass,
} from './types';
import type { EdgeData, NodeData, NodeType } from './types';

// The Graph tab renders what the app holds and hands every keystroke back
// through the handlers it is given, so it needs no board, no database and no
// story load: the board itself is replaced by a passthrough, and the handlers
// arrive as spies. Two things it does decide for itself are held to here — which
// holders the selected skill card already has and which cast members could still
// learn it — along with the toolbar rules, the connection editor's drafts, the
// node drawer's draft bookkeeping and the cast member's numbers beside it.
//
// The board's own props are captured so a test can drive the one moment only the
// library can: a pan that waited for another tab to finish initializing.

const { boardProps } = vi.hoisted(() => ({
  boardProps: { current: null as Record<string, unknown> | null },
}));

vi.mock('reactflow', async () => {
  const React = await import('react');
  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);
  const Board = (props: Record<string, unknown>) => {
    boardProps.current = props;

    // The one thing only the library can hand over: the instance a drop asks for
    // the board's own coordinates. An unzoomed board maps screen to itself.
    React.useEffect(() => {
      (props.onInit as ((instance: unknown) => void) | undefined)?.({
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      });
    }, [props.onInit]);

    return React.createElement('div', null, props.children as React.ReactNode);
  };

  return {
    default: Board,
    Controls: () => null,
    Background: () => null,
    Panel: PassThrough,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  };
});

beforeEach(() => {
  boardProps.current = null;
});

const story: Story = {
  id: 's-1',
  title: 'The Vault',
  description: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function character(id: string, name: string, level?: number): Character {
  return {
    id,
    story_id: story.id,
    name,
    description: null,
    ...(level != null ? { level } : {}),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const mira = character('c-1', 'Mira', 3);
const rook = character('c-2', 'Rook');

function stat(id: string, name: string, value: number, characterId = mira.id): CharacterStat {
  return {
    id,
    character_id: characterId,
    stat_name: name,
    value,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function attribute(id: string, name: string, value: string): CharacterAttribute {
  return {
    id,
    character_id: mira.id,
    attr_name: name,
    value,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function node(
  id: string,
  label: string,
  nodeType: string,
  data: Partial<NodeData> = {}
): Node<NodeData> {
  return {
    id,
    type: nodeType,
    position: { x: 0, y: 0 },
    data: { label, nodeType, createdBy: 'author', ...data },
  };
}

function skill(id: string, characterId: string, chapterId: string | null = null): CharacterSkill {
  return {
    id,
    character_id: characterId,
    name: 'Arcane Sight',
    rank: null,
    effect: null,
    chapter_id: chapterId,
    node_id: 'n-skill',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function edge(id: string, source: string, target: string): Edge<EdgeData> {
  return { id, source, target, data: { createdBy: 'author' } };
}

// Every handler the tab reaches for, so a test asserts the wiring rather than a
// state behind it. The app's real setters are React state, so the harness below
// supplies those instead.
function canvasSpies() {
  return {
    openSearch: vi.fn(),
    openCanvasCreate: vi.fn(),
    undoLast: vi.fn(),
    redoLast: vi.fn(),
    panCanvas: vi.fn(),
    handleNodesChange: vi.fn(),
    onEdgesChange: vi.fn(),
    onConnect: vi.fn(),
    onConnectStart: vi.fn(),
    onConnectEnd: vi.fn(),
    onNodeDragStart: vi.fn(),
    onNodeDragStop: vi.fn(),
    selectNode: vi.fn(),
    selectEdge: vi.fn(),
    removeNodes: vi.fn(),
    removeEdges: vi.fn(),
    setDraggingCastId: vi.fn(),
    setDropTargetNodeId: vi.fn(),
    nodeUnderPointer: vi.fn(() => null),
    dropCastMember: vi.fn(),
    copyCardFromRail: vi.fn(),
    placeQuestFromRail: vi.fn(),
    closeEdge: vi.fn(),
    saveEdge: vi.fn(),
    closeNodeInspector: vi.fn(),
    rememberNodeDraft: vi.fn(),
    setRenameOffer: vi.fn(),
    applyRenameOffer: vi.fn(),
    saveNode: vi.fn(),
    discardNodeDraft: vi.fn(),
    changeNodeCharacter: vi.fn(),
    onOpenSheet: vi.fn(),
    onOpenChapter: vi.fn(),
    setSkillHolderError: vi.fn(),
    addSkillHolder: vi.fn(),
    toggleGraphLayer: vi.fn(),
    showAllGraphLayers: vi.fn(),
    showChapterSpine: vi.fn(),
    startInspectorStat: vi.fn(),
    saveInspectorStat: vi.fn(),
    startInspectorAttribute: vi.fn(),
    saveInspectorAttribute: vi.fn(),
  };
}

type Spies = ReturnType<typeof canvasSpies>;

// The drafts the app owns and the tab types into. A test that types needs those
// setState calls to go somewhere real, so the harness holds state for them and
// hands them down; everything else passes through as it was given.
interface Start {    newNodeType?: NodeType;
    newNodeLabel?: string;
    showChapterNotes?: boolean;
    graphLayers?: GraphLayers;
  edgeLabelDraft?: string;
  edgeRelationDraft?: string;
  nodeLabelDraft?: string;
  nodeContentDraft?: string;
  skillHolderCharacterId?: string;
  skillHolderRank?: string;
  skillHolderChapterId?: string;
  closePrompt?: boolean;
  inspectorStatId?: string | null;
  inspectorStatValue?: string;
  inspectorAttrId?: string | null;
  inspectorAttrValue?: string;
}

function props(spies: Spies, start: Start = {}, overrides: Partial<GraphTabProps> = {}) {
  const base: GraphTabProps = {
    story,
    renderSearchPalette: () => <div data-testid="search-palette">Search</div>,
    openSearch: spies.openSearch,
    shortcutKeys: { undo: 'Ctrl+Z', redo: 'Ctrl+Shift+Z', search: 'Ctrl+K' },

    newNodeType: start.newNodeType ?? 'character',
    setNewNodeType: vi.fn(),
    newNodeLabel: start.newNodeLabel ?? '',
    setNewNodeLabel: vi.fn(),
    openCanvasCreate: spies.openCanvasCreate,

    undoLast: spies.undoLast,
    redoLast: spies.redoLast,
    historyDepth: { undo: 0, redo: 0 },

    showChapterNotes: start.showChapterNotes ?? false,
    setShowChapterNotes: vi.fn(),
    graphLayers: start.graphLayers ?? { ...CHAPTER_SPINE_LAYERS },
    toggleGraphLayer: spies.toggleGraphLayer,
    showAllGraphLayers: spies.showAllGraphLayers,
    showChapterSpine: spies.showChapterSpine,
    nodes: [],
    canvasNodes: [],
    edges: [],
    flowRef: { current: null },
    pendingPanRef: { current: null },
    panCanvas: spies.panCanvas,
    handleNodesChange: spies.handleNodesChange,
    onEdgesChange: spies.onEdgesChange,
    onConnect: spies.onConnect,
    onConnectStart: spies.onConnectStart,
    onConnectEnd: spies.onConnectEnd,
    onNodeDragStart: spies.onNodeDragStart,
    onNodeDragStop: spies.onNodeDragStop,
    selectNode: spies.selectNode,
    selectEdge: spies.selectEdge,
    removeNodes: spies.removeNodes,
    removeEdges: spies.removeEdges,

    characters: [],
    castStats: {},
    draggingCastId: null,
    setDraggingCastId: spies.setDraggingCastId,
    setDropTargetNodeId: spies.setDropTargetNodeId,
    copyCardFromRail: spies.copyCardFromRail,
    placeQuestFromRail: spies.placeQuestFromRail,
    unplacedQuests: [],
    nodeUnderPointer: spies.nodeUnderPointer,
    dropCastMember: spies.dropCastMember,

    selectedEdgeId: null,
    closeEdge: spies.closeEdge,
    selectedEdge: null,
    edgeLabelDraft: start.edgeLabelDraft ?? '',
    setEdgeLabelDraft: vi.fn(),
    edgeRelationDraft: start.edgeRelationDraft ?? '',
    setEdgeRelationDraft: vi.fn(),
    saveEdge: spies.saveEdge,
    edgeEditError: null,

    selectedNode: null,
    selectedNodeId: null,
    nodeIsDirty: false,
    closeNodeInspector: spies.closeNodeInspector,
    nodeLabelDraft: start.nodeLabelDraft ?? '',
    setNodeLabelDraft: vi.fn(),
    nodeContentDraft: start.nodeContentDraft ?? '',
    setNodeContentDraft: vi.fn(),
    rememberNodeDraft: spies.rememberNodeDraft,
    renameOffer: null,
    setRenameOffer: spies.setRenameOffer,
    applyRenameOffer: spies.applyRenameOffer,
    nodeEditError: null,
    saveNode: spies.saveNode,
    closePrompt: start.closePrompt ?? false,
    setClosePrompt: vi.fn(),
    discardNodeDraft: spies.discardNodeDraft,
    changeNodeCharacter: spies.changeNodeCharacter,
    onOpenSheet: spies.onOpenSheet,
    onOpenChapter: spies.onOpenChapter,
    systemEventChoices: [],

    skills: [],
    skillHolderCharacterId: start.skillHolderCharacterId ?? '',
    setSkillHolderCharacterId: vi.fn(),
    skillHolderRank: start.skillHolderRank ?? '',
    setSkillHolderRank: vi.fn(),
    skillHolderChapterId: start.skillHolderChapterId ?? '',
    setSkillHolderChapterId: vi.fn(),
    skillHolderError: null,
    setSkillHolderError: spies.setSkillHolderError,
    savingSkillHolder: false,
    chapterChoices: [],
    addSkillHolder: spies.addSkillHolder,

    inspectorCharacter: null,
    inspectorStats: [],
    inspectorAttributes: [],
    inspectorError: null,
    inspectorStatId: start.inspectorStatId ?? null,
    setInspectorStatId: vi.fn(),
    inspectorStatValue: start.inspectorStatValue ?? '',
    setInspectorStatValue: vi.fn(),
    startInspectorStat: spies.startInspectorStat,
    saveInspectorStat: spies.saveInspectorStat,
    inspectorAttrId: start.inspectorAttrId ?? null,
    setInspectorAttrId: vi.fn(),
    inspectorAttrValue: start.inspectorAttrValue ?? '',
    setInspectorAttrValue: vi.fn(),
    startInspectorAttribute: spies.startInspectorAttribute,
    saveInspectorAttribute: spies.saveInspectorAttribute,
  };

  return { ...base, ...overrides };
}

// The drafts the app owns, held here as real state so typing reaches the tab the
// way it does in the app. Only the fields a test types into or toggles are real;
// the rest arrive from props.
function Harness({
  spies,
  start = {},
  overrides = {},
}: {
  spies: Spies;
  start?: Start;
  overrides?: Partial<GraphTabProps>;
}) {
  // The drafts start where the app would have them: an override or a start
  // value is the value on screen, and a keystroke moves it from there.
  const wired = props(spies, start, overrides);

  const [newNodeType, setNewNodeType] = useState<NodeType>(wired.newNodeType);
  const [newNodeLabel, setNewNodeLabel] = useState(wired.newNodeLabel);
  const [showChapterNotes, setShowChapterNotes] = useState(wired.showChapterNotes);
  const [edgeLabelDraft, setEdgeLabelDraft] = useState(wired.edgeLabelDraft);
  const [edgeRelationDraft, setEdgeRelationDraft] = useState(wired.edgeRelationDraft);
  const [nodeLabelDraft, setNodeLabelDraft] = useState(wired.nodeLabelDraft);
  const [nodeContentDraft, setNodeContentDraft] = useState(wired.nodeContentDraft);
  const [skillHolderCharacterId, setSkillHolderCharacterId] = useState(
    wired.skillHolderCharacterId
  );
  const [skillHolderRank, setSkillHolderRank] = useState(wired.skillHolderRank);
  const [skillHolderChapterId, setSkillHolderChapterId] = useState(
    wired.skillHolderChapterId
  );
  const [closePrompt, setClosePrompt] = useState(wired.closePrompt);
  const [inspectorStatId, setInspectorStatId] = useState(wired.inspectorStatId);
  const [inspectorStatValue, setInspectorStatValue] = useState(wired.inspectorStatValue);
  const [inspectorAttrId, setInspectorAttrId] = useState(wired.inspectorAttrId);
  const [inspectorAttrValue, setInspectorAttrValue] = useState(wired.inspectorAttrValue);

  return (
    <GraphTab
      {...wired}
      newNodeType={newNodeType}
      setNewNodeType={setNewNodeType}
      newNodeLabel={newNodeLabel}
      setNewNodeLabel={setNewNodeLabel}
      showChapterNotes={showChapterNotes}
      setShowChapterNotes={setShowChapterNotes}
      edgeLabelDraft={edgeLabelDraft}
      setEdgeLabelDraft={setEdgeLabelDraft}
      edgeRelationDraft={edgeRelationDraft}
      setEdgeRelationDraft={setEdgeRelationDraft}
      nodeLabelDraft={nodeLabelDraft}
      setNodeLabelDraft={setNodeLabelDraft}
      nodeContentDraft={nodeContentDraft}
      setNodeContentDraft={setNodeContentDraft}
      skillHolderCharacterId={skillHolderCharacterId}
      setSkillHolderCharacterId={setSkillHolderCharacterId}
      skillHolderRank={skillHolderRank}
      setSkillHolderRank={setSkillHolderRank}
      skillHolderChapterId={skillHolderChapterId}
      setSkillHolderChapterId={setSkillHolderChapterId}
      closePrompt={closePrompt}
      setClosePrompt={setClosePrompt}
      inspectorStatId={inspectorStatId}
      setInspectorStatId={setInspectorStatId}
      inspectorStatValue={inspectorStatValue}
      setInspectorStatValue={setInspectorStatValue}
      inspectorAttrId={inspectorAttrId}
      setInspectorAttrId={setInspectorAttrId}
      inspectorAttrValue={inspectorAttrValue}
      setInspectorAttrValue={setInspectorAttrValue}
    />
  );
}

function open(overrides: Partial<GraphTabProps> = {}, start: Start = {}) {
  const spies = canvasSpies();
  render(<Harness spies={spies} start={start} overrides={overrides} />);
  return spies;
}

describe('the layers', () => {
  // A board with every card on it is a good place to look and a poor place to
  // start, so the chips say what is drawn and one click changes it.
  it('opens with the chapter spine on and the other two off', () => {
    open();

    const chips = screen.getByRole('group', { name: 'Layers' });

    expect(within(chips).getByRole('button', { name: 'Chapter spine' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(chips).getByRole('button', { name: 'Arcs & quests' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(within(chips).getByRole('button', { name: 'Entities' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    // Something is hidden, so the whole web is one press away.
    expect(within(chips).getByRole('button', { name: 'Show all' })).toBeEnabled();
  });

  it('switches the layer the chip names', async () => {
    const spies = open();

    await userEvent.click(screen.getByRole('button', { name: 'Entities' }));
    await userEvent.click(screen.getByRole('button', { name: 'Arcs & quests' }));

    expect(spies.toggleGraphLayer).toHaveBeenNthCalledWith(1, 'entities');
    expect(spies.toggleGraphLayer).toHaveBeenNthCalledWith(2, 'arcs');
  });

  it('takes the chips and the presets from the layers the app holds', async () => {
    const spies = open({}, { graphLayers: allLayers() });
    const chips = screen.getByRole('group', { name: 'Layers' });

    expect(within(chips).getByRole('button', { name: 'Entities' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // Everything is already drawn, so there is nothing for Show all to do.
    expect(within(chips).getByRole('button', { name: 'Show all' })).toBeDisabled();

    await userEvent.click(within(chips).getByRole('button', { name: 'Chapters only' }));

    expect(spies.showChapterSpine).toHaveBeenCalledTimes(1);
  });

  it('says what each chip hides in its tooltip', () => {
    open();

    expect(screen.getByRole('button', { name: 'Entities' })).toHaveAttribute(
      'title',
      expect.stringContaining('Click to show')
    );
    expect(screen.getByRole('button', { name: 'Chapter spine' })).toHaveAttribute(
      'title',
      expect.stringContaining('Click to hide')
    );
  });
});

describe('connection kinds', () => {
  // The board draws two kinds of line. A cast or skill line repeats what a
  // badge or a sheet already says, so it is the quiet one; everything else is
  // the story's own shape.
  it('marks a cast or skill line as an assignment, and the rest as flow', () => {
    expect(edgeKindClass('cast')).toBe('storyboard-assignment');
    expect(edgeKindClass('SKILL')).toBe('storyboard-assignment');
    expect(edgeKindClass('unlocks')).toBe('storyboard-flow');
    expect(edgeKindClass(null)).toBe('storyboard-flow');
  });
});

describe('the graph tab', () => {
  it('asks for a story before it draws a board', () => {
    open({ story: null });

    expect(screen.getByText('Select or create a story')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Node' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Cast')).not.toBeInTheDocument();
  });

  describe('the toolbar', () => {
    it('adds a cast card with no label yet, because its form asks for the name', async () => {
      const user = userEvent.setup();
      const spies = open();

      const add = screen.getByRole('button', { name: 'Add Node' });
      // A card that carries a record of its own opens a form that asks what to
      // call it, so the toolbar does not insist on a label first.
      expect(add).toBeEnabled();

      await user.click(add);
      expect(spies.openCanvasCreate).toHaveBeenCalledTimes(1);
    });

    it('will not add a plain card that would have nothing on it', async () => {
      const user = userEvent.setup();
      const spies = open({}, { newNodeType: 'idea' });

      const add = screen.getByRole('button', { name: 'Add Node' });
      expect(add).toBeDisabled();

      await user.type(screen.getByPlaceholderText('Node label'), 'Vault');
      expect(add).toBeEnabled();

      await user.click(add);
      expect(spies.openCanvasCreate).toHaveBeenCalledTimes(1);
    });

    it('adds from the label field without reaching for the button', async () => {
      const user = userEvent.setup();
      const spies = open();

      await user.type(screen.getByPlaceholderText('Node label'), 'Vault{Enter}');

      expect(spies.openCanvasCreate).toHaveBeenCalledTimes(1);
    });

    it('walks the history only as far as there is one', async () => {
      const user = userEvent.setup();
      const spies = open({ historyDepth: { undo: 1, redo: 2 } });

      const undo = screen.getByRole('button', { name: 'Undo' });
      const redo = screen.getByRole('button', { name: 'Redo' });
      expect(undo).toBeEnabled();
      expect(redo).toBeEnabled();

      await user.click(undo);
      await user.click(redo);
      expect(spies.undoLast).toHaveBeenCalledTimes(1);
      expect(spies.redoLast).toHaveBeenCalledTimes(1);
    });

    it('offers no history to walk on a story that has none yet', () => {
      open({ historyDepth: { undo: 0, redo: 0 } });

      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    });

    it('toggles the chapter notes pinned under their chapters', async () => {
      const user = userEvent.setup();
      open();

      const toggle = screen.getByRole('button', { name: 'Show notes' });
      expect(toggle).toHaveAttribute('aria-pressed', 'false');

      await user.click(toggle);

      expect(screen.getByRole('button', { name: 'Hide notes' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    it('opens the search palette from the toolbar', async () => {
      const user = userEvent.setup();
      const spies = open();

      await user.click(screen.getByRole('button', { name: 'Search' }));

      expect(spies.openSearch).toHaveBeenCalledTimes(1);
    });

    it('pans to a place another tab asked for when the board is ready', () => {
      const spies = open();
      const pending = { current: { x: 120, y: -40 } };

      render(
        <Harness
          spies={spies}
          overrides={{ pendingPanRef: pending }}
        />
      );

      // The board hands its instance back on mount, and that is when a pan that
      // was asked for while another tab was open is finally applied.
      const onInit = boardProps.current?.onInit as (instance: unknown) => void;
      expect(typeof onInit).toBe('function');

      onInit({});

      expect(spies.panCanvas).toHaveBeenCalledWith(120, -40);
      expect(pending.current).toBeNull();
    });
  });

  describe('the cast rail', () => {
    it('says where a cast member comes from when there is none', () => {
      open();

      expect(
        screen.getByText('No cast yet — add someone on the Characters tab.')
      ).toBeInTheDocument();
    });

    it('shows a level and as many numbers as a chip has room for', () => {
      open({
        characters: [mira],
        castStats: {
          [mira.id]: [stat('st-1', 'STR', 12), stat('st-2', 'AGI', 9), stat('st-3', 'LUCK', 4)],
        },
      });

      expect(screen.getByText('Lv 3 · STR 12 · AGI 9')).toBeInTheDocument();
      expect(screen.queryByText(/LUCK/)).not.toBeInTheDocument();
      expect(NODE_STAT_BADGES).toBe(2);
    });

    it('leaves the level off a chip read from an older story', () => {
      open({ characters: [rook], castStats: { [rook.id]: [stat('st-1', 'STR', 12, rook.id)] } });

      expect(screen.getByText('STR 12')).toBeInTheDocument();
    });

    it('carries the cast member id when a chip is dragged, not its name', () => {
      const spies = open({ characters: [mira] });

      const chip = screen.getByTitle('Drag Mira onto the canvas');
      const payload: Record<string, string> = {};
      fireEvent.dragStart(chip, {
        dataTransfer: {
          setData: (type: string, value: string) => {
            payload[type] = value;
          },
          effectAllowed: '',
        },
      });

      expect(payload[CAST_DRAG_TYPE]).toBe(mira.id);
      expect(spies.setDraggingCastId).toHaveBeenCalledWith(mira.id);
    });

    it('lets go of the drop target when the drag ends', () => {
      const spies = open({ characters: [mira] });

      fireEvent.dragEnd(screen.getByTitle('Drag Mira onto the canvas'));

      expect(spies.setDraggingCastId).toHaveBeenCalledWith(null);
      expect(spies.setDropTargetNodeId).toHaveBeenCalledWith(null);
    });

    it('opens the canvas to a drop while a chip is in the air', () => {
      open({ characters: [mira], draggingCastId: mira.id });

      expect(document.querySelector('.graph-canvas.drop-ready')).not.toBeNull();
    });
  });

  describe('the cards list', () => {
    const item = node('n-item', 'Tooth key', 'item');

    it('names the story’s cards once, however many copies are on the board', () => {
      open({
        nodes: [
          item,
          node('n-item-2', 'Tooth key', 'item'),
          node('n-loc', 'The Vault', 'location'),
        ],
      });

      const items = screen.getByRole('region', { name: 'Items' });
      expect(within(items).getAllByText('Tooth key')).toHaveLength(1);
      expect(screen.getByRole('region', { name: 'Locations' })).toBeInTheDocument();
    });

    it('accepts the drag as a copy, so the browser lets the card land', () => {
      open({ nodes: [item] });

      const canvas = document.querySelector('.graph-canvas') as HTMLElement;
      const dataTransfer = {
        types: [CARD_DRAG_TYPE],
        effectAllowed: 'copy',
        dropEffect: 'none',
        getData: () => '',
        setData: () => {},
      };
      const dragOver = new MouseEvent('dragover', {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(dragOver, 'dataTransfer', { value: dataTransfer });
      fireEvent(canvas, dragOver);

      // The tile offers a copy, so the board asks for a copy: a board asking for
      // a move refuses a drag that only offers to copy it.
      expect(dragOver.defaultPrevented).toBe(true);
      expect(dataTransfer.dropEffect).toBe('copy');
    });

    it('asks for a copy at the point the tile was let go', () => {
      const spies = open({ nodes: [item] });
      const tile = screen.getByTitle('Drag another Tooth key card onto the board');
      const payload: Record<string, string> = {};

      fireEvent.dragStart(tile, {
        dataTransfer: {
          types: [],
          setData: (type: string, value: string) => {
            payload[type] = value;
          },
          getData: (type: string) => payload[type] ?? '',
          effectAllowed: '',
          dropEffect: '',
        },
      });

      expect(payload[CARD_DRAG_TYPE]).toBe(item.id);

      const canvas = document.querySelector('.graph-canvas') as HTMLElement;
      const drop = new MouseEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: 240,
        clientY: 120,
      });
      Object.defineProperty(drop, 'dataTransfer', {
        value: {
          types: [CARD_DRAG_TYPE],
          getData: (type: string) => payload[type] ?? '',
          effectAllowed: '',
          dropEffect: '',
        },
      });
      fireEvent(canvas, drop);

      // The board's own coordinates, so it lands under the pointer at any zoom.
      expect(spies.copyCardFromRail).toHaveBeenCalledWith(item.id, { x: 240, y: 120 });
    });

    it('places an unplaced quest where it is let go, writing its card', () => {
      const spies = open({
        nodes: [],
        unplacedQuests: [{ id: 'q-1', title: 'The Ledger' }],
      });

      const tile = screen.getByTitle(
        'Drag “The Ledger” onto the board to place its card'
      );
      expect(tile).toHaveTextContent('Unplaced');

      const payload: Record<string, string> = {};
      fireEvent.dragStart(tile, {
        dataTransfer: {
          types: [],
          setData: (type: string, value: string) => {
            payload[type] = value;
          },
          getData: (type: string) => payload[type] ?? '',
          effectAllowed: '',
          dropEffect: '',
        },
      });

      // The drag carries the ledger row, not a card: there is no card yet.
      expect(payload[QUEST_DRAG_TYPE]).toBe('q-1');

      const canvas = document.querySelector('.graph-canvas') as HTMLElement;
      const drop = new MouseEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: 320,
        clientY: 90,
      });
      Object.defineProperty(drop, 'dataTransfer', {
        value: {
          types: [QUEST_DRAG_TYPE],
          getData: (type: string) => payload[type] ?? '',
          effectAllowed: '',
          dropEffect: '',
        },
      });
      fireEvent(canvas, drop);

      expect(spies.placeQuestFromRail).toHaveBeenCalledWith('q-1', { x: 320, y: 90 });
    });
  });

  describe('the skill card\u2019s holders', () => {
    const skillCard = node('n-skill', 'Arcane Sight', 'skill');
    const chapterOne = node('n-ch-1', 'One', 'chapter');

    function holderProps(overrides: Partial<GraphTabProps> = {}) {
      return {
        selectedNode: skillCard,
        selectedNodeId: skillCard.id,
        chapterChoices: [chapterOne],
        ...overrides,
      };
    }

    it('lists the holders with the rank and chapter each learned it in, sorted by name', () => {
      open(
        holderProps({
          nodes: [skillCard, chapterOne],
          characters: [mira, rook],
          skills: [
            skill('sk-1', rook.id),
            skill('sk-2', mira.id, chapterOne.id),
          ],
        })
      );

      const holders = screen.getByRole('list');
      expect(
        within(holders)
          .getAllByRole('listitem')
          .map(row => row.textContent)
      ).toEqual(['MiraOne', 'RookNo chapter']);
    });

    it('names a holder whose card is gone rather than dropping the row', () => {
      open(
        holderProps({
          // The chapter card is not on the board any more, so the row cannot
          // show where it was learned.
          characters: [mira],
          skills: [skill('sk-1', mira.id, 'n-ch-gone')],
        })
      );

      const holders = screen.getByRole('list');
      expect(within(holders).getByText('Mira')).toBeInTheDocument();
      expect(within(holders).getByText('No chapter')).toBeInTheDocument();
    });

    it('says so when a holder is no longer in the cast', () => {
      open(
        holderProps({
          // Rook holds it but was deleted, so the row names where he went.
          characters: [mira],
          skills: [skill('sk-1', rook.id)],
        })
      );

      const holders = screen.getByRole('list');
      expect(within(holders).getByText('Cast member in the trash')).toBeInTheDocument();
    });

    it('counts the holders and says when there are none', () => {
      open(holderProps());

      expect(screen.getByText('nobody yet')).toBeInTheDocument();
      expect(
        screen.getByText(/No one has this skill yet/)
      ).toBeInTheDocument();
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });

    it('offers only the cast members who do not hold the card yet', () => {
      open(
        holderProps({
          characters: [mira, rook],
          skills: [skill('sk-1', mira.id)],
        })
      );

      expect(screen.getByText('1 character')).toBeInTheDocument();

      const choose = screen.getByLabelText('Character');
      const offered = within(choose)
        .getAllByRole('option')
        .map(option => option.textContent);

      // Mira already holds it: the database refuses a second row with the same
      // name, but not offering it is clearer than an error after the click.
      expect(offered).toEqual(['Choose a character', 'Rook']);
    });

    it('says when everyone in the cast already holds the card', () => {
      open(
        holderProps({
          characters: [mira],
          skills: [skill('sk-1', mira.id)],
        })
      );

      expect(
        screen.getByText('Everyone in the cast already holds this card.')
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Add a character first — a skill needs someone to hold it.')
      ).not.toBeInTheDocument();
    });

    it('asks for a cast member before a holder can be added at all', () => {
      open(holderProps());

      expect(
        screen.getByText('Add a character first — a skill needs someone to hold it.')
      ).toBeInTheDocument();
      expect(screen.queryByText(/Everyone in the cast already holds/)).not.toBeInTheDocument();
    });

    it('adds a holder from the chosen character, rank and chapter', async () => {
      const user = userEvent.setup();
      const spies = open(
        holderProps({
          characters: [mira, rook],
          skills: [],
        }),
        { skillHolderCharacterId: rook.id }
      );

      const add = screen.getByRole('button', { name: 'Add holder' });
      expect(add).toBeEnabled();

      await user.click(add);
      expect(spies.addSkillHolder).toHaveBeenCalledTimes(1);
    });

    it('adds from the rank field without reaching for the button', async () => {
      const user = userEvent.setup();
      const spies = open(
        holderProps({ characters: [rook], skills: [] }),
        { skillHolderCharacterId: rook.id }
      );

      await user.type(screen.getByLabelText('Rank'), 'Apprentice{Enter}');

      expect(spies.addSkillHolder).toHaveBeenCalledTimes(1);
    });

    it('refuses to add a holder while the card has unsaved changes', () => {
      open(
        holderProps({ characters: [rook], skills: [], nodeIsDirty: true }),
        { skillHolderCharacterId: rook.id }
      );

      expect(screen.getByRole('button', { name: 'Add holder' })).toBeDisabled();
      expect(
        screen.getByText("Save the card's label and notes before adding a holder.")
      ).toBeInTheDocument();
    });

    it('refuses to add a holder until a character is chosen', () => {
      open(holderProps({ characters: [rook], skills: [] }));

      expect(screen.getByRole('button', { name: 'Add holder' })).toBeDisabled();
    });

    it('shows what the last holder write said', () => {
      open(holderProps({ characters: [rook], skills: [], skillHolderError: 'Rook is full' }));

      expect(screen.getByText('Rook is full')).toBeInTheDocument();
    });

    it('shows the holders beside the card and nowhere else', () => {
      open({
        characters: [mira],
        skills: [skill('sk-1', mira.id)],
        selectedNode: node('n-chapter', 'One', 'chapter'),
      });

      expect(screen.queryByLabelText('Skill holders')).not.toBeInTheDocument();
    });
  });

  describe('the connection editor', () => {
    const first = node('n-1', 'Mira', 'character');
    const second = node('n-2', 'Vault', 'location');

    function openEditor(overrides: Partial<GraphTabProps> = {}) {
      return open({
        nodes: [first, second],
        selectedEdgeId: 'e-1',
        selectedEdge: edge('e-1', first.id, second.id),
        ...overrides,
      });
    }

    it('reads both ends of the line from the cards it joins', () => {
      openEditor();

      expect(screen.getByText('Edit connection')).toBeInTheDocument();
      expect(screen.getByText('Mira → Vault')).toBeInTheDocument();
    });

    it('shows a question mark for an end that is no longer on the board', () => {
      openEditor({ selectedEdge: edge('e-1', first.id, 'n-gone') });

      expect(screen.getByText('Mira → ?')).toBeInTheDocument();
    });

    it('saves the label and the verb it carries', async () => {
      const user = userEvent.setup();
      const spies = openEditor();

      await user.type(screen.getByPlaceholderText('Label (optional)'), 'opens');
      await user.type(screen.getByPlaceholderText('Relation type (optional)'), 'unlocks');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(spies.saveEdge).toHaveBeenCalledTimes(1);
      // The drafts are the app's, so what the tab owes it is the keystrokes.
      expect(await screen.findByDisplayValue('unlocks')).toBeInTheDocument();
    });

    it('saves from either field without reaching for the button', async () => {
      const user = userEvent.setup();
      const spies = openEditor();

      await user.type(screen.getByPlaceholderText('Label (optional)'), 'opens{Enter}');

      expect(spies.saveEdge).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape rather than saving', async () => {
      const user = userEvent.setup();
      const spies = openEditor();

      await user.type(screen.getByPlaceholderText('Relation type (optional)'), '{Escape}');

      expect(spies.closeEdge).toHaveBeenCalledTimes(1);
      expect(spies.saveEdge).not.toHaveBeenCalled();
    });

    it('says why a connection was refused', () => {
      openEditor({ edgeEditError: 'A bond keeps its type' });

      expect(screen.getByText('A bond keeps its type')).toBeInTheDocument();
    });

    it('stays out of the way until a connection is picked', () => {
      open({ nodes: [first, second] });

      expect(screen.queryByText('Edit connection')).not.toBeInTheDocument();
    });
  });

  describe('the node drawer', () => {
    const card = node('n-1', 'Mira', 'character', { characterId: mira.id });

    function openDrawer(overrides: Partial<GraphTabProps> = {}, start: Start = {}) {
      return open(
        {
          nodes: [card],
          selectedNode: card,
          selectedNodeId: card.id,
          nodeLabelDraft: start.nodeLabelDraft ?? 'Mira',
          ...overrides,
        },
        start
      );
    }

    it('says when the card is the whole record', () => {
      const place = node('n-2', 'The Low Tide Gate', 'location');

      open({
        nodes: [place],
        selectedNode: place,
        selectedNodeId: place.id,
        nodeLabelDraft: place.data.label,
      });

      expect(
        screen.getByText(
          'This card is the record for this location: nothing else in the story stores it.'
        )
      ).toBeInTheDocument();
    });

    it('says nothing of the sort for a card that is a view of a record', () => {
      // A character is a sheet with a card in front of it, so the drawer has no
      // reason to call the card the record.
      openDrawer();

      expect(screen.queryByText(/nothing else in the story stores it/)).toBeNull();
    });

    it('names the quests that lean on a faction card, and opens them', async () => {
      const user = userEvent.setup();
      const onOpenQuest = vi.fn();
      const guild = node('n-3', 'The Salt Choir', 'faction', {
        factionQuests: [
          { id: 'q-1', title: 'The Ninth Bell' },
          { id: 'q-2', title: 'Find the Drowned Stair' },
        ],
        onOpenQuest,
      });

      open({
        nodes: [guild],
        selectedNode: guild,
        selectedNodeId: guild.id,
        nodeLabelDraft: guild.data.label,
      });

      // The card is the whole record of the faction, so the note says what points
      // at it rather than leaving a purge to be a surprise.
      expect(
        screen.getByText(
          'This card is the record for this faction: its quests and standings name it, and nothing else in the story stores it.'
        )
      ).toBeInTheDocument();

      const naming = screen.getByRole('region', {
        name: 'Quests naming this faction',
      });
      expect(within(naming).getByText('2 quests')).toBeInTheDocument();

      await user.click(within(naming).getByRole('button', { name: 'The Ninth Bell' }));

      expect(onOpenQuest).toHaveBeenCalledWith('q-1');
    });

    it('shows a system card as the box its fields make, with the copy beside it', () => {
      const notice = node('n-4', '[SYSTEM ANNOUNCEMENT]', 'system', {
        content: 'The Choir Notes You\nThe Salt Choir has taken an interest.',
      });

      open(
        {
          nodes: [notice],
          selectedNode: notice,
          selectedNodeId: notice.id,
          nodeLabelDraft: notice.data.label,
        },
        { nodeContentDraft: 'The Choir Notes You\nThe Salt Choir has taken an interest.' }
      );

      const box = screen.getByRole('region', { name: 'System box' });

      expect(within(box).getByText('[SYSTEM ANNOUNCEMENT]')).toHaveClass(
        'system-box-header'
      );
      expect(within(box).getByText('The Choir Notes You')).toHaveClass('system-box-title');
      // The copy is of what the drawer is holding, not of the last saved row.
      expect(
        within(box).getByRole('button', { name: 'Copy System Box' })
      ).toBeInTheDocument();
    });

    it('turns a notice into a level-up box, and writes that into its notes', async () => {
      const user = userEvent.setup();
      const system = node('n-4', '[TIDAL LEDGER]', 'system', {
        content: 'Level 4\n+2 to place',
      });

      const spies = open(
        {
          nodes: [system],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
        },
        { nodeContentDraft: 'Level 4\n+2 to place' }
      );

      const box = screen.getByRole('region', { name: 'System box' });

      await user.selectOptions(within(box).getByLabelText('Message type'), 'level_up');

      // The level fields the kind asks for were not in the drawer before.
      await user.type(within(box).getByLabelText('Level from'), '3');
      await user.type(within(box).getByLabelText('Level to'), '4');
      await user.type(within(box).getByLabelText('Points to place'), '2');

      expect(spies.rememberNodeDraft).toHaveBeenLastCalledWith('n-4', {
        label: '[TIDAL LEDGER]',
        content: [
          'Type: level_up',
          'Title: Level 4',
          'Level: 3 → 4',
          'Points: 2',
          '---',
          '+2 to place',
        ].join('\n'),
      });

      // And the box beside the fields is drawn from what they hold.
      expect(within(box).getByText('Level 3 → 4')).toHaveClass('system-box-level');
      expect(within(box).getByText('2 points to place')).toHaveClass('system-box-points');
    });

    it('adds stat rows to a level-up and prints each one with its change', async () => {
      const user = userEvent.setup();
      const system = node('n-4', '[TIDAL LEDGER]', 'system', {
        content: 'Type: level_up\nTitle: The Tide Advances',
      });

      const spies = open(
        {
          nodes: [system],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
        },
        { nodeContentDraft: system.data.content ?? '' }
      );

      const box = screen.getByRole('region', { name: 'System box' });

      await user.click(within(box).getByRole('button', { name: 'Add stat' }));
      await user.type(within(box).getByLabelText('Stat 1 name'), 'Agility');
      await user.type(within(box).getByLabelText('Stat 1 from'), '12');
      await user.type(within(box).getByLabelText('Stat 1 to'), '13');

      expect(spies.rememberNodeDraft).toHaveBeenLastCalledWith('n-4', {
        label: '[TIDAL LEDGER]',
        content: [
          'Type: level_up',
          'Title: The Tide Advances',
          'Stat: Agility | 12 → 13',
        ].join('\n'),
      });
      expect(within(box).getByText('Agility: 12 → 13')).toBeInTheDocument();
      expect(within(box).getByText('+1')).toHaveClass('system-box-delta');
    });

    it('takes a quest’s objectives and ticks them into the box', async () => {
      const user = userEvent.setup();
      const system = node('n-4', '[QUEST]', 'system', { content: 'Type: quest' });

      const spies = open(
        {
          nodes: [system],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
        },
        { nodeContentDraft: 'Type: quest' }
      );

      const box = screen.getByRole('region', { name: 'System box' });

      await user.type(within(box).getByLabelText('Title'), 'The Drowned Stair');
      await user.click(within(box).getByRole('button', { name: 'Add objective' }));
      await user.type(
        within(box).getByLabelText('Objective 1 text'),
        'Reach the Drowned Stair'
      );
      await user.click(within(box).getByLabelText('Objective 1 done'));

      expect(spies.rememberNodeDraft).toHaveBeenLastCalledWith('n-4', {
        label: '[QUEST]',
        content: [
          'Type: quest',
          'Title: The Drowned Stair',
          'Status: accepted',
          'Objective: [x] Reach the Drowned Stair',
        ].join('\n'),
      });
      expect(
        within(box).getByText('QUEST ACCEPTED', { selector: '.system-box-status' })
      ).toBeInTheDocument();
    });

    it('writes the stat gains the crossed levels recorded into the box', async () => {
      const user = userEvent.setup();
      const system = node('n-4', '[TIDAL LEDGER]', 'system', { content: 'Type: notice' });

      const spies = open(
        {
          nodes: [system],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
          systemEventChoices: [
            {
              id: 'e-1',
              chapterId: 'ch-3',
              label: 'Ch. 3 · Ivy Marrow · 600 XP, level 2 → 3',
              prefill: {
                kind: 'level_up',
                title: 'The Drowned Stair',
                levelFrom: '2',
                levelTo: '3',
                points: '4',
                stats: [{ name: 'Insight', from: '12', to: '13' }],
              },
            },
          ],
        },
        { nodeContentDraft: 'Type: notice' }
      );

      const box = screen.getByRole('region', { name: 'System box' });

      await user.selectOptions(within(box).getByLabelText('Write from a chapter event'), 'e-1');

      expect(spies.rememberNodeDraft).toHaveBeenLastCalledWith('n-4', {
        label: '[TIDAL LEDGER]',
        content: [
          'Type: level_up',
          'Title: The Drowned Stair',
          'Level: 2 → 3',
          'Points: 4',
          'Stat: Insight | 12 → 13',
        ].join('\n'),
      });
      expect(within(box).getByLabelText('Stat 1 name')).toHaveValue('Insight');
      expect(within(box).getByText('Insight: 12 → 13')).toBeInTheDocument();
      expect(within(box).getByText('+1')).toHaveClass('system-box-delta');
    });

    it('shows what the two copies will paste, under the box', async () => {
      const user = userEvent.setup();
      const system = node('n-4', '[TIDAL LEDGER]', 'system', { content: 'Type: notice' });

      open(
        {
          nodes: [system],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
        },
        {
          nodeContentDraft: ['Type: level_up', 'Title: The Tide Advances', 'Level: 3 → 4'].join(
            '\n'
          ),
        }
      );

      const box = screen.getByRole('region', { name: 'System box' });
      const preview = within(box).getByRole('region', { name: 'Copy preview' });

      expect(preview.querySelector('pre')).toHaveTextContent('**[TIDAL LEDGER]**');
      expect(preview.querySelector('pre')).toHaveTextContent('**Level 3 → 4**');

      // It reads the drawer's draft rather than the last saved row, so the
      // preview answers while the author is still typing.
      const title = within(box).getByLabelText('Title');

      await user.clear(title);
      await user.type(title, 'The Tide Turns');

      expect(preview.querySelector('pre')).toHaveTextContent('**The Tide Turns**');
    });

    it('writes a box from a chapter event the scene already logged', async () => {
      const user = userEvent.setup();
      const system = node('n-4', '[TIDAL LEDGER]', 'system', { content: 'Type: notice' });

      const spies = open(
        {
          nodes: [system],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
          systemEventChoices: [
            {
              id: 'e-1',
              chapterId: 'ch-3',
              label: 'Ch. 3 · Ivy Marrow · 600 XP, level 2 → 3',
              prefill: {
                kind: 'level_up',
                title: 'The Drowned Stair',
                levelFrom: '2',
                levelTo: '3',
                points: '4',
                body: 'Ivy Marrow is paid 600 XP in The Drowned Stair.',
              },
            },
          ],
        },
        { nodeContentDraft: 'Type: notice' }
      );

      const box = screen.getByRole('region', { name: 'System box' });

      await user.selectOptions(
        within(box).getByLabelText('Write from a chapter event'),
        'e-1'
      );

      // The fields are filled from the scene, and the card's notes are the box.
      expect(spies.rememberNodeDraft).toHaveBeenLastCalledWith('n-4', {
        label: '[TIDAL LEDGER]',
        content: [
          'Type: level_up',
          'Title: The Drowned Stair',
          'Level: 2 → 3',
          'Points: 4',
          '---',
          'Ivy Marrow is paid 600 XP in The Drowned Stair.',
        ].join('\n'),
      });

      expect(within(box).getByLabelText('Message type')).toHaveValue('level_up');
      expect(within(box).getByLabelText('Level from')).toHaveValue('2');
      expect(within(box).getByText('Level 2 → 3')).toHaveClass('system-box-level');
    });

    // A board with two chapters on it is two scenes, and the picker should not
    // ask the author which one they meant twice: the box's place says it.
    const chapterChoice = (id: string, chapterId: string, label: string) => ({
      id,
      chapterId,
      label,
      prefill: { kind: 'level_up' as const, title: label, levelFrom: '1', levelTo: '2' },
    });

    const placed = (nodeType: string, id: string, label: string, x: number, chapterSeq?: number) => ({
      ...node(id, label, nodeType, chapterSeq != null ? { chapterSeq } : {}),
      position: { x, y: 0 },
    });

    it('offers only the chapter the box sits nearest', () => {
      const system = placed('system', 'n-4', '[TIDAL LEDGER]', 900);
      const first = placed('chapter', 'n-1', 'The Low Tide', 0, 1);
      const second = placed('chapter', 'n-2', 'The Drowned Stair', 880, 2);

      open(
        {
          nodes: [first, second, system],
          edges: [],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
          systemEventChoices: [
            chapterChoice('e-1', 'n-1', 'Ch. 1 · Ivy Marrow · 600 XP, level 1 → 2'),
            chapterChoice('e-2', 'n-2', 'Ch. 2 · Ivy Marrow · 600 XP, level 2 → 3'),
          ],
        },
        { nodeContentDraft: 'Type: notice' }
      );

      const box = screen.getByRole('region', { name: 'System box' });
      const picker = within(box).getByLabelText('Write from a chapter event');

      expect(within(picker).queryByRole('option', { name: /Ch\. 1/ })).not.toBeInTheDocument();
      expect(within(picker).getByRole('option', { name: /Ch\. 2/ })).toBeInTheDocument();
      expect(
        within(box).getByText(
          'From Ch. 2 · The Drowned Stair, the nearest chapter card on the board.'
        )
      ).toBeInTheDocument();
    });

    it('opens every chapter’s events from the scoped picker, and closes it again', async () => {
      const user = userEvent.setup();
      const system = placed('system', 'n-4', '[TIDAL LEDGER]', 900);
      const first = placed('chapter', 'n-1', 'The Low Tide', 0, 1);
      const second = placed('chapter', 'n-2', 'The Drowned Stair', 880, 2);

      open(
        {
          nodes: [first, second, system],
          edges: [],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
          systemEventChoices: [
            chapterChoice('e-1', 'n-1', 'Ch. 1 · Ivy Marrow · 600 XP, level 1 → 2'),
            chapterChoice('e-2', 'n-2', 'Ch. 2 · Ivy Marrow · 600 XP, level 2 → 3'),
          ],
        },
        { nodeContentDraft: 'Type: notice' }
      );

      const box = screen.getByRole('region', { name: 'System box' });

      expect(within(box).queryByRole('option', { name: /Ch\. 1/ })).not.toBeInTheDocument();

      // The narrowing is a default, not a cage: one press shows the story's
      // other scenes, and the card has not moved.
      await user.click(within(box).getByRole('button', { name: 'Show every chapter' }));

      expect(within(box).getByRole('option', { name: /Ch\. 1/ })).toBeInTheDocument();
      expect(
        within(box).getByText('Every chapter, not just Ch. 2 · The Drowned Stair.')
      ).toBeInTheDocument();

      await user.click(within(box).getByRole('button', { name: 'This chapter only' }));

      expect(within(box).queryByRole('option', { name: /Ch\. 1/ })).not.toBeInTheDocument();
    });

    it('takes the chapter it is connected to over the closer one', () => {
      const system = placed('system', 'n-4', '[TIDAL LEDGER]', 0);
      const first = placed('chapter', 'n-1', 'The Low Tide', 0, 1);
      const second = placed('chapter', 'n-2', 'The Drowned Stair', 900, 2);

      open(
        {
          nodes: [first, second, system],
          edges: [edge('e-9', 'n-4', 'n-2')],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
          systemEventChoices: [
            chapterChoice('e-1', 'n-1', 'Ch. 1 · Ivy Marrow · 600 XP, level 1 → 2'),
            chapterChoice('e-2', 'n-2', 'Ch. 2 · Ivy Marrow · 600 XP, level 2 → 3'),
          ],
        },
        { nodeContentDraft: 'Type: notice' }
      );

      const box = screen.getByRole('region', { name: 'System box' });

      expect(
        within(box).getByText(
          'From Ch. 2 · The Drowned Stair, the chapter this box is connected to.'
        )
      ).toBeInTheDocument();
      expect(
        within(box).queryByRole('option', { name: /Ch\. 1/ })
      ).not.toBeInTheDocument();
    });

    it('offers the chapters either side when its own has nothing logged', async () => {
      const user = userEvent.setup();
      const system = placed('system', 'n-9', '[TIDAL LEDGER]', 780);
      const chapters = [
        placed('chapter', 'n-1', 'The Low Tide', 0, 1),
        placed('chapter', 'n-2', 'The Drowned Stair', 400, 2),
        placed('chapter', 'n-3', 'The Ninth Bell', 800, 3),
        placed('chapter', 'n-4', 'The Tally', 1200, 4),
        placed('chapter', 'n-5', 'After the Bell', 1600, 5),
      ];

      open(
        {
          nodes: [...chapters, system],
          edges: [],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
          systemEventChoices: [
            chapterChoice('e-1', 'n-1', 'Ch. 1 · Ivy Marrow · 600 XP, level 1 → 2'),
            chapterChoice('e-2', 'n-2', 'Ch. 2 · Ivy Marrow · 600 XP, level 2 → 3'),
            chapterChoice('e-4', 'n-4', 'Ch. 4 · Ivy Marrow · learns Salt-Sight'),
          ],
        },
        { nodeContentDraft: 'Type: notice' }
      );

      const box = screen.getByRole('region', { name: 'System box' });
      const picker = within(box).getByLabelText('Write from a chapter event');

      // The scene it sits beside has nothing to write, so the two scenes either
      // side of it are offered — not the whole story.
      expect(within(picker).queryByRole('option', { name: /Ch\. 1/ })).not.toBeInTheDocument();
      expect(within(picker).getByRole('option', { name: /Ch\. 2/ })).toBeInTheDocument();
      expect(within(picker).getByRole('option', { name: /Ch\. 4/ })).toBeInTheDocument();
      expect(
        within(box).getByText(
          'Nothing is logged in Ch. 3 · The Ninth Bell yet, so Ch. 2 · The Drowned Stair and Ch. 4 · The Tally are listed.'
        )
      ).toBeInTheDocument();

      await user.click(within(box).getByRole('button', { name: 'Show every chapter' }));

      expect(within(picker).getByRole('option', { name: /Ch\. 1/ })).toBeInTheDocument();
      expect(within(box).getByText('Every chapter, not just Ch. 3 · The Ninth Bell.')).toBeInTheDocument();

      await user.click(within(box).getByRole('button', { name: 'Nearby chapters only' }));

      expect(within(picker).queryByRole('option', { name: /Ch\. 1/ })).not.toBeInTheDocument();
    });

    it('lists the neighbour when it holds every event the story has', () => {
      const system = placed('system', 'n-4', '[TIDAL LEDGER]', 0);
      const first = placed('chapter', 'n-1', 'The Low Tide', 0, 1);
      const second = placed('chapter', 'n-2', 'The Drowned Stair', 900, 2);

      open(
        {
          nodes: [first, second, system],
          edges: [],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
          systemEventChoices: [
            chapterChoice('e-2', 'n-2', 'Ch. 2 · Ivy Marrow · 600 XP, level 2 → 3'),
          ],
        },
        { nodeContentDraft: 'Type: notice' }
      );

      const box = screen.getByRole('region', { name: 'System box' });

      // The near chapter has nothing to write, so the picker stays useful and
      // says why it is showing another scene.
      expect(within(box).getByRole('option', { name: /Ch\. 2/ })).toBeInTheDocument();
      expect(
        within(box).getByText(
          'Nothing is logged in Ch. 1 · The Low Tide yet, so Ch. 2 · The Drowned Stair is listed.'
        )
      ).toBeInTheDocument();

      // That neighbour is the whole story, so there is nothing left to widen to
      // and no press is offered.
      expect(
        within(box).queryByRole('button', { name: 'Show every chapter' })
      ).not.toBeInTheDocument();
    });

    it('keeps the plainer notes box off a system card', () => {
      const system = node('n-4', '[TIDAL LEDGER]', 'system', { content: 'Type: notice' });

      open(
        {
          nodes: [system],
          selectedNode: system,
          selectedNodeId: system.id,
          nodeLabelDraft: system.data.label,
        },
        { nodeContentDraft: 'Type: notice' }
      );

      expect(screen.queryByLabelText('Notes')).not.toBeInTheDocument();
    });

    it('names the standings held through a faction card, and opens their sheets', async () => {
      const user = userEvent.setup();
      const onOpenStandingSheet = vi.fn();
      const guild = node('n-3', 'The Salt Choir', 'faction', {
        factionStandings: [
          {
            id: 'standing-1',
            characterId: 'c-1',
            characterName: 'Mira',
            standing: 'member',
            note: null,
            chapterLabel: 'The Low Tide',
          },
          {
            id: 'standing-2',
            characterId: 'c-2',
            characterName: 'Rook',
            standing: 'wanted',
            note: null,
            chapterLabel: null,
          },
        ],
        onOpenStandingSheet,
      });

      open({
        nodes: [guild],
        selectedNode: guild,
        selectedNodeId: guild.id,
        nodeLabelDraft: guild.data.label,
      });

      const held = screen.getByRole('region', {
        name: 'Standings held through this faction',
      });
      expect(within(held).getByText('2')).toBeInTheDocument();
      expect(within(held).getByText('member')).toBeInTheDocument();
      expect(within(held).getByText('wanted')).toBeInTheDocument();

      await user.click(within(held).getByRole('button', { name: 'Mira' }));

      expect(onOpenStandingSheet).toHaveBeenCalledWith('c-1');
    });

    it('says when no quest names a faction card yet', () => {
      const guild = node('n-3', 'The Salt Choir', 'faction');

      open({
        nodes: [guild],
        selectedNode: guild,
        selectedNodeId: guild.id,
        nodeLabelDraft: guild.data.label,
      });

      const naming = screen.getByRole('region', {
        name: 'Quests naming this faction',
      });

      expect(within(naming).getByText('no quests yet')).toBeInTheDocument();
      expect(within(naming).queryByRole('button')).toBeNull();
    });

    it('names the card and says it has unsaved changes', () => {
      openDrawer({ nodeIsDirty: true });

      expect(screen.getByLabelText('Node inspector')).toBeInTheDocument();
      expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument();
    });

    it('remembers the draft a keystroke made, with the other field as it stands', async () => {
      const user = userEvent.setup();
      const spies = openDrawer(
        { nodeLabelDraft: 'Mira' },
        { nodeContentDraft: 'Bearer of the ledger' }
      );

      await user.type(screen.getByLabelText('Label'), '!');

      // The app keeps one draft per node, so both halves are written together.
      expect(spies.rememberNodeDraft).toHaveBeenLastCalledWith(card.id, {
        label: 'Mira!',
        content: 'Bearer of the ledger',
      });

      // Typing a label is a decision of its own, so a rename offer that was
      // about this node stops being one.
      expect(spies.setRenameOffer).toHaveBeenCalledWith(null);
    });

    it('remembers a note the same way, and leaves the rename offer alone', async () => {
      const user = userEvent.setup();
      const spies = openDrawer({ nodeLabelDraft: 'Mira' });

      await user.type(screen.getByLabelText('Notes'), 'x');

      expect(spies.rememberNodeDraft).toHaveBeenLastCalledWith(card.id, {
        label: 'Mira',
        content: 'x',
      });
      // A note says nothing about what the card is called, so the offer stands.
      expect(spies.setRenameOffer).not.toHaveBeenCalled();
    });

    it('will not save a card with no label', () => {
      openDrawer({ nodeLabelDraft: '   ' });

      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('asks before closing a card with unsaved changes', async () => {
      const user = userEvent.setup();
      const spies = openDrawer({ nodeLabelDraft: 'Mira', closePrompt: true });

      const prompt = screen.getByRole('alertdialog', { name: 'Unsaved changes' });
      await user.click(within(prompt).getByRole('button', { name: 'Save' }));
      expect(spies.saveNode).toHaveBeenCalledWith(true);

      await user.click(within(prompt).getByRole('button', { name: 'Discard' }));
      expect(spies.discardNodeDraft).toHaveBeenCalledTimes(1);

      await user.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('keeps a link to a cast member who is no longer in the cast', () => {
      const orphan = node('n-2', 'Vault', 'location', { characterId: 'c-gone' });
      openDrawer({
        characters: [mira],
        nodes: [orphan],
        selectedNode: orphan,
        selectedNodeId: orphan.id,
      });

      const choose = screen.getByLabelText('Cast member');
      const offered = within(choose)
        .getAllByRole('option')
        .map(option => option.textContent);

      // The link is kept and named, rather than silently pointing at nobody.
      expect(offered).toEqual([
        'Not linked',
        'Mira',
        'Linked cast member (not in the cast)',
      ]);
    });

    it('links a card to a cast member as soon as one is chosen', async () => {
      const user = userEvent.setup();
      const spies = openDrawer({ characters: [mira, rook] });

      await user.selectOptions(screen.getByLabelText('Cast member'), rook.id);

      expect(spies.changeNodeCharacter).toHaveBeenCalledWith(rook.id);
    });

    it('opens a linked card’s sheet from the drawer instead of only naming it', async () => {
      const user = userEvent.setup();
      const spies = openDrawer({ characters: [mira, rook] });

      await user.click(screen.getByRole('button', { name: "Open Mira's sheet" }));

      expect(spies.onOpenSheet).toHaveBeenCalledWith(mira.id);
    });

    it('shows a chapter’s roster and no single-cast link', async () => {
      const user = userEvent.setup();
      const onOpenChapterCast = vi.fn();
      const chapterCard = node('n-ch', 'Opening', 'chapter', {
        chapterCast: [
          { characterId: mira.id, name: 'Mira', level: 3, levelIsPenalty: false, skills: [] },
          { characterId: rook.id, name: 'Rook', level: null, levelIsPenalty: false, skills: [] },
        ],
        onOpenChapterCast,
      });

      const spies = openDrawer({
        characters: [mira, rook],
        nodes: [chapterCard],
        selectedNode: chapterCard,
        selectedNodeId: chapterCard.id,
        nodeLabelDraft: 'Opening',
      });

      // The roster is the whole of it: there is no second way to bind one name.
      expect(screen.queryByLabelText('Cast member')).not.toBeInTheDocument();
      expect(screen.getByText('2 in the scene')).toBeInTheDocument();
      expect(
        within(screen.getByLabelText('Chapter roster')).getByText('Lv 3')
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Mira' }));
      expect(onOpenChapterCast).toHaveBeenCalledWith(mira.id);

      await user.click(
        screen.getByRole('button', { name: 'Edit on the Chapters tab' })
      );
      expect(spies.onOpenChapter).toHaveBeenCalledWith('n-ch');
    });

    it('says a chapter has nobody yet, and where to add them', () => {
      const chapterCard = node('n-empty', 'Quiet', 'chapter');

      openDrawer({
        nodes: [chapterCard],
        selectedNode: chapterCard,
        selectedNodeId: chapterCard.id,
        nodeLabelDraft: 'Quiet',
      });

      expect(screen.getByText('nobody yet')).toBeInTheDocument();
      expect(
        screen.getByText(/Give the chapter a point of view/)
      ).toBeInTheDocument();
    });

    it('offers a rename only for the card the offer names', () => {
      openDrawer({
        renameOffer: { nodeId: card.id, from: 'Mira', to: 'Mira Vance' },
      });

      expect(screen.getByText(/was named after Mira/)).toBeInTheDocument();
      expect(screen.getByText(/Rename it to “Mira Vance”?/)).toBeInTheDocument();
    });

    it('keeps the offer away from a card it does not name', () => {
      openDrawer({
        renameOffer: { nodeId: 'n-elsewhere', from: 'Rook', to: 'Rook Vance' },
      });

      expect(screen.queryByText(/was named after/)).not.toBeInTheDocument();
    });

    it('applies the rename it offered, or leaves the label alone', async () => {
      const user = userEvent.setup();
      const spies = openDrawer({
        renameOffer: { nodeId: card.id, from: 'Mira', to: 'Mira Vance' },
      });

      await user.click(screen.getByRole('button', { name: 'Rename' }));
      expect(spies.applyRenameOffer).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('button', { name: 'Keep label' }));
      expect(spies.setRenameOffer).toHaveBeenCalledWith(null);
    });

    it('tells the app when the drawer is closed, from the key or the button', async () => {
      const user = userEvent.setup();
      const spies = openDrawer();

      await user.click(screen.getByRole('button', { name: 'Close inspector' }));
      expect(spies.closeNodeInspector).toHaveBeenCalledTimes(1);

      await user.type(
        screen.getByRole('button', { name: 'Close inspector' }),
        '{Escape}'
      );
      expect(spies.closeNodeInspector).toHaveBeenCalledTimes(2);
    });
  });

  describe('the linked cast member\u2019s numbers', () => {
    const card = node('n-1', 'Mira', 'character', { characterId: mira.id });
    const strength = stat('st-1', 'STR', 12);

    function openNumbers(overrides: Partial<GraphTabProps> = {}, start: Start = {}) {
      return open(
        {
          nodes: [card],
          selectedNode: card,
          selectedNodeId: card.id,
          inspectorCharacter: mira,
          inspectorStats: [strength],
          inspectorAttributes: [attribute('at-1', 'Class', 'Rogue')],
          ...overrides,
        },
        start,
      );
    }

    it('reads a stat through the drawer and hands the edit back', async () => {
      const user = userEvent.setup();
      const spies = openNumbers();

      expect(screen.getByText('Class')).toBeInTheDocument();
      await user.click(screen.getByTitle('Change this stat'));

      expect(spies.startInspectorStat).toHaveBeenCalledWith(strength);
    });

    it('opens the value it was told to edit, and saves or drops it', async () => {
      const user = userEvent.setup();
      const spies = openNumbers({}, { inspectorStatId: strength.id, inspectorStatValue: '12' });

      const field = screen.getByLabelText('STR value');
      expect(field).toHaveValue(12);

      await user.type(field, '9');
      // The drawer's own Save sits above this row, so the row is addressed by
      // the title naming the value it writes.
      await user.click(screen.getByTitle('Save this new STR value'));
      expect(spies.saveInspectorStat).toHaveBeenCalledWith(strength);

      await user.click(screen.getByTitle('Leave the value as it was'));
      expect(screen.queryByLabelText('STR value')).not.toBeInTheDocument();
    });

    it('edits an attribute as free text, because a class is not a number', async () => {
      const user = userEvent.setup();
      const spies = openNumbers({}, { inspectorAttrId: 'at-1', inspectorAttrValue: 'Rogue' });

      const field = screen.getByLabelText('Class value');
      expect(field).toHaveValue('Rogue');

      await user.clear(field);
      await user.type(field, 'Ranger');
      await user.click(screen.getByTitle('Save this new Class value'));

      expect(spies.saveInspectorAttribute).toHaveBeenCalledWith(
        expect.objectContaining({ attr_name: 'Class' })
      );
    });

    it('says so when the cast member has nothing recorded yet', () => {
      openNumbers({ inspectorStats: [], inspectorAttributes: [] });

      expect(
        screen.getByText('This cast member has no stats or attributes yet.')
      ).toBeInTheDocument();
    });

    it('explains a link to a cast member who is in the trash', () => {
      openNumbers({ inspectorCharacter: null });

      expect(
        screen.getByText(/not in this story's live cast/)
      ).toBeInTheDocument();
    });

    it('keeps the numbers away from a card with no cast member behind it', () => {
      open({
        nodes: [node('n-9', 'Vault', 'location')],
        selectedNode: node('n-9', 'Vault', 'location'),
        selectedNodeId: 'n-9',
        inspectorCharacter: mira,
        inspectorStats: [strength],
      });

      expect(screen.queryByLabelText('Cast numbers')).not.toBeInTheDocument();
    });

    it('shows what the last stat write said', () => {
      openNumbers({ inspectorError: 'STR must be a number' });

      expect(screen.getByText('STR must be a number')).toBeInTheDocument();
    });
  });

  it('hands the board every handler the app gave it', () => {
    const spies = open({ nodes: [node('n-1', 'Mira', 'character')] });

    const wired = boardProps.current as Record<string, unknown>;

    // The board's own events are the app's handlers: the tab only draws it.
    expect(wired.onConnect).toBe(spies.onConnect);
    expect(wired.onNodeClick).toBe(spies.selectNode);
    expect(wired.onEdgeClick).toBe(spies.selectEdge);
    expect(wired.onNodesDelete).toBe(spies.removeNodes);
    expect(wired.onEdgesDelete).toBe(spies.removeEdges);
    expect(wired.onNodeDragStop).toBe(spies.onNodeDragStop);

    const select = screen.getByTitle('The kind of node the Add button creates');
    const addable = within(select)
      .getAllByRole('option')
      .map(option => (option as HTMLOptionElement).value);

    // Every kind can be made here, a skill included: a skill card placed from the
    // toolbar is the definition, and its drawer is where holders are added.
    expect(addable).toContain('skill');
    expect(addable).toContain('chapter');
    expect(addable.length).toBeGreaterThan(10);
  });

  it('draws the search palette over the board', () => {
    open();

    expect(screen.getByTestId('search-palette')).toBeInTheDocument();
  });
});
