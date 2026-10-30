import { encodeVarInt } from "./VarInt";
import { encodeNetworkNbt, type NbtValue } from "../protocol/nbt";
import type { BlockPosition } from "../world/BlockPosition";

/**
 * Builds an outgoing packet field by field.
 *
 * Every write method returns `this`, so you can chain them:
 *   new PacketWriter(0x02).writeString("hi").writeByte(0)
 *
 * On the wire every packet looks like:
 *   [length: VarInt] [packet id: VarInt] [fields...]
 * where "length" counts the id and the fields. Connection.send() adds the length
 * (and compresses big packets, see network/framing.ts); toBuffer() adds it
 * without compression, which is handy in tests.
 */
export class PacketWriter {
  private readonly parts: Buffer[] = [];
  /** Filled by body(), so a packet sent to many players is joined together once. */
  private bodyCache: Buffer | null = null;

  constructor(readonly packetId: number) {
    this.writeVarInt(packetId);
  }

  /** Allocates `size` bytes, lets `fill` write into them, and stores them. */
  private add(size: number, fill: (buffer: Buffer) => void): this {
    const buffer = Buffer.alloc(size);
    fill(buffer);
    this.parts.push(buffer);
    return this;
  }

  writeBytes(bytes: Buffer): this {
    this.parts.push(bytes);
    return this;
  }

  writeVarInt(value: number): this {
    return this.writeBytes(encodeVarInt(value));
  }

  writeString(text: string): this {
    const bytes = Buffer.from(text, "utf8");
    return this.writeVarInt(bytes.length).writeBytes(bytes);
  }

  writeBoolean(value: boolean): this {
    return this.writeUnsignedByte(value ? 1 : 0);
  }

  writeByte(value: number): this {
    return this.add(1, (b) => b.writeInt8(value));
  }

  writeUnsignedByte(value: number): this {
    return this.add(1, (b) => b.writeUInt8(value));
  }

  writeShort(value: number): this {
    return this.add(2, (b) => b.writeInt16BE(value));
  }

  writeUnsignedShort(value: number): this {
    return this.add(2, (b) => b.writeUInt16BE(value));
  }

  writeInt(value: number): this {
    return this.add(4, (b) => b.writeInt32BE(value));
  }

  writeLong(value: bigint): this {
    return this.add(8, (b) => b.writeBigInt64BE(value));
  }

  writeFloat(value: number): this {
    return this.add(4, (b) => b.writeFloatBE(value));
  }

  writeDouble(value: number): this {
    return this.add(8, (b) => b.writeDoubleBE(value));
  }

  /** Writes a count followed by that many VarInts. */
  writeVarIntArray(values: readonly number[]): this {
    this.writeVarInt(values.length);
    for (const value of values) this.writeVarInt(value);
    return this;
  }

  /** Writes a count followed by that many 64-bit numbers (used for bit sets and packed arrays). */
  writeLongArray(values: readonly bigint[]): this {
    this.writeVarInt(values.length);
    return this.add(values.length * 8, (b) => values.forEach((value, i) => b.writeBigInt64BE(value, i * 8)));
  }

  /** A UUID is sent as 16 raw bytes. */
  writeUUID(uuid: string): this {
    return this.writeBytes(Buffer.from(uuid.replace(/-/g, ""), "hex"));
  }

  /** The reverse of PacketReader.readPosition(): x in the top 26 bits, z in the middle 26, y in the bottom 12. */
  writePosition(pos: BlockPosition): this {
    const packed =
      ((BigInt(pos.x) & 0x3ffffffn) << 38n) |
      ((BigInt(pos.z) & 0x3ffffffn) << 12n) |
      (BigInt(pos.y) & 0xfffn);
    return this.add(8, (b) => b.writeBigUInt64BE(packed));
  }

  /** Rotations are sent as 1 byte: 256 steps for a full circle. */
  writeAngle(degrees: number): this {
    const steps = Math.floor((degrees / 360) * 256);
    return this.writeUnsignedByte(((steps % 256) + 256) % 256);
  }

  /** Login errors are the one place that still uses chat as JSON text, e.g. {"text":"hello","color":"yellow"} */
  writeChat(component: object): this {
    return this.writeString(JSON.stringify(component));
  }

  /** Everywhere else chat text is NBT (see protocol/nbt.ts). */
  writeTextComponent(component: object): this {
    return this.writeBytes(encodeNetworkNbt(component as NbtValue));
  }

  /** The packet id and fields, without the length in front. */
  body(): Buffer {
    return (this.bodyCache ??= Buffer.concat(this.parts));
  }

  /** The finished packet, ready to write to the socket. */
  toBuffer(): Buffer {
    const body = this.body();
    return Buffer.concat([encodeVarInt(body.length), body]);
  }
}
