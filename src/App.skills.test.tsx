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

const character = {
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

const nodeRow = (id: string, type: string, label: string) => ({
  id,
  story_id: story.id,
  node_type: type,
  label,
  content: null,
  pos_x: 0,
  pos_y: 0,
  created_by: 'Ada',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  character_id: null,
  chapter_seq: type === 'chapter' ? Number(id.slice(1)) : null,
});

let skills: SkillRow[] = [];

beforeEach(() => {
  skills = [
    {
      id: 'skill-1',
      character_id: 'char-1',
      name: 'Fireball',
      rank: 'Rank 2',
      effect: '3d6 fire',
      chapter_id: 'n1',
      node_id: 'n5',
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return [
          nodeRow('n1', 'chapter', 'Chapter One'),
          nodeRow('n2', 'chapter', 'Chapter Two'),
          nodeRow('n5', 'skill', 'Fireball'),
          nodeRow('n6', 'skill', 'Shield Wall'),
        ];
      case 'get_graph_edges':
      case 'get_story_character_stats':
      case 'get_character_stats':
      case 'get_character_attributes':
        return [];
      case 'get_characters':
        return args.storyId === story.id ? [character] : [];
      case 'get_story_skills':
        return skills.map(skill => ({ ...skill }));
      case 'get_character_skills':
        return skills
          .filter(skill => skill.character_id === args.characterId)
          .map(skill => ({ ...skill }));
      case 'add_skill': {
        const saved: SkillRow = {
          id: `skill-${skills.length + 1}`,
          character_id: args.characterId,
          name: args.name,
          rank: args.rank ?? null,
          effect: args.effect ?? null,
          chapter_id: args.chapterId ?? null,
          node_id: args.nodeId ?? null,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        skills = [...skills, saved];
        return { ...saved };
      }
      case 'update_skill': {
        const existing = skills.find(skill => skill.id === args.id);
        if (!existing) return null;

        const updated: SkillRow = {
          ...existing,
          name: args.name,
          rank: args.rank ?? null,
          effect: args.effect ?? null,
          chapter_id: args.chapterId ?? null,
          node_id: args.nodeId ?? null,
        };
        skills = skills.map(skill => (skill.id === updated.id ? updated : skill));
        return { ...updated };
      }
      case 'create_graph_node':
        return {
          ...nodeRow('n7', args.nodeType, args.label),
          content: args.content ?? null,
          pos_x: args.posX ?? 0,
          pos_y: args.posY ?? 0,
        };
      case 'delete_skill':
        skills = skills.filter(skill => skill.id !== args.id);
        return null;
      default:
        return null;
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

async function openSheet() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await screen.findByRole('button', { name: 'Chapter One' });
  await user.click(screen.getByRole('button', { name: 'Characters' }));
  await user.click(screen.getByTitle("Show Rook's sheet"));

  return user;
}

function skillRow(name: string) {
  const label = screen.getByText(name, { selector: '.skill-name' });
  const row = label.closest('.skill-row');
  if (!row) throw new Error(`no skill row for ${name}`);
  return within(row as HTMLElement);
}

describe('skills on the character sheet', () => {
  it('lists a skill with its rank, effect and the chapter it was learned in', async () => {
    await openSheet();

    expect(screen.getByRole('heading', { name: 'Skills' })).toBeInTheDocument();
    expect(skillRow('Fireball').getByText('Rank 2')).toBeInTheDocument();
    expect(skillRow('Fireball').getByText('3d6 fire')).toBeInTheDocument();
    expect(skillRow('Fireball').getByText('Learned in Chapter One')).toBeInTheDocument();
    expect(skillRow('Fireball').getByText('Card: Fireball')).toBeInTheDocument();
  });

  it('adds a skill with the chapter it was learned in', async () => {
    const user = await openSheet();

    await user.type(screen.getByLabelText('New skill name'), 'Shield Wall');
    await user.type(screen.getByLabelText('New skill rank'), 'Rank 1');
    await user.type(screen.getByLabelText('New skill effect'), '+2 armour');
    await user.selectOptions(screen.getByLabelText('New skill chapter'), 'n2');
    await user.click(screen.getByRole('button', { name: 'Add skill' }));

    expect(lastCall('add_skill')).toMatchObject({
      characterId: 'char-1',
      name: 'Shield Wall',
      rank: 'Rank 1',
      effect: '+2 armour',
      chapterId: 'n2',
      nodeId: null,
    });

    expect(skillRow('Shield Wall').getByText('Learned in Chapter Two')).toBeInTheDocument();
  });

  it('edits a skill in place, chapter and all', async () => {
    const user = await openSheet();

    await user.click(skillRow('Fireball').getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Skill name'));
    await user.type(screen.getByLabelText('Skill name'), 'Greater Fireball');
    await user.clear(screen.getByLabelText('Skill rank'));
    await user.type(screen.getByLabelText('Skill rank'), 'Rank 3');
    await user.selectOptions(screen.getByLabelText('Chapter acquired'), 'n2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(lastCall('update_skill')).toMatchObject({
      id: 'skill-1',
      name: 'Greater Fireball',
      rank: 'Rank 3',
      effect: '3d6 fire',
      chapterId: 'n2',
      nodeId: 'n5',
    });

    expect(skillRow('Greater Fireball').getByText('Rank 3')).toBeInTheDocument();
    expect(
      skillRow('Greater Fireball').getByText('Learned in Chapter Two')
    ).toBeInTheDocument();
  });

  it('opens the card a skill names on the board, from the row', async () => {
    const user = await openSheet();

    await user.click(skillRow('Fireball').getByRole('button', { name: 'Card: Fireball' }));

    // The board comes up with that card open in the inspector, so the link from
    // the sheet to the card works the other way too.
    const drawer = await screen.findByRole('complementary', { name: 'Node inspector' });
    expect(within(drawer).getByLabelText('Label')).toHaveValue('Fireball');
    expect(within(drawer).getByText('skill')).toHaveClass('legend', 'skill');
  });

  it('opens the chapter a skill was learned in on the board, from the row', async () => {
    const user = await openSheet();

    await user.click(
      skillRow('Fireball').getByRole('button', { name: 'Learned in Chapter One' })
    );

    const drawer = await screen.findByRole('complementary', { name: 'Node inspector' });
    expect(within(drawer).getByLabelText('Label')).toHaveValue('Chapter One');
    expect(within(drawer).getByText('chapter')).toHaveClass('legend', 'chapter');
  });

  it('makes a skill card from the form that adds the skill', async () => {
    const user = await openSheet();

    // A story with no cards yet: the form is where the card is made, and the
    // card carries the name and effect being typed.
    await user.type(screen.getByLabelText('New skill name'), 'Glass Ward');
    await user.type(screen.getByLabelText('New skill effect'), '+2 ward');
    await user.click(screen.getByRole('button', { name: 'New card' }));

    expect(lastCall('create_graph_node')).toMatchObject({
      storyId: story.id,
      nodeType: 'skill',
      label: 'Glass Ward',
      content: '+2 ward',
    });

    // The new card is the skill's card, so saving links the sheet to it.
    await waitFor(() =>
      expect(screen.getByLabelText('New skill card')).toHaveValue('n7')
    );
    expect(
      within(screen.getByLabelText('New skill card')).getByRole('option', {
        name: 'Glass Ward',
      })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add skill' }));

    expect(lastCall('add_skill')).toMatchObject({
      characterId: 'char-1',
      name: 'Glass Ward',
      effect: '+2 ward',
      nodeId: 'n7',
    });
    expect(
      skillRow('Glass Ward').getByText('Card: Glass Ward')
    ).toBeInTheDocument();
  });

  it('makes a card for a skill that is already on the sheet', async () => {
    const user = await openSheet();

    await user.click(skillRow('Fireball').getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Skill name'));
    await user.type(screen.getByLabelText('Skill name'), 'Greater Fireball');
    await user.selectOptions(screen.getByLabelText('Skill card'), '');
    // The creator form has its own New card button; this one belongs to the row.
    const editor = document.querySelector('.skill-editor') as HTMLElement;
    await user.click(within(editor).getByRole('button', { name: 'New card' }));

    expect(lastCall('create_graph_node')).toMatchObject({
      nodeType: 'skill',
      label: 'Greater Fireball',
    });

    await waitFor(() =>
      expect(screen.getByLabelText('Skill card')).toHaveValue('n7')
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(lastCall('update_skill')).toMatchObject({
      id: 'skill-1',
      name: 'Greater Fireball',
      nodeId: 'n7',
    });
  });

  it('deletes a skill without touching the character', async () => {
    const user = await openSheet();

    await user.click(skillRow('Fireball').getByRole('button', { name: 'Delete' }));

    expect(lastCall('delete_skill')).toEqual({ id: 'skill-1', user: 'You' });
    expect(screen.queryByText('Fireball', { selector: '.skill-name' })).not.toBeInTheDocument();
    expect(screen.getByText('No skills yet — add one below.')).toBeInTheDocument();
  });
});

describe('skills on the board', () => {
  it('names who has a skill, with their rank and chapter', async () => {
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Fireball', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    expect(card).not.toBeNull();
    const withinCard = within(card as HTMLElement);
    expect(withinCard.getByText('Rook')).toBeInTheDocument();
    expect(withinCard.getByText('Rank 2')).toBeInTheDocument();
    expect(withinCard.getByText('Chapter One')).toBeInTheDocument();
  });

  it('says so when nobody has the skill yet', async () => {
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Shield Wall', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    expect(card).not.toBeNull();
    expect(
      within(card as HTMLElement).getByText('No one has this skill yet')
    ).toBeInTheDocument();
  });
});
