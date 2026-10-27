import type { SearchKind, SearchResult } from './types';

// The palette's wording: how many rows it shows at once, what the filter row
// offers, and what each kind is called when it is hovered. The search itself is
// in results.ts; none of this decides what is found.

export const SEARCH_RESULTS_SHOWN = 8;

export const searchKindFilters: {
  value: 'all' | SearchKind;
  label: string;
  noun: string;
  title: string;
}[] = [
  { value: 'all', label: 'All', noun: 'results', title: 'Show every kind of result' },
  { value: 'node', label: 'Nodes', noun: 'nodes', title: 'Show only cards on the boards' },
  { value: 'cast', label: 'Cast', noun: 'cast members', title: 'Show only characters in the cast lists' },
  { value: 'link', label: 'Links', noun: 'connections', title: 'Show only connections between cards' },
  { value: 'note', label: 'Notes', noun: 'notes', title: 'Show only notes kept with chapters' },
  { value: 'story', label: 'Stories', noun: 'stories', title: 'Show only other stories' },
];

export const searchResultTitles: Record<SearchKind, string> = {
  node: 'Open this node on its board',
  cast: "Open this character's sheet",
  link: "Open this connection's editor",
  note: "Open this chapter's notes",
  story: 'Open this story',
};

// What sits on the right of a result: whose character a card belongs to, both
// ends of a connection, or the story it lives in when that is not the open one.
export function searchResultTag(result: SearchResult, openStoryId: string | undefined): string | null {
  const elsewhere = result.storyId !== openStoryId;

  if (result.kind === 'node') {
    return result.characterName ?? (elsewhere ? result.storyTitle : null);
  }

  if (result.kind === 'link' || result.kind === 'cast') {
    return elsewhere ? result.storyTitle : result.detail;
  }

  // A note says which chapter holds it, since that is where choosing it lands,
  // and names the story too when it is not the open one.
  if (result.kind === 'note') {
    const chapter = result.chapterLabel;

    if (!chapter) return elsewhere ? result.storyTitle : null;

    return elsewhere ? `${chapter} · ${result.storyTitle}` : chapter;
  }

  return null;
}
