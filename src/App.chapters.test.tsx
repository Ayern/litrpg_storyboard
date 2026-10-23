import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock, flowMock, windowMock } = vi.hoisted(() => {
  type CloseHandler = (event: { preventDefault: () => void }) => void;

  const closeHandlers: CloseHandler[] = [];

  return {
    invokeMock: vi.fn(),
    flowMock: { setCenter: vi.fn(), getZoom: vi.fn(() => 1) },
    windowMock: {
      closeHandlers,
      destroy: vi.fn(async () => {}),
      onCloseRequested: vi.fn(async (handler: CloseHandler) => {
        closeHandlers.push(handler);

        return () => {
          const index = closeHandlers.indexOf(handler);
          if (index >= 0) closeHandlers.splice(index, 1);
        };
      }),
    },
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: windowMock.onCloseRequested,
    destroy: windowMock.destroy,
  }),
}));

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
  chapter_time: string | null;
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
    chapter_time: null,
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

const otherStory = {
  id: 'story-2',
  title: 'Ashes',
  description: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

// A second, empty story, so the sidebar has somewhere else to go.
function withOtherStory() {
  const fallback = invokeMock.getMockImplementation();

  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    if (command === 'get_all_stories') return [story, otherStory];
    if (command === 'get_graph_nodes' && args.storyId === otherStory.id) return [];
    if (command === 'get_graph_edges' && args.storyId === otherStory.id) return [];
    if (command === 'get_characters' && args.storyId === otherStory.id) return [];
    if (command === 'get_story_character_stats' && args.storyId === otherStory.id) return [];
    if (command === 'get_chapter_notes' && args.storyId === otherStory.id) return [];
    return fallback?.(command, rawArgs);
  });
}

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
  windowMock.closeHandlers.length = 0;
  windowMock.destroy.mockClear();

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
        row.chapter_time = args.time ?? null;
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

// Only the desktop build has a window to close, so the quit guard is installed
// when the Tauri bridge is there.
function asDesktopWindow() {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
}

