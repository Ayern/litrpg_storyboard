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

interface CharacterRow {
  id: string;
  story_id: string;
  name: string;
  description: string | null;
  level: number;
  xp: number;
  rank: string | null;
  xp_to_next: number | null;
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

interface StandingRow {
  id: string;
  story_id: string;
  character_id: string;
  faction_node_id: string | null;
  standing: string;
  note: string | null;
  since_chapter_id: string | null;
  until_chapter_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const rook: CharacterRow = {
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

const mira: CharacterRow = {
  ...rook,
  id: 'char-2',
  name: 'Mira',
  level: 2,
  xp: 100,
  rank: null,
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

let cast: CharacterRow[] = [];
let relations: RelationRow[] = [];
let standings: StandingRow[] = [];

beforeEach(() => {
  cast = [rook, mira];
  relations = [];
  standings = [];

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
          nodeRow('n3', 'chapter', 'Chapter Three'),
          nodeRow('n4', 'faction', 'The Ashen Guild'),
        ];
      case 'get_graph_edges':
      case 'get_character_stats':
      case 'get_story_character_stats':
      case 'get_character_attributes':
      case 'get_character_skills':
      case 'get_character_inventory':
      case 'get_character_currency':
      case 'get_character_level_milestones':
      case 'get_character_progress':
        return [];
      case 'get_story_skills':
      case 'get_story_skill_events':
      case 'get_story_level_milestones':
      case 'get_story_character_progress':
      case 'get_story_inventory':
      case 'get_story_chapter_cast':
      case 'get_chapter_notes':
        return [];
      case 'get_characters':
        return cast.map(character => ({ ...character }));
      case 'get_story_relations':
        return relations.map(relation => ({ ...relation }));
      case 'get_story_faction_standings':
        return standings.map(standing => ({ ...standing }));
      case 'add_relation': {
        const saved: RelationRow = {
          id: `relation-${relations.length + 1}`,
          story_id: story.id,
          from_character_id: args.fromCharacterId,
          to_character_id: args.toCharacterId,
          kind: args.kind,
          note: args.note ?? null,
          since_chapter_id: args.sinceChapterId ?? null,
          until_chapter_id: args.untilChapterId ?? null,
          created_by: args.user,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        relations = [...relations, saved];
        return { ...saved };
      }
      case 'update_relation': {
        const existing = relations.find(relation => relation.id === args.id);
        if (!existing) return null;
        const updated: RelationRow = {
          ...existing,
          kind: args.kind,
          note: args.note ?? null,
          since_chapter_id: args.sinceChapterId ?? null,
          until_chapter_id: args.untilChapterId ?? null,
        };
        relations = relations.map(relation =>
          relation.id === updated.id ? updated : relation
        );
        return { ...updated };
      }
      case 'delete_relation':
        relations = relations.filter(relation => relation.id !== args.id);
        return null;
      case 'add_faction_standing': {
        const saved: StandingRow = {
          id: `standing-${standings.length + 1}`,
          story_id: story.id,
          character_id: args.characterId,
          faction_node_id: args.factionNodeId ?? null,
          standing: args.standing,
          note: args.note ?? null,
          since_chapter_id: args.sinceChapterId ?? null,
          until_chapter_id: args.untilChapterId ?? null,
          created_by: args.user,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        standings = [...standings, saved];
        return { ...saved };
      }
      case 'update_faction_standing': {
        const existing = standings.find(standing => standing.id === args.id);
        if (!existing) return null;
        const updated: StandingRow = {
          ...existing,
          faction_node_id: args.factionNodeId ?? null,
          standing: args.standing,
          note: args.note ?? null,
          since_chapter_id: args.sinceChapterId ?? null,
          until_chapter_id: args.untilChapterId ?? null,
        };
        standings = standings.map(standing =>
          standing.id === updated.id ? updated : standing
        );
        return { ...updated };
      }
      case 'delete_faction_standing':
        standings = standings.filter(standing => standing.id !== args.id);
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
  await user.click(screen.getByRole('button', { name: 'Characters' }));
  await user.click(screen.getByTitle("Show Rook's sheet"));

  return user;
}

async function openMap() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Characters' }));
  await user.click(screen.getByRole('button', { name: 'Relations' }));

  return user;
}

async function openChapters() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Chapters' }));

  return user;
}

function continuityPanel() {
  return screen.getByRole('region', { name: 'Continuity' });
}

function continuityText(panel: HTMLElement) {
  return [...panel.querySelectorAll('li')].map(item => item.textContent).join('\n');
}

describe('relations on the character sheet', () => {
  it('adds, edits and deletes a relation', async () => {
    const user = await openSheet();

    await user.clear(screen.getByLabelText('New relation kind'));
    await user.type(screen.getByLabelText('New relation kind'), 'rival');
    await user.selectOptions(screen.getByLabelText('New relation with'), 'char-2');
    await user.selectOptions(
      screen.getByLabelText('New relation since chapter'),
      'n1'
    );
    await user.type(screen.getByLabelText('New relation note'), 'For the ledger');
    await user.click(screen.getByRole('button', { name: 'Add relation' }));

    expect(lastCall('add_relation')).toMatchObject({
      fromCharacterId: 'char-1',
      toCharacterId: 'char-2',
      kind: 'rival',
      note: 'For the ledger',
      sinceChapterId: 'n1',
      untilChapterId: null,
      user: 'You',
    });
    expect(
      document.querySelector('[data-progression="relation-relation-1"]')
    ).toHaveTextContent('rivalMira');

    await user.click(screen.getByTitle('Change this rival relation'));
    await user.clear(screen.getByLabelText('Relation kind'));
    await user.type(screen.getByLabelText('Relation kind'), 'mentor');
    await user.selectOptions(screen.getByLabelText('Relation until chapter'), 'n3');
    await user.click(screen.getByRole('button', { name: 'Save relation' }));

    expect(lastCall('update_relation')).toMatchObject({
      id: 'relation-1',
      kind: 'mentor',
      note: 'For the ledger',
      sinceChapterId: 'n1',
      untilChapterId: 'n3',
      user: 'You',
    });
    expect(
      document.querySelector('[data-progression="relation-relation-1"]')
    ).toHaveTextContent('mentorMira');

    await user.click(screen.getByTitle('Delete this mentor relation'));
    expect(lastCall('delete_relation')).toMatchObject({
      id: 'relation-1',
      user: 'You',
    });
    expect(document.querySelector('[data-progression="relation-relation-1"]')).toBeNull();
  });

  it('shows every kind of bond as soon as the field is focused', async () => {
    const user = await openSheet();

    const kind = screen.getByLabelText('New relation kind');
    await user.click(kind);

    const list = screen.getByRole('listbox', {
      name: 'New relation kind suggestions',
    });

    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual(
      ['ally', 'rival', 'mentor', 'family', 'enemy', 'owes']
    );

    await user.click(within(list).getByRole('option', { name: 'mentor' }));
    expect(kind).toHaveValue('mentor');
  });

  it('records a faction standing with the chapter it began in', async () => {
    const user = await openSheet();

    await user.selectOptions(
      screen.getByLabelText('New standing faction'),
      'n4'
    );
    await user.type(screen.getByLabelText('New standing role'), 'Captain');
    await user.selectOptions(
      screen.getByLabelText('New standing since chapter'),
      'n2'
    );
    await user.click(screen.getByRole('button', { name: 'Add standing' }));

    expect(lastCall('add_faction_standing')).toMatchObject({
      characterId: 'char-1',
      factionNodeId: 'n4',
      standing: 'Captain',
      sinceChapterId: 'n2',
      untilChapterId: null,
      user: 'You',
    });
    expect(
      document.querySelector('[data-progression="faction-standing-standing-1"]')
    ).toHaveTextContent('The Ashen GuildCaptain');

    await user.click(screen.getByTitle('Change this Captain standing'));
    await user.clear(screen.getByLabelText('Standing role'));
    await user.type(screen.getByLabelText('Standing role'), 'Exiled');
    await user.click(screen.getByRole('button', { name: 'Save standing' }));

    expect(lastCall('update_faction_standing')).toMatchObject({
      id: 'standing-1',
      factionNodeId: 'n4',
      standing: 'Exiled',
      sinceChapterId: 'n2',
      user: 'You',
    });

    await user.click(screen.getByTitle('Delete this Exiled standing'));
    expect(lastCall('delete_faction_standing')).toMatchObject({
      id: 'standing-1',
      user: 'You',
    });
    expect(
      document.querySelector('[data-progression="faction-standing-standing-1"]')
    ).toBeNull();
  });
});

describe('the relations map', () => {
  beforeEach(() => {
    relations = [
      {
        id: 'relation-1',
        story_id: story.id,
        from_character_id: 'char-1',
        to_character_id: 'char-2',
        kind: 'rival',
        note: 'For the ledger',
        since_chapter_id: 'n1',
        until_chapter_id: null,
        created_by: 'Ada',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];
    standings = [
      {
        id: 'standing-1',
        story_id: story.id,
        character_id: 'char-1',
        faction_node_id: 'n4',
        standing: 'Captain',
        note: null,
        since_chapter_id: 'n1',
        until_chapter_id: null,
        created_by: 'Ada',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];
  });

  it('draws the cast, factions and labelled relation lines', async () => {
    await openMap();

    const map = screen.getByRole('group', { name: 'Cast relations map' });

    expect(within(map).getByText('Rook')).toBeInTheDocument();
    expect(within(map).getByText('Mira')).toBeInTheDocument();
    expect(within(map).getByText('The Ashen Guild')).toBeInTheDocument();
    expect(
      within(map).getByRole('button', {
        name: 'Edit the rival relation between Rook and Mira',
      })
    ).toBeInTheDocument();
    expect(
      within(map).getByRole('button', {
        name: "Edit Rook's Captain standing in The Ashen Guild",
      })
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Relation styles' })).toHaveTextContent(
      'ally'
    );
  });

  it('dims everyone else when a character is focused', async () => {
    const user = await openMap();

    await user.click(screen.getByRole('button', { name: 'Focus Rook' }));

    expect(screen.getByRole('button', { name: 'Stop focusing Rook' })).toHaveClass(
      'focused'
    );
    expect(screen.getByRole('button', { name: 'Focus Mira' })).toHaveClass('dimmed');

    await user.click(screen.getByRole('button', { name: 'Stop focusing Rook' }));
    expect(screen.getByRole('button', { name: 'Focus Mira' })).not.toHaveClass(
      'dimmed'
    );
  });

  it('opens the relation editor on the sheet from a map line', async () => {
    const user = await openMap();

    await user.click(
      screen.getByRole('button', {
        name: 'Edit the rival relation between Rook and Mira',
      })
    );

    expect(screen.getByRole('button', { name: 'Characters' })).toHaveClass('active');
    expect(screen.getByLabelText('Relation kind')).toHaveValue('rival');
    expect(
      document.querySelector('[data-progression="relation-relation-1"]')
    ).toHaveClass('progression-row-focused');
  });
});

describe('relation continuity', () => {
  it('names a relation that points at a cast member in the trash', async () => {
    cast = [rook];
    relations = [
      {
        id: 'relation-1',
        story_id: story.id,
        from_character_id: 'char-1',
        to_character_id: 'char-2',
        kind: 'ally',
        note: null,
        since_chapter_id: 'n1',
        until_chapter_id: null,
        created_by: 'Ada',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    await openChapters();

    expect(continuityText(continuityPanel())).toContain(
      "Rook's ally relation points at a cast member in the trash."
    );
  });

  it('flags two standings held in one faction at the same time', async () => {
    standings = [
      {
        id: 'standing-1',
        story_id: story.id,
        character_id: 'char-1',
        faction_node_id: 'n4',
        standing: 'Captain',
        note: null,
        since_chapter_id: 'n1',
        until_chapter_id: null,
        created_by: 'Ada',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
      {
        id: 'standing-2',
        story_id: story.id,
        character_id: 'char-1',
        faction_node_id: 'n4',
        standing: 'Exiled',
        note: null,
        since_chapter_id: 'n2',
        until_chapter_id: null,
        created_by: 'Ada',
        created_at: '2026-10-22T12:00:01Z',
        updated_at: '2026-10-22T12:00:01Z',
      },
    ];

    await openChapters();

    expect(continuityText(continuityPanel())).toContain(
      'Rook holds two standings in The Ashen Guild at once'
    );
  });

  it('flags a standing that ends before it began', async () => {
    standings = [
      {
        id: 'standing-1',
        story_id: story.id,
        character_id: 'char-1',
        faction_node_id: 'n4',
        standing: 'Captain',
        note: null,
        since_chapter_id: 'n3',
        until_chapter_id: 'n1',
        created_by: 'Ada',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    await openChapters();

    expect(continuityText(continuityPanel())).toContain(
      "Rook's Captain standing in The Ashen Guild ends in “Chapter One” before it begins in “Chapter Three”."
    );
  });

  it('names a standing whose faction card is in the trash', async () => {
    standings = [
      {
        id: 'standing-1',
        story_id: story.id,
        character_id: 'char-1',
        faction_node_id: null,
        standing: 'Captain',
        note: null,
        since_chapter_id: 'n1',
        until_chapter_id: null,
        created_by: 'Ada',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    await openChapters();

    expect(continuityText(continuityPanel())).toContain(
      "Rook's Captain standing is on a faction card in the trash."
    );
  });
});
