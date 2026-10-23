import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  const Canvas = (props: any) => {
    const { nodes = [], nodeTypes = {}, children } = props;
    const Card = nodeTypes.default;

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

const restoredStory = {
  id: 'story-0',
  title: 'Restored Ledger',
  description: null,
  created_at: '2026-10-20T12:00:00Z',
  updated_at: '2026-10-20T12:00:00Z',
};

const copies = [
  {
    file_name: 'storyboard-20261023-090000.db',
    created_at: '2026-10-23T09:00:00Z',
    size_bytes: 2048,
  },
  {
    file_name: 'storyboard-20261022-210000.db',
    created_at: '2026-10-22T21:00:00Z',
    size_bytes: 1024,
  },
];

let backups = copies;
let stories = [story];
let listError: string | null = null;
let restoreError: string | null = null;

beforeEach(() => {
  backups = copies;
  stories = [story];
  listError = null;
  restoreError = null;

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
      case 'list_backups':
        if (listError) throw new Error(listError);
        return backups;
      case 'restore_backup':
        if (restoreError) throw new Error(restoreError);
        stories = [restoredStory];
        return null;
      default:
        return null;
    }
  });
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

async function openBackups() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Backups' }));
  await screen.findByRole('dialog', { name: 'Backups' });
  return user;
}

function dialog() {
  return screen.getByRole('dialog', { name: 'Backups' });
}

function copyItems() {
  return within(within(dialog()).getByRole('list', { name: 'Database backups' })).getAllByRole(
    'listitem'
  );
}

describe('the backups dialog', () => {
  it('lists each copy with when it was written, its size and its file name', async () => {
    await openBackups();

    const items = copyItems();
    expect(items).toHaveLength(2);

    expect(items[0]).toHaveTextContent(new Date(copies[0].created_at).toLocaleString());
    expect(items[0]).toHaveTextContent('2.0 KB');
    expect(items[0]).toHaveTextContent('storyboard-20261023-090000.db');
    expect(items[1]).toHaveTextContent('1.0 KB');
  });

  it('asks before replacing anything, and cancelling changes nothing', async () => {
    const user = await openBackups();

    await user.click(within(copyItems()[0]).getByRole('button', { name: 'Restore' }));
    expect(within(copyItems()[0]).getByText('Replace everything with this copy?')).toBeInTheDocument();

    await user.click(within(copyItems()[0]).getByRole('button', { name: 'Cancel' }));

    expect(lastCall('restore_backup')).toBeUndefined();
    expect(within(copyItems()[0]).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('restores the chosen copy and reads the stories from it', async () => {
    const user = await openBackups();

    await user.click(within(copyItems()[0]).getByRole('button', { name: 'Restore' }));
    await user.click(
      within(copyItems()[0]).getByRole('button', { name: 'Restore this copy' })
    );

    await waitFor(() =>
      expect(lastCall('restore_backup')).toEqual({ fileName: copies[0].file_name })
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Backups' })).not.toBeInTheDocument()
    );

    // The stories come from the restored file, not the one that was open.
    expect(await screen.findAllByText('Restored Ledger')).not.toHaveLength(0);
    expect(screen.queryByText('Ledger')).not.toBeInTheDocument();
    expect(screen.getByText(/Restored the copy from/)).toBeInTheDocument();
  });

  it('says why a restore failed and leaves the dialog open', async () => {
    restoreError = 'the file is locked';
    const user = await openBackups();

    await user.click(within(copyItems()[0]).getByRole('button', { name: 'Restore' }));
    await user.click(
      within(copyItems()[0]).getByRole('button', { name: 'Restore this copy' })
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/the file is locked/);
    expect(dialog()).toBeInTheDocument();
    // The old data is untouched.
    expect(screen.getAllByText('Ledger').length).toBeGreaterThan(0);
  });

  it('says when the list itself cannot be read', async () => {
    listError = 'the folder is gone';
    await openBackups();

    expect(await screen.findByRole('alert')).toHaveTextContent(/the folder is gone/);
  });

  it('explains the empty case', async () => {
    backups = [];
    await openBackups();

    expect(
      within(dialog()).getByText('No copies yet. One is written each time the app starts.')
    ).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    await openBackups();

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Backups' })).not.toBeInTheDocument()
    );
  });
});
