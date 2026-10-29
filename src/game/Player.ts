import type { Connection } from "../network/Connection";
import type { PacketWriter } from "../network/PacketWriter";
import type { MinecraftServer } from "./Server";
import type { GameMode } from "./GameMode";
import { config } from "../config";
import {
  changeGameMode,
  chatMessage,
  chunkData,
  entityHeadLook,
  entityTeleport,
  playerListUpdateGameMode,
  playerPositionAndLook,
  unloadChunk,
} from "../protocol/clientbound";

/** Everything the server knows about one logged-in player. */
export class Player {
  // Real values are set by MinecraftServer.addPlayer() once the terrain height is known.
  x = 0;
  y = 0;
  z = 0;
  yaw = 0; // left/right rotation in degrees
  pitch = 0; // up/down rotation in degrees
  onGround = true;

  /** Keep-alive bookkeeping, see MinecraftServer.sendKeepAlives(). */
  pendingKeepAliveId: number | null = null;
  lastKeepAliveReply = Date.now();

  /** Chunks this client currently has, as "x,z" strings. */
  private readonly loadedChunks = new Set<string>();
  private lastChunkX: number | null = null;
  private lastChunkZ: number | null = null;

  constructor(
    readonly connection: Connection,
    readonly server: MinecraftServer,
    readonly entityId: number,
    readonly username: string,
    readonly uuid: string,
    public gameMode: GameMode,
  ) {}

  get isOp(): boolean {
    return config.ops.some((name) => name.toLowerCase() === this.username.toLowerCase());
  }

  /** "x,z" keys of the chunks this client currently has. */
  get loadedChunkKeys(): ReadonlySet<string> {
    return this.loadedChunks;
  }

  send(packet: PacketWriter): void {
    this.connection.send(packet);
  }

  sendMessage(text: string, color?: string): void {
    this.send(chatMessage({ text, color }));
  }

  kick(reason: string): void {
    this.connection.disconnect(reason);
  }

  /**
   * Sends the chunks around the player that the client doesn't have yet,
   * and tells it to forget the ones that are now too far away.
   * Does nothing if the player is still in the same chunk as last time.
   */
  updateLoadedChunks(): void {
    const centerX = Math.floor(this.x / 16);
    const centerZ = Math.floor(this.z / 16);
    if (centerX === this.lastChunkX && centerZ === this.lastChunkZ) return;
    this.lastChunkX = centerX;
    this.lastChunkZ = centerZ;

    const radius = config.viewDistance;
    const wanted = new Set<string>();

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const chunkX = centerX + dx;
        const chunkZ = centerZ + dz;
        const key = `${chunkX},${chunkZ}`;
        wanted.add(key);

        if (!this.loadedChunks.has(key)) {
          const chunk = this.server.world.getChunk(chunkX, chunkZ);
          this.send(chunkData(chunk, this.server.world.getLight(chunk)));
          this.loadedChunks.add(key);
        }
      }
    }

    for (const key of this.loadedChunks) {
      if (!wanted.has(key)) {
        const [chunkX, chunkZ] = key.split(",").map(Number);
        this.send(unloadChunk(chunkX, chunkZ));
        this.loadedChunks.delete(key);
      }
    }
  }

  /** Moves the player somewhere and tells everyone about it. */
  teleport(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.updateLoadedChunks(); // send the new area before moving them into it
    this.send(playerPositionAndLook(x, y, z, this.yaw, this.pitch));
    this.server.broadcast(entityTeleport(this), this);
    this.server.broadcast(entityHeadLook(this), this);
  }

  setGameMode(gameMode: GameMode): void {
    this.gameMode = gameMode;
    this.send(changeGameMode(gameMode));
    // The tab list also stores game modes (and the client uses it to
    // decide if *you* are in spectator mode), so update it for everyone.
    this.server.broadcast(playerListUpdateGameMode(this));
  }
}
