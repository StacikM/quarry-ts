/**
 * Helpers shared by the checks that stand in for a connected client
 * (no sockets: the server is handed a fake connection that records what it is sent).
 */
import { PacketReader } from "../../src/network/PacketReader";
import { PacketWriter } from "../../src/network/PacketWriter";
import { PlayOut } from "../../src/protocol/packetIds";
import type { PendingLogin } from "../../src/network/Connection";

export interface SentPacket {
  packetId: number;
  body(): Buffer;
}

/** The text of a System Chat packet (the `text` of its first component), or null for any other packet. */
export function chatText(packet: SentPacket): string | null {
  if (packet.packetId !== PlayOut.SystemChat) return null;
  const body = packet.body();
  const key = body.indexOf(Buffer.from([8, 0, 4, 0x74, 0x65, 0x78, 0x74])); // a String tag called "text"
  if (key < 0) return null;
  const length = body.readUInt16BE(key + 7);
  return body.toString("utf8", key + 9, key + 9 + length);
}

/** The login data the server has once a client has logged in and finished configuring. */
export function pendingLogin(username: string, uuid: string, ip = "127.0.0.1"): PendingLogin {
  return { username, uuid, ip, knownPacksAnswered: true, viewDistance: null };
}

/** A reader positioned after the packet id, as the packet handlers expect it. */
export function readerFor(packet: PacketWriter): PacketReader {
  const reader = new PacketReader(packet.body());
  reader.readVarInt();
  return reader;
}

/** The zero UUID a client sends in Login Start; the server ignores it. */
export const NO_UUID = "00000000-0000-0000-0000-000000000000";
