// Chapters, their cast and the snapshots the cards read.

import type {
  CharacterChapterItem,
  CharacterChapterSkill,
  CharacterChapterStat,
} from '../shared/types';

// What a character's sheet held at a chapter, read from the milestone and event
// ledgers by the database rather than recalculated in the UI.
export interface CharacterChapterState {
  character_id: string;
  chapter_id: string;
  chapter_seq: number;
  level: number | null;
  level_milestone_id: string | null;
  level_is_penalty: boolean;
  // The chapter the level was recorded in, so a readout can say where the
  // number came from as well as what it was.
  level_chapter_id: string | null;
  level_chapter_seq: number | null;
  stats: CharacterChapterStat[];
  skills: CharacterChapterSkill[];
  items: CharacterChapterItem[];
  // Items with no chapter, which cannot be placed in the story.
  undated_items: number;
}

// The compact form of that snapshot used by a chapter card. The database sends
// one row per assigned character; the card adds the cast member's name.
export interface ChapterCastState {
  chapter_id: string;
  character_id: string;
  level: number | null;
  level_is_penalty: boolean;
  skills: CharacterChapterSkill[];
}

// One character the author added to a chapter's cast. The linked cast member
// and POV are kept as links on the node, so they are not rows here.
export interface ChapterCastMember {
  id: string;
  chapter_id: string;
  character_id: string;
  created_at: string;
  updated_at: string;
}
