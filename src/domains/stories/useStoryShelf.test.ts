import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { formatWhen } from '../../lib/format';
import { useStoryShelf } from './useStoryShelf';
import type { StoryShelfOptions } from './useStoryShelf';
import type { BackupInfo, Story } from './types';

// The shelf holds the sidebar's own state: which story is being renamed or asked
// about, the notices the import and export round trips leave, and the backups
// dialog — the one action that replaces the whole database. The stories
// themselves belong to the app, so the list arrives as an argument and every
// change leaves through a callback. These tests hold it to that, with the
// commands it runs and the two dialogs it opens mocked.

const { storiesApi, openFileDialog, writeText } = vi.hoisted(() => ({
  storiesApi: {
    updateStory: vi.fn(),
    deleteStory: vi.fn(),
    importStoryJson: vi.fn(),
    exportStoryJson: vi.fn(),
    exportStoryMarkdown: vi.fn(),
    storyBibleMarkdown: vi.fn(),
    listBackups: vi.fn(),
    restoreBackup: vi.fn(),
    getAllStories: vi.fn(),
  },
  openFileDialog: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('./api', () => storiesApi);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openFileDialog }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText }));

function story(id: string, title: string, updatedAt: string): Story {
  return {
    id,
    title,
    description: null,
    created_at: '2026-10-20T09:00:00Z',
    updated_at: updatedAt,
  };
}

const ledger = story('story-1', 'Ledger', '2026-10-22T12:00:00Z');
const vault = story('story-2', 'Vault', '2026-10-21T09:00:00Z');

const copies: BackupInfo[] = [
  {
    file_name: 'storyboard-20261023-090000.db',
    created_at: '2026-10-23T09:00:00Z',
    size_bytes: 2048,
  },
  {
    file_name: 'storyboard-20261022-210000.db',
    created_at: '2026-10-22T21:00:00Z',
    size_bytes: 1024,
  },
];

function setup(overrides: Partial<StoryShelfOptions> = {}) {
  const onStoryRenamed = vi.fn();
  const onStoryDeleted = vi.fn();
  const onStoryImported = vi.fn();
  const onDatabaseRestored = vi.fn();
  const onError = vi.fn();

  const options: StoryShelfOptions = {
    stories: [ledger, vault],
    currentStory: ledger,
    actor: 'You',
    onStoryRenamed,
    onStoryDeleted,
    onStoryImported,
    onDatabaseRestored,
    onError,
    ...overrides,
  };

  const view = renderHook((props: StoryShelfOptions) => useStoryShelf(props), {
    initialProps: options,
  });

  return {
    ...view,
    onStoryRenamed,
    onStoryDeleted,
    onStoryImported,
    onDatabaseRestored,
    onError,
  };
}

