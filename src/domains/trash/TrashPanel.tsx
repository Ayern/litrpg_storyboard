import { useEffect, useState } from 'react';
import { formatWhen } from '../../lib/format';
import type { Story } from '../stories/types';
import * as trashApi from './api';
import type { DeletedItem } from './types';

// The Trash tab: everything the app deleted instead of destroying, in the two
// lists it belongs to — the stories that went, and what went from the story that
// is open. The tab is mounted only while it is open, so it reads the trash
// itself on arrival and holds the lists, the loading flag, the item awaiting a
// permanent-delete confirmation, the retention window and the notices. What a
// restore or a purge reaches outside the tab — the story list, the open story's
// cards, whichever sheet is selected, and the history that a permanent delete
// makes unsafe to undo into — belongs to the app and arrives as a callback.
// The markup that turns a deleted row into a line is here, with the rest of the
// tab, and the way a kind is named beside it.

// What a deleted row was, as the tab names it on a line and in a notice.
const trashKindLabels: Record<string, string> = {
  story: 'Story',
  character: 'Character',
  node: 'Graph node',
  edge: 'Graph connection',
};

// How long the trash is kept. `null` is forever, which is the default.
const retentionChoices: { value: string; label: string }[] = [
  { value: 'forever', label: 'Forever' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

// Both lists the trash shows, in one round trip. Shared by the tab's first read
// and by the retention change that sweeps rows out of the window.
async function fetchTrash(storyId: string | null) {
  const [inStory, stories] = await Promise.all([
    storyId
      ? trashApi.getTrash(storyId)
      : Promise.resolve<DeletedItem[]>([]),
    trashApi.getTrash(null),
  ]);

  return { inStory, stories };
}

export interface TrashPanelProps {
  // The open story, which is what its half of the trash is read for. The tab
  // shows every deleted story whether or not one is open.
  story: Story | null;
  actor: string;
  // Changed when the whole database was replaced by a restored copy, which is
  // the one thing that empties both lists without the open story moving.
  reloadToken: number;

  // A restored item has to reappear where the user last saw it, and that is the
  // story list or the open story's cards — both outside this tab.
  onRestored: (item: DeletedItem) => Promise<void>;
  // Purging a card unlinks everything that named it, so the open story is
  // re-read rather than left pointing at a row that is gone.
  onPurged: (item: DeletedItem) => Promise<void>;
  // Nothing can bring a purged row back, so the earlier steps are no longer a
  // safe branch to undo into. Clearing them is the app's history to keep.
  onIrreversible: () => void;
}

export function TrashPanel({
  story,
  actor,
  reloadToken,
  onRestored,
  onPurged,
  onIrreversible,
}: TrashPanelProps) {
  const [trash, setTrash] = useState<DeletedItem[]>([]);
  const [deletedStories, setDeletedStories] = useState<DeletedItem[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashNotice, setTrashNotice] = useState<string | null>(null);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);

  // Arriving at the tab is the re-read, so it always reflects the latest
  // deletions — including ones made a moment ago from another tab. A story
  // opened while the tab is up changes what its half of the list is read for.
  useEffect(() => {
    let cancelled = false;

    const loadTrash = async () => {
      setTrashLoading(true);
      setTrashError(null);

      try {
        const [lists, days] = await Promise.all([
          fetchTrash(story?.id ?? null),
          trashApi.getTrashRetention(),
        ]);

        if (cancelled) return;
        setTrash(lists.inStory);
        setDeletedStories(lists.stories);
        setRetentionDays(days);
      } catch (e) {
        console.error('Failed to load the trash:', e);
        if (!cancelled) setTrashError(String(e));
      } finally {
        if (!cancelled) setTrashLoading(false);
      }
    };

    loadTrash();

    return () => {
      cancelled = true;
    };
  }, [story, reloadToken]);

  const restoreDeleted = async (item: DeletedItem) => {
    setConfirmPurgeId(null);
    setTrashError(null);
    setTrashNotice(null);

    try {
      await trashApi.restoreDeleted(item.id, item.kind, actor);

      if (item.kind === 'story') {
        setDeletedStories(previous => previous.filter(other => other.id !== item.id));
      } else {
        setTrash(previous => previous.filter(other => other.id !== item.id));
      }

      await onRestored(item);

      setTrashNotice(
        `Restored ${trashKindLabels[item.kind] ?? item.kind} “${item.label}”.`
      );
    } catch (e) {
      console.error('Failed to restore:', e);
      setTrashError(String(e));
    }
  };

  // The one irreversible action in the app, so it stays behind a confirmation.
  const purgeDeleted = async (item: DeletedItem) => {
    setConfirmPurgeId(null);
    setTrashError(null);

    try {
      await trashApi.purgeDeleted(item.id, item.kind, actor);

      // Nothing can bring a purged row back, so earlier steps are cleared before
      // anything is reloaded, the way they always were.
      onIrreversible();

      if (item.kind === 'story') {
        setDeletedStories(previous => previous.filter(other => other.id !== item.id));
      } else {
        setTrash(previous => previous.filter(other => other.id !== item.id));
      }

      await onPurged(item);
    } catch (e) {
      console.error('Failed to delete permanently:', e);
      setTrashError(String(e));
    }
  };

  // Shortening the window applies it straight away, so the effect of the choice
  // is visible instead of deferred to the next launch.
  const changeRetention = async (value: string) => {
    const days = value === 'forever' ? null : Number(value);

    setTrashError(null);
    setTrashNotice(null);

    try {
      const purged: number = await trashApi.setTrashRetention(days);
      setRetentionDays(days);

      if (purged > 0) {
        // Retention is a purge too: undoing past it could not restore what went.
        onIrreversible();

        const lists = await fetchTrash(story?.id ?? null);
        setTrash(lists.inStory);
        setDeletedStories(lists.stories);

        setTrashNotice(
          `Removed ${purged} ${purged === 1 ? 'item' : 'items'} deleted more than ${days} ${
            days === 1 ? 'day' : 'days'
          } ago.`
        );
      }
    } catch (e) {
      console.error('Failed to change how long the trash is kept:', e);
      setTrashError(String(e));
    }
  };

  // A window the list does not offer (a hand-edited database, or one written by
  // a future build) still has to show as itself rather than as a blank box.
  const retentionOptions =
    retentionDays !== null &&
    !retentionChoices.some(choice => choice.value === String(retentionDays))
      ? [...retentionChoices, { value: String(retentionDays), label: `${retentionDays} days` }]
      : retentionChoices;

  const renderTrashItem = (item: DeletedItem) => (
    <li key={item.id} className="trash-item">
      <span className={`trash-kind ${item.kind}`}>
        {trashKindLabels[item.kind] ?? item.kind}
      </span>
      <span className="trash-label">{item.label}</span>
      <span className="trash-when">deleted {formatWhen(item.deleted_at)}</span>

      {confirmPurgeId === item.id ? (
        <>
          <button
            className="trash-danger"
            title="Delete permanently — this cannot be undone"
            onClick={() => purgeDeleted(item)}
          >
            Yes, delete forever
          </button>
          <button title="Keep it in the trash" onClick={() => setConfirmPurgeId(null)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            title="Put it back exactly as it was"
            onClick={() => restoreDeleted(item)}
          >
            Restore
          </button>
          <button
            className="trash-danger"
            title="Delete permanently — this cannot be undone"
            onClick={() => setConfirmPurgeId(item.id)}
          >
            Delete forever
          </button>
        </>
      )}
    </li>
  );

  return (
    <div className="tab-content">
      <div className="trash-intro">
        Deleting a story, character, node or connection puts it here instead of
        destroying it. Restoring brings it back exactly as it was.
      </div>

      {trashError && (
        <div className="audit-error">Could not use the trash: {trashError}</div>
      )}

      {trashNotice && (
        <div className="status-strip">
          {trashNotice}
          <button
            className="status-dismiss"
            title="Hide this message"
            onClick={() => setTrashNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="trash-retention">
        <label htmlFor="trash-retention">Keep deleted items for</label>
        <select
          id="trash-retention"
          title="How long deleted items are kept before they are removed for good"
          value={retentionDays === null ? 'forever' : String(retentionDays)}
          onChange={event => changeRetention(event.target.value)}
        >
          {retentionOptions.map(choice => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        <span className="hint">
          Older items are removed when the app starts, and as soon as you shorten
          this window.
        </span>
      </div>

      {trashLoading ? (
        <div className="empty">Loading the trash…</div>
      ) : (
        <>
          <div className="trash-section">
            <h4 className="character-section-heading">Deleted stories</h4>

            {deletedStories.length === 0 ? (
              <div className="empty">No stories in the trash.</div>
            ) : (
              <ul className="trash-list" aria-label="Deleted stories">
                {deletedStories.map(item => renderTrashItem(item))}
              </ul>
            )}
          </div>

          <div className="trash-section">
            <h4 className="character-section-heading">
              {story ? `Deleted from “${story.title}”` : 'Deleted items'}
            </h4>

            {!story ? (
              <div className="empty">Select a story to see what was deleted from it.</div>
            ) : trash.length === 0 ? (
              <div className="empty">Nothing deleted from this story.</div>
            ) : (
              <ul className="trash-list" aria-label="Deleted from this story">
                {trash.map(item => renderTrashItem(item))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
