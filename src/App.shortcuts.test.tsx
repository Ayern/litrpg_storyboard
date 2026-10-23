import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// React Flow needs real DOM measurements, so the canvas is replaced with
// something that draws every node through the map the app registers.
vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  interface CanvasProps {
    nodes?: { id: string; data: unknown }[];
    nodeTypes?: Record<string, React.ComponentType<Record<string, unknown>>>;
    children?: unknown;
  }

  const Canvas = ({ nodes = [], nodeTypes = {}, children }: CanvasProps) => {
    const Card = nodeTypes.default;

    return React.createElement(
      'div',
      { 'data-testid': 'canvas' },
      nodes.map((node, index) =>
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
    content: null,
    pos_x: 0,
    pos_y: 0,
    created_by: 'Ada',
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
    character_id: null,
  },
];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return rows;
      case 'get_graph_edges':
      case 'get_characters':
      case 'get_story_character_stats':
        return [];
      default:
        return null;
    }
  });
});

async function openApp() {
  render(<App />);
  await screen.findAllByText('Ledger');
  await screen.findByText('Opening');
}

function shortcutDialog() {
  return screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
}

describe('the keyboard reference', () => {
  it('opens from the button beside the user name and says what the keys do', async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));

    const dialog = shortcutDialog();
    expect(within(dialog).getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument();

    // The routes for searching are listed with the key that the Search button
    // itself names, so the two cannot disagree.
    expect(within(dialog).getByText('Search')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Open the search palette (Graph and Chapters tabs)')
    ).toBeInTheDocument();
    const key = within(dialog).getByText('Ctrl+F');
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('title')).toContain(
      key.textContent
    );

    await user.click(within(dialog).getByRole('button', { name: 'Close shortcuts' }));
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
  });

  it('opens with ? on any tab and closes on Escape', async () => {
    const user = userEvent.setup();
    await openApp();

    // Characters is a tab with no shortcuts of its own; the reference still opens.
    await user.click(screen.getByRole('button', { name: 'Characters' }));

    fireEvent.keyDown(window, { key: '?' });
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
    );
  });

  it('leaves a question mark alone while a field is being typed in', async () => {
    const user = userEvent.setup();
    await openApp();

    const nameField = screen.getByPlaceholderText('Your name');
    await user.type(nameField, '?');

    expect(nameField).toHaveValue('You?');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
  });

  it('keeps the canvas shortcuts to itself while the list is open', async () => {
    await openApp();

    fireEvent.keyDown(window, { key: '?' });
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });

    // Ctrl+F would otherwise open the search palette behind the overlay.
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

    expect(screen.queryByRole('dialog', { name: 'Search the storyboard' })).not.toBeInTheDocument();
    expect(shortcutDialog()).toBeInTheDocument();
  });

  it('closes when the backdrop is clicked, but not when the list is', async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    const dialog = shortcutDialog();

    await user.click(dialog);
    expect(shortcutDialog()).toBeInTheDocument();

    await user.click(dialog.parentElement as HTMLElement);
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
  });
});
