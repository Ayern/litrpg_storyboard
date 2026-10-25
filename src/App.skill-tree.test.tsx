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

// React Flow reduced to the parts the tree test reads: every node through its
// custom component, and every edge as a button carrying its label and colour.
vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  const Canvas = (props: any) => {
    const {
      nodes = [],
      edges = [],
      nodeTypes = {},
      children,
      onInit,
      onNodeClick,
      onEdgeClick,
    } = props;
    const Card = nodeTypes.default;

    React.useEffect(() => {
      onInit?.(flowMock);
    }, [onInit]);

    return React.createElement(
      'div',
      { 'data-testid': 'skill-tree-canvas' },
      nodes.map((node: any) =>
        React.createElement(
          'div',
          { key: node.id, className: 'react-flow__node', 'data-id': node.id },
          Card
            ? React.createElement(Card, {
                id: node.id,
                data: node.data,
                isConnectable: false,
                selected: false,
                xPos: 0,
                yPos: 0,
                zIndex: 0,
                dragging: false,
              })
            : null,
          React.createElement(
            'button',
            {
              key: 'open',
              'data-testid': `node-${node.id}`,
              onClick: (event: unknown) => onNodeClick?.(event, node),
            },
            node.data.label
          )
        )
      ),
      edges.map((edge: any) =>
        React.createElement(
          'button',
          {
            key: edge.id,
            'data-testid': `edge-${edge.id}`,
            'data-stroke': edge.style?.stroke,
            onClick: (event: unknown) => onEdgeClick?.(event, edge),
          },
          edge.label
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

const cast = [
  {
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
  },
  {
    id: 'char-2',
    story_id: story.id,
    name: 'Mira',
    description: null,
    level: 2,
    xp: 100,
    rank: 'Bronze',
    xp_to_next: 1000,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
];

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

interface EvolutionRow {
  id: string;
  story_id: string;
  parent_skill_id: string;
  child_skill_id: string;
  evolution_type: string;
  chapter_id: string | null;
  required_rank: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  skill_id: string;
  kind: string;
  chapter_id: string | null;
  rank: string | null;
  milestone_id?: string | null;
  created_at: string;
  updated_at: string;
}

const skill = (
  id: string,
  characterId: string,
  name: string,
  chapterId: string | null,
  rank: string | null = null
): SkillRow => ({
  id,
  character_id: characterId,
  name,
  rank,
  effect: null,
  chapter_id: chapterId,
  node_id: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
});

const evolution = (
  id: string,
  parent: string,
  child: string,
  type: string,
  overrides: Partial<EvolutionRow> = {}
): EvolutionRow => ({
  id,
  story_id: story.id,
  parent_skill_id: parent,
  child_skill_id: child,
  evolution_type: type,
  chapter_id: null,
  required_rank: null,
  notes: null,
  created_by: 'Ada',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  ...overrides,
});

let skills: SkillRow[] = [];
let evolutions: EvolutionRow[] = [];
let skillEvents: EventRow[] = [];

beforeEach(() => {
  skills = [];
  evolutions = [];
  skillEvents = [];

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
          nodeRow('n3', 'chapter', 'Chapter Three'),
        ];
      case 'get_characters':
        return cast.map(character => ({ ...character }));
      case 'get_story_skills':
        return skills.map(row => ({ ...row }));
      case 'get_character_skills':
        return skills
          .filter(row => row.character_id === args.characterId)
          .map(row => ({ ...row }));
      case 'get_story_skill_events':
        return skillEvents.map(row => ({ ...row }));
      case 'get_story_skill_evolutions':
        return evolutions.map(row => ({ ...row }));
      case 'get_story_character_stats':
      case 'get_graph_edges':
      case 'get_character_stats':
      case 'get_character_attributes':
      case 'get_character_inventory':
      case 'get_character_currency':
      case 'get_character_level_milestones':
      case 'get_character_progress':
      case 'get_story_level_milestones':
      case 'get_story_relations':
      case 'get_story_faction_standings':
      case 'get_chapter_notes':
      case 'get_story_chapter_cast':
      case 'get_story_chapter_cast_states':
      case 'get_story_character_progress':
      case 'get_story_inventory':
      case 'get_story_quests':
        return [];
      case 'add_skill_evolution': {
        const saved = evolution(
          `evolution-${evolutions.length + 1}`,
          args.parentSkillId,
          args.childSkillId,
          args.evolutionType,
          {
            chapter_id: args.chapterId ?? null,
            required_rank: args.requiredRank ?? null,
            notes: args.notes ?? null,
          }
        );
        evolutions = [...evolutions, saved];
        return { ...saved };
      }
      case 'delete_skill_evolution':
        evolutions = evolutions.filter(row => row.id !== args.id);
        return null;
      default:
        return null;
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

async function openCharacters() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Characters' }));

  return user;
}

async function openSkillTrees() {
  const user = await openCharacters();
  await user.click(screen.getByRole('button', { name: 'Skill trees' }));

  return user;
}

function continuityText() {
  const panel = screen.getByRole('region', { name: 'Continuity' });
  return [...panel.querySelectorAll('li')].map(item => item.textContent).join('\n');
}

describe('the skill tree view', () => {
  it('draws each tier and colours an edge by its evolution kind', async () => {
    skills = [
      skill('skill-ember', 'char-1', 'Ember', 'n1', 'Rank 1'),
      skill('skill-flame', 'char-1', 'Flame', 'n2', 'Rank 2'),
      skill('skill-inferno', 'char-2', 'Inferno', null),
    ];
    evolutions = [
      evolution('e1', 'skill-ember', 'skill-flame', 'upgrade'),
      evolution('e2', 'skill-flame', 'skill-inferno', 'fusion'),
    ];

    await openSkillTrees();

    expect(screen.getByRole('heading', { name: 'Skill trees' })).toBeInTheDocument();
    // Tiers and links are drawn from the story's skills and evolutions, which
    // load after the view opens, so wait for the first tier rather than assume
    // the tree is already there.
    expect(await screen.findByText('Tier 1')).toBeInTheDocument();
    expect(screen.getByText('Tier 2')).toBeInTheDocument();
    expect(screen.getByText('Tier 3')).toBeInTheDocument();
    expect(screen.getByTestId('node-skill-ember')).toBeInTheDocument();
    expect(screen.getByTestId('node-skill-flame')).toBeInTheDocument();
    expect(screen.getByTestId('node-skill-inferno')).toBeInTheDocument();

    // The two evolution kinds are told apart by colour, and the legend says so.
    expect(await screen.findByTestId('edge-e1')).toHaveAttribute(
      'data-stroke',
      '#5b8def'
    );
    expect(screen.getByTestId('edge-e2')).toHaveAttribute('data-stroke', '#e0af68');
    const legend = screen.getByRole('group', { name: 'Evolution styles' });
    expect(within(legend).getByText('Upgrade')).toBeInTheDocument();
    expect(within(legend).getByText('Fusion')).toBeInTheDocument();
  });

  it('adds a prerequisite link for the selected skill', async () => {
    skills = [
      skill('skill-ember', 'char-1', 'Ember', 'n1'),
      skill('skill-flame', 'char-1', 'Flame', 'n2'),
    ];

    const user = await openSkillTrees();

    await user.click(await screen.findByTestId('node-skill-flame'));
    await user.selectOptions(screen.getByLabelText('Linked skill'), 'skill-ember');
    await user.selectOptions(screen.getByLabelText('Evolution kind'), 'fusion');
    await user.selectOptions(screen.getByLabelText('Evolution chapter'), 'n2');
    await user.type(screen.getByLabelText('Required parent rank'), 'Rank 1');
    await user.type(screen.getByLabelText('Evolution notes'), 'Two fires became one.');
    await user.click(screen.getByRole('button', { name: 'Add link' }));

    expect(lastCall('add_skill_evolution')).toMatchObject({
      parentSkillId: 'skill-ember',
      childSkillId: 'skill-flame',
      evolutionType: 'fusion',
      chapterId: 'n2',
      requiredRank: 'Rank 1',
      notes: 'Two fires became one.',
      user: 'You',
    });

    // The new link is drawn without reopening the story.
    expect(screen.getByTestId('edge-evolution-1')).toHaveAttribute(
      'data-stroke',
      '#e0af68'
    );
  });

  it('adds an outcome link for the selected skill', async () => {
    skills = [
      skill('skill-ember', 'char-1', 'Ember', 'n1'),
      skill('skill-flame', 'char-1', 'Flame', 'n2'),
    ];

    const user = await openSkillTrees();

    await user.click(await screen.findByTestId('node-skill-ember'));
    await user.click(screen.getByRole('button', { name: 'Add outcome' }));
    await user.selectOptions(screen.getByLabelText('Linked skill'), 'skill-flame');
    await user.click(screen.getByRole('button', { name: 'Add link' }));

    expect(lastCall('add_skill_evolution')).toMatchObject({
      parentSkillId: 'skill-ember',
      childSkillId: 'skill-flame',
      evolutionType: 'upgrade',
    });
  });

  it('shows and deletes a link from its edge details', async () => {
    skills = [
      skill('skill-ember', 'char-1', 'Ember', 'n1'),
      skill('skill-flame', 'char-1', 'Flame', 'n2'),
    ];
    evolutions = [
      evolution('e1', 'skill-ember', 'skill-flame', 'mutation', {
        chapter_id: 'n2',
        required_rank: 'Rank 2',
        notes: 'It learned to think.',
      }),
    ];

    const user = await openSkillTrees();

    await user.click(await screen.findByTestId('edge-e1'));

    const details = screen.getByRole('complementary', { name: 'Skill tree details' });
    expect(details).toHaveTextContent('Ember → Flame');
    expect(details).toHaveTextContent('Mutation');
    expect(details).toHaveTextContent('Rank 2');
    expect(details).toHaveTextContent('It learned to think.');

    await user.click(within(details).getByRole('button', { name: 'Delete link' }));

    expect(lastCall('delete_skill_evolution')).toMatchObject({ id: 'e1' });
    expect(screen.queryByTestId('edge-e1')).not.toBeInTheDocument();
  });

  it('reports a loop the database refuses', async () => {
    skills = [
      skill('skill-ember', 'char-1', 'Ember', 'n1'),
      skill('skill-flame', 'char-1', 'Flame', 'n2'),
    ];
    evolutions = [evolution('e1', 'skill-ember', 'skill-flame', 'upgrade')];

    invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
      if (command === 'add_skill_evolution') {
        throw new Error('“Flame” already leads to “Ember”, so this link would close a loop');
      }

      switch (command) {
        case 'get_all_stories':
          return [story];
        case 'get_graph_nodes':
          return [nodeRow('n1', 'chapter', 'Chapter One'), nodeRow('n2', 'chapter', 'Chapter Two')];
        case 'get_characters':
          return cast.map(character => ({ ...character }));
        case 'get_story_skills':
          return skills.map(row => ({ ...row }));
        case 'get_story_skill_evolutions':
          return evolutions.map(row => ({ ...row }));
        default:
          return [];
      }
    });

    const user = await openSkillTrees();

    await user.click(screen.getByTestId('node-skill-ember'));
    await user.selectOptions(screen.getByLabelText('Linked skill'), 'skill-flame');
    await user.click(screen.getByRole('button', { name: 'Add link' }));

    expect(screen.getByRole('alert')).toHaveTextContent('close a loop');
  });
});

describe('skill links on the character sheet', () => {
  it('names what a skill requires and what it becomes', async () => {
    skills = [
      skill('skill-ember', 'char-1', 'Ember', 'n1', 'Rank 1'),
      skill('skill-flame', 'char-1', 'Flame', 'n2', 'Rank 2'),
    ];
    evolutions = [
      evolution('e1', 'skill-ember', 'skill-flame', 'upgrade', {
        required_rank: 'Rank 1',
      }),
    ];

    await openCharacters();

    // The sheet's skills and the story's links load after the title does, so
    // wait for the row the author actually reads.
    expect(await screen.findByText(/Requires Ember · Rank 1/)).toBeInTheDocument();
    expect(screen.getByText(/→ Flame/)).toBeInTheDocument();
  });
});

describe('skill evolution continuity', () => {
  it('warns when a skill appears before its parent was learned', async () => {
    skills = [
      skill('skill-ember', 'char-1', 'Ember', 'n2'),
      skill('skill-flame', 'char-1', 'Flame', 'n1'),
    ];
    evolutions = [evolution('e1', 'skill-ember', 'skill-flame', 'upgrade')];

    const user = await openCharacters();
    await user.click(screen.getByRole('button', { name: 'Chapters' }));

    await waitFor(() =>
      expect(continuityText()).toContain(
        'appears in “Chapter One” before its parent skill “Ember” is learned in “Chapter Two”'
      )
    );
  });

  it('warns when a fusion is unlocked before the rank it needed', async () => {
    skills = [
      skill('skill-ember', 'char-1', 'Ember', 'n1', 'Rank 2'),
      skill('skill-flame', 'char-1', 'Flame', 'n2'),
    ];
    evolutions = [
      evolution('e1', 'skill-ember', 'skill-flame', 'fusion', {
        chapter_id: 'n1',
        required_rank: 'Rank 2',
      }),
    ];
    skillEvents = [
      {
        id: 'event-1',
        skill_id: 'skill-ember',
        kind: 'upgraded',
        chapter_id: 'n2',
        rank: 'Rank 2',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    const user = await openCharacters();
    await user.click(screen.getByRole('button', { name: 'Chapters' }));

    await waitFor(() =>
      expect(continuityText()).toContain(
        'is unlocked in “Chapter One” but “Ember” only reaches Rank 2 in “Chapter Two”'
      )
    );
  });

  it('warns when a link points at a skill in the trash', async () => {
    skills = [skill('skill-ember', 'char-1', 'Ember', 'n1')];
    evolutions = [
      evolution('e1', 'skill-ember', 'skill-gone', 'branch', { chapter_id: 'n1' }),
    ];

    const user = await openCharacters();
    await user.click(screen.getByRole('button', { name: 'Chapters' }));

    await waitFor(() =>
      expect(continuityText()).toContain('branch link has a child skill in the trash')
    );
  });
});
