import { SuggestionInput } from '../../components/SuggestionInput';
import type { ChapterNode } from '../narrative/chapters';
import type { ProgressionFocus } from '../progression/types';
import type { Character, CharacterRelation } from '../shared/types';

// The sheet's relation rows: a bond with another cast member, the kind the author
// calls it, the chapters it ran between and a note. A relation joins two people,
// so the row names the other one from whichever end it was recorded, and someone
// whose sheet is in the trash is named as such rather than dropped.
//
// The kind is a suggestion list, not a vocabulary: the field keeps any word the
// author types. Drawing an edge between two cards on the board writes one of
// these rows, so the open row, the drafts behind it and the writes they feed stay
// in the app - deleting the row still takes its canvas connection with it in one
// undoable step.

export interface RelationListProps {
  relations: CharacterRelation[];
  // Which sheet these rows belong to, so a row can name the person at the other end.
  selectedCharacterId: string | null;
  characterNameById: Map<string, string>;
  chapterLabelById: Map<string, string>;
  chapters: ChapterNode[];
  characters: Character[];
  // The bond kinds the two kind fields suggest.
  kindSuggestions: readonly string[];
  focus: ProgressionFocus | null;

  editingRelationId: string | null;
  setEditingRelationId: (relationId: string | null) => void;
  relationKindDraft: string;
  setRelationKindDraft: (kind: string) => void;
  relationChapterDraft: string;
  setRelationChapterDraft: (chapterId: string) => void;
  relationUntilChapterDraft: string;
  setRelationUntilChapterDraft: (chapterId: string) => void;
  relationNoteDraft: string;
  setRelationNoteDraft: (note: string) => void;
  startRelationEdit: (relation: CharacterRelation) => void;
  saveRelation: (relation: CharacterRelation) => Promise<void>;
  removeRelation: (relation: CharacterRelation) => Promise<void>;

  newRelationKind: string;
  setNewRelationKind: (kind: string) => void;
  newRelationToId: string;
  setNewRelationToId: (characterId: string) => void;
  newRelationChapterId: string;
  setNewRelationChapterId: (chapterId: string) => void;
  newRelationNote: string;
  setNewRelationNote: (note: string) => void;
  addRelation: () => Promise<void>;
}

