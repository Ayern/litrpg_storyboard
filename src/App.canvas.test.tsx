import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// React Flow needs real DOM measurements, so the canvas is replaced with
// something that draws every node through the map the app registers. That way
// the custom node card is rendered here exactly as React Flow would render it.
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
        Card
          ? React.createElement(Card, {
              key: node.id,
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
    // Real state, so the nodes the app loads after mount actually reach the canvas.
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

function node(id: string, label: string, nodeType: string) {
  return {
    id,
    story_id: story.id,
    node_type: nodeType,
    label,
    content: null,
    pos_x: 0,
    pos_y: 0,
    created_by: 'Ada',
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        // The third type is not one the app knows, so it has to fall back.
        return [
          node('n1', 'Opening', 'chapter'),
          node('n2', 'Rook', 'character'),
          node('n3', 'Stray', 'nonsense'),
        ];
      case 'get_graph_edges':
      case 'get_characters':
      case 'get_story_character_stats':
        return [];
      default:
        return null;
    }
  });
});

describe('the graph canvas', () => {
  it('draws each node as a card coloured and captioned by its type', async () => {
    const { container } = render(<App />);

    await screen.findAllByText('Ledger');
    await screen.findByText('Opening');

    // The type is the card's class, which is what colours it, and its caption.
    const chapter = container.querySelector('.graph-node.chapter');
    expect(chapter).not.toBeNull();
    expect(chapter).toHaveTextContent('chapter');
    expect(chapter).toHaveTextContent('Opening');

    expect(container.querySelector('.graph-node.character')).toHaveTextContent('Rook');

    // An unknown type is still drawn, as the neutral one rather than unstyled.
    const stray = container.querySelector('.graph-node.misc');
    expect(stray).toHaveTextContent('Stray');
  });

  it('keeps the legend in step with the types the cards use', async () => {
    const { container } = render(<App />);

    await screen.findAllByText('Ledger');
    await screen.findByText('Opening');

    const chips = Array.from(container.querySelectorAll('.legend'));
    expect(chips.map(chip => chip.textContent)).toEqual([
      'chapter',
      'idea',
      'character',
      'location',
      'event',
      'plot',
      'misc',
    ]);

    // Every chip carries its own type class, which is where its colour comes from.
    expect(chips.every(chip => chip.classList.length === 2)).toBe(true);
    expect(container.querySelector('.legend.chapter')).toHaveTextContent('chapter');
  });
});
