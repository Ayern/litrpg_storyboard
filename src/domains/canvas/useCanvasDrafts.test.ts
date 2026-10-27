import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Edge, Node } from 'reactflow';

import { useCanvasDrafts } from './useCanvasDrafts';
import type { CanvasDraftsOptions } from './useCanvasDrafts';
import type { EdgeData, NodeData } from './types';

// The hook holds what the author is editing on the canvas: which card or
// connection is open, the text in its fields, and the half-written drafts
// remembered per card. Whether that text is unsaved is measured against the
// board, so the board is handed in and these tests move it the way the app does.
// Nothing here writes to the database, so no command is mocked: what is held to
// is which editor is open, what its fields hold, and what happens to the text
// when something else decides where it goes.

function node(id: string, label: string, content: string | null = null): Node<NodeData> {
  return {
    id,
    type: 'default',
    position: { x: 0, y: 0 },
    data: { label, nodeType: 'character', content: content ?? undefined, createdBy: 'author' },
  };
}

function edge(id: string, label: string | null, relationType: string | null) {
  return {
    id,
    source: 'n-1',
    target: 'n-2',
    data: {
      label: label ?? undefined,
      relationType: relationType ?? undefined,
      createdBy: 'author',
    },
  } as Edge<EdgeData>;
}

const board: CanvasDraftsOptions = {
  nodes: [node('n-1', 'Mira', 'Bearer of the ledger'), node('n-2', 'Rook')],
  edges: [
    edge('e-1', 'unlocks', 'unlocks'),
    // A line with nothing on it, which is how a bare connection reads.
    edge('e-2', null, null),
  ],
};

function open(initial: CanvasDraftsOptions = board) {
  return renderHook((props: CanvasDraftsOptions) => useCanvasDrafts(props), {
    initialProps: initial,
  });
}

type Harness = ReturnType<typeof open>;

// The same card the board is holding, which is how the app opens one: a click on
// a card hands over what that card says.
function openCard(result: Harness['result'], id = 'n-1') {
  const card = board.nodes.find(candidate => candidate.id === id);
  if (!card) throw new Error(`no card ${id} on the board`);

  act(() =>
    result.current.openNode({
      id: card.id,
      label: card.data.label,
      content: card.data.content ?? null,
    })
  );
}

