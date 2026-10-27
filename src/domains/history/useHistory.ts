import { useCallback, useEffect, useRef, useState } from 'react';
import type { UndoStep } from './types';

// This session's undo and redo stacks. A step is a label and two closures, and
// the closures call the ordinary commands, so walking one is an audited change
// like any other. The stacks are refs because they are read only when a key is
// pressed; the counts are state, because the toolbar draws them.
//
// What a walk touches outside the domain stays with the app and arrives as a
// callback: the error line the last step reported, the correction notices it
// offered, the story whose board is re-read afterwards, and the entry a refusal
// writes into the audit log. Undo is scoped to the story it was recorded in and
// the steps are never written to disk — the audit log is the permanent record.

// How many actions this session's undo stack keeps. The audit tab is the
// permanent record; this is only the last few steps, so it is capped and never
// written to disk.
export const UNDO_LIMIT = 50;

export interface HistoryOptions {
  // Called when a step is recorded and again when one is walked: a newer action
  // owns the board now, so the correction the last one offered is stale.
  onBoardTaken: () => void;
  // Called just before a step runs. The error it last reported and the nodes it
  // was removing belong to the step before it.
  onStepStarting: () => void;
  // The story whose board a step changes. Null is no story open, which is the
  // one case where there is nothing to read again.
  openStoryId: () => string | null;
  // Reads the board again after a step, so the canvas shows what the step did
  // rather than what was there before it.
  reloadStory: (storyId: string) => Promise<void>;
  // A refusal is a fact about the story, so it goes where the Audit tab keeps
  // it, as well as to the error line.
  onRefused: (
    action: 'undo_refused' | 'redo_refused',
    detail: string
  ) => Promise<void>;
  // Where a refused step, or a board that could not be read again, is reported.
  onError: (message: string) => void;
}

export function useHistory({
  onBoardTaken,
  onStepStarting,
  openStoryId,
  reloadStory,
  onRefused,
  onError,
}: HistoryOptions) {
  // The app's callbacks are new on every render. They are read through a ref so
  // the steps below keep one identity for the life of the session, which is what
  // lets the keyboard shortcut subscribe to them once.
  const latest = useRef({ onBoardTaken, onStepStarting, openStoryId, reloadStory, onRefused, onError });
  latest.current = { onBoardTaken, onStepStarting, openStoryId, reloadStory, onRefused, onError };

  const undoStackRef = useRef<UndoStep[]>([]);
  const redoStackRef = useRef<UndoStep[]>([]);
  const [depth, setDepth] = useState({ undo: 0, redo: 0 });
  const [notice, setNotice] = useState<string | null>(null);
  // Set when a step put its own half back, so the move that then failed writes
  // the rollback's entry instead of a second one saying the same thing.
  const rollbackRecordedRef = useRef(false);

  // A notice about an undo is useful for a moment, then it is just stale text.
  useEffect(() => {
    if (!notice) return;

    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const recordStep = useCallback((step: UndoStep) => {
    // A new action makes the old redo branch impossible, as in any editor.
    redoStackRef.current = [];
    undoStackRef.current = [...undoStackRef.current, step].slice(-UNDO_LIMIT);
    setDepth({ undo: undoStackRef.current.length, redo: 0 });
    // A newer action owns the board now; the old correction's Undo would be a
    // step out of order.
    latest.current.onBoardTaken();
  }, []);

  // A step that put its own half back says so here, so the failure that follows
  // does not write a second entry about the same thing.
  const noteRolledBack = useCallback(() => {
    rollbackRecordedRef.current = true;
  }, []);

  const moveInHistory = useCallback(async (direction: 'undo' | 'redo') => {
    const source = direction === 'undo' ? undoStackRef : redoStackRef;
    const target = direction === 'undo' ? redoStackRef : undoStackRef;
    const step = source.current[source.current.length - 1];

    if (!step) return;

    rollbackRecordedRef.current = false;
    latest.current.onStepStarting();

    try {
      await (direction === 'undo' ? step.undo() : step.redo());
    } catch (e) {
      // The step stays where it was, so the failed change can be retried. The
      // half a step put back has already written its own entry; otherwise the
      // refusal itself is the entry.
      console.error(`Failed to ${direction}:`, e);
      latest.current.onError(`Could not ${direction} ${step.label}: ${String(e)}`);

      if (!rollbackRecordedRef.current) {
        await latest.current.onRefused(
          direction === 'undo' ? 'undo_refused' : 'redo_refused',
          `${direction === 'undo' ? 'Undo' : 'Redo'} refused — ${
            step.label
          }: ${String(e)} The step stays in the history, so it can be tried again.`
        );
      }

      return;
    }

    source.current = source.current.slice(0, -1);
    target.current = [...target.current, step];
    setDepth({
      undo: undoStackRef.current.length,
      redo: redoStackRef.current.length,
    });
    // The note belongs to the undo: a redo takes the same things away again.
    const note = direction === 'undo' ? step.undoNote : null;
    setNotice(
      `${direction === 'undo' ? 'Undid' : 'Redid'}: ${step.label}${
        note ? ` — ${note}` : ''
      }`
    );

    const storyId = latest.current.openStoryId();
    if (!storyId) return;

    try {
      await latest.current.reloadStory(storyId);
    } catch (e) {
      // The change itself went through; a failed refresh is reported, not
      // pretended away.
      console.error('Failed to reload the board after moving through history:', e);
      latest.current.onError(
        `The change was made, but the board could not be reloaded: ${String(e)}`
      );
    }
  }, []);

  const undoLast = useCallback(() => moveInHistory('undo'), [moveInHistory]);
  const redoLast = useCallback(() => moveInHistory('redo'), [moveInHistory]);

  // Undo is scoped to the story it was recorded in, and a purge, a shortened
  // retention window or a replaced database leaves nothing behind the steps that
  // could be put back, so the stacks are dropped without touching the rows.
  const forget = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    setDepth({ undo: 0, redo: 0 });
  }, []);

  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    depth,
    notice,
    clearNotice,
    recordStep,
    noteRolledBack,
    undoLast,
    redoLast,
    forget,
  };
}
