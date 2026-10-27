import type { Node } from 'reactflow';
import type { NodeData } from '../canvas/types';
import type { ChapterNode } from '../narrative/chapters';
import type { ProgressionFocus } from '../progression/types';
import type { FactionStanding } from '../shared/types';

// The sheet's faction standings: which faction card a character belongs to, in
// what role, and the chapters that standing ran between. A faction is a card on
// the board, so the row names it by its label and a card in the trash is named as
// such rather than dropped.
//
// The standing form can also make the faction card it needs, without leaving the
// sheet: the quick-add field hands a name to the app, which creates the card and
// reports the new id back here so it is the one selected. The drafts and the
// writes they feed stay in the app, so a standing is still one audited row.

export interface StandingListProps {
  standings: FactionStanding[];
  // The faction cards a standing can belong to.
  factions: Node<NodeData>[];
  chapters: ChapterNode[];
  chapterLabelById: Map<string, string>;
  focus: ProgressionFocus | null;

  editingStandingId: string | null;
  setEditingStandingId: (standingId: string | null) => void;
  standingFactionDraft: string;
  setStandingFactionDraft: (factionId: string) => void;
  standingTextDraft: string;
  setStandingTextDraft: (standing: string) => void;
  standingChapterDraft: string;
  setStandingChapterDraft: (chapterId: string) => void;
  standingUntilChapterDraft: string;
  setStandingUntilChapterDraft: (chapterId: string) => void;
  standingNoteDraft: string;
  setStandingNoteDraft: (note: string) => void;
  startStandingEdit: (standing: FactionStanding) => void;
  saveStanding: (standing: FactionStanding) => Promise<void>;
  removeStanding: (standing: FactionStanding) => Promise<void>;

  newStandingFactionId: string;
  setNewStandingFactionId: (factionId: string) => void;
  newStandingFactionName: string;
  setNewStandingFactionName: (name: string) => void;
  newStandingText: string;
  setNewStandingText: (standing: string) => void;
  newStandingChapterId: string;
  setNewStandingChapterId: (chapterId: string) => void;
  newStandingNote: string;
  setNewStandingNote: (note: string) => void;
  addStanding: () => Promise<void>;

  // Makes a faction card on the board and hands its id back, so the form can
  // name a faction the story does not have yet.
  createFaction: (
    name: string,
    onCreated: (factionId: string) => void,
    onError: (message: string) => void
  ) => Promise<void>;
  onError: (message: string) => void;
}

