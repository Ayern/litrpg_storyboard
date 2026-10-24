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

let levels: LevelRow[] = [];
let progress: ProgressRow[] = [];

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
  const prior = levels
    .filter(entry => entry.character_id === characterId)
    .filter(entry => {
      const place = chapters.find(chapter => chapter.id === entry.chapter_id);
      return place != null && place.seq <= chapter.seq;
    })
    .sort((a, b) => {
      const left = chapters.find(entry => entry.id === a.chapter_id)!.seq;
      const right = chapters.find(entry => entry.id === b.chapter_id)!.seq;
      return left - right || a.created_at.localeCompare(b.created_at);
    });
  const latest = prior[prior.length - 1] ?? null;

  return {
    character_id: characterId,
    chapter_id: chapterId,
    chapter_seq: chapter.seq,
    level: latest?.level ?? null,
    level_milestone_id: latest?.id ?? null,
    level_is_penalty: latest?.is_debuff ?? false,
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

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return chapters.map(nodeRow);
      case 'get_graph_edges':
      case 'get_story_character_stats':
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
      case 'get_story_level_milestones':
        return levels.map(entry => ({ ...entry }));
      case 'get_story_character_progress':
        return progress.map(entry => ({ ...entry }));
      case 'get_character_progress':
        return progress
          .filter(entry => entry.character_id === args.characterId)
          .map(entry => ({ ...entry }));
      case 'get_character_level_milestones':
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
      invokeMock.mock.calls.some(call => call[0] === 'get_story_level_milestones')
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
    expect(rook.map(marker => marker.getAttribute('data-value'))).toEqual(['100', '900']);
    expect(wren.map(marker => marker.getAttribute('data-value'))).toEqual(['50', '700']);
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

  it('says what is missing when no character has a level milestone', async () => {
    levels = [];
    const { container } = await openCharacters();

    expect(
      await screen.findByText(
        "No level milestones yet — record one on a character's sheet."
      )
    ).toBeInTheDocument();
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(
      invokeMock.mock.calls.filter(
        call => call[0] === 'get_character_state_at_chapter'
      )
    ).toHaveLength(0);
  });
});
