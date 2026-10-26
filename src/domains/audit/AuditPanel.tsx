import { useEffect, useRef, useState } from 'react';

import { formatWhen } from '../../lib/format';
import { AuditEntryRow } from './AuditEntryRow';
import * as auditApi from './api';
import { actionLabels, auditFilters, AUDIT_PAGE_SIZE, entityLabel } from './labels';
import type { AuditEntry, AuditFilter, AuditPage } from './types';

// The Audit Log: the story's history, a page at a time, with a Revert on each
// field the database still says can be put back.
//
// The panel owns the reading and the reverting, and reaches the database only
// through the audit command layer, so the whole of the tab is described by the
// types and commands in this folder. What it cannot own is the other tabs: a
// revert changes what they show, so it asks the app to reload them rather than
// knowing what they are.
export function AuditPanel({
  storyId,
  actor,
  onReverted,
}: {
  // The story whose history is shown; null until one is open.
  storyId: string | null;
  // Who a revert is credited to in the history.
  actor: string;
  // The rest of the app, reloaded rather than left showing the value the history
  // just put back.
  onReverted: () => Promise<void>;
}) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<AuditFilter>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revertBusyId, setRevertBusyId] = useState<string | null>(null);
  const [revertNotice, setRevertNotice] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  // Read by the "show older" request when it returns, so a page fetched under one
  // filter is never appended to a list showing another.
  const filterRef = useRef<AuditFilter>(null);

  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  // History is fetched when the tab is opened, when the story changes and when
  // the filter changes, so the tab always reflects the latest changes. Closing a
  // story leaves the tab holding nothing rather than the story that was open.
  useEffect(() => {
    if (!storyId) {
      setEntries([]);
      setTotal(0);
      return;
    }

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const page: AuditPage = await auditApi.getAuditHistory(
          storyId,
          filter,
          null,
          AUDIT_PAGE_SIZE,
          0
        );
        if (!cancelled) {
          setEntries(page.entries);
          setTotal(page.total);
        }
      } catch (e) {
        console.error('Failed to load audit history:', e);
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [storyId, filter]);

  // Older changes are appended rather than reloaded, so the list grows where the
  // reader is instead of jumping back to the newest entry.
  const loadMore = async () => {
    if (!storyId) return;

    const asked = filter;
    setLoadingMore(true);
    setError(null);

    try {
      const page: AuditPage = await auditApi.getAuditHistory(
        storyId,
        asked,
        null,
        AUDIT_PAGE_SIZE,
        entries.length
      );

      if (asked !== filterRef.current) return;

      setEntries(previous => [...previous, ...page.entries]);
      setTotal(page.total);
    } catch (e) {
      console.error('Failed to load more audit history:', e);
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  // The window is refetched at the size the reader had reached, so a revert adds
  // its own entry without collapsing "show older changes" back to one page.
  const reloadWindow = async () => {
    if (!storyId) return;

    const page: AuditPage = await auditApi.getAuditHistory(
      storyId,
      filter,
      null,
      Math.min(Math.max(entries.length, AUDIT_PAGE_SIZE), 500),
      0
    );

    setEntries(page.entries);
    setTotal(page.total);
  };

  const revert = async (entry: AuditEntry) => {
    setRevertBusyId(entry.id);
    setRevertError(null);
    setRevertNotice(null);

    try {
      const changed: boolean = await auditApi.revertChange(entry.id, actor);

      if (!changed) {
        setRevertNotice('Nothing to put back: that field already holds its earlier value.');
      } else {
        setRevertNotice(`Reverted ${entityLabel(entry)} to “${entry.old_value ?? 'nothing'}”.`);
      }

      try {
        await onReverted();
        await reloadWindow();
      } catch (e) {
        // The revert itself succeeded; a failed refresh must not be reported as one.
        console.error('Failed to refresh after a revert:', e);
      }
    } catch (e) {
      console.error('Failed to revert a change:', e);
      setRevertError(String(e));
    } finally {
      setRevertBusyId(null);
    }
  };

  if (!storyId) {
    return (
      <div className="tab-content">
        <div className="empty-state">Load a story to see history</div>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <div className="audit-filters" role="group" aria-label="Filter history by what changed">
        {auditFilters.map(option => (
          <button
            key={option.value ?? 'all'}
            className={filter === option.value ? 'audit-filter active' : 'audit-filter'}
            aria-pressed={filter === option.value}
            title={
              option.value
                ? `Show only ${option.label.toLowerCase()} changes`
                : 'Show every kind of change'
            }
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="audit-error">Could not load history for this story: {error}</div>
      )}

      {revertError && (
        <div className="audit-error">
          Cannot revert that change: {revertError}{' '}
          <button
            className="status-dismiss"
            title="Hide this message"
            onClick={() => setRevertError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {revertNotice && (
        <div className="status-strip">
          {revertNotice}
          <button
            className="status-dismiss"
            title="Hide this message"
            onClick={() => setRevertNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {loading ? (
        <div className="empty">Loading history…</div>
      ) : entries.length === 0 ? (
        error ? null : (
          <div className="empty">
            {filter
              ? 'No changes of this kind recorded yet.'
              : 'No changes recorded yet. Edits to this story will show up here, newest first.'}
          </div>
        )
      ) : (
        <>
          <div className="audit-summary">
            Showing {entries.length} of {total} {total === 1 ? 'change' : 'changes'}
          </div>

          <ol className="audit-list" aria-label="Change history">
            {entries.map(entry => (
              <li key={entry.id} className="audit-entry">
                <div className="audit-row">
                  <span className={`audit-badge ${entry.action}`}>
                    {actionLabels[entry.action] ?? entry.action}
                  </span>
                  <span className="audit-entity">{entityLabel(entry)}</span>
                  <span className="audit-when">
                    {entry.changed_by} · {formatWhen(entry.changed_at)}
                  </span>
                </div>
                <AuditEntryRow entry={entry} onRevert={revert} busy={revertBusyId} />
              </li>
            ))}
          </ol>

          {entries.length < total && (
            <button
              className="audit-more"
              title="Load the next page of changes"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : `Show older changes (${total - entries.length} more)`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
