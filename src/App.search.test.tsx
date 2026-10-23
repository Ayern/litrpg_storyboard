import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock, flowMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  flowMock: { setCenter: vi.fn(), getZoom: vi.fn(() => 1) },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// React Flow needs real DOM measurements, so the canvas draws each node through
// the card the app registers, inside the wrapper whose class carries the search
// highlights. The fake instance records the pan the search asks for.
vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  interface CanvasProps {
    nodes?: { id: string; data: unknown; className?: string }[];
    nodeTypes?: Record<string, React.ComponentType<Record<string, unknown>>>;
    children?: unknown;
    onInit?: (instance: unknown) => void;
  }

  const Canvas = ({ nodes = [], nodeTypes = {}, children, onInit }: CanvasProps) => {
    const Card = nodeTypes.default;

    React.useEffect(() => {
      onInit?.(flowMock);
    }, [onInit]);

    return React.createElement(
      'div',
      { 'data-testid': 'canvas' },
      nodes.map((node, index) =>
        React.createElement(
          'div',
          {
            key: node.id,
            className: `react-flow__node ${node.className ?? ''}`.trim(),
            'data-id': node.id,
          },
          Card
            ? React.createElement(Card, {
                id: node.id,
                data: node.data,
                isConnectable: true,
                selected: false,
                xPos: 0,
                yPos: index * 40,
                zIndex: 0,
                dragging: false,
              })
            : null
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

const rows = [
  {
    id: 'n1',
    story_id: story.id,
    node_type: 'chapter',
    label: 'Opening',
    content: 'Rook arrives at the vault.',
    pos_x: 0,
    pos_y: 0,
    created_by: 'Ada',
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
    character_id: null,
  },
  {
    id: 'n2',
    story_id: story.id,
    node_type: 'character',
    label: 'Rook',
    content: null,
    pos_x: 400,
    pos_y: 300,
    created_by: 'Ada',
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
    character_id: 'char-1',
  },
  {
    id: 'n3',
    story_id: story.id,
    node_type: 'location',
    label: 'Vault',
    content: 'Where the wardens keep the ledgers.',
    pos_x: 0,
    pos_y: 200,
    created_by: 'Ada',
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
    character_id: null,
  },
];

const cast = [
  {
    id: 'char-1',
    story_id: story.id,
    name: 'Rook',
    description: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
];

beforeEach(() => {
  flowMock.setCenter.mockReset();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return rows;
      case 'get_graph_edges':
      case 'get_story_character_stats':
      case 'get_character_stats':
      case 'get_character_attributes':
        return [];
      case 'get_characters':
        return cast;
      default:
        return null;
    }
  });
});

async function openCanvas() {
  const { container } = render(<App />);

  await screen.findAllByText('Ledger');
  await screen.findByText('Opening');

  return { container };
}

function searchDialog() {
  return screen.getByRole('dialog', { name: 'Search the canvas' });
}

function hitIds(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.react-flow__node.search-hit')).map(
    node => node.getAttribute('data-id')
  );
}

describe('the canvas search', () => {
  it('opens with Ctrl+F and outlines every match as the query is typed', async () => {
    const user = userEvent.setup();
    const { container } = await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

    const input = await screen.findByLabelText('Search nodes');
    expect(input).toHaveFocus();

    await user.type(input, 'vault');

    // One match by label, one by the word in its notes.
    await waitFor(() => expect(hitIds(container)).toEqual(['n1', 'n3']));

    const results = searchDialog();
    expect(within(results).getByText('Opening')).toBeInTheDocument();
    expect(within(results).getByText('Vault')).toBeInTheDocument();
    expect(within(results).getByText(/2 matches/)).toBeInTheDocument();
  });

  it('goes to the match on Enter, opening it and panning the canvas', async () => {
    const user = userEvent.setup();
    const { container } = await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search nodes'), 'vault');

    // The first match is the chapter, which mentions the vault in its notes.
    await waitFor(() => expect(hitIds(container)).toEqual(['n1', 'n3']));
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(flowMock.setCenter).toHaveBeenCalledWith(70, 20, { zoom: 1, duration: 300 })
    );

    expect(screen.queryByRole('dialog', { name: 'Search the canvas' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('complementary', { name: 'Node inspector' })).getByLabelText(
        'Label'
      )
    ).toHaveValue('Opening');
  });

  it('walks the matches with the arrow keys before choosing one', async () => {
    const user = userEvent.setup();
    await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    const input = await screen.findByLabelText('Search nodes');
    await user.type(input, 'vault');
    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() =>
      expect(flowMock.setCenter).toHaveBeenCalledWith(70, 220, { zoom: 1, duration: 300 })
    );

    expect(
      within(screen.getByRole('complementary', { name: 'Node inspector' })).getByLabelText(
        'Label'
      )
    ).toHaveValue('Vault');
  });

  it('finds a node by whose cast member it is', async () => {
    const user = userEvent.setup();
    const { container } = await openCanvas();

    // Only the node labelled "Rook" is linked to her; searching the cast name
    // reaches it, and nothing else here is called Rook.
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search nodes'), 'rook');

    await waitFor(() => expect(hitIds(container)).toEqual(['n1', 'n2']));
  });

  it('says when nothing matches', async () => {
    const user = userEvent.setup();
    const { container } = await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search nodes'), 'zeppelin');

    expect(screen.getByText('No node matches “zeppelin”.')).toBeInTheDocument();
    expect(screen.getByText('0 matches', { exact: false })).toBeInTheDocument();
    expect(hitIds(container)).toEqual([]);
  });

  it('closes on Escape and starts empty next time', async () => {
    const user = userEvent.setup();
    const { container } = await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    const input = await screen.findByLabelText('Search nodes');
    await user.type(input, 'vault');
    await waitFor(() => expect(hitIds(container)).toHaveLength(2));

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Search the canvas' })).not.toBeInTheDocument();
    expect(hitIds(container)).toEqual([]);

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(await screen.findByLabelText('Search nodes')).toHaveValue('');
  });

  it('explains the controls before they are used', async () => {
    const user = userEvent.setup();
    await openCanvas();

    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute(
      'title',
      expect.stringContaining('Ctrl+F')
    );
    expect(screen.getByRole('button', { name: 'Add Node' })).toHaveAttribute(
      'title',
      'Add a node of the selected type to the canvas'
    );
    expect(screen.getByRole('button', { name: 'Graph' })).toHaveAttribute(
      'title',
      expect.stringContaining('idea graph')
    );
    expect(screen.getByTitle('Label for the new node')).toBeInTheDocument();
    expect(screen.getByTitle('The kind of node the Add button creates')).toBeInTheDocument();

    // The help is not only on the canvas: the other tabs explain their controls too.
    await user.click(screen.getByRole('button', { name: 'Characters' }));
    expect(await screen.findByRole('button', { name: 'Add character' })).toHaveAttribute(
      'title',
      expect.stringContaining('cast')
    );
  });
});
