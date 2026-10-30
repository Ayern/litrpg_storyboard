import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// The trash tab is plain DOM; the canvas it sits beside needs React Flow's DOM
// measurements, so render its children through a passthrough instead.
vi.mock('reactflow', async () => {
  const React = await import('react');
  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  return {
    default: PassThrough,
    Controls: () => null,
    Background: () => null,
    Panel: PassThrough,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    useNodesState: (initial: unknown[]) => [initial, () => {}, () => {}],
    useEdgesState: (initial: unknown[]) => [initial, () => {}, () => {}],
  };
});

interface DeletedRow {
  id: string;
  kind: string;
  label: string;
  story_id: string;
  deleted_at: string;
  detail?: string | null;
}

const story = {
  id: 'story-1',
  title: 'Ledger',
  description: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

function deleted(id: string, kind: string, label: string, storyId = story.id): DeletedRow {
  return {
    id,
    kind,
    label,
    story_id: storyId,
    deleted_at: '2026-10-22T12:00:00Z',
  };
}

interface Invocation {
  command: string;
  args: Record<string, unknown>;
}

let calls: Invocation[] = [];
let storyTrash: DeletedRow[] = [];
let deletedStories: DeletedRow[] = [];
let retention: number | null = null;
let purgedByChangingRetention = 0;
let failOn: string | null = null;

beforeEach(() => {
  calls = [];
  storyTrash = [];
  deletedStories = [];
  retention = null;
  purgedByChangingRetention = 0;
  failOn = null;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push({ command, args });

    if (command === failOn) throw 'restore the connected nodes first';

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
      case 'get_graph_edges':
      case 'get_characters':
      case 'get_story_character_stats':
        return [];
      case 'get_trash':
        return args.storyId ? storyTrash : deletedStories;
      case 'get_trash_retention':
        return retention;
      case 'set_trash_retention':
        retention = (args.days as number | null) ?? null;
        return purgedByChangingRetention;
      default:
        // initialize_database, restore_deleted, purge_deleted and friends.
        return null;
    }
  });
});

async function openTrashTab() {
  const user = userEvent.setup();
  render(<App />);

  // The story list has to arrive before the tab has a story to report on.
  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Trash' }));

  return user;
}

function commandsRun() {
  return calls.map(call => call.command).filter(command => command !== 'get_trash');
}

