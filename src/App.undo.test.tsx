import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock, flowMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  flowMock: { setCenter: vi.fn(), getZoom: vi.fn(() => 1) },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// A canvas with the gestures React Flow would perform, exposed as buttons so a
// test can drag a node, delete one, or draw a connection without geometry.
vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  const Canvas = (props: any) => {
    const {
      nodes = [],
      edges = [],
      nodeTypes = {},
      children,
      onInit,
      onNodeClick,
      onEdgeClick,
      onNodeDragStart,
      onNodeDragStop,
      onNodesDelete,
      onEdgesDelete,
      onConnect,
    } = props;

    const Card = nodeTypes.default;

    React.useEffect(() => {
      onInit?.(flowMock);
    }, [onInit]);

    return React.createElement(
      'div',
      { 'data-testid': 'canvas' },
      nodes.map((node: any) =>
        React.createElement(
          'div',
          { key: node.id, className: 'react-flow__node', 'data-id': node.id },
          Card
            ? React.createElement(Card, {
                id: node.id,
                data: node.data,
                isConnectable: true,
                selected: false,
                xPos: 0,
                yPos: 0,
                zIndex: 0,
                dragging: false,
              })
            : null,
          React.createElement(
            'button',
            { key: 'open', onClick: (event: unknown) => onNodeClick?.(event, node) },
            node.data.label
          ),
          React.createElement(
            'button',
            { key: 'start', onClick: () => onNodeDragStart?.({}, node) },
            `start ${node.id}`
          ),
          React.createElement(
            'button',
            {
              key: 'drop',
              onClick: () =>
                onNodeDragStop?.({}, { ...node, position: { x: 250, y: 160 } }),
            },
            `drop ${node.id}`
          )
        )
      ),
      edges.map((edge: any) =>
        React.createElement(
          'div',
          { key: edge.id },
          React.createElement(
            'button',
            { onClick: (event: unknown) => onEdgeClick?.(event, edge) },
            `edge ${edge.source} to ${edge.target}`
          ),
          React.createElement(
            'button',
            { onClick: () => onEdgesDelete?.([edge]) },
            `delete edge ${edge.id}`
          )
        )
      ),
      nodes.length > 0 &&
        React.createElement(
          'button',
          { onClick: () => onNodesDelete?.([nodes[0]]) },
          'delete first node'
        ),
      nodes.some((node: any) => node.data.nodeType === 'character') &&
        React.createElement(
          'button',
          {
            onClick: () =>
              onNodesDelete?.([
                nodes.find((node: any) => node.data.nodeType === 'character'),
              ]),
          },
          'delete the character node'
        ),
      React.createElement(
        'button',
        { onClick: () => onConnect?.({ source: 'n1', target: 'n3' }) },
        'connect two cards'
      ),
      children as React.ReactNode
    );
  };

  return {
    default: Canvas,
    Controls: () => null,
    Background: () => null,
    Panel: PassThrough,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    useNodesState: (initial: unknown[]) => {
      const [state, setState] = React.useState(initial);
      return [state, setState, () => {}];
    },
    useEdgesState: (initial: unknown[]) => {
      const [state, setState] = React.useState(initial);
      return [state, setState, () => {}];
    },
  };
});

