import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CharacterSkill } from '../shared/types';
import { useSkillHolderForm } from './useSkillHolderForm';
import type { SkillHolderFormOptions } from './useSkillHolderForm';

// The form a skill card adds a holder with: the character who learns it, and the
// rank and chapter that are that holder's own facts rather than the card's. The
// card arrives as an argument, because the canvas owns the board; the row the
// write answers with leaves on one callback, because the canvas and the open
// sheet both list skills.

const { skillsApi } = vi.hoisted(() => ({ skillsApi: { addSkill: vi.fn() } }));

vi.mock('../skills/api', () => skillsApi);

function skill(
  id: string,
  characterId: string,
  name: string,
  rank: string | null,
  effect: string | null,
  chapterId: string | null,
  nodeId: string | null
): CharacterSkill {
  return {
    id,
    character_id: characterId,
    name,
    rank,
    effect,
    chapter_id: chapterId,
    node_id: nodeId,
    created_at: '2026-10-23T09:00:00Z',
    updated_at: '2026-10-23T09:00:00Z',
  };
}

// The card the drawer is showing: a saved skill card with notes on it.
const fireball = { id: 'n-1', label: 'Fireball', content: 'Burns for three rounds' };
const nameless = { id: 'n-2', label: '   ', content: null };

const onHolderAdded = vi.fn();

const drawer: SkillHolderFormOptions = {
  card: fireball,
  onHolderAdded,
  actor: 'author',
};