describe('trash tab', () => {
  it('separates deleted stories from what was deleted inside the open story', async () => {
    storyTrash = [
      deleted('char-1', 'character', 'Rook'),
      deleted('edge-1', 'edge', 'Rook -> Vault'),
    ];
    deletedStories = [deleted('story-2', 'story', 'Old Draft', 'story-2')];

    await openTrashTab();

    const stories = await screen.findByRole('list', { name: 'Deleted stories' });
    expect(within(stories).getByText('Old Draft')).toBeInTheDocument();
    expect(within(stories).getByText('Story')).toBeInTheDocument();

    const items = screen.getByRole('list', { name: 'Deleted from this story' });
    expect(within(items).getByText('Rook')).toBeInTheDocument();
    expect(within(items).getByText('Graph connection')).toBeInTheDocument();

    // The open story's list must not repeat the deleted story above it.
    expect(within(items).queryByText('Old Draft')).not.toBeInTheDocument();
  });

  it('says so when the story has nothing in the trash', async () => {
    deletedStories = [deleted('story-2', 'story', 'Old Draft', 'story-2')];

    await openTrashTab();

    expect(
      await screen.findByText('Nothing deleted from this story.')
    ).toBeInTheDocument();
    expect(screen.queryByText('No stories in the trash.')).not.toBeInTheDocument();
  });

  it('restores an item and takes it out of the list', async () => {
    storyTrash = [deleted('char-1', 'character', 'Rook')];

    const user = await openTrashTab();
    const items = await screen.findByRole('list', { name: 'Deleted from this story' });

    await user.click(within(items).getByRole('button', { name: 'Restore' }));

    const restore = calls.find(call => call.command === 'restore_deleted');
    expect(restore?.args).toEqual({ id: 'char-1', kind: 'character', user: 'You' });

    await waitFor(() =>
      expect(screen.queryByText('Rook')).not.toBeInTheDocument()
    );
    expect(await screen.findByText(/Restored Character/)).toBeInTheDocument();
  });

  it('asks before deleting something forever', async () => {
    storyTrash = [deleted('char-1', 'character', 'Rook')];

    const user = await openTrashTab();
    const items = await screen.findByRole('list', { name: 'Deleted from this story' });

    await user.click(within(items).getByRole('button', { name: 'Delete forever' }));

    // Nothing irreversible happens on the first click.
    expect(commandsRun()).not.toContain('purge_deleted');
    expect(within(items).getByText('Rook')).toBeInTheDocument();

    await user.click(within(items).getByRole('button', { name: 'Yes, delete forever' }));

    const purge = calls.find(call => call.command === 'purge_deleted');
    expect(purge?.args).toEqual({ id: 'char-1', kind: 'character', user: 'You' });

    // The nodes that pointed at her are unlinked now, so the canvas is re-read
    // rather than left showing a link to a row that is gone.
    const purgeAt = calls.findIndex(call => call.command === 'purge_deleted');
    expect(
      calls.slice(purgeAt).some(call => call.command === 'get_graph_nodes')
    ).toBe(true);

    await waitFor(() =>
      expect(screen.queryByText('Rook')).not.toBeInTheDocument()
    );
  });

  it('says what a permanent delete would take with a card', async () => {
    storyTrash = [
      {
        ...deleted('node-1', 'node', 'Cinder Secret'),
        detail: 'Deleting forever also removes 2 skills and 1 chapter event.',
      },
      deleted('node-2', 'node', 'A bell under the floor'),
    ];

    const user = await openTrashTab();
    const items = await screen.findByRole('list', { name: 'Deleted from this story' });

    const card = within(items).getByText('Cinder Secret').closest('li')!;
    expect(
      within(card).getByText(
        'Deleting forever also removes 2 skills and 1 chapter event.'
      )
    ).toBeInTheDocument();

    // A card that owns nothing beyond itself says nothing extra.
    const plain = within(items).getByText('A bell under the floor').closest('li')!;
    expect(
      within(plain).queryByText(/Deleting forever also removes/)
    ).not.toBeInTheDocument();

    // The warning is on the line before the confirmation is asked for.
    await user.click(within(card).getByRole('button', { name: 'Delete forever' }));
    expect(
      within(card).getByText(/Deleting forever also removes 2 skills/)
    ).toBeInTheDocument();
  });

  it('keeps a cancelled permanent delete', async () => {
    storyTrash = [deleted('char-1', 'character', 'Rook')];

    const user = await openTrashTab();
    const items = await screen.findByRole('list', { name: 'Deleted from this story' });

    await user.click(within(items).getByRole('button', { name: 'Delete forever' }));
    await user.click(within(items).getByRole('button', { name: 'Cancel' }));

    expect(commandsRun()).not.toContain('purge_deleted');
    expect(within(items).getByText('Rook')).toBeInTheDocument();
  });

  it('explains why a restore failed instead of just dropping the row', async () => {
    storyTrash = [deleted('edge-1', 'edge', 'Rook -> Vault')];
    failOn = 'restore_deleted';

    const user = await openTrashTab();
    const items = await screen.findByRole('list', { name: 'Deleted from this story' });

    await user.click(within(items).getByRole('button', { name: 'Restore' }));

    expect(await screen.findByText(/restore the connected nodes first/)).toBeInTheDocument();
    expect(within(items).getByText('Rook -> Vault')).toBeInTheDocument();
  });

  it('re-reads the trash every time the tab is opened', async () => {
    storyTrash = [deleted('char-1', 'character', 'Rook')];

    const user = await openTrashTab();
    await screen.findByText('Rook');

    storyTrash = [];

    await user.click(screen.getByRole('button', { name: 'Graph' }));
    await user.click(screen.getByRole('button', { name: 'Trash' }));

    expect(await screen.findByText('Nothing deleted from this story.')).toBeInTheDocument();
  });

  it('shows the retention window that is stored', async () => {
    retention = 30;

    await openTrashTab();

    const select = await screen.findByLabelText('Keep deleted items for');
    await waitFor(() => expect(select).toHaveValue('30'));

    const labels = within(select)
      .getAllByRole('option')
      .map(option => option.textContent);
    expect(labels).toEqual(['Forever', '7 days', '30 days', '90 days', '1 year']);
  });

  it('shows a stored window the list does not offer', async () => {
    retention = 14;

    await openTrashTab();

    const select = await screen.findByLabelText('Keep deleted items for');
    await waitFor(() => expect(select).toHaveValue('14'));
    expect(within(select).getByRole('option', { name: '14 days' })).toBeInTheDocument();
  });

  it('applies a shorter window at once and says what it removed', async () => {
    storyTrash = [deleted('char-1', 'character', 'Old Rook')];
    purgedByChangingRetention = 2;

    const user = await openTrashTab();
    const select = await screen.findByLabelText('Keep deleted items for');

    storyTrash = [];
    await user.selectOptions(select, '90');

    const change = calls.find(call => call.command === 'set_trash_retention');
    expect(change?.args).toEqual({ days: 90 });

    expect(
      await screen.findByText('Removed 2 items deleted more than 90 days ago.')
    ).toBeInTheDocument();

    // The lists are re-read so the purged rows leave the screen immediately.
    const trashReads = calls.filter(call => call.command === 'get_trash');
    expect(trashReads.length).toBeGreaterThan(2);
    expect(screen.queryByText('Old Rook')).not.toBeInTheDocument();
  });

  it('turns the window off by asking for no window at all', async () => {
    retention = 30;

    const user = await openTrashTab();
    const select = await screen.findByLabelText('Keep deleted items for');
    await waitFor(() => expect(select).toHaveValue('30'));

    await user.selectOptions(select, 'forever');

    const change = calls.find(call => call.command === 'set_trash_retention');
    expect(change?.args).toEqual({ days: null });
    expect(screen.queryByText(/Removed/)).not.toBeInTheDocument();
  });

  it('keeps the previous window when the change is refused', async () => {
    retention = 30;
    failOn = 'set_trash_retention';

    const user = await openTrashTab();
    const select = await screen.findByLabelText('Keep deleted items for');
    await waitFor(() => expect(select).toHaveValue('30'));

    await user.selectOptions(select, '7');

    expect(
      await screen.findByText(/restore the connected nodes first/)
    ).toBeInTheDocument();
    expect(select).toHaveValue('30');
  });
});
