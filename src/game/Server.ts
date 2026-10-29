import net from "node:net";
import { Connection } from "../network/Connection";
import type { PacketWriter } from "../network/PacketWriter";
import { createWorld } from "./createWorld";
import { PluginManager } from "../plugins/PluginManager";
import { coreCommands } from "./commands";
import { Player } from "./Player";
import { config } from "../config";
import { logger } from "../util/logger";
import type { BlockPosition } from "../world/BlockPosition";
import {
  blockChange,
  chatMessage,
  destroyEntities,
  joinGame,
  keepAlive,
  playerListAdd,
  playerListRemove,
  playerPositionAndLook,
  spawnPlayer,
  spawnPosition,
} from "../protocol/clientbound";

/**
 * The heart of the server: owns the world and the list of players,
 * and accepts new TCP connections.
 */
export class MinecraftServer {
  readonly world = createWorld();
  readonly plugins = new PluginManager(this);

  /** Online players, keyed by entity ID. */
  private readonly players = new Map<number, Player>();
  private nextEntityId = 1;

  private readonly tcpServer = net.createServer((socket) => new Connection(socket, this));
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    for (const command of coreCommands) {
      this.plugins.commands.register("core", command);
    }
  }

  start(): void {
    this.plugins.loadAll();
    this.tcpServer.listen(config.port, config.host, () => {
      logger.info(`Listening on ${config.host}:${config.port}`);
    });
    this.keepAliveTimer = setInterval(() => this.sendKeepAlives(), config.keepAliveIntervalMs);
    this.tickTimer = setInterval(() => this.plugins.scheduler.tick(), 50); // 20 ticks per second
    this.saveTimer = setInterval(() => this.saveWorld(), config.autosaveIntervalMs);
  }

  /**
   * Kicks everyone and stops accepting connections. It does NOT save: call
   * saveWorld() afterwards and check `failed`, because a save can fail
   * (disk full...) and then the caller must not just exit.
   */
  stop(): void {
    logger.info("Stopping server...");
    for (const player of this.players.values()) {
      player.kick("Server closed");
    }
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.plugins.disableAll();
    this.tcpServer.close();
  }

  /**
   * Writes changed chunks to disk, then frees chunks no player is near.
   * Runs every autosave interval and when the server stops.
   * `failed` is how many chunks still have unsaved changes.
   */
  saveWorld(options: { quiet?: boolean } = {}): { saved: number; failed: number } {
    const { saved, failed } = this.world.saveDirtyChunks();
    const keep = new Set<string>();
    for (const player of this.players.values()) {
      for (const key of player.loadedChunkKeys) keep.add(key);
    }
    const unloaded = this.world.unloadChunksExcept(keep);
    if (saved > 0 || options.quiet === false) {
      logger.info(`World saved: ${saved} chunk file(s) written, ${unloaded} chunk(s) unloaded, ${this.world.loadedChunkCount} in memory`);
    }
    return { saved, failed };
  }

  /**
   * Changes a block AND tells every player. Use this from plugins and
   * commands. (world.setBlock alone changes the world but leaves the
   * players' screens out of date.) The change is saved with the world.
   */
  setBlock(pos: BlockPosition, blockId: number, metadata = 0): void {
    if (pos.y < 0 || pos.y > 255) return;
    this.world.setBlock(pos, blockId, metadata);
    this.broadcast(blockChange(pos, blockId, metadata));
  }

  /** Where new players appear. The height depends on the terrain, so it's looked up. */
  getSpawnPoint(): { x: number; y: number; z: number } {
    const { x, z } = config.spawn;
    return { x, y: this.world.getSpawnHeight(Math.floor(x), Math.floor(z)), z };
  }

  getOnlinePlayers(): Player[] {
    return [...this.players.values()];
  }

  getPlayerByName(name: string): Player | undefined {
    const lower = name.toLowerCase();
    return this.getOnlinePlayers().find((p) => p.username.toLowerCase() === lower);
  }

  /** Sends a packet to every player, optionally skipping one. */
  broadcast(packet: PacketWriter, except?: Player): void {
    for (const player of this.players.values()) {
      if (player !== except) player.send(packet);
    }
  }

  broadcastMessage(text: string, color?: string): void {
    logger.info(`[chat] ${text}`);
    this.broadcast(chatMessage({ text, color }));
  }

  /**
   * Called right after a successful login. The order of packets matters:
   *   1. Join Game           - "you're in, here's your entity ID and game mode"
   *   2. Spawn Position      - where the compass points
   *   3. Chunk Data (many)   - the world around them
   *   4. Position And Look   - puts them in the world; the loading screen closes
   *   5. Tab list + other players appearing
   */
  addPlayer(conn: Connection, username: string, uuid: string): void {
    const player = new Player(conn, this, this.nextEntityId++, username, uuid, config.defaultGameMode);
    const spawn = this.getSpawnPoint();
    player.x = spawn.x;
    player.y = spawn.y;
    player.z = spawn.z;
    conn.player = player;
    this.players.set(player.entityId, player);
    logger.info(`${username} joined from ${conn.address} (uuid ${uuid})`);

    const { x, y, z } = spawn;
    player.send(joinGame(player.entityId, player.gameMode, config.maxPlayers));
    player.send(spawnPosition({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }));
    player.updateLoadedChunks();
    player.send(playerPositionAndLook(x, y, z, player.yaw, player.pitch));

    // Tab list: the new player needs everyone (including themselves),
    // everyone else just needs the new player.
    player.send(playerListAdd(this.getOnlinePlayers()));
    this.broadcast(playerListAdd([player]), player);

    // Make the players see each other. This must come after the tab list.
    for (const other of this.players.values()) {
      if (other === player) continue;
      player.send(spawnPlayer(other));
      other.send(spawnPlayer(player));
    }

    this.broadcastMessage(`${username} joined the game`, "yellow");
    this.plugins.events.emit("playerJoin", { player });
  }

  /** Called when any socket closes. Only matters if the player had logged in. */
  onConnectionClosed(conn: Connection): void {
    const player = conn.player;
    if (!player || !this.players.has(player.entityId)) return;

    this.players.delete(player.entityId);
    this.broadcast(destroyEntities([player.entityId]));
    this.broadcast(playerListRemove([player]));
    this.broadcastMessage(`${player.username} left the game`, "yellow");
    this.plugins.events.emit("playerQuit", { player });
  }

  /**
   * Keep-alives let both sides notice dead connections. We send a random
   * number; the client must send the same number back. If a player hasn't
   * answered for too long, we kick them.
   */
  private sendKeepAlives(): void {
    const now = Date.now();
    for (const player of this.players.values()) {
      if (now - player.lastKeepAliveReply > config.keepAliveTimeoutMs) {
        player.kick("Timed out");
        continue;
      }
      const id = Math.floor(Math.random() * 0x7fffffff);
      player.pendingKeepAliveId = id;
      player.send(keepAlive(id));
    }
  }
}
