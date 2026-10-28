import type { CharacterLevel, CharacterLevelStatChange } from '../shared/types';

// Every stat a milestone changed. A v18 milestone may still hold the old single
// snapshot in a fixture or an import; treat it as a value-after with no gain.
export function milestoneStatChanges(
  milestone: CharacterLevel
): CharacterLevelStatChange[] {
  if (milestone.stat_changes && milestone.stat_changes.length > 0) {
    return milestone.stat_changes;
  }

  if (milestone.stat_name != null && milestone.stat_points != null) {
    return [
      {
        id: `legacy-${milestone.id}`,
        level_record_id: milestone.id,
        stat_name: milestone.stat_name,
        amount: null,
        value_after: milestone.stat_points,
        created_at: milestone.created_at,
        updated_at: milestone.updated_at,
      },
    ];
  }

  return [];
}

// Level-ups are named by level rather than id wherever one is chosen, so a
// linked skill event reads the way the author thinks of it.
export function milestoneLabel(milestone: CharacterLevel): string {
  return `Level ${milestone.level}${milestone.is_debuff ? ' (penalty)' : ''}`;
}

export function signedNumber(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export function statChangeText(change: CharacterLevelStatChange): string {
  if (change.amount != null && change.value_after != null) {
    return `${change.stat_name} ${signedNumber(change.amount)} (now ${change.value_after})`;
  }

  if (change.amount != null) {
    return `${change.stat_name} ${signedNumber(change.amount)}`;
  }

  return `${change.stat_name} ${change.value_after ?? ''}`.trim();
}
