import type { Connection } from "../network/Connection";
import type { PacketWriter } from "../network/PacketWriter";
import type { MinecraftServer } from "./Server";
import type { GameMode } from "./GameMode";
import { config } from "../config";
import { normalizeIp } from "../util/ip";
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

  /** Chunks the client should have but we have not sent yet, nearest to the player first. */
  private pendingChunks: Array<{ x: number; z: number }> = [];

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

  /** Lets a Player be used wherever a CommandSender is expected. */
  get name(): string {
    return this.username;
  }

  readonly isConsole = false;

  /** The client's IP address, without the "::ffff:" prefix some systems add to IPv4. */
  get ip(): string {
    return normalizeIp(this.connection.socket.remoteAddress ?? "");
  }

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
  updateLoadedChunks(urgent = false): void {
    const centerX = Math.floor(this.x / 16);
    const centerZ = Math.floor(this.z / 16);
    if (centerX === this.lastChunkX && centerZ === this.lastChunkZ) return;
    this.lastChunkX = centerX;
    this.lastChunkZ = centerZ;

    const radius = config.viewDistance;
    const wanted = new Set<string>();
    const alreadyQueued = new Set(this.pendingChunks.map((chunk) => `${chunk.x},${chunk.z}`));
    const missing: Array<{ x: number; z: number }> = [];

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const chunkX = centerX + dx;
        const chunkZ = centerZ + dz;
        const key = `${chunkX},${chunkZ}`;
        wanted.add(key);
        if (!this.loadedChunks.has(key) && !alreadyQueued.has(key)) missing.push({ x: chunkX, z: chunkZ });
      }
    }

    // Forget queued chunks that are now too far away (for example after teleporting again),
    // add the new ones, and put the ones nearest the player first.
    this.pendingChunks = this.pendingChunks.filter((chunk) => wanted.has(`${chunk.x},${chunk.z}`));
    this.pendingChunks.push(...missing);
    const distance = (chunk: { x: number; z: number }): number => (chunk.x - centerX) ** 2 + (chunk.z - centerZ) ** 2;
    this.pendingChunks.sort((a, b) => distance(a) - distance(b));

    // Telling the client to drop far chunks is cheap, so that happens right away.
    for (const key of this.loadedChunks) {
      if (!wanted.has(key)) {
        const [chunkX, chunkZ] = key.split(",").map(Number);
        this.send(unloadChunk(chunkX, chunkZ));
        this.loadedChunks.delete(key);
      }
    }

    // The chunks right around the player must arrive now so they never fall through the world.
    // Everything else is sent a few per tick by MinecraftServer.streamChunks().
    if (urgent) {
      const reach = config.urgentChunkRadius;
      while (
        this.pendingChunks.length > 0 &&
        Math.max(Math.abs(this.pendingChunks[0].x - centerX), Math.abs(this.pendingChunks[0].z - centerZ)) <= reach
      ) {
        this.sendNextChunk();
      }
    }
  }

  /** How many chunks are still waiting to be sent to this player. */
  get pendingChunkCount(): number {
    return this.pendingChunks.length;
  }

  /**
   * Prepares and sends the nearest waiting chunk. The chunk leaves the queue
   * first, so if loading it fails it is not retried in a loop (it is queued
   * again the next time the player moves into a new chunk).
   */
  sendNextChunk(): void {
    const next = this.pendingChunks.shift();
    if (!next) return;

    const world = this.server.world;
    const chunk = world.getChunk(next.x, next.z);
    this.send(chunkData(chunk, world.getLight(chunk)));
    this.loadedChunks.add(`${next.x},${next.z}`);
  }

  /** Moves the player somewhere and tells everyone about it. */
  teleport(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.updateLoadedChunks(true); // the chunks around the destination are sent first, the rest stream in
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
