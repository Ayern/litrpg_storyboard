import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock, flowMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  flowMock: {
    setCenter: vi.fn(),
    getZoom: vi.fn(() => 1),
    screenToFlowPosition: vi.fn(() => ({ x: 320, y: 180 })),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// The canvas exposes the gestures React Flow would perform as buttons: drawing
// a connection, ending one on empty canvas, and deleting an edge.
vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  const Canvas = (props: any) => {
    const {
      nodes = [],
      edges = [],
      nodeTypes = {},
      children,
      onInit,
      onConnect,
      onConnectStart,
      onConnectEnd,
      onEdgeClick,
      onEdgesDelete,
    } = props;

    const Card = nodeTypes.default;

    React.useEffect(() => {
      onInit?.(flowMock);
    }, [onInit]);

    const spawn = (nodeId: string) => {
      onConnectStart?.({}, { nodeId });
      onConnectEnd?.(new MouseEvent('mouseup', { clientX: 90, clientY: 110 }));
    };

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
      React.createElement(
        'button',
        { onClick: () => onConnect?.({ source: 'n1', target: 'n2' }) },
        'connect characters'
      ),
      React.createElement(
        'button',
        { onClick: () => onConnect?.({ source: 'n1', target: 'n3' }) },
        'connect character to chapter'
      ),
      React.createElement(
        'button',
        { onClick: () => spawn('n1') },
        'spawn from character'
      ),
      React.createElement(
        'button',
        { onClick: () => spawn('n3') },
        'spawn from chapter'
      ),
      React.createElement(
        'button',
        { onClick: () => onConnect?.({ source: 'n4', target: 'n1' }) },
        'connect skill to character'
      ),
      React.createElement(
        'button',
        { onClick: () => onConnect?.({ source: 'n1', target: 'n4' }) },
        'connect character to skill'
      ),
      edges.map((edge: any) =>
        React.createElement(
          React.Fragment,
          { key: edge.id },
          React.createElement(
            'button',
            { onClick: () => onEdgesDelete?.([edge]) },
            `remove ${edge.id}`
          ),
          React.createElement(
            'button',
            { onClick: () => onEdgeClick?.({}, edge) },
            `edit ${edge.id}`
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

interface NodeRow {
  id: string;
  node_type: string;
  label: string;
  character_id: string | null;
  chapter_seq: number | null;
  content?: string | null;
}

function nodeRow(
  id: string,
  nodeType: string,
  label: string,
  characterId: string | null,
  chapterSeq: number | null = null,
  content: string | null = null
): NodeRow {
  return {
    id,
    node_type: nodeType,
    label,
    character_id: characterId,
    chapter_seq: chapterSeq,
    content,
  };
}

interface SkillRow {
  id: string;
  character_id: string;
  name: string;
  rank: string | null;
  effect: string | null;
  chapter_id: string | null;
  node_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SkillEventRow {
  id: string;
  skill_id: string;
  kind: string;
  chapter_id: string | null;
  rank: string | null;
  level_record_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SkillEvolutionRow {
  id: string;
  story_id: string;
  parent_skill_id: string;
  child_skill_id: string;
  evolution_type: string;
  chapter_id: string | null;
  required_rank: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  story_id: string;
  source_id: string;
  target_id: string;
  label: string | null;
  relation_type: string | null;
  created_by: string;
  created_at: string;
}

interface CastRow {
  id: string;
  chapter_id: string;
  character_id: string;
  created_at: string;
  updated_at: string;
}

interface RelationRow {
  id: string;
  story_id: string;
  from_character_id: string;
  to_character_id: string;
  kind: string;
  note: string | null;
  since_chapter_id: string | null;
  until_chapter_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

let nodes: NodeRow[] = [];
let edges: EdgeRow[] = [];
let deletedEdges: EdgeRow[] = [];
let chapterCast: CastRow[] = [];
let relations: RelationRow[] = [];
let edgeSeq = 0;
let relationSeq = 0;
let castSeq = 0;
let skillSeq = 0;
let skills: SkillRow[] = [];
// Failures a test can ask for, so the two halves of a step can be made to disagree.
let failNextEdgeDelete = false;
let failNextEdgeRestore = false;
let skillEventSeq = 0;
let skillEvents: SkillEventRow[] = [];
let skillEvolutionSeq = 0;
let skillEvolutions: SkillEvolutionRow[] = [];

function timestamp() {
  return '2026-10-22T12:00:00Z';
}

beforeEach(() => {
  nodes = [
    nodeRow('n1', 'character', 'Rook', 'char-1'),
    nodeRow('n2', 'character', 'Wren', 'char-2'),
    nodeRow('n3', 'chapter', 'Opening', null, 1),
    nodeRow('n4', 'skill', 'Frost Touch', null, null, 'Leaves frost on the skin.'),
  ];
  edges = [];
  deletedEdges = [];
  chapterCast = [];
  relations = [];
  skills = [];
  skillEvents = [];
  skillEvolutions = [];
  edgeSeq = 0;
  relationSeq = 0;
  castSeq = 0;
  skillSeq = 0;
  skillEventSeq = 0;
  skillEvolutionSeq = 0;
  failNextEdgeDelete = false;
  failNextEdgeRestore = false;

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return nodes.map(row => ({
          ...row,
          story_id: story.id,
          content: row.content ?? null,
          pos_x: 0,
          pos_y: 0,
          created_by: 'Ada',
          created_at: timestamp(),
          updated_at: timestamp(),
        }));
      case 'get_graph_edges':
        return edges.map(row => ({ ...row, updated_at: timestamp() }));
      case 'get_characters':
        return cast;
      case 'get_story_chapter_cast':
        return chapterCast;
      case 'get_story_relations':
        return relations;
      case 'create_graph_edge': {
        edgeSeq += 1;
        const edge: EdgeRow = {
          id: `e${edgeSeq}`,
          story_id: story.id,
          source_id: args.sourceId,
          target_id: args.targetId,
          label: args.label ?? null,
          relation_type: args.relationType ?? null,
          created_by: args.createdBy,
          created_at: timestamp(),
        };
        edges.push(edge);
        return { ...edge, updated_at: timestamp() };
      }
      case 'delete_edge': {
        if (failNextEdgeDelete) {
          failNextEdgeDelete = false;
          throw new Error('the edge could not be deleted');
        }

        const edge = edges.find(row => row.id === args.id);
        if (edge) {
          edges = edges.filter(row => row.id !== edge.id);
          deletedEdges.push(edge);
        }
        return null;
      }
      case 'restore_deleted': {
        if (args.kind !== 'edge') return null;
        if (failNextEdgeRestore) {
          failNextEdgeRestore = false;
          throw new Error('the edge could not be restored');
        }
        const edge = deletedEdges.find(row => row.id === args.id);
        if (edge) {
          deletedEdges = deletedEdges.filter(row => row.id !== edge.id);
          edges.push(edge);
        }
        return null;
      }
      case 'add_relation': {
        relationSeq += 1;
        const relation: RelationRow = {
          id: `relation-${relationSeq}`,
          story_id: story.id,
          from_character_id: args.fromCharacterId,
          to_character_id: args.toCharacterId,
          kind: args.kind,
          note: args.note ?? null,
          since_chapter_id: args.sinceChapterId ?? null,
          until_chapter_id: args.untilChapterId ?? null,
          created_by: args.user,
          created_at: timestamp(),
          updated_at: timestamp(),
        };
        relations.push(relation);
        return relation;
      }
      case 'update_relation': {
        const existing = relations.find(row => row.id === args.id);
        if (!existing) return null;
        const updated: RelationRow = {
          ...existing,
          kind: args.kind,
          note: args.note ?? null,
          since_chapter_id: args.sinceChapterId ?? null,
          until_chapter_id: args.untilChapterId ?? null,
        };
        relations = relations.map(row => (row.id === updated.id ? updated : row));
        return { ...updated };
      }
      case 'update_graph_edge': {
        const existing = edges.find(row => row.id === args.id);
        if (!existing) return null;
        const updated: EdgeRow = {
          ...existing,
          label: args.label ?? null,
          relation_type: args.relationType ?? null,
        };
        edges = edges.map(row => (row.id === updated.id ? updated : row));
        return { ...updated, updated_at: timestamp() };
      }
      case 'delete_relation':
        relations = relations.filter(row => row.id !== args.id);
        return null;
      case 'add_chapter_cast_member': {
        const existing = chapterCast.find(
          row => row.chapter_id === args.chapterId && row.character_id === args.characterId
        );
        if (existing) return existing;

        castSeq += 1;
        const member: CastRow = {
          id: `cast-${castSeq}`,
          chapter_id: args.chapterId,
          character_id: args.characterId,
          created_at: timestamp(),
          updated_at: timestamp(),
        };
        chapterCast.push(member);
        return member;
      }
      case 'remove_chapter_cast_member':
        chapterCast = chapterCast.filter(row => row.id !== args.id);
        return null;
      case 'get_story_skills':
        return skills.map(row => ({ ...row }));
      case 'get_character_skills':
        return skills
          .filter(row => row.character_id === args.characterId)
          .map(row => ({ ...row }));
      case 'add_skill': {
        // Seeded rows can already hold the next number, so skip past them.
        skillSeq += 1;
        while (skills.some(row => row.id === `skill-${skillSeq}`)) skillSeq += 1;
        const row: SkillRow = {
          id: `skill-${skillSeq}`,
          character_id: args.characterId,
          name: args.name,
          rank: args.rank ?? null,
          effect: args.effect ?? null,
          chapter_id: args.chapterId ?? null,
          node_id: args.nodeId ?? null,
          created_at: timestamp(),
          updated_at: timestamp(),
        };
        skills.push(row);
        return { ...row };
      }
      case 'delete_skill':
        // The database cascades the events and the tree links with the row.
        skills = skills.filter(row => row.id !== args.id);
        skillEvents = skillEvents.filter(row => row.skill_id !== args.id);
        skillEvolutions = skillEvolutions.filter(
          row => row.parent_skill_id !== args.id && row.child_skill_id !== args.id
        );
        return null;
      case 'get_story_skill_events':
        return skillEvents.map(row => ({ ...row }));
      case 'get_story_skill_evolutions':
        return skillEvolutions.map(row => ({ ...row }));
      case 'add_skill_event': {
        skillEventSeq += 1;
        const row: SkillEventRow = {
          id: `event-${skillEventSeq}`,
          skill_id: args.skillId,
          kind: args.kind,
          chapter_id: args.chapterId ?? null,
          rank: args.rank ?? null,
          level_record_id: args.levelRecordId ?? null,
          created_at: timestamp(),
          updated_at: timestamp(),
        };
        skillEvents.push(row);
        return { ...row };
      }
      case 'add_skill_evolution': {
        skillEvolutionSeq += 1;
        const row: SkillEvolutionRow = {
          id: `evolution-${skillEvolutionSeq}`,
          story_id: story.id,
          parent_skill_id: args.parentSkillId,
          child_skill_id: args.childSkillId,
          evolution_type: args.evolutionType,
          chapter_id: args.chapterId ?? null,
          required_rank: args.requiredRank ?? null,
          notes: args.notes ?? null,
          created_by: args.user,
          created_at: timestamp(),
          updated_at: timestamp(),
        };
        skillEvolutions.push(row);
        return { ...row };
      }
      default:
        return [];
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

async function openCanvas() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await screen.findByTitle('The kind of node the Add button creates');

  return user;
}

// The skills the open sheet is listing, read from the rows themselves so a name
// that also appears on a card or in the tree cannot stand in for it.
function sheetSkillNames(): string[] {
  return Array.from(document.querySelectorAll('.skill-row .skill-name')).map(
    node => node.textContent ?? ''
  );
}

describe('connection actions', () => {
  it('turns a character connection into a relation and undoes both together', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect characters' }));

    const dialog = await screen.findByRole('dialog', { name: 'Connect characters' });
    const kind = within(dialog).getByLabelText('Relation kind');
    expect(kind).toHaveValue('ally');

    await user.clear(kind);
    await user.type(kind, 'enemy');
    await user.selectOptions(within(dialog).getByLabelText('Since chapter (optional)'), 'n3');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'The truce ended.');
    await user.click(within(dialog).getByRole('button', { name: 'Connect characters' }));

    await waitFor(() =>
      expect(lastCall('add_relation')).toEqual({
        fromCharacterId: 'char-1',
        toCharacterId: 'char-2',
        kind: 'enemy',
        note: 'The truce ended.',
        sinceChapterId: 'n3',
        untilChapterId: null,
        user: 'You',
      })
    );
    expect(lastCall('create_graph_edge')).toMatchObject({
      storyId: story.id,
      sourceId: 'n1',
      targetId: 'n2',
      label: 'enemy',
      relationType: 'enemy',
      createdBy: 'You',
    });

    expect(screen.queryByRole('dialog', { name: 'Connect characters' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'remove e1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('delete_relation')).toEqual({ id: 'relation-1', user: 'You' })
    );
    expect(lastCall('delete_edge')).toEqual({ id: 'e1', user: 'You' });

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    await waitFor(() =>
      expect(lastCall('add_relation')).toMatchObject({
        fromCharacterId: 'char-1',
        toCharacterId: 'char-2',
        kind: 'enemy',
      })
    );
    expect(lastCall('restore_deleted')).toEqual({ id: 'e1', kind: 'edge', user: 'You' });
  });

  it('cancels a relation without writing either half', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect characters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect characters' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog', { name: 'Connect characters' })).not.toBeInTheDocument();
    expect(lastCall('create_graph_edge')).toBeUndefined();
    expect(lastCall('add_relation')).toBeUndefined();
  });

  it('adds the character to the chapter cast and asks before removing it', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect character to chapter' }));

    await waitFor(() =>
      expect(lastCall('add_chapter_cast_member')).toEqual({
        chapterId: 'n3',
        characterId: 'char-1',
        user: 'You',
      })
    );
    expect(lastCall('create_graph_edge')).toMatchObject({
      sourceId: 'n1',
      targetId: 'n3',
      label: 'cast',
      relationType: 'cast',
    });
    expect(screen.getByRole('button', { name: 'remove e1' })).toBeInTheDocument();

    // Keep leaves both the connection and the cast row alone.
    await user.click(screen.getByRole('button', { name: 'remove e1' }));
    const keep = await screen.findByRole('dialog', { name: 'Remove connection' });
    expect(keep).toHaveTextContent("Rook will leave Opening's cast");
    await user.click(within(keep).getByRole('button', { name: 'Keep' }));

    expect(lastCall('remove_chapter_cast_member')).toBeUndefined();
    expect(screen.getByRole('button', { name: 'remove e1' })).toBeInTheDocument();

    // Removing deletes the cast row and the edge, and undo brings both back.
    await user.click(screen.getByRole('button', { name: 'remove e1' }));
    const remove = await screen.findByRole('dialog', { name: 'Remove connection' });
    await user.click(within(remove).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(lastCall('remove_chapter_cast_member')).toEqual({ id: 'cast-1', user: 'You' })
    );
    expect(lastCall('delete_edge')).toEqual({ id: 'e1', user: 'You' });
    expect(screen.queryByRole('button', { name: 'remove e1' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('add_chapter_cast_member')).toEqual({
        chapterId: 'n3',
        characterId: 'char-1',
        user: 'You',
      })
    );
    expect(lastCall('restore_deleted')).toEqual({ id: 'e1', kind: 'edge', user: 'You' });

    // The line is drawn again without reopening the story, not only in the file.
    expect(await screen.findByRole('button', { name: 'remove e1' })).toBeInTheDocument();
  });

  it('keeps the cast row and its line together when a removal cannot finish', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect character to chapter' }));
    await waitFor(() => expect(chapterCast).toHaveLength(1));

    failNextEdgeDelete = true;
    await user.click(screen.getByRole('button', { name: 'remove e1' }));
    const remove = await screen.findByRole('dialog', { name: 'Remove connection' });
    await user.click(within(remove).getByRole('button', { name: 'Remove' }));

    // The line could not be deleted, so the row it stood for is written back:
    // neither half happened.
    expect(await screen.findByText(/Could not remove the connection/)).toBeInTheDocument();
    await waitFor(() => expect(chapterCast).toHaveLength(1));

    // The notice fades; the history says the step was put back and why.
    expect(lastCall('record_history_event')).toMatchObject({
      storyId: story.id,
      action: 'step_rolled_back',
      user: 'You',
    });
    expect((lastCall('record_history_event') as any).detail).toContain('Nothing changed');
    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'add_chapter_cast_member')
    ).toHaveLength(2);
    expect(await screen.findByRole('button', { name: 'remove e1' })).toBeInTheDocument();
  });

  it('puts the cast member back when its undo cannot restore the line', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect character to chapter' }));
    await waitFor(() => expect(chapterCast).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'remove e1' }));
    const remove = await screen.findByRole('dialog', { name: 'Remove connection' });
    await user.click(within(remove).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(chapterCast).toHaveLength(0));

    failNextEdgeRestore = true;
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    // The line could not come back, so the row the undo wrote is taken away again
    // and the step waits in the history as a whole.
    expect(await screen.findByText(/Could not undo/)).toBeInTheDocument();
    await waitFor(() => expect(chapterCast).toHaveLength(0));

    // One entry, naming the half that was put back — not a second one saying the
    // undo was refused.
    const recorded = invokeMock.mock.calls.filter(call => call[0] === 'record_history_event');
    expect(recorded).toHaveLength(1);
    expect(recorded[0][1]).toMatchObject({ action: 'step_rolled_back', user: 'You' });
    expect((recorded[0][1] as any).detail).toContain('could not be restored');

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(chapterCast).toHaveLength(1));
    expect(await screen.findByRole('button', { name: 'remove e1' })).toBeInTheDocument();
  });

  it('turns a skill-to-character connection into a holder on the sheet, and undoes both together', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect skill to character' }));

    await waitFor(() =>
      expect(lastCall('add_skill')).toEqual({
        characterId: 'char-1',
        name: 'Frost Touch',
        rank: null,
        effect: 'Leaves frost on the skin.',
        chapterId: null,
        nodeId: 'n4',
        user: 'You',
      })
    );
    expect(lastCall('create_graph_edge')).toMatchObject({
      sourceId: 'n4',
      targetId: 'n1',
      label: 'skill',
      relationType: 'skill',
    });
    expect(skills).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'remove e1' })).toBeInTheDocument();

    // The write reaches the sheet that is open on the other tab, not just the
    // database, so the holder is there before the story is reopened.
    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(await screen.findByTitle("Show Rook's sheet"));
    expect(sheetSkillNames()).toContain('Frost Touch');

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('delete_skill')).toEqual({ id: 'skill-1', user: 'You' })
    );
    expect(lastCall('delete_edge')).toEqual({ id: 'e1', user: 'You' });
    expect(skills).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    await waitFor(() =>
      expect(lastCall('add_skill')).toMatchObject({
        characterId: 'char-1',
        nodeId: 'n4',
      })
    );
    expect(lastCall('restore_deleted')).toEqual({ id: 'e1', kind: 'edge', user: 'You' });
    expect(skills).toHaveLength(1);
  });

  it('asks before a skill connection takes the skill off the sheet, and undoes both together', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect skill to character' }));
    await waitFor(() => expect(lastCall('add_skill')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'remove e1' }));
    const keep = await screen.findByRole('dialog', { name: 'Remove connection' });
    expect(keep).toHaveTextContent('Rook will lose Frost Touch');
    await user.click(within(keep).getByRole('button', { name: 'Keep' }));

    expect(lastCall('delete_skill')).toBeUndefined();
    expect(skills).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'remove e1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'remove e1' }));
    const remove = await screen.findByRole('dialog', { name: 'Remove connection' });
    await user.click(within(remove).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(lastCall('delete_skill')).toEqual({ id: 'skill-1', user: 'You' })
    );
    expect(lastCall('delete_edge')).toEqual({ id: 'e1', user: 'You' });
    expect(skills).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'remove e1' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('add_skill')).toEqual({
        characterId: 'char-1',
        name: 'Frost Touch',
        rank: null,
        effect: 'Leaves frost on the skin.',
        chapterId: null,
        nodeId: 'n4',
        user: 'You',
      })
    );
    expect(lastCall('restore_deleted')).toEqual({ id: 'e1', kind: 'edge', user: 'You' });
    expect(skills).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'remove e1' })).toBeInTheDocument();
  });

  it('adopts a line drawn before a skill hold was written', async () => {
    // A board from before this rule: the line is there, the sheet has no row.
    edges = [
      {
        id: 'e9',
        story_id: story.id,
        source_id: 'n4',
        target_id: 'n1',
        label: null,
        relation_type: null,
        created_by: 'Ada',
        created_at: timestamp(),
      },
    ];

    const user = await openCanvas();

    const edgeWrites = invokeMock.mock.calls.filter(
      call => call[0] === 'create_graph_edge'
    ).length;

    await user.click(screen.getByRole('button', { name: 'connect skill to character' }));

    await waitFor(() => expect(skills).toHaveLength(1));
    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'create_graph_edge').length
    ).toBe(edgeWrites);
    expect(screen.getAllByRole('button', { name: 'remove e9' })).toHaveLength(1);

    // The adopted line is the hold's drawing from then on, so deleting it asks.
    await user.click(screen.getByRole('button', { name: 'remove e9' }));
    const remove = await screen.findByRole('dialog', { name: 'Remove connection' });
    expect(remove).toHaveTextContent('Rook will lose Frost Touch');
  });

  it('removes the line when the skill is deleted from the sheet, as one undo step', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect skill to character' }));
    await waitFor(() => expect(skills).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'remove e1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(await screen.findByTitle("Show Rook's sheet"));
    await user.click(screen.getByTitle('Delete Frost Touch'));

    await waitFor(() =>
      expect(lastCall('delete_skill')).toEqual({ id: 'skill-1', user: 'You' })
    );
    expect(lastCall('delete_edge')).toEqual({ id: 'e1', user: 'You' });
    expect(skills).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    expect(screen.queryByRole('button', { name: 'remove e1' })).not.toBeInTheDocument();

    // One step puts the skill and the line back together.
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('add_skill')).toMatchObject({
        characterId: 'char-1',
        name: 'Frost Touch',
        nodeId: 'n4',
      })
    );
    expect(lastCall('restore_deleted')).toEqual({ id: 'e1', kind: 'edge', user: 'You' });
    expect(skills).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'remove e1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    await waitFor(() => expect(skills).toHaveLength(0));
    expect(lastCall('delete_edge')).toEqual({ id: 'e1', user: 'You' });
    expect(screen.queryByRole('button', { name: 'remove e1' })).not.toBeInTheDocument();
  });

  it('brings a deleted skill\'s events and tree links back with it', async () => {
    // Rook holds Frost Touch through its card, with a change history and a link
    // into Wren's skill. Both cascade away with the row.
    skills = [
      {
        id: 'skill-1',
        character_id: 'char-1',
        name: 'Frost Touch',
        rank: 'Rank 1',
        effect: 'Leaves frost on the skin.',
        chapter_id: null,
        node_id: 'n4',
        created_at: timestamp(),
        updated_at: timestamp(),
      },
      {
        id: 'skill-2',
        character_id: 'char-2',
        name: 'Ember',
        rank: null,
        effect: null,
        chapter_id: null,
        node_id: null,
        created_at: timestamp(),
        updated_at: timestamp(),
      },
    ];
    skillEvents = [
      {
        id: 'event-1',
        skill_id: 'skill-1',
        kind: 'upgraded',
        chapter_id: null,
        rank: 'Rank 2',
        level_record_id: null,
        created_at: timestamp(),
        updated_at: timestamp(),
      },
    ];
    skillEvolutions = [
      {
        id: 'evolution-1',
        story_id: story.id,
        parent_skill_id: 'skill-1',
        child_skill_id: 'skill-2',
        evolution_type: 'upgrade',
        chapter_id: null,
        required_rank: null,
        notes: null,
        created_by: 'Ada',
        created_at: timestamp(),
        updated_at: timestamp(),
      },
    ];

    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(await screen.findByTitle("Show Rook's sheet"));
    await user.click(screen.getByTitle('Delete Frost Touch'));

    await waitFor(() =>
      expect(lastCall('delete_skill')).toEqual({ id: 'skill-1', user: 'You' })
    );
    expect(skillEvents).toHaveLength(0);
    expect(skillEvolutions).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('add_skill')).toMatchObject({
        characterId: 'char-1',
        name: 'Frost Touch',
        rank: 'Rank 1',
      })
    );

    // The row is written again, and the history is written against that row.
    const restored = skills.find(row => row.name === 'Frost Touch');
    expect(restored).toBeDefined();
    expect(skillEvents).toEqual([
      expect.objectContaining({
        skill_id: restored?.id,
        kind: 'upgraded',
        rank: 'Rank 2',
      }),
    ]);
    expect(skillEvolutions).toEqual([
      expect.objectContaining({
        parent_skill_id: restored?.id,
        child_skill_id: 'skill-2',
        evolution_type: 'upgrade',
      }),
    ]);

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    await waitFor(() => expect(skills.some(row => row.name === 'Frost Touch')).toBe(false));
    expect(skillEvents).toHaveLength(0);
    expect(skillEvolutions).toHaveLength(0);
  });

  it('leaves a sheet alone when the character already holds the skill', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect skill to character' }));
    await waitFor(() => expect(lastCall('add_skill')).toBeTruthy());

    const edgeWrites = invokeMock.mock.calls.filter(
      call => call[0] === 'create_graph_edge'
    ).length;

    // The same pair drawn the other way round is the same hold, not a second one.
    await user.click(screen.getByRole('button', { name: 'connect character to skill' }));

    expect(await screen.findByText('Rook already has Frost Touch.')).toBeInTheDocument();
    expect(skills).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(call => call[0] === 'create_graph_edge').length
    ).toBe(edgeWrites);
  });

  it('asks before deleting a relation by deleting the edge that drew it', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect characters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect characters' });
    await user.click(within(dialog).getByRole('button', { name: 'Connect characters' }));
    await waitFor(() => expect(lastCall('add_relation')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'remove e1' }));

    const remove = await screen.findByRole('dialog', { name: 'Remove connection' });
    expect(remove).toHaveTextContent('The ally relation between Rook and Wren will be deleted');
    await user.click(within(remove).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(lastCall('delete_relation')).toEqual({ id: 'relation-1', user: 'You' })
    );
    expect(lastCall('delete_edge')).toEqual({ id: 'e1', user: 'You' });
  });

  it('removes the matching connection when a relation is deleted on the sheet, as one undo step', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect characters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect characters' });
    await user.click(within(dialog).getByRole('button', { name: 'Connect characters' }));
    await waitFor(() => expect(lastCall('add_relation')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'remove e1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(await screen.findByTitle("Show Rook's sheet"));
    await user.click(screen.getByTitle('Delete this ally relation'));

    await waitFor(() =>
      expect(lastCall('delete_relation')).toEqual({ id: 'relation-1', user: 'You' })
    );
    expect(lastCall('delete_edge')).toEqual({ id: 'e1', user: 'You' });
    expect(screen.queryByTitle('Delete this ally relation')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    expect(screen.queryByRole('button', { name: 'remove e1' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('add_relation')).toMatchObject({
        fromCharacterId: 'char-1',
        toCharacterId: 'char-2',
        kind: 'ally',
      })
    );
    expect(lastCall('restore_deleted')).toEqual({ id: 'e1', kind: 'edge', user: 'You' });
    expect(await screen.findByRole('button', { name: 'remove e1' })).toBeInTheDocument();
  });

  it('moves a relation verb onto the connection that drew it, with one undo step', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect characters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect characters' });
    await user.click(within(dialog).getByRole('button', { name: 'Connect characters' }));
    await waitFor(() => expect(lastCall('add_relation')).toBeTruthy());
    expect(edges[0]).toMatchObject({ id: 'e1', label: 'ally', relation_type: 'ally' });

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(screen.getByTitle("Show Rook's sheet"));
    await user.click(screen.getByTitle('Change this ally relation'));
    await user.clear(screen.getByLabelText('Relation kind'));
    await user.type(screen.getByLabelText('Relation kind'), 'mentor');
    await user.click(screen.getByRole('button', { name: 'Save relation' }));

    await waitFor(() =>
      expect(lastCall('update_relation')).toMatchObject({
        id: 'relation-1',
        kind: 'mentor',
      })
    );
    expect(lastCall('update_graph_edge')).toEqual({
      id: 'e1',
      label: 'mentor',
      relationType: 'mentor',
      user: 'You',
    });
    expect(edges[0]).toMatchObject({ label: 'mentor', relation_type: 'mentor' });

    // Undo lives on the canvas toolbar, beside the node controls.
    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('update_relation')).toMatchObject({
        id: 'relation-1',
        kind: 'ally',
      })
    );
    expect(lastCall('update_graph_edge')).toEqual({
      id: 'e1',
      label: 'ally',
      relationType: 'ally',
      user: 'You',
    });
    expect(edges[0]).toMatchObject({ label: 'ally', relation_type: 'ally' });

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    await waitFor(() =>
      expect(lastCall('update_relation')).toMatchObject({
        id: 'relation-1',
        kind: 'mentor',
      })
    );
    expect(lastCall('update_graph_edge')).toEqual({
      id: 'e1',
      label: 'mentor',
      relationType: 'mentor',
      user: 'You',
    });
    expect(edges[0]).toMatchObject({ label: 'mentor', relation_type: 'mentor' });
  });

  it('moves a connection verb onto the relation on the sheet, with one undo step', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect characters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect characters' });
    await user.click(within(dialog).getByRole('button', { name: 'Connect characters' }));
    await waitFor(() => expect(lastCall('add_relation')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'edit e1' }));
    const relationType = screen.getByPlaceholderText('Relation type (optional)');
    expect(relationType).toHaveValue('ally');
    await user.clear(relationType);
    await user.type(relationType, 'mentor');
    await user.click(screen.getByTitle("Save this connection's fields"));

    await waitFor(() =>
      expect(lastCall('update_graph_edge')).toEqual({
        id: 'e1',
        label: 'mentor',
        relationType: 'mentor',
        user: 'You',
      })
    );
    expect(lastCall('update_relation')).toMatchObject({
      id: 'relation-1',
      kind: 'mentor',
      note: null,
      sinceChapterId: null,
      untilChapterId: null,
      user: 'You',
    });
    expect(edges[0]).toMatchObject({ label: 'mentor', relation_type: 'mentor' });
    expect(relations[0]).toMatchObject({ kind: 'mentor' });

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    await user.click(await screen.findByTitle("Show Rook's sheet"));
    expect(screen.getByTitle('Change this mentor relation')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(lastCall('update_relation')).toMatchObject({
        id: 'relation-1',
        kind: 'ally',
      })
    );
    expect(lastCall('update_graph_edge')).toEqual({
      id: 'e1',
      label: 'ally',
      relationType: 'ally',
      user: 'You',
    });
    expect(edges[0]).toMatchObject({ label: 'ally', relation_type: 'ally' });
    expect(relations[0]).toMatchObject({ kind: 'ally' });

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    await waitFor(() =>
      expect(lastCall('update_relation')).toMatchObject({
        id: 'relation-1',
        kind: 'mentor',
      })
    );
    expect(lastCall('update_graph_edge')).toEqual({
      id: 'e1',
      label: 'mentor',
      relationType: 'mentor',
      user: 'You',
    });
    expect(edges[0]).toMatchObject({ label: 'mentor', relation_type: 'mentor' });
    expect(relations[0]).toMatchObject({ kind: 'mentor' });
  });

  it('refuses to leave a relation drawing without a verb', async () => {
    const user = await openCanvas();

    await user.click(screen.getByRole('button', { name: 'connect characters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect characters' });
    await user.click(within(dialog).getByRole('button', { name: 'Connect characters' }));
    await waitFor(() => expect(lastCall('add_relation')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'edit e1' }));
    await user.clear(screen.getByPlaceholderText('Relation type (optional)'));
    await user.click(screen.getByTitle("Save this connection's fields"));

    expect(
      await screen.findByText(
        /This connection draws the ally relation between Rook and Wren/
      )
    ).toBeInTheDocument();
    expect(lastCall('update_graph_edge')).toBeUndefined();
    expect(relations[0]).toMatchObject({ kind: 'ally' });
    expect(edges[0]).toMatchObject({ label: 'ally', relation_type: 'ally' });
  });

  it('pre-fills a quest giver from a character card', async () => {
    const user = await openCanvas();
    const type = screen.getByTitle('The kind of node the Add button creates');

    // Every kind is made from the board, a skill included: a skill card placed
    // here is the definition, and its drawer is where holders are added.
    expect(
      within(type).getByRole('option', { name: 'skill' })
    ).toBeInTheDocument();

    await user.selectOptions(type, 'quest');
    await user.click(screen.getByRole('button', { name: 'spawn from character' }));

    const quest = await screen.findByRole('dialog', { name: 'New quest' });
    expect(within(quest).getByLabelText('Quest giver')).toHaveValue('char-1');
  });

  it('pre-fills a quest chapter from a chapter card', async () => {
    const user = await openCanvas();
    const type = screen.getByTitle('The kind of node the Add button creates');

    await user.selectOptions(type, 'quest');
    await user.click(screen.getByRole('button', { name: 'spawn from chapter' }));

    const quest = await screen.findByRole('dialog', { name: 'New quest' });
    expect(within(quest).getByLabelText('Quest accepted chapter')).toHaveValue('n3');
  });
});