describe('useCanvasDrafts', () => {
  it('opens a card with what the board says and closes the connection editor', () => {
    const { result } = open();

    act(() => result.current.openEdge({ id: 'e-1', label: 'unlocks' }));
    expect(result.current.selectedEdgeId).toBe('e-1');

    // Both editors occupy the same corner of the canvas, so one at a time.
    openCard(result);

    expect(result.current.selectedNodeId).toBe('n-1');
    expect(result.current.selectedEdgeId).toBeNull();
    expect(result.current.selectedNode?.id).toBe('n-1');
    expect(result.current.nodeLabelDraft).toBe('Mira');
    expect(result.current.nodeContentDraft).toBe('Bearer of the ledger');
    expect(result.current.nodeDirty).toBe(false);
  });

  it('opens a card that has no notes with an empty field', () => {
    const { result } = open();

    act(() => result.current.openNode({ id: 'n-2', label: 'Rook' }));

    expect(result.current.nodeContentDraft).toBe('');
  });

  it('brings a half-written draft back when the card is reopened', () => {
    const { result } = open();

    openCard(result);
    act(() => {
      result.current.setNodeLabelDraft('Mira Vance');
      result.current.rememberNodeDraft('n-1', { label: 'Mira Vance', content: 'Bearer' });
    });

    // Looking at another card, or switching story, keeps the text for this
    // session; only a discard or a save lets it go.
    act(() => result.current.openNode({ id: 'n-2', label: 'Rook' }));
    expect(result.current.selectedNodeId).toBe('n-2');

    openCard(result);

    expect(result.current.nodeLabelDraft).toBe('Mira Vance');
    expect(result.current.nodeContentDraft).toBe('Bearer');
    expect(result.current.nodeDirty).toBe(true);
  });

  it('calls a card dirty for a changed label or for notes that differ', () => {
    const { result } = open();

    openCard(result);
    expect(result.current.nodeDirty).toBe(false);

    // A label is the author's exact words, so a trailing space is a change.
    act(() => result.current.setNodeLabelDraft('Mira '));
    expect(result.current.nodeDirty).toBe(true);

    act(() => result.current.setNodeLabelDraft('Mira'));
    expect(result.current.nodeDirty).toBe(false);

    act(() => result.current.setNodeContentDraft('Bearer of the ledger'));
    expect(result.current.nodeDirty).toBe(false);

    // Notes are compared trimmed: an empty field and no notes are the same.
    act(() => result.current.setNodeContentDraft('Bearer of the ledger\n'));
    expect(result.current.nodeDirty).toBe(false);

    act(() => result.current.setNodeContentDraft('Bearer of the ledger and the vault'));
    expect(result.current.nodeDirty).toBe(true);
  });

  it('asks before closing a card with unsaved text, and not otherwise', () => {
    const { result } = open();

    openCard(result);
    act(() => result.current.closeNode());
    expect(result.current.selectedNodeId).toBeNull();
    expect(result.current.closePrompt).toBe(false);

    openCard(result);
    act(() => result.current.setNodeLabelDraft('Mira Vance'));
    act(() => result.current.closeNode());

    // Still open, and asking.
    expect(result.current.selectedNodeId).toBe('n-1');
    expect(result.current.closePrompt).toBe(true);

    act(() => result.current.setClosePrompt(false));
    expect(result.current.closePrompt).toBe(false);
  });

  it('closes without asking when a save or a discard already decided', () => {
    const { result } = open();

    openCard(result);
    act(() => result.current.setNodeLabelDraft('Mira Vance'));
    act(() => result.current.dismissNode());

    expect(result.current.selectedNodeId).toBeNull();
    expect(result.current.closePrompt).toBe(false);
  });

  it('forgets a discarded draft so the card does not offer it back', () => {
    const { result } = open();

    openCard(result);
    act(() => {
      result.current.setNodeContentDraft('half a thought');
      result.current.rememberNodeDraft('n-1', { label: 'Mira', content: 'half a thought' });
    });
    act(() => result.current.discardNode());

    openCard(result);

    expect(result.current.nodeContentDraft).toBe('Bearer of the ledger');
    expect(result.current.nodeDirty).toBe(false);
  });

  it('keeps the notes typed since when the label alone was written', () => {
    const { result } = open();

    openCard(result);
    act(() => {
      result.current.setNodeContentDraft('notes kept');
      result.current.rememberNodeDraft('n-1', { label: 'Mira', content: 'notes kept' });
    });

    act(() => result.current.rememberLabelWritten('n-1', 'Mira Vance'));
    act(() => result.current.closeEditors());
    openCard(result);

    // The new label arrived; the notes the author had typed did not go with it.
    expect(result.current.nodeLabelDraft).toBe('Mira Vance');
    expect(result.current.nodeContentDraft).toBe('notes kept');
  });

  it('has nothing to keep when no draft was remembered for the card', () => {
    const { result } = open();

    openCard(result);
    act(() => result.current.rememberLabelWritten('n-2', 'Rook Vance'));

    expect(result.current.nodeLabelDraft).toBe('Mira');
  });

  it('drops every remembered draft when the database is replaced', () => {
    const { result } = open();

    openCard(result);
    act(() => result.current.rememberNodeDraft('n-1', { label: 'Mira Vance', content: '' }));
    act(() => result.current.forgetNodeDraft('n-1'));
    act(() => result.current.rememberNodeDraft('n-1', { label: 'Mira again', content: '' }));
    act(() => result.current.forgetRememberedDrafts());

    openCard(result);

    expect(result.current.nodeLabelDraft).toBe('Mira');
  });

  it('forgets one card\u2019s draft without touching the others', () => {
    const { result } = open();

    act(() => {
      result.current.rememberNodeDraft('n-1', { label: 'Mira Vance', content: '' });
      result.current.rememberNodeDraft('n-2', { label: 'Rook Vance', content: '' });
      result.current.forgetNodeDraft('n-1');
    });

    act(() => result.current.openNode({ id: 'n-1', label: 'Mira' }));
    expect(result.current.nodeLabelDraft).toBe('Mira');

    act(() => result.current.openNode({ id: 'n-2', label: 'Rook' }));
    expect(result.current.nodeLabelDraft).toBe('Rook Vance');
  });

  it('opens a connection with the verb it carries', () => {
    const { result } = open();

    openCard(result);
    act(() => result.current.openEdge({ id: 'e-1', label: 'unlocks', relationType: 'unlocks' }));

    expect(result.current.selectedEdgeId).toBe('e-1');
    expect(result.current.selectedNodeId).toBeNull();
    expect(result.current.selectedEdge).not.toBeNull();
    expect(result.current.edgeLabelDraft).toBe('unlocks');
    expect(result.current.edgeRelationDraft).toBe('unlocks');
    expect(result.current.edgeDirty).toBe(false);
  });

  it('calls a connection dirty only when its fields would write something else', () => {
    const { result } = open();

    act(() => result.current.openEdge({ id: 'e-2' }));
    expect(result.current.edgeDirty).toBe(false);

    // A line with no label and one with spaces in its label are the same line.
    act(() => result.current.setEdgeLabelDraft('  '));
    expect(result.current.edgeDirty).toBe(false);

    act(() => result.current.setEdgeRelationDraft('requires'));
    expect(result.current.edgeDirty).toBe(true);
  });

  it('carries a message only for the editor it belongs to', () => {
    const { result } = open();

    openCard(result);
    act(() => result.current.setNodeEditError('A node needs a label.'));

    // Opening a connection is not a second try at the card, so the card's
    // message stays until the card itself is opened again.
    act(() => result.current.openEdge({ id: 'e-1' }));
    expect(result.current.nodeEditError).toBe('A node needs a label.');

    openCard(result);
    expect(result.current.nodeEditError).toBeNull();

    act(() => result.current.setEdgeEditError('A bond keeps its type'));
    act(() => result.current.openEdge({ id: 'e-1' }));
    expect(result.current.edgeEditError).toBeNull();
  });

  it('closes both editors at once, as a story switch does', () => {
    const { result } = open();

    openCard(result);
    act(() => result.current.closeEditors());

    expect(result.current.selectedNodeId).toBeNull();
    expect(result.current.selectedEdgeId).toBeNull();
  });

  it('closes the editors a deletion took away', () => {
    const { result } = open();

    openCard(result);
    act(() => result.current.cardsRemoved(new Set(['n-2'])));
    expect(result.current.selectedNodeId).toBe('n-1');

    act(() => result.current.cardsRemoved(new Set(['n-1'])));
    expect(result.current.selectedNodeId).toBeNull();

    act(() => result.current.edgesRemoved(new Set(['e-9'])));
    act(() => result.current.openEdge({ id: 'e-1' }));
    act(() => result.current.edgesRemoved(new Set(['e-9'])));
    expect(result.current.selectedEdgeId).toBe('e-1');

    act(() => result.current.edgesRemoved(new Set(['e-1'])));
    expect(result.current.selectedEdgeId).toBeNull();
  });

  it('closes a line\u2019s editor when a card it ended on is deleted', () => {
    const { result } = open();

    // A connection open on the board, then a card taken away from under it. The
    // database takes that connection with the card, so the editor cannot stay.
    act(() => result.current.openEdge({ id: 'e-1', label: 'unlocks' }));
    act(() => result.current.cardsRemoved(new Set(['n-1'])));

    expect(result.current.selectedEdgeId).toBeNull();
  });

  it('follows a stored row when the editor holds nothing unsaved', () => {
    const { result } = open();

    openCard(result);
    act(() =>
      result.current.followStoredRows({
        nodes: [{ id: 'n-1', label: 'Mira Vance', content: 'Renamed' }],
        edges: [],
      })
    );

    expect(result.current.nodeLabelDraft).toBe('Mira Vance');
    expect(result.current.nodeContentDraft).toBe('Renamed');
  });

  it('leaves typing alone when the stored row changes under it', () => {
    const { result } = open();

    openCard(result);
    act(() => result.current.setNodeLabelDraft('Mira of the Vault'));

    act(() =>
      result.current.followStoredRows({
        nodes: [{ id: 'n-1', label: 'Mira Vance', content: 'Renamed' }],
        edges: [],
      })
    );

    expect(result.current.nodeLabelDraft).toBe('Mira of the Vault');
    expect(result.current.nodeContentDraft).toBe('Bearer of the ledger');
  });

  it('follows a connection row the same way', () => {
    const { result } = open();

    act(() => result.current.openEdge({ id: 'e-1', label: 'unlocks', relationType: 'unlocks' }));
    act(() =>
      result.current.followStoredRows({
        nodes: [],
        edges: [{ id: 'e-1', label: 'opens', relation_type: 'requires' }],
      })
    );

    expect(result.current.edgeLabelDraft).toBe('opens');
    expect(result.current.edgeRelationDraft).toBe('requires');

    act(() => result.current.setEdgeLabelDraft('half typed'));
    act(() =>
      result.current.followStoredRows({
        nodes: [],
        edges: [{ id: 'e-1', label: 'opens again', relation_type: 'requires' }],
      })
    );

    expect(result.current.edgeLabelDraft).toBe('half typed');
  });

  it('does nothing for an editor that is not open', () => {
    const { result } = open();

    act(() =>
      result.current.followStoredRows({
        nodes: [{ id: 'n-1', label: 'Mira Vance', content: null }],
        edges: [{ id: 'e-1', label: 'opens', relation_type: null }],
      })
    );

    expect(result.current.nodeLabelDraft).toBe('');
    expect(result.current.edgeLabelDraft).toBe('');
  });

  it('measures the drafts against the board as it stands now', () => {
    const { result, rerender } = open();

    openCard(result);
    act(() => result.current.setNodeLabelDraft('Mira of the Vault'));
    expect(result.current.nodeDirty).toBe(true);

    // The board moves under the open editor, as it does when a save writes the
    // card and the row comes back.
    rerender({ nodes: [node('n-1', 'Mira of the Vault', 'Bearer of the ledger')], edges: [] });

    // The same text is no longer an edit, because the card now says it.
    expect(result.current.nodeDirty).toBe(false);

    act(() =>
      result.current.followStoredRows({
        nodes: [{ id: 'n-1', label: 'Mira of the Vault', content: 'Renamed' }],
        edges: [],
      })
    );

    expect(result.current.nodeContentDraft).toBe('Renamed');
  });
});
