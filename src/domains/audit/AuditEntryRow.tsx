import { revertLabels } from './labels';
import type { AuditEntry } from './types';

export function AuditEntryRow({
  entry,
  onRevert,
  busy,
}: {
  entry: AuditEntry;
  onRevert: (entry: AuditEntry) => void;
  busy: string | null;
}) {
  const state = entry.revert_state ?? null;
  const blocked = state !== null && state !== 'available';

  // A disabled button keeps the action where it would be and says why it is not
  // on offer, so a reader learns that before clicking rather than after.
  const revertButton = state === null ? null : (
    <button
      className="audit-revert"
      aria-label={
        blocked
          ? `Revert ${entry.field_changed} — ${revertLabels[state].toLowerCase()}`
          : `Revert ${entry.field_changed}`
      }
      title={
        blocked
          ? entry.revert_reason ?? undefined
          : 'Put this field back to what it was before this change'
      }
      onClick={() => onRevert(entry)}
      disabled={blocked || busy !== null}
    >
      {busy === entry.id ? 'Reverting…' : revertLabels[state]}
    </button>
  );

  if (entry.action === 'update' || entry.action === 'revert') {
    return (
      <div className="audit-change">
        <span className="audit-old">{entry.old_value ?? 'nothing'}</span>
        <span className="audit-arrow">→</span>
        <span className="audit-new">{entry.new_value ?? 'nothing'}</span>
        {revertButton}
      </div>
    );
  }

  if (!entry.new_value) return null;

  return (
    <div className="audit-change">
      <span className="audit-new">{entry.new_value}</span>
      {revertButton}
    </div>
  );
}
