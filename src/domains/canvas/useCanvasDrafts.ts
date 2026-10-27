import { useCallback, useEffect, useRef, useState } from 'react';
import type { Edge, Node } from 'reactflow';
import type { EdgeData, NodeData } from './types';

// What the author is editing on the canvas: which card or connection is open,
// the label and notes its fields hold, and the half-written text remembered for
// the cards visited this session. Only one editor is open at a time, because
// both occupy the same corner of the canvas.
//
// Whether a field holds something unsaved is measured against the row the board
// is showing, so the board comes in as an argument and the answers come back
// out. Nothing here writes to the database: a save is the app's, with its
// history step and its audit entry. What the hook keeps is the text and the rule
// that an open editor follows the stored row unless it holds typing the author
// has not saved.

export interface CanvasDraftsOptions {
  // The board as the app holds it, which is what says whether the open editor's
  // fields have moved away from it.
  nodes: Node<NodeData>[];
  edges: Edge<EdgeData>[];
}

// The label and notes of one card, as a half-written edit left them.
interface NodeDraft {
  label: string;
  content: string;
}

// A relink can leave a card named after the cast member it no longer points at.
// The label is the author's, so this offers a rename instead of taking one.
export interface RenameOffer {
  nodeId: string;
  from: string;
  to: string;
}

// A card as the database stores it, or as a write answered with it. Both rows
// the canvas reads and the single row a save returns fit this.
export interface StoredNode {
  id: string;
  label: string;
  content: string | null;
}

export interface StoredEdge {
  id: string;
  label: string | null;
  relation_type: string | null;
}

// The rows a board was read from, or the one row a save wrote back.
export interface StoredRows {
  nodes: StoredNode[];
  edges: StoredEdge[];
}

// A card to open, as the board, a search result or a freshly written row gives
// it. `content` may be left out, which is how a card with no notes reads.
export interface OpenNodeRequest {
  id: string;
  label: string;
  content?: string | null;
}

export interface OpenEdgeRequest {
  id: string;
  label?: string | null;
  relationType?: string | null;
}

