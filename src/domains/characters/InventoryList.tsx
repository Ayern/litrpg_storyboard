import type { Node } from 'reactflow';
import { formatCount } from '../../lib/format';
import type { NodeData } from '../canvas/types';
import type { ChapterNode } from '../narrative/chapters';
import type { InventoryItem } from '../inventory/types';

// The sheet's inventory: a ledger, not a game engine. A row is a name, a
// rarity, how many the character carries, what it does, where it was found and,
// if it is gone, where it was lost. The card column is what puts the row on an
// item card on the board, so the two views name the same item.
//
// Everything the rows read arrives as a prop, including the chapter and card
// labels they look up by id - a chapter or a card in the trash is shown as such
// rather than silently dropped. The drafts and the writes they feed stay in the
// app, so an add, a save and a delete keep their single audited step.

export interface InventoryListProps {
  items: InventoryItem[];
  // The chapters and the item cards a row can point at.
  chapters: ChapterNode[];
  cards: Node<NodeData>[];
  editingItemId: string | null;
  setEditingItemId: (itemId: string | null) => void;
  itemNameDraft: string;
  setItemNameDraft: (name: string) => void;
  itemRarityDraft: string;
  setItemRarityDraft: (rarity: string) => void;
  itemQuantityDraft: string;
  setItemQuantityDraft: (quantity: string) => void;
  itemEffectDraft: string;
  setItemEffectDraft: (effect: string) => void;
  itemChapterDraft: string;
  setItemChapterDraft: (chapterId: string) => void;
  itemLostChapterDraft: string;
  setItemLostChapterDraft: (chapterId: string) => void;
  itemNodeDraft: string;
  setItemNodeDraft: (nodeId: string) => void;
  startItemEdit: (item: InventoryItem) => void;
  saveItem: (item: InventoryItem) => Promise<void>;
  removeItem: (item: InventoryItem) => Promise<void>;
  newItemName: string;
  setNewItemName: (name: string) => void;
  newItemRarity: string;
  setNewItemRarity: (rarity: string) => void;
  newItemQuantity: string;
  setNewItemQuantity: (quantity: string) => void;
  newItemEffect: string;
  setNewItemEffect: (effect: string) => void;
  newItemChapterId: string;
  setNewItemChapterId: (chapterId: string) => void;
  newItemLostChapterId: string;
  setNewItemLostChapterId: (chapterId: string) => void;
  newItemNodeId: string;
  setNewItemNodeId: (nodeId: string) => void;
  addItem: () => Promise<void>;
}