async function requestWindowClose() {
  await waitFor(() => expect(windowMock.closeHandlers.length).toBeGreaterThan(0));

  const event = { preventDefault: vi.fn() };

  act(() => {
    windowMock.closeHandlers.forEach(handler => handler(event));
  });

  return event;
}

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

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
      time: null,
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
      time: null,
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
      time: null,
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

  it('asks before Escape drops an edit, and leaves the chapter alone when discarded', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit Two details' }));
    await user.type(screen.getByLabelText('Words'), '99');
    await user.keyboard('{Escape}');

    // Escape no longer throws the edit away on its own.
    const prompt = screen.getByRole('alertdialog', { name: 'Unsaved chapter changes' });
    expect(
      within(prompt).getByText('Close this chapter and drop these changes?')
    ).toBeInTheDocument();

    await user.click(within(prompt).getByRole('button', { name: 'Discard changes' }));

    expect(screen.queryByLabelText('Words')).not.toBeInTheDocument();
    expect(within(rowsInList()[1]).getByText('800 / 2,000 words')).toBeInTheDocument();
    expect(lastCall('set_chapter_details')).toBeUndefined();
  });

  it('asks before leaving the Chapters tab with an edit open', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));
    await user.type(screen.getByLabelText('Arc'), ' and more');

    await user.click(screen.getByRole('button', { name: 'Graph' }));

    const prompt = screen.getByRole('alertdialog', { name: 'Unsaved chapter changes' });
    expect(
      within(prompt).getByText('Leave Chapters and drop these changes?')
    ).toBeInTheDocument();
    // The tab has not moved while the question is open.
    expect(screen.getByRole('list', { name: 'Chapters' })).toBeInTheDocument();

    await user.click(within(prompt).getByRole('button', { name: 'Discard and continue' }));

    expect(screen.queryByRole('list', { name: 'Chapters' })).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas')).toBeInTheDocument();
  });

  it('asks before switching stories with an edit open', async () => {
    withOtherStory();
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));
    await user.type(screen.getByLabelText('Arc'), ' and more');

    await user.click(screen.getByText('Ashes', { selector: '.story-title' }));

    const prompt = screen.getByRole('alertdialog', { name: 'Unsaved chapter changes' });
    expect(
      within(prompt).getByText('Open “Ashes” and drop these changes?')
    ).toBeInTheDocument();
    expect(document.querySelector('.story-item.active')).toHaveTextContent('Ledger');

    await user.click(within(prompt).getByRole('button', { name: 'Discard and continue' }));

    await waitFor(() =>
      expect(document.querySelector('.story-item.active')).toHaveTextContent('Ashes')
    );
    expect(screen.queryByLabelText('Arc')).not.toBeInTheDocument();
  });

  it('asks before Cancel drops an edit, and can stay in the form', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit Two details' }));
    await user.type(screen.getByLabelText('Words'), '99');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    const prompt = screen.getByRole('alertdialog', { name: 'Unsaved chapter changes' });
    // The safe answer is focused, so a stray Enter keeps the edit.
    expect(within(prompt).getByRole('button', { name: 'Keep editing' })).toHaveFocus();

    await user.click(within(prompt).getByRole('button', { name: 'Keep editing' }));

    expect(
      screen.queryByRole('alertdialog', { name: 'Unsaved chapter changes' })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Words')).toHaveValue(80099);
    // And answering gives the keyboard back to the form.
    expect(screen.getByLabelText('Arc')).toHaveFocus();

    // A second Cancel asks again, and Escape dismisses that question without
    // touching the form.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');

    expect(
      screen.queryByRole('alertdialog', { name: 'Unsaved chapter changes' })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Words')).toHaveValue(80099);
    expect(screen.getByLabelText('Arc')).toHaveFocus();

    // A third Cancel asks once more; this time the edit is dropped.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(
      within(
        screen.getByRole('alertdialog', { name: 'Unsaved chapter changes' })
      ).getByRole('button', { name: 'Discard changes' })
    );

    expect(screen.queryByLabelText('Words')).not.toBeInTheDocument();
    expect(within(rowsInList()[1]).getByText('800 / 2,000 words')).toBeInTheDocument();
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

  // Saving closes the form, so nothing is left to lose. Clicking another tab must
  // go there, rather than raise a question that has no form to show it in.
  it('leaves the tabs free once a day is saved', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));
    await user.type(screen.getByLabelText('Day'), '3');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByLabelText('Day')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Graph' }));

    expect(screen.queryByRole('list', { name: 'Chapters' })).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas')).toBeInTheDocument();
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

  it('orders the chapters that share a day by their time of day', async () => {
    rows[0].chapter_day = 4; // One, chapter 1
    rows[0].chapter_time = 'Evening';
    rows[2].chapter_day = 4; // Two, chapter 2
    rows[2].chapter_time = '7:30 am';
    rows[3].chapter_day = 4; // Three, chapter 3
    rows[3].chapter_time = 'after the fire';

    await openChapters();

    const timeline = screen.getByRole('list', { name: 'Chapter timeline' });
    const placed = within(timeline).getAllByRole('listitem');

    // 7:30am comes before Evening, and the label no clock can read keeps its
    // place in reading order rather than being guessed at.
    expect(placed.map(row => within(row).getByText(/^(One|Two|Three)$/).textContent)).toEqual([
      'Two',
      'One',
      'Three',
    ]);
  });

  it('puts a label the clock cannot read after the ones it can inside the day', async () => {
    rows[0].chapter_day = 4; // One, chapter 1
    rows[0].chapter_time = 'after the fire';
    rows[2].chapter_day = 4; // Two, chapter 2
    rows[2].chapter_time = '7:30 am';

    await openChapters();

    const timeline = screen.getByRole('list', { name: 'Chapter timeline' });
    const placed = within(timeline).getAllByRole('listitem');

    // An unreadable label has no place in the day, so it waits behind the one
    // that does rather than holding its position and splitting the day.
    expect(placed.map(row => within(row).getByText(/^(One|Two|Three)$/).textContent)).toEqual([
      'Two',
      'One',
    ]);
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

  it('saves a time of day as the author typed it', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));
    await user.type(screen.getByLabelText('Time'), '  Dusk, after the fire ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(lastCall('set_chapter_details')).toEqual({
      nodeId: 'n1',
      arc: 'The Vault',
      words: 1200,
      target: 2000,
      pov: null,
      day: null,
      time: 'Dusk, after the fire',
      user: 'You',
    });

    await waitFor(() => {
      const [one] = rowsInList();
      expect(within(one).getByText('Dusk, after the fire')).toBeInTheDocument();
    });
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

  it('asks before closing the panel with an unsaved note edit', async () => {
    seedNotes({ id: 'note-1', chapter: 'n1', text: 'Rook owes the vault' });
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Notes for One' }));
    await user.click(
      screen.getByRole('button', { name: 'Edit the note Rook owes the vault' })
    );

    const editor = screen.getByLabelText('Edit note in One');
    await user.clear(editor);
    await user.type(editor, 'The vault answers');

    await user.click(screen.getByRole('button', { name: 'Notes for One' }));

    const prompt = screen.getByRole('alertdialog', { name: 'Unsaved note changes' });
    expect(
      within(prompt).getByText('Discard your changes to this note?')
    ).toBeInTheDocument();
    expect(within(prompt).getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    expect(screen.getByLabelText('Edit note in One')).toHaveValue('The vault answers');

    await user.click(within(prompt).getByRole('button', { name: 'Keep editing' }));

    expect(screen.getByLabelText('Edit note in One')).toHaveValue('The vault answers');
    expect(lastCall('update_chapter_note')).toBeUndefined();

    // Closing again and answering takes the panel away without writing.
    await user.click(screen.getByRole('button', { name: 'Notes for One' }));
    await user.click(
      within(
        screen.getByRole('alertdialog', { name: 'Unsaved note changes' })
      ).getByRole('button', { name: 'Discard and continue' })
    );

    expect(screen.queryByLabelText('Edit note in One')).not.toBeInTheDocument();
    expect(screen.queryByText('Rook owes the vault')).not.toBeInTheDocument();
    expect(lastCall('update_chapter_note')).toBeUndefined();
  });

  it('asks before moving a half-typed note to another chapter', async () => {
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Notes for One' }));
    await user.type(screen.getByLabelText('New note for One'), 'Rook owls');

    await user.click(screen.getByRole('button', { name: 'Notes for Two' }));

    const prompt = screen.getByRole('alertdialog', { name: 'Unsaved note changes' });
    expect(within(prompt).getByText('Discard this new note?')).toBeInTheDocument();
    expect(screen.getByLabelText('New note for One')).toHaveValue('Rook owls');

    await user.click(within(prompt).getByRole('button', { name: 'Discard and continue' }));

    expect(screen.queryByLabelText('New note for One')).not.toBeInTheDocument();
    expect(screen.getByLabelText('New note for Two')).toHaveValue('');
    expect(lastCall('add_chapter_note')).toBeUndefined();
  });

  it('asks before switching stories with a half-typed note', async () => {
    withOtherStory();
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Notes for One' }));
    await user.type(screen.getByLabelText('New note for One'), 'Rook owls');

    await user.click(screen.getByText('Ashes', { selector: '.story-title' }));

    const prompt = screen.getByRole('alertdialog', { name: 'Unsaved note changes' });
    expect(
      within(prompt).getByText('Open “Ashes” and drop these changes?')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('New note for One')).toHaveValue('Rook owls');
    expect(document.querySelector('.story-item.active')).toHaveTextContent('Ledger');

    await user.click(within(prompt).getByRole('button', { name: 'Discard and continue' }));

    await waitFor(() =>
      expect(document.querySelector('.story-item.active')).toHaveTextContent('Ashes')
    );
    expect(screen.queryByLabelText('New note for One')).not.toBeInTheDocument();
    expect(lastCall('add_chapter_note')).toBeUndefined();
  });

  it('asks before Cancel or Escape drops an edited note', async () => {
    seedNotes({ id: 'note-1', chapter: 'n1', text: 'Rook owes the vault' });
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Notes for One' }));
    await user.click(
      screen.getByRole('button', { name: 'Edit the note Rook owes the vault' })
    );

    const editor = screen.getByLabelText('Edit note in One');
    await user.clear(editor);
    await user.type(editor, 'The vault answers');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    const prompt = screen.getByRole('alertdialog', { name: 'Unsaved note changes' });
    expect(
      within(prompt).getByText('Discard your changes to this note?')
    ).toBeInTheDocument();

    await user.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Edit note in One')).toHaveValue('The vault answers');

    // Escape asks the question, and a second Escape is the answer: it dismisses
    // the question and leaves the editor exactly as it was.
    await user.click(screen.getByLabelText('Edit note in One'));
    await user.keyboard('{Escape}');
    expect(
      screen.getByRole('alertdialog', { name: 'Unsaved note changes' })
    ).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(
      screen.queryByRole('alertdialog', { name: 'Unsaved note changes' })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Edit note in One')).toHaveFocus();
    expect(screen.getByLabelText('Edit note in One')).toHaveValue('The vault answers');

    // Escape again asks once more, and Discard closes the editor without writing.
    await user.keyboard('{Escape}');
    await user.click(
      within(
        screen.getByRole('alertdialog', { name: 'Unsaved note changes' })
      ).getByRole('button', { name: 'Discard and continue' })
    );

    expect(screen.queryByLabelText('Edit note in One')).not.toBeInTheDocument();
    expect(screen.getByText('Rook owes the vault')).toBeInTheDocument();
    expect(lastCall('update_chapter_note')).toBeUndefined();

    // An untouched editor closes on Escape without asking.
    await user.click(
      screen.getByRole('button', { name: 'Edit the note Rook owes the vault' })
    );
    await user.keyboard('{Escape}');

    expect(screen.queryByLabelText('Edit note in One')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('alertdialog', { name: 'Unsaved note changes' })
    ).not.toBeInTheDocument();
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
  // A flag's words, whichever elements carry them, so an assertion does not
  // depend on which chapter names happen to be links.
  function flags(panel: HTMLElement) {
    return [...panel.querySelectorAll('li')].map(item => item.textContent);
  }

  it('names the chapters that have no POV', async () => {
    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });

    expect(flags(panel)).toContain('3 chapters have no POV: One, Two, Three.');
    // Every name in the sentence is a way to the chapter it names.
    expect(within(panel).getByRole('button', { name: 'One' })).toBeInTheDocument();
    // The flags are advisory, and the panel says so rather than blocking a save.
    expect(within(panel).getByText(/1 to check · advisory/)).toBeInTheDocument();
  });

  it('flags a time label with no day to place it on', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_day = 1;
    rows[2].chapter_pov = 'c2';
    rows[3].chapter_pov = 'c1';
    rows[3].chapter_time = 'Dusk';

    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });

    expect(flags(panel)).toContain('1 chapter has a time but no day: Three.');
    expect(within(panel).getByText(/1 to check · advisory/)).toBeInTheDocument();
  });

  it('groups the chapters that name a time but no day', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_time = 'Dusk';
    rows[2].chapter_pov = 'c2';
    rows[2].chapter_time = 'after the fire';
    rows[3].chapter_pov = 'c1';
    rows[3].chapter_day = 2;
    rows[3].chapter_time = 'Noon';

    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });

    // A label that reads as no time still names a time: the missing day is the
    // problem, and the chapter placed on a day is left alone.
    expect(flags(panel)).toContain('2 chapters have a time but no day: One, Two.');
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

    expect(flags(panel)).toContain('“Two” goes back to Day 2 after “One” on Day 5.');
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

    expect(flags(panel)).toContain('Rook is the POV of 2 chapters on Day 3: One, Three.');
  });

  it('flags a time that goes backwards inside one day', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_day = 4;
    rows[0].chapter_time = 'Dusk';
    rows[2].chapter_pov = 'c2';
    rows[2].chapter_day = 4;
    rows[2].chapter_time = 'Morning';
    rows[3].chapter_pov = 'c1';
    rows[3].chapter_day = 4;
    rows[3].chapter_time = 'after the fire';

    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });

    expect(flags(panel)).toContain(
      '“Two” goes back to Morning after “One” at Dusk on Day 4.'
    );
    // A label that reads as no time at all is not compared, so Three is silent.
    expect(within(panel).queryByText(/“Three”/)).not.toBeInTheDocument();
  });

  it('flags two chapters written at the same time on the same day', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_day = 3;
    rows[0].chapter_time = 'Dusk';
    rows[2].chapter_pov = 'c2';
    rows[2].chapter_day = 3;
    rows[2].chapter_time = 'dusk';

    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });

    expect(flags(panel)).toContain('“One” and “Two” are both at Dusk on Day 3.');
  });

  it('flags labels the clock reads as the same moment but that are written apart', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_day = 3;
    rows[0].chapter_time = 'Dusk';
    rows[2].chapter_pov = 'c2';
    rows[2].chapter_day = 3;
    rows[2].chapter_time = '19:00';
    rows[3].chapter_pov = 'c1';
    rows[3].chapter_day = 3;
    rows[3].chapter_time = '7:00 pm';

    await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });

    expect(flags(panel)).toContain(
      '“One” at Dusk, “Two” at 19:00 and “Three” at 7:00 pm happen at the same moment on Day 3.'
    );
  });

  it('opens the chapter a flag names, and brings its row into view', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_day = 4;
    rows[0].chapter_time = 'Dusk';
    rows[2].chapter_pov = 'c2';
    rows[2].chapter_day = 4;
    rows[2].chapter_time = 'Morning';

    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const user = await openChapters();

    const panel = screen.getByRole('region', { name: 'Continuity' });
    await user.click(within(panel).getByRole('button', { name: '“Two”' }));

    // The chapter's own details open, ready to be corrected where the flag was.
    expect(screen.getByLabelText('Day')).toHaveValue(4);
    expect(screen.getByLabelText('Time')).toHaveValue('Morning');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(document.querySelector('[data-chapter-id="n3"]')).toHaveClass(
      'chapter-row-revealed'
    );

    // The glow is a nudge, not a permanent state.
    await waitFor(
      () =>
        expect(document.querySelector('[data-chapter-id="n3"]')).not.toHaveClass(
          'chapter-row-revealed'
        ),
      { timeout: 2500 }
    );
  });

  it('asks before dropping an unsaved edit for the chapter a flag names', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_day = 4;
    rows[0].chapter_time = 'Dusk';
    rows[2].chapter_pov = 'c2';
    rows[2].chapter_day = 4;
    rows[2].chapter_time = 'Morning';

    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));
    const day = within(rowsInList()[0]).getByLabelText('Day');
    await user.clear(day);
    await user.type(day, '9');

    const panel = screen.getByRole('region', { name: 'Continuity' });
    await user.click(within(panel).getByRole('button', { name: '“Two”' }));

    // Nothing switched yet: the open form keeps the unsaved day, and the
    // question is asked in the row where the edits are.
    const prompt = screen.getByRole('alertdialog', { name: 'Unsaved chapter changes' });
    expect(
      within(prompt).getByText('Open “Two” and drop these changes?')
    ).toBeInTheDocument();
    expect(within(rowsInList()[0]).getByLabelText('Day')).toHaveValue(9);
    expect(within(rowsInList()[1]).queryByLabelText('Day')).not.toBeInTheDocument();

    await user.click(within(prompt).getByRole('button', { name: 'Keep editing' }));

    expect(
      screen.queryByRole('alertdialog', { name: 'Unsaved chapter changes' })
    ).not.toBeInTheDocument();
    expect(within(rowsInList()[0]).getByLabelText('Day')).toHaveValue(9);

    // Asking again and answering opens the chapter, with its own values.
    await user.click(within(panel).getByRole('button', { name: '“Two”' }));
    await user.click(
      within(screen.getByRole('alertdialog', { name: 'Unsaved chapter changes' })).getByRole(
        'button',
        { name: 'Discard and open' }
      )
    );

    expect(within(rowsInList()[1]).getByLabelText('Day')).toHaveValue(4);
    expect(within(rowsInList()[1]).getByLabelText('Time')).toHaveValue('Morning');
    expect(within(rowsInList()[0]).queryByLabelText('Day')).not.toBeInTheDocument();
  });

  it('says nothing when the chapters agree', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_day = 1;
    rows[2].chapter_pov = 'c2';
    rows[2].chapter_day = 2;
    rows[3].chapter_pov = 'c1';
    rows[3].chapter_day = 3;
    // Whitespace is no time at all, so it does not ask for a day.
    rows[0].chapter_time = '   ';

    await openChapters();

    expect(screen.queryByRole('region', { name: 'Continuity' })).not.toBeInTheDocument();
  });

  it('leaves a shared time alone across days, and a label no clock can read', async () => {
    withCast();
    rows[0].chapter_pov = 'c1';
    rows[0].chapter_day = 3;
    rows[0].chapter_time = 'Dusk';
    rows[2].chapter_pov = 'c2';
    rows[2].chapter_day = 4;
    rows[2].chapter_time = 'Dusk';
    rows[3].chapter_pov = 'c1';
    rows[3].chapter_day = 4;
    rows[3].chapter_time = 'after the fire';

    await openChapters();

    expect(screen.queryByRole('region', { name: 'Continuity' })).not.toBeInTheDocument();
  });
});

