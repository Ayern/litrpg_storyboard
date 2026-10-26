// What a cast member carries, and what they hold it in.

// One item a cast member carries. Rarity and effect are the author's words, the
// quantity is how many, the chapter is where it was acquired, and the lost
// chapter is where it left their hands.
export interface InventoryItem {
  id: string;
  character_id: string;
  name: string;
  rarity: string | null;
  quantity: number;
  effect: string | null;
  chapter_id: string | null;
  lost_chapter_id: string | null;
  node_id: string | null;
  created_at: string;
  updated_at: string;
}

// A named currency a cast member holds. No exchange rate is implied.
export interface CharacterCurrency {
  id: string;
  character_id: string;
  name: string;
  amount: number;
  created_at: string;
  updated_at: string;
}
