import { whitelistFor, WHITELIST_MESSAGE } from "../../game/whitelist";
import { isOperatorName } from "../../game/operators";
import type { Connection } from "../../network/Connection";
import { ConnectionState } from "../../network/ConnectionState";
import type { PacketReader } from "../../network/PacketReader";
import { LoginIn } from "../packetIds";
import { loginSuccess } from "../clientbound";
import { config, PROTOCOL_VERSION, VERSION_NAME } from "../../config";
import { offlineUUID } from "../../util/uuid";
import { VALID_USERNAME } from "../../util/username";
import { banMessage } from "../../game/bans";
import { logger } from "../../util/logger";

/**
 * Logging in, "offline mode" style: we trust whatever name the client sends.
 *
 * An online-mode server would now start encryption and ask Mojang's session
 * servers whether this player really owns the account. We skip all that,
 * which keeps the code simple but means anyone can join with any name.
 * Don't run this on a public server without understanding that.
 */
export function handleLogin(conn: Connection, packetId: number, reader: PacketReader): void {
  if (packetId !== LoginIn.LoginStart) return;

  const username = reader.readString();

  if (conn.protocolVersion !== PROTOCOL_VERSION) {
    conn.disconnect(`This server runs Minecraft ${VERSION_NAME}. Please use that version.`);
    return;
  }
  if (!VALID_USERNAME.test(username)) {
    conn.disconnect("Invalid username.");
    return;
  }
  // Bans are checked before anything else about the server's state, so a banned player learns nothing more.
  const nameBan = conn.server.bans.findNameBan(username);
  const ipBan = conn.server.bans.findIpBan(conn.socket.remoteAddress ?? "");
  const ban = nameBan ?? ipBan;
  if (ban) {
    logger.info(`Turned away banned ${nameBan ? "name" : "address"}: ${username} from ${conn.address}`);
    conn.disconnect(banMessage(ban));
    return;
  }
  try {
    if (!isOperatorName(username) && !whitelistFor(conn.server).allows(username)) {
      conn.disconnect(WHITELIST_MESSAGE);
      return;
    }
  } catch (error) {
    logger.error(`Whitelist could not be loaded: ${String(error)}`);
    conn.disconnect("The whitelist could not be loaded. Please contact an operator.");
    return;
  }
  if (conn.server.getOnlinePlayers().length >= config.maxPlayers) {
    conn.disconnect("The server is full.");
    return;
  }
  if (conn.server.getPlayerByName(username)) {
    conn.disconnect("Someone with that name is already playing.");
    return;
  }

  const uuid = offlineUUID(username);
  conn.send(loginSuccess(uuid, username));
  conn.state = ConnectionState.Play;
  conn.server.addPlayer(conn, username, uuid);
}
