import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Edge, Node } from 'reactflow';
import type { EdgeData, IndexedEdge, IndexedNode, NodeData } from '../canvas/types';
import type { ChapterNote, Character } from '../shared/types';
import type { Story } from '../stories/types';
import type { IndexedNote, StoryIndex } from './types';
import { useSearchPalette } from './useSearchPalette';
import type { SearchPaletteOptions } from './useSearchPalette';
import { SEARCH_RESULTS_SHOWN } from './labels';

// The palette holds what it is looking for and what it has already read of the
// other stories. The open story's rows come from the screen, so they arrive as
// arguments and the results are derived from them; the other stories are read
// once each through one command, which is what these tests mock.

const { searchApi } = vi.hoisted(() => ({
  searchApi: { readStoryIndex: vi.fn() },
}));

vi.mock('./api', () => searchApi);

function story(id: string, title: string, description: string | null = null): Story {
  return {
    id,
    title,
    description,
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
  };
}

const ledger = story('story-1', 'Ledger');
const vault = story('story-2', 'Vault', 'What the ledger was keeping');

function card(
  id: string,
  label: string,
  data: Partial<NodeData> = {},
  position = { x: 0, y: 0 }
): Node<NodeData> {
  return {
    id,
    type: 'default',
    position,
    data: { label, nodeType: 'character', createdBy: 'author', ...data },
  };
}

function line(id: string, source: string, target: string, label: string | null): Edge<EdgeData> {
  return {
    id,
    source,
    target,
    data: { label: label ?? undefined, relationType: label ?? undefined, createdBy: 'author' },
  };
}

function cast(id: string, name: string, description: string | null): Character {
  return {
    id,
    story_id: 'story-1',
    name,
    description,
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
  };
}

const mira = cast('ch-1', 'Mira', 'Bearer of the ledger');
const rook = cast('ch-2', 'Rook', null);

const gate = card('n-1', 'The Gate', { nodeType: 'chapter' }, { x: 100, y: 200 });
const bearer = card('n-2', 'Bearer', { characterId: 'ch-1' }, { x: 0, y: 0 });
const door = card(
  'n-3',
  'Vault Door',
  { nodeType: 'misc', content: 'Sealed by the ledger' },
  { x: 300, y: 100 }
);
const ledgerHall = card('n-4', 'Ledger Hall', { nodeType: 'location' }, { x: 40, y: 60 });

const note: ChapterNote = {
  id: 'no-1',
  chapterId: 'n-1',
  text: 'The gate opens at dusk\nand closes at dawn',
};

const opening = line('e-1', 'n-1', 'n-3', 'unlocks');

const board: SearchPaletteOptions = {
  nodes: [gate, bearer, door, ledgerHall],
  edges: [opening],
  characters: [mira, rook],
  notes: [note],
  stories: [ledger, vault],
  currentStory: ledger,
};

function indexedCard(
  id: string,
  label: string,
  nodeType: string,
  content: string | null,
  posX: number,
  posY: number,
  characterId: string | null = null
): IndexedNode {
  return {
    id,
    label,
    node_type: nodeType,
    content,
    pos_x: posX,
    pos_y: posY,
    character_id: characterId,
    parent_node_id: null,
  };
}

const vaultIndex: StoryIndex = {
  nodes: [
    indexedCard('v-1', 'The Vault', 'chapter', null, 10, 20),
    indexedCard('v-2', 'Ledger shard', 'misc', 'A page of the ledger', 50, 60),
  ],
  characters: [
    cast('ch-9', 'Sereth', 'Keeper of the vault'),
  ],
  edges: [
    {
      id: 've-1',
      source_id: 'v-1',
      target_id: 'v-2',
      label: 'contains',
      relation_type: 'contains',
    } as IndexedEdge,
  ],
  notes: [
    { id: 'vn-1', chapter_id: 'v-1', text: 'Sereth keeps the second key' } as IndexedNote,
  ],
};

