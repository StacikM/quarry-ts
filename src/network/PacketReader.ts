import { decodeVarInt } from "./VarInt";
import type { BlockPosition } from "../world/BlockPosition";

/** The part of an item stack we care about: which item, and how many. */
export interface ItemSlot {
  itemId: number; // -1 means an empty slot
  count: number;
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
    // A VarInt can be negative. Without this check a bad client could make us read backwards.
    if (length < 0) {
      throw new Error(`String has a negative length (${length})`);
    }
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
   *   x: top 26 bits, z: middle 26 bits, y: bottom 12 bits
   * BigInt.asIntN turns each slice back into a signed number.
   */
  readPosition(): BlockPosition {
    const packed = this.readLong();
    return {
      x: Number(BigInt.asIntN(26, packed >> 38n)),
      y: Number(BigInt.asIntN(12, packed)),
      z: Number(BigInt.asIntN(26, packed >> 12n)),
    };
  }

  /** A UUID is 16 raw bytes. */
  readUUID(): string {
    this.need(16);
    const hex = this.buffer.toString("hex", this.offset, this.offset + 16);
    this.offset += 16;
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }

  /** The rest of the packet, as is. */
  readRemaining(): Buffer {
    const rest = this.buffer.subarray(this.offset);
    this.offset = this.buffer.length;
    return rest;
  }

  /** How many bytes of the packet have not been read yet. */
  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  /**
   * Reads an item stack. After the item comes a list of "components" (names,
   * enchantments, ...) which we don't need, so we stop before it. Only call
   * this when the slot is the last thing you care about in the packet.
   */
  readSlot(): ItemSlot {
    const count = this.readVarInt();
    if (count <= 0) return { itemId: -1, count: 0 };
    return { itemId: this.readVarInt(), count };
  }
}