function setup(overrides: Partial<SkillHolderFormOptions> = {}) {
  const options: SkillHolderFormOptions = { ...drawer, ...overrides };

  return renderHook((props: SkillHolderFormOptions) => useSkillHolderForm(props), {
    initialProps: options,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  skillsApi.addSkill.mockImplementation(
    async (
      characterId: string,
      name: string,
      rank: string | null,
      effect: string | null,
      chapterId: string | null,
      nodeId: string | null
    ) => skill('sk-1', characterId, name, rank, effect, chapterId, nodeId)
  );
});

describe('the three answers', () => {
  it('starts blank', () => {
    const { result } = setup();

    expect(result.current.skillHolderCharacterId).toBe('');
    expect(result.current.skillHolderRank).toBe('');
    expect(result.current.skillHolderChapterId).toBe('');
    expect(result.current.skillHolderError).toBeNull();
    expect(result.current.savingSkillHolder).toBe(false);
  });

  it('holds the character, rank and chapter as they are chosen', () => {
    const { result } = setup();

    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    act(() => result.current.setSkillHolderRank('Apprentice'));
    act(() => result.current.setSkillHolderChapterId('c-1'));

    expect(result.current.skillHolderCharacterId).toBe('ch-2');
    expect(result.current.skillHolderRank).toBe('Apprentice');
    expect(result.current.skillHolderChapterId).toBe('c-1');
  });

  it('takes a message from the card and clears it again', () => {
    const { result } = setup();

    act(() => result.current.setSkillHolderError('Rook is full'));
    expect(result.current.skillHolderError).toBe('Rook is full');

    act(() => result.current.setSkillHolderError(null));
    expect(result.current.skillHolderError).toBeNull();
  });
});

describe('adding a holder', () => {
  it("copies the card's name and notes onto the chosen character's sheet", async () => {
    const { result } = setup();

    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    act(() => result.current.setSkillHolderRank('Apprentice'));
    act(() => result.current.setSkillHolderChapterId('c-1'));
    await act(async () => {
      await result.current.addSkillHolder();
    });

    // The card the row links back to, and the holder's own rank and chapter.
    expect(skillsApi.addSkill).toHaveBeenCalledWith(
      'ch-2',
      'Fireball',
      'Apprentice',
      'Burns for three rounds',
      'c-1',
      'n-1',
      'author'
    );
  });

  it("trims the card's name and notes", async () => {
    const { result } = setup({
      card: { id: 'n-1', label: '  Fireball  ', content: '  Burns  ' },
    });

    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    await act(async () => {
      await result.current.addSkillHolder();
    });

    expect(skillsApi.addSkill).toHaveBeenCalledWith(
      'ch-2',
      'Fireball',
      null,
      'Burns',
      null,
      'n-1',
      'author'
    );
  });

  it('adds a holder with no effect when the card has no notes', async () => {
    const { result } = setup({ card: { id: 'n-1', label: 'Fireball', content: null } });

    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    await act(async () => {
      await result.current.addSkillHolder();
    });

    expect(skillsApi.addSkill).toHaveBeenCalledWith(
      'ch-2',
      'Fireball',
      null,
      null,
      null,
      'n-1',
      'author'
    );
  });

  it('reads a blank rank and an unset chapter as no answer', async () => {
    const { result } = setup();

    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    act(() => result.current.setSkillHolderRank('   '));
    act(() => result.current.setSkillHolderChapterId(''));
    await act(async () => {
      await result.current.addSkillHolder();
    });

    expect(skillsApi.addSkill).toHaveBeenCalledWith(
      'ch-2',
      'Fireball',
      null,
      'Burns for three rounds',
      null,
      'n-1',
      'author'
    );
  });

  it('reports the row it wrote', async () => {
    const { result } = setup();

    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    await act(async () => {
      await result.current.addSkillHolder();
    });

    expect(onHolderAdded).toHaveBeenCalledWith(
      expect.objectContaining({ character_id: 'ch-2', name: 'Fireball', node_id: 'n-1' })
    );
  });

  it('empties the form once the holder is added', async () => {
    const { result } = setup();

    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    act(() => result.current.setSkillHolderRank('Apprentice'));
    act(() => result.current.setSkillHolderChapterId('c-1'));
    await act(async () => {
      await result.current.addSkillHolder();
    });

    expect(result.current.skillHolderCharacterId).toBe('');
    expect(result.current.skillHolderRank).toBe('');
    expect(result.current.skillHolderChapterId).toBe('');
  });

  it('refuses to add a holder until a character is chosen', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.addSkillHolder();
    });

    expect(result.current.skillHolderError).toBe('Choose the character who learns this skill.');
    expect(skillsApi.addSkill).not.toHaveBeenCalled();
    expect(result.current.savingSkillHolder).toBe(false);
  });

  it('refuses to add a holder to a card with no name', async () => {
    const { result } = setup({ card: nameless });

    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    await act(async () => {
      await result.current.addSkillHolder();
    });

    expect(result.current.skillHolderError).toBe(
      'The card needs a name before it can be added to a sheet.'
    );
    expect(skillsApi.addSkill).not.toHaveBeenCalled();
  });

  it('adds nothing while no card is open', async () => {
    const { result } = setup({ card: null });

    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    await act(async () => {
      await result.current.addSkillHolder();
    });

    expect(skillsApi.addSkill).not.toHaveBeenCalled();
    expect(result.current.skillHolderError).toBeNull();
  });

  it('clears the message once the answers are complete', async () => {
    const { result } = setup();

    act(() => result.current.setSkillHolderError('Rook is full'));
    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    await act(async () => {
      await result.current.addSkillHolder();
    });

    expect(result.current.skillHolderError).toBeNull();
  });

  it('says why the write failed, and keeps the answers', async () => {
    const { result } = setup();

    skillsApi.addSkill.mockRejectedValue('the ledger is locked');
    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    act(() => result.current.setSkillHolderRank('Apprentice'));
    await act(async () => {
      await result.current.addSkillHolder();
    });

    expect(result.current.skillHolderError).toBe(
      'Could not add the holder: the ledger is locked'
    );
    expect(result.current.skillHolderCharacterId).toBe('ch-2');
    expect(result.current.skillHolderRank).toBe('Apprentice');
    expect(onHolderAdded).not.toHaveBeenCalled();
  });

  it('marks the form busy while it writes, and clears the line it was complaining on', async () => {
    let release: (row: CharacterSkill) => void = () => {};
    skillsApi.addSkill.mockImplementation(
      () =>
        new Promise<CharacterSkill>(resolve => {
          release = resolve;
        })
    );
    const { result } = setup();

    act(() => result.current.setSkillHolderError('Rook is full'));
    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    act(() => {
      void result.current.addSkillHolder();
    });

    await waitFor(() => expect(result.current.savingSkillHolder).toBe(true));
    expect(result.current.skillHolderError).toBeNull();

    await act(async () => {
      release(skill('sk-1', 'ch-2', 'Fireball', null, null, null, 'n-1'));
    });

    expect(result.current.savingSkillHolder).toBe(false);
  });

  it('stops being busy when the write fails', async () => {
    const { result } = setup();

    skillsApi.addSkill.mockRejectedValue('the ledger is locked');
    act(() => result.current.setSkillHolderCharacterId('ch-2'));
    await act(async () => {
      await result.current.addSkillHolder();
    });

    expect(result.current.savingSkillHolder).toBe(false);
  });
});
