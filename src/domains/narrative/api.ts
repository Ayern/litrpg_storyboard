import { invoke } from '@tauri-apps/api/core';
import type { IndexedNode } from '../canvas/types';
import type { ChapterCastMember, ChapterCastState } from './types';

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
