import { itemName } from "../world/blockStates";
import { maxStackSize } from "../world/itemStacks";

/**
 * What a player carries, numbered like the slots of the client's own inventory window:
 * 0 crafting result, 1-4 crafting grid, 5-8 armor, 9-35 the main part, 36-44 the hotbar, 45 the off hand.
 * Only items and counts are tracked (no names, enchantments or other item data).
 */
export interface ItemStack {
  itemId: number;
  count: number;
}

export const SLOT_COUNT = 46;
export const MAIN_START = 9;
export const HOTBAR_START = 36;
export const HOTBAR_END = 44;

export class Inventory {
  private readonly slots: Array<ItemStack | null> = new Array(SLOT_COUNT).fill(null);

  get(slot: number): ItemStack | null {
    return this.slots[slot] ?? null;
  }

  /** Puts a stack (or nothing) in a slot. Returns false for a slot number that does not exist. */
  set(slot: number, stack: ItemStack | null): boolean {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) return false;
    this.slots[slot] = stack && stack.count > 0 && stack.itemId >= 0 ? { itemId: stack.itemId, count: stack.count } : null;
    return true;
  }

  /** The hotbar slot (0-8) that holds this item, or -1. */
  findInHotbar(itemId: number): number {
    for (let i = 0; i < 9; i++) if (this.slots[HOTBAR_START + i]?.itemId === itemId) return i;
    return -1;
  }

  /**
   * Adds items the way the game does: first onto stacks of the same item that have room, then into empty
   * slots, the hotbar before the main part. Returns what did not fit and which slots changed.
   */
  add(itemId: number, count: number): { leftover: number; changed: number[] } {
    const limit = maxStackSize(itemName(itemId));
    const order = [...range(HOTBAR_START, HOTBAR_END), ...range(MAIN_START, HOTBAR_START - 1)];
    const changed: number[] = [];
    let left = count;

    for (const slot of order) {
      const stack = this.slots[slot];
      if (left <= 0) break;
      if (!stack || stack.itemId !== itemId || stack.count >= limit) continue;
      const moved = Math.min(left, limit - stack.count);
      stack.count += moved;
      left -= moved;
      changed.push(slot);
    }
    for (const slot of order) {
      if (left <= 0) break;
      if (this.slots[slot]) continue;
      const moved = Math.min(left, limit);
      this.slots[slot] = { itemId, count: moved };
      left -= moved;
      changed.push(slot);
    }
    return { leftover: left, changed };
  }

  /** The slot in the hotbar (0-8) a picked block should go in: the selected one if it is empty, else the first empty one, else the selected one. */
  slotForPicked(selected: number): number {
    if (!this.slots[HOTBAR_START + selected]) return selected;
    for (let i = 0; i < 9; i++) if (!this.slots[HOTBAR_START + i]) return i;
    return selected;
  }
}

function range(from: number, to: number): number[] {
  const numbers: number[] = [];
  for (let i = from; i <= to; i++) numbers.push(i);
  return numbers;
}
