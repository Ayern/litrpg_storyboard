import type { CharacterLevelMilestone } from '../shared/types';
import { milestoneStatChanges } from './helpers';

// One stat a level-up changed, as a sheet's form holds it while it is being
// typed. The three fields stay strings so a half-typed row survives a render,
// and a blank field means "not recorded" rather than zero.
export interface LevelStatChangeDraft {
  statName: string;
  amount: string;
  valueAfter: string;
}

export function blankStatChange(): LevelStatChangeDraft {
  return { statName: '', amount: '', valueAfter: '' };
}

// The form a milestone opens with: one row per stat the level already changed.
export function statChangesFromMilestone(
  milestone: CharacterLevelMilestone
): LevelStatChangeDraft[] {
  return milestoneStatChanges(milestone).map(change => ({
    statName: change.stat_name,
    amount: change.amount == null ? '' : String(change.amount),
    valueAfter: change.value_after == null ? '' : String(change.value_after),
  }));
}
