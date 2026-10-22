import React, { useState, useEffect, useCallback } from 'react';
import ReactFlow, {
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Connection,
  addEdge,
  Panel,
} from 'reactflow';
import type { Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';
import { invoke } from '@tauri-apps/api/core';

interface Story {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

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
}

// Simple type aliases for our custom node/edge data
type NodeData = { label: string; nodeType: string; content?: string; createdBy: string };
type EdgeData = { relationType?: string; createdBy: string };

// We'll use ReactFlow's internal types but cast our data
const nodeTypes = ['chapter', 'idea', 'character', 'location', 'event', 'plot', 'misc'] as const;
type NodeType = typeof nodeTypes[number];

const USER_KEY = 'litrpg.currentUser';

const entityLabels: Record<string, string> = {
  story: 'Story',
  character: 'Character',
  character_stat: 'Character stat',
  node: 'Graph node',
  edge: 'Graph connection',
};

function entityLabel(entry: AuditEntry): string {
  const base = entityLabels[entry.entity_type] ?? entry.entity_type;
  return entry.field_changed ? `${base} (${entry.field_changed})` : base;
}

function formatWhen(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

function AuditChange({ entry }: { entry: AuditEntry }) {
  if (entry.action === 'update') {
    return (
      <div className="audit-change">
        <span className="audit-old">{entry.old_value ?? 'nothing'}</span>
        <span className="audit-arrow">→</span>
        <span className="audit-new">{entry.new_value ?? 'nothing'}</span>
      </div>
    );
  }

  if (!entry.new_value) return null;

  return (
    <div className="audit-change">
      <span className="audit-new">{entry.new_value}</span>
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
  
  const [selectedTab, setSelectedTab] = useState<'graph' | 'characters' | 'audit'>('graph');
  
  const [newStoryTitle, setNewStoryTitle] = useState('');
  const [newNodeLabel, setNewNodeLabel] = useState('');
  const [newNodeType, setNewNodeType] = useState<NodeType>('idea');

  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const [renamingStoryId, setRenamingStoryId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteStoryId, setConfirmDeleteStoryId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
        },
      }));

      const flowEdges: any[] = dbEdges.map((e: any) => ({
        id: e.id,
        source: e.source_id,
        target: e.target_id,
        label: e.label || e.relation_type || '',
        data: {
          relationType: e.relation_type,
          createdBy: e.created_by,
        },
      }));

      setNodes(flowNodes);
      setEdges(flowEdges);
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

  // History is fetched whenever the tab is opened or the story changes, so
  // returning to the tab always reflects the latest changes.
  useEffect(() => {
    if (selectedTab !== 'audit' || !currentStory) return;

    let cancelled = false;

    const loadAudit = async () => {
      setAuditLoading(true);
      setAuditError(null);

      try {
        const entries: AuditEntry[] = await invoke('get_audit_history', {
          storyId: currentStory.id,
          entityType: null,
          entityId: null,
          limit: 200,
        });
        if (!cancelled) setAuditEntries(entries);
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
  }, [selectedTab, currentStory]);

  // Remember who is using the app: an audit trail that resets everyone to
  // "You" after a restart is not attribution.
  useEffect(() => {
    try {
      localStorage.setItem(USER_KEY, currentUser);
    } catch (e) {
      console.warn('Could not persist the current user name:', e);
    }
  }, [currentUser]);

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
      // Don't load graph yet - new story has no nodes/edges
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
        },
      };

      setNodes(nds => [...nds, flowNode]);
      setNewNodeLabel('');
    } catch (e) {
      console.error('Failed to create node:', e);
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

  const handleNodesChange = useCallback(
    (changes: any[]) => {
      onNodesChange(changes);
    },
    [onNodesChange]
  );

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
          </div>
          {currentStory && <span className="current-story">{currentStory.title}</span>}
        </div>

        {actionError && (
          <div className="error-strip">
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)}>Dismiss</button>
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
                <div style={{ width: '100%', height: 'calc(100% - 40px)' }}>
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onNodeDragStop={onNodeDragStop}
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
                  </ReactFlow>
                </div>
              </>
            )}
          </div>
        )}

        {selectedTab === 'characters' && (
          <div className="tab-content">
            {currentStory ? (
              <div>Character management coming in next iteration</div>
            ) : (
              <div className="empty-state">Load a story to manage characters</div>
            )}
          </div>
        )}

        {selectedTab === 'audit' && (
          <div className="tab-content">
            {!currentStory ? (
              <div className="empty-state">Load a story to see history</div>
            ) : auditError ? (
              <div className="audit-error">
                Could not load history for this story: {auditError}
              </div>
            ) : auditLoading ? (
              <div className="empty">Loading history…</div>
            ) : auditEntries.length === 0 ? (
              <div className="empty">
                No changes recorded yet. Edits to this story will show up here,
                newest first.
              </div>
            ) : (
              <ol className="audit-list">
                {auditEntries.map(entry => (
                  <li key={entry.id} className="audit-entry">
                    <div className="audit-row">
                      <span className={`audit-badge ${entry.action}`}>{entry.action}</span>
                      <span className="audit-entity">{entityLabel(entry)}</span>
                      <span className="audit-when">
                        {entry.changed_by} · {formatWhen(entry.changed_at)}
                      </span>
                    </div>
                    <AuditChange entry={entry} />
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;