beforeEach(() => {
  openFileDialog.mockReset();
  openFileDialog.mockResolvedValue(null);
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);

  for (const command of Object.values(storiesApi)) command.mockReset();

  storiesApi.updateStory.mockResolvedValue({ ...ledger, title: 'The Ledger' });
  storiesApi.deleteStory.mockResolvedValue(undefined);
  storiesApi.exportStoryJson.mockResolvedValue('C:\\exports\\ledger.json');
  storiesApi.exportStoryMarkdown.mockResolvedValue('C:\\exports\\ledger-story-bible.md');
  storiesApi.storyBibleMarkdown.mockResolvedValue('# Ledger\n\n## Chapters\n');
  storiesApi.listBackups.mockResolvedValue(copies);
  storiesApi.restoreBackup.mockResolvedValue(undefined);
  storiesApi.getAllStories.mockResolvedValue([story('story-0', 'Restored', '2026-10-19T09:00:00Z')]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('renaming a story', () => {
  it('opens a row with the title it has, and closes any delete question', () => {
    const { result, onError } = setup();

    act(() => result.current.askDeleteStory('story-2'));
    act(() => result.current.startRename(ledger));

    expect(result.current.renamingStoryId).toBe('story-1');
    expect(result.current.renameValue).toBe('Ledger');
    // One row is open for editing at a time, and the last complaint belonged to
    // whatever was being done before this.
    expect(result.current.confirmDeleteStoryId).toBeNull();
    expect(onError).toHaveBeenCalledWith(null);
  });

  it('writes the trimmed title and reports the row it came back with', async () => {
    const { result, onStoryRenamed } = setup();

    act(() => result.current.startRename(ledger));
    act(() => result.current.setRenameValue('  The Ledger  '));

    await act(async () => {
      await result.current.commitRename(ledger);
    });

    expect(storiesApi.updateStory).toHaveBeenCalledWith('story-1', 'The Ledger', 'You');
    expect(onStoryRenamed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'story-1', title: 'The Ledger' })
    );
    expect(result.current.renamingStoryId).toBeNull();
  });

  it('writes nothing when the title is unchanged, and just closes the field', async () => {
    const { result, onStoryRenamed } = setup();

    act(() => result.current.startRename(ledger));
    await act(async () => {
      await result.current.commitRename(ledger);
    });

    expect(storiesApi.updateStory).not.toHaveBeenCalled();
    expect(onStoryRenamed).not.toHaveBeenCalled();
    expect(result.current.renamingStoryId).toBeNull();
  });

  it('writes nothing when the title is only spaces', async () => {
    const { result, onStoryRenamed } = setup();

    act(() => result.current.startRename(ledger));
    act(() => result.current.setRenameValue('   '));

    await act(async () => {
      await result.current.commitRename(ledger);
    });

    expect(storiesApi.updateStory).not.toHaveBeenCalled();
    expect(onStoryRenamed).not.toHaveBeenCalled();
    expect(result.current.renamingStoryId).toBeNull();
  });

  it('says why a rename was refused, and reports no new row', async () => {
    const { result, onStoryRenamed, onError } = setup();
    storiesApi.updateStory.mockRejectedValue('the database is locked');

    act(() => result.current.startRename(ledger));
    act(() => result.current.setRenameValue('The Ledger'));

    await act(async () => {
      await result.current.commitRename(ledger);
    });

    expect(onStoryRenamed).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Could not rename story: the database is locked');
  });

  it('closes the field on Escape without writing anything', () => {
    const { result } = setup();

    act(() => result.current.startRename(ledger));
    act(() => result.current.setRenameValue('Something else'));
    act(() => result.current.cancelRename());

    expect(result.current.renamingStoryId).toBeNull();
    expect(storiesApi.updateStory).not.toHaveBeenCalled();
  });
});

describe('deleting a story', () => {
  it('asks before deleting, and cancelling writes nothing', () => {
    const { result } = setup();

    act(() => result.current.askDeleteStory('story-2'));
    expect(result.current.confirmDeleteStoryId).toBe('story-2');

    act(() => result.current.cancelDeleteStory());

    expect(result.current.confirmDeleteStoryId).toBeNull();
    expect(storiesApi.deleteStory).not.toHaveBeenCalled();
  });

  it('moves the story to the trash and hands back what is left', async () => {
    const { result, onStoryDeleted, onError } = setup();

    act(() => result.current.askDeleteStory('story-2'));
    await act(async () => {
      await result.current.removeStory(vault);
    });

    expect(storiesApi.deleteStory).toHaveBeenCalledWith('story-2', 'You');
    expect(onStoryDeleted).toHaveBeenCalledWith(vault, [ledger]);
    expect(onError).toHaveBeenCalledWith(null);
    // The question is answered by the click that deletes.
    expect(result.current.confirmDeleteStoryId).toBeNull();
  });

  it('hands back an empty shelf when the only story goes', async () => {
    const { result, onStoryDeleted } = setup({ stories: [ledger] });

    await act(async () => {
      await result.current.removeStory(ledger);
    });

    expect(onStoryDeleted).toHaveBeenCalledWith(ledger, []);
  });

  it('says why a delete was refused, and reports nothing deleted', async () => {
    const { result, onStoryDeleted, onError } = setup();
    storiesApi.deleteStory.mockRejectedValue('the file is read-only');

    await act(async () => {
      await result.current.removeStory(vault);
    });

    expect(onStoryDeleted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Could not delete story: the file is read-only');
    expect(result.current.confirmDeleteStoryId).toBeNull();
  });
});

describe('importing a story', () => {
  it('does nothing when the file dialog is dismissed', async () => {
    const { result, onStoryImported, onError } = setup();

    await act(async () => {
      await result.current.importStory();
    });

    expect(storiesApi.importStoryJson).not.toHaveBeenCalled();
    expect(onStoryImported).not.toHaveBeenCalled();
    expect(result.current.storyNotice).toBeNull();
    // Dismissing a dialog is not a failure.
    expect(onError).not.toHaveBeenCalledWith(expect.stringContaining('Could not'));
  });

  it('opens what it imported and says its name', async () => {
    const { result, onStoryImported } = setup();
    openFileDialog.mockResolvedValue('C:\\exports\\vault.json');
    storiesApi.importStoryJson.mockResolvedValue(vault);

    await act(async () => {
      await result.current.importStory();
    });

    expect(openFileDialog).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      filters: [{ name: 'Story export', extensions: ['json'] }],
    });
    expect(storiesApi.importStoryJson).toHaveBeenCalledWith('C:\\exports\\vault.json', 'You');
    expect(onStoryImported).toHaveBeenCalledWith(vault);
    expect(result.current.storyNotice).toBe('Imported "Vault"');
  });

  it('says why a file could not be imported, and claims no import', async () => {
    const { result, onStoryImported, onError } = setup();
    openFileDialog.mockResolvedValue('C:\\exports\\broken.json');
    storiesApi.importStoryJson.mockRejectedValue('that is not a story export');

    await act(async () => {
      await result.current.importStory();
    });

    expect(onStoryImported).not.toHaveBeenCalled();
    expect(result.current.storyNotice).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      'Could not import that file: that is not a story export'
    );
  });

  it('can be dismissed once read', async () => {
    const { result } = setup();
    openFileDialog.mockResolvedValue('C:\\exports\\vault.json');
    storiesApi.importStoryJson.mockResolvedValue(vault);

    await act(async () => {
      await result.current.importStory();
    });
    act(() => result.current.dismissStoryNotice());

    expect(result.current.storyNotice).toBeNull();
  });
});

