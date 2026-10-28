// The fake Tauri backend the screenshot harness drives the real app against.
//
// Every read is served from `fixture.json`, which the Rust example beside this
// file wrote out of the real database, so the shapes here are the shapes the
// desktop build sends. Writes are kept in memory for the length of the page:
// enough for the UI to react to a click the way it does in the app, and no
// more. A command that is not implemented says so in the console rather than
// failing silently.

import fixture from './fixture.json';

type Row = Record<string, any>;

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const story = clone(fixture.story) as Row;

const store = {
  storyId: fixture.storyId as string,
  stories: clone(fixture.stories) as Row[],
  nodes: clone(fixture.nodes) as Row[],
  edges: clone(fixture.edges) as Row[],
  characters: clone(fixture.characters) as Row[],
  stats: clone(fixture.story_stats) as Row[],
  skills: clone(fixture.story_skills) as Row[],
  skillEvents: clone(fixture.story_skill_events) as Row[],
  levels: clone(fixture.story_levels) as Row[],
  progress: clone(fixture.story_progress) as Row[],
  inventory: clone(fixture.story_inventory) as Row[],
  notes: clone(fixture.chapter_notes) as Row[],
  chapterCast: clone(fixture.story_chapter_cast) as Row[],
  castStates: clone(fixture.chapter_cast_states) as Row[],
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
};

let counter = 0;
let clock = Date.parse('2026-10-27T20:15:00Z');

const id = (prefix: string) => `${prefix}0000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const now = () => {
  clock += 1000;
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
  get_character_state_at_chapter: args =>
    characterState(args.characterId, args.chapterId),

  get_story_inventory: () => store.inventory,
  get_character_inventory: args =>
    store.inventory.filter(row => row.character_id === args.characterId),
  get_character_currency: args => store.currency[args.characterId] ?? [],
  get_character_attributes: args => store.attributes[args.characterId] ?? [],

  get_chapter_notes: () => store.notes,
  get_story_chapter_cast: () => store.chapterCast,
  get_story_chapter_cast_states: () => store.castStates,

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
    return row;
  },

  update_character_progress: args => {
    const row = store.progress.find(candidate => candidate.id === args.id);
    if (!row) throw new Error('no such income');
    row.chapter_id = args.chapterId;
    row.xp_earned = args.xpEarned;
    row.updated_at = now();
    return row;
  },

  delete_character_progress: args => {
    drop(store.progress, args.id);
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
  return result;
}

// A short label for the harness itself, so a capture can say which story it is.
export const harnessStory = { id: story.id, title: story.title, cast: characterName };
export const harnessNodeLabel = nodeLabel;
export { store };
