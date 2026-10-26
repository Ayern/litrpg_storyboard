import { invoke } from '@tauri-apps/api/core';
import type { Character, CharacterStat } from '../shared/types';
import type { CharacterAttribute } from './types';

// The cast and their sheet numbers. A stat or an attribute is written by name,
// so the database updates the row that already has it rather than adding a
// second one, which is why neither command takes an id for a new value.

export function getCharacters(storyId: string) {
  return invoke<Character[]>('get_characters', { storyId });
}

export function createCharacter(
  storyId: string,
  name: string,
  description: string | null,
  actor: string
) {
  return invoke<Character>('create_new_character', { storyId, name, description, user: actor });
}

export function updateCharacter(
  id: string,
  name: string,
  description: string | null,
  actor: string
) {
  return invoke<Character>('update_character', { id, name, description, user: actor });
}

export function deleteCharacter(id: string, actor: string) {
  return invoke<void>('delete_character', { id, user: actor });
}

export function getStoryCharacterStats(storyId: string) {
  return invoke<CharacterStat[]>('get_story_character_stats', { storyId });
}

export function getCharacterStats(characterId: string) {
  return invoke<CharacterStat[]>('get_character_stats', { characterId });
}

export function setCharacterStat(
  characterId: string,
  statName: string,
  value: number,
  notes: string | null,
  actor: string
) {
  return invoke<CharacterStat>('set_character_stat', {
    characterId,
    statName,
    value,
    notes,
    user: actor,
  });
}

export function getCharacterAttributes(characterId: string) {
  return invoke<CharacterAttribute[]>('get_character_attributes', { characterId });
}

export function setCharacterAttribute(
  characterId: string,
  attrName: string,
  value: string,
  actor: string
) {
  return invoke<CharacterAttribute>('set_character_attribute', {
    characterId,
    attrName,
    value,
    user: actor,
  });
}

export function deleteCharacterAttribute(id: string, actor: string) {
  return invoke<void>('delete_character_attribute', { id, user: actor });
}
