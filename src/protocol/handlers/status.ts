import type { Connection } from "../../network/Connection";
import type { PacketReader } from "../../network/PacketReader";
import { StatusIn } from "../packetIds";
import { pong, statusResponse } from "../clientbound";
import { config, PROTOCOL_VERSION, VERSION_NAME } from "../../config";

/**
 * The server list ping. When you open the multiplayer menu, the client:
 *   1. sends Request -> we answer with the MOTD, version, and player count
 *   2. sends Ping with a number -> we send the same number back
 * The time between 2 and our reply is the ping (the green bars).
 */
export function handleStatus(conn: Connection, packetId: number, reader: PacketReader): void {
  switch (packetId) {
    case StatusIn.Request: {
      const players = conn.server.getOnlinePlayers();
      conn.send(
        statusResponse({
          version: { name: VERSION_NAME, protocol: PROTOCOL_VERSION },
          players: {
            max: config.maxPlayers,
            online: players.length,
            // Shown when you hover over the player count.
            sample: players.slice(0, 12).map((p) => ({ name: p.username, id: p.uuid })),
          },
          description: { text: config.motd },
        }),
      );
      break;
    }

    case StatusIn.Ping: {
      const payload = reader.readLong();
      conn.send(pong(payload));
      conn.socket.end();
      break;
    }
  }
}
