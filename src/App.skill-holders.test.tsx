import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// React Flow needs real DOM measurements, so the canvas is replaced with the
// node list it was given. Clicking one runs the same handler as a real card.
vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  const Canvas = ({ nodes = [], onNodeClick, children }: any) =>
    React.createElement(
      'div',
      null,
      nodes.map((node: any) =>
        React.createElement(
          'button',
          { key: node.id, onClick: (event: unknown) => onNodeClick?.(event, node) },
          `${node.data.nodeType}: ${node.data.label}`
        )
      ),
      children as React.ReactNode
    );

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

const mira = {
  ...rook,
  id: 'char-2',
  name: 'Mira',
};

const card = {
  id: 'n-skill',
  story_id: story.id,
  node_type: 'skill',
  label: 'Frost Touch',
  content: 'A touch that leaves frost on the skin.',
  pos_x: 0,
  pos_y: 0,
  created_by: 'Ada',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  character_id: null,
  chapter_seq: null,
};

const chapter = {
  id: 'n1',
  story_id: story.id,
  node_type: 'chapter',
  label: 'The Ashen Gate',
  content: null,
  pos_x: 0,
  pos_y: 0,
  created_by: 'Ada',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  character_id: null,
  chapter_seq: 1,
};

const skillRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'skill-mira',
  character_id: 'char-2',
  name: 'Frost Touch',
  rank: 'Rank 1',
  effect: 'A touch that leaves frost on the skin.',
  chapter_id: 'n1',
  node_id: 'n-skill',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  ...overrides,
});

interface Call {
  command: string;
  args: Record<string, unknown>;
}

let calls: Call[] = [];
let cardDescription: string | null = card.content;

beforeEach(() => {
  calls = [];
  cardDescription = card.content;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push({ command, args });

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return [{ ...card, content: cardDescription }, chapter];
      case 'get_graph_edges':
        return [];
      case 'get_characters':
        return [{ ...rook }, { ...mira }];
      case 'get_story_skills':
        return [skillRow()];
      case 'add_skill':
        return skillRow({
          id: 'skill-rook',
          character_id: args.characterId,
          name: args.name,
          rank: args.rank ?? null,
          effect: args.effect ?? null,
          chapter_id: args.chapterId ?? null,
          node_id: args.nodeId ?? null,
        });
      case 'get_character_stats':
      case 'get_character_attributes':
      case 'get_character_skills':
      case 'get_character_inventory':
      case 'get_character_currency':
      case 'get_character_level_milestones':
      case 'get_character_progress':
      case 'get_story_character_stats':
      case 'get_story_skill_events':
      case 'get_story_skill_evolutions':
      case 'get_story_level_milestones':
      case 'get_story_relations':
      case 'get_story_faction_standings':
      case 'get_story_chapter_cast':
      case 'get_story_chapter_cast_states':
      case 'get_story_character_progress':
      case 'get_story_inventory':
      case 'get_story_quests':
      case 'get_chapter_notes':
        return [];
      default:
        return null;
    }
  });
});

function lastCall(command: string) {
  return [...calls].reverse().find(call => call.command === command)?.args;
}

async function openCard() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(await screen.findByRole('button', { name: 'skill: Frost Touch' }));

  return {
    user,
    panel: screen.getByRole('complementary', { name: 'Node inspector' }),
  };
}

describe('adding a skill holder from its card', () => {
  it('copies the card name and notes and keeps the holder rank and chapter', async () => {
    const { user, panel } = await openCard();

    // Mira already has the skill through the card, so only Rook is offered.
    expect(
      within(panel).getByText('Mira', { selector: '.node-drawer-holder-name' })
    ).toBeInTheDocument();
    const chooser = within(panel).getByLabelText('Character');
    expect(within(chooser).queryByRole('option', { name: 'Mira' })).not.toBeInTheDocument();

    await user.selectOptions(chooser, 'char-1');
    await user.type(within(panel).getByLabelText('Rank'), 'Rank 2');
    await user.selectOptions(within(panel).getByLabelText('Learned in'), 'n1');
    await user.click(within(panel).getByRole('button', { name: 'Add holder' }));

    expect(lastCall('add_skill')).toMatchObject({
      characterId: 'char-1',
      name: 'Frost Touch',
      effect: 'A touch that leaves frost on the skin.',
      rank: 'Rank 2',
      chapterId: 'n1',
      nodeId: 'n-skill',
      user: 'You',
    });

    expect(
      await within(panel).findByText('Rook', { selector: '.node-drawer-holder-name' })
    ).toBeInTheDocument();
    expect(within(panel).getByText('Rank 2')).toBeInTheDocument();
    expect(chooser).toHaveValue('');
    expect(within(panel).getByLabelText('Rank')).toHaveValue('');
    expect(within(panel).getByLabelText('Learned in')).toHaveValue('');
  });

  it('adds a holder with no effect when the card has no notes', async () => {
    cardDescription = null;
    const { user, panel } = await openCard();

    await user.selectOptions(within(panel).getByLabelText('Character'), 'char-1');
    await user.click(within(panel).getByRole('button', { name: 'Add holder' }));

    expect(lastCall('add_skill')).toMatchObject({
      characterId: 'char-1',
      name: 'Frost Touch',
      effect: null,
      rank: null,
      chapterId: null,
      nodeId: 'n-skill',
      user: 'You',
    });
  });

  it('stops adding holders until the card name and notes are saved', async () => {
    const { user, panel } = await openCard();

    await user.type(within(panel).getByLabelText('Notes'), ' Still writing.');
    await user.selectOptions(within(panel).getByLabelText('Character'), 'char-1');

    expect(within(panel).getByRole('button', { name: 'Add holder' })).toBeDisabled();
    expect(
      within(panel).getByText(/Save the card's label and notes before adding a holder\./)
    ).toBeInTheDocument();
  });
});
