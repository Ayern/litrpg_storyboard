import { invoke } from '@tauri-apps/api/core';
import type { Quest, QuestReward } from './types';

// Quests, contracts and what they pay out. A quest names the chapter it was
// accepted in and, once it is over, the one it ended in; a reward names a
// character, an item, a stat or a faction card depending on its type.

export function getStoryQuests(storyId: string) {
  return invoke<Quest[]>('get_story_quests', { storyId });
}

export function addQuest(
  storyId: string,
  title: string,
  giverCharacterId: string | null,
  factionNodeId: string | null,
  acceptedChapterId: string,
  completedChapterId: string | null,
  status: string,
  description: string | null,
  notes: string | null,
  actor: string
) {
  return invoke<Quest>('add_quest', {
    storyId,
    title,
    giverCharacterId,
    factionNodeId,
    acceptedChapterId,
    completedChapterId,
    status,
    description,
    notes,
    user: actor,
  });
}

export function updateQuest(
  id: string,
  title: string,
  giverCharacterId: string | null,
  factionNodeId: string | null,
  acceptedChapterId: string,
  completedChapterId: string | null,
  status: string,
  description: string | null,
  notes: string | null,
  actor: string
) {
  return invoke<Quest>('update_quest', {
    id,
    title,
    giverCharacterId,
    factionNodeId,
    acceptedChapterId,
    completedChapterId,
    status,
    description,
    notes,
    user: actor,
  });
}

export function deleteQuest(id: string, actor: string) {
  return invoke<void>('delete_quest', { id, user: actor });
}

// Points a quest at the card that stands for it on the board, or clears the link
// with a null card id. The link is by id, so a rename on either side keeps it, and
// a card in the trash keeps it until the card is purged.
export function linkQuestCard(questId: string, cardNodeId: string | null, actor: string) {
  return invoke<Quest>('link_quest_card', {
    questId,
    cardNodeId,
    user: actor,
  });
}

export function addQuestReward(
  questId: string,
  rewardType: string,
  targetId: string | null,
  amountOrDetails: string | null,
  actor: string
) {
  return invoke<QuestReward>('add_quest_reward', {
    questId,
    rewardType,
    targetId,
    amountOrDetails,
    user: actor,
  });
}

export function updateQuestReward(
  id: string,
  rewardType: string,
  targetId: string | null,
  amountOrDetails: string | null,
  actor: string
) {
  return invoke<QuestReward>('update_quest_reward', {
    id,
    rewardType,
    targetId,
    amountOrDetails,
    user: actor,
  });
}

export function deleteQuestReward(id: string, actor: string) {
  return invoke<void>('delete_quest_reward', { id, user: actor });
}

// Stamps the payouts that have reached the ledger, so applying a quest's
// rewards twice cannot pay them twice.
export function markQuestRewardsApplied(ids: string[]) {
  return invoke<void>('mark_quest_rewards_applied', { ids });
}
