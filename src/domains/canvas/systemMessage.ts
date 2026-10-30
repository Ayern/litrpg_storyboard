// A system card is an announcement a reader meets: a level-up, a quest, a skill
// evolving, an achievement. Those boxes have a shape — a level that moved, points
// to place, objectives with ticks — so the card is edited as that shape rather
// than as a paragraph, and copied out as one.
//
// The shape is stored in the text the card already has, under a small line format
// the card's own notes show:
//
//     Type: level_up
//     Title: The Tide Advances
//     Level: 3 → 4
//     Points: 2
//     Stat: Agility | 12 → 13
//     ---
//     Flavour text, any length.
//
// Nothing about the database changed for this: the label is the box's header and
// the notes are the message, so save, undo and the audit trail already carry it.
// A card written before the format existed — a title on the first line, the body
// under it — still reads as a notice, which is what it was.

export const systemKinds = ['notice', 'level_up', 'skill', 'quest', 'achievement'] as const;

export type SystemKind = (typeof systemKinds)[number];

/** What an author picks at the top of the drawer. */
export const systemKindLabels: Record<SystemKind, string> = {
  notice: 'System notice',
  level_up: 'Level up & stats',
  skill: 'Skill learn / evolve',
  quest: 'Quest offer / completion',
  achievement: 'Achievement unlocked',
};

export const questStatuses = ['offered', 'accepted', 'complete', 'failed'] as const;

export type QuestStatus = (typeof questStatuses)[number];

/** The banner a quest box carries, as the genre prints it. */
export const questStatusLabels: Record<QuestStatus, string> = {
  offered: 'QUEST OFFER',
  accepted: 'QUEST ACCEPTED',
  complete: 'QUEST COMPLETE',
  failed: 'QUEST FAILED',
};

export interface SystemStat {
  name: string;
  from: string;
  to: string;
}

export interface SystemObjective {
  text: string;
  done: boolean;
}

/** One card's message, with every kind's fields present so the editor can switch
 *  between them without losing what the author already wrote. */
export interface SystemMessage {
  kind: SystemKind;
  header: string;
  title: string;
  body: string;
  levelFrom: string;
  levelTo: string;
  points: string;
  stats: SystemStat[];
  rank: string;
  evolution: string;
  status: QuestStatus;
  objectives: SystemObjective[];
  rewards: string[];
}

const ARROW = /\s*(?:→|->|=>)\s*/;

/** The two sides of a move. The arrow is written whenever either side is, so a
 *  half-typed level still says which half it is when it is read back. */
const transition = (from: string, to: string) =>
  from.trim() || to.trim() ? `${from.trim()} → ${to.trim()}`.trim() : '';

const isKind = (value: string): value is SystemKind =>
  (systemKinds as readonly string[]).includes(value);

const isStatus = (value: string): value is QuestStatus =>
  (questStatuses as readonly string[]).includes(value);

export function emptySystemMessage(header = ''): SystemMessage {
  return {
    kind: 'notice',
    header,
    title: '',
    body: '',
    levelFrom: '',
    levelTo: '',
    points: '',
    stats: [],
    rank: '',
    evolution: '',
    status: 'accepted',
    objectives: [],
    rewards: [],
  };
}

/** `3 → 4`, `3 -> 4`, or a lone `4`, which is a level with no start. */
function parseLevelPair(text: string): { from: string; to: string } {
  const parts = text.split(ARROW);

  return parts.length > 1
    ? { from: parts[0].trim(), to: parts.slice(1).join(' ').trim() }
    : { from: '', to: text.trim() };
}

/** `Agility | 12 → 13`, or just `12 → 13` for a stat whose name the author left
 *  off. A row with no arrow reads as the value after the change. */
function parseStat(text: string): SystemStat {
  const [name, ...rest] = text.split('|');
  const pair = rest.length > 0 ? rest.join('|') : name;

  return { name: rest.length > 0 ? name.trim() : '', ...parseLevelPair(pair) };
}

function parseObjective(text: string): SystemObjective {
  const match = text.match(/^\[([ xX✓✗])\]\s*(.*)$/);

  if (!match) return { text, done: false };

  const mark = match[1].trim();

  return { text: match[2], done: mark === '✓' || mark.toLowerCase() === 'x' };
}

/** A card's label and notes as a message. The first line decides: `Type:` opens
 *  the format above, anything else is the first line of a notice's title. */
