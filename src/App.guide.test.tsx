import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App, { placeTooltip } from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// React Flow needs real DOM measurements, so the canvas is replaced with
// something that draws every node through the map the app registers.
vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  const Canvas = (props: any) => {
    const { nodes = [], nodeTypes = {}, children } = props;
    const Card = nodeTypes.default;

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

const rook = {
  id: 'char-1',
  story_id: story.id,
  name: 'Rook',
  description: null,
  level: 3,
  xp: 250,
  rank: 'Bronze',
  xp_to_next: 1000,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

const chapter = {
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
  chapter_seq: 1,
};

// The commands that answer with a list get an empty one; the rest answer null.
const emptyLists = [
  'get_graph_edges',
  'get_story_character_stats',
  'get_story_skills',
  'get_story_skill_events',
  'get_story_level_milestones',
  'get_story_character_progress',
  'get_story_inventory',
  'get_chapter_notes',
  'get_story_chapter_cast',
  'get_story_relations',
  'get_story_faction_standings',
  'get_story_quests',
  'get_story_skill_evolutions',
  'get_character_stats',
  'get_character_attributes',
  'get_character_skills',
  'get_character_inventory',
  'get_character_currency',
  'get_character_level_milestones',
  'get_character_progress',
];

beforeEach(() => {
  localStorage.clear();

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (emptyLists.includes(command)) return [];

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return [chapter];
      case 'get_characters':
        return [rook];
      default:
        return null;
    }
  });
});

async function openApp() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await screen.findByText('Opening', { selector: '.graph-node-label' });

  return user;
}

