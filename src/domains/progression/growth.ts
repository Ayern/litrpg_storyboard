import type {
  CharacterLevelMilestone,
  LevelGrowthRule,
} from '../shared/types';
import type { LevelStatChangeDraft } from './drafts';

// What a level hands out, read three ways: the story's rule, one character's
// override, and whichever of the two applies to a sheet.
//
// The rule is a promise the app reads, never arithmetic it runs: nothing here
// moves a level, and a level-up still records only what the author wrote.

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

  const parts: string[] = [];

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
