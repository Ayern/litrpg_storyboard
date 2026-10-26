// Chapters, their cast and the snapshots the cards read.

import type { CharacterChapterSkill } from '../shared/types';

// What a character's sheet held at a chapter, read from the milestone and event
// ledgers by the database rather than recalculated in the UI.
export interface CharacterChapterState {
  character_id: string;
  chapter_id: string;
  chapter_seq: number;
  level: number | null;
  level_milestone_id: string | null;
  level_is_penalty: boolean;
  skills: CharacterChapterSkill[];
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
