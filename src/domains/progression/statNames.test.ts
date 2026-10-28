import { describe, it, expect } from 'vitest';

import { findSheetStat, likelyRenamedStat, statKey } from './statNames';

const row = (stat_name: string, value = 1) => ({ stat_name, value });

describe('statKey', () => {
  it('ignores case and the spacing the author typed', () => {
    expect(statKey('  Strength  ')).toBe('strength');
    expect(statKey('Attack   Power')).toBe('attack power');
    expect(statKey('STR')).toBe('str');
  });
});

describe('findSheetStat', () => {
  const sheet = [row('strength', 12), row('Dexterity', 9)];

  it('finds a row whose spelling differs only by case', () => {
    expect(findSheetStat(sheet, 'Strength')?.value).toBe(12);
  });

  it('prefers the exact spelling when the sheet holds both', () => {
    const both = [row('Strength', 12), row('strength', 4)];

    expect(findSheetStat(both, 'strength')?.value).toBe(4);
    expect(findSheetStat(both, 'Strength')?.value).toBe(12);
  });

  it('returns nothing for a stat the sheet does not have', () => {
    expect(findSheetStat(sheet, 'Wisdom')).toBeUndefined();
  });
});

describe('likelyRenamedStat', () => {
  it('names the row an abbreviation stands for', () => {
    expect(likelyRenamedStat([row('STR')], 'Strength')).toBe('STR');
  });

  it('works the other way round, when the level-up used the abbreviation', () => {
    expect(likelyRenamedStat([row('Strength')], 'STR')).toBe('Strength');
  });

  it('names the row a typo nearly spells', () => {
    expect(likelyRenamedStat([row('Strenght')], 'Strength')).toBe('Strenght');
  });

  it('names a row the recorded name is a short form of', () => {
    expect(likelyRenamedStat([row('Strength (base)')], 'Strength')).toBe(
      'Strength (base)'
    );
  });

  it('says nothing when the sheet only re-spaced the same name', () => {
    // Not a rename at all: findSheetStat already reads this row.
    expect(likelyRenamedStat([row(' strength ')], 'Strength')).toBe(null);
  });

  it('says nothing about a genuinely different stat', () => {
    expect(likelyRenamedStat([row('Dexterity'), row('HP')], 'Strength')).toBe(
      null
    );
  });
});
