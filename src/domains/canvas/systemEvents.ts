import { FALLBACK_XP_BASE } from '../progression/crossings';
import { effectiveGrowthRule, levelForXp } from '../progression/growth';
import { formatCount } from '../../lib/format';
import type { ChapterNode } from '../narrative/chapters';
import type { CharacterProgress, CharacterSkill, LevelGrowthRule } from '../shared/types';
import type { ChapterEventRow } from './types';
import type { SystemEventPrefill } from './systemMessage';

// A scene already knows what happened: the ledger on a chapter card records the
// XP paid, the skill learned, the rank that moved. A System box announcing the
// same thing should not be retyped from it, so each event that can be written as
// a box is offered to the drawer, already turned into the box's fields.
//
// The experience is worked out the way the rest of the app works it out: the
// chapter incomes in reading order, and the story's own growth rule (or the
// character's override) deciding where a level falls. A scene that paid enough to
// cross a level writes a level-up; a scene that did not is not offered, because a
// box announcing a level that did not move would be a lie.

export interface SystemEventChoice {
  id: string;
  // The scene the event was logged in, so a card can be offered only what
  // happened in the chapter it was written beside.
  chapterId: string;
  // What the picker shows: the chapter, the person and what happened.
  label: string;
  prefill: SystemEventPrefill;
}

export interface ChapterEventChoiceInput {
  // Story-wide events, each with the actor's name resolved, as the chapter cards
  // are handed them.
  events: ChapterEventRow[];
  chapters: ChapterNode[];
  progress: CharacterProgress[];
  rules: LevelGrowthRule[];
  skills: Pick<CharacterSkill, 'id' | 'name' | 'rank'>[];
}

// The order a chapter's income counts in: the reading order, with the chapters
// that have no place yet after every placed one. It is the order the crossings
// use, so the box and the curve agree about which chapter paid for a level.
function chapterOrder(chapters: ChapterNode[]): Map<string, number> {
  const placed = [...chapters].sort(
    (left, right) =>
      (left.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) -
        (right.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id)
  );

  return new Map(placed.map((chapter, index) => [chapter.id, index]));
}

const ordered = (events: ChapterEventRow[], rank: (id: string | null) => number) =>
  [...events].sort(
    (left, right) =>
      rank(left.chapter_id) - rank(right.chapter_id) ||
      left.position - right.position ||
      left.created_at.localeCompare(right.created_at) ||
      left.id.localeCompare(right.id)
  );

export function chapterEventChoices({
  events,
  chapters,
  progress,
  rules,
  skills,
}: ChapterEventChoiceInput): SystemEventChoice[] {
  const order = chapterOrder(chapters);
  const rank = (chapterId: string | null) =>
    chapterId ? order.get(chapterId) ?? order.size : order.size;

  const chaptersById = new Map(chapters.map(chapter => [chapter.id, chapter]));
  const skillsById = new Map(skills.map(skill => [skill.id, skill]));

  // What each character was paid before a chapter, so an award's own chapter is
  // the only one that has to be added up as the events go by.
  const income = new Map<string, number>();

  for (const entry of progress) {
    const key = `${entry.character_id}|${rank(entry.chapter_id)}`;
    income.set(key, (income.get(key) ?? 0) + entry.xp_earned);
  }

  const paidBeforeChapter = (characterId: string, chapterRank: number) => {
    let total = 0;

    for (const [key, xp] of income) {
      const [id, at] = key.split('|');
      if (id === characterId && Number(at) < chapterRank) total += xp;
    }

    return total;
  };

  const paidInChapter = new Map<string, number>();
  const choices: SystemEventChoice[] = [];

  for (const event of ordered(events, rank)) {
    const chapter = event.chapter_id ? chaptersById.get(event.chapter_id) : undefined;
    const chapterName = chapter?.data.label ?? 'A chapter';
    const where = chapter?.data.chapterSeq != null ? `Ch. ${chapter.data.chapterSeq}` : chapterName;
    const actor = event.actorName || 'The cast';
    const inChapter = `${event.actor_id}|${event.chapter_id}`;

    const skillOf = (id: string | null | undefined) => (id ? skillsById.get(id) : undefined);

    if (event.event_type === 'xp_award') {
      const amount = event.amount ?? 0;

      if (amount <= 0) continue;

      const rule = effectiveGrowthRule(rules, event.actor_id);
      const base = rule?.xp_base ?? FALLBACK_XP_BASE;
      const growth = rule?.xp_growth ?? 0;

      const before =
        paidBeforeChapter(event.actor_id, rank(event.chapter_id)) +
        (paidInChapter.get(inChapter) ?? 0);

      paidInChapter.set(inChapter, (paidInChapter.get(inChapter) ?? 0) + amount);

      const from = levelForXp(base, growth, before);
      const to = levelForXp(base, growth, before + amount);

      if (to <= from) continue;

      const points = (to - from) * (rule?.points_per_level ?? 0);

      choices.push({
        id: event.id,
        chapterId: event.chapter_id,
        label: `${where} · ${actor} · ${formatCount(amount)} XP, level ${from} → ${to}`,
        prefill: {
          kind: 'level_up',
          title: chapterName,
          levelFrom: String(from),
          levelTo: String(to),
          points: points > 0 ? String(points) : '',
          body: `${actor} is paid ${formatCount(amount)} XP in ${chapterName}.`,
        },
      });

      continue;
    }

    if (event.event_type === 'skill_learn') {
      const skill = skillOf(event.source_id) ?? skillOf(event.skill_id);
      const name = (event.details || event.skillName || skill?.name || '').trim();

      if (!name) continue;

      choices.push({
        id: event.id,
        chapterId: event.chapter_id,
        label: `${where} · ${actor} · learns ${name}`,
        prefill: {
          kind: 'skill',
          title: `[${name}]`,
          rank: skill?.rank ?? '',
          body: `${actor} learns ${name} in ${chapterName}.`,
        },
      });

      continue;
    }

    if (event.event_type === 'skill_rank_up') {
      const skill = skillOf(event.skill_id);
      const name = (event.skillName || skill?.name || '').trim();

      if (!name) continue;

      choices.push({
        id: event.id,
        chapterId: event.chapter_id,
        label: `${where} · ${actor} · ${name}${skill?.rank ? ` rank ${skill.rank}` : ' rank up'}`,
        prefill: {
          kind: 'skill',
          title: `[${name}]`,
          rank: skill?.rank ?? '',
          body: `${actor}'s ${name} moves up a rank in ${chapterName}.`,
        },
      });

      continue;
    }

    if (event.event_type === 'skill_evolve') {
      const next = (event.details || '').trim();

      if (!next) continue;

      const base = (event.skillName || skillOf(event.skill_id)?.name || '').trim();
      const evolved = skillOf(event.new_skill_id);

      choices.push({
        id: event.id,
        chapterId: event.chapter_id,
        label: `${where} · ${actor} · ${base ? `${base} → ` : ''}${next}`,
        prefill: {
          kind: 'skill',
          title: `[${next}]`,
          rank: evolved?.rank ?? '',
          evolution: base
            ? `Evolved from [${base}] in ${chapterName}`
            : `Evolved in ${chapterName}`,
        },
      });

      continue;
    }

    if (event.event_type === 'skill_sacrifice') {
      const base = (event.skillName || skillOf(event.skill_id)?.name || event.details || '').trim();

      if (!base) continue;

      choices.push({
        id: event.id,
        chapterId: event.chapter_id,
        label: `${where} · ${actor} · sacrifices ${base}`,
        prefill: {
          kind: 'skill',
          title: `[${base}]`,
          evolution: `Sacrificed in ${chapterName}`,
        },
      });
    }

    // An item the scene handed over is an inventory row, not a System box: none
    // of the kinds says what an item is worth, so it is left to the author.
  }

  return choices;
}

