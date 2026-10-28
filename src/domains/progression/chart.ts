import type { ChapterNode } from '../narrative/chapters';
import type {
  Character,
  CharacterLevelMilestone,
  CharacterProgress,
  CharacterStat,
  LevelGrowthRule,
} from '../shared/types';
import { levelCrossingsFor } from './crossings';
import { effectiveGrowthRule } from './growth';
import { milestoneStatChanges } from './helpers';
import type { ProgressionChartSeries, ProgressionMetric } from './types';

// What the progression chart draws, worked out from the story's rows: one line
// per cast member, the metrics those lines can be read in, and the stat names a
// line could follow. No React and no command, so the rules can be read in one
// place.

// Fixed, distinguishable line colours. A cast member keeps the same colour while
// the chart is open, so hiding one line does not recolour the comparison.
export const PROGRESSION_CHART_COLORS = [
  '#7ac47a',
  '#7aa2f7',
  '#e0af68',
  '#f7768e',
  '#bb9af7',
  '#2ac3de',
  '#9ece6a',
  '#ff9e64',
];

// The chart reads the same story-wide rows the continuity checks use. Only
// chapters that are on the board can place a point, so a row whose chapter is in
// the trash is left out rather than guessed at. The levels themselves come from
// the curve's crossings, worked out from the ledger and the story's rule.
export function chartSeriesFor(
  characters: Character[],
  milestones: CharacterLevelMilestone[],
  progress: CharacterProgress[],
  chapterNodes: ChapterNode[],
  rules: LevelGrowthRule[]
): ProgressionChartSeries[] {
  const chapterIds = new Set(chapterNodes.map(chapter => chapter.id));

  return characters
    .map((character, index) => ({
      characterId: character.id,
      name: character.name,
      color: PROGRESSION_CHART_COLORS[index % PROGRESSION_CHART_COLORS.length],
      crossings: levelCrossingsFor(
        character.id,
        progress,
        milestones,
        effectiveGrowthRule(rules, character.id),
        chapterNodes
      ).filter(
        crossing => crossing.chapterId !== null && chapterIds.has(crossing.chapterId)
      ),
      milestones: milestones.filter(
        milestone =>
          milestone.character_id === character.id &&
          milestone.chapter_id !== null &&
          chapterIds.has(milestone.chapter_id)
      ),
      progress: progress.filter(
        entry =>
          entry.character_id === character.id &&
          entry.chapter_id !== null &&
          chapterIds.has(entry.chapter_id)
      ),
    }))
    .filter(
      series =>
        series.crossings.length > 0 ||
        series.milestones.length > 0 ||
        series.progress.length > 0
    );
}

// A primary-stat line needs a name that either sits on a sheet now or was
// snapshotted on a milestone before the sheet changed.
export function statNamesFrom(
  castStats: Record<string, CharacterStat[]>,
  milestones: CharacterLevelMilestone[]
): string[] {
  const names = new Set<string>();

  for (const stats of Object.values(castStats)) {
    for (const stat of stats) names.add(stat.stat_name);
  }

  for (const milestone of milestones) {
    for (const change of milestoneStatChanges(milestone)) {
      names.add(change.stat_name);
    }
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}

// Only a character with a recorded value can have a point in the chosen metric.
// Level is always present, XP and a stat snapshot are optional, and income comes
// from its own ledger rather than being inferred from totals.
export function metricSeriesFor(
  series: ProgressionChartSeries[],
  metric: ProgressionMetric,
  statName: string
): ProgressionChartSeries[] {
  const withMilestones = series.filter(entry => entry.milestones.length > 0);

  // A level and a total XP point are the curve's, not a row's, so a character a
  // hand-written level was recorded for still has a line only where the ledger
  // actually carried them.
  if (metric === 'level') {
    return series.filter(entry => entry.crossings.length > 0);
  }

  if (metric === 'xp') {
    return series.filter(entry => entry.crossings.length > 0);
  }

  if (metric === 'earned') {
    return series.filter(entry => entry.progress.length > 0);
  }

  if (!statName) return [];

  return withMilestones.filter(entry =>
    entry.milestones.some(milestone =>
      milestoneStatChanges(milestone).some(
        change => change.stat_name === statName && change.value_after != null
      )
    )
  );
}
