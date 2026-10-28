import type { CharacterLevelMilestone, CharacterProgress } from '../shared/types';

// One line on the progression chart. The colour is fixed per cast member while
// the chart is open, so toggling someone off does not recolour the others.
export interface ProgressionChartSeries {
  characterId: string;
  name: string;
  color: string;
  milestones: CharacterLevelMilestone[];
  progress: CharacterProgress[];
}

export type ProgressionMetric = 'level' | 'xp' | 'earned' | 'stat';

// The row a jump just landed on, so the sheet or the board can mark it. The kind
// says which list to look in; a level-up, a skill and a relation can share an id.
export interface ProgressionFocus {
  kind: 'skill' | 'skill-event' | 'level' | 'relation' | 'faction-standing';
  id: string;
}

// One stat a level-up changed, as the form hands it to the database. `amount` is
// the points gained and `value_after` the sheet value once they applied; either
// can be left out, which is how a row written before the amount existed reads.
export interface LevelStatChangeInput {
  stat_name: string;
  amount: number | null;
  value_after: number | null;
}

// What a growth editor hands the app. The numbers stay the text that was typed,
// because the app is the one that decides what a whole number of points is.
export interface GrowthRateDraft {
  statName: string;
  perLevel: string;
}

export interface GrowthDraft {
  pointsPerLevel: string;
  rates: GrowthRateDraft[];
}

// One award, as its form holds it. XP belongs to a chapter; a stat point can be
// handed over anywhere, so its chapter is optional.
export interface AwardDraft {
  kind: 'xp' | 'stat';
  chapterId: string;
  statName: string;
  amount: string;
  note: string;
}
