import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Character, CharacterStat } from '../shared/types';
import type { CharacterAttribute } from '../characters/types';
import { useCanvasInspector } from './useCanvasInspector';
import type { CanvasInspectorOptions } from './useCanvasInspector';

// The inspector holds one cast member's numbers, the row that is open for
// editing and the line an error would be written on. The cast arrives as an
// argument, so these tests hand it over the way the board does; every command it
// runs is mocked, so each one can be read back argument by argument.

const { charactersApi } = vi.hoisted(() => ({
  charactersApi: {
    getCharacterStats: vi.fn(),
    getCharacterAttributes: vi.fn(),
    setCharacterStat: vi.fn(),
    setCharacterAttribute: vi.fn(),
  },
}));

vi.mock('../characters/api', () => charactersApi);

function character(id: string, name: string): Character {
  return {
    id,
    story_id: 'story-1',
    name,
    description: null,
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
  };
}

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

function attribute(
  id: string,
  characterId: string,
  attrName: string,
  value: string
): CharacterAttribute {
  return {
    id,
    character_id: characterId,
    attr_name: attrName,
    value,
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
  };
}

const mira = character('ch-1', 'Mira');
const rook = character('ch-2', 'Rook');

const strength = stat('s-1', 'ch-1', 'Strength', 12, 'from the gate');
const agility = stat('s-2', 'ch-1', 'Agility', 7);
const classAttribute = attribute('at-1', 'ch-1', 'Class', 'Rogue');
const originAttribute = attribute('at-2', 'ch-1', 'Origin', 'Ashfall');

const rememberStat = vi.fn();

const board: CanvasInspectorOptions = {
  linkedCharacterId: 'ch-1',
  characters: [mira, rook],
  rememberStat,
  actor: 'author',
};

function setup(overrides: Partial<CanvasInspectorOptions> = {}) {
  const options: CanvasInspectorOptions = { ...board, ...overrides };

  return renderHook((props: CanvasInspectorOptions) => useCanvasInspector(props), {
    initialProps: options,
  });
}

// The rows come back in the order the read answered them, which is what the
// panel draws, so a save is what has to put them back in name order.
beforeEach(() => {
  vi.clearAllMocks();
  charactersApi.getCharacterStats.mockResolvedValue([strength, agility]);
  charactersApi.getCharacterAttributes.mockResolvedValue([classAttribute, originAttribute]);
  // Both commands are writes on the name rather than the id, so a save answers
  // with the row it replaced. The answer carries the same id, which is what the
  // panel uses to place it.
  charactersApi.setCharacterStat.mockImplementation(
    async (_characterId: string, statName: string, value: number, notes: string | null) =>
      stat(
        [strength, agility].find(row => row.stat_name === statName)?.id ?? `s-${statName}`,
        'ch-1',
        statName,
        value,
        notes
      )
  );
  charactersApi.setCharacterAttribute.mockImplementation(
    async (_characterId: string, attrName: string, value: string) =>
      attribute(
        [classAttribute, originAttribute].find(row => row.attr_name === attrName)?.id ??
          `at-${attrName}`,
        'ch-1',
        attrName,
        value
      )
  );
});

describe('the linked cast member', () => {
  it('resolves the link to the row it names', () => {
    const { result } = setup();

    expect(result.current.inspectorCharacter?.name).toBe('Mira');
  });

  it('is nobody when no card is linked', () => {
    const { result } = setup({ linkedCharacterId: null });

    expect(result.current.inspectorCharacter).toBeNull();
  });

  it('is nobody when the link names a cast member who is not in the list', () => {
    // A link to a member in the trash resolves to nothing rather than being
    // guessed at from the card's label.
    const { result } = setup({ linkedCharacterId: 'ch-9' });

    expect(result.current.inspectorCharacter).toBeNull();
  });

  it('follows the link when the card is relinked', () => {
    const { result, rerender } = setup();

    rerender({ ...board, linkedCharacterId: 'ch-2' });

    expect(result.current.inspectorCharacter?.name).toBe('Rook');
  });
});

