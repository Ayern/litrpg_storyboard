import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
    nodes?: { id: string; data: unknown; hidden?: boolean }[];
    edges?: { id: string; hidden?: boolean }[];
    nodeTypes?: Record<string, React.ComponentType<Record<string, unknown>>>;
    children?: unknown;
  }

  const Canvas = ({ nodes = [], edges = [], nodeTypes = {}, children }: CanvasProps) => {
    const Card = nodeTypes.default;

    return React.createElement(
      'div',
      { 'data-testid': 'canvas' },
      // The layer a card is drawn in is carried by the `hidden` flag, so the
      // stub keeps it where a test can read it: a real board draws nothing for a
      // hidden card, and hides the lines that end on one.
      React.createElement(
        'div',
        { 'data-testid': 'edges' },
        edges.map(edge =>
          React.createElement('span', {
            key: edge.id,
            'data-edge-id': edge.id,
            'data-hidden': edge.hidden ? 'true' : 'false',
          })
        )
      ),
      nodes.map((node, index) =>
        React.createElement(
          'div',
          { key: node.id, 'data-id': node.id, 'data-hidden': node.hidden ? 'true' : 'false' },
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
          node('n4', 'System notice', 'system'),
          node('n5', 'Fireball', 'skill'),
          node('n6', 'Tooth key', 'item'),
          node('n7', 'Find the vault', 'quest'),
          node('n8', 'The Guild', 'faction'),
        ];
      case 'get_graph_edges':
        // A cast thread, which belongs to a card that is not on the spine.
        return [
          { id: 'e1', source_id: 'n1', target_id: 'n2', label: null, relation_type: 'cast' },
        ];
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

  it('draws the LitRPG vocabulary as its own cards', async () => {
    const { container } = render(<App />);

    await screen.findAllByText('Ledger');
    await screen.findByText('System notice');

    const cards: [string, string][] = [
      ['system', 'System notice'],
      ['skill', 'Fireball'],
      ['item', 'Tooth key'],
      ['quest', 'Find the vault'],
      ['faction', 'The Guild'],
    ];

    for (const [type, label] of cards) {
      const card = container.querySelector(`.graph-node.${type}`);
      expect(card).not.toBeNull();
      expect(card).toHaveTextContent(type);
      expect(card).toHaveTextContent(label);
    }
  });

  it('opens on the chapter spine and keeps the other cards off the board', async () => {
    const { container } = render(<App />);

    await screen.findByText('Opening');

    const drawn = (id: string) =>
      container.querySelector(`[data-id="${id}"]`)?.getAttribute('data-hidden');

    expect(drawn('n1')).toBe('false');
    // The cast, the System, the skill, the item, the quest and the faction are
    // all there in the story and none of them is on screen.
    for (const id of ['n2', 'n4', 'n5', 'n6', 'n7', 'n8']) {
      expect(drawn(id), `card ${id}`).toBe('true');
    }

    // A type the build does not know is drawn rather than hidden.
    expect(drawn('n3')).toBe('false');

    // And the line into the hidden cast card is hidden with it, rather than
    // running off the edge of the spine to a card nobody can see.
    expect(container.querySelector('[data-edge-id="e1"]')).toHaveAttribute(
      'data-hidden',
      'true'
    );
  });

  it('draws the layers the chips name, one at a time', async () => {
    const { container } = render(<App />);
    const user = userEvent.setup();

    await screen.findByText('Opening');

    const drawn = (id: string) =>
      container.querySelector(`[data-id="${id}"]`)?.getAttribute('data-hidden');

    await user.click(screen.getByRole('button', { name: 'Entities' }));

    expect(drawn('n2')).toBe('false');
    expect(drawn('n5')).toBe('false');
    expect(drawn('n7')).toBe('true');
    expect(drawn('n1')).toBe('false');
    expect(container.querySelector('[data-edge-id="e1"]')).toHaveAttribute(
      'data-hidden',
      'false'
    );

    await user.click(screen.getByRole('button', { name: 'Arcs & quests' }));
    expect(drawn('n7')).toBe('false');

    await user.click(screen.getByRole('button', { name: 'Chapters only' }));
    expect(drawn('n1')).toBe('false');
    expect(drawn('n2')).toBe('true');
    expect(drawn('n7')).toBe('true');
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
      'system',
      'skill',
      'item',
      'quest',
      'faction',
      'misc',
    ]);

    // Every chip carries its own type class, which is where its colour comes from.
    expect(chips.every(chip => chip.classList.length === 2)).toBe(true);
    expect(container.querySelector('.legend.chapter')).toHaveTextContent('chapter');
  });
});
