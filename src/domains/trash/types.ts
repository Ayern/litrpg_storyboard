// What the trash lists: one row per deleted thing.

// One deleted row. `kind` is what it was, `story_id` is the story it belonged to
// (its own id for a story), so the trash can tell a restore where to look.
// `detail` names what a permanent delete would take with the row, in the
// author's words, and is absent when it would take nothing else.
export interface DeletedItem {
  id: string;
  kind: string;
  label: string;
  story_id: string;
  deleted_at: string;
  detail?: string | null;
}