describe('help tooltips', () => {
  it('explains connections on hover and takes the bubble away again', async () => {
    const user = await openApp();

    const badge = screen.getByRole('button', { name: 'About drawing connections' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.hover(badge);

    const bubble = screen.getByRole('tooltip');
    expect(bubble).toHaveTextContent(/Let go over empty canvas/);
    // The bubble is announced as the description of the button it explains.
    expect(badge).toHaveAttribute('aria-describedby', bubble.id);

    await user.unhover(badge);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(badge).not.toHaveAttribute('aria-describedby');
  });

  it('opens on keyboard focus and closes on Escape without losing focus', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Characters' }));

    const badge = await screen.findByRole('button', {
      name: 'About skill cards and the sheets that hold them',
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => badge.focus());

    expect(screen.getByRole('tooltip')).toHaveTextContent(/every sheet that holds it/);
    expect(document.activeElement).toBe(badge);

    fireEvent.keyDown(badge, { key: 'Escape' });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(badge);
  });

  it('opens from a click, so a touch screen can read it too', async () => {
    const user = await openApp();

    const badge = screen.getByRole('button', { name: 'About drawing connections' });

    await user.click(badge);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/filled in from the card/);

    // Leaving the button puts the bubble away.
    act(() => badge.blur());
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('explains the sheet skills once the sheet is open', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(await screen.findByTitle("Show Rook's sheet"));

    const badge = await screen.findByRole('button', {
      name: 'About skill cards and the sheets that hold them',
    });

    await user.hover(badge);

    expect(screen.getByRole('tooltip')).toHaveTextContent(
      /editing the card reaches all of them at once/
    );
  });

  it('keeps a bubble inside the window', () => {
    const viewport = { width: 1024, height: 768 };

    // A badge at the right edge pulls the bubble back to the margin.
    expect(
      placeTooltip({ top: 40, bottom: 56, left: 1000, width: 16 }, { width: 280, height: 80 }, viewport)
    ).toEqual({ top: 62, left: 736, placement: 'bottom' });

    // No room underneath: the bubble flips above the badge.
    expect(
      placeTooltip({ top: 700, bottom: 716, left: 200, width: 16 }, { width: 280, height: 120 }, viewport)
    ).toEqual({ top: 574, left: 68, placement: 'top' });

    // A bubble taller than the window is pinned to the top margin instead of
    // disappearing below the bottom one.
    expect(
      placeTooltip({ top: 4, bottom: 20, left: 200, width: 16 }, { width: 280, height: 900 }, viewport)
    ).toEqual({ top: 8, left: 68, placement: 'bottom' });

    // A window narrower than the bubble still gets a bubble that fits.
    expect(
      placeTooltip(
        { top: 20, bottom: 36, left: 100, width: 16 },
        { width: 280, height: 80 },
        { width: 200, height: 400 }
      )
    ).toEqual({ top: 42, left: 8, placement: 'bottom' });
  });
});

describe('the guide', () => {
  it('opens from the header with the illustrated guide in it', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Guide' }));

    const dialog = screen.getByRole('dialog', { name: 'Guide' });

    // The document itself, not a summary of it: GUIDE.md is what the app reads.
    expect(
      within(dialog).getByRole('heading', { name: /How It Works/ })
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: '1. The mental model' })).toBeInTheDocument();

    // And its pictures, which are the ones the screenshot run shoots.
    expect(within(dialog).getAllByRole('img').length).toBeGreaterThan(0);

    // The three rules the welcome card promises are here in full.
    for (const rule of [
      /The canvas is a database/,
      /A skill card has one identity/,
      /History goes back whole actions/,
    ]) {
      expect(within(dialog).getByText(rule)).toBeInTheDocument();
    }
  });

  it('closes on Escape and on the backdrop, but not on its own text', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Guide' }));
    const dialog = screen.getByRole('dialog', { name: 'Guide' });

    await user.click(dialog);
    expect(screen.getByRole('dialog', { name: 'Guide' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Guide' })).not.toBeInTheDocument()
    );

    await user.click(screen.getByRole('button', { name: 'Guide' }));
    await user.click(screen.getByRole('dialog', { name: 'Guide' }).parentElement as HTMLElement);

    expect(screen.queryByRole('dialog', { name: 'Guide' })).not.toBeInTheDocument();
  });

  it('hands over to the keyboard reference', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Guide' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Guide' })).getByRole('button', {
        name: 'Keyboard shortcuts',
      })
    );

    expect(screen.queryByRole('dialog', { name: 'Guide' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});

describe('the first-run welcome card', () => {
  it('opens a story with the card and puts it away for good', async () => {
    const user = await openApp();

    const card = await screen.findByRole('region', { name: 'Start here' });
    // One line per rule the guide explains.
    expect(within(card).getByText(/A line you draw is a record/)).toBeInTheDocument();
    expect(within(card).getByText(/every character who holds that skill/)).toBeInTheDocument();
    expect(within(card).getByText(/on the sheet or the canvas/)).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Got it' }));

    expect(screen.queryByRole('region', { name: 'Start here' })).not.toBeInTheDocument();
    expect(localStorage.getItem('litrpg.guide.dismissed')).toBe('1');
  });

  it('stays away on the next launch', async () => {
    localStorage.setItem('litrpg.guide.dismissed', '1');

    await openApp();

    expect(screen.queryByRole('region', { name: 'Start here' })).not.toBeInTheDocument();
  });

  it('does not come back after the app is mounted again', async () => {
    const user = userEvent.setup();
    const first = render(<App />);

    const card = await screen.findByRole('region', { name: 'Start here' });
    await user.click(
      within(card).getByRole('button', { name: 'Dismiss the welcome card' })
    );
    first.unmount();

    render(<App />);

    // Wait for the board to load before saying the card is gone, or the check
    // would pass on a screen that has not finished starting up.
    await screen.findByText('Opening', { selector: '.graph-node-label' });
    expect(screen.queryByRole('region', { name: 'Start here' })).not.toBeInTheDocument();
  });

  it('points at the guide without covering the app', async () => {
    const user = await openApp();

    await user.click(await screen.findByRole('button', { name: 'Open the guide' }));

    expect(screen.getByRole('dialog', { name: 'Guide' })).toBeInTheDocument();
    // Opening the guide does not dismiss the card; it is still there to read.
    expect(screen.getByRole('region', { name: 'Start here' })).toBeInTheDocument();
  });
});
