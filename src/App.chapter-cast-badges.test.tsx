import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

const cast = [
  {
    id: 'char-1',
    story_id: story.id,
    name: 'Rook',
    description: null,
    level: 12,
    xp: 0,
    rank: null,
    xp_to_next: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
  {
    id: 'char-2',
    story_id: story.id,
    name: 'Wren',
    description: null,
    level: 4,
    xp: 0,
    rank: null,
    xp_to_next: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
  {
    id: 'char-3',
    story_id: story.id,
    name: 'Tess',
    description: null,
    level: 2,
    xp: 0,
    rank: null,
    xp_to_next: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
];

// The explicit rows the picker has written. The badge command folds these in
// with the linked cast and POV, as the database does.
let chapterCastRows: any[] = [];

const nodeRow = (
  id: string,
  label: string,
  seq: number,
  characterId: string | null = null,
  pov: string | null = null
) => ({
  id,
  story_id: story.id,
  node_type: 'chapter',
  label,
  content: null,
  pos_x: 0,
  pos_y: 0,
  created_by: 'Ada',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  character_id: characterId,
  chapter_seq: seq,
  chapter_pov: pov,
});

const chapterCastStates = [
  {
    chapter_id: 'n1',
    character_id: 'char-1',
    level: 12,
    level_is_penalty: false,
    skills: [
      {
        skill_id: 'skill-1',
        name: 'Fireball',
        rank: 'Rank 3',
        effect: '3d8 fire',
        learned_chapter_id: 'n1',
        learned_chapter_seq: 1,
      },
      {
        skill_id: 'skill-2',
        name: 'Dash',
        rank: null,
        effect: null,
        learned_chapter_id: 'n1',
        learned_chapter_seq: 1,
      },
    ],
  },
  {
    chapter_id: 'n1',
    character_id: 'char-2',
    level: null,
    level_is_penalty: false,
    skills: [],
  },
];

beforeEach(() => {
  chapterCastRows = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return [
          nodeRow('n1', 'Chapter One', 1, 'char-1', 'char-2'),
          nodeRow('n2', 'Chapter Two', 2, 'char-2'),
          nodeRow('n3', 'Chapter Three', 3),
        ];
      case 'get_graph_edges':
      case 'get_story_character_stats':
      case 'get_story_levels':
      case 'get_story_skills':
      case 'get_story_skill_events':
      case 'get_story_inventory':
      case 'get_chapter_notes':
      case 'get_story_character_stats':
      case 'get_character_stats':
      case 'get_character_attributes':
      case 'get_character_skills':
      case 'get_character_inventory':
      case 'get_character_currency':
        return [];
      case 'get_characters':
        return args.storyId === story.id ? cast.map(entry => ({ ...entry })) : [];
      case 'get_story_chapter_cast':
        return chapterCastRows.map(row => ({ ...row }));
      case 'get_story_chapter_cast_states':
        return [
          ...chapterCastStates,
          ...chapterCastRows.map(row => ({
            chapter_id: row.chapter_id,
            character_id: row.character_id,
            level: null,
            level_is_penalty: false,
            skills: [],
          })),
        ].map(state => ({
          ...state,
          skills: state.skills.map(skill => ({ ...skill })),
        }));
      case 'add_chapter_cast_member': {
        const row = {
          id: `cast-${args.characterId}`,
          chapter_id: args.chapterId,
          character_id: args.characterId,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        chapterCastRows = [...chapterCastRows, row];
        return row;
      }
      case 'remove_chapter_cast_member':
        chapterCastRows = chapterCastRows.filter(row => row.id !== args.id);
        return null;
      default:
        return null;
    }
  });
});

function cardFor(container: HTMLElement, id: string) {
  return container.querySelector(`[data-id="${id}"]`) as HTMLElement;
}

async function openGraph() {
  const user = userEvent.setup();
  const view = render(<App />);

  await screen.findAllByText('Ledger');
  await screen.findByRole('button', { name: 'Chapter One' });

  return { user, ...view };
}

describe('chapter card cast badges', () => {
  it('shows assigned characters, their level and active skills in the tooltip', async () => {
    const { container } = await openGraph();

    await waitFor(() => {
      expect(
        within(cardFor(container, 'n1')).getByRole('group', {
          name: 'Cast in this chapter',
        })
      ).toBeInTheDocument();
    });

    const group = within(cardFor(container, 'n1')).getByRole('group', {
      name: 'Cast in this chapter',
    });
    const rook = within(group).getByRole('button', { name: /Rook, Level 12/i });

    expect(rook).toHaveClass('nodrag');
    expect(rook).toHaveClass('nopan');
    expect(rook).toHaveTextContent('Rook');
    expect(rook).toHaveTextContent('Lv 12');

    const title = rook.getAttribute('title') ?? '';
    expect(title).toContain('Level 12');
    expect(title).toContain('Fireball (Rank 3)');
    expect(title).toContain('Dash');
    expect(title).toContain("Open Rook's sheet");

    const noLevel = within(group).getByRole('button', {
      name: /Wren, No level recorded/i,
    });
    expect(noLevel).toHaveTextContent('Wren');
    expect(noLevel).not.toHaveTextContent('Lv');
    expect(noLevel.getAttribute('title') ?? '').toContain('No level recorded');

    // A chapter with nobody assigned has no badge section at all.
    expect(
      within(cardFor(container, 'n3')).queryByRole('group', {
        name: 'Cast in this chapter',
      })
    ).not.toBeInTheDocument();

    expect(
      invokeMock.mock.calls.some(call => call[0] === 'get_story_chapter_cast_states')
    ).toBe(true);
  });

  it('opens the character sheet from a badge', async () => {
    const { user, container } = await openGraph();

    const card = cardFor(container, 'n1');

    await waitFor(() => {
      expect(
        within(card).getByRole('button', { name: /Rook, Level 12/i })
      ).toBeInTheDocument();
    });

    await user.click(within(card).getByRole('button', { name: /Rook, Level 12/i }));

    expect(await screen.findByRole('heading', { name: 'Rook' })).toBeInTheDocument();
  });

  it('draws every present cast member, including one without a milestone', async () => {
    chapterCastRows = [
      {
        id: 'cast-tess',
        chapter_id: 'n1',
        character_id: 'char-3',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    const { container } = await openGraph();
    const card = cardFor(container, 'n1');

    await waitFor(() => {
      expect(
        within(card).getByRole('button', { name: /Tess, No level recorded/i })
      ).toBeInTheDocument();
    });

    const group = within(card).getByRole('group', { name: 'Cast in this chapter' });
    expect(within(group).getAllByRole('button')).toHaveLength(3);

    const tess = within(card).getByRole('button', {
      name: /Tess, No level recorded/i,
    });
    expect(tess).toHaveTextContent('Tess');
    expect(tess).not.toHaveTextContent('Lv');
  });

  it('adds and removes present cast from a chapter row', async () => {
    const { user, container } = await openGraph();

    await user.click(screen.getByRole('button', { name: 'Chapters' }));
    await screen.findByRole('heading', { name: 'Reading order' });
    await user.click(screen.getByRole('button', { name: 'Cast for Chapter Three' }));

    const panel = document.querySelector('.chapter-cast-panel') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(within(panel).getByText('Rook')).toBeInTheDocument();
    expect(
      within(panel).getByRole('checkbox', { name: 'Tess present in Chapter Three' })
    ).not.toBeChecked();

    await user.click(
      within(panel).getByRole('checkbox', { name: 'Tess present in Chapter Three' })
    );

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.find(call => call[0] === 'add_chapter_cast_member')?.[1]
      ).toMatchObject({ chapterId: 'n3', characterId: 'char-3' });
    });
    expect(
      within(panel).getByRole('checkbox', { name: 'Tess present in Chapter Three' })
    ).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await waitFor(() => {
      expect(
        within(cardFor(container, 'n3')).getByRole('button', {
          name: /Tess, No level recorded/i,
        })
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Chapters' }));
    const reopened = document.querySelector('.chapter-cast-panel') as HTMLElement;
    await user.click(
      within(reopened).getByRole('checkbox', {
        name: 'Tess present in Chapter Three',
      })
    );

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.find(call => call[0] === 'remove_chapter_cast_member')?.[1]
      ).toMatchObject({ id: 'cast-char-3' });
    });

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await waitFor(() => {
      expect(
        within(cardFor(container, 'n3')).queryByRole('button', {
          name: /Tess, No level recorded/i,
        })
      ).not.toBeInTheDocument();
    });
  });
});
