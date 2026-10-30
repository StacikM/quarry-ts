import type { Socket } from "node:net";
import { decodeVarInt } from "./VarInt";
import { ConnectionState } from "./ConnectionState";
import { PacketReader } from "./PacketReader";
import type { PacketWriter } from "./PacketWriter";
import { frame, unframe } from "./framing";
import { handleHandshake } from "../protocol/handlers/handshake";
import { handleStatus } from "../protocol/handlers/status";
import { handleLogin } from "../protocol/handlers/login";
import { handleConfiguration } from "../protocol/handlers/configuration";
import { handlePlay } from "../protocol/handlers/play";
import { configDisconnect, loginDisconnect, playDisconnect } from "../protocol/clientbound";
import { normalizeIp } from "../util/ip";
import { logger } from "../util/logger";
import type { MinecraftServer } from "../game/Server";
import type { Player } from "../game/Player";

/** Refuse absurdly big packets so a bad client can't make us eat all memory. */
const MAX_PACKET_SIZE = 2 * 1024 * 1024;

/** A client that has not finished logging in after this long is dropped. */
const LOGIN_TIMEOUT_MS = 30_000;

/** What we know about a player between "Login Start" and the moment they enter the world. */
/** A piece of profile data attached to a player; the one that matters is "textures", which holds the skin. */
export interface ProfileProperty {
  name: string;
  value: string;
  signature?: string;
}

export interface PendingLogin {
  username: string;
  uuid: string;
  /** Where they really connect from (a proxy forwards this). */
  ip: string;
  /** Set once the client has answered our Known Packs question. */
  knownPacksAnswered: boolean;
  viewDistance: number | null;
  /** Which parts of their skin the player shows (hat, jacket, sleeves, pants, cape), as the client reports it. */
  skinParts?: number;
  /** Profile data from a proxy (skins). Empty for players who connect directly. */
  properties: ProfileProperty[];
}

/**
 * One TCP connection from one client.
 *
 * TCP is a stream of bytes, not of packets: one "data" event might hold half
 * a packet, or three and a bit. So we collect bytes in `incoming` and cut
 * complete packets off the front whenever we have enough.
 */
export class Connection {
  state = ConnectionState.Handshaking;
  protocolVersion = 0;
  /** Set once the client has logged in. */
  player: Player | null = null;
  /** Filled in while logging in and configuring, then handed to the server. */
  pending: PendingLogin | null = null;
  /** Packets of at least this many bytes are compressed; -1 means no compression at all. */
  compressionThreshold = -1;
  /** The id of the Velocity forwarding request we are waiting on, or null. */
  velocityMessageId: number | null = null;
  /** The address the player really comes from. Behind a proxy that is not the socket's address. */
  private forwardedIp: string | null = null;

  private incoming = Buffer.alloc(0);
  private readonly loginTimer: NodeJS.Timeout;

  constructor(
    readonly socket: Socket,
    readonly server: MinecraftServer,
  ) {
    socket.setNoDelay(true); // send small packets right away instead of batching
    socket.on("data", (data) => this.onData(data));
    socket.on("close", () => {
      clearTimeout(this.loginTimer);
      server.onConnectionClosed(this);
    });
    this.loginTimer = setTimeout(() => {
      if (this.state !== ConnectionState.Play) this.socket.destroy();
    }, LOGIN_TIMEOUT_MS);
    this.loginTimer.unref();
    socket.on("error", () => {
      // Clients disconnecting abruptly cause errors like ECONNRESET.
      // "close" fires right after, which is where cleanup happens.
    });
  }

  get address(): string {
    return `${this.socket.remoteAddress}:${this.socket.remotePort}`;
  }

  /** The player's IP address: what the proxy told us if there is one, else the socket's. */
  get clientIp(): string {
    return this.forwardedIp ?? normalizeIp(this.socket.remoteAddress ?? "");
  }

  set clientIp(ip: string) {
    this.forwardedIp = ip;
  }

  private onData(data: Buffer): void {
    this.incoming = Buffer.concat([this.incoming, data]);

    try {
      // Each packet starts with its length as a VarInt.
      while (!this.socket.destroyed) {
        const length = decodeVarInt(this.incoming, 0);
        if (!length) return; // haven't even received the whole length yet

        if (length.value > MAX_PACKET_SIZE) {
          throw new Error(`Packet too big (${length.value} bytes)`);
        }

        const packetEnd = length.size + length.value;
        if (this.incoming.length < packetEnd) return; // wait for the rest

        const payload = this.incoming.subarray(length.size, packetEnd);
        this.incoming = this.incoming.subarray(packetEnd);
        this.handlePacket(unframe(payload, this.compressionThreshold, MAX_PACKET_SIZE));
      }
    } catch (err) {
      logger.warn(`Error from ${this.address}: ${(err as Error).message}`);
      this.disconnect("Internal error while reading your packets");
    }
  }

  /** Sends the packet to the right handler for our current state. */
  private handlePacket(packet: Buffer): void {
    const reader = new PacketReader(packet);
    const packetId = reader.readVarInt();

    switch (this.state) {
      case ConnectionState.Handshaking:
        return handleHandshake(this, packetId, reader);
      case ConnectionState.Status:
        return handleStatus(this, packetId, reader);
      case ConnectionState.Login:
        return handleLogin(this, packetId, reader);
      case ConnectionState.Configuration:
        return handleConfiguration(this, packetId, reader);
      case ConnectionState.Play:
        return handlePlay(this, packetId, reader);
    }
  }

  send(packet: PacketWriter): void {
    this.sendFrame(frame(packet.body(), this.compressionThreshold));
  }

  /** Sends bytes that are already framed (and compressed) for this connection's compression setting. */
  sendFrame(bytes: Buffer): void {
    if (!this.socket.destroyed) this.socket.write(bytes);
  }

  /** Kicks the client, showing them `reason` if they're logging in or playing. */
  disconnect(reason: string): void {
    const message = { text: reason, color: "red" };
    if (this.state === ConnectionState.Login) {
      this.send(loginDisconnect(message));
    } else if (this.state === ConnectionState.Configuration) {
      this.send(configDisconnect(message));
    } else if (this.state === ConnectionState.Play) {
      this.send(playDisconnect(message));
    }
    // end() flushes what we've written, then closes the socket.
    this.socket.end();
  }
}