function setup(overrides: Partial<SearchPaletteOptions> = {}) {
  const options: SearchPaletteOptions = { ...board, ...overrides };
  const view = renderHook((props: SearchPaletteOptions) => useSearchPalette(props), {
    initialProps: options,
  });

  return view;
}

beforeEach(() => {
  searchApi.readStoryIndex.mockReset();
  searchApi.readStoryIndex.mockResolvedValue(vaultIndex);
});

describe('opening and closing the palette', () => {
  it('opens empty, on everything, with the first result chosen', () => {
    const { result } = setup();

    expect(result.current.searchOpen).toBe(false);

    act(() => result.current.openSearch());

    expect(result.current.searchOpen).toBe(true);
    expect(result.current.searchTerm).toBe('');
    expect(result.current.searchKind).toBe('all');
    expect(result.current.searchIndex).toBe(0);
    expect(result.current.searchResults).toEqual([]);
  });

  it('drops the term, the filter and the cursor when it closes', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('mira'));
    act(() => result.current.filterKind('cast'));
    act(() => result.current.highlightResult(1));

    act(() => result.current.closeSearch());

    expect(result.current.searchOpen).toBe(false);
    // A filter or a term left behind would hide results the next time.
    expect(result.current.searchTerm).toBe('');
    expect(result.current.searchKind).toBe('all');
    expect(result.current.searchIndex).toBe(0);
  });

  it('opens on everything again when it is opened a second time', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('mira'));
    act(() => result.current.filterKind('cast'));

    // Ctrl+F and the Search button both land here while it is already up.
    act(() => result.current.openSearch());

    expect(result.current.searchKind).toBe('all');
    expect(result.current.searchIndex).toBe(0);
  });

  it('reads nothing while the palette is closed', () => {
    setup();

    expect(searchApi.readStoryIndex).not.toHaveBeenCalled();
  });
});

describe('what a search finds in the open story', () => {
  it('finds a card by its label, aimed at its middle', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('ledger hall'));

    const hits = result.current.searchResults;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: 'node',
      targetId: 'n-4',
      label: 'Ledger Hall',
      storyId: 'story-1',
      x: 40 + 70,
      y: 60 + 20,
      rank: 0,
    });
  });

  it('finds a card by its notes, ranked under the name matches', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('ledger'));

    const kinds = result.current.searchResults.map(entry => `${entry.kind}:${entry.rank}`);
    expect(kinds[0]).toBe('node:0');
    // The notes and the description matched, so they follow the name.
    expect(kinds).toContain('node:1');
    expect(kinds).toContain('cast:1');
  });

  it('finds a card by the cast member it is linked to', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('mira'));

    const card = result.current.searchResults.find(entry => entry.targetId === 'n-2');
    expect(card).toMatchObject({ kind: 'node', label: 'Bearer', characterName: 'Mira' });
  });

  it('finds a card by its type', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('chapter'));

    expect(
      result.current.searchResults.map(entry => entry.targetId)
    ).toContain('n-1');
  });

  it('finds a chapter note by its text and lists it by its first line', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('dusk'));

    expect(result.current.searchResults).toEqual([
      expect.objectContaining({
        kind: 'note',
        targetId: 'no-1',
        label: 'The gate opens at dusk',
        chapterId: 'n-1',
        chapterLabel: 'The Gate',
      }),
    ]);
  });

  it('leaves out a note whose chapter is not on the board', () => {
    const { result } = setup({
      notes: [{ id: 'no-2', chapterId: 'n-99', text: 'A note with no chapter' }],
    });

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('chapter'));

    expect(result.current.searchResults.some(entry => entry.targetId === 'no-2')).toBe(false);
  });

  it('finds a connection by either end, aimed between the two cards', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('vault door'));

    const link = result.current.searchResults.find(entry => entry.kind === 'link');
    expect(link).toMatchObject({
      targetId: 'e-1',
      label: 'unlocks',
      detail: 'The Gate → Vault Door',
      x: (100 + 300) / 2,
      y: (200 + 100) / 2,
    });
  });

  it('narrows to one kind when a filter is chosen', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('ledger'));
    act(() => result.current.filterKind('cast'));

    expect(result.current.searchResults.map(entry => entry.kind)).toEqual(['cast']);
    // The cursor goes back to the first of what is now listed.
    expect(result.current.searchIndex).toBe(0);
  });

  it('puts the cursor back on the first row when the term changes', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('mira'));
    act(() => result.current.highlightResult(1));

    act(() => result.current.typeSearch('mira l'));

    expect(result.current.searchIndex).toBe(0);
  });

  it('finds nothing for a term of only spaces', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('   '));

    expect(result.current.searchResults).toEqual([]);
  });
});

