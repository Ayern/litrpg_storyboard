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

interface StatChangeRow {
  id: string;
  milestone_id: string;
  stat_name: string;
  amount: number | null;
  value_after: number | null;
  created_at: string;
  updated_at: string;
}

interface LevelRow {
  id: string;
  character_id: string;
  level: number;
  chapter_id: string | null;
  is_debuff: boolean;
  xp?: number | null;
  stat_changes?: StatChangeRow[];
  created_at: string;
  updated_at: string;
}

interface StatRow {
  id: string;
  character_id: string;
  stat_name: string;
  value: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ProgressRow {
  id: string;
  character_id: string;
  chapter_id: string;
  xp_earned: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  skill_id: string;
  kind: 'upgraded' | 'sacrificed' | 'used';
  chapter_id: string | null;
  rank: string | null;
  milestone_id?: string | null;
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
let stats: StatRow[] = [];
let progress: ProgressRow[] = [];

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
      xp: 900,
      stat_changes: [
        {
          id: 'change-1',
          milestone_id: 'milestone-1',
          stat_name: 'Strength',
          amount: 2,
          value_after: 10,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        },
      ],
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
    {
      id: 'milestone-2',
      character_id: 'char-1',
      level: 4,
      chapter_id: 'n2',
      is_debuff: false,
      xp: 2400,
      stat_changes: [
        {
          id: 'change-2',
          milestone_id: 'milestone-2',
          stat_name: 'Strength',
          amount: 2,
          value_after: 12,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        },
      ],
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];
  stats = [
    {
      id: 'stat-1',
      character_id: 'char-1',
      stat_name: 'Strength',
      value: 12,
      notes: null,
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
    {
      id: 'stat-2',
      character_id: 'char-1',
      stat_name: 'Dexterity',
      value: 9,
      notes: null,
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];
  progress = [
    {
      id: 'progress-1',
      character_id: 'char-1',
      chapter_id: 'n1',
      xp_earned: 900,
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
    {
      id: 'progress-2',
      character_id: 'char-1',
      chapter_id: 'n2',
      xp_earned: 1500,
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
      case 'get_character_attributes':
        return [];
      case 'get_story_character_stats':
        return stats.map(stat => ({ ...stat }));
      case 'get_character_stats':
        return stats
          .filter(stat => stat.character_id === args.characterId)
          .map(stat => ({ ...stat }));
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
      case 'get_story_character_progress':
        return progress.map(entry => ({ ...entry }));
      case 'get_character_progress':
        return progress
          .filter(entry => entry.character_id === args.characterId)
          .map(entry => ({ ...entry }));
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
          xp: args.xp ?? null,
          stat_changes: (args.statChanges ?? []).map(
            (change: { stat_name: string; amount: number | null; value_after: number | null }, at: number) => ({
              id: `change-new-${at + 1}`,
              milestone_id: `milestone-${levels.length + 1}`,
              stat_name: change.stat_name,
              amount: change.amount,
              value_after: change.value_after,
              created_at: '2026-10-22T12:00:00Z',
              updated_at: '2026-10-22T12:00:00Z',
            })
          ),
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
          xp: args.xp ?? null,
          stat_changes: (args.statChanges ?? []).map(
            (change: { stat_name: string; amount: number | null; value_after: number | null }, at: number) => ({
              id: `change-updated-${at + 1}`,
              milestone_id: existing.id,
              stat_name: change.stat_name,
              amount: change.amount,
              value_after: change.value_after,
              created_at: '2026-10-22T12:00:00Z',
              updated_at: '2026-10-22T12:00:00Z',
            })
          ),
        };
        levels = levels.map(level => (level.id === updated.id ? updated : level));
        return { ...updated };
      }
      case 'delete_level_milestone':
        levels = levels.filter(level => level.id !== args.id);
        return null;
      case 'add_character_progress': {
        const saved: ProgressRow = {
          id: `progress-${progress.length + 1}`,
          character_id: args.characterId,
          chapter_id: args.chapterId,
          xp_earned: args.xpEarned,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        progress = [...progress, saved];
        return { ...saved };
      }
      case 'update_character_progress': {
        const existing = progress.find(entry => entry.id === args.id);
        if (!existing) return null;

        const updated: ProgressRow = {
          ...existing,
          chapter_id: args.chapterId,
          xp_earned: args.xpEarned,
        };
        progress = progress.map(entry => (entry.id === updated.id ? updated : entry));
        return { ...updated };
      }
      case 'delete_character_progress':
        progress = progress.filter(entry => entry.id !== args.id);
        return null;
      case 'add_skill_event': {
        const saved: EventRow = {
          id: `event-${events.length + 1}`,
          skill_id: args.skillId,
          kind: args.kind,
          chapter_id: args.chapterId ?? null,
          rank: args.kind === 'sacrificed' ? null : (args.rank ?? null),
          milestone_id: args.milestoneId ?? null,
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
          milestone_id: args.milestoneId ?? null,
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

  it('accepts XP income that adds up to each total milestone', async () => {
    await openChapters();

    expect(continuityText(continuityPanel())).not.toContain('XP earned through');
  });

  it('flags XP income that does not add up to a total milestone', async () => {
    progress[1].xp_earned = 1200;

    await openChapters();

    expect(continuityText(continuityPanel())).toContain(
      "Rook's XP earned through “Chapter Two” adds up to 2,100 XP, but the total XP milestone there records 2,400 XP (300 short)."
    );
  });

  it('flags income over the recorded total as well', async () => {
    progress[1].xp_earned = 1700;

    await openChapters();

    expect(continuityText(continuityPanel())).toContain(
      "Rook's XP earned through “Chapter Two” adds up to 2,600 XP, but the total XP milestone there records 2,400 XP (200 over)."
    );
  });

  it('leaves totals alone until a character has an income row', async () => {
    progress = [];

    await openChapters();

    expect(continuityText(continuityPanel())).not.toContain('XP earned through');
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
  it('opens the total-XP milestone from a reconciliation warning', async () => {
    progress[1].xp_earned = 1200;

    const user = await openChapters();
    const panel = continuityPanel();

    expect(continuityText(panel)).toContain('XP earned through');

    await user.click(within(panel).getByRole('button', { name: 'Rook' }));

    expect(screen.getByRole('button', { name: 'Characters' })).toHaveClass('active');
    expect(screen.getByLabelText('Milestone total XP')).toHaveValue(2400);
    expect(
      document.querySelector('[data-progression="level-milestone-2"]')
    ).toHaveClass('progression-row-focused');
  });

  it('records the ledger total on the milestone in one click', async () => {
    progress[1].xp_earned = 1200;

    const user = await openChapters();

    await user.click(
      within(continuityPanel()).getByRole('button', { name: 'Sync to 2,100 XP' })
    );

    await waitFor(() =>
      expect(lastCall('update_level_milestone')).toMatchObject({
        id: 'milestone-2',
        level: 4,
        chapterId: 'n2',
        isDebuff: false,
        xp: 2100,
        statChanges: [{ stat_name: 'Strength', amount: 2, value_after: 12 }],
        user: 'You',
      })
    );

    expect(continuityText(continuityPanel())).not.toContain('XP earned through');
    expect(screen.getByText("Synced Rook's total to 2,100 XP.")).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: "Undo syncing Rook's total XP" })
    );

    await waitFor(() =>
      expect(lastCall('update_level_milestone')).toMatchObject({
        id: 'milestone-2',
        xp: 2400,
      })
    );
    expect(continuityText(continuityPanel())).toContain('XP earned through');
  });

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

  it('shows the reconciliation warning on the chapter card', async () => {
    progress[1].xp_earned = 1200;

    await openGraph();
    const card = (
      await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    expect(card).not.toBeNull();
    expect(card?.querySelector('.graph-node-continuity')).toHaveTextContent(
      "Rook's XP income is 2,100 XP, milestone says 2,400"
    );
  });

  it('syncs the ledger total from the chapter card', async () => {
    progress[1].xp_earned = 1200;

    const user = await openGraph();
    const card = (
      await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    expect(card).not.toBeNull();
    await user.click(
      within(card as HTMLElement).getByRole('button', {
        name: "Sync Rook's total XP to 2,100 XP",
      })
    );

    await waitFor(() =>
      expect(lastCall('update_level_milestone')).toMatchObject({
        id: 'milestone-2',
        xp: 2100,
        statChanges: [{ stat_name: 'Strength', amount: 2, value_after: 12 }],
      })
    );
    expect(screen.getByText("Synced Rook's total to 2,100 XP.")).toBeInTheDocument();
  });
});

describe('level milestones and skill events on the sheet', () => {
  it('adds, edits and deletes a level milestone', async () => {
    const user = await openSheet();

    await user.clear(screen.getByLabelText('New milestone level'));
    await user.type(screen.getByLabelText('New milestone level'), '6');
    await user.selectOptions(screen.getByLabelText('New milestone chapter'), 'n3');
    await user.selectOptions(screen.getByLabelText('New milestone stat 1 name'), 'Strength');
    await user.type(screen.getByLabelText('New milestone stat 1 gain'), '2');
    await user.type(screen.getByLabelText('New milestone stat 1 value after'), '14');
    await user.click(screen.getByRole('button', { name: 'Add a new milestone stat' }));
    await user.selectOptions(screen.getByLabelText('New milestone stat 2 name'), 'Dexterity');
    await user.type(screen.getByLabelText('New milestone stat 2 gain'), '1');
    await user.type(screen.getByLabelText('New milestone total XP'), '3600');
    await user.click(screen.getByLabelText('New milestone is a penalty'));
    await user.click(screen.getByRole('button', { name: 'Add milestone' }));

    expect(lastCall('add_level_milestone')).toMatchObject({
      characterId: 'char-1',
      level: 6,
      chapterId: 'n3',
      isDebuff: true,
      xp: 3600,
      statChanges: [
        { stat_name: 'Strength', amount: 2, value_after: 14 },
        { stat_name: 'Dexterity', amount: 1, value_after: null },
      ],
      user: 'You',
    });
    expect(
      document.querySelector('[data-progression="level-milestone-3"]')
    ).toHaveTextContent('Strength +2 (now 14)');
    expect(
      document.querySelector('[data-progression="level-milestone-3"]')
    ).toHaveTextContent('Dexterity +1');
    expect(document.querySelector('[data-progression="level-milestone-3"]')).toBeInTheDocument();
    expect(
      within(document.querySelector('[data-progression="level-milestone-3"]') as HTMLElement)
        .getByText('Penalty')
    ).toBeInTheDocument();

    await user.click(
      screen.getByTitle('Change the level and chapter of the level 3 milestone')
    );
    expect(screen.getByLabelText('Milestone total XP')).toHaveValue(900);
    expect(screen.getByLabelText('Milestone stat 1 name')).toHaveValue('Strength');
    expect(screen.getByLabelText('Milestone stat 1 gain')).toHaveValue(2);
    expect(screen.getByLabelText('Milestone stat 1 value after')).toHaveValue(10);
    await user.clear(screen.getByLabelText('Milestone level'));
    await user.type(screen.getByLabelText('Milestone level'), '5');
    await user.selectOptions(screen.getByLabelText('Milestone chapter'), 'n2');
    await user.selectOptions(screen.getByLabelText('Milestone stat 1 name'), 'Dexterity');
    await user.clear(screen.getByLabelText('Milestone stat 1 value after'));
    await user.type(screen.getByLabelText('Milestone stat 1 value after'), '11');
    await user.click(screen.getByRole('button', { name: 'Add a milestone stat' }));
    await user.selectOptions(screen.getByLabelText('Milestone stat 2 name'), 'Strength');
    await user.type(screen.getByLabelText('Milestone stat 2 gain'), '1');
    await user.clear(screen.getByLabelText('Milestone total XP'));
    await user.type(screen.getByLabelText('Milestone total XP'), '1500');
    await user.click(screen.getByRole('button', { name: 'Save milestone' }));

    expect(lastCall('update_level_milestone')).toMatchObject({
      id: 'milestone-1',
      level: 5,
      chapterId: 'n2',
      isDebuff: false,
      xp: 1500,
      statChanges: [
        { stat_name: 'Dexterity', amount: 2, value_after: 11 },
        { stat_name: 'Strength', amount: 1, value_after: null },
      ],
      user: 'You',
    });

    await user.click(screen.getByTitle('Delete the level 4 milestone'));
    expect(lastCall('delete_level_milestone')).toMatchObject({
      id: 'milestone-2',
      user: 'You',
    });
  });

  it('refuses negative XP and a stat without points', async () => {
    const user = await openSheet();

    await user.type(screen.getByLabelText('New milestone total XP'), '-1');
    await user.click(screen.getByRole('button', { name: 'Add milestone' }));

    expect(
      await screen.findByText('Total XP is a whole number, 0 or more, or blank.')
    ).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'add_level_milestone')
    ).toHaveLength(0);

    await user.clear(screen.getByLabelText('New milestone total XP'));
    await user.selectOptions(screen.getByLabelText('New milestone stat 1 name'), 'Strength');
    await user.click(screen.getByRole('button', { name: 'Add milestone' }));

    expect(
      await screen.findByText('Strength needs a gain, a resulting value, or both.')
    ).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'add_level_milestone')
    ).toHaveLength(0);
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

  it('adds, edits and deletes XP earned by chapter', async () => {
    const user = await openSheet();

    expect(document.querySelector('[data-xp-entry="progress-1"]')).toHaveTextContent(
      'Chapter One900 XP earned'
    );
    expect(document.querySelector('[data-xp-entry="progress-2"]')).toHaveTextContent(
      'Chapter Two1500 XP earned'
    );

    await user.selectOptions(screen.getByLabelText('New XP entry chapter'), 'n3');
    await user.type(screen.getByLabelText('New XP entry earned XP'), '750');
    await user.click(screen.getByRole('button', { name: 'Add XP' }));

    expect(lastCall('add_character_progress')).toMatchObject({
      characterId: 'char-1',
      chapterId: 'n3',
      xpEarned: 750,
      user: 'You',
    });
    expect(document.querySelector('[data-xp-entry="progress-3"]')).toHaveTextContent(
      'Chapter Three750 XP earned'
    );

    await user.click(screen.getByTitle('Change the XP earned in Chapter One'));
    expect(screen.getByLabelText('XP entry earned XP')).toHaveValue(900);
    await user.clear(screen.getByLabelText('XP entry earned XP'));
    await user.type(screen.getByLabelText('XP entry earned XP'), '500');
    await user.click(screen.getByRole('button', { name: 'Save XP' }));

    expect(lastCall('update_character_progress')).toMatchObject({
      id: 'progress-1',
      chapterId: 'n1',
      xpEarned: 500,
      user: 'You',
    });
    expect(document.querySelector('[data-xp-entry="progress-1"]')).toHaveTextContent(
      '500 XP earned'
    );

    await user.click(screen.getByTitle('Delete the XP earned in Chapter Two'));
    expect(lastCall('delete_character_progress')).toMatchObject({
      id: 'progress-2',
      user: 'You',
    });
    expect(document.querySelector('[data-xp-entry="progress-2"]')).toBeNull();
  });

  it('refuses negative XP or an XP entry without a chapter', async () => {
    const user = await openSheet();

    await user.selectOptions(screen.getByLabelText('New XP entry chapter'), 'n3');
    await user.type(screen.getByLabelText('New XP entry earned XP'), '-1');
    await user.click(screen.getByRole('button', { name: 'Add XP' }));

    expect(
      await screen.findByText('XP earned is a whole number, 0 or more.')
    ).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'add_character_progress')
    ).toHaveLength(0);

    await user.clear(screen.getByLabelText('New XP entry earned XP'));
    await user.type(screen.getByLabelText('New XP entry earned XP'), '100');
    await user.selectOptions(screen.getByLabelText('New XP entry chapter'), '');
    await user.click(screen.getByRole('button', { name: 'Add XP' }));

    expect(await screen.findByText('XP earned needs a chapter.')).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'add_character_progress')
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

  it('groups a skill upgrade under the level-up it came with', async () => {
    const user = await openSheet();

    await user.click(
      screen.getByTitle('Record an upgrade, use or sacrifice of Fireball')
    );
    expect(screen.getByLabelText('Skill event level-up')).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('Skill event level-up'), 'milestone-1');
    await user.type(screen.getByLabelText('Skill event rank'), 'Rank 2');
    await user.click(screen.getByRole('button', { name: 'Save event' }));

    expect(lastCall('add_skill_event')).toMatchObject({
      skillId: 'skill-1',
      kind: 'upgraded',
      milestoneId: 'milestone-1',
      rank: 'Rank 2',
      user: 'You',
    });

    const milestoneRow = document.querySelector(
      '[data-progression="level-milestone-1"]'
    ) as HTMLElement;
    expect(milestoneRow).toHaveTextContent('Fireball · upgraded Rank 2');
    expect(
      document.querySelector('[data-progression="skill-event-event-2"]')
    ).toHaveTextContent('At Level 3');

    const event = document.querySelector(
      '[data-progression="skill-event-event-2"]'
    ) as HTMLElement;
    await user.click(within(event).getByTitle('Change this Fireball event'));
    expect(screen.getByLabelText('Skill event level-up')).toHaveValue('milestone-1');
    await user.selectOptions(screen.getByLabelText('Skill event level-up'), '');
    await user.click(screen.getByRole('button', { name: 'Save event' }));

    expect(lastCall('update_skill_event')).toMatchObject({
      id: 'event-2',
      milestoneId: null,
      user: 'You',
    });
    expect(
      document.querySelector('[data-progression="level-milestone-1"]')
    ).not.toHaveTextContent('Fireball · upgraded');
  });
});
