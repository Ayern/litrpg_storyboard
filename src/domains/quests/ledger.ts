import type { QuestBadge } from '../canvas/types';
import type { Quest, QuestWarning } from './types';

// Everything the Quests tab works out from the story's quests without touching
// the database: the status words a story uses, which quests a filter lets
// through, which chapter cards carry a badge, and which warnings belong to which
// contract. The ledger and the board both read these, so each is stated once.

// The four statuses the form suggests. The database keeps the author's word, so
// a story can use its own without a migration.
export const questStatuses = ['active', 'completed', 'failed', 'abandoned'] as const;

export const questStatusLabels: Record<string, string> = {
  active: 'Active',
  completed: 'Completed',
  failed: 'Failed',
  abandoned: 'Abandoned',
};

export const questRewardTypes = ['xp', 'item', 'stat', 'faction_standing'] as const;

export const questRewardLabels: Record<string, string> = {
  xp: 'XP',
  item: 'Item',
  stat: 'Stat',
  faction_standing: 'Faction standing',
};

// The statuses this story actually uses, so a story with its own words is not
// forced back into the suggested four.
export function questStatusChoices(quests: Quest[]): string[] {
  const names = new Set<string>(questStatuses);

  for (const quest of quests) {
    const status = quest.status.trim();
    if (status) names.add(status);
  }

  return [...names];
}

// The list a status filter leaves. The stored word is compared without case or
// surrounding space, because the field is free text.
export function filterQuests(quests: Quest[], filter: string): Quest[] {
  if (filter === 'all') return quests;

  return quests.filter(
    quest => quest.status.trim().toLowerCase() === filter.toLowerCase()
  );
}

// The status filter a ledger opens on, and the word the chip shows for it.
export function questStatusFilterLabel(status: string): string {
  return status === 'all' ? 'All' : (questStatusLabels[status] ?? status);
}

// A quest shows on both chapters it names: where it was taken and where it
// ended. The acceptance chapter is required, so every quest has at least one,
// and a quest that ended in the chapter it was accepted in gets one badge rather
// than two.
export function questsByChapter(quests: Quest[]): Map<string, QuestBadge[]> {
  const byChapter = new Map<string, QuestBadge[]>();

  for (const quest of quests) {
    const add = (chapterId: string | null, role: QuestBadge['role']) => {
      if (!chapterId) return;

      const existing = byChapter.get(chapterId) ?? [];

      if (existing.some(badge => badge.questId === quest.id && badge.role === role)) {
        return;
      }

      existing.push({
        questId: quest.id,
        title: quest.title,
        status: quest.status,
        role,
      });
      byChapter.set(chapterId, existing);
    };

    add(quest.accepted_chapter_id, 'accepted');

    if (quest.completed_chapter_id !== quest.accepted_chapter_id) {
      add(quest.completed_chapter_id, 'completed');
    }
  }

  return byChapter;
}

// The advisories a ledger card lists, grouped by the quest they are about. The
// continuity panel reads the same warnings one by one.
export function warningsByQuest(warnings: QuestWarning[]): Map<string, QuestWarning[]> {
  const byQuest = new Map<string, QuestWarning[]>();

  for (const warning of warnings) {
    const existing = byQuest.get(warning.questId) ?? [];
    existing.push(warning);
    byQuest.set(warning.questId, existing);
  }

  return byQuest;
}

// How many of a quest's payouts reach the ledger by themselves, and how many of
// those are still unpaid. A stat gain and a faction standing are written in the
// author's own words, so they are applied on the sheet and never counted here.
export function rewardApplicationState(quest: Quest) {
  const automatic = quest.rewards.filter(
    reward => reward.reward_type === 'xp' || reward.reward_type === 'item'
  );
  const pending = automatic.filter(reward => !reward.applied_at).length;

  return {
    automatic,
    pending,
    allApplied: automatic.length > 0 && pending === 0,
    anyApplied: quest.rewards.some(reward => reward.applied_at),
  };
}
