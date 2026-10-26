// What the trash lists: one row per deleted thing.

// One deleted row. `kind` is what it was, `story_id` is the story it belonged to
// (its own id for a story), so the trash can tell a restore where to look.
export interface DeletedItem {
  id: string;
  kind: string;
  label: string;
  story_id: string;
  deleted_at: string;
}