export function systemMessageOf(
  label: string,
  content: string | null | undefined
): SystemMessage {
  const message = emptySystemMessage(label.trim() || 'SYSTEM');
  const lines = (content ?? '').replace(/\r\n/g, '\n').split('\n');

  const first = lines.findIndex(line => line.trim() !== '');
  const typed = first >= 0 && /^type\s*:/i.test(lines[first].trim());

  if (!typed) {
    // The shape this app wrote before the format: a title, then the body.
    const kept = [...lines];
    while (kept.length > 0 && kept[0].trim() === '') kept.shift();
    message.title = kept.length > 0 ? (kept.shift() as string).trim() : '';
    message.body = kept.join('\n').replace(/^\n+|\n+$/g, '');
    return message;
  }

  const bodyParts: string[] = [];
  let inBody = false;

  for (const line of lines) {
    if (!inBody && line.trim() === '---') {
      inBody = true;
      continue;
    }

    if (inBody) {
      bodyParts.push(line);
      continue;
    }

    const field = line.match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/);

    if (!field) {
      // A line the format does not name is the author's own text, not a field.
      if (line.trim() !== '') bodyParts.push(line);
      continue;
    }

    const key = field[1].trim().toLowerCase();
    // The one space after the colon is the format's; the rest is the author's
    // text, trailing spaces included, so typing keeps the space typed before the
    // next word instead of swallowing it.
    const value = field[2].replace(/^ /, '');

    switch (key) {
      case 'type': {
        const kind = value.trim();
        if (isKind(kind)) message.kind = kind;
        break;
      }
      case 'title':
        message.title = value;
        break;
      case 'level': {
        const pair = parseLevelPair(value);
        message.levelFrom = pair.from;
        message.levelTo = pair.to;
        break;
      }
      case 'points':
        message.points = value;
        break;
      case 'stat':
        // A row is kept even with nothing in it, because a half-typed one is on
        // its way somewhere and the fields are what the author is looking at.
        message.stats.push(parseStat(value));
        break;
      case 'rank':
        message.rank = value;
        break;
      case 'evolution':
        message.evolution = value;
        break;
      case 'status': {
        const status = value.trim().toLowerCase();
        if (isStatus(status)) message.status = status;
        break;
      }
      case 'objective':
        message.objectives.push(parseObjective(value));
        break;
      case 'reward':
        if (value.trim()) message.rewards.push(value);
        break;
      default:
        bodyParts.push(line);
    }
  }

  message.body = bodyParts.join('\n');

  return message;
}

/** The card's notes as the format writes them. `notice` with nothing written is
 *  still blank, so a card nobody has filled in stays empty rather than carrying
 *  a type line; every other kind keeps its type so it survives a save. */
export function serializeSystemMessage(message: SystemMessage): string {
  const lines: string[] = [];

  const filled =
    Boolean(message.title.trim()) ||
    Boolean(message.body.trim()) ||
    message.stats.length > 0 ||
    message.objectives.length > 0 ||
    message.rewards.length > 0 ||
    Boolean(message.levelFrom || message.levelTo || message.points || message.rank || message.evolution);

  if (message.kind !== 'notice' || filled) {
    lines.push(`Type: ${message.kind}`);
  }

  if (message.title.trim()) lines.push(`Title: ${message.title}`);

  if (message.kind === 'level_up') {
    if (message.levelFrom.trim() || message.levelTo.trim()) {
      lines.push(`Level: ${transition(message.levelFrom, message.levelTo)}`);
    }

    if (message.points.trim()) lines.push(`Points: ${message.points}`);

    for (const stat of message.stats) {
      // The bar is written even with nothing after it, so a name being typed is
      // a name and not mistaken for a value on the way back in.
      const pair = transition(stat.from, stat.to);
      const rest = pair ? ` ${pair}` : '';

      lines.push(stat.name ? `Stat: ${stat.name} |${rest}` : `Stat: |${rest}`);
    }
  }

  if (message.kind === 'skill') {
    if (message.rank.trim()) lines.push(`Rank: ${message.rank}`);
    if (message.evolution.trim()) lines.push(`Evolution: ${message.evolution}`);
  }

  if (message.kind === 'quest') {
    lines.push(`Status: ${message.status}`);

    for (const objective of message.objectives) {
      const text = objective.text;

      lines.push(`Objective: [${objective.done ? 'x' : ' '}]${text ? ` ${text}` : ''}`);
    }

    for (const reward of message.rewards) {
      if (reward.trim()) lines.push(`Reward: ${reward}`);
    }
  }

  if (message.kind === 'achievement') {
    for (const reward of message.rewards) {
      if (reward.trim()) lines.push(`Reward: ${reward}`);
    }
  }

  if (message.body.trim()) {
    lines.push('---', message.body);
  }

  return lines.join('\n');
}

/** `+1`, `-2`, or nothing when the two values are not both numbers. A stat that
 *  went from 12 to 13 is worth saying so in the box. */
export function statDelta(from: string, to: string): string {
  const before = Number(from.trim());
  const after = Number(to.trim());

  if (!from.trim() || !to.trim() || !Number.isFinite(before) || !Number.isFinite(after)) {
    return '';
  }

  const delta = after - before;

  return delta === 0 ? '' : `${delta > 0 ? '+' : ''}${delta}`;
}

/** `Agility: 12 → 13`, or the half of it the author filled in. The box draws the
 *  delta beside this as its own chip, and a copy writes it in the line. */
