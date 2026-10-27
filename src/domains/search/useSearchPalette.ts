import { useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Node } from 'reactflow';
import type { EdgeData, NodeData } from '../canvas/types';
import type { ChapterNote, Character } from '../shared/types';
import type { Story } from '../stories/types';
import * as searchApi from './api';
import { SEARCH_RESULTS_SHOWN } from './labels';
import { findResults } from './results';
import type { SearchKind, SearchResult, StoryIndex } from './types';

// The palette's own state: whether it is open, what it is looking for, which
// kind of result it is narrowed to, which row the keyboard is on, and the boards
// of the stories that are not open, read once each so a word can be found
// without opening the story that holds it.
//
// The open story is searched from what is on screen, so those rows arrive as
// arguments; the closed ones are read here and kept until that story is opened.
// Choosing a result stays with the app, because it moves the window to another
// tab, story or card.

export interface SearchPaletteOptions {
  // The open story's rows, so its results are live rather than read again.
  nodes: Node<NodeData>[];
  edges: Edge<EdgeData>[];
  characters: Character[];
  notes: ChapterNote[];
  // Every story, and the one that is open: the rest are the closed ones.
  stories: Story[];
  currentStory: Story | null;
}

export function useSearchPalette({
  nodes,
  edges,
  characters,
  notes,
  stories,
  currentStory,
}: SearchPaletteOptions) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  // Which kind of result the list is narrowed to; "all" searches everything.
  const [searchKind, setSearchKind] = useState<'all' | SearchKind>('all');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // The other stories' boards, kept for the session so a search reaches them
  // without opening them. The copy for a story is dropped when it is opened,
  // because edits made while it was open would make it stale.
  const [otherStoryIndex, setOtherStoryIndex] = useState<Record<string, StoryIndex>>({});
  const otherStoryIndexRef = useRef<Record<string, StoryIndex>>({});
  // The story the window was last showing. It survives the moment a story is
  // closed, which is when the history still has to name the board a step
  // changed.
  const lastStoryIdRef = useRef<string | null>(null);
  const [otherStoryLoading, setOtherStoryLoading] = useState(false);
  const [otherStoryError, setOtherStoryError] = useState<string | null>(null);

  const searchResults = useMemo<SearchResult[]>(
    () =>
      findResults({
        term: searchTerm,
        kind: searchKind,
        nodes,
        notes,
        characters,
        edges,
        stories,
        openStory: currentStory,
        otherStoryIndex,
      }),
    [
      searchTerm,
      searchKind,
      nodes,
      notes,
      characters,
      edges,
      stories,
      currentStory,
      otherStoryIndex,
    ]
  );

  // Only the rows the list shows can be reached with the keyboard, and Enter
  // takes the one the cursor is on — clamped to the last, since a mouse can
  // leave the cursor past the end of a list that has since shrunk.
  const shownCount = Math.min(searchResults.length, SEARCH_RESULTS_SHOWN);
  const highlightedResult = searchResults[Math.min(searchIndex, searchResults.length - 1)] ?? null;

  const openSearch = () => {
    setSearchOpen(true);
    setSearchIndex(0);
    setSearchKind('all');
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchTerm('');
    setSearchIndex(0);
    // A filter left on would hide results the next time the palette opens.
    setSearchKind('all');
  };

  // Typing or narrowing the list puts the cursor back on the first row, so
  // Enter after a change opens what the field is now showing.
  const typeSearch = (value: string) => {
    setSearchTerm(value);
    setSearchIndex(0);
  };

  const filterKind = (kind: 'all' | SearchKind) => {
    setSearchKind(kind);
    setSearchIndex(0);
  };

  const highlightResult = (index: number) => setSearchIndex(index);

  const moveSearchSelection = (delta: number) => {
    if (shownCount === 0) return;
    setSearchIndex(current => (current + delta + shownCount) % shownCount);
  };

  // Which story a step belongs to, for the history: the open one, or the one
  // that was open a moment ago if the board has just been let go.
  const openStoryId = () => lastStoryIdRef.current;

  // Restoring replaces every row the copies describe, so they go with the old
  // file rather than being searched against rows that no longer exist.
  const forgetOtherStories = () => {
    otherStoryIndexRef.current = {};
    setOtherStoryIndex({});
  };

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // A story's board is kept for searching only while that story is closed. The
  // moment it is opened the screen becomes the truth, and when it is left the
  // cached copy is dropped so the next search reads it again.
  useEffect(() => {
    const nextId = currentStory?.id ?? null;
    const previousId = lastStoryIdRef.current;
    lastStoryIdRef.current = nextId;

    if (!previousId || previousId === nextId || !otherStoryIndexRef.current[previousId]) {
      return;
    }

    const next = { ...otherStoryIndexRef.current };
    delete next[previousId];
    otherStoryIndexRef.current = next;
    setOtherStoryIndex(next);
  }, [currentStory]);

  // The other stories are read when the palette opens, all at once, so typing
  // never waits on the database and the results cover every story.
  useEffect(() => {
    if (!searchOpen || !currentStory) return;

    const missing = stories.filter(
      story => story.id !== currentStory.id && !otherStoryIndexRef.current[story.id]
    );
    if (missing.length === 0) {
      // Everything is cached, so a read cancelled by an earlier close cannot
      // leave the palette saying it is still searching.
      setOtherStoryLoading(false);
      return;
    }

    let cancelled = false;
    setOtherStoryLoading(true);
    setOtherStoryError(null);

    Promise.all(
      missing.map(async story => [story.id, await searchApi.readStoryIndex(story.id)] as const)
    )
      .then(entries => {
        if (cancelled) return;

        const next = { ...otherStoryIndexRef.current };
        entries.forEach(([id, index]) => {
          next[id] = index;
        });
        otherStoryIndexRef.current = next;
        setOtherStoryIndex(next);
      })
      .catch(error => {
        // A board that cannot be read is left out of the results rather than
        // failing the whole search; the footer says some stories were skipped.
        if (!cancelled) setOtherStoryError(String(error));
      })
      .finally(() => {
        if (!cancelled) setOtherStoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [searchOpen, stories, currentStory]);

  return {
    // Whether it is up, and what it is looking for.
    searchOpen,
    searchTerm,
    typeSearch,
    searchKind,
    filterKind,
    searchIndex,
    highlightResult,
    moveSearchSelection,
    searchInputRef,
    openSearch,
    closeSearch,

    // What the term found, in the order the list shows it.
    searchResults,
    highlightedResult,

    // The boards of the stories that are not open.
    otherStoryLoading,
    otherStoryError,
    forgetOtherStories,

    // Which story a step belongs to, for the history.
    openStoryId,
  };
}
