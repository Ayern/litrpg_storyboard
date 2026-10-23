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

interface NodeRow {
  id: string;
  story_id: string;
  node_type: string;
  label: string;
  content: string | null;
  pos_x: number;
  pos_y: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  character_id: string | null;
  chapter_seq: number | null;
  chapter_arc: string | null;
  chapter_words: number | null;
  chapter_target: number | null;
  chapter_pov: string | null;
  chapter_day: number | null;
  parent_node_id: string | null;
}

function nodeRow(
  id: string,
  nodeType: string,
  label: string,
  seq: number | null,
  createdAt = '2026-10-22T12:00:00Z'
): NodeRow {
  return {
    id,
    story_id: story.id,
    node_type: nodeType,
    label,
    content: null,
    pos_x: 0,
    pos_y: 0,
    created_by: 'Ada',
    created_at: createdAt,
    updated_at: createdAt,
    character_id: null,
    chapter_seq: seq,
    chapter_arc: null,
    chapter_words: null,
    chapter_target: null,
    chapter_pov: null,
    chapter_day: null,
    parent_node_id: null,
  };
}

// The cast a chapter can be told from. Only the tests about POV and the timeline
// need it, so they install it rather than every test carrying a cast around.
const cast = [
  {
    id: 'c1',
    story_id: story.id,
    name: 'Rook',
    description: null,
    level: 1,
    xp: 0,
    rank: null,
    xp_to_next: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
  {
    id: 'c2',
    story_id: story.id,
    name: 'Mara',
    description: null,
    level: 1,
    xp: 0,
    rank: null,
    xp_to_next: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
];

function withCast() {
  const fallback = invokeMock.getMockImplementation();

  invokeMock.mockImplementation(async (command: string, args?: unknown) => {
    if (command === 'get_characters') return cast.map(character => ({ ...character }));
    return fallback?.(command, args);
  });
}

let rows: NodeRow[] = [];

// The notes kept with chapters. Each hangs off one chapter row.
let notes: NodeRow[] = [];

function seedNotes(...seeded: { id: string; chapter: string; text: string }[]) {
  notes = seeded.map(note =>
    Object.assign(nodeRow(note.id, 'note', note.text.split('\n')[0], null), {
      content: note.text,
      parent_node_id: note.chapter,
    })
  );
}

const chaptersInOrder = () =>
  rows
    .filter(node => node.node_type === 'chapter')
    .sort((left, right) => (left.chapter_seq ?? 999) - (right.chapter_seq ?? 999));

beforeEach(() => {
  rows = [
    { ...nodeRow('n1', 'chapter', 'One', 1, '2026-10-22T12:00:00Z'), chapter_arc: 'The Vault', chapter_words: 1200, chapter_target: 2000 },
    nodeRow('n2', 'idea', 'Idea', null, '2026-10-22T12:01:00Z'),
    { ...nodeRow('n3', 'chapter', 'Two', 2, '2026-10-22T12:02:00Z'), chapter_arc: 'The Vault', chapter_words: 800, chapter_target: 2000 },
    nodeRow('n4', 'chapter', 'Three', 3, '2026-10-22T12:03:00Z'),
  ];

  notes = [];

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return rows.map(row => ({ ...row }));
      case 'get_graph_edges':
        return [];
      case 'get_characters':
      case 'get_story_character_stats':
      case 'get_character_stats':
      case 'get_character_attributes':
      case 'get_audit_history':
        return [];
      case 'create_graph_node': {
        const highest = Math.max(0, ...rows.map(row => row.chapter_seq ?? 0));
        const created = nodeRow(
          `n-created-${rows.length + 1}`,
          args.nodeType,
          args.label,
          args.nodeType === 'chapter' ? highest + 1 : null
        );
        created.pos_x = args.posX;
        created.pos_y = args.posY;
        rows = [...rows, created];
        return { ...created };
      }
      case 'set_chapter_order': {
        const ordered = args.orderedIds as string[];
        ordered.forEach((id, index) => {
          const row = rows.find(candidate => candidate.id === id);
          if (row) row.chapter_seq = index + 1;
        });
        return chaptersInOrder().map(row => ({ ...row }));
      }
      case 'get_chapter_notes':
        return notes.map(note => ({ ...note }));
      case 'add_chapter_note': {
        const text = String(args.text);
        const created = Object.assign(
          nodeRow(`note-${notes.length + 1}`, 'note', text.split('\n')[0].trim(), null),
          { content: text, parent_node_id: args.chapterId }
        );
        notes = [...notes, created];
        return { ...created };
      }
      case 'update_chapter_note': {
        const note = notes.find(candidate => candidate.id === args.id);
        if (!note) return null;

        note.content = args.text;
        note.label = String(args.text).split('\n')[0].trim();
        return { ...note };
      }
      case 'delete_node': {
        notes = notes.filter(note => note.id !== args.id);
        return true;
      }
      case 'set_chapter_details': {
        const row = rows.find(candidate => candidate.id === args.nodeId);
        if (!row) return null;

        row.chapter_arc = args.arc ?? null;
        row.chapter_words = args.words ?? null;
        row.chapter_target = args.target ?? null;
        row.chapter_pov = args.pov ?? null;
        row.chapter_day = args.day ?? null;
        return { ...row };
      }
      default:
        return null;
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

async function openChapters() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Chapters' }));

  return user;
}

function list() {
  return screen.getByRole('list', { name: 'Chapters' });
}

function rowsInList() {
  return within(list()).getAllByRole('listitem');
}

describe('the chapter list', () => {
  it('numbers the chapters and leaves other cards out', async () => {
    await openChapters();

    const rows = rowsInList();
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('One')).toBeInTheDocument();
    expect(within(rows[0]).getByText('1')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Two')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Three')).toBeInTheDocument();
    expect(within(rows[2]).getByText('3')).toBeInTheDocument();
    expect(screen.queryByText('Idea')).not.toBeInTheDocument();
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
  });

  it('adds a chapter at the end and shows it on the graph', async () => {
    const user = await openChapters();

    await user.type(screen.getByPlaceholderText('Chapter title'), 'Four');
    await user.click(screen.getByRole('button', { name: 'New chapter' }));

    expect(lastCall('create_graph_node')).toEqual({
      storyId: story.id,
      nodeType: 'chapter',
      label: 'Four',
      content: null,
      posX: expect.any(Number),
      posY: expect.any(Number),
      createdBy: 'You',
    });

    const added = await waitFor(() => rowsInList()[3]);
    expect(within(added).getByText('Four')).toBeInTheDocument();
    expect(within(added).getByText('4')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Chapter title')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    expect(await screen.findByText('Ch. 4')).toBeInTheDocument();
  });

  it('moves a chapter up by one and renumbers the rest', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Move Two earlier' }));

    await waitFor(() =>
      expect(lastCall('set_chapter_order')).toEqual({
        storyId: story.id,
        orderedIds: ['n3', 'n1', 'n4'],
        user: 'You',
      })
    );

    await waitFor(() => {
      const moved = rowsInList();
      expect(within(moved[0]).getByText('Two')).toBeInTheDocument();
      expect(within(moved[0]).getByText('1')).toBeInTheDocument();
      expect(within(moved[1]).getByText('One')).toBeInTheDocument();
      expect(within(moved[2]).getByText('Three')).toBeInTheDocument();
    });

    // The canvas badge follows the list.
    await user.click(screen.getByRole('button', { name: 'Graph' }));
    expect(await screen.findByText('Ch. 1')).toBeInTheDocument();
  });

  it('cannot move the first chapter earlier or the last one later', async () => {
    await openChapters();

    expect(screen.getByRole('button', { name: 'Move One earlier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Three later' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Two earlier' })).toBeEnabled();
  });

  it('flags a gap left by a deleted chapter and can renumber it away', async () => {
    // Chapter Two was trashed, so the live story holds 1 and 3.
    rows = rows.filter(node => node.id !== 'n3');

    const user = await openChapters();

    expect(
      screen.getByText(/reading order needs attention: position 2 is empty/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Renumber' }));

    await waitFor(() =>
      expect(lastCall('set_chapter_order')).toEqual({
        storyId: story.id,
        orderedIds: ['n1', 'n4'],
        user: 'You',
      })
    );

    await waitFor(() => {
      const numbered = rowsInList();
      expect(within(numbered[0]).getByText('One')).toBeInTheDocument();
      expect(within(numbered[0]).getByText('1')).toBeInTheDocument();
      expect(within(numbered[1]).getByText('Three')).toBeInTheDocument();
      expect(within(numbered[1]).getByText('2')).toBeInTheDocument();
    });
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
  });

  it('says when two chapters share a position', async () => {
    rows = rows.map(node => (node.id === 'n4' ? { ...node, chapter_seq: 2 } : node));

    await openChapters();

    expect(
      screen.getByText(/reading order needs attention: position 2 is used more than once/i)
    ).toBeInTheDocument();
  });

  it('keeps the old order and says why when the database refuses', async () => {
    const user = await openChapters();

    invokeMock.mockImplementationOnce(async () => {
      throw 'another window moved a chapter';
    });
    await user.click(screen.getByRole('button', { name: 'Move Three earlier' }));

    expect(
      await screen.findByText(/Could not reorder chapters: another window moved a chapter/i)
    ).toBeInTheDocument();

    const unchanged = rowsInList();
    expect(within(unchanged[0]).getByText('One')).toBeInTheDocument();
    expect(within(unchanged[2]).getByText('Three')).toBeInTheDocument();
  });

  it('undoes a move through the same command', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Move Two earlier' }));
    await waitFor(() => expect(rows[0].chapter_seq).toBe(2));

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect([...invokeMock.mock.calls].reverse().find(call => call[0] === 'set_chapter_order')?.[1])
        .toEqual({
          storyId: story.id,
          orderedIds: ['n1', 'n3', 'n4'],
          user: 'You',
        })
    );
  });

  it('shows an empty list for a story with no chapters', async () => {
    rows = [nodeRow('n2', 'idea', 'Idea', null)];

    await openChapters();

    expect(
      screen.getByText(/No chapters yet — add one here, or add a chapter card on the Graph tab/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Chapters' })).not.toBeInTheDocument();
  });
});

describe('chapter arcs and word counts', () => {
  it('shows each arc and count, and the story total', async () => {
    await openChapters();

    const [one, , three] = rowsInList();
    expect(within(one).getByText('The Vault')).toBeInTheDocument();
    expect(within(one).getByText('1,200 / 2,000 words')).toBeInTheDocument();
    expect(within(three).getByText('No word count')).toBeInTheDocument();

    expect(screen.getByText('2,000 words of 4,000')).toBeInTheDocument();
    expect(screen.getByText(/3 chapters · 2 with a target/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Story word count' })).toHaveAttribute(
      'aria-valuenow',
      '50'
    );
  });

  it('saves an arc, a count and a target from the row', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));

    const arc = screen.getByLabelText('Arc');
    await user.clear(arc);
    await user.type(arc, 'The Deep');

    const words = screen.getByLabelText('Words');
    await user.clear(words);
    await user.type(words, '1500');

    const target = screen.getByLabelText('Target');
    await user.clear(target);
    await user.type(target, '2500');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(lastCall('set_chapter_details')).toEqual({
      nodeId: 'n1',
      arc: 'The Deep',
      words: 1500,
      target: 2500,
      pov: null,
      day: null,
      user: 'You',
    });

    await waitFor(() => {
      const [one] = rowsInList();
      expect(within(one).getByText('The Deep')).toBeInTheDocument();
      expect(within(one).getByText('1,500 / 2,500 words')).toBeInTheDocument();
    });

    expect(screen.queryByLabelText('Arc')).not.toBeInTheDocument();
    expect(screen.getByText('2,300 words of 4,500')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Story word count' })).toHaveAttribute(
      'aria-valuenow',
      '51'
    );
  });

  it('clears the arc and the target but keeps a count of zero', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit Three details' }));

    const words = screen.getByLabelText('Words');
    await user.type(words, '400');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(lastCall('set_chapter_details')).toEqual({
      nodeId: 'n4',
      arc: null,
      words: 400,
      target: null,
      pov: null,
      day: null,
      user: 'You',
    });

    await waitFor(() => {
      const three = rowsInList()[2];
      expect(within(three).getByText('400 words')).toBeInTheDocument();
    });

    // The target still only covers two of the three chapters.
    expect(screen.getByText('2,400 words of 4,000')).toBeInTheDocument();
    expect(screen.getByText(/3 chapters · 2 with a target/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));
    await user.clear(screen.getByLabelText('Arc'));
    await user.clear(screen.getByLabelText('Words'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(lastCall('set_chapter_details')).toEqual({
      nodeId: 'n1',
      arc: null,
      words: null,
      target: 2000,
      pov: null,
      day: null,
      user: 'You',
    });

    await waitFor(() => {
      const one = rowsInList()[0];
      expect(within(one).getByText('0 / 2,000 words')).toBeInTheDocument();
    });
  });

  it('refuses a target of zero without calling the database', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit Two details' }));
    const target = screen.getByLabelText('Target');
    await user.clear(target);
    await user.type(target, '0');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      screen.getByText('A word target is a whole number above 0, or blank.')
    ).toBeInTheDocument();
    expect(lastCall('set_chapter_details')).toBeUndefined();
    expect(screen.getByLabelText('Target')).toHaveValue(0);
  });

  it('keeps the form open and says why when the save fails', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));
    invokeMock.mockImplementationOnce(async () => {
      throw 'the database is locked';
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/Could not save the chapter details: the database is locked/i)
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Words')).toBeInTheDocument();
  });

  it('leaves the chapter alone when the form is cancelled', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit Two details' }));
    await user.type(screen.getByLabelText('Words'), '99');
    await user.keyboard('{Escape}');

    expect(screen.queryByLabelText('Words')).not.toBeInTheDocument();
    expect(within(rowsInList()[1]).getByText('800 / 2,000 words')).toBeInTheDocument();
    expect(lastCall('set_chapter_details')).toBeUndefined();
  });
});

