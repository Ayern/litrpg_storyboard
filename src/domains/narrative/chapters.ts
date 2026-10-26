// What a chapter is, worked out from the cards and the ledgers: where it sits in
// the reading order, whether the numbers make sense, how many words the story
// adds up to, where it falls in the day, and who is in it. None of this needs
// React, so the Chapters tab and the canvas cards read the same answers.

import type { Node } from 'reactflow';
import type { ChapterCastBadge, NodeData } from '../canvas/types';
import type { ChapterNote } from '../shared/types';
import { formatCount } from '../../lib/format';
import type { ChapterCastState } from './types';

export type ChapterNode = Node<NodeData>;

// The live chapters, in reading order. One with no position yet sorts last by
// name, so it is visible and can be given a place rather than hidden.
export function liveChapters(nodes: ChapterNode[]): ChapterNode[] {
  const chapters = nodes.filter(node => node.data.nodeType === 'chapter');

  return [...chapters].sort((left, right) => {
    const leftSeq = left.data.chapterSeq ?? Number.MAX_SAFE_INTEGER;
    const rightSeq = right.data.chapterSeq ?? Number.MAX_SAFE_INTEGER;

    return leftSeq === rightSeq
      ? left.data.label.localeCompare(right.data.label)
      : leftSeq - rightSeq;
  });
}

export interface ChapterIssues {
  duplicates: number[];
  missing: number[];
  unnumbered: number;
}

// Duplicated, missing or absent numbers. Reordering avoids all three, so this
// only has something to say after a deletion or after an older import.
export function numberingIssues(chapterNodes: ChapterNode[]): ChapterIssues {
  const positions = chapterNodes
    .map(node => node.data.chapterSeq)
    .filter((sequence): sequence is number => sequence != null);

  const duplicates = [...new Set(
    positions.filter((sequence, index) => positions.indexOf(sequence) !== index)
  )].sort((left, right) => left - right);

  const missing: number[] = [];
  const highest = positions.length > 0 ? Math.max(...positions) : 0;
  for (let position = 1; position <= highest; position += 1) {
    if (!positions.includes(position)) missing.push(position);
  }

  const unnumbered = chapterNodes.filter(
    node => node.data.chapterSeq == null
  ).length;

  return { duplicates, missing, unnumbered };
}

// The chapter list's one-sentence warning. Positions start at 1, so a story
// whose middle chapter was deleted can have 1 and 3 while 2 is empty.
export function describeNumberingIssues(issues: ChapterIssues): string {
  const parts: string[] = [];

  if (issues.duplicates.length > 0) {
    parts.push(`position ${issues.duplicates.join(', ')} is used more than once`);
  }
  if (issues.missing.length > 0) {
    parts.push(`position ${issues.missing.join(', ')} is empty`);
  }
  if (issues.unnumbered > 0) {
    parts.push(
      `${issues.unnumbered} chapter${issues.unnumbered === 1 ? '' : 's'} ${
        issues.unnumbered === 1 ? 'has' : 'have'
      } no position`
    );
  }

  return `The reading order needs attention: ${parts.join('; ')}.`;
}

export interface ChapterTotals {
  words: number;
  target: number | null;
  targeted: number;
}

// The story total: every count the author has entered, and the sum of the
// targets that exist — a chapter without one contributes no target rather than
// pretending its words were uncounted for.
export function sumChapterWords(chapterNodes: ChapterNode[]): ChapterTotals {
  const words = chapterNodes.reduce(
    (sum, node) => sum + (node.data.chapterWords ?? 0),
    0
  );
  const targets = chapterNodes
    .map(node => node.data.chapterTarget)
    .filter((target): target is number => target != null);

  return {
    words,
    target: targets.length > 0 ? targets.reduce((sum, target) => sum + target, 0) : null,
    targeted: targets.length,
  };
}

// How full the story's target is, as a whole percent, capped at 100.
export function wordTargetPercent(totals: ChapterTotals): number {
  return totals.target && totals.target > 0
    ? Math.min(100, Math.round((totals.words / totals.target) * 100))
    : 0;
}

// Time order, which is not always reading order. A chapter without a day is left
// off rather than quietly given one; the note above the list counts them. The
// sort is stable, so chapters sharing a day keep their reading order.
export function timelineOrder(chapterNodes: ChapterNode[]): ChapterNode[] {
  return chapterNodes
    .filter(node => node.data.chapterDay != null)
    .sort((left, right) => {
      const day = (left.data.chapterDay ?? 0) - (right.data.chapterDay ?? 0);

      if (day !== 0) return day;

      // Inside a day, only labels that read as a time can be ordered. One that
      // cannot has no place in the day, so it waits after the ones that can,
      // keeping its reading order among the others the clock cannot read.
      const leftTime = timeOfDay(left.data.chapterTime);
      const rightTime = timeOfDay(right.data.chapterTime);

      if (leftTime == null) return rightTime == null ? 0 : 1;
      if (rightTime == null) return -1;

      return leftTime - rightTime;
    });
}

