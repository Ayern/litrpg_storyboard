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
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    useNodesState: (initial: unknown[]) => [initial, () => {}, () => {}],
    useEdgesState: (initial: unknown[]) => [initial, () => {}, () => {}],
  };
});

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

// One history entry, an ordinary node label edit unless a test says otherwise.
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
        row({ id: 'created-1', action: 'create', old_value: null }),
        row({
          id: 'deleted-1',
          action: 'soft_delete',
          field_changed: null,
          old_value: 'draft',
          new_value: null,
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
    auditHandler = () => ({ entries: [row({ id: 'edit-1' })], total: 1 });

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
});
