import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// React Flow needs real DOM measurements, so the canvas draws every node through
// the card map the app registers. That keeps the badges, which live on the card,
// under test exactly as they are drawn.
vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  interface CanvasProps {
    nodes?: { id: string; data: unknown; className?: string }[];
    nodeTypes?: Record<string, React.ComponentType<Record<string, unknown>>>;
    onInit?: (instance: unknown) => void;
    onNodesDelete?: (nodes: unknown[]) => void;
    children?: unknown;
  }

  // The wrapper mirrors React Flow's own: the drop handler reads a node's id
  // from it, and a relink target is marked with a class on it. `onInit` hands the
  // app the one method a drop asks for, so a placement lands where the pointer
  // was; the board is unzoomed here, so screen and board coordinates agree. The
  // delete button stands in for React Flow's Delete key.
  const Canvas = ({
    nodes = [],
    nodeTypes = {},
    onInit,
    onNodesDelete,
    children,
  }: CanvasProps) => {
    const Card = nodeTypes.default;

    React.useEffect(() => {
      onInit?.({
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      });
    }, [onInit]);

    return React.createElement(
      'div',
      { 'data-testid': 'canvas' },
      nodes.map((node, index) =>
        React.createElement(
          'div',
          {
            key: node.id,
            className: `react-flow__node ${node.className ?? ''}`.trim(),
            'data-id': node.id,
          },
          Card
            ? React.createElement(Card, {
                id: node.id,
                data: node.data,
                isConnectable: true,
                selected: false,
                xPos: 0,
                yPos: index * 40,
                zIndex: 0,
                dragging: false,
              })
            : null
        )
      ),
      nodes.map(node =>
        React.createElement(
          'button',
          {
            key: `delete-${node.id}`,
            onClick: () => onNodesDelete?.([node]),
          },
          `delete ${node.id}`
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

const cast = [
  {
    id: 'char-1',
    story_id: story.id,
    name: 'Rook',
    description: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
  {
    id: 'char-2',
    story_id: story.id,
    name: 'Wren',
    description: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
];

let stats: {
  id: string;
  character_id: string;
  stat_name: string;
  value: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}[] = [];

interface NodeRow {
  id: string;
  label: string;
  type: string;
  characterId: string | null;
}

let rows: NodeRow[] = [];

function nodeRow({ id, label, type, characterId }: NodeRow) {
  return {
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
    character_id: characterId,
  };
}

interface Call {
  command: string;
  args: Record<string, unknown>;
}

let calls: Call[] = [];

// The explicit chapter cast rows the mock keeps, so a drop on a chapter card can
// be read back the way the badge and the drawer read it.
let chapterCastRows: { id: string; chapter_id: string; character_id: string }[] = [];

function lastCall(command: string) {
  return [...calls].reverse().find(call => call.command === command)?.args;
}

// jsdom has no DataTransfer, so the drag payload is a plain object with the two
// methods the app uses.
function dragPayload(id?: string, type = 'application/x-litrpg-character') {
  const store: Record<string, string> = {};
  if (id) store[type] = id;

  return {
    types: Object.keys(store),
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? '',
  };
}

beforeEach(() => {
  rows = [{ id: 'n3', label: 'Ghost', type: 'character', characterId: 'char-gone' }];
  stats = [
    {
      id: 'stat-1',
      character_id: 'char-1',
      stat_name: 'Level',
      value: 4,
      notes: null,
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
    {
      id: 'stat-2',
      character_id: 'char-1',
      stat_name: 'HP',
      value: 20,
      notes: null,
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
    {
      id: 'stat-3',
      character_id: 'char-1',
      stat_name: 'Mana',
      value: 3,
      notes: null,
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];
  chapterCastRows = [];
  calls = [];

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push({ command, args });

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return rows.map(nodeRow);
      case 'get_graph_edges':
        return [];
      case 'get_characters':
        return cast;
      case 'get_story_character_stats':
        return stats;
      case 'get_story_chapter_cast':
        return chapterCastRows;
      case 'get_story_chapter_cast_states':
        return chapterCastRows.map(row => ({
          chapter_id: row.chapter_id,
          character_id: row.character_id,
          level: null,
          level_is_penalty: false,
          skills: [],
        }));
      case 'add_chapter_cast_member': {
        const existing = chapterCastRows.find(
          row =>
            row.chapter_id === args.chapterId && row.character_id === args.characterId
        );
        if (existing) return existing;

        const row = {
          id: `cast-${args.characterId}`,
          chapter_id: args.chapterId as string,
          character_id: args.characterId as string,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        chapterCastRows = [...chapterCastRows, row];
        return row;
      }
      case 'remove_chapter_cast_member':
        chapterCastRows = chapterCastRows.filter(row => row.id !== args.id);
        return null;
      case 'create_graph_node': {
        const created = nodeRow({
          id: 'n-dropped',
          label: args.label as string,
          type: args.nodeType as string,
          characterId: (args.characterId as string | null) ?? null,
        });
        // The database had to see a link for this node to come back with one.
        rows = [...rows, { id: created.id, label: created.label, type: created.node_type, characterId: created.character_id }];
        return { ...created, pos_x: args.posX, pos_y: args.posY };
      }
      case 'get_character_stats':
        return stats.filter(stat => stat.character_id === args.characterId);
      case 'set_node_character': {
        const row = rows.find(candidate => candidate.id === args.nodeId);
        if (!row) return null;

        const linked = {
          ...row,
          characterId: (args.characterId as string | null) ?? null,
        };
        rows = rows.map(candidate => (candidate.id === row.id ? linked : candidate));
        return nodeRow(linked);
      }
      case 'update_graph_node': {
        const row = rows.find(candidate => candidate.id === args.id);
        if (!row) return null;

        const renamed = { ...row, label: args.label as string };
        rows = rows.map(candidate => (candidate.id === row.id ? renamed : candidate));
        return nodeRow(renamed);
      }
      case 'get_character_attributes':
        return [];
      case 'set_character_stat': {
        const existing = stats.find(stat => stat.stat_name === args.statName);
        const updated = {
          id: existing?.id ?? 'stat-new',
          character_id: args.characterId as string,
          stat_name: args.statName as string,
          value: args.value as number,
          notes: (args.notes as string | null) ?? null,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        stats = [...stats.filter(stat => stat.id !== updated.id), updated];
        return updated;
      }
      default:
        return null;
    }
  });
});

async function canvasAndRail() {
  const { container } = render(<App />);
  await screen.findAllByText('Ledger');
  const rail = await screen.findByRole('complementary', { name: 'Cards' });
  return { container, rail, canvas: container.querySelector('.graph-canvas') as HTMLElement };
}

function drawer() {
  return screen.getByRole('complementary', { name: 'Node inspector' });
}

// jsdom has no DragEvent with pointer coordinates, so a drop is dispatched as a
// mouse event that carries the payload; the point is what the node is placed at.
function dropOn(canvas: HTMLElement, payload: object, clientX: number, clientY: number) {
  const event = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, 'dataTransfer', { value: payload });
  fireEvent(canvas, event);
}

// Several nodes can be character nodes, so the card is found by its label.
function cardFor(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('.graph-node')).find(
    card => card.querySelector('.graph-node-label')?.textContent === label
  ) as HTMLElement;
}

describe('dragging a cast member onto the canvas', () => {
  it('lists the cast as draggable cards, with their numbers', async () => {
    const { rail } = await canvasAndRail();

    expect(within(rail).getByText('Rook')).toBeInTheDocument();
    expect(within(rail).getByText('HP 20 · Level 4')).toBeInTheDocument();
    expect(rail.querySelectorAll('.cast-chip[draggable="true"]')).toHaveLength(2);
  });

  it('drops one as a linked node that carries its live badges', async () => {
    const { container, rail, canvas } = await canvasAndRail();
    const chip = within(rail).getByText('Rook').closest('.cast-chip') as HTMLElement;
    const payload = dragPayload();

    fireEvent.dragStart(chip, { dataTransfer: payload });
    expect(payload.getData('application/x-litrpg-character')).toBe('char-1');

    fireEvent.dragOver(canvas, { dataTransfer: payload });
    dropOn(canvas, payload, 240, 120);

    await waitFor(() =>
      expect(lastCall('create_graph_node')).toEqual({
        storyId: story.id,
        nodeType: 'character',
        label: 'Rook',
        content: null,
        posX: 240,
        posY: 120,
        createdBy: 'You',
        characterId: 'char-1',
      })
    );

    // The card shows the numbers it was given, and counts what it cannot fit.
    await waitFor(() => {
      const card = cardFor(container, 'Rook');
      expect(card).toHaveTextContent('Level 4');
      expect(card).toHaveTextContent('HP 20');
      expect(card).toHaveTextContent('+1');
    });

    // The drop opens the node, already pointed at the cast member.
    expect(within(drawer()).getByLabelText('Cast member')).toHaveValue('char-1');
  });

  it('updates the badge when the number is edited in the drawer', async () => {
    const { container, rail, canvas } = await canvasAndRail();
    const user = userEvent.setup();
    const chip = within(rail).getByText('Rook').closest('.cast-chip') as HTMLElement;
    const payload = dragPayload('char-1');

    fireEvent.dragStart(chip, { dataTransfer: payload });
    fireEvent.dragOver(canvas, { dataTransfer: payload });
    dropOn(canvas, payload, 240, 120);

    const cast = await waitFor(() =>
      within(drawer()).getByRole('region', { name: 'Cast numbers' })
    );
    await user.click(await within(cast).findByRole('button', { name: '4' }));
    const input = within(cast).getByLabelText('Level value');
    await user.clear(input);
    await user.type(input, '7{Enter}');

    await waitFor(() => {
      expect(cardFor(container, 'Rook')).toHaveTextContent('Level 7');
    });
  });

  it('says when a linked cast member is in the trash', async () => {
    const { container } = await canvasAndRail();

    expect(cardFor(container, 'Ghost')).toHaveTextContent('cast member in the trash');
  });

  it('links the node a card is dropped on instead of making another', async () => {
    const { container, rail } = await canvasAndRail();
    const chip = within(rail).getByText('Rook').closest('.cast-chip') as HTMLElement;
    const payload = dragPayload('char-1');
    const target = container.querySelector('.react-flow__node[data-id="n3"]') as HTMLElement;

    fireEvent.dragStart(chip, { dataTransfer: payload });
    fireEvent.dragOver(target, { dataTransfer: payload });
    expect(target).toHaveClass('drop-target');

    // Letting go of the drag, or moving off the node, clears the marker.
    fireEvent.dragEnd(chip, { dataTransfer: payload });
    expect(target).not.toHaveClass('drop-target');

    fireEvent.dragOver(target, { dataTransfer: payload });
    dropOn(target, payload, 10, 10);

    await waitFor(() =>
      expect(lastCall('set_node_character')).toEqual({
        nodeId: 'n3',
        characterId: 'char-1',
        user: 'You',
      })
    );
    expect(lastCall('create_graph_node')).toBeUndefined();

    // The node keeps its own label and gains the cast member's numbers.
    await waitFor(() => {
      expect(cardFor(container, 'Ghost')).toHaveTextContent('Level 4');
      expect(cardFor(container, 'Ghost')).toHaveTextContent('Rook');
    });
    expect(within(drawer()).getByLabelText('Cast member')).toHaveValue('char-1');
    expect(within(drawer()).getByLabelText('Label')).toHaveValue('Ghost');
  });

  it('offers to rename a node that was named after the member it left', async () => {
    rows = [
      ...rows,
      { id: 'n2', label: 'Rook', type: 'character', characterId: 'char-1' },
    ];

    const { container, rail } = await canvasAndRail();
    const user = userEvent.setup();
    const chip = within(rail).getByText('Wren').closest('.cast-chip') as HTMLElement;
    const payload = dragPayload('char-2');
    const target = container.querySelector('.react-flow__node[data-id="n2"]') as HTMLElement;

    fireEvent.dragStart(chip, { dataTransfer: payload });
    fireEvent.dragOver(target, { dataTransfer: payload });
    dropOn(target, payload, 10, 10);

    const panel = await screen.findByRole('complementary', { name: 'Node inspector' });
    const offer = await within(panel).findByRole('status');
    expect(offer).toHaveTextContent('named after Rook');

    await user.click(within(offer).getByRole('button', { name: 'Rename' }));

    await waitFor(() =>
      expect(lastCall('update_graph_node')).toEqual({
        id: 'n2',
        label: 'Wren',
        content: null,
        user: 'You',
      })
    );
    await waitFor(() => expect(cardFor(container, 'Wren')).toBeTruthy());
    expect(cardFor(container, 'Rook')).toBeUndefined();
  });

  it('leaves a node that already points at that member alone', async () => {
    rows = [
      ...rows,
      { id: 'n2', label: 'Rook', type: 'character', characterId: 'char-1' },
    ];

    const { container, rail } = await canvasAndRail();
    const chip = within(rail).getByText('Rook').closest('.cast-chip') as HTMLElement;
    const payload = dragPayload('char-1');
    const target = container.querySelector('.react-flow__node[data-id="n2"]') as HTMLElement;

    fireEvent.dragStart(chip, { dataTransfer: payload });
    fireEvent.dragOver(target, { dataTransfer: payload });
    dropOn(target, payload, 10, 10);

    await waitFor(() => expect(within(drawer()).getByLabelText('Label')).toHaveValue('Rook'));
    expect(lastCall('set_node_character')).toBeUndefined();
    expect(lastCall('create_graph_node')).toBeUndefined();
  });

  it('adds a card dropped on a chapter to its cast, as one undoable step', async () => {
    rows = [
      ...rows,
      { id: 'n-ch', label: 'Opening', type: 'chapter', characterId: null },
    ];

    const { container, rail } = await canvasAndRail();
    const user = userEvent.setup();
    const chip = within(rail).getByText('Rook').closest('.cast-chip') as HTMLElement;
    const payload = dragPayload('char-1');
    const target = container.querySelector('.react-flow__node[data-id="n-ch"]') as HTMLElement;

    fireEvent.dragStart(chip, { dataTransfer: payload });
    fireEvent.dragOver(target, { dataTransfer: payload });
    dropOn(target, payload, 10, 10);

    await waitFor(() =>
      expect(lastCall('add_chapter_cast_member')).toEqual({
        chapterId: 'n-ch',
        characterId: 'char-1',
        user: 'You',
      })
    );
    // The chapter is not bound to one person: the row is the whole change.
    expect(lastCall('set_node_character')).toBeUndefined();

    // The card names them once, as a badge, and the drawer lists the roster
    // instead of a picker.
    const panel = drawer();
    expect(within(panel).queryByLabelText('Cast member')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Rook' })).toBeInTheDocument()
    );
    await waitFor(() => expect(cardFor(container, 'Opening')).toHaveTextContent('Rook'));

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('remove_chapter_cast_member')).toEqual({
        id: 'cast-char-1',
        user: 'You',
      })
    );
  });

  it('ignores a drop that carries nothing it knows', async () => {
    const { canvas } = await canvasAndRail();

    fireEvent.drop(canvas, { dataTransfer: dragPayload() });
    fireEvent.drop(canvas, { dataTransfer: dragPayload('char-gone') });

    expect(lastCall('create_graph_node')).toBeUndefined();
  });
});

describe('dragging a card out of a section', () => {
  beforeEach(() => {
    rows = [
      ...rows,
      // A card the story already holds, with somebody bound to it.
      { id: 'n-item', label: 'Tooth key', type: 'item', characterId: 'char-1' },
    ];
  });

  it('copies the card where it is dropped instead of moving the one on the board', async () => {
    const { container, rail, canvas } = await canvasAndRail();

    const tile = rail.querySelector('.card-tile.item') as HTMLElement;
    expect(tile).toHaveTextContent('Tooth key');

    const entities = screen.getByRole('button', { name: 'Entities' });
    const payload = dragPayload('n-item', 'application/x-litrpg-card');

    fireEvent.dragStart(tile, { dataTransfer: payload });
    expect(payload.getData('application/x-litrpg-card')).toBe('n-item');

    // The tile offers a copy and the board asks for a copy. Asking for a move
    // instead is a drop the browser refuses, which is what “not allowed” means.
    fireEvent.dragOver(canvas, { dataTransfer: payload });
    expect(payload.dropEffect).toBe('copy');

    dropOn(canvas, payload, 240, 120);

    await waitFor(() =>
      expect(lastCall('create_graph_node')).toEqual({
        storyId: story.id,
        nodeType: 'item',
        label: 'Tooth key',
        content: null,
        posX: 240,
        posY: 120,
        createdBy: 'You',
      })
    );

    // Nobody is bound to the copy and no chapter is its own: those are the
    // author's next clicks, on that card alone.
    expect((lastCall('create_graph_node') as any).characterId).toBeUndefined();

    // The card already on the board was not moved.
    expect(lastCall('update_graph_node_position')).toBeUndefined();

    // Its layer comes back with it, and both cards are drawn.
    expect(entities).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(container.querySelectorAll('.graph-node.item')).toHaveLength(2)
    );
  });

  it('takes the copy away again with one undo', async () => {
    const user = userEvent.setup();
    const { canvas } = await canvasAndRail();

    dropOn(canvas, dragPayload('n-item', 'application/x-litrpg-card'), 40, 60);
    await waitFor(() => expect(lastCall('create_graph_node')).toBeDefined());

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('delete_node')).toEqual({ id: 'n-dropped', user: 'You' })
    );
  });

  it('keeps the list entry when the copy is deleted from the board', async () => {
    const user = userEvent.setup();
    const { rail, canvas } = await canvasAndRail();

    dropOn(canvas, dragPayload('n-item', 'application/x-litrpg-card'), 40, 60);
    await waitFor(() => expect(lastCall('create_graph_node')).toBeDefined());

    await user.click(screen.getByRole('button', { name: 'delete n-dropped' }));

    await waitFor(() =>
      expect(lastCall('delete_node')).toEqual({ id: 'n-dropped', user: 'You' })
    );

    // One card was a use of the trinket; the trinket is still in the story, so
    // the list still names it.
    expect(within(rail).getByText('Tooth key')).toBeInTheDocument();
  });

  it('opens a card from its tile, bringing its layer with it', async () => {
    const user = userEvent.setup();
    const { rail } = await canvasAndRail();
    const entities = screen.getByRole('button', { name: 'Entities' });

    await user.click(rail.querySelector('.card-tile.item') as HTMLElement);

    expect(entities).toHaveAttribute('aria-pressed', 'true');
    expect(within(drawer()).getByLabelText('Label')).toHaveValue('Tooth key');
  });
});
describe('deleting a skill card', () => {
  beforeEach(() => {
    rows = [
      ...rows,
      { id: 'n-skill', label: 'Brine-Lung', type: 'skill', characterId: null },
    ];
  });

  it('reads the sheets again, so the skill leaves them with the card', async () => {
    const user = userEvent.setup();
    await canvasAndRail();

    const readsBefore = calls.filter(call => call.command === 'get_story_skills').length;

    await user.click(screen.getByRole('button', { name: 'delete n-skill' }));

    await waitFor(() =>
      expect(lastCall('delete_node')).toEqual({ id: 'n-skill', user: 'You' })
    );
    await waitFor(() =>
      expect(calls.filter(call => call.command === 'get_story_skills').length).toBe(
        readsBefore + 1
      )
    );
  });
});
