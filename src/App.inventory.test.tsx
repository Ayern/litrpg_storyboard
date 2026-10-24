import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock, flowMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  flowMock: { setCenter: vi.fn(), getZoom: vi.fn(() => 1) },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// The canvas, reduced to the parts the app needs to mount a graph.
vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  const Canvas = (props: any) => {
    const { nodes = [], nodeTypes = {}, children, onInit, onNodeClick } = props;
    const Card = nodeTypes.default;

    React.useEffect(() => {
      onInit?.(flowMock);
    }, [onInit]);

    return React.createElement(
      'div',
      { 'data-testid': 'canvas' },
      nodes.map((node: any) =>
        React.createElement(
          'div',
          { key: node.id, className: 'react-flow__node', 'data-id': node.id },
          Card
            ? React.createElement(Card, {
                id: node.id,
                data: node.data,
                isConnectable: true,
                selected: false,
                xPos: 0,
                yPos: 0,
                zIndex: 0,
                dragging: false,
              })
            : null,
          React.createElement(
            'button',
            { key: 'open', onClick: (event: unknown) => onNodeClick?.(event, node) },
            node.data.label
          )
        )
      ),
      children as React.ReactNode
    );
  };

  return {
    default: Canvas,
    Controls: () => null,
    Background: () => null,
    Panel: PassThrough,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    useNodesState: (initial: unknown[]) => {
      const [state, setState] = React.useState(initial);
      return [state, setState, () => {}];
    },
    useEdgesState: (initial: unknown[]) => {
      const [state, setState] = React.useState(initial);
      return [state, setState, () => {}];
    },
  };
});

