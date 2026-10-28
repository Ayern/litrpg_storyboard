import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  Character,
  CharacterLevelMilestone,
  CharacterLevelStatChange,
  CharacterProgress,
  CharacterStat,
} from '../shared/types';
import type { ChapterNode } from '../narrative/chapters';
import type { CharacterChapterState } from '../narrative/types';
import type { CharacterSkillEvent } from '../skills/types';
import { useProgressionChart } from './useProgressionChart';
import type { ProgressionChartOptions } from './useProgressionChart';

// The chart holds what it is plotting and what it is reading: the metric, the
// stat a line follows, the cast members hidden from the comparison, and the
// snapshot of one chapter. The story's rows arrive as arguments, so these tests
// move them the way the app does; the one command the readout runs is mocked.

const { progressionApi } = vi.hoisted(() => ({
  progressionApi: { getCharacterStateAtChapter: vi.fn() },
}));

vi.mock('./api', () => progressionApi);

function character(id: string, name: string): Character {
  return {
    id,
    story_id: 'story-1',
    name,
    description: null,
    level: 1,
    xp: 0,
    rank: null,
    xp_to_next: null,
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
  };
}

function chapter(id: string, label: string, seq: number | null): ChapterNode {
  return {
    id,
    type: 'default',
    position: { x: 0, y: 0 },
    data: {
      label,
      nodeType: 'chapter',
      createdBy: 'author',
      chapterSeq: seq,
    },
  };
}

function statChange(statName: string, valueAfter: number | null): CharacterLevelStatChange {
  return {
    id: `change-${statName}-${valueAfter}`,
    milestone_id: '',
    stat_name: statName,
    amount: valueAfter,
    value_after: valueAfter,
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
  };
}

function milestone(
  id: string,
  characterId: string,
  level: number,
  chapterId: string | null,
  xp: number | null,
  changes: CharacterLevelStatChange[] = []
): CharacterLevelMilestone {
  return {
    id,
    character_id: characterId,
    level,
    chapter_id: chapterId,
    is_debuff: false,
    xp,
    stat_changes: changes,
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
  };
}

function income(id: string, characterId: string, chapterId: string, xpEarned: number): CharacterProgress {
  return {
    id,
    character_id: characterId,
    chapter_id: chapterId,
    xp_earned: xpEarned,
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
  };
}

function stat(id: string, characterId: string, statName: string, value: number): CharacterStat {
  return {
    id,
    character_id: characterId,
    stat_name: statName,
    value,
    notes: null,
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
  };
}

function chapterState(characterId: string, chapterId: string, level: number | null) {
  return {
    character_id: characterId,
    chapter_id: chapterId,
    chapter_seq: 1,
    level,
    level_milestone_id: null,
    level_is_penalty: false,
    level_chapter_id: null,
    level_chapter_seq: null,
    stats: [],
    skills: [],
    items: [],
    undated_items: 0,
  } satisfies CharacterChapterState;
}

const mira = character('ch-1', 'Mira');
const rook = character('ch-2', 'Rook');
const sereth = character('ch-3', 'Sereth');

const gate = chapter('c-1', 'The Gate', 1);
const vault = chapter('c-2', 'The Vault', 2);
const unwritten = chapter('c-3', 'Unwritten', null);

const milestones = [
  milestone('m-1', 'ch-1', 2, 'c-1', 100, [statChange('Strength', 12)]),
  milestone('m-2', 'ch-1', 3, 'c-2', 250, [statChange('Strength', 13)]),
  milestone('m-3', 'ch-2', 2, 'c-1', null),
  milestone('m-5', 'ch-2', 3, 'c-2', null, [statChange('Agility', 9)]),
  // A milestone whose chapter is in the trash cannot place a point.
  milestone('m-4', 'ch-1', 4, 'c-9', 400, []),
];

const progress = [income('p-1', 'ch-3', 'c-2', 50)];

