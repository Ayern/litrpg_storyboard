// Model rows more than one part of the app reads.

export interface Character {
  id: string;
  story_id: string;
  name: string;
  description: string | null;
  // Progression, saved as its own fields. Optional here because a character from
  // a story written by an older build has no such fields until it is read again.
  level?: number;
  xp?: number;
  rank?: string | null;
  xp_to_next?: number | null;
  created_at: string;
  updated_at: string;
}

export interface CharacterStat {
  id: string;
  character_id: string;
  stat_name: string;
  value: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// One skill a cast member has. The rank and effect are the author's words, and
// the chapter is the one it was learned in; both links are optional.
export interface CharacterSkill {
  id: string;
  character_id: string;
  name: string;
  rank: string | null;
  effect: string | null;
  chapter_id: string | null;
  node_id: string | null;
  created_at: string;
  updated_at: string;
}

// One link in a skill tree: the parent skill a later skill grew out of,
// mutated from or fused with. The chapter places the change in the reading
// order; the required rank is the parent's rank the author says it needed.
export type EvolutionType = 'upgrade' | 'fusion' | 'mutation' | 'branch';

export interface SkillEvolution {
  id: string;
  story_id: string;
  parent_skill_id: string;
  child_skill_id: string;
  evolution_type: string;
  chapter_id: string | null;
  required_rank: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// One stat a level-up changed. `amount` is the gained points, and `value_after`
// is the sheet value once it applied. A row migrated from schema v18 has only
// the latter, because the old field was a snapshot rather than a gain.
export interface CharacterLevelStatChange {
  id: string;
  milestone_id: string;
  stat_name: string;
  amount?: number | null;
  value_after?: number | null;
  created_at: string;
  updated_at: string;
}

// One level a cast member had in a chapter. A lower level is only a problem when
// it was not explicitly marked as a penalty.
export interface CharacterLevelMilestone {
  id: string;
  character_id: string;
  level: number;
  chapter_id: string | null;
  is_debuff: boolean;
  // Optional snapshots: total XP and every stat the level changed.
  xp?: number | null;
  stat_changes?: CharacterLevelStatChange[];
  // Legacy v18 fields, accepted from an older export and shown by the fallback
  // below until the migration has copied them into a stat change.
  stat_name?: string | null;
  stat_points?: number | null;
  created_at: string;
  updated_at: string;
}

// One cast-to-cast bond. Symmetric kinds are stored with the two ids in a fixed
// order, so the same alliance cannot be recorded from both sides.
export interface CharacterRelation {
  id: string;
  story_id: string;
  from_character_id: string;
  to_character_id: string;
  kind: string;
  note: string | null;
  since_chapter_id: string | null;
  until_chapter_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// One character's place in a faction for an arc. The faction is a card; a purged
// card clears the link rather than deleting the recorded standing.
export interface FactionStanding {
  id: string;
  story_id: string;
  character_id: string;
  faction_node_id: string | null;
  standing: string;
  note: string | null;
  since_chapter_id: string | null;
  until_chapter_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// What one level hands out. `character_id` null is the story's own rule; a row
// with an id is that character's override. The rule is read by the level-up form,
// never applied on its own, because the app does not level anybody up.
export interface LevelGrowthStat {
  id: string;
  rule_id: string;
  stat_name: string;
  per_level: number;
  created_at: string;
  updated_at: string;
}

export interface LevelGrowthRule {
  id: string;
  story_id: string;
  character_id: string | null;
  points_per_level: number;
  stats: LevelGrowthStat[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

// A gain that is not a level-up: XP a chapter paid, or stat points something in
// it handed over. Writing one applies it, and deleting it takes it back.
export interface CharacterAward {
  id: string;
  character_id: string;
  chapter_id: string | null;
  kind: 'xp' | 'stat';
  stat_name: string | null;
  amount: number;
  note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// One chapter's XP income. This is separate from the total XP snapshot on a
// milestone: one says what was earned there, the other what the running total was.
export interface CharacterProgress {
  id: string;
  character_id: string;
  chapter_id: string;
  xp_earned: number;
  created_at: string;
  updated_at: string;
}

// A skill as it stood in one chapter. The rank is the one that applied then,
// which is not necessarily the rank the skill row holds today.
export interface CharacterChapterSkill {
  skill_id: string;
  name: string;
  rank: string | null;
  effect: string | null;
  learned_chapter_id: string;
  learned_chapter_seq: number;
}

// A stat as it stood in one chapter, read from the level-up that recorded it.
// A stat with no value has not been given a number by the story yet; the name
// still belongs on the sheet.
export interface CharacterChapterStat {
  stat_name: string;
  value: number | null;
  recorded_chapter_id: string | null;
  recorded_chapter_seq: number | null;
}

// An item a character carried into a chapter: gained by then, not yet lost.
// The quantity is the row's own, which the app does not date.
export interface CharacterChapterItem {
  item_id: string;
  name: string;
  quantity: number;
  rarity: string | null;
  effect: string | null;
  acquired_chapter_id: string | null;
  acquired_chapter_seq: number | null;
}

// A note kept with a chapter. It is stored as a node, but the row shows only
// what a note needs: its text and the chapter it hangs under.
export interface ChapterNote {
  id: string;
  chapterId: string;
  text: string;
}

// A skill card names the cast members who have it, and where they learned it.
export interface SkillHolder {
  id: string;
  characterName: string;
  rank: string | null;
  chapterLabel: string | null;
}

// An item card names who carries it, how many, how rare it is, where it came
// from and, when the author recorded it, where it was lost.
export interface InventoryHolder {
  id: string;
  characterName: string;
  quantity: number;
  rarity: string | null;
  chapterLabel: string | null;
  lostChapterLabel: string | null;
}

// One advisory line in the continuity panel: its words, with every chapter or
// cast entry it names as a part that opens when clicked.
export type ContinuityPart =
  | string
  | { id: string; text: string; kind?: 'chapter' }
  | {
      id: string;
      text: string;
      kind: 'character';
      target: ProgressionTarget;
    };

// What a warning should open on the character sheet. Inventory warnings open the
// sheet itself; progression warnings open the exact row that needs editing.
export type ProgressionTarget =
  | { kind: 'inventory'; itemId: string }
  | { kind: 'skill'; skillId: string }
  | { kind: 'skill-event'; eventId: string; skillId: string }
  | { kind: 'level'; milestoneId: string }
  | { kind: 'relation'; relationId: string }
  | { kind: 'faction-standing'; standingId: string };

// One continuity warning, kept with the chapter whose card it belongs on. The
// summary is short enough for a card; the detail is the whole sentence and goes
// in the tooltip and the continuity panel.
export interface ChapterContinuityFlag {
  id: string;
  itemId?: string;
  itemName?: string;
  kind: string;
  chapterId: string | null;
  characterId: string;
  characterName: string;
  summary: string;
  detail: string;
  parts: ContinuityPart[];
  // For an XP mismatch: what the ledger adds up to through this milestone's
  // chapter, so the panel can put that number on the milestone in one click.
  ledgerXp?: number;
  // For a stat mismatch: the stat and the value its last level-up recorded, so
  // the panel can put that number on the sheet in one click.
  statName?: string;
  statValue?: number;
  target: ProgressionTarget;
}