describe('reading the numbers', () => {
  it("reads the linked member's stats and attributes", async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));

    expect(charactersApi.getCharacterStats).toHaveBeenCalledWith('ch-1');
    expect(charactersApi.getCharacterAttributes).toHaveBeenCalledWith('ch-1');
    expect(result.current.inspectorStats.map(row => row.stat_name)).toEqual([
      'Strength',
      'Agility',
    ]);
    expect(result.current.inspectorAttributes.map(row => row.attr_name)).toEqual([
      'Class',
      'Origin',
    ]);
  });

  it('asks for nothing while no card is linked', () => {
    const { result } = setup({ linkedCharacterId: null });

    expect(charactersApi.getCharacterStats).not.toHaveBeenCalled();
    expect(charactersApi.getCharacterAttributes).not.toHaveBeenCalled();
    expect(result.current.inspectorStats).toEqual([]);
    expect(result.current.inspectorAttributes).toEqual([]);
  });

  it('reads the other member when the card is relinked', async () => {
    const { rerender } = setup();

    await waitFor(() => expect(charactersApi.getCharacterStats).toHaveBeenCalledWith('ch-1'));
    charactersApi.getCharacterStats.mockResolvedValue([stat('s-3', 'ch-2', 'Luck', 3)]);

    rerender({ ...board, linkedCharacterId: 'ch-2' });

    await waitFor(() => expect(charactersApi.getCharacterStats).toHaveBeenCalledWith('ch-2'));
  });

  it('closes the open rows when the card is closed', async () => {
    const { result, rerender } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));
    act(() => result.current.startInspectorStat(strength));
    act(() => result.current.startInspectorAttribute(classAttribute));
    expect(result.current.inspectorStatId).toBe('s-1');
    expect(result.current.inspectorAttrId).toBe('at-1');

    // Closing the card drops the rows, so nothing is left half open behind it.
    rerender({ ...board, linkedCharacterId: null });

    expect(result.current.inspectorStatId).toBeNull();
    expect(result.current.inspectorAttrId).toBeNull();
    expect(result.current.inspectorStats).toEqual([]);
    expect(result.current.inspectorAttributes).toEqual([]);
  });

  it('drops an answer that arrives after the card was closed', async () => {
    let release: (rows: CharacterStat[]) => void = () => {};
    charactersApi.getCharacterStats.mockImplementation(
      () =>
        new Promise<CharacterStat[]>(resolve => {
          release = resolve;
        })
    );
    const { result, rerender } = setup();

    rerender({ ...board, linkedCharacterId: null });
    await act(async () => {
      release([strength]);
    });

    expect(result.current.inspectorStats).toEqual([]);
  });

  it('says why a read failed, and keeps the rows it had', async () => {
    const { result, rerender } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));
    charactersApi.getCharacterStats.mockRejectedValue('the sheet is locked');

    rerender({ ...board, linkedCharacterId: 'ch-2' });

    await waitFor(() =>
      expect(result.current.inspectorError).toBe(
        'Could not load the cast member: the sheet is locked'
      )
    );
    expect(result.current.inspectorStats).toHaveLength(2);
  });

  it('clears the message when a read lands', async () => {
    charactersApi.getCharacterStats.mockRejectedValueOnce('the sheet is locked');
    const { result, rerender } = setup();

    await waitFor(() => expect(result.current.inspectorError).not.toBeNull());

    // The next read answers, so the line it was complaining on is cleared.
    rerender({ ...board, linkedCharacterId: 'ch-2' });

    await waitFor(() => expect(result.current.inspectorError).toBeNull());
  });
});

