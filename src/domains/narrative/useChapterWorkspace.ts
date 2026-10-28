import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IndexedNode, NodeData } from '../canvas/types';
import type { ChapterNote } from '../shared/types';
import * as narrativeApi from './api';
import { groupNotesByChapter } from './chapters';
import type { ChapterNode } from './chapters';
import type { ChapterCastMember } from './types';

// The Chapters tab's own state: the reading list's controls, the details form
// with the question it asks before being left, the notes panel, and the cast
// picker. The cards, the notes and the cast rows belong to the story, so the
// rows it reads arrive as arguments and the ones it writes are reported back
// through callbacks rather than written into somebody else's state.
//
// The order the chapters are drawn in, which chapter is in the air and which
// side a drop lands on are the panel's: nothing outside the list reads them.

export interface ChapterWorkspaceOptions {
  // The live chapters, so a question can name the row it is about.
  chapterNodes: ChapterNode[];
  // The explicit cast rows, which the board also writes when an edge is drawn.
  chapterCast: ChapterCastMember[];
  actor: string;
  onCastMemberAdded: (row: ChapterCastMember) => void;
  onCastMemberRemoved: (id: string) => void;
}

export function useChapterWorkspace({
  chapterNodes,
  chapterCast,
  actor,
  onCastMemberAdded,
  onCastMemberRemoved,
}: ChapterWorkspaceOptions) {
  // The chapter list's own controls.
  const [newChapterTitle, setNewChapterTitle] = useState('');
  const [chapterError, setChapterError] = useState<string | null>(null);
  const [chapterBusy, setChapterBusy] = useState(false);

  // The arc and word counts, edited one chapter at a time in the list.
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  // The chapter a continuity flag just opened, lit briefly so the eye can find
  // the row the scroll landed on.
  const [revealedChapterId, setRevealedChapterId] = useState<string | null>(null);
  const revealTimer = useRef<number | null>(null);
  // The question the open form is waiting on: opening another chapter while this
  // one has unsaved edits, closing the form, or navigating away from it — a tab,
  // a story, a search result. One state, so two questions can never be asked at
  // once.
  const [chapterFormPrompt, setChapterFormPrompt] = useState<
    | { kind: 'open'; id: string }
    | { kind: 'close' }
    | { kind: 'leave'; message: string; go: () => void }
    | null
  >(null);
  // The drafts the open form started with, so an untouched form is known to be
  // clean even when its values are not what the saved chapter holds.
  const chapterOpenedDrafts = useRef<string[] | null>(null);
  // Where focus goes when a question appears, so the keyboard is on the answer
  // rather than left in the field the question is about.
  const chapterKeepEditingRef = useRef<HTMLButtonElement | null>(null);
  const noteKeepEditingRef = useRef<HTMLButtonElement | null>(null);
  // Where the keyboard goes back to once a question is answered, so dismissing it
  // does not leave focus on a button that is about to disappear.
  const chapterArcInputRef = useRef<HTMLInputElement | null>(null);
  const noteEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const noteAddRef = useRef<HTMLTextAreaElement | null>(null);
  const [chapterArcDraft, setChapterArcDraft] = useState('');
  const [chapterWordsDraft, setChapterWordsDraft] = useState('');
  const [chapterTargetDraft, setChapterTargetDraft] = useState('');
  const [chapterPovDraft, setChapterPovDraft] = useState('');
  const [chapterDayDraft, setChapterDayDraft] = useState('');
  const [chapterTimeDraft, setChapterTimeDraft] = useState('');

  // The explicit cast of each chapter: everyone present beyond its point of
  // view. One picker is open at a time.
  const [openChapterCastId, setOpenChapterCastId] = useState<string | null>(null);
  const [chapterCastBusyId, setChapterCastBusyId] = useState<string | null>(null);
  const [chapterCastError, setChapterCastError] = useState<string | null>(null);

  // The plain-text notes kept with each chapter, and the one panel that is open.
  const [notes, setNotes] = useState<ChapterNote[]>([]);
  const [openNotesChapterId, setOpenNotesChapterId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  // The note a search result pointed at, marked for a moment after it is opened.
  const [matchedNoteId, setMatchedNoteId] = useState<string | null>(null);
  const noteHighlightRef = useRef<number | null>(null);
  // Closing the note panel or moving it to another chapter is a way to lose a
  // half-written note, so it asks first, in the panel where the typing is.
  const [notePrompt, setNotePrompt] = useState<{ message: string; go: () => void } | null>(
    null
  );

  // The notes grouped by their chapter, which is how both the panel and the card
  // badge count them.
  const notesByChapter = useMemo(() => groupNotesByChapter(notes), [notes]);

  const noteCount = (chapterId: string) => notesByChapter.get(chapterId)?.length ?? 0;

  // The rows a load brought back. A note is stored as a node, so the rows are the
  // board's shape and are mapped once, here, rather than by every caller.
  const followLoadedNotes = useCallback((rows: readonly IndexedNode[]) => {
    setNotes(rows.map(toChapterNote));
  }, []);

  const clearNotes = useCallback(() => setNotes([]), []);

  // Scrolling a row into view and lighting it for a moment, so a warning or a
  // search result points at the chapter instead of naming it.
  const focusChapterRow = (chapterId: string) => {
    document
      .querySelector(`[data-chapter-id="${chapterId}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });

    setRevealedChapterId(chapterId);

    if (revealTimer.current != null) window.clearTimeout(revealTimer.current);

    revealTimer.current = window.setTimeout(() => {
      setRevealedChapterId(null);
      revealTimer.current = null;
    }, 1200);
  };

  const startChapterEdit = (node: { id: string; data: NodeData }) => {
    setChapterError(null);
    setEditingChapterId(node.id);

    const drafts = [
      node.data.chapterArc ?? '',
      node.data.chapterWords != null ? String(node.data.chapterWords) : '',
      node.data.chapterTarget != null ? String(node.data.chapterTarget) : '',
      node.data.chapterPov ?? '',
      node.data.chapterDay != null ? String(node.data.chapterDay) : '',
      node.data.chapterTime ?? '',
    ];

    setChapterArcDraft(drafts[0]);
    setChapterWordsDraft(drafts[1]);
    setChapterTargetDraft(drafts[2]);
    setChapterPovDraft(drafts[3]);
    setChapterDayDraft(drafts[4]);
    setChapterTimeDraft(drafts[5]);

    chapterOpenedDrafts.current = drafts;
  };

  // Whether the open form holds anything that has not been saved. Comparing with
  // the drafts it opened with, rather than with the stored chapter, means typing
  // a value and undoing it leaves the form clean.
  const chapterDraftIsDirty = () => {
    // A closed form holds no draft. Saving closes it and leaves the baseline it
    // opened with behind, so comparing against that would call saved work dirty
    // and block every tab with a question that has no form left to show it in.
    if (editingChapterId == null) return false;

    const opened = chapterOpenedDrafts.current;

    if (!opened) return false;

    return [
      chapterArcDraft,
      chapterWordsDraft,
      chapterTargetDraft,
      chapterPovDraft,
      chapterDayDraft,
      chapterTimeDraft,
    ].some((draft, index) => draft !== opened[index]);
  };

  // Opens a chapter's details. When another chapter's form has unsaved drafts the
  // switch waits for an answer instead of dropping them, which is what a flag or
  // another row's Edit button used to do silently. Answers whether the details
  // are now open on that chapter.
  const openChapterDetails = (node: { id: string; data: NodeData }) => {
    if (editingChapterId === node.id) return true;

    if (editingChapterId != null && chapterDraftIsDirty()) {
      setChapterError(null);
      setChapterFormPrompt({ kind: 'open', id: node.id });
      return false;
    }

    setChapterFormPrompt(null);
    startChapterEdit(node);
    return true;
  };

  // Answering a question returns the keyboard to the field it was about.
  const dismissChapterPrompt = () => {
    setChapterFormPrompt(null);
    chapterArcInputRef.current?.focus();
  };

  // Closing the form is the other way to lose a draft, so it asks the same
  // question when there is something to lose. A second Escape dismisses the
  // question, as it does for a note.
  const requestChapterClose = () => {
    if (chapterFormPrompt) {
      dismissChapterPrompt();
      return;
    }

    if (chapterDraftIsDirty()) {
      setChapterFormPrompt({ kind: 'close' });
      return;
    }

    setEditingChapterId(null);
  };

  // The question, without the test: the caller already knows there is a draft to
  // lose, because it is the one that counted it.
  const askToLeaveChapter = (message: string, go: () => void) => {
    setChapterFormPrompt({ kind: 'leave', message, go });
  };

  // Leaving the form behind — another tab, another story, a search result — asks
  // the same question, then does what was asked.
  const requestChapterLeave = (message: string, go: () => void) => {
    if (chapterDraftIsDirty()) {
      askToLeaveChapter(message, go);
      return;
    }

    go();
  };

  // A flag leads somewhere: the chapter it names opens its details, and the row
  // is brought into view and lit for a moment so the warning is answered where
  // it was raised.
  const revealChapter = (chapterId: string) => {
    const node = chapterNodes.find(candidate => candidate.id === chapterId);

    if (!node || !openChapterDetails(node)) return;

    focusChapterRow(chapterId);
  };

  // The answer to the prompt: drop the open drafts and go where the flag pointed.
  const discardChapterEdit = () => {
    const next =
      chapterFormPrompt?.kind === 'open'
        ? chapterNodes.find(candidate => candidate.id === chapterFormPrompt.id)
        : null;

    setChapterFormPrompt(null);

    if (!next) return;

    startChapterEdit(next);
    focusChapterRow(next.id);
  };

  // The same answer when the form was being closed: drop the drafts and close.
  const closeChapterForm = () => {
    setChapterFormPrompt(null);
    setEditingChapterId(null);
  };

  // The answer when the form was being left behind: drop the drafts, then go
  // where the author asked to go.
  const leaveChapterForm = () => {
    if (chapterFormPrompt?.kind !== 'leave') return;

    const go = chapterFormPrompt.go;

    setChapterFormPrompt(null);
    setEditingChapterId(null);
    go();
  };

  // A save closes the form; the question it may have been showing goes with it.
  const finishChapterSave = () => {
    setEditingChapterId(null);
  };

  // Dropping the open chapter's typing without asking, for a navigation that has
  // already had its answer.
  const abandonChapterDrafts = () => {
    setChapterFormPrompt(null);
    setEditingChapterId(null);
  };

  // Whether the note panel holds something not yet saved: an edited note whose
  // text has changed, or a new note that has been typed into.
  const noteDraftIsDirty = () => {
    if (editingNoteId != null) {
      const saved = notes.find(note => note.id === editingNoteId);

      return saved != null && noteEditDraft !== saved.text;
    }

    return noteDraft.trim() !== '';
  };

  const requestNoteLeave = (go: () => void) => {
    if (!noteDraftIsDirty()) {
      go();
      return;
    }

    setNoteError(null);
    setNotePrompt({
      message:
        editingNoteId != null
          ? 'Discard your changes to this note?'
          : 'Discard this new note?',
      go,
    });
  };

  // Notes are shown one chapter at a time. Opening another or closing this one
  // asks first when there is typing to lose.
  const toggleChapterNotes = (chapterId: string) => {
    const closing = openNotesChapterId === chapterId;

    requestNoteLeave(() => {
      setEditingNoteId(null);
      setNoteDraft('');
      setNoteError(null);
      setMatchedNoteId(null);
      setNotePrompt(null);
      setOpenNotesChapterId(closing ? null : chapterId);
    });
  };

  // A search result for a note opens the chapter it lives in and marks the note
  // for a moment, so the found text does not have to be hunted for in the list.
  const openChapterNotes = useCallback((chapterId: string, noteId: string | null) => {
    // An edit in progress in another chapter keeps its draft: the panel hides it
    // rather than throwing the typing away.
    setNoteError(null);
    setOpenNotesChapterId(chapterId);
    setMatchedNoteId(noteId);

    if (noteHighlightRef.current !== null) {
      window.clearTimeout(noteHighlightRef.current);
    }
    noteHighlightRef.current = window.setTimeout(() => {
      setMatchedNoteId(null);
      noteHighlightRef.current = null;
    }, 2400);

    // The tab is rendered by now, but the row still has to be scrolled to.
    setTimeout(() => {
      document
        .querySelector(`[data-chapter-id="${chapterId}"]`)
        ?.scrollIntoView?.({ block: 'nearest' });
    }, 0);
  }, []);

  const addNote = async (chapterId: string) => {
    const text = noteDraft.trim();

    if (!text) {
      setNoteError('A note needs some text.');
      return;
    }

    setNoteBusy(true);
    setNoteError(null);

    try {
      const created = await narrativeApi.addChapterNote(chapterId, text, actor);

      setNotes(previous => [...previous, toChapterNote(created)]);
      setNoteDraft('');
    } catch (e) {
      console.error('Failed to add a note:', e);
      setNoteError(`Could not add the note: ${String(e)}`);
    } finally {
      setNoteBusy(false);
    }
  };

  const startNoteEdit = (note: ChapterNote) => {
    if (editingNoteId === note.id) return;

    const open = () => {
      setNoteError(null);
      setEditingNoteId(note.id);
      setNoteEditDraft(note.text);
      setNotePrompt(null);
    };

    // Editing another note is a move within the panel, and only an edited note
    // holds a draft that the move would drop.
    if (editingNoteId != null) {
      requestNoteLeave(open);
      return;
    }

    open();
  };

  const dismissNotePrompt = () => {
    setNotePrompt(null);
    (editingNoteId != null ? noteEditorRef.current : noteAddRef.current)?.focus();
  };

  // Cancelling an edit closes the editor rather than the panel, and asks first
  // when the note has been changed. A second Escape is the answer to the
  // question: it dismisses it, the same as Keep editing.
  const requestNoteEditCancel = () => {
    if (notePrompt) {
      dismissNotePrompt();
      return;
    }

    const closeEditor = () => {
      setEditingNoteId(null);
      setNoteEditDraft('');
      setNotePrompt(null);
    };

    if (editingNoteId != null && noteDraftIsDirty()) {
      setNoteError(null);
      setNotePrompt({
        message: 'Discard your changes to this note?',
        go: closeEditor,
      });
      return;
    }

    closeEditor();
  };

  // The answer to the note prompt: drop the draft and do what was asked.
  const discardNoteDraft = () => {
    if (!notePrompt) return;

    const go = notePrompt.go;

    setNotePrompt(null);
    go();
  };

  const saveNoteEdit = async () => {
    if (!editingNoteId) return;

    const text = noteEditDraft.trim();

    if (!text) {
      setNoteError('A note needs some text.');
      return;
    }

    setNoteBusy(true);
    setNoteError(null);

    try {
      const updated = await narrativeApi.updateChapterNote(editingNoteId, text, actor);
      const row = toChapterNote(updated);

      setNotes(previous => previous.map(note => (note.id === row.id ? row : note)));
      setEditingNoteId(null);
    } catch (e) {
      console.error('Failed to save a note:', e);
      setNoteError(`Could not save the note: ${String(e)}`);
    } finally {
      setNoteBusy(false);
    }
  };

  // Deleting a note moves it to the trash, like a card: the Trash tab can bring it
  // back for as long as the retention window lasts.
  const deleteNote = async (note: ChapterNote) => {
    setNoteBusy(true);
    setNoteError(null);

    try {
      await narrativeApi.deleteChapterNote(note.id, actor);

      setNotes(previous => previous.filter(entry => entry.id !== note.id));
      setEditingNoteId(previous => (previous === note.id ? null : previous));
    } catch (e) {
      console.error('Failed to delete a note:', e);
      setNoteError(`Could not delete the note: ${String(e)}`);
    } finally {
      setNoteBusy(false);
    }
  };

  // Dropping the note panel's typing without asking, for a navigation that has
  // already had its answer.
  const abandonNoteDrafts = () => {
    setNotePrompt(null);
    setEditingNoteId(null);
    setNoteEditDraft('');
    setNoteDraft('');
    setNoteError(null);
    setMatchedNoteId(null);
  };

  // The question about a note, asked over whatever the chapter form was asking.
  // Only one question is ever up, so opening this one takes the other's place.
  const askNoteQuestion = (message: string, go: () => void) => {
    setChapterFormPrompt(null);
    setNotePrompt({ message, go });
  };

  const chapterCastIsExplicit = (chapterId: string, characterId: string) =>
    chapterCast.some(
      member => member.chapter_id === chapterId && member.character_id === characterId
    );

  const toggleChapterCastPanel = (chapterId: string) => {
    setChapterCastError(null);
    setOpenChapterCastId(current => (current === chapterId ? null : chapterId));
  };

  // The picker belongs to the story it was opened in, so loading another one
  // closes it rather than showing a row from the story that was just left.
  const closeChapterCastPanel = () => {
    setOpenChapterCastId(null);
    setChapterCastError(null);
  };

  // The chapter's POV is always present. This adds or removes the rest of the
  // scene's cast, one command per person, so every change is recorded in the
  // history like any other edit.
  const setChapterCastPresence = async (
    chapterId: string,
    characterId: string,
    present: boolean
  ) => {
    const existing = chapterCast.find(
      member => member.chapter_id === chapterId && member.character_id === characterId
    );

    if (present && existing) return;
    if (!present && !existing) return;

    setChapterCastBusyId(characterId);
    setChapterCastError(null);

    try {
      if (present) {
        const created = await narrativeApi.addChapterCastMember(chapterId, characterId, actor);

        onCastMemberAdded(created);
      } else {
        if (!existing) return;

        await narrativeApi.removeChapterCastMember(existing.id, actor);
        onCastMemberRemoved(existing.id);
      }
    } catch (e) {
      console.error('Failed to change the chapter cast:', e);
      setChapterCastError(`Could not change the chapter cast: ${String(e)}`);
    } finally {
      setChapterCastBusyId(null);
    }
  };

  // Where the keyboard goes back to when a question about a draft is dismissed:
  // whichever field the typing is in.
  const focusDraftField = () => {
    if (editingNoteId != null) noteEditorRef.current?.focus();
    else if (openNotesChapterId != null) noteAddRef.current?.focus();
    else if (editingChapterId != null) chapterArcInputRef.current?.focus();
  };

  // A timer left behind by a flag must not reach into an unmounted panel.
  useEffect(
    () => () => {
      if (revealTimer.current != null) window.clearTimeout(revealTimer.current);
    },
    []
  );

  // Closing the note panel drops the question with it.
  useEffect(() => {
    if (openNotesChapterId == null) setNotePrompt(null);
  }, [openNotesChapterId]);

  // A question takes the keyboard with it: the safe answer is already focused, so
  // Enter keeps the work instead of discarding it.
  useEffect(() => {
    if (chapterFormPrompt) chapterKeepEditingRef.current?.focus();
  }, [chapterFormPrompt]);

  useEffect(() => {
    if (notePrompt) noteKeepEditingRef.current?.focus();
  }, [notePrompt]);

  // Closing the form drops the question with it.
  useEffect(() => {
    if (editingChapterId == null) setChapterFormPrompt(null);
  }, [editingChapterId]);

  return {
    // The chapter list's controls.
    newChapterTitle,
    setNewChapterTitle,
    chapterError,
    setChapterError,
    chapterBusy,
    setChapterBusy,
    revealedChapterId,
    revealChapter,

    // The details form.
    editingChapterId,
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
    chapterArcInputRef,
    chapterKeepEditingRef,
    chapterDraftIsDirty,
    openChapterDetails,
    requestChapterClose,
    requestChapterLeave,
    askToLeaveChapter,
    chapterFormPrompt,
    dismissChapterPrompt,
    discardChapterEdit,
    closeChapterForm,
    leaveChapterForm,
    finishChapterSave,
    abandonChapterDrafts,

    // The notes.
    notes,
    notesByChapter,
    noteCount,
    followLoadedNotes,
    clearNotes,
    openNotesChapterId,
    toggleChapterNotes,
    openChapterNotes,
    noteDraft,
    setNoteDraft,
    noteDraftIsDirty,
    editingNoteId,
    noteEditDraft,
    setNoteEditDraft,
    matchedNoteId,
    noteBusy,
    noteError,
    noteEditorRef,
    noteAddRef,
    noteKeepEditingRef,
    notePrompt,
    setNotePrompt,
    askNoteQuestion,
    dismissNotePrompt,
    discardNoteDraft,
    abandonNoteDrafts,
    addNote,
    startNoteEdit,
    requestNoteEditCancel,
    saveNoteEdit,
    deleteNote,

    // The cast picker.
    openChapterCastId,
    chapterCastBusyId,
    chapterCastError,
    chapterCastIsExplicit,
    toggleChapterCastPanel,
    closeChapterCastPanel,
    setChapterCastPresence,

    // Where the keyboard goes when a question about a draft is put away.
    focusDraftField,
  };
}

// A note is stored as a node under its chapter, so the row that comes back is the
// board's shape and only its text and its parent are the panel's business.
function toChapterNote(row: IndexedNode): ChapterNote {
  return {
    id: row.id,
    chapterId: row.parent_node_id ?? '',
    text: row.content ?? '',
  };
}