describe('exporting a story', () => {
  it('writes the JSON snapshot for the open story and says where it went', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.exportStory();
    });

    expect(storiesApi.exportStoryJson).toHaveBeenCalledWith('story-1');
    expect(result.current.exportStatus).toBe('C:\\exports\\ledger.json');
  });

  it('offers nothing to write when no story is open', async () => {
    const { result } = setup({ currentStory: null });

    await act(async () => {
      await result.current.exportStory();
      await result.current.exportStoryBible();
      await result.current.copyStoryBible();
    });

    expect(storiesApi.exportStoryJson).not.toHaveBeenCalled();
    expect(storiesApi.exportStoryMarkdown).not.toHaveBeenCalled();
    expect(storiesApi.storyBibleMarkdown).not.toHaveBeenCalled();
    expect(result.current.exportStatus).toBeNull();
  });

  it('writes the Markdown bible', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.exportStoryBible();
    });

    expect(storiesApi.exportStoryMarkdown).toHaveBeenCalledWith('story-1');
    expect(result.current.exportStatus).toBe('C:\\exports\\ledger-story-bible.md');
  });

  it('says why the JSON export failed', async () => {
    const { result, onError } = setup();
    storiesApi.exportStoryJson.mockRejectedValue('the exports folder is read-only');

    await act(async () => {
      await result.current.exportStory();
    });

    expect(result.current.exportStatus).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      'Could not export story: the exports folder is read-only'
    );
  });

  it('says why the Markdown bible failed', async () => {
    const { result, onError } = setup();
    storiesApi.exportStoryMarkdown.mockRejectedValue('the exports folder is gone');

    await act(async () => {
      await result.current.exportStoryBible();
    });

    expect(result.current.exportStatus).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      'Could not write the story bible: the exports folder is gone'
    );
  });

  it('copies the same outline the file would hold, and writes no file', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.copyStoryBible();
    });

    // Read from the database, not from the last file written.
    expect(storiesApi.storyBibleMarkdown).toHaveBeenCalledWith('story-1');
    expect(writeText).toHaveBeenCalledWith('# Ledger\n\n## Chapters\n');
    expect(storiesApi.exportStoryMarkdown).not.toHaveBeenCalled();
    expect(result.current.copyNotice).toBe('Story bible copied to the clipboard');
  });

  it('does not claim a copy that failed', async () => {
    const { result, onError } = setup();
    writeText.mockRejectedValue('the clipboard is locked');

    await act(async () => {
      await result.current.copyStoryBible();
    });

    expect(result.current.copyNotice).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      'Could not copy the story bible: the clipboard is locked'
    );
  });
});

describe('the notices the round trips leave', () => {
  it('lets the export path fade after eight seconds', async () => {
    vi.useFakeTimers();
    const { result } = setup();

    await act(async () => {
      await result.current.exportStory();
    });
    expect(result.current.exportStatus).not.toBeNull();

    act(() => vi.advanceTimersByTime(8000));

    expect(result.current.exportStatus).toBeNull();
  });

  it('lets the copied outline fade after five, sooner than a file', async () => {
    vi.useFakeTimers();
    const { result } = setup();

    await act(async () => {
      await result.current.copyStoryBible();
    });
    expect(result.current.copyNotice).not.toBeNull();

    act(() => vi.advanceTimersByTime(5000));

    expect(result.current.copyNotice).toBeNull();
  });

  it('lets the restore notice fade after eight seconds', async () => {
    vi.useFakeTimers();
    const { result } = setup();

    await act(async () => {
      await result.current.openBackups();
    });
    await act(async () => {
      await result.current.restoreBackup(copies[0]);
    });
    expect(result.current.restoreNotice).not.toBeNull();

    act(() => vi.advanceTimersByTime(8000));

    expect(result.current.restoreNotice).toBeNull();
  });
});

