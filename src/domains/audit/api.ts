import { invoke } from '@tauri-apps/api/core';
import type { AuditPage } from './types';

// The history and the two things done with it: reading a page of it, and
// putting one field back. The filter and the window are both part of the read,
// because the tab pages through the same query rather than holding it all.

export function getAuditHistory(
  storyId: string | null,
  entityType: string | null,
  entityId: string | null,
  limit: number,
  offset: number
) {
  return invoke<AuditPage>('get_audit_history', {
    storyId,
    entityType,
    entityId,
    limit,
    offset,
  });
}

// Answers whether anything was actually written back: the value may have moved
// on since the entry was recorded, which the tab shows before it is clicked.
export function revertChange(entryId: string, actor: string) {
  return invoke<boolean>('revert_change', { entryId, user: actor });
}

// A note the UI itself puts in the history, for the steps it took on its own.
export function recordHistoryEvent(
  storyId: string,
  action: string,
  detail: string,
  actor: string
) {
  return invoke<void>('record_history_event', { storyId, action, detail, user: actor });
}
