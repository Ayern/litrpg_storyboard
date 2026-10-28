import React, { useState } from 'react';
import type { Node } from 'reactflow';
import { HelpTip } from '../../components/HelpTip';
import { formatCount } from '../../lib/format';
import type { ChapterCastBadge, NodeData } from '../canvas/types';
import type { ChapterNote, ContinuityPart, ChapterContinuityFlag, Character, ProgressionTarget } from '../shared/types';
import type { Story } from '../stories/types';
import { ChapterCastPanel } from './ChapterCastPanel';
import { ChapterNotesPanel } from './ChapterNotesPanel';
import { CHAPTER_DRAG_TYPE, describeNumberingIssues, formatChapterWords } from './chapters';
import type { ChapterIssues, ChapterNode, ChapterTotals } from './chapters';

// The Chapters tab: the reading order, the word totals, each chapter's details,
// its cast and its notes, the timeline, and the continuity warnings. The panel
// owns the row-reorder interaction — which chapter is in the air and which side
// the drop would land on — because nothing outside the list reads it. Everything
// else it shows is state the board also writes: a cast edge on the canvas adds a
// cast member, a continuity flag opens a chapter, and the undo history restores
// both, so those live in the app and arrive here as props.

export interface ChaptersPanelProps {
  story: Story | null;
  renderSearchPalette: (placement: 'inline') => React.ReactNode;
  searchShortcut: string;
  openSearch: () => void;

  // The reading order and what it adds up to.
  chapterNodes: ChapterNode[];
  chapterIssues: ChapterIssues;
  chapterTotals: ChapterTotals;
  chapterWordsPercent: number;
  chapterTimeline: ChapterNode[];
  chapterError: string | null;
  chapterBusy: boolean;
  newChapterTitle: string;
  setNewChapterTitle: React.Dispatch<React.SetStateAction<string>>;
  addChapter: () => Promise<void>;
  // The ordered write the grip, the arrows and Renumber all go through. It
  // records one undo step, so the panel never writes the order itself.
  saveChapterOrder: (orderedIds: string[], undoIds: string[] | null) => Promise<void>;
  revealedChapterId: string | null;

  // The cast, by id, for the POV labels; and everyone, for the pickers.
  characters: Character[];
  castNames: Map<string, string>;
  chapterCastByChapter: Map<string, ChapterCastBadge[]>;
  chapterCastIsExplicit: (chapterId: string, characterId: string) => boolean;
  setChapterCastPresence: (
    chapterId: string,
    characterId: string,
    present: boolean
  ) => Promise<void>;
  chapterCastBusyId: string | null;
  chapterCastError: string | null;
  openChapterCastId: string | null;
  toggleChapterCastPanel: (chapterId: string) => void;

  // The details form, one chapter at a time, and the question asked before a
  // half-edited chapter is left behind.
  editingChapterId: string | null;
  openChapterDetails: (node: ChapterNode) => boolean;
  chapterArcInputRef: React.RefObject<HTMLInputElement | null>;
  chapterArcDraft: string;
  setChapterArcDraft: React.Dispatch<React.SetStateAction<string>>;
  chapterWordsDraft: string;
  setChapterWordsDraft: React.Dispatch<React.SetStateAction<string>>;
  chapterTargetDraft: string;
  setChapterTargetDraft: React.Dispatch<React.SetStateAction<string>>;
  chapterPovDraft: string;
  setChapterPovDraft: React.Dispatch<React.SetStateAction<string>>;
  chapterDayDraft: string;
  setChapterDayDraft: React.Dispatch<React.SetStateAction<string>>;
  chapterTimeDraft: string;
  setChapterTimeDraft: React.Dispatch<React.SetStateAction<string>>;
  saveChapterDetails: () => Promise<void>;
  requestChapterClose: () => void;
  chapterFormPrompt:
    | { kind: 'open'; id: string }
    | { kind: 'close' }
    | { kind: 'leave'; message: string; go: () => void }
    | null;
  dismissChapterPrompt: () => void;
  discardChapterEdit: () => void;
  closeChapterForm: () => void;
  leaveChapterForm: () => void;
  chapterKeepEditingRef: React.RefObject<HTMLButtonElement | null>;

