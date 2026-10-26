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
