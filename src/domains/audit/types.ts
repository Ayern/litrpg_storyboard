// The audit trail as the tab reads it.

// Mirrors the entity types the database records in `audit_log.entity_type`.
export type AuditFilter = string | null;

// Whether the history says one entry's earlier value can still be written back.
// Worked out by the database when the page is read, against the value the field
// holds now — so the tab can tell before it is clicked. Keep in step with
// `RevertState` in the database crate.
export type RevertState =
  | 'available'
  | 'changed_since'
  | 'in_trash'
  | 'gone'
  | 'already_back';

export interface AuditEntry {
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
  // Absent when the entry has nothing to put back at all.
  revert_state?: RevertState | null;
  // What a click would be refused with, when it would be refused.
  revert_reason?: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
}
