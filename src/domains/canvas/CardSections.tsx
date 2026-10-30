import { useState } from 'react';
import type { Node } from 'reactflow';

import type { Character, CharacterStat } from '../shared/types';
import {
  CARD_DRAG_TYPE,
  CAST_DRAG_TYPE,
  NODE_STAT_BADGES,
  QUEST_DRAG_TYPE,
} from './types';
import type { NodeData, NodeType, UnplacedQuest } from './types';

// Everything the story already holds, in sections down the side of the board.
//
// The list is a catalogue, not a shelf of cards: one tile per name and kind, no
// matter how many cards that name has on the board. A skill can be held by more
// than one person and a place can be visited in more than one chapter, so a
// second card is a second use of the same thing. Dragging a tile out therefore
// makes that second card, and the tile stays where it is for the next one. The
// cast is listed above the sections, because a person is the one thing a board
// cannot draw without a card.

// The kinds that get a section, in the order they are listed. Chapters are the
// spine and are already on the board; people are the cast list above them.
const CARD_SECTIONS: { type: NodeType; label: string }[] = [
  { type: 'item', label: 'Items' },
  { type: 'skill', label: 'Skills' },
  { type: 'location', label: 'Locations' },
  { type: 'quest', label: 'Quests' },
  { type: 'faction', label: 'Factions' },
  { type: 'plot', label: 'Plots' },
  { type: 'event', label: 'Events' },
  { type: 'idea', label: 'Ideas' },
  { type: 'system', label: 'System' },
  { type: 'misc', label: 'Misc' },
];

export interface CardSectionsProps {
  characters: Character[];
  castStats: Record<string, CharacterStat[]>;
  nodes: Node<NodeData>[];
  // Quest records the board has no card for. They are listed with the quest
  // cards and marked, because a quest written in the ledger is still a quest:
  // dragging one out is how it gets a card.
  unplacedQuests: UnplacedQuest[];
  draggingCastId: string | null;
  setDraggingCastId: React.Dispatch<React.SetStateAction<string | null>>;
  setDropTargetNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  // Opening a tile is the same gesture as clicking its card: the layer comes
  // back and the drawer opens on it.
  onOpenCard: (id: string) => void;
}

// One entry per name and kind, keeping the card the other entries are copies of.
// The tile carries that card's id, which is how a drop knows what to copy.
function catalogue(nodes: Node<NodeData>[], type: NodeType): Node<NodeData>[] {
  const seen = new Set<string>();

  return nodes
    .filter(node => node.data.nodeType === type)
    .sort((a, b) => a.data.label.localeCompare(b.data.label))
    .filter(node => {
      const name = node.data.label.trim();

      if (seen.has(name)) return false;

      seen.add(name);
      return true;
    });
}

export function CardSections({
  characters,
  castStats,
  nodes,
  unplacedQuests,
  draggingCastId,
  setDraggingCastId,
  setDropTargetNodeId,
  onOpenCard,
}: CardSectionsProps) {
  // Sections start open. A closed one stays closed for this visit to the board,
  // so a long list can be folded down while the board is being laid out.
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const toggle = (type: string) =>
    setClosed(current => ({ ...current, [type]: !current[type] }));

  const sectionHeader = (type: string, label: string, count: number) => (
    <button
      type="button"
      className="card-section-head"
      aria-expanded={!closed[type]}
      title={closed[type] ? `Show the ${label.toLowerCase()}` : `Fold the ${label.toLowerCase()} away`}
      onClick={() => toggle(type)}
    >
      <span className="card-section-name">{label}</span>
      <span className="card-section-count">{count}</span>
    </button>
  );

  return (
    <aside className="cast-rail card-sections" aria-label="Cards">
      <section className="card-section" aria-label="Cast">
        <div className="card-section-title">
          <span>Cast</span>
          <span className="card-section-count">{characters.length}</span>
        </div>

        {characters.length === 0 ? (
          <p className="cast-rail-hint">No cast yet — add someone on the Characters tab.</p>
        ) : (
          <>
            {characters.map(character => (
              <div
                key={character.id}
                className={`cast-chip${draggingCastId === character.id ? ' dragging' : ''}`}
                draggable
                title={`Drag ${character.name} onto the canvas`}
                onDragStart={event => {
                  event.dataTransfer.setData(CAST_DRAG_TYPE, character.id);
                  event.dataTransfer.effectAllowed = 'copy';
                  setDraggingCastId(character.id);
                }}
                onDragEnd={() => {
                  setDraggingCastId(null);
                  setDropTargetNodeId(null);
                }}
              >
                <span className="cast-chip-name">{character.name}</span>
                <span className="cast-chip-stats">
                  {[
                    // A character read from an older story may have no level yet;
                    // the chip then shows only its numbers.
                    ...(character.level != null ? [`Lv ${character.level}`] : []),
                    ...(castStats[character.id] ?? [])
                      .slice(0, NODE_STAT_BADGES)
                      .map(stat => `${stat.stat_name} ${stat.value}`),
                  ].join(' · ')}
                </span>
              </div>
            ))}
            <p className="cast-rail-hint">
              Drag a cast member onto the canvas to make a linked node.
            </p>
          </>
        )}
      </section>

      {CARD_SECTIONS.map(option => {
        const names = catalogue(nodes, option.type);
        // An unplaced quest is a ledger row, not a card, so it is listed by the
        // tile that makes its card rather than by a name copied from one.
        const unplaced = option.type === 'quest' ? unplacedQuests : [];

        if (names.length === 0 && unplaced.length === 0) return null;

        return (
          <section
            key={option.type}
            className="card-section"
            aria-label={option.label}
          >
            {sectionHeader(option.type, option.label, names.length + unplaced.length)}

            {!closed[option.type] && (
              <div className="card-section-tiles">
                {unplaced.map(quest => (
                  <div
                    key={`unplaced-${quest.id}`}
                    className="card-tile quest unplaced"
                    draggable
                    data-unplaced-quest={quest.id}
                    title={`Drag “${quest.title}” onto the board to place its card`}
                    onDragStart={event => {
                      event.dataTransfer.setData(QUEST_DRAG_TYPE, quest.id);
                      event.dataTransfer.effectAllowed = 'copy';
                    }}
                  >
                    <span className="card-tile-label">{quest.title}</span>
                    <span
                      className="card-tile-badge"
                      title="This quest is in the ledger with no card on the board"
                    >
                      Unplaced
                    </span>
                  </div>
                ))}
                {names.map(card => (
                  <div
                    key={card.id}
                    className={`card-tile ${option.type}`}
                    draggable
                    title={`Drag another ${card.data.label} card onto the board`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenCard(card.id)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onOpenCard(card.id);
                      }
                    }}
                    onDragStart={event => {
                      event.dataTransfer.setData(CARD_DRAG_TYPE, card.id);
                      event.dataTransfer.effectAllowed = 'copy';
                    }}
                  >
                    <span className="card-tile-label">{card.data.label}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </aside>
  );
}
