import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock, flowMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  flowMock: {
    setCenter: vi.fn(),
    getZoom: vi.fn(() => 1),
    screenToFlowPosition: vi.fn(() => ({ x: 320, y: 180 })),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// The canvas exposes the gestures React Flow would perform as buttons: drawing
// a connection, ending one on empty canvas, and deleting an edge.
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
      onConnect,
      onConnectStart,
      onConnectEnd,
      onEdgesDelete,
    } = props;

    const Card = nodeTypes.default;

    React.useEffect(() => {
      onInit?.(flowMock);
    }, [onInit]);

    const spawn = (nodeId: string) => {
      onConnectStart?.({}, { nodeId });
      onConnectEnd?.(new MouseEvent('mouseup', { clientX: 90, clientY: 110 }));
    };

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
            : null
        )
      ),
      React.createElement(
        'button',
        { onClick: () => onConnect?.({ source: 'n1', target: 'n2' }) },
        'connect characters'
      ),
      React.createElement(
        'button',
        { onClick: () => onConnect?.({ source: 'n1', target: 'n3' }) },
        'connect character to chapter'
      ),
      React.createElement(
        'button',
        { onClick: () => spawn('n1') },
        'spawn from character'
      ),
      React.createElement(
        'button',
        { onClick: () => spawn('n3') },
        'spawn from chapter'
      ),
      edges.map((edge: any) =>
        React.createElement(
          'button',
          { key: edge.id, onClick: () => onEdgesDelete?.([edge]) },
          `remove ${edge.id}`
        )
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

interface NodeRow {
  id: string;
  node_type: string;
  label: string;
  character_id: string | null;
  chapter_seq: number | null;
}

function nodeRow(
  id: string,
  nodeType: string,
  label: string,
  characterId: string | null,
  chapterSeq: number | null = null
): NodeRow {
  return { id, node_type: nodeType, label, character_id: characterId, chapter_seq: chapterSeq };
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
}

interface CastRow {
  id: string;
  chapter_id: string;
  character_id: string;
  created_at: string;
  updated_at: string;
}

interface RelationRow {
  id: string;
  story_id: string;
  from_character_id: string;
  to_character_id: string;
  kind: string;
  note: string | null;
  since_chapter_id: string | null;
  until_chapter_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

let nodes: NodeRow[] = [];
let edges: EdgeRow[] = [];
let deletedEdges: EdgeRow[] = [];
let chapterCast: CastRow[] = [];
let relations: RelationRow[] = [];
let edgeSeq = 0;
let relationSeq = 0;
let castSeq = 0;

function timestamp() {
  return '2026-10-22T12:00:00Z';
}

beforeEach(() => {
  nodes = [
    nodeRow('n1', 'character', 'Rook', 'char-1'),
    nodeRow('n2', 'character', 'Wren', 'char-2'),
    nodeRow('n3', 'chapter', 'Opening', null, 1),
  ];
  edges = [];
  deletedEdges = [];
  chapterCast = [];
  relations = [];
  edgeSeq = 0;
  relationSeq = 0;
  castSeq = 0;

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return nodes.map(row => ({
          ...row,
          story_id: story.id,
          content: null,
          pos_x: 0,
          pos_y: 0,
          created_by: 'Ada',
          created_at: timestamp(),
          updated_at: timestamp(),
        }));
      case 'get_graph_edges':
        return edges.map(row => ({ ...row, updated_at: timestamp() }));
      case 'get_characters':
        return cast;
      case 'get_story_chapter_cast':
        return chapterCast;
      case 'get_story_relations':
        return relations;
      case 'create_graph_edge': {
        edgeSeq += 1;
        const edge: EdgeRow = {
          id: `e${edgeSeq}`,
          story_id: story.id,
          source_id: args.sourceId,
          target_id: args.targetId,
          label: args.label ?? null,
          relation_type: args.relationType ?? null,
          created_by: args.createdBy,
          created_at: timestamp(),
        };
        edges.push(edge);
        return { ...edge, updated_at: timestamp() };
      }
      case 'delete_edge': {
        const edge = edges.find(row => row.id === args.id);
        if (edge) {
          edges = edges.filter(row => row.id !== edge.id);
          deletedEdges.push(edge);
        }
        return null;
      }
      case 'restore_deleted': {
        if (args.kind !== 'edge') return null;
        const edge = deletedEdges.find(row => row.id === args.id);
        if (edge) {
          deletedEdges = deletedEdges.filter(row => row.id !== edge.id);
          edges.push(edge);
        }
        return null;
      }
      case 'add_relation': {
        relationSeq += 1;
        const relation: RelationRow = {
          id: `relation-${relationSeq}`,
          story_id: story.id,
          from_character_id: args.fromCharacterId,
          to_character_id: args.toCharacterId,
          kind: args.kind,
          note: args.note ?? null,
          since_chapter_id: args.sinceChapterId ?? null,
          until_chapter_id: args.untilChapterId ?? null,
          created_by: args.user,
          created_at: timestamp(),
          updated_at: timestamp(),
        };
        relations.push(relation);
        return relation;
      }
      case 'delete_relation':
        relations = relations.filter(row => row.id !== args.id);
        return null;
      case 'add_chapter_cast_member': {
        const existing = chapterCast.find(
          row => row.chapter_id === args.chapterId && row.character_id === args.characterId
        );
        if (existing) return existing;

        castSeq += 1;
        const member: CastRow = {
          id: `cast-${castSeq}`,
          chapter_id: args.chapterId,
          character_id: args.characterId,
          created_at: timestamp(),
          updated_at: timestamp(),
        };
        chapterCast.push(member);
        return member;
      }
      case 'remove_chapter_cast_member':
        chapterCast = chapterCast.filter(row => row.id !== args.id);
        return null;
      default:
        return [];
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

async function openCanvas() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await screen.findByTitle('The kind of node the Add button creates');

  return user;
}

describe('connection actions', () => {
  it('turns a character connection into a relation and undoes both together', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect characters' }));

    const dialog = await screen.findByRole('dialog', { name: 'Connect characters' });
    const kind = within(dialog).getByLabelText('Relation kind');
    expect(kind).toHaveValue('ally');

    await user.clear(kind);
    await user.type(kind, 'enemy');
    await user.selectOptions(within(dialog).getByLabelText('Since chapter (optional)'), 'n3');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'The truce ended.');
    await user.click(within(dialog).getByRole('button', { name: 'Connect characters' }));

    await waitFor(() =>
      expect(lastCall('add_relation')).toEqual({
        fromCharacterId: 'char-1',
        toCharacterId: 'char-2',
        kind: 'enemy',
        note: 'The truce ended.',
        sinceChapterId: 'n3',
        untilChapterId: null,
        user: 'You',
      })
    );
    expect(lastCall('create_graph_edge')).toMatchObject({
      storyId: story.id,
      sourceId: 'n1',
      targetId: 'n2',
      label: 'enemy',
      relationType: 'enemy',
      createdBy: 'You',
    });

    expect(screen.queryByRole('dialog', { name: 'Connect characters' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'remove e1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('delete_relation')).toEqual({ id: 'relation-1', user: 'You' })
    );
    expect(lastCall('delete_edge')).toEqual({ id: 'e1', user: 'You' });

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    await waitFor(() =>
      expect(lastCall('add_relation')).toMatchObject({
        fromCharacterId: 'char-1',
        toCharacterId: 'char-2',
        kind: 'enemy',
      })
    );
    expect(lastCall('restore_deleted')).toEqual({ id: 'e1', kind: 'edge', user: 'You' });
  });

  it('cancels a relation without writing either half', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect characters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect characters' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog', { name: 'Connect characters' })).not.toBeInTheDocument();
    expect(lastCall('create_graph_edge')).toBeUndefined();
    expect(lastCall('add_relation')).toBeUndefined();
  });

  it('adds the character to the chapter cast and asks before removing it', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect character to chapter' }));

    await waitFor(() =>
      expect(lastCall('add_chapter_cast_member')).toEqual({
        chapterId: 'n3',
        characterId: 'char-1',
        user: 'You',
      })
    );
    expect(lastCall('create_graph_edge')).toMatchObject({
      sourceId: 'n1',
      targetId: 'n3',
      label: 'cast',
      relationType: 'cast',
    });
    expect(screen.getByRole('button', { name: 'remove e1' })).toBeInTheDocument();

    // Keep leaves both the connection and the cast row alone.
    await user.click(screen.getByRole('button', { name: 'remove e1' }));
    const keep = await screen.findByRole('dialog', { name: 'Remove connection' });
    expect(keep).toHaveTextContent("Rook will leave Opening's cast");
    await user.click(within(keep).getByRole('button', { name: 'Keep' }));

    expect(lastCall('remove_chapter_cast_member')).toBeUndefined();
    expect(screen.getByRole('button', { name: 'remove e1' })).toBeInTheDocument();

    // Removing deletes the cast row and the edge, and undo brings both back.
    await user.click(screen.getByRole('button', { name: 'remove e1' }));
    const remove = await screen.findByRole('dialog', { name: 'Remove connection' });
    await user.click(within(remove).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(lastCall('remove_chapter_cast_member')).toEqual({ id: 'cast-1', user: 'You' })
    );
    expect(lastCall('delete_edge')).toEqual({ id: 'e1', user: 'You' });
    expect(screen.queryByRole('button', { name: 'remove e1' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('add_chapter_cast_member')).toEqual({
        chapterId: 'n3',
        characterId: 'char-1',
        user: 'You',
      })
    );
    expect(lastCall('restore_deleted')).toEqual({ id: 'e1', kind: 'edge', user: 'You' });
  });

  it('asks before deleting a relation by deleting the edge that drew it', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect characters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect characters' });
    await user.click(within(dialog).getByRole('button', { name: 'Connect characters' }));
    await waitFor(() => expect(lastCall('add_relation')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'remove e1' }));

    const remove = await screen.findByRole('dialog', { name: 'Remove connection' });
    expect(remove).toHaveTextContent('The ally relation between Rook and Wren will be deleted');
    await user.click(within(remove).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(lastCall('delete_relation')).toEqual({ id: 'relation-1', user: 'You' })
    );
    expect(lastCall('delete_edge')).toEqual({ id: 'e1', user: 'You' });
  });

  it('pre-fills a skill owner and a quest giver from a character card', async () => {
    const user = await openCanvas();
    const type = screen.getByTitle('The kind of node the Add button creates');

    await user.selectOptions(type, 'skill');
    await user.click(screen.getByRole('button', { name: 'spawn from character' }));

    const skill = await screen.findByRole('dialog', { name: 'New skill' });
    expect(within(skill).getByLabelText('Skill owner')).toHaveValue('char-1');
    await user.click(within(skill).getByRole('button', { name: 'Cancel' }));

    await user.selectOptions(type, 'quest');
    await user.click(screen.getByRole('button', { name: 'spawn from character' }));

    const quest = await screen.findByRole('dialog', { name: 'New quest' });
    expect(within(quest).getByLabelText('Quest giver')).toHaveValue('char-1');
  });

  it('pre-fills a skill chapter and a quest chapter from a chapter card', async () => {
    const user = await openCanvas();
    const type = screen.getByTitle('The kind of node the Add button creates');

    await user.selectOptions(type, 'skill');
    await user.click(screen.getByRole('button', { name: 'spawn from chapter' }));

    const skill = await screen.findByRole('dialog', { name: 'New skill' });
    expect(within(skill).getByLabelText('Skill chapter')).toHaveValue('n3');
    await user.click(within(skill).getByRole('button', { name: 'Cancel' }));

    await user.selectOptions(type, 'quest');
    await user.click(screen.getByRole('button', { name: 'spawn from chapter' }));

    const quest = await screen.findByRole('dialog', { name: 'New quest' });
    expect(within(quest).getByLabelText('Quest accepted chapter')).toHaveValue('n3');
  });
});
