import { describe, expect, it } from 'vitest';

import {
  allLayers,
  chapterSpine,
  drawnNodeTypes,
  everyLayerShown,
  GRAPH_LAYERS,
  isNodeTypeDrawn,
  layerOf,
  layersShowing,
  revealLayer,
  revealNodeType,
  toggleLayer,
} from './layers';
import { nodeTypes } from './types';

describe('the board’s layers', () => {
  it('draws every card type in exactly one layer', () => {
    for (const type of nodeTypes) {
      const homes = GRAPH_LAYERS.filter(option => option.types.includes(type));

      expect(homes.map(option => option.key), `the layers for ${type}`).toHaveLength(1);
    }

    // And no layer names a type the board does not have, which would be a layer
    // that could never draw anything.
    const known = new Set<string>(nodeTypes);

    for (const option of GRAPH_LAYERS) {
      for (const type of option.types) {
        expect(known.has(type), `${option.label} names ${type}`).toBe(true);
      }
    }
  });

  it('opens on the chapter spine and hides everything else', () => {
    const layers = chapterSpine();

    expect(isNodeTypeDrawn('chapter', layers)).toBe(true);

    for (const type of ['plot', 'quest', 'character', 'skill', 'item', 'location', 'misc']) {
      expect(isNodeTypeDrawn(type, layers), `${type} on the spine`).toBe(false);
    }

    // A copy rather than the shared default, so no caller can change the board's
    // starting view for everyone.
    const other = chapterSpine();

    expect(other).not.toBe(layers);
    layers.entities = true;
    expect(other.entities).toBe(false);
  });

  it('puts a card in the layer its type belongs to', () => {
    expect(layerOf('chapter')).toBe('chapters');
    expect(layerOf('plot')).toBe('arcs');
    expect(layerOf('quest')).toBe('arcs');
    expect(layerOf('character')).toBe('entities');
    expect(layerOf('skill')).toBe('entities');
    expect(layerOf('misc')).toBe('entities');

    // A type this build does not know is drawn rather than hidden: a card from a
    // newer story is not a card to throw away.
    expect(layerOf('prophecy')).toBeNull();
    expect(isNodeTypeDrawn('prophecy', chapterSpine())).toBe(true);
  });

  it('turns one layer the other way and leaves the rest alone', () => {
    const withEntities = toggleLayer(chapterSpine(), 'entities');

    expect(withEntities).toEqual({ chapters: true, arcs: false, entities: true });
    expect(isNodeTypeDrawn('character', withEntities)).toBe(true);
    expect(isNodeTypeDrawn('quest', withEntities)).toBe(false);

    // Toggling twice is where it started.
    expect(toggleLayer(withEntities, 'entities')).toEqual(chapterSpine());

    // Hiding the spine is allowed too: the other chips can bring it back.
    expect(isNodeTypeDrawn('chapter', toggleLayer(chapterSpine(), 'chapters'))).toBe(false);
  });

  it('shows all the layers, and says when all of them are on', () => {
    const all = allLayers();

    expect(everyLayerShown(all)).toBe(true);
    expect(everyLayerShown(chapterSpine())).toBe(false);

    for (const type of nodeTypes) {
      expect(isNodeTypeDrawn(type, all), `${type} with every layer on`).toBe(true);
    }

    expect(drawnNodeTypes(chapterSpine())).toEqual(['chapter']);
    expect(drawnNodeTypes(all)).toEqual([...nodeTypes]);
  });

  it('reveals the layer a card needs without switching anything off', () => {
    const layers = chapterSpine();

    expect(layersShowing('skill')).toEqual(['entities']);
    expect(layersShowing('quest')).toEqual(['arcs']);
    expect(layersShowing('chapter')).toEqual(['chapters']);
    expect(layersShowing('prophecy')).toEqual([]);

    const revealed = revealNodeType(layers, 'skill');

    expect(isNodeTypeDrawn('skill', revealed)).toBe(true);
    expect(isNodeTypeDrawn('quest', revealed)).toBe(false);
    expect(isNodeTypeDrawn('chapter', revealed)).toBe(true);

    // Revealing something already drawn hands back the same object, which is
    // what keeps an open card from re-rendering the whole board.
    expect(revealLayer(revealed, 'entities')).toBe(revealed);
  });
});
