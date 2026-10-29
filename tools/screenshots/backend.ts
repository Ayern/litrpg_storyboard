// The fake Tauri backend the screenshot harness drives the real app against.
//
// Every read is served from `fixture.json`, which the Rust example beside this
// file wrote out of the real database, so the shapes here are the shapes the
// desktop build sends. Writes are kept in memory for the length of the page:
// enough for the UI to react to a click the way it does in the app, and no
// more. A command that is not implemented says so in the console rather than
// failing silently.

import { levelForXp, levelXpThreshold } from '../../src/domains/progression/growth';
import fixture from './fixture.json';

type Row = Record<string, any>;

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const story = clone(fixture.story) as Row;

const createStore = () => ({
  storyId: fixture.storyId as string,
  stories: clone(fixture.stories) as Row[],
  nodes: clone(fixture.nodes) as Row[],
  edges: clone(fixture.edges) as Row[],
  characters: clone(fixture.characters) as Row[],
  stats: clone(fixture.story_stats) as Row[],
  skills: clone(fixture.story_skills) as Row[],
  skillEvents: clone(fixture.story_skill_events) as Row[],
  // The demo's levels were all posted by its curve, which is what lets income that
  // is taken away take its levels with it. The database keeps that in a `source`
  // column the app never reads, so the fixture does not carry it.
  levels: clone(fixture.story_levels).map((row: Row) => ({
    ...row,
    source: row.source ?? 'level',
  })) as Row[],
  progress: clone(fixture.story_progress) as Row[],
  growthPoints: clone(fixture.story_growth_points ?? []) as Row[],
  growthRules: clone(fixture.story_level_growth_rules ?? []) as Row[],
  awards: clone(fixture.character_awards ?? []) as Row[],
  inventory: clone(fixture.story_inventory) as Row[],
  notes: clone(fixture.chapter_notes) as Row[],
  chapterCast: clone(fixture.story_chapter_cast) as Row[],
  tasks: clone(fixture.story_chapter_tasks ?? []) as Row[],
  chapterEvents: clone(fixture.story_chapter_events ?? []) as Row[],
  relations: clone(fixture.story_relations) as Row[],
  standings: clone(fixture.story_faction_standings) as Row[],
  quests: clone(fixture.story_quests) as Row[],
  evolutions: clone(fixture.story_skill_evolutions) as Row[],
  attributes: clone(fixture.character_attributes) as Record<string, Row[]>,
  currency: clone(fixture.character_currency) as Record<string, Row[]>,
  chapterStates: clone(fixture.chapter_states) as Record<string, Row>,
  audit: clone(fixture.audit) as Row[],
  trash: clone(fixture.trash) as Row[],
  trashStories: clone(fixture.trash_stories) as Row[],
  trashRetention: fixture.trash_retention as number | null,
});

type Store = ReturnType<typeof createStore>;

// An edit to this file would otherwise re-evaluate the module and rebuild the
// store from the fixture under a page that is holding ids and rows from the old
// one: a chapter the page still names would no longer exist here, and every XP
// row would read "Chapter in the trash". Carrying the store across the update
// keeps the session the author was in the middle of.
type HotData = { store?: Store; counter?: number; clock?: number };

const hot = (import.meta as { hot?: { data: HotData } }).hot;

const store: Store = hot?.data.store ?? createStore();

if (hot) hot.data.store = store;

let counter = hot?.data.counter ?? 0;
let clock = hot?.data.clock ?? Date.parse('2026-10-27T20:15:00Z');

