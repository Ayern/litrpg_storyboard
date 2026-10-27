import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { CharacterStat } from '../shared/types';
import { useSheetStats } from './useSheetStats';
import type { SheetStatsOptions } from './useSheetStats';

// The sheet's stat section holds the two fields of its new-stat form, the one
// row open for editing with that row's value and notes, and the two writes
// behind them. Whose sheet is open arrives as an argument, because the app owns
// the list the load filled; each write runs the command the sheet has always
// run, and the row that comes back leaves on one callback, because a saved stat
// has two places to go.

const { charactersApi } = vi.hoisted(() => ({
  charactersApi: { setCharacterStat: vi.fn() },
}));

vi.mock('../characters/api', () => charactersApi);

function stat(
  id: string,
  characterId: string,
  statName: string,
  value: number,
  notes: string | null = null
): CharacterStat {
  return {
    id,
    character_id: characterId,
    stat_name: statName,
    value,
    notes,
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
  };
}

const strength = stat('s-1', 'ch-1', 'Strength', 12, 'from the gate');
const agility = stat('s-2', 'ch-1', 'Agility', 7);

const onStatWritten = vi.fn();
const reportError = vi.fn();

const sheet: SheetStatsOptions = {
  characterId: 'ch-1',
  onStatWritten,
  reportError,
  actor: 'author',
};

function setup(overrides: Partial<SheetStatsOptions> = {}) {
  const options: SheetStatsOptions = { ...sheet, ...overrides };

  return renderHook((props: SheetStatsOptions) => useSheetStats(props), { initialProps: options });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The command is a write on the name rather than the id: setting a stat that
  // already exists updates the row and answers with it.
  charactersApi.setCharacterStat.mockImplementation(
    async (characterId: string, statName: string, value: number, notes: string | null) => {
      const existing = [strength, agility].find(row => row.stat_name === statName);

      return stat(existing?.id ?? `s-${statName}`, characterId, statName, value, notes);
    }
  );
});

