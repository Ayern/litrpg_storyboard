import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock, flowMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  flowMock: { setCenter: vi.fn(), getZoom: vi.fn(() => 1) },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  const Canvas = (props: any) => {
    const { nodes = [], nodeTypes = {}, children, onInit } = props;
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
            : null
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

const rook = {
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

const mira = {
  ...rook,
  id: 'char-2',
  name: 'Mira',
};

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

let createdNodes = 0;

beforeEach(() => {
  createdNodes = 0;

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
          nodeRow('n3', 'faction', 'The Ashen Guild'),
        ];
      case 'get_characters':
        return [{ ...rook }, { ...mira }];
      case 'create_new_character':
        return {
          ...rook,
          id: 'char-3',
          name: args.name,
          description: args.description ?? null,
        };
      case 'create_graph_node': {
        createdNodes += 1;
        return {
          id: `node-${createdNodes}`,
          story_id: story.id,
          node_type: args.nodeType,
          label: args.label,
          content: args.content ?? null,
          pos_x: args.posX,
          pos_y: args.posY,
          created_by: args.createdBy,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
          character_id: args.characterId ?? null,
          chapter_seq: null,
        };
      }
      case 'add_quest':
        return {
          id: 'quest-1',
          story_id: story.id,
          title: args.title,
          giver_character_id: args.giverCharacterId ?? null,
          faction_node_id: args.factionNodeId ?? null,
          accepted_chapter_id: args.acceptedChapterId,
          completed_chapter_id: args.completedChapterId ?? null,
          status: args.status,
          description: args.description ?? null,
          notes: args.notes ?? null,
          created_by: 'Ada',
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
          rewards: [],
        };
      case 'add_skill':
        return {
          id: 'skill-1',
          character_id: args.characterId,
          name: args.name,
          rank: args.rank ?? null,
          effect: args.effect ?? null,
          chapter_id: args.chapterId ?? null,
          node_id: args.nodeId ?? null,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
      case 'delete_node':
      case 'delete_character':
      case 'delete_quest':
      case 'delete_skill':
      case 'restore_deleted':
        return null;
      case 'get_graph_edges':
      case 'get_character_stats':
      case 'get_story_character_stats':
      case 'get_character_attributes':
      case 'get_character_skills':
      case 'get_character_inventory':
      case 'get_character_currency':
      case 'get_character_level_milestones':
      case 'get_character_progress':
      case 'get_story_skills':
      case 'get_story_skill_events':
      case 'get_story_skill_evolutions':
      case 'get_story_level_milestones':
      case 'get_story_relations':
      case 'get_story_faction_standings':
      case 'get_chapter_notes':
      case 'get_story_chapter_cast':
      case 'get_story_chapter_cast_states':
      case 'get_story_character_progress':
      case 'get_story_inventory':
      case 'get_story_quests':
        return [];
      default:
        return null;
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

function canvasCard(id: string) {
  const card = document.querySelector(`.react-flow__node[data-id="${id}"]`);
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

async function openCanvas() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  // The story is read after the sidebar list; the toolbar appears with it.
  await screen.findByTitle('The kind of node the Add button creates');

  return user;
}

async function startCreate(
  user: ReturnType<typeof userEvent.setup>,
  type: string,
  label = ''
) {
  await user.selectOptions(
    screen.getByTitle('The kind of node the Add button creates'),
    type
  );

  if (label) {
    await user.type(screen.getByPlaceholderText('Node label'), label);
  }

  await user.click(screen.getByRole('button', { name: 'Add Node' }));
}

describe('creating canvas cards from their real forms', () => {
  it('creates a character and its linked card together', async () => {
    const user = await openCanvas();

    await startCreate(user, 'character', 'Mira Vale');

    const dialog = screen.getByRole('dialog', { name: 'New character' });
    expect(within(dialog).getByLabelText('Character name')).toHaveValue('Mira Vale');

    await user.type(
      within(dialog).getByLabelText('Character description'),
      'A cartographer who reads the ledger.'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create card' }));

    expect(lastCall('create_new_character')).toMatchObject({
      storyId: story.id,
      name: 'Mira Vale',
      description: 'A cartographer who reads the ledger.',
      user: 'You',
    });
    expect(lastCall('create_graph_node')).toMatchObject({
      storyId: story.id,
      nodeType: 'character',
      label: 'Mira Vale',
      content: 'A cartographer who reads the ledger.',
      characterId: 'char-3',
    });

    expect(screen.queryByRole('dialog', { name: 'New character' })).not.toBeInTheDocument();
    expect(canvasCard('node-1')).toHaveTextContent('Mira Vale');
  });

  it('creates a quest contract and its card with the same facts', async () => {
    const user = await openCanvas();

    await startCreate(user, 'quest', 'The Ashen Key');

    const dialog = screen.getByRole('dialog', { name: 'New quest' });
    expect(within(dialog).getByLabelText('Quest title')).toHaveValue('The Ashen Key');

    // The first chapter in reading order is the default acceptance point.
    expect(within(dialog).getByLabelText('Quest accepted chapter')).toHaveValue('n1');

    await user.selectOptions(within(dialog).getByLabelText('Quest giver'), 'char-1');
    await user.selectOptions(within(dialog).getByLabelText('Quest ending chapter'), 'n2');
    await user.type(within(dialog).getByLabelText('Quest notes'), 'The key is a lie.');
    await user.click(within(dialog).getByRole('button', { name: 'Create card' }));

    expect(lastCall('add_quest')).toMatchObject({
      storyId: story.id,
      title: 'The Ashen Key',
      giverCharacterId: 'char-1',
      acceptedChapterId: 'n1',
      completedChapterId: 'n2',
      status: 'completed',
      notes: 'The key is a lie.',
    });
    expect(lastCall('create_graph_node')).toMatchObject({
      nodeType: 'quest',
      label: 'The Ashen Key',
    });
    expect(canvasCard('node-1')).toHaveTextContent('The Ashen Key');
  });

  it('creates a skill on its owner and the card that grants it', async () => {
    const user = await openCanvas();

    await startCreate(user, 'skill', 'Fireball');

    const dialog = screen.getByRole('dialog', { name: 'New skill' });
    expect(within(dialog).getByLabelText('Skill name')).toHaveValue('Fireball');
    // Nobody is chosen for the author: an unheld card is a valid place to start.
    expect(within(dialog).getByLabelText('Skill owner')).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: 'Create card' })).toBeEnabled();

    await user.selectOptions(within(dialog).getByLabelText('Skill owner'), 'char-1');
    await user.selectOptions(within(dialog).getByLabelText('Skill chapter'), 'n2');
    await user.type(within(dialog).getByLabelText('Skill rank'), 'Rank 2');
    await user.type(within(dialog).getByLabelText('Skill effect'), '3d6 fire');
    await user.click(within(dialog).getByRole('button', { name: 'Create card' }));

    expect(lastCall('create_graph_node')).toMatchObject({
      nodeType: 'skill',
      label: 'Fireball',
      content: '3d6 fire',
    });
    expect(lastCall('add_skill')).toMatchObject({
      characterId: 'char-1',
      name: 'Fireball',
      rank: 'Rank 2',
      effect: '3d6 fire',
      chapterId: 'n2',
      nodeId: 'node-1',
      user: 'You',
    });
    expect(canvasCard('node-1')).toHaveTextContent('Fireball');
  });

  it('places a skill card nobody holds yet, and undoes only the card', async () => {
    const user = await openCanvas();

    await startCreate(user, 'skill', 'Frost Touch');

    const dialog = screen.getByRole('dialog', { name: 'New skill' });
    // An owner is a convenience, not a requirement: the card can be placed now.
    expect(within(dialog).getByLabelText('Skill owner')).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: 'Create card' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: 'Create card' }));

    expect(lastCall('create_graph_node')).toMatchObject({
      nodeType: 'skill',
      label: 'Frost Touch',
    });
    expect(lastCall('add_skill')).toBeUndefined();
    expect(screen.queryByRole('dialog', { name: 'New skill' })).not.toBeInTheDocument();
    expect(canvasCard('node-1')).toHaveTextContent('Frost Touch');
    expect(canvasCard('node-1')).toHaveTextContent('No one has this skill yet');

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(lastCall('delete_node')).toMatchObject({ id: 'node-1' });
    expect(lastCall('delete_skill')).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'restore_deleted').map(call => call[1])
    ).toEqual([expect.objectContaining({ id: 'node-1', kind: 'node' })]);
    expect(lastCall('add_skill')).toBeUndefined();
  });

  it('still creates narrative cards with the quick label path', async () => {
    const user = await openCanvas();

    await startCreate(user, 'idea', 'A sealed door');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(lastCall('create_graph_node')).toMatchObject({
      nodeType: 'idea',
      label: 'A sealed door',
    });
  });

  it('undoes and redoes the record and its card together', async () => {
    const user = await openCanvas();

    await startCreate(user, 'character', 'Mira Vale');
    const dialog = screen.getByRole('dialog', { name: 'New character' });
    await user.click(within(dialog).getByRole('button', { name: 'Create card' }));

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(lastCall('delete_node')).toMatchObject({ id: 'node-1' });
    expect(lastCall('delete_character')).toMatchObject({ id: 'char-3' });

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    const restores = invokeMock.mock.calls
      .filter(call => call[0] === 'restore_deleted')
      .map(call => call[1]);
    expect(restores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'char-3', kind: 'character' }),
        expect.objectContaining({ id: 'node-1', kind: 'node' }),
      ])
    );
  });

  it('cancels without creating a record', async () => {
    const user = await openCanvas();

    await startCreate(user, 'character', 'Nobody');

    const dialog = screen.getByRole('dialog', { name: 'New character' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(lastCall('create_new_character')).toBeUndefined();
    expect(lastCall('create_graph_node')).toBeUndefined();
  });
});
