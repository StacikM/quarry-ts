import { decodeVarInt } from "./VarInt";
import type { BlockPosition } from "../world/BlockPosition";

/** An item stack as sent by the client (e.g. what's in their hand). */
export interface ItemSlot {
  itemId: number; // -1 means "empty hand"
  count: number;
  damage: number; // also used as "metadata", e.g. the colour of wool
}

/**
 * Reads values one after another out of a packet's bytes.
 * Every read moves `offset` forward, so call them in the order the
 * protocol lists the fields. All numbers are big-endian.
 */
export class PacketReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  /** Throws if there aren't `count` bytes left, instead of reading garbage. */
  private need(count: number): void {
    if (this.offset + count > this.buffer.length) {
      throw new Error(`Packet ended early (wanted ${count} more bytes)`);
    }
  }

  readVarInt(): number {
    const result = decodeVarInt(this.buffer, this.offset);
    if (!result) {
      throw new Error("Packet ended in the middle of a VarInt");
    }
    this.offset += result.size;
    return result.value;
  }

  /** Strings are a VarInt length (in bytes) followed by UTF-8 text. */
  readString(): string {
    const length = this.readVarInt();
    this.need(length);
    const text = this.buffer.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return text;
  }

  readBoolean(): boolean {
    return this.readUnsignedByte() !== 0;
  }

  readByte(): number {
    this.need(1);
    const value = this.buffer.readInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readUnsignedByte(): number {
    this.need(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readShort(): number {
    this.need(2);
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  readUnsignedShort(): number {
    this.need(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  readInt(): number {
    this.need(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  /** 64-bit numbers don't fit in a JS number, so we use bigint. */
  readLong(): bigint {
    this.need(8);
    const value = this.buffer.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  readFloat(): number {
    this.need(4);
    const value = this.buffer.readFloatBE(this.offset);
    this.offset += 4;
    return value;
  }

  readDouble(): number {
    this.need(8);
    const value = this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }

  /**
   * A block position is packed into one 64-bit number:
   *   x: top 26 bits, y: middle 12 bits, z: bottom 26 bits
   * BigInt.asIntN turns each slice back into a signed number.
   */
  readPosition(): BlockPosition {
    const packed = this.readLong();
    return {
      x: Number(packed >> 38n),
      y: Number(BigInt.asIntN(12, packed >> 26n)),
      z: Number(BigInt.asIntN(26, packed)),
    };
  }

  /**
   * Reads an item stack. It may end with NBT data (enchantments, names...),
   * which we don't need, so we stop before it. Only call this when the slot
   * is the last thing you care about in the packet.
   */
  readSlot(): ItemSlot {
    const itemId = this.readShort();
    if (itemId === -1) {
      return { itemId: -1, count: 0, damage: 0 };
    }
    const count = this.readByte();
    const damage = this.readShort();
    return { itemId, count, damage };
  }
}
