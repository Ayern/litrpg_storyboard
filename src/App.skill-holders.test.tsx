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

interface SkillRow {
  id: string;
  character_id: string;
  name: string;
  rank: string | null;
  effect: string | null;
  chapter_id: string | null;
  node_id: string | null;
  created_at: string;
  updated_at: string;
}

const skillRow = (overrides: Partial<SkillRow> = {}): SkillRow => ({
  id: 'skill-rook',
  character_id: 'char-1',
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
let cardLabel = card.label;
let cardDescription: string | null = card.content;
let skills: SkillRow[] = [skillRow()];
// Any further cards the board is holding, so a test can open a second one.
let extraNodes: unknown[] = [];

beforeEach(() => {
  calls = [];
  cardLabel = card.label;
  cardDescription = card.content;
  skills = [skillRow()];
  extraNodes = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push({ command, args });

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return [{ ...card, label: cardLabel, content: cardDescription }, chapter, ...extraNodes];
      case 'get_graph_edges':
        return [];
      case 'get_characters':
        return [{ ...rook }, { ...mira }];
      case 'get_story_skills':
        return skills.map(skill => ({ ...skill }));
      case 'get_character_skills':
        return skills
          .filter(skill => skill.character_id === args.characterId)
          .map(skill => ({ ...skill }));
      case 'add_skill': {
        const saved = skillRow({
          id: `skill-${skills.length + 1}`,
          character_id: args.characterId as string,
          name: args.name as string,
          rank: (args.rank as string | null) ?? null,
          effect: (args.effect as string | null) ?? null,
          chapter_id: (args.chapterId as string | null) ?? null,
          node_id: (args.nodeId as string | null) ?? null,
        });
        skills = [...skills, saved];
        return { ...saved };
      }
      case 'update_graph_node': {
        cardLabel = args.label as string;
        cardDescription = (args.content as string | null) ?? null;
        // The real database keeps the linked skill rows in step; mirror that so
        // a later sheet read sees the same facts as the open board.
        skills = skills.map(skill =>
          skill.node_id === card.id
            ? { ...skill, name: cardLabel, effect: cardDescription }
            : skill
        );
        return { ...card, label: cardLabel, content: cardDescription };
      }
      case 'update_skill': {
        const before = skills.find(skill => skill.id === args.id);
        if (!before) return null;

        // The real database changes the shared definition: every holder follows,
        // and the card takes the same words. Rank and chapter stay per holder.
        const sameDefinition = (row: SkillRow) =>
          before.node_id
            ? row.node_id === before.node_id
            : row.name.toLowerCase() === before.name.toLowerCase();
        const updated = {
          ...before,
          name: args.name as string,
          rank: (args.rank as string | null) ?? null,
          effect: (args.effect as string | null) ?? null,
          chapter_id: (args.chapterId as string | null) ?? null,
          node_id: (args.nodeId as string | null) ?? null,
        };

        skills = skills.map(row =>
          sameDefinition(row)
            ? {
                ...row,
                name: updated.name,
                effect: updated.effect,
                node_id: updated.node_id,
              }
            : row
        );

        if (updated.node_id) {
          cardLabel = updated.name;
          cardDescription = updated.effect;
        }

        return { ...updated };
      }
      case 'get_character_stats':
      case 'get_character_attributes':
      case 'get_character_inventory':
      case 'get_character_currency':
      case 'get_character_levels':
      case 'get_character_progress':
      case 'get_story_character_stats':
      case 'get_story_skill_events':
      case 'get_story_skill_evolutions':
      case 'get_story_levels':
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

    // Rook already has the skill through the card, so only Mira is offered.
    expect(
      within(panel).getByText('Rook', { selector: '.node-drawer-holder-name' })
    ).toBeInTheDocument();
    const chooser = within(panel).getByLabelText('Character');
    expect(within(chooser).queryByRole('option', { name: 'Rook' })).not.toBeInTheDocument();

    await user.selectOptions(chooser, 'char-2');
    await user.type(within(panel).getByLabelText('Rank'), 'Rank 2');
    await user.selectOptions(within(panel).getByLabelText('Learned in'), 'n1');
    await user.click(within(panel).getByRole('button', { name: 'Add holder' }));

    expect(lastCall('add_skill')).toMatchObject({
      characterId: 'char-2',
      name: 'Frost Touch',
      effect: 'A touch that leaves frost on the skin.',
      rank: 'Rank 2',
      chapterId: 'n1',
      nodeId: 'n-skill',
      user: 'You',
    });

    expect(
      await within(panel).findByText('Mira', { selector: '.node-drawer-holder-name' })
    ).toBeInTheDocument();
    expect(within(panel).getByText('Rank 2')).toBeInTheDocument();
    expect(chooser).toHaveValue('');
    expect(within(panel).getByLabelText('Rank')).toHaveValue('');      expect(within(panel).getByLabelText('Learned in')).toHaveValue('');
  });

  it('empties the holder form when another card is opened', async () => {
    // A second skill card on the board, so the drawer has somewhere to switch to.
    extraNodes = [{ ...card, id: 'n-ember', label: 'Ember', content: null }];
    const { user, panel } = await openCard();

    await user.selectOptions(within(panel).getByLabelText('Character'), 'char-2');
    await user.type(within(panel).getByLabelText('Rank'), 'Rank 2');
    await user.selectOptions(within(panel).getByLabelText('Learned in'), 'n1');

    // The rank and the chapter are that holder's own facts, so the next card
    // starts from nothing rather than offering them to a different character.
    await user.click(screen.getByRole('button', { name: 'skill: Ember' }));

    expect(within(panel).getByLabelText('Character')).toHaveValue('');
    expect(within(panel).getByLabelText('Rank')).toHaveValue('');
    expect(within(panel).getByLabelText('Learned in')).toHaveValue('');

    // Coming back to the first card does not bring them back either.
    await user.click(screen.getByRole('button', { name: 'skill: Frost Touch' }));

    expect(within(panel).getByLabelText('Rank')).toHaveValue('');
    expect(within(panel).getByLabelText('Learned in')).toHaveValue('');
  });

  it('adds a holder with no effect when the card has no notes', async () => {
    cardDescription = null;
    const { user, panel } = await openCard();

    await user.selectOptions(within(panel).getByLabelText('Character'), 'char-2');
    await user.click(within(panel).getByRole('button', { name: 'Add holder' }));

    expect(lastCall('add_skill')).toMatchObject({
      characterId: 'char-2',
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
    await user.selectOptions(within(panel).getByLabelText('Character'), 'char-2');

    expect(within(panel).getByRole('button', { name: 'Add holder' })).toBeDisabled();
    expect(
      within(panel).getByText(/Save the card's label and notes before adding a holder\./)
    ).toBeInTheDocument();
  });

  it('puts holder names back when the card edit is undone', async () => {
    const { user, panel } = await openCard();

    await user.clear(within(panel).getByLabelText('Label'));
    await user.type(within(panel).getByLabelText('Label'), 'Chill Touch');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByRole('button', { name: 'skill: Chill Touch' })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(
      await screen.findByRole('button', { name: 'skill: Frost Touch' })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(await screen.findByTitle("Show Rook's sheet"));
    expect(
      await screen.findByText('Frost Touch', { selector: '.skill-name' })
    ).toBeInTheDocument();
  });

  it('keeps the card and every holder in step when a sheet edits the shared skill', async () => {
    skills = [
      skillRow(),
      skillRow({ id: 'skill-mira', character_id: 'char-2', rank: 'Rank 4' }),
    ];

    const user = userEvent.setup();
    render(<App />);

    await screen.findAllByText('Ledger');
    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(await screen.findByTitle("Show Rook's sheet"));

    const row = screen
      .getByText('Frost Touch', { selector: '.skill-name' })
      .closest('.skill-row') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));

    const name = screen.getByLabelText('Skill name');
    await user.clear(name);
    await user.type(name, 'Chill Touch');
    const effect = screen.getByLabelText('Skill effect');
    await user.clear(effect);
    await user.type(effect, 'A deeper cold.');
    await user.click(screen.getByTitle('Save this Frost Touch'));

    expect(lastCall('update_skill')).toMatchObject({
      id: 'skill-rook',
      name: 'Chill Touch',
      effect: 'A deeper cold.',
      nodeId: 'n-skill',
      user: 'You',
    });

    // The card on the board follows the sheet edit without reopening the story.
    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await user.click(await screen.findByRole('button', { name: 'skill: Chill Touch' }));

    const panel = screen.getByRole('complementary', { name: 'Node inspector' });
    const rookHolder = within(panel)
      .getByText('Rook', { selector: '.node-drawer-holder-name' })
      .closest('li') as HTMLElement;
    const miraHolder = within(panel)
      .getByText('Mira', { selector: '.node-drawer-holder-name' })
      .closest('li') as HTMLElement;

    expect(rookHolder).toHaveAttribute('title', expect.stringContaining('A deeper cold.'));
    expect(miraHolder).toHaveAttribute('title', expect.stringContaining('A deeper cold.'));
    expect(miraHolder).toHaveTextContent('Rank 4');
  });

  it('keeps existing holders in step when the card is saved', async () => {
    const { user, panel } = await openCard();

    await user.clear(within(panel).getByLabelText('Label'));
    await user.type(within(panel).getByLabelText('Label'), 'Chill Touch');
    await user.clear(within(panel).getByLabelText('Notes'));
    await user.type(within(panel).getByLabelText('Notes'), 'A deeper cold.');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));

    expect(lastCall('update_graph_node')).toMatchObject({
      id: 'n-skill',
      label: 'Chill Touch',
      content: 'A deeper cold.',
      user: 'You',
    });

    // The open board and the holder line follow the save without reopening.
    const holder = within(panel)
      .getByText('Rook', { selector: '.node-drawer-holder-name' })
      .closest('li');
    expect(holder).toHaveAttribute('title', expect.stringContaining('A deeper cold.'));
    expect(
      await screen.findByRole('button', { name: 'skill: Chill Touch' })
    ).toBeInTheDocument();

    // And the holder's sheet shows the new name and effect.
    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(await screen.findByTitle("Show Rook's sheet"));
    expect(await screen.findByRole('heading', { name: 'Skills' })).toBeInTheDocument();
    expect(screen.getByText('Chill Touch', { selector: '.skill-name' })).toBeInTheDocument();
    expect(screen.getByText('A deeper cold.', { selector: '.skill-effect' })).toBeInTheDocument();
  });
});
