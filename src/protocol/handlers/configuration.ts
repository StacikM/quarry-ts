import type { Connection } from "../../network/Connection";
import { ConnectionState } from "../../network/ConnectionState";
import type { PacketReader } from "../../network/PacketReader";
import { ConfigIn } from "../packetIds";
import { allRegistryData, finishConfiguration, tagsPacket } from "../clientbound";
import { VERSION_NAME } from "../../config";
import { logger } from "../../util/logger";

/**
 * The Configuration phase sits between login and the game. The server tells the
 * client which standard game data it should use, and the client tells us its
 * settings. When both sides are done, the game starts.
 */
export function handleConfiguration(conn: Connection, packetId: number, reader: PacketReader): void {
  const pending = conn.pending;
  if (!pending) return;

  switch (packetId) {
    case ConfigIn.ClientInformation: {
      reader.readString(); // language, e.g. "en_us"
      const viewDistance = reader.readByte(); // how many chunks the player wants to see
      pending.viewDistance = viewDistance > 0 ? viewDistance : null;
      if (reader.remaining >= 3) {
        reader.readVarInt(); // chat visibility
        reader.readBoolean(); // chat colours
        pending.skinParts = reader.readUnsignedByte(); // which layers of the skin to show
      }
      break;
    }

    case ConfigIn.KnownPacks: {
      if (pending.knownPacksAnswered) return;
      pending.knownPacksAnswered = true;

      // The client lists the data packs it has. We need the standard one, because
      // we only send the names of biomes, damage types and so on.
      const count = reader.readVarInt();
      let hasCore = false;
      for (let i = 0; i < Math.min(count, 64); i++) {
        const namespace = reader.readString();
        const id = reader.readString();
        const version = reader.readString();
        if (namespace === "minecraft" && id === "core" && version === VERSION_NAME) hasCore = true;
      }
      if (!hasCore) {
        // A real 1.21.11 client always has it. Tools that are not the real game may not; we carry on and let them cope.
        logger.warn(`${pending.username} did not list the standard data pack; sending registry names anyway`);
      }
      for (const packet of allRegistryData()) conn.send(packet);
      conn.send(tagsPacket());
      conn.send(finishConfiguration());
      break;
    }

    case ConfigIn.FinishConfiguration:
      // The client has everything. Now the player enters the world.
      if (!pending.knownPacksAnswered) {
        conn.disconnect("Unexpected packet.");
        return;
      }
      conn.state = ConnectionState.Play;
      conn.server.addPlayer(conn, pending);
      break;

    // Plugin messages (the client's brand...) and keep-alives need no answer.
  }
}