const story = {
  id: 'story-1',
  title: 'Ledger',
  description: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

const otherStory = {
  id: 'story-2',
  title: 'Ashes',
  description: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

const cast = [
  {
    id: 'char-1',
    story_id: story.id,
    name: 'Rook',
    description: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
  {
    id: 'char-2',
    story_id: story.id,
    name: 'Wren',
    description: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
];

interface Row {
  id: string;
  story_id: string;
  node_type: string;
  label: string;
  content: string | null;
  pos_x: number;
  pos_y: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  character_id: string | null;
  deleted_at?: string | null;
}

function nodeRow(
  id: string,
  label: string,
  nodeType: string,
  characterId: string | null,
  x: number,
  y: number
): Row {
  return {
    id,
    story_id: story.id,
    node_type: nodeType,
    label,
    content: null,
    pos_x: x,
    pos_y: y,
    created_by: 'Ada',
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
    character_id: characterId,
  };
}

interface EdgeRow {
  id: string;
  story_id: string;
  source_id: string;
  target_id: string;
  label: string | null;
  relation_type: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

// The database the mocked commands read and write, so an undo is visible on the
// next load the way it would be in the real app.
let dbNodes: Row[] = [];
let dbEdges: EdgeRow[] = [];
let stories = [story];
// Set by a test that wants the next undo to be refused by the database.
let failNextNodeUpdate = false;

const live = <T extends { deleted_at?: string | null }>(rows: T[]) =>
  rows.filter(row => !row.deleted_at).map(({ deleted_at, ...row }) => row);

beforeEach(() => {
  stories = [story];
  failNextNodeUpdate = false;
  dbNodes = [
    nodeRow('n1', 'Opening', 'chapter', null, 0, 0),
    nodeRow('n2', 'Rook', 'character', 'char-1', 400, 300),
    // A chapter and an idea stay a plain connection; characters and chapters
    // now make domain records instead.
    nodeRow('n3', 'Hint', 'idea', null, 400, 600),
  ];
  dbEdges = [
    {
      id: 'e1',
      story_id: story.id,
      source_id: 'n1',
      target_id: 'n2',
      label: 'leads to',
      relation_type: 'leads_to',
      created_by: 'Ada',
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;
    const node = dbNodes.find(row => row.id === (args.id ?? args.nodeId));
    const edge = dbEdges.find(row => row.id === args.id);

    switch (command) {
      case 'get_all_stories':
        return stories;
      case 'get_graph_nodes':
        return args.storyId === story.id ? live(dbNodes) : [];
      case 'get_graph_edges':
        return args.storyId === story.id ? live(dbEdges) : [];
      case 'get_characters':
        return args.storyId === story.id ? cast : [];
      case 'get_story_character_stats':
      case 'get_character_stats':
      case 'get_character_attributes':
        return [];
      case 'update_graph_node':
        if (failNextNodeUpdate) {
          failNextNodeUpdate = false;
          throw new Error('the file is locked');
        }
        if (!node) return null;
        node.label = args.label;
        node.content = args.content;
        return { ...node };
      case 'update_graph_node_position':
        if (node) {
          node.pos_x = args.posX;
          node.pos_y = args.posY;
        }
        return null;
      case 'set_node_character':
        if (node) node.character_id = args.characterId ?? null;
        return node ? { ...node } : null;
      case 'update_graph_edge':
        if (!edge) return null;
        edge.label = args.label;
        edge.relation_type = args.relationType;
        return { ...edge };
      case 'create_graph_node': {
        const created = {
          ...nodeRow('n-new', args.label, args.nodeType, args.characterId ?? null, args.posX, args.posY),
          story_id: args.storyId,
        };
        dbNodes.push(created);
        return { ...created };
      }
      case 'create_graph_edge': {
        const created: EdgeRow = {
          id: 'e-new',
          story_id: args.storyId,
          source_id: args.sourceId,
          target_id: args.targetId,
          label: args.label,
          relation_type: args.relationType,
          created_by: args.createdBy,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        dbEdges.push(created);
        return { ...created };
      }
      case 'delete_node': {
        if (!node) return null;
        const stamp = `del-${node.id}`;
        node.deleted_at = stamp;
        // The database takes the attached connections with it.
        dbEdges
          .filter(row => row.source_id === node.id || row.target_id === node.id)
          .forEach(row => {
            row.deleted_at = stamp;
          });
        return null;
      }
      case 'delete_edge':
        if (edge) edge.deleted_at = 'del';
        return null;
      case 'restore_deleted': {
        if (args.kind === 'node') {
          const restored = dbNodes.find(row => row.id === args.id);
          if (restored) {
            const stamp = restored.deleted_at;
            restored.deleted_at = null;
            // A chapter comes back on its own; its connections wait in the
            // trash, as the database now does for any chapter node.
            if (restored.node_type !== 'chapter') {
              dbEdges
                .filter(row => row.deleted_at === stamp)
                .forEach(row => {
                  row.deleted_at = null;
                });
            }
          }
        }

        if (args.kind === 'edge') {
          const restored = dbEdges.find(row => row.id === args.id);
          if (restored) restored.deleted_at = null;
        }

        return null;
      }
      default:
        return null;
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

async function openApp() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findAllByText('Ledger');
  await screen.findByRole('button', { name: 'Opening' });
  return user;
}

function drawer() {
  return screen.getByRole('complementary', { name: 'Node inspector' });
}

function undoButton() {
  return screen.getByRole('button', { name: 'Undo' });
}

function redoButton() {
  return screen.getByRole('button', { name: 'Redo' });
}

describe('undo and redo', () => {
  it('puts back an edited label and redoes the edit', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Opening' }));
    const label = within(drawer()).getByLabelText('Label');
    await user.clear(label);
    await user.type(label, 'Opening the Vault');
    await user.click(within(drawer()).getByRole('button', { name: 'Save' }));

    expect(undoButton()).toBeEnabled();
    await user.click(undoButton());

    await waitFor(() =>
      expect(lastCall('update_graph_node')).toEqual({
        id: 'n1',
        label: 'Opening',
        content: null,
        user: 'You',
      })
    );
    await waitFor(() => expect(within(drawer()).getByLabelText('Label')).toHaveValue('Opening'));
    expect(screen.getByText('Undid: Edit “Opening the Vault”')).toBeInTheDocument();

    await user.click(redoButton());
    await waitFor(() =>
      expect(within(drawer()).getByLabelText('Label')).toHaveValue('Opening the Vault')
    );
  });

  it('puts back a relink made with the picker', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Rook' }));
    await user.selectOptions(within(drawer()).getByLabelText('Cast member'), 'char-2');
    expect(lastCall('set_node_character')).toEqual({
      nodeId: 'n2',
      characterId: 'char-2',
      user: 'You',
    });

    await user.click(undoButton());

    await waitFor(() =>
      expect(lastCall('set_node_character')).toEqual({
        nodeId: 'n2',
        characterId: 'char-1',
        user: 'You',
      })
    );
    await waitFor(() =>
      expect(within(drawer()).getByLabelText('Cast member')).toHaveValue('char-1')
    );
  });

  it('puts a dragged node back where it was', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'start n1' }));
    await user.click(screen.getByRole('button', { name: 'drop n1' }));

    expect(lastCall('update_graph_node_position')).toEqual({
      id: 'n1',
      posX: 250,
      posY: 160,
      user: 'You',
    });

    await user.click(undoButton());

    await waitFor(() =>
      expect(lastCall('update_graph_node_position')).toEqual({
        id: 'n1',
        posX: 0,
        posY: 0,
        user: 'You',
      })
    );

    await user.click(redoButton());
    await waitFor(() =>
      expect(lastCall('update_graph_node_position')).toEqual({
        id: 'n1',
        posX: 250,
        posY: 160,
        user: 'You',
      })
    );
  });

  it('brings a deleted node back, connections included', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'delete the character node' }));
    expect(undoButton()).toBeEnabled();

    await user.click(undoButton());

    await waitFor(() =>
      expect(lastCall('restore_deleted')).toEqual({
        id: 'n2',
        kind: 'node',
        user: 'You',
      })
    );
    expect(await screen.findByRole('button', { name: 'Rook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'edge n1 to n2' })).toBeInTheDocument();
  });

  it('restores a chapter without drawing its connections again', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'delete first node' }));

    await user.click(undoButton());

    await waitFor(() =>
      expect(lastCall('restore_deleted')).toEqual({
        id: 'n1',
        kind: 'node',
        user: 'You',
      })
    );

    // The chapter is back, and its line is a separate restore: the undo of a
    // chapter is a chapter action, not a bundle of chapter and connections.
    expect(await screen.findByRole('button', { name: 'Opening' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'edge n1 to n2' })
    ).not.toBeInTheDocument();
  });

  it('writes a refused undo into the history, not just the notice', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Opening' }));
    const label = within(drawer()).getByLabelText('Label');
    await user.clear(label);
    await user.type(label, 'Opening Two{Enter}');
    await waitFor(() => expect(undoButton()).toBeEnabled());

    failNextNodeUpdate = true;
    await user.click(undoButton());

    expect(await screen.findByText(/Could not undo/)).toBeInTheDocument();

    // The notice fades after five seconds; the history keeps the refusal.
    expect(lastCall('record_history_event')).toMatchObject({
      storyId: story.id,
      action: 'undo_refused',
      user: 'You',
    });
    const detail = (lastCall('record_history_event') as any).detail as string;
    expect(detail).toContain('Undo refused — Edit “Opening Two”');
    expect(detail).toContain('the file is locked');

    // The step stayed where it was, so it can be tried again.
    expect(undoButton()).toBeEnabled();
  });

  it('puts back a connection edit', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'edge n1 to n2' }));
    const label = screen.getByPlaceholderText('Label (optional)');
    await user.clear(label);
    await user.type(label, 'opens');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await user.click(undoButton());

    await waitFor(() =>
      expect(lastCall('update_graph_edge')).toEqual({
        id: 'e1',
        label: 'leads to',
        relationType: 'leads_to',
        user: 'You',
      })
    );

    await user.click(redoButton());
    await waitFor(() =>
      expect(lastCall('update_graph_edge')).toEqual({
        id: 'e1',
        label: 'opens',
        relationType: 'leads_to',
        user: 'You',
      })
    );
  });

  it('undoes a new node and a new connection', async () => {
    const user = await openApp();

    await user.type(screen.getByPlaceholderText('Node label'), 'Epilogue');
    await user.click(screen.getByRole('button', { name: 'Add Node' }));
    expect(screen.getByRole('button', { name: 'Epilogue' })).toBeInTheDocument();

    await user.click(undoButton());

    await waitFor(() =>
      expect(lastCall('delete_node')).toEqual({ id: 'n-new', user: 'You' })
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Epilogue' })).not.toBeInTheDocument()
    );

    await user.click(screen.getByRole('button', { name: 'connect two cards' }));
    expect(screen.getAllByRole('button', { name: 'edge n1 to n3' })).toHaveLength(1);

    await user.click(undoButton());
    await waitFor(() =>
      expect(lastCall('delete_edge')).toEqual({ id: 'e-new', user: 'You' })
    );
  });

  it('drops the redo branch as soon as something new is recorded', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Opening' }));
    await user.clear(within(drawer()).getByLabelText('Label'));
    await user.type(within(drawer()).getByLabelText('Label'), 'First{Enter}');

    await user.click(undoButton());
    await waitFor(() => expect(redoButton()).toBeEnabled());

    await user.clear(within(drawer()).getByLabelText('Label'));
    await user.type(within(drawer()).getByLabelText('Label'), 'Second{Enter}');

    expect(redoButton()).toBeDisabled();
  });

  it('undoes with Ctrl+Z and redoes with Ctrl+Shift+Z', async () => {
    const user = await openApp();

    await user.type(screen.getByPlaceholderText('Node label'), 'Epilogue');
    await user.click(screen.getByRole('button', { name: 'Add Node' }));

    // The button has focus, so the shortcut belongs to the app, not a field.
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() =>
      expect(lastCall('delete_node')).toEqual({ id: 'n-new', user: 'You' })
    );

    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    await waitFor(() =>
      expect(lastCall('restore_deleted')).toEqual({
        id: 'n-new',
        kind: 'node',
        user: 'You',
      })
    );
  });

  it('leaves Ctrl+Z to the text field that has focus', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Opening' }));
    const label = within(drawer()).getByLabelText('Label');
    await user.type(label, ' half-written');
    await user.keyboard('{Control>}z{/Control}');

    expect(lastCall('update_graph_node')).toBeUndefined();
    expect(undoButton()).toBeDisabled();
  });

  it('clears the history when another story is opened', async () => {
    stories = [story, otherStory];
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Opening' }));
    const label = within(drawer()).getByLabelText('Label');
    await user.clear(label);
    await user.type(label, 'Opening Two{Enter}');
    await waitFor(() => expect(undoButton()).toBeEnabled());

    await user.click(screen.getAllByText('Ashes')[0]);

    await waitFor(() => expect(undoButton()).toBeDisabled());
    expect(redoButton()).toBeDisabled();
  });
});