  // The notes, and the panel that shows which chapter's are open.
  notesByChapter: Map<string, ChapterNote[]>;
  noteCount: (chapterId: string) => number;
  openNotesChapterId: string | null;
  toggleChapterNotes: (chapterId: string) => void;
  notePrompt: { message: string; go: () => void } | null;
  dismissNotePrompt: () => void;
  discardNoteDraft: () => void;
  noteKeepEditingRef: React.RefObject<HTMLButtonElement | null>;
  noteEditorRef: React.RefObject<HTMLTextAreaElement | null>;
  noteAddRef: React.RefObject<HTMLTextAreaElement | null>;
  editingNoteId: string | null;
  matchedNoteId: string | null;
  noteEditDraft: string;
  setNoteEditDraft: React.Dispatch<React.SetStateAction<string>>;
  noteDraft: string;
  setNoteDraft: React.Dispatch<React.SetStateAction<string>>;
  noteBusy: boolean;
  noteError: string | null;
  startNoteEdit: (note: ChapterNote) => void;
  requestNoteEditCancel: () => void;
  saveNoteEdit: () => Promise<void>;
  deleteNote: (note: ChapterNote) => Promise<void>;
  addNote: (chapterId: string) => Promise<void>;

  // The advisory continuity list, and where each of its parts leads.
  continuityLines: { parts: ContinuityPart[]; flag?: ChapterContinuityFlag }[];
  openCharacterSheet: (characterId: string, target?: ProgressionTarget) => void;
  revealChapter: (chapterId: string) => void;
  syncingXpMilestoneId: string | null;
  syncMilestoneXp: (flag: ChapterContinuityFlag) => Promise<void>;
  // The row a stat sync is writing, and the write itself.
  syncingStatKey: string | null;
  syncSheetStat: (flag: ChapterContinuityFlag) => Promise<void>;
}

