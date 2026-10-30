import net from "node:net";
import { Connection } from "../network/Connection";
import { frame } from "../network/framing";
import type { PacketWriter } from "../network/PacketWriter";
import { createWorld } from "./createWorld";
import { PluginManager } from "../plugins/PluginManager";
import { coreCommands } from "./commands";
import { adminCommands } from "./adminCommands";
import { BanList } from "./bans";
import { ConsoleSender } from "./CommandSender";
import { ServerStats } from "./stats";
import { Player } from "./Player";
import { config } from "../config";
import { formatError, logger } from "../util/logger";
import type { BlockPosition } from "../world/BlockPosition";
import type { Chunk } from "../world/Chunk";
import type { PendingLogin } from "../network/Connection";
import {
  blockChange,
  chunkData,
  commandTree,
  destroyEntities,
  GameEvent,
  gameEvent,
  joinGame,
  keepAlive,
  playerAbilities,
  playerListAdd,
  playerListRemove,
  spawnPlayer,
  spawnPosition,
  systemChat,
  timeUpdate,
} from "../protocol/clientbound";

/**
 * The heart of the server: owns the world and the list of players,
 * and accepts new TCP connections.
 */
/** One server tick is 50 ms, so there are 20 a second. */
const TICK_MS = 50;
/** How much of each tick a running autosave may use. A 20 chunk autosave then takes about 3 ticks. */
const AUTOSAVE_BUDGET_MS = 5;
/** After a stall we run at most this many missed ticks back to back; the rest are skipped. */
const MAX_CATCH_UP_TICKS = 5;

export class MinecraftServer {
  readonly world = createWorld();
  readonly plugins = new PluginManager(this);
  /** Who is banned. Read from bans.json when the server is created. */
  readonly bans = new BanList();
  /** Ticks per second, stalls and CPU use, shown by /tps and /perf. */
  readonly stats = new ServerStats();
  /** The server console, as someone who can run commands. */
  readonly console = new ConsoleSender(this);
  private tickCount = 0;
  /** Which player gets the next chunk first, so they take turns. */
  private streamTurn = 0;
  /** An autosave that is spread over several ticks, or null when none is running. */
  private autosave: { skip: Set<Chunk>; saved: number; failed: number } | null = null;
  /** When the tick clock started, and how many ticks have run since (see scheduleTick). */
  private tickClockStart = 0;
  private ticksRun = 0;

  /** Online players, keyed by entity ID. */
  private readonly players = new Map<number, Player>();
  private nextEntityId = 1;