// The notes grouped by the chapter they belong to, so a row can show its count
// without scanning the whole list.
export function groupNotesByChapter(notes: ChapterNote[]): Map<string, ChapterNote[]> {
  const grouped = new Map<string, ChapterNote[]>();

  for (const note of notes) {
    grouped.set(note.chapterId, [...(grouped.get(note.chapterId) ?? []), note]);
  }

  return grouped;
}

// The chapter card badges describe the cast assigned to each chapter. A state
// whose cast member is in the trash has no name to show, so it is left out.
export function castBadgesByChapter(
  states: ChapterCastState[],
  castNames: Map<string, string>
): Map<string, ChapterCastBadge[]> {
  const grouped = new Map<string, ChapterCastBadge[]>();

  for (const state of states) {
    const name = castNames.get(state.character_id);
    if (!name) continue;

    const existing = grouped.get(state.chapter_id) ?? [];
    existing.push({
      characterId: state.character_id,
      name,
      level: state.level,
      levelIsPenalty: state.level_is_penalty,
      skills: state.skills,
    });
    grouped.set(state.chapter_id, existing);
  }

  return grouped;
}

// What a chapter row says about its words. A target without a count reads as
// zero of that target rather than hiding the target.
export function formatChapterWords(
  words: number | null | undefined,
  target: number | null | undefined
): string {
  if (words == null && target == null) return 'No word count';
  if (target == null) return `${formatCount(words ?? 0)} words`;

  return `${formatCount(words ?? 0)} / ${formatCount(target)} words`;
}

// A chapter's time is free text, so comparing two of them means reading the
// label as a clock first: “18:40”, “6:40 pm”, or one of the day parts writers
// reach for, optionally qualified (“late evening”, “just before dawn”). A label
// that reads as neither — “after the fire” — gets no order at all and is left
// where reading order put it, rather than guessed at.
const DAY_PARTS: [RegExp, number][] = [
  [/\bmidnight\b/, 0],
  [/\bdawn\b|\bsunrise\b|\bfirst light\b/, 6 * 60],
  [/\bmorning\b/, 9 * 60],
  [/\bnoon\b|\bmidday\b/, 12 * 60],
  [/\bafternoon\b/, 14 * 60 + 30],
  [/\bdusk\b|\bsunset\b|\bevening\b/, 19 * 60],
  [/\bnight\b|\bnightfall\b|\bafter dark\b/, 21 * 60],
];

const DAY_PART_NUDGES: [RegExp, number][] = [
  [/\bearly\b|\bbefore\b/, -60],
  [/\blate\b|\bafter\b|\bdeep\b/, 60],
];

/** A label's place in the day, in minutes from midnight, or null when it does
 * not read as a time of day. */
export function timeOfDay(label?: string | null): number | null {
  if (!label) return null;

  const text = label.trim().toLowerCase();

  const clock = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/);
  const hourOnly = text.match(/^(\d{1,2})\s*(am|pm)$/);

  if (clock || hourOnly) {
    const hour = Number((clock ?? hourOnly)?.[1]);
    const minute = clock ? Number(clock[2]) : 0;
    const meridiem = (clock?.[3] ?? hourOnly?.[2]) as 'am' | 'pm' | undefined;

    if (hour > (meridiem ? 12 : 23) || minute > 59) return null;

    // 12am is midnight and 12pm is noon; every other hour simply shifts.
    const wrapped = meridiem ? (hour % 12) + (meridiem === 'pm' ? 12 : 0) : hour;

    return wrapped * 60 + minute;
  }

  let best: { at: number; minutes: number } | null = null;

  for (const [pattern, minutes] of DAY_PARTS) {
    const hit = pattern.exec(text);

    if (hit && (best === null || hit.index < best.at)) {
      best = { at: hit.index, minutes };
    }
  }

  if (best === null) return null;

  const nudge = DAY_PART_NUDGES.reduce(
    (offset, [pattern, minutes]) => (pattern.test(text) ? offset + minutes : offset),
    0
  );

  // Clamped to the day so “late night” does not spill into tomorrow.
  return Math.min(23 * 60 + 59, Math.max(0, best.minutes + nudge));
}

// A row's grip carries this, so the list only reacts to its own drags.
export const CHAPTER_DRAG_TYPE = 'application/x-litrpg-chapter';
