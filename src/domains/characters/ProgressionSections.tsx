import { useEffect, useState } from 'react';
import { HelpTip } from '../../components/HelpTip';
import type { ChapterNode } from '../narrative/chapters';
import { AwardsSection } from '../progression/AwardsSection';
import { GrowthSection } from '../progression/GrowthSection';
import type { GrowthScope } from '../progression/GrowthSection';
import {
  effectiveGrowthRule,
  growthPointTally,
  growthRateText,
} from '../progression/growth';
import { milestoneStatChanges, statChangeText } from '../progression/helpers';
import type {
  AwardDraft,
  GrowthRateDraft,
  ProgressionFocus,
} from '../progression/types';
import type {
  Character,
  CharacterAward,
  CharacterGrowthPoint,
  CharacterLevel,
  CharacterProgress,
  CharacterSkill,
  LevelGrowthRule,
} from '../shared/types';
import type { CharacterSkillEvent } from '../skills/types';

// Three lists make up a character's progression: the level and experience the
// sheet shows now, the timeline of levels the curve wrote, and the XP each
// chapter paid out.
//
// Only the last two are records an author keeps. The level and the total are read
// from them - the income adds up, the curve turns it into a level, and the rule
// hands out what that level carried - so the head of this panel is a readout with
// one field left to type: the rank.
//
// The form state that remains is the rank, the income rows, the growth rule and
// the awards. Every field stays the text the author typed, and each write answers
// whether the row was written, so a refused row keeps its editor rather than
// throwing the typing away.

// What the progression form hands the app: the author's words about where the
// character stands. The numbers beside them are worked out.
export interface ProgressDraft {
  rank: string;
}

// One chapter's XP income, as the ledger's form holds it.
export interface XpEntryDraft {
  chapterId: string;
  xp: string;
}

export interface ProgressionSectionsProps {
  // The selected character and the numbers the app works out from it.
  character: Character | null;
  characterId: string | null;
  shownLevel: number;
  shownXp: number;
  shownTarget: number | null;
  progressPercent: number;

  // The chapters a milestone or an income row can name, in reading order.
  chapters: ChapterNode[];

  milestones: CharacterLevel[];
  xpEntries: CharacterProgress[];
  skillEvents: CharacterSkillEvent[];
  skills: CharacterSkill[];
  // What a level hands out, the gains that skipped a level-up, and where this
  // character's points have been placed so far.
  growthRules: LevelGrowthRule[];
  growthPoints: CharacterGrowthPoint[];
  awards: CharacterAward[];
  // The stat names a milestone's rows, a growth rate or an award can pick from.
  statNameOptions: string[];
  focus: ProgressionFocus | null;

  onError: (message: string | null) => void;
  onSaveProgress: (draft: ProgressDraft) => Promise<boolean>;
  onSaveGrowth: (
    scope: GrowthScope,
    pointsPerLevel: string,
    xpBase: string,
    xpGrowth: string,
    rates: GrowthRateDraft[]
  ) => Promise<boolean>;
  onDeleteGrowth: (rule: LevelGrowthRule) => Promise<void>;
  onAddAward: (draft: AwardDraft) => Promise<boolean>;
  onDeleteAward: (award: CharacterAward) => Promise<void>;
  onCreateXpEntry: (draft: XpEntryDraft) => Promise<boolean>;
  onSaveXpEntry: (
    entry: CharacterProgress,
    draft: XpEntryDraft
  ) => Promise<boolean>;
  onDeleteXpEntry: (entry: CharacterProgress) => Promise<boolean>;
}