describe('the new-stat form', () => {
  it('starts blank', () => {
    const { result } = setup();

    expect(result.current.newStatName).toBe('');
    expect(result.current.newStatValue).toBe('');
  });

  it('holds the name and the value as they are typed', () => {
    const { result } = setup();

    act(() => result.current.setNewStatName('Strength'));
    act(() => result.current.setNewStatValue('13'));

    expect(result.current.newStatName).toBe('Strength');
    expect(result.current.newStatValue).toBe('13');
  });

  it("adds the stat through the sheet's own command", async () => {
    const { result } = setup();

    act(() => result.current.setNewStatName('Strength'));
    act(() => result.current.setNewStatValue('13'));
    await act(async () => {
      await result.current.addStat();
    });

    // The name is trimmed, and a stat added from the form carries no notes.
    expect(charactersApi.setCharacterStat).toHaveBeenCalledWith(
      'ch-1',
      'Strength',
      13,
      null,
      'author'
    );
  });

  it('trims the name before it writes', async () => {
    const { result } = setup();

    act(() => result.current.setNewStatName('  Strength  '));
    await act(async () => {
      await result.current.addStat();
    });

    expect(charactersApi.setCharacterStat).toHaveBeenCalledWith(
      'ch-1',
      'Strength',
      0,
      null,
      'author'
    );
  });

  it('reads an empty value as zero', async () => {
    const { result } = setup();

    act(() => result.current.setNewStatName('Luck'));
    act(() => result.current.setNewStatValue('   '));
    await act(async () => {
      await result.current.addStat();
    });

    expect(charactersApi.setCharacterStat).toHaveBeenCalledWith(
      'ch-1',
      'Luck',
      0,
      null,
      'author'
    );
  });

  it('truncates a value typed as a fraction', async () => {
    const { result } = setup();

    act(() => result.current.setNewStatName('Luck'));
    act(() => result.current.setNewStatValue('13.7'));
    await act(async () => {
      await result.current.addStat();
    });

    expect(charactersApi.setCharacterStat).toHaveBeenCalledWith(
      'ch-1',
      'Luck',
      13,
      null,
      'author'
    );
  });

  it('refuses a value that is not a number', async () => {
    const { result } = setup();

    act(() => result.current.setNewStatName('Luck'));
    act(() => result.current.setNewStatValue('plenty'));
    await act(async () => {
      await result.current.addStat();
    });

    expect(reportError).toHaveBeenLastCalledWith('A stat value has to be a number.');
    expect(charactersApi.setCharacterStat).not.toHaveBeenCalled();
  });

  it('clears the message before it writes', async () => {
    const { result } = setup();

    act(() => result.current.setNewStatName('Luck'));
    await act(async () => {
      await result.current.addStat();
    });

    expect(reportError).toHaveBeenCalledWith(null);
  });

  it('empties the form once the stat is added', async () => {
    const { result } = setup();

    act(() => result.current.setNewStatName('Luck'));
    act(() => result.current.setNewStatValue('4'));
    await act(async () => {
      await result.current.addStat();
    });

    expect(result.current.newStatName).toBe('');
    expect(result.current.newStatValue).toBe('');
  });

  it('hands the saved row back on the one callback', async () => {
    const { result } = setup();

    act(() => result.current.setNewStatName('Agility'));
    act(() => result.current.setNewStatValue('9'));
    await act(async () => {
      await result.current.addStat();
    });

    // Setting a stat that already exists answers with the row it replaced, which
    // is what the list merges by.
    expect(onStatWritten).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-2', stat_name: 'Agility', value: 9 })
    );
  });

  it('says why an add failed, and keeps what was typed', async () => {
    const { result } = setup();

    charactersApi.setCharacterStat.mockRejectedValue('the ledger is locked');
    act(() => result.current.setNewStatName('Luck'));
    act(() => result.current.setNewStatValue('4'));
    await act(async () => {
      await result.current.addStat();
    });

    expect(reportError).toHaveBeenLastCalledWith('Could not add stat: the ledger is locked');
    expect(result.current.newStatName).toBe('Luck');
    expect(result.current.newStatValue).toBe('4');
    expect(onStatWritten).not.toHaveBeenCalled();
  });

  it('writes nothing while no cast member is open', async () => {
    const { result } = setup({ characterId: null });

    act(() => result.current.setNewStatName('Luck'));
    await act(async () => {
      await result.current.addStat();
    });

    expect(charactersApi.setCharacterStat).not.toHaveBeenCalled();
  });

  it('writes nothing while the name is blank', async () => {
    const { result } = setup();

    act(() => result.current.setNewStatValue('4'));
    await act(async () => {
      await result.current.addStat();
    });

    expect(charactersApi.setCharacterStat).not.toHaveBeenCalled();
  });
});

