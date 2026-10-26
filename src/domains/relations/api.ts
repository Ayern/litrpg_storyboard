import { invoke } from '@tauri-apps/api/core';
import type { CharacterRelation, FactionStanding } from '../shared/types';

// Bonds between cast members and where each of them stands with a faction. Both
// take a since and an until chapter, because an author records when a bond or a
// standing held rather than only that it exists.

export function getStoryRelations(storyId: string) {
  return invoke<CharacterRelation[]>('get_story_relations', { storyId });
}

export function addRelation(
  fromCharacterId: string,
  toCharacterId: string,
  kind: string,
  note: string | null,
  sinceChapterId: string | null,
  untilChapterId: string | null,
  actor: string
) {
  return invoke<CharacterRelation>('add_relation', {
    fromCharacterId,
    toCharacterId,
    kind,
    note,
    sinceChapterId,
    untilChapterId,
    user: actor,
  });
}

export function updateRelation(
  id: string,
  kind: string,
  note: string | null,
  sinceChapterId: string | null,
  untilChapterId: string | null,
  actor: string
) {
  return invoke<CharacterRelation>('update_relation', {
    id,
    kind,
    note,
    sinceChapterId,
    untilChapterId,
    user: actor,
  });
}

export function deleteRelation(id: string, actor: string) {
  return invoke<void>('delete_relation', { id, user: actor });
}

export function getStoryFactionStandings(storyId: string) {
  return invoke<FactionStanding[]>('get_story_faction_standings', { storyId });
}

export function addFactionStanding(
  characterId: string,
  factionNodeId: string | null,
  standing: string,
  note: string | null,
  sinceChapterId: string,
  untilChapterId: string | null,
  actor: string
) {
  return invoke<FactionStanding>('add_faction_standing', {
    characterId,
    factionNodeId,
    standing,
    note,
    sinceChapterId,
    untilChapterId,
    user: actor,
  });
}

export function updateFactionStanding(
  id: string,
  factionNodeId: string | null,
  standing: string,
  note: string | null,
  sinceChapterId: string,
  untilChapterId: string | null,
  actor: string
) {
  return invoke<FactionStanding>('update_faction_standing', {
    id,
    factionNodeId,
    standing,
    note,
    sinceChapterId,
    untilChapterId,
    user: actor,
  });
}

export function deleteFactionStanding(id: string, actor: string) {
  return invoke<void>('delete_faction_standing', { id, user: actor });
}
