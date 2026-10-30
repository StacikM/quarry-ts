/**
 * Reads NBT, the binary format Minecraft saves worlds in. Everything is big-endian.
 *
 * What comes out: numbers for byte/short/int/float/double, bigint for long, strings,
 * plain arrays for lists, and objects for compounds. Number arrays (byte, int) are
 * plain arrays; long arrays are BigInt64Array.
 */

export type NbtData = number | bigint | string | NbtData[] | BigInt64Array | { [key: string]: NbtData };

const MAX_DEPTH = 64;

export class NbtError extends Error {}

/** NBT strings are "modified UTF-8": NUL is two bytes and characters outside the basic plane are two three-byte halves. */
function decodeString(bytes: Buffer): string {
  let text = "";
  for (let i = 0; i < bytes.length; ) {
    const first = bytes[i++];
    if (first < 0x80) {
      text += String.fromCharCode(first);
    } else if ((first & 0xe0) === 0xc0 && i < bytes.length) {
      text += String.fromCharCode(((first & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if ((first & 0xf0) === 0xe0 && i + 1 < bytes.length) {
      text += String.fromCharCode(((first & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else {
      throw new NbtError("Bad text in NBT");
    }
  }
  return text;
}

class Cursor {
  offset = 0;
  constructor(readonly buffer: Buffer) {}

  need(count: number): void {
    if (count < 0 || this.offset + count > this.buffer.length) throw new NbtError("NBT ended early");
  }
  byte(): number {
    this.need(1);
    return this.buffer.readInt8(this.offset++);
  }
  unsignedByte(): number {
    this.need(1);
    return this.buffer.readUInt8(this.offset++);
  }
  short(): number {
    this.need(2);
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }
  unsignedShort(): number {
    this.need(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }
  int(): number {
    this.need(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  long(): bigint {
    this.need(8);
    const value = this.buffer.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }
  float(): number {
    this.need(4);
    const value = this.buffer.readFloatBE(this.offset);
    this.offset += 4;
    return value;
  }
  double(): number {
    this.need(8);
    const value = this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }
  string(): string {
    const length = this.unsignedShort();
    this.need(length);
    const text = decodeString(this.buffer.subarray(this.offset, this.offset + length));
    this.offset += length;
    return text;
  }
}

function readPayload(cursor: Cursor, type: number, depth: number): NbtData {
  if (depth > MAX_DEPTH) throw new NbtError("NBT is nested too deeply");
  switch (type) {
    case 1:
      return cursor.byte();
    case 2:
      return cursor.short();
    case 3:
      return cursor.int();
    case 4:
      return cursor.long();
    case 5:
      return cursor.float();
    case 6:
      return cursor.double();
    case 7: {
      const length = cursor.int();
      cursor.need(length);
      const values = Array.from(cursor.buffer.subarray(cursor.offset, cursor.offset + length), (byte) => (byte << 24) >> 24);
      cursor.offset += length;
      return values;
    }
    case 8:
      return cursor.string();
    case 9: {
      const itemType = cursor.unsignedByte();
      const length = cursor.int();
      if (length < 0 || (itemType === 0 && length > 0)) throw new NbtError("Bad NBT list");
      cursor.need(length); // every item takes at least a byte except in lists of empty compounds; this still bounds the count
      const items: NbtData[] = [];
      for (let i = 0; i < length; i++) items.push(readPayload(cursor, itemType, depth + 1));
      return items;
    }
    case 10: {
      const compound: { [key: string]: NbtData } = Object.create(null);
      for (;;) {
        const childType = cursor.unsignedByte();
        if (childType === 0) return compound;
        const name = cursor.string();
        compound[name] = readPayload(cursor, childType, depth + 1);
      }
    }
    case 11: {
      const length = cursor.int();
      cursor.need(length * 4);
      const values: number[] = [];
      for (let i = 0; i < length; i++) values.push(cursor.int());
      return values;
    }
    case 12: {
      const length = cursor.int();
      cursor.need(length * 8);
      const values = new BigInt64Array(length);
      for (let i = 0; i < length; i++) values[i] = cursor.long();
      return values;
    }
    default:
      throw new NbtError(`Unknown NBT tag type ${type}`);
  }
}

/** Reads a whole NBT file's bytes (already decompressed) and returns its root compound. */
export function readNbt(buffer: Buffer): { [key: string]: NbtData } {
  const cursor = new Cursor(buffer);
  const type = cursor.unsignedByte();
  if (type !== 10) throw new NbtError("NBT does not start with a compound");
  cursor.string(); // the root's name (usually empty)
  return readPayload(cursor, 10, 0) as { [key: string]: NbtData };
}