describe('the one row that is open', () => {
  it('opens a row on its own value and notes', () => {
    const { result } = setup();

    act(() => result.current.startStatEdit(strength));

    expect(result.current.editingStatId).toBe('s-1');
    expect(result.current.statValueDraft).toBe('12');
    expect(result.current.statNotesDraft).toBe('from the gate');
  });

  it('opens a row with no notes on an empty notes field', () => {
    const { result } = setup();

    act(() => result.current.startStatEdit(agility));

    expect(result.current.statNotesDraft).toBe('');
  });

  it('closes the row again', () => {
    const { result } = setup();

    act(() => result.current.startStatEdit(strength));
    act(() => result.current.setEditingStatId(null));

    expect(result.current.editingStatId).toBeNull();
  });

  it('clears the message before it writes', async () => {
    const { result } = setup();

    act(() => result.current.startStatEdit(strength));
    act(() => result.current.setStatValueDraft('13'));
    await act(async () => {
      await result.current.saveStat(strength);
    });

    expect(reportError).toHaveBeenCalledWith(null);
  });

  it("saves the typed value and notes through the sheet's own command", async () => {
    const { result } = setup();

    act(() => result.current.startStatEdit(strength));
    act(() => result.current.setStatValueDraft('13'));
    act(() => result.current.setStatNotesDraft('  earned at the gate  '));
    await act(async () => {
      await result.current.saveStat(strength);
    });

    expect(charactersApi.setCharacterStat).toHaveBeenCalledWith(
      'ch-1',
      'Strength',
      13,
      'earned at the gate',
      'author'
    );
  });

  it('truncates a value typed as a fraction', async () => {
    const { result } = setup();

    act(() => result.current.startStatEdit(strength));
    act(() => result.current.setStatValueDraft('12.8'));
    await act(async () => {
      await result.current.saveStat(strength);
    });

    expect(charactersApi.setCharacterStat).toHaveBeenCalledWith(
      'ch-1',
      'Strength',
      12,
      'from the gate',
      'author'
    );
  });

  it('passes null for notes that were cleared', async () => {
    const { result } = setup();

    act(() => result.current.startStatEdit(strength));
    act(() => result.current.setStatNotesDraft('   '));
    await act(async () => {
      await result.current.saveStat(strength);
    });

    expect(charactersApi.setCharacterStat).toHaveBeenCalledWith(
      'ch-1',
      'Strength',
      12,
      null,
      'author'
    );
  });

  it('closes the row once it is saved', async () => {
    const { result } = setup();

    act(() => result.current.startStatEdit(strength));
    act(() => result.current.setStatValueDraft('13'));
    await act(async () => {
      await result.current.saveStat(strength);
    });

    expect(result.current.editingStatId).toBeNull();
  });

  it('hands the saved row back on the one callback', async () => {
    const { result } = setup();

    act(() => result.current.startStatEdit(strength));
    act(() => result.current.setStatValueDraft('13'));
    await act(async () => {
      await result.current.saveStat(strength);
    });

    expect(onStatWritten).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-1', stat_name: 'Strength', value: 13 })
    );
  });

  it('writes against the row it was handed', async () => {
    const { result } = setup({ characterId: 'ch-9' });

    act(() => result.current.startStatEdit(strength));
    act(() => result.current.setStatValueDraft('13'));
    await act(async () => {
      await result.current.saveStat(strength);
    });

    // A row knows the cast member it belongs to, so the sheet moving on does not
    // move the write with it.
    expect(charactersApi.setCharacterStat).toHaveBeenCalledWith(
      'ch-1',
      'Strength',
      13,
      'from the gate',
      'author'
    );
  });

  it('refuses a value that was cleared', async () => {
    const { result } = setup();

    act(() => result.current.startStatEdit(strength));
    act(() => result.current.setStatValueDraft('   '));
    await act(async () => {
      await result.current.saveStat(strength);
    });

    expect(reportError).toHaveBeenLastCalledWith('A stat value has to be a number.');
    expect(charactersApi.setCharacterStat).not.toHaveBeenCalled();
    expect(result.current.editingStatId).toBe('s-1');
  });

  it('refuses a value that is not a number', async () => {
    const { result } = setup();

    act(() => result.current.startStatEdit(strength));
    act(() => result.current.setStatValueDraft('strong'));
    await act(async () => {
      await result.current.saveStat(strength);
    });

    expect(reportError).toHaveBeenLastCalledWith('A stat value has to be a number.');
    expect(charactersApi.setCharacterStat).not.toHaveBeenCalled();
  });

  it('says why a save failed, and leaves the row open', async () => {
    const { result } = setup();

    charactersApi.setCharacterStat.mockRejectedValue('the ledger is locked');
    act(() => result.current.startStatEdit(strength));
    act(() => result.current.setStatValueDraft('13'));
    await act(async () => {
      await result.current.saveStat(strength);
    });

    expect(reportError).toHaveBeenLastCalledWith('Could not save stat: the ledger is locked');
    expect(result.current.editingStatId).toBe('s-1');
    expect(onStatWritten).not.toHaveBeenCalled();
  });
});
