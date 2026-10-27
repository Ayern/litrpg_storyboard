import { useRef, useState } from 'react';
import * as skillsApi from '../skills/api';
import type { CharacterSkill } from '../shared/types';

// The form a skill card adds a holder with. A skill card is a link target rather
// than a template the sheet knows about, and adding a holder from the card is
// the deliberate exception: the card's saved name and notes become the new row's
// name and effect, because those identify the skill. Rank and chapter are the
// holder's own facts, so they are entered here rather than copied from somebody
// else's row.
//
// The card arrives as an argument, because the canvas owns the board and the
// drawer; the row the write answers with goes back out on `onHolderAdded`,
// because a skill is listed by the board and by the open sheet, and only the app
// knows whether the sheet is showing the character who just learned it.

// What the write needs from the open card: the node a holder links back to, and
// the name and notes it copies. Nothing else about the board reaches the form.
export interface SkillHolderCard {
  id: string;
  label: string;
  content: string | null;
}

export interface SkillHolderFormOptions {
  // The skill card the drawer is showing, or null while it shows something else.
  card: SkillHolderCard | null;
  // The row that came back, for the board's list and the open sheet's.
  onHolderAdded: (skill: CharacterSkill) => void;
  actor: string;
}

export function useSkillHolderForm({
  card,
  onHolderAdded,
  actor,
}: SkillHolderFormOptions) {
  const [skillHolderCharacterId, setSkillHolderCharacterId] = useState('');
  const [skillHolderRank, setSkillHolderRank] = useState('');
  const [skillHolderChapterId, setSkillHolderChapterId] = useState('');
  const [skillHolderError, setSkillHolderError] = useState<string | null>(null);
  const [savingSkillHolder, setSavingSkillHolder] = useState(false);

  // The form belongs to the card the drawer is showing. A rank and a chapter typed
  // for one card are that holder's own facts, so they must not be waiting there
  // for the next card: opening another card — or closing the drawer — empties the
  // form and the line it was complaining on. The card's id decides, not the object
  // it arrives in, because the app builds that object afresh on every render.
  const cardId = card?.id ?? null;
  const [formCardId, setFormCardId] = useState<string | null>(cardId);

  // The card the form belongs to, readable from the write that runs outside a
  // render, so a write finishing for a card that is no longer open cannot empty a
  // form the author has since started filling for a different one.
  const openCardId = useRef<string | null>(cardId);

  if (cardId !== formCardId) {
    setFormCardId(cardId);
    openCardId.current = cardId;
    setSkillHolderCharacterId('');
    setSkillHolderRank('');
    setSkillHolderChapterId('');
    setSkillHolderError(null);
  }

  const addSkillHolder = async () => {
    if (!card) return;

    const writtenCardId = card.id;
    const characterId = skillHolderCharacterId;
    const name = card.label.trim();
    const effect = card.content?.trim() || null;

    if (!characterId) {
      setSkillHolderError('Choose the character who learns this skill.');
      return;
    }

    if (!name) {
      setSkillHolderError('The card needs a name before it can be added to a sheet.');
      return;
    }

    setSkillHolderError(null);
    setSavingSkillHolder(true);

    try {
      const saved: CharacterSkill = await skillsApi.addSkill(
        characterId,
        name,
        skillHolderRank.trim() || null,
        effect,
        skillHolderChapterId || null,
        card.id,
        actor
      );

      onHolderAdded(saved);

      // Only the form these answers were typed into is emptied: if the author
      // opened another card while the write was in flight, what is on screen now
      // is that card's answers and they are left alone.
      if (openCardId.current === writtenCardId) {
        setSkillHolderCharacterId('');
        setSkillHolderRank('');
        setSkillHolderChapterId('');
      }
    } catch (e) {
      console.error('Failed to add a skill holder:', e);
      setSkillHolderError(`Could not add the holder: ${String(e)}`);
    } finally {
      setSavingSkillHolder(false);
    }
  };

  return {
    // The three answers, as the card's holder section reads and writes them.
    skillHolderCharacterId,
    setSkillHolderCharacterId,
    skillHolderRank,
    setSkillHolderRank,
    skillHolderChapterId,
    setSkillHolderChapterId,

    // The line the form complains on, and whether a write is in flight.
    skillHolderError,
    setSkillHolderError,
    savingSkillHolder,

    addSkillHolder,
  };
}