export function useCanvasDrafts({ nodes, edges }: CanvasDraftsOptions) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeLabelDraft, setNodeLabelDraft] = useState('');
  const [nodeContentDraft, setNodeContentDraft] = useState('');
  const [nodeEditError, setNodeEditError] = useState<string | null>(null);
  // Whether the drawer has been asked what to do with an unsaved edit.
  const [closePrompt, setClosePrompt] = useState(false);
  const [renameOffer, setRenameOffer] = useState<RenameOffer | null>(null);

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [edgeLabelDraft, setEdgeLabelDraft] = useState('');
  const [edgeRelationDraft, setEdgeRelationDraft] = useState('');
  const [edgeEditError, setEdgeEditError] = useState<string | null>(null);

  // Unsaved label and notes, per card, for this session. Closing or switching
  // away no longer has to discard them: reopening the card offers the text back.
  const rememberedRef = useRef<Record<string, NodeDraft>>({});

  const selectedNode = nodes.find(node => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find(edge => edge.id === selectedEdgeId) ?? null;

  // What the drawer's fields hold against what the card still says. A remembered
  // draft counts as unsaved, because it has not been written anywhere.
  const nodeDirty =
    selectedNode !== null &&
    (nodeLabelDraft !== selectedNode.data.label ||
      nodeContentDraft.trim() !== (selectedNode.data.content ?? ''));

  // A connection's fields are compared trimmed, and an empty one against null:
  // a line with no label and one with spaces in its label are the same line to
  // the database.
  const edgeDirty =
    selectedEdge !== null &&
    ((edgeLabelDraft.trim() || null) !== (selectedEdge.data?.label ?? null) ||
      (edgeRelationDraft.trim() || null) !== (selectedEdge.data?.relationType ?? null));

  // Read by the handlers that run outside a render, where the values above are a
  // commit behind. An editor must not be written over while it holds typing, and
  // the handlers that write a row then read the board again are exactly the ones
  // that need to know.
  const live = useRef({
    nodeId: selectedNodeId,
    nodeDirty,
    edgeId: selectedEdgeId,
    edgeDirty,
  });

  useEffect(() => {
    live.current = {
      nodeId: selectedNodeId,
      nodeDirty,
      edgeId: selectedEdgeId,
      edgeDirty,
    };
  }, [selectedNodeId, nodeDirty, selectedEdgeId, edgeDirty]);

  const rememberNodeDraft = useCallback((id: string, draft: NodeDraft) => {
    rememberedRef.current = { ...rememberedRef.current, [id]: draft };
  }, []);

  const forgetNodeDraft = useCallback((id: string) => {
    if (!rememberedRef.current[id]) return;

    const next = { ...rememberedRef.current };
    delete next[id];
    rememberedRef.current = next;
  }, []);

  // A card's label was written while notes typed into its drawer since are still
  // unsaved, so the draft remembered for it keeps those notes under the new name.
  const rememberLabelWritten = useCallback((id: string, label: string) => {
    const draft = rememberedRef.current[id];
    if (!draft) return;

    rememberedRef.current = {
      ...rememberedRef.current,
      [id]: { label, content: draft.content },
    };
  }, []);

  // A replaced database may hand the same card id to a different card, so the
  // text remembered against those ids goes with it.
  const forgetRememberedDrafts = useCallback(() => {
    rememberedRef.current = {};
  }, []);

  // Opening a card is the same gesture whether it was just created or relinked,
  // and it is where a half-written draft comes back.
  const openNode = useCallback((node: OpenNodeRequest) => {
    const draft = rememberedRef.current[node.id];

    // Picking a card closes the connection editor, because both occupy the same
    // corner of the canvas.
    setSelectedEdgeId(null);
    setNodeEditError(null);
    setSelectedNodeId(node.id);
    setNodeLabelDraft(draft?.label ?? node.label);
    setNodeContentDraft(draft?.content ?? node.content ?? '');
    setClosePrompt(false);
  }, []);

  const openEdge = useCallback((edge: OpenEdgeRequest) => {
    setEdgeEditError(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(edge.id);
    setEdgeLabelDraft(edge.label ?? '');
    setEdgeRelationDraft(edge.relationType ?? '');
  }, []);

  // Closing the drawer asks first when its fields hold something unsaved.
  const closeNode = useCallback(() => {
    if (nodeDirty) {
      setClosePrompt(true);
      return;
    }

    setClosePrompt(false);
    setSelectedNodeId(null);
  }, [nodeDirty]);

  // The drawer goes away without asking, because the save or the discard that
  // sent it away has already decided what happens to the text.
  const dismissNode = useCallback(() => {
    setClosePrompt(false);
    setSelectedNodeId(null);
  }, []);

  // Leaving with an unsaved edit: the remembered draft goes with it, so the card
  // does not offer the discarded text back.
  const discardNode = useCallback(() => {
    if (selectedNodeId) forgetNodeDraft(selectedNodeId);
    setClosePrompt(false);
    setSelectedNodeId(null);
  }, [selectedNodeId, forgetNodeDraft]);

  const closeEdge = useCallback(() => {
    setSelectedEdgeId(null);
  }, []);

  // Nothing is open any more: a story was switched, or a card or line from
  // another story cannot stay under the pointer.
  const closeEditors = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, []);

  // A card that is gone cannot stay open, and neither can a line that ended on
  // it: the database takes those connections with the card.
  const cardsRemoved = useCallback((removed: Set<string>) => {
    setSelectedNodeId(current => (current && removed.has(current) ? null : current));
    setSelectedEdgeId(null);
  }, []);

  // A line that is gone cannot stay open; the card at either end is untouched.
  const edgesRemoved = useCallback((removed: Set<string>) => {
    setSelectedEdgeId(current => (current && removed.has(current) ? null : current));
  }, []);

  // The stored rows just changed, whether the whole board was read again after an
  // undo or a save returned the row it wrote. An open editor follows what the row
  // now says, unless it holds typing the author has not saved.
  const followStoredRows = useCallback((rows: StoredRows) => {
    const open = live.current;

    if (open.nodeId && !open.nodeDirty) {
      const fresh = rows.nodes.find(row => row.id === open.nodeId);

      if (fresh) {
        setNodeLabelDraft(fresh.label);
        setNodeContentDraft(fresh.content ?? '');
      }
    }

    if (open.edgeId && !open.edgeDirty) {
      const fresh = rows.edges.find(row => row.id === open.edgeId);

      if (fresh) {
        setEdgeLabelDraft(fresh.label ?? '');
        setEdgeRelationDraft(fresh.relation_type ?? '');
      }
    }
  }, []);

  return {
    selectedNode,
    selectedEdge,
    selectedNodeId,
    selectedEdgeId,
    nodeLabelDraft,
    setNodeLabelDraft,
    nodeContentDraft,
    setNodeContentDraft,
    nodeEditError,
    setNodeEditError,
    closePrompt,
    setClosePrompt,
    renameOffer,
    setRenameOffer,
    edgeLabelDraft,
    setEdgeLabelDraft,
    edgeRelationDraft,
    setEdgeRelationDraft,
    edgeEditError,
    setEdgeEditError,
    nodeDirty,
    edgeDirty,
    openNode,
    openEdge,
    closeNode,
    dismissNode,
    discardNode,
    closeEdge,
    closeEditors,
    cardsRemoved,
    edgesRemoved,
    rememberNodeDraft,
    rememberLabelWritten,
    forgetNodeDraft,
    forgetRememberedDrafts,
    followStoredRows,
  };
}