const id = (prefix: string) => {
  counter += 1;
  if (hot) hot.data.counter = counter;
  return `${prefix}0000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};
const now = () => {
  clock += 1000;
  if (hot) hot.data.clock = clock;
  return new Date(clock).toISOString();
};

const upsert = (list: Row[], row: Row) => {
  const index = list.findIndex(candidate => candidate.id === row.id);
  if (index >= 0) list[index] = { ...list[index], ...row };
  else list.push(row);
  return list.find(candidate => candidate.id === row.id)!;
};

const drop = (list: Row[], rowId: string) => {
  const index = list.findIndex(candidate => candidate.id === rowId);
  if (index >= 0) list.splice(index, 1);
};

const characterName = (characterId: string | null) =>
  store.characters.find(character => character.id === characterId)?.name ?? null;

const nodeLabel = (nodeId: string | null) =>
  store.nodes.find(node => node.id === nodeId)?.label ??
  store.notes.find(note => note.id === nodeId)?.label ??
  null;

const characterState = (characterId: string, chapterId: string): Row =>
  store.chapterStates[`${characterId}|${chapterId}`] ?? {
    character_id: characterId,
    chapter_id: chapterId,
    chapter_seq:
      store.nodes.find(node => node.id === chapterId)?.chapter_seq ?? null,
    level: null,
    level_record_id: null,
    level_is_penalty: false,
    skills: [],
  };

// ---- progression, derived the way the database derives it --------------
//
// A character's level is not an author's field: it is the income rows added up and
// run through the rule's curve, and every crossing writes a level whose stat gains
// the rule describes. The desktop build does that in one transaction inside the
// database. The harness used to skip it, which made the preview lie: an author
// added a chapter's XP and watched nothing level. These helpers repeat the same
// arithmetic from the app's own growth rules, so a click here answers like a click
// in the app.

const chapterSeqOf = (chapterId: string | null) =>
  store.nodes.find(node => node.id === chapterId)?.chapter_seq ?? null;

const ruleFor = (characterId: string) =>
  store.growthRules.find(rule => rule.character_id === characterId) ??
  store.growthRules.find(rule => rule.character_id === null) ??
  null;

// A chapter an income row names, checked the way the database checks it: the row
// has to point at a chapter card that is on the board. Without this a stale id
// quietly becomes income nobody can name, which the sheet can only report as a
// chapter that is not there.
const chapterOrThrow = (chapterId: string | null) => {
  const chapter = store.nodes.find(node => node.id === chapterId);

  if (!chapter || chapter.node_type !== 'chapter') {
    throw new Error('a chapter on the board is required');
  }

  return chapter;
};

// The kinds of event a chapter card can log, in the order the database allows.
const CHAPTER_EVENT_TYPES = [
  'xp_award',
  'skill_learn',
  'skill_rank_up',
  'skill_evolve',
  'skill_sacrifice',
  'item_acquire',
];

// One stat a level raises, added to the sheet: the row is created at the gained
// value when the sheet has none, which is what the database's post does.
const gainStat = (characterId: string, statName: string, amount: number, timestamp: string) => {
  const gain = Number(amount) || 0;
  const existing = store.stats.find(
    row => row.character_id === characterId && row.stat_name === statName
  );

  if (existing) {
    existing.value = (Number(existing.value) || 0) + gain;
    existing.updated_at = timestamp;
    return existing.value;
  }

  const row: Row = {
    id: id('stat'),
    character_id: characterId,
    stat_name: statName,
    value: gain,
    notes: null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  store.stats.push(row);
  return row.value;
};

const reverseStat = (characterId: string, statName: string, amount: number) => {
  const stat = store.stats.find(
    row => row.character_id === characterId && row.stat_name === statName
  );

  if (stat) {
    stat.value = (Number(stat.value) || 0) - (Number(amount) || 0);
    stat.updated_at = now();
  }
};

// Brings one character's level, total and target back in step with their income,
// posting the levels the income crossed and taking back the ones it no longer pays
// for. Rows written by hand are the floor: an author's level stands for itself.
function deriveProgression(characterId: string) {
  const character = store.characters.find(row => row.id === characterId);
  if (!character) return;

  const income = store.progress
    .filter(row => row.character_id === characterId)
    .sort(
      (a, b) =>
        (chapterSeqOf(a.chapter_id) ?? Number.MAX_SAFE_INTEGER) -
          (chapterSeqOf(b.chapter_id) ?? Number.MAX_SAFE_INTEGER) ||
        String(a.created_at).localeCompare(String(b.created_at)) ||
        String(a.id).localeCompare(String(b.id))
    );

  const total = income.reduce((sum, row) => sum + row.xp_earned, 0);
  const rule = ruleFor(characterId);
  const base = rule?.xp_base ?? 100;
  const growth = rule?.xp_growth ?? 0;
  // The floor is the highest level nobody's curve wrote: a row from the fixture or
  // one the author added by hand. The rows the curve posted are the curve's to take
  // back when the income goes away, so they are not counted here.
  const recorded = store.levels
    .filter(row => row.character_id === characterId && row.source !== 'level')
    .reduce((highest, row) => Math.max(highest, row.level), 1);
  const level = Math.max(levelForXp(base, growth, total), recorded);

  // Income that has gone away takes the levels it paid for with it, and their
  // gains come back off the sheet — only the rows the curve wrote, never an
  // author's own.
  for (const row of store.levels.filter(
    entry => entry.character_id === characterId && entry.source === 'level' && entry.level > level
  )) {
    for (const change of row.stat_changes ?? []) {
      if (change.amount != null) reverseStat(characterId, change.stat_name, change.amount);
    }

    // A skill event that named the level keeps its place in the story; the level
    // it pointed at is gone, so the link goes with it.
    store.skillEvents.forEach(event => {
      if (event.level_record_id === row.id) event.level_record_id = null;
    });

    drop(store.levels, row.id);
  }

  // Each rung is filed under the chapter whose income carried the total over its
  // step, so the timeline says where the level landed rather than when it was typed.
  const taken = new Set(
    store.levels
      .filter(row => row.character_id === characterId)
      .map(row => row.level as number)
  );

  let running = 0;

  for (const entry of income) {
    running += entry.xp_earned;

    for (let rung = recorded + 1; rung <= level; rung += 1) {
      if (taken.has(rung)) continue;
      if (running < levelXpThreshold(base, growth, rung)) continue;

      const timestamp = now();
      // A rate of zero is not a gain: the database skips it rather than filing a
      // change that moves nothing, and creating a stat at zero would put a row on
      // the sheet the author never asked for.
      const statChanges = (rule?.stats ?? [])
        .filter((rate: Row) => Number(rate.per_level) !== 0)
        .map((rate: Row) => {
          const valueAfter = gainStat(characterId, rate.stat_name, rate.per_level, timestamp);

          return {
            id: id('change'),
            level_record_id: null,
            stat_name: rate.stat_name,
            amount: rate.per_level,
            value_after: valueAfter,
            created_at: timestamp,
            updated_at: timestamp,
          };
        });

      const row: Row = {
        id: id('level'),
        character_id: characterId,
        level: rung,
        chapter_id: entry.chapter_id,
        is_debuff: false,
        xp: levelXpThreshold(base, growth, rung),
        stat_changes: statChanges,
        source: 'level',
        created_at: timestamp,
        updated_at: timestamp,
      };

      statChanges.forEach((change: Row) => {
        change.level_record_id = row.id;
      });

      store.levels.push(row);
      taken.add(rung);
    }
  }

  character.xp = total;
  character.level = level;
  character.xp_to_next = level >= 999 ? null : levelXpThreshold(base, growth, level + 1);
  character.updated_at = now();
}

// ---- who is in a chapter, and what they were then -----------------------
//
// A chapter card's cast is not a list the author types: the database works it
// out from two places — the chapter's point of view and the rows ticked under
// “Present in this chapter” — and dates each person at that chapter. The harness
// used to answer from the fixture's snapshot, so the preview never drew a badge
// for a chapter or a cast member the author had just added. Deriving here means
// naming a POV or ticking somebody present draws the same badge the desktop
// build draws; a chapter card has no single linked cast member to fall back on.

const chaptersInReadingOrder = () =>
  store.nodes
    .filter(node => node.node_type === 'chapter')
    .sort(
      (a, b) =>
        (a.chapter_seq ?? Number.MAX_SAFE_INTEGER) -
          (b.chapter_seq ?? Number.MAX_SAFE_INTEGER) ||
        String(a.created_at).localeCompare(String(b.created_at)) ||
        String(a.id).localeCompare(String(b.id))
    );

type ChapterState = {
  level: number | null;
  levelIsPenalty: boolean;
  skills: Row[];
};

// A character as the story had them at a chapter: the income paid by then run
// through their rule's curve, a level somebody recorded as the floor, and the
// skills learned — and not since sacrificed — up to the same chapter.
const stateAtChapter = (characterId: string, chapterId: string): ChapterState => {
  const chapter = store.nodes.find(node => node.id === chapterId);

  if (!chapter || chapter.node_type !== 'chapter') throw new Error('no such chapter');

  const sequence = chapter.chapter_seq as number | null;

  if (sequence == null) {
    throw new Error(
      'a chapter needs a place in the reading order before its state can be read'
    );
  }

  const earned = store.progress
    .filter(
      row =>
        row.character_id === characterId &&
        (chapterSeqOf(row.chapter_id) ?? Number.MAX_SAFE_INTEGER) <= sequence
    )
    .reduce((sum, row) => sum + Number(row.xp_earned ?? 0), 0);

  const rule = ruleFor(characterId);
  const curve = levelForXp(rule?.xp_base ?? 100, rule?.xp_growth ?? 0, earned);

  const recorded = store.levels
    .filter(
      row =>
        row.character_id === characterId &&
        (chapterSeqOf(row.chapter_id) ?? Number.MAX_SAFE_INTEGER) <= sequence
    )
    .sort(
      (a, b) =>
        Number(b.level) - Number(a.level) ||
        (chapterSeqOf(b.chapter_id) ?? 0) - (chapterSeqOf(a.chapter_id) ?? 0) ||
        String(b.created_at).localeCompare(String(a.created_at))
    )[0];

  // Nothing earned and nothing recorded is a character the story has not placed
  // yet, rather than a level 1 the card would be claiming.
  const level = recorded
    ? Math.max(curve, Number(recorded.level))
    : earned === 0
      ? null
      : curve;

  const skills = store.skills
    .filter(row => row.character_id === characterId)
    .map(row => ({ row, learned: chapterSeqOf(row.chapter_id) }))
    .filter(
      (entry): entry is { row: Row; learned: number } =>
        entry.learned != null && entry.learned <= sequence
    )
    .sort(
      (a, b) =>
        a.learned - b.learned ||
        String(a.row.created_at).localeCompare(String(b.row.created_at))
    )
    .flatMap(({ row, learned }) => {
      const events = store.skillEvents
        .filter(event => event.skill_id === row.id)
        .map(event => ({ event, seq: chapterSeqOf(event.chapter_id) }))
        .filter(
          entry =>
            entry.seq != null && entry.seq >= learned && entry.seq <= sequence
        )
        .sort(
          (a, b) =>
            (a.seq ?? 0) - (b.seq ?? 0) ||
            String(a.event.created_at).localeCompare(String(b.event.created_at))
        );

      // A sacrifice removes the skill; a later use is a warning, not a revival.
      if (events.some(entry => entry.event.kind === 'sacrificed')) return [];

      const rank =
        [...events]
          .reverse()
          .find(
            entry =>
              (entry.event.kind === 'upgraded' || entry.event.kind === 'used') &&
              entry.event.rank != null &&
              String(entry.event.rank).trim() !== ''
          )?.event.rank ??
        row.rank ??
        null;

      return [
        {
          skill_id: row.id,
          name: row.name,
          rank,
          effect: row.effect ?? null,
          learned_chapter_id: row.chapter_id,
          learned_chapter_seq: learned,
        },
      ];
    });

  return {
    level,
    // Only the row that records the level the character actually reached can
    // say the level was a penalty.
    levelIsPenalty: Boolean(
      recorded && recorded.is_debuff && Number(recorded.level) === level
    ),
    skills,
  };
};

const chapterCastStates = () => {
  const chapters = chaptersInReadingOrder();
  const chapterIds = new Set(chapters.map(node => node.id));
  const live = new Set(store.characters.map(row => row.id));
  const assignments: { chapterId: string; characterId: string }[] = [];
  const seen = new Set<string>();

  const assign = (chapterId: string | null, characterId: string | null) => {
    if (!chapterId || !characterId) return;
    if (!chapterIds.has(chapterId) || !live.has(characterId)) return;

    const key = `${chapterId}|${characterId}`;
    if (seen.has(key)) return;

    seen.add(key);
    assignments.push({ chapterId, characterId });
  };

  // A chapter's roster is its point of view and its cast rows, exactly as the
  // database works it out. The card's own character_id is not a third source:
  // nothing in the app writes one on a chapter any more.
  chapters.forEach(node => assign(node.id, node.chapter_pov ?? null));

  store.chapterCast.forEach(row =>
    assign(row.chapter_id ?? null, row.character_id ?? null)
  );

  return assignments.flatMap(({ chapterId, characterId }) => {
    try {
      const state = stateAtChapter(characterId, chapterId);

      return [
        {
          chapter_id: chapterId,
          character_id: characterId,
          level: state.level,
          level_is_penalty: state.levelIsPenalty,
          skills: state.skills,
        },
      ];
    } catch {
      // A chapter with no place in the reading order has no snapshot, and the
      // database leaves it out too rather than failing the whole board.
      return [];
    }
  });
};

const auditEntry = (args: Row, action: string, detail: string, entityType = 'history') =>
  ({
    id: id('audit'),
    story_id: args.storyId ?? store.storyId,
    entity_type: entityType,
    entity_id: args.storyId ?? store.storyId,
    action,
    field_changed: null,
    old_value: null,
    new_value: detail,
    changed_by: args.user ?? 'Ada',
    changed_at: now(),
  }) as Row;

// ---- the reads the app loads a story with -------------------------------

const reads: Record<string, (args: Row) => unknown> = {
  initialize_database: () => '/screenshot-harness/storyboard.db',
  list_backups: () => [],
  get_all_stories: () => store.stories.filter(row => !row.deleted_at),

  get_graph_nodes: () => store.nodes,
  get_graph_edges: () => store.edges,
  get_characters: () => store.characters,

  get_story_character_stats: () => store.stats,
  get_character_stats: args => store.stats.filter(row => row.character_id === args.characterId),

  get_story_skills: () => store.skills,
  get_character_skills: args => store.skills.filter(row => row.character_id === args.characterId),
  get_story_skill_events: () => store.skillEvents,
  get_story_skill_evolutions: () => store.evolutions,

  get_story_levels: () => store.levels,
  get_story_character_progress: () => store.progress,
  get_story_growth_points: () => store.growthPoints,
  get_story_character_awards: () => store.awards,
  // The rule the sheet reads its tally and its level against, so the gallery
  // shows the points a level hands out rather than "Not set".
  get_story_level_growth_rules: () => store.growthRules,
  get_character_state_at_chapter: args =>
    characterState(args.characterId, args.chapterId),

  get_story_inventory: () => store.inventory,
  get_character_inventory: args =>
    store.inventory.filter(row => row.character_id === args.characterId),
  get_character_currency: args => store.currency[args.characterId] ?? [],
  get_character_attributes: args => store.attributes[args.characterId] ?? [],

  get_chapter_notes: () => store.notes,
  get_story_chapter_cast: () => store.chapterCast,
  get_story_chapter_cast_states: () => chapterCastStates(),
  get_story_chapter_tasks: () => store.tasks,
  get_story_chapter_events: () => store.chapterEvents,

  get_story_relations: () => store.relations,
  get_story_faction_standings: () => store.standings,

  get_story_quests: args =>
    args.status
      ? store.quests.filter(
          quest => String(quest.status).toLowerCase() === String(args.status).toLowerCase()
        )
      : store.quests,

  get_audit_history: args => {
    const filtered = store.audit.filter(
      entry =>
        (!args.storyId || entry.story_id === args.storyId) &&
        (!args.entityType || entry.entity_type === args.entityType) &&
        (!args.entityId || entry.entity_id === args.entityId)
    );
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 100);

    return { entries: filtered.slice(offset, offset + limit), total: filtered.length };
  },

  // With a story named, its own deleted rows; with none, the deleted stories,
  // which is the two ways the one command is read.
  get_trash: args =>
    args.storyId
      ? store.trash.filter(row => row.story_id === args.storyId)
      : store.trashStories,
  get_trash_retention: () => store.trashRetention,

  export_story_json: () => '/screenshot-harness/story.json',
  export_story_markdown: () => '/screenshot-harness/story.md',
  story_bible_markdown: () => `# ${story.title}\n\nPrepared for the guide.\n`,
  list_backups_alias: () => [],
};

