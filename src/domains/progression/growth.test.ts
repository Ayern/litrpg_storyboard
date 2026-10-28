import { describe, it, expect } from 'vitest';

import type {
  CharacterLevel,
  LevelGrowthRule,
  LevelGrowthStat,
} from '../shared/types';
import {
  characterGrowthRule,
  effectiveGrowthRule,
  growthRateText,
  growthStatRows,
  levelForXp,
  levelXpCost,
  levelXpThreshold,
  xpStepText,
  levelFromMilestones,
  nextLevelFromMilestones,
  storyGrowthRule,
} from './growth';

const stamp = (minute: number) => `2026-10-22T12:${String(minute).padStart(2, '0')}:00Z`;

function rate(statName: string, perLevel: number): LevelGrowthStat {
  return {
    id: `rate-${statName}`,
    rule_id: 'rule',
    stat_name: statName,
    per_level: perLevel,
    created_at: stamp(0),
    updated_at: stamp(0),
  };
}

function rule(
  id: string,
  characterId: string | null,
  points: number,
  stats: LevelGrowthStat[] = []
): LevelGrowthRule {
  return {
    id,
    story_id: 'story-1',
    character_id: characterId,
    points_per_level: points,
    xp_base: 100,
    xp_growth: 0,
    stats,
    created_by: 'Ada',
    created_at: stamp(0),
    updated_at: stamp(0),
  };
}

function milestone(
  id: string,
  characterId: string,
  level: number,
  minute: number
): CharacterLevel {
  return {
    id,
    character_id: characterId,
    level,
    chapter_id: null,
    is_debuff: false,
    xp: null,
    stat_changes: [],
    created_at: stamp(minute),
    updated_at: stamp(minute),
  };
}

const story = rule('rule-story', null, 3, [rate('Strength', 1)]);
const override = rule('rule-rook', 'char-1', 1);

describe('the growth rule a sheet follows', () => {
  it('tells the story rule apart from a character’s override', () => {
    expect(storyGrowthRule([override, story])).toBe(story);
    expect(characterGrowthRule([override, story], 'char-1')).toBe(override);
    expect(characterGrowthRule([override, story], 'char-2')).toBeNull();
    expect(characterGrowthRule([override, story], null)).toBeNull();
  });

  it('prefers the override, falls back to the story, and has neither', () => {
    expect(effectiveGrowthRule([override, story], 'char-1')).toBe(override);
    expect(effectiveGrowthRule([override, story], 'char-2')).toBe(story);
    expect(effectiveGrowthRule([], 'char-1')).toBeNull();
  });
});

describe('the level a sheet stands at', () => {
  it('is 1 before any level-up is recorded', () => {
    expect(levelFromMilestones([], 'char-1')).toBe(1);
    expect(nextLevelFromMilestones([], 'char-1')).toBe(2);
  });

  it('comes from the last level-up written', () => {
    const milestones = [
      milestone('m-1', 'char-1', 3, 1),
      milestone('m-2', 'char-1', 4, 2),
      milestone('m-3', 'char-1', 3, 3),
    ];

    expect(levelFromMilestones(milestones, 'char-1')).toBe(3);
    expect(nextLevelFromMilestones(milestones, 'char-1')).toBe(4);
  });

  it('ignores another character’s level-ups', () => {
    const milestones = [milestone('m-1', 'char-1', 4, 1), milestone('m-2', 'char-2', 9, 2)];

    expect(levelFromMilestones(milestones, 'char-1')).toBe(4);
    expect(levelFromMilestones(milestones, 'char-2')).toBe(9);
  });

  it('breaks a tie on the id, so the answer does not depend on list order', () => {
    const first = milestone('m-a', 'char-1', 5, 1);
    const second = milestone('m-b', 'char-1', 6, 1);

    expect(levelFromMilestones([first, second], 'char-1')).toBe(6);
    expect(levelFromMilestones([second, first], 'char-1')).toBe(6);
  });
});

describe('the rows a level-up opens with', () => {
  it('turns each automatic rate into a draft row', () => {
    expect(storyStats()).toEqual([{ statName: 'Strength', amount: '1', valueAfter: '' }]);
  });

  it('keeps a negative rate as typed, and a plain number without a plus', () => {
    const cursed = rule('rule-story', null, 0, [rate('Luck', -2), rate('Agility', 2)]);

    expect(growthStatRows(cursed)).toEqual([
      { statName: 'Luck', amount: '-2', valueAfter: '' },
      { statName: 'Agility', amount: '2', valueAfter: '' },
    ]);
  });

  it('opens with no rows when there is no rule', () => {
    expect(growthStatRows(null)).toEqual([]);
  });
});

describe('the sentence a rule reads as', () => {
  it('names the cost, the points and the rates', () => {
    expect(growthRateText(story)).toBe(
      '100 XP a level · 3 points to place per level · Strength +1'
    );
  });

  it('says one point, not one points', () => {
    expect(growthRateText(override)).toBe('100 XP a level · 1 point to place per level');
  });

  it('is explicit about a rule that hands out nothing', () => {
    expect(growthRateText(rule('rule-empty', null, 0))).toBe(
      '100 XP a level · no points to place'
    );
    expect(growthRateText(null)).toBe('No growth rule set');
  });

  it('says when each level costs more than the last', () => {
    const climbing = { ...story, xp_base: 500, xp_growth: 50 };

    expect(xpStepText(climbing)).toBe('500 XP, 50% more each level');
  });
});

describe('the ladder a rule builds', () => {
  it('charges the same for every level when nothing grows', () => {
    expect(levelXpCost(100, 0, 2)).toBe(100);
    expect(levelXpCost(100, 0, 9)).toBe(100);
    expect(levelXpThreshold(100, 0, 4)).toBe(300);
  });

  it('charges more for each level when the rule grows', () => {
    expect(levelXpCost(100, 50, 3)).toBe(150);
    expect(levelXpThreshold(100, 50, 4)).toBe(450);
  });

  it('turns a total into the level it buys', () => {
    expect(levelForXp(100, 0, 0)).toBe(1);
    expect(levelForXp(100, 0, 99)).toBe(1);
    expect(levelForXp(100, 0, 100)).toBe(2);
    expect(levelForXp(100, 0, 250)).toBe(3);
    expect(levelForXp(700, 0, 2400)).toBe(4);
  });
});

function storyStats() {
  return growthStatRows(story);
}
