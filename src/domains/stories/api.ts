import { invoke } from '@tauri-apps/api/core';
import type { BackupInfo, Story } from './types';

// The story commands. Naming each one here is what keeps the command string and
// the row it answers with in one place; the board only ever sees the function.

export function initializeDatabase() {
  return invoke<string>('initialize_database');
}

export function getAllStories() {
  return invoke<Story[]>('get_all_stories');
}

export function createNewStory(title: string, description: string | null, actor: string) {
  return invoke<Story>('create_new_story', { title, description, user: actor });
}

export function updateStory(id: string, title: string, actor: string) {
  return invoke<Story>('update_story', { id, title, user: actor });
}

export function deleteStory(id: string, actor: string) {
  return invoke<void>('delete_story', { id, user: actor });
}

export function createDemoStory(actor: string) {
  return invoke<Story>('create_demo_story', { user: actor });
}

export function resetDemoStory(storyId: string, actor: string) {
  return invoke<Story>('reset_demo_story', { storyId, user: actor });
}

export function importStoryJson(path: string, actor: string) {
  return invoke<Story>('import_story_json', { path, user: actor });
}

// Writes the export next to the database and answers with the path it wrote.
export function exportStoryJson(storyId: string) {
  return invoke<string>('export_story_json', { storyId });
}

export function exportStoryMarkdown(storyId: string) {
  return invoke<string>('export_story_markdown', { storyId });
}

export function storyBibleMarkdown(storyId: string) {
  return invoke<string>('story_bible_markdown', { storyId });
}

export function listBackups() {
  return invoke<BackupInfo[]>('list_backups');
}

export function restoreBackup(fileName: string) {
  return invoke<void>('restore_backup', { fileName });
}
