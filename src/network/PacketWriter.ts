import { encodeVarInt } from "./VarInt";
import type { BlockPosition } from "../world/BlockPosition";

/**
 * Builds an outgoing packet field by field.
 *
 * Every write method returns `this`, so you can chain them:
 *   new PacketWriter(0x02).writeString("hi").writeByte(0)
 *
 * On the wire every packet looks like:
 *   [length: VarInt] [packet id: VarInt] [fields...]
 * where "length" counts the id and the fields. toBuffer() adds the length.
 */
export class PacketWriter {
  private readonly parts: Buffer[] = [];

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

  /** A UUID is sent as 16 raw bytes. */
  writeUUID(uuid: string): this {
    return this.writeBytes(Buffer.from(uuid.replace(/-/g, ""), "hex"));
  }

  /** The reverse of PacketReader.readPosition(). */
  writePosition(pos: BlockPosition): this {
    const packed =
      ((BigInt(pos.x) & 0x3ffffffn) << 38n) |
      ((BigInt(pos.y) & 0xfffn) << 26n) |
      (BigInt(pos.z) & 0x3ffffffn);
    return this.add(8, (b) => b.writeBigUInt64BE(packed));
  }

  /** Rotations are sent as 1 byte: 256 steps for a full circle. */
  writeAngle(degrees: number): this {
    const steps = Math.floor((degrees / 360) * 256);
    return this.writeUnsignedByte(((steps % 256) + 256) % 256);
  }

  /**
   * Entity positions in 1.8 are "fixed point": the block coordinate times 32,
   * stored as an int. So x = 10.5 is sent as 336.
   */
  writeFixedPoint(value: number): this {
    return this.writeInt(Math.floor(value * 32));
  }

  /** Chat text is sent as JSON, e.g. {"text":"hello","color":"yellow"} */
  writeChat(component: object): this {
    return this.writeString(JSON.stringify(component));
  }

  /** The finished packet, ready to write to the socket. */
  toBuffer(): Buffer {
    const body = Buffer.concat(this.parts);
    return Buffer.concat([encodeVarInt(body.length), body]);
  }
}
