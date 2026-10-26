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

// One stat a level-up changed, as the form hands it to the database. `amount` is
// the points gained and `value_after` the sheet value once they applied; either
// can be left out, which is how a row written before the amount existed reads.
export interface LevelStatChangeInput {
  stat_name: string;
  amount: number | null;
  value_after: number | null;
}
