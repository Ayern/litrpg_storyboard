import React from 'react';
import ReactFlow, { Background, Controls, Panel } from 'reactflow';
import type {
  Connection,
  Edge,
  EdgeMouseHandler,
  Node,
  NodeDragHandler,
  NodeMouseHandler,
  OnConnectEnd,
  OnConnectStart,
  OnEdgesChange,
} from 'reactflow';
import { HelpTip } from '../../components/HelpTip';
import type { CharacterAttribute } from '../characters/types';
import { everyLayerShown, GRAPH_LAYERS } from './layers';
import type { GraphLayer, GraphLayers } from './layers';
import type { Character, CharacterSkill, CharacterStat } from '../shared/types';
import type { Story } from '../stories/types';
import { flowNodeTypes } from './GraphNode';
import { CardSections } from './CardSections';
import { CopySystemBoxButton, SystemBoxFace } from './SystemBox';
import { SystemMessageForm } from './SystemMessageForm';
import { serializeSystemMessage, systemMessageOf } from './systemMessage';
import { chapterBesideCard } from './systemEvents';
import type { SystemEventChoice } from './systemEvents';
import {
  CARD_DRAG_TYPE,
  CAST_DRAG_TYPE,
  canvasCreateNodeTypes,
  cardOnlyNote,
  edgeRelationTypes,
  isCanvasCreateKind,
  nodeTypes,
  QUEST_DRAG_TYPE,
} from './types';
import type { EdgeData, NodeData, NodeType, UnplacedQuest } from './types';

// The Graph tab: the Add form, Undo and Redo, the cast rail, the board itself,
// the connection editor that hangs over it and the inspector drawer beside it.
// Every draft still lives in the app, because the board, the sheet and the
// audit history all write to the same rows: the tab renders what the app holds
// and hands keystrokes back through the handlers it is given. The one thing the
// tab reads for itself is which holders a skill card already has, since that is
// only ever shown here.

export interface GraphTabProps {
  story: Story | null;
  renderSearchPalette: (placement: 'overlay') => React.ReactNode;
  openSearch: () => void;
  shortcutKeys: { undo: string; redo: string; search: string };

  // The Add form behind the toolbar.
  newNodeType: NodeType;
  setNewNodeType: React.Dispatch<React.SetStateAction<NodeType>>;
  newNodeLabel: string;
  setNewNodeLabel: React.Dispatch<React.SetStateAction<string>>;
  openCanvasCreate: () => void;

  // History, and the buttons that walk it.
  undoLast: () => void | Promise<void>;
  redoLast: () => void | Promise<void>;
  historyDepth: { undo: number; redo: number };

  // The board and the notes toggle.
  showChapterNotes: boolean;
  setShowChapterNotes: React.Dispatch<React.SetStateAction<boolean>>;
  // Which kinds of card the board draws. A story opens on the chapter spine, so
  // a first look is the reading order rather than everything at once.
  graphLayers: GraphLayers;
  toggleGraphLayer: (layer: GraphLayer) => void;
  showAllGraphLayers: () => void;
  showChapterSpine: () => void;
  nodes: Node<NodeData>[];
  canvasNodes: Node<NodeData>[];
  edges: Edge<EdgeData>[];
  flowRef: React.RefObject<any>;
  pendingPanRef: React.RefObject<{ x: number; y: number } | null>;
  panCanvas: (x: number, y: number) => void;
  handleNodesChange: (changes: any[]) => void;
  onEdgesChange: OnEdgesChange;
  onConnect: (params: Connection) => void;
  onConnectStart: OnConnectStart;
  onConnectEnd: OnConnectEnd;
  onNodeDragStart: NodeDragHandler;
  onNodeDragStop: NodeDragHandler;
  selectNode: NodeMouseHandler;
  selectEdge: EdgeMouseHandler;
  removeNodes: (deleted: Node<NodeData>[]) => void;
  removeEdges: (deleted: Edge<EdgeData>[]) => void;

