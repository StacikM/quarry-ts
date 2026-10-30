/**
 * Minecraft sends chat text as NBT (a binary format) since 1.20.3. This writes
 * the small part of NBT we need: a "network NBT" root, which in this version
 * has a type byte but no name.
 *
 * JavaScript values map like this: string -> String tag, boolean -> Byte,
 * whole number -> Int, other number -> Double, array -> List, object -> Compound.
 */

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_INT = 3;
const TAG_DOUBLE = 6;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;

export type NbtValue = string | number | boolean | NbtValue[] | { [key: string]: NbtValue | undefined };

/** NBT strings use Java's "modified UTF-8": one to three bytes per UTF-16 unit, and NUL is two bytes. */
function modifiedUtf8(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit !== 0 && unit < 0x80) {
      bytes.push(unit);
    } else if (unit < 0x800) {
      bytes.push(0xc0 | (unit >> 6), 0x80 | (unit & 0x3f));
    } else {
      bytes.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f));
    }
  }
  if (bytes.length > 0xffff) throw new Error("NBT string is too long");
  return Buffer.from(bytes);
}

function typeOf(value: NbtValue): number {
  if (typeof value === "string") return TAG_STRING;
  if (typeof value === "boolean") return TAG_BYTE;
  if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) < 2 ** 31 ? TAG_INT : TAG_DOUBLE;
  if (Array.isArray(value)) return TAG_LIST;
  return TAG_COMPOUND;
}

function payload(value: NbtValue, parts: Buffer[]): void {
  switch (typeOf(value)) {
    case TAG_STRING: {
      const text = modifiedUtf8(value as string);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(text.length);
      parts.push(length, text);
      break;
    }
    case TAG_BYTE:
      parts.push(Buffer.from([value ? 1 : 0]));
      break;
    case TAG_INT: {
      const bytes = Buffer.alloc(4);
      bytes.writeInt32BE(value as number);
      parts.push(bytes);
      break;
    }
    case TAG_DOUBLE: {
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleBE(value as number);
      parts.push(bytes);
      break;
    }
    case TAG_LIST: {
      const items = value as NbtValue[];
      const itemType = items.length > 0 ? typeOf(items[0]) : TAG_END;
      const head = Buffer.alloc(5);
      head.writeUInt8(itemType, 0);
      head.writeInt32BE(items.length, 1);
      parts.push(head);
      for (const item of items) {
        if (typeOf(item) !== itemType) throw new Error("An NBT list must hold one kind of value");
        payload(item, parts);
      }
      break;
    }
    default: {
      for (const [key, entry] of Object.entries(value as Record<string, NbtValue | undefined>)) {
        if (entry === undefined) continue;
        const name = modifiedUtf8(key);
        const head = Buffer.alloc(3);
        head.writeUInt8(typeOf(entry), 0);
        head.writeUInt16BE(name.length, 1);
        parts.push(head, name);
        payload(entry, parts);
      }
      parts.push(Buffer.from([TAG_END]));
    }
  }
}

/** The bytes of a network-NBT root value (type byte, then the payload, no name). */
export function encodeNetworkNbt(value: NbtValue): Buffer {
  const parts: Buffer[] = [Buffer.from([typeOf(value)])];
  payload(value, parts);
  return Buffer.concat(parts);
}
