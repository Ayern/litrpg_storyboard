import type { Edge, Node } from 'reactflow';
import type { EdgeData, NodeData } from '../canvas/types';
import type { ChapterNote, Character } from '../shared/types';
import type { Story } from '../stories/types';
import type { SearchKind, SearchResult, StoryIndex } from './types';

// The search itself: what a word finds and in what order. Everything it looks at
// is handed in, so the open story is searched from what is on screen and the
// closed ones from the copies the palette has read. No React and no command, so
// the rules can be read in one place.

// Everything a search looks at: the words, the kind it is narrowed to, and the
// rows of the story that is open plus the copies of the ones that are not.
export interface SearchSource {
  term: string;
  kind: 'all' | SearchKind;
  nodes: Node<NodeData>[];
  notes: ChapterNote[];
  characters: Character[];
  edges: Edge<EdgeData>[];
  stories: Story[];
  openStory: Story | null;
  otherStoryIndex: Record<string, StoryIndex>;
}

// A search looks at everything a result is made of — a card's label, notes, type
// and cast member; a character's name and description; both ends of a
// connection; a story's title and description — so it can be found the way a
// person remembers it rather than only by its exact name. A result whose name
// matched is listed before one found only by its notes or description.
export function findResults({
  term: rawTerm,
  kind,
  nodes,
  notes,
  characters,
  edges,
  stories,
  openStory,
  otherStoryIndex,
}: SearchSource): SearchResult[] {
  const term = rawTerm.trim().toLowerCase();
  if (!term) return [];

  const matches = (value: string | null | undefined) =>
    typeof value === 'string' && value.toLowerCase().includes(term);
  const hits = (values: (string | null | undefined)[]) => values.some(matches);
  const wants = (candidate: SearchKind) => kind === 'all' || kind === candidate;

  const result = (
    resultKind: SearchKind,
    story: { id: string; title: string },
    targetId: string,
    label: string,
    extra: Partial<SearchResult> = {}
  ): SearchResult => ({
    key: `${resultKind}:${story.id}:${targetId}`,
    kind: resultKind,
    storyId: story.id,
    storyTitle: story.title,
    targetId,
    label,
    detail: null,
    nodeType: null,
    characterName: null,
    x: 0,
    y: 0,
    content: null,
    edgeLabel: '',
    edgeRelation: '',
    chapterId: null,
    chapterLabel: null,
    rank: 1,
    ...extra,
  });

  const results: SearchResult[] = [];
  const open = { id: openStory?.id ?? '', title: openStory?.title ?? '' };

  // The open story reads from what is on screen, so its results are live.
  const castById = new Map(characters.map(character => [character.id, character]));
  const labelOf = new Map(nodes.map(node => [node.id, node.data.label]));
  const positionOf = new Map(nodes.map(node => [node.id, node.position]));

  if (wants('node')) {
    nodes.forEach(node => {
      const characterName = node.data.characterId
        ? castById.get(node.data.characterId)?.name ?? null
        : null;

      if (!hits([node.data.label, node.data.content, node.data.nodeType, characterName])) {
        return;
      }

      results.push(
        result('node', open, node.id, node.data.label, {
          nodeType: node.data.nodeType,
          characterName,
          detail: node.data.content ?? null,
          content: node.data.content ?? null,
          rank: matches(node.data.label) ? 0 : 1,
          // A node's position is its top-left, so the pan aims at its middle.
          x: node.position.x + 70,
          y: node.position.y + 20,
        })
      );
    });
  }

  if (wants('note')) {
    notes.forEach(note => {
      const chapterLabel = labelOf.get(note.chapterId);

      // A note whose chapter is not on the board has nowhere to open.
      if (!chapterLabel || !hits([note.text])) return;

      const label = noteFirstLine(note.text);

      results.push(
        result('note', open, note.id, label, {
          chapterId: note.chapterId,
          chapterLabel,
          detail: note.text,
          rank: matches(label) ? 0 : 1,
        })
      );
    });
  }

  if (wants('cast')) {
    characters.forEach(character => {
      if (!hits([character.name, character.description])) return;

      results.push(
        result('cast', open, character.id, character.name, {
          detail: character.description,
          rank: matches(character.name) ? 0 : 1,
        })
      );
    });
  }

  if (wants('link')) {
    edges.forEach(edge => {
      const source = labelOf.get(edge.source) ?? '?';
      const target = labelOf.get(edge.target) ?? '?';
      const edgeLabel = edge.data?.label ?? '';
      const edgeRelation = edge.data?.relationType ?? '';

      if (!hits([edgeLabel, edgeRelation, source, target])) return;

      const from = positionOf.get(edge.source);
      const to = positionOf.get(edge.target);

      results.push(
        result('link', open, edge.id, edgeLabel || edgeRelation || `${source} → ${target}`, {
          detail: `${source} → ${target}`,
          edgeLabel,
          edgeRelation,
          rank: matches(edgeLabel) ? 0 : 1,
          x: from && to ? (from.x + to.x) / 2 : 0,
          y: from && to ? (from.y + to.y) / 2 : 0,
        })
      );
    });
  }

  // Every other story is searched from the copy read when the palette opened, so
  // a word can be found without opening the story that holds it.
  stories.forEach(story => {
    if (story.id === open.id) return;

    const index = otherStoryIndex[story.id];
    const storyCast = index ? new Map(index.characters.map(entry => [entry.id, entry])) : null;

    if (wants('story') && hits([story.title, story.description])) {
      results.push(
        result('story', { id: story.id, title: story.title }, story.id, story.title, {
          detail: story.description,
          rank: matches(story.title) ? 0 : 1,
        })
      );
    }

    if (!index) return;

    const storyLabels = new Map(index.nodes.map(node => [node.id, node.label]));

    if (wants('note')) {
      index.notes.forEach(note => {
        const chapterLabel = note.chapter_id
          ? storyLabels.get(note.chapter_id) ?? null
          : null;

        if (!chapterLabel || !hits([note.text])) return;

        const label = noteFirstLine(note.text);

        results.push(
          result('note', story, note.id, label, {
            chapterId: note.chapter_id,
            chapterLabel,
            detail: note.text,
            rank: matches(label) ? 0 : 1,
          })
        );
      });
    }

    if (wants('node')) {
      index.nodes.forEach(node => {
        const characterName = node.character_id
          ? storyCast?.get(node.character_id)?.name ?? null
          : null;

        if (!hits([node.label, node.content, node.node_type, characterName])) return;

        results.push(
          result('node', story, node.id, node.label, {
            nodeType: node.node_type,
            characterName,
            detail: node.content,
            content: node.content,
            rank: matches(node.label) ? 0 : 1,
            x: node.pos_x + 70,
            y: node.pos_y + 20,
          })
        );
      });
    }

    if (wants('cast')) {
      index.characters.forEach(character => {
        if (!hits([character.name, character.description])) return;

        results.push(
          result('cast', story, character.id, character.name, {
            detail: character.description,
            rank: matches(character.name) ? 0 : 1,
          })
        );
      });
    }

    if (wants('link')) {
      const storyPositions = new Map(
        index.nodes.map(node => [node.id, { x: node.pos_x, y: node.pos_y }])
      );

      index.edges.forEach(edge => {
        const source = storyLabels.get(edge.source_id) ?? '?';
        const target = storyLabels.get(edge.target_id) ?? '?';
        const edgeLabel = edge.label ?? '';
        const edgeRelation = edge.relation_type ?? '';

        if (!hits([edgeLabel, edgeRelation, source, target])) return;

        const from = storyPositions.get(edge.source_id);
        const to = storyPositions.get(edge.target_id);

        results.push(
          result('link', story, edge.id, edgeLabel || edgeRelation || `${source} → ${target}`, {
            detail: `${source} → ${target}`,
            edgeLabel,
            edgeRelation,
            rank: matches(edgeLabel) ? 0 : 1,
            x: from && to ? (from.x + to.x) / 2 : 0,
            y: from && to ? (from.y + to.y) / 2 : 0,
          })
        );
      });
    }
  });

  // Name matches first. The sort is stable, so within each band the results keep
  // the order they were gathered in: the open story before the others.
  return results.sort((left, right) => left.rank - right.rank);
}

// The line a note is listed by: its first, with the rest left to the panel.
function noteFirstLine(text: string): string {
  return text.split('\n')[0].trim();
}