  // The cast rail.
  characters: Character[];
  castStats: Record<string, CharacterStat[]>;
  draggingCastId: string | null;
  setDraggingCastId: React.Dispatch<React.SetStateAction<string | null>>;
  setDropTargetNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  nodeUnderPointer: (event: React.DragEvent<HTMLDivElement>) => string | null;
  dropCastMember: (event: React.DragEvent<HTMLDivElement>) => void;
  // A card dragged out of a section is copied where it lands: a second card of
  // that name, with its layer switched back on.
  copyCardFromRail: (id: string, position: { x: number; y: number }) => void;
  // Writes the card an unplaced quest has been waiting for and links the two, as
  // one step the undo history holds together.
  placeQuestFromRail: (questId: string, position: { x: number; y: number }) => void;
  // Quest records the board has no card for, listed in the rail marked as such.
  unplacedQuests: UnplacedQuest[];

  // The connection editor.
  selectedEdgeId: string | null;
  // Closes the connection editor. Nothing here opens one: picking a line is the
  // board's own event, and picking a card opens its drawer instead.
  closeEdge: () => void;
  selectedEdge: Edge<EdgeData> | null;
  edgeLabelDraft: string;
  setEdgeLabelDraft: React.Dispatch<React.SetStateAction<string>>;
  edgeRelationDraft: string;
  setEdgeRelationDraft: React.Dispatch<React.SetStateAction<string>>;
  saveEdge: () => void;
  edgeEditError: string | null;

  // The node drawer.
  selectedNode: Node<NodeData> | null;
  selectedNodeId: string | null;
  nodeIsDirty: boolean;
  closeNodeInspector: () => void;
  nodeLabelDraft: string;
  setNodeLabelDraft: React.Dispatch<React.SetStateAction<string>>;
  nodeContentDraft: string;
  setNodeContentDraft: React.Dispatch<React.SetStateAction<string>>;
  rememberNodeDraft: (id: string, draft: { label: string; content: string }) => void;
  renameOffer: { nodeId: string; from: string; to: string } | null;
  setRenameOffer: React.Dispatch<
    React.SetStateAction<{ nodeId: string; from: string; to: string } | null>
  >;
  applyRenameOffer: () => void;
  nodeEditError: string | null;
  saveNode: (closeAfter?: boolean) => void;
  closePrompt: boolean;
  setClosePrompt: React.Dispatch<React.SetStateAction<boolean>>;
  discardNodeDraft: () => void;
  changeNodeCharacter: (characterId: string) => void;
  // A card is a shortcut to what it stands for as well as a place to edit it.
  onOpenSheet: (characterId: string) => void;
  onOpenChapter: (chapterId: string) => void;
  // The scenes' own records, already shaped as System boxes, so a level-up the
  // chapter logged can be written out on the card without retyping it.
  systemEventChoices: SystemEventChoice[];

  // The skill card's holders.
  skills: CharacterSkill[];
  skillHolderCharacterId: string;
  setSkillHolderCharacterId: React.Dispatch<React.SetStateAction<string>>;
  skillHolderRank: string;
  setSkillHolderRank: React.Dispatch<React.SetStateAction<string>>;
  skillHolderChapterId: string;
  setSkillHolderChapterId: React.Dispatch<React.SetStateAction<string>>;
  skillHolderError: string | null;
  setSkillHolderError: React.Dispatch<React.SetStateAction<string | null>>;
  savingSkillHolder: boolean;
  chapterChoices: Node<NodeData>[];
  addSkillHolder: () => void;

