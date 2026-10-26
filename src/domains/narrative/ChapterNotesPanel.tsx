import React from 'react';
import type { ChapterNote } from '../shared/types';

// The notes kept with one chapter: the plain-text list, the one note being
// edited, the box that adds another, and the question asked when a half-written
// note would be dropped. The drafts live in the app, because a search result and
// a story switch can both ask the panel to close.

export interface ChapterNotesPanelProps {
  chapterLabel: string;
  // The notes hanging under this chapter, in the order they were written.
  notes: ChapterNote[];
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
  addNote: () => Promise<void>;
}

export function ChapterNotesPanel({
  chapterLabel,
  notes,
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
}: ChapterNotesPanelProps) {
  return (
    <div
      className="chapter-notes"
      onKeyDown={(e) => {
        // Escape is how the question is dismissed, wherever
        // the focus was left when it appeared.
        if (e.key === 'Escape' && notePrompt) {
          e.stopPropagation();
          dismissNotePrompt();
        }
      }}
    >
      {notePrompt && (
        <div
          className="chapter-details-prompt"
          role="alertdialog"
          aria-label="Unsaved note changes"
        >
          <p>{notePrompt.message}</p>
          <div className="chapter-details-prompt-actions">
            <button
              title="Drop this note and continue"
              onClick={discardNoteDraft}
            >
              Discard and continue
            </button>
            <button
              ref={noteKeepEditingRef}
              title="Stay with the note as it is"
              onClick={dismissNotePrompt}
            >
              Keep editing
            </button>
          </div>
        </div>
      )}

      {notes.map(note =>
        editingNoteId === note.id ? (
          <div
            key={note.id}
            className={`chapter-note${
              note.id === matchedNoteId ? ' matched' : ''
            }`}
          >
            <textarea
              ref={noteEditorRef}
              className="chapter-note-editor"
              aria-label={`Edit note in ${chapterLabel}`}
              autoFocus
              value={noteEditDraft}
              onChange={(e) => setNoteEditDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') requestNoteEditCancel();
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  void saveNoteEdit();
                }
              }}
            />
            <div className="chapter-note-actions">
              <button
                title="Save this note (Ctrl+Enter)"
                onClick={() => void saveNoteEdit()}
                disabled={noteBusy}
              >
                Save
              </button>
              <button
                title="Leave the note as it was"
                onClick={requestNoteEditCancel}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            key={note.id}
            className={`chapter-note${
              note.id === matchedNoteId ? ' matched' : ''
            }`}
          >
            <div className="chapter-note-text">{note.text}</div>
            <div className="chapter-note-actions">
              <button
                aria-label={`Edit the note ${note.text.split('\n')[0]}`}
                title="Edit this note"
                onClick={() => startNoteEdit(note)}
                disabled={noteBusy}
              >
                Edit
              </button>
              <button
                aria-label={`Delete the note ${note.text.split('\n')[0]}`}
                title="Move this note to the trash"
                onClick={() => void deleteNote(note)}
                disabled={noteBusy}
              >
                Delete
              </button>
            </div>
          </div>
        )
      )}

      {notes.length === 0 && (
        <div className="chapter-notes-empty">
          No notes yet — a note is plain text, kept with the
          chapter.
        </div>
      )}

      {editingNoteId === null && (
        <div className="chapter-note-add">
          <textarea
            ref={noteAddRef}
            aria-label={`New note for ${chapterLabel}`}
            placeholder="A note for this chapter"
            title="Ctrl+Enter adds the note"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                void addNote();
              }
            }}
          />
          <button
            title="Add this note to the chapter"
            onClick={() => void addNote()}
            disabled={noteBusy || !noteDraft.trim()}
          >
            Add note
          </button>
        </div>
      )}

      {noteError && (
        <div className="chapter-note-error">{noteError}</div>
      )}
    </div>
  );
}
