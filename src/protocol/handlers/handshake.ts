import type { Connection } from "../../network/Connection";
import { ConnectionState } from "../../network/ConnectionState";
import type { PacketReader } from "../../network/PacketReader";
import { HandshakeIn } from "../packetIds";

/**
 * The very first packet. It tells us the client's protocol version and
 * whether it wants to ping the server (state 1) or log in (state 2).
 */
export function handleHandshake(conn: Connection, packetId: number, reader: PacketReader): void {
  if (packetId !== HandshakeIn.Handshake) {
    conn.socket.destroy();
    return;
  }

  conn.protocolVersion = reader.readVarInt();
  reader.readString(); // the address the player typed (we don't need it)
  reader.readUnsignedShort(); // the port the player typed
  const nextState = reader.readVarInt();

  if (nextState === 1) {
    conn.state = ConnectionState.Status;
  } else if (nextState === 2) {
    conn.state = ConnectionState.Login;
  } else {
    conn.socket.destroy();
  }
}
