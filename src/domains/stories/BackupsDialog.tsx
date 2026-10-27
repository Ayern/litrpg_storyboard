import { formatWhen } from '../../lib/format';
import type { BackupInfo } from './types';

// The dialog that lists the launch copies. One copy at a time is asked about,
// and nothing in it says what the current database holds: the list is the same
// whether a restore is needed or not.

interface BackupsDialogProps {
  backups: BackupInfo[];
  loading: boolean;
  error: string | null;
  confirmRestore: string | null;
  restoringFile: string | null;
  onAskRestore: (fileName: string) => void;
  onCancelRestore: () => void;
  onRestore: (backup: BackupInfo) => void;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BackupsDialog({
  backups,
  loading,
  error,
  confirmRestore,
  restoringFile,
  onAskRestore,
  onCancelRestore,
  onRestore,
  onClose,
}: BackupsDialogProps) {
  return (
    <div className="shortcuts-backdrop" role="presentation" onClick={onClose}>
      <div
        className="backups"
        role="dialog"
        aria-modal="true"
        aria-label="Backups"
        onClick={event => event.stopPropagation()}
      >
        <div className="shortcuts-head">
          <h2>Backups</h2>
          <button
            className="shortcuts-close"
            aria-label="Close backups"
            title="Close this dialog (Esc)"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <p className="shortcuts-intro">
          A copy of the whole database is written each time the app starts, and the
          newest ten are kept. Restoring one replaces every story in this window;
          the state it replaces is copied first, so a restore can be walked back
          from this same list.
        </p>

        {loading && <p className="backups-empty">Reading the backups…</p>}

        {error && (
          <div className="backups-error" role="alert">
            {error}
          </div>
        )}

        {!loading && !error && backups.length === 0 && (
          <p className="backups-empty">
            No copies yet. One is written each time the app starts.
          </p>
        )}

        {backups.length > 0 && (
          <ul className="backup-list" aria-label="Database backups">
            {backups.map(backup => (
              <li key={backup.file_name} className="backup-item">
                <div className="backup-when">
                  {formatWhen(backup.created_at)}
                  <span className="backup-meta">
                    {formatBytes(backup.size_bytes)} · {backup.file_name}
                  </span>
                </div>

                {confirmRestore === backup.file_name ? (
                  <div className="backup-confirm">
                    <span>Replace everything with this copy?</span>
                    <button
                      title="Replace the database with this copy; a copy of what is here now is taken first"
                      onClick={() => onRestore(backup)}
                      disabled={restoringFile !== null}
                    >
                      {restoringFile === backup.file_name ? 'Restoring…' : 'Restore this copy'}
                    </button>
                    <button
                      title="Keep the current data"
                      onClick={onCancelRestore}
                      disabled={restoringFile !== null}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    title={`Replace the database with the copy from ${formatWhen(
                      backup.created_at
                    )}`}
                    onClick={() => onAskRestore(backup.file_name)}
                    disabled={restoringFile !== null}
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
