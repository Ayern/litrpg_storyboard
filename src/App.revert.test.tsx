import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// The audit tab is plain DOM; the canvas around it needs React Flow's DOM
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

type RevertState =
  | 'available'
  | 'changed_since'
  | 'in_trash'
  | 'gone'
  | 'already_back';

interface AuditRow {
  id: string;
  story_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  field_changed: string | null;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
  changed_at: string;
  revert_state: RevertState | null;
  revert_reason: string | null;
}

interface RevertArgs {
  entryId: string;
  user: string;
}

const story = {
  id: 'story-1',
  title: 'Ledger',
  description: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

// One history entry, an ordinary node label edit the page says is still
// revertible, unless a test says otherwise.
function row(overrides: Partial<AuditRow> & { id: string }): AuditRow {
  return {
    story_id: story.id,
    entity_type: 'node',
    entity_id: 'node-1',
    action: 'update',
    field_changed: 'label',
    old_value: 'draft',
    new_value: 'note',
    changed_by: 'Ada',
    changed_at: '2026-10-22T12:00:00Z',
    revert_state: 'available',
    revert_reason: null,
    ...overrides,
  };
}

let auditCalls: number[] = [];
let auditHandler: () => { entries: AuditRow[]; total: number } = () => ({
  entries: [],
  total: 0,
});
let revertCalls: RevertArgs[] = [];
let revertHandler: () => boolean | Promise<boolean> = () => true;

beforeEach(() => {
  auditCalls = [];
  revertCalls = [];
  auditHandler = () => ({ entries: [], total: 0 });
  revertHandler = () => true;

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
      case 'get_graph_edges':
      case 'get_characters':
      case 'get_story_character_stats':
        return [];
      case 'get_audit_history':
        auditCalls.push(args.offset as number);
        return auditHandler();
      case 'revert_change':
        revertCalls.push({ entryId: args.entryId as string, user: args.user as string });
        return revertHandler();
      default:
        // initialize_database and anything else the shell asks for on mount.
        return null;
    }
  });
});

async function openAuditTab() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Audit Log' }));

  return user;
}

function historyItems() {
  const list = screen.getByRole('list', { name: 'Change history' });
  return within(list).getAllByRole('listitem');
}