// ---- the writes the UI can reach while a screenshot is being taken ------

const writes: Record<string, (args: Row) => unknown> = {
  set_node_character: args => {
    const node = store.nodes.find(row => row.id === args.nodeId);
    if (!node) throw new Error('no such card');
    // A chapter's people are its point of view and its cast rows; the database
    // refuses this link, so the harness must too.
    if (node.node_type === 'chapter' && args.characterId) {
      throw new Error('a chapter takes its cast, not a linked character');
    }
    node.character_id = args.characterId ?? null;
    node.updated_at = now();
    return node;
  },

  create_graph_node: args => {
    const timestamp = now();
    const row: Row = {
      id: id('node'),
      story_id: args.storyId,
      node_type: args.nodeType,
      label: args.label,
      content: args.content ?? null,
      pos_x: args.posX ?? 0,
      pos_y: args.posY ?? 0,
      created_by: args.createdBy ?? 'Ada',
      created_at: timestamp,
      updated_at: timestamp,
      character_id: args.characterId ?? null,
      chapter_seq:
        args.nodeType === 'chapter'
          ? store.nodes.filter(node => node.node_type === 'chapter').length + 1
          : null,
      chapter_arc: null,
      chapter_words: null,
      chapter_target: null,
      chapter_pov: null,
      chapter_day: null,
      chapter_time: null,
      parent_node_id: null,
    };

    store.nodes.push(row);
    return row;
  },

  update_graph_node: args => {
    const node = store.nodes.find(row => row.id === args.id);
    if (!node) throw new Error('no such card');
    node.label = args.label;
    node.content = args.content ?? null;
    node.updated_at = now();

    // A skill card is the shared name for every holder, exactly as the database
    // keeps it.
    if (node.node_type === 'skill') {
      store.skills
        .filter(skill => skill.node_id === node.id)
        .forEach(skill => {
          skill.name = node.label;
          skill.effect = node.content;
        });
    }

    return node;
  },

  update_graph_node_position: args => {
    const node = store.nodes.find(row => row.id === args.id);
    if (node) {
      node.pos_x = args.posX;
      node.pos_y = args.posY;
    }
    return null;
  },

  create_graph_edge: args => {
    const row: Row = {
      id: id('edge'),
      story_id: args.storyId,
      source_id: args.sourceId,
      target_id: args.targetId,
      label: args.label ?? null,
      relation_type: args.relationType ?? null,
      created_by: args.createdBy ?? 'Ada',
      created_at: now(),
    };

    store.edges.push(row);
    return row;
  },

  update_graph_edge: args => {
    const edge = store.edges.find(row => row.id === args.id);
    if (!edge) throw new Error('no such connection');
    edge.label = args.label ?? null;
    edge.relation_type = args.relationType ?? null;
    return edge;
  },

  delete_node: args => {
    const node = store.nodes.find(row => row.id === args.id);
    if (node) {
      store.trash.push({
        id: node.id,
        kind: 'node',
        label: node.label,
        story_id: node.story_id,
        deleted_at: now(),
      });
      drop(store.nodes, node.id);
    }
    drop(store.notes, args.id);
    return null;
  },

  delete_edge: args => {
    const edge = store.edges.find(row => row.id === args.id);
    if (edge) {
      store.trash.push({
        id: edge.id,
        kind: 'edge',
        label: `${nodeLabel(edge.source_id) ?? '?'} → ${nodeLabel(edge.target_id) ?? '?'}`,
        story_id: edge.story_id,
        deleted_at: now(),
      });
      drop(store.edges, edge.id);
    }
    return null;
  },

  restore_deleted: args => {
    drop(store.trash, args.id);
    drop(store.trashStories, args.id);
    return null;
  },

  purge_deleted: args => {
    drop(store.trash, args.id);
    drop(store.trashStories, args.id);
    return null;
  },

  set_trash_retention: args => {
    store.trashRetention = args.days ?? null;
    return 0;
  },

  set_chapter_details: args => {
    const node = store.nodes.find(row => row.id === args.nodeId);
    if (!node) throw new Error('no such chapter');
    Object.assign(node, {
      chapter_arc: args.arc ?? null,
      chapter_words: args.words ?? null,
      chapter_target: args.target ?? null,
      chapter_pov: args.pov ?? null,
      chapter_day: args.day ?? null,
      chapter_time: args.time ?? null,
      updated_at: now(),
    });
    return node;
  },

  set_chapter_order: args => {
    (args.orderedIds as string[]).forEach((nodeId, index) => {
      const node = store.nodes.find(row => row.id === nodeId);
      if (node) node.chapter_seq = index + 1;
    });
    return store.nodes.filter(node => node.node_type === 'chapter');
  },

  add_chapter_note: args => {
    const timestamp = now();
    const text = String(args.text);
    const row: Row = {
      id: id('note'),
      story_id: store.storyId,
      node_type: 'note',
      label: text.length > 60 ? `${text.slice(0, 60)}…` : text,
      content: text,
      pos_x: 0,
      pos_y: 0,
      created_by: args.user ?? 'Ada',
      created_at: timestamp,
      updated_at: timestamp,
      character_id: null,
      chapter_seq: null,
      chapter_arc: null,
      chapter_words: null,
      chapter_target: null,
      chapter_pov: null,
      chapter_day: null,
      chapter_time: null,
      parent_node_id: args.chapterId,
    };

    store.notes.push(row);
    return row;
  },

  update_chapter_note: args => {
    const note = store.notes.find(row => row.id === args.id);
    if (!note) throw new Error('no such note');
    note.content = args.text;
    note.label = String(args.text).slice(0, 60);
    note.updated_at = now();
    return note;
  },

  add_chapter_cast_member: args => {
    chapterOrThrow(args.chapterId);

    // Ticking somebody on twice is not a change: the scene already has them,
    // and the database hands back the row it kept.
    const existing = store.chapterCast.find(
      row =>
        row.chapter_id === args.chapterId && row.character_id === args.characterId
    );

    if (existing) return existing;

    const timestamp = now();
    const row: Row = {
      id: id('cast'),
      chapter_id: args.chapterId,
      character_id: args.characterId,
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.chapterCast.push(row);
    return row;
  },

  remove_chapter_cast_member: args => {
    drop(store.chapterCast, args.id);
    return null;
  },

  add_chapter_task: args => {
    chapterOrThrow(args.chapterId);

    const text = String(args.text ?? '').trim();
    if (!text) throw new Error('an objective needs a line of text');

    const timestamp = now();
    const position = store.tasks
      .filter(row => row.chapter_id === args.chapterId)
      .reduce((next, row) => Math.max(next, Number(row.position) + 1), 0);
    const row: Row = {
      id: id('task'),
      chapter_id: args.chapterId,
      text,
      done: false,
      position,
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.tasks.push(row);
    return row;
  },

  set_chapter_task_done: args => {
    const task = store.tasks.find(row => row.id === args.id);
    if (!task) throw new Error('no such objective');

    task.done = Boolean(args.done);
    task.updated_at = now();
    return task;
  },

  delete_chapter_task: args => {
    drop(store.tasks, args.id);
    return null;
  },

  // The scene's progression ledger. XP, a learned skill and an acquired item
  // write the row they stand for through the same in-memory helpers the sheets
  // use; a rank-up, an evolution and a sacrifice are the scene's own record.
  add_chapter_event: args => {
    const eventType = String(args.eventType);
    let details = String(args.details ?? '').trim();
    let amount = args.amount == null ? null : Number(args.amount);

    if (!CHAPTER_EVENT_TYPES.includes(eventType)) {
      throw new Error('that is not a chapter event');
    }

    chapterOrThrow(args.chapterId);

    if (!store.characters.some(row => row.id === args.actorId)) {
      throw new Error('an event names someone in the story');
    }

    if (eventType === 'xp_award' && (!amount || amount <= 0)) {
      throw new Error('an XP award is a whole number above zero');
    }

    if (eventType === 'item_acquire') {
      amount = amount ?? 1;
      if (amount < 1) throw new Error('an acquired item is at least one');
    }

    if (eventType !== 'xp_award' && eventType !== 'item_acquire' && !details) {
      throw new Error('an event needs a detail line');
    }

    const timestamp = now();
    let sourceId: string | null = null;

    if (eventType === 'xp_award') {
      const award = writes.add_character_award({
        characterId: args.actorId,
        chapterId: args.chapterId,
        kind: 'xp',
        amount,
        note: details || null,
        user: args.user,
      }) as Row;
      sourceId = String(award.id);
    } else if (eventType === 'skill_learn') {
      const skill = writes.add_skill({
        characterId: args.actorId,
        name: details,
        chapterId: args.chapterId,
        user: args.user,
      }) as Row;
      sourceId = String(skill.id);
    } else if (eventType === 'item_acquire') {
      const item = writes.add_inventory_item({
        characterId: args.actorId,
        name: details,
        quantity: amount,
        chapterId: args.chapterId,
        user: args.user,
      }) as Row;
      sourceId = String(item.id);
    }

    const position = store.chapterEvents
      .filter(row => row.chapter_id === args.chapterId)
      .reduce((next, row) => Math.max(next, Number(row.position) + 1), 0);
    const row: Row = {
      id: id('chapter-event'),
      chapter_id: args.chapterId,
      actor_id: args.actorId,
      event_type: eventType,
      details,
      amount,
      source_id: sourceId,
      position,
      created_by: args.user ?? 'Ada',
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.chapterEvents.push(row);
    return row;
  },

  delete_chapter_event: args => {
    const event = store.chapterEvents.find(row => row.id === args.id);
    if (!event) return null;

    if (event.source_id) {
      if (event.event_type === 'xp_award') {
        writes.delete_character_award({ id: event.source_id, user: args.user });
      } else if (event.event_type === 'skill_learn') {
        writes.delete_skill({ id: event.source_id });
      } else if (event.event_type === 'item_acquire') {
        writes.delete_inventory_item({ id: event.source_id });
      }
    }

    drop(store.chapterEvents, args.id);
    return null;
  },

  add_skill: args => {
    const timestamp = now();
    const row: Row = {
      id: id('skill'),
      character_id: args.characterId,
      name: args.name,
      rank: args.rank ?? null,
      effect: args.effect ?? null,
      chapter_id: args.chapterId ?? null,
      node_id: args.nodeId ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.skills.push(row);
    return row;
  },

  update_skill: args => {
    const skill = store.skills.find(row => row.id === args.id);
    if (!skill) throw new Error('no such skill');
    Object.assign(skill, {
      name: args.name,
      rank: args.rank ?? null,
      effect: args.effect ?? null,
      chapter_id: args.chapterId ?? null,
      node_id: args.nodeId ?? null,
      updated_at: now(),
    });
    return skill;
  },

  delete_skill: args => {
    drop(store.skills, args.id);
    store.skillEvents = store.skillEvents.filter(row => row.skill_id !== args.id);
    store.evolutions = store.evolutions.filter(
      row => row.parent_skill_id !== args.id && row.child_skill_id !== args.id
    );
    return null;
  },

  add_skill_event: args => {
    const timestamp = now();
    const row: Row = {
      id: id('event'),
      skill_id: args.skillId,
      kind: args.kind,
      chapter_id: args.chapterId ?? null,
      rank: args.rank ?? null,
      level_record_id: args.levelRecordId ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.skillEvents.push(row);
    return row;
  },

  update_skill_event: args => {
    const event = store.skillEvents.find(row => row.id === args.id);
    if (!event) throw new Error('no such change');
    Object.assign(event, {
      kind: args.kind,
      chapter_id: args.chapterId ?? null,
      rank: args.rank ?? null,
      level_record_id: args.levelRecordId ?? null,
      updated_at: now(),
    });
    return event;
  },

  delete_skill_event: args => {
    drop(store.skillEvents, args.id);
    return null;
  },

  add_skill_evolution: args => {
    const timestamp = now();
    const row: Row = {
      id: id('evolution'),
      story_id: store.storyId,
      parent_skill_id: args.parentSkillId,
      child_skill_id: args.childSkillId,
      evolution_type: args.evolutionType,
      chapter_id: args.chapterId ?? null,
      required_rank: args.requiredRank ?? null,
      notes: args.notes ?? null,
      created_by: args.user ?? 'Ada',
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.evolutions.push(row);
    return row;
  },

  delete_skill_evolution: args => {
    drop(store.evolutions, args.id);
    return null;
  },

  add_relation: args => {
    const timestamp = now();
    const row: Row = {
      id: id('relation'),
      story_id: store.storyId,
      from_character_id: args.fromCharacterId,
      to_character_id: args.toCharacterId,
      kind: args.kind,
      note: args.note ?? null,
      since_chapter_id: args.sinceChapterId ?? null,
      until_chapter_id: args.untilChapterId ?? null,
      created_by: args.user ?? 'Ada',
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.relations.push(row);
    return row;
  },

  update_relation: args => {
    const relation = store.relations.find(row => row.id === args.id);
    if (!relation) throw new Error('no such relation');
    Object.assign(relation, {
      kind: args.kind,
      note: args.note ?? null,
      since_chapter_id: args.sinceChapterId ?? null,
      until_chapter_id: args.untilChapterId ?? null,
      updated_at: now(),
    });
    return relation;
  },

  delete_relation: args => {
    drop(store.relations, args.id);
    return null;
  },

  add_faction_standing: args => {
    const timestamp = now();
    const row: Row = {
      id: id('standing'),
      story_id: store.storyId,
      character_id: args.characterId,
      faction_node_id: args.factionNodeId ?? null,
      standing: args.standing,
      note: args.note ?? null,
      since_chapter_id: args.sinceChapterId ?? null,
      until_chapter_id: args.untilChapterId ?? null,
      created_by: args.user ?? 'Ada',
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.standings.push(row);
    return row;
  },

  update_faction_standing: args => {
    const standing = store.standings.find(row => row.id === args.id);
    if (!standing) throw new Error('no such standing');
    Object.assign(standing, {
      faction_node_id: args.factionNodeId ?? null,
      standing: args.standing,
      note: args.note ?? null,
      since_chapter_id: args.sinceChapterId ?? null,
      until_chapter_id: args.untilChapterId ?? null,
      updated_at: now(),
    });
    return standing;
  },

  delete_faction_standing: args => {
    drop(store.standings, args.id);
    return null;
  },

  set_character_stat: args => {
    const existing = store.stats.find(
      row => row.character_id === args.characterId && row.stat_name === args.statName
    );
    const timestamp = now();

    if (existing) {
      existing.value = args.value;
      existing.notes = args.notes ?? null;
      existing.updated_at = timestamp;
      return existing;
    }

    const row: Row = {
      id: id('stat'),
      character_id: args.characterId,
      stat_name: args.statName,
      value: args.value,
      notes: args.notes ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.stats.push(row);
    return row;
  },

  set_character_attribute: args => {
    const list = (store.attributes[args.characterId] ??= []);
    const existing = list.find(row => row.attr_name === args.attrName);
    const timestamp = now();

    if (existing) {
      existing.value = args.value;
      existing.updated_at = timestamp;
      return existing;
    }

    const row: Row = {
      id: id('attribute'),
      character_id: args.characterId,
      attr_name: args.attrName,
      value: args.value,
      created_at: timestamp,
      updated_at: timestamp,
    };

    list.push(row);
    return row;
  },

  delete_character_attribute: args => {
    Object.values(store.attributes).forEach(list => drop(list, args.id));
    return null;
  },

  add_inventory_item: args => {
    const timestamp = now();
    const row: Row = {
      id: id('item'),
      character_id: args.characterId,
      name: args.name,
      rarity: args.rarity ?? null,
      quantity: args.quantity ?? 1,
      effect: args.effect ?? null,
      chapter_id: args.chapterId ?? null,
      lost_chapter_id: args.lostChapterId ?? null,
      node_id: args.nodeId ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.inventory.push(row);
    return row;
  },

  update_inventory_item: args => {
    const item = store.inventory.find(row => row.id === args.id);
    if (!item) throw new Error('no such item');
    Object.assign(item, {
      name: args.name,
      rarity: args.rarity ?? null,
      quantity: args.quantity ?? 1,
      effect: args.effect ?? null,
      chapter_id: args.chapterId ?? null,
      lost_chapter_id: args.lostChapterId ?? null,
      node_id: args.nodeId ?? null,
      updated_at: now(),
    });
    return item;
  },

  delete_inventory_item: args => {
    drop(store.inventory, args.id);
    return null;
  },

  add_currency: args => {
    const list = (store.currency[args.characterId] ??= []);
    const timestamp = now();
    const row: Row = {
      id: id('currency'),
      character_id: args.characterId,
      name: args.name,
      amount: args.amount,
      created_at: timestamp,
      updated_at: timestamp,
    };

    list.push(row);
    return row;
  },

  update_currency: args => {
    Object.values(store.currency)
      .flat()
      .forEach(row => {
        if (row.id === args.id) {
          row.name = args.name;
          row.amount = args.amount;
          row.updated_at = now();
        }
      });
    return Object.values(store.currency)
      .flat()
      .find(row => row.id === args.id);
  },

  delete_currency: args => {
    Object.values(store.currency).forEach(list => drop(list, args.id));
    return null;
  },

  add_character_progress: args => {
    chapterOrThrow(args.chapterId);

    // One amount per character per chapter, as the database insists: a second entry
    // for the same chapter is refused rather than quietly doubling the income.
    if (
      store.progress.some(
        row => row.character_id === args.characterId && row.chapter_id === args.chapterId
      )
    ) {
      throw new Error('that chapter already has XP recorded for this character');
    }

    const timestamp = now();
    const row: Row = {
      id: id('progress'),
      character_id: args.characterId,
      chapter_id: args.chapterId,
      xp_earned: args.xpEarned,
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.progress.push(row);
    deriveProgression(args.characterId);
    return row;
  },

  update_character_progress: args => {
    const row = store.progress.find(candidate => candidate.id === args.id);
    if (!row) throw new Error('no such income');
    chapterOrThrow(args.chapterId);
    row.chapter_id = args.chapterId;
    row.xp_earned = args.xpEarned;
    row.updated_at = now();
    deriveProgression(row.character_id);
    return row;
  },

  delete_character_progress: args => {
    const row = store.progress.find(candidate => candidate.id === args.id);
    drop(store.progress, args.id);
    if (row) deriveProgression(row.character_id);
    return null;
  },

  // An award is a gain that skips the level-up: XP lands on the chapter's income,
  // a stat point lands on the sheet, and the roll records what was handed over.
  // The database applies both in the transaction that writes the award, so the
  // sheet follows the same click here.
  add_character_award: args => {
    const amount = Number(args.amount) || 0;

    if (amount === 0) throw new Error('an award is a whole number other than zero');

    const timestamp = now();

    if (args.kind === 'xp') {
      if (!args.chapterId) throw new Error('XP awarded belongs to a chapter');
      chapterOrThrow(args.chapterId);

      const entry = store.progress.find(
        row => row.character_id === args.characterId && row.chapter_id === args.chapterId
      );

      if (entry) {
        entry.xp_earned += amount;
        entry.updated_at = timestamp;
      } else {
        store.progress.push({
          id: id('progress'),
          character_id: args.characterId,
          chapter_id: args.chapterId,
          xp_earned: amount,
          created_at: timestamp,
          updated_at: timestamp,
        });
      }
    } else {
      if (!args.statName) throw new Error('a stat award needs a stat');
      gainStat(args.characterId, args.statName, amount, timestamp);
    }

    const row: Row = {
      id: id('award'),
      character_id: args.characterId,
      chapter_id: args.chapterId ?? null,
      kind: args.kind,
      stat_name: args.kind === 'stat' ? args.statName : null,
      amount,
      note: args.note ?? null,
      created_by: args.user ?? 'Ada',
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.awards.push(row);
    deriveProgression(args.characterId);
    return row;
  },

  delete_character_award: args => {
    const award = store.awards.find(row => row.id === args.id);
    if (!award) return null;

    if (award.kind === 'stat') {
      if (award.stat_name) reverseStat(award.character_id, award.stat_name, award.amount);
    } else if (award.chapter_id) {
      const entry = store.progress.find(
        row => row.character_id === award.character_id && row.chapter_id === award.chapter_id
      );

      if (entry) {
        // A row the award emptied has nothing left to say about the chapter.
        if (entry.xp_earned - award.amount <= 0) drop(store.progress, entry.id);
        else {
          entry.xp_earned -= award.amount;
          entry.updated_at = now();
        }
      }
    }

    drop(store.awards, args.id);
    deriveProgression(award.character_id);
    return null;
  },

  add_character_level: args => {
    const timestamp = now();
    const row: Row = {
      id: id('level'),
      character_id: args.characterId,
      level: args.level,
      chapter_id: args.chapterId ?? null,
      is_debuff: Boolean(args.isDebuff),
      xp: args.xp ?? null,
      stat_changes: (args.statChanges ?? []).map((change: Row) => ({
        id: id('change'),
        level_record_id: null,
        stat_name: change.stat_name,
        amount: change.amount ?? null,
        value_after: change.value_after ?? null,
        created_at: timestamp,
        updated_at: timestamp,
      })),
      source: 'recorded',
      created_at: timestamp,
      updated_at: timestamp,
    };

    row.stat_changes.forEach((change: Row) => {
      change.level_record_id = row.id;
    });

    store.levels.push(row);
    return row;
  },

  update_character_level: args => {
    const row = store.levels.find(candidate => candidate.id === args.id);
    if (!row) throw new Error('no such level');
    row.level = args.level;
    row.chapter_id = args.chapterId ?? null;
    row.is_debuff = Boolean(args.isDebuff);
    row.xp = args.xp ?? null;
    row.stat_changes = (args.statChanges ?? []).map((change: Row) => ({
      id: id('change'),
      level_record_id: row.id,
      stat_name: change.stat_name,
      amount: change.amount ?? null,
      value_after: change.value_after ?? null,
      created_at: now(),
      updated_at: now(),
    }));
    row.updated_at = now();
    return row;
  },

  delete_character_level: args => {
    drop(store.levels, args.id);
    return null;
  },

  // Placing a growth point raises the stat and records the placement, the way
  // the database does both in one transaction. The pool is not checked here: the
  // harness only has to show the sheet reacting to the click.
  spend_growth_point: (args: Row) => {
    const timestamp = now();
    const existing = store.stats.find(
      row => row.character_id === args.characterId && row.stat_name === args.statName
    );

    const stat = existing ?? {
      id: id('stat'),
      character_id: args.characterId,
      stat_name: args.statName,
      value: 0,
      notes: null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    stat.value += args.amount;
    stat.updated_at = timestamp;

    if (!existing) store.stats.push(stat);

    const point: Row = {
      id: id('growth'),
      character_id: args.characterId,
      stat_name: args.statName,
      amount: args.amount,
      note: args.note ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.growthPoints.push(point);

    return { point, stat };
  },

  delete_growth_point: args => {
    const point = store.growthPoints.find(row => row.id === args.id);
    if (!point) return null;

    const stat = store.stats.find(
      row =>
        row.character_id === point.character_id && row.stat_name === point.stat_name
    );

    if (stat) {
      stat.value -= point.amount;
      stat.updated_at = now();
    }

    drop(store.growthPoints, args.id);
    return null;
  },

  // The rule a level follows, written the way the database writes it: one row per
  // scope (the story, or one character), with its rates replaced rather than
  // appended, and the level re-derived afterwards because the cost may have moved
  // everybody in the cast.
  save_level_growth_rule: args => {
    const owner = args.characterId ?? null;
    const timestamp = now();
    const existing = store.growthRules.find(rule => rule.character_id === owner);
    const row: Row = {
      id: existing?.id ?? id('rule'),
      story_id: args.storyId ?? store.storyId,
      character_id: owner,
      points_per_level: args.pointsPerLevel,
      xp_base: args.xpBase,
      xp_growth: args.xpGrowth,
      stats: (args.stats ?? []).map((rate: Row) => ({
        id: id('rate'),
        rule_id: existing?.id ?? 'rule',
        stat_name: rate.stat_name,
        per_level: rate.per_level,
        created_at: timestamp,
        updated_at: timestamp,
      })),
      created_by: args.user ?? 'Ada',
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
    };

    if (existing) Object.assign(existing, row);
    else store.growthRules.push(row);

    row.stats.forEach((rate: Row) => {
      rate.rule_id = row.id;
    });

    for (const character of store.characters) {
      deriveProgression(character.id);
    }

    return store.growthRules.find(rule => rule.id === row.id)!;
  },

  delete_level_growth_rule: args => {
    drop(store.growthRules, args.id);
    for (const character of store.characters) {
      deriveProgression(character.id);
    }
    return null;
  },

  // Only the rank is typed now. The level and the total the gallery shows come
  // from the fixture, which is built by the demo seed itself.
  set_character_progress: args => {
    const character = store.characters.find(row => row.id === args.characterId);
    if (!character) throw new Error('no such cast member');
    Object.assign(character, {
      rank: args.rank ?? null,
      updated_at: now(),
    });
    return character;
  },

  level_up_character: args => {
    const character = store.characters.find(row => row.id === args.characterId);
    if (!character) throw new Error('no such cast member');
    character.level = (character.level ?? 1) + 1;
    character.updated_at = now();
    return character;
  },

  update_character: args => {
    const character = store.characters.find(row => row.id === args.id);
    if (!character) throw new Error('no such cast member');
    character.name = args.name;
    character.description = args.description ?? null;
    character.updated_at = now();
    return character;
  },

  create_new_character: args => {
    const timestamp = now();
    const row: Row = {
      id: id('character'),
      story_id: args.storyId,
      name: args.name,
      description: args.description ?? null,
      level: 1,
      xp: 0,
      rank: null,
      xp_to_next: null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.characters.push(row);
    return row;
  },

  create_new_story: args => {
    const timestamp = now();
    const row: Row = {
      id: id('story'),
      title: args.title,
      description: args.description ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    store.stories.unshift(row);
    return row;
  },

  update_story: args => {
    const row = store.stories.find(storyRow => storyRow.id === args.id);
    if (!row) throw new Error('no such story');
    row.title = args.title;
    row.updated_at = now();
    return row;
  },

  add_quest: args => {
    const timestamp = now();
    const row: Row = {
      id: id('quest'),
      story_id: args.storyId,
      title: args.title,
      giver_character_id: args.giverCharacterId ?? null,
      faction_node_id: args.factionNodeId ?? null,
      accepted_chapter_id: args.acceptedChapterId ?? null,
      completed_chapter_id: args.completedChapterId ?? null,
      status: args.status,
      description: args.description ?? null,
      notes: args.notes ?? null,
      created_by: args.user ?? 'Ada',
      created_at: timestamp,
      updated_at: timestamp,
      rewards: [],
    };

    store.quests.push(row);
    return row;
  },

  update_quest: args => {
    const quest = store.quests.find(row => row.id === args.id);
    if (!quest) throw new Error('no such quest');
    Object.assign(quest, {
      title: args.title,
      giver_character_id: args.giverCharacterId ?? null,
      faction_node_id: args.factionNodeId ?? null,
      accepted_chapter_id: args.acceptedChapterId ?? null,
      completed_chapter_id: args.completedChapterId ?? null,
      status: args.status,
      description: args.description ?? null,
      notes: args.notes ?? null,
      updated_at: now(),
    });
    return quest;
  },

  delete_quest: args => {
    drop(store.quests, args.id);
    return null;
  },

  add_quest_reward: args => {
    const quest = store.quests.find(row => row.id === args.questId);
    if (!quest) throw new Error('no such quest');
    const timestamp = now();
    const row: Row = {
      id: id('reward'),
      quest_id: quest.id,
      reward_type: args.rewardType,
      target_id: args.targetId ?? null,
      amount_or_details: args.amountOrDetails ?? null,
      applied_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    (quest.rewards ??= []).push(row);
    return row;
  },

  update_quest_reward: args => {
    for (const quest of store.quests) {
      const reward = (quest.rewards ?? []).find(row => row.id === args.id);
      if (reward) {
        Object.assign(reward, {
          reward_type: args.rewardType,
          target_id: args.targetId ?? null,
          amount_or_details: args.amountOrDetails ?? null,
          updated_at: now(),
        });
        return reward;
      }
    }
    throw new Error('no such reward');
  },

  delete_quest_reward: args => {
    store.quests.forEach(quest => {
      quest.rewards = (quest.rewards ?? []).filter(row => row.id !== args.id);
    });
    return null;
  },

  mark_quest_rewards_applied: args => {
    const ids: string[] = args.ids ?? [];
    const stamp = now();
    store.quests.forEach(quest => {
      (quest.rewards ?? []).forEach(reward => {
        if (ids.includes(reward.id)) reward.applied_at = stamp;
      });
    });
    return null;
  },

  record_history_event: args => {
    store.audit.unshift(auditEntry(args, args.action, args.detail ?? ''));
    return null;
  },

  // Nothing in the harness is put back: the audit tab is shown, not driven.
  revert_change: () => false,
};

export async function invoke(command: string, args: Row = {}): Promise<unknown> {
  const handler = reads[command] ?? writes[command];

  if (!handler) {
    console.warn(`[harness] ${command} is not implemented; the UI got null`);
    return null;
  }

  // The app renders a spinner while a command is in flight and the screenshots
  // are taken of the settled screen, so the write is exposed as a promise.
  const result = handler(args ?? {});

  // A real command crosses the IPC bridge, so what the app receives is a copy of
  // what the database serialised: no row can be mutated behind React's back, and a
  // memo keyed on the answer sees a new value every time. Handing back the store's
  // own arrays instead made a level the write had just added invisible to a memo
  // that had already run, which is exactly the kind of lie this harness exists not
  // to tell.
  return result === null || result === undefined ? result : clone(result);
}

// A short label for the harness itself, so a capture can say which story it is.
export const harnessStory = { id: story.id, title: story.title, cast: characterName };
export const harnessNodeLabel = nodeLabel;
export { store };
