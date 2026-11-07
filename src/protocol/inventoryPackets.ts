import { PacketWriter } from '../network/PacketWriter';
import type { ItemStack } from '../game/Inventory';
import { REGISTRY_KEYS } from './registryKeys';
export const EFFECT_IDS: Record<string, number> = { speed: 0, strength: 4, regeneration: 9, resistance: 10, absorption: 21 };
/** Component IDs and packet layouts verified against the installed 1.21.11 protocol schema. */
export function writeItemStack(packet: PacketWriter, item: ItemStack | null): void {
  if (!item || item.count <= 0) { packet.writeVarInt(0); return; }
  const components: Array<[number, () => void]> = [];
  if (item.customName !== undefined) components.push([6, () => { packet.writeTextComponent({ text: item.customName }); }]);
  if (item.lore) components.push([11, () => { packet.writeVarInt(item.lore!.length); for (const text of item.lore!) packet.writeTextComponent({ text }); }]);
  if (item.enchantments) components.push([13, () => {
    const values = Object.entries(item.enchantments!).map(([name, level]) => [REGISTRY_KEYS['minecraft:enchantment'].indexOf(name.includes(':') ? name : `minecraft:${name}`), level]);
    if (values.some(([id, level]) => id < 0 || !Number.isInteger(level) || level < 1 || level > 255)) throw new Error('Invalid enchantment');
    packet.writeVarInt(values.length); for (const [id, level] of values) packet.writeVarInt(id).writeVarInt(level);
  }]);
  if (item.potionEffects) components.push([49, () => {
    packet.writeBoolean(false).writeBoolean(false).writeVarInt(item.potionEffects!.length);
    for (const effect of item.potionEffects!) {
      const id = EFFECT_IDS[effect.name];
      if (id === undefined || !Number.isInteger(effect.amplifier) || effect.amplifier < 0 || effect.amplifier > 255 || !Number.isInteger(effect.durationTicks) || effect.durationTicks < 1) throw new Error('Unsupported potion effect');
      packet.writeVarInt(id).writeVarInt(effect.amplifier).writeVarInt(effect.durationTicks).writeBoolean(false).writeBoolean(true).writeBoolean(true).writeBoolean(false);
    }
    packet.writeBoolean(false);
  }]);
  if (item.unbreakable) components.push([4, () => {}]);
  if (item.damage !== undefined) components.push([3, () => { packet.writeVarInt(item.damage!); }]);
  if (item.dyedColor !== undefined) components.push([42, () => { packet.writeInt(item.dyedColor!); }]);
  packet.writeVarInt(item.count).writeVarInt(item.itemId).writeVarInt(components.length).writeVarInt(0);
  for (const [id, write] of components) { packet.writeVarInt(id); write(); }
}
export function containerContent(id: number, state: number, items: Array<ItemStack | null>, cursor: ItemStack | null): PacketWriter {
  const packet = new PacketWriter(0x12).writeVarInt(id).writeVarInt(state).writeVarInt(items.length);
  for (const item of items) writeItemStack(packet, item);
  writeItemStack(packet, cursor); return packet;
}
export function openContainer(id: number, title: string, size = 54): PacketWriter { return new PacketWriter(0x39).writeVarInt(id).writeVarInt(size / 9 - 1).writeTextComponent({ text: title }); }
export function closeContainer(id: number): PacketWriter { return new PacketWriter(0x11).writeVarInt(id); }
export function healthPacket(health: number, food: number, saturation: number): PacketWriter { return new PacketWriter(0x66).writeFloat(health).writeVarInt(food).writeFloat(saturation); }
