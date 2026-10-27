import { useState } from 'react';
import * as charactersApi from '../characters/api';
import type { CharacterStat } from '../shared/types';

// The stat section of a character sheet: the two fields of its new-stat form,
// the one row open for editing with that row's value and notes, and the two
// writes behind them. Each write runs the command the sheet has always run, so a
// stat is recorded the way every other stat edit has been.
//
// The rows are not the hook's. The app reads them for the open cast member — one
// read per selection, shared with a revert and a delete — and owns the list, so
// the row a write answers with goes straight back out on `onStatWritten`: that
// row has two places to go, the sheet's own list and the story-wide map the
// badges on every card are drawn from. The sheet's error line is shared with
// every other write on the tab, so it arrives as a callback as well.

export interface SheetStatsOptions {
  // Whose sheet is open: the new-stat form writes against them. A row already on
  // the sheet knows its own cast member, so a save uses the row it was handed.
  characterId: string | null;
  // The row that came back from a write, for the sheet's list and the cards.
  onStatWritten: (stat: CharacterStat) => void;
  // The sheet's error line, which the tab's other writes share.
  reportError: (message: string | null) => void;
  actor: string;
}

export function useSheetStats({
  characterId,
  onStatWritten,
  reportError,
  actor,
}: SheetStatsOptions) {
  // One row at a time is open for editing, and the row's own notes are held
  // beside its value so a save never drops them.
  const [editingStatId, setEditingStatId] = useState<string | null>(null);
  const [statValueDraft, setStatValueDraft] = useState('');
  const [statNotesDraft, setStatNotesDraft] = useState('');

  const [newStatName, setNewStatName] = useState('');
  const [newStatValue, setNewStatValue] = useState('');

  const startStatEdit = (stat: CharacterStat) => {
    setEditingStatId(stat.id);
    setStatValueDraft(String(stat.value));
    setStatNotesDraft(stat.notes ?? '');
  };

  const saveStat = async (stat: CharacterStat) => {
    const value = Number(statValueDraft);

    if (!statValueDraft.trim() || !Number.isFinite(value)) {
      reportError('A stat value has to be a number.');
      return;
    }

    reportError(null);

    try {
      const updated: CharacterStat = await charactersApi.setCharacterStat(
        stat.character_id,
        stat.stat_name,
        Math.trunc(value),
        statNotesDraft.trim() || null,
        actor
      );

      onStatWritten(updated);
      setEditingStatId(null);
    } catch (e) {
      console.error('Failed to save stat:', e);
      reportError(`Could not save stat: ${String(e)}`);
    }
  };

  const addStat = async () => {
    if (!characterId || !newStatName.trim()) return;

    const raw = newStatValue.trim();
    const value = Number(raw || '0');

    if (!Number.isFinite(value)) {
      reportError('A stat value has to be a number.');
      return;
    }

    reportError(null);

    try {
      // Setting a stat that already exists updates it, which is what the name
      // implies; the list the app keeps merges by id either way.
      const saved: CharacterStat = await charactersApi.setCharacterStat(
        characterId,
        newStatName.trim(),
        Math.trunc(value),
        null,
        actor
      );

      onStatWritten(saved);
      setNewStatName('');
      setNewStatValue('');
    } catch (e) {
      console.error('Failed to add stat:', e);
      reportError(`Could not add stat: ${String(e)}`);
    }
  };

  return {
    // The new-stat form.
    newStatName,
    setNewStatName,
    newStatValue,
    setNewStatValue,
    addStat,

    // The one row open for editing.
    editingStatId,
    setEditingStatId,
    statValueDraft,
    setStatValueDraft,
    statNotesDraft,
    setStatNotesDraft,
    startStatEdit,
    saveStat,
  };
}
