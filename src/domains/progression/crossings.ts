import type { ChapterNode } from '../narrative/chapters';
import type {
  Character,
  CharacterLevel,
  CharacterProgress,
  LevelGrowthRule,
} from '../shared/types';
import { effectiveGrowthRule, levelXpThreshold } from './growth';

// Where the level curve was crossed: one entry per level the experience has
// bought, in the chapter whose income carried the total over the step.
//
// This is the curve's own answer, worked out from the ledger and the rule the
// same way the database works it out, so the timeline, the chart and the
// continuity check stop reading a level out of the rows. A row the author
// recorded keeps its place — it says where a level was reached when the ledger
// alone cannot, and a level recorded above the ledger's reach is a floor — but
// it does not decide what the level costs.

// The database levels a story that has written no rule at all on this step, so a
// reader that has to work the curve out for itself has to start from the same
// number or it would draw a ladder nobody walks.
export const FALLBACK_XP_BASE = 100;

export interface LevelCrossing {
  level: number;
  // The total the rule puts this level at. It is the rule's number even when the
  // author recorded the level by hand, so the timeline cannot outvote the curve.
  xp: number;
  // The chapter the crossing happened in, as far as the story can place it.
  chapterId: string | null;
  // The author's row for this level, when there is one.
  recordedMilestoneId: string | null;
  isPenalty: boolean;
}

// The order a chapter's income counts in: the reading order, with the chapters
// that have no place yet sorted after every placed one.
function chapterOrder(chapters: ChapterNode[]): Map<string, number> {
  const placed = [...chapters].sort(
    (left, right) =>
      (left.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) -
        (right.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id)
  );

  return new Map(placed.map((chapter, index) => [chapter.id, index]));
}

export function levelCrossingsFor(
  characterId: string,
  progress: CharacterProgress[],
  milestones: CharacterLevel[],
  rule: LevelGrowthRule | null,
  chapters: ChapterNode[]
): LevelCrossing[] {
  const order = chapterOrder(chapters);
  const base = rule?.xp_base ?? FALLBACK_XP_BASE;
  const growth = rule?.xp_growth ?? 0;
  const unplaced = order.size;

  // A row whose chapter has been purged keeps its experience and is read last,
  // which is what the database does with it too.
  const income = progress
    .filter(entry => entry.character_id === characterId)
    .map(entry => ({
      entry,
      rank: entry.chapter_id ? order.get(entry.chapter_id) ?? unplaced : unplaced,
    }))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.entry.created_at.localeCompare(right.entry.created_at) ||
        left.entry.id.localeCompare(right.entry.id)
    );

  const crossings: LevelCrossing[] = [];
  let total = 0;

  for (const { entry } of income) {
    total += entry.xp_earned;
    // A chapter in the trash still paid the experience, and the crossing keeps
    // its name; a reader that can only place live chapters filters it out.
    const chapterId = entry.chapter_id;

    // One chapter's income can carry more than one level, and every level it
    // carried landed in that chapter.
    while (
      crossings.length + 2 <= 999 &&
      total >= levelXpThreshold(base, growth, crossings.length + 2)
    ) {
      const level = crossings.length + 2;

      crossings.push({
        level,
        xp: levelXpThreshold(base, growth, level),
        chapterId,
        recordedMilestoneId: null,
        isPenalty: false,
      });
    }
  }

  // A recorded level the ledger has not reached stands as a floor, and the
  // author's row is the record of the ones it has.
  for (const milestone of milestones) {
    if (milestone.character_id !== characterId) continue;

    const crossing = crossings.find(entry => entry.level === milestone.level);

    if (crossing) {
      // The author placed the level in a chapter, and that placement is the one
      // the story tells; the curve only says what the level costs.
      crossing.chapterId = milestone.chapter_id ?? crossing.chapterId;
      crossing.recordedMilestoneId = milestone.id;
      crossing.isPenalty = milestone.is_debuff;
      continue;
    }

    crossings.push({
      level: milestone.level,
      xp: levelXpThreshold(base, growth, milestone.level),
      chapterId: milestone.chapter_id,
      recordedMilestoneId: milestone.id,
      isPenalty: milestone.is_debuff,
    });
  }

  return crossings.sort((left, right) => left.level - right.level);
}

// What every cast member's curve says, keyed by character. One pass over the
// story's rows, because the chart, the sheet and the warnings all ask for it.
export function crossingsByCharacter(
  characters: Character[],
  progress: CharacterProgress[],
  milestones: CharacterLevel[],
  rules: LevelGrowthRule[],
  chapters: ChapterNode[]
): Record<string, LevelCrossing[]> {
  const crossings: Record<string, LevelCrossing[]> = {};

  for (const character of characters) {
    crossings[character.id] = levelCrossingsFor(
      character.id,
      progress,
      milestones,
      effectiveGrowthRule(rules, character.id),
      chapters
    );
  }

  return crossings;
}

// The crossings in the shape the chart already draws its points in, so a level
// or XP line reads the curve rather than the rows. `created_at` carries the
// crossing's place in the list because the chart breaks a tie inside one chapter
// by it; a later level in the same chapter is the one the chapter left the
// character at.
export function crossingMilestones(
  characterId: string,
  crossings: LevelCrossing[]
): CharacterLevel[] {
  return crossings.map((crossing, index) => ({
    id: crossing.recordedMilestoneId ?? `crossing-${characterId}-${crossing.level}`,
    character_id: characterId,
    level: crossing.level,
    chapter_id: crossing.chapterId,
    is_debuff: crossing.isPenalty,
    xp: crossing.xp,
    stat_changes: [],
    created_at: String(index).padStart(4, '0'),
    updated_at: '',
  }));
}
