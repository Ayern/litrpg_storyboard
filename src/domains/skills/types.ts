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
