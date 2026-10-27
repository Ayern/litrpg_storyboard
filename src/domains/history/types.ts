// The history domain's vocabulary: one recorded action, with the commands that
// walk it in either direction.

// One recorded action, with the commands that walk it backwards and forwards.
// The closures call the ordinary commands, so an undo is an audited change like
// any other rather than a quiet rewrite of the database.
export interface UndoStep {
  label: string;
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
  // Said after a successful undo only. A step whose work left something else
  // behind — a chapter's connections, which are restored separately — names it
  // here, so the notice says where the rest went.
  undoNote?: string;
}
