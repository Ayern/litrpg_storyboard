import type {
  ChapterContinuityFlag,
  ChapterNote,
  CharacterChapterSkill,
  CharacterStat,
  InventoryHolder,
  ProgressionTarget,
  SkillHolder,
} from '../shared/types';

export interface ChapterCastBadge {
  characterId: string;
  name: string;
  level: number | null;
  levelIsPenalty: boolean;
  skills: CharacterChapterSkill[];
}

// One chapter card's quest badge: which quest, and whether it was accepted or
// ended there, so the card reads both ends of the contract.
export interface QuestBadge {
  questId: string;
  title: string;
  status: string;
  role: 'accepted' | 'completed';
}

// Simple type aliases for our custom node/edge data
export type NodeData = {
  label: string;
  nodeType: string;
  content?: string;
  createdBy: string;
  // The cast member this node points at, stored as an id on the node itself.
  characterId?: string | null;
  // The linked cast member's name and numbers, put here when the canvas is
  // drawn so the card can show them without reading the database itself.
  characterName?: string | null;
  characterStats?: CharacterStat[];
  // The linked cast member's level, drawn before the numbers.
  characterLevel?: number | null;
  // Where a chapter sits in the reading order; null on every other kind.
  chapterSeq?: number | null;
  // A chapter's arc and the words written against a target, all optional.
  chapterArc?: string | null;
  chapterWords?: number | null;
  chapterTarget?: number | null;
  // The cast member the chapter is told from, kept as an id like the node's
  // own link, and the in-world day it happens on. Both optional.
  chapterPov?: string | null;
  chapterDay?: number | null;
  // When inside that day, in the author's own words: “Dusk”, “18:40”.
  chapterTime?: string | null;
  // The notes hanging under a chapter while the graph's note toggle is on. Only
  // the first few are drawn; the rest are counted on the last card.
  noteCards?: ChapterNote[];
  hiddenNotes?: number;
  onOpenNote?: (noteId: string | null) => void;
  // Who has this skill, with the rank and chapter they learned it in. Filled in
  // when the canvas is drawn, so the card needs no read of its own.
  skillHolders?: SkillHolder[];
  hiddenSkillHolders?: number;
  // Who is carrying this item, filled in when the canvas is drawn.
  inventoryHolders?: InventoryHolder[];
  hiddenInventoryHolders?: number;
  // The cast whose snapshot applies to this chapter, linked in the reading
  // order by the database. The card shows a level only when one was recorded.
  chapterCast?: ChapterCastBadge[];
  onOpenChapterCast?: (characterId: string) => void;
  // The quests accepted or ended in this chapter, and where their badges lead.
  questBadges?: QuestBadge[];
  onOpenQuest?: (questId: string) => void;
  // Continuity warnings that belong to this chapter, short enough for the card
  // and complete in the tooltip.
  continuityFlags?: ChapterContinuityFlag[];
  hiddenContinuityFlags?: number;
  // Opens the sheet entry a continuity warning names.
  onOpenContinuity?: (characterId: string, target: ProgressionTarget) => void;
  // Clears a recorded loss without leaving the board.
  onMarkItemReturned?: (itemId: string) => void;
  returningItemId?: string | null;
  // Records the chapter ledger's sum on the milestone a warning names.
  onSyncMilestoneXp?: (flag: ChapterContinuityFlag) => void;
  syncingMilestoneXpId?: string | null;
};

// We'll use ReactFlow's internal types but cast our data. The last five are the
// LitRPG vocabulary: the System, what it grants, and the factions and quests it
// hands out. They are ordinary cards with their own colour and caption.
export const nodeTypes = [
  'chapter',
  'idea',
  'character',
  'location',
  'event',
  'plot',
  'system',
  'skill',
  'item',
  'quest',
  'faction',
  'misc',
] as const;

export type NodeType = typeof nodeTypes[number];

export function isNodeType(value: string): value is NodeType {
  return (nodeTypes as readonly string[]).includes(value);
}

// How many numbers a card has room for before it starts counting.
export const NODE_STAT_BADGES = 2;

// Same for the quests that touch a chapter: two ends of a contract can be told
// apart at a glance, and the rest are counted rather than shrinking the card.
export const QUEST_BADGES_SHOWN = 3;
// Another story's board, read when the palette opens so its nodes can be found
// without loading the story first. A chapter's note is a node too, and hangs
// under its chapter rather than on the board, which is what parent_node_id says.
export interface IndexedNode {
  id: string;
  label: string;
  node_type: string;
  content: string | null;
  pos_x: number;
  pos_y: number;
  character_id: string | null;
  parent_node_id: string | null;
}

export interface IndexedEdge {
  id: string;
  source_id: string;
  target_id: string;
  label: string | null;
  relation_type: string | null;
}
