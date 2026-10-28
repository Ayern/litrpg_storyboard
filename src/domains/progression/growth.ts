import type {
  CharacterLevelMilestone,
  LevelGrowthRule,
} from '../shared/types';
import type { LevelStatChangeDraft } from './drafts';

// What a level costs and hands out, read three ways: the story's rule, one
// character's override, and whichever of the two applies to a sheet.
//
// The two halves answer different questions. The step (`xp_base` and the
// `xp_growth` percentage) is arithmetic: the database turns a chapter's income
// into a level with it, and the helpers here do the same sum so a sheet can show
// the ladder without a round trip. The rest (the points to place and the rates)
// is what that level hands out, and the database writes it when the level lands.

// XP needed to climb from the level below to `level`.
export function levelXpCost(base: number, growth: number, level: number): number {
  if (level < 2) return 0;

  return base + Math.floor((base * growth * (level - 2)) / 100);
}

// Total XP a character stands on at `level`. Level 1 costs nothing.
export function levelXpThreshold(
  base: number,
  growth: number,
  level: number
): number {
  let total = 0;

  for (let rung = 2; rung <= Math.min(level, 999); rung += 1) {
    total += levelXpCost(base, growth, rung);
  }

  return total;
}

// The level a total buys.
export function levelForXp(base: number, growth: number, xp: number): number {
  let level = 1;

  while (level < 999 && xp >= levelXpThreshold(base, growth, level + 1)) {
    level += 1;
  }

  return level;
}

// The cost of a level as the rule states it: "700 XP a level" or "700 XP, 50%
// more each level".
export function xpStepText(rule: LevelGrowthRule | null): string {
  if (!rule) return 'no cost set';

  return rule.xp_growth > 0
    ? `${rule.xp_base} XP, ${rule.xp_growth}% more each level`
    : `${rule.xp_base} XP a level`;
}

export function storyGrowthRule(rules: LevelGrowthRule[]): LevelGrowthRule | null {
  return rules.find(rule => rule.character_id === null) ?? null;
}

export function characterGrowthRule(
  rules: LevelGrowthRule[],
  characterId: string | null
): LevelGrowthRule | null {
  if (!characterId) return null;

  return rules.find(rule => rule.character_id === characterId) ?? null;
}

// A character's own rule wins over the story's, because that is what an override
// is for. With neither, a level hands out nothing until the author says what it
// should.
export function effectiveGrowthRule(
  rules: LevelGrowthRule[],
  characterId: string | null
): LevelGrowthRule | null {
  return characterGrowthRule(rules, characterId) ?? storyGrowthRule(rules);
}

// The order milestones are compared in: the order they were recorded, which is
// the one the database keeps and the one the level itself follows.
function byRecorded(a: CharacterLevelMilestone, b: CharacterLevelMilestone): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

// The level a sheet stands at. It comes from the last level-up recorded, and a
// cast member with no level-up is at 1 — there is no other place to type it.
export function levelFromMilestones(
  milestones: CharacterLevelMilestone[],
  characterId: string | null
): number {
  if (!characterId) return 1;

  const own = milestones.filter(milestone => milestone.character_id === characterId);
  if (own.length === 0) return 1;

  const last = [...own].sort(byRecorded).pop();

  return last?.level ?? 1;
}

// The level the next level-up would record.
export function nextLevelFromMilestones(
  milestones: CharacterLevelMilestone[],
  characterId: string | null
): number {
  return levelFromMilestones(milestones, characterId) + 1;
}

// The stat rows a level-up form opens with: the stats this rule raises by
// itself. They stay drafts, so the author can change the number or remove the
// row before anything is recorded.
export function growthStatRows(
  rule: LevelGrowthRule | null
): LevelStatChangeDraft[] {
  if (!rule) return [];

  return rule.stats.map(rate => ({
    statName: rate.stat_name,
    // The form parses a signed whole number, so a plain "2" is what it wants;
    // the plus is for the sentence it shows back.
    amount: String(rate.per_level),
    valueAfter: '',
  }));
}

// The one-line description of a rule, used beside the sheet and in the level-up
// caption: "3 points to place · Strength +1, Insight +1".
export function growthRateText(rule: LevelGrowthRule | null): string {
  if (!rule) return 'No growth rule set';

  const parts: string[] = [xpStepText(rule)];

  if (rule.points_per_level > 0) {
    parts.push(
      `${rule.points_per_level} point${rule.points_per_level === 1 ? '' : 's'} to place per level`
    );
  } else {
    parts.push('no points to place');
  }

  if (rule.stats.length > 0) {
    parts.push(
      rule.stats
        .map(rate => `${rate.stat_name} ${rate.per_level > 0 ? '+' : ''}${rate.per_level}`)
        .join(', ')
    );
  }

  return parts.join(' · ');
}
