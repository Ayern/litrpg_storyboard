import { useState } from 'react';
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

  const addSkillHolder = async () => {
    if (!card) return;

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
      setSkillHolderCharacterId('');
      setSkillHolderRank('');
      setSkillHolderChapterId('');
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
