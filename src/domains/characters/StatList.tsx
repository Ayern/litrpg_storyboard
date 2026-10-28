import { useEffect } from 'react';
import { growthPointsOnStat } from '../progression/growth';
import { statKey } from '../progression/statNames';
import type {
  CharacterGrowthPoint,
  CharacterStat,
  LevelGrowthRule,
} from '../shared/types';
import { useSheetStats } from './useSheetStats';

// The sheet's stats, sitting directly under the progression bar.
//
// That is where they belong: a level hands out points, the author places them
// here, and the number that just moved is one glance from the bar that moved it.
// They used to live below the inventory and the relations, so an author who had
// just watched a level land had to scroll to see what it handed out.
//
// The rule's own rate is named beside each stat it raises (`+1 a level`), and a
// stat the rule raises that the sheet has no row for gets a row of its own: that
// is the rule saying a number is missing rather than the sheet quietly omitting
// it. The rows and the writes behind them stay in `useSheetStats`, which the
// canvas inspector uses the same way.

export interface StatListProps {
  // Whose sheet this is; the titles and the writes read it.
  characterName: string;
  characterId: string | null;
  stats: CharacterStat[];
  // The rule this sheet follows, for the per-level rates beside each stat.
  rule: LevelGrowthRule | null;
  // Where the points a level handed out have been placed, so a stat can say how
  // much of its value came from levelling rather than from typing.
  growthPoints: CharacterGrowthPoint[];
  // How many points are still waiting, which is what offers the button.
  pointsLeft: number;
  onPlacePoint: (statName: string) => Promise<void>;
  onStatWritten: (stat: CharacterStat) => void;
  onError: (message: string | null) => void;
  actor: string;
}

// A rate as the sheet words it: `+1`, or `-2` when a level takes something away.
const signed = (amount: number) => (amount > 0 ? `+${amount}` : `${amount}`);

export function StatList({
  characterName,
  characterId,
  stats,
  rule,
  growthPoints,
  pointsLeft,
  onPlacePoint,
  onStatWritten,
  onError,
  actor,
}: StatListProps) {
  const {
    newStatName,
    setNewStatName,
    newStatValue,
    setNewStatValue,
    addStat,
    editingStatId,
    setEditingStatId,
    statValueDraft,
    setStatValueDraft,
    statNotesDraft,
    setStatNotesDraft,
    startStatEdit,
    saveStat,
  } = useSheetStats({
    characterId,
    onStatWritten,
    reportError: onError,
    actor,
  });

  // A row open for editing belongs to the cast member whose sheet it was on, so
  // moving to somebody else closes it rather than leaving a draft pointing at a
  // row that is no longer drawn.
  useEffect(() => {
    setEditingStatId(null);
  }, [characterId, setEditingStatId]);

  const rateFor = (statName: string) =>
    rule?.stats.find(rate => statKey(rate.stat_name) === statKey(statName)) ?? null;

  // The rates the sheet has no row for yet: the rule raises them every level, so
  // their absence is worth showing rather than skipping.
  const missingRates =
    rule?.stats.filter(
      rate => !stats.some(stat => statKey(stat.stat_name) === statKey(rate.stat_name))
    ) ?? [];

  const rateSentence =
    rule && rule.stats.length > 0
      ? `Every level raises ${rule.stats
          .map(rate => `${rate.stat_name} ${signed(rate.per_level)}`)
          .join(', ')} on its own.`
      : 'No stat rises with a level — the rule hands out points to place instead.';

  return (
    <section className="stat-section" aria-label="Stats">
      <div className="stat-head">
        <h4 className="character-section-heading">Stats</h4>
        <span className="stat-hint">{rateSentence}</span>
      </div>

      <div className="stat-list">
        {stats.length === 0 && missingRates.length === 0 && (
          <div className="empty">No stats yet — add one below.</div>
        )}

        {stats.map(stat => {
          const rate = rateFor(stat.stat_name);
          const placed = growthPointsOnStat(growthPoints, stat.stat_name);

          return (
            <div key={stat.id} className="stat-row">
              <span className="stat-name">{stat.stat_name}</span>

              {editingStatId === stat.id ? (
                <>
                  <input
                    className="stat-value-input"
                    type="number"
                    autoFocus
                    value={statValueDraft}
                    onChange={e => setStatValueDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveStat(stat);
                      if (e.key === 'Escape') setEditingStatId(null);
                    }}
                  />
                  <input
                    className="stat-notes-input"
                    placeholder="Notes (optional)"
                    value={statNotesDraft}
                    onChange={e => setStatNotesDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveStat(stat);
                      if (e.key === 'Escape') setEditingStatId(null);
                    }}
                  />
                  <button
                    title={`Save this new ${stat.stat_name} value and notes`}
                    onClick={() => saveStat(stat)}
                  >
                    Save
                  </button>
                  <button
                    title="Leave the value as it was"
                    onClick={() => setEditingStatId(null)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="stat-value">{stat.value}</span>
                  {stat.notes && <span className="stat-notes">{stat.notes}</span>}
                  {rate && (
                    <span
                      className="stat-rule"
                      title={`The level growth rule raises this by ${rate.per_level} every level`}
                    >
                      {signed(rate.per_level)} a level
                    </span>
                  )}
                  {placed > 0 && (
                    <span
                      className="stat-growth-points"
                      title={`Of this value, ${placed} came from placing level points`}
                    >
                      +{placed} from levels
                    </span>
                  )}
                  {pointsLeft > 0 && (
                    <button
                      className="stat-place-point"
                      title={`Place one of ${characterName}'s ${pointsLeft} unspent points on ${stat.stat_name} — one undo step`}
                      onClick={() => onPlacePoint(stat.stat_name)}
                    >
                      Place point
                    </button>
                  )}
                  <button
                    title={`Change this ${stat.stat_name} value or notes`}
                    onClick={() => startStatEdit(stat)}
                  >
                    Edit
                  </button>
                </>
              )}
            </div>
          );
        })}

        {missingRates.map(rate => (
          <div
            key={`rule-${rate.stat_name}`}
            className="stat-row stat-row-rule"
            data-rule-stat={rate.stat_name}
          >
            <span className="stat-name">{rate.stat_name}</span>
            <span className="stat-value stat-value-none">—</span>
            <span
              className="stat-rule"
              title={`The level growth rule raises this by ${rate.per_level} every level`}
            >
              {signed(rate.per_level)} a level
            </span>
            <span className="stat-notes">
              Not on the sheet yet — add it below to record the value.
            </span>
          </div>
        ))}
      </div>

      <div className="stat-creator">
        <input
          placeholder="Stat name"
          value={newStatName}
          onChange={e => setNewStatName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addStat()}
        />
        <input
          className="stat-value-input"
          type="number"
          placeholder="0"
          value={newStatValue}
          onChange={e => setNewStatValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addStat()}
        />
        <button
          title="Add this stat, or update it if the name already exists"
          onClick={addStat}
          disabled={!newStatName.trim()}
        >
          Add stat
        </button>
      </div>
    </section>
  );
}
