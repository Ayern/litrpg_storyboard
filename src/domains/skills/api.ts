import { invoke } from '@tauri-apps/api/core';
import type { CharacterSkill, SkillEvolution } from '../shared/types';
import type { CharacterSkillEvent } from './types';

// Skills and what happens to them. A skill is held by one cast member, so its
// owner is part of the row rather than a separate link.

export function getCharacterSkills(characterId: string) {
  return invoke<CharacterSkill[]>('get_character_skills', { characterId });
}

export function getStorySkills(storyId: string) {
  return invoke<CharacterSkill[]>('get_story_skills', { storyId });
}

export function addSkill(
  characterId: string,
  name: string,
  rank: string | null,
  effect: string | null,
  chapterId: string | null,
  nodeId: string | null,
  actor: string
) {
  return invoke<CharacterSkill>('add_skill', {
    characterId,
    name,
    rank,
    effect,
    chapterId,
    nodeId,
    user: actor,
  });
}

export function updateSkill(
  id: string,
  name: string,
  rank: string | null,
  effect: string | null,
  chapterId: string | null,
  nodeId: string | null,
  actor: string
) {
  return invoke<CharacterSkill>('update_skill', {
    id,
    name,
    rank,
    effect,
    chapterId,
    nodeId,
    user: actor,
  });
}

export function deleteSkill(id: string, actor: string) {
  return invoke<void>('delete_skill', { id, user: actor });
}

export function getStorySkillEvents(storyId: string) {
  return invoke<CharacterSkillEvent[]>('get_story_skill_events', { storyId });
}

export function addSkillEvent(
  skillId: string,
  kind: string,
  chapterId: string | null,
  rank: string | null,
  milestoneId: string | null,
  actor: string
) {
  return invoke<CharacterSkillEvent>('add_skill_event', {
    skillId,
    kind,
    chapterId,
    rank,
    milestoneId,
    user: actor,
  });
}

export function updateSkillEvent(
  id: string,
  kind: string,
  chapterId: string | null,
  rank: string | null,
  milestoneId: string | null,
  actor: string
) {
  return invoke<CharacterSkillEvent>('update_skill_event', {
    id,
    kind,
    chapterId,
    rank,
    milestoneId,
    user: actor,
  });
}

export function deleteSkillEvent(id: string, actor: string) {
  return invoke<void>('delete_skill_event', { id, user: actor });
}

export function getStorySkillEvolutions(storyId: string) {
  return invoke<SkillEvolution[]>('get_story_skill_evolutions', { storyId });
}

export function addSkillEvolution(
  parentSkillId: string,
  childSkillId: string,
  evolutionType: string,
  chapterId: string | null,
  requiredRank: string | null,
  notes: string | null,
  actor: string
) {
  return invoke<SkillEvolution>('add_skill_evolution', {
    parentSkillId,
    childSkillId,
    evolutionType,
    chapterId,
    requiredRank,
    notes,
    user: actor,
  });
}

export function deleteSkillEvolution(id: string, actor: string) {
  return invoke<void>('delete_skill_evolution', { id, user: actor });
}
