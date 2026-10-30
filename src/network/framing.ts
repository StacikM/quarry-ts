import zlib from "node:zlib";
import { decodeVarInt, encodeVarInt } from "./VarInt";

/**
 * Wraps a packet body (packet id + fields) into the bytes that go on the wire.
 *
 * Without compression (threshold < 0) that is just [length][body].
 * With compression, every packet is [length][data length][data]:
 *   - small packets (shorter than the threshold) are sent as they are, with a data length of 0,
 *   - bigger ones are zlib-compressed, and the data length says how big they were before.
 * Chunks are the packets that gain the most: they shrink to a small fraction.
 */
export function frame(body: Buffer, threshold: number): Buffer {
  if (threshold < 0) return Buffer.concat([encodeVarInt(body.length), body]);

  if (body.length < threshold) {
    const dataLength = encodeVarInt(0);
    return Buffer.concat([encodeVarInt(dataLength.length + body.length), dataLength, body]);
  }
  const dataLength = encodeVarInt(body.length);
  const compressed = zlib.deflateSync(body, { level: 3 });
  return Buffer.concat([encodeVarInt(dataLength.length + compressed.length), dataLength, compressed]);
}

/**
 * The reverse for one received frame: `payload` is what follows the length.
 * Packets that claim to be bigger than `maxSize` when unpacked are refused,
 * so a tiny "zip bomb" cannot make the server run out of memory.
 */
export function unframe(payload: Buffer, threshold: number, maxSize: number): Buffer {
  if (threshold < 0) return payload;

  const dataLength = decodeVarInt(payload, 0);
  if (!dataLength) throw new Error("Compressed packet has no length");
  const rest = payload.subarray(dataLength.size);
  if (dataLength.value === 0) return rest;
  if (dataLength.value < 0 || dataLength.value > maxSize) throw new Error(`Packet too big (${dataLength.value} bytes)`);

  const body = zlib.inflateSync(rest, { maxOutputLength: dataLength.value });
  if (body.length !== dataLength.value) throw new Error("Compressed packet has the wrong size");
  return body;
}
