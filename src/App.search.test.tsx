import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock, flowMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  flowMock: { setCenter: vi.fn(), getZoom: vi.fn(() => 1) },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// React Flow needs real DOM measurements, so the canvas draws each node through
// the card the app registers, inside the wrapper whose class carries the search
// highlights. The fake instance records the pan the search asks for.
vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  interface CanvasProps {
    nodes?: { id: string; data: unknown; className?: string }[];
    nodeTypes?: Record<string, React.ComponentType<Record<string, unknown>>>;
    children?: unknown;
    onInit?: (instance: unknown) => void;
  }

  const Canvas = ({ nodes = [], nodeTypes = {}, children, onInit }: CanvasProps) => {
    const Card = nodeTypes.default;

    React.useEffect(() => {
      onInit?.(flowMock);
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

const rows = [
  {
    id: 'n1',
    story_id: story.id,
    node_type: 'chapter',
    label: 'Opening',
    content: 'Rook arrives at the vault.',
    pos_x: 0,
    pos_y: 0,
    created_by: 'Ada',
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
    character_id: null,
  },
  {
    id: 'n2',
    story_id: story.id,
    node_type: 'character',
    label: 'Rook',
    content: null,
    pos_x: 400,
    pos_y: 300,
    created_by: 'Ada',
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
    character_id: 'char-1',
  },
  {
    id: 'n3',
    story_id: story.id,
    node_type: 'location',
    label: 'Vault',
    content: 'Where the wardens keep the ledgers.',
    pos_x: 0,
    pos_y: 200,
    created_by: 'Ada',
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
    character_id: null,
  },
];

const cast = [
  {
    id: 'char-1',
    story_id: story.id,
    name: 'Rook',
    description: null,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
];

const otherStory = {
  id: 'story-2',
  title: 'Ashes',
  description: 'A second book.',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

// A board in a story that is not open. The palette reads it when it opens, so a
// card here is reachable without visiting that story first.
const otherRows = [
  {
    id: 'n21',
    story_id: otherStory.id,
    node_type: 'chapter',
    label: 'Cinder Keep',
    content: 'Wren wakes in the ash.',
    pos_x: 100,
    pos_y: 100,
    created_by: 'Ada',
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
    character_id: null,
  },
];

const otherCast = [
  {
    id: 'char-2',
    story_id: otherStory.id,
    name: 'Wren',
    description: 'A smith.',
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  },
];

// A connection to search for. Most tests have none, so the counts they check
// stay about cards only.
const connection = {
  id: 'e1',
  story_id: story.id,
  source_id: 'n2',
  target_id: 'n3',
  label: 'guards',
  relation_type: 'protects',
  created_by: 'Ada',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

// A chapter note. It is found by words that appear nowhere else, so a test can
// be sure which result it clicked.
const chapterNote = {
  id: 'note-1',
  story_id: story.id,
  node_type: 'note',
  label: 'Rook owes the vault.',
  content: 'Rook owes the vault.\nThe warder knows it.',
  pos_x: 0,
  pos_y: 0,
  created_by: 'Ada',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  character_id: null,
  parent_node_id: 'n1',
};

// A note in the story that is not open, hanging off its chapter card.
const otherNote = {
  ...chapterNote,
  id: 'note-21',
  story_id: otherStory.id,
  label: 'Wren hides the ledger.',
  content: 'Wren hides the ledger.',
  parent_node_id: 'n21',
};

let edges: unknown[] = [];
let notes: unknown[] = [];
let otherNotes: unknown[] = [];

beforeEach(() => {
  edges = [];
  notes = [];
  otherNotes = [];
  flowMock.setCenter.mockReset();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: { storyId?: string }) => {
    const otherBoard = args?.storyId === otherStory.id;

    switch (command) {
      case 'get_all_stories':
        return [story, otherStory];
      case 'get_graph_nodes':
        return otherBoard ? otherRows : rows;
      case 'get_graph_edges':
        return otherBoard ? [] : edges;
      case 'get_story_character_stats':
      case 'get_character_stats':
      case 'get_character_attributes':
        return [];
      case 'get_characters':
        return otherBoard ? otherCast : cast;
      case 'get_chapter_notes':
        return otherBoard ? otherNotes : notes;
      default:
        return null;
    }
  });
});

async function openCanvas() {
  const { container } = render(<App />);

  await screen.findAllByText('Ledger');
  await screen.findByText('Opening');

  return { container };
}

function searchDialog() {
  return screen.getByRole('dialog', { name: 'Search the storyboard' });
}

function hitIds(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.react-flow__node.search-hit')).map(
    node => node.getAttribute('data-id')
  );
}

// The result rows of one kind, so a test names what it clicks instead of relying
// on an index that moves as the fixtures change.
function resultButtons(kind: string) {
  return Array.from(
    searchDialog().querySelectorAll<HTMLElement>('.canvas-search-result')
  ).filter(entry =>
    kind === 'node'
      ? entry.querySelector('.legend')
      : entry.querySelector(`.canvas-search-kind.${kind}`)
  );
}

describe('the canvas search', () => {
  it('opens with Ctrl+F and outlines every match as the query is typed', async () => {
    const user = userEvent.setup();
    const { container } = await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

    const input = await screen.findByLabelText('Search everything');
    expect(input).toHaveFocus();

    await user.type(input, 'vault');

    // One match by label, one by the word in its notes.
    await waitFor(() => expect(hitIds(container)).toEqual(['n1', 'n3']));

    const results = searchDialog();
    expect(within(results).getByText('Opening')).toBeInTheDocument();
    expect(within(results).getByText('Vault')).toBeInTheDocument();
    expect(within(results).getByText(/2 matches/)).toBeInTheDocument();
  });

  it('goes to the match on Enter, opening it and panning the canvas', async () => {
    const user = userEvent.setup();
    const { container } = await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'vault');

    // Both cards mention the vault, but only one is named after it, so the card
    // whose name matched is listed first and takes the Enter key.
    await waitFor(() => expect(hitIds(container)).toEqual(['n1', 'n3']));
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(flowMock.setCenter).toHaveBeenCalledWith(70, 220, { zoom: 1, duration: 300 })
    );

    expect(screen.queryByRole('dialog', { name: 'Search the storyboard' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('complementary', { name: 'Node inspector' })).getByLabelText(
        'Label'
      )
    ).toHaveValue('Vault');
  });

  it('walks the matches with the arrow keys before choosing one', async () => {
    const user = userEvent.setup();
    await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    const input = await screen.findByLabelText('Search everything');
    await user.type(input, 'vault');
    await user.keyboard('{ArrowDown}{Enter}');

    // One step past the name match is the chapter that mentions the vault.
    await waitFor(() =>
      expect(flowMock.setCenter).toHaveBeenCalledWith(70, 20, { zoom: 1, duration: 300 })
    );

    expect(
      within(screen.getByRole('complementary', { name: 'Node inspector' })).getByLabelText(
        'Label'
      )
    ).toHaveValue('Opening');
  });

  it('lists name matches before results found only in their notes', async () => {
    notes = [chapterNote];
    const user = userEvent.setup();
    await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'vault');

    // The card named Vault and the note whose first line names it come first;
    // the chapter that only mentions the word in its notes comes last.
    const labels = Array.from(
      searchDialog().querySelectorAll('.canvas-search-label')
    ).map(entry => entry.textContent);

    expect(labels).toEqual(['Vault', 'Rook owes the vault.', 'Opening']);
  });

  it('finds a node by whose cast member it is', async () => {
    const user = userEvent.setup();
    const { container } = await openCanvas();

    // Only the node labelled "Rook" is linked to her; searching the cast name
    // reaches it, and nothing else here is called Rook.
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'rook');

    await waitFor(() => expect(hitIds(container)).toEqual(['n1', 'n2']));
  });

  it('says when nothing matches', async () => {
    const user = userEvent.setup();
    const { container } = await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'zeppelin');

    expect(screen.getByText('Nothing matches “zeppelin”.')).toBeInTheDocument();
    expect(screen.getByText('0 matches', { exact: false })).toBeInTheDocument();
    expect(hitIds(container)).toEqual([]);
  });

  it('closes on Escape and starts empty next time', async () => {
    const user = userEvent.setup();
    const { container } = await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    const input = await screen.findByLabelText('Search everything');
    await user.type(input, 'vault');
    await waitFor(() => expect(hitIds(container)).toHaveLength(2));

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Search the storyboard' })).not.toBeInTheDocument();
    expect(hitIds(container)).toEqual([]);

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(await screen.findByLabelText('Search everything')).toHaveValue('');
  });

  it('explains the controls before they are used', async () => {
    const user = userEvent.setup();
    await openCanvas();

    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute(
      'title',
      expect.stringContaining('Ctrl+F')
    );
    expect(screen.getByRole('button', { name: 'Add Node' })).toHaveAttribute(
      'title',
      'Add a node of the selected type to the canvas'
    );
    expect(screen.getByRole('button', { name: 'Graph' })).toHaveAttribute(
      'title',
      expect.stringContaining('idea graph')
    );
    expect(screen.getByTitle('Label for the new node')).toBeInTheDocument();
    expect(screen.getByTitle('The kind of node the Add button creates')).toBeInTheDocument();

    // The help is not only on the canvas: the other tabs explain their controls too.
    await user.click(screen.getByRole('button', { name: 'Characters' }));
    expect(await screen.findByRole('button', { name: 'Add character' })).toHaveAttribute(
      'title',
      expect.stringContaining('cast')
    );
  });

  it('opens a cast member on their sheet rather than on the canvas', async () => {
    const user = userEvent.setup();
    await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'rook');

    const [castResult] = resultButtons('cast');
    expect(castResult).toHaveTextContent('Rook');

    await user.click(castResult);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Characters' })).toHaveClass('active')
    );
    expect(document.querySelector('[data-character-id="char-1"]')).toHaveClass('active');
    expect(screen.getByRole('heading', { name: 'Rook' })).toBeInTheDocument();
  });

  it('finds a connection by either end and opens its editor at its middle', async () => {
    const user = userEvent.setup();
    edges = [connection];
    await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'protects');

    // Found by the relation, which is not the label, and shown with both ends.
    const [linkResult] = resultButtons('link');
    expect(linkResult).toHaveTextContent('guards');
    expect(linkResult).toHaveTextContent('Rook → Vault');

    await user.click(linkResult);

    expect(screen.getByText('Edit connection')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Label (optional)')).toHaveValue('guards');
    expect(screen.getByPlaceholderText('Relation type (optional)')).toHaveValue('protects');
    expect(flowMock.setCenter).toHaveBeenCalledWith(200, 250, { zoom: 1, duration: 300 });
  });

  it('narrows the list to one kind and outlines only what it lists', async () => {
    const user = userEvent.setup();
    const { container } = await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'rook');

    // The two cards that mention her, plus her cast entry.
    await waitFor(() =>
      expect(screen.getByText('3 matches', { exact: false })).toBeInTheDocument()
    );
    expect(hitIds(container)).toEqual(['n1', 'n2']);

    await user.click(within(searchDialog()).getByRole('button', { name: 'Cast' }));

    expect(within(searchDialog()).getByRole('button', { name: 'Cast' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByText('1 match', { exact: false })).toBeInTheDocument();
    expect(resultButtons('cast')).toHaveLength(1);
    expect(within(searchDialog()).queryByText('Opening')).not.toBeInTheDocument();

    // Nothing outlined while the list shows only the cast.
    expect(hitIds(container)).toEqual([]);
  });

  it('finds a card in another story and opens that story on it', async () => {
    const user = userEvent.setup();
    await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'cinder');

    const [otherResult] = await waitFor(
      () => {
        const found = resultButtons('node');
        expect(found[0]).toHaveTextContent('Ashes');
        return found;
      },
      { timeout: 2000 }
    );

    await user.click(otherResult);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('get_graph_nodes', { storyId: 'story-2' })
    );
    expect(await screen.findByText('Cinder Keep')).toBeInTheDocument();
    expect(
      within(screen.getByRole('complementary', { name: 'Node inspector' })).getByLabelText('Label')
    ).toHaveValue('Cinder Keep');
    expect(flowMock.setCenter).toHaveBeenCalledWith(170, 120, { zoom: 1, duration: 300 });
  });

  it('opens a story from its title', async () => {
    const user = userEvent.setup();
    await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'ashes');

    const [storyResult] = await waitFor(
      () => {
        const found = resultButtons('story');
        expect(found[0]).toHaveTextContent('Ashes');
        return found;
      },
      { timeout: 2000 }
    );

    await user.click(storyResult);

    expect(await screen.findByText('Cinder Keep')).toBeInTheDocument();
    expect(document.querySelector('.story-item.active')).toHaveTextContent('Ashes');
  });

  it('opens from the Chapters tab and finds a note there', async () => {
    notes = [chapterNote];
    const user = userEvent.setup();
    await openCanvas();

    await user.click(screen.getByRole('button', { name: 'Chapters' }));
    await screen.findByRole('heading', { name: 'Reading order' });

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

    const input = await screen.findByLabelText('Search everything');
    expect(input).toHaveFocus();

    await user.type(input, 'owes');
    await user.click(resultButtons('note')[0]);

    // The panel opens where it already is, so no tab has to change underfoot.
    expect(screen.getByRole('button', { name: 'Chapters' })).toHaveClass('active');
    expect(document.querySelector('.chapter-notes')).toHaveTextContent(
      'The warder knows it.'
    );
  });

  it('opens a card from the Chapters tab and still centres the board on it', async () => {
    const user = userEvent.setup();
    await openCanvas();

    await user.click(screen.getByRole('button', { name: 'Chapters' }));
    await screen.findByRole('heading', { name: 'Reading order' });

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'vault');

    const locationResult = resultButtons('node').find(button =>
      button.textContent?.includes('Vault')
    );
    expect(locationResult).toBeDefined();
    await user.click(locationResult as HTMLElement);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Graph' })).toHaveClass('active')
    );

    // The pan was parked while the board was off screen, and applied on mount.
    expect(flowMock.setCenter).toHaveBeenCalledWith(70, 220, { zoom: 1, duration: 300 });
    expect(
      within(screen.getByRole('complementary', { name: 'Node inspector' })).getByLabelText(
        'Label'
      )
    ).toHaveValue('Vault');
  });

  it('offers a Search button on the Chapters tab', async () => {
    const user = userEvent.setup();
    await openCanvas();

    await user.click(screen.getByRole('button', { name: 'Chapters' }));
    await user.click(await screen.findByRole('button', { name: 'Search' }));

    expect(screen.getByRole('dialog', { name: 'Search the storyboard' })).toBeInTheDocument();
  });

  it('leaves Ctrl+F to the browser on tabs without the palette', async () => {
    const user = userEvent.setup();
    await openCanvas();

    await user.click(screen.getByRole('button', { name: 'Characters' }));
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

    expect(
      screen.queryByRole('dialog', { name: 'Search the storyboard' })
    ).not.toBeInTheDocument();
  });

  it('finds a chapter note and opens it under its chapter', async () => {
    notes = [chapterNote];
    const user = userEvent.setup();
    await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'owes');

    // The words are only in the note, and the result names the chapter it is in.
    const [noteResult] = resultButtons('note');
    expect(noteResult).toHaveTextContent('Rook owes the vault.');
    expect(noteResult).toHaveTextContent('Opening');

    await user.click(noteResult);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Chapters' })).toHaveClass('active')
    );

    // The chapter's panel opens on the note, and the note is marked so it is not
    // hunted for in a list of them.
    const panel = document.querySelector('.chapter-notes');
    expect(panel).toHaveTextContent('The warder knows it.');
    expect(document.querySelector('.chapter-note.matched')).not.toBeNull();
  });

  it('narrows the palette to notes only', async () => {
    notes = [chapterNote];
    const user = userEvent.setup();
    await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'vault');

    await waitFor(() => expect(resultButtons('note')).toHaveLength(1));
    expect(resultButtons('node').length).toBeGreaterThan(0);

    await user.click(within(searchDialog()).getByRole('button', { name: 'Notes' }));

    expect(screen.getByText('1 match', { exact: false })).toBeInTheDocument();
    expect(resultButtons('note')).toHaveLength(1);
    expect(resultButtons('node')).toHaveLength(0);
  });

  it('finds a note in another story and opens that story on its chapter', async () => {
    otherNotes = [otherNote];
    const user = userEvent.setup();
    await openCanvas();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await user.type(await screen.findByLabelText('Search everything'), 'hides');

    const [noteResult] = await waitFor(
      () => {
        const found = resultButtons('note');
        expect(found[0]).toHaveTextContent('Ashes');
        return found;
      },
      { timeout: 2000 }
    );

    await user.click(noteResult);

    // Scoped to the list: the chapter is also named by a continuity flag here.
    expect(
      within(await screen.findByRole('list', { name: 'Chapters' })).getByText('Cinder Keep')
    ).toBeInTheDocument();
    expect(document.querySelector('.story-item.active')).toHaveTextContent('Ashes');

    const panel = document.querySelector('.chapter-notes');
    expect(panel).toHaveTextContent('Wren hides the ledger.');
  });
});