export function statChange(stat: SystemStat): string {
  const name = stat.name.trim();
  const pair = [stat.from.trim(), stat.to.trim()].filter(Boolean).join(' → ');

  if (name && pair) return `${name}: ${pair}`;
  return name || pair;
}

/** `Agility: 12 → 13 (+1)`, as a copy writes it. */
export function statLine(stat: SystemStat): string {
  const change = statChange(stat);
  const delta = statDelta(stat.from, stat.to);

  return delta ? `${change} (${delta})` : change;
}

/** `Level 3 → 4`, or `Level 4` when only the level reached was written. */
export function levelLine(message: SystemMessage): string {
  const from = message.levelFrom.trim();
  const to = message.levelTo.trim();

  if (from && to) return `Level ${from} → ${to}`;
  if (to) return `Level ${to}`;
  if (from) return `Level ${from}`;
  return '';
}

/** The words the achievement box puts over its title. */
export const achievementBanner = 'ACHIEVEMENT UNLOCKED';

export type SystemBlock =
  | { kind: 'paragraph'; text: string; bold?: boolean }
  | { kind: 'bullets'; items: string[] };

/** The box's body as the parts both exports draw, so Markdown and HTML can never
 *  say different things. */
export function systemBlocks(message: SystemMessage): SystemBlock[] {
  const blocks: SystemBlock[] = [];

  if (message.title.trim()) {
    blocks.push({ kind: 'paragraph', text: message.title.trim(), bold: true });
  }

  if (message.kind === 'level_up') {
    const level = levelLine(message);
    if (level) blocks.push({ kind: 'paragraph', text: level, bold: true });

    if (message.points.trim()) {
      blocks.push({ kind: 'paragraph', text: `${message.points.trim()} points to place` });
    }

    const stats = message.stats.map(statLine).filter(Boolean);
    if (stats.length > 0) blocks.push({ kind: 'bullets', items: stats });
  }

  if (message.kind === 'skill') {
    if (message.rank.trim()) blocks.push({ kind: 'paragraph', text: `Rank ${message.rank.trim()}` });
    if (message.evolution.trim()) {
      blocks.push({ kind: 'paragraph', text: message.evolution.trim() });
    }
  }

  if (message.kind === 'quest') {
    blocks.push({
      kind: 'paragraph',
      text: `[${questStatusLabels[message.status]}]`,
      bold: true,
    });

    const objectives = message.objectives
      .filter(objective => objective.text.trim())
      .map(objective => `[${objective.done ? 'x' : ' '}] ${objective.text.trim()}`);

    if (objectives.length > 0) blocks.push({ kind: 'bullets', items: objectives });

    const rewards = message.rewards.map(reward => reward.trim()).filter(Boolean);
    if (rewards.length > 0) {
      blocks.push({ kind: 'paragraph', text: `Rewards: ${rewards.join('; ')}` });
    }
  }

  if (message.kind === 'achievement') {
    blocks.push({ kind: 'paragraph', text: achievementBanner, bold: true });

    const rewards = message.rewards.map(reward => reward.trim()).filter(Boolean);
    if (rewards.length > 0) {
      blocks.push({ kind: 'paragraph', text: `Rewards: ${rewards.join('; ')}` });
    }
  }

  for (const paragraph of message.body.split(/\n{2,}/)) {
    const text = paragraph.replace(/^\n+|\n+$/g, '');
    if (text.trim()) blocks.push({ kind: 'paragraph', text });
  }

  return blocks;
}

/** What a Markdown copy puts on the clipboard: the box as a blockquote, with one
 *  quoted line per line of the paragraph it belongs to. */
export function systemMessageMarkdown(message: SystemMessage): string {
  const lines: string[] = [`> **${message.header}**`];

  for (const block of systemBlocks(message)) {
    lines.push('>');

    if (block.kind === 'bullets') {
      for (const item of block.items) lines.push(`> - ${item}`);
      continue;
    }

    for (const line of block.text.split('\n')) {
      lines.push(block.bold ? `> **${line.trim()}**` : `> ${line.trim()}`);
    }
  }

  return lines.join('\n');
}

/** Text that must survive being pasted as markup: a stat line reading `<HP>` is
 *  the author's text, not the start of a tag. */
const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The same box as a real HTML blockquote, for a site whose editor takes tags. */
export function systemMessageHtml(message: SystemMessage): string {
  const lines: string[] = [
    '<blockquote>',
    `  <p><strong>${escapeHtml(message.header)}</strong></p>`,
  ];

  for (const block of systemBlocks(message)) {
    if (block.kind === 'bullets') {
      lines.push('  <ul>');
      for (const item of block.items) lines.push(`    <li>${escapeHtml(item)}</li>`);
      lines.push('  </ul>');
      continue;
    }

    const text = block.text
      .split('\n')
      .map(line => escapeHtml(line.trim()))
      .filter(Boolean)
      .join('<br />');

    lines.push(
      block.bold ? `  <p><strong>${text}</strong></p>` : `  <p>${text}</p>`
    );
  }

  lines.push('</blockquote>');

  return lines.join('\n');
}
