import type { IndexedEdge, IndexedNode } from '../canvas/types';
import type { Character } from '../shared/types';

// What the palette can find. A card is not the only thing worth searching for:
// the cast, the connections and the other boards are all destinations, and the
// kind is what the filter row narrows to.
export type SearchKind = 'node' | 'cast' | 'link' | 'note' | 'story';

// One row in the palette. It carries everything needed to arrive at the thing it
// names, because a result in another story is chosen before that story is open.
export interface SearchResult {
  key: string;
  kind: SearchKind;
  storyId: string;
  storyTitle: string;
  targetId: string;
  label: string;
  detail: string | null;
  nodeType: string | null;
  characterName: string | null;
  // Where the viewport goes when this result is chosen.
  x: number;
  y: number;
  content: string | null;
  edgeLabel: string;
  edgeRelation: string;
  // A note is reached through the chapter that holds it, so the result carries
  // both the chapter and the text that found it.
  chapterId: string | null;
  chapterLabel: string | null;
  // 0 when the query matched the name the result is listed by, 1 when it only
  // matched what surrounds it. Name matches are listed first.
  rank: number;
}

export interface IndexedNote {
  id: string;
  chapter_id: string | null;
  text: string;
}

// A closed story, read once so a search can reach it without opening it.
export interface StoryIndex {
  nodes: IndexedNode[];
  characters: Character[];
  edges: IndexedEdge[];
  notes: IndexedNote[];
}