describe('the backups dialog', () => {
  it('lists the copies when it opens, and closes any earlier question', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.openBackups();
    });

    expect(result.current.backupsOpen).toBe(true);
    expect(result.current.backups).toEqual(copies);
    expect(result.current.backupsLoading).toBe(false);
    expect(result.current.confirmRestore).toBeNull();
    expect(result.current.backupsError).toBeNull();
  });

  it('says when the list itself cannot be read', async () => {
    const { result } = setup();
    storiesApi.listBackups.mockRejectedValue('the folder is gone');

    await act(async () => {
      await result.current.openBackups();
    });

    expect(result.current.backupsError).toBe('Could not read the backups: the folder is gone');
    expect(result.current.backupsLoading).toBe(false);
    // The dialog stays up, so the reason is read where the list would be.
    expect(result.current.backupsOpen).toBe(true);
  });

  it('asks before replacing anything, and cancelling keeps the data', () => {
    const { result } = setup();

    act(() => result.current.askRestore(copies[0].file_name));
    expect(result.current.confirmRestore).toBe(copies[0].file_name);

    act(() => result.current.cancelRestore());

    expect(result.current.confirmRestore).toBeNull();
    expect(storiesApi.restoreBackup).not.toHaveBeenCalled();
  });

  it('restores the copy, closes, and says when it was taken', async () => {
    const { result, onDatabaseRestored } = setup();
    const restored = [story('story-0', 'Restored', '2026-10-19T09:00:00Z')];
    storiesApi.getAllStories.mockResolvedValue(restored);

    await act(async () => {
      await result.current.openBackups();
    });
    act(() => result.current.askRestore(copies[0].file_name));
    await act(async () => {
      await result.current.restoreBackup(copies[0]);
    });

    expect(storiesApi.restoreBackup).toHaveBeenCalledWith(copies[0].file_name);
    // The stories come from the restored file, not from the one that was open.
    expect(onDatabaseRestored).toHaveBeenCalledWith(restored);
    expect(result.current.backupsOpen).toBe(false);
    expect(result.current.confirmRestore).toBeNull();
    expect(result.current.restoringFile).toBeNull();
    expect(result.current.restoreNotice).toBe(`Restored the copy from ${formatWhen(copies[0].created_at)}`);
  });

  it('says why a restore failed and leaves the dialog open', async () => {
    const { result, onDatabaseRestored } = setup();
    storiesApi.restoreBackup.mockRejectedValue('the file is locked');

    await act(async () => {
      await result.current.openBackups();
    });
    await act(async () => {
      await result.current.restoreBackup(copies[0]);
    });

    expect(onDatabaseRestored).not.toHaveBeenCalled();
    expect(result.current.backupsError).toBe('Could not restore that copy: the file is locked');
    expect(result.current.backupsOpen).toBe(true);
    expect(result.current.restoringFile).toBeNull();
    expect(result.current.restoreNotice).toBeNull();
  });

  it('closes on Escape', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.openBackups();
    });
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(result.current.backupsOpen).toBe(false);
    expect(result.current.confirmRestore).toBeNull();
  });

  it('cannot be closed while a restore is running', async () => {
    const { result } = setup();
    let finish: (() => void) | null = null;
    storiesApi.restoreBackup.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );

    await act(async () => {
      await result.current.openBackups();
    });
    act(() => {
      void result.current.restoreBackup(copies[0]);
    });
    await waitFor(() => expect(result.current.restoringFile).toBe(copies[0].file_name));

    // The backdrop, the × and Escape are one rule: the file is being replaced,
    // so the dialog stays up until it is done.
    act(() => result.current.closeBackups());
    expect(result.current.backupsOpen).toBe(true);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(result.current.backupsOpen).toBe(true);

    await act(async () => {
      finish?.();
    });
    await waitFor(() => expect(result.current.backupsOpen).toBe(false));
  });

  it('closes on request when nothing is being replaced', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.openBackups();
    });
    act(() => result.current.closeBackups());

    expect(result.current.backupsOpen).toBe(false);
  });
});
