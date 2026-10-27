import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { UNDO_LIMIT, useHistory } from './useHistory';
import type { HistoryOptions } from './useHistory';
import type { UndoStep } from './types';

// The hook is this session's undo and redo stacks. What a walk reaches outside
// the domain arrives as a callback, so it is driven here with no board, no
// database and no story load: the app's side is a set of spies, the steps are
// closures a test controls, and what is held to is the stack discipline — what
// moves where, what is said afterwards, and what a refusal leaves behind.

function spies(overrides: Partial<HistoryOptions> = {}): HistoryOptions {
  return {
    onBoardTaken: vi.fn(),
    onStepStarting: vi.fn(),
    openStoryId: vi.fn(() => 's-1'),
    reloadStory: vi.fn(async () => {}),
    onRefused: vi.fn(async () => {}),
    onError: vi.fn(),
    ...overrides,
  };
}

function step(label: string, overrides: Partial<UndoStep> = {}): UndoStep {
  return { label, undo: vi.fn(async () => {}), redo: vi.fn(async () => {}), ...overrides };
}

async function record(result: { current: ReturnType<typeof useHistory> }, undoStep: UndoStep) {
  await act(async () => {
    result.current.recordStep(undoStep);
  });
}

async function walk(
  result: { current: ReturnType<typeof useHistory> },
  direction: 'undo' | 'redo'
) {
  await act(async () => {
    await (direction === 'undo' ? result.current.undoLast() : result.current.redoLast());
  });
}

