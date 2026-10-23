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

vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  const Canvas = (props: any) => {
    const { nodes = [], nodeTypes = {}, children, onInit, onNodeClick } = props;
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
          )
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

interface NodeRow {
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
  chapter_seq: number | null;
}

function nodeRow(
  id: string,
  nodeType: string,
  label: string,
  seq: number | null,
  createdAt = '2026-10-22T12:00:00Z'
): NodeRow {
  return {
    id,
    story_id: story.id,
    node_type: nodeType,
    label,
    content: null,
    pos_x: 0,
    pos_y: 0,
    created_by: 'Ada',
    created_at: createdAt,
    updated_at: createdAt,
    character_id: null,
    chapter_seq: seq,
  };
}

let rows: NodeRow[] = [];

const chaptersInOrder = () =>
  rows
    .filter(node => node.node_type === 'chapter')
    .sort((left, right) => (left.chapter_seq ?? 999) - (right.chapter_seq ?? 999));

beforeEach(() => {
  rows = [
    nodeRow('n1', 'chapter', 'One', 1, '2026-10-22T12:00:00Z'),
    nodeRow('n2', 'idea', 'Idea', null, '2026-10-22T12:01:00Z'),
    nodeRow('n3', 'chapter', 'Two', 2, '2026-10-22T12:02:00Z'),
    nodeRow('n4', 'chapter', 'Three', 3, '2026-10-22T12:03:00Z'),
  ];

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return rows.map(row => ({ ...row }));
      case 'get_graph_edges':
        return [];
      case 'get_characters':
      case 'get_story_character_stats':
      case 'get_character_stats':
      case 'get_character_attributes':
      case 'get_audit_history':
        return [];
      case 'create_graph_node': {
        const highest = Math.max(0, ...rows.map(row => row.chapter_seq ?? 0));
        const created = nodeRow(
          `n-created-${rows.length + 1}`,
          args.nodeType,
          args.label,
          args.nodeType === 'chapter' ? highest + 1 : null
        );
        created.pos_x = args.posX;
        created.pos_y = args.posY;
        rows = [...rows, created];
        return { ...created };
      }
      case 'set_chapter_order': {
        const ordered = args.orderedIds as string[];
        ordered.forEach((id, index) => {
          const row = rows.find(candidate => candidate.id === id);
          if (row) row.chapter_seq = index + 1;
        });
        return chaptersInOrder().map(row => ({ ...row }));
      }
      default:
        return null;
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

async function openChapters() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Chapters' }));

  return user;
}

function list() {
  return screen.getByRole('list', { name: 'Chapters' });
}

function rowsInList() {
  return within(list()).getAllByRole('listitem');
}

describe('the chapter list', () => {
  it('numbers the chapters and leaves other cards out', async () => {
    await openChapters();

    const rows = rowsInList();
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('One')).toBeInTheDocument();
    expect(within(rows[0]).getByText('1')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Two')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Three')).toBeInTheDocument();
    expect(within(rows[2]).getByText('3')).toBeInTheDocument();
    expect(screen.queryByText('Idea')).not.toBeInTheDocument();
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
  });

  it('adds a chapter at the end and shows it on the graph', async () => {
    const user = await openChapters();

    await user.type(screen.getByPlaceholderText('Chapter title'), 'Four');
    await user.click(screen.getByRole('button', { name: 'New chapter' }));

    expect(lastCall('create_graph_node')).toEqual({
      storyId: story.id,
      nodeType: 'chapter',
      label: 'Four',
      content: null,
      posX: expect.any(Number),
      posY: expect.any(Number),
      createdBy: 'You',
    });

    const added = await waitFor(() => rowsInList()[3]);
    expect(within(added).getByText('Four')).toBeInTheDocument();
    expect(within(added).getByText('4')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Chapter title')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    expect(await screen.findByText('Ch. 4')).toBeInTheDocument();
  });

  it('moves a chapter up by one and renumbers the rest', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Move Two earlier' }));

    await waitFor(() =>
      expect(lastCall('set_chapter_order')).toEqual({
        storyId: story.id,
        orderedIds: ['n3', 'n1', 'n4'],
        user: 'You',
      })
    );

    await waitFor(() => {
      const moved = rowsInList();
      expect(within(moved[0]).getByText('Two')).toBeInTheDocument();
      expect(within(moved[0]).getByText('1')).toBeInTheDocument();
      expect(within(moved[1]).getByText('One')).toBeInTheDocument();
      expect(within(moved[2]).getByText('Three')).toBeInTheDocument();
    });

    // The canvas badge follows the list.
    await user.click(screen.getByRole('button', { name: 'Graph' }));
    expect(await screen.findByText('Ch. 1')).toBeInTheDocument();
  });

  it('cannot move the first chapter earlier or the last one later', async () => {
    await openChapters();

    expect(screen.getByRole('button', { name: 'Move One earlier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Three later' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Two earlier' })).toBeEnabled();
  });

  it('flags a gap left by a deleted chapter and can renumber it away', async () => {
    // Chapter Two was trashed, so the live story holds 1 and 3.
    rows = rows.filter(node => node.id !== 'n3');

    const user = await openChapters();

    expect(
      screen.getByText(/reading order needs attention: position 2 is empty/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Renumber' }));

    await waitFor(() =>
      expect(lastCall('set_chapter_order')).toEqual({
        storyId: story.id,
        orderedIds: ['n1', 'n4'],
        user: 'You',
      })
    );

    await waitFor(() => {
      const numbered = rowsInList();
      expect(within(numbered[0]).getByText('One')).toBeInTheDocument();
      expect(within(numbered[0]).getByText('1')).toBeInTheDocument();
      expect(within(numbered[1]).getByText('Three')).toBeInTheDocument();
      expect(within(numbered[1]).getByText('2')).toBeInTheDocument();
    });
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
  });

  it('says when two chapters share a position', async () => {
    rows = rows.map(node => (node.id === 'n4' ? { ...node, chapter_seq: 2 } : node));

    await openChapters();

    expect(
      screen.getByText(/reading order needs attention: position 2 is used more than once/i)
    ).toBeInTheDocument();
  });

  it('keeps the old order and says why when the database refuses', async () => {
    const user = await openChapters();

    invokeMock.mockImplementationOnce(async () => {
      throw 'another window moved a chapter';
    });
    await user.click(screen.getByRole('button', { name: 'Move Three earlier' }));

    expect(
      await screen.findByText(/Could not reorder chapters: another window moved a chapter/i)
    ).toBeInTheDocument();

    const unchanged = rowsInList();
    expect(within(unchanged[0]).getByText('One')).toBeInTheDocument();
    expect(within(unchanged[2]).getByText('Three')).toBeInTheDocument();
  });

  it('undoes a move through the same command', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Move Two earlier' }));
    await waitFor(() => expect(rows[0].chapter_seq).toBe(2));

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect([...invokeMock.mock.calls].reverse().find(call => call[0] === 'set_chapter_order')?.[1])
        .toEqual({
          storyId: story.id,
          orderedIds: ['n1', 'n3', 'n4'],
          user: 'You',
        })
    );
  });

  it('shows an empty list for a story with no chapters', async () => {
    rows = [nodeRow('n2', 'idea', 'Idea', null)];

    await openChapters();

    expect(
      screen.getByText(/No chapters yet — add one here, or add a chapter card on the Graph tab/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Chapters' })).not.toBeInTheDocument();
  });
});
