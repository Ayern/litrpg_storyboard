import { describe, expect, it } from 'vitest';

import {
  levelLine,
  serializeSystemMessage,
  statDelta,
  statLine,
  systemBlocks,
  systemMessageHtml,
  systemMessageMarkdown,
  systemMessageOf,
} from './systemMessage';

// A system card keeps the two fields every card has — the label is the box's
// header, the notes are the message — and the message is written in a small line
// format the fields edit. These tests hold the format, what a card written before
// it reads as, and the two exports an author pastes into a web editor.

const levelUp = [
  'Type: level_up',
  'Title: The Tide Advances',
  'Level: 3 → 4',
  'Points: 2',
  'Stat: Agility | 12 → 13',
  'Stat: Insight | 15 → 16',
  '---',
  'The ledger remembers.',
].join('\n');

describe('reading a card', () => {
  it('reads a card written before the format as a notice', () => {
    const message = systemMessageOf('Level Up', 'Level 4\n\n+2 to place');

    expect(message.kind).toBe('notice');
    expect(message.title).toBe('Level 4');
    expect(message.body).toBe('+2 to place');
    expect(message.header).toBe('Level Up');
  });

  it('gives a card with nothing written yet a header to draw', () => {
    expect(systemMessageOf('', null)).toMatchObject({
      kind: 'notice',
      header: 'SYSTEM',
      title: '',
      body: '',
    });
  });

  it('reads every field of a level-up box', () => {
    const message = systemMessageOf('The Tidal Ledger', levelUp);

    expect(message.kind).toBe('level_up');
    expect(message.title).toBe('The Tide Advances');
    expect(message.levelFrom).toBe('3');
    expect(message.levelTo).toBe('4');
    expect(message.points).toBe('2');
    expect(message.stats).toEqual([
      { name: 'Agility', from: '12', to: '13' },
      { name: 'Insight', from: '15', to: '16' },
    ]);
    expect(message.body).toBe('The ledger remembers.');
  });

  it('takes a plain arrow and a stat whose name was left off', () => {
    const message = systemMessageOf(
      'Level Up',
      ['Type: level_up', 'Level: 3 -> 4', 'Stat: 12 -> 13'].join('\n')
    );

    expect(message.levelFrom).toBe('3');
    expect(message.levelTo).toBe('4');
    expect(message.stats).toEqual([{ name: '', from: '12', to: '13' }]);
  });

  it('reads a quest with its objectives and rewards', () => {
    const message = systemMessageOf(
      'Level Up',
      [
        'Type: quest',
        'Title: The Drowned Stair',
        'Status: complete',
        'Objective: [x] Reach the Drowned Stair',
        'Objective: [ ] Retrieve the Bell Clapper',
        'Reward: 400 XP',
        'Reward: +10 Faction Standing (Salt Choir)',
      ].join('\n')
    );

    expect(message.kind).toBe('quest');
    expect(message.status).toBe('complete');
    expect(message.objectives).toEqual([
      { text: 'Reach the Drowned Stair', done: true },
      { text: 'Retrieve the Bell Clapper', done: false },
    ]);
    expect(message.rewards).toEqual(['400 XP', '+10 Faction Standing (Salt Choir)']);
  });

  it('keeps a line the format does not name as the author’s own text', () => {
    const message = systemMessageOf(
      'System',
      ['Type: notice', 'Title: The Tide', 'The water is rising.', 'Body-ish: not a field'].join(
        '\n'
      )
    );

    expect(message.body).toBe('The water is rising.\nBody-ish: not a field');
  });

  it('ignores a type it does not know rather than losing the card', () => {
    const message = systemMessageOf('System', ['Type: boss_fight', 'Title: The Tide'].join('\n'));

    expect(message.kind).toBe('notice');
    expect(message.title).toBe('The Tide');
  });
});