const story = {
  id: 'story-1',
  title: 'Ledger',
  description: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

const character = {
  id: 'char-1',
  story_id: story.id,
  name: 'Rook',
  description: null,
  level: 3,
  xp: 250,
  rank: 'Bronze',
  xp_to_next: 1000,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

interface ItemRow {
  id: string;
  character_id: string;
  name: string;
  rarity: string | null;
  quantity: number;
  effect: string | null;
  chapter_id: string | null;
  lost_chapter_id: string | null;
  node_id: string | null;
  created_at: string;
  updated_at: string;
}

interface CurrencyRow {
  id: string;
  character_id: string;
  name: string;
  amount: number;
  created_at: string;
  updated_at: string;
}

const nodeRow = (id: string, type: string, label: string) => ({
  id,
  story_id: story.id,
  node_type: type,
  label,
  content: null,
  pos_x: 0,
  pos_y: 0,
  created_by: 'Ada',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  character_id: null,
  chapter_seq: type === 'chapter' ? Number(id.slice(1)) : null,
});

let inventory: ItemRow[] = [];
let currency: CurrencyRow[] = [];

beforeEach(() => {
  inventory = [
    {
      id: 'item-1',
      character_id: 'char-1',
      name: 'Iron Sword',
      rarity: 'Rare',
      quantity: 2,
      effect: '+1 damage',
      chapter_id: 'n1',
      lost_chapter_id: null,
      node_id: 'n5',
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];
  currency = [
    {
      id: 'currency-1',
      character_id: 'char-1',
      name: 'Gold',
      amount: 250,
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return [
          nodeRow('n1', 'chapter', 'Chapter One'),
          nodeRow('n2', 'chapter', 'Chapter Two'),
          nodeRow('n5', 'item', 'Iron Sword'),
          nodeRow('n6', 'item', 'Silver Key'),
        ];
      case 'get_graph_edges':
      case 'get_story_character_stats':
      case 'get_story_skills':
      case 'get_character_skills':
      case 'get_character_stats':
      case 'get_character_attributes':
        return [];
      case 'get_characters':
        return args.storyId === story.id ? [character] : [];
      case 'get_story_inventory':
        return inventory.map(item => ({ ...item }));
      case 'get_character_inventory':
        return inventory
          .filter(item => item.character_id === args.characterId)
          .map(item => ({ ...item }));
      case 'get_character_currency':
        return currency
          .filter(row => row.character_id === args.characterId)
          .map(row => ({ ...row }));
      case 'add_inventory_item': {
        const saved: ItemRow = {
          id: `item-${inventory.length + 1}`,
          character_id: args.characterId,
          name: args.name,
          rarity: args.rarity ?? null,
          quantity: args.quantity,
          effect: args.effect ?? null,
          chapter_id: args.chapterId ?? null,
          lost_chapter_id: args.lostChapterId ?? null,
          node_id: args.nodeId ?? null,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        inventory = [...inventory, saved];
        return { ...saved };
      }
      case 'update_inventory_item': {
        const existing = inventory.find(item => item.id === args.id);
        if (!existing) return null;

        const updated: ItemRow = {
          ...existing,
          name: args.name,
          rarity: args.rarity ?? null,
          quantity: args.quantity,
          effect: args.effect ?? null,
          chapter_id: args.chapterId ?? null,
          lost_chapter_id: args.lostChapterId ?? null,
          node_id: args.nodeId ?? null,
        };
        inventory = inventory.map(item => (item.id === updated.id ? updated : item));
        return { ...updated };
      }
      case 'delete_inventory_item':
        inventory = inventory.filter(item => item.id !== args.id);
        return null;
      case 'add_currency': {
        const saved: CurrencyRow = {
          id: `currency-${currency.length + 1}`,
          character_id: args.characterId,
          name: args.name,
          amount: args.amount,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        currency = [...currency, saved];
        return { ...saved };
      }
      case 'update_currency': {
        const existing = currency.find(row => row.id === args.id);
        if (!existing) return null;

        const updated: CurrencyRow = {
          ...existing,
          name: args.name,
          amount: args.amount,
        };
        currency = currency.map(row => (row.id === updated.id ? updated : row));
        return { ...updated };
      }
      case 'delete_currency':
        currency = currency.filter(row => row.id !== args.id);
        return null;
      default:
        return null;
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

async function openSheet() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await screen.findByRole('button', { name: 'Chapter One' });
  await user.click(screen.getByRole('button', { name: 'Characters' }));
  await user.click(screen.getByTitle("Show Rook's sheet"));

  return user;
}

function itemRow(name: string) {
  const label = screen.getByText(name, { selector: '.inventory-name' });
  const row = label.closest('.inventory-row');
  if (!row) throw new Error(`no inventory row for ${name}`);
  return within(row as HTMLElement);
}

function currencyRow(name: string) {
  const label = screen.getByText(name, { selector: '.currency-name' });
  const row = label.closest('.currency-row');
  if (!row) throw new Error(`no currency row for ${name}`);
  return within(row as HTMLElement);
}

async function openChapters() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Chapters' }));

  return user;
}

function continuityFlags(panel: HTMLElement) {
  return [...panel.querySelectorAll('li')].map(item => item.textContent);
}

describe('inventory on the character sheet', () => {
  it('lists an item with its quantity, rarity, effect and chapter', async () => {
    await openSheet();

    expect(screen.getByRole('heading', { name: 'Inventory' })).toBeInTheDocument();
    expect(itemRow('Iron Sword').getByText('×2')).toBeInTheDocument();
    expect(itemRow('Iron Sword').getByText('Rare')).toBeInTheDocument();
    expect(itemRow('Iron Sword').getByText('+1 damage')).toBeInTheDocument();
    expect(itemRow('Iron Sword').getByText('Found in Chapter One')).toBeInTheDocument();
    expect(itemRow('Iron Sword').getByText('Card: Iron Sword')).toBeInTheDocument();
  });

  it('names the chapter an item was lost in', async () => {
    inventory[0].lost_chapter_id = 'n2';

    await openSheet();

    expect(itemRow('Iron Sword').getByText('Lost in Chapter Two')).toBeInTheDocument();
  });

  it('adds an item with its quantity, chapter and card', async () => {
    const user = await openSheet();

    await user.type(screen.getByLabelText('New item name'), 'Silver Key');
    await user.type(screen.getByLabelText('New item rarity'), 'Common');
    await user.clear(screen.getByLabelText('New item quantity'));
    await user.type(screen.getByLabelText('New item quantity'), '3');
    await user.type(screen.getByLabelText('New item effect'), 'Opens the vault');
    await user.selectOptions(screen.getByLabelText('New item chapter'), 'n2');
    await user.selectOptions(screen.getByLabelText('New item lost chapter'), 'n1');
    await user.selectOptions(screen.getByLabelText('New item card'), 'n6');
    await user.click(screen.getByRole('button', { name: 'Add item' }));

    expect(lastCall('add_inventory_item')).toMatchObject({
      characterId: 'char-1',
      name: 'Silver Key',
      rarity: 'Common',
      quantity: 3,
      effect: 'Opens the vault',
      chapterId: 'n2',
      lostChapterId: 'n1',
      nodeId: 'n6',
    });

    expect(itemRow('Silver Key').getByText('×3')).toBeInTheDocument();
    expect(itemRow('Silver Key').getByText('Found in Chapter Two')).toBeInTheDocument();
    expect(itemRow('Silver Key').getByText('Lost in Chapter One')).toBeInTheDocument();
  });

  it('edits an item in place, quantity and all', async () => {
    const user = await openSheet();

    await user.click(itemRow('Iron Sword').getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Item name'));
    await user.type(screen.getByLabelText('Item name'), 'Greater Iron Sword');
    await user.clear(screen.getByLabelText('Item rarity'));
    await user.type(screen.getByLabelText('Item rarity'), 'Epic');
    await user.clear(screen.getByLabelText('Item quantity'));
    await user.type(screen.getByLabelText('Item quantity'), '4');
    await user.selectOptions(screen.getByLabelText('Item chapter acquired'), 'n2');
    await user.selectOptions(screen.getByLabelText('Item chapter lost'), 'n1');
    await user.selectOptions(screen.getByLabelText('Item card'), 'n6');
    await user.click(screen.getByRole('button', { name: 'Save item' }));

    expect(lastCall('update_inventory_item')).toMatchObject({
      id: 'item-1',
      name: 'Greater Iron Sword',
      rarity: 'Epic',
      quantity: 4,
      effect: '+1 damage',
      chapterId: 'n2',
      lostChapterId: 'n1',
      nodeId: 'n6',
    });

    expect(itemRow('Greater Iron Sword').getByText('×4')).toBeInTheDocument();
    expect(itemRow('Greater Iron Sword').getByText('Epic')).toBeInTheDocument();
    expect(itemRow('Greater Iron Sword').getByText('Found in Chapter Two')).toBeInTheDocument();
    expect(itemRow('Greater Iron Sword').getByText('Lost in Chapter One')).toBeInTheDocument();
  });

  it('deletes an item without touching the character', async () => {
    const user = await openSheet();

    await user.click(itemRow('Iron Sword').getByRole('button', { name: 'Delete' }));

    expect(lastCall('delete_inventory_item')).toEqual({ id: 'item-1', user: 'You' });
    expect(
      screen.queryByText('Iron Sword', { selector: '.inventory-name' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('No items yet — add one below.')).toBeInTheDocument();
  });

  it('refuses a quantity that is not a whole number', async () => {
    const user = await openSheet();

    await user.type(screen.getByLabelText('New item name'), 'Silver Key');
    await user.clear(screen.getByLabelText('New item quantity'));
    await user.type(screen.getByLabelText('New item quantity'), '1.5');
    await user.click(screen.getByRole('button', { name: 'Add item' }));

    expect(
      screen.getByText('An item needs a whole-number quantity, zero or more.')
    ).toBeInTheDocument();
    expect(lastCall('add_inventory_item')).toBeUndefined();
  });
});

describe('currency on the character sheet', () => {
  it('lists a named amount', async () => {
    await openSheet();

    expect(screen.getByRole('heading', { name: 'Currency' })).toBeInTheDocument();
    expect(currencyRow('Gold').getByText('250')).toBeInTheDocument();
  });

  it('adds, edits and deletes a currency without touching the others', async () => {
    const user = await openSheet();

    await user.type(screen.getByLabelText('New currency name'), 'Mana Crystals');
    await user.clear(screen.getByLabelText('New currency amount'));
    await user.type(screen.getByLabelText('New currency amount'), '40');
    await user.click(screen.getByRole('button', { name: 'Add currency' }));

    expect(lastCall('add_currency')).toMatchObject({
      characterId: 'char-1',
      name: 'Mana Crystals',
      amount: 40,
    });
    expect(currencyRow('Mana Crystals').getByText('40')).toBeInTheDocument();

    await user.click(currencyRow('Mana Crystals').getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Currency amount'));
    await user.type(screen.getByLabelText('Currency amount'), '75');
    await user.click(screen.getByRole('button', { name: 'Save currency' }));

    expect(lastCall('update_currency')).toMatchObject({
      id: 'currency-2',
      name: 'Mana Crystals',
      amount: 75,
    });
    expect(currencyRow('Mana Crystals').getByText('75')).toBeInTheDocument();

    await user.click(currencyRow('Mana Crystals').getByRole('button', { name: 'Delete' }));
    expect(lastCall('delete_currency')).toEqual({ id: 'currency-2', user: 'You' });
    expect(currencyRow('Gold').getByText('250')).toBeInTheDocument();
  });
});

describe('items on the board', () => {
  it('names who carries an item, with the count, rarity and chapter', async () => {
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Iron Sword', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    expect(card).not.toBeNull();
    const withinCard = within(card as HTMLElement);
    expect(withinCard.getByText('Rook')).toBeInTheDocument();
    expect(withinCard.getByText('×2')).toBeInTheDocument();
    expect(withinCard.getByText('Rare')).toBeInTheDocument();
    expect(withinCard.getByText('Chapter One')).toBeInTheDocument();
  });

  it('says so when nobody is carrying the item yet', async () => {
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Silver Key', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    expect(card).not.toBeNull();
    expect(
      within(card as HTMLElement).getByText('No one is carrying this item yet')
    ).toBeInTheDocument();
  });

  it('names where the holder lost the item', async () => {
    inventory[0].lost_chapter_id = 'n2';

    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Iron Sword', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    expect(
      within(card as HTMLElement).getByText('lost in Chapter Two')
    ).toBeInTheDocument();
  });

  it('puts a still-carried warning on the chapter card it belongs to', async () => {
    inventory[0].lost_chapter_id = 'n2';

    render(<App />);

    await screen.findAllByText('Ledger');
    const lostIn = (
      await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
    ).closest('.graph-node');
    const acquiredIn = (
      await screen.findByText('Chapter One', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    expect(
      within(lostIn as HTMLElement).getByText('Rook still has “Iron Sword” (×2)')
    ).toBeInTheDocument();
    expect(within(acquiredIn as HTMLElement).queryByText(/still has/)).not.toBeInTheDocument();
  });

  it('puts a lost-before-acquired warning on the lost chapter card', async () => {
    inventory[0].chapter_id = 'n2';
    inventory[0].lost_chapter_id = 'n1';

    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Chapter One', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    expect(
      within(card as HTMLElement).getByText('Rook\'s “Iron Sword” lost before acquired')
    ).toBeInTheDocument();
  });

  it('clears the lost chapter from the warning without leaving the board', async () => {
    inventory[0].lost_chapter_id = 'n2';

    const user = userEvent.setup();
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    await user.click(
      within(card as HTMLElement).getByRole('button', {
        name: 'Mark Iron Sword returned',
      })
    );

    expect(lastCall('update_inventory_item')).toMatchObject({
      id: 'item-1',
      name: 'Iron Sword',
      quantity: 2,
      chapterId: 'n1',
      lostChapterId: null,
      nodeId: 'n5',
      user: 'You',
    });

    await waitFor(() =>
      expect(
        screen.queryByText('Rook still has “Iron Sword” (×2)')
      ).not.toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: 'Graph' })).toHaveClass('active');

    const itemCard = (
      screen.getByText('Iron Sword', { selector: '.graph-node-label' }).closest('.graph-node')
    );
    expect(within(itemCard as HTMLElement).queryByText('lost in Chapter Two')).not.toBeInTheDocument();
  });

  it('puts the lost chapter back from the board notice', async () => {
    inventory[0].lost_chapter_id = 'n2';

    const user = userEvent.setup();
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    await user.click(
      within(card as HTMLElement).getByRole('button', {
        name: 'Mark Iron Sword returned',
      })
    );

    expect(await screen.findByText('Marked “Iron Sword” returned.')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Undo marking Iron Sword returned' })
    );

    expect(lastCall('update_inventory_item')).toMatchObject({
      id: 'item-1',
      name: 'Iron Sword',
      quantity: 2,
      chapterId: 'n1',
      lostChapterId: 'n2',
      nodeId: 'n5',
      user: 'You',
    });
    await waitFor(() =>
      expect(screen.getByText('Rook still has “Iron Sword” (×2)')).toBeInTheDocument()
    );
    expect(screen.getByText('Undid: Mark “Iron Sword” returned')).toBeInTheDocument();
    expect(screen.queryByText('Marked “Iron Sword” returned.')).not.toBeInTheDocument();

    const itemCard = (
      screen.getByText('Iron Sword', { selector: '.graph-node-label' }).closest('.graph-node')
    );
    expect(within(itemCard as HTMLElement).getByText('lost in Chapter Two')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Redo' }));
    expect(lastCall('update_inventory_item')).toMatchObject({ lostChapterId: null });
    await waitFor(() =>
      expect(screen.queryByText('Rook still has “Iron Sword” (×2)')).not.toBeInTheDocument()
    );
  });

  it('keeps later item edits when the return is undone', async () => {
    inventory[0].lost_chapter_id = 'n2';

    const user = userEvent.setup();
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    await user.click(
      within(card as HTMLElement).getByRole('button', {
        name: 'Mark Iron Sword returned',
      })
    );
    await screen.findByText('Marked “Iron Sword” returned.');

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(screen.getByTitle("Show Rook's sheet"));
    await user.click(itemRow('Iron Sword').getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Item name'));
    await user.type(screen.getByLabelText('Item name'), 'Greater Iron Sword');
    await user.clear(screen.getByLabelText('Item quantity'));
    await user.type(screen.getByLabelText('Item quantity'), '4');
    await user.clear(screen.getByLabelText('Item rarity'));
    await user.type(screen.getByLabelText('Item rarity'), 'Legendary');
    await user.clear(screen.getByLabelText('Item effect'));
    await user.type(screen.getByLabelText('Item effect'), '+3 damage');
    await user.click(screen.getByRole('button', { name: 'Save item' }));

    await waitFor(() =>
      expect(itemRow('Greater Iron Sword').getByText('Legendary')).toBeInTheDocument()
    );

    await user.click(
      screen.getByRole('button', { name: 'Undo marking Iron Sword returned' })
    );

    expect(lastCall('update_inventory_item')).toMatchObject({
      id: 'item-1',
      name: 'Greater Iron Sword',
      quantity: 4,
      rarity: 'Legendary',
      effect: '+3 damage',
      lostChapterId: 'n2',
    });
    const undoneRow = itemRow('Greater Iron Sword');
    expect(undoneRow.getByText('×4')).toBeInTheDocument();
    expect(undoneRow.getByText('Legendary')).toBeInTheDocument();
    expect(undoneRow.getByText('+3 damage')).toBeInTheDocument();
    expect(undoneRow.getByText('Lost in Chapter Two')).toBeInTheDocument();
  });

  it('keeps later item edits when the return is redone', async () => {
    inventory[0].lost_chapter_id = 'n2';

    const user = userEvent.setup();
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    await user.click(
      within(card as HTMLElement).getByRole('button', {
        name: 'Mark Iron Sword returned',
      })
    );
    await screen.findByText('Marked “Iron Sword” returned.');

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(screen.getByTitle("Show Rook's sheet"));
    await user.click(itemRow('Iron Sword').getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Item name'));
    await user.type(screen.getByLabelText('Item name'), 'Greater Iron Sword');
    await user.clear(screen.getByLabelText('Item quantity'));
    await user.type(screen.getByLabelText('Item quantity'), '4');
    await user.clear(screen.getByLabelText('Item rarity'));
    await user.type(screen.getByLabelText('Item rarity'), 'Legendary');
    await user.clear(screen.getByLabelText('Item effect'));
    await user.type(screen.getByLabelText('Item effect'), '+3 damage');
    await user.click(screen.getByRole('button', { name: 'Save item' }));

    await user.click(
      screen.getByRole('button', { name: 'Undo marking Iron Sword returned' })
    );
    await waitFor(() =>
      expect(itemRow('Greater Iron Sword').getByText('Lost in Chapter Two')).toBeInTheDocument()
    );

    await user.click(itemRow('Greater Iron Sword').getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Item name'));
    await user.type(screen.getByLabelText('Item name'), 'Iron Sword of Dawn');
    await user.clear(screen.getByLabelText('Item quantity'));
    await user.type(screen.getByLabelText('Item quantity'), '5');
    await user.clear(screen.getByLabelText('Item rarity'));
    await user.type(screen.getByLabelText('Item rarity'), 'Mythic');
    await user.clear(screen.getByLabelText('Item effect'));
    await user.type(screen.getByLabelText('Item effect'), '+5 damage');
    await user.click(screen.getByRole('button', { name: 'Save item' }));

    await waitFor(() =>
      expect(itemRow('Iron Sword of Dawn').getByText('Mythic')).toBeInTheDocument()
    );

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await user.click(screen.getByRole('button', { name: 'Redo' }));

    expect(lastCall('update_inventory_item')).toMatchObject({
      id: 'item-1',
      name: 'Iron Sword of Dawn',
      quantity: 5,
      rarity: 'Mythic',
      effect: '+5 damage',
      chapterId: 'n1',
      lostChapterId: null,
      nodeId: 'n5',
    });

    const itemCard = (
      screen.getByText('Iron Sword', { selector: '.graph-node-label' }).closest('.graph-node')
    );
    expect(within(itemCard as HTMLElement).getByText('Mythic')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(itemCard as HTMLElement).queryByText('lost in Chapter Two')).not.toBeInTheDocument()
    );
  });

  it('keeps later item edits through keyboard undo and redo', async () => {
    inventory[0].lost_chapter_id = 'n2';

    const user = userEvent.setup();
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    await user.click(
      within(card as HTMLElement).getByRole('button', {
        name: 'Mark Iron Sword returned',
      })
    );
    await screen.findByText('Marked “Iron Sword” returned.');

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(screen.getByTitle("Show Rook's sheet"));
    await user.click(itemRow('Iron Sword').getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Item name'));
    await user.type(screen.getByLabelText('Item name'), 'Greater Iron Sword');
    await user.clear(screen.getByLabelText('Item quantity'));
    await user.type(screen.getByLabelText('Item quantity'), '4');
    await user.clear(screen.getByLabelText('Item rarity'));
    await user.type(screen.getByLabelText('Item rarity'), 'Legendary');
    await user.clear(screen.getByLabelText('Item effect'));
    await user.type(screen.getByLabelText('Item effect'), '+3 damage');
    await user.click(screen.getByRole('button', { name: 'Save item' }));

    await waitFor(() =>
      expect(itemRow('Greater Iron Sword').getByText('Legendary')).toBeInTheDocument()
    );

    await user.keyboard('{Control>}z{/Control}');

    await waitFor(() =>
      expect(lastCall('update_inventory_item')).toMatchObject({
        id: 'item-1',
        name: 'Greater Iron Sword',
        quantity: 4,
        rarity: 'Legendary',
        effect: '+3 damage',
        lostChapterId: 'n2',
      })
    );
    const undoneRow = itemRow('Greater Iron Sword');
    expect(undoneRow.getByText('×4')).toBeInTheDocument();
    expect(undoneRow.getByText('+3 damage')).toBeInTheDocument();
    expect(undoneRow.getByText('Lost in Chapter Two')).toBeInTheDocument();

    await user.click(itemRow('Greater Iron Sword').getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Item name'));
    await user.type(screen.getByLabelText('Item name'), 'Iron Sword of Dawn');
    await user.clear(screen.getByLabelText('Item quantity'));
    await user.type(screen.getByLabelText('Item quantity'), '5');
    await user.clear(screen.getByLabelText('Item rarity'));
    await user.type(screen.getByLabelText('Item rarity'), 'Mythic');
    await user.clear(screen.getByLabelText('Item effect'));
    await user.type(screen.getByLabelText('Item effect'), '+5 damage');
    await user.click(screen.getByRole('button', { name: 'Save item' }));

    await waitFor(() =>
      expect(itemRow('Iron Sword of Dawn').getByText('Mythic')).toBeInTheDocument()
    );

    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');

    await waitFor(() =>
      expect(lastCall('update_inventory_item')).toMatchObject({
        id: 'item-1',
        name: 'Iron Sword of Dawn',
        quantity: 5,
        rarity: 'Mythic',
        effect: '+5 damage',
        lostChapterId: null,
      })
    );
    const redoneRow = itemRow('Iron Sword of Dawn');
    expect(redoneRow.getByText('×5')).toBeInTheDocument();
    expect(redoneRow.getByText('Mythic')).toBeInTheDocument();
    expect(redoneRow.queryByText('Lost in Chapter Two')).not.toBeInTheDocument();
  });

  it('keeps the return in history after its notice is dismissed', async () => {
    inventory[0].lost_chapter_id = 'n2';

    const user = userEvent.setup();
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    await user.click(
      within(card as HTMLElement).getByRole('button', {
        name: 'Mark Iron Sword returned',
      })
    );
    await screen.findByText('Marked “Iron Sword” returned.');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Marked “Iron Sword” returned.')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Undo marking Iron Sword returned' })
    ).not.toBeInTheDocument();

    await user.keyboard('{Control>}z{/Control}');

    await waitFor(() =>
      expect(lastCall('update_inventory_item')).toMatchObject({
        id: 'item-1',
        name: 'Iron Sword',
        quantity: 2,
        lostChapterId: 'n2',
      })
    );
    await waitFor(() =>
      expect(screen.getByText('Rook still has “Iron Sword” (×2)')).toBeInTheDocument()
    );
    expect(screen.getByText('Undid: Mark “Iron Sword” returned')).toBeInTheDocument();

    const itemCard = (
      screen.getByText('Iron Sword', { selector: '.graph-node-label' }).closest('.graph-node')
    );
    expect(within(itemCard as HTMLElement).getByText('lost in Chapter Two')).toBeInTheDocument();
  });

  it('expires its notice on time and still leaves the undo step', async () => {
    inventory[0].lost_chapter_id = 'n2';

    const user = userEvent.setup();
    const expire = { run: null as null | (() => void) };
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: any[]
    ) => {
      if (delay === 10000 && typeof handler === 'function') {
        expire.run = () => handler(...args);
        return 0;
      }

      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout);

    try {
      render(<App />);

      await screen.findAllByText('Ledger');
      const card = (
        await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
      ).closest('.graph-node');

      await user.click(
        within(card as HTMLElement).getByRole('button', {
          name: 'Mark Iron Sword returned',
        })
      );
      await screen.findByText('Marked “Iron Sword” returned.');

      expect(expire.run).not.toBeNull();
      act(() => expire.run?.());

      expect(screen.queryByText('Marked “Iron Sword” returned.')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Undo marking Iron Sword returned' })
      ).not.toBeInTheDocument();

      await user.keyboard('{Control>}z{/Control}');

      await waitFor(() =>
        expect(lastCall('update_inventory_item')).toMatchObject({
          id: 'item-1',
          name: 'Iron Sword',
          quantity: 2,
          lostChapterId: 'n2',
        })
      );
      await waitFor(() =>
        expect(screen.getByText('Rook still has “Iron Sword” (×2)')).toBeInTheDocument()
      );
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('leaves Ctrl+Z to the item form, then undoes once focus leaves', async () => {
    inventory[0].lost_chapter_id = 'n2';

    const user = userEvent.setup();
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    await user.click(
      within(card as HTMLElement).getByRole('button', {
        name: 'Mark Iron Sword returned',
      })
    );
    await screen.findByText('Marked “Iron Sword” returned.');

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(screen.getByTitle("Show Rook's sheet"));
    await user.click(itemRow('Iron Sword').getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByLabelText('Item name'));
    await user.type(screen.getByLabelText('Item name'), ' (draft)');

    await user.keyboard('{Control>}z{/Control}');

    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'update_inventory_item')
    ).toHaveLength(1);
    expect(screen.getByText('Marked “Iron Sword” returned.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Undo marking Iron Sword returned' })
    ).toBeInTheDocument();

    const chapterSelect = screen.getByLabelText('Item chapter acquired');
    await user.selectOptions(chapterSelect, 'n2');
    expect(chapterSelect).toHaveFocus();

    await user.keyboard('{Control>}z{/Control}');

    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'update_inventory_item')
    ).toHaveLength(1);
    expect(screen.getByText('Marked “Iron Sword” returned.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Undo marking Iron Sword returned' })
    ).toBeInTheDocument();

    const itemCardSelect = screen.getByLabelText('Item card');
    await user.selectOptions(itemCardSelect, 'n6');
    expect(itemCardSelect).toHaveFocus();

    await user.keyboard('{Control>}z{/Control}');

    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'update_inventory_item')
    ).toHaveLength(1);
    expect(screen.getByText('Marked “Iron Sword” returned.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Undo marking Iron Sword returned' })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    expect(itemCardSelect).not.toHaveFocus();

    await user.keyboard('{Control>}z{/Control}');

    await waitFor(() =>
      expect(lastCall('update_inventory_item')).toMatchObject({
        id: 'item-1',
        name: 'Iron Sword',
        quantity: 2,
        lostChapterId: 'n2',
      })
    );
    expect(screen.queryByText('Marked “Iron Sword” returned.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Item name')).toHaveValue('Iron Sword (draft)');
    expect(chapterSelect).toHaveValue('n2');
    expect(itemCardSelect).toHaveValue('n6');
    expect(screen.getByRole('button', { name: 'Save item' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await waitFor(() =>
      expect(screen.getByText('Rook still has “Iron Sword” (×2)')).toBeInTheDocument()
    );

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    expect(screen.getByLabelText('Item name')).toHaveValue('Iron Sword (draft)');
    await user.click(screen.getByRole('button', { name: 'Save item' }));

    expect(lastCall('update_inventory_item')).toMatchObject({
      id: 'item-1',
      name: 'Iron Sword (draft)',
      quantity: 2,
      chapterId: 'n2',
      lostChapterId: null,
      nodeId: 'n6',
      user: 'You',
    });

    const savedRow = itemRow('Iron Sword (draft)');
    expect(savedRow.getByText('Found in Chapter Two')).toBeInTheDocument();
    expect(savedRow.getByText('Card: Silver Key')).toBeInTheDocument();
    expect(savedRow.queryByText('Lost in Chapter Two')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await waitFor(() =>
      expect(
        screen.queryByText('Rook still has “Iron Sword” (×2)')
      ).not.toBeInTheDocument()
    );
  });

  it('opens the holder\'s sheet from a warning on the chapter card', async () => {
    inventory[0].lost_chapter_id = 'n2';

    const user = userEvent.setup();
    render(<App />);

    await screen.findAllByText('Ledger');
    const card = (
      await screen.findByText('Chapter Two', { selector: '.graph-node-label' })
    ).closest('.graph-node');

    await user.click(
      within(card as HTMLElement).getByRole('button', { name: /Open Rook's sheet/ })
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Characters' })).toHaveClass('active')
    );
    expect(document.querySelector('[data-character-id="char-1"]')).toHaveClass('active');
    expect(screen.getByRole('heading', { name: 'Rook' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Inventory' })).toBeInTheDocument();
    expect(screen.getByLabelText('New item name')).toBeInTheDocument();
  });
});

describe('inventory continuity', () => {
  it('flags an item marked lost but still carried', async () => {
    inventory[0].lost_chapter_id = 'n2';

    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });
    expect(continuityFlags(panel)).toContain(
      'Rook\'s “Iron Sword” is marked lost in “Chapter Two” but is still carried (×2).'
    );
  });

  it('flags an item lost before it was acquired', async () => {
    inventory[0].chapter_id = 'n2';
    inventory[0].lost_chapter_id = 'n1';

    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });
    expect(continuityFlags(panel)).toContain(
      'Rook\'s “Iron Sword” is marked lost in “Chapter One” before it was acquired in “Chapter Two”.'
    );
  });

  it('leaves a lost item alone once its count is zero', async () => {
    inventory[0].quantity = 0;
    inventory[0].lost_chapter_id = 'n2';

    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });
    expect(continuityFlags(panel).some(flag => flag?.includes('marked lost'))).toBe(false);
  });
});
