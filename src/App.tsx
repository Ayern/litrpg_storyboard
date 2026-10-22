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
import type { Node } from 'reactflow';
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
  const [currentUser, setCurrentUser] = useState<string>('You');
  
  const [nodes, setNodes, onNodesChange] = useNodesState<NodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<EdgeData>([]);
  
  const [selectedTab, setSelectedTab] = useState<'graph' | 'characters' | 'audit'>('graph');
  
  const [newStoryTitle, setNewStoryTitle] = useState('');
  const [newNodeLabel, setNewNodeLabel] = useState('');
  const [newNodeType, setNewNodeType] = useState<NodeType>('idea');

  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

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

  const createNewStory = async () => {
    if (!newStoryTitle.trim()) return;
    
    try {
      const story: Story = await invoke('create_new_story', {
        title: newStoryTitle.trim(),
        description: null,
        user: currentUser,
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
        createdBy: currentUser,
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
          createdBy: currentUser,
        });

        const newEdge: any = {
          id: newDbEdge.id,
          source: params.source,
          target: params.target,
          label: '',
          data: {
            createdBy: currentUser,
          },
        };

        setEdges(eds => addEdge(newEdge, eds));
      } catch (e) {
        console.error('Failed to create edge:', e);
      }
    },
    [currentStory, currentUser, setEdges]
  );

  const onNodeDragStop = useCallback(
    async (_event: any, node: Node<NodeData>) => {
      if (!currentStory) return;

      try {
        await invoke('update_graph_node_position', {
          id: node.id,
          posX: node.position.x,
          posY: node.position.y,
          user: currentUser,
        });
      } catch (e) {
        console.error('Failed to persist node position:', e);
      }
    },
    [currentStory, currentUser]
  );

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
          {stories.map(story => (
            <div
              key={story.id}
              className={`story-item ${currentStory?.id === story.id ? 'active' : ''}`}
              onClick={() => loadStory(story)}
            >
              {story.title}
            </div>
          ))}
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