  private readonly tcpServer = net.createServer((socket) => new Connection(socket, this));
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    for (const command of [...coreCommands, ...adminCommands]) {
      this.plugins.commands.register("core", command);
    }
  }

  start(): void {
    this.plugins.loadAll();
    this.stats.start();
    this.tcpServer.listen(config.port, config.host, () => {
      logger.info(`Listening on ${config.host}:${config.port}`);
    });
    this.keepAliveTimer = setInterval(() => this.sendKeepAlives(), config.keepAliveIntervalMs);
    this.tickClockStart = performance.now();
    this.ticksRun = 0;
    this.scheduleTick();
    this.saveTimer = setInterval(() => this.startAutosave(), config.autosaveIntervalMs);
  }

  /**
   * Runs the ticks on a clock of our own: tick N is due N * 50 ms after the start.
   *
   * A plain setInterval(50) is not good enough. On Windows timers only wake up
   * in steps of about 15.6 ms, so an interval of 50 ms really fires every
   * 62.5 ms and the server would tick 16 times a second instead of 20 (a plugin
   * task set for "20 ticks" would take 1.25 seconds). Here every wake-up works
   * out how many ticks are due and runs them, so time stays correct.
   * If the server stalls for more than a few ticks we skip the ticks we cannot make up.
   */
  private scheduleTick(): void {
    const dueAt = this.tickClockStart + (this.ticksRun + 1) * TICK_MS;
    this.tickTimer = setTimeout(() => this.runDueTicks(), Math.max(1, dueAt - performance.now()));
  }

  private runDueTicks(): void {
    let due = Math.floor((performance.now() - this.tickClockStart) / TICK_MS) - this.ticksRun;
    if (due > MAX_CATCH_UP_TICKS) {
      this.ticksRun += due - MAX_CATCH_UP_TICKS; // too far behind: drop the ticks we can't make up
      due = MAX_CATCH_UP_TICKS;
    }
    for (let i = 0; i < due; i++) {
      this.tick();
      this.ticksRun++;
    }
    this.scheduleTick();
  }

  /**
   * Sends waiting chunks to players, spending at most `budgetMs` of this tick on it
   * (but always at least one chunk, so loading never stalls). Players take turns
   * one chunk at a time, so one person teleporting does not starve everyone else.
   * Returns how many chunks were attempted.
   */
  streamChunks(budgetMs: number = config.chunkBudgetMs): number {
    const waiting = [...this.players.values()].filter((player) => player.pendingChunkCount > 0);
    const deadline = performance.now() + budgetMs;
    let attempted = 0;
    let turn = this.streamTurn++;

    while (waiting.length > 0 && (attempted === 0 || performance.now() < deadline)) {
      const player = waiting[turn++ % waiting.length];
      attempted++;
      try {
        player.sendNextChunk();
      } catch (err) {
        // For example a save file that cannot be read. The chunk is skipped; the world is not lost.
        logger.error(`Could not send a chunk to ${player.username}: ${formatError(err)}`);
      }
      if (player.pendingChunkCount === 0) waiting.splice(waiting.indexOf(player), 1);
    }
    return attempted;
  }

  /**
   * The bytes that send `chunk` to a player, ready to write to the socket. They are made once and
   * kept until the chunk changes, so a crowd joining the same lobby costs one encoding and one
   * compression per chunk, not one per player.
   */
  getChunkFrame(chunk: Chunk, compressionThreshold: number): Buffer {
    if (chunk.cachedFrame?.threshold === compressionThreshold) return chunk.cachedFrame.frame;
    const bytes = frame(chunkData(chunk, this.world.getLight(chunk)).body(), compressionThreshold);
    chunk.cachedFrame = { threshold: compressionThreshold, frame: bytes };
    chunk.light = null; // the light is only needed to make the packet; it is worked out again after a change
    return bytes;
  }

  /** How many chunks are waiting to be sent to all players together. */
  getPendingChunkCount(): number {
    let total = 0;
    for (const player of this.players.values()) total += player.pendingChunkCount;
    return total;
  }

  /** One server tick (every 50 ms): runs scheduled plugin tasks, and times itself for /tps. */
  private tick(): void {
    const startedAt = performance.now();
    this.plugins.scheduler.tick();
    try {
      this.streamChunks();
      this.stepAutosave();
    } catch (err) {
      logger.error(`Sending chunks or autosaving failed: ${formatError(err)}`);
    }
    this.stats.recordTick(performance.now() - startedAt);

    // Forget old stall measurements every 5 minutes so one old spike does not show forever.
    if (++this.tickCount % (20 * 300) === 0) this.stats.resetEventLoop();
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
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.stats.stop();
    this.plugins.disableAll();
    this.tcpServer.close();
  }

  /**
   * Starts the periodic autosave. Instead of writing every changed chunk at once
   * (about 1.4 ms each, so building across 200 chunks froze the server for over
   * a quarter of a second), the chunks are written a few per tick by stepAutosave().
   */
  startAutosave(): void {
    if (!this.autosave) this.autosave = { skip: new Set(), saved: 0, failed: 0 };
  }

  /** Does a small slice of a running autosave, and finishes it when nothing is left. */
  stepAutosave(budgetMs: number = AUTOSAVE_BUDGET_MS): void {
    const autosave = this.autosave;
    if (!autosave) return;

    const result = this.world.saveSomeDirtyChunks(budgetMs, autosave.skip);
    autosave.saved += result.saved;
    autosave.failed += result.failed;
    if (result.remaining > 0) return; // more next tick

    this.autosave = null;
    const keep = new Set<string>();
    for (const player of this.players.values()) {
      for (const key of player.loadedChunkKeys) keep.add(key);
    }
    const unloaded = this.world.unloadChunksExcept(keep);
    if (autosave.saved > 0) {
      logger.info(`World saved: ${autosave.saved} chunk file(s) written, ${unloaded} chunk(s) unloaded, ${this.world.loadedChunkCount} in memory`);
    }
  }

  /**
   * Writes changed chunks to disk, then frees chunks no player is near.
   * Runs every autosave interval and when the server stops.
   * `failed` is how many chunks still have unsaved changes.
   */
  saveWorld(options: { quiet?: boolean } = {}): { saved: number; failed: number } {
    this.autosave = null; // this save covers everything, so a running slow autosave is no longer needed
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
  setBlock(pos: BlockPosition, state: number): void {
    if (pos.y < 0 || pos.y > 255) return;
    this.world.setBlock(pos, state);
    this.broadcast(blockChange(pos, state));
  }

  /** Where new players appear. The height depends on the terrain, so it's looked up. */
  getSpawnPoint(): { x: number; y: number; z: number } {
    const { x, z } = config.spawn;
    return { x, y: config.spawn.y ?? this.world.getSpawnHeight(Math.floor(x), Math.floor(z)), z };
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
    this.broadcast(systemChat({ text, color }));
  }

  /**
   * Called when the client has finished configuring and is ready to enter the world.
   * The order of packets matters:
   *   1. Login               - "you're in, here's your entity ID, game mode and world"
   *   2. Abilities, commands - what the player may do and which commands exist
   *   3. Time, spawn, Position - the sky, the compass, and where the player stands
   *   4. "Chunks are coming" - then the chunk list: the world around them
   *   5. Tab list + other players appearing
   */
  addPlayer(conn: Connection, pending: PendingLogin): void {
    if (this.getPlayerByName(pending.username)) {
      conn.disconnect("Someone with that name is already playing.");
      return;
    }
    const viewRadius = Math.max(2, Math.min(config.viewDistance, pending.viewDistance ?? config.viewDistance));
    const player = new Player(conn, this, this.nextEntityId++, pending.username, pending.uuid, config.defaultGameMode, viewRadius);
    const spawn = this.getSpawnPoint();
    player.x = spawn.x;
    player.y = spawn.y;
    player.z = spawn.z;
    conn.player = player;
    this.players.set(player.entityId, player);
    logger.info(`${player.username} joined from ${conn.address} (uuid ${player.uuid})`);

    const { x, y, z } = spawn;
    player.send(joinGame(player.entityId, player.gameMode, config.maxPlayers, viewRadius));
    player.send(playerAbilities(player.gameMode));
    player.send(commandTree(this.plugins.commands.all().map((command) => command.name)));
    player.send(timeUpdate(0, config.timeOfDay, false)); // a frozen clock: it is always the same time of day
    player.send(spawnPosition({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }));
    player.sendPosition();
    player.send(gameEvent(GameEvent.LevelChunksLoadStart, 0));
    player.updateLoadedChunks(true); // the nearest chunks now, the rest are streamed over the next ticks

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

    this.broadcastMessage(`${player.username} joined the game`, "yellow");
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