export function ChaptersPanel({
  story,
  renderSearchPalette,
  searchShortcut,
  openSearch,
  chapterNodes,
  chapterIssues,
  chapterTotals,
  chapterWordsPercent,
  chapterTimeline,
  chapterError,
  chapterBusy,
  newChapterTitle,
  setNewChapterTitle,
  addChapter,
  saveChapterOrder,
  revealedChapterId,
  characters,
  castNames,
  chapterCastByChapter,
  chapterCastIsExplicit,
  setChapterCastPresence,
  chapterCastBusyId,
  chapterCastError,
  openChapterCastId,
  toggleChapterCastPanel,
  editingChapterId,
  openChapterDetails,
  chapterArcInputRef,
  chapterArcDraft,
  setChapterArcDraft,
  chapterWordsDraft,
  setChapterWordsDraft,
  chapterTargetDraft,
  setChapterTargetDraft,
  chapterPovDraft,
  setChapterPovDraft,
  chapterDayDraft,
  setChapterDayDraft,
  chapterTimeDraft,
  setChapterTimeDraft,
  saveChapterDetails,
  requestChapterClose,
  chapterFormPrompt,
  dismissChapterPrompt,
  discardChapterEdit,
  closeChapterForm,
  leaveChapterForm,
  chapterKeepEditingRef,
  notesByChapter,
  noteCount,
  openNotesChapterId,
  toggleChapterNotes,
  notePrompt,
  dismissNotePrompt,
  discardNoteDraft,
  noteKeepEditingRef,
  noteEditorRef,
  noteAddRef,
  editingNoteId,
  matchedNoteId,
  noteEditDraft,
  setNoteEditDraft,
  noteDraft,
  setNoteDraft,
  noteBusy,
  noteError,
  startNoteEdit,
  requestNoteEditCancel,
  saveNoteEdit,
  deleteNote,
  addNote,
  continuityLines,
  openCharacterSheet,
  revealChapter,
  syncingXpMilestoneId,
  syncMilestoneXp,
  syncingStatKey,
  syncSheetStat,
}: ChaptersPanelProps) {
  // A chapter being dragged, and the row under the pointer with the side the
  // drop would land on. Both are cleared when the drag ends, however it ends.
  const [draggedChapterId, setDraggedChapterId] = useState<string | null>(null);
  const [chapterDrop, setChapterDrop] = useState<{ id: string; after: boolean } | null>(
    null
  );

  const moveChapter = (id: string, delta: number) => {
    const order = chapterNodes.map(node => node.id);
    const from = order.indexOf(id);
    const to = from + delta;

    if (from < 0 || to < 0 || to >= order.length) return;

    const next = [...order];
    [next[from], next[to]] = [next[to], next[from]];
    void saveChapterOrder(next, order);
  };

  // The grip on a row starts a pointer drag; the row under the pointer shows the
  // side the chapter would land on. One ordered write follows, the same command
  // the arrows use, so the whole list stays consistent and the move is undoable.
  const startChapterDrag = (
    event: React.DragEvent<HTMLElement>,
    nodeId: string
  ) => {
    if (chapterBusy) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(CHAPTER_DRAG_TYPE, nodeId);
    setDraggedChapterId(nodeId);
    setChapterDrop(null);
  };

  const chapterDropIsAfter = (
    event: React.DragEvent<HTMLElement>,
    element: HTMLElement
  ) => {
    const rect = element.getBoundingClientRect();

    return event.clientY > rect.top + rect.height / 2;
  };

  const dragOverChapter = (event: React.DragEvent<HTMLElement>, nodeId: string) => {
    if (!draggedChapterId || draggedChapterId === nodeId || chapterBusy) return;

    // Only a chapter drag is accepted; a cast card in the air keeps its own drop
    // targets and must not be treated as a move.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const after = chapterDropIsAfter(event, event.currentTarget);

    setChapterDrop(current =>
      current?.id === nodeId && current.after === after
        ? current
        : { id: nodeId, after }
    );
  };

  const dragLeaveChapter = (event: React.DragEvent<HTMLElement>, nodeId: string) => {
    // Moving between the row's own children is not leaving the row.
    if (event.currentTarget.contains(event.relatedTarget as HTMLElement | null)) return;

    setChapterDrop(current => (current?.id === nodeId ? null : current));
  };

  const dropChapter = (event: React.DragEvent<HTMLElement>, nodeId: string) => {
    event.preventDefault();

    const draggedId = draggedChapterId;

    setDraggedChapterId(null);
    setChapterDrop(null);

    if (!draggedId || chapterBusy || draggedId === nodeId) return;

    const order = chapterNodes.map(node => node.id);
    const from = order.indexOf(draggedId);
    const target = order.indexOf(nodeId);

    if (from < 0 || target < 0) return;

    const after = chapterDropIsAfter(event, event.currentTarget);
    const next = order.filter(id => id !== draggedId);
    // Removing the dragged row first shifts every position after it down one.
    let insertAt = target + (after ? 1 : 0);
    if (from < insertAt) insertAt -= 1;
    next.splice(insertAt, 0, draggedId);

    // A drop that leaves the list as it was writes nothing.
    if (next.every((id, index) => id === order[index])) return;

    void saveChapterOrder(next, order);
  };

  const endChapterDrag = () => {
    setDraggedChapterId(null);
    setChapterDrop(null);
  };

  // The escape hatch for data that arrived numbered badly: number what is shown,
  // in the order it is shown.
  const renumberChapters = () => {
    void saveChapterOrder(
      chapterNodes.map(node => node.id),
      null
    );
  };

  if (!story) {
    return (
      <div className="empty-state">Load a story to put its chapters in order</div>
    );
  }

  return (
    <div className="chapters-layout">
      {renderSearchPalette('inline')}
      <div className="chapters-header">
        <div>
          <h3 className="chapters-heading">Reading order</h3>
          <p className="chapters-hint">
            Chapter cards on the Graph tab, numbered from 1. Moving one
            renumbers the rest. Drag a row's grip, or use the arrows, to
            move it; a new chapter joins the end.
          </p>
        </div>

        <div className="chapter-creator">
          <input
            placeholder="Chapter title"
            value={newChapterTitle}
            onChange={(e) => setNewChapterTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addChapter();
            }}
          />
          <button
            title="Create a chapter card at the end of the reading order"
            onClick={() => void addChapter()}
            disabled={!newChapterTitle.trim() || chapterBusy}
          >
            New chapter
          </button>
          <button
            type="button"
            className="chapter-search-button"
            title={`Find a card, a cast member, a connection, a note or a story (${searchShortcut})`}
            onClick={openSearch}
          >
            Search
          </button>
        </div>
      </div>

      {chapterError && <div className="audit-error">{chapterError}</div>}

      {(chapterIssues.duplicates.length > 0 ||
        chapterIssues.missing.length > 0 ||
        chapterIssues.unnumbered > 0) && (
        <div className="chapter-warning">
          <span>{describeNumberingIssues(chapterIssues)}</span>
          <button
            title="Number the chapters one after another in the order shown"
            onClick={renumberChapters}
            disabled={chapterBusy}
          >
            Renumber
          </button>
        </div>
      )}

      {chapterNodes.length === 0 ? (
        <div className="empty">
          No chapters yet — add one here, or add a chapter card on the Graph tab.
        </div>
      ) : (
        <>
          <div className="chapter-totals">
            <div className="chapter-totals-head">
              <span className="chapter-totals-count">
                {formatCount(chapterTotals.words)}{' '}
                {chapterTotals.words === 1 ? 'word' : 'words'}
                {chapterTotals.target != null &&
                  ` of ${formatCount(chapterTotals.target)}`}
              </span>
              <span className="chapter-totals-note">
                {chapterNodes.length} chapter
                {chapterNodes.length === 1 ? '' : 's'}
                {chapterTotals.target != null &&
                chapterTotals.targeted < chapterNodes.length
                  ? ` · ${chapterTotals.targeted} with a target`
                  : ''}
              </span>
            </div>

            {chapterTotals.target != null && (
              <div
                className="chapter-total-bar"
                role="progressbar"
                aria-label="Story word count"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={chapterWordsPercent}
              >
                <div
                  className="chapter-total-fill"
                  style={{ width: `${chapterWordsPercent}%` }}
                />
              </div>
            )}
          </div>

          <ol className="chapter-list" aria-label="Chapters">
            {chapterNodes.map((node, index) => (
              <li
                key={node.id}
                className={[
                  'chapter-row',
                  revealedChapterId === node.id ? 'chapter-row-revealed' : '',
                  draggedChapterId === node.id ? 'chapter-row-dragging' : '',
                  chapterDrop?.id === node.id
                    ? chapterDrop.after
                      ? 'chapter-row-drop-after'
                      : 'chapter-row-drop-before'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-chapter-id={node.id}
                onDragOver={event => dragOverChapter(event, node.id)}
                onDragLeave={event => dragLeaveChapter(event, node.id)}
                onDrop={event => dropChapter(event, node.id)}
              >
                <div className="chapter-row-main">
                  <span
                    className="chapter-drag"
                    draggable={!chapterBusy}
                    aria-hidden="true"
                    title={`Drag ${node.data.label} to another place; the arrows move it without the pointer`}
                    onDragStart={event => startChapterDrag(event, node.id)}
                    onDragEnd={endChapterDrag}
                  >
                    ⠿
                  </span>
                  <span className="chapter-number">
                    {node.data.chapterSeq ?? '—'}
                  </span>
                  <span className="chapter-label">{node.data.label}</span>
                  {node.data.chapterArc && (
                    <span className="chapter-arc" title="Arc">
                      {node.data.chapterArc}
                    </span>
                  )}
                  {node.data.chapterPov && (
                    <span className="chapter-pov" title="Point of view">
                      {castNames.get(node.data.chapterPov) ??
                        'cast member in the trash'}
                    </span>
                  )}
                  {node.data.chapterDay != null && (
                    <span className="chapter-day" title="In-world day">
                      Day {node.data.chapterDay}
                    </span>
                  )}
                  {node.data.chapterTime && (
                    <span className="chapter-time" title="Time of day">
                      {node.data.chapterTime}
                    </span>
                  )}
                  <span className="chapter-words">
                    {formatChapterWords(
                      node.data.chapterWords,
                      node.data.chapterTarget
                    )}
                  </span>
                  <button
                    aria-label={`Edit ${node.data.label} details`}
                    title="Set the arc, the day, the time and the word count"
                    onClick={() => openChapterDetails(node)}
                    disabled={chapterBusy}
                  >
                    Edit
                  </button>
                  <button
                    aria-label={`Notes for ${node.data.label}`}
                    title="Plain-text notes kept with this chapter"
                    onClick={() => toggleChapterNotes(node.id)}
                    disabled={chapterBusy}
                  >
                    {noteCount(node.id) > 0
                      ? `Notes (${noteCount(node.id)})`
                      : 'Notes'}
                  </button>
                  <button
                    aria-label={`Cast for ${node.data.label}`}
                    title="Choose everyone present in this chapter"
                    onClick={() => toggleChapterCastPanel(node.id)}
                    disabled={chapterBusy}
                  >
                    {(() => {
                      const count = chapterCastByChapter.get(node.id)?.length ?? 0;
                      return count > 0 ? `Cast (${count})` : 'Cast';
                    })()}
                  </button>
                  <button
                    aria-label={`Move ${node.data.label} earlier`}
                    title="Move this chapter one place earlier"
                    onClick={() => moveChapter(node.id, -1)}
                    disabled={index === 0 || chapterBusy}
                  >
                    ↑
                  </button>
                  <button
                    aria-label={`Move ${node.data.label} later`}
                    title="Move this chapter one place later"
                    onClick={() => moveChapter(node.id, 1)}
                    disabled={index === chapterNodes.length - 1 || chapterBusy}
                  >
                    ↓
                  </button>
                </div>

                {editingChapterId === node.id && (
                  <div className="chapter-details-form">
                    <label>
                      Arc
                      <input
                        ref={chapterArcInputRef}
                        autoFocus
                        placeholder="No arc"
                        value={chapterArcDraft}
                        onChange={(e) => setChapterArcDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveChapterDetails();
                          if (e.key === 'Escape') requestChapterClose();
                        }}
                      />
                    </label>
                    <label>
                      Words
                      <input
                        type="number"
                        min={0}
                        placeholder="0"
                        value={chapterWordsDraft}
                        onChange={(e) => setChapterWordsDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveChapterDetails();
                          if (e.key === 'Escape') requestChapterClose();
                        }}
                      />
                    </label>
                    <label>
                      Target
                      <input
                        type="number"
                        min={1}
                        placeholder="None"
                        value={chapterTargetDraft}
                        onChange={(e) => setChapterTargetDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveChapterDetails();
                          if (e.key === 'Escape') requestChapterClose();
                        }}
                      />
                    </label>
                    <label>
                      POV
                      <select
                        title="Whose point of view the chapter is told from"
                        value={chapterPovDraft}
                        onChange={(e) => setChapterPovDraft(e.target.value)}
                      >
                        <option value="">No POV</option>
                        {/* A POV whose cast member is in the trash is
                            kept and shown, not silently dropped. */}
                        {chapterPovDraft && !castNames.has(chapterPovDraft) && (
                          <option value={chapterPovDraft}>
                            Cast member in the trash
                          </option>
                        )}
                        {characters.map(character => (
                          <option key={character.id} value={character.id}>
                            {character.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Day
                      <input
                        type="number"
                        min={0}
                        placeholder="Not placed"
                        value={chapterDayDraft}
                        onChange={(e) => setChapterDayDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveChapterDetails();
                          if (e.key === 'Escape') requestChapterClose();
                        }}
                      />
                    </label>
                    <label>
                      Time
                      <input
                        placeholder="Dusk"
                        title="When inside the day, in your own words: Dusk, 18:40, after the fire"
                        value={chapterTimeDraft}
                        onChange={(e) => setChapterTimeDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveChapterDetails();
                          if (e.key === 'Escape') requestChapterClose();
                        }}
                      />
                    </label>
                    <div className="chapter-details-actions">
                      <button
                        title="Save the arc, the day, the time and the word counts"
                        onClick={() => void saveChapterDetails()}
                        disabled={chapterBusy}
                      >
                        Save
                      </button>
                      <button
                        title="Leave this chapter as it was"
                        onClick={requestChapterClose}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {editingChapterId === node.id && chapterFormPrompt && (
                  <div
                    className="chapter-details-prompt"
                    role="alertdialog"
                    aria-label="Unsaved chapter changes"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        dismissChapterPrompt();
                      }
                    }}
                  >
                    <p>
                      {chapterFormPrompt.kind === 'open'
                        ? `Open “${
                            chapterNodes.find(
                              candidate => candidate.id === chapterFormPrompt.id
                            )?.data.label ?? 'another chapter'
                          }” and drop these changes?`
                        : chapterFormPrompt.kind === 'close'
                          ? 'Close this chapter and drop these changes?'
                          : chapterFormPrompt.message}
                    </p>
                    <div className="chapter-details-prompt-actions">
                      {chapterFormPrompt.kind === 'open' ? (
                        <button
                          title="Open the other chapter and lose these edits"
                          onClick={discardChapterEdit}
                        >
                          Discard and open
                        </button>
                      ) : chapterFormPrompt.kind === 'close' ? (
                        <button
                          title="Close the form and lose these edits"
                          onClick={closeChapterForm}
                        >
                          Discard changes
                        </button>
                      ) : (
                        <button
                          title="Leave this chapter and lose these edits"
                          onClick={leaveChapterForm}
                        >
                          Discard and continue
                        </button>
                      )}
                      <button
                        ref={chapterKeepEditingRef}
                        title="Stay on this chapter with the edits as they are"
                        onClick={dismissChapterPrompt}
                      >
                        Keep editing
                      </button>
                    </div>
                  </div>
                )}

                {openChapterCastId === node.id && (
                  <ChapterCastPanel
                    chapterId={node.id}
                    chapterLabel={node.data.label}
                    povId={node.data.chapterPov ?? null}
                    characters={characters}
                    chapterCastIsExplicit={chapterCastIsExplicit}
                    setChapterCastPresence={setChapterCastPresence}
                    busy={chapterBusy || chapterCastBusyId !== null}
                    chapterCastError={chapterCastError}
                  />
                )}

                {openNotesChapterId === node.id && (
                  <ChapterNotesPanel
                    chapterLabel={node.data.label}
                    notes={notesByChapter.get(node.id) ?? []}
                    notePrompt={notePrompt}
                    dismissNotePrompt={dismissNotePrompt}
                    discardNoteDraft={discardNoteDraft}
                    noteKeepEditingRef={noteKeepEditingRef}
                    noteEditorRef={noteEditorRef}
                    noteAddRef={noteAddRef}
                    editingNoteId={editingNoteId}
                    matchedNoteId={matchedNoteId}
                    noteEditDraft={noteEditDraft}
                    setNoteEditDraft={setNoteEditDraft}
                    noteDraft={noteDraft}
                    setNoteDraft={setNoteDraft}
                    noteBusy={noteBusy}
                    noteError={noteError}
                    startNoteEdit={startNoteEdit}
                    requestNoteEditCancel={requestNoteEditCancel}
                    saveNoteEdit={saveNoteEdit}
                    deleteNote={deleteNote}
                    addNote={() => addNote(node.id)}
                  />
                )}
              </li>
            ))}
          </ol>

          <section
            className="chapter-timeline"
            aria-labelledby="chapter-timeline-heading"
          >
            <div className="chapter-timeline-head">
              <h3 id="chapter-timeline-heading">Timeline</h3>
              <span className="chapter-timeline-note">
                {chapterTimeline.length} placed
                {chapterTimeline.length < chapterNodes.length &&
                  ` · ${chapterNodes.length - chapterTimeline.length} without a day`}
              </span>
            </div>

            {chapterTimeline.length === 0 ? (
              <p className="chapters-hint">
                Give a chapter an in-world day to place it on the timeline.
              </p>
            ) : (
              <ol className="chapter-timeline-list" aria-label="Chapter timeline">
                {chapterTimeline.map(node => (
                  <li key={node.id} className="chapter-timeline-row">
                    <span className="chapter-timeline-day">
                      Day {node.data.chapterDay}
                    </span>
                    {node.data.chapterTime && (
                      <span className="chapter-timeline-time">
                        {node.data.chapterTime}
                      </span>
                    )}
                    {node.data.chapterSeq != null && (
                      <span className="chapter-timeline-seq">
                        #{node.data.chapterSeq}
                      </span>
                    )}
                    <span className="chapter-timeline-label">
                      {node.data.label}
                    </span>
                    {node.data.chapterPov && (
                      <span className="chapter-timeline-pov">
                        {castNames.get(node.data.chapterPov) ??
                          'cast member in the trash'}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {continuityLines.length > 0 && (
            <section
              className="chapter-continuity"
              aria-labelledby="chapter-continuity-heading"
            >
              <div className="chapter-continuity-head">
                <h3 id="chapter-continuity-heading">Continuity</h3>
                <span className="chapter-continuity-note">
                  {continuityLines.length} to check · advisory
                </span>
                <HelpTip label="continuity warnings">
                  These compare the ledger with the story and point at what
                  cannot both be true: a skill learned before its parent, an
                  item lost before it was found, a level that goes down
                  without a penalty. They are advisory, and a sync writes the
                  ledger’s number onto the milestone — or a level-up’s number
                  onto the sheet — as one undoable change.
                </HelpTip>
              </div>
              <ul>
                {continuityLines.map(({ parts, flag }, index) => (
                  <li
                    key={`${index}-${parts
                      .map(part => (typeof part === 'string' ? part : part.text))
                      .join('')}`}
                  >
                    {parts.map((part, partIndex) =>
                      typeof part === 'string' ? (
                        <React.Fragment key={partIndex}>{part}</React.Fragment>
                      ) : (
                        <button
                          key={partIndex}
                          type="button"
                          className="chapter-continuity-link"
                          title={
                            part.kind === 'character'
                              ? "Open this entry on the character's sheet"
                              : "Open this chapter's details"
                          }
                          onClick={() =>
                            part.kind === 'character'
                              ? openCharacterSheet(part.id, part.target)
                              : revealChapter(part.id)
                          }
                        >
                          {part.text}
                        </button>
                      )
                    )}
                    {flag?.kind === 'xp-income-mismatch' &&
                      flag.ledgerXp != null &&
                      flag.target.kind === 'level' && (
                        <div className="chapter-continuity-fix">
                          <button
                            type="button"
                            className="chapter-continuity-sync"
                            title="Record the chapter ledger's total on this milestone"
                            disabled={
                              syncingXpMilestoneId === flag.target.milestoneId
                            }
                            onClick={() => void syncMilestoneXp(flag)}
                          >
                            {syncingXpMilestoneId === flag.target.milestoneId
                              ? 'Syncing…'
                              : `Sync to ${formatCount(flag.ledgerXp)} XP`}
                          </button>
                        </div>
                      )}
                    {flag?.kind === 'stat-sheet-mismatch' &&
                      flag.statName &&
                      flag.statValue != null && (
                        <div className="chapter-continuity-fix">
                          <button
                            type="button"
                            className="chapter-continuity-sync"
                            title={`Record the level-up's ${flag.statName} of ${flag.statValue} on the sheet`}
                            disabled={
                              syncingStatKey ===
                              `${flag.characterId}::${flag.statName}`
                            }
                            onClick={() => void syncSheetStat(flag)}
                          >
                            {syncingStatKey ===
                            `${flag.characterId}::${flag.statName}`
                              ? 'Syncing…'
                              : `Set to ${flag.statValue}`}
                          </button>
                        </div>
                      )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
