import { invoke } from '@tauri-apps/api/core';
import type { DeletedItem } from './types';

// The trash. A null story id means every deleted story rather than the contents
// of one, which is the same command read two ways.

export function getTrash(storyId: string | null) {
  return invoke<DeletedItem[]>('get_trash', { storyId });
}

export function getTrashRetention() {
  return invoke<number | null>('get_trash_retention');
}

// Answers with how many items the window swept out straight away.
export function setTrashRetention(days: number | null) {
  return invoke<number>('set_trash_retention', { days });
}

export function restoreDeleted(id: string, kind: string, actor: string) {
  return invoke<void>('restore_deleted', { id, kind, user: actor });
}

export function purgeDeleted(id: string, kind: string, actor: string) {
  return invoke<void>('purge_deleted', { id, kind, user: actor });
}
