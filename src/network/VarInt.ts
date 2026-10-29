/**
 * VarInts are how Minecraft sends most integers.
 *
 * Small numbers take fewer bytes. Each byte holds 7 bits of the number;
 * the top bit (0x80) means "more bytes follow". So:
 *   1    -> 0x01
 *   300  -> 0xAC 0x02
 *   -1   -> 0xFF 0xFF 0xFF 0xFF 0x0F   (negatives always take 5 bytes)
 */

export function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  // ">>> 0" treats the number as unsigned 32-bit, which makes negatives work.
  let remaining = value >>> 0;

  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80; // more bytes follow
    }
    bytes.push(byte);
  } while (remaining !== 0);

  return Buffer.from(bytes);
}

/**
 * Reads a VarInt starting at `offset`.
 * Returns null if the buffer ends before the VarInt does (we need more data).
 */
export function decodeVarInt(buffer: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0;
  let size = 0;

  while (true) {
    if (offset + size >= buffer.length) {
      return null;
    }

    const byte = buffer[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size++;

    if ((byte & 0x80) === 0) {
      return { value, size };
    }
    if (size >= 5) {
      throw new Error("VarInt is longer than 5 bytes");
    }
  }
}