describe('chapter POV and in-world days', () => {
  it('saves a POV cast member and a day, and shows both on the row', async () => {
    withCast();
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));

    const pov = screen.getByLabelText('POV');
    expect(within(pov).getByRole('option', { name: 'Rook' })).toBeInTheDocument();
    await user.selectOptions(pov, 'c1');

    await user.type(screen.getByLabelText('Day'), '3');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(lastCall('set_chapter_details')).toMatchObject({
      nodeId: 'n1',
      pov: 'c1',
      day: 3,
    });

    await waitFor(() => {
      const [one] = rowsInList();
      expect(within(one).getByText('Rook')).toBeInTheDocument();
      expect(within(one).getByText('Day 3')).toBeInTheDocument();
    });

    // The day places it on the timeline, which names its POV too.
    const timeline = screen.getByRole('list', { name: 'Chapter timeline' });
    const placed = within(timeline).getAllByRole('listitem');
    expect(placed).toHaveLength(1);
    expect(within(placed[0]).getByText('Day 3')).toBeInTheDocument();
    expect(within(placed[0]).getByText('Rook')).toBeInTheDocument();
  });

  it('orders the timeline by day rather than by chapter number', async () => {
    rows[0].chapter_day = 3; // One, chapter 1
    rows[2].chapter_day = 2; // Two, chapter 2
    rows[3].chapter_day = 2; // Three, chapter 3

    await openChapters();

    const timeline = screen.getByRole('list', { name: 'Chapter timeline' });
    const placed = within(timeline).getAllByRole('listitem');

    // Same-day chapters keep their reading order; the later day comes last.
    expect(placed.map(row => within(row).getByText(/^Day /).textContent)).toEqual([
      'Day 2',
      'Day 2',
      'Day 3',
    ]);
    expect(placed.map(row => within(row).getByText(/^(One|Two|Three)$/).textContent)).toEqual([
      'Two',
      'Three',
      'One',
    ]);

    expect(screen.getByText('3 placed')).toBeInTheDocument();
  });

  it('leaves a chapter without a day off the timeline and says how many are waiting', async () => {
    rows[0].chapter_day = 1;

    await openChapters();

    const timeline = screen.getByRole('list', { name: 'Chapter timeline' });
    const placed = within(timeline).getAllByRole('listitem');

    expect(placed).toHaveLength(1);
    expect(within(placed[0]).getByText('One')).toBeInTheDocument();
    expect(screen.getByText('1 placed · 2 without a day')).toBeInTheDocument();
  });

  it('keeps a POV whose cast member is in the trash', async () => {
    rows[0].chapter_pov = 'c9';
    withCast();
    const user = await openChapters();

    const [one] = rowsInList();
    expect(within(one).getByText('cast member in the trash')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));

    const pov = screen.getByLabelText('POV');
    expect(pov).toHaveValue('c9');
    expect(
      within(pov).getByRole('option', { name: 'Cast member in the trash' })
    ).toBeInTheDocument();

    // Saving an unrelated field sends the link back unchanged rather than
    // dropping the author's POV because its cast member is not on the tab.
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(lastCall('set_chapter_details')).toMatchObject({ nodeId: 'n1', pov: 'c9' });
  });

  it('refuses a negative day without calling the database', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));

    const day = screen.getByLabelText('Day');
    await user.clear(day);
    await user.type(day, '-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      screen.getByText('An in-world day is a whole number, 0 or more, or blank.')
    ).toBeInTheDocument();
    expect(lastCall('set_chapter_details')).toBeUndefined();
    expect(screen.getByLabelText('Day')).toHaveValue(-1);
  });
});

