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
import type { Character, CharacterSkill, CharacterStat } from '../shared/types';
import type { Story } from '../stories/types';
import { flowNodeTypes } from './GraphNode';
import {
  CAST_DRAG_TYPE,
  edgeRelationTypes,
  isCanvasCreateKind,
  NODE_STAT_BADGES,
  nodeTypes,
} from './types';
import type { EdgeData, NodeData, NodeType } from './types';

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

  const skillHolderCandidates = skillCardNode
    ? characters.filter(
        character =>
          !skillCardHolders.some(holder => holder.skill.character_id === character.id)
      )
    : [];

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
