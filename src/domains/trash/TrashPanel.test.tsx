import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Story } from '../stories/types';
import { TrashPanel } from './TrashPanel';
import type { TrashPanelProps } from './TrashPanel';
import type { DeletedItem } from './types';

// The panel reads the two lists itself, on arrival, and holds what it shows —
// the loading flag, the row awaiting a permanent-delete confirmation, the
// retention window and the notices. Everything outside the tab, which is what a
// restore or a purge reaches, leaves through a callback. So it renders with no
// board, no story load and no database: the command module is mocked, and these
// tests hold the panel to the lists it draws and the callbacks it makes.

const { trashApi } = vi.hoisted(() => ({
  trashApi: {
    getTrash: vi.fn(),
    getTrashRetention: vi.fn(),
    setTrashRetention: vi.fn(),
    restoreDeleted: vi.fn(),
    purgeDeleted: vi.fn(),
  },
}));

vi.mock('./api', () => trashApi);

const story: Story = {
  id: 's-1',
  title: 'The Vault',
  description: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function deleted(id: string, kind: string, label: string): DeletedItem {
  return {
    id,
    kind,
    label,
    story_id: story.id,
    deleted_at: '2026-01-02T00:00:00Z',
  };
}

// What the two reads answer: the rows deleted inside the open story, and every
// deleted story. A test changes these before rendering.
let inStory: DeletedItem[] = [];
let stories: DeletedItem[] = [];

beforeEach(() => {
  inStory = [];
  stories = [];
  vi.clearAllMocks();

  trashApi.getTrash.mockImplementation(async (storyId: string | null) =>
    storyId ? inStory : stories
  );
  trashApi.getTrashRetention.mockResolvedValue(null);
  trashApi.setTrashRetention.mockResolvedValue(0);
  trashApi.restoreDeleted.mockResolvedValue(null);
  trashApi.purgeDeleted.mockResolvedValue(null);
});

function baseProps(overrides: Partial<TrashPanelProps> = {}): TrashPanelProps {
  return {
    story,
    actor: 'Ada',
    reloadToken: 0,
    onRestored: vi.fn(async () => {}),
    onPurged: vi.fn(async () => {}),
    onIrreversible: vi.fn(),
    ...overrides,
  };
}

function storyRows() {
  return screen.getByRole('list', { name: 'Deleted from this story' });
}

function deletedStoryRows() {
  return screen.getByRole('list', { name: 'Deleted stories' });
}

describe('the trash panel', () => {
  it('keeps the deleted stories apart from what went from the open story', async () => {
    inStory = [
      deleted('c-1', 'character', 'Rook'),
      deleted('e-1', 'edge', 'Rook -> Vault'),
    ];
    stories = [deleted('s-2', 'story', 'Old Draft')];

    render(<TrashPanel {...baseProps()} />);

    expect(await screen.findByText('Rook')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Deleted from “The Vault”' })
    ).toBeInTheDocument();

    const gone = deletedStoryRows();
    expect(within(gone).getByText('Old Draft')).toBeInTheDocument();
    expect(within(gone).getByText('Story')).toBeInTheDocument();

    // The open story's list is only its own rows, and a kind is named not shown.
    const left = storyRows();
    expect(within(left).getByText('Graph connection')).toBeInTheDocument();
    expect(within(left).queryByText('Old Draft')).not.toBeInTheDocument();
  });

  it('says when the open story has nothing in the trash', async () => {
    stories = [deleted('s-2', 'story', 'Old Draft')];

    render(<TrashPanel {...baseProps()} />);

    expect(
      await screen.findByText('Nothing deleted from this story.')
    ).toBeInTheDocument();
    expect(screen.queryByText('No stories in the trash.')).not.toBeInTheDocument();
  });

  it('asks for a story before it can list what went from one', async () => {
    render(<TrashPanel {...baseProps({ story: null })} />);

    expect(
      await screen.findByText('Select a story to see what was deleted from it.')
    ).toBeInTheDocument();
    expect(screen.getByText('No stories in the trash.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Deleted items' })).toBeInTheDocument();

    // With no story open there is nothing to read the story's half of the trash
    // for, so the one read it makes is the deleted stories.
    expect(trashApi.getTrash.mock.calls).toEqual([[null]]);
  });

  it('shows the stored window with the choices it offers', async () => {
    trashApi.getTrashRetention.mockResolvedValue(30);

    render(<TrashPanel {...baseProps()} />);

    const select = await screen.findByLabelText('Keep deleted items for');
    await waitFor(() => expect(select).toHaveValue('30'));

    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Forever', '7 days', '30 days', '90 days', '1 year']);
  });

  it('shows a stored window the list does not offer', async () => {
    trashApi.getTrashRetention.mockResolvedValue(14);

    render(<TrashPanel {...baseProps()} />);

    const select = await screen.findByLabelText('Keep deleted items for');
    await waitFor(() => expect(select).toHaveValue('14'));
    expect(within(select).getByRole('option', { name: '14 days' })).toBeInTheDocument();
  });

  it('applies a shorter window at once and says what it swept out', async () => {
    const user = userEvent.setup();
    inStory = [deleted('c-1', 'character', 'Old Rook')];
    trashApi.setTrashRetention.mockResolvedValue(2);
    const onIrreversible = vi.fn();

    render(<TrashPanel {...baseProps({ onIrreversible })} />);

    const select = await screen.findByLabelText('Keep deleted items for');
    expect(await screen.findByText('Old Rook')).toBeInTheDocument();

    // The window that was applied has already swept the row out of the list.
    inStory = [];
    await user.selectOptions(select, '90');

    expect(trashApi.setTrashRetention).toHaveBeenCalledWith(90);

    // The purged rows leave the screen without leaving the tab: both lists are
    // read again, and the story's half is the only one that can have changed.
    expect(
      await screen.findByText('Removed 2 items deleted more than 90 days ago.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Old Rook')).not.toBeInTheDocument();
    expect(trashApi.getTrash.mock.calls.length).toBeGreaterThan(2);

    // A purge is behind the history now, so the app is told to drop it.
    expect(onIrreversible).toHaveBeenCalledTimes(1);
  });

  it('turns the window off by asking for no window at all', async () => {
    const user = userEvent.setup();
    trashApi.getTrashRetention.mockResolvedValue(30);
    const onIrreversible = vi.fn();

    render(<TrashPanel {...baseProps({ onIrreversible })} />);

    const select = await screen.findByLabelText('Keep deleted items for');
    await waitFor(() => expect(select).toHaveValue('30'));

    await user.selectOptions(select, 'forever');

    expect(trashApi.setTrashRetention).toHaveBeenCalledWith(null);
    expect(screen.queryByText(/Removed/)).not.toBeInTheDocument();
    // Nothing was swept out, so no history was made unsafe to undo into.
    expect(onIrreversible).not.toHaveBeenCalled();
  });

  it('hands a restore to the app and takes the row out of the list', async () => {
    const user = userEvent.setup();
    inStory = [deleted('c-1', 'character', 'Rook')];
    const onRestored = vi.fn(async () => {});

    render(<TrashPanel {...baseProps({ onRestored })} />);

    await user.click(await screen.findByRole('button', { name: 'Restore' }));

    expect(trashApi.restoreDeleted).toHaveBeenCalledWith('c-1', 'character', 'Ada');
    await waitFor(() => expect(screen.queryByText('Rook')).not.toBeInTheDocument());
    expect(onRestored).toHaveBeenCalledWith(inStory[0]);
    expect(await screen.findByText('Restored Character “Rook”.')).toBeInTheDocument();
  });

  it('asks before deleting a row forever', async () => {
    const user = userEvent.setup();
    inStory = [deleted('c-1', 'character', 'Rook')];
    const onPurged = vi.fn(async () => {});
    const onIrreversible = vi.fn();

    render(<TrashPanel {...baseProps({ onPurged, onIrreversible })} />);

    await user.click(await screen.findByRole('button', { name: 'Delete forever' }));

    // The first click only asks: nothing irreversible has happened yet.
    expect(trashApi.purgeDeleted).not.toHaveBeenCalled();
    expect(onPurged).not.toHaveBeenCalled();
    expect(screen.getByText('Rook')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(trashApi.purgeDeleted).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete forever' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete forever' }));

    expect(trashApi.purgeDeleted).toHaveBeenCalledWith('c-1', 'character', 'Ada');
    expect(onIrreversible).toHaveBeenCalledTimes(1);
    expect(onPurged).toHaveBeenCalledWith(inStory[0]);
    await waitFor(() => expect(screen.queryByText('Rook')).not.toBeInTheDocument());
  });

  it('explains a read that failed rather than leaving the tab loading', async () => {
    trashApi.getTrashRetention.mockRejectedValue('database is locked');

    render(<TrashPanel {...baseProps()} />);

    expect(
      await screen.findByText('Could not use the trash: database is locked')
    ).toBeInTheDocument();
    // The read failed, so the tab has stopped waiting for it rather than sitting
    // on a spinner over two lists that will never arrive.
    expect(screen.queryByText('Loading the trash…')).not.toBeInTheDocument();
  });
});
