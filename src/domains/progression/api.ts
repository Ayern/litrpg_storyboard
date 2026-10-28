import { invoke } from '@tauri-apps/api/core';
import type {
  Character,
  CharacterAward,
  CharacterLevel,
  CharacterProgress,
  LevelGrowthRule,
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

export function getStoryLevels(storyId: string) {
  return invoke<CharacterLevel[]>('get_story_levels', { storyId });
}

export function addCharacterLevel(
  characterId: string,
  level: number,
  chapterId: string | null,
  isDebuff: boolean,
  xp: number | null,
  statChanges: LevelStatChangeInput[],
  actor: string
) {
  return invoke<CharacterLevel>('add_character_level', {
    characterId,
    level,
    chapterId,
    isDebuff,
    xp,
    statChanges,
    user: actor,
  });
}

export function updateCharacterLevel(
  id: string,
  level: number,
  chapterId: string | null,
  isDebuff: boolean,
  xp: number | null,
  statChanges: LevelStatChangeInput[],
  actor: string
) {
  return invoke<CharacterLevel>('update_character_level', {
    id,
    level,
    chapterId,
    isDebuff,
    xp,
    statChanges,
    user: actor,
  });
}

export function deleteCharacterLevel(id: string, actor: string) {
  return invoke<void>('delete_character_level', { id, user: actor });
}

// The one progression field an author types. Experience is the ledger's sum and
// the level falls out of the story's curve, so neither is sent: the command would
// have nothing to do with them.
export function setCharacterProgress(
  characterId: string,
  rank: string | null,
  actor: string
) {
  return invoke<Character>('set_character_progress', {
    characterId,
    rank,
    user: actor,
  });
}

// What a level hands out. A rule with no character id is the story's own; one
// with an id replaces it for that character.
export function getStoryLevelGrowthRules(storyId: string) {
  return invoke<LevelGrowthRule[]>('get_story_level_growth_rules', { storyId });
}

export function saveLevelGrowthRule(
  storyId: string,
  characterId: string | null,
  pointsPerLevel: number,
  xpBase: number,
  xpGrowth: number,
  stats: { stat_name: string; per_level: number }[],
  actor: string
) {
  return invoke<LevelGrowthRule>('save_level_growth_rule', {
    storyId,
    characterId,
    pointsPerLevel,
    xpBase,
    xpGrowth,
    stats,
    user: actor,
  });
}

export function deleteLevelGrowthRule(id: string, actor: string) {
  return invoke<void>('delete_level_growth_rule', { id, user: actor });
}

// Gains that are not level-ups. Writing one applies it: XP lands on the
// chapter's income and stat points on the sheet.
export function getStoryCharacterAwards(storyId: string) {
  return invoke<CharacterAward[]>('get_story_character_awards', { storyId });
}

export function addCharacterAward(
  characterId: string,
  chapterId: string | null,
  kind: 'xp' | 'stat',
  statName: string | null,
  amount: number,
  note: string | null,
  actor: string
) {
  return invoke<CharacterAward>('add_character_award', {
    characterId,
    chapterId,
    kind,
    statName,
    amount,
    note,
    user: actor,
  });
}

export function deleteCharacterAward(id: string, actor: string) {
  return invoke<void>('delete_character_award', { id, user: actor });
}

// What a sheet held at one chapter, worked out by the database rather than the
// UI, so the number on a chapter card matches the ledger it came from.
export function getCharacterStateAtChapter(characterId: string, chapterId: string) {
  return invoke<CharacterChapterState>('get_character_state_at_chapter', {
    characterId,
    chapterId,
  });
}
