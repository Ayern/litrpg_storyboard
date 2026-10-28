import { useState } from 'react';
import { HelpTip } from '../../components/HelpTip';
import type { ChapterNode } from '../narrative/chapters';
import type { CharacterAward } from '../shared/types';
import type { AwardDraft } from './types';

// Gains that are not level-ups: a hidden quest's XP, a blessing's point of
// Strength, a monster that drops something the System counts. Writing one applies
// it there and then, and deleting it takes the same amount back out, so the list
// and the sheet cannot disagree.
//
// XP belongs to a chapter, because income is kept per chapter; a stat point can
// be handed over anywhere, so its chapter is optional.

export interface AwardsSectionProps {
  awards: CharacterAward[];
  chapters: ChapterNode[];
  // The stat names an award can add to: those on the sheet, plus anything the
  // author types elsewhere.
  statNameOptions: string[];
  onAdd: (draft: AwardDraft) => Promise<boolean>;
  onDelete: (award: CharacterAward) => Promise<void>;
}

function awardAmountText(award: CharacterAward): string {
  const amount = award.amount > 0 ? `+${award.amount}` : String(award.amount);

  return award.kind === 'xp'
    ? `${amount} XP`
    : `${award.stat_name ?? 'Stat'} ${amount}`;
}

export function AwardsSection({
  awards,
  chapters,
  statNameOptions,
  onAdd,
  onDelete,
}: AwardsSectionProps) {
  const [kind, setKind] = useState<'xp' | 'stat'>('xp');
  const [chapterDraft, setChapterDraft] = useState('');
  const [statDraft, setStatDraft] = useState('');
  const [amountDraft, setAmountDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');

  const addAward = async () => {
    const saved = await onAdd({
      kind,
      chapterId: chapterDraft,
      statName: statDraft,
      amount: amountDraft,
      note: noteDraft,
    });

    if (!saved) return;

    // The kind and the chapter usually hold for the next one; the amount is what
    // changes, so it is the only field that starts empty again.
    setAmountDraft('');
    setNoteDraft('');
  };

  return (
    <section className="awards-section" aria-label="Awards">
      <div className="awards-head">
        <h4 className="character-section-heading">Awards</h4>
        <HelpTip label="awards">
          Gains that are not level-ups: XP a chapter paid, or a stat point handed
          over by an event. Adding one writes the number on the sheet or the
          chapter’s income, and deleting it takes that amount back out in the same
          step, so nothing drifts. A level-up still records what it awarded; an
          award is applied.
        </HelpTip>
      </div>

      <div className="award-list">
        {awards.length === 0 && (
          <div className="empty">
            No awards yet — an event can pay XP or a stat point without a level-up.
          </div>
        )}

        {awards.map(award => {
          const chapter = chapters.find(choice => choice.id === award.chapter_id);
          const chapterLabel = chapter
            ? chapter.data.label
            : award.chapter_id
              ? 'Chapter in the trash'
              : 'No chapter';

          return (
            <div key={award.id} className="award-row" data-award={award.id}>
              <div className="award-summary">
                <span className="award-amount">{awardAmountText(award)}</span>
                <span className="award-chapter">{chapterLabel}</span>
                {award.note && <span className="award-note">{award.note}</span>}
              </div>
              <button
                type="button"
                title={`Delete the ${awardAmountText(award)} award and take it back out`}
                onClick={() => void onDelete(award)}
              >
                Delete
              </button>
            </div>
          );
        })}
      </div>

      <div className="award-creator">
        <label className="award-field">
          Kind
          <select
            aria-label="Award kind"
            value={kind}
            onChange={e => setKind(e.target.value === 'stat' ? 'stat' : 'xp')}
          >
            <option value="xp">XP</option>
            <option value="stat">Stat point</option>
          </select>
        </label>
        <label className="award-field">
          Chapter
          <select
            aria-label="Award chapter"
            title={
              kind === 'xp'
                ? 'The chapter that paid the XP'
                : 'The chapter it happened in; optional'
            }
            value={chapterDraft}
            onChange={e => setChapterDraft(e.target.value)}
          >
            <option value="">{kind === 'xp' ? 'Choose chapter' : 'No chapter'}</option>
            {chapterDraft &&
              !chapters.some(choice => choice.id === chapterDraft) && (
                <option value={chapterDraft}>Chapter in the trash</option>
              )}
            {chapters.map(choice => (
              <option key={choice.id} value={choice.id}>
                {choice.data.label}
              </option>
            ))}
          </select>
        </label>
        {kind === 'stat' && (
          <label className="award-field">
            Stat
            <select
              aria-label="Award stat"
              title="The stat the points land on"
              value={statDraft}
              onChange={e => setStatDraft(e.target.value)}
            >
              <option value="">Choose stat</option>
              {statDraft && !statNameOptions.includes(statDraft) && (
                <option value={statDraft}>{statDraft} (not on sheet)</option>
              )}
              {statNameOptions.map(name => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="award-field">
          Amount
          <input
            aria-label="Award amount"
            title={
              kind === 'xp'
                ? 'XP paid out, a whole number above zero'
                : 'Points added to the stat; a negative number takes them away'
            }
            type="number"
            step={1}
            placeholder={kind === 'xp' ? '250' : '+1'}
            value={amountDraft}
            onChange={e => setAmountDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void addAward();
            }}
          />
        </label>
        <label className="award-field award-note-field">
          Note
          <input
            aria-label="Award note"
            title="Why it happened, in your words"
            placeholder="Optional"
            value={noteDraft}
            onChange={e => setNoteDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void addAward();
            }}
          />
        </label>
        <button
          type="button"
          title="Record this gain and apply it"
          onClick={() => void addAward()}
        >
          Add award
        </button>
      </div>
    </section>
  );
}
