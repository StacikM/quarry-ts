import { itemName } from "../world/blockStates";
import { maxStackSize } from "../world/itemStacks";

/**
 * What a player carries, numbered like the slots of the client's own inventory window:
 * 0 crafting result, 1-4 crafting grid, 5-8 armor, 9-35 the main part, 36-44 the hotbar, 45 the off hand.
 * Supported names, lore, enchantments, dye, damage and unbreakability travel with each stack.
 */
export interface ItemStack {
  itemId: number;
  count: number;
  customName?: string;
  lore?: string[];
  enchantments?: Record<string, number>;
  dyedColor?: number;
  unbreakable?: boolean;
  damage?: number;
  potionEffects?: Array<{ name: string; amplifier: number; durationTicks: number }>;
}

export const SLOT_COUNT = 46;
export const MAIN_START = 9;
export const HOTBAR_START = 36;
export const HOTBAR_END = 44;

export class Inventory {
  private readonly slots: Array<ItemStack | null> = new Array(SLOT_COUNT).fill(null);

  get(slot: number): ItemStack | null {
    return cloneStack(this.slots[slot] ?? null);
  }

  /** Puts a stack (or nothing) in a slot. Returns false for a slot number that does not exist. */
  set(slot: number, stack: ItemStack | null): boolean {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) return false;
    if (stack && (!Number.isInteger(stack.count) || stack.count < 1 || stack.count > maxStackSize(itemName(stack.itemId)) || !Number.isInteger(stack.itemId) || itemName(stack.itemId) === undefined)) return false;
    this.slots[slot] = cloneStack(stack);
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
    if (!Number.isSafeInteger(count) || count < 0 || itemName(itemId) === undefined) throw new Error("Invalid item or count");
    const limit = maxStackSize(itemName(itemId));
    const order = [...range(HOTBAR_START, HOTBAR_END), ...range(MAIN_START, HOTBAR_START - 1)];
    const changed: number[] = [];
    let left = count;

    for (const slot of order) {
      const stack = this.slots[slot];
      if (left <= 0) break;
      if (!stack || !sameItem(stack, { itemId, count: 1 }) || stack.count >= limit) continue;
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

/** Copy at ownership boundaries so callers cannot mutate stored stacks. */
export function cloneStack(stack: ItemStack | null): ItemStack | null {
  return stack ? { ...stack, ...(stack.enchantments ? { enchantments: { ...stack.enchantments } } : {}), ...(stack.lore ? { lore: [...stack.lore] } : {}), ...(stack.potionEffects ? { potionEffects: stack.potionEffects.map(effect => ({ ...effect })) } : {}) } : null;
}
export function sameItem(a: ItemStack | null, b: ItemStack | null): boolean {
  if (!a || !b) return a === b;
  const canonical = (s: ItemStack) => JSON.stringify(Object.entries({ ...s, count: 0, enchantments: s.enchantments ? Object.entries(s.enchantments).sort() : undefined }).filter(([, v]) => v !== undefined).sort(([a], [b]) => String(a).localeCompare(String(b))));
  return canonical(a) === canonical(b);
}