describe('writing a card', () => {
  it('writes the format it reads, so a save changes nothing', () => {
    expect(serializeSystemMessage(systemMessageOf('The Tidal Ledger', levelUp))).toBe(levelUp);
  });

  it('keeps the half of a move that is typed, so the other box stays empty', () => {
    const typedFrom = {
      ...systemMessageOf('System', null),
      kind: 'level_up' as const,
      levelFrom: '3',
    };

    expect(serializeSystemMessage(typedFrom)).toBe('Type: level_up\nLevel: 3 →');
    expect(systemMessageOf('System', serializeSystemMessage(typedFrom))).toMatchObject({
      levelFrom: '3',
      levelTo: '',
    });

    const typedStat = {
      ...systemMessageOf('System', null),
      kind: 'level_up' as const,
      stats: [{ name: 'Agility', from: '', to: '13' }],
    };

    expect(serializeSystemMessage(typedStat)).toBe('Type: level_up\nStat: Agility | → 13');
    expect(systemMessageOf('System', serializeSystemMessage(typedStat)).stats).toEqual([
      { name: 'Agility', from: '', to: '13' },
    ]);
  });

  it('leaves a notice with nothing written blank', () => {
    expect(serializeSystemMessage(systemMessageOf('Level Up', null))).toBe('');
  });

  it('keeps the type of a box whose fields are still empty', () => {
    const message = { ...systemMessageOf('System', null), kind: 'quest' as const };

    expect(serializeSystemMessage(message)).toBe('Type: quest\nStatus: accepted');
  });

  it('writes a quest’s objectives with their ticks', () => {
    const message = {
      ...systemMessageOf('System', null),
      kind: 'quest' as const,
      title: 'The Drowned Stair',
      status: 'accepted' as const,
      objectives: [
        { text: 'Reach the Drowned Stair', done: true },
        { text: 'Retrieve the Bell Clapper', done: false },
      ],
      rewards: ['400 XP'],
    };

    expect(serializeSystemMessage(message)).toBe(
      [
        'Type: quest',
        'Title: The Drowned Stair',
        'Status: accepted',
        'Objective: [x] Reach the Drowned Stair',
        'Objective: [ ] Retrieve the Bell Clapper',
        'Reward: 400 XP',
      ].join('\n')
    );
  });
});

describe('the numbers in a box', () => {
  it('says how far a stat moved', () => {
    expect(statDelta('12', '13')).toBe('+1');
    expect(statDelta('15', '12')).toBe('-3');
    expect(statDelta('12', '12')).toBe('');
    expect(statDelta('12', '')).toBe('');
    expect(statDelta('high', '13')).toBe('');
  });

  it('writes a stat as a reader wants it', () => {
    expect(statLine({ name: 'Agility', from: '12', to: '13' })).toBe('Agility: 12 → 13 (+1)');
    expect(statLine({ name: '', from: '', to: '13' })).toBe('13');
    expect(statLine({ name: 'Luck', from: '', to: '' })).toBe('Luck');
  });

  it('writes the level that moved', () => {
    const base = systemMessageOf('System', null);

    expect(levelLine({ ...base, levelFrom: '3', levelTo: '4' })).toBe('Level 3 → 4');
    expect(levelLine({ ...base, levelTo: '4' })).toBe('Level 4');
    expect(levelLine(base)).toBe('');
  });
});

describe('copying a box as Markdown', () => {
  it('writes a level-up with its line, its points and its stats', () => {
    expect(systemMessageMarkdown(systemMessageOf('The Tidal Ledger', levelUp))).toBe(
      [
        '> **The Tidal Ledger**',
        '>',
        '> **The Tide Advances**',
        '>',
        '> **Level 3 → 4**',
        '>',
        '> 2 points to place',
        '>',
        '> - Agility: 12 → 13 (+1)',
        '> - Insight: 15 → 16 (+1)',
        '>',
        '> The ledger remembers.',
      ].join('\n')
    );
  });

  it('writes a quest’s banner, its objectives and its rewards', () => {
    const message = systemMessageOf(
      '[QUEST OFFER]',
      [
        'Type: quest',
        'Title: The Drowned Stair',
        'Status: accepted',
        'Objective: [x] Reach the Drowned Stair',
        'Objective: [ ] Retrieve the Bell Clapper',
        'Reward: 400 XP',
        'Reward: +10 Faction Standing (Salt Choir)',
      ].join('\n')
    );

    expect(systemMessageMarkdown(message)).toBe(
      [
        '> **[QUEST OFFER]**',
        '>',
        '> **The Drowned Stair**',
        '>',
        '> **[QUEST ACCEPTED]**',
        '>',
        '> - [x] Reach the Drowned Stair',
        '> - [ ] Retrieve the Bell Clapper',
        '>',
        '> Rewards: 400 XP; +10 Faction Standing (Salt Choir)',
      ].join('\n')
    );
  });

  it('writes a skill’s rank and what it grew out of', () => {
    const message = systemMessageOf(
      '[SKILL]',
      [
        'Type: skill',
        'Title: [Ember Step]',
        'Rank: 2 (Evolved)',
        'Evolution: Evolved from [Spark Step] via Deep Water immersion',
      ].join('\n')
    );

    expect(systemMessageMarkdown(message)).toBe(
      [
        '> **[SKILL]**',
        '>',
        '> **[Ember Step]**',
        '>',
        '> Rank 2 (Evolved)',
        '>',
        '> Evolved from [Spark Step] via Deep Water immersion',
      ].join('\n')
    );
  });

  it('writes an achievement with its banner and reward', () => {
    const message = systemMessageOf(
      '[ACHIEVEMENT]',
      ['Type: achievement', 'Title: First Blood', 'Reward: +1 Feat point'].join('\n')
    );

    expect(systemMessageMarkdown(message)).toBe(
      [
        '> **[ACHIEVEMENT]**',
        '>',
        '> **First Blood**',
        '>',
        '> **ACHIEVEMENT UNLOCKED**',
        '>',
        '> Rewards: +1 Feat point',
      ].join('\n')
    );
  });

  it('keeps a notice’s body as quoted paragraphs', () => {
    const message = systemMessageOf('Level Up', 'Level 4\n\nFirst.\nSecond.\n\nThird.');

    expect(systemMessageMarkdown(message)).toBe(
      [
        '> **Level Up**',
        '>',
        '> **Level 4**',
        '>',
        '> First.',
        '> Second.',
        '>',
        '> Third.',
      ].join('\n')
    );
  });
});

