import { useEffect, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { formatWhen } from '../../lib/format';
import * as storiesApi from './api';
import type { BackupInfo, Story } from './types';

// The story shelf's own state: which row is being renamed, which one is a click
// away from the trash, the notices the import and export round trips leave, and
// the backups dialog — the one action that replaces the whole database.
//
// The stories themselves are read by the search palette, the first-story load and
// the sidebar at once, so the list stays where the loads can reach it: it arrives
// as an argument and what each action did leaves through a callback. The error
// line is app-wide for the same reason, so a refusal is reported rather than
// held here.

export interface StoryShelfOptions {
  // The shelf as it stands, so a delete can hand back what is left of it.
  stories: Story[];
  // The open story, because the export buttons act on it.
  currentStory: Story | null;
  actor: string;
  onStoryRenamed: (story: Story) => void;
  onStoryDeleted: (story: Story, remaining: Story[]) => void;
  onStoryImported: (story: Story) => void;
  // A restore replaces the file under every read in the app, so the stories the
  // restored file holds are handed over whole rather than merged into the old
  // list.
  onDatabaseRestored: (stories: Story[]) => void;
  onError: (message: string | null) => void;
}

export function useStoryShelf({
  stories,
  currentStory,
  actor,
  onStoryRenamed,
  onStoryDeleted,
  onStoryImported,
  onDatabaseRestored,
  onError,
}: StoryShelfOptions) {
  // The story whose title is being edited in the sidebar, and the text in it.
  const [renamingStoryId, setRenamingStoryId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // The story one click away from the trash, asked in the row itself.
  const [confirmDeleteStoryId, setConfirmDeleteStoryId] = useState<string | null>(null);

  // What the last round trip said: where the file went, what the clipboard now
  // holds, or which story was opened.
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  // One strip for what replaced the open story: an import, or a demo story the
  // shelf built.
  const [storyNotice, setStoryNotice] = useState<string | null>(null);

  // The launch copies beside the database, and the dialog that lists them.
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupsError, setBackupsError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoringFile, setRestoringFile] = useState<string | null>(null);
  // Kept apart from the undo notice: loading a story clears that one, and this
  // one is written just as the restored story is being loaded.
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  const startRename = (story: Story) => {
    onError(null);
    // One row is open at a time, and the delete question belongs to the row it
    // was asked about.
    setConfirmDeleteStoryId(null);
    setRenamingStoryId(story.id);
    setRenameValue(story.title);
  };

  const cancelRename = () => setRenamingStoryId(null);

  // The field closes either way: a title that was not changed is not an edit, so
  // nothing is written for it.
  const commitRename = async (story: Story) => {
    setRenamingStoryId(null);

    const title = renameValue.trim();
    if (!title || title === story.title) return;

    try {
      const updated = await storiesApi.updateStory(story.id, title, actor);
      onStoryRenamed(updated);
    } catch (e) {
      console.error('Failed to rename story:', e);
      onError(`Could not rename story: ${String(e)}`);
    }
  };

  const askDeleteStory = (id: string) => setConfirmDeleteStoryId(id);

  const cancelDeleteStory = () => setConfirmDeleteStoryId(null);

  const removeStory = async (story: Story) => {
    setConfirmDeleteStoryId(null);
    onError(null);

    try {
      await storiesApi.deleteStory(story.id, actor);

      // What is left is handed over rather than written here: if the deleted
      // story was the open one, the board has to be moved to another.
      onStoryDeleted(story, stories.filter(other => other.id !== story.id));
    } catch (e) {
      console.error('Failed to delete story:', e);
      onError(`Could not delete story: ${String(e)}`);
    }
  };

  const importStory = async () => {
    onError(null);
    setStoryNotice(null);

    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'Story export', extensions: ['json'] }],
      });

      // The dialog returns null when it is dismissed, which is not an error.
      if (typeof selected !== 'string') return;

      const imported = await storiesApi.importStoryJson(selected, actor);

      onStoryImported(imported);
      setStoryNotice(`Imported "${imported.title}"`);
    } catch (e) {
      console.error('Failed to import story:', e);
      onError(`Could not import that file: ${String(e)}`);
    }
  };

  const exportStory = async () => {
    if (!currentStory) return;
    onError(null);
    setExportStatus(null);

    try {
      const path: string = await storiesApi.exportStoryJson(currentStory.id);
      setExportStatus(path);
    } catch (e) {
      console.error('Failed to export story:', e);
      onError(`Could not export story: ${String(e)}`);
    }
  };

  // The hand-off for drafting elsewhere: Markdown, not a snapshot of the app.
  const exportStoryBible = async () => {
    if (!currentStory) return;
    onError(null);
    setExportStatus(null);

    try {
      const path: string = await storiesApi.exportStoryMarkdown(currentStory.id);
      setExportStatus(path);
    } catch (e) {
      console.error('Failed to write the story bible:', e);
      onError(`Could not write the story bible: ${String(e)}`);
    }
  };

  // The same text the file holds, so copying and saving cannot say different
  // things; the Markdown is read from the database rather than the last file.
  const copyStoryBible = async () => {
    if (!currentStory) return;
    onError(null);
    setCopyNotice(null);

    try {
      const markdown: string = await storiesApi.storyBibleMarkdown(currentStory.id);

      await writeText(markdown);
      setCopyNotice('Story bible copied to the clipboard');
    } catch (e) {
      console.error('Failed to copy the story bible:', e);
      onError(`Could not copy the story bible: ${String(e)}`);
    }
  };

  const openBackups = async () => {
    setBackupsOpen(true);
    setConfirmRestore(null);
    setBackupsError(null);
    setBackupsLoading(true);

    try {
      setBackups(await storiesApi.listBackups());
    } catch (e) {
      console.error('Failed to list backups:', e);
      setBackupsError(`Could not read the backups: ${String(e)}`);
    } finally {
      setBackupsLoading(false);
    }
  };

  // The backdrop, the × and Escape are one rule: while a copy is being put back
  // the file underneath the app is half replaced, so the dialog stays up.
  const closeBackups = () => {
    if (restoringFile) return;

    setBackupsOpen(false);
    setConfirmRestore(null);
  };

  const askRestore = (fileName: string) => setConfirmRestore(fileName);

  const cancelRestore = () => setConfirmRestore(null);

  // Restoring replaces the file under the whole app. Everything read from the old
  // one is dropped and read again through the callback, and the session's undo
  // history goes with it, because it describes rows that no longer exist.
  const restoreBackup = async (file: BackupInfo) => {
    setRestoringFile(file.file_name);
    setBackupsError(null);

    try {
      await storiesApi.restoreBackup(file.file_name);

      onDatabaseRestored(await storiesApi.getAllStories());

      setConfirmRestore(null);
      setBackupsOpen(false);
      setRestoreNotice(`Restored the copy from ${formatWhen(file.created_at)}`);
    } catch (e) {
      console.error('Failed to restore a backup:', e);
      setBackupsError(`Could not restore that copy: ${String(e)}`);
    } finally {
      setRestoringFile(null);
    }
  };

  // Escape closes the dialog, but not while a restore is already running.
  useEffect(() => {
    if (!backupsOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || restoringFile) return;

      event.preventDefault();
      setBackupsOpen(false);
      setConfirmRestore(null);
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [backupsOpen, restoringFile]);

  // A stale "exported to ..." note is worse than none, so let it expire.
  useEffect(() => {
    if (!exportStatus) return;
    const timer = setTimeout(() => setExportStatus(null), 8000);
    return () => clearTimeout(timer);
  }, [exportStatus]);

  // A copied outline is a smaller event than a file, so its note is shorter.
  useEffect(() => {
    if (!copyNotice) return;
    const timer = setTimeout(() => setCopyNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [copyNotice]);

  useEffect(() => {
    if (!restoreNotice) return;
    const timer = setTimeout(() => setRestoreNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [restoreNotice]);

  return {
    // Renaming a story in the sidebar.
    renamingStoryId,
    renameValue,
    setRenameValue,
    startRename,
    cancelRename,
    commitRename,

    // Deleting a story, asked in its row.
    confirmDeleteStoryId,
    askDeleteStory,
    cancelDeleteStory,
    removeStory,

    // The import and export round trips, and what each left behind.
    storyNotice,
    announceStory: (message: string) => setStoryNotice(message),
    dismissStoryNotice: () => setStoryNotice(null),
    exportStatus,
    copyNotice,
    importStory,
    exportStory,
    exportStoryBible,
    copyStoryBible,

    // The backups dialog.
    backupsOpen,
    openBackups,
    closeBackups,
    backups,
    backupsLoading,
    backupsError,
    confirmRestore,
    askRestore,
    cancelRestore,
    restoringFile,
    restoreBackup,
    restoreNotice,
  };
}