describe('editing a stat', () => {
  it('opens the row on its own value', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));
    act(() => result.current.startInspectorStat(strength));

    expect(result.current.inspectorStatId).toBe('s-1');
    expect(result.current.inspectorStatValue).toBe('12');
  });

  it('clears the message when a row is opened', async () => {
    const { result } = setup();

    act(() => result.current.reportInspectorError('Could not link the cast member: no'));
    act(() => result.current.startInspectorStat(strength));

    expect(result.current.inspectorError).toBeNull();
  });

  it("writes through the sheet's own command, notes and all", async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));
    act(() => result.current.startInspectorStat(strength));
    act(() => result.current.setInspectorStatValue('13'));
    await act(async () => {
      await result.current.saveInspectorStat(strength);
    });

    // The same command the Characters tab runs, with the notes passed back
    // rather than cleared.
    expect(charactersApi.setCharacterStat).toHaveBeenCalledWith(
      'ch-1',
      'Strength',
      13,
      'from the gate',
      'author'
    );
  });

  it('replaces the row it wrote and keeps the list in name order', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));
    act(() => result.current.startInspectorStat(agility));
    act(() => result.current.setInspectorStatValue('9'));
    await act(async () => {
      await result.current.saveInspectorStat(agility);
    });

    // Luck sorts before Strength, so the new row is placed rather than appended.
    expect(result.current.inspectorStats.map(row => row.stat_name)).toEqual([
      'Agility',
      'Strength',
    ]);
    expect(result.current.inspectorStats[0].value).toBe(9);
  });

  it('truncates a value typed as a fraction', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));
    act(() => result.current.startInspectorStat(strength));
    act(() => result.current.setInspectorStatValue('13.7'));
    await act(async () => {
      await result.current.saveInspectorStat(strength);
    });

    expect(charactersApi.setCharacterStat).toHaveBeenCalledWith(
      'ch-1',
      'Strength',
      13,
      'from the gate',
      'author'
    );
  });

  it('closes the row once it is saved', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));
    act(() => result.current.startInspectorStat(strength));
    act(() => result.current.setInspectorStatValue('13'));
    await act(async () => {
      await result.current.saveInspectorStat(strength);
    });

    expect(result.current.inspectorStatId).toBeNull();
    expect(result.current.inspectorError).toBeNull();
  });

  it('hands the saved row to the story-wide badges', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));
    act(() => result.current.startInspectorStat(strength));
    act(() => result.current.setInspectorStatValue('13'));
    await act(async () => {
      await result.current.saveInspectorStat(strength);
    });

    expect(rememberStat).toHaveBeenCalledWith(
      expect.objectContaining({ stat_name: 'Strength', value: 13 })
    );
  });

  it('refuses a value that is not a number', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));
    act(() => result.current.startInspectorStat(strength));
    act(() => result.current.setInspectorStatValue('strong'));
    await act(async () => {
      await result.current.saveInspectorStat(strength);
    });

    expect(result.current.inspectorError).toBe('A stat value has to be a number.');
    expect(charactersApi.setCharacterStat).not.toHaveBeenCalled();
    expect(result.current.inspectorStatId).toBe('s-1');
  });

  it('refuses a value that was cleared', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));
    act(() => result.current.startInspectorStat(strength));
    act(() => result.current.setInspectorStatValue('  '));
    await act(async () => {
      await result.current.saveInspectorStat(strength);
    });

    expect(result.current.inspectorError).toBe('A stat value has to be a number.');
    expect(charactersApi.setCharacterStat).not.toHaveBeenCalled();
  });

  it('says why a save failed, and leaves the row open', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorStats).toHaveLength(2));
    charactersApi.setCharacterStat.mockRejectedValue('the ledger is locked');
    act(() => result.current.startInspectorStat(strength));
    act(() => result.current.setInspectorStatValue('13'));
    await act(async () => {
      await result.current.saveInspectorStat(strength);
    });

    expect(result.current.inspectorError).toBe('Could not save stat: the ledger is locked');
    expect(result.current.inspectorStatId).toBe('s-1');
  });

  it('writes nothing while no card is linked', async () => {
    const { result } = setup({ linkedCharacterId: null });

    act(() => result.current.startInspectorStat(strength));
    act(() => result.current.setInspectorStatValue('13'));
    await act(async () => {
      await result.current.saveInspectorStat(strength);
    });

    expect(charactersApi.setCharacterStat).not.toHaveBeenCalled();
  });
});

