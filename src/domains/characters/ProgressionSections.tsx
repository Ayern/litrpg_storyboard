import { useEffect, useState } from 'react';
import type { ChapterNode } from '../narrative/chapters';
import { AwardsSection } from '../progression/AwardsSection';
import { GrowthSection } from '../progression/GrowthSection';
import type { GrowthScope } from '../progression/GrowthSection';
import { StatChangeRows } from '../progression/StatChangeRows';
import {
  effectiveGrowthRule,
  growthRateText,
  growthStatRows,
  nextLevelFromMilestones,
} from '../progression/growth';
import type { LevelStatChangeDraft } from '../progression/drafts';
import { blankStatChange, statChangesFromMilestone } from '../progression/drafts';
import { milestoneStatChanges, statChangeText } from '../progression/helpers';
import type {
  AwardDraft,
  GrowthRateDraft,
  ProgressionFocus,
} from '../progression/types';
import type {
  Character,
  CharacterAward,
  CharacterLevelMilestone,
  CharacterProgress,
  CharacterSkill,
  LevelGrowthRule,
} from '../shared/types';
import type { CharacterSkillEvent } from '../skills/types';

// The three lists a character's progression is made of: the level and XP the
// sheet shows now, the milestones that record where a level was reached, and the
// XP each chapter paid out.
//
// They are one group because they share one question: what changed, and where in
// the reading order did it change. The milestones and the income feed the power
// curve above this sheet.
//
// The form state lives here: the level and XP fields, the milestone rows with the
// stat changes a level carried, and the income rows. Every field stays the text
// the author typed, because the app is the one that decides what a whole level, a
// total or a stat change is - and each write answers whether the row was written,
// so a refused row keeps its editor rather than throwing the typing away.
//
// A warning on another tab opens the exact row it names, so this panel watches
// the focus it is handed and opens that milestone. Moving to another character
// closes the level form, because it holds that character's numbers rather than a
// row's.

// What the totals form hands the app. The numbers stay as typed; the app is the
// one that decides what an experience total and a target are. The level is not
// in this form at all: it comes from the level-ups, not from a field.
export interface ProgressDraft {
  xp: string;
  target: string;
  rank: string;
}

// One level-up, as the milestone form holds it. XP is optional, and a level can
// carry as many stat changes as the story needs.
export interface MilestoneDraft {
  level: string;
  chapterId: string;
  isDebuff: boolean;
  xp: string;
  statChanges: LevelStatChangeDraft[];
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

  milestones: CharacterLevelMilestone[];
  xpEntries: CharacterProgress[];
  skillEvents: CharacterSkillEvent[];
  skills: CharacterSkill[];
  // What a level hands out, and the gains that skipped a level-up.
  growthRules: LevelGrowthRule[];
  awards: CharacterAward[];
  // The stat names a milestone's rows, a growth rate or an award can pick from.
  statNameOptions: string[];
  focus: ProgressionFocus | null;