describe('chapter notes', () => {
  it('adds a plain-text note and shows it under its chapter', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Notes for One' }));

    expect(screen.getByText(/No notes yet/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('New note for One'), 'Rook owes the vault');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    expect(lastCall('add_chapter_note')).toEqual({
      chapterId: 'n1',
      text: 'Rook owes the vault',
      user: 'You',
    });

    expect(await screen.findByText('Rook owes the vault')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notes for One' })).toHaveTextContent(
      'Notes (1)'
    );

    // The box empties so the next note can be typed straight away.
    expect(screen.getByLabelText('New note for One')).toHaveValue('');
  });

  it('keeps each chapter to its own notes', async () => {
    seedNotes(
      { id: 'note-1', chapter: 'n1', text: 'Rook owes the vault' },
      { id: 'note-2', chapter: 'n3', text: 'The warder bargains' }
    );

    const user = await openChapters();

    expect(screen.getByRole('button', { name: 'Notes for One' })).toHaveTextContent(
      'Notes (1)'
    );
    expect(screen.getByRole('button', { name: 'Notes for Two' })).toHaveTextContent(
      'Notes (1)'
    );
    expect(screen.getByRole('button', { name: 'Notes for Three' })).toHaveTextContent('Notes');

    await user.click(screen.getByRole('button', { name: 'Notes for One' }));

    expect(screen.getByText('Rook owes the vault')).toBeInTheDocument();
    expect(screen.queryByText('The warder bargains')).not.toBeInTheDocument();
  });

  it('edits a note and refuses to save one with nothing in it', async () => {
    seedNotes({ id: 'note-1', chapter: 'n1', text: 'Rook owes the vault' });
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Notes for One' }));
    await user.click(
      screen.getByRole('button', { name: 'Edit the note Rook owes the vault' })
    );

    const editor = screen.getByLabelText('Edit note in One');
    await user.clear(editor);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('A note needs some text.')).toBeInTheDocument();
    expect(lastCall('update_chapter_note')).toBeUndefined();

    await user.type(editor, 'The vault answers');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(lastCall('update_chapter_note')).toEqual({
      id: 'note-1',
      text: 'The vault answers',
      user: 'You',
    });

    expect(await screen.findByText('The vault answers')).toBeInTheDocument();
    expect(screen.queryByText('Rook owes the vault')).not.toBeInTheDocument();
  });

  it('moves a note to the trash and takes it off the chapter', async () => {
    seedNotes({ id: 'note-1', chapter: 'n1', text: 'Rook owes the vault' });
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Notes for One' }));
    await user.click(
      screen.getByRole('button', { name: 'Delete the note Rook owes the vault' })
    );

    expect(lastCall('delete_node')).toEqual({ id: 'note-1', user: 'You' });
    expect(screen.queryByText('Rook owes the vault')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notes for One' })).toHaveTextContent('Notes');
    expect(screen.getByText(/No notes yet/)).toBeInTheDocument();
  });
});