describe('quitting the app', () => {
  it('asks before the window closes with an unsaved chapter edit', async () => {
    asDesktopWindow();
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit Two details' }));
    await user.type(screen.getByLabelText('Words'), '99');

    const event = await requestWindowClose();

    expect(event.preventDefault).toHaveBeenCalled();
    const prompt = screen.getByRole('alertdialog', {
      name: 'Unsaved changes before quitting',
    });
    // A stray Enter keeps the work, as in the chapter's own question.
    expect(within(prompt).getByRole('button', { name: 'Keep working' })).toHaveFocus();
    expect(windowMock.destroy).not.toHaveBeenCalled();

    // Escape is the same answer, and the form is where it was.
    await user.keyboard('{Escape}');

    expect(
      screen.queryByRole('alertdialog', { name: 'Unsaved changes before quitting' })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Words')).toHaveValue(80099);
    expect(screen.getByLabelText('Arc')).toHaveFocus();
  });

  it('closes the window without writing when the edit is dropped', async () => {
    asDesktopWindow();
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit Two details' }));
    await user.type(screen.getByLabelText('Words'), '99');

    await requestWindowClose();
    await user.click(screen.getByRole('button', { name: 'Quit without saving' }));

    expect(windowMock.destroy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Quit without saving?')).not.toBeInTheDocument();
    // The question never reaches the database: the form is simply gone with the
    // window, so nothing is written.
    expect(lastCall('set_chapter_details')).toBeUndefined();
  });

  it('asks before the window closes with an unsaved note, and keeps it', async () => {
    asDesktopWindow();
    seedNotes({ id: 'note-1', chapter: 'n1', text: 'Rook owes the vault' });
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Notes for One' }));
    await user.click(
      screen.getByRole('button', { name: 'Edit the note Rook owes the vault' })
    );

    const editor = screen.getByLabelText('Edit note in One');
    await user.clear(editor);
    await user.type(editor, 'The vault answers');

    const event = await requestWindowClose();

    expect(event.preventDefault).toHaveBeenCalled();

    await user.click(
      within(
        screen.getByRole('alertdialog', { name: 'Unsaved changes before quitting' })
      ).getByRole('button', { name: 'Keep working' })
    );

    expect(screen.getByLabelText('Edit note in One')).toHaveValue('The vault answers');
    expect(screen.getByLabelText('Edit note in One')).toHaveFocus();
    expect(windowMock.destroy).not.toHaveBeenCalled();
  });

  it('lets a clean window close without asking', async () => {
    asDesktopWindow();
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit Two details' }));

    const event = await requestWindowClose();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('alertdialog', { name: 'Unsaved changes before quitting' })
    ).not.toBeInTheDocument();
  });

  // A saved form is not a draft, so closing the window after a save must not ask.
  it('lets a window close after the chapter edit was saved', async () => {
    asDesktopWindow();
    const user = await openChapters();

    await user.click(screen.getByRole('button', { name: 'Edit One details' }));
    await user.type(screen.getByLabelText('Day'), '3');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const event = await requestWindowClose();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('alertdialog', { name: 'Unsaved changes before quitting' })
    ).not.toBeInTheDocument();
  });
});
