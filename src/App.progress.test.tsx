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

// The canvas, reduced to the parts the app needs to mount a graph.
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

interface CastRow {
  id: string;
  story_id: string;
  name: string;
  description: string | null;
  level: number;
  xp: number;
  rank: string | null;
  xp_to_next: number | null;
  created_at: string;
  updated_at: string;
}

const row = (
  id: string,
  name: string,
  level: number,
  xp: number,
  rank: string | null,
  target: number | null
): CastRow => ({
  id,
  story_id: story.id,
  name,
  description: null,
  level,
  xp,
  rank,
  xp_to_next: target,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
});

let cast: CastRow[] = [];

beforeEach(() => {
  cast = [row('char-1', 'Rook', 3, 250, 'Bronze', 1000), row('char-2', 'Wren', 1, 0, null, null)];

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return [
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
      case 'get_graph_edges':
        return [];
      case 'get_characters':
        return args.storyId === story.id ? cast.map(entry => ({ ...entry })) : [];
      case 'get_story_character_stats':
      case 'get_character_stats':
      case 'get_character_attributes':
        return [];
      case 'set_character_progress': {
        const character = cast.find(entry => entry.id === args.characterId);
        if (!character) return null;

        character.level = args.level;
        character.xp = args.xp;
        character.rank = args.rank ?? null;
        character.xp_to_next = args.xpToNext ?? null;
        return { ...character };
      }
      case 'level_up_character': {
        const character = cast.find(entry => entry.id === args.characterId);
        if (!character) return null;

        character.level += 1;
        return { ...character };
      }
      default:
        return null;
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

async function openSheet(name = 'Rook') {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await screen.findByRole('button', { name: 'Opening' });
  await user.click(screen.getByRole('button', { name: 'Characters' }));
  await user.click(screen.getByTitle(`Show ${name}'s sheet`));

  return user;
}

function sheet() {
  return screen.getByRole('region', { name: 'Progression' });
}

function bar() {
  return within(sheet()).getByRole('progressbar');
}

describe('progression', () => {
  it('shows the level, rank, experience and bar the character was saved with', async () => {
    await openSheet();

    expect(within(sheet()).getByText('3')).toBeInTheDocument();
    expect(within(sheet()).getByText('250 / 1000')).toBeInTheDocument();
    expect(within(sheet()).getByText('Bronze')).toBeInTheDocument();
    expect(within(sheet()).getByText('750 XP to level 4')).toBeInTheDocument();
    expect(bar()).toHaveAttribute('aria-valuenow', '25');

    // The list says where the cast stands without opening each sheet.
    expect(screen.getByText('Level 3 · Bronze')).toBeInTheDocument();
  });

  it('leaves the level on the cast rail as well', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findAllByText('Ledger');
    const rail = await screen.findByRole('complementary', { name: 'Cast' });

    expect(within(rail).getByText('Lv 3')).toBeInTheDocument();
    expect(within(rail).getByText('Lv 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(screen.getByTitle("Show Rook's sheet"));
    await user.click(within(sheet()).getByRole('button', { name: 'Level up' }));
    await user.click(screen.getByRole('button', { name: 'Graph' }));

    expect(
      await within(screen.getByRole('complementary', { name: 'Cast' })).findByText('Lv 4')
    ).toBeInTheDocument();
  });

  it('saves the four fields and moves the bar', async () => {
    const user = await openSheet();

    await user.click(within(sheet()).getByRole('button', { name: 'Edit progression' }));

    const level = within(sheet()).getByLabelText('Level');
    await user.clear(level);
    await user.type(level, '4');

    const xp = within(sheet()).getByLabelText('Experience');
    await user.clear(xp);
    await user.type(xp, '1000');

    const target = within(sheet()).getByLabelText('XP to next');
    await user.clear(target);
    await user.type(target, '1200');

    const rank = within(sheet()).getByLabelText('Rank');
    await user.clear(rank);
    await user.type(rank, 'Silver');

    await user.click(within(sheet()).getByRole('button', { name: 'Save' }));

    expect(lastCall('set_character_progress')).toEqual({
      characterId: 'char-1',
      level: 4,
      xp: 1000,
      rank: 'Silver',
      xpToNext: 1200,
      user: 'You',
    });

    expect(await within(sheet()).findByText('1000 / 1200')).toBeInTheDocument();
    expect(bar()).toHaveAttribute('aria-valuenow', '83');
    expect(screen.getByText('Level 4 · Silver')).toBeInTheDocument();
    expect(within(sheet()).queryByLabelText('Rank')).not.toBeInTheDocument();
  });

  it('leaves the target and the rank empty when they are cleared', async () => {
    const user = await openSheet();

    await user.click(within(sheet()).getByRole('button', { name: 'Edit progression' }));
    await user.clear(within(sheet()).getByLabelText('XP to next'));
    await user.clear(within(sheet()).getByLabelText('Rank'));
    await user.click(within(sheet()).getByRole('button', { name: 'Save' }));

    expect(lastCall('set_character_progress')).toEqual({
      characterId: 'char-1',
      level: 3,
      xp: 250,
      rank: null,
      xpToNext: null,
      user: 'You',
    });

    expect(
      await within(sheet()).findByText('No target set — edit progression to show a bar.')
    ).toBeInTheDocument();
    expect(within(sheet()).getByText('Unranked')).toBeInTheDocument();
    expect(bar()).toHaveAttribute('aria-valuenow', '0');
  });

  it('refuses a level below one without calling the database', async () => {
    const user = await openSheet();

    await user.click(within(sheet()).getByRole('button', { name: 'Edit progression' }));
    const level = within(sheet()).getByLabelText('Level');
    await user.clear(level);
    await user.type(level, '0');
    await user.click(within(sheet()).getByRole('button', { name: 'Save' }));

    expect(screen.getByText('A level is a whole number, 1 or more.')).toBeInTheDocument();
    expect(lastCall('set_character_progress')).toBeUndefined();
    expect(within(sheet()).getByLabelText('Level')).toHaveValue(0);
  });

  it('levels up as its own recorded action and keeps the experience', async () => {
    const user = await openSheet();

    await user.click(within(sheet()).getByRole('button', { name: 'Level up' }));

    expect(lastCall('level_up_character')).toEqual({
      characterId: 'char-1',
      user: 'You',
    });
    await waitFor(() => expect(within(sheet()).getByText('4')).toBeInTheDocument());
    expect(within(sheet()).getByText('250 / 1000')).toBeInTheDocument();
    expect(within(sheet()).getByText('750 XP to level 5')).toBeInTheDocument();
    expect(screen.getByText('Level 4 · Bronze')).toBeInTheDocument();
  });

  it('keeps the form open and says why when the save fails', async () => {
    const user = await openSheet();

    await user.click(within(sheet()).getByRole('button', { name: 'Edit progression' }));
    invokeMock.mockImplementationOnce(async () => {
      throw 'database is busy';
    });
    await user.click(within(sheet()).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Could not save progression: database is busy/i)).toBeInTheDocument();
    expect(within(sheet()).getByLabelText('Level')).toBeInTheDocument();
  });

  it('does not carry a half-typed form over to another character', async () => {
    const user = await openSheet();

    await user.click(within(sheet()).getByRole('button', { name: 'Edit progression' }));
    const level = within(sheet()).getByLabelText('Level');
    await user.clear(level);
    await user.type(level, '9');

    await user.click(screen.getByTitle("Show Wren's sheet"));

    expect(within(sheet()).getByRole('button', { name: 'Edit progression' })).toBeInTheDocument();
    expect(within(sheet()).queryByLabelText('Level')).not.toBeInTheDocument();
    expect(within(sheet()).getByText('Unranked')).toBeInTheDocument();

    await user.click(within(sheet()).getByRole('button', { name: 'Edit progression' }));
    expect(within(sheet()).getByLabelText('Level')).toHaveValue(1);
    expect(within(sheet()).getByLabelText('Experience')).toHaveValue(0);
    expect(within(sheet()).getByLabelText('Rank')).toHaveValue('');
    expect(lastCall('set_character_progress')).toBeUndefined();
  });
});
