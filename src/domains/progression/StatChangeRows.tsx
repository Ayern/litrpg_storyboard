import React from 'react';
import { blankStatChange } from './drafts';
import type { LevelStatChangeDraft } from './drafts';

// One editor for both the new and existing milestone forms. A level-up can
// carry any number of stat changes, so rows are added and removed here rather
// than forcing the author to save the same level several times.
//
// The rows are drafts, not rows: nothing is written until the milestone is
// saved, which is why this component only ever calls the setter it was given.
export interface StatChangeRowsProps {
  drafts: LevelStatChangeDraft[];
  setDrafts: React.Dispatch<React.SetStateAction<LevelStatChangeDraft[]>>;
  // "Milestone" or "New milestone", which prefixes every accessible name so the
  // two forms on one sheet stay distinguishable to a screen reader.
  prefix: string;
  // The stat names a row can pick from: those on any sheet and those already
  // snapshotted on a milestone.
  statNameOptions: string[];
}

export function StatChangeRows({
  drafts,
  setDrafts,
  prefix,
  statNameOptions,
}: StatChangeRowsProps) {
  return (
    <div className="stat-change-list">
      {drafts.map((draft, index) => (
        <div className="stat-change-row" key={`${prefix}-${index}`}>
          <select
            aria-label={`${prefix} stat ${index + 1} name`}
            title="The stat this level changed"
            value={draft.statName}
            onChange={e =>
              setDrafts(previous =>
                previous.map((entry, at) =>
                  at === index ? { ...entry, statName: e.target.value } : entry
                )
              )
            }
          >
            <option value="">Choose stat</option>
            {draft.statName &&
              !statNameOptions.includes(draft.statName) && (
                <option value={draft.statName}>{draft.statName} (not on sheet)</option>
              )}
            {statNameOptions.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <input
            aria-label={`${prefix} stat ${index + 1} gain`}
            title="How many points this level awarded, such as +2 or -1"
            type="number"
            step={1}
            placeholder="+2"
            value={draft.amount}
            onChange={e =>
              setDrafts(previous =>
                previous.map((entry, at) =>
                  at === index ? { ...entry, amount: e.target.value } : entry
                )
              )
            }
          />
          <input
            aria-label={`${prefix} stat ${index + 1} value after`}
            title="The stat's value once the gain applied; optional"
            type="number"
            step={1}
            placeholder="Now (optional)"
            value={draft.valueAfter}
            onChange={e =>
              setDrafts(previous =>
                previous.map((entry, at) =>
                  at === index ? { ...entry, valueAfter: e.target.value } : entry
                )
              )
            }
          />
          <button
            type="button"
            className="stat-change-remove"
            title="Remove this stat change"
            aria-label={`Remove ${prefix} stat ${index + 1}`}
            onClick={() =>
              setDrafts(previous => previous.filter((_, at) => at !== index))
            }
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="stat-change-add"
        aria-label={`Add ${prefix === 'New milestone' ? 'a new milestone' : 'a milestone'} stat`}
        title="Add another stat this level changed"
        onClick={() => setDrafts(previous => [...previous, blankStatChange()])}
      >
        Add stat
      </button>
    </div>
  );
}