describe('editing an attribute', () => {
  it('opens the row on its own value', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorAttributes).toHaveLength(2));
    act(() => result.current.startInspectorAttribute(classAttribute));

    expect(result.current.inspectorAttrId).toBe('at-1');
    expect(result.current.inspectorAttrValue).toBe('Rogue');
  });

  it("writes the trimmed value through the sheet's own command", async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorAttributes).toHaveLength(2));
    act(() => result.current.startInspectorAttribute(classAttribute));
    act(() => result.current.setInspectorAttrValue('  Mage  '));
    await act(async () => {
      await result.current.saveInspectorAttribute(classAttribute);
    });

    expect(charactersApi.setCharacterAttribute).toHaveBeenCalledWith(
      'ch-1',
      'Class',
      'Mage',
      'author'
    );
  });

  it('replaces the row and keeps the list in name order', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorAttributes).toHaveLength(2));
    act(() => result.current.startInspectorAttribute(originAttribute));
    act(() => result.current.setInspectorAttrValue('Zaneth'));
    await act(async () => {
      await result.current.saveInspectorAttribute(originAttribute);
    });

    expect(result.current.inspectorAttributes.map(row => row.value)).toEqual(['Rogue', 'Zaneth']);
    expect(result.current.inspectorAttrId).toBeNull();
  });

  it('refuses a value that was cleared, and says where to delete it', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorAttributes).toHaveLength(2));
    act(() => result.current.startInspectorAttribute(classAttribute));
    act(() => result.current.setInspectorAttrValue('   '));
    await act(async () => {
      await result.current.saveInspectorAttribute(classAttribute);
    });

    expect(result.current.inspectorError).toBe(
      'An attribute needs a value — delete it on the Characters tab to remove it.'
    );
    expect(charactersApi.setCharacterAttribute).not.toHaveBeenCalled();
  });

  it('clears the message when a row is opened', async () => {
    const { result } = setup();

    act(() => result.current.reportInspectorError('Could not rename the node: no'));
    act(() => result.current.startInspectorAttribute(classAttribute));

    expect(result.current.inspectorError).toBeNull();
  });

  it('says why a save failed, and leaves the row open', async () => {
    const { result } = setup();

    await waitFor(() => expect(result.current.inspectorAttributes).toHaveLength(2));
    charactersApi.setCharacterAttribute.mockRejectedValue('the sheet is locked');
    act(() => result.current.startInspectorAttribute(classAttribute));
    act(() => result.current.setInspectorAttrValue('Mage'));
    await act(async () => {
      await result.current.saveInspectorAttribute(classAttribute);
    });

    expect(result.current.inspectorError).toBe('Could not save attribute: the sheet is locked');
    expect(result.current.inspectorAttrId).toBe('at-1');
  });

  it('writes nothing while no card is linked', async () => {
    const { result } = setup({ linkedCharacterId: null });

    act(() => result.current.startInspectorAttribute(classAttribute));
    act(() => result.current.setInspectorAttrValue('Mage'));
    await act(async () => {
      await result.current.saveInspectorAttribute(classAttribute);
    });

    expect(charactersApi.setCharacterAttribute).not.toHaveBeenCalled();
  });
});

describe('the line an error is written on', () => {
  it('takes a message from the relink and the rename', () => {
    const { result } = setup();

    act(() => result.current.reportInspectorError('Could not link the cast member: no such row'));

    expect(result.current.inspectorError).toBe('Could not link the cast member: no such row');
  });

  it('can be cleared again', () => {
    const { result } = setup();

    act(() => result.current.reportInspectorError('Could not rename the node: no'));
    act(() => result.current.reportInspectorError(null));

    expect(result.current.inspectorError).toBeNull();
  });
});
