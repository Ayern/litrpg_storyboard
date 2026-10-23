import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// React Flow needs real DOM measurements, so the canvas is replaced with a list
// of the nodes it was given. Clicking one calls the same handler React Flow would.
vi.mock('reactflow', async () => {
  const React = await import('react');

  interface CanvasProps {
    nodes?: { id: string; data: { nodeType: string; label: string } }[];
    onNodeClick?: (event: unknown, node: unknown) => void;
    children?: unknown;
  }

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  const Canvas = ({ nodes = [], onNodeClick, children }: CanvasProps) =>
    React.createElement(
      'div',
      null,
      nodes.map(node =>
        React.createElement(
          'button',
          { key: node.id, onClick: event => onNodeClick?.(event, node) },
          `${node.data.nodeType}: ${node.data.label}`
        )
      ),
      children as React.ReactNode
    );

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

interface NodeRow {
  id: string;
  label: string;
  type: string;
  characterId: string | null;
}

// Three nodes: an unlinked chapter, a character linked to the cast, and one
// linked to a cast member that is no longer in the live cast.
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

beforeEach(() => {
  rows = [
    { id: 'n1', label: 'Opening', type: 'chapter', characterId: null },
    { id: 'n2', label: 'Rook', type: 'character', characterId: 'char-1' },
    { id: 'n3', label: 'Ghost', type: 'character', characterId: 'char-gone' },
  ];
  calls = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push({ command, args });

    const find = (id: string) => rows.find(row => row.id === id) ?? rows[1];

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return rows.map(nodeRow);
      case 'get_graph_edges':
        return [];
      case 'get_characters':
        return [
          {
            id: 'char-1',
            story_id: story.id,
            name: 'Rook',
            description: null,
            created_at: '2026-10-22T12:00:00Z',
            updated_at: '2026-10-22T12:00:00Z',
          },
        ];
      case 'get_story_character_stats':
        return [];
      case 'get_character_stats':
        return [
          {
            id: 'stat-1',
            character_id: 'char-1',
            stat_name: 'Level',
            value: 4,
            notes: null,
            created_at: '2026-10-22T12:00:00Z',
            updated_at: '2026-10-22T12:00:00Z',
          },
        ];
      case 'get_character_attributes':
        return [
          {
            id: 'attr-1',
            character_id: 'char-1',
            attr_name: 'Class',
            value: 'Warden',
            created_at: '2026-10-22T12:00:00Z',
            updated_at: '2026-10-22T12:00:00Z',
          },
        ];
      case 'update_graph_node':
        return nodeRow({ ...find(args.id as string), label: args.label as string });
      case 'set_node_character': {
        const row = find(args.nodeId as string);
        return nodeRow({ ...row, characterId: (args.characterId as string | null) ?? null });
      }
      case 'set_character_stat':
        return {
          id: 'stat-1',
          character_id: args.characterId as string,
          stat_name: args.statName as string,
          value: args.value as number,
          notes: (args.notes as string | null) ?? null,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
      case 'set_character_attribute':
        return {
          id: 'attr-1',
          character_id: args.characterId as string,
          attr_name: args.attrName as string,
          value: args.value as string,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
      default:
        return null;
    }
  });
});

async function openNode(label: string) {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(await screen.findByRole('button', { name: label }));

  return user;
}

function drawer() {
  return screen.getByRole('complementary', { name: 'Node inspector' });
}

function lastCall(command: string) {
  return [...calls].reverse().find(call => call.command === command)?.args;
}

describe('the node inspector', () => {
  it('opens beside the canvas with the node that was clicked, and saves it there', async () => {
    const user = await openNode('character: Rook');

    const panel = drawer();
    expect(within(panel).getByText('Inspector')).toBeInTheDocument();
    // The type chip uses the same colour class as the card on the canvas.
    expect(within(panel).getByText('character')).toHaveClass('legend', 'character');

    const label = within(panel).getByLabelText('Label');
    expect(label).toHaveValue('Rook');

    await user.clear(label);
    await user.type(label, 'Rook the Bold');
    await user.type(within(panel).getByLabelText('Notes'), 'Carries the ledger.');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));

    expect(lastCall('update_graph_node')).toEqual({
      id: 'n2',
      label: 'Rook the Bold',
      content: 'Carries the ledger.',
      user: 'You',
    });
  });

  it('keeps the link to the cast member when the node is renamed', async () => {
    const user = await openNode('character: Rook');
    const panel = drawer();

    // The link is the id, so a rename no longer decides whose numbers these are.
    expect(within(panel).getByLabelText('Cast member')).toHaveValue('char-1');
    expect(within(panel).getByText('Level')).toBeInTheDocument();

    const label = within(panel).getByLabelText('Label');
    await user.clear(label);
    await user.type(label, 'Rook the Bold');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));

    expect(within(drawer()).getByLabelText('Cast member')).toHaveValue('char-1');
    expect(within(drawer()).getByText('Level')).toBeInTheDocument();
  });

  it('links a cast member from the picker and shows its numbers', async () => {
    const user = await openNode('chapter: Opening');
    const panel = drawer();

    expect(within(panel).getByLabelText('Cast member')).toHaveValue('');
    expect(within(panel).queryByRole('region', { name: 'Cast numbers' })).not.toBeInTheDocument();

    await user.selectOptions(within(panel).getByLabelText('Cast member'), 'char-1');

    expect(lastCall('set_node_character')).toEqual({
      nodeId: 'n1',
      characterId: 'char-1',
      user: 'You',
    });

    const cast = within(drawer()).getByRole('region', { name: 'Cast numbers' });
    expect(within(cast).getByText('Level')).toBeInTheDocument();
    expect(within(cast).getByText('Class')).toBeInTheDocument();
  });

  it('clears the link again from the same picker', async () => {
    const user = await openNode('character: Rook');
    const panel = drawer();

    await user.selectOptions(within(panel).getByLabelText('Cast member'), '');

    expect(lastCall('set_node_character')).toEqual({
      nodeId: 'n2',
      characterId: null,
      user: 'You',
    });
    expect(within(drawer()).queryByRole('region', { name: 'Cast numbers' })).not.toBeInTheDocument();
  });

  it('edits a stat without leaving the canvas', async () => {
    const user = await openNode('character: Rook');

    const cast = within(drawer()).getByRole('region', { name: 'Cast numbers' });
    await user.click(within(cast).getByRole('button', { name: '4' }));
    const input = within(cast).getByLabelText('Level value');
    await user.clear(input);
    await user.type(input, '7{Enter}');

    expect(lastCall('set_character_stat')).toEqual({
      characterId: 'char-1',
      statName: 'Level',
      value: 7,
      notes: null,
      user: 'You',
    });
    expect(within(cast).getByRole('button', { name: '7' })).toBeInTheDocument();
  });

  it('edits a text attribute in place as well', async () => {
    const user = await openNode('character: Rook');

    const cast = within(drawer()).getByRole('region', { name: 'Cast numbers' });
    await user.click(within(cast).getByRole('button', { name: 'Warden' }));
    const input = within(cast).getByLabelText('Class value');
    await user.clear(input);
    await user.type(input, 'Ranger{Enter}');

    expect(lastCall('set_character_attribute')).toEqual({
      characterId: 'char-1',
      attrName: 'Class',
      value: 'Ranger',
      user: 'You',
    });
    expect(within(cast).getByRole('button', { name: 'Ranger' })).toBeInTheDocument();
  });

  it('says when the linked cast member is no longer in the live cast', async () => {
    await openNode('character: Ghost');

    const panel = drawer();
    // The picker keeps showing the link it cannot name, rather than silently
    // appearing unlinked and losing it on the next change.
    expect(within(panel).getByLabelText('Cast member')).toHaveValue('char-gone');
    expect(
      within(panel).getByRole('option', { name: 'Linked cast member (not in the cast)' })
    ).toBeInTheDocument();
    expect(within(panel).getByText(/probably in the trash/i)).toBeInTheDocument();
  });

  it('closes and leaves the canvas as it was', async () => {
    const user = await openNode('character: Rook');

    await user.click(within(drawer()).getByRole('button', { name: 'Close inspector' }));

    expect(screen.queryByRole('complementary', { name: 'Node inspector' })).not.toBeInTheDocument();
    expect(lastCall('update_graph_node')).toBeUndefined();
  });
});