const castStats: Record<string, CharacterStat[]> = {
  'ch-1': [stat('s-1', 'ch-1', 'Strength', 13)],
  'ch-3': [stat('s-2', 'ch-3', 'Agility', 9)],
};

const board: ProgressionChartOptions = {
  characters: [mira, rook, sereth],
  milestones,
  progress,
  chapterNodes: [gate, vault, unwritten],
  castStats,
  active: true,
  storyId: 'story-1',
  skillEvents: [],
};

function setup(overrides: Partial<ProgressionChartOptions> = {}) {
  const options: ProgressionChartOptions = { ...board, ...overrides };
  const view = renderHook((props: ProgressionChartOptions) => useProgressionChart(props), {
    initialProps: options,
  });

  return view;
}

beforeEach(() => {
  progressionApi.getCharacterStateAtChapter.mockReset();
  progressionApi.getCharacterStateAtChapter.mockImplementation(
    async (characterId: string, chapterId: string) =>
      chapterState(characterId, chapterId, characterId === 'ch-1' ? 3 : null)
  );
});

describe('the lines the chart draws', () => {
  it('draws one line per cast member who has a milestone or income', () => {
    const { result } = setup();

    const lines = result.current.chartSeries;
    expect(lines.map(line => line.characterId)).toEqual(['ch-1', 'ch-2', 'ch-3']);

    // The milestone in a chapter that is not on the board is left out rather
    // than guessed at.
    expect(lines[0].milestones.map(row => row.id)).toEqual(['m-1', 'm-2']);
    expect(lines[2].progress.map(row => row.id)).toEqual(['p-1']);
  });

  it('leaves out a cast member with nothing to plot', () => {
    const { result } = setup({
      characters: [...board.characters, character('ch-4', 'Nadia')],
    });

    expect(result.current.chartSeries.map(line => line.characterId)).toEqual([
      'ch-1',
      'ch-2',
      'ch-3',
    ]);
  });

  it('gives neighbouring lines different colours', () => {
    const { result } = setup();

    const [first, second] = result.current.chartSeries;
    expect(first.color).toBeTruthy();
    expect(second.color).not.toBe(first.color);
  });
});

describe('choosing what to plot', () => {
  it('plots levels by default', () => {
    const { result } = setup();

    expect(result.current.chartMetric).toBe('level');
    expect(result.current.chartMetricSeries.map(line => line.characterId)).toEqual([
      'ch-1',
      'ch-2',
    ]);
  });

  it('plots only the lines with a recorded XP when XP is chosen', () => {
    const { result } = setup();

    act(() => result.current.setChartMetric('xp'));

    expect(result.current.chartMetricSeries.map(line => line.characterId)).toEqual(['ch-1']);
  });

  it('plots the income ledger when earned XP is chosen', () => {
    const { result } = setup();

    act(() => result.current.setChartMetric('earned'));

    expect(result.current.chartMetricSeries.map(line => line.characterId)).toEqual(['ch-3']);
  });

  it('lists the stat names the sheets and the milestones offer, in order', () => {
    const { result } = setup();

    expect(result.current.statNameOptions).toEqual(['Agility', 'Strength']);
  });

  it('draws a stat name that only a milestone recorded', () => {
    const { result } = setup({
      castStats: {},
      milestones: [milestone('m-9', 'ch-1', 2, 'c-1', 10, [statChange('Luck', 4)])],
      progress: [],
    });

    expect(result.current.statNameOptions).toEqual(['Luck']);
  });

  it('falls back to the first stat when the stat metric is chosen', () => {
    const { result } = setup();

    expect(result.current.chartStatName).toBe('');

    act(() => result.current.setChartMetric('stat'));

    expect(result.current.chartStatName).toBe('Agility');
  });

  it('keeps a chosen stat that is still offered', () => {
    const { result } = setup();

    act(() => result.current.setChartMetric('stat'));
    act(() => result.current.setChartStatName('Strength'));

    expect(result.current.chartStatName).toBe('Strength');
  });

  it('moves to the first stat when the chosen one is gone', () => {
    const { result, rerender } = setup();

    act(() => result.current.setChartMetric('stat'));
    act(() => result.current.setChartStatName('Strength'));

    // The sheet's stat is renamed, so the honour no longer exists.
    rerender({
      ...board,
      castStats: { 'ch-1': [stat('s-1', 'ch-1', 'Power', 13)] },
      milestones: [],
    });

    expect(result.current.chartStatName).toBe('Power');
  });

  it('plots the chosen stat against the value a level-up left it at', () => {
    const { result } = setup();

    act(() => result.current.setChartMetric('stat'));
    act(() => result.current.setChartStatName('Strength'));

    // Only Mira's milestones recorded Strength, and both of hers did.
    expect(result.current.chartMetricSeries.map(line => line.characterId)).toEqual(['ch-1']);

    // The other stat belongs to Rook alone, so the lines are the other way round.
    act(() => result.current.setChartStatName('Agility'));
    expect(result.current.chartMetricSeries.map(line => line.characterId)).toEqual(['ch-2']);
  });

  it('plots nothing for a stat no line recorded', () => {
    const { result } = setup({
      castStats: { 'ch-1': [stat('s-1', 'ch-1', 'Luck', 13)] },
      milestones: [],
    });

    act(() => result.current.setChartMetric('stat'));
    act(() => result.current.setChartStatName('Luck'));

    expect(result.current.chartMetricSeries).toEqual([]);
  });
});