describe('copying a box as HTML', () => {
  it('writes a level-up with the stats as a list', () => {
    expect(systemMessageHtml(systemMessageOf('The Tidal Ledger', levelUp))).toBe(
      [
        '<blockquote>',
        '  <p><strong>The Tidal Ledger</strong></p>',
        '  <p><strong>The Tide Advances</strong></p>',
        '  <p><strong>Level 3 → 4</strong></p>',
        '  <p>2 points to place</p>',
        '  <ul>',
        '    <li>Agility: 12 → 13 (+1)</li>',
        '    <li>Insight: 15 → 16 (+1)</li>',
        '  </ul>',
        '  <p>The ledger remembers.</p>',
        '</blockquote>',
      ].join('\n')
    );
  });

  it('writes a quest’s objectives as list items', () => {
    const message = systemMessageOf(
      '[QUEST COMPLETE]',
      [
        'Type: quest',
        'Title: The Drowned Stair',
        'Status: complete',
        'Objective: [x] Retrieve the Bell Clapper',
        'Reward: 400 XP',
      ].join('\n')
    );

    expect(systemMessageHtml(message)).toBe(
      [
        '<blockquote>',
        '  <p><strong>[QUEST COMPLETE]</strong></p>',
        '  <p><strong>The Drowned Stair</strong></p>',
        '  <p><strong>[QUEST COMPLETE]</strong></p>',
        '  <ul>',
        '    <li>[x] Retrieve the Bell Clapper</li>',
        '  </ul>',
        '  <p>Rewards: 400 XP</p>',
        '</blockquote>',
      ].join('\n')
    );
  });

  it('pastes a stat line as text when it looks like a tag', () => {
    const message = {
      ...systemMessageOf('<Tidal Ledger>', null),
      kind: 'level_up' as const,
      title: 'HP & MP',
      levelFrom: '1',
      levelTo: '2',
      stats: [{ name: '<HP>', from: '30', to: '40' }],
    };

    expect(systemMessageHtml(message)).toBe(
      [
        '<blockquote>',
        '  <p><strong>&lt;Tidal Ledger&gt;</strong></p>',
        '  <p><strong>HP &amp; MP</strong></p>',
        '  <p><strong>Level 1 → 2</strong></p>',
        '  <ul>',
        '    <li>&lt;HP&gt;: 30 → 40 (+10)</li>',
        '  </ul>',
        '</blockquote>',
      ].join('\n')
    );
  });
});

describe('the parts a box is made of', () => {
  it('puts a blank line in the body in its own paragraph', () => {
    const blocks = systemBlocks(
      systemMessageOf('Level Up', 'Level 4\n\nOne.\nTwo.\n\nThree.')
    );

    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Level 4', bold: true },
      { kind: 'paragraph', text: 'One.\nTwo.' },
      { kind: 'paragraph', text: 'Three.' },
    ]);
  });
});
