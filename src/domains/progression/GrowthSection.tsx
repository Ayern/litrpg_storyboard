import { useState } from 'react';
import { HelpTip } from '../../components/HelpTip';
import type { LevelGrowthRule } from '../shared/types';
import { growthRateText } from './growth';
import type { GrowthRateDraft } from './types';

// What a level hands out, read as two rows: the story's rule and this
// character's. The story's is the System everyone follows; an override is the
// exception it makes for one person, and removing it puts them back on the
// story's rule.
//
// The form holds typed text, not numbers: a half-typed points field survives a
// render, and the app is the one that refuses a number it cannot use.

export type GrowthScope = 'story' | 'character';

export interface GrowthSectionProps {
  storyRule: LevelGrowthRule | null;
  characterRule: LevelGrowthRule | null;
  // The stat names an automatic rate can name: every stat on a sheet.
  statNameOptions: string[];
  onSave: (scope: GrowthScope, pointsPerLevel: string, rates: GrowthRateDraft[]) => Promise<boolean>;
  onDelete: (rule: LevelGrowthRule) => Promise<void>;
}

function draftsFromRule(rule: LevelGrowthRule | null): {
  points: string;
  rates: GrowthRateDraft[];
} {
  return {
    points: rule ? String(rule.points_per_level) : '0',
    rates:
      rule?.stats.map(rate => ({
        statName: rate.stat_name,
        perLevel: String(rate.per_level),
      })) ?? [],
  };
}

export function GrowthSection({
  storyRule,
  characterRule,
  statNameOptions,
  onSave,
  onDelete,
}: GrowthSectionProps) {
  const [editing, setEditing] = useState<GrowthScope | null>(null);
  const [pointsDraft, setPointsDraft] = useState('0');
  const [rateDrafts, setRateDrafts] = useState<GrowthRateDraft[]>([]);

  const startEdit = (scope: GrowthScope) => {
    const rule = scope === 'story' ? storyRule : (characterRule ?? storyRule);
    const drafts = draftsFromRule(rule);

    setPointsDraft(drafts.points);
    setRateDrafts(drafts.rates);
    setEditing(scope);
  };

  const save = async (scope: GrowthScope) => {
    if (await onSave(scope, pointsDraft, rateDrafts)) setEditing(null);
  };

  const removeOverride = async () => {
    if (characterRule) await onDelete(characterRule);
    setEditing(null);
  };

  return (
    <section className="growth-section" aria-label="Level growth">
      <div className="growth-head">
        <h4 className="character-section-heading">Level growth</h4>
        <HelpTip label="level growth">
          What one level hands out. Points are yours to place when you record a
          level-up; a rate is a stat that rises on its own. The story rule covers
          everyone, and a character can override it — a monster that grows twice
          as fast, or a human who gets nothing for free. The rule only fills in
          the level-up form; it never moves a level by itself.
        </HelpTip>
      </div>

      <div className="growth-row" data-growth="story">
        <span className="growth-scope">Story rule</span>
        <span className="growth-text">
          {storyRule
            ? growthRateText(storyRule)
            : 'Not set — a level hands out nothing until you say what it should.'}
        </span>
        {editing !== 'story' && (
          <button
            type="button"
            title={
              storyRule
                ? 'Change what a level hands out for everyone'
                : 'Set what a level hands out for everyone'
            }
            onClick={() => startEdit('story')}
          >
            {storyRule ? 'Edit' : 'Set rule'}
          </button>
        )}
      </div>

      <div className="growth-row" data-growth="character">
        <span className="growth-scope">This character</span>
        <span className="growth-text">
          {characterRule ? growthRateText(characterRule) : 'Follows the story rule.'}
        </span>
        {editing !== 'character' && (
          <>
            <button
              type="button"
              title={
                characterRule
                  ? 'Change what a level hands out for this character'
                  : 'Give this character a rule of their own'
              }
              onClick={() => startEdit('character')}
            >
              {characterRule ? 'Edit' : 'Override'}
            </button>
            {characterRule && (
              <button
                type="button"
                title="Put this character back on the story rule"
                onClick={() => void removeOverride()}
              >
                Remove
              </button>
            )}
          </>
        )}
      </div>

      {editing && (
        <div className="growth-form">
          <label className="level-metric-field">
            Points per level
            <input
              aria-label="Growth points per level"
              type="number"
              min={0}
              step={1}
              autoFocus
              value={pointsDraft}
              onChange={e => setPointsDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void save(editing);
                if (e.key === 'Escape') setEditing(null);
              }}
            />
          </label>

          {rateDrafts.map((rate, index) => (
            <div className="growth-rate-row" key={`rate-${index}`}>
              <select
                aria-label={`Growth rate ${index + 1} stat`}
                title="A stat this level raises by itself"
                value={rate.statName}
                onChange={e =>
                  setRateDrafts(previous =>
                    previous.map((entry, at) =>
                      at === index ? { ...entry, statName: e.target.value } : entry
                    )
                  )
                }
              >
                <option value="">Choose stat</option>
                {rate.statName && !statNameOptions.includes(rate.statName) && (
                  <option value={rate.statName}>{rate.statName} (not on sheet)</option>
                )}
                {statNameOptions.map(name => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Growth rate ${index + 1} per level`}
                title="How many points this stat gains each level"
                type="number"
                step={1}
                placeholder="+1"
                value={rate.perLevel}
                onChange={e =>
                  setRateDrafts(previous =>
                    previous.map((entry, at) =>
                      at === index ? { ...entry, perLevel: e.target.value } : entry
                    )
                  )
                }
              />
              <button
                type="button"
                className="stat-change-remove"
                aria-label={`Remove growth rate ${index + 1}`}
                title="Remove this automatic rate"
                onClick={() =>
                  setRateDrafts(previous => previous.filter((_, at) => at !== index))
                }
              >
                ×
              </button>
            </div>
          ))}

          <button
            type="button"
            className="stat-change-add"
            title="Add a stat this level raises by itself"
            onClick={() =>
              setRateDrafts(previous => [...previous, { statName: '', perLevel: '' }])
            }
          >
            Add rate
          </button>

          <div className="level-actions">
            <button
              type="button"
              title={
                editing === 'story'
                  ? 'Save the rule everyone without their own follows'
                  : 'Save this character’s own rule'
              }
              onClick={() => void save(editing)}
            >
              Save rule
            </button>
            <button type="button" title="Leave the rule as it was" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
