import { describe, expect, it } from 'vitest';
import type { ChapterNode } from '../narrative/chapters';
import type {
  CharacterLevelMilestone,
  CharacterProgress,
  LevelGrowthRule,
} from '../shared/types';
import { crossingMilestones, levelCrossingsFor } from './crossings';

function chapter(id: string, seq: number | null): ChapterNode {
  return {
    id,
    type: 'chapter',
    position: { x: 0, y: 0 },
    data: { label: id, nodeType: 'chapter', createdBy: 'author', chapterSeq: seq },
  };
}

function income(id: string, chapterId: string, xp: number, at: string): CharacterProgress {
  return {
    id,
    character_id: 'c-1',
    chapter_id: chapterId,
    xp_earned: xp,
    created_at: at,
    updated_at: at,
  };
}

function milestone(
  id: string,
  level: number,
  chapterId: string | null,
  xp: number | null
): CharacterLevelMilestone {
  return {
    id,
    character_id: 'c-1',
    level,
    chapter_id: chapterId,
    is_debuff: false,
    xp,
    stat_changes: [],
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
  };
}

const rule: LevelGrowthRule = {
  id: 'rule-1',
  story_id: 'story-1',
  character_id: null,
  points_per_level: 0,
  xp_base: 700,
  xp_growth: 0,
  stats: [],
  created_by: 'Ada',
  created_at: '2026-10-20T09:00:00Z',
  updated_at: '2026-10-20T09:00:00Z',
};

const chapters = [chapter('c-3', 3), chapter('c-1', 1), chapter('c-2', 2)];

describe('the curve’s crossings', () => {
  it('places each level in the chapter whose income carried it over the step', () => {
    const crossings = levelCrossingsFor(
      'c-1',
      [income('p-1', 'c-1', 600, '2026-10-20T09:00:00Z'), income('p-2', 'c-2', 900, '2026-10-20T09:10:00Z')],
      [],
      rule,
      chapters
    );

    expect(crossings.map(entry => [entry.level, entry.xp, entry.chapterId])).toEqual([
      [2, 700, 'c-2'],
      [3, 1400, 'c-2'],
    ]);
  });

  it('counts a chapter with no place after every placed one', () => {
    const crossings = levelCrossingsFor(
      'c-1',
      [
        income('p-1', 'c-9', 700, '2026-10-20T08:00:00Z'),
        income('p-2', 'c-1', 700, '2026-10-20T09:00:00Z'),
      ],
      [],
      rule,
      chapters
    );

    expect(crossings.map(entry => entry.chapterId)).toEqual(['c-1', 'c-9']);
  });

  it('uses the effective rule, so a growth percentage lifts the later steps', () => {
    const crossings = levelCrossingsFor(
      'c-1',
      [income('p-1', 'c-1', 3200, '2026-10-20T09:00:00Z')],
      [],
      { ...rule, xp_growth: 50 },
      chapters
    );

    // 700, then 1,050 more, then 1,400 more.
    expect(crossings.map(entry => entry.xp)).toEqual([700, 1750, 3150]);
  });

  it('keeps a level recorded above the ledger as a floor, with the rule’s step', () => {
    const crossings = levelCrossingsFor(
      'c-1',
      [income('p-1', 'c-1', 100, '2026-10-20T09:00:00Z')],
      [milestone('m-1', 6, 'c-2', 9000)],
      rule,
      chapters
    );

    expect(crossings).toHaveLength(1);
    expect(crossings[0]).toMatchObject({
      level: 6,
      xp: 3500,
      chapterId: 'c-2',
      recordedMilestoneId: 'm-1',
    });
  });

  it('keeps the chapter the author recorded for a level the ledger also reached', () => {
    const crossings = levelCrossingsFor(
      'c-1',
      [income('p-1', 'c-1', 800, '2026-10-20T09:00:00Z')],
      [milestone('m-1', 2, 'c-3', 700)],
      rule,
      chapters
    );

    expect(crossings[0]).toMatchObject({ level: 2, chapterId: 'c-3' });
    expect(crossings[0].recordedMilestoneId).toBe('m-1');
  });

  it('draws a crossing at the rule’s step, whatever the row recorded', () => {
    const crossings = levelCrossingsFor(
      'c-1',
      [],
      [milestone('m-1', 3, 'c-1', 999)],
      rule,
      chapters
    );

    expect(crossingMilestones('c-1', crossings)[0]).toMatchObject({
      id: 'm-1',
      level: 3,
      xp: 1400,
      chapter_id: 'c-1',
    });
  });

  it('leaves a cast member with no income and no rows with no line', () => {
    expect(levelCrossingsFor('c-2', [], [], rule, chapters)).toEqual([]);
  });
});
