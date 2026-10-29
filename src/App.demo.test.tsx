import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const demoStory = {
  id: 'demo-1',
  title: 'The Ninth Bell (Demo)',
  description: 'A prepared story for trying the whole board.',
  created_at: '2026-10-24T12:00:00Z',
  updated_at: '2026-10-24T12:00:00Z',
};

const chapter = (
  id: string,
  label: string,
  seq: number,
  x: number
) => ({
  id,
  story_id: demoStory.id,
  node_type: 'chapter',
  label,
  content: null,
  pos_x: x,
  pos_y: 120,
  created_by: 'You',
  created_at: '2026-10-24T12:00:00Z',
  updated_at: '2026-10-24T12:00:00Z',
  character_id: null,
  chapter_seq: seq,
  chapter_arc: null,
  chapter_words: null,
  chapter_target: null,
  chapter_pov: null,
  chapter_day: null,
  chapter_time: null,
  parent_node_id: null,
});

const chapters = [
  chapter('demo-ch-1', 'The Low Tide', 1, 80),
  chapter('demo-ch-2', 'Nine Minutes', 2, 460),
  chapter('demo-ch-3', 'The Drowned Stair', 3, 840),
  chapter('demo-ch-4', 'The Tally', 4, 840),
  chapter('demo-ch-5', 'The Ninth Bell', 5, 460),
  chapter('demo-ch-6', 'After the Bell', 6, 80),
];

const cast = [
  {
    id: 'demo-ivy',
    story_id: demoStory.id,
    name: 'Ivy Marrow',
    description: null,
    level: 4,
    xp: 1850,
    rank: 'Bronze',
    xp_to_next: 3000,
    created_at: '2026-10-24T12:00:00Z',
    updated_at: '2026-10-24T12:00:00Z',
  },
  {
    id: 'demo-tamsin',
    story_id: demoStory.id,
    name: 'Tamsin Quill',
    description: null,
    level: 3,
    xp: 1450,
    rank: 'Bronze',
    xp_to_next: 2200,
    created_at: '2026-10-24T12:00:00Z',
    updated_at: '2026-10-24T12:00:00Z',
  },
];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [];
      case 'create_demo_story':
        return { ...demoStory };
      case 'reset_demo_story':
        return { ...demoStory, updated_at: '2026-10-24T12:30:00Z' };
      case 'get_graph_nodes':
        return args.storyId === demoStory.id ? chapters.map(node => ({ ...node })) : [];
      case 'get_graph_edges':
      case 'get_story_character_stats':
      case 'get_story_skills':
      case 'get_story_skill_events':
      case 'get_story_levels':
      case 'get_story_character_progress':
      case 'get_story_inventory':
      case 'get_chapter_notes':
      case 'get_story_chapter_cast':
      case 'get_story_chapter_cast_states':
        return [];
      case 'get_characters':
        return args.storyId === demoStory.id ? cast.map(entry => ({ ...entry })) : [];
      default:
        return null;
    }
  });
});

describe('demo story', () => {
  it('creates and opens a prepared story from the sidebar', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText('No stories yet');
    await user.click(screen.getByRole('button', { name: 'Load demo story' }));

    expect(
      invokeMock.mock.calls.some(
        call =>
          call[0] === 'create_demo_story' &&
          (call[1] as Record<string, unknown>)?.user === 'You'
      )
    ).toBe(true);

    await waitFor(() =>
      expect(screen.getAllByText('The Ninth Bell (Demo)').length).toBeGreaterThan(0)
    );
    expect(await screen.findByRole('button', { name: 'The Low Tide' })).toBeInTheDocument();

    for (const label of [
      'Nine Minutes',
      'The Drowned Stair',
      'The Tally',
      'The Ninth Bell',
      'After the Bell',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('resets the open demo in place after confirmation', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText('No stories yet');
    await user.click(screen.getByRole('button', { name: 'Load demo story' }));

    const resetButton = await screen.findByRole('button', { name: 'Reset demo story' });

    // The first click only asks; nothing is replaced until the second one.
    await user.click(resetButton);
    expect(
      invokeMock.mock.calls.some(call => call[0] === 'reset_demo_story')
    ).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.getByRole('button', { name: 'Reset demo story' })
    ).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.some(call => call[0] === 'reset_demo_story')
    ).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Reset demo story' }));
    await user.click(screen.getByRole('button', { name: 'Replace the demo data' }));

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(
          call =>
            call[0] === 'reset_demo_story' &&
            (call[1] as Record<string, unknown>)?.storyId === demoStory.id &&
            (call[1] as Record<string, unknown>)?.user === 'You'
        )
      ).toBe(true)
    );

    expect(
      await screen.findByText(/Rebuilt "The Ninth Bell \(Demo\)" with its original sample data/)
    ).toBeInTheDocument();
    expect(
      screen.getAllByText('The Ninth Bell (Demo)').length
    ).toBeGreaterThan(0);
  });
});
