import { nodeTypes } from './types';
import type { NodeType } from './types';

// The board can draw a story's whole web, and a first look at twenty-eight cards
// is a hard place to begin. So the cards are grouped into three layers, and the
// board opens on the reading order alone: the chapter spine, left to right, with
// nothing beside it. The other two layers are the author's to switch on, and the
// switch lives on the toolbar rather than in a menu, because looking at the web
// and going back to the spine is something a person does while thinking.
//
// A layer is a view, not a permission: nothing is deleted or moved, a hidden
// card keeps its position and its connections, and opening a card from anywhere
// else in the app - a sheet's card link, a chapter's skill row, a search result -
// switches its layer back on so the card is on screen when the drawer opens.

export type GraphLayer = 'chapters' | 'arcs' | 'entities';

export interface GraphLayerOption {
  key: GraphLayer;
  // What the chip says, which is also its accessible name.
  label: string;
  // The sentence the chip's tooltip gives, since three words cannot say which
  // card types are behind it.
  hint: string;
  types: readonly NodeType[];
}

// The three layers, in the order the toolbar draws them. Every node type belongs
// to exactly one, which a test pins down: a type added later should be a
// decision about where it is drawn, not a card that silently hides.
export const GRAPH_LAYERS: readonly GraphLayerOption[] = [
  {
    key: 'chapters',
    // Not “Chapters”, which is the tab's own button: a chip with the same name
    // would make two controls answer to one word.
    label: 'Chapter spine',
    hint: 'The reading order: the chapter cards and nothing else',
    types: ['chapter'],
  },
  {
    key: 'arcs',
    label: 'Arcs & quests',
    hint: 'The plot cards and the quest cards, which the chapters are strung with',
    types: ['plot', 'quest'],
  },
  {
    key: 'entities',
    label: 'Entities',
    hint: 'The cast, skills, items, locations, factions, system, events, ideas and misc cards',
    types: [
      'character',
      'skill',
      'item',
      'location',
      'faction',
      'system',
      'event',
      'idea',
      'misc',
    ],
  },
];

export type GraphLayers = Record<GraphLayer, boolean>;

// What a story opens on: six chapters, or three, and a clean line between them.
export const CHAPTER_SPINE_LAYERS: GraphLayers = {
  chapters: true,
  arcs: false,
  entities: false,
};

const LAYER_BY_TYPE = new Map<string, GraphLayer>(
  GRAPH_LAYERS.flatMap(option => option.types.map(type => [type, option.key] as const))
);

// The layer a card type is drawn in. A type this build does not know about has
// no layer, and is drawn rather than hidden: an unknown card is more likely a
// card from a newer story than a card nobody wants to see.
export function layerOf(nodeType: string): GraphLayer | null {
  return LAYER_BY_TYPE.get(nodeType) ?? null;
}

// Whether the board draws a card of this type under these layers.
export function isNodeTypeDrawn(nodeType: string, layers: GraphLayers): boolean {
  const layer = layerOf(nodeType);
  return layer === null ? true : layers[layer];
}

// The layers with one switched the other way. Turning the last one off is
// allowed: an empty board is a clear statement, and the other chips are still
// there to switch something back on.
export function toggleLayer(layers: GraphLayers, layer: GraphLayer): GraphLayers {
  return { ...layers, [layer]: !layers[layer] };
}

// Every layer on, which is the whole web. Used by the toolbar's Show all.
export function allLayers(): GraphLayers {
  return GRAPH_LAYERS.reduce(
    (next, option) => ({ ...next, [option.key]: true }),
    { ...CHAPTER_SPINE_LAYERS }
  );
}

// The reading order alone, which is what the toolbar's Show chapters only does
// and what a story opens on.
export function chapterSpine(): GraphLayers {
  return { ...CHAPTER_SPINE_LAYERS };
}

export function everyLayerShown(layers: GraphLayers): boolean {
  return GRAPH_LAYERS.every(option => layers[option.key]);
}

// The types drawn under these layers, for the legend: the key should name the
// cards that are on the board, not the ones that could be.
export function drawnNodeTypes(layers: GraphLayers): readonly NodeType[] {
  return nodeTypes.filter(type => isNodeTypeDrawn(type, layers));
}

// The layers a card needs switched on for it to be on screen. Opening a card
// from the sheet, a chapter or a search result reveals exactly these.
export function layersShowing(nodeType: string): GraphLayer[] {
  const layer = layerOf(nodeType);
  return layer === null ? [] : [layer];
}

export function revealLayer(layers: GraphLayers, layer: GraphLayer): GraphLayers {
  return layers[layer] ? layers : { ...layers, [layer]: true };
}

export function revealNodeType(layers: GraphLayers, nodeType: string): GraphLayers {
  return layersShowing(nodeType).reduce(revealLayer, layers);
}
