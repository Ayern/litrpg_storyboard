// Quests, their rewards and the advisories the ledger raises.

// A quest or contract. Its two chapters place it in the reading order, its
// giver or faction says who issued it, and its rewards are its own children.
export interface Quest {
  id: string;
  story_id: string;
  title: string;
  giver_character_id: string | null;
  faction_node_id: string | null;
  // The quest card that stands for this record on the board. Null, or pointing at
  // a card in the trash, is a state the ledger says out loud rather than hiding:
  // the record is real, but there is nothing on the canvas to open.
  card_node_id?: string | null;
  accepted_chapter_id: string | null;
  completed_chapter_id: string | null;
  status: string;
  description: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  rewards: QuestReward[];
}

// One payout from a quest. The kind decides what the target is: a character for
// XP, an item and a stat, a faction card for a standing.
export interface QuestReward {
  id: string;
  quest_id: string;
  reward_type: string;
  target_id: string | null;
  amount_or_details: string | null;
  // When this payout last reached the chapter ledger; null until it has.
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

// One advisory problem in the quest ledger. The chapter links are kept so the
// Quests tab and the continuity panel can point at the chapters named.
export interface QuestWarning {
  id: string;
  questId: string;
  questTitle: string;
  kind: string;
  summary: string;
  chapterIds: string[];
}