export function ProgressionSections({
  character,
  characterId,
  shownLevel,
  shownXp,
  shownTarget,
  progressPercent,
  chapters,
  milestones,
  xpEntries,
  skillEvents,
  skills,
  growthRules,
  growthPoints,
  awards,
  statNameOptions,
  focus,
  onError,
  onSaveProgress,
  onSaveGrowth,
  onDeleteGrowth,
  onAddAward,
  onDeleteAward,
  onCreateXpEntry,
  onSaveXpEntry,
  onDeleteXpEntry,
}: ProgressionSectionsProps) {
  const [editingProgress, setEditingProgress] = useState(false);
  const [progressRankDraft, setProgressRankDraft] = useState('');

  const [editingXpEntryId, setEditingXpEntryId] = useState<string | null>(null);
  const [xpEntryChapterDraft, setXpEntryChapterDraft] = useState('');
  const [xpEntryXpDraft, setXpEntryXpDraft] = useState('');

  const [newXpEntryChapter, setNewXpEntryChapter] = useState('');
  const [newXpEntryXp, setNewXpEntryXp] = useState('');

  // The rule this sheet follows: its own when it has one, the story's otherwise.
  const growth = effectiveGrowthRule(growthRules, characterId);

  // What the levels handed out against what has been placed. Both halves are
  // worked out: the pool follows the level and the rule, the placings are rows,
  // so the tally moves when either does without anything having to be kept in
  // step by hand.
  const tally = growthPointTally(growth, shownLevel, growthPoints);

  // The rank form holds the selected character's words rather than a row's, so
  // moving to somebody else closes it.
  const startProgressEdit = () => {
    if (!character) return;

    setProgressRankDraft(character.rank ?? '');
    onError(null);
    setEditingProgress(true);
  };

  const saveProgress = async () => {
    const saved = await onSaveProgress({ rank: progressRankDraft });

    if (saved) setEditingProgress(false);
  };

  useEffect(() => {
    setEditingProgress(false);
  }, [characterId]);

  const startXpEntryEdit = (entry: CharacterProgress) => {
    setEditingXpEntryId(entry.id);
    setXpEntryChapterDraft(entry.chapter_id ?? '');
    setXpEntryXpDraft(String(entry.xp_earned));
  };

  const saveXpEntry = async (entry: CharacterProgress) => {
    const saved = await onSaveXpEntry(entry, {
      chapterId: xpEntryChapterDraft,
      xp: xpEntryXpDraft,
    });

    if (saved) setEditingXpEntryId(null);
  };

  const addXpEntry = async () => {
    const saved = await onCreateXpEntry({
      chapterId: newXpEntryChapter,
      xp: newXpEntryXp,
    });

    if (!saved) return;

    setNewXpEntryChapter('');
    setNewXpEntryXp('');
  };

  const removeXpEntry = async (entry: CharacterProgress) => {
    if (await onDeleteXpEntry(entry)) setEditingXpEntryId(null);
  };

  return (
    <>
      <section className="progress-section" aria-label="Progression">
        <div className="progress-head">
          <h4 className="character-section-heading">Progression</h4>
          <span className="progress-rank">{character?.rank || 'Unranked'}</span>
        </div>

        <div className="progress-stats">
          <div className="progress-stat">
            <span className="progress-stat-label">Level</span>
            <span className="progress-stat-value">{shownLevel}</span>
          </div>
          <div className="progress-stat">
            <span className="progress-stat-label">Experience</span>
            <span className="progress-stat-value">
              {shownTarget ? `${shownXp} / ${shownTarget}` : shownXp}
            </span>
          </div>
        </div>

        <div
          className="progress-bar"
          role="progressbar"
          aria-label="Progress to the next level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
        >
          <div
            className="progress-bar-fill"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <div className="progress-caption">
          {shownTarget
            ? `${Math.max(0, shownTarget - shownXp)} XP to level ${shownLevel + 1}`
            : 'No target set — edit progression to show a bar.'}
        </div>

        {/* The points a level hands out are the author's to place, so the tally
            sits with the level rather than with the rule that set the number:
            it is about how far this character has come. */}
        {growth && tally.owed > 0 && (
          <div className="growth-point-tally" data-growth-points={tally.left}>
            <span className="growth-point-left">
              {tally.left > 0
                ? `${tally.left} of ${tally.owed} points to place`
                : tally.left === 0
                  ? `All ${tally.owed} points placed`
                  : `${-tally.left} more placed than this level's rule hands out`}
            </span>
            <span className="growth-point-placed">
              {tally.placed > 0
                ? `${tally.placed} placed`
                : 'None placed yet'}
            </span>
            <HelpTip label="growth points">
              Every level hands out points, and they are yours to place: put
              them on the stats below, one point per click. Each placing raises
              the stat straight away and is one undo step, so a point placed in
              the wrong stat comes straight back. Only the placings are stored;
              the pool itself follows the level and the rule, which is why
              changing what a level hands out changes the tally.
            </HelpTip>
          </div>
        )}

        {editingProgress ? (
          <div className="progress-form">
            <label>
              Rank
              <input
                placeholder="Unranked"
                value={progressRankDraft}
                onChange={(e) => setProgressRankDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveProgress();
                  if (e.key === 'Escape') setEditingProgress(false);
                }}
              />
            </label>
            <div className="progress-actions">
              <button title="Save the rank" onClick={saveProgress}>
                Save
              </button>
              <button
                title="Leave the rank as it was"
                onClick={() => setEditingProgress(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="progress-actions">
            <button
              title="Type the rank; the level and experience come from the ledger and the rule"
              onClick={startProgressEdit}
            >
              Edit rank
            </button>
          </div>
        )}
      </section>

      {/* The timeline is what the curve wrote: a level, the chapter its income
          crossed in, and the gains the rule handed out there. It is a readout,
          so it is not edited here — the experience is, above. */}
      <section className="level-section" aria-label="Level timeline">
        <h4 className="character-section-heading">Level timeline</h4>

        <div className="level-list">
          {milestones.length === 0 && (
            <div className="empty">
              No levels yet — record what a chapter paid out and the timeline
              follows.
            </div>
          )}

          {milestones.map(milestone => {
            const chapter = chapters.find(
              choice => choice.id === milestone.chapter_id
            );
            const focused =
              focus?.kind === 'level' && focus.id === milestone.id;

            return (
              <div
                key={milestone.id}
                className={`level-row${focused ? ' progression-row-focused' : ''}`}
                data-progression={`level-${milestone.id}`}
              >
                <div className="level-summary">
                  <span className="level-value">Level {milestone.level}</span>
                  <span className="level-chapter">
                    {chapter
                      ? `Reached in ${chapter.data.label}`
                      : milestone.chapter_id
                        ? 'Chapter in the trash'
                        : 'No chapter recorded'}
                  </span>
                  {milestone.is_debuff && (
                    <span className="level-penalty">Penalty</span>
                  )}
                  {milestone.xp != null && (
                    <span className="level-xp">XP {milestone.xp}</span>
                  )}
                  {milestoneStatChanges(milestone).map(change => (
                    <span className="level-stat" key={change.id}>
                      {statChangeText(change)}
                    </span>
                  ))}
                  {skillEvents
                    .filter(event => event.level_record_id === milestone.id)
                    .map(event => {
                      const skill = skills.find(
                        entry => entry.id === event.skill_id
                      );

                      return (
                        <span
                          className="level-stat level-skill-change"
                          key={event.id}
                        >
                          {skill?.name ?? 'Skill'} · {event.kind}
                          {event.rank ? ` ${event.rank}` : ''}
                        </span>
                      );
                    })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="level-growth-hint">
          {growth
            ? `Every level hands out: ${growthRateText(growth)}.`
            : 'No growth rule yet — set one below.'}
        </div>

      </section>

      <GrowthSection
        storyRule={growthRules.find(rule => rule.character_id === null) ?? null}
        characterRule={
          growthRules.find(rule => rule.character_id === characterId) ?? null
        }
        statNameOptions={statNameOptions}
        onSave={onSaveGrowth}
        onDelete={onDeleteGrowth}
      />

      {/* Income is what a chapter paid out, and it is the only thing that moves
          the level: the sheet's total is these rows added up. */}
      <section className="xp-ledger-section" aria-label="XP by chapter">
        <h4 className="character-section-heading">XP by chapter</h4>

        <div className="xp-ledger-list">
          {xpEntries.length === 0 && (
            <div className="empty">
              No XP earned by chapter yet — record what a chapter paid out.
            </div>
          )}

          {xpEntries.map(entry => {
            const chapter = chapters.find(
              choice => choice.id === entry.chapter_id
            );
            const chapterLabel = chapter
              ? chapter.data.label
              : 'Chapter in the trash';

            return (
              <div
                key={entry.id}
                className="xp-ledger-row"
                data-xp-entry={entry.id}
              >
                {editingXpEntryId === entry.id ? (
                  <div className="level-editor">
                    <select
                      aria-label="XP entry chapter"
                      value={xpEntryChapterDraft}
                      onChange={e => setXpEntryChapterDraft(e.target.value)}
                    >
                      <option value="">Choose chapter</option>
                      {xpEntryChapterDraft &&
                        !chapters.some(
                          choice => choice.id === xpEntryChapterDraft
                        ) && (
                          <option value={xpEntryChapterDraft}>
                            Chapter in the trash
                          </option>
                        )}
                      {chapters.map(choice => (
                        <option key={choice.id} value={choice.id}>
                          {choice.data.label}
                        </option>
                      ))}
                    </select>
                    <label className="level-metric-field">
                      XP earned
                      <input
                        aria-label="XP entry earned XP"
                        type="number"
                        min={0}
                        step={1}
                        value={xpEntryXpDraft}
                        onChange={e => setXpEntryXpDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveXpEntry(entry);
                          if (e.key === 'Escape') setEditingXpEntryId(null);
                        }}
                      />
                    </label>
                    <div className="level-actions">
                      <button
                        title={`Save the XP earned in ${chapterLabel}`}
                        onClick={() => saveXpEntry(entry)}
                      >
                        Save XP
                      </button>
                      <button
                        title="Leave the XP entry as it was"
                        onClick={() => setEditingXpEntryId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="xp-ledger-summary">
                      <span className="xp-ledger-chapter">{chapterLabel}</span>
                      <span className="level-xp">
                        {entry.xp_earned} XP earned
                      </span>
                    </div>
                    <button
                      title={`Change the XP earned in ${chapterLabel}`}
                      onClick={() => startXpEntryEdit(entry)}
                    >
                      Edit
                    </button>
                    <button
                      title={`Delete the XP earned in ${chapterLabel}`}
                      onClick={() => removeXpEntry(entry)}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="level-creator xp-ledger-creator">
          <select
            aria-label="New XP entry chapter"
            value={newXpEntryChapter}
            onChange={e => setNewXpEntryChapter(e.target.value)}
          >
            <option value="">Choose chapter</option>
            {chapters.map(choice => (
              <option key={choice.id} value={choice.id}>
                {choice.data.label}
              </option>
            ))}
          </select>
          <label className="level-metric-field">
            XP earned
            <input
              aria-label="New XP entry earned XP"
              type="number"
              min={0}
              step={1}
              value={newXpEntryXp}
              onChange={e => setNewXpEntryXp(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addXpEntry()}
            />
          </label>
          <button
            title="Record the XP this chapter paid out"
            onClick={addXpEntry}
          >
            Add XP
          </button>
        </div>
      </section>

      <AwardsSection
        awards={awards}
        chapters={chapters}
        statNameOptions={statNameOptions}
        onAdd={onAddAward}
        onDelete={onDeleteAward}
      />
    </>
  );
}
