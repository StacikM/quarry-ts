import type { Player } from './Player';
import { cloneStack, sameItem, type ItemStack } from './Inventory';
import { itemName } from '../world/blockStates';
import { maxStackSize } from '../world/itemStacks';
import { containerContent, openContainer, closeContainer } from '../protocol/inventoryPackets';

export interface ContainerClick { windowId: number; stateId: number; slot: number; button: number; mode: number }
export interface MenuOptions {
  title: string;
  items: Array<ItemStack | null>;
  /** Menus are immutable; callback may replace or close them safely. */
  onClick?: (slot: number, button: number) => void;
  editable?: boolean;
  onClose?: (items: Array<ItemStack | null>) => void;
}
/** Transactions use server stacks only. Client predictions are never applied. */
export class Containers {
  stateId = 0;
  windowId = 0;
  private nextId = 1;
  private cursor: ItemStack | null = null;
  private menu: MenuOptions | null = null;
  constructor(private readonly player: Player) {}
  get carried(): ItemStack | null { return cloneStack(this.cursor); }
  get isEditable(): boolean { return this.menu?.editable === true; }
  open(menu: MenuOptions): number {
    if (menu.items.length !== 54 && menu.items.length !== 27) throw new Error('Menus require 27 or 54 slots');
    if (!this.close()) throw new Error('Cannot open menu while cursor has no room');
    this.menu = { ...menu, items: menu.items.map(cloneStack) };
    this.windowId = this.nextId; this.nextId = this.nextId % 100 + 1;
    this.player.send(openContainer(this.windowId, menu.title, menu.items.length)); this.sync();
    return this.windowId;
  }
  /** Return cursor without dropping or deleting overflow; refuse close until it fits. */
  close(windowId = this.windowId): boolean {
    if (windowId !== this.windowId) { this.sync(); return false; }
    if (this.cursor) {
      for (let slot = 9; slot <= 44 && this.cursor; slot++) {
        const target = this.player.inventory.get(slot);
        if (target && !sameItem(target, this.cursor)) continue;
        const moved = Math.min(this.cursor.count, maxStackSize(itemName(this.cursor.itemId)) - (target?.count ?? 0));
        if (!moved) continue;
        this.player.setInventorySlot(slot, { ...this.cursor, count: (target?.count ?? 0) + moved }, false);
        this.cursor.count -= moved;
        if (!this.cursor.count) this.cursor = null;
      }
      if (this.cursor) { this.sync(); return false; }
    }
    this.menu?.onClose?.(this.menu.items.map(cloneStack));
    if (this.windowId) this.player.send(closeContainer(this.windowId));
    this.windowId = 0; this.menu = null; this.sync(); return true;
  }
  sync(): void {
    this.stateId = (this.stateId + 1) & 0x7fffffff;
    const slots = this.menu ? [...this.menu.items, ...Array.from({ length: 36 }, (_, i) => this.player.inventory.get(i + 9))] : Array.from({ length: 46 }, (_, i) => this.player.inventory.get(i));
    this.player.send(containerContent(this.windowId, this.stateId, slots, this.cursor));
  }
  click(click: ContainerClick): boolean {
    if (![click.windowId, click.stateId, click.slot, click.button, click.mode].every(Number.isInteger)) { this.sync(); return false; }
    if (click.windowId !== this.windowId || click.stateId !== this.stateId) { this.sync(); return false; }
    if (this.menu) {
      if (this.menu.editable) return this.edit(click);
      const menu = this.menu;
      if (click.slot >= 0 && click.slot < menu.items.length && click.mode === 0 && (click.button === 0 || click.button === 1)) menu.onClick?.(click.slot, click.button);
      this.sync(); return false;
    }
    const { slot, mode, button } = click;
    // Crafting, dropping, cloning, drag and collect are deliberately unsupported.
    if (!Number.isInteger(slot) || slot < 5 || slot > 45) { this.sync(); return false; }
    const current = this.player.inventory.get(slot);
    let accepted = false;
    if (mode === 0 && (button === 0 || button === 1)) {
      if (!this.cursor) {
        if (current) { const n = button === 1 ? Math.ceil(current.count / 2) : current.count; this.cursor = { ...current, count: n }; this.put(slot, current.count > n ? { ...current, count: current.count - n } : null); accepted = true; }
      } else if (this.allowed(slot, this.cursor)) {
        if (!current || sameItem(current, this.cursor)) {
          const n = Math.min(button === 1 ? 1 : this.cursor.count, this.limit(slot, this.cursor) - (current?.count ?? 0));
          if (n > 0) { this.put(slot, { ...this.cursor, count: (current?.count ?? 0) + n }); this.cursor.count -= n; if (!this.cursor.count) this.cursor = null; accepted = true; }
        } else if (this.cursor.count <= this.limit(slot, this.cursor)) { this.put(slot, this.cursor); this.cursor = current; accepted = true; }
      }
    } else if (mode === 2 && ((button >= 0 && button <= 8) || button === 40)) {
      const otherSlot = button === 40 ? 45 : 36 + button;
      const other = this.player.inventory.get(otherSlot);
      if (otherSlot !== slot && this.allowed(slot, other) && this.allowed(otherSlot, current) && (!other || other.count <= this.limit(slot, other))) { this.put(slot, other); this.put(otherSlot, current); accepted = true; }
    } else if (mode === 1 && button === 0 && current) {
      const destination = slot >= 36 ? Array.from({ length: 27 }, (_, i) => i + 9) : Array.from({ length: 9 }, (_, i) => i + 36);
      let left = current.count;
      for (const empty of [false, true]) for (const targetSlot of destination) {
        const target = this.player.inventory.get(targetSlot);
        if ((target === null) !== empty || (target && !sameItem(target, current))) continue;
        const n = Math.min(left, maxStackSize(itemName(current.itemId)) - (target?.count ?? 0));
        if (n > 0) { this.put(targetSlot, { ...current, count: (target?.count ?? 0) + n }); left -= n; }
      }
      if (left !== current.count) { this.put(slot, left ? { ...current, count: left } : null); accepted = true; }
    }
    this.sync(); return accepted;
  }
  private edit({ slot, mode, button }: ContainerClick): boolean {
    const menu = this.menu!;
    const size = menu.items.length;
    const get = (i: number): ItemStack | null => i < size ? cloneStack(menu.items[i]) : this.player.inventory.get(i - size + 9);
    const put = (i: number, value: ItemStack | null) => {
      if (i < size) menu.items[i] = cloneStack(value);
      else this.player.setInventorySlot(i - size + 9, value, false);
    };
    if (slot < 0 || slot >= size + 36) { this.sync(); return false; }
    const current = get(slot);
    if (mode === 0 && (button === 0 || button === 1)) {
      if (!this.cursor && current) {
        const n = button ? Math.ceil(current.count / 2) : current.count;
        this.cursor = { ...current, count:n }; put(slot, current.count > n ? { ...current, count:current.count-n } : null);
      } else if (this.cursor) {
        if (!current || sameItem(current, this.cursor)) {
          const n = Math.min(button ? 1 : this.cursor.count, maxStackSize(itemName(this.cursor.itemId)) - (current?.count ?? 0));
          if (n > 0) { put(slot, { ...this.cursor, count:(current?.count ?? 0)+n }); this.cursor.count -= n; if (!this.cursor.count) this.cursor = null; }
        } else { put(slot, this.cursor); this.cursor = current; }
      }
    } else if (mode === 2 && button >= 0 && button <= 8) {
      const other = size + 27 + button; const stack = get(other); put(other, current); put(slot, stack);
    } else if (mode === 1 && button === 0 && current) {
      const targets = slot < size ? Array.from({length:36}, (_,i)=>size+i) : Array.from({length:size}, (_,i)=>i);
      let left = current.count;
      for (const empty of [false,true]) for (const i of targets) {
        const target=get(i); if ((target===null)!==empty || target && !sameItem(target,current)) continue;
        const n=Math.min(left,maxStackSize(itemName(current.itemId))-(target?.count??0));
        if(n>0){put(i,{...current,count:(target?.count??0)+n});left-=n;}
      }
      put(slot,left?{...current,count:left}:null);
    } else { this.sync(); return false; }
    this.sync(); return true;
  }
  private put(slot: number, stack: ItemStack | null): void { this.player.setInventorySlot(slot, cloneStack(stack), false); }
  private limit(slot: number, stack: ItemStack): number { return slot >= 5 && slot <= 8 ? 1 : maxStackSize(itemName(stack.itemId)); }
  private allowed(slot: number, stack: ItemStack | null): boolean {
    if (!stack || slot > 8) return true;
    const name = itemName(stack.itemId) ?? '';
    return name.endsWith(['_helmet', '_chestplate', '_leggings', '_boots'][slot - 5]);
  }
}
