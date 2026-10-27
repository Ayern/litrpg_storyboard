import * as canvasApi from '../canvas/api';
import * as charactersApi from '../characters/api';
import * as narrativeApi from '../narrative/api';
import type { StoryIndex } from './types';

// One closed story's board as the palette needs it. The four reads go together
// because a search reaches all four, and the story is not open, so there is
// nothing on screen to search instead.
export async function readStoryIndex(storyId: string): Promise<StoryIndex> {
  const [nodes, characters, edges, notes] = await Promise.all([
    canvasApi.getGraphNodes(storyId),
    charactersApi.getCharacters(storyId),
    canvasApi.getGraphEdges(storyId),
    narrativeApi.getChapterNotes(storyId),
  ]);

  return {
    nodes,
    characters,
    edges,
    notes: (notes ?? []).map(note => ({
      id: note.id,
      chapter_id: note.parent_node_id ?? null,
      text: note.content ?? '',
    })),
  };
}
