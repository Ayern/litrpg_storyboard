import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { IndexedNode, NodeData } from '../canvas/types';
import type { ChapterNote } from '../shared/types';
import { useChapterWorkspace } from './useChapterWorkspace';
import type { ChapterWorkspaceOptions } from './useChapterWorkspace';
import type { ChapterNode } from './chapters';
import type { ChapterCastMember } from './types';

// The workspace holds what the Chapters tab is editing: the details form and the
// question it asks before being left, the notes panel, and the cast picker. The
// cards and the cast rows belong to the story, so they arrive as arguments and
// every write the tab makes leaves through a callback or a command — which is
// what these tests hold it to, with the four commands it runs mocked.

const { narrativeApi } = vi.hoisted(() => ({
  narrativeApi: {
    addChapterNote: vi.fn(),
    updateChapterNote: vi.fn(),
    deleteChapterNote: vi.fn(),
    addChapterCastMember: vi.fn(),
    removeChapterCastMember: vi.fn(),
  },
}));

vi.mock('./api', () => narrativeApi);

function chapter(id: string, label: string, data: Partial<NodeData> = {}): ChapterNode {
  return {
    id,
    type: 'default',
    position: { x: 0, y: 0 },
    data: {
      label,
      nodeType: 'chapter',
      createdBy: 'author',
      chapterSeq: 1,
      ...data,
    },
  };
}

function noteRow(id: string, chapterId: string, text: string): IndexedNode {
  return {
    id,
    label: text,
    node_type: 'note',
    content: text,
    pos_x: 0,
    pos_y: 0,
    character_id: null,
    parent_node_id: chapterId,
  };
}

