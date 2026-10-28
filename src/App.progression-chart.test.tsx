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

interface LevelRow {
  id: string;
  character_id: string;
  level: number;
  chapter_id: string | null;
  is_debuff: boolean;
  xp?: number | null;
  stat_name?: string | null;
  stat_points?: number | null;
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

const cast: CastRow[] = [
  {
    id: 'char-1',
    story_id: story.id,
    name: 'Rook',
    description: null,
    level: 5,
    xp: 500,
    rank: 'Bronze',
    xp_to_next: 1000,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
  {
    id: 'char-2',
    story_id: story.id,
    name: 'Wren',
    description: null,
    level: 4,
    xp: 100,
    rank: null,
    xp_to_next: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
];

const chapters = [
  { id: 'n1', label: 'Chapter One', seq: 1 },
  { id: 'n2', label: 'Chapter Two', seq: 2 },
  { id: 'n3', label: 'Chapter Three', seq: 3 },
];

const nodeRow = (chapter: { id: string; label: string; seq: number }) => ({
  id: chapter.id,
  story_id: story.id,
  node_type: 'chapter',
  label: chapter.label,
  content: null,
  pos_x: 0,
  pos_y: 0,
  created_by: 'Ada',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  character_id: null,
  chapter_seq: chapter.seq,
});

interface StatRow {
  id: string;
  character_id: string;
  stat_name: string;
  value: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface InventoryRow {
  id: string;
  character_id: string;
  name: string;
  rarity: string | null;
  quantity: number;
  effect: string | null;
  chapter_id: string | null;
  lost_chapter_id: string | null;
  node_id: string | null;
  created_at: string;
  updated_at: string;
}

let levels: LevelRow[] = [];
let progress: ProgressRow[] = [];
// The sheet's rows today, which the expanded readout compares against the
// snapshot. The snapshot itself is worked out from the milestone and item
// ledgers, the way the database works it out.
let storyStats: Record<string, StatRow[]> = {};
let storyInventory: InventoryRow[] = [];

const stat = (characterId: string, name: string, value: number): StatRow => ({
  id: `stat-${characterId}-${name}`,
  character_id: characterId,
  stat_name: name,
  value,
  notes: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
});

const item = (
  id: string,
  characterId: string,
  name: string,
  quantity: number,
  rarity: string | null,
  chapterId: string | null,
  lostChapterId: string | null = null
): InventoryRow => ({
  id,
  character_id: characterId,
  name,
  rarity,
  quantity,
  effect: null,
  chapter_id: chapterId,
  lost_chapter_id: lostChapterId,
  node_id: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
});

const milestone = (
  id: string,
  characterId: string,
  level: number,
  chapterId: string | null,
  createdAt = '2026-10-22T12:00:00Z',
  xp: number | null = null,
  statName: string | null = null,
  statPoints: number | null = null
): LevelRow => ({
  id,
  character_id: characterId,
  level,
  chapter_id: chapterId,
  is_debuff: false,
  xp,
  stat_name: statName,
  stat_points: statPoints,
  created_at: createdAt,
  updated_at: createdAt,
});

function stateAt(characterId: string, chapterId: string) {
  const chapter = chapters.find(entry => entry.id === chapterId)!;
  const placeOf = (id: string | null) =>
    chapters.find(entry => entry.id === id) ?? null;
  const prior = levels
    .filter(entry => entry.character_id === characterId)
    .filter(entry => {
      const place = placeOf(entry.chapter_id);
      return place != null && place.seq <= chapter.seq;
    })
    .sort((a, b) => {
      const left = placeOf(a.chapter_id)!.seq;
      const right = placeOf(b.chapter_id)!.seq;
      return left - right || a.created_at.localeCompare(b.created_at);
    });
  const latest = prior[prior.length - 1] ?? null;

  // The last level-up that recorded a value for a stat is where it stood. The
  // sheet's own names join the list with no value, the way the database answers.
  const recorded = new Map<
    string,
    { value: number; chapterId: string; seq: number }
  >();

  for (const entry of prior) {
    if (!entry.stat_name || entry.stat_points == null) continue;

    recorded.set(entry.stat_name, {
      value: entry.stat_points,
      chapterId: entry.chapter_id as string,
      seq: placeOf(entry.chapter_id)!.seq,
    });
  }

  const names = [
    ...new Set([
      ...recorded.keys(),
      ...(storyStats[characterId] ?? []).map(row => row.stat_name),
    ]),
  ].sort((a, b) => a.localeCompare(b));

  const stats = names.map(name => {
    const hit = recorded.get(name);

    return {
      stat_name: name,
      value: hit?.value ?? null,
      recorded_chapter_id: hit?.chapterId ?? null,
      recorded_chapter_seq: hit?.seq ?? null,
    };
  });

  let undated = 0;
  const items = [];

  for (const row of storyInventory.filter(entry => entry.character_id === characterId)) {
    const gained = placeOf(row.chapter_id);

    if (!gained) {
      undated += 1;
      continue;
    }

    if (gained.seq > chapter.seq) continue;

    const lost = placeOf(row.lost_chapter_id);
    if (lost && lost.seq <= chapter.seq) continue;

    items.push({
      item_id: row.id,
      name: row.name,
      quantity: row.quantity,
      rarity: row.rarity,
      effect: row.effect,
      acquired_chapter_id: gained.id,
      acquired_chapter_seq: gained.seq,
    });
  }

  items.sort(
    (a, b) =>
      (a.acquired_chapter_seq ?? 0) - (b.acquired_chapter_seq ?? 0) ||
      a.name.localeCompare(b.name)
  );

  return {
    character_id: characterId,
    chapter_id: chapterId,
    chapter_seq: chapter.seq,
    level: latest?.level ?? null,
    level_record_id: latest?.id ?? null,
    level_is_penalty: latest?.is_debuff ?? false,
    level_chapter_id: latest?.chapter_id ?? null,
    level_chapter_seq: latest ? placeOf(latest.chapter_id)?.seq ?? null : null,
    stats,
    skills:
      characterId === 'char-1'
        ? [
            {
              skill_id: 'skill-1',
              name: 'Fireball',
              rank: chapter.seq >= 2 ? 'Rank 2' : 'Rank 1',
              effect: '3d6 fire',
              learned_chapter_id: 'n1',
              learned_chapter_seq: 1,
            },
          ]
        : [],
    items,
    undated_items: undated,
  };
}

beforeEach(() => {
  levels = [
    milestone('milestone-1', 'char-1', 3, 'n1', '2026-10-22T12:00:00Z', 100, 'Strength', 10),
    milestone('milestone-2', 'char-1', 5, 'n3', '2026-10-22T12:05:00Z', 900, 'Strength', 16),
    milestone('milestone-3', 'char-2', 2, 'n2', '2026-10-22T12:01:00Z', 50, 'Strength', 8),
    milestone('milestone-4', 'char-2', 4, 'n3', '2026-10-22T12:06:00Z', 700, 'Strength', 14),
    // Neither of these can be placed on the chapter spine.
    milestone('milestone-5', 'char-1', 9, null, '2026-10-22T12:07:00Z', 999, 'Strength', 99),
    milestone('milestone-6', 'char-1', 8, 'n4', '2026-10-22T12:08:00Z', 888, 'Strength', 88),
  ];

  progress = [
    {
      id: 'progress-1',
      character_id: 'char-1',
      chapter_id: 'n1',
      xp_earned: 100,
      created_at: '2026-10-22T12:02:00Z',
      updated_at: '2026-10-22T12:02:00Z',
    },
    {
      id: 'progress-2',
      character_id: 'char-1',
      chapter_id: 'n3',
      xp_earned: 300,
      created_at: '2026-10-22T12:03:00Z',
      updated_at: '2026-10-22T12:03:00Z',
    },
    {
      id: 'progress-3',
      character_id: 'char-2',
      chapter_id: 'n2',
      xp_earned: 50,
      created_at: '2026-10-22T12:04:00Z',
      updated_at: '2026-10-22T12:04:00Z',
    },
    {
      id: 'progress-4',
      character_id: 'char-2',
      chapter_id: 'n3',
      xp_earned: 250,
      created_at: '2026-10-22T12:05:00Z',
      updated_at: '2026-10-22T12:05:00Z',
    },
  ];

  storyStats = {
    'char-1': [stat('char-1', 'Strength', 16)],
    'char-2': [stat('char-2', 'Strength', 14)],
  };
  storyInventory = [
    item('item-1', 'char-1', 'Iron Sword', 2, 'Rare', 'n1', 'n3'),
    item('item-2', 'char-1', 'Ember Sigil', 1, null, 'n2'),
    // No chapter, so no place in the story to show it in.
    item('item-3', 'char-1', 'Cloak', 1, null, null),
  ];

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return chapters.map(nodeRow);
      case 'get_story_character_stats':
        return Object.values(storyStats).flat();
      case 'get_graph_edges':
      case 'get_character_stats':
      case 'get_character_attributes':
      case 'get_character_skills':
      case 'get_character_inventory':
      case 'get_character_currency':
      case 'get_story_skills':
      case 'get_story_skill_events':
      case 'get_story_inventory':
      case 'get_chapter_notes':
        return [];
      case 'get_characters':
        return args.storyId === story.id ? cast.map(entry => ({ ...entry })) : [];
      case 'get_story_levels':
        return levels.map(entry => ({ ...entry }));
      case 'get_story_character_progress':
        return progress.map(entry => ({ ...entry }));
      case 'get_character_progress':
        return progress
          .filter(entry => entry.character_id === args.characterId)
          .map(entry => ({ ...entry }));
      case 'get_character_levels':
        return levels
          .filter(entry => entry.character_id === args.characterId)
          .map(entry => ({ ...entry }));
      case 'get_character_state_at_chapter':
        return stateAt(args.characterId, args.chapterId);
      default:
        return null;
    }
  });
});

async function openCharacters() {
  const user = userEvent.setup();
  const view = render(<App />);

  await screen.findAllByText('Ledger');
  await screen.findByRole('button', { name: 'Chapter One' });
  await user.click(screen.getByRole('button', { name: 'Characters' }));

  return { user, ...view };
}

describe('per-character progression chart', () => {
  it('plots each character from the level milestones in chapter order', async () => {
    const { container } = await openCharacters();

    const chart = await screen.findByRole('img', {
      name: 'Character levels for Rook, Wren across 3 chapters in reading order',
    });
    expect(chart).toBeInTheDocument();

    const rook = [...container.querySelectorAll('[data-series="char-1"] .progression-chart-marker')];
    const wren = [...container.querySelectorAll('[data-series="char-2"] .progression-chart-marker')];

    expect(rook).toHaveLength(2);
    expect(wren).toHaveLength(2);
    expect(rook.map(marker => marker.getAttribute('data-chapter-id'))).toEqual(['n1', 'n3']);
    expect(rook.map(marker => marker.getAttribute('data-level'))).toEqual(['3', '5']);
    expect(wren.map(marker => marker.getAttribute('data-chapter-id'))).toEqual(['n2', 'n3']);
    expect(wren.map(marker => marker.getAttribute('data-level'))).toEqual(['2', '4']);

    // The points move left to right along the reading order, not by entry time.
    expect(Number(rook[0].getAttribute('cx'))).toBeLessThan(
      Number(rook[1].getAttribute('cx'))
    );

    // Milestones without a live chapter are not guessed onto the line.
    expect(container.querySelector('[data-chapter-id="n4"]')).toBeNull();
    expect(container.querySelector('[data-level="9"]')).toBeNull();

    expect(screen.getByText('Ch. 1')).toBeInTheDocument();
    expect(screen.getByText('Ch. 3')).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.some(call => call[0] === 'get_story_levels')
    ).toBe(true);
  });

  it('toggles compared characters without recolouring the rest', async () => {
    const { user, container } = await openCharacters();

    await screen.findByRole('img', {
      name: /Character levels for Rook, Wren/,
    });

    const wrenToggle = screen.getByRole('button', { name: 'Wren' });
    expect(wrenToggle).toHaveAttribute('aria-pressed', 'true');

    await user.click(wrenToggle);

    await waitFor(() => {
      expect(container.querySelector('[data-series="char-2"]')).toBeNull();
    });
    expect(wrenToggle).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.getByRole('img', { name: /Character levels for Rook across 3 chapters/ })
    ).toBeInTheDocument();
    expect(container.querySelector('[data-series="char-1"]')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rook' }));

    expect(
      await screen.findByText('Choose a character above to show a level line.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Character levels/ })).toBeNull();
  });

  it('reads each selected character as of the chosen chapter', async () => {
    const { user } = await openCharacters();

    const select = await screen.findByLabelText('Chapter state');
    expect(select).toHaveValue('n3');

    const last = await screen.findByLabelText('Character state at Chapter Three');
    expect(within(last).getByText('Rook')).toBeInTheDocument();
    expect(within(last).getByText('Level 5')).toBeInTheDocument();
    expect(within(last).getByText('Fireball (Rank 2)')).toBeInTheDocument();
    expect(within(last).getByText('Wren')).toBeInTheDocument();
    expect(within(last).getByText('Level 4')).toBeInTheDocument();
    expect(within(last).getByText('No active skills')).toBeInTheDocument();

    await user.selectOptions(select, 'n1');

    const opening = await screen.findByLabelText('Character state at Chapter One');
    expect(within(opening).getByText('Level 3')).toBeInTheDocument();
    expect(within(opening).getByText('Fireball (Rank 1)')).toBeInTheDocument();
    expect(within(opening).getByText('No level recorded')).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.some(
        call =>
          call[0] === 'get_character_state_at_chapter' &&
          (call[1] as Record<string, any>).chapterId === 'n1'
      )
    ).toBe(true);
  });

  it('switches the y-axis to total XP', async () => {
    const { user, container } = await openCharacters();

    await screen.findByRole('img', { name: /Character levels for Rook, Wren/ });
    const xpButton = screen.getByRole('button', { name: 'Total XP' });
    expect(xpButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(xpButton);

    const chart = await screen.findByRole('img', {
      name: 'Character XP for Rook, Wren across 3 chapters in reading order',
    });
    expect(chart).toHaveAttribute('data-metric', 'xp');
    expect(xpButton).toHaveAttribute('aria-pressed', 'true');

    const rook = [...container.querySelectorAll('[data-series="char-1"] .progression-chart-marker')];
    const wren = [...container.querySelectorAll('[data-series="char-2"] .progression-chart-marker')];
    // The total plotted is the step the rule puts that level on, not the number
    // a hand-written row happened to record.
    expect(rook.map(marker => marker.getAttribute('data-value'))).toEqual(['200', '400']);
    expect(wren.map(marker => marker.getAttribute('data-value'))).toEqual(['100', '300']);
    expect(rook.map(marker => marker.getAttribute('data-level'))).toEqual(['3', '5']);
  });

  it('plots one chosen primary stat per chapter', async () => {
    const { user, container } = await openCharacters();

    await screen.findByRole('img', { name: /Character levels for Rook, Wren/ });
    await user.click(screen.getByRole('button', { name: 'Stats' }));

    expect(await screen.findByLabelText('Stat to plot')).toHaveValue('Strength');
    const chart = await screen.findByRole('img', {
      name: 'Strength for Rook, Wren across 3 chapters in reading order',
    });
    expect(chart).toHaveAttribute('data-metric', 'stat');

    const rook = [...container.querySelectorAll('[data-series="char-1"] .progression-chart-marker')];
    expect(rook.map(marker => marker.getAttribute('data-value'))).toEqual(['10', '16']);
    expect(rook[0]).toHaveAttribute('data-metric', 'stat');
  });

  it('plots XP earned in each chapter as bars, not a carried-forward total', async () => {
    const { user, container } = await openCharacters();

    await screen.findByRole('img', { name: /Character levels for Rook, Wren/ });
    await user.click(screen.getByRole('button', { name: 'XP earned' }));

    const chart = await screen.findByRole('img', {
      name: 'XP earned for Rook, Wren across 3 chapters in reading order',
    });
    expect(chart).toHaveAttribute('data-metric', 'earned');
    expect(container.querySelector('.progression-chart-line')).toBeNull();

    const rook = [
      ...container.querySelectorAll('[data-series="char-1"] .progression-chart-bar'),
    ];
    const wren = [
      ...container.querySelectorAll('[data-series="char-2"] .progression-chart-bar'),
    ];

    expect(rook.map(bar => bar.getAttribute('data-chapter-id'))).toEqual(['n1', 'n3']);
    expect(rook.map(bar => bar.getAttribute('data-value'))).toEqual(['100', '300']);
    expect(wren.map(bar => bar.getAttribute('data-chapter-id'))).toEqual(['n2', 'n3']);
    expect(wren.map(bar => bar.getAttribute('data-value'))).toEqual(['50', '250']);

    // A bar is the income for its own chapter; a missing chapter is not
    // backfilled with the last amount.
    expect(rook).toHaveLength(2);
    expect(wren).toHaveLength(2);
  });

  it('includes a character with XP income but no level milestone', async () => {
    levels = levels.filter(entry => entry.character_id === 'char-1');
    const { user, container } = await openCharacters();

    await screen.findByRole('img', { name: /Character levels for Rook/ });
    await user.click(screen.getByRole('button', { name: 'XP earned' }));

    const chart = await screen.findByRole('img', {
      name: 'XP earned for Rook, Wren across 3 chapters in reading order',
    });
    expect(chart).toHaveAttribute('data-metric', 'earned');

    const wren = [
      ...container.querySelectorAll('[data-series="char-2"] .progression-chart-bar'),
    ];
    expect(wren.map(bar => bar.getAttribute('data-value'))).toEqual(['50', '250']);
  });

  it('explains when the XP-by-chapter ledger is empty', async () => {
    progress = [];
    const { user } = await openCharacters();

    await screen.findByRole('img', { name: /Character levels for Rook, Wren/ });
    await user.click(screen.getByRole('button', { name: 'XP earned' }));

    expect(
      await screen.findByText(
        'No XP earned by chapter yet — record it on a character\'s sheet.'
      )
    ).toBeInTheDocument();
  });

  it('says what is missing when no character has a level', async () => {
    levels = [];
    progress = [];
    const { container } = await openCharacters();

    expect(
      await screen.findByText(
        "No progression recorded yet — add a level milestone or XP earned on a character's sheet."
      )
    ).toBeInTheDocument();
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(
      invokeMock.mock.calls.filter(
        call => call[0] === 'get_character_state_at_chapter'
      )
    ).toHaveLength(0);
  });

  it('opens a character\'s whole sheet as of the chosen chapter', async () => {
    // Agility is on the sheet today but no level-up has recorded a value for it,
    // and Strength has moved on since the chapter being read.
    storyStats = {
      'char-1': [stat('char-1', 'Strength', 18), stat('char-1', 'Agility', 12)],
      'char-2': [stat('char-2', 'Strength', 14)],
    };
    const { user } = await openCharacters();

    const last = await screen.findByLabelText('Character state at Chapter Three');
    const rookRow = within(last).getByText('Rook').closest('li') as HTMLElement;
    const toggle = within(rookRow).getByRole('button', { name: 'Read sheet' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'chapter-snapshot-char-1');

    const sheet = await screen.findByLabelText("Rook's sheet at Chapter Three");
    expect(
      within(sheet).getByText('Level 5 · recorded in Ch. 3')
    ).toBeInTheDocument();

    const strength = sheet.querySelector(
      '[data-snapshot-stat="Strength"]'
    ) as HTMLElement;
    expect(within(strength).getByText('16')).toBeInTheDocument();
    expect(within(strength).getByText('Ch. 3')).toBeInTheDocument();
    expect(within(strength).getByText('now 18')).toBeInTheDocument();

    const agility = sheet.querySelector(
      '[data-snapshot-stat="Agility"]'
    ) as HTMLElement;
    expect(within(agility).getByText('—')).toBeInTheDocument();
    expect(within(agility).getByText('no value yet')).toBeInTheDocument();
    expect(within(agility).getByText('now 12')).toBeInTheDocument();

    const fireball = sheet.querySelector(
      '[data-snapshot-skill="Fireball"]'
    ) as HTMLElement;
    expect(within(fireball).getByText('Rank 2')).toBeInTheDocument();
    expect(within(fireball).getByText('learned in Ch. 1')).toBeInTheDocument();
    expect(within(fireball).getByText('3d6 fire')).toBeInTheDocument();

    // The sigil was gained in the second chapter and the sword was lost in this
    // one, so only the sigil is still carried at the end of it.
    expect(sheet.querySelector('[data-snapshot-item="Ember Sigil"]')).not.toBeNull();
    expect(sheet.querySelector('[data-snapshot-item="Iron Sword"]')).toBeNull();
    expect(
      within(sheet).getByText(
        'One more item has no chapter, so it cannot be placed in the story.'
      )
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Chapter state'), 'n1');

    const opening = await screen.findByLabelText("Rook's sheet at Chapter One");
    const earlier = opening.querySelector(
      '[data-snapshot-stat="Strength"]'
    ) as HTMLElement;
    expect(within(earlier).getByText('10')).toBeInTheDocument();
    expect(within(earlier).getByText('Ch. 1')).toBeInTheDocument();
    expect(within(opening).getByText('Fireball')).toBeInTheDocument();

    const carried = opening.querySelector(
      '[data-snapshot-item="Iron Sword"]'
    ) as HTMLElement;
    expect(within(carried).getByText('Iron Sword ×2')).toBeInTheDocument();
    expect(within(carried).getByText('Rare')).toBeInTheDocument();
    expect(within(carried).getByText('gained in Ch. 1')).toBeInTheDocument();
    expect(opening.querySelector('[data-snapshot-item="Ember Sigil"]')).toBeNull();
  });

  it('collapses the whole sheet again from the same button', async () => {
    const { user } = await openCharacters();

    const last = await screen.findByLabelText('Character state at Chapter Three');
    const rookRow = within(last).getByText('Rook').closest('li') as HTMLElement;

    await user.click(within(rookRow).getByRole('button', { name: 'Read sheet' }));
    expect(
      await screen.findByLabelText("Rook's sheet at Chapter Three")
    ).toBeInTheDocument();

    await user.click(within(rookRow).getByRole('button', { name: 'Hide sheet' }));

    expect(screen.queryByLabelText("Rook's sheet at Chapter Three")).toBeNull();
    expect(within(rookRow).getByRole('button', { name: 'Read sheet' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('says what a sheet held when the ledgers have nothing for it yet', async () => {
    storyStats = {};
    storyInventory = [];
    const { user } = await openCharacters();

    // Wren's first milestone lands in the second chapter, so the opening reads
    // as a sheet the story has recorded nothing about yet.
    await user.selectOptions(await screen.findByLabelText('Chapter state'), 'n1');

    const last = await screen.findByLabelText('Character state at Chapter One');
    const wrenRow = within(last).getByText('Wren').closest('li') as HTMLElement;

    await user.click(within(wrenRow).getByRole('button', { name: 'Read sheet' }));

    const sheet = await screen.findByLabelText("Wren's sheet at Chapter One");
    expect(
      within(sheet).getByText('No level recorded by this chapter')
    ).toBeInTheDocument();
    expect(within(sheet).getByText('No stats by this chapter.')).toBeInTheDocument();
    expect(
      within(sheet).getByText('No skills learned by this chapter.')
    ).toBeInTheDocument();
    expect(
      within(sheet).getByText('Nothing recorded as carried by this chapter.')
    ).toBeInTheDocument();
  });

  it('marks a stat the sheet has since dropped instead of hiding it', async () => {
    storyStats = {};
    const { user } = await openCharacters();

    const last = await screen.findByLabelText('Character state at Chapter Three');
    const rookRow = within(last).getByText('Rook').closest('li') as HTMLElement;

    await user.click(within(rookRow).getByRole('button', { name: 'Read sheet' }));

    const sheet = await screen.findByLabelText("Rook's sheet at Chapter Three");
    const strength = sheet.querySelector(
      '[data-snapshot-stat="Strength"]'
    ) as HTMLElement;

    expect(within(strength).getByText('16')).toBeInTheDocument();
    expect(within(strength).getByText('not on the sheet now')).toBeInTheDocument();
  });
});
