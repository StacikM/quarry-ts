import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { Connection } from "../../network/Connection";
import { ConnectionState } from "../../network/ConnectionState";
import { PacketReader } from "../../network/PacketReader";
import { LoginIn } from "../packetIds";
import {
  featureFlags,
  knownPacksRequest,
  loginSuccess,
  serverBrand,
  setCompression,
  velocityPlayerInfoRequest,
} from "../clientbound";
import { config, PROTOCOL_VERSION, VERSION_NAME } from "../../config";
import { offlineUUID } from "../../util/uuid";
import { normalizeIp } from "../../util/ip";
import { VALID_USERNAME } from "../../util/username";
import { banMessage } from "../../game/bans";
import { logger } from "../../util/logger";

/**
 * Logging in, "offline mode" style: we trust whatever name the client sends.
 *
 * An online-mode server would now start encryption and ask Mojang's session
 * servers whether this player really owns the account. We skip all that,
 * which keeps the code simple but means anyone can join with any name.
 * Don't expose this server directly to the internet. Behind a Velocity proxy
 * (which does check accounts) it is fine: see config.velocity.
 *
 * The steps: Login Start -> (Velocity: ask the proxy who this really is) ->
 * Set Compression + Login Success -> the client acknowledges -> Configuration.
 */
export function handleLogin(conn: Connection, packetId: number, reader: PacketReader): void {
  switch (packetId) {
    case LoginIn.LoginStart:
      return onLoginStart(conn, reader);
    case LoginIn.PluginResponse:
      return onPluginResponse(conn, reader);
    case LoginIn.LoginAcknowledged:
      return onLoginAcknowledged(conn);
  }
}

function onLoginStart(conn: Connection, reader: PacketReader): void {
  if (conn.pending || conn.velocityMessageId !== null) return; // a second Login Start is ignored

  const username = reader.readString();
  reader.readUUID(); // the UUID the client claims; we do not trust it

  if (conn.protocolVersion !== PROTOCOL_VERSION) {
    conn.disconnect(`This server runs Minecraft ${VERSION_NAME}. Please use that version.`);
    return;
  }
  if (!VALID_USERNAME.test(username)) {
    conn.disconnect("Invalid username.");
    return;
  }

  if (config.velocity.enabled) {
    // Behind a proxy, the proxy decides who the player is. Ask it; only a message signed with our secret counts.
    conn.velocityMessageId = randomInt(1, 0x7fffffff);
    conn.send(velocityPlayerInfoRequest(conn.velocityMessageId, 1));
    return;
  }

  finishLogin(conn, username, offlineUUID(username));
}

/** The proxy's answer. Layout: 32 bytes HMAC-SHA256 signature, then the signed data. */
function onPluginResponse(conn: Connection, reader: PacketReader): void {
  const messageId = reader.readVarInt();
  if (conn.velocityMessageId === null || messageId !== conn.velocityMessageId) return;
  conn.velocityMessageId = null;

  const understood = reader.readBoolean();
  const data = reader.readRemaining();
  if (!understood || data.length <= 32) {
    conn.disconnect("This server can only be joined through the proxy.");
    return;
  }

  const signature = data.subarray(0, 32);
  const signed = data.subarray(32);
  const expected = createHmac("sha256", config.velocity.secret).update(signed).digest();
  if (!timingSafeEqual(signature, expected)) {
    logger.warn(`Rejected a login from ${conn.address}: the proxy signature is wrong (is the forwarding secret the same on both sides?)`);
    conn.disconnect("Could not verify the proxy's signature. Check that the forwarding secret is the same in Velocity and here.");
    return;
  }

  const forwarded = new PacketReader(signed);
  const version = forwarded.readVarInt();
  if (version < 1 || version > 4) {
    conn.disconnect(`The proxy used a forwarding version this server does not know (${version}).`);
    return;
  }
  const address = forwarded.readString();
  const uuid = forwarded.readUUID();
  const username = forwarded.readString();
  // (skin properties and chat keys follow; not needed here)

  if (!VALID_USERNAME.test(username)) {
    conn.disconnect("Invalid username.");
    return;
  }
  conn.clientIp = normalizeIp(address);
  finishLogin(conn, username, uuid);
}

/** The name is known and trusted now: apply the server's rules and let the player in. */
function finishLogin(conn: Connection, username: string, uuid: string): void {
  // Bans are checked before anything else about the server's state, so a banned player learns nothing more.
  const nameBan = conn.server.bans.findNameBan(username);
  const ipBan = conn.server.bans.findIpBan(conn.clientIp);
  const ban = nameBan ?? ipBan;
  if (ban) {
    logger.info(`Turned away banned ${nameBan ? "name" : "address"}: ${username} from ${conn.address}`);
    conn.disconnect(banMessage(ban));
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

  conn.pending = { username, uuid, ip: conn.clientIp, knownPacksAnswered: false, viewDistance: null };

  // The compression packet itself is sent uncompressed; everything after it follows the new rule.
  if (config.compressionThreshold >= 0) {
    conn.send(setCompression(config.compressionThreshold));
    conn.compressionThreshold = config.compressionThreshold;
  }
  conn.send(loginSuccess(uuid, username));
}

/** The client confirmed the login. From here on the connection is in the Configuration phase. */
function onLoginAcknowledged(conn: Connection): void {
  if (!conn.pending) {
    conn.disconnect("Unexpected packet.");
    return;
  }
  conn.state = ConnectionState.Configuration;
  conn.send(serverBrand("Quarry.ts"));
  conn.send(featureFlags(["minecraft:vanilla"]));
  conn.send(knownPacksRequest(VERSION_NAME));
}