function castRow(id: string, chapterId: string, characterId: string): ChapterCastMember {
  return {
    id,
    chapter_id: chapterId,
    character_id: characterId,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const chapters = [
  chapter('c-1', 'The Gate', { chapterArc: 'Arrival', chapterWords: 1200, chapterDay: 1 }),
  chapter('c-2', 'The Vault', { chapterArc: 'Descent', chapterTarget: 2000 }),
];

function setup(overrides: Partial<ChapterWorkspaceOptions> = {}) {
  const onCastMemberAdded = vi.fn();
  const onCastMemberRemoved = vi.fn();

  const options: ChapterWorkspaceOptions = {
    chapterNodes: chapters,
    chapterCast: [],
    actor: 'You',
    onCastMemberAdded,
    onCastMemberRemoved,
    ...overrides,
  };

  const view = renderHook((props: ChapterWorkspaceOptions) => useChapterWorkspace(props), {
    initialProps: options,
  });

  return { ...view, onCastMemberAdded, onCastMemberRemoved, options };
}

type Harness = ReturnType<typeof setup>;

function openChapter(result: Harness['result'], id = 'c-1') {
  const node = chapters.find(candidate => candidate.id === id);
  if (!node) throw new Error(`no chapter ${id}`);

  act(() => result.current.openChapterDetails(node));
}

// A field the hook would have been given by the panel, so the keyboard can be
// watched: nothing renders here, so the element is attached by hand.
function attach<T extends HTMLElement>(ref: { current: T | null }, element: T) {
  document.body.append(element);
  ref.current = element;
  return element;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('useChapterWorkspace', () => {
  it('opens a chapter with what the card says and stays clean until a draft moves', () => {
    const { result } = setup();

    openChapter(result);

    expect(result.current.editingChapterId).toBe('c-1');
    expect(result.current.chapterArcDraft).toBe('Arrival');
    expect(result.current.chapterWordsDraft).toBe('1200');
    expect(result.current.chapterTargetDraft).toBe('');
    expect(result.current.chapterDayDraft).toBe('1');
    expect(result.current.chapterDraftIsDirty()).toBe(false);

    act(() => result.current.setChapterArcDraft('The arrival'));

    expect(result.current.chapterDraftIsDirty()).toBe(true);

    // Typing a value and putting it back leaves nothing to save.
    act(() => result.current.setChapterArcDraft('Arrival'));

    expect(result.current.chapterDraftIsDirty()).toBe(false);
  });

  it('asks before another chapter replaces unsaved drafts, then switches on the answer', () => {
    const { result } = setup();

    openChapter(result);
    act(() => result.current.setChapterWordsDraft('1300'));

    const vault = chapters[1];

    act(() => {
      expect(result.current.openChapterDetails(vault)).toBe(false);
    });

    expect(result.current.chapterFormPrompt).toEqual({ kind: 'open', id: 'c-2' });
    // The form is still on the chapter it was on, with its typing intact.
    expect(result.current.editingChapterId).toBe('c-1');
    expect(result.current.chapterWordsDraft).toBe('1300');

    act(() => result.current.discardChapterEdit());

    expect(result.current.chapterFormPrompt).toBeNull();
    expect(result.current.editingChapterId).toBe('c-2');
    expect(result.current.chapterArcDraft).toBe('Descent');
    expect(result.current.chapterDraftIsDirty()).toBe(false);
  });

  it('opens another chapter straight away when nothing is unsaved', () => {
    const { result } = setup();

    openChapter(result);

    act(() => {
      expect(result.current.openChapterDetails(chapters[1])).toBe(true);
    });

    expect(result.current.chapterFormPrompt).toBeNull();
    expect(result.current.editingChapterId).toBe('c-2');
  });

  it('asks before closing a form with typing in it, and Escape is the answer to the question', () => {
    const { result } = setup();

    openChapter(result);
    act(() => result.current.setChapterTimeDraft('dawn'));

    act(() => result.current.requestChapterClose());

    expect(result.current.chapterFormPrompt).toEqual({ kind: 'close' });
    expect(result.current.editingChapterId).toBe('c-1');

    // A second Escape dismisses the question rather than answering it.
    act(() => result.current.requestChapterClose());

    expect(result.current.chapterFormPrompt).toBeNull();
    expect(result.current.editingChapterId).toBe('c-1');

    act(() => result.current.requestChapterClose());
    act(() => result.current.closeChapterForm());

    expect(result.current.editingChapterId).toBeNull();
    expect(result.current.chapterDraftIsDirty()).toBe(false);
  });

  it('closes a clean form without asking', () => {
    const { result } = setup();

    openChapter(result);
    act(() => result.current.requestChapterClose());

    expect(result.current.chapterFormPrompt).toBeNull();
    expect(result.current.editingChapterId).toBeNull();
  });

  it('leaves the form for a tab at once when clean, and only after an answer when not', () => {
    const { result } = setup();
    const go = vi.fn();

    openChapter(result);
    act(() => result.current.requestChapterLeave('Leave?', go));

    expect(go).toHaveBeenCalledTimes(1);
    expect(result.current.chapterFormPrompt).toBeNull();

    act(() => result.current.setChapterArcDraft('Something else'));
    act(() => result.current.requestChapterLeave('Leave?', go));

    expect(go).toHaveBeenCalledTimes(1);
    expect(result.current.chapterFormPrompt).toEqual({ kind: 'leave', message: 'Leave?', go });

    act(() => result.current.leaveChapterForm());

    // The form is closed behind the author, and the move they asked for happens.
    expect(result.current.editingChapterId).toBeNull();
    expect(result.current.chapterFormPrompt).toBeNull();
    expect(go).toHaveBeenCalledTimes(2);
  });

  it('takes the keyboard when it asks, so Enter keeps the work', () => {
    const { result } = setup();
    const keep = attach(result.current.chapterKeepEditingRef, document.createElement('button'));

    openChapter(result);
    act(() => result.current.setChapterArcDraft('Typed'));

    act(() => result.current.requestChapterClose());

    expect(document.activeElement).toBe(keep);
  });

  it('opens the chapter a continuity flag names and lights the row for a moment', () => {
    vi.useFakeTimers();
    const { result } = setup();

    act(() => result.current.revealChapter('c-2'));

    expect(result.current.editingChapterId).toBe('c-2');
    expect(result.current.revealedChapterId).toBe('c-2');

    act(() => vi.advanceTimersByTime(1200));

    expect(result.current.revealedChapterId).toBeNull();
  });

  it('groups the notes a load brought back under their chapters', () => {
    const { result } = setup();

    act(() =>
      result.current.followLoadedNotes([
        noteRow('n-1', 'c-1', 'The gate is barred'),
        noteRow('n-2', 'c-1', 'Someone is watching'),
        noteRow('n-3', 'c-2', 'The vault hums'),
      ])
    );

    expect(result.current.notes.map(note => note.id)).toEqual(['n-1', 'n-2', 'n-3']);
    expect(result.current.noteCount('c-1')).toBe(2);
    expect(result.current.noteCount('c-2')).toBe(1);
    expect(result.current.notesByChapter.get('c-1')?.[0].text).toBe('The gate is barred');

    act(() => result.current.clearNotes());

    expect(result.current.notes).toEqual([]);
    expect(result.current.noteCount('c-1')).toBe(0);
  });

  it('opens a chapter’s notes, and asks before the typing in them is lost', () => {
    const { result } = setup();

    act(() => result.current.toggleChapterNotes('c-1'));

    expect(result.current.openNotesChapterId).toBe('c-1');

    act(() => result.current.setNoteDraft('Half a thought'));
    expect(result.current.noteDraftIsDirty()).toBe(true);

    act(() => result.current.toggleChapterNotes('c-2'));

    expect(result.current.notePrompt?.message).toBe('Discard this new note?');
    expect(result.current.openNotesChapterId).toBe('c-1');

    act(() => result.current.discardNoteDraft());

    // The answer drops the typing and moves the panel where it was asked to go.
    expect(result.current.openNotesChapterId).toBe('c-2');
    expect(result.current.noteDraft).toBe('');
    expect(result.current.notePrompt).toBeNull();
  });

  it('puts the keyboard back in the note being edited when the question is dismissed', () => {
    const { result } = setup();

    act(() => result.current.toggleChapterNotes('c-1'));
    const field = attach(result.current.noteAddRef, document.createElement('textarea'));

    act(() => result.current.setNoteDraft('Half a thought'));
    act(() => result.current.toggleChapterNotes('c-2'));
    act(() => result.current.dismissNotePrompt());

    expect(result.current.notePrompt).toBeNull();
    expect(result.current.openNotesChapterId).toBe('c-1');
    expect(document.activeElement).toBe(field);
  });

  it('writes a note, appends the row it came back as and clears the field', async () => {
    const { result } = setup();
    const created = noteRow('n-9', 'c-1', 'The gate is barred');

    narrativeApi.addChapterNote.mockResolvedValue(created);

    act(() => result.current.toggleChapterNotes('c-1'));
    act(() => result.current.setNoteDraft('  The gate is barred  '));

    await act(async () => {
      await result.current.addNote('c-1');
    });

    expect(narrativeApi.addChapterNote).toHaveBeenCalledWith('c-1', 'The gate is barred', 'You');
    expect(result.current.notes).toHaveLength(1);
    expect(result.current.notes[0]).toEqual({ id: 'n-9', chapterId: 'c-1', text: 'The gate is barred' });
    expect(result.current.noteDraft).toBe('');
    expect(result.current.noteError).toBeNull();
    expect(result.current.noteBusy).toBe(false);
  });

  it('refuses a blank note without writing one', async () => {
    const { result } = setup();

    act(() => result.current.setNoteDraft('   '));

    await act(async () => {
      await result.current.addNote('c-1');
    });

    expect(narrativeApi.addChapterNote).not.toHaveBeenCalled();
    expect(result.current.noteError).toBe('A note needs some text.');
    expect(result.current.noteBusy).toBe(false);
  });

  it('reports a refused note without losing the draft', async () => {
    const { result } = setup();

    narrativeApi.addChapterNote.mockRejectedValue('database is locked');

    act(() => result.current.setNoteDraft('Worth keeping'));

    await act(async () => {
      await result.current.addNote('c-1');
    });

    expect(result.current.noteError).toBe('Could not add the note: database is locked');
    expect(result.current.noteDraft).toBe('Worth keeping');
    expect(result.current.noteBusy).toBe(false);
  });

  it('edits a note against the text it opened with, and saves the trimmed row', async () => {
    const { result } = setup();

    act(() => result.current.followLoadedNotes([noteRow('n-1', 'c-1', 'The gate is barred')]));
    act(() => result.current.toggleChapterNotes('c-1'));
    act(() => result.current.startNoteEdit(result.current.notes[0]));

    expect(result.current.editingNoteId).toBe('n-1');
    expect(result.current.noteEditDraft).toBe('The gate is barred');
    expect(result.current.noteDraftIsDirty()).toBe(false);

    act(() => result.current.setNoteEditDraft('  The gate is barred  '));
    expect(result.current.noteDraftIsDirty()).toBe(true);

    narrativeApi.updateChapterNote.mockResolvedValue(
      noteRow('n-1', 'c-1', 'The gate is barred')
    );

    await act(async () => {
      await result.current.saveNoteEdit();
    });

    expect(narrativeApi.updateChapterNote).toHaveBeenCalledWith(
      'n-1',
      'The gate is barred',
      'You'
    );
    expect(result.current.editingNoteId).toBeNull();
    expect(result.current.notes[0].text).toBe('The gate is barred');
  });

  it('asks before an edit in flight is replaced by another note', () => {
    const { result } = setup();

    act(() =>
      result.current.followLoadedNotes([
        noteRow('n-1', 'c-1', 'First'),
        noteRow('n-2', 'c-1', 'Second'),
      ])
    );
    act(() => result.current.toggleChapterNotes('c-1'));
    act(() => result.current.startNoteEdit(result.current.notes[0]));
    act(() => result.current.setNoteEditDraft('Changed'));

    act(() => result.current.startNoteEdit(result.current.notes[1]));

    expect(result.current.notePrompt?.message).toBe('Discard your changes to this note?');
    expect(result.current.editingNoteId).toBe('n-1');

    act(() => result.current.discardNoteDraft());

    expect(result.current.editingNoteId).toBe('n-2');
    expect(result.current.noteEditDraft).toBe('Second');
  });

  it('cancelling an edit closes the editor, after an answer when the note changed', () => {
    const { result } = setup();

    act(() => result.current.followLoadedNotes([noteRow('n-1', 'c-1', 'First')]));
    act(() => result.current.startNoteEdit(result.current.notes[0]));

    act(() => result.current.requestNoteEditCancel());

    expect(result.current.editingNoteId).toBeNull();

    act(() => result.current.startNoteEdit(result.current.notes[0]));
    act(() => result.current.setNoteEditDraft('Changed'));
    act(() => result.current.requestNoteEditCancel());

    expect(result.current.notePrompt).not.toBeNull();
    expect(result.current.editingNoteId).toBe('n-1');

    act(() => result.current.discardNoteDraft());

    expect(result.current.editingNoteId).toBeNull();
  });

  it('deletes a note through the command, drops the row and closes its editor', async () => {
    const { result } = setup();

    narrativeApi.deleteChapterNote.mockResolvedValue(undefined);

    act(() =>
      result.current.followLoadedNotes([
        noteRow('n-1', 'c-1', 'First'),
        noteRow('n-2', 'c-1', 'Second'),
      ])
    );
    act(() => result.current.startNoteEdit(result.current.notes[0]));

    await act(async () => {
      await result.current.deleteNote(result.current.notes[0]);
    });

    expect(narrativeApi.deleteChapterNote).toHaveBeenCalledWith('n-1', 'You');
    expect(result.current.notes.map(note => note.id)).toEqual(['n-2']);
    expect(result.current.editingNoteId).toBeNull();
  });

  it('marks the note a search result pointed at and lets the mark fade', () => {
    vi.useFakeTimers();
    const { result } = setup();

    act(() => result.current.openChapterNotes('c-1', 'n-2'));

    expect(result.current.openNotesChapterId).toBe('c-1');
    expect(result.current.matchedNoteId).toBe('n-2');

    act(() => vi.advanceTimersByTime(2400));

    expect(result.current.matchedNoteId).toBeNull();
  });

  it('asks only one question at a time: a note question takes the chapter form’s place', () => {
    const { result } = setup();
    const go = vi.fn();

    openChapter(result);
    act(() => result.current.askToLeaveChapter('Leave Chapters?', go));

    expect(result.current.chapterFormPrompt?.kind).toBe('leave');

    act(() => result.current.askNoteQuestion('Discard this new note?', go));

    expect(result.current.chapterFormPrompt).toBeNull();
    expect(result.current.notePrompt?.message).toBe('Discard this new note?');
  });

  it('drops every draft the tab holds without asking, for a move already answered', () => {
    const { result } = setup();

    openChapter(result);
    act(() => result.current.toggleChapterNotes('c-1'));
    act(() => result.current.setNoteDraft('Half a thought'));
    act(() => result.current.setChapterArcDraft('Typed'));

    act(() => {
      result.current.abandonChapterDrafts();
      result.current.abandonNoteDrafts();
    });

    expect(result.current.editingChapterId).toBeNull();
    expect(result.current.chapterDraftIsDirty()).toBe(false);
    expect(result.current.noteDraft).toBe('');
    expect(result.current.noteDraftIsDirty()).toBe(false);
    expect(result.current.notePrompt).toBeNull();
    expect(result.current.chapterFormPrompt).toBeNull();
  });

  it('puts the keyboard back in whichever draft is open', () => {
    const { result } = setup();

    openChapter(result);
    const arc = attach(result.current.chapterArcInputRef, document.createElement('input'));

    act(() => result.current.focusDraftField());

    expect(document.activeElement).toBe(arc);

    act(() => result.current.toggleChapterNotes('c-1'));
    const noteField = attach(result.current.noteAddRef, document.createElement('textarea'));

    act(() => result.current.focusDraftField());

    expect(document.activeElement).toBe(noteField);

    act(() => result.current.followLoadedNotes([noteRow('n-1', 'c-1', 'First')]));
    act(() => result.current.startNoteEdit(result.current.notes[0]));
    const editor = attach(result.current.noteEditorRef, document.createElement('textarea'));

    act(() => result.current.focusDraftField());

    expect(document.activeElement).toBe(editor);
  });

  it('knows who is already in a chapter and adds the rest through the command', async () => {
    const existing = castRow('cc-1', 'c-1', 'ch-1');
    const { result, onCastMemberAdded, onCastMemberRemoved } = setup({
      chapterCast: [existing],
    });

    expect(result.current.chapterCastIsExplicit('c-1', 'ch-1')).toBe(true);
    expect(result.current.chapterCastIsExplicit('c-1', 'ch-2')).toBe(false);
    expect(result.current.chapterCastIsExplicit('c-2', 'ch-1')).toBe(false);

    // Asking for someone already there writes nothing.
    await act(async () => {
      await result.current.setChapterCastPresence('c-1', 'ch-1', true);
    });

    expect(narrativeApi.addChapterCastMember).not.toHaveBeenCalled();
    expect(onCastMemberAdded).not.toHaveBeenCalled();

    const created = castRow('cc-2', 'c-1', 'ch-2');
    narrativeApi.addChapterCastMember.mockResolvedValue(created);

    await act(async () => {
      await result.current.setChapterCastPresence('c-1', 'ch-2', true);
    });

    expect(narrativeApi.addChapterCastMember).toHaveBeenCalledWith('c-1', 'ch-2', 'You');
    expect(onCastMemberAdded).toHaveBeenCalledWith(created);
    expect(result.current.chapterCastBusyId).toBeNull();
  });

  it('removes a cast member through the command and reports the row that went', async () => {
    const existing = castRow('cc-1', 'c-1', 'ch-1');
    const { result, onCastMemberAdded, onCastMemberRemoved } = setup({
      chapterCast: [existing],
    });

    narrativeApi.removeChapterCastMember.mockResolvedValue(undefined);

    await act(async () => {
      await result.current.setChapterCastPresence('c-1', 'ch-1', false);
    });

    expect(narrativeApi.removeChapterCastMember).toHaveBeenCalledWith('cc-1', 'You');
    expect(onCastMemberRemoved).toHaveBeenCalledWith('cc-1');
    // Removing is not adding: the two callbacks are told apart.
    expect(onCastMemberAdded).not.toHaveBeenCalled();
  });

  it('holds the picker to one chapter and reports a refused cast change', async () => {
    const { result } = setup();

    act(() => result.current.toggleChapterCastPanel('c-1'));
    expect(result.current.openChapterCastId).toBe('c-1');

    act(() => result.current.toggleChapterCastPanel('c-1'));
    expect(result.current.openChapterCastId).toBeNull();

    act(() => result.current.toggleChapterCastPanel('c-2'));
    narrativeApi.addChapterCastMember.mockRejectedValue('database is locked');

    await act(async () => {
      await result.current.setChapterCastPresence('c-2', 'ch-1', true);
    });

    expect(result.current.chapterCastError).toBe(
      'Could not change the chapter cast: database is locked'
    );

    // Opening the picker for another chapter clears the complaint about the last.
    act(() => result.current.closeChapterCastPanel());

    expect(result.current.chapterCastError).toBeNull();
    expect(result.current.openChapterCastId).toBeNull();
  });

  it('reports the cast as busy while the command is in flight', async () => {
    const { result } = setup();

    let settle: (row: ChapterCastMember) => void = () => {};
    narrativeApi.addChapterCastMember.mockReturnValue(
      new Promise<ChapterCastMember>(resolve => {
        settle = resolve;
      })
    );

    let pending: Promise<void> = Promise.resolve();

    act(() => {
      pending = result.current.setChapterCastPresence('c-1', 'ch-2', true);
    });

    expect(result.current.chapterCastBusyId).toBe('ch-2');

    await act(async () => {
      settle(castRow('cc-2', 'c-1', 'ch-2'));
      await pending;
    });

    await waitFor(() => expect(result.current.chapterCastBusyId).toBeNull());
  });

  it('closes the cast picker and forgets its complaint when another story loads', () => {
    const { result } = setup();

    act(() => result.current.toggleChapterCastPanel('c-1'));
    act(() => result.current.closeChapterCastPanel());

    expect(result.current.openChapterCastId).toBeNull();
    expect(result.current.chapterCastError).toBeNull();
  });

  it('a save closes the form and the question that was waiting on it', () => {
    const { result } = setup();

    openChapter(result);
    act(() => result.current.setChapterArcDraft('Typed'));
    act(() => result.current.requestChapterClose());

    expect(result.current.chapterFormPrompt).toEqual({ kind: 'close' });

    act(() => result.current.finishChapterSave());

    expect(result.current.editingChapterId).toBeNull();
    expect(result.current.chapterFormPrompt).toBeNull();
    expect(result.current.chapterDraftIsDirty()).toBe(false);
  });

  it('keeps the chapter list’s own notice and busy flag for the app to write', () => {
    const { result } = setup();

    act(() => result.current.setChapterError('Could not add a chapter: locked'));
    act(() => result.current.setChapterBusy(true));

    expect(result.current.chapterError).toBe('Could not add a chapter: locked');
    expect(result.current.chapterBusy).toBe(true);

    act(() => result.current.setNewChapterTitle('The Vault'));
    expect(result.current.newChapterTitle).toBe('The Vault');
  });

  it('keeps a note out of the dirty count while the panel is closed', () => {
    const { result } = setup();

    // A draft left behind by an unmounting panel is not something to ask about.
    act(() => result.current.setNoteDraft('Half a thought'));
    expect(result.current.noteDraftIsDirty()).toBe(true);

    act(() => result.current.abandonNoteDrafts());
    expect(result.current.noteDraftIsDirty()).toBe(false);
  });

  it('does not call a typed and reverted note an edit', () => {
    const { result } = setup();

    act(() => result.current.followLoadedNotes([noteRow('n-1', 'c-1', 'First')]));

    const saved: ChapterNote = result.current.notes[0];
    act(() => result.current.startNoteEdit(saved));
    act(() => result.current.setNoteEditDraft('Changed'));
    act(() => result.current.setNoteEditDraft('First'));

    expect(result.current.noteDraftIsDirty()).toBe(false);
  });
});
