import { invoke } from '@tauri-apps/api/core';
import type {
  Character,
  CharacterLevelMilestone,
  CharacterProgress,
} from '../shared/types';
import type { CharacterChapterState } from '../narrative/types';
import type { LevelStatChangeInput } from './types';

// Levelling: the XP a chapter earned, the levels reached and what they changed.
// A milestone carries its own stat changes, so the sheet and the sheet at a
// chapter both read from the same rows.

export function getStoryCharacterProgress(storyId: string) {
  return invoke<CharacterProgress[]>('get_story_character_progress', { storyId });
}

export function addCharacterProgress(
  characterId: string,
  chapterId: string,
  xpEarned: number,
  actor: string
) {
  return invoke<CharacterProgress>('add_character_progress', {
    characterId,
    chapterId,
    xpEarned,
    user: actor,
  });
}

export function updateCharacterProgress(
  id: string,
  chapterId: string,
  xpEarned: number,
  actor: string
) {
  return invoke<CharacterProgress>('update_character_progress', {
    id,
    chapterId,
    xpEarned,
    user: actor,
  });
}

export function deleteCharacterProgress(id: string, actor: string) {
  return invoke<void>('delete_character_progress', { id, user: actor });
}

export function getStoryLevelMilestones(storyId: string) {
  return invoke<CharacterLevelMilestone[]>('get_story_level_milestones', { storyId });
}

export function addLevelMilestone(
  characterId: string,
  level: number,
  chapterId: string | null,
  isDebuff: boolean,
  xp: number | null,
  statChanges: LevelStatChangeInput[],
  actor: string
) {
  return invoke<CharacterLevelMilestone>('add_level_milestone', {
    characterId,
    level,
    chapterId,
    isDebuff,
    xp,
    statChanges,
    user: actor,
  });
}

export function updateLevelMilestone(
  id: string,
  level: number,
  chapterId: string | null,
  isDebuff: boolean,
  xp: number | null,
  statChanges: LevelStatChangeInput[],
  actor: string
) {
  return invoke<CharacterLevelMilestone>('update_level_milestone', {
    id,
    level,
    chapterId,
    isDebuff,
    xp,
    statChanges,
    user: actor,
  });
}

export function deleteLevelMilestone(id: string, actor: string) {
  return invoke<void>('delete_level_milestone', { id, user: actor });
}

// The running totals on the cast member itself, which the level-up command
// moves on by one. Both answer with the character as it now stands.
export function setCharacterProgress(
  characterId: string,
  level: number,
  xp: number,
  rank: string | null,
  xpToNext: number | null,
  actor: string
) {
  return invoke<Character>('set_character_progress', {
    characterId,
    level,
    xp,
    rank,
    xpToNext,
    user: actor,
  });
}

export function levelUpCharacter(characterId: string, actor: string) {
  return invoke<Character>('level_up_character', { characterId, user: actor });
}

// What a sheet held at one chapter, worked out by the database rather than the
// UI, so the number on a chapter card matches the ledger it came from.
export function getCharacterStateAtChapter(characterId: string, chapterId: string) {
  return invoke<CharacterChapterState>('get_character_state_at_chapter', {
    characterId,
    chapterId,
  });
}