export function RelationList({
  relations,
  selectedCharacterId,
  characterNameById,
  chapterLabelById,
  chapters,
  characters,
  kindSuggestions,
  focus,
  editingRelationId,
  setEditingRelationId,
  relationKindDraft,
  setRelationKindDraft,
  relationChapterDraft,
  setRelationChapterDraft,
  relationUntilChapterDraft,
  setRelationUntilChapterDraft,
  relationNoteDraft,
  setRelationNoteDraft,
  startRelationEdit,
  saveRelation,
  removeRelation,
  newRelationKind,
  setNewRelationKind,
  newRelationToId,
  setNewRelationToId,
  newRelationChapterId,
  setNewRelationChapterId,
  newRelationNote,
  setNewRelationNote,
  addRelation,
}: RelationListProps) {
  return (
    <div className="relations-section">
      <h4 className="character-section-heading">Relations</h4>

      <div className="relation-list">
        {relations.length === 0 && (
          <div className="empty">
            No relations yet — a bond with another cast member is recorded below.
          </div>
        )}

        {relations.map(relation => {
          const otherId =
            relation.from_character_id === selectedCharacterId
              ? relation.to_character_id
              : relation.from_character_id;
          const otherName =
            characterNameById.get(otherId) ?? 'a cast member in the trash';
          const sinceLabel = relation.since_chapter_id
            ? chapterLabelById.get(relation.since_chapter_id) ??
              'a chapter in the trash'
            : null;
          const untilLabel = relation.until_chapter_id
            ? chapterLabelById.get(relation.until_chapter_id) ??
              'a chapter in the trash'
            : null;
          const focused =
            focus?.kind === 'relation' && focus.id === relation.id;

          return (
            <div
              key={relation.id}
              data-progression={`relation-${relation.id}`}
              className={`relation-row${
                focused ? ' progression-row-focused' : ''
              }`}
            >
              {editingRelationId === relation.id ? (
                <div className="relation-editor">
                  <SuggestionInput
                    label="Relation kind"
                    title="Ally, rival, mentor, family and owes are only suggestions"
                    autoFocus
                    value={relationKindDraft}
                    suggestions={kindSuggestions}
                    onChange={setRelationKindDraft}
                    onEnter={() => void saveRelation(relation)}
                    onEscape={() => setEditingRelationId(null)}
                  />
                  <span className="relation-other">{otherName}</span>
                  <select
                    aria-label="Relation since chapter"
                    title="The chapter this bond began in"
                    value={relationChapterDraft}
                    onChange={(e) => setRelationChapterDraft(e.target.value)}
                  >
                    <option value="">No chapter recorded</option>
                    {chapters.map(node => (
                      <option key={node.id} value={node.id}>
                        {node.data.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Relation until chapter"
                    title="The chapter this bond ended in, if it did"
                    value={relationUntilChapterDraft}
                    onChange={(e) =>
                      setRelationUntilChapterDraft(e.target.value)
                    }
                  >
                    <option value="">Still current</option>
                    {chapters.map(node => (
                      <option key={node.id} value={node.id}>
                        {node.data.label}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Relation note"
                    placeholder="Note"
                    value={relationNoteDraft}
                    onChange={(e) => setRelationNoteDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveRelation(relation);
                      if (e.key === 'Escape') setEditingRelationId(null);
                    }}
                  />
                  <div className="relation-actions">
                    <button
                      title={`Save this ${relation.kind} relation`}
                      onClick={() => void saveRelation(relation)}
                    >
                      Save relation
                    </button>
                    <button
                      title="Leave the relation as it was"
                      onClick={() => setEditingRelationId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="relation-summary">
                    <span className="relation-kind">{relation.kind}</span>
                    <span className="relation-other">{otherName}</span>
                    <span className="relation-when">
                      {sinceLabel ? `since ${sinceLabel}` : 'no chapter recorded'}
                      {untilLabel ? ` – ${untilLabel}` : ''}
                    </span>
                  </div>
                  {relation.note && (
                    <span className="relation-note">{relation.note}</span>
                  )}
                  <button
                    title={`Change this ${relation.kind} relation`}
                    onClick={() => startRelationEdit(relation)}
                  >
                    Edit
                  </button>
                  <button
                    title={`Delete this ${relation.kind} relation`}
                    onClick={() => void removeRelation(relation)}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="relation-creator">
        <SuggestionInput
          label="New relation kind"
          title="Ally, rival, mentor, family and owes are only suggestions"
          placeholder="Kind (ally)"
          value={newRelationKind}
          suggestions={kindSuggestions}
          onChange={setNewRelationKind}
          onEnter={() => void addRelation()}
        />
        <select
          aria-label="New relation with"
          title="The other cast member in this relation"
          value={newRelationToId}
          onChange={(e) => setNewRelationToId(e.target.value)}
        >
          <option value="">Choose cast…</option>
          {characters
            .filter(character => character.id !== selectedCharacterId)
            .map(character => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
        </select>
        <select
          aria-label="New relation since chapter"
          title="The chapter this bond began in"
          value={newRelationChapterId}
          onChange={(e) => setNewRelationChapterId(e.target.value)}
        >
          <option value="">No chapter recorded</option>
          {chapters.map(node => (
            <option key={node.id} value={node.id}>
              {node.data.label}
            </option>
          ))}
        </select>
        <input
          aria-label="New relation note"
          placeholder="Note"
          value={newRelationNote}
          onChange={(e) => setNewRelationNote(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addRelation()}
        />
        <button
          title="Record this relation on the character's sheet"
          onClick={() => void addRelation()}
          disabled={!newRelationToId || !newRelationKind.trim()}
        >
          Add relation
        </button>
      </div>
    </div>
  );
}
