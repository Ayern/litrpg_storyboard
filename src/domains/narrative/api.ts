import { invoke } from '@tauri-apps/api/core';
import type { IndexedNode } from '../canvas/types';
import type {
  ChapterCastMember,
  ChapterCastState,
  ChapterEvent,
  ChapterTask,
} from './types';

// Chapters, the cast assigned to them and the notes hanging under them. A
// chapter and a note are both stored as nodes, so the rows that come back are
// the board's node rows: the canvas types are shared rather than copied here.

export function getChapterNotes(storyId: string) {
  return invoke<IndexedNode[]>('get_chapter_notes', { storyId });
}

export function addChapterNote(chapterId: string, text: string, actor: string) {
  return invoke<IndexedNode>('add_chapter_note', { chapterId, text, user: actor });
}

export function updateChapterNote(id: string, text: string, actor: string) {
  return invoke<IndexedNode>('update_chapter_note', { id, text, user: actor });
}

// A note is a node, so deleting one is the board's delete: it goes to the trash
// like a card, which is why the panel drops the row without the database having
// forgotten it.
export function deleteChapterNote(id: string, actor: string) {
  return invoke<void>('delete_node', { id, user: actor });
}

// Writes the reading order and answers with the renumbered chapters, so a
// refused list leaves the board as it was rather than half-renumbered.
export function setChapterOrder(storyId: string, orderedIds: string[], actor: string) {
  return invoke<IndexedNode[]>('set_chapter_order', { storyId, orderedIds, user: actor });
}

export function setChapterDetails(
  nodeId: string,
  arc: string | null,
  words: number | null,
  target: number | null,
  pov: string | null,
  day: number | null,
  time: string | null,
  actor: string
) {
  return invoke<IndexedNode>('set_chapter_details', {
    nodeId,
    arc,
    words,
    target,
    pov,
    day,
    time,
    user: actor,
  });
}

export function getStoryChapterCast(storyId: string) {
  return invoke<ChapterCastMember[]>('get_story_chapter_cast', { storyId });
}

export function getStoryChapterCastStates(storyId: string) {
  return invoke<ChapterCastState[]>('get_story_chapter_cast_states', { storyId });
}

export function addChapterCastMember(chapterId: string, characterId: string, actor: string) {
  return invoke<ChapterCastMember>('add_chapter_cast_member', {
    chapterId,
    characterId,
    user: actor,
  });
}

export function removeChapterCastMember(id: string, actor: string) {
  return invoke<void>('remove_chapter_cast_member', { id, user: actor });
}

// The scene checklist on a chapter card. One row per line, in the order it was
// written, so a tick can be undone without the list rearranging itself.
export function getStoryChapterTasks(storyId: string) {
  return invoke<ChapterTask[]>('get_story_chapter_tasks', { storyId });
}

export function addChapterTask(chapterId: string, text: string, actor: string) {
  return invoke<ChapterTask>('add_chapter_task', { chapterId, text, user: actor });
}

export function setChapterTaskDone(id: string, done: boolean, actor: string) {
  return invoke<ChapterTask>('set_chapter_task_done', { id, done, user: actor });
}

export function deleteChapterTask(id: string, actor: string) {
  return invoke<void>('delete_chapter_task', { id, user: actor });
}

// The scene's progression ledger. XP pays into the chapter's income, a learned
// skill and an acquired item are written onto the sheet, and a rank-up, an
// evolution or a sacrifice is the scene's own record.
export function getStoryChapterEvents(storyId: string) {
  return invoke<ChapterEvent[]>('get_story_chapter_events', { storyId });
}

export function addChapterEvent(
  chapterId: string,
  actorId: string,
  eventType: string,
  details: string,
  amount: number | null,
  actor: string
) {
  return invoke<ChapterEvent>('add_chapter_event', {
    chapterId,
    actorId,
    eventType,
    details,
    amount,
    user: actor,
  });
}

export function deleteChapterEvent(id: string, actor: string) {
  return invoke<void>('delete_chapter_event', { id, user: actor });
}
