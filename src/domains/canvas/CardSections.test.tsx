import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Node } from 'reactflow';

import type { Character, CharacterStat } from '../shared/types';
import { CardSections } from './CardSections';
import type { NodeData } from './types';

// jsdom has no DataTransfer, so a drag is a plain object with the two methods the
// component uses.
function dragPayload() {
  const store: Record<string, string> = {};

  return {
    types: () => Object.keys(store),
    effectAllowed: '',
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? '',
  };
}

function card(id: string, label: string, nodeType: string): Node<NodeData> {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { label, nodeType, content: '', createdBy: 'Ada' },
  };
}

const cast: Character[] = [
  {
    id: 'char-1',
    story_id: 'story-1',
    name: 'Rook',
    description: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
    level: 4,
  },
  {
    id: 'char-2',
    story_id: 'story-1',
    name: 'Wren',
    description: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
];

const stats: Record<string, CharacterStat[]> = {
  'char-1': [
    {
      id: 'stat-1',
      character_id: 'char-1',
      stat_name: 'HP',
      value: 20,
      notes: null,
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ],
};

const cards = [
  card('n-ch', 'Opening', 'chapter'),
  card('n-quest', 'Find the vault', 'quest'),
  card('n-item-b', 'Tooth key', 'item'),
  card('n-item-a', 'Ash glass', 'item'),
  card('n-skill', 'Ember Whisper', 'skill'),
  card('n-ghost', 'Ghost', 'character'),
];

function props(overrides: Partial<React.ComponentProps<typeof CardSections>> = {}) {
  return {
    characters: cast,
    castStats: stats,
    nodes: cards,
    unplacedQuests: [],
    draggingCastId: null,
    setDraggingCastId: vi.fn(),
    setDropTargetNodeId: vi.fn(),
    onOpenCard: vi.fn(),
    ...overrides,
  };
}

function rail() {
  return screen.getByRole('complementary', { name: 'Cards' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the board’s side sections', () => {
  it('opens with the cast list and one section per kind of card the story holds', () => {
    render(<CardSections {...props()} />);

    const castSection = screen.getByRole('region', { name: 'Cast' });
    expect(within(castSection).getByText('Rook')).toBeInTheDocument();
    expect(within(castSection).getByText('Wren')).toBeInTheDocument();
    // A character with no level yet shows only the numbers it has.
    expect(within(castSection).getByText('Lv 4 · HP 20')).toBeInTheDocument();

    // The sections name the kinds that have cards, and count them.
    const items = screen.getByRole('region', { name: 'Items' });
    expect(within(items).getByRole('button', { name: /Items/ })).toHaveTextContent('2');
    expect(screen.getByRole('region', { name: 'Quests' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Skills' })).toBeInTheDocument();

    // A kind with nothing in the story gets no section at all.
    expect(screen.queryByRole('region', { name: 'Locations' })).not.toBeInTheDocument();

    // The spine and the cast are not repeated here: a chapter is on the board by
    // design, and a character is a cast chip rather than a tile.
    expect(screen.queryByRole('region', { name: 'Chapters' })).not.toBeInTheDocument();
    expect(rail().querySelectorAll('.card-tile.character')).toHaveLength(0);
  });

  it('lists a section’s names in order', () => {
    render(<CardSections {...props()} />);

    const items = screen.getByRole('region', { name: 'Items' });
    const labels = Array.from(items.querySelectorAll('.card-tile-label')).map(
      tile => tile.textContent
    );

    expect(labels).toEqual(['Ash glass', 'Tooth key']);
  });

  it('names a thing once, however many cards of it the board holds', () => {
    // The same skill, written twice: two people hold Brine-Lung in two chapters.
    render(
      <CardSections
        {...props({
          nodes: [
            ...cards,
            card('n-skill-2', 'Ember Whisper', 'skill'),
            card('n-skill-3', 'Ember Whisper', 'skill'),
          ],
        })}
      />
    );

    const skills = screen.getByRole('region', { name: 'Skills' });
    expect(within(skills).getAllByText('Ember Whisper')).toHaveLength(1);
    // The count is the number of things the story has, not of cards on it.
    expect(within(skills).getByRole('button', { name: /Skills/ })).toHaveTextContent('1');
  });

  it('folds a section away and back', async () => {
    const user = userEvent.setup();
    render(<CardSections {...props()} />);

    const items = screen.getByRole('region', { name: 'Items' });
    const head = within(items).getByRole('button', { name: /Items/ });

    expect(head).toHaveAttribute('aria-expanded', 'true');

    await user.click(head);

    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(within(items).queryByText('Tooth key')).not.toBeInTheDocument();
    // The other sections are untouched: one fold closes one list.
    expect(
      within(screen.getByRole('region', { name: 'Skills' })).getByText('Ember Whisper')
    ).toBeInTheDocument();

    await user.click(head);

    expect(head).toHaveAttribute('aria-expanded', 'true');
    expect(within(items).getByText('Tooth key')).toBeInTheDocument();
  });

  it('carries the card’s id, not its name, when a tile is dragged', () => {
    render(<CardSections {...props()} />);

    const tile = screen.getByText('Tooth key').closest('.card-tile') as HTMLElement;
    const payload = dragPayload();

    fireEvent.dragStart(tile, { dataTransfer: payload });

    // A copy is about to be made, so the drag is a copy rather than a move.
    expect(payload.getData('application/x-litrpg-card')).toBe('n-item-b');
    expect(payload.effectAllowed).toBe('copy');
  });

  it('lists a quest with no card as unplaced, and drags its ledger row', () => {
    render(
      <CardSections
        {...props({ unplacedQuests: [{ id: 'q-1', title: 'The Ledger' }] })}
      />
    );

    const quests = screen.getByRole('region', { name: 'Quests' });
    const tile = within(quests).getByText('The Ledger').closest('.card-tile') as HTMLElement;

    // The badge says why the tile looks unlike a card: there is no card yet.
    expect(tile).toHaveTextContent('Unplaced');
    expect(tile).toHaveClass('unplaced');

    const payload = dragPayload();
    fireEvent.dragStart(tile, { dataTransfer: payload });

    // A quest still in the ledger carries its row, not a card id.
    expect(payload.getData('application/x-litrpg-quest')).toBe('q-1');
    expect(payload.effectAllowed).toBe('copy');
  });

  it('keeps a kind’s section when the only thing in it has no card yet', () => {
    render(
      <CardSections
        {...props({
          nodes: cards.filter(entry => entry.data.nodeType !== 'quest'),
          unplacedQuests: [{ id: 'q-1', title: 'The Ledger' }],
        })}
      />
    );

    const quests = screen.getByRole('region', { name: 'Quests' });
    expect(within(quests).getByText('The Ledger')).toBeInTheDocument();
    // The count is everything the section lists, card or not.
    expect(within(quests).getByRole('button', { name: /Quests/ })).toHaveTextContent('1');
  });

  it('gives a tile nothing to delete: the cards are removed where they are', () => {
    render(<CardSections {...props()} />);

    expect(rail().querySelectorAll('.card-tile button')).toHaveLength(0);
  });

  it('marks the cast chip being dragged and clears it when the drag ends', () => {
    const setDraggingCastId = vi.fn();
    const setDropTargetNodeId = vi.fn();

    render(<CardSections {...props({ setDraggingCastId, setDropTargetNodeId })} />);

    const chip = screen.getByText('Rook').closest('.cast-chip') as HTMLElement;
    const payload = dragPayload();

    fireEvent.dragStart(chip, { dataTransfer: payload });

    // A person is a card pointing at them, not a copy of a card: the app makes a
    // linked node.
    expect(payload.getData('application/x-litrpg-character')).toBe('char-1');
    expect(payload.effectAllowed).toBe('copy');
    expect(setDraggingCastId).toHaveBeenCalledWith('char-1');

    fireEvent.dragEnd(chip, { dataTransfer: payload });

    expect(setDraggingCastId).toHaveBeenLastCalledWith(null);
    expect(setDropTargetNodeId).toHaveBeenLastCalledWith(null);
  });

  it('opens a card when its tile is clicked, or chosen from the keyboard', async () => {
    const user = userEvent.setup();
    const onOpenCard = vi.fn();

    render(<CardSections {...props({ onOpenCard })} />);

    const tile = screen.getByText('Tooth key').closest('.card-tile') as HTMLElement;

    await user.click(tile);
    expect(onOpenCard).toHaveBeenLastCalledWith('n-item-b');

    tile.focus();
    await user.keyboard('{Enter}');
    expect(onOpenCard).toHaveBeenLastCalledWith('n-item-b');

    await user.keyboard(' ');
    expect(onOpenCard).toHaveBeenLastCalledWith('n-item-b');
  });

  it('says so when the story has no cast yet', () => {
    render(<CardSections {...props({ characters: [] })} />);

    expect(
      within(screen.getByRole('region', { name: 'Cast' })).getByText(/No cast yet/)
    ).toBeInTheDocument();
  });
});
