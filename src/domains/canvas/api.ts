import { invoke } from '@tauri-apps/api/core';
import type { IndexedEdge, IndexedNode } from './types';

// The board as the database keeps it. A card and the line between two cards are
// the only two rows the canvas writes; everything drawn on them is derived.

export function getGraphNodes(storyId: string) {
  return invoke<IndexedNode[]>('get_graph_nodes', { storyId });
}

export function getGraphEdges(storyId: string) {
  return invoke<IndexedEdge[]>('get_graph_edges', { storyId });
}

// The cast member is optional, so a card can be drawn before its owner exists.
// The link is only sent when there is one: an unowned card is written without
// the field at all, which is how the board has always written it.
export function createGraphNode(
  storyId: string,
  nodeType: string,
  label: string,
  content: string | null,
  posX: number,
  posY: number,
  actor: string,
  characterId: string | null = null
) {
  return invoke<IndexedNode>('create_graph_node', {
    storyId,
    nodeType,
    label,
    content,
    posX,
    posY,
    createdBy: actor,
    ...(characterId === null ? {} : { characterId }),
  });
}

export function updateGraphNode(
  id: string,
  label: string,
  content: string | null,
  actor: string
) {
  return invoke<IndexedNode>('update_graph_node', { id, label, content, user: actor });
}

export function updateGraphNodePosition(
  id: string,
  posX: number,
  posY: number,
  actor: string
) {
  return invoke<void>('update_graph_node_position', { id, posX, posY, user: actor });
}

// Answers with the row as it now stands, so the card can show the new link
// without reading the node again.
export function setNodeCharacter(
  nodeId: string,
  characterId: string | null,
  actor: string
) {
  return invoke<IndexedNode>('set_node_character', { nodeId, characterId, user: actor });
}

export function deleteNode(id: string, actor: string) {
  return invoke<void>('delete_node', { id, user: actor });
}

export function createGraphEdge(
  storyId: string,
  sourceId: string,
  targetId: string,
  label: string | null,
  relationType: string | null,
  actor: string
) {
  return invoke<IndexedEdge>('create_graph_edge', {
    storyId,
    sourceId,
    targetId,
    label,
    relationType,
    createdBy: actor,
  });
}

export function updateGraphEdge(
  id: string,
  label: string | null,
  relationType: string | null,
  actor: string
) {
  return invoke<IndexedEdge>('update_graph_edge', { id, label, relationType, user: actor });
}

export function deleteEdge(id: string, actor: string) {
  return invoke<void>('delete_edge', { id, user: actor });
}
