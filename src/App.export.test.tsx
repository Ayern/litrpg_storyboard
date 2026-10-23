import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock, flowMock, writeTextMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  flowMock: { setCenter: vi.fn(), getZoom: vi.fn(() => 1) },
  writeTextMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: writeTextMock }));

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
        Card
          ? React.createElement(Card, {
              key: node.id,
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

let stories: (typeof story)[] = [];
let markdownPath = '';
let markdownError: string | null = null;
let jsonPath = '';
let bibleMarkdown = '';

beforeEach(() => {
  stories = [story];
  markdownPath = 'C:\\data\\exports\\ledger-story-bible.md';
  markdownError = null;
  jsonPath = 'C:\\data\\exports\\ledger.json';
  bibleMarkdown = '# Ledger\n\n## Chapters\n\n### 1. Opening\n';

  writeTextMock.mockReset();
  writeTextMock.mockImplementation(async () => {});

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    switch (command) {
      case 'get_all_stories':
        return stories;
      case 'get_graph_nodes':
      case 'get_graph_edges':
      case 'get_characters':
      case 'get_story_character_stats':
        return [];
      case 'export_story_markdown':
        if (markdownError) throw markdownError;
        return markdownPath;
      case 'export_story_json':
        return jsonPath;
      case 'story_bible_markdown':
        return bibleMarkdown;
      default:
        return null;
    }
  });
});

async function openApp() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findAllByText('Ledger');
  // The export buttons appear only once a story is the open one.
  await screen.findByRole('button', { name: 'Story bible' });
  return user;
}

describe('the story bible export', () => {
  it('writes a Markdown outline and says where it went', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Story bible' }));

    expect(invokeMock).toHaveBeenCalledWith('export_story_markdown', {
      storyId: 'story-1',
    });
    expect(
      await screen.findByText(/Exported to C:\\data\\exports\\ledger-story-bible\.md/i)
    ).toBeInTheDocument();
  });

  it('keeps the JSON export beside it', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Export JSON' }));

    expect(invokeMock).toHaveBeenCalledWith('export_story_json', {
      storyId: 'story-1',
    });
    expect(await screen.findByText(/Exported to C:\\data\\exports\\ledger\.json/i)).toBeInTheDocument();
  });

  it('explains a failed write and leaves the button usable', async () => {
    const user = await openApp();

    markdownError = 'the exports folder is read-only';
    await user.click(screen.getByRole('button', { name: 'Story bible' }));

    expect(
      await screen.findByText(/Could not write the story bible: the exports folder is read-only/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Story bible' })).toBeEnabled();
  });

  it('copies the same outline to the clipboard without writing a file', async () => {
    const user = await openApp();

    await user.click(screen.getByRole('button', { name: 'Copy bible' }));

    expect(invokeMock).toHaveBeenCalledWith('story_bible_markdown', {
      storyId: 'story-1',
    });
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith(bibleMarkdown));
    expect(await screen.findByText('Story bible copied to the clipboard')).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('export_story_markdown', expect.anything());
  });

  it('says why the clipboard copy failed, and does not claim it worked', async () => {
    const user = await openApp();

    writeTextMock.mockRejectedValueOnce('the clipboard is locked');
    await user.click(screen.getByRole('button', { name: 'Copy bible' }));

    expect(
      await screen.findByText(/Could not copy the story bible: the clipboard is locked/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('Story bible copied to the clipboard')).not.toBeInTheDocument();
  });

  it('offers nothing to export when no story is open', async () => {
    stories = [];
    render(<App />);

    expect(await screen.findByText(/Select or create a story/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Story bible' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export JSON' })).not.toBeInTheDocument();
  });
});
