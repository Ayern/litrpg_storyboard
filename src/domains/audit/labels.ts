import type { AuditEntry, AuditFilter, RevertState } from './types';

export const entityLabels: Record<string, string> = {
  story: 'Story',
  character: 'Character',
  character_stat: 'Character stat',
  character_attribute: 'Character attribute',
  character_skill: 'Character skill',
  character_inventory: 'Inventory item',
  character_currency: 'Currency',
  character_relation: 'Relation',
  faction_standing: 'Faction standing',
  quest: 'Quest',
  quest_reward: 'Quest reward',
  node: 'Graph node',
  edge: 'Graph connection',
  history: 'History',
};

// A few recorded field names are column names rather than words.
export const fieldLabels: Record<string, string> = {
  xp: 'XP',
  xp_to_next: 'XP to next',
  chapter_pov: 'POV',
  chapter_day: 'in-world day',
  chapter_time: 'time of day',
  card: 'skill card',
  item_card: 'item card',
  lost_chapter: 'chapter lost in',
  kind: 'kind',
  note: 'note',
  standing: 'standing',
  faction: 'faction card',
  since: 'began in',
  until: 'ended in',
  title: 'title',
  status: 'status',
  giver: 'giver',
  accepted: 'accepted in',
  completed: 'ended in',
  description: 'description',
  notes: 'notes',
  type: 'reward type',
  target: 'reward target',
  details: 'reward details',
};

// The badge reads as a word; the CSS class stays the raw action so the colours
// are keyed to what the database recorded.
export const actionLabels: Record<string, string> = {
  soft_delete: 'trash',
  purge: 'delete forever',
  revert: 'revert',
  level_up: 'level up',
  undo_refused: 'undo refused',
  redo_refused: 'redo refused',
  step_rolled_back: 'rolled back',
};

// What the button says when a revert is not on offer. The words name the reason
// in the space the action would take; the full sentence is in its tooltip.
export const revertLabels: Record<RevertState, string> = {
  available: 'Revert',
  changed_since: 'Changed since',
  in_trash: 'In trash',
  gone: 'Gone',
  already_back: 'Already back',
};

export const auditFilters: { value: AuditFilter; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'story', label: 'Story' },
  { value: 'character', label: 'Characters' },
  { value: 'character_stat', label: 'Stats' },
  { value: 'character_attribute', label: 'Attributes' },
  { value: 'character_skill', label: 'Skills' },
  { value: 'character_inventory', label: 'Inventory' },
  { value: 'character_currency', label: 'Currency' },
  { value: 'character_relation', label: 'Relations' },
  { value: 'faction_standing', label: 'Faction standings' },
  { value: 'quest', label: 'Quests' },
  { value: 'quest_reward', label: 'Quest rewards' },
  { value: 'node', label: 'Nodes' },
  { value: 'edge', label: 'Connections' },
  { value: 'history', label: 'History' },
];

// One screenful of history at a time. The tab used to request everything up to a
// fixed 200 and then stop silently, so anything older was simply unreachable.
export const AUDIT_PAGE_SIZE = 50;

export function entityLabel(entry: AuditEntry): string {
  const base = entityLabels[entry.entity_type] ?? entry.entity_type;
  if (!entry.field_changed) return base;

  return `${base} (${fieldLabels[entry.field_changed] ?? entry.field_changed})`;
}