describe('useHistory', () => {
  it('counts what it has recorded', async () => {
    const app = spies();
    const { result } = renderHook(() => useHistory(app));

    expect(result.current.depth).toEqual({ undo: 0, redo: 0 });

    await record(result, step('One'));
    await record(result, step('Two'));

    expect(result.current.depth).toEqual({ undo: 2, redo: 0 });
    expect(app.onBoardTaken).toHaveBeenCalledTimes(2);
  });

  it('runs a step\u2019s undo and offers the same step back to redo', async () => {
    const app = spies();
    const edited = step('Renamed “Vault”');
    const { result } = renderHook(() => useHistory(app));

    await record(result, edited);
    await walk(result, 'undo');

    expect(edited.undo).toHaveBeenCalledTimes(1);
    expect(edited.redo).not.toHaveBeenCalled();
    expect(result.current.depth).toEqual({ undo: 0, redo: 1 });
    expect(result.current.notice).toBe('Undid: Renamed “Vault”');
  });

  it('runs the redo of the step it just put aside', async () => {
    const app = spies();
    const edited = step('Renamed “Vault”');
    const { result } = renderHook(() => useHistory(app));

    await record(result, edited);
    await walk(result, 'undo');
    await walk(result, 'redo');

    expect(edited.redo).toHaveBeenCalledTimes(1);
    expect(result.current.depth).toEqual({ undo: 1, redo: 0 });
    expect(result.current.notice).toBe('Redid: Renamed “Vault”');
  });

  it('drops the redo branch as soon as a new action is recorded', async () => {
    const app = spies();
    const undone = step('One');
    const { result } = renderHook(() => useHistory(app));

    await record(result, undone);
    await walk(result, 'undo');
    expect(result.current.depth).toEqual({ undo: 0, redo: 1 });

    // As in any editor, the branch that was undone is no longer reachable.
    await record(result, step('Two'));

    expect(result.current.depth).toEqual({ undo: 1, redo: 0 });

    // It is gone, not merely uncounted: walking forward would run a step the
    // new action replaced.
    await walk(result, 'redo');

    expect(undone.redo).not.toHaveBeenCalled();
    expect(result.current.depth).toEqual({ undo: 1, redo: 0 });
  });

  it('names where the rest of an undo went, but only on the undo', async () => {
    const app = spies();
    const { result } = renderHook(() => useHistory(app));

    await record(
      result,
      step('Deleted “One”', { undoNote: '3 connections are in the Trash' })
    );

    await walk(result, 'undo');
    expect(result.current.notice).toBe(
      'Undid: Deleted “One” — 3 connections are in the Trash'
    );

    // The redo takes the same things away again, so there is nothing to add.
    await walk(result, 'redo');
    expect(result.current.notice).toBe('Redid: Deleted “One”');
  });

  it('keeps only the last few steps of the session', async () => {
    const app = spies();
    const { result } = renderHook(() => useHistory(app));

    for (let i = 0; i < UNDO_LIMIT + 5; i += 1) {
      await record(result, step(`Step ${i}`));
    }

    expect(result.current.depth.undo).toBe(UNDO_LIMIT);
  });

  it('tells the app a step is starting before it runs', async () => {
    const order: string[] = [];
    const app = spies({ onStepStarting: () => order.push('cleared') });
    const edited = step('Moved “Vault”', {
      undo: vi.fn(async () => {
        order.push('undone');
      }),
    });
    const { result } = renderHook(() => useHistory(app));

    await record(result, edited);
    await walk(result, 'undo');

    expect(order).toEqual(['cleared', 'undone']);
  });

  it('reads the board again after a step, for the story that is open', async () => {
    const app = spies({ openStoryId: () => 's-7' });
    const { result } = renderHook(() => useHistory(app));

    await record(result, step('One'));
    await walk(result, 'undo');

    expect(app.reloadStory).toHaveBeenCalledWith('s-7');
  });

  it('has nothing to read again when no story is open', async () => {
    const app = spies({ openStoryId: () => null });
    const { result } = renderHook(() => useHistory(app));

    await record(result, step('One'));
    await walk(result, 'undo');

    expect(app.reloadStory).not.toHaveBeenCalled();
    // The step still moved; there was simply no board to refresh.
    expect(result.current.depth).toEqual({ undo: 0, redo: 1 });
  });

  it('says nothing at all when there is nothing to walk', async () => {
    const app = spies();
    const { result } = renderHook(() => useHistory(app));

    await walk(result, 'undo');
    await walk(result, 'redo');

    expect(result.current.notice).toBeNull();
    expect(app.onError).not.toHaveBeenCalled();
    expect(app.onRefused).not.toHaveBeenCalled();
    expect(app.reloadStory).not.toHaveBeenCalled();
  });

  it('keeps a refused step so it can be tried again, and reports it', async () => {
    const app = spies();
    const stuck = step('Deleted “One”', {
      undo: vi.fn(async () => {
        throw 'restore the connected nodes first';
      }),
    });
    const { result } = renderHook(() => useHistory(app));

    await record(result, stuck);
    await walk(result, 'undo');

    expect(app.onError).toHaveBeenCalledWith(
      'Could not undo Deleted “One”: restore the connected nodes first'
    );
    expect(app.onRefused).toHaveBeenCalledWith(
      'undo_refused',
      'Undo refused — Deleted “One”: restore the connected nodes first The step stays in the history, so it can be tried again.'
    );

    // Nothing moved: the step is still where it was, waiting.
    expect(result.current.depth).toEqual({ undo: 1, redo: 0 });
    expect(result.current.notice).toBeNull();

    await walk(result, 'undo');
    expect(stuck.undo).toHaveBeenCalledTimes(2);
  });

  it('names a refused redo as a redo', async () => {
    const app = spies();
    const stuck = step('Deleted “One”', {
      redo: vi.fn(async () => {
        throw 'the row is gone';
      }),
    });
    const { result } = renderHook(() => useHistory(app));

    await record(result, stuck);
    await walk(result, 'undo');
    await walk(result, 'redo');

    expect(app.onError).toHaveBeenCalledWith('Could not redo Deleted “One”: the row is gone');
    expect(app.onRefused).toHaveBeenCalledWith(
      'redo_refused',
      'Redo refused — Deleted “One”: the row is gone The step stays in the history, so it can be tried again.'
    );
    expect(result.current.depth).toEqual({ undo: 0, redo: 1 });
  });

  it('does not write a second entry for a half-step that put its own back', async () => {
    const app = spies();
    const { result } = renderHook(() => useHistory(app));

    // A step whose own work already rolled back and wrote about it, exactly as
    // the app's rollback paths do while the step is running.
    const halfStep = step('Learned “Arcane Sight”', {
      undo: vi.fn(async () => {
        result.current.noteRolledBack();
        throw 'the holder row could not be written';
      }),
    });

    await record(result, halfStep);
    await walk(result, 'undo');

    expect(app.onError).toHaveBeenCalledWith(
      'Could not undo Learned “Arcane Sight”: the holder row could not be written'
    );
    // The rollback's own entry is already in the audit log; the refusal is what
    // the author needs to see, not a second entry saying the same thing.
    expect(app.onRefused).not.toHaveBeenCalled();
  });

  it('lets a rollback note speak only for the move it was made in', async () => {
    const app = spies();
    const { result } = renderHook(() => useHistory(app));

    const halfStep = step('Learned “Arcane Sight”', {
      undo: vi.fn(async () => {
        result.current.noteRolledBack();
        throw 'the holder row could not be written';
      }),
    });
    const stuck = step('Deleted “One”', {
      undo: vi.fn(async () => {
        throw 'restore the connected nodes first';
      }),
    });

    await record(result, halfStep);
    await walk(result, 'undo');
    expect(app.onRefused).not.toHaveBeenCalled();

    // The next move writes its own entry: the note belonged to the step before.
    await record(result, stuck);
    await walk(result, 'undo');

    expect(app.onRefused).toHaveBeenCalledTimes(1);
    expect(app.onRefused).toHaveBeenCalledWith(
      'undo_refused',
      'Undo refused — Deleted “One”: restore the connected nodes first The step stays in the history, so it can be tried again.'
    );
  });

  it('lets a made change stand when only the board could not be read again', async () => {
    const app = spies({
      reloadStory: vi.fn(async () => {
        throw 'database is locked';
      }),
    });
    const { result } = renderHook(() => useHistory(app));

    await record(result, step('Moved “Vault”'));
    await walk(result, 'undo');

    expect(app.onError).toHaveBeenCalledWith(
      'The change was made, but the board could not be reloaded: database is locked'
    );
    // The refresh failed, not the change: the step is behind us either way.
    expect(result.current.depth).toEqual({ undo: 0, redo: 1 });
    expect(result.current.notice).toBe('Undid: Moved “Vault”');
    expect(app.onRefused).not.toHaveBeenCalled();
  });

  it('drops both stacks on request, without walking anything', async () => {
    const app = spies();
    const first = step('One');
    const { result } = renderHook(() => useHistory(app));

    await record(result, first);
    await walk(result, 'undo');

    await act(async () => {
      result.current.forget();
    });

    expect(result.current.depth).toEqual({ undo: 0, redo: 0 });

    // Neither direction has anything left to run.
    await walk(result, 'undo');
    await walk(result, 'redo');

    expect(first.undo).toHaveBeenCalledTimes(1);
    expect(first.redo).not.toHaveBeenCalled();
  });

  it('clears its notice on request', async () => {
    const app = spies();
    const { result } = renderHook(() => useHistory(app));

    await record(result, step('One'));
    await walk(result, 'undo');
    expect(result.current.notice).not.toBeNull();

    await act(async () => {
      result.current.clearNotice();
    });

    expect(result.current.notice).toBeNull();
  });

  it('fades its notice on its own', async () => {
    vi.useFakeTimers();

    try {
      const app = spies();
      const { result } = renderHook(() => useHistory(app));

      await act(async () => {
        result.current.recordStep(step('One'));
      });
      await act(async () => {
        await result.current.undoLast();
      });
      expect(result.current.notice).toBe('Undid: One');

      await act(async () => {
        vi.advanceTimersByTime(5000);
      });

      expect(result.current.notice).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the buttons one identity while reading the app\u2019s latest callbacks', async () => {
    let app = spies();
    const { result, rerender } = renderHook(() => useHistory(app));

    const undoLast = result.current.undoLast;
    const redoLast = result.current.redoLast;

    // A render of the app hands the hook new callbacks every time, which is why
    // the keyboard shortcut can subscribe to these once.
    app = spies();
    rerender();

    expect(result.current.undoLast).toBe(undoLast);
    expect(result.current.redoLast).toBe(redoLast);

    await record(result, step('One'));
    await walk(result, 'undo');

    // The callbacks reached are the new render's, not the ones captured first.
    expect(app.reloadStory).toHaveBeenCalledWith('s-1');
  });
});