describe('the other stories', () => {
  it('reads the closed stories when the palette opens, and only those', async () => {
    const { result } = setup();

    act(() => result.current.openSearch());

    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));
    expect(searchApi.readStoryIndex).toHaveBeenCalledTimes(1);
    expect(searchApi.readStoryIndex).toHaveBeenCalledWith('story-2');

    act(() => result.current.typeSearch('shard'));

    const card = result.current.searchResults.find(entry => entry.kind === 'node');
    expect(card).toMatchObject({ storyId: 'story-2', targetId: 'v-2' });
    // Nothing in the open story mentions a shard, so every row is the other one.
    expect(result.current.searchResults.every(entry => entry.storyId === 'story-2')).toBe(true);
  });

  it('finds their cast, connections and notes too', async () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));

    act(() => result.current.typeSearch('sereth'));
    expect(result.current.searchResults.map(entry => entry.kind).sort()).toEqual([
      'cast',
      'note',
    ]);

    act(() => result.current.typeSearch('contains'));
    expect(result.current.searchResults).toEqual([
      expect.objectContaining({ kind: 'link', storyId: 'story-2', detail: 'The Vault → Ledger shard' }),
    ]);
  });

  it('finds a closed story by its title without reading its board', async () => {
    searchApi.readStoryIndex.mockImplementation(() => new Promise(() => {}));
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('vault'));

    // The story row is searched from the shelf, so a board still loading does
    // not hide the story itself.
    const closed = result.current.searchResults.filter(entry => entry.storyId === 'story-2');
    expect(closed).toEqual([expect.objectContaining({ kind: 'story', label: 'Vault' })]);
  });

  it('reads nothing when there is no other story', async () => {
    const { result } = setup({ stories: [ledger] });

    act(() => result.current.openSearch());

    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));
    expect(searchApi.readStoryIndex).not.toHaveBeenCalled();
    expect(result.current.otherStoryError).toBeNull();
  });

  it('drops the last failure once a later read works', async () => {
    searchApi.readStoryIndex.mockRejectedValueOnce('the file is locked');
    const { result } = setup();

    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryError).toBe('the file is locked'));
    act(() => result.current.closeSearch());
    act(() => result.current.openSearch());

    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));
    expect(result.current.otherStoryError).toBeNull();
  });

  it('says it is searching while a board is on its way', async () => {
    let finish: ((index: StoryIndex) => void) | null = null;
    searchApi.readStoryIndex.mockImplementation(
      () =>
        new Promise<StoryIndex>(resolve => {
          finish = resolve;
        })
    );
    const { result } = setup();

    act(() => result.current.openSearch());
    expect(result.current.otherStoryLoading).toBe(true);

    await act(async () => {
      finish?.(vaultIndex);
    });

    expect(result.current.otherStoryLoading).toBe(false);
  });

  it('leaves a board that cannot be read out of the results, and says so', async () => {
    searchApi.readStoryIndex.mockRejectedValue('the file is locked');
    const { result } = setup();

    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryError).toBe('the file is locked'));

    expect(result.current.otherStoryLoading).toBe(false);
    act(() => result.current.typeSearch('vault'));
    // The story is still found by its title; only its board is missing.
    const closed = result.current.searchResults.filter(entry => entry.storyId === 'story-2');
    expect(closed.map(entry => entry.kind)).toEqual(['story']);
  });

  it('reads each closed story once, and does not read it again on reopening', async () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));
    act(() => result.current.closeSearch());
    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));

    expect(searchApi.readStoryIndex).toHaveBeenCalledTimes(1);
  });

  it('drops the board of a story once that story is opened', async () => {
    const { result, rerender } = setup();

    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));
    act(() => result.current.closeSearch());

    // The vault is opened, so the screen is the truth for it now.
    rerender({ ...board, currentStory: vault });

    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));

    expect(searchApi.readStoryIndex).toHaveBeenLastCalledWith('story-1');
    expect(searchApi.readStoryIndex).toHaveBeenCalledTimes(2);
  });

  it('reads a board again once its story has been closed and reopened', async () => {
    const { result, rerender } = setup();

    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));
    act(() => result.current.closeSearch());

    // The vault is opened, which is when its copy stops being the truth.
    rerender({ ...board, currentStory: vault });
    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));
    act(() => result.current.closeSearch());

    // Back to the ledger, and the vault is closed again: its board has to be
    // read a second time rather than searched from the copy that went stale.
    rerender({ ...board, currentStory: ledger });
    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));

    expect(searchApi.readStoryIndex).toHaveBeenCalledTimes(3);
    expect(searchApi.readStoryIndex).toHaveBeenLastCalledWith('story-2');
  });

  it('forgets every board when the database is replaced', async () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));
    act(() => result.current.closeSearch());

    act(() => result.current.forgetOtherStories());

    act(() => result.current.openSearch());
    await waitFor(() => expect(result.current.otherStoryLoading).toBe(false));

    expect(searchApi.readStoryIndex).toHaveBeenCalledTimes(2);
  });

  it('reports the story a step belongs to, and nothing once the board is let go', async () => {
    const { result, rerender } = setup();

    expect(result.current.openStoryId()).toBe('story-1');

    rerender({ ...board, currentStory: vault });

    expect(result.current.openStoryId()).toBe('story-2');

    rerender({ ...board, currentStory: null });
    expect(result.current.openStoryId()).toBeNull();
  });
});