  onError: (message: string | null) => void;
  onSaveProgress: (draft: ProgressDraft) => Promise<boolean>;
  onSaveGrowth: (
    scope: GrowthScope,
    pointsPerLevel: string,
    rates: GrowthRateDraft[]
  ) => Promise<boolean>;
  onDeleteGrowth: (rule: LevelGrowthRule) => Promise<void>;
  onAddAward: (draft: AwardDraft) => Promise<boolean>;
  onDeleteAward: (award: CharacterAward) => Promise<void>;
  onCreateMilestone: (draft: MilestoneDraft) => Promise<boolean>;
  onSaveMilestone: (
    milestone: CharacterLevelMilestone,
    draft: MilestoneDraft
  ) => Promise<boolean>;
  onDeleteMilestone: (milestone: CharacterLevelMilestone) => Promise<boolean>;
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
  awards,
  statNameOptions,
  focus,
  onError,
  onSaveProgress,
  onSaveGrowth,
  onDeleteGrowth,
  onAddAward,
  onDeleteAward,
  onCreateMilestone,
  onSaveMilestone,
  onDeleteMilestone,
  onCreateXpEntry,
  onSaveXpEntry,
  onDeleteXpEntry,
}: ProgressionSectionsProps) {
  const [editingProgress, setEditingProgress] = useState(false);
  const [progressXpDraft, setProgressXpDraft] = useState('0');
  const [progressTargetDraft, setProgressTargetDraft] = useState('');
  const [progressRankDraft, setProgressRankDraft] = useState('');

  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(null);
  const [milestoneLevelDraft, setMilestoneLevelDraft] = useState('1');
  const [milestoneChapterDraft, setMilestoneChapterDraft] = useState('');
  const [milestoneDebuffDraft, setMilestoneDebuffDraft] = useState(false);
  const [milestoneXpDraft, setMilestoneXpDraft] = useState('');
  const [milestoneStatChangesDraft, setMilestoneStatChangesDraft] = useState<
    LevelStatChangeDraft[]
  >([]);

  const [newMilestoneLevel, setNewMilestoneLevel] = useState('1');
  const [newMilestoneChapter, setNewMilestoneChapter] = useState('');
  const [newMilestoneDebuff, setNewMilestoneDebuff] = useState(false);
  const [newMilestoneXp, setNewMilestoneXp] = useState('');
  const [newMilestoneStatChanges, setNewMilestoneStatChanges] = useState<
    LevelStatChangeDraft[]
  >([blankStatChange()]);

  const [editingXpEntryId, setEditingXpEntryId] = useState<string | null>(null);
  const [xpEntryChapterDraft, setXpEntryChapterDraft] = useState('');
  const [xpEntryXpDraft, setXpEntryXpDraft] = useState('');

  const [newXpEntryChapter, setNewXpEntryChapter] = useState('');
  const [newXpEntryXp, setNewXpEntryXp] = useState('');

  // The rule this sheet follows: its own when it has one, the story's otherwise.
  const growth = effectiveGrowthRule(growthRules, characterId);

  // The progression form opens with the stored numbers, so a save can change one
  // field without having to retype the others.
  const startProgressEdit = () => {
    if (!character) return;

    setProgressXpDraft(String(shownXp));
    setProgressTargetDraft(shownTarget ? String(shownTarget) : '');
    setProgressRankDraft(character.rank ?? '');
    onError(null);
    setEditingProgress(true);
  };

  const saveProgress = async () => {
    const saved = await onSaveProgress({
      xp: progressXpDraft,
      target: progressTargetDraft,
      rank: progressRankDraft,
    });

    if (saved) setEditingProgress(false);
  };

  // A level-up is a record in a chapter, so the button opens the creator with
  // the next level and the rule's automatic gains already in it. Whatever the
  // rule says, the author still writes the level-up.
  const startLevelUp = () => {
    onError(null);
    setNewMilestoneLevel(String(nextLevelFromMilestones(milestones, characterId)));
    setNewMilestoneChapter('');
    setNewMilestoneDebuff(false);
    setNewMilestoneXp('');

    const rows = growthStatRows(growth);
    setNewMilestoneStatChanges(rows.length > 0 ? rows : [blankStatChange()]);
  };

  // The level form holds the selected character's numbers rather than a row's, so
  // moving to somebody else closes it: whoever is selected next starts from their
  // own record.
  useEffect(() => {
    setEditingProgress(false);
  }, [characterId]);

  // The creator opens at the level after the one this character last reached, so
  // moving to somebody else starts from their record rather than the last
  // sheet's number. Only a change of character resets it, never a save.
  useEffect(() => {
    setNewMilestoneLevel(String(nextLevelFromMilestones(milestones, characterId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  const startMilestoneEdit = (milestone: CharacterLevelMilestone) => {
    setEditingMilestoneId(milestone.id);
    setMilestoneLevelDraft(String(milestone.level));
    setMilestoneChapterDraft(milestone.chapter_id ?? '');
    setMilestoneDebuffDraft(milestone.is_debuff);
    setMilestoneXpDraft(milestone.xp == null ? '' : String(milestone.xp));
    setMilestoneStatChangesDraft(statChangesFromMilestone(milestone));
  };

  // A warning opens the milestone it names; the highlight simply timing out
  // leaves the editor alone.
  useEffect(() => {
    if (!focus) return;

    const milestone = milestones.find(entry => entry.id === focus.id);

    if (focus.kind === 'level' && milestone) startMilestoneEdit(milestone);
    // Only a new focus reopens a row: the list changing under an open editor must
    // not put the saved values back over what is being typed.
  }, [focus]);

  const saveMilestone = async (milestone: CharacterLevelMilestone) => {
    const saved = await onSaveMilestone(milestone, {
      level: milestoneLevelDraft,
      chapterId: milestoneChapterDraft,
      isDebuff: milestoneDebuffDraft,
      xp: milestoneXpDraft,
      statChanges: milestoneStatChangesDraft,
    });

    if (saved) setEditingMilestoneId(null);
  };

  const addMilestone = async () => {
    const saved = await onCreateMilestone({
      level: newMilestoneLevel,
      chapterId: newMilestoneChapter,
      isDebuff: newMilestoneDebuff,
      xp: newMilestoneXp,
      statChanges: newMilestoneStatChanges,
    });

    if (!saved) return;

    // The next milestone usually follows the one just recorded, so the level is
    // kept as the number that was written rather than as it was typed.
    setNewMilestoneLevel(String(Number(newMilestoneLevel)));
    setNewMilestoneChapter('');
    setNewMilestoneDebuff(false);
    setNewMilestoneXp('');
    setNewMilestoneStatChanges([blankStatChange()]);
  };

  const removeMilestone = async (milestone: CharacterLevelMilestone) => {
    if (await onDeleteMilestone(milestone)) setEditingMilestoneId(null);
  };

  const startXpEntryEdit = (entry: CharacterProgress) => {
    setEditingXpEntryId(entry.id);
    setXpEntryChapterDraft(entry.chapter_id);
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

        {editingProgress ? (
          <div className="progress-form">
            <label>
              Experience
              <input
                type="number"
                min={0}
                value={progressXpDraft}
                onChange={(e) => setProgressXpDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveProgress();
                  if (e.key === 'Escape') setEditingProgress(false);
                }}
              />
            </label>
            <label>
              XP to next
              <input
                type="number"
                min={1}
                placeholder="None"
                value={progressTargetDraft}
                onChange={(e) => setProgressTargetDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveProgress();
                  if (e.key === 'Escape') setEditingProgress(false);
                }}
              />
            </label>
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
              <button
                title="Save level, experience, rank and the next-level target"
                onClick={saveProgress}
              >
                Save
              </button>
              <button
                title="Leave the progression as it was"
                onClick={() => setEditingProgress(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="progress-actions">
            <button
              title="Record the next level as a level-up in a chapter"
              onClick={startLevelUp}
            >
              Record level-up
            </button>
            <button
              title="Type the experience, rank and XP target; the level comes from the level-ups"
              onClick={startProgressEdit}
            >
              Edit progression
            </button>
          </div>
        )}
      </section>

      {/* A milestone is where a level was reached, not the level
          the sheet shows now. It is what continuity compares in
          reading order, and a deliberate drop can say so. */}
      <section className="level-section" aria-label="Level milestones">
        <h4 className="character-section-heading">Level milestones</h4>

        <div className="level-list">
          {milestones.length === 0 && (
            <div className="empty">
              No level milestones yet — record where a level was reached.
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
                {editingMilestoneId === milestone.id ? (
                  <div className="level-editor">
                    <input
                      aria-label="Milestone level"
                      type="number"
                      min={1}
                      step={1}
                      autoFocus
                      value={milestoneLevelDraft}
                      onChange={(e) => setMilestoneLevelDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveMilestone(milestone);
                        if (e.key === 'Escape') setEditingMilestoneId(null);
                      }}
                    />
                    <select
                      aria-label="Milestone chapter"
                      title="The chapter where this level was reached"
                      value={milestoneChapterDraft}
                      onChange={(e) => setMilestoneChapterDraft(e.target.value)}
                    >
                      <option value="">No chapter</option>
                      {milestoneChapterDraft &&
                        !chapters.some(
                          choice => choice.id === milestoneChapterDraft
                        ) && (
                          <option value={milestoneChapterDraft}>
                            Chapter in the trash
                          </option>
                        )}
                      {chapters.map(choice => (
                        <option key={choice.id} value={choice.id}>
                          {choice.data.label}
                        </option>
                      ))}
                    </select>
                    <label className="level-penalty-field">
                      <input
                        aria-label="Level drop is a penalty"
                        type="checkbox"
                        checked={milestoneDebuffDraft}
                        onChange={(e) => setMilestoneDebuffDraft(e.target.checked)}
                      />
                      Penalty
                    </label>
                    <label className="level-metric-field">
                      Total XP
                      <input
                        aria-label="Milestone total XP"
                        type="number"
                        min={0}
                        step={1}
                        placeholder="Optional"
                        value={milestoneXpDraft}
                        onChange={e => setMilestoneXpDraft(e.target.value)}
                      />
                    </label>
                    <StatChangeRows
                      drafts={milestoneStatChangesDraft}
                      setDrafts={setMilestoneStatChangesDraft}
                      prefix="Milestone"
                      statNameOptions={statNameOptions}
                    />
                    <div className="level-actions">
                      <button
                        title={`Save this level ${milestone.level} milestone`}
                        onClick={() => saveMilestone(milestone)}
                      >
                        Save milestone
                      </button>
                      <button
                        title="Leave the milestone as it was"
                        onClick={() => setEditingMilestoneId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
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
                        .filter(event => event.milestone_id === milestone.id)
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
                    <button
                      title={`Change the level and chapter of the level ${milestone.level} milestone`}
                      onClick={() => startMilestoneEdit(milestone)}
                    >
                      Edit
                    </button>
                    <button
                      title={`Delete the level ${milestone.level} milestone`}
                      onClick={() => removeMilestone(milestone)}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="level-creator">
          <div className="level-growth-hint">
            {growth
              ? `This level hands out: ${growthRateText(growth)}.`
              : 'No growth rule yet — set one below, or record the gains by hand.'}
          </div>
          <input
            aria-label="New milestone level"
            type="number"
            min={1}
            step={1}
            value={newMilestoneLevel}
            onChange={(e) => setNewMilestoneLevel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addMilestone()}
          />
          <select
            aria-label="New milestone chapter"
            title="The chapter where this level was reached"
            value={newMilestoneChapter}
            onChange={(e) => setNewMilestoneChapter(e.target.value)}
          >
            <option value="">No chapter</option>
            {chapters.map(choice => (
              <option key={choice.id} value={choice.id}>
                {choice.data.label}
              </option>
            ))}
          </select>
          <label className="level-penalty-field">
            <input
              aria-label="New milestone is a penalty"
              type="checkbox"
              checked={newMilestoneDebuff}
              onChange={(e) => setNewMilestoneDebuff(e.target.checked)}
            />
            Penalty
          </label>
          <label className="level-metric-field">
            Total XP
            <input
              aria-label="New milestone total XP"
              type="number"
              min={0}
              step={1}
              placeholder="Optional"
              value={newMilestoneXp}
              onChange={e => setNewMilestoneXp(e.target.value)}
            />
          </label>
          <StatChangeRows
            drafts={newMilestoneStatChanges}
            setDrafts={setNewMilestoneStatChanges}
            prefix="New milestone"
            statNameOptions={statNameOptions}
          />
          <button
            title="Record this level in the selected character's timeline"
            onClick={addMilestone}
          >
            Add milestone
          </button>
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

      {/* Income is what a chapter paid out, kept separate from the
          running total on a milestone so the chart can show either. */}
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
