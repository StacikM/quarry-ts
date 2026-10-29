import type { Socket } from "node:net";
import { decodeVarInt } from "./VarInt";
import { ConnectionState } from "./ConnectionState";
import { PacketReader } from "./PacketReader";
import type { PacketWriter } from "./PacketWriter";
import { handleHandshake } from "../protocol/handlers/handshake";
import { handleStatus } from "../protocol/handlers/status";
import { handleLogin } from "../protocol/handlers/login";
import { handlePlay } from "../protocol/handlers/play";
import { loginDisconnect, playDisconnect } from "../protocol/clientbound";
import { logger } from "../util/logger";
import type { MinecraftServer } from "../game/Server";
import type { Player } from "../game/Player";

/** Refuse absurdly big packets so a bad client can't make us eat all memory. */
const MAX_PACKET_SIZE = 2 * 1024 * 1024;

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

  private incoming = Buffer.alloc(0);

  constructor(
    readonly socket: Socket,
    readonly server: MinecraftServer,
  ) {
    socket.setNoDelay(true); // send small packets right away instead of batching
    socket.on("data", (data) => this.onData(data));
    socket.on("close", () => server.onConnectionClosed(this));
    socket.on("error", () => {
      // Clients disconnecting abruptly cause errors like ECONNRESET.
      // "close" fires right after, which is where cleanup happens.
    });
  }

  get address(): string {
    return `${this.socket.remoteAddress}:${this.socket.remotePort}`;
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

        const packet = this.incoming.subarray(length.size, packetEnd);
        this.incoming = this.incoming.subarray(packetEnd);
        this.handlePacket(packet);
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
      case ConnectionState.Play:
        return handlePlay(this, packetId, reader);
    }
  }

  send(packet: PacketWriter): void {
    if (!this.socket.destroyed) {
      this.socket.write(packet.toBuffer());
    }
  }

  /** Kicks the client, showing them `reason` if they're logging in or playing. */
  disconnect(reason: string): void {
    const message = { text: reason, color: "red" };
    if (this.state === ConnectionState.Login) {
      this.send(loginDisconnect(message));
    } else if (this.state === ConnectionState.Play) {
      this.send(playDisconnect(message));
    }
    // end() flushes what we've written, then closes the socket.
    this.socket.end();
  }
}