describe('hiding a line', () => {
  it('takes a cast member out of both the metric and the comparison set', () => {
    const { result } = setup();

    act(() => result.current.toggleChartCharacter('ch-2'));

    expect(result.current.hiddenChartCharacterIds).toEqual(['ch-2']);
    expect(result.current.visibleChartSeries.map(line => line.characterId)).toEqual(['ch-1']);
    expect(result.current.visibleComparisonSeries.map(line => line.characterId)).toEqual([
      'ch-1',
    ]);
  });

  it('puts it back when it is toggled again', () => {
    const { result } = setup();

    act(() => result.current.toggleChartCharacter('ch-1'));
    act(() => result.current.toggleChartCharacter('ch-2'));
    act(() => result.current.toggleChartCharacter('ch-1'));

    expect(result.current.hiddenChartCharacterIds).toEqual(['ch-2']);
    expect(result.current.visibleChartSeries.map(line => line.characterId)).toEqual(['ch-1']);
  });

  it('keeps a line hidden when the metric changes', () => {
    const { result } = setup();

    act(() => result.current.toggleChartCharacter('ch-3'));
    act(() => result.current.setChartMetric('earned'));

    // Sereth is the only line with income, and she is the one hidden.
    expect(result.current.visibleChartSeries).toEqual([]);

    act(() => result.current.setChartMetric('level'));

    expect(result.current.visibleChartSeries.map(line => line.characterId)).toEqual([
      'ch-1',
      'ch-2',
    ]);
  });
});

