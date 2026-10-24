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

interface LevelRow {
  id: string;
  character_id: string;
  level: number;
  chapter_id: string | null;
  is_debuff: boolean;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  skill_id: string;
  kind: 'upgraded' | 'sacrificed' | 'used';
  chapter_id: string | null;
  rank: string | null;
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
let levels: LevelRow[] = [];
let events: EventRow[] = [];

beforeEach(() => {
  skills = [
    {
      id: 'skill-1',
      character_id: 'char-1',
      name: 'Fireball',
      rank: 'Rank 1',
      effect: '3d6 fire',
      chapter_id: 'n1',
      node_id: null,
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];
  levels = [
    {
      id: 'milestone-1',
      character_id: 'char-1',
      level: 3,
      chapter_id: 'n1',
      is_debuff: false,
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
    {
      id: 'milestone-2',
      character_id: 'char-1',
      level: 4,
      chapter_id: 'n2',
      is_debuff: false,
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];
  events = [
    {
      id: 'event-1',
      skill_id: 'skill-1',
      kind: 'upgraded',
      chapter_id: 'n2',
      rank: 'Rank 2',
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
          nodeRow('n3', 'chapter', 'Chapter Three'),
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
      case 'get_story_level_milestones':
        return levels.map(level => ({ ...level }));
      case 'get_character_level_milestones':
        return levels
          .filter(level => level.character_id === args.characterId)
          .map(level => ({ ...level }));
      case 'get_story_skill_events':
        return events.map(event => ({ ...event }));
      case 'get_skill_events':
        return events
          .filter(event => event.skill_id === args.skillId)
          .map(event => ({ ...event }));
      case 'add_level_milestone': {
        const saved: LevelRow = {
          id: `milestone-${levels.length + 1}`,
          character_id: args.characterId,
          level: args.level,
          chapter_id: args.chapterId ?? null,
          is_debuff: args.isDebuff,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        levels = [...levels, saved];
        return { ...saved };
      }
      case 'update_level_milestone': {
        const existing = levels.find(level => level.id === args.id);
        if (!existing) return null;

        const updated: LevelRow = {
          ...existing,
          level: args.level,
          chapter_id: args.chapterId ?? null,
          is_debuff: args.isDebuff,
        };
        levels = levels.map(level => (level.id === updated.id ? updated : level));
        return { ...updated };
      }
      case 'delete_level_milestone':
        levels = levels.filter(level => level.id !== args.id);
        return null;
      case 'add_skill_event': {
        const saved: EventRow = {
          id: `event-${events.length + 1}`,
          skill_id: args.skillId,
          kind: args.kind,
          chapter_id: args.chapterId ?? null,
          rank: args.kind === 'sacrificed' ? null : (args.rank ?? null),
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        events = [...events, saved];
        return { ...saved };
      }
      case 'update_skill_event': {
        const existing = events.find(event => event.id === args.id);
        if (!existing) return null;

        const updated: EventRow = {
          ...existing,
          kind: args.kind,
          chapter_id: args.chapterId ?? null,
          rank: args.kind === 'sacrificed' ? null : (args.rank ?? null),
        };
        events = events.map(event => (event.id === updated.id ? updated : event));
        return { ...updated };
      }
      case 'delete_skill_event':
        events = events.filter(event => event.id !== args.id);
        return null;
      default:
        return null;
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

function continuityPanel() {
  return screen.getByRole('region', { name: 'Continuity' });
}

function continuityText(panel: HTMLElement) {
  return [...panel.querySelectorAll('li')].map(item => item.textContent).join('\n');
}

async function openChapters() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Chapters' }));

  return user;
}

async function openSheet() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Characters' }));
  await user.click(screen.getByTitle("Show Rook's sheet"));

  return user;
}

async function openGraph() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');

  return user;
}

describe('level and skill continuity', () => {
  it('flags a level that goes backwards without a penalty', async () => {
    levels[1].level = 2;

    await openChapters();

    const panel = continuityPanel();
    expect(continuityText(panel)).toContain(
      "Rook's level goes back from 3 in “Chapter One” to 2 in “Chapter Two”."
    );
  });

  it('accepts a level drop marked as a penalty', async () => {
    levels[1].level = 2;
    levels[1].is_debuff = true;

    await openChapters();

    // The chapters still have their own POV reminder, but not a level one.
    expect(continuityText(continuityPanel())).not.toContain('level goes back');
  });

  it('flags a skill used before it was learned', async () => {
    skills[0].chapter_id = 'n2';
    events = [
      {
        id: 'event-use',
        skill_id: 'skill-1',
        kind: 'used',
        chapter_id: 'n1',
        rank: null,
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    await openChapters();

    expect(continuityText(continuityPanel())).toContain(
      "Rook's “Fireball” is used in “Chapter One” before it was learned in “Chapter Two”."
    );
  });

  it('flags a rank used before its upgrade', async () => {
    skills[0].chapter_id = 'n1';
    events = [
      {
        id: 'event-use',
        skill_id: 'skill-1',
        kind: 'used',
        chapter_id: 'n2',
        rank: 'Rank 2',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
      {
        id: 'event-upgrade',
        skill_id: 'skill-1',
        kind: 'upgraded',
        chapter_id: 'n3',
        rank: 'Rank 2',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    await openChapters();

    expect(continuityText(continuityPanel())).toContain(
      "Rook's “Fireball” is used at Rank 2 in “Chapter Two” before that rank is gained in “Chapter Three”."
    );
  });

  it('flags a skill upgraded after it was sacrificed', async () => {
    skills[0].chapter_id = 'n1';
    events = [
      {
        id: 'event-sacrifice',
        skill_id: 'skill-1',
        kind: 'sacrificed',
        chapter_id: 'n2',
        rank: null,
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
      {
        id: 'event-upgrade',
        skill_id: 'skill-1',
        kind: 'upgraded',
        chapter_id: 'n3',
        rank: 'Rank 3',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    await openChapters();

    expect(continuityText(continuityPanel())).toContain(
      "Rook's “Fireball” is upgraded in “Chapter Three” after it was sacrificed in “Chapter Two”."
    );
  });

  it('flags a skill used after it was sacrificed', async () => {
    skills[0].chapter_id = 'n1';
    events = [
      {
        id: 'event-use-one',
        skill_id: 'skill-1',
        kind: 'used',
        chapter_id: 'n1',
        rank: null,
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
      {
        id: 'event-sacrifice',
        skill_id: 'skill-1',
        kind: 'sacrificed',
        chapter_id: 'n2',
        rank: null,
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
      {
        id: 'event-use-two',
        skill_id: 'skill-1',
        kind: 'used',
        chapter_id: 'n3',
        rank: null,
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    await openChapters();

    expect(continuityText(continuityPanel())).toContain(
      "Rook's “Fireball” is used in “Chapter Three” after it was sacrificed in “Chapter Two”."
    );
  });
});

describe('progression warnings open the entry to edit', () => {
  it('opens the level milestone from the continuity panel', async () => {
    levels[1].level = 2;

    const user = await openChapters();
    const panel = continuityPanel();

    expect(continuityText(panel)).toContain('level goes back');

    await user.click(within(panel).getByRole('button', { name: 'Rook' }));

    expect(screen.getByRole('button', { name: 'Characters' })).toHaveClass('active');
    expect(document.querySelector('[data-character-id="char-1"]')).toHaveClass('active');
    expect(screen.getByLabelText('Milestone level')).toHaveValue(2);
    expect(
      document.querySelector('[data-progression="level-milestone-2"]')
    ).toHaveClass('progression-row-focused');
  });

  it('opens the skill event from a chapter-card badge', async () => {
    skills[0].chapter_id = 'n2';
    events = [
      {
        id: 'event-use',
        skill_id: 'skill-1',
        kind: 'used',
        chapter_id: 'n1',
        rank: null,
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    const user = await openGraph();
    const card = (
      await screen.findByText('Chapter One', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    expect(card).not.toBeNull();
    await user.click(
      within(card as HTMLElement).getByRole('button', { name: /Open Rook's sheet/ })
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Characters' })).toHaveClass('active')
    );
    expect(document.querySelector('[data-character-id="char-1"]')).toHaveClass('active');
    expect(screen.getByLabelText('Skill event kind')).toHaveValue('used');
    expect(screen.getByLabelText('Skill event chapter')).toHaveValue('n1');
    expect(
      document.querySelector('[data-progression="skill-event-event-use"]')
    ).toHaveClass('progression-row-focused');
  });
});

describe('level milestones and skill events on the sheet', () => {
  it('adds, edits and deletes a level milestone', async () => {
    const user = await openSheet();

    await user.clear(screen.getByLabelText('New milestone level'));
    await user.type(screen.getByLabelText('New milestone level'), '6');
    await user.selectOptions(screen.getByLabelText('New milestone chapter'), 'n3');
    await user.click(screen.getByLabelText('New milestone is a penalty'));
    await user.click(screen.getByRole('button', { name: 'Add milestone' }));

    expect(lastCall('add_level_milestone')).toMatchObject({
      characterId: 'char-1',
      level: 6,
      chapterId: 'n3',
      isDebuff: true,
      user: 'You',
    });
    expect(document.querySelector('[data-progression="level-milestone-3"]')).toBeInTheDocument();
    expect(
      within(document.querySelector('[data-progression="level-milestone-3"]') as HTMLElement)
        .getByText('Penalty')
    ).toBeInTheDocument();

    await user.click(
      screen.getByTitle('Change the level and chapter of the level 3 milestone')
    );
    await user.clear(screen.getByLabelText('Milestone level'));
    await user.type(screen.getByLabelText('Milestone level'), '5');
    await user.selectOptions(screen.getByLabelText('Milestone chapter'), 'n2');
    await user.click(screen.getByRole('button', { name: 'Save milestone' }));

    expect(lastCall('update_level_milestone')).toMatchObject({
      id: 'milestone-1',
      level: 5,
      chapterId: 'n2',
      isDebuff: false,
      user: 'You',
    });

    await user.click(screen.getByTitle('Delete the level 4 milestone'));
    expect(lastCall('delete_level_milestone')).toMatchObject({
      id: 'milestone-2',
      user: 'You',
    });
  });

  it('refuses a milestone below level 1', async () => {
    const user = await openSheet();

    await user.clear(screen.getByLabelText('New milestone level'));
    await user.type(screen.getByLabelText('New milestone level'), '0');
    await user.click(screen.getByRole('button', { name: 'Add milestone' }));

    expect(
      await screen.findByText('A level milestone needs a whole-number level of 1 or more.')
    ).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'add_level_milestone')
    ).toHaveLength(0);
  });

  it('adds, edits and deletes a skill event', async () => {
    const user = await openSheet();

    await user.click(
      screen.getByTitle('Record an upgrade, use or sacrifice of Fireball')
    );
    await user.selectOptions(screen.getByLabelText('Skill event kind'), 'used');
    await user.selectOptions(screen.getByLabelText('Skill event chapter'), 'n3');
    await user.type(screen.getByLabelText('Skill event rank'), 'Rank 3');
    await user.click(screen.getByRole('button', { name: 'Save event' }));

    expect(lastCall('add_skill_event')).toMatchObject({
      skillId: 'skill-1',
      kind: 'used',
      chapterId: 'n3',
      rank: 'Rank 3',
      user: 'You',
    });
    expect(screen.getByText('Used at Rank 3')).toBeInTheDocument();
    expect(
      document.querySelector('[data-progression="skill-event-event-2"] .skill-event-chapter')
    ).toHaveTextContent('Chapter Three');

    const firstEvent = document.querySelector(
      '[data-progression="skill-event-event-1"]'
    ) as HTMLElement;
    await user.click(within(firstEvent).getByTitle('Change this Fireball event'));
    await user.selectOptions(screen.getByLabelText('Skill event kind'), 'sacrificed');
    expect(screen.getByLabelText('Skill event rank')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save event' }));

    expect(lastCall('update_skill_event')).toMatchObject({
      id: 'event-1',
      kind: 'sacrificed',
      rank: null,
      user: 'You',
    });
    expect(within(firstEvent).getByText('Sacrificed or lost')).toBeInTheDocument();

    await user.click(within(firstEvent).getByTitle('Delete this Fireball event'));
    expect(lastCall('delete_skill_event')).toMatchObject({
      id: 'event-1',
      user: 'You',
    });
    expect(document.querySelector('[data-progression="skill-event-event-1"]')).toBeNull();
  });
});