export function StandingList({
  standings,
  factions,
  chapters,
  chapterLabelById,
  focus,
  editingStandingId,
  setEditingStandingId,
  standingFactionDraft,
  setStandingFactionDraft,
  standingTextDraft,
  setStandingTextDraft,
  standingChapterDraft,
  setStandingChapterDraft,
  standingUntilChapterDraft,
  setStandingUntilChapterDraft,
  standingNoteDraft,
  setStandingNoteDraft,
  startStandingEdit,
  saveStanding,
  removeStanding,
  newStandingFactionId,
  setNewStandingFactionId,
  newStandingFactionName,
  setNewStandingFactionName,
  newStandingText,
  setNewStandingText,
  newStandingChapterId,
  setNewStandingChapterId,
  newStandingNote,
  setNewStandingNote,
  addStanding,
  createFaction,
  onError,
}: StandingListProps) {
  return (
    <div className="standings-section">
      <h4 className="character-section-heading">Faction standings</h4>

      <div className="standing-list">
        {standings.length === 0 && (
          <div className="empty">
            No faction standings yet — record one below.
          </div>
        )}

        {standings.map(standing => {
          const factionName =
            (standing.faction_node_id
              ? factions.find(node => node.id === standing.faction_node_id)?.data
                  .label
              : null) ?? 'a faction no longer on the board';
          const sinceLabel = standing.since_chapter_id
            ? chapterLabelById.get(standing.since_chapter_id) ??
              'a chapter in the trash'
            : null;
          const untilLabel = standing.until_chapter_id
            ? chapterLabelById.get(standing.until_chapter_id) ??
              'a chapter in the trash'
            : null;
          const focused =
            focus?.kind === 'faction-standing' && focus.id === standing.id;

          return (
            <div
              key={standing.id}
              data-progression={`faction-standing-${standing.id}`}
              className={`standing-row${
                focused ? ' progression-row-focused' : ''
              }`}
            >
              {editingStandingId === standing.id ? (
                <div className="standing-editor">
                  <select
                    aria-label="Standing faction"
                    title="The faction card this standing belongs to"
                    value={standingFactionDraft}
                    onChange={(e) => setStandingFactionDraft(e.target.value)}
                  >
                    <option value="">Choose faction…</option>
                    {factions.map(node => (
                      <option key={node.id} value={node.id}>
                        {node.data.label}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Standing role"
                    placeholder="Standing (Member)"
                    autoFocus
                    value={standingTextDraft}
                    onChange={(e) => setStandingTextDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveStanding(standing);
                      if (e.key === 'Escape') setEditingStandingId(null);
                    }}
                  />
                  <select
                    aria-label="Standing since chapter"
                    title="The chapter this standing began in"
                    value={standingChapterDraft}
                    onChange={(e) => setStandingChapterDraft(e.target.value)}
                  >
                    <option value="">Choose chapter…</option>
                    {chapters.map(node => (
                      <option key={node.id} value={node.id}>
                        {node.data.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Standing until chapter"
                    title="The chapter this standing ended in, if it did"
                    value={standingUntilChapterDraft}
                    onChange={(e) =>
                      setStandingUntilChapterDraft(e.target.value)
                    }
                  >
                    <option value="">Still standing</option>
                    {chapters.map(node => (
                      <option key={node.id} value={node.id}>
                        {node.data.label}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Standing note"
                    placeholder="Note"
                    value={standingNoteDraft}
                    onChange={(e) => setStandingNoteDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveStanding(standing);
                      if (e.key === 'Escape') setEditingStandingId(null);
                    }}
                  />
                  <div className="standing-actions">
                    <button
                      title="Save this faction standing"
                      onClick={() => void saveStanding(standing)}
                    >
                      Save standing
                    </button>
                    <button
                      title="Leave the standing as it was"
                      onClick={() => setEditingStandingId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="standing-summary">
                    <span className="standing-faction">{factionName}</span>
                    <span className="standing-role">{standing.standing}</span>
                    <span className="standing-when">
                      {sinceLabel
                        ? `since ${sinceLabel}`
                        : 'no chapter recorded'}
                      {untilLabel ? ` – ${untilLabel}` : ''}
                    </span>
                  </div>
                  {standing.note && (
                    <span className="standing-note">{standing.note}</span>
                  )}
                  <button
                    title={`Change this ${standing.standing} standing`}
                    onClick={() => startStandingEdit(standing)}
                  >
                    Edit
                  </button>
                  <button
                    title={`Delete this ${standing.standing} standing`}
                    onClick={() => void removeStanding(standing)}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="standing-creator">
        <select
          aria-label="New standing faction"
          title="The faction card this standing belongs to"
          value={newStandingFactionId}
          onChange={(e) => setNewStandingFactionId(e.target.value)}
        >
          <option value="">Choose faction…</option>
          {factions.map(node => (
            <option key={node.id} value={node.id}>
              {node.data.label}
            </option>
          ))}
        </select>
        <span className="faction-quick-add">
          <input
            aria-label="New standing faction name"
            title="Make a faction card and record this standing in it"
            placeholder="New faction…"
            value={newStandingFactionName}
            onChange={event => setNewStandingFactionName(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void createFaction(
                newStandingFactionName,
                id => {
                  setNewStandingFactionId(id);
                  setNewStandingFactionName('');
                },
                onError
              );
            }}
          />
          <button
            type="button"
            title="Create this faction card and choose it"
            disabled={!newStandingFactionName.trim()}
            onClick={() =>
              void createFaction(
                newStandingFactionName,
                id => {
                  setNewStandingFactionId(id);
                  setNewStandingFactionName('');
                },
                onError
              )
            }
          >
            Add faction
          </button>
        </span>
        <input
          aria-label="New standing role"
          placeholder="Standing (Member)"
          value={newStandingText}
          onChange={(e) => setNewStandingText(e.target.value)}
        />
        <select
          aria-label="New standing since chapter"
          title="The chapter this standing began in"
          value={newStandingChapterId}
          onChange={(e) => setNewStandingChapterId(e.target.value)}
        >
          <option value="">Choose chapter…</option>
          {chapters.map(node => (
            <option key={node.id} value={node.id}>
              {node.data.label}
            </option>
          ))}
        </select>
        <input
          aria-label="New standing note"
          placeholder="Note"
          value={newStandingNote}
          onChange={(e) => setNewStandingNote(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addStanding()}
        />
        <button
          title="Record this faction standing on the character's sheet"
          onClick={() => void addStanding()}
          disabled={
            !newStandingFactionId || !newStandingText.trim() || !newStandingChapterId
          }
        >
          Add standing
        </button>
      </div>
    </div>
  );
}
