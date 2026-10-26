import type { Character } from '../shared/types';

// The cast checklist under a chapter row: who is present in the chapter beyond
// the card's own linked cast member and its point of view. The write belongs to
// the app, because the board's own cast edge is the same write.

export interface ChapterCastPanelProps {
  chapterId: string;
  chapterLabel: string;
  // The card's linked cast member and its POV, which are always present.
  linkedId: string | null;
  povId: string | null;
  characters: Character[];
  // Whether the author ticked this character in, leaving the two always-present
  // cast members out of it.
  chapterCastIsExplicit: (chapterId: string, characterId: string) => boolean;
  setChapterCastPresence: (
    chapterId: string,
    characterId: string,
    present: boolean
  ) => Promise<void>;
  // True while any cast write is in flight, of any kind.
  busy: boolean;
  chapterCastError: string | null;
}

export function ChapterCastPanel({
  chapterId,
  chapterLabel,
  linkedId,
  povId,
  characters,
  chapterCastIsExplicit,
  setChapterCastPresence,
  busy,
  chapterCastError,
}: ChapterCastPanelProps) {
  return (
    <div
      className="chapter-cast-panel"
      role="group"
      aria-label={`Cast present in ${chapterLabel}`}
    >
      <div className="chapter-cast-panel-head">
        <strong>Present in this chapter</strong>
        <span>
          The card’s linked cast member and POV are always
          present; tick everyone else in the scene.
        </span>
      </div>

      {characters.length === 0 ? (
        <p className="chapter-cast-empty">
          Add a cast member on the Characters tab first.
        </p>
      ) : (
        <ul className="chapter-cast-options">
          {characters.map(character => {
            const explicit = chapterCastIsExplicit(
              chapterId,
              character.id
            );
            const isPov = povId === character.id;
            const isLinked = linkedId === character.id;

            return (
              <li key={character.id}>
                <label className="chapter-cast-option">
                  <input
                    type="checkbox"
                    aria-label={`${character.name} present in ${chapterLabel}`}
                    checked={explicit}
                    disabled={busy}
                    onChange={event =>
                      void setChapterCastPresence(
                        chapterId,
                        character.id,
                        event.target.checked
                      )
                    }
                  />
                  <span className="chapter-cast-option-name">
                    {character.name}
                  </span>
                  {isPov && (
                    <span className="chapter-cast-tag">POV</span>
                  )}
                  {isLinked && (
                    <span className="chapter-cast-tag">Linked</span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {chapterCastError && (
        <p className="chapter-cast-error" role="alert">
          {chapterCastError}
        </p>
      )}
    </div>
  );
}
