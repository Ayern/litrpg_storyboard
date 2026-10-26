// What one card in the tree is given.

export interface SkillTreeNodeData {
  skillId: string;
  label: string;
  rank: string | null;
  characterName: string;
  tier: number;
  prerequisites: number;
  outcomes: number;
  // Set while the open link form would close a loop through this skill.
  inDraftLoop?: boolean;
  onSelect?: (skillId: string) => void;
}

// What the link form hands to the tree when a parent and child are chosen.
export interface SkillEvolutionInput {
  parentSkillId: string;
  childSkillId: string;
  evolutionType: string;
  chapterId: string | null;
  requiredRank: string | null;
  notes: string | null;
}

export type SkillEventKind = 'upgraded' | 'sacrificed' | 'used';

// One change in a skill's life. The chapter places it in the reading order; the
// rank is only meaningful for upgrades and uses.
export interface CharacterSkillEvent {
  id: string;
  skill_id: string;
  kind: SkillEventKind;
  chapter_id: string | null;
  rank: string | null;
  milestone_id?: string | null;
  created_at: string;
  updated_at: string;
}