describe('chapter continuity', () => {
  it('names the chapters that have no POV', async () => {
    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });

    expect(
      within(panel).getByText('3 chapters have no POV: One, Two, Three.')
    ).toBeInTheDocument();
    // The flags are advisory, and the panel says so rather than blocking a save.
    expect(within(panel).getByText(/1 to check · advisory/)).toBeInTheDocument();
  });

  it('flags a day that goes backwards in reading order', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_day = 5;
    rows[2].chapter_pov = 'c2';
    rows[2].chapter_day = 2;
    rows[3].chapter_pov = 'c1';
    rows[3].chapter_day = 3;

    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });

    expect(
      within(panel).getByText('“Two” goes back to Day 2 after “One” on Day 5.')
    ).toBeInTheDocument();
  });

  it('flags one cast member looking after two chapters on the same day', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_day = 3;
    rows[2].chapter_pov = 'c2';
    rows[2].chapter_day = 3;
    rows[3].chapter_pov = 'c1';
    rows[3].chapter_day = 3;

    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });

    expect(
      within(panel).getByText('Rook is the POV of 2 chapters on Day 3: One, Three.')
    ).toBeInTheDocument();
  });

  it('says nothing when the chapters agree', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_day = 1;
    rows[2].chapter_pov = 'c2';
    rows[2].chapter_day = 2;
    rows[3].chapter_pov = 'c1';
    rows[3].chapter_day = 3;

    await openChapters();

    expect(screen.queryByRole('region', { name: 'Continuity' })).not.toBeInTheDocument();
  });
});