describe('the chapter readout', () => {
  it('offers only the chapters the reading order can place', () => {
    const { result } = setup();

    expect(result.current.chartStateChapters.map(row => row.id)).toEqual(['c-1', 'c-2']);
  });

  it('starts at the last placed chapter', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.chartStateChapterId).toBe('c-2'));
  });

  it('keeps the chosen chapter while it is still placed', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.chartStateChapterId).toBe('c-2'));
    act(() => result.current.setChartStateChapterId('c-1'));

    expect(result.current.chartStateChapterId).toBe('c-1');
    expect(result.current.chartStateChapter?.id).toBe('c-1');
  });

  it('moves to the last placed chapter when the chosen one is gone', async () => {
    const { result, rerender } = setup();

    await waitFor(() => expect(result.current.chartStateChapterId).toBe('c-2'));
    act(() => result.current.setChartStateChapterId('c-1'));

    rerender({ ...board, chapterNodes: [vault] });

    await waitFor(() => expect(result.current.chartStateChapterId).toBe('c-2'));
  });

  it('asks for every visible cast member at the chosen chapter', async () => {
    const { result } = setup();

    await waitFor(() =>
      expect(progressionApi.getCharacterStateAtChapter).toHaveBeenCalledTimes(2)
    );
    expect(progressionApi.getCharacterStateAtChapter).toHaveBeenCalledWith('ch-1', 'c-2');
    expect(progressionApi.getCharacterStateAtChapter).toHaveBeenCalledWith('ch-2', 'c-2');
    // Sereth has income but no milestone, so the comparison set leaves her out.
    expect(progressionApi.getCharacterStateAtChapter).not.toHaveBeenCalledWith(
      'ch-3',
      expect.anything()
    );
  });

  it('maps the answers by cast member and leaves out the ones that came back empty', async () => {
    progressionApi.getCharacterStateAtChapter.mockImplementation(
      async (characterId: string, chapterId: string) =>
        characterId === 'ch-2' ? null : chapterState(characterId, chapterId, 3)
    );
    const { result } = setup();

    await waitFor(() => expect(result.current.chartStateLoading).toBe(false));

    expect([...result.current.chartStateById.keys()]).toEqual(['ch-1']);
    expect(result.current.chartStateById.get('ch-1')?.level).toBe(3);
  });

  it('says why a read failed, and keeps nothing from it', async () => {
    progressionApi.getCharacterStateAtChapter.mockRejectedValue('the ledger is locked');
    const { result } = setup();

    await waitFor(() => expect(result.current.chartStateError).toBe('the ledger is locked'));

    expect(result.current.chartStateLoading).toBe(false);
    expect(result.current.chartStateById.size).toBe(0);
  });

  it('reads the comparison set rather than the plotted one', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.chartStateLoading).toBe(false));
    // XP is plotted for Mira alone, so the plotted set is the narrower one.
    act(() => result.current.setChartMetric('xp'));
    progressionApi.getCharacterStateAtChapter.mockClear();

    act(() => result.current.setChartStateChapterId('c-1'));

    await waitFor(() =>
      expect(progressionApi.getCharacterStateAtChapter).toHaveBeenCalledWith('ch-2', 'c-1')
    );
    expect(progressionApi.getCharacterStateAtChapter).not.toHaveBeenCalledWith(
      'ch-3',
      expect.anything()
    );
  });

  it('asks nothing while another tab is showing, and drops what it had', async () => {
    const { result, rerender } = setup();

    await waitFor(() => expect(result.current.chartStateById.size).toBeGreaterThan(0));
    progressionApi.getCharacterStateAtChapter.mockClear();

    rerender({ ...board, active: false });

    expect(result.current.chartStateById.size).toBe(0);
    expect(result.current.chartStateLoading).toBe(false);
    expect(result.current.chartStateError).toBeNull();
    expect(progressionApi.getCharacterStateAtChapter).not.toHaveBeenCalled();
  });

  it('reads again when a skill edit lands', async () => {
    const { result, rerender } = setup();

    await waitFor(() => expect(result.current.chartStateLoading).toBe(false));
    const before = progressionApi.getCharacterStateAtChapter.mock.calls.length;

    rerender({
      ...board,
      skillEvents: [
        {
          id: 'ev-1',
          skill_id: 'sk-1',
          kind: 'upgraded',
          rank: null,
          chapter_id: 'c-2',
          created_at: '2026-10-20T09:00:00Z',
          updated_at: '2026-10-20T09:00:00Z',
        },
      ],
    });

    await waitFor(() =>
      expect(progressionApi.getCharacterStateAtChapter.mock.calls.length).toBeGreaterThan(before)
    );
  });

  it('asks nothing when no chapter can be placed', async () => {
    const { result } = setup({ chapterNodes: [unwritten] });

    await waitFor(() => expect(result.current.chartStateLoading).toBe(false));

    expect(result.current.chartStateChapterId).toBe('');
    expect(progressionApi.getCharacterStateAtChapter).not.toHaveBeenCalled();
  });
});
