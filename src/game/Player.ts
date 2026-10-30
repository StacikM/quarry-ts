import type { Connection } from "../network/Connection";
import type { PacketWriter } from "../network/PacketWriter";
import type { MinecraftServer } from "./Server";
import { GameMode } from "./GameMode";
import { config } from "../config";
import {
  changeGameMode,
  chunkBatchFinished,
  chunkBatchStart,
  chunkData,
  entityHeadLook,
  entityTeleport,
  playerAbilities,
  playerListUpdateGameMode,
  playerPosition,
  pluginMessage,
  setCenterChunk,
  systemChat,
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

  /** Whether the player is flying (creative and spectator only). The client tells us. */
  flying = false;
  /** Which slot of the hotbar is selected (0-8), and what is in the hotbar slots, as item ids (-1 = nothing). */
  heldSlot = 0;
  readonly hotbar: number[] = new Array(9).fill(-1);

  /** Numbers the position updates we force on the client; it answers each with "Teleport Confirm". */
  private teleportCounter = 0;
  /** The last forced position the client has not confirmed yet. Until then its own position reports are stale and ignored. */
  awaitingTeleport: number | null = null;

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
    /** How many chunks around the player are sent: the server's setting, or less if the player asked for less. */
    readonly viewRadius: number,
  ) {}

  /** Lets a Player be used wherever a CommandSender is expected. */
  get name(): string {
    return this.username;
  }

  readonly isConsole = false;

  /** The client's IP address, without the "::ffff:" prefix some systems add to IPv4. */
  get ip(): string {
    return this.connection.clientIp;
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
    this.send(systemChat({ text, color }));
  }

  /**
   * Asks the Velocity (or BungeeCord) proxy in front of this server to move the
   * player to another of its servers, by the name it has in the proxy's config.
   * Does nothing useful when there is no proxy: nobody answers the message.
   */
  connectToServer(serverName: string): void {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(serverName)) throw new Error(`Invalid server name: ${serverName}`);
    // The proxy reads Java's DataOutput format: each string is a 2-byte length and then the text.
    const text = (value: string): Buffer => Buffer.concat([Buffer.from([0, value.length]), Buffer.from(value, "ascii")]);
    this.send(pluginMessage("bungeecord:main", Buffer.concat([text("Connect"), text(serverName)])));
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
    this.send(setCenterChunk(centerX, centerZ)); // the client keeps the chunks around this one

    const radius = this.viewRadius;
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
    // Each chunk travels inside a "batch", which the client uses to measure how fast it can take them.
    this.send(chunkBatchStart());
    this.send(chunkData(chunk, world.getLight(chunk)));
    this.send(chunkBatchFinished(1));
    this.loadedChunks.add(`${next.x},${next.z}`);
  }

  /** Moves the player somewhere and tells everyone about it. */
  teleport(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.updateLoadedChunks(true); // the chunks around the destination are sent first, the rest stream in
    this.sendPosition();
    this.server.broadcast(entityTeleport(this), this);
    this.server.broadcast(entityHeadLook(this), this);
  }

  /** Puts the client's player at our idea of where it is. */
  sendPosition(): void {
    this.awaitingTeleport = ++this.teleportCounter;
    this.send(playerPosition(this.awaitingTeleport, this.x, this.y, this.z, this.yaw, this.pitch));
  }

  setGameMode(gameMode: GameMode): void {
    this.gameMode = gameMode;
    if (gameMode !== GameMode.Creative && gameMode !== GameMode.Spectator) this.flying = false;
    this.send(changeGameMode(gameMode));
    this.send(playerAbilities(gameMode, this.flying));
    // The tab list also stores game modes (and the client uses it to
    // decide if *you* are in spectator mode), so update it for everyone.
    this.server.broadcast(playerListUpdateGameMode(this));
  }
}