describe('reverting an edit', () => {
  it('offers Revert on an edit and on an earlier revert, and nowhere else', async () => {
    auditHandler = () => ({
      entries: [
        row({ id: 'revert-1', action: 'revert', old_value: 'note', new_value: 'draft' }),
        row({ id: 'edit-1' }),
        row({ id: 'created-1', action: 'create', old_value: null, revert_state: null }),
        row({
          id: 'deleted-1',
          action: 'soft_delete',
          field_changed: null,
          old_value: 'draft',
          new_value: null,
          revert_state: null,
        }),
      ],
      total: 4,
    });

    await openAuditTab();

    const items = historyItems();
    expect(items).toHaveLength(4);
    expect(within(items[0]).getByRole('button', { name: 'Revert label' })).toBeInTheDocument();
    expect(within(items[1]).getByRole('button', { name: 'Revert label' })).toBeInTheDocument();

    // A creation and a deletion are undone by the trash, not by reverting.
    expect(within(items[2]).queryByRole('button', { name: /^Revert/ })).not.toBeInTheDocument();
    expect(within(items[3]).queryByRole('button', { name: /^Revert/ })).not.toBeInTheDocument();

    // A revert reads as a change of its own, with its own badge.
    expect(within(items[0]).getByText('revert')).toBeInTheDocument();
  });

  it('puts the field back and says what it restored', async () => {
    // The first page offers the revert; once it has been done, the page says the
    // field is back where it was, so the button stops advertising it.
    let pages = 0;
    auditHandler = () => {
      pages += 1;
      return {
        entries: [
          pages === 1
            ? row({ id: 'edit-1' })
            : row({
                id: 'edit-1',
                revert_state: 'already_back',
                revert_reason:
                  'that field already holds its earlier value, so there is nothing to put back',
              }),
        ],
        total: 1,
      };
    };

    const user = await openAuditTab();
    await user.click(screen.getByRole('button', { name: 'Revert label' }));

    expect(
      await screen.findByText(/Reverted Graph node \(label\) to “draft”/)
    ).toBeInTheDocument();
    expect(revertCalls).toEqual([{ entryId: 'edit-1', user: 'You' }]);

    // The window is fetched again so the revert's own entry can appear, and the
    // graph is reloaded so the canvas is not left showing the old label.
    expect(auditCalls.length).toBe(2);
    expect(invokeMock).toHaveBeenCalledWith('get_graph_nodes', { storyId: story.id });

    expect(
      screen.getByRole('button', { name: /already back/i })
    ).toBeDisabled();
  });

  it('explains a refusal instead of quietly leaving the field alone', async () => {
    auditHandler = () => ({ entries: [row({ id: 'edit-1', new_value: 'note 3' })], total: 1 });
    revertHandler = () =>
      Promise.reject(
        new Error(
          'label changed after that entry — it now reads "note 3", so reverting would discard that edit'
        )
      );

    const user = await openAuditTab();
    await user.click(screen.getByRole('button', { name: 'Revert label' }));

    const message = await screen.findByText(/Cannot revert that change/);
    expect(message).toHaveTextContent('changed after that entry');
    expect(screen.queryByText(/^Reverted/)).not.toBeInTheDocument();

    // Nothing succeeded, so nothing was reloaded.
    expect(auditCalls.length).toBe(1);
    expect(historyItems()).toHaveLength(1);
  });

  it('says when there was nothing left to put back', async () => {
    auditHandler = () => ({ entries: [row({ id: 'edit-1' })], total: 1 });
    revertHandler = () => false;

    const user = await openAuditTab();
    await user.click(screen.getByRole('button', { name: 'Revert label' }));

    expect(await screen.findByText(/Nothing to put back/)).toBeInTheDocument();
  });

  it('keeps Revert for a field that was emptied, but not for one with no recorded value', async () => {
    auditHandler = () => ({
      entries: [
        row({
          id: 'description',
          entity_type: 'character',
          field_changed: 'description',
          old_value: 'Scout',
          new_value: null,
        }),
        row({
          id: 'title',
          entity_type: 'story',
          field_changed: 'title',
          old_value: null,
          new_value: 'Ledger',
          // The page says this one recorded nothing, so it offers no button.
          revert_state: null,
        }),
      ],
      total: 2,
    });

    await openAuditTab();

    const items = historyItems();
    // Clearing a description is revertible: empty is a value it can go back to.
    expect(
      within(items[0]).getByRole('button', { name: 'Revert description' })
    ).toBeInTheDocument();
    // A title entry that recorded no earlier title has nothing to put back.
    expect(within(items[1]).queryByRole('button', { name: /^Revert/ })).not.toBeInTheDocument();
  });

  it('says on the button why a revert is no longer possible, before it is clicked', async () => {
    const stale =
      'label changed after that entry — it now reads "note 9", so reverting would discard that edit';

    auditHandler = () => ({
      entries: [
        row({ id: 'stale', revert_state: 'changed_since', revert_reason: stale }),
        row({
          id: 'trashed',
          revert_state: 'in_trash',
          revert_reason: 'that item is in the trash; restore it before reverting an edit',
        }),
        row({
          id: 'gone',
          revert_state: 'gone',
          revert_reason: 'that item is no longer in the database, so there is nothing to put back',
        }),
        row({
          id: 'back',
          revert_state: 'already_back',
          revert_reason: 'that field already holds its earlier value, so there is nothing to put back',
        }),
        row({ id: 'ready' }),
      ],
      total: 5,
    });

    const user = await openAuditTab();
    const items = historyItems();

    // Each blocked entry carries the reason the engine would give, in the place
    // the button would be, and cannot be clicked at all.
    const blocked: [number, string][] = [
      [0, 'Changed since'],
      [1, 'In trash'],
      [2, 'Gone'],
      [3, 'Already back'],
    ];

    for (const [index, label] of blocked) {
      const button = within(items[index]).getByRole('button', { name: new RegExp(label, 'i') });
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent(label);
      await user.click(button);
    }

    expect(within(items[0]).getByTitle(stale)).toBeInTheDocument();
    expect(revertCalls).toEqual([]);

    // The one that is still possible stays a working button.
    expect(within(items[4]).getByRole('button', { name: 'Revert label' })).toBeEnabled();
  });
});
