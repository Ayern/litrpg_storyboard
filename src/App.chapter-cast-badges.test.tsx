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

// The checklist rows a chapter card has written, and the awards it has paid.
// The ids keep counting instead of reusing a freed number, so a rewritten line
// is a different row — which is what makes the undo/redo test worth writing.
let chapterTasks: any[] = [];
let taskSeq = 0;
let awards: any[] = [];

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
  chapterTasks = [];
  taskSeq = 0;
  awards = [];
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
      case 'get_story_chapter_tasks':
        return chapterTasks.map(row => ({ ...row }));
      case 'add_chapter_task': {
        taskSeq += 1;
        const row = {
          id: `task-${taskSeq}`,
          chapter_id: args.chapterId,
          text: String(args.text),
          done: false,
          position: chapterTasks.length,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        chapterTasks = [...chapterTasks, row];
        return row;
      }
      case 'set_chapter_task_done': {
        chapterTasks = chapterTasks.map(row =>
          row.id === args.id ? { ...row, done: Boolean(args.done) } : row
        );
        return chapterTasks.find(row => row.id === args.id) ?? null;
      }
      case 'delete_chapter_task':
        chapterTasks = chapterTasks.filter(row => row.id !== args.id);
        return null;
      case 'get_story_character_awards':
        return awards.map(row => ({ ...row }));
      case 'add_character_award': {
        const row = {
          id: `award-${awards.length + 1}`,
          character_id: args.characterId,
          chapter_id: args.chapterId ?? null,
          kind: args.kind,
          stat_name: args.statName ?? null,
          amount: Number(args.amount),
          note: args.note ?? null,
          created_by: 'Ada',
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        awards = [...awards, row];
        return row;
      }
      case 'delete_character_award':
        awards = awards.filter(row => row.id !== args.id);
        return null;
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

  it('draws the roster once, not again in the linked-cast footer', async () => {
    const { container } = await openGraph();
    const card = cardFor(container, 'n1');

    await waitFor(() => {
      expect(
        within(card).getByRole('button', { name: /Rook, Level 12/i })
      ).toBeInTheDocument();
    });

    // The chapter is linked to Rook, and Rook is already a badge: the card says
    // his level once rather than adding a second row underneath.
    expect(card.querySelector('.graph-node-cast')).toBeNull();
  });

  it('explains where the roster comes from, from the keyboard too', async () => {
    const { user, container } = await openGraph();
    const card = cardFor(container, 'n1');

    const help = await within(card).findByRole('button', {
      name: 'About the cast on a chapter card',
    });

    expect(within(help).getByText('?')).toBeInTheDocument();

    // Focus, not hover: the bubble has to open for a keyboard author too.
    help.focus();

    const bubble = await screen.findByRole('tooltip');
    expect(bubble).toHaveTextContent('point of view');
    expect(bubble).toHaveTextContent('Present in this chapter');
    expect(bubble).toHaveTextContent('as of this chapter');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // A chapter with no cast still offers the roster on its face, so the dot
    // stays: an empty card is exactly where the explanation is needed.
    const empty = cardFor(container, 'n3');
    expect(
      within(empty).getByRole('button', {
        name: 'About the cast on a chapter card',
      })
    ).toBeInTheDocument();
    expect(within(empty).getByText('Nobody in this scene yet')).toBeInTheDocument();
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

  // ---- the chapter card's own workbench ----------------------------------
  //
  // The card writes the same rows the panels do, and every one of those writes
  // is one history step. These tests hold the card to that: the line appears on
  // the face, and Undo takes it back off.

  it('plans a scene from the card, and Undo takes the line back', async () => {
    const { user, container } = await openGraph();
    const card = cardFor(container, 'n1');

    const field = await within(card).findByRole('textbox', {
      name: 'Add an objective to Chapter One',
    });

    await user.type(field, 'Open on the toll gate{Enter}');

    await waitFor(() => {
      expect(within(card).getByText('Open on the toll gate')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(
        within(card).queryByText('Open on the toll gate')
      ).not.toBeInTheDocument();
    });

    // Redo writes a new row with a new id, and the next Undo still takes that
    // row away rather than naming the one the redo replaced.
    await user.click(screen.getByRole('button', { name: 'Redo' }));

    await waitFor(() => {
      expect(within(card).getByText('Open on the toll gate')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(
        within(card).queryByText('Open on the toll gate')
      ).not.toBeInTheDocument();
    });
  });

  it('ticks a line off on the card, and Undo opens it again', async () => {
    chapterTasks = [
      {
        id: 'task-1',
        chapter_id: 'n1',
        text: 'Vane names his price',
        done: false,
        position: 0,
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    const { user, container } = await openGraph();
    const card = cardFor(container, 'n1');

    await user.click(
      await within(card).findByRole('checkbox', {
        name: 'Vane names his price — open',
      })
    );

    await waitFor(() => {
      expect(
        within(card).getByRole('checkbox', {
          name: 'Vane names his price — done',
        })
      ).toBeChecked();
    });

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(
        within(card).getByRole('checkbox', {
          name: 'Vane names his price — open',
        })
      ).not.toBeChecked();
    });
  });

  it('puts a name in the scene from the card, and Undo takes them out', async () => {
    const { user, container } = await openGraph();
    const card = cardFor(container, 'n1');

    await user.click(await within(card).findByRole('button', { name: 'Cast' }));
    await user.click(
      within(card).getByRole('checkbox', {
        name: 'Tess present in Chapter One',
      })
    );

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.find(
          call => call[0] === 'add_chapter_cast_member'
        )?.[1]
      ).toMatchObject({ chapterId: 'n1', characterId: 'char-3' });
    });

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.find(
          call => call[0] === 'remove_chapter_cast_member'
        )?.[1]
      ).toMatchObject({ id: 'cast-char-3' });
    });
  });

  it('pays XP into a chapter from the card, as one undoable step', async () => {
    const { user, container } = await openGraph();
    const card = cardFor(container, 'n1');

    await user.click(await within(card).findByRole('button', { name: '+ XP' }));

    // The point of view is the person the card pays by default.
    expect(
      within(card).getByRole('combobox', {
        name: 'Who the XP is for in Chapter One',
      })
    ).toHaveValue('char-2');

    await user.type(
      within(card).getByRole('spinbutton', {
        name: 'XP to award in Chapter One',
      }),
      '100'
    );
    await user.click(within(card).getByRole('button', { name: 'Award' }));

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.find(call => call[0] === 'add_character_award')?.[1]
      ).toMatchObject({
        characterId: 'char-2',
        chapterId: 'n1',
        kind: 'xp',
        amount: 100,
      });
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.find(call => call[0] === 'delete_character_award')?.[1]
      ).toMatchObject({ id: 'award-1' });
    });
  });
});