  // The linked cast member's numbers.
  inspectorCharacter: Character | null;
  inspectorStats: CharacterStat[];
  inspectorAttributes: CharacterAttribute[];
  inspectorError: string | null;
  inspectorStatId: string | null;
  setInspectorStatId: React.Dispatch<React.SetStateAction<string | null>>;
  inspectorStatValue: string;
  setInspectorStatValue: React.Dispatch<React.SetStateAction<string>>;
  startInspectorStat: (stat: CharacterStat) => void;
  saveInspectorStat: (stat: CharacterStat) => void;
  inspectorAttrId: string | null;
  setInspectorAttrId: React.Dispatch<React.SetStateAction<string | null>>;
  inspectorAttrValue: string;
  setInspectorAttrValue: React.Dispatch<React.SetStateAction<string>>;
  startInspectorAttribute: (attribute: CharacterAttribute) => void;
  saveInspectorAttribute: (attribute: CharacterAttribute) => void;
}

export function GraphTab({
  story,
  renderSearchPalette,
  openSearch,
  shortcutKeys,
  newNodeType,
  setNewNodeType,
  newNodeLabel,
  setNewNodeLabel,
  openCanvasCreate,
  undoLast,
  redoLast,
  historyDepth,
  showChapterNotes,
  setShowChapterNotes,
  graphLayers,
  toggleGraphLayer,
  showAllGraphLayers,
  showChapterSpine,
  nodes,
  canvasNodes,
  edges,
  flowRef,
  pendingPanRef,
  panCanvas,
  handleNodesChange,
  onEdgesChange,
  onConnect,
  onConnectStart,
  onConnectEnd,
  onNodeDragStart,
  onNodeDragStop,
  selectNode,
  selectEdge,
  removeNodes,
  removeEdges,
  characters,
  castStats,
  draggingCastId,
  setDraggingCastId,
  setDropTargetNodeId,
  nodeUnderPointer,
  dropCastMember,
  copyCardFromRail,
  placeQuestFromRail,
  unplacedQuests,
  selectedEdgeId,
  closeEdge,
  selectedEdge,
  edgeLabelDraft,
  setEdgeLabelDraft,
  edgeRelationDraft,
  setEdgeRelationDraft,
  saveEdge,
  edgeEditError,
  selectedNode,
  selectedNodeId,
  nodeIsDirty,
  closeNodeInspector,
  nodeLabelDraft,
  setNodeLabelDraft,
  nodeContentDraft,
  setNodeContentDraft,
  rememberNodeDraft,
  renameOffer,
  setRenameOffer,
  applyRenameOffer,
  nodeEditError,
  saveNode,
  closePrompt,
  setClosePrompt,
  discardNodeDraft,
  changeNodeCharacter,
  onOpenSheet,
  onOpenChapter,
  systemEventChoices,
  skills,
  skillHolderCharacterId,
  setSkillHolderCharacterId,
  skillHolderRank,
  setSkillHolderRank,
  skillHolderChapterId,
  setSkillHolderChapterId,
  skillHolderError,
  setSkillHolderError,
  savingSkillHolder,
  chapterChoices,
  addSkillHolder,
  inspectorCharacter,
  inspectorStats,
  inspectorAttributes,
  inspectorError,
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
}: GraphTabProps) {
  const skillCardNode =
    selectedNode?.data.nodeType === 'skill' ? selectedNode : null;

  // A chapter names its people through its point of view and its cast rows, so
  // it has no linked cast member of its own to edit here. What the drawer shows
  // is the roster the card draws, and clicking a name opens that sheet.
  const chapterIsSelected = selectedNode?.data.nodeType === 'chapter';
  const linkedCharacterId = chapterIsSelected
    ? null
    : selectedNode?.data.characterId ?? null;
  const chapterRoster = chapterIsSelected
    ? selectedNode?.data.chapterCast ?? []
    : [];
  const linkedCharacterName =
    characters.find(character => character.id === linkedCharacterId)?.name ??
    selectedNode?.data.characterName ??
    'this character';

  // The holders already attached to the selected card, and the cast members who
  // could still learn it. A person is only offered once: the database also
  // refuses a second skill with the same name, but not showing the option is
  // clearer than an error after the click.
  const skillCardHolders = skillCardNode
    ? skills
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

  // The system card's message as the drawer is holding it, so the fields, the
  // preview and the copy all follow the typing rather than the last saved row.
  // The form writes the card's notes, which is where the message lives, so one
  // Save carries the whole edit and one Undo takes it back.
  const systemMessageDraft = systemMessageOf(nodeLabelDraft, nodeContentDraft);

  // The scene a System box is written for: the chapter it is connected to, or
  // else the chapter card it sits nearest. Two chapters can sit a finger apart on
  // a board, so the picker asks this one chapter instead of offering the whole
  // story's events and leaving the author to work out which is which.
  const systemEventScope = React.useMemo(
    () =>
      selectedNode?.data.nodeType === 'system'
        ? chapterBesideCard({ nodeId: selectedNode.id, nodes, edges })
        : null,
    [selectedNode, nodes, edges]
  );

  // A narrow picker is a good default and a bad cage, so the note under it can
  // open the whole story's events without moving the card. The press belongs to
  // the drawer rather than the form, which holds no state of its own, and a
  // different card starts narrow again.
  const [showEveryChapter, setShowEveryChapter] = React.useState(false);

  React.useEffect(() => {
    setShowEveryChapter(false);
  }, [selectedNodeId]);

  // A chapter with nothing logged yet would leave an empty picker, so the whole
  // story is offered then, and the note under it says why.
  const systemEventListing = React.useMemo(() => {
    if (!systemEventScope) return { choices: systemEventChoices, scope: null };

    const inChapter = systemEventChoices.filter(
      choice => choice.chapterId === systemEventScope.chapterId
    );

    const scope = (showingAll: boolean) => ({
      ...systemEventScope,
      fellBack: false,
      showingAll,
      onToggleAll: setShowEveryChapter,
    });

    if (inChapter.length === 0) {
      return {
        choices: systemEventChoices,
        scope: { ...systemEventScope, fellBack: true, showingAll: false, onToggleAll: setShowEveryChapter },
      };
    }

    return showEveryChapter
      ? { choices: systemEventChoices, scope: scope(true) }
      : { choices: inChapter, scope: scope(false) };
  }, [systemEventChoices, systemEventScope, showEveryChapter]);

  const writeNodeContent = (content: string) => {
    setNodeContentDraft(content);
    if (selectedNodeId) {
      rememberNodeDraft(selectedNodeId, { label: nodeLabelDraft, content });
    }
  };

  const skillHolderCandidates = skillCardNode
    ? characters.filter(
        character =>
          !skillCardHolders.some(holder => holder.skill.character_id === character.id)
      )
    : [];

  // Where a drop lands, asked for in the board's own coordinates: a card placed
  // under the pointer stays under the pointer at whatever zoom and pan the board
  // is at.
  const boardPoint = (event: React.DragEvent<HTMLDivElement>) => {
    const instance = flowRef.current;

    return instance?.screenToFlowPosition
      ? instance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      : instance?.project?.({
          x: event.clientX - event.currentTarget.getBoundingClientRect().left,
          y: event.clientY - event.currentTarget.getBoundingClientRect().top,
        });
  };

  // A card out of a section lands where the pointer is, and it lands as a new
  // card rather than as the one that was dragged: the list names the skill, the
  // place or the trinket, and each card is one use of it.
  const dropCardOnBoard = (event: React.DragEvent<HTMLDivElement>) => {
    const id = event.dataTransfer.getData(CARD_DRAG_TYPE);

    if (!id) return;

    event.preventDefault();

    const point = boardPoint(event);

    if (point) copyCardFromRail(id, point);
  };

  // A quest with no card carries its ledger row instead of a card id, because
  // there is no card to copy yet. The drop writes one and links the two.
  const dropUnplacedQuest = (event: React.DragEvent<HTMLDivElement>) => {
    const questId = event.dataTransfer.getData(QUEST_DRAG_TYPE);

    if (!questId) return;

    event.preventDefault();

    const point = boardPoint(event);

    if (point) placeQuestFromRail(questId, point);
  };

  return (
    <div className="graph-container">
      {!story ? (
        <div className="empty-state">Select or create a story</div>
      ) : (
        <>
          <div className="graph-toolbar">
            <select
              title="The kind of node the Add button creates"
              value={newNodeType}
              onChange={(e) => setNewNodeType(e.target.value as NodeType)}
            >
              {canvasCreateNodeTypes.map(t => (
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
              onClick={openSearch}
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
            <span className="graph-layers" role="group" aria-label="Layers">
              <span className="graph-layers-label">Layers</span>
              {GRAPH_LAYERS.map(option => {
                const drawn = graphLayers[option.key];

                return (
                  <button
                    key={option.key}
                    className={`layer-toggle${drawn ? ' active' : ''}`}
                    aria-pressed={drawn}
                    title={`${option.hint}. ${drawn ? 'Click to hide' : 'Click to show'} them.`}
                    onClick={() => toggleGraphLayer(option.key)}
                  >
                    {option.label}
                  </button>
                );
              })}
              <button
                className="layer-preset"
                title={
                  everyLayerShown(graphLayers)
                    ? 'Every layer is already on'
                    : 'Draw every card on the board, the whole web at once'
                }
                onClick={showAllGraphLayers}
                disabled={everyLayerShown(graphLayers)}
              >
                Show all
              </button>
              <button
                className="layer-preset"
                title="Draw the chapters again and hide everything else"
                onClick={showChapterSpine}
              >
                Chapters only
              </button>
            </span>
            <span className="hint">Drag a dot to connect cards</span>
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
            <CardSections
              characters={characters}
              castStats={castStats}
              nodes={nodes}
              unplacedQuests={unplacedQuests}
              draggingCastId={draggingCastId}
              setDraggingCastId={setDraggingCastId}
              setDropTargetNodeId={setDropTargetNodeId}
              onOpenCard={id => {
                const card = nodes.find(node => node.id === id);

                if (card) selectNode({} as React.MouseEvent, card);
              }}
            />
            <div
              className={`graph-canvas${draggingCastId ? ' drop-ready' : ''}`}
              onDragOver={event => {
                // The payload type says what is in the air even if the state
                // update from the drag has not landed yet.
                const carryingCard = event.dataTransfer.types.includes(CARD_DRAG_TYPE);
                const carryingQuest = event.dataTransfer.types.includes(QUEST_DRAG_TYPE);

                if (
                  !carryingCard &&
                  !carryingQuest &&
                  !draggingCastId &&
                  !event.dataTransfer.types.includes(CAST_DRAG_TYPE)
                ) {
                  return;
                }

                event.preventDefault();
                // A card taken out of a list is copied, so the drop effect has to
                // agree with the drag's `effectAllowed` of `copy`: a drag that
                // offers a copy and a board that asks for a move is a drop the
                // browser refuses, with the pointer saying so.
                event.dataTransfer.dropEffect = 'copy';

                // A card being placed is going to a point, not onto another
                // card, so nothing is outlined under the pointer for it.
                if (carryingCard || carryingQuest) return;
  
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
              onDrop={event => {
                if (event.dataTransfer.types.includes(QUEST_DRAG_TYPE)) {
                  dropUnplacedQuest(event);
                  return;
                }

                if (event.dataTransfer.types.includes(CARD_DRAG_TYPE)) {
                  dropCardOnBoard(event);
                  return;
                }

                dropCastMember(event);
              }}
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
              minZoom={0.25}
              fitView
            >
              <Controls />
              <Background />
              {/* The key sits in the corner the cards leave alone, and never takes
                  a click: it is a legend, not a control, and the writer clicking
                  the card underneath it means the card. */}
              <Panel position="bottom-right" className="node-legend-panel">
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
                        if (e.key === 'Escape') closeEdge();
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
                        if (e.key === 'Escape') closeEdge();
                      }}
                    />
                    <datalist id="edge-relation-types">
                      {edgeRelationTypes.map(type => (
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
                        onClick={() => closeEdge()}
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
  
                {/* A card nothing else stores says so, so an author never has to
                    wonder whether half of it is written somewhere else. */}
                {cardOnlyNote(selectedNode.data.nodeType) && (
                  <p className="node-drawer-record">
                    {cardOnlyNote(selectedNode.data.nodeType)}
                  </p>
                )}

                {/* A system card is copied out of this app and into a web
                    editor, so the box is shown here in the shape it will be
                    pasted, built from the two fields above. */}
                {selectedNode.data.nodeType === 'system' && (
                  <section className="node-drawer-system" aria-label="System box">
                    <div className="node-drawer-section">
                      System message
                      <span className="node-drawer-note">
                        the Label above is the header
                      </span>
                    </div>
                    <SystemMessageForm
                      message={systemMessageDraft}
                      eventChoices={systemEventListing.choices}
                      eventScope={systemEventListing.scope}
                      onChange={next =>
                        writeNodeContent(serializeSystemMessage(next))
                      }
                    />
                    <SystemBoxFace message={systemMessageDraft} />
                    <div className="system-box-actions">
                      <CopySystemBoxButton message={systemMessageDraft} />
                      <CopySystemBoxButton message={systemMessageDraft} format="html" />
                    </div>
                  </section>
                )}

                {/* A faction is stored as its card alone, so the drawer names the
                    quests that lean on it and opens each where it is edited: the
                    other half of the link the ledger draws to this card. */}
                {selectedNode.data.nodeType === 'faction' && (
                  <section
                    className="node-drawer-faction"
                    aria-label="Quests naming this faction"
                  >
                    <div className="node-drawer-section">
                      Issued from this faction
                      <span className="node-drawer-note">
                        {(selectedNode.data.factionQuests ?? []).length === 0
                          ? 'no quests yet'
                          : `${(selectedNode.data.factionQuests ?? []).length} quest${
                              (selectedNode.data.factionQuests ?? []).length === 1
                                ? ''
                                : 's'
                            }`}
                      </span>
                    </div>
                    {(selectedNode.data.factionQuests ?? []).length > 0 && (
                      <ul className="node-drawer-holder-list">
                        {(selectedNode.data.factionQuests ?? []).map(quest => (
                          <li className="node-drawer-holder" key={quest.id}>
                            <button
                              type="button"
                              className="node-drawer-holder-name"
                              title={`Open “${quest.title}” in the quest ledger`}
                              onClick={() => selectedNode.data.onOpenQuest?.(quest.id)}
                            >
                              {quest.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                  </section>
                )}

                {/* The other half of what the card holds: who stands where in
                    the faction, with each name opening that sheet. */}
                {selectedNode.data.nodeType === 'faction' && (
                  <section
                    className="node-drawer-faction"
                    aria-label="Standings held through this faction"
                  >
                    <div className="node-drawer-section">
                      Standings held through it
                      <span className="node-drawer-note">
                        {(selectedNode.data.factionStandings ?? []).length === 0
                          ? 'nobody yet'
                          : `${(selectedNode.data.factionStandings ?? []).length}`}
                      </span>
                    </div>
                    {(selectedNode.data.factionStandings ?? []).length > 0 && (
                      <ul className="node-drawer-holder-list">
                        {(selectedNode.data.factionStandings ?? []).map(standing => (
                          <li className="node-drawer-holder" key={standing.id}>
                            <button
                              type="button"
                              className="node-drawer-holder-name"
                              title={
                                standing.chapterLabel
                                  ? `Open ${standing.characterName}'s sheet — ${standing.standing} since ${standing.chapterLabel}`
                                  : `Open ${standing.characterName}'s sheet`
                              }
                              onClick={() =>
                                selectedNode.data.onOpenStandingSheet?.(
                                  standing.characterId
                                )
                              }
                            >
                              {standing.characterName}
                            </button>
                            <span className="node-drawer-holder-rank">
                              {standing.standing}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}

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
  
                {/* A system card's notes are the message its fields write, so the
                    drawer does not offer a second, plainer box over them. */}
                {selectedNode.data.nodeType !== 'system' && (
                  <>
                    <label className="node-drawer-label" htmlFor="inspector-notes">
                      Notes
                    </label>
                    <textarea
                      id="inspector-notes"
                      className="node-editor-content"
                      placeholder="Notes for this node (optional)"
                      value={nodeContentDraft}
                      onChange={e => writeNodeContent(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Escape') closeNodeInspector();
                      }}
                    />
                  </>
                )}
  
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
  
                {chapterIsSelected ? (
                  <section
                    className="node-drawer-chapter"
                    aria-label="Chapter roster"
                  >
                    <div className="node-drawer-section">
                      In this chapter
                      <span className="node-drawer-note">
                        {chapterRoster.length === 0
                          ? 'nobody yet'
                          : `${chapterRoster.length} in the scene`}
                      </span>
                    </div>

                    {chapterRoster.length === 0 ? (
                      <p className="node-drawer-hint">
                        Nobody is in this scene yet. Give the chapter a point of
                        view, or tick who is present, on the Chapters tab.
                      </p>
                    ) : (
                      <ul className="node-drawer-holder-list">
                        {chapterRoster.map(member => (
                          <li className="node-drawer-holder" key={member.characterId}>
                            <button
                              type="button"
                              className="node-drawer-holder-name"
                              title={`Open ${member.name}'s sheet as of this chapter`}
                              onClick={() =>
                                selectedNode.data.onOpenChapterCast?.(
                                  member.characterId
                                )
                              }
                            >
                              {member.name}
                            </button>
                            {member.level !== null && (
                              <span className="node-drawer-holder-rank">
                                Lv {member.level}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    <p className="node-drawer-hint">
                      The roster comes from the chapter's point of view and the
                      people ticked under “Present in this chapter”; dropping a
                      cast member on this card adds them to it.
                    </p>

                    <button
                      type="button"
                      className="node-drawer-add-holder"
                      title="Open this chapter on the Chapters tab, where its point of view and cast are edited"
                      onClick={() => onOpenChapter(selectedNode.id)}
                    >
                      Edit on the Chapters tab
                    </button>
                  </section>
                ) : (
                  <>
                    <label className="node-drawer-label" htmlFor="inspector-cast">
                      Cast member
                    </label>
                    <select
                      id="inspector-cast"
                      className="node-drawer-select"
                      title="Link this card to a cast member; saved as soon as you choose"
                      value={linkedCharacterId ?? ''}
                      onChange={e => changeNodeCharacter(e.target.value)}
                    >
                      <option value="">Not linked</option>
                      {characters.map(character => (
                        <option key={character.id} value={character.id}>
                          {character.name}
                        </option>
                      ))}
                      {linkedCharacterId &&
                        !characters.some(
                          character => character.id === linkedCharacterId
                        ) && (
                          <option value={linkedCharacterId}>
                            Linked cast member (not in the cast)
                          </option>
                        )}
                    </select>

                    {linkedCharacterId && (
                      <button
                        type="button"
                        className="node-drawer-add-holder"
                        title={`Open ${linkedCharacterName}'s sheet`}
                        onClick={() => onOpenSheet(linkedCharacterId)}
                      >
                        Open {linkedCharacterName}'s sheet
                      </button>
                    )}
                  </>
                )}
  
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
  
                {linkedCharacterId && (
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
  );
}