export function InventoryList({
  items,
  chapters,
  cards,
  editingItemId,
  setEditingItemId,
  itemNameDraft,
  setItemNameDraft,
  itemRarityDraft,
  setItemRarityDraft,
  itemQuantityDraft,
  setItemQuantityDraft,
  itemEffectDraft,
  setItemEffectDraft,
  itemChapterDraft,
  setItemChapterDraft,
  itemLostChapterDraft,
  setItemLostChapterDraft,
  itemNodeDraft,
  setItemNodeDraft,
  startItemEdit,
  saveItem,
  removeItem,
  newItemName,
  setNewItemName,
  newItemRarity,
  setNewItemRarity,
  newItemQuantity,
  setNewItemQuantity,
  newItemEffect,
  setNewItemEffect,
  newItemChapterId,
  setNewItemChapterId,
  newItemLostChapterId,
  setNewItemLostChapterId,
  newItemNodeId,
  setNewItemNodeId,
  addItem,
}: InventoryListProps) {
  return (
    <div className="inventory-section">
      <h4 className="character-section-heading">Inventory</h4>

      <div className="inventory-list">
        {items.length === 0 && (
          <div className="empty">No items yet — add one below.</div>
        )}

        {items.map(item => {
          const chapter = chapters.find(choice => choice.id === item.chapter_id);
          const card = cards.find(choice => choice.id === item.node_id);
          const lostChapter = chapters.find(
            choice => choice.id === item.lost_chapter_id
          );

          return (
            <div key={item.id} className="inventory-row">
              {editingItemId === item.id ? (
                <div className="inventory-editor">
                  <input
                    aria-label="Item name"
                    autoFocus
                    value={itemNameDraft}
                    onChange={(e) => setItemNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveItem(item);
                      if (e.key === 'Escape') setEditingItemId(null);
                    }}
                  />
                  <input
                    aria-label="Item rarity"
                    placeholder="Rarity (optional)"
                    value={itemRarityDraft}
                    onChange={(e) => setItemRarityDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveItem(item);
                      if (e.key === 'Escape') setEditingItemId(null);
                    }}
                  />
                  <input
                    aria-label="Item quantity"
                    type="number"
                    min={0}
                    step={1}
                    title="How many of this item the character carries"
                    value={itemQuantityDraft}
                    onChange={(e) => setItemQuantityDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveItem(item);
                      if (e.key === 'Escape') setEditingItemId(null);
                    }}
                  />
                  <input
                    aria-label="Item effect"
                    placeholder="Effect (optional)"
                    value={itemEffectDraft}
                    onChange={(e) => setItemEffectDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveItem(item);
                      if (e.key === 'Escape') setEditingItemId(null);
                    }}
                  />
                  <select
                    aria-label="Item chapter acquired"
                    title="The chapter this item was acquired in"
                    value={itemChapterDraft}
                    onChange={(e) => setItemChapterDraft(e.target.value)}
                  >
                    <option value="">No chapter</option>
                    {itemChapterDraft &&
                      !chapters.some(choice => choice.id === itemChapterDraft) && (
                        <option value={itemChapterDraft}>
                          Chapter in the trash
                        </option>
                      )}
                    {chapters.map(choice => (
                      <option key={choice.id} value={choice.id}>
                        {choice.data.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Item chapter lost"
                    title="The chapter this item was lost in"
                    value={itemLostChapterDraft}
                    onChange={(e) => setItemLostChapterDraft(e.target.value)}
                  >
                    <option value="">Not lost</option>
                    {itemLostChapterDraft &&
                      !chapters.some(
                        choice => choice.id === itemLostChapterDraft
                      ) && (
                        <option value={itemLostChapterDraft}>
                          Chapter in the trash
                        </option>
                      )}
                    {chapters.map(choice => (
                      <option key={choice.id} value={choice.id}>
                        {choice.data.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Item card"
                    title="The item card this row belongs to"
                    value={itemNodeDraft}
                    onChange={(e) => setItemNodeDraft(e.target.value)}
                  >
                    <option value="">No card</option>
                    {itemNodeDraft &&
                      !cards.some(choice => choice.id === itemNodeDraft) && (
                        <option value={itemNodeDraft}>Card in the trash</option>
                      )}
                    {cards.map(choice => (
                      <option key={choice.id} value={choice.id}>
                        {choice.data.label}
                      </option>
                    ))}
                  </select>
                  <div className="inventory-actions">
                    <button
                      title={`Save this ${item.name}`}
                      onClick={() => saveItem(item)}
                    >
                      Save item
                    </button>
                    <button
                      title="Leave the item as it was"
                      onClick={() => setEditingItemId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="inventory-summary">
                    <span className="inventory-name">{item.name}</span>
                    <span className="inventory-quantity">
                      ×{formatCount(item.quantity)}
                    </span>
                    {item.rarity && (
                      <span className="inventory-rarity">{item.rarity}</span>
                    )}
                    {item.effect && (
                      <span className="inventory-effect">{item.effect}</span>
                    )}
                    <span className="inventory-chapter">
                      {chapter
                        ? `Found in ${chapter.data.label}`
                        : item.chapter_id
                          ? 'Chapter in the trash'
                          : 'Chapter not recorded'}
                    </span>
                    {item.lost_chapter_id && (
                      <span className="inventory-lost">
                        {lostChapter
                          ? `Lost in ${lostChapter.data.label}`
                          : 'Lost in a chapter in the trash'}
                      </span>
                    )}
                    {card && (
                      <span className="inventory-card-link">
                        Card: {card.data.label}
                      </span>
                    )}
                  </div>
                  <button
                    title={`Change ${item.name}'s rarity, quantity, effect or chapter`}
                    onClick={() => startItemEdit(item)}
                  >
                    Edit
                  </button>
                  <button
                    title={`Delete ${item.name}`}
                    onClick={() => removeItem(item)}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="inventory-creator">
        <input
          aria-label="New item name"
          placeholder="Item"
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addItem()}
        />
        <input
          aria-label="New item rarity"
          placeholder="Rarity"
          value={newItemRarity}
          onChange={(e) => setNewItemRarity(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addItem()}
        />
        <input
          aria-label="New item quantity"
          type="number"
          min={0}
          step={1}
          title="How many of this item the character carries"
          value={newItemQuantity}
          onChange={(e) => setNewItemQuantity(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addItem()}
        />
        <input
          aria-label="New item effect"
          placeholder="Effect"
          value={newItemEffect}
          onChange={(e) => setNewItemEffect(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addItem()}
        />
        <select
          aria-label="New item chapter"
          title="The chapter this item was acquired in"
          value={newItemChapterId}
          onChange={(e) => setNewItemChapterId(e.target.value)}
        >
          <option value="">No chapter</option>
          {chapters.map(choice => (
            <option key={choice.id} value={choice.id}>
              {choice.data.label}
            </option>
          ))}
        </select>
        <select
          aria-label="New item lost chapter"
          title="The chapter this item was lost in"
          value={newItemLostChapterId}
          onChange={(e) => setNewItemLostChapterId(e.target.value)}
        >
          <option value="">Not lost</option>
          {chapters.map(choice => (
            <option key={choice.id} value={choice.id}>
              {choice.data.label}
            </option>
          ))}
        </select>
        <select
          aria-label="New item card"
          title="The item card this row belongs to"
          value={newItemNodeId}
          onChange={(e) => setNewItemNodeId(e.target.value)}
        >
          <option value="">No card</option>
          {cards.map(choice => (
            <option key={choice.id} value={choice.id}>
              {choice.data.label}
            </option>
          ))}
        </select>
        <button
          title="Add this item to the selected character"
          onClick={addItem}
          disabled={!newItemName.trim()}
        >
          Add item
        </button>
      </div>
    </div>
  );
}
