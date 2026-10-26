import { invoke } from '@tauri-apps/api/core';
import type { CharacterCurrency, InventoryItem } from './types';

// What a cast member carries and what they hold it in. An item records the
// chapter it was picked up in and, when the author says so, the chapter it was
// lost in, so a card can show both ends of its life.

export function getStoryInventory(storyId: string) {
  return invoke<InventoryItem[]>('get_story_inventory', { storyId });
}

export function getCharacterInventory(characterId: string) {
  return invoke<InventoryItem[]>('get_character_inventory', { characterId });
}

export function addInventoryItem(
  characterId: string,
  name: string,
  rarity: string | null,
  quantity: number,
  effect: string | null,
  chapterId: string | null,
  lostChapterId: string | null,
  nodeId: string | null,
  actor: string
) {
  return invoke<InventoryItem>('add_inventory_item', {
    characterId,
    name,
    rarity,
    quantity,
    effect,
    chapterId,
    lostChapterId,
    nodeId,
    user: actor,
  });
}

export function updateInventoryItem(
  id: string,
  name: string,
  rarity: string | null,
  quantity: number,
  effect: string | null,
  chapterId: string | null,
  lostChapterId: string | null,
  nodeId: string | null,
  actor: string
) {
  return invoke<InventoryItem>('update_inventory_item', {
    id,
    name,
    rarity,
    quantity,
    effect,
    chapterId,
    lostChapterId,
    nodeId,
    user: actor,
  });
}

export function deleteInventoryItem(id: string, actor: string) {
  return invoke<void>('delete_inventory_item', { id, user: actor });
}

export function getCharacterCurrency(characterId: string) {
  return invoke<CharacterCurrency[]>('get_character_currency', { characterId });
}

export function addCurrency(characterId: string, name: string, amount: number, actor: string) {
  return invoke<CharacterCurrency>('add_currency', { characterId, name, amount, user: actor });
}

export function updateCurrency(id: string, name: string, amount: number, actor: string) {
  return invoke<CharacterCurrency>('update_currency', { id, name, amount, user: actor });
}

export function deleteCurrency(id: string, actor: string) {
  return invoke<void>('delete_currency', { id, user: actor });
}
