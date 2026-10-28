import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

interface MilestoneRow {
  id: string;
  character_id: string;
  level: number;
  chapter_id: string | null;
  is_debuff: boolean;
  xp: number | null;
  stat_changes: unknown[];
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

interface AwardRow {
  id: string;
  character_id: string;
  chapter_id: string | null;
  kind: 'xp' | 'stat';
  stat_name: string | null;
  amount: number;
  note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface GrowthRow {
  id: string;
  story_id: string;
  character_id: string | null;
  points_per_level: number;
  xp_base: number;
  xp_growth: number;
  stats: {
    id: string;
    rule_id: string;
    stat_name: string;
    per_level: number;
    created_at: string;
    updated_at: string;
  }[];
  created_by: string;
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
let milestones: MilestoneRow[] = [];
let stats: StatRow[] = [];
let progress: ProgressRow[] = [];
let awards: AwardRow[] = [];
let growth: GrowthRow[] = [];

const stamp = (minute: number) => `2026-10-22T12:${String(minute).padStart(2, '0')}:00Z`;

beforeEach(() => {
  cast = [row('char-1', 'Rook', 3, 250, 'Bronze', 1000), row('char-2', 'Wren', 1, 0, null, null)];
  // The sheet's level is read from the level-ups, so Rook's third level is one.
  milestones = [
    {
      id: 'm-1',
      character_id: 'char-1',
      level: 3,
      chapter_id: 'n1',
      is_debuff: false,
      xp: 250,
      stat_changes: [],
      created_at: stamp(1),
      updated_at: stamp(1),
    },
  ];
  stats = [
    {
      id: 's-1',
      character_id: 'char-1',
      stat_name: 'Strength',
      value: 12,
      notes: null,
      created_at: stamp(1),
      updated_at: stamp(1),
    },
  ];
  progress = [];
  awards = [];
  growth = [];

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
            created_at: stamp(1),
            updated_at: stamp(1),
            character_id: null,
          },
        ];
      case 'get_graph_edges':
        return [];
      case 'get_characters':
        return args.storyId === story.id ? cast.map(entry => ({ ...entry })) : [];
      case 'get_story_character_stats':
        return stats.map(entry => ({ ...entry }));
      case 'get_character_stats':
        return stats
          .filter(entry => entry.character_id === args.characterId)
          .map(entry => ({ ...entry }));
      case 'get_character_attributes':
        return [];
      case 'get_story_level_milestones':
        return milestones.map(entry => ({ ...entry }));
      case 'get_story_character_progress':
        return progress.map(entry => ({ ...entry }));
      case 'get_story_level_growth_rules':
        return growth.map(entry => ({ ...entry, stats: entry.stats.map(rate => ({ ...rate })) }));
      case 'get_story_character_awards':
        return awards.map(entry => ({ ...entry }));
      case 'set_character_progress': {
        const character = cast.find(entry => entry.id === args.characterId);
        if (!character) return null;

        character.rank = args.rank ?? null;
        return { ...character };
      }
      case 'add_character_progress': {
        const saved: ProgressRow = {
          id: `p-${progress.length + 1}`,
          character_id: args.characterId,
          chapter_id: args.chapterId,
          xp_earned: args.xpEarned,
          created_at: stamp(progress.length + 1),
          updated_at: stamp(progress.length + 1),
        };

        progress.push(saved);
        return saved;
      }
      case 'add_level_milestone': {
        const character = cast.find(entry => entry.id === args.characterId);
        if (!character) return null;

        const saved: MilestoneRow = {
          id: `m-${milestones.length + 1}`,
          character_id: args.characterId,
          level: args.level,
          chapter_id: args.chapterId ?? null,
          is_debuff: args.isDebuff,
          xp: args.xp ?? null,
          stat_changes: [],
          created_at: stamp(milestones.length + 1),
          updated_at: stamp(milestones.length + 1),
        };

        milestones.push(saved);
        // The last level-up written is the level the sheet stands at.
        character.level = saved.level;
        return { ...saved };
      }
      case 'delete_level_milestone': {
        const found = milestones.find(entry => entry.id === args.id);
        milestones = milestones.filter(entry => entry.id !== args.id);
        const character = found ? cast.find(entry => entry.id === found.character_id) : null;
        if (character) {
          const own = milestones.filter(entry => entry.character_id === character.id);
          character.level = own[own.length - 1]?.level ?? 1;
        }
        return null;
      }
      case 'save_level_growth_rule': {
        const owner = args.characterId ?? null;
        const existing = growth.findIndex(entry => entry.character_id === owner);
        const saved: GrowthRow = {
          id: existing >= 0 ? growth[existing].id : `g-${growth.length + 1}`,
          story_id: story.id,
          character_id: owner,
          points_per_level: args.pointsPerLevel,
          xp_base: args.xpBase ?? 100,
          xp_growth: args.xpGrowth ?? 0,
          stats: (args.stats ?? []).map((rate: any, index: number) => ({
            id: `gs-${index}`,
            rule_id: 'g',
            stat_name: rate.stat_name,
            per_level: rate.per_level,
            created_at: stamp(1),
            updated_at: stamp(1),
          })),
          created_by: 'You',
          created_at: stamp(1),
          updated_at: stamp(1),
        };

        if (existing >= 0) growth[existing] = saved;
        else growth.push(saved);

        return { ...saved };
      }
      case 'delete_level_growth_rule':
        growth = growth.filter(entry => entry.id !== args.id);
        return null;
      case 'add_character_award': {
        const saved: AwardRow = {
          id: `a-${awards.length + 1}`,
          character_id: args.characterId,
          chapter_id: args.chapterId ?? null,
          kind: args.kind,
          stat_name: args.statName ?? null,
          amount: args.amount,
          note: args.note ?? null,
          created_by: 'You',
          created_at: stamp(1),
          updated_at: stamp(1),
        };

        awards.push(saved);

        if (saved.kind === 'stat') {
          const existingStat = stats.find(
            entry =>
              entry.character_id === saved.character_id &&
              entry.stat_name === saved.stat_name
          );

          if (existingStat) existingStat.value += saved.amount;
          else
            stats.push({
              id: `s-${stats.length + 1}`,
              character_id: saved.character_id,
              stat_name: saved.stat_name ?? 'Stat',
              value: saved.amount,
              notes: null,
              created_at: stamp(1),
              updated_at: stamp(1),
            });
        } else if (saved.chapter_id) {
          const entry = progress.find(
            item =>
              item.character_id === saved.character_id && item.chapter_id === saved.chapter_id
          );

          if (entry) entry.xp_earned += saved.amount;
          else
            progress.push({
              id: `p-${progress.length + 1}`,
              character_id: saved.character_id,
              chapter_id: saved.chapter_id,
              xp_earned: saved.amount,
              created_at: stamp(1),
              updated_at: stamp(1),
            });
        }

        return { ...saved };
      }
      case 'delete_character_award': {
        const found = awards.find(entry => entry.id === args.id);
        awards = awards.filter(entry => entry.id !== args.id);

        if (found?.kind === 'stat') {
          const stat = stats.find(
            entry =>
              entry.character_id === found.character_id && entry.stat_name === found.stat_name
          );
          if (stat) stat.value -= found.amount;
        } else if (found?.chapter_id) {
          const entry = progress.find(
            item =>
              item.character_id === found.character_id && item.chapter_id === found.chapter_id
          );
          if (entry) entry.xp_earned = Math.max(0, entry.xp_earned - found.amount);
        }
        return null;
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

function milestonesPanel() {
  return within(screen.getByRole('region', { name: 'Level timeline' }));
}

function growthPanel() {
  return within(screen.getByRole('region', { name: 'Level growth' }));
}

function bar() {
  return within(sheet()).getByRole('progressbar');
}

function statRow(name: string) {
  return Array.from(document.querySelectorAll('.stat-row')).find(row =>
    row.textContent?.startsWith(name)
  );
}

describe('progression', () => {
  it('shows the level the level-ups recorded, with the rank and experience', async () => {
    await openSheet();

    expect(within(sheet()).getByText('3')).toBeInTheDocument();
    expect(within(sheet()).getByText('250 / 1000')).toBeInTheDocument();
    expect(within(sheet()).getByText('Bronze')).toBeInTheDocument();
    expect(within(sheet()).getByText('750 XP to level 4')).toBeInTheDocument();
    expect(bar()).toHaveAttribute('aria-valuenow', '25');

    // The rail reads the same level, which the database keeps in step with the
    // level-ups.
    expect(screen.getByText('Level 3 · Bronze')).toBeInTheDocument();
  });

  it('shows level 1 for a character with no level-ups', async () => {
    await openSheet('Wren');

    expect(within(sheet()).getByText('1')).toBeInTheDocument();
    expect(
      screen.getByText('No levels yet — record what a chapter paid out and the timeline follows.')
    ).toBeInTheDocument();
  });

  it('edits the rank without offering a level, a total or a target', async () => {
    const user = await openSheet();

    await user.click(within(sheet()).getByRole('button', { name: 'Edit rank' }));

    // None of the three are typed any more: the ledger holds the total, the curve
    // holds the level and the target.
    expect(within(sheet()).queryByLabelText('Level')).not.toBeInTheDocument();
    expect(within(sheet()).queryByLabelText('Experience')).not.toBeInTheDocument();
    expect(within(sheet()).queryByLabelText('XP to next')).not.toBeInTheDocument();

    const rank = within(sheet()).getByLabelText('Rank');
    await user.clear(rank);
    await user.type(rank, 'Silver');

    await user.click(within(sheet()).getByRole('button', { name: 'Save' }));

    expect(lastCall('set_character_progress')).toEqual({
      characterId: 'char-1',
      rank: 'Silver',
      user: 'You',
    });

    expect(screen.getByText('Level 3 · Silver')).toBeInTheDocument();
  });

  it('leaves the rank empty when it is cleared', async () => {
    const user = await openSheet();

    await user.click(within(sheet()).getByRole('button', { name: 'Edit rank' }));
    await user.clear(within(sheet()).getByLabelText('Rank'));
    await user.click(within(sheet()).getByRole('button', { name: 'Save' }));

    expect(lastCall('set_character_progress')).toEqual({
      characterId: 'char-1',
      rank: null,
      user: 'You',
    });

    expect(await within(sheet()).findByText('Unranked')).toBeInTheDocument();
  });

  it('offers no way to type a level or a level-up', async () => {
    await openSheet();

    expect(
      within(sheet()).queryByRole('button', { name: 'Record level-up' })
    ).not.toBeInTheDocument();
    expect(
      milestonesPanel().queryByRole('button', { name: 'Add milestone' })
    ).not.toBeInTheDocument();
    expect(
      milestonesPanel().queryByRole('button', { name: 'Edit' })
    ).not.toBeInTheDocument();

    // The timeline is still the record of what the curve wrote.
    expect(milestonesPanel().getByText('Level 3')).toBeInTheDocument();
  });

  it('records experience on a chapter, which is what moves the level', async () => {
    const user = await openSheet();

    const ledger = within(screen.getByRole('region', { name: 'XP by chapter' }));

    await user.selectOptions(ledger.getByLabelText('New XP entry chapter'), 'n1');
    await user.type(ledger.getByLabelText('New XP entry earned XP'), '250');
    await user.click(ledger.getByRole('button', { name: 'Add XP' }));

    expect(lastCall('add_character_progress')).toEqual({
      characterId: 'char-1',
      chapterId: 'n1',
      xpEarned: 250,
      user: 'You',
    });

    // The form clears once the row is written, and the sheet reads its total from
    // the ledger rather than keeping a copy to fall out of step with.
    expect(ledger.getByLabelText('New XP entry earned XP')).toHaveValue(null);
  });

  it('says what a level costs and hands out from the rule', async () => {
    growth = [
      {
        id: 'g-1',
        story_id: story.id,
        character_id: null,
        points_per_level: 2,
        xp_base: 700,
        xp_growth: 0,
        stats: [
          {
            id: 'gs-1',
            rule_id: 'g-1',
            stat_name: 'Strength',
            per_level: 1,
            created_at: stamp(1),
            updated_at: stamp(1),
          },
        ],
        created_by: 'Ada',
        created_at: stamp(1),
        updated_at: stamp(1),
      },
    ];

    await openSheet();

    expect(
      milestonesPanel().getByText(
        'Every level hands out: 700 XP a level · 2 points to place per level · Strength +1.'
      )
    ).toBeInTheDocument();
  });

  it('saves the story rule a level follows', async () => {
    const user = await openSheet();

    await user.click(growthPanel().getByRole('button', { name: 'Set rule' }));
    const points = growthPanel().getByLabelText('Growth points per level');
    await user.clear(points);
    await user.type(points, '2');

    await user.click(growthPanel().getByRole('button', { name: 'Add rate' }));
    await user.selectOptions(growthPanel().getByLabelText('Growth rate 1 stat'), 'Strength');
    const perLevel = growthPanel().getByLabelText('Growth rate 1 per level');
    await user.type(perLevel, '1');

    await user.click(growthPanel().getByRole('button', { name: 'Save rule' }));

    expect(lastCall('save_level_growth_rule')).toEqual({
      storyId: story.id,
      characterId: null,
      pointsPerLevel: 2,
      xpBase: 100,
      xpGrowth: 0,
      stats: [{ stat_name: 'Strength', per_level: 1 }],
      user: 'You',
    });

    expect(
      await growthPanel().findByText(
        '100 XP a level · 2 points to place per level · Strength +1'
      )
    ).toBeInTheDocument();
  });

  it('gives a character a rule of their own and removes it again', async () => {
    const user = await openSheet();

    await user.click(growthPanel().getByRole('button', { name: 'Override' }));
    const points = growthPanel().getByLabelText('Growth points per level');
    await user.clear(points);
    await user.type(points, '1');
    await user.click(growthPanel().getByRole('button', { name: 'Save rule' }));

    expect(lastCall('save_level_growth_rule')).toMatchObject({
      characterId: 'char-1',
      pointsPerLevel: 1,
      stats: [],
    });

    expect(
      await growthPanel().findByText('100 XP a level · 1 point to place per level')
    ).toBeInTheDocument();

    await user.click(growthPanel().getByRole('button', { name: 'Remove' }));

    expect(lastCall('delete_level_growth_rule')).toMatchObject({ id: 'g-1', user: 'You' });
    expect(await growthPanel().findByText('Follows the story rule.')).toBeInTheDocument();
  });

  it('records an award and takes it back out again', async () => {
    const user = await openSheet();

    const awardsRegion = within(screen.getByRole('region', { name: 'Awards' }));

    await user.selectOptions(awardsRegion.getByLabelText('Award kind'), 'stat');
    await user.selectOptions(awardsRegion.getByLabelText('Award chapter'), 'n1');
    await user.selectOptions(awardsRegion.getByLabelText('Award stat'), 'Strength');
    await user.type(awardsRegion.getByLabelText('Award amount'), '1');
    await user.type(awardsRegion.getByLabelText('Award note'), 'A hidden quest paid.');
    await user.click(awardsRegion.getByRole('button', { name: 'Add award' }));

    expect(lastCall('add_character_award')).toEqual({
      characterId: 'char-1',
      chapterId: 'n1',
      kind: 'stat',
      statName: 'Strength',
      amount: 1,
      note: 'A hidden quest paid.',
      user: 'You',
    });

    // The award applied itself, and the sheet was read back with the new number.
    expect(await awardsRegion.findByText('Strength +1')).toBeInTheDocument();
    expect(await screen.findByText('A hidden quest paid.')).toBeInTheDocument();
    expect(statRow('Strength')?.textContent).toContain('13');

    await user.click(awardsRegion.getByRole('button', { name: 'Delete' }));

    expect(lastCall('delete_character_award')).toMatchObject({ id: 'a-1', user: 'You' });
    expect(await awardsRegion.findByText(/No awards yet/)).toBeInTheDocument();
    expect(statRow('Strength')?.textContent).toContain('12');
  });

  it('pays an XP award into the chapter it happened in', async () => {
    const user = await openSheet();

    const awardsRegion = within(screen.getByRole('region', { name: 'Awards' }));

    await user.selectOptions(awardsRegion.getByLabelText('Award chapter'), 'n1');
    await user.type(awardsRegion.getByLabelText('Award amount'), '250');
    await user.click(awardsRegion.getByRole('button', { name: 'Add award' }));

    expect(lastCall('add_character_award')).toMatchObject({
      kind: 'xp',
      statName: null,
      amount: 250,
      chapterId: 'n1',
    });

    const ledger = within(screen.getByRole('region', { name: 'XP by chapter' }));
    expect(await ledger.findByText('250 XP earned')).toBeInTheDocument();
  });

  it('keeps the form open and says why when the save fails', async () => {
    const user = await openSheet();

    await user.click(within(sheet()).getByRole('button', { name: 'Edit rank' }));
    invokeMock.mockImplementationOnce(async () => {
      throw 'database is busy';
    });
    await user.click(within(sheet()).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/Could not save progression: database is busy/i)
    ).toBeInTheDocument();
    expect(within(sheet()).getByLabelText('Rank')).toBeInTheDocument();
  });

  it('does not carry a half-typed form over to another character', async () => {
    const user = await openSheet();

    await user.click(within(sheet()).getByRole('button', { name: 'Edit rank' }));
    const rank = within(sheet()).getByLabelText('Rank');
    await user.clear(rank);
    await user.type(rank, 'Silver');

    await user.click(screen.getByTitle("Show Wren's sheet"));

    expect(within(sheet()).getByRole('button', { name: 'Edit rank' })).toBeInTheDocument();
    expect(within(sheet()).queryByLabelText('Rank')).not.toBeInTheDocument();
    expect(within(sheet()).getByText('Unranked')).toBeInTheDocument();

    await user.click(within(sheet()).getByRole('button', { name: 'Edit rank' }));
    expect(within(sheet()).getByLabelText('Rank')).toHaveValue('');
    expect(lastCall('set_character_progress')).toBeUndefined();
  });
});
