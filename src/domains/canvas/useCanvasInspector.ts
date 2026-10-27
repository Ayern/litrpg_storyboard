import { useEffect, useMemo, useState } from 'react';
import * as charactersApi from '../characters/api';
import type { CharacterAttribute } from '../characters/types';
import type { Character, CharacterStat } from '../shared/types';

// The inspector on a linked card: the cast member the card names, that member's
// own stats and attributes, the one row that is open for editing, and the four
// writes. Each write runs the same command the Characters tab runs, so a number
// changed from the canvas is recorded exactly as if it had been typed on the
// sheet.
//
// The cast arrives as an argument, because the board, the sheets and the search
// all read the one list; resolving the link is what turns an open card into a
// row. A saved stat is handed back through `rememberStat`, since the badges on
// every card are drawn from the story-wide read. Two handlers that are not the
// inspector's — relinking a card and renaming it — report on the same line, so
// they are handed `reportInspectorError` rather than a setter of their own.

export interface CanvasInspectorOptions {
  // The cast member the open card is linked to, if any. The id alone is passed:
  // the inspector never reads the board.
  linkedCharacterId: string | null;
  // The live cast, so a link resolves to the row it names rather than being
  // guessed at from the card's label.
  characters: Character[];
  // A saved stat has to reach the cards' badges too, whichever tab it was
  // edited from, or a badge would go on showing the number it replaced.
  rememberStat: (stat: CharacterStat) => void;
  actor: string;
}

export function useCanvasInspector({
  linkedCharacterId,
  characters,
  rememberStat,
  actor,
}: CanvasInspectorOptions) {
  // The inspector keeps its own copy of the matched cast member's numbers, so
  // editing from the canvas never depends on what the Characters tab has
  // selected. One row at a time is open for editing, as on that tab.
  const [inspectorStats, setInspectorStats] = useState<CharacterStat[]>([]);
  const [inspectorAttributes, setInspectorAttributes] = useState<CharacterAttribute[]>([]);
  const [inspectorStatId, setInspectorStatId] = useState<string | null>(null);
  const [inspectorStatValue, setInspectorStatValue] = useState('');
  const [inspectorAttrId, setInspectorAttrId] = useState<string | null>(null);
  const [inspectorAttrValue, setInspectorAttrValue] = useState('');
  const [inspectorError, setInspectorError] = useState<string | null>(null);

  // The card's stored link, resolved against the live cast. A link to a cast
  // member who is not in the list is one in the trash; nothing is guessed from
  // the node's label any more.
  const inspectorCharacter = useMemo(
    () =>
      linkedCharacterId
        ? characters.find(character => character.id === linkedCharacterId) ?? null
        : null,
    [linkedCharacterId, characters]
  );

  useEffect(() => {
    if (!inspectorCharacter) {
      setInspectorStats([]);
      setInspectorAttributes([]);
      setInspectorStatId(null);
      setInspectorAttrId(null);
      return;
    }

    const characterId = inspectorCharacter.id;
    let cancelled = false;

    const load = async () => {
      try {
        const [stats, attributes] = await Promise.all([
          charactersApi.getCharacterStats(characterId),
          charactersApi.getCharacterAttributes(characterId),
        ]);
        if (cancelled) return;

        setInspectorStats(stats);
        setInspectorAttributes(attributes);
        setInspectorError(null);
      } catch (e) {
        console.error('Failed to load the cast member for the inspector:', e);
        if (!cancelled) setInspectorError(`Could not load the cast member: ${String(e)}`);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [inspectorCharacter]);

  const startInspectorStat = (stat: CharacterStat) => {
    setInspectorStatId(stat.id);
    setInspectorStatValue(String(stat.value));
    setInspectorError(null);
  };

  // Editing a stat from the canvas writes through the same command as the
  // Characters tab, so the change is recorded exactly as if it were made there.
  // The notes are passed back unchanged rather than being cleared.
  const saveInspectorStat = async (stat: CharacterStat) => {
    if (!inspectorCharacter) return;

    const value = Number(inspectorStatValue);

    if (!inspectorStatValue.trim() || !Number.isFinite(value)) {
      setInspectorError('A stat value has to be a number.');
      return;
    }

    try {
      const updated: CharacterStat = await charactersApi.setCharacterStat(
        inspectorCharacter.id,
        stat.stat_name,
        Math.trunc(value),
        stat.notes,
        actor
      );

      setInspectorStats(prev =>
        [...prev.filter(other => other.id !== updated.id), updated].sort((a, b) =>
          a.stat_name.localeCompare(b.stat_name)
        )
      );
      rememberStat(updated);
      setInspectorStatId(null);
      setInspectorError(null);
    } catch (e) {
      console.error('Failed to save a stat from the inspector:', e);
      setInspectorError(`Could not save stat: ${String(e)}`);
    }
  };

  const startInspectorAttribute = (attribute: CharacterAttribute) => {
    setInspectorAttrId(attribute.id);
    setInspectorAttrValue(attribute.value);
    setInspectorError(null);
  };

  const saveInspectorAttribute = async (attribute: CharacterAttribute) => {
    if (!inspectorCharacter) return;

    const value = inspectorAttrValue.trim();

    if (!value) {
      setInspectorError(
        'An attribute needs a value — delete it on the Characters tab to remove it.'
      );
      return;
    }

    try {
      const updated: CharacterAttribute = await charactersApi.setCharacterAttribute(
        inspectorCharacter.id,
        attribute.attr_name,
        value,
        actor
      );

      setInspectorAttributes(prev =>
        [...prev.filter(other => other.id !== updated.id), updated].sort((a, b) =>
          a.attr_name.localeCompare(b.attr_name)
        )
      );
      setInspectorAttrId(null);
      setInspectorError(null);
    } catch (e) {
      console.error('Failed to save an attribute from the inspector:', e);
      setInspectorError(`Could not save attribute: ${String(e)}`);
    }
  };

  return {
    // The card's link, resolved; nobody while nothing is linked.
    inspectorCharacter,

    // The numbers it shows, and the one row of each list that is open.
    inspectorStats,
    inspectorAttributes,
    inspectorStatId,
    setInspectorStatId,
    inspectorStatValue,
    setInspectorStatValue,
    startInspectorStat,
    saveInspectorStat,
    inspectorAttrId,
    setInspectorAttrId,
    inspectorAttrValue,
    setInspectorAttrValue,
    startInspectorAttribute,
    saveInspectorAttribute,

    // The one line both the reads and the relink write on. Clearing it is what
    // a relink and a rename do before they try, so it takes a null.
    inspectorError,
    reportInspectorError: setInspectorError,
  };
}