// The chapter a System box belongs to, read off the board rather than the story:
// the card answers a question about a scene, and the scene is where the card sits.
// Two chapters can be a finger apart, so a connection the author drew is asked
// first and settles the question; with no line to read, the nearest chapter card
// decides, measured from the middle of one card to the middle of the other.
export interface BoardCard {
  id: string;
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  measured?: { width?: number | null; height?: number | null } | null;
  data: { nodeType?: string; label?: string; chapterSeq?: number | null };
}

export interface BoardLink {
  source: string;
  target: string;
}

export interface NearChapter {
  chapterId: string;
  // “Ch. 3 · The Drowned Stair”, or the name alone for a chapter with no number.
  title: string;
  // Whether a drawn connection chose it, or its place on the board did.
  via: 'link' | 'near';
}

// What a card is drawn at before the board has measured it: a chapter workbench
// is a wide card, everything else a note-sized one. The measurement is used when
// it is there, so a card that grew with its cast is measured as it is.
const CARD_SIZE = {
  chapter: { width: 300, height: 340 },
  other: { width: 200, height: 90 },
};

function cardCentre(card: BoardCard) {
  const fallback = card.data.nodeType === 'chapter' ? CARD_SIZE.chapter : CARD_SIZE.other;

  return {
    x: card.position.x + (card.measured?.width ?? card.width ?? fallback.width) / 2,
    y: card.position.y + (card.measured?.height ?? card.height ?? fallback.height) / 2,
  };
}

export function chapterBesideCard({
  nodeId,
  nodes,
  edges,
}: {
  nodeId: string;
  nodes: readonly BoardCard[];
  edges: readonly BoardLink[];
}): NearChapter | null {
  const chapters = nodes.filter(node => node.data.nodeType === 'chapter');
  const card = nodes.find(node => node.id === nodeId);

  if (chapters.length === 0 || !card) return null;

  const chapterIds = new Set(chapters.map(chapter => chapter.id));
  const linked = new Set<string>();

  for (const edge of edges) {
    if (edge.source === nodeId && chapterIds.has(edge.target)) linked.add(edge.target);
    if (edge.target === nodeId && chapterIds.has(edge.source)) linked.add(edge.source);
  }

  const origin = cardCentre(card);
  const distanceTo = (chapter: BoardCard) => {
    const centre = cardCentre(chapter);

    return (centre.x - origin.x) ** 2 + (centre.y - origin.y) ** 2;
  };

  // A settled order, so two chapters the same distance away always answer with
  // the same one: the reading order, then the id.
  const ranked = [...chapters].sort(
    (left, right) =>
      distanceTo(left) - distanceTo(right) ||
      (left.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) -
        (right.data.chapterSeq ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id)
  );

  const pool = linked.size > 0 ? ranked.filter(chapter => linked.has(chapter.id)) : ranked;
  const chosen = pool[0];

  if (!chosen) return null;

  const name = chosen.data.label ?? 'A chapter';

  return {
    chapterId: chosen.id,
    title: chosen.data.chapterSeq != null ? `Ch. ${chosen.data.chapterSeq} · ${name}` : name,
    via: linked.has(chosen.id) ? 'link' : 'near',
  };
}
