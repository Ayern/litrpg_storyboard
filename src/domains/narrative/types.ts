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
  level_record_id: string | null;
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

// The kinds of progression a chapter card can log.
export type ChapterEventType =
  | 'xp_award'
  | 'skill_learn'
  | 'skill_rank_up'
  | 'skill_evolve'
  | 'skill_sacrifice'
  | 'item_acquire';

// One thing that happened in a scene, in the order it happened. XP, a learned
// skill, an acquired item and a rank-up, evolution or sacrifice all write their
// real row onto the sheet; an event with no skill is the older record-only line.
export interface ChapterEvent {
  id: string;
  chapter_id: string;
  actor_id: string;
  event_type: ChapterEventType;
  details: string;
  amount: number | null;
  // The award, skill or item row this event wrote, so deleting the event can
  // take that row back.
  source_id: string | null;
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  // The skill a rank-up, evolution or sacrifice changed, and the rows it wrote.
  skill_id?: string | null;
  skill_event_id?: string | null;
  new_skill_id?: string | null;
  evolution_id?: string | null;
  previous_rank?: string | null;
  keep_base_skill?: boolean;
  keep_on_sheet?: boolean;
  skill_snapshot?: string | null;
}

// One objective on a chapter card: a line the author ticks off as the scene is
// written. `position` is the order the lines were written in, so ticking one
// does not move it.
export interface ChapterTask {
  id: string;
  chapter_id: string;
  text: string;
  done: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

// One character the author added to a chapter's cast. The point of view is a
// link on the node and joins this list in the scene; a chapter has no other
// single-cast link.
export interface ChapterCastMember {
  id: string;
  chapter_id: string;
  character_id: string;
  created_at: string;
  updated_at: string;
}
