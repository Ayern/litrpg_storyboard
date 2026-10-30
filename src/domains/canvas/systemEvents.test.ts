import { describe, expect, it } from 'vitest';

import { chapterBesideCard, chapterEventChoices, chapterEventsFor } from './systemEvents';
import type { BoardCard, SystemEventChoice } from './systemEvents';
import type { ChapterEventRow } from './types';
import type { ChapterNode } from '../narrative/chapters';
import type {
  CharacterLevel,
  CharacterProgress,
  CharacterSkill,
  LevelGrowthRule,
} from '../shared/types';

// A scene's ledger already says what happened; these tests hold the translation
// from one of those rows into a System box, and the order the experience is
// added up in, which is the story's reading order.

const story = 'story-1';

function chapter(id: string, label: string, seq: number | null): ChapterNode {
  return {
    id,
    type: 'chapter',
    position: { x: 0, y: 0 },
    data: { label, nodeType: 'chapter', createdBy: 'Ada', chapterSeq: seq },
  };
}

const ch1 = chapter('ch-1', 'The Low Tide', 1);
const ch2 = chapter('ch-2', 'The Drowned Stair', 2);
const ch3 = chapter('ch-3', 'The Ninth Bell', 3);

const rule: LevelGrowthRule = {
  id: 'rule-1',
  story_id: story,
  character_id: null,
  points_per_level: 4,
  xp_base: 600,
  xp_growth: 0,
  stats: [],
  created_by: 'Ada',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const progress = (id: string, chapterId: string, xp: number): CharacterProgress => ({
  id,
  character_id: 'ivy',
  chapter_id: chapterId,
  xp_earned: xp,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const skillRow = (id: string, name: string, rank: string | null): CharacterSkill => ({
  id,
  character_id: 'ivy',
  name,
  rank,
  effect: null,
  chapter_id: null,
  node_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

let eventId = 0;

function event(
  chapterId: string,
  overrides: Partial<ChapterEventRow> = {}
): ChapterEventRow {
  eventId += 1;

  return {
    id: `e-${eventId}`,
    chapter_id: chapterId,
    actor_id: 'ivy',
    actorName: 'Ivy Marrow',
    event_type: 'xp_award',
    details: '',
    amount: 600,
    source_id: null,
    position: eventId,
    created_by: 'Ada',
    created_at: `2026-01-01T00:00:0${eventId}Z`,
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const choices = (events: ChapterEventRow[], extra: Partial<Parameters<typeof chapterEventChoices>[0]> = {}) =>
  chapterEventChoices({
    events,
    chapters: [ch1, ch2, ch3],
    progress: [progress('p-1', ch1.id, 600), progress('p-2', ch2.id, 600)],
    rules: [rule],
    skills: [],
    levels: [],
    ...extra,
  });

// A level the author recorded, with the stat gains it carries.
function level(
  levelNumber: number,
  changes: { stat_name: string; amount?: number | null; value_after?: number | null }[],
  characterId = 'ivy'
): CharacterLevel {
  return {
    id: `lvl-${characterId}-${levelNumber}`,
    character_id: characterId,
    level: levelNumber,
    chapter_id: null,
    is_debuff: false,
    stat_changes: changes.map((change, index) => ({
      id: `change-${levelNumber}-${index}`,
      level_record_id: `lvl-${characterId}-${levelNumber}`,
      stat_name: change.stat_name,
      amount: change.amount ?? null,
      value_after: change.value_after ?? null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('what a scene can write', () => {
  it('writes an XP award that carried a level as a level-up box', () => {
    const [choice] = choices([event(ch2.id, { id: 'e-1', amount: 600, position: 1 })]);

    // Chapter one paid 600, so the award in chapter two took the total to 1,200:
    // level three, at 600 XP a level.
    expect(choice.label).toBe('Ch. 2 · Ivy Marrow · 600 XP, level 2 → 3');
    expect(choice.chapterId).toBe(ch2.id);
    expect(choice.prefill).toEqual({
      kind: 'level_up',
      title: 'The Drowned Stair',
      levelFrom: '2',
      levelTo: '3',
      points: '4',
      body: 'Ivy Marrow is paid 600 XP in The Drowned Stair.',
    });
  });

  it('hands out the points of every level the award carried', () => {
    const [choice] = choices([
      event(ch2.id, { amount: 1800, position: 1 }),
    ]);

    // 600 before, 2,400 after: level 2 to level 5 is three levels, so twelve
    // points to place.
    expect(choice.prefill.levelFrom).toBe('2');
    expect(choice.prefill.levelTo).toBe('5');
    expect(choice.prefill.points).toBe('12');
    expect(choice.label).toBe('Ch. 2 · Ivy Marrow · 1,800 XP, level 2 → 5');
  });

  it('leaves out an award that did not move the level', () => {
    const choicesForScene = choices([
      event(ch2.id, { id: 'e-1', amount: 600, position: 1 }),
      event(ch2.id, { id: 'e-2', amount: 50, position: 2 }),
    ]);

    // The second award is on top of the first, so it is still inside level three.
    expect(choicesForScene.map(choice => choice.id)).toEqual(['e-1']);
  });

  it('adds a chapter’s awards up in the order the scene logged them', () => {
    const listed = choices([
      event(ch2.id, { id: 'e-1', amount: 300, position: 1 }),
      event(ch2.id, { id: 'e-2', amount: 300, position: 2 }),
    ]);

    // 900 after the first (still level two), 1,200 after the second: one box, and
    // it is the award that carried the level.
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('e-2');
    expect(listed[0].prefill.levelFrom).toBe('2');
    expect(listed[0].prefill.levelTo).toBe('3');
  });

  it('reads the character’s own rule before the story’s', () => {
    const own: LevelGrowthRule = {
      ...rule,
      id: 'rule-2',
      character_id: 'ivy',
      xp_base: 100,
      points_per_level: 2,
    };

    const [choice] = choices([event(ch2.id, { amount: 100 })], { rules: [rule, own] });

    // 600 before is already six levels on the character's own step, and 100 more
    // is level seven: one level, two points.
    expect(choice.prefill.levelFrom).toBe('7');
    expect(choice.prefill.levelTo).toBe('8');
    expect(choice.prefill.points).toBe('2');
  });

  it('puts the chapters in reading order, not the order they were created', () => {
    const [choice] = choices(
      [event(ch2.id, { id: 'e-2', amount: 600, position: 2 })],
      { chapters: [ch2, ch1] }
    );

    expect(choice.prefill.levelFrom).toBe('2');
  });
});

describe('a skill a scene changed', () => {
  const skill = skillRow('sk-1', 'Salt-Sight', '2');

  it('writes a learned skill with the rank its sheet holds', () => {
    const [choice] = choices(
      [
        event(ch2.id, {
          event_type: 'skill_learn',
          details: 'Salt-Sight',
          source_id: 'sk-1',
          amount: null,
        }),
      ],
      { skills: [skill] }
    );

    expect(choice.label).toBe('Ch. 2 · Ivy Marrow · learns Salt-Sight');
    expect(choice.prefill).toEqual({
      kind: 'skill',
      title: '[Salt-Sight]',
      rank: '2',
      body: 'Ivy Marrow learns Salt-Sight in The Drowned Stair.',
    });
  });

  it('writes a rank-up as the skill and the rank it reached', () => {
    const [choice] = choices(
      [
        event(ch3.id, {
          event_type: 'skill_rank_up',
          skill_id: 'sk-1',
          skillName: 'Salt-Sight',
          amount: null,
        }),
      ],
      { skills: [skill] }
    );

    expect(choice.label).toBe('Ch. 3 · Ivy Marrow · Salt-Sight rank 2');
    expect(choice.prefill).toMatchObject({ kind: 'skill', title: '[Salt-Sight]', rank: '2' });
  });

  it('writes an evolution from the skill it grew out of', () => {
    const evolved = skillRow('sk-2', 'Deep Bell', '1');

    const [choice] = choices(
      [
        event(ch3.id, {
          event_type: 'skill_evolve',
          details: 'Deep Bell',
          skillName: 'Bell-Tongue',
          new_skill_id: 'sk-2',
          amount: null,
        }),
      ],
      { skills: [evolved] }
    );

    expect(choice.label).toBe('Ch. 3 · Ivy Marrow · Bell-Tongue → Deep Bell');
    expect(choice.prefill).toEqual({
      kind: 'skill',
      title: '[Deep Bell]',
      rank: '1',
      evolution: 'Evolved from [Bell-Tongue] in The Ninth Bell',
    });
  });

  it('writes a sacrifice as the skill that was given up', () => {
    const [choice] = choices([
      event(ch3.id, {
        event_type: 'skill_sacrifice',
        skillName: 'Brine-Lung',
        amount: null,
      }),
    ]);

    expect(choice.label).toBe('Ch. 3 · Ivy Marrow · sacrifices Brine-Lung');
    expect(choice.prefill).toEqual({
      kind: 'skill',
      title: '[Brine-Lung]',
      evolution: 'Sacrificed in The Ninth Bell',
    });
  });

  it('leaves an acquired item to the author', () => {
    expect(
      choices([
        event(ch2.id, {
          event_type: 'item_acquire',
          details: 'Bell Fragment',
          amount: 1,
        }),
      ])
    ).toEqual([]);
  });
});

describe('the chapter a box belongs to', () => {
  // The board, not the ledger, says which scene a card was written for. A line
  // the author drew is read first; with no line, the card's place on the board
  // decides, because a chapter close by is the scene being described.
  const card = (
    id: string,
    nodeType: string,
    x: number,
    y: number,
    extra: Partial<BoardCard> = {}
  ): BoardCard => ({
    id,
    position: { x, y },
    data: { nodeType, label: id },
    ...extra,
  });

  const chapterCard = (id: string, label: string, seq: number, x: number, y = 0): BoardCard =>
    card(id, 'chapter', x, y, { data: { nodeType: 'chapter', label, chapterSeq: seq } });

  const box = (x: number, y = 200) => card('n-system', 'system', x, y);

  it('picks the chapter card the box sits nearest', () => {
    const first = chapterCard('ch-1', 'The Low Tide', 1, 0);
    const second = chapterCard('ch-2', 'The Drowned Stair', 2, 900);

    // The chapters' middles are at 150 and 1,050; the box's is at 960.
    expect(
      chapterBesideCard({ nodeId: 'n-system', nodes: [first, second, box(860)], edges: [] })
    ).toEqual({
      chapterId: 'ch-2',
      title: 'Ch. 2 · The Drowned Stair',
      via: 'near',
    });
  });

  it('measures from the middle of a card, not its corner', () => {
    // The wide first chapter starts at the edge of the board, so its corner is far
    // from the box while its middle is close: the card a reader sees under the
    // pointer is the one the box is beside.
    const first = card('ch-1', 'chapter', 0, 0, {
      measured: { width: 1200 },
      data: { nodeType: 'chapter', label: 'The Low Tide', chapterSeq: 1 },
    });
    const second = chapterCard('ch-2', 'The Drowned Stair', 2, 800);

    expect(
      chapterBesideCard({ nodeId: 'n-system', nodes: [first, second, box(560)], edges: [] })
    ).toMatchObject({ chapterId: 'ch-1', via: 'near' });
  });

  it('lets a connection decide between two chapters a finger apart', () => {
    const first = chapterCard('ch-1', 'The Low Tide', 1, 0);
    const second = chapterCard('ch-2', 'The Drowned Stair', 2, 900);

    expect(
      chapterBesideCard({
        nodeId: 'n-system',
        nodes: [first, second, box(0)],
        edges: [{ source: 'n-system', target: 'ch-2' }],
      })
    ).toEqual({ chapterId: 'ch-2', title: 'Ch. 2 · The Drowned Stair', via: 'link' });
  });

  it('reads a line drawn from the chapter as well as one drawn to it', () => {
    const first = chapterCard('ch-1', 'The Low Tide', 1, 0);
    const second = chapterCard('ch-2', 'The Drowned Stair', 2, 900);

    expect(
      chapterBesideCard({
        nodeId: 'n-system',
        nodes: [first, second, box(900)],
        edges: [{ source: 'ch-1', target: 'n-system' }],
      })
    ).toMatchObject({ chapterId: 'ch-1', via: 'link' });
  });

  it('answers with nothing when the board has no chapter to belong to', () => {
    expect(
      chapterBesideCard({ nodeId: 'n-system', nodes: [box(0)], edges: [] })
    ).toBeNull();
  });
});

describe('the stats a level-up recorded', () => {
  // The levels carry the gains: a sheet records what a level gave, and the award
  // that crossed it can announce the same numbers without the author copying
  // them across.
  it('writes the gain of a level the award crossed', () => {
    const [choice] = choices([event(ch2.id, { amount: 600 })], {
      levels: [level(3, [{ stat_name: 'Insight', amount: 1, value_after: 13 }])],
    });

    expect(choice.prefill.stats).toEqual([{ name: 'Insight', from: '12', to: '13' }]);
  });

  it('adds up a stat two crossed levels both raised', () => {
    const [choice] = choices([event(ch2.id, { amount: 1800 })], {
      levels: [
        level(3, [{ stat_name: 'Insight', amount: 1, value_after: 13 }]),
        level(4, [{ stat_name: 'Insight', amount: 1, value_after: 14 }]),
        level(5, [{ stat_name: 'Insight', amount: 1, value_after: 15 }]),
      ],
    });

    // Level two to five, so the row is one move rather than the same name three
    // times: where the first gain started and where the last one left it.
    expect(choice.prefill.levelTo).toBe('5');
    expect(choice.prefill.stats).toEqual([{ name: 'Insight', from: '12', to: '15' }]);
  });

  it('counts a gain spelled differently as the same stat', () => {
    const [choice] = choices([event(ch2.id, { amount: 1800 })], {
      levels: [
        level(3, [{ stat_name: 'Insight', amount: 1, value_after: 13 }]),
        level(4, [{ stat_name: ' insight ', amount: 1, value_after: 14 }]),
      ],
    });

    expect(choice.prefill.stats).toEqual([{ name: 'Insight', from: '12', to: '14' }]);
  });

  it('says a gain whose value was never recorded as the gain', () => {
    const [choice] = choices([event(ch2.id, { amount: 600 })], {
      levels: [level(3, [{ stat_name: 'Agility', amount: 2 }])],
    });

    // The sheet recorded what the level gave, not what it added to, so the box
    // says the gain rather than inventing a number.
    expect(choice.prefill.stats).toEqual([{ name: 'Agility', from: '', to: '+2' }]);
  });

  it('leaves a level the award never crossed out of the box', () => {
    const [choice] = choices([event(ch2.id, { amount: 600 })], {
      levels: [level(6, [{ stat_name: 'Strength', amount: 2, value_after: 20 }])],
    });

    // The award reached level three; a gain recorded at six is somebody else's
    // announcement. The key is left off rather than left empty.
    expect(choice.prefill).not.toHaveProperty('stats');
  });

  it('leaves the gains off another character’s award', () => {
    const [choice] = choices([event(ch2.id, { amount: 600 })], {
      levels: [level(3, [{ stat_name: 'Insight', amount: 1, value_after: 13 }], 'bram')],
    });

    expect(choice.prefill).not.toHaveProperty('stats');
  });
});

describe('which chapters the picker offers', () => {
  const choice = (chapterId: string): SystemEventChoice => ({
    id: `c-${chapterId}`,
    chapterId,
    label: chapterId,
    prefill: { kind: 'skill', title: chapterId },
  });

  const ch4 = chapter('ch-4', 'The Tally', 4);
  const ch5 = chapter('ch-5', 'After the Bell', 5);
  const five = [ch1, ch2, ch3, ch4, ch5];

  it('offers the chapter the box belongs to when it has events', () => {
    const listing = chapterEventsFor({
      choices: [choice(ch1.id), choice(ch3.id), choice(ch5.id)],
      chapterId: ch3.id,
      chapters: five,
    });

    expect(listing.scope).toBe('chapter');
    expect(listing.choices.map(entry => entry.chapterId)).toEqual([ch3.id]);
  });

  it('offers the chapters either side when its own has nothing logged', () => {
    const listing = chapterEventsFor({
      choices: [choice(ch2.id), choice(ch4.id)],
      chapterId: ch3.id,
      chapters: five,
    });

    // A box written beside a scene with nothing in it is usually announcing what
    // happened on the way in or out, so those two are offered before the story.
    expect(listing.scope).toBe('nearby');
    expect(listing.choices.map(entry => entry.chapterId)).toEqual([ch2.id, ch4.id]);
    expect(listing.nearby).toEqual([
      { chapterId: ch2.id, title: 'Ch. 2 · The Drowned Stair' },
      { chapterId: ch4.id, title: 'Ch. 4 · The Tally' },
    ]);
  });

  it('walks out another ring when the chapters beside it are empty too', () => {
    const listing = chapterEventsFor({
      choices: [choice(ch1.id)],
      chapterId: ch3.id,
      chapters: five,
    });

    expect(listing.scope).toBe('nearby');
    expect(listing.choices.map(entry => entry.chapterId)).toEqual([ch1.id]);
    // Only the chapter that answered is named: saying “the chapters beside Ch. 3”
    // would point at two scenes with nothing to write.
    expect(listing.nearby).toEqual([{ chapterId: ch1.id, title: 'Ch. 1 · The Low Tide' }]);
  });

  it('names the chapter when it has no number to read', () => {
    const unnumbered = chapter('ch-6', 'A Chapter With No Number', null);

    const listing = chapterEventsFor({
      choices: [choice(ch1.id)],
      chapterId: 'ch-6',
      chapters: [ch1, unnumbered],
    });

    expect(listing.nearby).toEqual([
      { chapterId: ch1.id, title: 'Ch. 1 · The Low Tide' },
    ]);
  });

  it('falls back to the whole story when no chapter has anything to write', () => {
    const listing = chapterEventsFor({
      choices: [],
      chapterId: ch3.id,
      chapters: five,
    });

    expect(listing.scope).toBe('all');
  });

  it('lists the whole story when the board has only the one chapter', () => {
    const listing = chapterEventsFor({
      choices: [choice(ch1.id)],
      chapterId: ch3.id,
      chapters: [ch3],
    });

    // There is no neighbour to widen to, so nothing is hidden either.
    expect(listing.scope).toBe('all');
  });
});

describe('the order the picker lists them in', () => {
  it('runs down the chapters and then down each scene', () => {
    const listed = choices(
      [
        event(ch3.id, { event_type: 'skill_learn', details: 'Deep Bell', amount: null, position: 2 }),
        event(ch2.id, { id: 'e-x', amount: 600, position: 1 }),
        event(ch3.id, { event_type: 'skill_learn', details: 'Salt-Sight', amount: null, position: 1 }),
      ],
      { chapters: [ch3, ch1, ch2] }
    );

    expect(listed.map(choice => choice.prefill.title)).toEqual([
      'The Drowned Stair',
      '[Salt-Sight]',
      '[Deep Bell]',
    ]);
  });
});