describe('the cursor', () => {
  const many: Node<NodeData>[] = Array.from({ length: SEARCH_RESULTS_SHOWN + 3 }, (_, index) =>
    card(`m-${index}`, `Match ${index}`)
  );

  it('walks within the results on screen and wraps at both ends', () => {
    const { result } = setup({ nodes: many, edges: [], characters: [], notes: [] });

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('match'));

    expect(result.current.searchResults).toHaveLength(SEARCH_RESULTS_SHOWN + 3);

    act(() => result.current.moveSearchSelection(-1));
    // The keyboard only reaches the rows the list shows.
    expect(result.current.searchIndex).toBe(SEARCH_RESULTS_SHOWN - 1);

    act(() => result.current.moveSearchSelection(1));
    expect(result.current.searchIndex).toBe(0);

    act(() => result.current.highlightResult(SEARCH_RESULTS_SHOWN + 2));
    expect(result.current.highlightedResult?.targetId).toBe(`m-${SEARCH_RESULTS_SHOWN + 2}`);
  });

  it('offers nothing to choose when there are no results', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('nothing matches this'));
    act(() => result.current.moveSearchSelection(1));

    expect(result.current.searchIndex).toBe(0);
    expect(result.current.highlightedResult).toBeNull();
  });

  it('clamps the choice to the last result when the list is shorter than the cursor', () => {
    const { result } = setup();

    act(() => result.current.openSearch());
    act(() => result.current.typeSearch('mira'));
    act(() => result.current.highlightResult(20));

    expect(result.current.highlightedResult).not.toBeNull();
    expect(result.current.highlightedResult).toBe(
      result.current.searchResults[result.current.searchResults.length - 1]
    );
  });
});
