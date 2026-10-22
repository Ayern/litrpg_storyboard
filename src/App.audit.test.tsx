import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
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

interface AuditPage {
  entries: AuditRow[];
  total: number;
}

interface AuditArgs {
  entityType: string | null;
  limit: number;
  offset: number;
}

const story = {
  id: 'story-1',
  title: 'Ledger',
  description: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

function row(index: number, entityType = 'node'): AuditRow {
  return {
    id: `entry-${entityType}-${index}`,
    story_id: story.id,
    entity_type: entityType,
    entity_id: `${entityType}-${index}`,
    action: index === 0 ? 'create' : 'update',
    field_changed: index === 0 ? null : 'label',
    old_value: index === 0 ? null : 'draft',
    new_value: `note ${index}`,
    changed_by: 'Ada',
    changed_at: '2026-10-22T12:00:00Z',
  };
}

function rows(count: number, start = 0, entityType = 'node'): AuditRow[] {
  return Array.from({ length: count }, (_, index) => row(start + index, entityType));
}

let auditCalls: AuditArgs[] = [];
let auditHandler: (args: AuditArgs) => AuditPage | Promise<AuditPage> = () => ({
  entries: [],
  total: 0,
});

beforeEach(() => {
  auditCalls = [];
  auditHandler = () => ({ entries: [], total: 0 });
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
      case 'get_audit_history': {
        const call: AuditArgs = {
          entityType: (args.entityType as string | null) ?? null,
          limit: args.limit as number,
          offset: args.offset as number,
        };
        auditCalls.push(call);
        return auditHandler(call);
      }
      default:
        // initialize_database and anything else the shell asks for on mount.
        return null;
    }
  });
});

async function openAuditTab() {
  const user = userEvent.setup();
  render(<App />);

  // The story list has to arrive before the audit tab has a story to report on.
  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Audit Log' }));

  return user;
}

function historyItems() {
  const list = screen.getByRole('list', { name: 'Change history' });
  return within(list).getAllByRole('listitem');
}

// "Characters" is both a tab and a filter, so always look inside the filter group.
function filterChip(name: string) {
  const filters = screen.getByRole('group', { name: 'Filter history by what changed' });
  return within(filters).getByRole('button', { name });
}

describe('audit history tab', () => {
  it('shows one page of history and how much of it is left', async () => {
    auditHandler = () => ({ entries: rows(50), total: 145 });

    await openAuditTab();

    expect(await screen.findByText(/Showing 50 of 145 changes/)).toBeInTheDocument();
    expect(historyItems()).toHaveLength(50);

    const more = screen.getByRole('button', { name: 'Show older changes (95 more)' });
    expect(more).toBeEnabled();

    // The window is a page, not everything, and it starts at the newest entry.
    expect(auditCalls).toEqual([{ entityType: null, limit: 50, offset: 0 }]);
  });

  it('appends the older page instead of replacing what is on screen', async () => {
    auditHandler = ({ offset }) =>
      offset === 0 ? { entries: rows(50, 0), total: 80 } : { entries: rows(30, 50), total: 80 };

    const user = await openAuditTab();
    await screen.findByText(/Showing 50 of 80 changes/);

    await user.click(screen.getByRole('button', { name: 'Show older changes (30 more)' }));

    expect(await screen.findByText(/Showing 80 of 80 changes/)).toBeInTheDocument();

    const items = historyItems();
    expect(items).toHaveLength(80);
    expect(items[0]).toHaveTextContent('note 0');
    expect(items[79]).toHaveTextContent('note 79');

    expect(screen.queryByRole('button', { name: /Show older changes/ })).not.toBeInTheDocument();
    expect(auditCalls.map(call => call.offset)).toEqual([0, 50]);
  });

  it('narrows the history to one kind of change', async () => {
    auditHandler = ({ entityType }) =>
      entityType === 'node'
        ? { entries: rows(3, 0, 'node'), total: 3 }
        : { entries: rows(50), total: 145 };

    const user = await openAuditTab();
    await screen.findByText(/Showing 50 of 145 changes/);

    await user.click(filterChip('Nodes'));

    expect(await screen.findByText(/Showing 3 of 3 changes/)).toBeInTheDocument();
    expect(filterChip('Nodes')).toHaveAttribute('aria-pressed', 'true');
    expect(filterChip('All')).toHaveAttribute('aria-pressed', 'false');
    expect(historyItems()).toHaveLength(3);

    expect(auditCalls).toEqual([
      { entityType: null, limit: 50, offset: 0 },
      { entityType: 'node', limit: 50, offset: 0 },
    ]);
  });

  it('starts a filter from the first page even after paging', async () => {
    auditHandler = ({ entityType, offset }) =>
      entityType === 'edge'
        ? { entries: rows(2, 0, 'edge'), total: 2 }
        : { entries: rows(50, offset), total: 120 };

    const user = await openAuditTab();
    await screen.findByText(/Showing 50 of 120 changes/);

    await user.click(screen.getByRole('button', { name: /Show older changes/ }));
    await screen.findByText(/Showing 100 of 120 changes/);

    await user.click(filterChip('Connections'));

    expect(await screen.findByText(/Showing 2 of 2 changes/)).toBeInTheDocument();
    expect(auditCalls.map(call => `${call.entityType}:${call.offset}`)).toEqual([
      'null:0',
      'null:50',
      'edge:0',
    ]);
  });

  it('drops a page that arrives after the filter moved on', async () => {
    let releaseOlder: (page: AuditPage) => void = () => {};
    const older = new Promise<AuditPage>(resolve => {
      releaseOlder = resolve;
    });

    auditHandler = ({ entityType, offset }) => {
      if (entityType === 'character') return { entries: rows(2, 0, 'character'), total: 2 };
      return offset === 0 ? { entries: rows(50, 0), total: 120 } : older;
    };

    const user = await openAuditTab();
    await screen.findByText(/Showing 50 of 120 changes/);

    // Ask for more, then change the filter while that request is still in flight.
    await user.click(screen.getByRole('button', { name: /Show older changes/ }));
    await user.click(filterChip('Characters'));
    expect(await screen.findByText(/Showing 2 of 2 changes/)).toBeInTheDocument();

    await act(async () => {
      releaseOlder({ entries: rows(50, 50), total: 120 });
      await older;
    });

    // The stale page belongs to the old list and must not land in the new one.
    expect(screen.getByText(/Showing 2 of 2 changes/)).toBeInTheDocument();
    expect(historyItems()).toHaveLength(2);
  });

  it('explains an empty filter instead of showing nothing', async () => {
    auditHandler = ({ entityType }) =>
      entityType === 'character_attribute'
        ? { entries: [], total: 0 }
        : { entries: rows(2), total: 2 };

    const user = await openAuditTab();
    await screen.findByText(/Showing 2 of 2 changes/);

    await user.click(filterChip('Attributes'));

    expect(await screen.findByText('No changes of this kind recorded yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Change history' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show older changes/ })).not.toBeInTheDocument();
  });
});
